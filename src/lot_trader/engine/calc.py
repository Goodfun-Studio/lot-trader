"""Pure calculation functions for Lot Trader engine."""
from decimal import Decimal, ROUND_HALF_UP
from typing import Tuple

# Default estimated sell fee rate:
# For A-shares: 0.05% stamp tax + 0.02% commission = 0.07% (or ETF 0.02% commission)
# The spec states:
# "预估卖出税费（印花税按现行A股单边千分之0.5或免印花税的ETF核算，预估佣金按万分之2计算）：
# Fee_est_sell = Q_remain * P_current * r_sell_fee
# PnL_float = (P_current * Q_remain) - (P_cost * Q_remain) - Fee_est_sell
# R_lot = PnL_float / (P_cost * Q_remain) = (P_current * (1 - r_sell_fee) - P_cost) / P_cost"
# Let's support asset-class specific or default sell fee rate.

DEFAULT_ETF_SELL_FEE_RATE = Decimal("0.0002")    # 0.02% (no stamp duty)
DEFAULT_STOCK_SELL_FEE_RATE = Decimal("0.0007")  # 0.05% stamp duty + 0.02% commission


def get_sell_fee_rate(asset_class: str) -> Decimal:
    if asset_class.upper() in ("ETF", "GOLD_SPOT"):
        return DEFAULT_ETF_SELL_FEE_RATE
    return DEFAULT_STOCK_SELL_FEE_RATE


def compute_cost_basis(buy_price: Decimal, buy_quantity: int, buy_fee: Decimal) -> Decimal:
    """
    P_cost = (Q_buy * P_buy + Fee_buy) / Q_buy
    """
    total_cost = (buy_price * Decimal(buy_quantity)) + buy_fee
    cost_basis = total_cost / Decimal(buy_quantity)
    return cost_basis.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def compute_floating_pnl(
    current_price: Decimal,
    cost_basis: Decimal,
    remaining_quantity: int,
    sell_fee_rate: Decimal = DEFAULT_ETF_SELL_FEE_RATE
) -> Tuple[Decimal, Decimal]:
    """
    Calculates floating PnL and floating return rate.
    Returns: (floating_pnl, floating_return_rate)
    """
    remain_dec = Decimal(remaining_quantity)
    market_value = current_price * remain_dec
    holding_cost = cost_basis * remain_dec
    est_sell_fee = market_value * sell_fee_rate
    floating_pnl = market_value - holding_cost - est_sell_fee

    if holding_cost > Decimal("0"):
        return_rate = floating_pnl / holding_cost
    else:
        return_rate = Decimal("0.0000")

    return (
        floating_pnl.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP),
        return_rate.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    )


def compute_realized_pnl(
    close_price: Decimal,
    cost_basis: Decimal,
    close_quantity: int,
    close_fee: Decimal
) -> Decimal:
    """
    Realized PnL = (P_close * Q_close) - (P_cost * Q_close) - close_fee
    """
    q_dec = Decimal(close_quantity)
    gross_proceeds = close_price * q_dec
    cost_basis_total = cost_basis * q_dec
    net_pnl = gross_proceeds - cost_basis_total - close_fee
    return net_pnl.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

