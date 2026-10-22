/**
 * Lot closer and core position substitute day-trading resolver.
 */
import { Database } from "bun:sqlite";
import { Lot, LotStatus, SettlementMode, Trade, TradeAction } from "./models.ts";
import { computeRealizedPnl } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { DEFAULT_ACCOUNT_ID } from "./accounts.ts";

/**
 * Append a decision-thesis note onto an existing (possibly partial-close) reason column.
 * An empty/blank note is a no-op so `--reason` stays fully optional.
 */
export function appendReason(existing: string | null | undefined, reason?: string | null): string | null {
  const next = (reason ?? "").trim();
  const prev = (existing ?? "").trim();
  if (!next) return prev ? prev : null;
  if (!prev) return next;
  return `${prev}\n${next}`;
}

export class LotCloser {
  private conn: Database;
  private arbitrator: SettlementArbitrator;

  constructor(dbConn: Database) {
    this.conn = dbConn;
    this.arbitrator = new SettlementArbitrator(dbConn);
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
    const now = closeTime || new Date();

    const row = this.conn.query<any, [string]>("SELECT * FROM lots WHERE lot_id = ?").get(lotId);
    if (!row) {
      throw new Error(`批次不存在: ${lotId}`);
    }

    if (row.status === LotStatus.CLOSED) {
      throw new Error(`批次 ${lotId} 已经是 CLOSED 状态，不可重复平仓`);
    }

    const remainingQty = row.remaining_quantity;
    const qtyToClose = closeQuantity !== undefined ? closeQuantity : remainingQty;

    if (qtyToClose <= 0) {
      throw new Error("平仓数量必须大于 0");
    }
    if (qtyToClose > remainingQty) {
      throw new Error(`平仓数量 ${qtyToClose} 超过剩余可用数量 ${remainingQty}`);
    }

    const symbol = row.symbol;
    const accountId = row.account_id || DEFAULT_ACCOUNT_ID;
    const settlementMode = this.arbitrator.getSymbolSettlementMode(symbol);

    const bDateStr = row.buy_time.slice(0, 10);
    const nowDateStr = now.toISOString().slice(0, 10);
    const isToday = bDateStr === nowDateStr;

    let substitutedCoreLotId: string | null = null;
    let isDayTrade = false;

    if (settlementMode === SettlementMode.NATIVE_T0) {
      if (isToday) {
        isDayTrade = true;
      }
    } else {
      // STATUTORY_T1
      if (isToday) {
        if (!substituteCore) {
          throw new Error(`标的 ${symbol} 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core`);
        }

        // T-45: the quota is NET of every substitute-core close already done today. Comparing
        // today's request against the gross core pool alone let repeated partial closes drain an
        // account far beyond its settled core position.
        const core = this.arbitrator.computeCorePositionBreakdown(symbol, now, accountId);
        if (core.available < qtyToClose) {
          throw new Error(
            `底仓可用配额不足，严防裸卖空！账户 ${accountId} 标的 ${symbol} 总底仓 ${core.gross} 股，` +
            `今日已代冲 ${core.consumedToday} 股，剩余可用配额仅 ${core.available} 股，申请代冲 ${qtyToClose} 股`
          );
        }

        const coreRow = this.conn.query<{ lot_id: string }, [string, string, string]>(
          `SELECT lot_id FROM lots
           WHERE symbol = ? AND account_id = ? AND status = 'ACTIVE' AND date(buy_time) < date(?)
           ORDER BY buy_time ASC
           LIMIT 1`
        ).get(symbol, accountId, now.toISOString());

        if (coreRow) {
          substitutedCoreLotId = coreRow.lot_id;
        }

        isDayTrade = true;
      }
    }

    let closeFee = fee;
    if (closeFee === undefined || closeFee === null) {
      const symRow = this.conn.query<{ asset_class: string }, [string]>(
        "SELECT asset_class FROM symbols WHERE symbol = ?"
      ).get(symbol);
      const aCls = symRow ? symRow.asset_class : "ETF";
      const rate = aCls.toUpperCase() === "ETF" || aCls.toUpperCase() === "GOLD_SPOT" ? 0.0002 : 0.0007;
      closeFee = Math.round((closePrice * qtyToClose * rate + Number.EPSILON) * 100) / 100;
    }

    const costBasis = Number(row.cost_basis_unit);
    const realizedPnl = computeRealizedPnl(closePrice, costBasis, qtyToClose, closeFee);

    const newRemainingQty = remainingQty - qtyToClose;
    const newStatus = newRemainingQty === 0 ? LotStatus.CLOSED : LotStatus.ACTIVE;
    const totalRealizedPnl = Math.round(((Number(row.realized_pnl) + realizedPnl) + Number.EPSILON) * 100) / 100;
    const nextCloseReason = appendReason(row.close_reason, closeReason);

    const randSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const timeStr = `${year}${month}${day}${hours}${mins}${secs}`;
    const tradeId = `TRD-${timeStr}-${randSuffix}`;
    const tradeAction = isDayTrade ? TradeAction.SELL_DAY_TRADE : TradeAction.SELL_REGULAR;

    const tx = this.conn.transaction(() => {
      this.conn.run(
        `UPDATE lots
         SET remaining_quantity = ?,
             status = ?,
             close_time = CASE WHEN ? = 0 THEN ? ELSE close_time END,
             close_avg_price = ?,
             realized_pnl = ?,
             is_day_trading = CASE WHEN ? THEN 1 ELSE is_day_trading END,
             substituted_core_lot_id = CASE WHEN ? IS NOT NULL THEN ? ELSE substituted_core_lot_id END,
             close_reason = ?
         WHERE lot_id = ?`,
        [
          newRemainingQty,
          newStatus,
          newRemainingQty,
          now.toISOString(),
          closePrice.toString(),
          totalRealizedPnl.toString(),
          isDayTrade ? 1 : 0,
          substitutedCoreLotId,
          substitutedCoreLotId,
          nextCloseReason,
          lotId,
        ]
      );

      this.conn.run(
        `INSERT INTO trades (trade_id, account_id, lot_id, action, price, quantity, fee, realized_pnl, reason, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tradeId,
          accountId,
          lotId,
          tradeAction,
          closePrice.toString(),
          qtyToClose,
          closeFee.toString(),
          realizedPnl.toString(),
          (closeReason ?? "").trim() || null,
          now.toISOString(),
        ]
      );
    });

    tx();

    const updatedRow = this.conn.query<any, [string]>("SELECT * FROM lots WHERE lot_id = ?").get(lotId)!;
    const updatedLot: Lot = {
      lot_id: updatedRow.lot_id,
      account_id: updatedRow.account_id || accountId,
      symbol: updatedRow.symbol,
      buy_time: new Date(updatedRow.buy_time),
      buy_price: Number(updatedRow.buy_price),
      buy_quantity: updatedRow.buy_quantity,
      remaining_quantity: updatedRow.remaining_quantity,
      cost_basis_unit: Number(updatedRow.cost_basis_unit),
      buy_fee: Number(updatedRow.buy_fee),
      parent_lot_id: updatedRow.parent_lot_id,
      status: updatedRow.status as LotStatus,
      pyramid_level: updatedRow.pyramid_level,
      can_sell_now: Boolean(updatedRow.can_sell_now),
      is_day_trading: Boolean(updatedRow.is_day_trading),
      substituted_core_lot_id: updatedRow.substituted_core_lot_id,
      max_high_price: updatedRow.max_high_price ? Number(updatedRow.max_high_price) : null,
      max_low_price: updatedRow.max_low_price ? Number(updatedRow.max_low_price) : null,
      buy_reason: updatedRow.buy_reason ?? null,
      close_reason: updatedRow.close_reason ?? null,
      close_time: updatedRow.close_time ? new Date(updatedRow.close_time) : null,
      close_avg_price: updatedRow.close_avg_price ? Number(updatedRow.close_avg_price) : null,
      realized_pnl: Number(updatedRow.realized_pnl),
    };

    const trade: Trade = {
      trade_id: tradeId,
      account_id: accountId,
      lot_id: lotId,
      action: tradeAction,
      price: closePrice,
      quantity: qtyToClose,
      fee: closeFee,
      realized_pnl: realizedPnl,
      reason: (closeReason ?? "").trim() || null,
      executed_at: now,
    };

    return [updatedLot, trade];
  }
}
