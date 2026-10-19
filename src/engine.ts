/**
 * Lot Trader engine services.
 */
import { Database } from "bun:sqlite";
import { Lot, LotStatus, SettlementMode, Signal, Trade } from "./models.ts";
import { computeCostBasis, computeFloatingPnl, getSellFeeRate } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { SignalScanner } from "./scanner.ts";
import { LotCloser } from "./closer.ts";
import { QuoteProvider, normalizeSymbol } from "./quotes.ts";

export interface LotListItem {
  lot_id: string;
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
  realized_pnl: number;
}

export interface TradingStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_realized_pnl: number;
  profit_factor: number;
  day_trades_count: number;
}

export class TraderEngine {
  public conn: Database;
  public quoteProvider: QuoteProvider;
  public arbitrator: SettlementArbitrator;
  public scanner: SignalScanner;
  public closer: LotCloser;

  constructor(dbConn: Database, quoteProvider?: QuoteProvider) {
    this.conn = dbConn;
    this.quoteProvider = quoteProvider || new QuoteProvider();
    this.arbitrator = new SettlementArbitrator(dbConn);
    this.scanner = new SignalScanner(dbConn);
    this.closer = new LotCloser(dbConn);
  }

  public buyLot(
    symbolInput: string,
    price: number,
    quantity: number,
    fee?: number,
    buyTime?: Date,
    parentLotId?: string
  ): Lot {
    const [stdSymbol] = normalizeSymbol(symbolInput);
    const now = buyTime || new Date();

    if (quantity <= 0) {
      throw new Error("买入数量必须大于 0");
    }
    if (quantity % 100 !== 0) {
      throw new Error(`买入数量必须为 100 的整数倍 (一手单位)，当前输入: ${quantity}`);
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
      const name = symbolInput !== stdSymbol ? symbolInput : `标的${stdSymbol}`;

      this.conn.run(
        `INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size)
         VALUES (?, ?, ?, ?, 100)`,
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
    const dateStr = `${year}${month}${day}`;

    const countRow = this.conn.query<{ c: number }, [string]>(
      "SELECT count(*) as c FROM lots WHERE lot_id LIKE ?"
    ).get(`LOT-${dateStr}-%`);
    const seq = (countRow ? countRow.c : 0) + 1;
    const seqStr = String(seq).padStart(3, "0");
    const lotId = `LOT-${dateStr}-${seqStr}`;

    let pyramidLevel = 0;
    if (parentLotId) {
      const pRow = this.conn.query<{ pyramid_level: number }, [string]>(
        "SELECT pyramid_level FROM lots WHERE lot_id = ?"
      ).get(parentLotId);
      if (pRow) {
        pyramidLevel = pRow.pyramid_level + 1;
      }
    }

    const canSell = settlementMode === SettlementMode.NATIVE_T0;

    const randSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const hours = String(now.getHours()).padStart(2, "0");
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const timeStr = `${year}${month}${day}${hours}${mins}${secs}`;
    const tradeId = `TRD-${timeStr}-${randSuffix}`;

    const tx = this.conn.transaction(() => {
      this.conn.run(
        `INSERT INTO lots (
          lot_id, parent_lot_id, symbol, buy_time, buy_price, buy_quantity,
          remaining_quantity, buy_fee, cost_basis_unit, status, pyramid_level,
          can_sell_now, is_day_trading, max_high_price, max_low_price, realized_pnl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lotId,
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
          "0.00",
        ]
      );

      this.conn.run(
        `INSERT INTO trades (trade_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tradeId,
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

  public getLot(lotId: string): Lot | null {
    const row = this.conn.query<any, [string]>("SELECT * FROM lots WHERE lot_id = ?").get(lotId);
    if (!row) return null;

    return {
      lot_id: row.lot_id,
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
      close_time: row.close_time ? new Date(row.close_time) : null,
      close_avg_price: row.close_avg_price ? Number(row.close_avg_price) : null,
      realized_pnl: Number(row.realized_pnl),
    };
  }

  public async listLots(status: string = "ACTIVE", symbol?: string): Promise<LotListItem[]> {
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
        const availCore = this.arbitrator.computeAvailableCorePosition(sym, now);
        dynamicCanSell = availCore >= remQ;
      }

      results.push({
        lot_id: r.lot_id,
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
        realized_pnl: Number(r.realized_pnl),
      });
    }

    return results;
  }

  public async scanSignals(
    customThresholds?: Record<string, number>,
    asOfTime?: Date
  ): Promise<Signal[]> {
    const rows = this.conn.query<{ lot_id: string; symbol: string }>(
      "SELECT lot_id, symbol FROM lots WHERE status = 'ACTIVE'"
    ).all();

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
          `INSERT OR REPLACE INTO signals (
            signal_id, lot_id, symbol, signal_type, trigger_return_rate,
            trigger_price, suggested_action, payload_json, is_handled
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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

  public computeStats(days?: number, symbol?: string): TradingStats {
    let query = "SELECT * FROM trades WHERE action IN ('SELL_REGULAR', 'SELL_DAY_TRADE')";
    const params: any[] = [];

    if (days !== undefined && days !== null) {
      query += " AND datetime(executed_at) >= datetime('now', ?)";
      params.push(`-${days} days`);
    }
    if (symbol) {
      const [stdS] = normalizeSymbol(symbol);
      query += " AND lot_id IN (SELECT lot_id FROM lots WHERE symbol = ?)";
      params.push(stdS);
    }

    const rows = this.conn.query<any, any[]>(query).all(...params);
    const totalClosedTrades = rows ? rows.length : 0;

    if (totalClosedTrades === 0) {
      return {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0.0,
        total_realized_pnl: 0.0,
        profit_factor: 0.0,
        day_trades_count: 0,
      };
    }

    let totalPnl = 0;
    let winningCount = 0;
    let losingCount = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let dayTrades = 0;

    for (const r of rows) {
      const pnl = Number(r.realized_pnl);
      totalPnl += pnl;
      if (pnl > 0) {
        winningCount += 1;
        grossProfit += pnl;
      } else if (pnl < 0) {
        losingCount += 1;
        grossLoss += Math.abs(pnl);
      }

      if (r.action === "SELL_DAY_TRADE") {
        dayTrades += 1;
      }
    }

    const winRate = totalClosedTrades > 0 ? winningCount / totalClosedTrades : 0.0;
    let profitFactor = 0.0;
    if (grossLoss > 0) {
      profitFactor = grossProfit / grossLoss;
    } else if (grossProfit > 0) {
      profitFactor = 999.0;
    } else {
      profitFactor = 1.0;
    }

    return {
      total_trades: totalClosedTrades,
      winning_trades: winningCount,
      losing_trades: losingCount,
      win_rate: Math.round(winRate * 10000) / 10000,
      total_realized_pnl: Math.round((totalPnl + Number.EPSILON) * 100) / 100,
      profit_factor: Math.round(profitFactor * 100) / 100,
      day_trades_count: dayTrades,
    };
  }
}

