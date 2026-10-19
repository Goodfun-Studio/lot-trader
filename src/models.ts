/**
 * Data models and enums for Lot Trader.
 */

export enum SettlementMode {
  NATIVE_T0 = "NATIVE_T0",
  STATUTORY_T1 = "STATUTORY_T1",
}

export enum AssetClass {
  STOCK = "STOCK",
  ETF = "ETF",
  GOLD_SPOT = "GOLD_SPOT",
}

export enum LotStatus {
  ACTIVE = "ACTIVE",
  CLOSING = "CLOSING",
  CLOSED = "CLOSED",
}

export enum SignalType {
  NONE = "NONE",
  TAKE_PROFIT_ALERT = "TAKE_PROFIT_ALERT",
  DAY_TRADE_PROFIT_ALERT = "DAY_TRADE_PROFIT_ALERT",
  T1_LOCKED_ALERT = "T1_LOCKED_ALERT",
  ADD_POSITION_ALERT = "ADD_POSITION_ALERT",
  DEEP_VALUE_ALERT = "DEEP_VALUE_ALERT",
}

export enum TradeAction {
  BUY = "BUY",
  SELL_REGULAR = "SELL_REGULAR",
  SELL_DAY_TRADE = "SELL_DAY_TRADE",
}

export interface SymbolConfig {
  symbol: string;
  name: string;
  asset_class: AssetClass;
  settlement_mode: SettlementMode;
  lot_size?: number;
  created_at?: string;
}

export interface Lot {
  lot_id: string;
  symbol: string;
  buy_time: Date;
  buy_price: number;
  buy_quantity: number;
  remaining_quantity: number;
  cost_basis_unit: number;
  buy_fee: number;
  parent_lot_id?: string | null;
  status: LotStatus;
  pyramid_level: number;
  can_sell_now: boolean;
  is_day_trading: boolean;
  substituted_core_lot_id?: string | null;
  max_high_price?: number | null;
  max_low_price?: number | null;
  close_time?: Date | null;
  close_avg_price?: number | null;
  realized_pnl: number;
  created_at?: Date | null;
}

export interface Signal {
  signal_id: string;
  lot_id: string;
  symbol: string;
  signal_type: SignalType;
  trigger_return_rate: number;
  trigger_price: number;
  suggested_action: string;
  payload_json: string;
  is_handled?: boolean;
  created_at?: Date | null;
}

export interface Trade {
  trade_id: string;
  lot_id: string;
  action: TradeAction;
  price: number;
  quantity: number;
  fee: number;
  realized_pnl: number;
  executed_at?: Date | null;
  created_at?: Date | null;
}

