/**
 * Local HTTP microservice primitive for Lot Trader (`trade serve`).
 *
 * Design rules (deliberate, non-negotiable):
 *  - Loopback only. The engine holds the owner's complete ledger, so the listener is
 *    hard-restricted to `127.0.0.1` / `localhost` / `::1`; any other `--host` value is a
 *    hard error rather than a silent external exposure.
 *  - Read-only JSON API. `serve` never mutates the ledger; writes stay on the CLI.
 *  - Every handler is defensive: a broken quote feed / missing table degrades the payload
 *    (cost-basis fallback) instead of throwing a 500 or emitting NaN.
 */
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import pkg from "../package.json";
import { AccountRepository, DEFAULT_ACCOUNT_ID } from "./accounts.ts";
import { computeFloatingPnl, getSellFeeRate, round } from "./calc.ts";
import { AppDatabase, DEFAULT_DB_PATH } from "./db.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";

export const TOOL_VERSION: string = (pkg as { version?: string }).version || "0.0.0";

export const DEFAULT_SERVE_PORT = 8080;
export const DEFAULT_SERVE_HOST = "127.0.0.1";

/** Only these literal hosts may ever be bound. Everything else is rejected. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"] as const;

export const DEFAULT_FULL_POSITION_CAP = 50000;
const DEFAULT_QUOTE_CACHE_TTL_MS = 5000;
const API_PREFIX = "/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** TCP port. `0` asks the OS for a free port (used by tests). Strings are parsed. */
  port?: number | string;
  /** Loopback host. Defaults to 127.0.0.1. */
  host?: string;
  /** Ledger path. Defaults to $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db. */
  dbPath?: string;
  /** Injectable quote feed (tests pass a fully mocked provider: no network). */
  quoteProvider?: QuoteProvider;
  /** Quote cache TTL in ms. */
  quoteCacheTtlMs?: number;
  /** Full position cap (hard budget upper bound). Defaults to env or 50000. */
  fullPositionCap?: number;
  /** Suppress the startup banner. */
  quiet?: boolean;
}

export interface ApiLot {
  lot_id: string;
  account_id: string;
  symbol: string;
  symbol_name: string;
  asset_class: string;
  settlement_mode: string;
  buy_time: string;
  buy_price: number;
  buy_quantity: number;
  remaining_quantity: number;
  cost_basis_unit: number;
  current_price: number;
  price_source: PriceSource;
  market_value: number;
  floating_pnl: number;
  return_rate: number;
  status: string;
  pyramid_level: number;
  can_sell_now: boolean;
  is_day_trading: boolean;
  peak_price: number | null;
  trailing_stop_active: boolean;
  buy_reason: string | null;
  close_reason: string | null;
  close_time: string | null;
  close_avg_price: number | null;
  realized_pnl: number;
}

export type PriceSource = "live" | "cost_basis";

export interface ApiSymbolSummary {
  symbol: string;
  name: string;
  asset_class: string;
  settlement_mode: string;
  accounts: string[];
  total_quantity: number;
  avg_cost_price: number;
  total_cost_basis: number;
  current_price: number;
  price_source: PriceSource;
  market_value: number;
  floating_pnl: number;
  return_rate: number;
  active_lots: number;
}

export interface ApiAccountSummary {
  account_id: string;
  name: string;
  broker_code: string;
  currency: string;
  is_active: boolean;
  total_symbols: number;
  total_active_lots: number;
  total_cost: number;
  total_market_value: number;
  total_floating_pnl: number;
  overall_return_rate: number;
  realized_pnl: number;
  dividends: number;
  withdrawn_cash: number;
  closed_trades: number;
  win_trades: number;
  loss_trades: number;
  win_rate: number;
}

export interface ApiPortfolioSummary {
  total_cost: number;
  total_market_value: number;
  total_floating_pnl: number;
  overall_return_rate: number;
  full_position_cap: number;
  remaining_budget: number;
  budget_utilization_rate: number;
  total_active_lots: number;
  total_symbols_count: number;
  total_quantity: number;
  realized_pnl: number;
  dividends: number;
  withdrawn_cash: number;
  closed_trades: number;
  win_trades: number;
  loss_trades: number;
  win_rate: number;
}

