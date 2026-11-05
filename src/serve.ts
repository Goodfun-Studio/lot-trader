/**
 * Local HTTP microservice primitive for Lot Trader (`trade serve`).
 *
 * Design rules (deliberate, non-negotiable):
 *  - Loopback only. The engine holds the owner's complete ledger, so the listener is
 *    hard-restricted to `127.0.0.1` / `localhost` / `::1`; any other `--host` value is a
 *    hard error rather than a silent external exposure.
 *  - Read-only JSON API. `serve` never mutates the ledger; writes stay on the CLI.
 *  - Browser-hardened. Three independent gates run before any routing:
 *      1. `Host` must name a loopback literal (blocks DNS rebinding, which would
 *         otherwise let `attacker.example -> 127.0.0.1` read the ledger as same-origin);
 *      2. `Origin` must be absent (curl / local script), `null` (dashboard opened from
 *         `file://`) or a loopback origin. Anything else is a flat 403 with **no** CORS
 *         headers, so a hostile page can never read the response;
 *      3. Sensitive ledger endpoints require the local session credential
 *         (`Authorization: Bearer <token>` or `?token=<token>`). The token lives in a
 *         `0600` file only the current OS user can read, so "same machine" is no longer
 *         treated as "trusted caller": a hostile `Origin: null` sandboxed iframe can pass
 *         the CORS gate but still cannot read a single ledger field.
 *  - Every handler is defensive: a broken quote feed / missing table degrades the payload
 *    (cost-basis fallback) instead of throwing a 500 or emitting NaN.
 */
import type { Server } from "bun";
import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { AccountRepository, DEFAULT_ACCOUNT_ID } from "./accounts.ts";
import { computeFloatingPnl, getSellFeeRate, round } from "./calc.ts";
import { AppDatabase, DEFAULT_DB_PATH } from "./db.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";
import { getFullPositionCap } from "./config.ts";

export const TOOL_VERSION: string = (pkg as { version?: string }).version || "0.0.0";

export const DEFAULT_SERVE_PORT = 8080;
export const DEFAULT_SERVE_HOST = "127.0.0.1";

/** Session credential file: 0600, current OS user only. Mirrors Clawd's local protocol handshake. */
export const DEFAULT_TOKEN_FILE = join(homedir(), ".lot-trader", "session.token");
/** Credential bytes -> 64 hex chars. */
export const SESSION_TOKEN_BYTES = 32;
/** `rw-------`: the whole security story of the credential rests on this bitmask. */
export const TOKEN_FILE_MODE = 0o600;

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
  /** Fixed session token. When omitted a 32-byte random hex token is generated. */
  token?: string;
  /** Credential file path. Defaults to $LOT_TRADER_TOKEN_FILE / ~/.lot-trader/session.token. */
  tokenFile?: string;
  /** Suppress the startup banner. */
  quiet?: boolean;
}

/** `explicit` = supplied by `--token`; `generated` = random, regenerated every run. */
export type TokenSource = "explicit" | "generated";

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
  /** Layer 2 budget for this single symbol (same value for every symbol). */
  full_position_cap: number;
  /** `total_cost_basis / full_position_cap` — cost-side utilisation of the symbol budget. */
  cost_position_rate: number;
  /** `market_value / full_position_cap` — live utilisation of the symbol budget. */
  current_position_rate: number;
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
  /**
   * Layer 2 reference: the **per-symbol** full-position budget. It is deliberately *not*
   * a portfolio-wide wallet, so it must never be used for a global subtraction.
   */
  full_position_cap: number;
  /** Explains what `full_position_cap` measures: always `"per_symbol"`. */
  full_position_cap_scope: "per_symbol";
  /**
   * Always `null`. A portfolio-wide remaining budget requires a real total-capital config;
   * the old `cap - portfolioMarketValue` was a unit-mismatched subtraction and is gone.
   */
  remaining_budget: number | null;
  /** Always `null`. See `remaining_budget`: no portfolio-wide cap exists to divide by. */
  budget_utilization_rate: number | null;
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

/**
 * "查不到 ≠ 没有": an honest read on the ledger's own integrity.
 *
 * `degraded: true` never means the request failed — it means the numbers below are
 * *suspicious* and must be treated as "unknown", not as a legitimate empty book. The
 * classic silent failure is a `lots` table that was wiped (or a serve pointed at a fresh
 * empty file) while the `trades` history is still intact: that used to answer HTTP 200 +
 * `status: "ok"` with market value / holdings all 0, dressing data loss up as "flat today".
 */
