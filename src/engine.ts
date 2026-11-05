/**
 * Lot Trader engine services.
 */
import { Database } from "bun:sqlite";
import { Lot, LotStatus, SettlementMode, Signal, Trade, Dividend, AssetClass } from "./models.ts";
import { computeCostBasis, computeFloatingPnl, getSellFeeRate } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { SignalScanner } from "./scanner.ts";
import { LotCloser, appendReason } from "./closer.ts";
import { QuoteProvider, normalizeSymbol, inferSymbolMetadata } from "./quotes.ts";
import { PositionAggregator, PositionSummary, PositionHierarchicalView } from "./position.ts";
import { Account, AccountRepository, DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./accounts.ts";

/**
 * Ledger price guard (D-09).
 *
 * Every write path (lot buy / add / close) must carry a finite, strictly positive price.
 * `parseFloat("abc")` yields NaN, and NaN / Infinity / 0 / negative numbers used to reach the
 * INSERT untouched, poisoning the ledger with `buy_price = NULL`, `cost_basis_unit = NULL` and
 * even negative fees. The check therefore runs before any write (and before the transaction), so
 * a rejected call leaves the ledger byte-for-byte unchanged.
 */
export function assertLegalFillPrice(price: number, context: string): void {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new Error(
      "非法成交价：" +
        context +
        " 必须为有限正数 (> 0，且非 NaN / Infinity)，当前输入: " +
        String(price) +
        "，已拒绝写入账本"
    );
  }
}

/**
 * Fill-time guard (D-01).
 *
 * `--time` exists to backfill history, so a past timestamp is legitimate. A FUTURE timestamp is
 * not: it used to be silently trusted as "now" for the 48h anti-shake window, which let a caller
 * forge `--time` to walk straight through the cooldown guard on the same lineage. It is also
 * refused because every derived stamp (lot_id date, trade_id, buy_time) would otherwise drift
 * ahead of the real clock. `realNow` must always be the wall clock, never a supplied fill time.
 */
export function assertFillTimeNotInFuture(fillTime: Date | undefined, realNow: Date, context: string): void {
  if (fillTime === undefined || fillTime === null) return;
  const fillMs = fillTime.getTime();
  if (Number.isNaN(fillMs)) {
    throw new Error("非法成交时间：" + context + " 无法解析为有效时间戳，已拒绝写入账本");
  }
  if (fillMs > realNow.getTime()) {
    throw new Error(
      "成交时间不得晚于当前时间：" +
        context +
        " 传入 " +
        fillTime.toISOString() +
        " 晚于当前 " +
        realNow.toISOString() +
        "，已拒绝写入账本"
    );
  }
}

/**
 * Hard-cap violation ratio formatter (D-06).
 *
 * The guard trips at `ratio > 30% + 1e-6`, i.e. the true ratio is always at least 30.0001%. At 2
 * decimals the text rounded back to "30.00%" and read as self-contradictory ("30.00% 超过
 * 30.00%"); 4 decimals keeps every tripping value distinguishable from the threshold.
 */
export function formatPositionCapRatio(ratio: number): string {
  return (ratio * 100).toFixed(4) + "%";
}

export interface LotListItem {
  lot_id: string;
  account_id: string;
  symbol: string;
  symbol_name: string;
  settlement_mode: string;
  buy_time: string;
  buy_price: number;
  buy_quantity: number;
  remaining_quantity: number;
  cost_basis_unit: number;
  current_price: number;
  floating_pnl: number;
  return_rate: number;
  status: string;
  pyramid_level: number;
  can_sell_now: boolean;
  is_day_trading: boolean;
  peak_price?: number | null;
  trailing_stop_active?: boolean;
  buy_reason?: string | null;
  close_reason?: string | null;
  realized_pnl: number;
}

export interface TradeAttribution {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_realized_pnl: number;
  profit_factor: number;
}

export interface TradingStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_realized_pnl: number;
  profit_factor: number;
  day_trades_count: number;
  by_symbol: Record<string, TradeAttribution>;
  by_trade_type: {
    regular_swing: TradeAttribution;
    native_t0: TradeAttribution;
    core_substitution_t0: TradeAttribution;
  };
}

export class TraderEngine {

