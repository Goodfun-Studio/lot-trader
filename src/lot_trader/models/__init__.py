"""Data models and enums for Lot Trader."""
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional, Dict, Any


class SettlementMode(str, Enum):
    NATIVE_T0 = "NATIVE_T0"
    STATUTORY_T1 = "STATUTORY_T1"


class AssetClass(str, Enum):
    STOCK = "STOCK"
    ETF = "ETF"
    GOLD_SPOT = "GOLD_SPOT"


class LotStatus(str, Enum):
    ACTIVE = "ACTIVE"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"


class SignalType(str, Enum):
    NONE = "NONE"
    TAKE_PROFIT_ALERT = "TAKE_PROFIT_ALERT"
    DAY_TRADE_PROFIT_ALERT = "DAY_TRADE_PROFIT_ALERT"
    T1_LOCKED_ALERT = "T1_LOCKED_ALERT"
    ADD_POSITION_ALERT = "ADD_POSITION_ALERT"
    DEEP_VALUE_ALERT = "DEEP_VALUE_ALERT"


class TradeAction(str, Enum):
    BUY = "BUY"
    SELL_REGULAR = "SELL_REGULAR"
    SELL_DAY_TRADE = "SELL_DAY_TRADE"


@dataclass
class SymbolConfig:
    symbol: str
    name: str
    asset_class: AssetClass
    settlement_mode: SettlementMode
    lot_size: int = 100
    created_at: Optional[datetime] = None


@dataclass
class Lot:
    lot_id: str
    symbol: str
    buy_time: datetime
    buy_price: Decimal
    buy_quantity: int
    remaining_quantity: int
    cost_basis_unit: Decimal
    buy_fee: Decimal = Decimal("0.00")
    parent_lot_id: Optional[str] = None
    status: LotStatus = LotStatus.ACTIVE
    pyramid_level: int = 0
    can_sell_now: bool = False
    is_day_trading: bool = False
    substituted_core_lot_id: Optional[str] = None
    max_high_price: Optional[Decimal] = None
    max_low_price: Optional[Decimal] = None
    close_time: Optional[datetime] = None
    close_avg_price: Optional[Decimal] = None
    realized_pnl: Decimal = Decimal("0.00")
    created_at: Optional[datetime] = None


@dataclass
class Signal:
    signal_id: str
    lot_id: str
    symbol: str
    signal_type: SignalType
    trigger_return_rate: Decimal
    trigger_price: Decimal
    suggested_action: str
    payload_json: str
    is_handled: bool = False
    created_at: Optional[datetime] = None


@dataclass
class Trade:
    trade_id: str
    lot_id: str
    action: TradeAction
    price: Decimal
    quantity: int
    fee: Decimal = Decimal("0.00")
    realized_pnl: Decimal = Decimal("0.00")
    executed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None

