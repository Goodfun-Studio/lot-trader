"""Lot closer and core position substitute day-trading resolver."""
from datetime import datetime, date
from decimal import Decimal
import sqlite3
import uuid
from typing import Optional, Tuple

from lot_trader.models import Lot, LotStatus, SettlementMode, TradeAction, Trade
from lot_trader.engine.calc import compute_realized_pnl
from lot_trader.engine.settlement import SettlementArbitrator


class LotCloser:
    def __init__(self, db_conn: sqlite3.Connection):
        self.conn = db_conn
        self.arbitrator = SettlementArbitrator(db_conn)

    def close_lot(
        self,
        lot_id: str,
        close_price: Decimal,
        close_quantity: Optional[int] = None,
        substitute_core: bool = False,
        fee: Optional[Decimal] = None,
        close_time: Optional[datetime] = None
    ) -> Tuple[Lot, Trade]:
        """
        Closes a lot (partial or full).
        If substitute_core is True, validates and deducts available core position,
        and marks the lot as is_day_trading = True.
        """
        now = close_time or datetime.now()

        # Query lot
        row = self.conn.execute("SELECT * FROM lots WHERE lot_id = ?", (lot_id,)).fetchone()
        if not row:
            raise ValueError(f"批次不存在: {lot_id}")

        lot_dict = dict(row)
        if lot_dict["status"] == LotStatus.CLOSED.value:
            raise ValueError(f"批次 {lot_id} 已经是 CLOSED 状态，不可重复平仓")

        remaining_qty = lot_dict["remaining_quantity"]
        qty_to_close = close_quantity if close_quantity is not None else remaining_qty

        if qty_to_close <= 0:
            raise ValueError("平仓数量必须大于 0")
        if qty_to_close > remaining_qty:
            raise ValueError(f"平仓数量 {qty_to_close} 超过剩余可用数量 {remaining_qty}")

        symbol = lot_dict["symbol"]
        settlement_mode = self.arbitrator.get_symbol_settlement_mode(symbol)

        b_time_raw = lot_dict["buy_time"]
        b_date = (b_time_raw.date() if isinstance(b_time_raw, datetime)
                  else datetime.fromisoformat(str(b_time_raw)).date())
        is_today = (b_date == now.date())

        substituted_core_lot_id: Optional[str] = None
        is_day_trade = False

        if settlement_mode == SettlementMode.NATIVE_T0:
            if is_today:
                is_day_trade = True
        else:
            # STATUTORY_T1
            if is_today:
                if not substitute_core:
                    raise ValueError(f"标的 {symbol} 为法定 T+1，当日买入份额无法直接平仓。若有可用底仓请指定 --substitute-core")

                # Check core position pool
                avail_core = self.arbitrator.compute_available_core_position(symbol, as_of_date=now.date())
                if avail_core < qty_to_close:
                    raise ValueError(f"底仓可用配额不足，严防裸卖空！可用底仓仅 {avail_core} 股，申请代冲 {qty_to_close} 股")

                # Find oldest active core lot to link
                core_row = self.conn.execute(
                    """
                    SELECT lot_id FROM lots
                    WHERE symbol = ? AND status = 'ACTIVE' AND date(buy_time) < date(?)
                    ORDER BY buy_time ASC
                    LIMIT 1
                    """,
                    (symbol, now.isoformat())
                ).fetchone()
                if core_row:
                    substituted_core_lot_id = core_row["lot_id"]

                is_day_trade = True

        # Compute fee if not provided (default 0.05% stamp tax + 0.02% commission if stock, or 0.02% if ETF)
        # For simplicity, 0.02% for ETF, 0.07% for STOCK if None
        close_fee = fee
        if close_fee is None:
            sym_row = self.conn.execute("SELECT asset_class FROM symbols WHERE symbol = ?", (symbol,)).fetchone()
            a_cls = sym_row["asset_class"] if sym_row else "ETF"
            rate = Decimal("0.0002") if a_cls.upper() in ("ETF", "GOLD_SPOT") else Decimal("0.0007")
            close_fee = (close_price * Decimal(qty_to_close) * rate).quantize(Decimal("0.01"))

        cost_basis = Decimal(str(lot_dict["cost_basis_unit"]))
        realized_pnl = compute_realized_pnl(
            close_price=close_price,
            cost_basis=cost_basis,
            close_quantity=qty_to_close,
            close_fee=close_fee
        )

        new_remaining_qty = remaining_qty - qty_to_close
        new_status = LotStatus.CLOSED.value if new_remaining_qty == 0 else LotStatus.ACTIVE.value
        total_realized_pnl = Decimal(str(lot_dict["realized_pnl"])) + realized_pnl

        # Atomic database updates with unique trade_id
        unique_suffix = uuid.uuid4().hex[:6].upper()
        trade_id = f"TRD-{now.strftime('%Y%m%d%H%M%S')}-{unique_suffix}"
        trade_action = TradeAction.SELL_DAY_TRADE.value if is_day_trade else TradeAction.SELL_REGULAR.value

        with self.conn:
            self.conn.execute(
                """
                UPDATE lots
                SET remaining_quantity = ?,
                    status = ?,
                    close_time = CASE WHEN ? = 0 THEN ? ELSE close_time END,
                    close_avg_price = ?,
                    realized_pnl = ?,
                    is_day_trading = CASE WHEN ? THEN 1 ELSE is_day_trading END,
                    substituted_core_lot_id = CASE WHEN ? IS NOT NULL THEN ? ELSE substituted_core_lot_id END
                WHERE lot_id = ?
                """,
                (
                    new_remaining_qty,
                    new_status,
                    new_remaining_qty,
                    now.isoformat(),
                    str(close_price),
                    str(total_realized_pnl),
                    1 if is_day_trade else 0,
                    substituted_core_lot_id,
                    substituted_core_lot_id,
                    lot_id
                )
            )

            self.conn.execute(
                """
                INSERT INTO trades (trade_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade_id,
                    lot_id,
                    trade_action,
                    str(close_price),
                    qty_to_close,
                    str(close_fee),
                    str(realized_pnl),
                    now.isoformat()
                )
            )

        # Reload updated lot
        updated_row = self.conn.execute("SELECT * FROM lots WHERE lot_id = ?", (lot_id,)).fetchone()
        updated_lot = Lot(
            lot_id=updated_row["lot_id"],
            symbol=updated_row["symbol"],
            buy_time=datetime.fromisoformat(str(updated_row["buy_time"])),
            buy_price=Decimal(str(updated_row["buy_price"])),
            buy_quantity=updated_row["buy_quantity"],
            remaining_quantity=updated_row["remaining_quantity"],
            cost_basis_unit=Decimal(str(updated_row["cost_basis_unit"])),
            buy_fee=Decimal(str(updated_row["buy_fee"])),
            parent_lot_id=updated_row["parent_lot_id"],
            status=LotStatus(updated_row["status"]),
            pyramid_level=updated_row["pyramid_level"],
            can_sell_now=bool(updated_row["can_sell_now"]),
            is_day_trading=bool(updated_row["is_day_trading"]),
            substituted_core_lot_id=updated_row["substituted_core_lot_id"],
            close_time=datetime.fromisoformat(str(updated_row["close_time"])) if updated_row["close_time"] else None,
            close_avg_price=Decimal(str(updated_row["close_avg_price"])) if updated_row["close_avg_price"] else None,
            realized_pnl=Decimal(str(updated_row["realized_pnl"]))
        )

        trade = Trade(
            trade_id=trade_id,
            lot_id=lot_id,
            action=TradeAction(trade_action),
            price=close_price,
            quantity=qty_to_close,
            fee=close_fee,
            realized_pnl=realized_pnl,
            executed_at=now
        )

        return updated_lot, trade