export interface LedgerHealth {
  degraded: boolean;
  degraded_reason: string | null;
}

export interface ApiSummary extends LedgerHealth {
  status: "ok";
  version: string;
  db_path: string;
  generated_at: number;
  currency: "CNY";
  portfolio: ApiPortfolioSummary;
  accounts: ApiAccountSummary[];
  symbols: ApiSymbolSummary[];
}

export interface ApiLots extends LedgerHealth {
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
  /** Effective session credential (in-process callers only; never printed by the CLI). */
  token: string;
  /** 0600 credential file the token was written to. */
  tokenFile: string;
  tokenSource: TokenSource;
  /** True when the token was auto-generated and the file is removed on stop(). */
  ephemeralToken: boolean;
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
  // Priority: raw param > env var > config file > default (see config.ts)
  
  if (raw !== undefined && raw !== null && raw !== "") {
    const value = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  
  return getFullPositionCap();
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
// Session credential (0600 local-protocol handshake)
//
// Same-origin / loopback is a *network* boundary, not an *identity* one. The three gates
// above still leave one theoretical hole: a hostile page can be loaded inside a sandboxed
// iframe (`Origin: null`), which is indistinguishable from the owner's `file://` dashboard,
// and blind-fire GETs at 127.0.0.1. The fix is not another header rule but a secret the
// attacker simply cannot read: a 32-byte random token kept in a `0600` file owned by the
// current OS user. File permissions become the authentication boundary.
// ---------------------------------------------------------------------------

/** Resolve the credential file path: explicit flag -> $LOT_TRADER_TOKEN_FILE -> default. */
export function resolveSessionTokenFile(raw?: string | null): string {
  const explicit = (raw ?? "").trim();
  if (explicit) return explicit;
  const fromEnv = (process.env.LOT_TRADER_TOKEN_FILE ?? "").trim();
  return fromEnv || DEFAULT_TOKEN_FILE;
}

/** 32 random bytes -> 64 lowercase hex chars. Entropy is the point; never derive it. */
export function generateSessionToken(bytes: number = SESSION_TOKEN_BYTES): string {
  const size = Number.isInteger(bytes) && bytes > 0 ? bytes : SESSION_TOKEN_BYTES;
  return randomBytes(size).toString("hex");
}

/**
 * Persist the credential with `0600` from the very first byte.
 * `writeFileSync`'s `mode` is masked by umask, so the explicit `chmodSync` is authoritative.
 */
export function writeSessionTokenFile(tokenFile: string, token: string): string {
  const path = resolveSessionTokenFile(tokenFile);
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Recreate instead of patching: an inherited umask must never widen the file.
    if (existsSync(path)) chmodSync(path, TOKEN_FILE_MODE);
    writeFileSync(path, `${token}\n`, { mode: TOKEN_FILE_MODE });
    chmodSync(path, TOKEN_FILE_MODE);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`无法写入本地会话 Token 凭证文件 ${path}: ${reason}`);
  }
  return path;
}

