/**
 * Strategy rule signal scanner.
 */
import { Database } from "bun:sqlite";
import { Lot, LotStatus, SettlementMode, Signal, SignalType } from "./models.ts";
import { computeFloatingPnl, getSellFeeRate } from "./calc.ts";
import { SettlementArbitrator } from "./settlement.ts";
import { Quote } from "./quotes.ts";

export class SignalScanner {
  private conn: Database;
  private arbitrator: SettlementArbitrator;

  constructor(dbConn: Database) {
    this.conn = dbConn;
    this.arbitrator = new SettlementArbitrator(dbConn);
  }

  public scanLot(
    lot: Lot,
    quote: Quote,
    customThresholds?: Record<string, number>,
    asOfTime?: Date
  ): Signal | null {
    if (lot.status !== LotStatus.ACTIVE) {
      return null;
    }

    const now = asOfTime || new Date();
    const currPrice = quote.current_price;

    const symRow = this.conn.query<{
      name: string;
      asset_class: string;
      settlement_mode: string;
    }, [string]>("SELECT name, asset_class, settlement_mode FROM symbols WHERE symbol = ?").get(lot.symbol);

    const assetClass = symRow ? symRow.asset_class : "ETF";
    const settlementMode = symRow ? (symRow.settlement_mode as SettlementMode) : SettlementMode.STATUTORY_T1;

    const feeRate = getSellFeeRate(assetClass);
    const [floatingPnl, returnRate] = computeFloatingPnl(
      currPrice,
      lot.cost_basis_unit,
      lot.remaining_quantity,
      feeRate
    );

    let tpMin = 0.1000;
    let dip1 = -0.1000;
    let deepValThresh = -0.2000;

    if (customThresholds) {
      if (customThresholds.take_profit_min !== undefined) tpMin = customThresholds.take_profit_min;
      if (customThresholds.dip_1 !== undefined) dip1 = customThresholds.dip_1;
      if (customThresholds.deep_value !== undefined) deepValThresh = customThresholds.deep_value;
    }

    const buyDateStr = (lot.buy_time instanceof Date ? lot.buy_time : new Date(lot.buy_time)).toISOString().slice(0, 10);
    const nowDateStr = now.toISOString().slice(0, 10);
    const isToday = buyDateStr === nowDateStr;

    let signalType: SignalType | null = null;
    let suggestedAction = "";
    let payload: Record<string, any> = {};

    // 1. Take Profit Scan
    if (returnRate >= tpMin) {
      if (settlementMode === SettlementMode.NATIVE_T0) {
        signalType = SignalType.TAKE_PROFIT_ALERT;
        suggestedAction = "CLOSE_PROFIT";
        payload = {
          reason: `天然T+0标的达到止盈线 (+${(returnRate * 100).toFixed(2)}%)`,
          settlement_mode: settlementMode,
          is_day_trading_eligible: isToday,
          can_sell_now: true,
          est_profit: floatingPnl,
          remaining_qty: lot.remaining_quantity,
          suggested_qty: lot.remaining_quantity,
        };
      } else {
        // STATUTORY_T1
        if (!isToday) {
          signalType = SignalType.TAKE_PROFIT_ALERT;
          suggestedAction = "CLOSE_PROFIT";
          payload = {
            reason: `历史持仓达到止盈线 (+${(returnRate * 100).toFixed(2)}%)`,
            settlement_mode: settlementMode,
            is_day_trading_eligible: false,
            can_sell_now: true,
            est_profit: floatingPnl,
            remaining_qty: lot.remaining_quantity,
            suggested_qty: lot.remaining_quantity,
          };
        } else {
          // Bought today in T+1
          const availCore = this.arbitrator.computeAvailableCorePosition(lot.symbol, now);
          if (availCore >= lot.remaining_quantity) {
            signalType = SignalType.DAY_TRADE_PROFIT_ALERT;
            suggestedAction = "SUBSTITUTE_CORE_CLOSE";
            payload = {
              reason: `当日买入浮盈达标 (+${(returnRate * 100).toFixed(2)}%)，可用底仓充足(${availCore}股)，支持代冲做T锁定`,
              settlement_mode: settlementMode,
              is_day_trading_eligible: true,
              can_sell_now: true,
              available_core_qty: availCore,
              est_profit: floatingPnl,
              remaining_qty: lot.remaining_quantity,
              suggested_qty: lot.remaining_quantity,
            };
          } else {
            signalType = SignalType.T1_LOCKED_ALERT;
            suggestedAction = "HOLD_UNTIL_NEXT_TRADING_DAY";
            payload = {
              reason: `当日买入浮盈达标 (+${(returnRate * 100).toFixed(2)}%)，但可用底仓不足(${availCore}股)，法定T+1锁定待次日开盘止盈`,
              settlement_mode: settlementMode,
              is_day_trading_eligible: false,
              can_sell_now: false,
              available_core_qty: availCore,
              est_profit: floatingPnl,
              remaining_qty: lot.remaining_quantity,
              suggested_qty: 0,
            };
          }
        }
      }
    }
    // 2. Dip Accumulation & Deep Value Scan
    else if (returnRate < deepValThresh) {
      // Drop > 20%: Deep value / accumulation zone
      // NEVER FREEZE. MUST REMAIN ACTIVE.
      signalType = SignalType.DEEP_VALUE_ALERT;
      suggestedAction = "DEEP_VALUE_ACCUMULATE_ON_STABILIZE";
      const targetLadder = returnRate >= -0.2500 ? "-25%" : "-30%";
      payload = {
        reason: `单笔浮亏达到深度击球区 (${(returnRate * 100).toFixed(2)}%)，估值极具吸引力，建议观察企稳信号分批加仓`,
        status_preserved: "ACTIVE",
        is_frozen: false,
        current_return_rate: returnRate,
        deep_ladder_target: targetLadder,
        suggested_base_amount: 10000,
        pyramid_level_next: lot.pyramid_level + 1,
      };
    } else if (returnRate <= dip1) {
      // Regular dip: -10% ~ -20%
      signalType = SignalType.ADD_POSITION_ALERT;
      suggestedAction = "ADD_POSITION_DIP";
      const ladderName = returnRate > -0.1500 ? "LEVEL_1" : "LEVEL_2";
      payload = {
        reason: `单笔浮亏触及常规逢低加仓梯度 (${(returnRate * 100).toFixed(2)}%)`,
        ladder: ladderName,
        suggested_base_amount: 10000,
        pyramid_level_next: lot.pyramid_level + 1,
      };
    }

    if (signalType && signalType !== SignalType.NONE) {
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const hours = String(now.getHours()).padStart(2, "0");
      const mins = String(now.getMinutes()).padStart(2, "0");
      const secs = String(now.getSeconds()).padStart(2, "0");
      const timeStr = `${year}${month}${day}${hours}${mins}${secs}`;
      const suffix = lot.lot_id.slice(-4);
      const sigId = `SIG-${timeStr}-${suffix}`;

      return {
        signal_id: sigId,
        lot_id: lot.lot_id,
        symbol: lot.symbol,
        signal_type: signalType,
        trigger_return_rate: returnRate,
        trigger_price: currPrice,
        suggested_action: suggestedAction,
        payload_json: JSON.stringify(payload),
      };
    }

    return null;
  }
}

