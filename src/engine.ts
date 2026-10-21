/**
 * Lot Trader engine services.
 */
import { Database } from "bun:sqlite";
import { Lot, LotStatus, SettlementMode, Signal, Trade, Dividend } from "./models.ts";
import { computeCostBasis, computeFloatingPnl, getSellFeeRate } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { SignalScanner } from "./scanner.ts";
import { LotCloser } from "./closer.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";
import { PositionAggregator, PositionSummary } from "./position.ts";

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
  public conn: Database;
  public quoteProvider: QuoteProvider;
  public arbitrator: SettlementArbitrator;
  public scanner: SignalScanner;
  public closer: LotCloser;
  public positionAggregator: PositionAggregator;
  public portfolioBudget?: number;

  constructor(dbConn: Database, quoteProvider?: QuoteProvider, portfolioBudget?: number) {
    this.conn = dbConn;
    this.quoteProvider = quoteProvider || new QuoteProvider();
    this.arbitrator = new SettlementArbitrator(dbConn);
    this.scanner = new SignalScanner(dbConn);
    this.closer = new LotCloser(dbConn);
    this.positionAggregator = new PositionAggregator(dbConn, this.quoteProvider);
    this.portfolioBudget = portfolioBudget;
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
    }>("SELECT symbol, remaining_quantity, buy_price, cost_basis_unit FROM lots WHERE status = 'ACTIVE'").all();

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
          "单标的持仓硬顶风控拦截：买入后标的 " + stdSymbol + " 估算持仓占比为 " + (ratio * 100).toFixed(2) + "%，超过 30.00% 组合级硬顶红线 (标的总额 " + newTargetSymbolValue.toFixed(2) + " / 组合总值 " + totalBase.toFixed(2) + ")！"
        );
      }
    } else if (otherSymbolsValue > 0) {
      const totalPortfolioValue = otherSymbolsValue + newTargetSymbolValue;
      const ratio = newTargetSymbolValue / totalPortfolioValue;
      if (ratio > 0.3000 + 1e-6) {
        throw new Error(
          "单标的持仓硬顶风控拦截：买入后标的 " + stdSymbol + " 估算持仓占比为 " + (ratio * 100).toFixed(2) + "%，超过 30.00% 组合级硬顶红线 (标的总额 " + newTargetSymbolValue.toFixed(2) + " / 组合总值 " + totalPortfolioValue.toFixed(2) + ")！"
        );
      }
    }
  }

  /**
   * Lineage Guard: Anti-shake cooldown check for pyramid dip buys.
   * If any lot in the same parent lineage was added within 48 hours (2 trading days), block rapid dip buying.
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
    accountId?: string
  ): Lot {
    const [stdSymbol] = normalizeSymbol(symbolInput);
    const now = buyTime || new Date();
    const accId = accountId && accountId.trim() ? accountId.trim() : 'DEFAULT';

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

      // Anti-shake cooldown check
      this.checkLineageAntiShake(parentLotId, now);
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

    const settlementMode = symRow.settlement_mode as SettlementMode;

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

    const tx = this.conn.transaction(() => {
      this.conn.run(
        "INSERT INTO lots (lot_id, account_id, parent_lot_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, buy_fee, cost_basis_unit, status, pyramid_level, can_sell_now, is_day_trading, max_high_price, max_low_price, peak_price, trailing_stop_active, realized_pnl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          "0.00",
        ]
      );

      this.conn.run(
        "INSERT INTO trades (trade_id, account_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          tradeId,
          accId,
          lotId,
          "BUY",
          price.toString(),
          quantity,
          buyFee.toString(),
          "0.00",
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
    }
  ): Lot {
    const parentLot = this.getLot(parentLotId);
    if (!parentLot) {
      throw new Error("指定的父批次不存在: " + parentLotId);
    }

    const targetAccountId = options?.accountId && options.accountId.trim() ? options.accountId.trim() : (parentLot.account_id || 'DEFAULT');

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
      targetAccountId
    );
  }

  public getLot(lotId: string): Lot | null {
    const row = this.conn.query<any, [string]>("SELECT * FROM lots WHERE lot_id = ?").get(lotId);
    if (!row) return null;

    return {
      lot_id: row.lot_id,
      account_id: row.account_id || 'DEFAULT',
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
      close_time: row.close_time ? new Date(row.close_time) : null,
      close_avg_price: row.close_avg_price ? Number(row.close_avg_price) : null,
      realized_pnl: Number(row.realized_pnl),
    };
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
      params.push(accountId);
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
        account_id: r.account_id || 'DEFAULT',
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
      params.push(accountId);
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
      if (!q) continue;

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
    closeTime?: Date
  ): [Lot, Trade] {
    return this.closer.closeLot(lotId, closePrice, closeQuantity, substituteCore, fee, closeTime);
  }

  public async getHierarchicalPositionView(symbolFilter?: string, asOfTime?: Date, customFullPositionCap?: number, accountFilter?: string): Promise<PositionHierarchicalView> {
    return this.positionAggregator.getHierarchicalPositionView(symbolFilter, asOfTime, customFullPositionCap, accountFilter);
  }

  public async getPositionSummaries(symbolFilter?: string, asOfTime?: Date, accountFilter?: string): Promise<PositionSummary[]> {
    return this.positionAggregator.getPositionSummaries(symbolFilter, asOfTime, accountFilter);
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
      params.push(accountId);
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

    let symRow = this.conn.query<{ symbol: string }, [string]>(
      "SELECT symbol FROM symbols WHERE symbol = ?"
    ).get(stdSymbol);

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
      const name = "标的" + stdSymbol;
      this.conn.run(
        "INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode) VALUES (?, ?, ?, ?)",
        [stdSymbol, name, assetClass, setMode]
      );
    }

    const amount = Number(params.amount);
    if (!isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid dividend amount: ${params.amount}. Must be a positive finite number.`);
    }

    const accountId = params.accountId ? params.accountId.trim().toUpperCase() : "DEFAULT";
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
      const acc = filter.accountId.trim().toUpperCase();
      if (acc !== "ALL") {
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
      const acc = accountId.trim().toUpperCase();
      if (acc !== "ALL") {
        query += " AND account_id = ?";
        params.push(acc);
      }
    }

    const row = this.conn.query<{ total: number }, any[]>(query).get(...params);
    return row ? Number(row.total) : 0.0;
  }

}