  public ensureSymbol(symbolInput: string, customName?: string, assetClassOverride?: AssetClass, settlementModeOverride?: SettlementMode) {
    const meta = inferSymbolMetadata(symbolInput);
    const stdSymbol = meta.stdSymbol;

    let symRow = this.conn.query<{
      symbol: string;
      name: string;
      asset_class: string;
      settlement_mode: string;
    }, [string]>("SELECT * FROM symbols WHERE symbol = ?").get(stdSymbol);

    if (!symRow) {
      const assetClass = assetClassOverride || meta.assetClass;
      const setMode = settlementModeOverride || meta.settlementMode;
      const name = customName && customName.trim() ? customName.trim() : meta.cleanCode;

      this.conn.run(
        "INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode) VALUES (?, ?, ?, ?)",
        [stdSymbol, name, assetClass, setMode]
      );

      symRow = this.conn.query<any, [string]>("SELECT * FROM symbols WHERE symbol = ?").get(stdSymbol);
    }
    return symRow;
  }

  public conn: Database;
  public quoteProvider: QuoteProvider;
  public arbitrator: SettlementArbitrator;
  public scanner: SignalScanner;
  public closer: LotCloser;
  public positionAggregator: PositionAggregator;
  public accounts: AccountRepository;
  public portfolioBudget?: number;

  constructor(dbConn: Database, quoteProvider?: QuoteProvider, portfolioBudget?: number) {
    this.conn = dbConn;
    this.quoteProvider = quoteProvider || new QuoteProvider();
    this.arbitrator = new SettlementArbitrator(dbConn);
    this.scanner = new SignalScanner(dbConn);
    this.closer = new LotCloser(dbConn);
    this.positionAggregator = new PositionAggregator(dbConn, this.quoteProvider);
    this.accounts = new AccountRepository(dbConn);
    this.portfolioBudget = portfolioBudget;
  }

  // ---------------------------------------------------------------------------
  // Account registry primitives (trade account list / add)
  // ---------------------------------------------------------------------------

  public listAccounts(includeInactive: boolean = false): Account[] {
    return this.accounts.listAccounts(includeInactive);
  }

  public getAccount(accountId: string): Account | null {
    return this.accounts.getAccount(accountId);
  }

  public addAccount(
    accountId: string,
    options: { name: string; brokerCode?: string; currency?: string },
  ): Account {
    return this.accounts.addAccount(accountId, options);
  }

  public ensureAccount(accountId?: string | null): Account {
    return this.accounts.ensureAccount(accountId);
  }

  /** `--account ALL` (or empty) means "no account filter", everything else is an exact account id. */
  public resolveAccountFilter(accountId?: string | null): string | undefined {
    if (!accountId) return undefined;
    const trimmed = accountId.trim();
    if (!trimmed || trimmed.toUpperCase() === "ALL") return undefined;
    return normalizeAccountId(trimmed);
  }

  /**
   * Risk Guard Middleware: Check 30% single-symbol position cap against total portfolio value.
   * Total portfolio value = sum of remaining active lots market value (or buy cost) + incoming buy cost.
   * If existing active lots exist and adding this lot causes the symbol's value to exceed 30% of total portfolio value,
   * it throws an error.
   */
  public checkPositionCap(stdSymbol: string, incomingValue: number): void {
    let budget = this.portfolioBudget;
    if (!budget && process.env.LOT_TRADER_PORTFOLIO_BUDGET) {
      budget = parseFloat(process.env.LOT_TRADER_PORTFOLIO_BUDGET);
    }

    const activeLots = this.conn.query<{
      symbol: string;
      remaining_quantity: number;
      buy_price: number;
      cost_basis_unit: number;
    }, []>("SELECT symbol, remaining_quantity, buy_price, cost_basis_unit FROM lots WHERE status = 'ACTIVE'").all();

    let existingTargetSymbolValue = 0;
    let otherSymbolsValue = 0;

    for (const l of activeLots) {
      const val = Number(l.remaining_quantity) * Number(l.buy_price);
      if (l.symbol === stdSymbol) {
        existingTargetSymbolValue += val;
      } else {
        otherSymbolsValue += val;
      }
    }

    const newTargetSymbolValue = existingTargetSymbolValue + incomingValue;

    if (budget && budget > 0) {
      const totalBase = Math.max(budget, otherSymbolsValue + newTargetSymbolValue);
      const ratio = newTargetSymbolValue / totalBase;
      if (ratio > 0.3000 + 1e-6) {
        throw new Error(
          "单标的持仓硬顶风控拦截：买入后标的 " + stdSymbol + " 估算持仓占比为 " + formatPositionCapRatio(ratio) + "，超过 30.00% 组合级硬顶红线 (标的总额 " + newTargetSymbolValue.toFixed(2) + " / 组合总值 " + totalBase.toFixed(2) + ")！"
        );
      }
    } else if (otherSymbolsValue > 0) {
      const totalPortfolioValue = otherSymbolsValue + newTargetSymbolValue;
      const ratio = newTargetSymbolValue / totalPortfolioValue;
      if (ratio > 0.3000 + 1e-6) {
        throw new Error(
          "单标的持仓硬顶风控拦截：买入后标的 " + stdSymbol + " 估算持仓占比为 " + formatPositionCapRatio(ratio) + "，超过 30.00% 组合级硬顶红线 (标的总额 " + newTargetSymbolValue.toFixed(2) + " / 组合总值 " + totalPortfolioValue.toFixed(2) + ")！"
        );
      }
    }
  }