/** Read a credential file, or null when it is missing / empty / unreadable. */
export function readSessionTokenFile(tokenFile: string): string | null {
  try {
    const value = readFileSync(tokenFile, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Delete a credential file (idempotent). Returns true when nothing is left behind.
 * `expectedToken` guards the shared-file case: a failed second `trade serve` (port already in
 * use) must not delete the credential the *running* instance just published.
 */
export function removeSessionTokenFile(tokenFile: string, expectedToken?: string): boolean {
  if (expectedToken !== undefined) {
    const current = readSessionTokenFile(tokenFile);
    if (current !== null && current !== expectedToken) return false;
  }
  try {
    rmSync(tokenFile, { force: true });
  } catch {
    // Fall through to the existence check below: a failed unlink is reported, not thrown.
  }
  return !existsSync(tokenFile);
}

/**
 * Constant-time credential comparison. Length mismatch short-circuits (timingSafeEqual
 * throws on unequal lengths) which leaks only the expected length — public knowledge.
 */
export function isTokenAuthorized(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  const exp = (expected ?? "").trim();
  const got = (provided ?? "").trim();
  if (!exp || !got) return false;
  const a = Buffer.from(exp, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Extract the credential from a request.
 *  - `Authorization: Bearer <token>` — normal clients / the dashboard runtime.
 *  - `?token=<token>` — SSE / static-front-end compatibility channel.
 */
export function extractRequestToken(req: Request, url: URL): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  const query = url.searchParams.get("token");
  if (query && query.trim()) return query.trim();
  return null;
}

/**
 * The only routes that may answer without a credential.
 * Both are ledger-free by construction: a liveness probe and the endpoint advertisement.
 */
export const PUBLIC_ROUTES = ["/", API_PREFIX, `${API_PREFIX}/health`] as const;

/** True for an explicitly public route (index / liveness). */
export function isPublicRoute(route: string): boolean {
  return (PUBLIC_ROUTES as readonly string[]).includes(route);
}

/**
 * True for every `/api/*` route that is not explicitly public.
 *
 * Fail-closed on purpose: `/api/summary` and `/api/lots` are the ledger endpoints today, but
 * the next one is protected the moment it is added — nobody has to remember to append it to a
 * list. A missing route also answers 401 instead of 404 when unauthenticated, so an attacker
 * cannot even enumerate which endpoints exist.
 */
export function isSensitiveRoute(route: string): boolean {
  const path = route || "/";
  if (isPublicRoute(path)) return false;
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
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

/**
 * Canonical account key: trimmed, **upper-cased**, blank -> `DEFAULT`.
 *
 * Account ids are case-insensitive by contract: the ledger stores `CMB`, so `?account=cmb`,
 * `?account=CMB` and `?account=Cmb` must all resolve to the same account. Normalizing on both
 * the filter side and the row side is what makes that true (a one-sided `.toUpperCase()` would
 * silently return zero rows).
 */
export function normalizeAccountKey(raw?: string | null): string {
  const value = (raw ?? "").trim().toUpperCase();
  return value || DEFAULT_ACCOUNT_ID;
}

/**
 * True only for the *expected* legacy-ledger shapes: a schema object that does not exist yet.
 * Everything else (`SQLITE_BUSY`, `SQLITE_LOCKED`, disk I/O, corruption) must stay loud.
 */
function isMissingSchemaError(err: unknown): boolean {
  const message = String((err as { message?: string })?.message ?? err ?? "");
  return /no such (table|column)/i.test(message);
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

/** Columns every historical trader ledger is guaranteed to carry. */
const REQUIRED_LOT_COLUMNS = [
  "lot_id",
  "symbol",
  "buy_time",
  "buy_price",
  "buy_quantity",
  "remaining_quantity",
  "cost_basis_unit",
  "status",
] as const;

/**
 * Columns introduced by later migrations. A pre-migration ledger is tolerated by mapping the
 * *documented* fallback for that exact column — never by pretending the whole table is empty.
 */
const OPTIONAL_LOT_COLUMN_FALLBACKS: Record<string, string> = {
  account_id: `'${DEFAULT_ACCOUNT_ID}'`,
  pyramid_level: "0",
  is_day_trading: "0",
  peak_price: "NULL",
  trailing_stop_active: "0",
  buy_reason: "NULL",
  close_reason: "NULL",
  close_time: "NULL",
  close_avg_price: "NULL",
  realized_pnl: "0",
};

/** Physical column names of a table. Unknown table => empty set (schema-level, not an error). */
function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Read the whole ledger once, joined with symbol metadata.
 *
 * Deliberately **not** wrapped in a blanket `try { ... } catch { return []; }`: that used to
 * launder `SQLITE_BUSY` / `SQLITE_LOCKED` / I/O failures into "the owner holds nothing", a false
 * 200 with an empty book. Legacy-schema compatibility is handled *explicitly* per column via
 * `PRAGMA table_info`, so a genuine database failure propagates and becomes an HTTP 500.
 */
export function readLedgerLots(db: Database): LedgerLotRow[] {
  const lotCols = tableColumns(db, "lots");
  const missing = REQUIRED_LOT_COLUMNS.filter((col) => !lotCols.has(col));
  if (missing.length > 0) {
    throw new Error(
      `数据库查询失败: lots 表缺少必需列 [${missing.join(", ")}]，该文件不是可用的 trade 账本。`,
    );
  }

  const lotExpr = (col: string): string => {
    if (lotCols.has(col)) return `l.${col}`;
    const fallback = OPTIONAL_LOT_COLUMN_FALLBACKS[col];
    if (fallback === undefined) {
      throw new Error(`数据库查询失败: lots 表缺少列 ${col}。`);
    }
    return `${fallback} AS ${col}`;
  };

  const symbolCols = tableColumns(db, "symbols");
  const hasSymbols = symbolCols.size > 0;
  const symExpr = (col: string, alias: string): string =>
    hasSymbols && symbolCols.has(col) ? `s.${col} AS ${alias}` : `NULL AS ${alias}`;

  const sql = `
    SELECT ${lotExpr("lot_id")}, ${lotExpr("account_id")}, ${lotExpr("symbol")},
           ${symExpr("name", "symbol_name")}, ${symExpr("asset_class", "asset_class")},
           ${symExpr("settlement_mode", "settlement_mode")},
           ${lotExpr("buy_time")}, ${lotExpr("buy_price")}, ${lotExpr("buy_quantity")},
           ${lotExpr("remaining_quantity")},
           ${lotExpr("cost_basis_unit")}, ${lotExpr("status")}, ${lotExpr("pyramid_level")},
           ${lotExpr("is_day_trading")},
           ${lotExpr("peak_price")}, ${lotExpr("trailing_stop_active")},
           ${lotExpr("buy_reason")}, ${lotExpr("close_reason")}, ${lotExpr("close_time")},
           ${lotExpr("close_avg_price")}, ${lotExpr("realized_pnl")}
    FROM lots l
    ${hasSymbols ? "LEFT JOIN symbols s ON l.symbol = s.symbol" : ""}
    ORDER BY datetime(l.buy_time) DESC, l.lot_id ASC
  `;
  return db.query<LedgerLotRow, []>(sql).all();
}

/**
 * Count rows in a bookkeeping table, tolerating only the documented "not migrated yet" case.
 * A genuine query failure (`SQLITE_BUSY`, corruption, I/O) must stay loud — silently reading
 * it as "0 rows" is exactly the class of lie this health probe exists to prevent.
 */
function countRows(db: Database, table: string): { count: number; schemaMissing: boolean } {
  try {
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return { count: Number(row?.n ?? 0), schemaMissing: false };
  } catch (err: unknown) {
    if (!isMissingSchemaError(err)) throw err;
    return { count: 0, schemaMissing: true };
  }
}

/**
 * Decide whether the ledger can be trusted at all — "查不到 ≠ 没有".
 *
 * The negative half is just as important as the positive half: a brand-new, schema-only
 * database (no trades, no lots) is a legitimate empty book and MUST stay `degraded: false`.
 * Only inside-inconsistent states are flagged:
 *
 *  1. `trades` carries history but `lots` is 0 rows  -> the lot book was wiped / switched to
 *     a wrong (empty) file; market value and holdings are unknown, not zero.
 *  2. `trades` carries history but there are no ACTIVE lots -> abnormal empty state; ask the
 *     owner to verify before reading it as "flat today".
 *  3. CLOSED lots exist but `trades` is empty -> the executed-trade journal was lost.
 *  4. `symbols` exists but was emptied while lots remain -> asset classification is gone.
 */
export function assessLedgerHealth(db: Database, rows: LedgerLotRow[]): LedgerHealth {
  const totalLots = rows.length;
  const activeLots = rows.filter((r) => String(r.status ?? "").toUpperCase() === "ACTIVE").length;
  const closedLots = rows.filter((r) => String(r.status ?? "").toUpperCase() === "CLOSED").length;

  const trades = countRows(db, "trades");

  // 1. History exists but the lot book is structurally empty: the dangerous silent-empty case.
  if (trades.count > 0 && totalLots === 0) {
    return {
      degraded: true,
      degraded_reason:
        `成交流水表(trades) 有 ${trades.count} 笔历史记录，但批次表(lots)为 0 行：` +
        `账本结构疑似被清空或误切空库，当前持仓与市值不可信，请核验数据库文件完整性。`,
    };
  }

  // 2. History exists but nothing is on the books any more: do not read this as a flat book.
  if (trades.count > 0 && activeLots === 0) {
    return {
      degraded: true,
      degraded_reason:
        `成交流水表(trades) 有 ${trades.count} 笔历史记录与 ${closedLots} 笔已平仓批次，` +
        `但当前活跃批次为 0 笔：疑似误清空或误切空库，请在确认前将当前市值视为未知，` +
        `并核验数据库文件完整性。`,
    };
  }

  // 3. Executed-trade journal lost while CLOSED lots remain.
  if (!trades.schemaMissing && trades.count === 0 && closedLots > 0) {
    return {
      degraded: true,
      degraded_reason:
        `存在 ${closedLots} 笔已平仓批次，但成交流水表(trades)为 0 行：平仓流水疑似丢失，` +
        `已实现盈亏与现金口径不可信，请核验数据库文件完整性。`,
    };
  }

  // 4. Symbol metadata table exists but was emptied: classification is unresolvable.
  if (activeLots > 0 && tableColumns(db, "symbols").size > 0) {
    const symbols = countRows(db, "symbols");
    if (!symbols.schemaMissing && symbols.count === 0) {
      return {
        degraded: true,
        degraded_reason:
          `存在 ${activeLots} 笔活跃批次，但标的元数据表(symbols)为 0 行：资产分类与名称不可信，` +
          `请核验数据库文件完整性。`,
      };
    }
  }

  return { degraded: false, degraded_reason: null };
}

/**
 * Every account id the ledger or the registry knows about, normalized to the canonical key.
 * Used to reject `?account=NOPE` with a 400 instead of a misleading 200 + empty list.
 * Only a missing table / column is tolerated; real database errors propagate.
 */
export function readKnownAccountKeys(db: Database): Set<string> {
  const keys = new Set<string>();
  const collect = (sql: string): void => {
    try {
      for (const row of db.query<{ account_id: string | null }, []>(sql).all()) {
        const key = normalizeAccountKey(row.account_id);
        if (key) keys.add(key);
      }
    } catch (err: unknown) {
      if (!isMissingSchemaError(err)) throw err;
      // Pre-registry / pre-ledger schema: this source simply contributes no accounts.
    }
  };

  collect("SELECT account_id FROM accounts");
  for (const table of ["lots", "trades", "dividends"]) {
    collect(`SELECT DISTINCT account_id FROM ${table} WHERE account_id IS NOT NULL`);
  }
  if (keys.size === 0) keys.add(DEFAULT_ACCOUNT_ID);
  return keys;
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
  // Account filter: blank / `ALL` means "no filter"; anything else is case-insensitively
  // normalized and validated against the registry + ledger before a single row is read.
  const rawAccount = (options.account ?? "").trim();
  const accountFilter =
    !rawAccount || rawAccount.toUpperCase() === "ALL" ? null : rawAccount.toUpperCase();
  if (accountFilter && !readKnownAccountKeys(db).has(accountFilter)) {
    // A 200 with an empty list would be a lie: the account simply is not registered.
    throw new Error(`非法账户代码: "${rawAccount}"。该账户未在系统中登记。`);
  }

  // Health is judged on the *whole* ledger, never on the filtered slice: `?symbol=X` with no
  // match is a legitimate empty result, not a degraded book.
  const allRows = readLedgerLots(db);
  const health = assessLedgerHealth(db, allRows);
  const rows = allRows.filter((row) => {
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
    degraded: health.degraded,
    degraded_reason: health.degraded_reason,
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
  } catch (err: unknown) {
    // Only a genuinely absent `trades` table degrades to "no closed trades".
    if (!isMissingSchemaError(err)) throw err;
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
  } catch (err: unknown) {
    // No dividends table (pre-migration ledger): zero dividends is the honest answer.
    // A real query failure, however, must not be dressed up as "no dividends".
    if (!isMissingSchemaError(err)) throw err;
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
  // "查不到 ≠ 没有": a structurally emptied book must be reported as degraded, never as a
  // legitimate flat portfolio. A brand-new schema-only ledger keeps `degraded: false`.
  const health = assessLedgerHealth(db, allRows);
  const activeRows = allRows.filter((r) => String(r.status ?? "").toUpperCase() === "ACTIVE");
  const prices = await options.priceBook.load(activeRows.map((r) => r.symbol));
  const tradeStats = readTradeStats(db);
  const dividendMap = readDividends(db);

  const accountsRepo = new AccountRepository(db);
  let accounts: Array<{ account_id: string; name: string; broker_code: string; currency: string; is_active: boolean }> = [];
  try {
    accounts = accountsRepo.listAccounts(true);
  } catch (err: unknown) {
    // Pre-account-registry ledger: no registry rows to enrich with.
    if (!isMissingSchemaError(err)) throw err;
    accounts = [];
  }

  // --- per-lot valuation (single source of truth for P&L) ----------------------
  const lotViewsAll: ApiLot[] = activeRows.map((row) => {
    const hit = prices[row.symbol];
    return buildApiLot(row, hit?.price ?? 0, hit?.source ?? "cost_basis", now);
  });

  // --- per-symbol aggregation -------------------------------------------------
  // Layer 2 is the only layer where `full_position_cap` is meaningful: it is the
  // *per-symbol* budget, so "how full is this symbol" is a well-defined question here.
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
        full_position_cap: cap,
        cost_position_rate: 0,
        current_position_rate: 0,
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
    // Single-symbol utilisation against the single-symbol cap (Layer 2 semantics).
    item.cost_position_rate = cap > 0 ? round(item.total_cost_basis / cap, 4) : 0;
    item.current_position_rate = cap > 0 ? round(item.market_value / cap, 4) : 0;
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
  // Registry ids are normalized too, so a lower-case legacy row can never fork a second summary.
  for (const acc of accounts) accountIds.add(normalizeAccountKey(acc.account_id));
  if (accountIds.size === 0) accountIds.add(DEFAULT_ACCOUNT_ID);

  const registered = new Map(accounts.map((a) => [normalizeAccountKey(a.account_id), a]));
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
    degraded: health.degraded,
    degraded_reason: health.degraded_reason,
    currency: "CNY",
    portfolio: {
      total_cost: portfolioCost,
      total_market_value: portfolioMkt,
      total_floating_pnl: portfolioPnl,
      overall_return_rate: portfolioCost > 0 ? round(portfolioPnl / portfolioCost, 4) : 0,
      // Layer 1 must NOT pretend to own a wallet. `full_position_cap` is the Layer 2
      // (per-symbol) budget; subtracting the whole portfolio's market value from one
      // symbol's budget produced absurd numbers (-1,170,601.42 remaining budget and a
      // 2412% utilisation). A portfolio-wide budget needs a real total-capital config,
      // which does not exist yet, so the honest answer is `null` + an explicit scope tag.
      full_position_cap: cap,
      full_position_cap_scope: "per_symbol" as const,
      remaining_budget: null,
      budget_utilization_rate: null,
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

//
// SECURITY GATE 1 — DNS-rebinding guard on the `Host` header.
//
// Binding to 127.0.0.1 is NOT sufficient on its own: a hostile domain that resolves to
// 127.0.0.1 (DNS rebinding) makes the browser treat `http://evil.example/api/summary` as
// same-origin, so the CORS layer is bypassed entirely. The only reliable discriminator is
// the request's own `Host` (HTTP/1.1) / `:authority` (HTTP/2+) header, so every request
// must name a loopback literal. Exact-match only: no suffix, wildcard or substring rules.

/** Loopback names accepted in the `Host` header (bracketed and bare IPv6 forms). */
export const ALLOWED_HOST_HEADER_NAMES = [
  "127.0.0.1",
  "localhost",
  "[::1]",
  "::1",
  "[0:0:0:0:0:0:0:1]",
  "0:0:0:0:0:0:0:1",
] as const;

/** Origins may only point back at the loopback interface (same set as the Host guard). */
export const ALLOWED_ORIGIN_HOSTS = ALLOWED_HOST_HEADER_NAMES;

const ALLOWED_HOST_HEADER_SET: ReadonlySet<string> = new Set(ALLOWED_HOST_HEADER_NAMES);

/** Split `host[:port]`, tolerating the bracket form `[::1]:8080`. Null when malformed. */
function splitHostAndPort(raw: string): { host: string; port: string | null } | null {
  // A single trailing dot is DNS-equivalent (`localhost.` === `localhost`).
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value) return null;

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    const bracketHost = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (!rest) return { host: bracketHost, port: null };
    if (!rest.startsWith(":")) return null;
    return { host: bracketHost, port: rest.slice(1) };
  }

  const firstColon = value.indexOf(":");
  if (firstColon < 0) return { host: value, port: null };
  // Two or more colons => a bare IPv6 literal, which can never carry a port unbracketed.
  if (value.indexOf(":", firstColon + 1) >= 0) return { host: value, port: null };
  return { host: value.slice(0, firstColon), port: value.slice(firstColon + 1) };
}

/** True only for loopback `Host` / `:authority` values (an optional numeric port is allowed). */
export function isAllowedHostHeader(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const parsed = splitHostAndPort(raw);
  if (!parsed) return false;
  if (parsed.port !== null && !/^\d{1,5}$/.test(parsed.port)) return false;
  return ALLOWED_HOST_HEADER_SET.has(parsed.host);
}

//
// SECURITY GATE 2 — CORS allow-list on the `Origin` header.
//
// `Access-Control-Allow-Origin: *` used to let ANY web page the owner happened to have
// open read the whole ledger off 127.0.0.1:8080. Now the only readable origins are the
// ones a *local* dashboard can produce:
//   * `null`            — HTML opened from `file://`
//   * http(s)://127.0.0.1[:port] | localhost[:port] | [::1][:port]
// Everything else gets 403 and, critically, no `Access-Control-Allow-Origin` at all.

/** Canonical origin to echo back, or null when the origin is not allow-listed. */
export function resolveAllowedOrigin(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  // `file://` documents send the literal string `null` (opaque origin).
  if (value.toLowerCase() === "null") return "null";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  if (!ALLOWED_HOST_HEADER_SET.has(parsed.hostname.toLowerCase())) return null;
  return value;
}

/** True only for the origins a local dashboard (or a loopback dev server) can produce. */
export function isAllowedOrigin(raw: string | null | undefined): boolean {
  return raw != null && resolveAllowedOrigin(raw) !== null;
}

/** Sentinel returned for a request that carries no `Origin` header at all (curl, scripts). */
export const NO_ORIGIN = Symbol("no-origin");

export type OriginVerdict = string | null | typeof NO_ORIGIN;

/**
 * Gate 2 verdict:
 *  - `NO_ORIGIN`  -> no `Origin` header; allow, emit no CORS origin header.
 *  - `string`     -> allow-listed; echo this exact value back.
 *  - `null`       -> rejected; the caller must 403 without any CORS origin header.
 */
export function checkRequestOrigin(raw: string | null): OriginVerdict {
  if (raw == null) return NO_ORIGIN;
  const echo = resolveAllowedOrigin(raw);
  return echo === null ? null : echo;
}

/** CORS headers for an already-validated origin. `NO_ORIGIN` emits no origin header. */
function corsHeaders(origin: OriginVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    // `Authorization` is required in the allow-list so a `file://` dashboard's credentialed
    // GET survives the preflight instead of being rejected by the browser itself.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  if (typeof origin === "string") headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(body: unknown, status = 200, origin: OriginVerdict = NO_ORIGIN): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

/**
 * Flat 403 for a blocked request. Deliberately carries **no** `Access-Control-Allow-Origin` and
 * no ledger field of any kind: a hostile page must not be able to read even the rejection.
 */
export function securityBlockResponse(kind: "host" | "origin"): Response {
  const message =
    kind === "host"
      ? "安全拦截：Host 请求头不是本地回环地址（仅允许 127.0.0.1 / localhost / [::1]），已拒绝处理。"
      : "安全拦截：请求来源（Origin）不在本地白名单内（仅允许本地看板的 Origin: null 与 http://127.0.0.1 / http://localhost / http://[::1]），已拒绝处理。";
  return new Response(
    JSON.stringify(
      {
        status: "error",
        code: kind === "host" ? "HOST_NOT_ALLOWED" : "ORIGIN_NOT_ALLOWED",
        message,
      },
      null,
      2,
    ),
    {
      status: 403,
      // No CORS origin on purpose; Vary keeps caches from mixing verdicts.
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Origin",
      },
    },
  );
}

export interface RuntimeContext {
  dbPath: string;
  priceBook: PriceBook;
  fullPositionCap: number;
  startedAt: number;
  /** Effective session credential for the sensitive endpoints. */
  sessionToken: string;
  /** Mutable: overwritten with the OS-assigned port when `port: 0` was requested. */
  host: string;
  port: number;
}

/**
 * Flat 401 for a sensitive endpoint without a valid credential.
 * The body is deliberately **ledger-free** and the refusal happens before any query runs:
 * a rejected caller learns only that it was rejected.
 */
export function unauthorizedResponse(origin: OriginVerdict = NO_ORIGIN): Response {
  return jsonResponse(
    {
      status: "error",
      code: "UNAUTHORIZED",
      message: "未授权：请提供合法的本地会话 Token。",
    },
    401,
    origin,
  );
}

/** Create the request handler. Kept separate from `Bun.serve` so tests can drive it directly. */
export function createRequestHandler(
  db: Database,
  ctx: RuntimeContext,
): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    // --- Security gates: both run before routing, methods and business logic ---
    // 1) DNS rebinding: the request must be addressed to a loopback literal.
    const hostHeader = req.headers.get("host");
    if (!isAllowedHostHeader(hostHeader)) {
      return securityBlockResponse("host");
    }
    // 2) CORS: only a local dashboard origin (or no origin at all) may read the ledger.
    const origin = checkRequestOrigin(req.headers.get("origin"));
    if (origin === null) {
      return securityBlockResponse("origin");
    }

    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return jsonResponse({ status: "error", message: `仅支持 GET 请求 (收到 ${req.method})` }, 405, origin);
      }

      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const route = path.toLowerCase();

      if (route === "/" || route === API_PREFIX) {
        return jsonResponse(
          {
            status: "ok",
            service: "lot-trader-local-engine",
            version: TOOL_VERSION,
            host: ctx.host,
            port: ctx.port,
            auth: "bearer",
            endpoints: ["GET /api/health", "GET /api/summary", "GET /api/lots?symbol=&account=&status="],
          },
          200,
          origin,
        );
      }

      // --- Security gate 3: session credential on every ledger endpoint ---
      // Runs *before* the payload builders, so an unauthorized call touches no table.
      if (isSensitiveRoute(route) && !isTokenAuthorized(ctx.sessionToken, extractRequestToken(req, url))) {
        return unauthorizedResponse(origin);
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
        return jsonResponse(health, 200, origin);
      }

      if (route === `${API_PREFIX}/summary`) {
        const summary = await buildSummaryPayload(db, {
          dbPath: ctx.dbPath,
          priceBook: ctx.priceBook,
          fullPositionCap: ctx.fullPositionCap,
        });
        return jsonResponse(summary, 200, origin);
      }

      if (route === `${API_PREFIX}/lots`) {
        const payload = await buildLotsPayload(db, {
          dbPath: ctx.dbPath,
          priceBook: ctx.priceBook,
          symbol: url.searchParams.get("symbol"),
          account: url.searchParams.get("account"),
          status: url.searchParams.get("status"),
        });
        return jsonResponse(payload, 200, origin);
      }

      return jsonResponse(
        {
          status: "error",
          message: `未知接口: ${path}`,
          endpoints: ["GET /api/health", "GET /api/summary", "GET /api/lots?symbol=&account=&status="],
        },
        404,
        origin,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const path = new URL(req.url).pathname;
      // A real database failure (SQLITE_BUSY / SQLITE_LOCKED / I/O) is a 500 with an
      // explicit `DATABASE_ERROR` code — never a 200 carrying a fabricated empty book.
      if (
        /SQLITE_|database is locked|database table is locked|disk I\/O error|not a database|malformed|数据库查询失败/i.test(
          message,
        )
      ) {
        const detail = message.startsWith("数据库查询失败") ? message : `数据库查询失败: ${message}`;
        return jsonResponse({ status: "error", code: "DATABASE_ERROR", message: detail, path }, 500, origin);
      }
      // Read-only service: a bad filter is a client error, everything else is ours.
      const status = /非法批次状态|非法端口|非法账户/.test(message) ? 400 : 500;
      return jsonResponse({ status: "error", message, path }, status, origin);
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

  // --- Read-only service: never materialize a ledger ------------------------------
  // `AppDatabase` used to mkdir + create + WAL an empty SQLite file when the path was a typo,
  // then serve a green "status: ok" with an all-zero portfolio. A read-only engine must refuse:
  // no file, no `-wal`, no `-shm`, exit code 1 with a friendly message.
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    throw new Error(
      `数据库文件不存在: ${dbPath}。trade serve 为只读服务，拒绝隐式建库。`,
    );
  }

  // --- Credential lifecycle: generate (or accept) -> persist 0600 -> drop on shutdown ---
  // The file is written only *after* the listener is bound: a failed boot (port in use)
  // must never clobber the credential a running instance just published.
  const explicitToken = (options.token ?? "").trim();
  const tokenSource: TokenSource = explicitToken ? "explicit" : "generated";
  const sessionToken = explicitToken || generateSessionToken();
  const tokenFile = resolveSessionTokenFile(options.tokenFile);
  const ephemeralToken = tokenSource === "generated";

  const appDb = new AppDatabase(dbPath);
  const db = appDb.getConnection();
  const priceBook = new PriceBook(options.quoteProvider, options.quoteCacheTtlMs);
  const startedAt = Date.now();

  const ctx: RuntimeContext = {
    dbPath,
    priceBook,
    fullPositionCap: resolveFullPositionCap(options.fullPositionCap),
    startedAt,
    sessionToken,
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

  try {
    writeSessionTokenFile(tokenFile, sessionToken);
  } catch (err: unknown) {
    // No credential on disk means no dashboard can ever authenticate: fail loud, not open.
    try {
      server.stop(true);
    } catch {
      /* already down */
    }
    appDb.close();
    throw err instanceof Error ? err : new Error(String(err));
  }

  return {
    server,
    host,
    port: actualPort,
    dbPath,
    version: TOOL_VERSION,
    url: `http://${host}:${actualPort}`,
    token: sessionToken,
    tokenFile,
    tokenSource,
    ephemeralToken,
    async stop(): Promise<void> {
      try {
        server.stop(true);
      } catch {
        // Already stopped: shutting down twice is not an error.
      }
      appDb.close();
      // Generated credentials die with the process; an explicitly supplied one is the
      // owner's property and is left in place.
      if (ephemeralToken) removeSessionTokenFile(tokenFile, sessionToken);
    },
  };
}
