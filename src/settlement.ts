/**
 * Settlement mode arbitrator and available core position pool.
 */
import { Database } from "bun:sqlite";
import { SettlementMode, LotStatus, Lot, TradeAction } from "./models.ts";
import { inferSymbolMetadata } from "./quotes.ts";

export interface CorePositionBreakdown {
  /** Gross settled core position from prior trading days (matured lots only). */
  gross: number;
  /** Substitute-core (day-trade) closes already executed TODAY for this account + symbol. */
  consumedToday: number;
  /** Remaining substitution quota = gross - consumedToday (never negative). */
  available: number;
}

export class SettlementArbitrator {
  private conn: Database;

  constructor(dbConn: Database) {
    this.conn = dbConn;
  }

  public getSymbolSettlementMode(symbol: string): SettlementMode {
    const row = this.conn.query<{ settlement_mode: string }, [string]>(
      "SELECT settlement_mode FROM symbols WHERE symbol = ?"
    ).get(symbol);

    if (row) {
      return row.settlement_mode as SettlementMode;
    }

    // Fallback heuristic using strict prefix inference
    const meta = inferSymbolMetadata(symbol);
    return meta.settlementMode;
  }

  /**
   * Remaining substitute-core quota, NET of every day-trade close already executed today.
   *
   * Regression guard (T-45): the gross core pool alone is NOT a quota. Without subtracting
   * today's already-substituted quantity, an account with 100 shares of core could be drained
   * by calling `lot close --substitute-core` repeatedly (5 x 100 = 500 shares, a 5x oversell)
   * because each call re-read the same 100-share denominator.
   */
  public computeAvailableCorePosition(symbol: string, asOfDate?: Date, accountId?: string): number {
    return this.computeCorePositionBreakdown(symbol, asOfDate, accountId).available;
  }

  /**
   * Gross core / consumed-today / available breakdown for one account + symbol.
   *
   *   available = gross (prior-settlement matured core) - consumedToday (today's substitute closes)
   *
   * A substitute-core close is identified from the trade ledger itself: a `SELL_DAY_TRADE` on a
   * lot whose `substituted_core_lot_id` is set, i.e. a STATUTORY_T+1 same-day close that borrowed
   * core. NATIVE_T0 same-day closes never set that column and therefore never consume quota.
   */
  public computeCorePositionBreakdown(symbol: string, asOfDate?: Date, accountId?: string): CorePositionBreakdown {
    const targetDate = asOfDate || new Date();
    // Compare YYYY-MM-DD (UTC calendar day, consistent with buy_time / executed_at storage).
    const targetDateStr = targetDate.toISOString().slice(0, 10);

    let query = "SELECT lot_id, buy_time, remaining_quantity, status FROM lots WHERE symbol = ? AND status IN ('ACTIVE', 'CLOSING')";
    const params: any[] = [symbol];
    if (accountId) {
      query += " AND account_id = ?";
      params.push(accountId);
    }

    const rows = this.conn.query<{
      lot_id: string;
      buy_time: string;
      remaining_quantity: number;
      status: string;
    }, any[]>(query).all(...params);

    let gross = 0;
    for (const r of rows) {
      const bDateStr = r.buy_time.slice(0, 10);
      if (bDateStr < targetDateStr) {
        if (r.status === LotStatus.ACTIVE) {
          gross += r.remaining_quantity;
        }
      }
    }

    let consumedQuery = `
      SELECT COALESCE(SUM(t.quantity), 0) AS consumed
      FROM trades t
      JOIN lots l ON t.lot_id = l.lot_id
      WHERE t.action = ?
        AND l.symbol = ?
        AND l.substituted_core_lot_id IS NOT NULL
        AND substr(t.executed_at, 1, 10) = ?`;
    const consumedParams: any[] = [TradeAction.SELL_DAY_TRADE, symbol, targetDateStr];
    if (accountId) {
      consumedQuery += " AND t.account_id = ?";
      consumedParams.push(accountId);
    }

    const consumedRow = this.conn.query<{ consumed: number }, any[]>(consumedQuery).get(...consumedParams);
    const consumedToday = Number(consumedRow?.consumed ?? 0) || 0;

    return {
      gross,
      consumedToday,
      available: Math.max(0, gross - consumedToday),
    };
  }

  public canSellLotNow(lot: Lot, currentTime?: Date): [boolean, string] {
    const now = currentTime || new Date();
    const settlementMode = this.getSymbolSettlementMode(lot.symbol);

    if (settlementMode === SettlementMode.NATIVE_T0) {
      return [true, "NATIVE_T0: 即刻可卖"];
    }

    // STATUTORY_T1
    const nowDateStr = now.toISOString().slice(0, 10);
    const buyDateStr = (lot.buy_time instanceof Date ? lot.buy_time : new Date(lot.buy_time)).toISOString().slice(0, 10);

    if (buyDateStr < nowDateStr) {
      return [true, "STATUTORY_T1: 历史交收底仓，可合法平仓"];
    }

    // Bought today: check if core position is available for day-trade substitution
    const availCore = this.computeAvailableCorePosition(lot.symbol, now, lot.account_id);
    if (availCore >= lot.remaining_quantity) {
      return [true, `STATUTORY_T1: 盘中加仓，可用底仓充足(${availCore}股)，支持代冲做T`];
    } else if (availCore > 0) {
      return [false, `STATUTORY_T1: 可用底仓不足以完全代冲(需${lot.remaining_quantity}股，仅${availCore}股)`];
    } else {
      return [false, "STATUTORY_T1: 当日建仓无底仓，法定T+1锁定，次日开盘方可平仓"];
    }
  }
}