  /**
   * Lineage Guard: Anti-shake cooldown check for pyramid dip buys.
   * If any lot in the same parent lineage was added within 48 hours (2 trading days), block rapid dip buying.
   *
   * D-01: `now` MUST be the real wall clock, never a supplied/backfilled fill timestamp. Passing
   * the caller's `--time` here is exactly what made the window forgeable.
   */
  public checkLineageAntiShake(parentLotId: string, now: Date): void {
    // Find the root lot id of this lineage
    let rootLotId = parentLotId;
    while (true) {
      const row = this.conn.query<{ parent_lot_id: string | null }, [string]>(
        "SELECT parent_lot_id FROM lots WHERE lot_id = ?"
      ).get(rootLotId);
      if (!row) break;
      if (row.parent_lot_id) {
        rootLotId = row.parent_lot_id;
      } else {
        break;
      }
    }

    // Query all lots belonging to this lineage (root lot or child lots referencing it)
    const lineageLots = this.conn.query<{
      lot_id: string;
      buy_time: string;
      pyramid_level: number;
    }, [string, string]>(
      "SELECT lot_id, buy_time, pyramid_level FROM lots WHERE lot_id = ? OR parent_lot_id = ? ORDER BY buy_time DESC"
    ).all(rootLotId, rootLotId);

    const cooldownMs = 48 * 3600 * 1000; // 48 hours (2 trading days)
    const currentTimeMs = now.getTime();

    for (const l of lineageLots) {
      // If a non-root lot was bought recently, check cooldown
      if (l.pyramid_level > 0) {
        const buyTimeMs = new Date(l.buy_time).getTime();
        const diffMs = currentTimeMs - buyTimeMs;
        if (diffMs >= 0 && diffMs < cooldownMs) {
          const hoursLeft = ((cooldownMs - diffMs) / (3600 * 1000)).toFixed(1);
          throw new Error(
            "加仓防抖冷却窗口守卫拦截：同源血缘链批次 " + l.lot_id + " (L" + l.pyramid_level + ") 于 " + l.buy_time + " 已执行加仓，尚在 48 小时 (2 个交易日) 防抖冷却窗口内 (剩余 " + hoursLeft + " 小时)，严禁急跌连续抢跑！"
          );
        }
      }
    }
  }

