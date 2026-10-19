"""Lot Trader engine services."""
from datetime import datetime, date
from decimal import Decimal
import json
from typing import Dict, List, Optional, Tuple
import sqlite3
import uuid

from lot_trader.models import Lot, LotStatus, SettlementMode, Signal, Trade
from lot_trader.engine.calc import compute_cost_basis, compute_floating_pnl, get_sell_fee_rate
from lot_trader.engine.settlement import SettlementArbitrator
from lot_trader.engine.scanner import SignalScanner
from lot_trader.engine.closer import LotCloser
from lot_trader.quotes import QuoteProvider, normalize_symbol


class TraderEngine:
    def __init__(self, db_conn: sqlite3.Connection, quote_provider: Optional[QuoteProvider] = None):
        self.conn = db_conn
        self.quote_provider = quote_provider or QuoteProvider()
        self.arbitrator = SettlementArbitrator(db_conn)
        self.scanner = SignalScanner(db_conn)
        self.closer = LotCloser(db_conn)

    def buy_lot(
        self,
        symbol_input: str,
        price: Decimal,
        quantity: int,
        fee: Optional[Decimal] = None,
        buy_time: Optional[datetime] = None,
        parent_lot_id: Optional[str] = None
    ) -> Lot:
        """Records a new buy lot."""
        std_symbol, _ = normalize_symbol(symbol_input)
        now = buy_time or datetime.now()

        # Quantity must be multiple of 100
        if quantity <= 0:
            raise ValueError("买入数量必须大于 0")
        if quantity % 100 != 0:
            raise ValueError(f"买入数量必须为 100 的整数倍 (一手单位)，当前输入: {quantity}")

        # Ensure symbol exists in database
        sym_row = self.conn.execute("SELECT * FROM symbols WHERE symbol = ?", (std_symbol,)).fetchone()
        if not sym_row:
            # Auto-register symbol based on standard inference
            is_gold_etf = any(k in std_symbol for k in ["518880", "159934", "518800", "159937", "513"])
            asset_class = "ETF" if ("51" in std_symbol or "15" in std_symbol or "58" in std_symbol) else "STOCK"
            set_mode = "NATIVE_T0" if is_gold_etf else "STATUTORY_T1"
            name = symbol_input if symbol_input != std_symbol else f"标的{std_symbol}"
            with self.conn:
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size)
                    VALUES (?, ?, ?, ?, 100)
                    """,
                    (std_symbol, name, asset_class, set_mode)
                )
            sym_row = self.conn.execute("SELECT * FROM symbols WHERE symbol = ?", (std_symbol,)).fetchone()

        asset_class = sym_row["asset_class"]
        settlement_mode = SettlementMode(sym_row["settlement_mode"])

        # Fee calculation if not provided (default 0.02% commission)
        buy_fee = fee
        if buy_fee is None:
            buy_fee = (price * Decimal(quantity) * Decimal("0.0002")).quantize(Decimal("0.01"))

        cost_basis = compute_cost_basis(price, quantity, buy_fee)

        # Generate lot_id: LOT-YYYYMMDD-XXXXX
        date_str = now.strftime("%Y%m%d")
        count_row = self.conn.execute(
            "SELECT count(*) as c FROM lots WHERE lot_id LIKE ?",
            (f"LOT-{date_str}-%",)
        ).fetchone()
        seq = (count_row["c"] + 1) if count_row else 1
        lot_id = f"LOT-{date_str}-{seq:03d}"

        # Determine pyramid level if parent_lot_id provided
        pyramid_level = 0
        if parent_lot_id:
            p_row = self.conn.execute("SELECT pyramid_level FROM lots WHERE lot_id = ?", (parent_lot_id,)).fetchone()
            if p_row:
                pyramid_level = p_row["pyramid_level"] + 1

        # Determine can_sell_now:
        # Native T+0 is always True.
        # Statutory T+1 is False initially.
        can_sell = (settlement_mode == SettlementMode.NATIVE_T0)

        with self.conn:
            self.conn.execute(
                """
                INSERT INTO lots (
                    lot_id, parent_lot_id, symbol, buy_time, buy_price, buy_quantity,
                    remaining_quantity, buy_fee, cost_basis_unit, status, pyramid_level,
                    can_sell_now, is_day_trading, max_high_price, max_low_price, realized_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lot_id,
                    parent_lot_id,
                    std_symbol,
                    now.isoformat(),
                    str(price),
                    quantity,
                    quantity,
                    str(buy_fee),
                    str(cost_basis),
                    LotStatus.ACTIVE.value,
                    pyramid_level,
                    1 if can_sell else 0,
                    0,
                    str(price),
                    str(price),
                    "0.00"
                )
            )

            # Record buy trade with unique trade_id
            unique_suffix = uuid.uuid4().hex[:6].upper()
            trade_id = f"TRD-{now.strftime('%Y%m%d%H%M%S')}-{unique_suffix}"
            self.conn.execute(
                """
                INSERT INTO trades (trade_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade_id,
                    lot_id,
                    "BUY",
                    str(price),
                    quantity,
                    str(buy_fee),
                    "0.00",
                    now.isoformat()
                )
            )

        return self.get_lot(lot_id)

    def get_lot(self, lot_id: str) -> Optional[Lot]:
        row = self.conn.execute("SELECT * FROM lots WHERE lot_id = ?", (lot_id,)).fetchone()
        if not row:
            return None
        return Lot(
            lot_id=row["lot_id"],
            symbol=row["symbol"],
            buy_time=datetime.fromisoformat(str(row["buy_time"])),
            buy_price=Decimal(str(row["buy_price"])),
            buy_quantity=row["buy_quantity"],
            remaining_quantity=row["remaining_quantity"],
            cost_basis_unit=Decimal(str(row["cost_basis_unit"])),
            buy_fee=Decimal(str(row["buy_fee"])),
            parent_lot_id=row["parent_lot_id"],
            status=LotStatus(row["status"]),
            pyramid_level=row["pyramid_level"],
            can_sell_now=bool(row["can_sell_now"]),
            is_day_trading=bool(row["is_day_trading"]),
            substituted_core_lot_id=row["substituted_core_lot_id"],
            max_high_price=Decimal(str(row["max_high_price"])) if row["max_high_price"] else None,
            max_low_price=Decimal(str(row["max_low_price"])) if row["max_low_price"] else None,
            close_time=datetime.fromisoformat(str(row["close_time"])) if row["close_time"] else None,
            close_avg_price=Decimal(str(row["close_avg_price"])) if row["close_avg_price"] else None,
            realized_pnl=Decimal(str(row["realized_pnl"]))
        )

    def list_lots(
        self,
        status: Optional[str] = "ACTIVE",
        symbol: Optional[str] = None
    ) -> List[Dict]:
        """
        Lists lots with current market price and floating PnL.
        """
        query = "SELECT * FROM lots WHERE 1=1"
        params = []
        if status:
            query += " AND status = ?"
            params.append(status.upper())
        if symbol:
            std_symbol, _ = normalize_symbol(symbol)
            query += " AND symbol = ?"
            params.append(std_symbol)
        query += " ORDER BY buy_time DESC"

        rows = self.conn.execute(query, params).fetchall()
        if not rows:
            return []

        symbols = list(set([r["symbol"] for r in rows]))
        quotes = self.quote_provider.get_quotes(symbols)

        results = []
        now = datetime.now()

        for r in rows:
            sym = r["symbol"]
            q = quotes.get(sym)
            curr_p = q.current_price if q else Decimal(str(r["buy_price"]))

            sym_row = self.conn.execute("SELECT name, asset_class, settlement_mode FROM symbols WHERE symbol = ?", (sym,)).fetchone()
            name = sym_row["name"] if sym_row else sym
            a_cls = sym_row["asset_class"] if sym_row else "ETF"
            set_mode = sym_row["settlement_mode"] if sym_row else "STATUTORY_T1"

            cost_b = Decimal(str(r["cost_basis_unit"]))
            rem_q = r["remaining_quantity"]
            fee_r = get_sell_fee_rate(a_cls)

            float_pnl, ret_rate = compute_floating_pnl(curr_p, cost_b, rem_q, fee_r)

            # Determine dynamic can_sell_now
            b_time = datetime.fromisoformat(str(r["buy_time"]))
            if set_mode == "NATIVE_T0":
                dynamic_can_sell = True
            elif b_time.date() < now.date():
                dynamic_can_sell = True
            else:
                avail_core = self.arbitrator.compute_available_core_position(sym, as_of_date=now.date())
                dynamic_can_sell = (avail_core >= rem_q)

            results.append({
                "lot_id": r["lot_id"],
                "symbol": sym,
                "symbol_name": name,
                "settlement_mode": set_mode,
                "buy_time": str(r["buy_time"]),
                "buy_price": float(r["buy_price"]),
                "buy_quantity": r["buy_quantity"],
                "remaining_quantity": rem_q,
                "cost_basis_unit": float(cost_b),
                "current_price": float(curr_p),
                "floating_pnl": float(float_pnl),
                "return_rate": float(ret_rate),
                "status": r["status"],
                "pyramid_level": r["pyramid_level"],
                "can_sell_now": dynamic_can_sell,
                "is_day_trading": bool(r["is_day_trading"]),
                "realized_pnl": float(r["realized_pnl"])
            })

        return results

    def scan_signals(
        self,
        custom_thresholds: Optional[Dict[str, Decimal]] = None,
        as_of_time: Optional[datetime] = None
    ) -> List[Signal]:
        """Scans all ACTIVE lots for signals."""
        rows = self.conn.execute("SELECT * FROM lots WHERE status = 'ACTIVE'").fetchall()
        if not rows:
            return []

        symbols = list(set([r["symbol"] for r in rows]))
        quotes = self.quote_provider.get_quotes(symbols)

        signals: List[Signal] = []
        for r in rows:
            lot = self.get_lot(r["lot_id"])
            q = quotes.get(lot.symbol)
            if not q:
                continue
            sig = self.scanner.scan_lot(lot, q, custom_thresholds=custom_thresholds, as_of_time=as_of_time)
            if sig:
                signals.append(sig)
                # Save signal to database
                with self.conn:
                    self.conn.execute(
                        """
                        INSERT OR REPLACE INTO signals (
                            signal_id, lot_id, symbol, signal_type, trigger_return_rate,
                            trigger_price, suggested_action, payload_json, is_handled
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                        """,
                        (
                            sig.signal_id,
                            sig.lot_id,
                            sig.symbol,
                            sig.signal_type.value,
                            str(sig.trigger_return_rate),
                            str(sig.trigger_price),
                            sig.suggested_action,
                            sig.payload_json
                        )
                    )
        return signals

    def close_lot(
        self,
        lot_id: str,
        close_price: Decimal,
        close_quantity: Optional[int] = None,
        substitute_core: bool = False,
        fee: Optional[Decimal] = None,
        close_time: Optional[datetime] = None
    ) -> Tuple[Lot, Trade]:
        return self.closer.close_lot(
            lot_id=lot_id,
            close_price=close_price,
            close_quantity=close_quantity,
            substitute_core=substitute_core,
            fee=fee,
            close_time=close_time
        )

    def compute_stats(self, days: Optional[int] = None, symbol: Optional[str] = None) -> Dict:
        """Computes trading performance statistics."""
        query = "SELECT * FROM trades WHERE action IN ('SELL_REGULAR', 'SELL_DAY_TRADE')"
        params = []
        if days:
            query += " AND datetime(executed_at) >= datetime('now', ?)"
            params.append(f"-{days} days")
        if symbol:
            std_s, _ = normalize_symbol(symbol)
            query += " AND lot_id IN (SELECT lot_id FROM lots WHERE symbol = ?)"
            params.append(std_s)

        rows = self.conn.execute(query, params).fetchall()

        total_closed_trades = len(rows)
        if total_closed_trades == 0:
            return {
                "total_trades": 0,
                "winning_trades": 0,
                "losing_trades": 0,
                "win_rate": 0.0,
                "total_realized_pnl": 0.0,
                "profit_factor": 0.0,
                "day_trades_count": 0
            }

        total_pnl = Decimal("0.00")
        winning_count = 0
        losing_count = 0
        gross_profit = Decimal("0.00")
        gross_loss = Decimal("0.00")
        day_trades = 0

        for r in rows:
            pnl = Decimal(str(r["realized_pnl"]))
            total_pnl += pnl
            if pnl > 0:
                winning_count += 1
                gross_profit += pnl
            elif pnl < 0:
                losing_count += 1
                gross_loss += abs(pnl)

            if r["action"] == "SELL_DAY_TRADE":
                day_trades += 1

        win_rate = float(winning_count / total_closed_trades) if total_closed_trades > 0 else 0.0
        profit_factor = float(gross_profit / gross_loss) if gross_loss > 0 else (999.0 if gross_profit > 0 else 1.0)

        return {
            "total_trades": total_closed_trades,
            "winning_trades": winning_count,
            "losing_trades": losing_count,
            "win_rate": round(win_rate, 4),
            "total_realized_pnl": float(total_pnl),
            "profit_factor": round(profit_factor, 2),
            "day_trades_count": day_trades
        }