export interface ApiSummary {
  status: "ok";
  version: string;
  db_path: string;
  generated_at: number;
  currency: "CNY";
  portfolio: ApiPortfolioSummary;
  accounts: ApiAccountSummary[];
  symbols: ApiSymbolSummary[];
}

export interface ApiLots {
  status: "ok";
  version: string;
  db_path: string;
  generated_at: number;
  filters: { symbol: string | null; account: string | null; status: string };
  total: number;
  lots: ApiLot[];
}

export interface ApiHealth {
  status: "ok";
  version: string;
  db_path: string;
  timestamp: number;
  host: string;
  port: number;
  uptime_seconds: number;
  endpoints: string[];
}

export interface StartedServe {
  server: Server<undefined>;
  host: string;
  port: number;
  dbPath: string;
  version: string;
  url: string;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Argument / host validation
// ---------------------------------------------------------------------------

/** Canonicalize a host to a bindable loopback literal, or throw a readable error. */
export function resolveServeHost(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_SERVE_HOST;
  const lower = value.toLowerCase();
  if ((LOOPBACK_HOSTS as readonly string[]).includes(lower)) {
    return lower === "localhost" ? DEFAULT_SERVE_HOST : lower;
  }
  throw new Error(
    `拒绝监听 ${value}：trade serve 仅允许本地回环地址 (${LOOPBACK_HOSTS.join(" / ")})，` +
      `以避免把完整投资账本暴露到外网。`,
  );
}

/** Parse / validate a port. Empty -> default. */
export function resolveServePort(raw?: string | number | null): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SERVE_PORT;
  const port = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`非法端口: "${raw}"。端口必须是 0-65535 之间的整数，例如 --port 8080。`);
  }
  return port;
}

export function resolveServeDbPath(raw?: string | null): string {
  return (
    (raw ?? "").trim() ||
    process.env.LOT_TRADER_DB ||
    process.env.TRADE_DB_PATH ||
    DEFAULT_DB_PATH
  );
}

export function resolveFullPositionCap(raw?: string | number | null): number {
  const fromEnv = process.env.LOT_TRADER_FULL_POSITION_CAP;
  const candidate = raw ?? fromEnv;
  if (candidate === undefined || candidate === null || candidate === "") {
    return DEFAULT_FULL_POSITION_CAP;
  }
  const value = typeof candidate === "number" ? candidate : Number(String(candidate).trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_FULL_POSITION_CAP;
}

function isPortInUseError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = String((err as { message?: string })?.message ?? "");
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use|Is port .* in use/i.test(message);
}