  public buyLot(
    symbolInput: string,
    price: number,
    quantity: number,
    fee?: number,
    buyTime?: Date,
    parentLotId?: string,
    skipRiskCheck: boolean = false,
    accountId?: string,
    buyReason?: string | null
  ): Lot {
    const [stdSymbol] = normalizeSymbol(symbolInput);
    const realNow = new Date();
    const now = buyTime || realNow;
    const accId = normalizeAccountId(accountId);

    // D-09 + D-01: both guards run before ANY ledger touch (no account self-heal, no INSERT).
    assertLegalFillPrice(price, "买入成交价");
    assertFillTimeNotInFuture(buyTime, realNow, "买入成交时间");

    if (quantity <= 0) {
      throw new Error("买入数量必须大于 0");
    }
    if (quantity % 100 !== 0) {
      throw new Error("买入数量必须为 100 的整数倍 (一手单位)，当前输入: " + quantity);
    }

    // 1. Risk Guard: Check single-symbol 30% position cap
    if (!skipRiskCheck) {
      const incomingValue = price * quantity;
      this.checkPositionCap(stdSymbol, incomingValue);
    }

    // 2. Lineage Guard: Anti-shake cooldown check if adding to existing parent
    let pyramidLevel = 0;
    if (parentLotId) {
      const pRow = this.conn.query<{ pyramid_level: number; symbol: string }, [string]>(
        "SELECT pyramid_level, symbol FROM lots WHERE lot_id = ?"
      ).get(parentLotId);
      if (!pRow) {
        throw new Error("指定的父批次不存在: " + parentLotId);
      }
      if (pRow.symbol !== stdSymbol) {
        throw new Error("父批次标的 (" + pRow.symbol + ") 与当前买入标的 (" + stdSymbol + ") 不一致");
      }
      pyramidLevel = pRow.pyramid_level + 1;

      // Anti-shake cooldown check. D-01: the window is measured against the REAL clock, so a
      // backfilled (past) fill time can never shorten or skip the cooldown.
      this.checkLineageAntiShake(parentLotId, realNow);
    }

    let symRow = this.conn.query<{
      symbol: string;
      name: string;
      asset_class: string;
      settlement_mode: string;
    }, [string]>("SELECT * FROM symbols WHERE symbol = ?").get(stdSymbol);

    if (!symRow) {
      const isGoldEtf =
        stdSymbol.includes("518880") ||
        stdSymbol.includes("159934") ||
        stdSymbol.includes("518800") ||
        stdSymbol.includes("159937") ||
        stdSymbol.includes("513");

      const assetClass =
        stdSymbol.includes("51") || stdSymbol.includes("15") || stdSymbol.includes("58") ? "ETF" : "STOCK";
      const setMode = isGoldEtf ? "NATIVE_T0" : "STATUTORY_T1";
      const name = symbolInput !== stdSymbol ? symbolInput : "标的" + stdSymbol;

      this.conn.run(
        "INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size) VALUES (?, ?, ?, ?, 100)",
        [stdSymbol, name, assetClass, setMode]
      );
      symRow = this.conn.query<any, [string]>("SELECT * FROM symbols WHERE symbol = ?").get(stdSymbol);
    }

    const settlementMode = symRow!.settlement_mode as SettlementMode;

    let buyFee = fee;
    if (buyFee === undefined || buyFee === null) {
      buyFee = Math.round((price * quantity * 0.0002 + Number.EPSILON) * 100) / 100;
    }

    const costBasis = computeCostBasis(price, quantity, buyFee);

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const dateStr = "" + year + month + day;

    const countRow = this.conn.query<{ c: number }, [string]>(
      "SELECT count(*) as c FROM lots WHERE lot_id LIKE ?"
    ).get("LOT-" + dateStr + "-%");
    const seq = (countRow ? countRow.c : 0) + 1;
    const seqStr = String(seq).padStart(3, "0");
    const lotId = "LOT-" + dateStr + "-" + seqStr;

    const canSell = settlementMode === SettlementMode.NATIVE_T0;

    const randSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const hours = String(now.getHours()).padStart(2, "0");
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const timeStr = "" + year + month + day + hours + mins + secs;
    const tradeId = "TRD-" + timeStr + "-" + randSuffix;

    // Account registry: self-heal unknown accounts right before the ledger write, so quick entry
    // into a brand-new broker account never blocks (and failed validations leave no trace).
    this.accounts.ensureAccount(accId);

    const tx = this.conn.transaction(() => {
      this.conn.run(
        "INSERT INTO lots (lot_id, account_id, parent_lot_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, buy_fee, cost_basis_unit, status, pyramid_level, can_sell_now, is_day_trading, max_high_price, max_low_price, peak_price, trailing_stop_active, buy_reason, realized_pnl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          lotId,
          accId,
          parentLotId || null,
          stdSymbol,
          now.toISOString(),
          price.toString(),
          quantity,
          quantity,
          buyFee.toString(),
          costBasis.toString(),
          LotStatus.ACTIVE,
          pyramidLevel,
          canSell ? 1 : 0,
          0,
          price.toString(),
          price.toString(),
          price.toString(),
          0,
          (buyReason ?? "").trim() || null,
          "0.00",
        ]
      );

      this.conn.run(
        "INSERT INTO trades (trade_id, account_id, lot_id, action, price, quantity, fee, realized_pnl, reason, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          tradeId,
          accId,
          lotId,
          "BUY",
          price.toString(),
          quantity,
          buyFee.toString(),
          "0.00",
          (buyReason ?? "").trim() || null,
          now.toISOString(),
        ]
      );
    });

    tx();

    return this.getLot(lotId)!;
  }

  /**
   * Dedicated Pyramid Dip Add Operation (trade lot add).
   * Supports base amount (default 10,000 yuan) or explicit quantity.
   * Auto converts base amount to nearest integer multiple of 100 shares.
   */
  public addLot(
    parentLotId: string,
    price: number,
    options?: {
      amount?: number;
      qty?: number;
      fee?: number;
      buyTime?: Date;
      skipRiskCheck?: boolean;
      accountId?: string;
      reason?: string | null;
    }
  ): Lot {
    const parentLot = this.getLot(parentLotId);
    if (!parentLot) {
      throw new Error("指定的父批次不存在: " + parentLotId);
    }

    // D-09: guard BEFORE deriving quantity from `amount / price` — division by 0 or NaN would
    // otherwise yield Infinity/NaN quantities and a misleading "100 的整数倍" error instead of
    // naming the real problem (the illegal price).
    assertLegalFillPrice(price, "加仓成交价");
    // D-01: `lot add` is its own entry point, so the future-fill-time check is named for it too.
    assertFillTimeNotInFuture(options?.buyTime, new Date(), "加仓成交时间");

    const targetAccountId = options?.accountId && options.accountId.trim() ? options.accountId.trim() : (parentLot.account_id || DEFAULT_ACCOUNT_ID);

    let quantity = options?.qty;
    if (!quantity || quantity <= 0) {
      const baseAmount = options?.amount && options.amount > 0 ? options.amount : 10000;
      quantity = Math.floor(baseAmount / price / 100) * 100;
      if (quantity <= 0) {
        quantity = 100; // minimum 1 lot
      }
    }

    return this.buyLot(
      parentLot.symbol,
      price,
      quantity,
      options?.fee,
      options?.buyTime,
      parentLotId,
      options?.skipRiskCheck,
      targetAccountId,
      options?.reason ?? null
    );
  }

  public getLot(lotId: string): Lot | null {
    const row = this.conn.query<any, [string]>("SELECT * FROM lots WHERE lot_id = ?").get(lotId);
    if (!row) return null;

    return {
      lot_id: row.lot_id,
      account_id: row.account_id || DEFAULT_ACCOUNT_ID,
      symbol: row.symbol,
      buy_time: new Date(row.buy_time),
      buy_price: Number(row.buy_price),
      buy_quantity: row.buy_quantity,
      remaining_quantity: row.remaining_quantity,
      cost_basis_unit: Number(row.cost_basis_unit),
      buy_fee: Number(row.buy_fee),
      parent_lot_id: row.parent_lot_id,
      status: row.status as LotStatus,
      pyramid_level: row.pyramid_level,
      can_sell_now: Boolean(row.can_sell_now),
      is_day_trading: Boolean(row.is_day_trading),
      substituted_core_lot_id: row.substituted_core_lot_id,
      max_high_price: row.max_high_price ? Number(row.max_high_price) : null,
      max_low_price: row.max_low_price ? Number(row.max_low_price) : null,
      peak_price: row.peak_price ? Number(row.peak_price) : null,
      trailing_stop_active: Boolean(row.trailing_stop_active),
      buy_reason: row.buy_reason ?? null,
      close_reason: row.close_reason ?? null,
      close_time: row.close_time ? new Date(row.close_time) : null,
      close_avg_price: row.close_avg_price ? Number(row.close_avg_price) : null,
      realized_pnl: Number(row.realized_pnl),
    };
  }

  /**
   * Update the decision thesis on an existing lot without touching any accounting field.
   * Empty string clears the note (stored as NULL), omitted fields are left untouched.
   */
  public updateLotReason(
    lotId: string,
    patch: { buyReason?: string | null; closeReason?: string | null; append?: boolean },
  ): Lot {
    const lot = this.getLot(lotId);
    if (!lot) {
      throw new Error("批次不存在: " + lotId);
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (patch.buyReason !== undefined) {
      const value = patch.append ? appendReason(lot.buy_reason, patch.buyReason) : (patch.buyReason ?? "").trim() || null;
      sets.push("buy_reason = ?");
      params.push(value);
    }
    if (patch.closeReason !== undefined) {
      const value = patch.append
        ? appendReason(lot.close_reason, patch.closeReason)
        : (patch.closeReason ?? "").trim() || null;
      sets.push("close_reason = ?");
      params.push(value);
    }

    if (sets.length === 0) {
      throw new Error("未提供任何需要更新的字段 (--reason / --close-reason)");
    }

    params.push(lotId);
    this.conn.run(`UPDATE lots SET ${sets.join(", ")} WHERE lot_id = ?`, params);
    return this.getLot(lotId)!;
  }

  public async listLots(status: string = "ACTIVE", symbol?: string, accountId?: string): Promise<LotListItem[]> {
    let query = "SELECT * FROM lots WHERE 1=1";
    const params: any[] = [];

    if (status && status.toUpperCase() !== "ALL") {
      query += " AND status = ?";
      params.push(status.toUpperCase());
    }
    if (symbol) {
      const [stdSymbol] = normalizeSymbol(symbol);
      query += " AND symbol = ?";
      params.push(stdSymbol);
    }
    if (accountId) {
      query += " AND account_id = ?";
      params.push(this.resolveAccountFilter(accountId) ?? normalizeAccountId(accountId));
    }
    query += " ORDER BY buy_time DESC";

    const rows = this.conn.query<any, any[]>(query).all(...params);
    if (!rows || rows.length === 0) {
      return [];
    }

    const symbols = Array.from(new Set(rows.map((r) => r.symbol)));
    const quotes = await this.quoteProvider.getQuotes(symbols);

    const results: LotListItem[] = [];
    const now = new Date();
    const nowDateStr = now.toISOString().slice(0, 10);

    for (const r of rows) {
      const sym = r.symbol;
      const q = quotes[sym];
      const currP = q ? q.current_price : Number(r.buy_price);

      const symRow = this.conn.query<{
        name: string;
        asset_class: string;
        settlement_mode: string;
      }, [string]>("SELECT name, asset_class, settlement_mode FROM symbols WHERE symbol = ?").get(sym);

      const name = symRow ? symRow.name : sym;
      const aCls = symRow ? symRow.asset_class : "ETF";
      const setMode = symRow ? symRow.settlement_mode : "STATUTORY_T1";

      const costB = Number(r.cost_basis_unit);
      const remQ = r.remaining_quantity;
      const feeR = getSellFeeRate(aCls);

      const [floatPnl, retRate] = computeFloatingPnl(currP, costB, remQ, feeR);

      // Determine dynamic can_sell_now
      const bDateStr = r.buy_time.slice(0, 10);
      let dynamicCanSell = false;
      if (setMode === "NATIVE_T0") {
        dynamicCanSell = true;
      } else if (bDateStr < nowDateStr) {
        dynamicCanSell = true;
      } else {
        const availCore = this.arbitrator.computeAvailableCorePosition(sym, now, r.account_id);
        dynamicCanSell = availCore >= remQ;
      }

      results.push({
        lot_id: r.lot_id,
        account_id: r.account_id || DEFAULT_ACCOUNT_ID,
        symbol: sym,
        symbol_name: name,
        settlement_mode: setMode,
        buy_time: r.buy_time,
        buy_price: Number(r.buy_price),
        buy_quantity: r.buy_quantity,
        remaining_quantity: remQ,
        cost_basis_unit: costB,
        current_price: currP,
        floating_pnl: floatPnl,
        return_rate: retRate,
        status: r.status,
        pyramid_level: r.pyramid_level,
        can_sell_now: dynamicCanSell,
        is_day_trading: Boolean(r.is_day_trading),
        peak_price: r.peak_price ? Number(r.peak_price) : null,
        trailing_stop_active: Boolean(r.trailing_stop_active),
        buy_reason: r.buy_reason ?? null,
        close_reason: r.close_reason ?? null,
        realized_pnl: Number(r.realized_pnl),
      });
    }

    return results;
  }

  public async scanSignals(
    customThresholds?: Record<string, number>,
    asOfTime?: Date,
    accountId?: string
  ): Promise<Signal[]> {
    let query = "SELECT lot_id, symbol FROM lots WHERE status = 'ACTIVE'";
    const params: any[] = [];
    if (accountId) {
      query += " AND account_id = ?";
      params.push(this.resolveAccountFilter(accountId) ?? normalizeAccountId(accountId));
    }
    const rows = this.conn.query<{ lot_id: string; symbol: string }, any[]>(query).all(...params);

    if (!rows || rows.length === 0) {
      return [];
    }

    const symbols = Array.from(new Set(rows.map((r) => r.symbol)));
    const quotes = await this.quoteProvider.getQuotes(symbols);

    const signals: Signal[] = [];
    for (const r of rows) {
      const lot = this.getLot(r.lot_id);
      if (!lot) continue;
      const q = quotes[lot.symbol];
      // Issue #9 同源缺口: 防止 0 价行情产生假信号
      if (!q || !(q.current_price > 0)) continue;

      const sig = this.scanner.scanLot(lot, q, customThresholds, asOfTime);
      if (sig) {
        signals.push(sig);

        this.conn.run(
          "INSERT OR REPLACE INTO signals (signal_id, lot_id, symbol, signal_type, trigger_return_rate, trigger_price, suggested_action, payload_json, is_handled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
          [
            sig.signal_id,
            sig.lot_id,
            sig.symbol,
            sig.signal_type,
            sig.trigger_return_rate.toString(),
            sig.trigger_price.toString(),
            sig.suggested_action,
            sig.payload_json,
          ]
        );
      }
    }

    return signals;
  }

  public closeLot(
    lotId: string,
    closePrice: number,
    closeQuantity?: number,
    substituteCore: boolean = false,
    fee?: number,
    closeTime?: Date,
    closeReason?: string | null
  ): [Lot, Trade] {
    // D-09 + D-01: `lot close` is a ledger write path too; the same finite-positive-price and
    // no-future-fill-time guards apply before delegating to the closer.
    const realNow = new Date();
    assertLegalFillPrice(closePrice, "平仓成交价");
    assertFillTimeNotInFuture(closeTime, realNow, "平仓成交时间");
    return this.closer.closeLot(lotId, closePrice, closeQuantity, substituteCore, fee, closeTime, closeReason);
  }

  public async getHierarchicalPositionView(symbolFilter?: string, asOfTime?: Date, customFullPositionCap?: number, accountFilter?: string): Promise<PositionHierarchicalView> {
    return this.positionAggregator.getHierarchicalPositionView(symbolFilter, asOfTime, customFullPositionCap, this.resolveAccountFilter(accountFilter));
  }

  public async getPositionSummaries(symbolFilter?: string, asOfTime?: Date, accountFilter?: string): Promise<PositionSummary[]> {
    return this.positionAggregator.getPositionSummaries(symbolFilter, asOfTime, this.resolveAccountFilter(accountFilter));
  }

  public computeStats(days?: number, symbol?: string, accountId?: string): TradingStats {
    let query = "SELECT t.*, l.symbol, l.substituted_core_lot_id, s.settlement_mode FROM trades t JOIN lots l ON t.lot_id = l.lot_id LEFT JOIN symbols s ON l.symbol = s.symbol WHERE t.action IN ('SELL_REGULAR', 'SELL_DAY_TRADE')";
    const params: any[] = [];

    if (days !== undefined && days !== null) {
      query += " AND datetime(t.executed_at) >= datetime('now', ?)";
      params.push("-" + days + " days");
    }
    if (symbol) {
      const [stdS] = normalizeSymbol(symbol);
      query += " AND l.symbol = ?";
      params.push(stdS);
    }
    if (accountId) {
      query += " AND t.account_id = ?";
      params.push(this.resolveAccountFilter(accountId) ?? normalizeAccountId(accountId));
    }

    const rows = this.conn.query<any, any[]>(query).all(...params);

    const calcAttr = (tradeRows: any[]): TradeAttribution => {
      const count = tradeRows.length;
      if (count === 0) {
        return {
          total_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          win_rate: 0.0,
          total_realized_pnl: 0.0,
          profit_factor: 0.0,
        };
      }
      let pnlSum = 0;
      let winCount = 0;
      let lossCount = 0;
      let grossProfit = 0;
      let grossLoss = 0;

      for (const tr of tradeRows) {
        const pnl = Number(tr.realized_pnl);
        pnlSum += pnl;
        if (pnl > 0) {
          winCount += 1;
          grossProfit += pnl;
        } else if (pnl < 0) {
          lossCount += 1;
          grossLoss += Math.abs(pnl);
        }
      }

      const winRate = count > 0 ? winCount / count : 0.0;
      let pf = 0.0;
      if (grossLoss > 0) {
        pf = grossProfit / grossLoss;
      } else if (grossProfit > 0) {
        pf = 999.0;
      } else {
        pf = 1.0;
      }

      return {
        total_trades: count,
        winning_trades: winCount,
        losing_trades: lossCount,
        win_rate: Math.round(winRate * 10000) / 10000,
        total_realized_pnl: Math.round((pnlSum + Number.EPSILON) * 100) / 100,
        profit_factor: Math.round(pf * 100) / 100,
      };
    };

    if (!rows || rows.length === 0) {
      const emptyAttr = calcAttr([]);
      return {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0.0,
        total_realized_pnl: 0.0,
        profit_factor: 0.0,
        day_trades_count: 0,
        by_symbol: {},
        by_trade_type: {
          regular_swing: emptyAttr,
          native_t0: emptyAttr,
          core_substitution_t0: emptyAttr,
        },
      };
    }

    const overall = calcAttr(rows);
    let dayTrades = 0;

    // Multi-dimensional breakdown
    const symbolMap: Record<string, any[]> = {};
    const regSwingRows: any[] = [];
    const nativeT0Rows: any[] = [];
    const coreSubRows: any[] = [];

    for (const r of rows) {
      if (r.action === "SELL_DAY_TRADE") {
        dayTrades += 1;
      }

      // Group by symbol
      const sym = r.symbol;
      if (!symbolMap[sym]) {
        symbolMap[sym] = [];
      }
      symbolMap[sym].push(r);

      // Group by trade type:
      if (r.substituted_core_lot_id) {
        coreSubRows.push(r);
      } else if (r.action === "SELL_DAY_TRADE" || r.settlement_mode === "NATIVE_T0") {
        nativeT0Rows.push(r);
      } else {
        regSwingRows.push(r);
      }
    }

    const bySymbol: Record<string, TradeAttribution> = {};
    for (const [sym, trList] of Object.entries(symbolMap)) {
      bySymbol[sym] = calcAttr(trList);
    }

    return {
      total_trades: overall.total_trades,
      winning_trades: overall.winning_trades,
      losing_trades: overall.losing_trades,
      win_rate: overall.win_rate,
      total_realized_pnl: overall.total_realized_pnl,
      profit_factor: overall.profit_factor,
      day_trades_count: dayTrades,
      by_symbol: bySymbol,
      by_trade_type: {
        regular_swing: calcAttr(regSwingRows),
        native_t0: calcAttr(nativeT0Rows),
        core_substitution_t0: calcAttr(coreSubRows),
      },
    };
  }

  public addDividend(params: {
    symbol: string;
    amount: number;
    exDate?: string;
    accountId?: string;
    sharesCount?: number;
    dividendPerShare?: number;
    notes?: string;
  }): Dividend {
    const [stdSymbol] = normalizeSymbol(params.symbol);

    this.ensureSymbol(params.symbol);

    const amount = Number(params.amount);
    if (!isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid dividend amount: ${params.amount}. Must be a positive finite number.`);
    }

    const accountId = normalizeAccountId(params.accountId);
    this.accounts.ensureAccount(accountId);
    const now = new Date();
    let exDate = params.exDate ? params.exDate.trim() : "";
    if (!exDate) {
      exDate = now.toISOString().slice(0, 10);
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) {
        throw new Error(`Invalid ex_date format: ${params.exDate}. Must be YYYY-MM-DD.`);
      }
    }

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const divId = `DIV-${year}${month}${day}${hours}${mins}${secs}-${randSuffix}`;

    const sharesCount = params.sharesCount !== undefined ? Number(params.sharesCount) : null;
    const divPerShare = params.dividendPerShare !== undefined ? Number(params.dividendPerShare) : null;
    const notes = params.notes !== undefined && params.notes !== null ? String(params.notes).trim() : null;

    this.conn.run(
      `INSERT INTO dividends (dividend_id, account_id, symbol, amount, ex_date, shares_count, dividend_per_share, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [divId, accountId, stdSymbol, amount, exDate, sharesCount, divPerShare, notes]
    );

    return {
      dividend_id: divId,
      account_id: accountId,
      symbol: stdSymbol,
      amount: amount,
      ex_date: exDate,
      shares_count: sharesCount,
      dividend_per_share: divPerShare,
      notes: notes,
      created_at: now,
    };
  }

  public getDividends(filter?: { symbol?: string; accountId?: string }): Dividend[] {
    let query = "SELECT dividend_id, account_id, symbol, amount, ex_date, shares_count, dividend_per_share, notes, created_at FROM dividends WHERE 1=1";
    const params: any[] = [];

    if (filter?.symbol) {
      const [stdSymbol] = normalizeSymbol(filter.symbol);
      query += " AND symbol = ?";
      params.push(stdSymbol);
    }

    if (filter?.accountId) {
      const acc = this.resolveAccountFilter(filter.accountId);
      if (acc) {
        query += " AND account_id = ?";
        params.push(acc);
      }
    }

    query += " ORDER BY ex_date DESC, created_at DESC";

    const rows = this.conn.query<{
      dividend_id: string;
      account_id: string;
      symbol: string;
      amount: number;
      ex_date: string;
      shares_count: number | null;
      dividend_per_share: number | null;
      notes: string | null;
      created_at: string;
    }, any[]>(query).all(...params);

    return rows.map((r) => ({
      dividend_id: r.dividend_id,
      account_id: r.account_id,
      symbol: r.symbol,
      amount: Number(r.amount),
      ex_date: r.ex_date,
      shares_count: r.shares_count !== null ? Number(r.shares_count) : null,
      dividend_per_share: r.dividend_per_share !== null ? Number(r.dividend_per_share) : null,
      notes: r.notes,
      created_at: r.created_at ? new Date(r.created_at) : null,
    }));
  }

  public getTotalDividends(symbol?: string, accountId?: string): number {
    let query = "SELECT COALESCE(SUM(amount), 0.0) as total FROM dividends WHERE 1=1";
    const params: any[] = [];

    if (symbol) {
      query += " AND symbol = ?";
      const [stdSymbol] = normalizeSymbol(symbol);
      params.push(stdSymbol);
    }

    if (accountId) {
      const acc = this.resolveAccountFilter(accountId);
      if (acc) {
        query += " AND account_id = ?";
        params.push(acc);
      }
    }

    const row = this.conn.query<{ total: number }, any[]>(query).get(...params);
    return row ? Number(row.total) : 0.0;
  }

}
