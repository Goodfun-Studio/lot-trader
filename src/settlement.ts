/**
 * Settlement mode arbitrator and available core position pool.
 */
import { Database } from "bun:sqlite";
import { SettlementMode, LotStatus, Lot } from "./models.ts";
import { inferSymbolMetadata } from "./quotes.ts";

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

  public computeAvailableCorePosition(symbol: string, asOfDate?: Date, accountId?: string): number {
    const targetDate = asOfDate || new Date();
    // Compare YYYY-MM-DD
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

    let totalCore = 0;
    for (const r of rows) {
      const bDateStr = r.buy_time.slice(0, 10);
      if (bDateStr < targetDateStr) {
        if (r.status === LotStatus.ACTIVE) {
          totalCore += r.remaining_quantity;
        }
      }
    }

    return totalCore;
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