/** Turn a raw EADDRINUSE into the human, actionable banner used by the CLI. */
export function formatPortConflictError(host: string, port: number): string {
  return [
    `端口 ${port} 已被占用，本地引擎无法在 ${host}:${port} 启动。`,
    `  可能已有一个 trade serve 在运行：先访问 http://${host}:${port}/api/health 确认。`,
    `  或换一个端口重试： trade serve --port ${port === 65535 ? 8081 : port + 1}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Price book (quote cache with graceful cost-basis fallback)
// ---------------------------------------------------------------------------

/** Thin cached façade over QuoteProvider: never throws, never yields NaN. */
export class PriceBook {
  private provider: QuoteProvider;
  private ttlMs: number;
  private cache = new Map<string, { price: number; source: PriceSource; at: number }>();

  constructor(provider?: QuoteProvider, ttlMs: number = DEFAULT_QUOTE_CACHE_TTL_MS) {
    this.provider = provider ?? new QuoteProvider();
    this.ttlMs = ttlMs;
  }

  public invalidate(): void {
    this.cache.clear();
  }

  /** Fetch live prices for the given symbols. Failures resolve to `{}` (caller falls back). */
  public async load(symbols: string[]): Promise<Record<string, { price: number; source: PriceSource }>> {
    const unique = Array.from(new Set(symbols.filter((s) => Boolean(s))));
    const now = Date.now();
    const out: Record<string, { price: number; source: PriceSource }> = {};
    const stale: string[] = [];

    for (const sym of unique) {
      const hit = this.cache.get(sym);
      if (hit && now - hit.at < this.ttlMs) {
        out[sym] = { price: hit.price, source: hit.source };
      } else {
        stale.push(sym);
      }
    }

    if (stale.length === 0) return out;

    let quotes: Record<string, { current_price: number }> = {};
    try {
      quotes = await this.provider.getQuotes(stale);
    } catch {
      quotes = {};
    }

    for (const sym of stale) {
      const price = Number(quotes?.[sym]?.current_price);
      if (Number.isFinite(price) && price > 0) {
        this.cache.set(sym, { price, source: "live", at: now });
        out[sym] = { price, source: "live" };
      }
      // No cache entry on failure: the next request retries instead of pinning a stale miss.
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// Ledger aggregation
// ---------------------------------------------------------------------------

interface LedgerLotRow {
  lot_id: string;
  account_id: string | null;
  symbol: string;
  symbol_name: string | null;
  asset_class: string | null;
  settlement_mode: string | null;
  buy_time: string;
  buy_price: number;
  buy_quantity: number;
  remaining_quantity: number;
  cost_basis_unit: number;
  status: string;
  pyramid_level: number | null;
  is_day_trading: number | boolean | null;
  peak_price: number | null;
  trailing_stop_active: number | boolean | null;
  buy_reason: string | null;
  close_reason: string | null;
  close_time: string | null;
  close_avg_price: number | null;
  realized_pnl: number | null;
}

function toFinite(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeAccountKey(raw?: string | null): string {
  const value = (raw ?? "").trim();
  return value || DEFAULT_ACCOUNT_ID;
}

function normalizeStatusFilter(raw?: string | null): string {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value || value === "ALL") return "ALL";
  if (value === "ACTIVE" || value === "CLOSED" || value === "CLOSING") return value;
  throw new Error(`非法批次状态: "${raw}"。可选值: ACTIVE | CLOSED | CLOSING | ALL`);
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** Read the whole ledger once, joined with symbol metadata. */
export function readLedgerLots(db: Database): LedgerLotRow[] {
  const sql = `
    SELECT l.lot_id, l.account_id, l.symbol,
           s.name AS symbol_name, s.asset_class, s.settlement_mode,
           l.buy_time, l.buy_price, l.buy_quantity, l.remaining_quantity,
           l.cost_basis_unit, l.status, l.pyramid_level, l.is_day_trading,
           l.peak_price, l.trailing_stop_active,
           l.buy_reason, l.close_reason, l.close_time, l.close_avg_price, l.realized_pnl
    FROM lots l
    LEFT JOIN symbols s ON l.symbol = s.symbol
    ORDER BY datetime(l.buy_time) DESC, l.lot_id ASC
  `;
  try {
    return db.query<LedgerLotRow, []>(sql).all();
  } catch {
    // A pre-migration ledger without the newest columns must still serve a payload.
    return [];
  }
}

/** Build the per-lot API shape from a raw row + a resolved price. */
export function buildApiLot(row: LedgerLotRow, price: number, priceSource: PriceSource, now: Date = new Date()): ApiLot {
  const account = normalizeAccountKey(row.account_id);
  const symbol = row.symbol;
  const assetClass = row.asset_class || "ETF";
  const settlementMode = row.settlement_mode || "STATUTORY_T1";
  const status = (row.status || "ACTIVE").toUpperCase();
  const remaining = toFinite(row.remaining_quantity);
  const costUnit = toFinite(row.cost_basis_unit);
  const buyPrice = toFinite(row.buy_price);
  const safePrice = Number.isFinite(price) && price > 0 ? price : costUnit || buyPrice;

  const buyTimeRaw = String(row.buy_time ?? "");
  const buyDate = buyTimeRaw.slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  let floatingPnl = 0;
  let returnRate = 0;
  if (status === "ACTIVE" && safePrice > 0) {
    [floatingPnl, returnRate] = computeFloatingPnl(
      safePrice,
      costUnit || buyPrice,
      remaining,
      getSellFeeRate(assetClass),
    );
  }

  return {
    lot_id: row.lot_id,
    account_id: account,
    symbol,
    symbol_name: row.symbol_name || symbol,
    asset_class: assetClass,
    settlement_mode: settlementMode,
    buy_time: buyTimeRaw,
    buy_price: buyPrice,
    buy_quantity: toFinite(row.buy_quantity),
    remaining_quantity: remaining,
    cost_basis_unit: costUnit,
    current_price: safePrice,
    price_source: Number.isFinite(price) && price > 0 ? priceSource : "cost_basis",
    market_value: round(safePrice * remaining, 2),
    floating_pnl: floatingPnl,
    return_rate: returnRate,
    status,
    pyramid_level: toFinite(row.pyramid_level),
    can_sell_now: status === "ACTIVE" ? settlementMode === "NATIVE_T0" || buyDate < today : false,
    is_day_trading: Boolean(row.is_day_trading),
    peak_price: row.peak_price === null || row.peak_price === undefined ? null : toFinite(row.peak_price),
    trailing_stop_active: Boolean(row.trailing_stop_active),
    buy_reason: row.buy_reason ?? null,
    close_reason: row.close_reason ?? null,
    close_time: row.close_time ?? null,
    close_avg_price:
      row.close_avg_price === null || row.close_avg_price === undefined ? null : toFinite(row.close_avg_price),
    realized_pnl: toFinite(row.realized_pnl),
  };
}

/** Filter + price an arbitrary lot list. */
export async function buildLotsPayload(
  db: Database,
  options: {
    dbPath: string;
    symbol?: string | null;
    account?: string | null;
    status?: string | null;
    priceBook: PriceBook;
    now?: Date;
  },
): Promise<ApiLots> {
  const now = options.now ?? new Date();
  const status = normalizeStatusFilter(options.status);

  let symbolFilter: string | null = null;
  if (options.symbol && options.symbol.trim()) {
    try {
      const [std] = normalizeSymbol(options.symbol.trim());
      symbolFilter = std.toUpperCase();
    } catch {
      symbolFilter = options.symbol.trim().toUpperCase();
    }
  }
  const accountFilter = options.account && options.account.trim() ? options.account.trim() : null;

  const rows = readLedgerLots(db).filter((row) => {
    if (status !== "ALL" && String(row.status ?? "").toUpperCase() !== status) return false;
    if (symbolFilter && row.symbol.toUpperCase() !== symbolFilter) return false;
    if (accountFilter && normalizeAccountKey(row.account_id) !== accountFilter) return false;
    return true;
  });

  const prices = await options.priceBook.load(rows.map((r) => r.symbol));
  const lots = rows.map((row) => {
    const hit = prices[row.symbol];
    return buildApiLot(row, hit?.price ?? 0, hit?.source ?? "cost_basis", now);
  });

  return {
    status: "ok",
    version: TOOL_VERSION,
    db_path: options.dbPath,
    generated_at: now.getTime(),
    filters: { symbol: symbolFilter, account: accountFilter, status },
    total: lots.length,
    lots,
  };
}

interface TradeStats {
  closed_trades: number;
  win_trades: number;
  loss_trades: number;
  realized_pnl: number;
}

function readTradeStats(db: Database): Map<string, TradeStats> {
  const map = new Map<string, TradeStats>();
  let rows: Array<{ account_id: string | null; realized_pnl: number | null; action: string }> = [];
  try {
    rows = db
      .query<{ account_id: string | null; realized_pnl: number | null; action: string }, []>(
        "SELECT account_id, realized_pnl, action FROM trades WHERE action LIKE 'SELL%'",
      )
      .all();
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const key = normalizeAccountKey(row.account_id);
    const bucket = map.get(key) ?? { closed_trades: 0, win_trades: 0, loss_trades: 0, realized_pnl: 0 };
    const pnl = toFinite(row.realized_pnl);
    bucket.closed_trades += 1;
    if (pnl > 0) bucket.win_trades += 1;
    else if (pnl < 0) bucket.loss_trades += 1;
    bucket.realized_pnl = round(bucket.realized_pnl + pnl, 2);
    map.set(key, bucket);
  }
  return map;
}

function readDividends(db: Database): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db
      .query<{ account_id: string | null; amount: number | null }, []>(
        "SELECT account_id, amount FROM dividends",
      )
      .all();
    for (const row of rows) {
      const key = normalizeAccountKey(row.account_id);
      map.set(key, round((map.get(key) ?? 0) + toFinite(row.amount), 2));
    }
  } catch {
    // No dividends table (pre-migration ledger): zero dividends is the honest answer.
  }
  return map;
}

/** Compose the full `/api/summary` payload. */
export async function buildSummaryPayload(
  db: Database,
  options: { dbPath: string; priceBook: PriceBook; fullPositionCap?: number; now?: Date },
): Promise<ApiSummary> {
  const now = options.now ?? new Date();
  const cap = resolveFullPositionCap(options.fullPositionCap);
  const allRows = readLedgerLots(db);
  const activeRows = allRows.filter((r) => String(r.status ?? "").toUpperCase() === "ACTIVE");
  const prices = await options.priceBook.load(activeRows.map((r) => r.symbol));
  const tradeStats = readTradeStats(db);
  const dividendMap = readDividends(db);

  const accountsRepo = new AccountRepository(db);
  let accounts: Array<{ account_id: string; name: string; broker_code: string; currency: string; is_active: boolean }> = [];
  try {
    accounts = accountsRepo.listAccounts(true);
  } catch {
    accounts = [];
  }

  // --- per-lot valuation (single source of truth for P&L) ----------------------
  const lotViewsAll: ApiLot[] = activeRows.map((row) => {
    const hit = prices[row.symbol];
    return buildApiLot(row, hit?.price ?? 0, hit?.source ?? "cost_basis", now);
  });

  // --- per-symbol aggregation -------------------------------------------------
  const symbolMap = new Map<string, ApiSymbolSummary>();
  for (const lot of lotViewsAll) {
    const existing = symbolMap.get(lot.symbol);
    if (!existing) {
      symbolMap.set(lot.symbol, {
        symbol: lot.symbol,
        name: lot.symbol_name,
        asset_class: lot.asset_class,
        settlement_mode: lot.settlement_mode,
        accounts: [lot.account_id],
        total_quantity: lot.remaining_quantity,
        avg_cost_price: lot.cost_basis_unit,
        total_cost_basis: round(lot.cost_basis_unit * lot.remaining_quantity, 2),
        current_price: lot.current_price,
        price_source: lot.price_source,
        market_value: lot.market_value,
        floating_pnl: lot.floating_pnl,
        return_rate: 0,
        active_lots: 1,
      });
    } else {
      if (!existing.accounts.includes(lot.account_id)) existing.accounts.push(lot.account_id);
      const totalQty = existing.total_quantity + lot.remaining_quantity;
      const totalCost = existing.total_cost_basis + lot.cost_basis_unit * lot.remaining_quantity;
      existing.total_quantity = totalQty;
      existing.total_cost_basis = round(totalCost, 2);
      existing.avg_cost_price = totalQty > 0 ? round(totalCost / totalQty, 4) : existing.avg_cost_price;
      existing.current_price = lot.current_price;
      existing.price_source = lot.price_source;
      existing.market_value = round(existing.market_value + lot.market_value, 2);
      existing.floating_pnl = round(existing.floating_pnl + lot.floating_pnl, 2);
      existing.active_lots += 1;
    }
  }

  let portfolioCost = 0;
  let portfolioMkt = 0;
  let portfolioPnl = 0;
  let portfolioQty = 0;
  for (const item of symbolMap.values()) {
    item.return_rate = item.total_cost_basis > 0 ? round(item.floating_pnl / item.total_cost_basis, 4) : 0;
    portfolioCost = round(portfolioCost + item.total_cost_basis, 2);
    portfolioMkt = round(portfolioMkt + item.market_value, 2);
    portfolioPnl = round(portfolioPnl + item.floating_pnl, 2);
    portfolioQty += item.total_quantity;
  }

  const symbols = Array.from(symbolMap.values()).sort((a, b) => b.market_value - a.market_value);

  // --- per-account aggregation ------------------------------------------------
  const accountIds = new Set<string>();
  for (const lot of lotViewsAll) accountIds.add(lot.account_id);
  for (const id of tradeStats.keys()) accountIds.add(id);
  for (const id of dividendMap.keys()) accountIds.add(id);
  for (const acc of accounts) accountIds.add(acc.account_id);
  if (accountIds.size === 0) accountIds.add(DEFAULT_ACCOUNT_ID);

  const registered = new Map(accounts.map((a) => [a.account_id, a]));
  const accountSummaries: ApiAccountSummary[] = [];
  for (const accountId of Array.from(accountIds).sort()) {
    const ownLots = lotViewsAll.filter((lot) => lot.account_id === accountId);
    const ownSymbols = new Set(ownLots.map((lot) => lot.symbol));
    const cost = round(ownLots.reduce((sum, lot) => sum + lot.cost_basis_unit * lot.remaining_quantity, 0), 2);
    const mkt = round(ownLots.reduce((sum, lot) => sum + lot.market_value, 0), 2);
    const pnl = round(ownLots.reduce((sum, lot) => sum + lot.floating_pnl, 0), 2);
    const stats = tradeStats.get(accountId) ?? {
      closed_trades: 0,
      win_trades: 0,
      loss_trades: 0,
      realized_pnl: 0,
    };
    const dividends = dividendMap.get(accountId) ?? 0;
    const meta = registered.get(accountId);

    accountSummaries.push({
      account_id: accountId,
      name: meta?.name ?? accountId,
      broker_code: meta?.broker_code ?? "CUSTOM",
      currency: meta?.currency ?? "CNY",
      is_active: meta?.is_active ?? true,
      total_symbols: ownSymbols.size,
      total_active_lots: ownLots.length,
      total_cost: cost,
      total_market_value: mkt,
      total_floating_pnl: pnl,
      overall_return_rate: cost > 0 ? round(pnl / cost, 4) : 0,
      realized_pnl: stats.realized_pnl,
      dividends,
      withdrawn_cash: round(stats.realized_pnl + dividends, 2),
      closed_trades: stats.closed_trades,
      win_trades: stats.win_trades,
      loss_trades: stats.loss_trades,
      win_rate: stats.closed_trades > 0 ? round(stats.win_trades / stats.closed_trades, 4) : 0,
    });
  }

  const totals = accountSummaries.reduce(
    (acc, cur) => {
      acc.closed_trades += cur.closed_trades;
      acc.win_trades += cur.win_trades;
      acc.loss_trades += cur.loss_trades;
      acc.realized_pnl = round(acc.realized_pnl + cur.realized_pnl, 2);
      acc.dividends = round(acc.dividends + cur.dividends, 2);
      return acc;
    },
    { closed_trades: 0, win_trades: 0, loss_trades: 0, realized_pnl: 0, dividends: 0 },
  );

  return {
    status: "ok",
    version: TOOL_VERSION,
    db_path: options.dbPath,
    generated_at: now.getTime(),
    currency: "CNY",
    portfolio: {
      total_cost: portfolioCost,
      total_market_value: portfolioMkt,
      total_floating_pnl: portfolioPnl,
      overall_return_rate: portfolioCost > 0 ? round(portfolioPnl / portfolioCost, 4) : 0,
      full_position_cap: cap,
      remaining_budget: round(cap - portfolioMkt, 2),
      budget_utilization_rate: cap > 0 ? round(portfolioMkt / cap, 4) : 0,
      total_active_lots: activeRows.length,
      total_symbols_count: symbols.length,
      total_quantity: portfolioQty,
      realized_pnl: totals.realized_pnl,
      dividends: totals.dividends,
      withdrawn_cash: round(totals.realized_pnl + totals.dividends, 2),
      closed_trades: totals.closed_trades,
      win_trades: totals.win_trades,
      loss_trades: totals.loss_trades,
      win_rate: totals.closed_trades > 0 ? round(totals.win_trades / totals.closed_trades, 4) : 0,
    },
    accounts: accountSummaries,
    symbols,
  };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  // The dashboard is opened from file:// (Origin: null) or a different port, so a
  // permissive read-only CORS policy is exactly what a local, loopback-only API needs.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export interface RuntimeContext {
  dbPath: string;
  priceBook: PriceBook;
  fullPositionCap: number;
  startedAt: number;
  /** Mutable: overwritten with the OS-assigned port when `port: 0` was requested. */
  host: string;
  port: number;
}

/** Create the request handler. Kept separate from `Bun.serve` so tests can drive it directly. */
export function createRequestHandler(
  db: Database,
  ctx: RuntimeContext,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return jsonResponse({ status: "error", message: `仅支持 GET 请求 (收到 ${req.method})` }, 405);
      }

      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const route = path.toLowerCase();

      if (route === "/" || route === API_PREFIX) {
        return jsonResponse({
          status: "ok",
          service: "lot-trader-local-engine",
          version: TOOL_VERSION,
          host: ctx.host,
          port: ctx.port,
          endpoints: ["GET /api/health", "GET /api/summary", "GET /api/lots?symbol=&account=&status="],
        });
      }

      if (route === `${API_PREFIX}/health`) {
        const health: ApiHealth = {
          status: "ok",
          version: TOOL_VERSION,
          db_path: ctx.dbPath,
          timestamp: Date.now(),
          host: ctx.host,
          port: ctx.port,
          uptime_seconds: Math.max(0, Math.round((Date.now() - ctx.startedAt) / 1000)),
          endpoints: ["/api/health", "/api/summary", "/api/lots"],
        };
        return jsonResponse(health);
      }

      if (route === `${API_PREFIX}/summary`) {
        const summary = await buildSummaryPayload(db, {
          dbPath: ctx.dbPath,
          priceBook: ctx.priceBook,
          fullPositionCap: ctx.fullPositionCap,
        });
        return jsonResponse(summary);
      }

      if (route === `${API_PREFIX}/lots`) {
        const payload = await buildLotsPayload(db, {
          dbPath: ctx.dbPath,
          priceBook: ctx.priceBook,
          symbol: url.searchParams.get("symbol"),
          account: url.searchParams.get("account"),
          status: url.searchParams.get("status"),
        });
        return jsonResponse(payload);
      }

      return jsonResponse(
        {
          status: "error",
          message: `未知接口: ${path}`,
          endpoints: ["GET /api/health", "GET /api/summary", "GET /api/lots?symbol=&account=&status="],
        },
        404,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Read-only service: a bad filter is a client error, everything else is ours.
      const status = /非法批次状态|非法端口/.test(message) ? 400 : 500;
      return jsonResponse({ status: "error", message, path: new URL(req.url).pathname }, status);
    }
  };
}

/**
 * Start the loopback HTTP engine.
 * Throws a readable error (no stack leakage) when the port is taken or the host is not loopback.
 */
export async function startServe(options: ServeOptions = {}): Promise<StartedServe> {
  const host = resolveServeHost(options.host);
  const port = resolveServePort(options.port);
  const dbPath = resolveServeDbPath(options.dbPath);
  const appDb = new AppDatabase(dbPath);
  const db = appDb.getConnection();
  const priceBook = new PriceBook(options.quoteProvider, options.quoteCacheTtlMs);
  const startedAt = Date.now();

  const ctx: RuntimeContext = {
    dbPath,
    priceBook,
    fullPositionCap: resolveFullPositionCap(options.fullPositionCap),
    startedAt,
    host,
    port,
  };
  const handler = createRequestHandler(db, ctx);

  let server: Server<undefined>;
  try {
    // NOTE: `development: false` must NOT be set here — Bun then quietly enables
    // SO_REUSEPORT, so a second `trade serve` would "succeed" and silently load-balance
    // two engines on one port. Default mode keeps the bind exclusive (EADDRINUSE).
    server = Bun.serve({
      hostname: host,
      port,
      fetch: handler,
      error(err: Error) {
        return jsonResponse({ status: "error", message: err?.message ?? "internal error" }, 500);
      },
    });
  } catch (err: unknown) {
    appDb.close();
    if (isPortInUseError(err)) {
      const friendly = new Error(formatPortConflictError(host, port));
      (friendly as { code?: string }).code = "PORT_IN_USE";
      throw friendly;
    }
    if (err instanceof Error) throw err;
    throw new Error(`本地引擎启动失败: ${String(err)}`);
  }

  const actualPort = server.port ?? port;
  ctx.port = actualPort;

  return {
    server,
    host,
    port: actualPort,
    dbPath,
    version: TOOL_VERSION,
    url: `http://${host}:${actualPort}`,
    async stop(): Promise<void> {
      try {
        server.stop(true);
      } catch {
        // Already stopped: shutting down twice is not an error.
      }
      appDb.close();
    },
  };
}
