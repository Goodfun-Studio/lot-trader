"""Strategy rule signal scanner."""
import json
from dataclasses import asdict
from datetime import datetime, date
from decimal import Decimal
from typing import Dict, List, Optional
import sqlite3

from lot_trader.models import Lot, LotStatus, SettlementMode, Signal, SignalType
from lot_trader.engine.calc import compute_cost_basis, compute_floating_pnl, get_sell_fee_rate
from lot_trader.engine.settlement import SettlementArbitrator
from lot_trader.quotes import Quote


class SignalScanner:
    def __init__(self, db_conn: sqlite3.Connection):
        self.conn = db_conn
        self.arbitrator = SettlementArbitrator(db_conn)

    def scan_lot(
        self,
        lot: Lot,
        quote: Quote,
        custom_thresholds: Optional[Dict[str, Decimal]] = None,
        as_of_time: Optional[datetime] = None
    ) -> Optional[Signal]:
        """
        Scans a single ACTIVE lot against real-time quote.
        Thresholds defaults:
        - take_profit_min: +0.1000 (+10%)
        - take_profit_std: +0.1500 (+15%)
        - take_profit_strong: +0.2000 (+20%)
        - dip_1: -0.1000 (-10%)
        - dip_2: -0.1500 (-15%)
        - dip_3: -0.2000 (-20%)
        - deep_value: < -0.2000 (-20%)
        """
        if lot.status != LotStatus.ACTIVE:
            return None

        now = as_of_time or datetime.now()
        curr_price = quote.current_price

        # Update dynamic high/low tracking
        max_h = max(lot.max_high_price or curr_price, curr_price)
        max_l = min(lot.max_low_price or curr_price, curr_price)

        # Get asset class
        sym_row = self.conn.execute("SELECT name, asset_class, settlement_mode FROM symbols WHERE symbol = ?", (lot.symbol,)).fetchone()
        asset_class = sym_row["asset_class"] if sym_row else "ETF"
        symbol_name = sym_row["name"] if sym_row else lot.symbol
        settlement_mode = SettlementMode(sym_row["settlement_mode"]) if sym_row else SettlementMode.STATUTORY_T1

        fee_rate = get_sell_fee_rate(asset_class)
        floating_pnl, return_rate = compute_floating_pnl(
            current_price=curr_price,
            cost_basis=lot.cost_basis_unit,
            remaining_quantity=lot.remaining_quantity,
            sell_fee_rate=fee_rate
        )

        tp_min = Decimal("0.1000")
        dip_1 = Decimal("-0.1000")
        deep_val_thresh = Decimal("-0.2000")

        if custom_thresholds:
            tp_min = custom_thresholds.get("take_profit_min", tp_min)
            dip_1 = custom_thresholds.get("dip_1", dip_1)
            deep_val_thresh = custom_thresholds.get("deep_value", deep_val_thresh)

        buy_date = lot.buy_time.date() if isinstance(lot.buy_time, datetime) else datetime.fromisoformat(str(lot.buy_time)).date()
        is_today = (buy_date == now.date())

        signal_type: Optional[SignalType] = None
        suggested_action = ""
        payload = {}

        # 1. Take Profit Scan
        if return_rate >= tp_min:
            if settlement_mode == SettlementMode.NATIVE_T0:
                signal_type = SignalType.TAKE_PROFIT_ALERT
                suggested_action = "CLOSE_PROFIT"
                payload = {
                    "reason": f"天然T+0标的达到止盈线 (+{return_rate * 100:.2f}%)",
                    "settlement_mode": settlement_mode.value,
                    "is_day_trading_eligible": is_today,
                    "can_sell_now": True,
                    "est_profit": float(floating_pnl),
                    "remaining_qty": lot.remaining_quantity,
                    "suggested_qty": lot.remaining_quantity
                }
            else:
                # STATUTORY_T1
                if not is_today:
                    signal_type = SignalType.TAKE_PROFIT_ALERT
                    suggested_action = "CLOSE_PROFIT"
                    payload = {
                        "reason": f"历史持仓达到止盈线 (+{return_rate * 100:.2f}%)",
                        "settlement_mode": settlement_mode.value,
                        "is_day_trading_eligible": False,
                        "can_sell_now": True,
                        "est_profit": float(floating_pnl),
                        "remaining_qty": lot.remaining_quantity,
                        "suggested_qty": lot.remaining_quantity
                    }
                else:
                    # Bought today in T+1
                    avail_core = self.arbitrator.compute_available_core_position(lot.symbol, as_of_date=now.date())
                    if avail_core >= lot.remaining_quantity:
                        signal_type = SignalType.DAY_TRADE_PROFIT_ALERT
                        suggested_action = "SUBSTITUTE_CORE_CLOSE"
                        payload = {
                            "reason": f"当日买入浮盈达标 (+{return_rate * 100:.2f}%)，可用底仓充足({avail_core}股)，支持代冲做T锁定",
                            "settlement_mode": settlement_mode.value,
                            "is_day_trading_eligible": True,
                            "can_sell_now": True,
                            "available_core_qty": avail_core,
                            "est_profit": float(floating_pnl),
                            "remaining_qty": lot.remaining_quantity,
                            "suggested_qty": lot.remaining_quantity
                        }
                    else:
                        signal_type = SignalType.T1_LOCKED_ALERT
                        suggested_action = "HOLD_UNTIL_NEXT_TRADING_DAY"
                        payload = {
                            "reason": f"当日买入浮盈达标 (+{return_rate * 100:.2f}%)，但可用底仓不足({avail_core}股)，法定T+1锁定待次日开盘止盈",
                            "settlement_mode": settlement_mode.value,
                            "is_day_trading_eligible": False,
                            "can_sell_now": False,
                            "available_core_qty": avail_core,
                            "est_profit": float(floating_pnl),
                            "remaining_qty": lot.remaining_quantity,
                            "suggested_qty": 0
                        }

        # 2. Dip Accumulation & Deep Value Scan
        elif return_rate < deep_val_thresh:
            # Drop > 20%: Deep value / accumulation zone
            # NEVER FREEZE. MUST REMAIN ACTIVE.
            signal_type = SignalType.DEEP_VALUE_ALERT
            suggested_action = "DEEP_VALUE_ACCUMULATE_ON_STABILIZE"
            # Target suggest ladder: next ladder is -25% or -30%
            target_ladder = "-25%" if return_rate >= Decimal("-0.2500") else "-30%"
            payload = {
                "reason": f"单笔浮亏达到深度击球区 ({return_rate * 100:.2f}%)，估值极具吸引力，建议观察企稳信号分批加仓",
                "status_preserved": "ACTIVE",
                "is_frozen": False,
                "current_return_rate": float(return_rate),
                "deep_ladder_target": target_ladder,
                "suggested_base_amount": 10000,
                "pyramid_level_next": lot.pyramid_level + 1
            }

        elif return_rate <= dip_1:
            # Regular dip: -10% ~ -20%
            signal_type = SignalType.ADD_POSITION_ALERT
            suggested_action = "ADD_POSITION_DIP"
            ladder_name = "LEVEL_1" if return_rate > Decimal("-0.1500") else "LEVEL_2"
            payload = {
                "reason": f"单笔浮亏触及常规逢低加仓梯度 ({return_rate * 100:.2f}%)",
                "ladder": ladder_name,
                "suggested_base_amount": 10000,
                "pyramid_level_next": lot.pyramid_level + 1
            }

        if signal_type and signal_type != SignalType.NONE:
            sig_id = f"SIG-{now.strftime('%Y%m%d%H%M%S')}-{lot.lot_id[-4:]}"
            return Signal(
                signal_id=sig_id,
                lot_id=lot.lot_id,
                symbol=lot.symbol,
                signal_type=signal_type,
                trigger_return_rate=return_rate,
                trigger_price=curr_price,
                suggested_action=suggested_action,
                payload_json=json.dumps(payload, ensure_ascii=False)
            )

        return None

