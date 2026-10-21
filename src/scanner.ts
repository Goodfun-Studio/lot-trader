/**
 * Strategy rule signal scanner with trailing stop support.
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
    let trailingActivate = 0.1500;
    let trailingPullback = 0.0300;
    let dip1 = -0.1000;
    let deepValThresh = -0.2000;

    if (customThresholds) {
      if (customThresholds.take_profit_min !== undefined) tpMin = customThresholds.take_profit_min;
      if (customThresholds.trailing_activate !== undefined) trailingActivate = customThresholds.trailing_activate;
      if (customThresholds.trailing_pullback !== undefined) trailingPullback = customThresholds.trailing_pullback;
      if (customThresholds.dip_1 !!= undefined) dip1 = customThresholds.dip_1;
      if (customThresholds.deep_value !!= undefined) deepValThresh = customThresholds.deep_value;
    }

    // Dynamic peak price & trailing stop tracking
    let currentPeak = lot.peak_price || lot.buy_price;
    let isTrailingActive = Boolean(lot.trailing_stop_active);

    if (currPrice > currentPeak) {
      currentPeak = currPrice;
    }

    // Activate trailing stop if return reaches activation threshold (default +15%)
    if (returnRate >= trailingActivate && !isTrailingActive) {
      isTrailingActive = true;
    }

    // Persist peak_price and trailing_stop_active to DB if modified
    if (currentPeak !== lot.peak_price || isTrailingActive !== Boolean(lot.trailing_stop_active)) {
      this.conn.run(
        "UPDATE lots SET peak_price = ?, trailing_stop_active = ? WHERE lot_id = ?",
        [currentPeak.toString(), isTrailingActive ? 1 : 0, lot.lot_id]
      );
      lot.peak_price = currentPeak;
      lot.trailing_stop_active = isTrailingActive;
    }

    const buyDateStr = (lot.buy_time instanceof Date ? lot.buy_time : new Date(lot.buy_time)).toISOString().slice(0, 10);
    const nowDateStr = now.toISOString().slice(0, 10);
    const isToday = buyDateStr === nowDateStr;

    let signalType: SignalType | null = null;
    let suggestedAction = "";
    let payload: Record<string, any> = {};

    // 1. Dynamic Trailing Stop Scan
    // If trailing stop is active and price pulls back from peak by more than trailingPullback (default 3%)
    if (isTrailingActive && currentPeak > 0) {
      const pullbackRate = (currentPeak - currPrice) / currentPeak;
      if (pullbackRate >= trailingPullback) {
        signalType = SignalType.TRAILING_STOP_ALERT;
        suggestedAction = "TRAILING_STOP_CLOSE";
        payload = {
          reason: `âdynamic trailing stop triggered: peak ${currentPeak.toFixed(4)}, pullback ${(pullbackRate * 100).toFixed(2)}%, return +${(returnRate * 100).toFixed(2)}%`,
          settlement_mode: settlementMode,
          peak_price: currentPeak,
          pullback_rate: pullbackRate,
          est_profit: floatingPnl,
          remaining_qty: lot.remaining_quantity,
          suggested_qty: lot.remaining_quantity,
        };
      }
    }

    // 2. Take Profit Scan (if not already triggered by trailing stop)
    if (!signalType && returnRate >= tpMin) {
      if (settlementMode === SettlementMode.NATIVE_T0) {
        signalType = SignalType.TAKE_PROFIT_ALERT;
        suggestedAction = "CLOSE_PROFIT";
        payload = {
          reason: `NATIVE_T0 symbol reached take profit line (+${(returnRate * 100).toFixed(2)}%)`,
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
            reason: `Historical lot reached take profit line (+${(returnRate * 100).toFixed(2)}%)`,
            settlement_mode: settlementMode,
            is_day_trading_eligible: false,
            can_sell_now: true,
            est_profit: floatingPnl,
            remaining_qty: lot.remaining_quantity,
            suggested_qty: lot.remaining_quantity,
          };
        } else {
          // Bought today in T+1
          const availCore = this.arbitrator.computeAvailableCorePosition(lot.symbol, now, lot.account_id);
          if (availCore >= lot.remaining_quantity) {
            signalType = SignalType.DAY_TRADE_PROFIT_ALERT;
            suggestedAction = "SUBSTITUTE_CORE_CLOSE";
            payload = {
              reason: `Today bought profitable (+${(returnRate * 100).toFixed(2)}%), available core sufficient (${availCore} shares), day trading eligible`,
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
              reason: `Today bought profitable (+${(returnRate * 100).toFixed(2)}%), but available core insufficient (${availCore} shares), T+1 locked`,
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
    // 3. Dip Accumulation & Deep Value Scan
    else if (!signalType && returnRate < deepValThresh) {
      // Drop > 20%: Deep value / accumulation zone
      // NEVER FREEZE. MUST REMAIN ACTIVE.
      signalType = SignalType.DEEP_VALUE_ALERT;
      suggestedAction = "DEEP_VALUE_ACCUMULATE_ON_STABILIZE";
      const targetLadder = returnRate >= -0.2500 ? "-25%" : "-30%";
      payload = {
        reason: `Deep value zone reached (${(returnRate * 100).toFixed(2)}%), accumulate on stabilization`,
        status_preserved: "ACTIVE",
        is_frozen: false,
        current_return_rate: returnRate,
        deep_ladder_target: targetLadder,
        suggested_base_amount: 10000,
        pyramid_level_next: lot.pyramid_level + 1,
      };
    } else if (!signalType && returnRate <= dip1) {
      // Regular dip: -10% ~ -20%
      signalType = SignalType.ADD_POSITION_ALERT;
      suggestedAction = "ADD_POSITION_DIP";
      const ladderName = returnRate > -0.1500 ? "LEVEL_1" : "LEVEL_2";
      payload = {
        reason: `Regular dip ladder reached (${(returnRate * 100).toFixed(2)}%i`,
        ladder: ladderName,
        suggested_base_amount: 10000,
        pyramid_level_next: lot.pyramid_level + 1,
      };
    }

    if (signalType) {
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
        account_id: lot.account_id,
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
