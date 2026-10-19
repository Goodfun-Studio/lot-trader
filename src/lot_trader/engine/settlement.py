"""Settlement mode arbitrator and available core position pool."""
from datetime import datetime, date
from decimal import Decimal
from typing import Dict, List, Optional, Tuple
import sqlite3

from lot_trader.models import SettlementMode, LotStatus, Lot


class SettlementArbitrator:
    def __init__(self, db_conn: sqlite3.Connection):
        self.conn = db_conn

    def get_symbol_settlement_mode(self, symbol: str) -> SettlementMode:
        row = self.conn.execute(
            "SELECT settlement_mode FROM symbols WHERE symbol = ?",
            (symbol,)
        ).fetchone()
        if row:
            return SettlementMode(row["settlement_mode"])
        # Fallback heuristic: 518xxx, 159934, etc are Native T+0
        if any(prefix in symbol for prefix in ["518880", "159934", "518800", "159937", "513"]):
            return SettlementMode.NATIVE_T0
        return SettlementMode.STATUTORY_T1

    def compute_available_core_position(
        self,
        symbol: str,
        as_of_date: Optional[date] = None
    ) -> int:
        """
        Q_available_core = sum(Q_remain of lots bought on T-1 or earlier) - Q_closing_frozen
        Only lots bought strictly before as_of_date count as available core.
        """
        target_date = as_of_date or date.today()
        # In SQLite, buy_time is stored as string/timestamp. We can extract date or compare.
        cur = self.conn.execute(
            """
            SELECT lot_id, buy_time, remaining_quantity, status
            FROM lots
            WHERE symbol = ? AND status IN ('ACTIVE', 'CLOSING')
            """,
            (symbol,)
        )
        rows = cur.fetchall()
        total_core = 0
        for r in rows:
            # Check buy_date vs target_date
            b_time_raw = r["buy_time"]
            if isinstance(b_time_raw, str):
                b_date = datetime.fromisoformat(b_time_raw.replace("Z", "")).date()
            elif isinstance(b_time_raw, datetime):
                b_date = b_time_raw.date()
            else:
                continue

            if b_date < target_date:
                if r["status"] == LotStatus.ACTIVE.value:
                    total_core += r["remaining_quantity"]
                # If CLOSING, it is frozen, so not counted

        return total_core

    def can_sell_lot_now(
        self,
        lot: Lot,
        current_time: Optional[datetime] = None
    ) -> Tuple[bool, str]:
        """
        Checks if the lot itself has permission to sell now.
        Returns: (can_sell, reason)
        """
        now = current_time or datetime.now()
        settlement_mode = self.get_symbol_settlement_mode(lot.symbol)

        if settlement_mode == SettlementMode.NATIVE_T0:
            return True, "NATIVE_T0: 即刻可卖"

        # STATUTORY_T1
        buy_date = lot.buy_time.date() if isinstance(lot.buy_time, datetime) else datetime.fromisoformat(str(lot.buy_time)).date()
        if buy_date < now.date():
            return True, "STATUTORY_T1: 历史交收底仓，可合法平仓"

        # Bought today: check if core position is available for day-trade substitution
        avail_core = self.compute_available_core_position(lot.symbol, as_of_date=now.date())
        if avail_core >= lot.remaining_quantity:
            return True, f"STATUTORY_T1: 盘中加仓，可用底仓充足({avail_core}股)，支持代冲做T"
        elif avail_core > 0:
            return False, f"STATUTORY_T1: 可用底仓不足以完全代冲(需{lot.remaining_quantity}股，仅{avail_core}股)"
        else:
            return False, "STATUTORY_T1: 当日建仓无底仓，法定T+1锁定，次日开盘方可平仓"

