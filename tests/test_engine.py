"""Tests for Core Engine Calculations and Signal Rules."""
from datetime import datetime, date, timedelta
from decimal import Decimal
import pytest

from lot_trader.db import Database
from lot_trader.engine import TraderEngine
from lot_trader.engine.calc import compute_cost_basis, compute_floating_pnl, compute_realized_pnl
from lot_trader.models import LotStatus, SignalType, TradeAction
from lot_trader.quotes import Quote, QuoteProvider


@pytest.fixture
def test_engine(tmp_path):
    db_file = tmp_path / "test_engine.db"
    db = Database(db_path=db_file)
    mock_quotes = QuoteProvider()
    engine = TraderEngine(db.get_connection(), quote_provider=mock_quotes)
    return engine, mock_quotes


def test_cost_basis_and_pnl_math():
    # Buy 1000 shares at 10.00 with 2.00 fee -> cost basis = (10000 + 2) / 1000 = 10.0020
    cost_basis = compute_cost_basis(Decimal("10.00"), 1000, Decimal("2.00"))
    assert cost_basis == Decimal("10.0020")

    # Current price 11.50, ETF sell fee 0.02% -> est sell fee = 11.50 * 1000 * 0.0002 = 2.30
    # Market value = 11500, cost = 10002, fee = 2.30 -> PnL = 1495.70
    pnl, ret_rate = compute_floating_pnl(Decimal("11.50"), cost_basis, 1000, Decimal("0.0002"))
    assert pnl == Decimal("1495.70")
    # Return rate = 1495.70 / 10002 = 0.14954... -> 0.1495 (14.95%)
    assert ret_rate == Decimal("0.1495")


def test_lot_buy_validation(test_engine):
    engine, _ = test_engine

    # Qty not multiple of 100 must fail
    with pytest.raises(ValueError, match="100 的整数倍"):
        engine.buy_lot("518880.SH", Decimal("6.00"), 150)

    # Negative qty must fail
    with pytest.raises(ValueError):
        engine.buy_lot("518880.SH", Decimal("6.00"), -100)

    # Valid buy
    lot = engine.buy_lot("518880.SH", Decimal("6.120"), 2000)
    assert lot.lot_id.startswith("LOT-")
    assert lot.symbol == "518880.SH"
    assert lot.remaining_quantity == 2000
    assert lot.status == LotStatus.ACTIVE
    assert lot.can_sell_now is True  # Native T+0 is immediately sellable


def test_scene_a_deep_value_alert_strict_active(test_engine):
    """
    测试场景 a): 单笔批次跌幅达 -22%，系统保持 ACTIVE 并正确出具 DEEP_VALUE_ALERT 深跌等待加仓信号；
    铁律：严禁冻结，绝不锁死！
    """
    engine, mock_quotes = test_engine

    # Buy at 10.00
    lot = engine.buy_lot("588000.SH", Decimal("10.00"), 1000)
    assert lot.status == LotStatus.ACTIVE

    # Price drops to 7.70 (-23% return)
    mock_quotes.set_mock_price("588000.SH", Decimal("7.70"))

    signals = engine.scan_signals()
    assert len(signals) == 1
    sig = signals[0]
    assert sig.signal_type == SignalType.DEEP_VALUE_ALERT
    assert sig.suggested_action == "DEEP_VALUE_ACCUMULATE_ON_STABILIZE"
    assert sig.trigger_return_rate < Decimal("-0.20")

    # Verify lot in database is STILL ACTIVE (Never frozen)
    reloaded_lot = engine.get_lot(lot.lot_id)
    assert reloaded_lot.status == LotStatus.ACTIVE


def test_scene_b_gold_etf_native_t0_profit(test_engine):
    """
    测试场景 b): 黄金 ETF 买入当日浮盈 +10%，即刻生成平仓信号并闭环；
    """
    engine, mock_quotes = test_engine

    # Buy Gold ETF today at 6.00
    lot = engine.buy_lot("518880.SH", Decimal("6.00"), 2000)
    assert lot.can_sell_now is True

    # Price jumps to 6.70 (+11.6% return)
    mock_quotes.set_mock_price("518880.SH", Decimal("6.70"))

    signals = engine.scan_signals()
    assert len(signals) == 1
    sig = signals[0]
    assert sig.signal_type == SignalType.TAKE_PROFIT_ALERT
    assert sig.suggested_action == "CLOSE_PROFIT"

    # Close the lot
    updated_lot, trade = engine.close_lot(lot.lot_id, Decimal("6.70"))
    assert updated_lot.status == LotStatus.CLOSED
    assert updated_lot.remaining_quantity == 0
    assert updated_lot.is_day_trading is True  # Native T+0 closed today
    assert trade.action == TradeAction.SELL_DAY_TRADE
    assert trade.realized_pnl > Decimal("1300.00")


def test_scene_c_stock_core_substitution_day_trade(test_engine):
    """
    测试场景 c): 股票有可用底仓情况下，盘中买入新 Lot 浮盈 +10%，成功触发底仓代冲日内止盈；
    """
    engine, mock_quotes = test_engine

    # Yesterday bought 500 shares of 600519
    yesterday = datetime.now() - timedelta(days=2)
    core_lot = engine.buy_lot("600519.SH", Decimal("1500.00"), 500, buy_time=yesterday)

    # Today bought another 500 shares at 1500.00
    today_lot = engine.buy_lot("600519.SH", Decimal("1500.00"), 500)

    # Stock surges to 1670.00 (+11.3%)
    mock_quotes.set_mock_price("600519.SH", Decimal("1670.00"))

    # Scan signals
    signals = engine.scan_signals()
    # Find signal for today_lot
    today_sig = next((s for s in signals if s.lot_id == today_lot.lot_id), None)
    assert today_sig is not None
    assert today_sig.signal_type == SignalType.DAY_TRADE_PROFIT_ALERT
    assert today_sig.suggested_action == "SUBSTITUTE_CORE_CLOSE"

    # Close today's lot using substitute core
    updated_lot, trade = engine.close_lot(
        lot_id=today_lot.lot_id,
        close_price=Decimal("1670.00"),
        substitute_core=True
    )
    assert updated_lot.status == LotStatus.CLOSED
    assert updated_lot.is_day_trading is True
    assert updated_lot.substituted_core_lot_id == core_lot.lot_id
    assert trade.action == TradeAction.SELL_DAY_TRADE
    assert trade.realized_pnl > Decimal("80000.00")


def test_scene_d_stock_no_core_position_t1_lock(test_engine):
    """
    测试场景 d): 股票首日建仓（无底仓）盘中浮盈 +10%，正确阻断当日卖出指令，提示 T+1 锁定待次日执行；
    """
    engine, mock_quotes = test_engine

    # Today bought first position in 000001 (no prior core position)
    lot = engine.buy_lot("000001.SZ", Decimal("10.00"), 1000)

    # Price jumps to 11.20 (+12%)
    mock_quotes.set_mock_price("000001.SZ", Decimal("11.20"))

    signals = engine.scan_signals()
    assert len(signals) == 1
    sig = signals[0]
    # Must report T1_LOCKED_ALERT
    assert sig.signal_type == SignalType.T1_LOCKED_ALERT
    assert sig.suggested_action == "HOLD_UNTIL_NEXT_TRADING_DAY"

    # Direct close attempt without substitute_core must be blocked
    with pytest.raises(ValueError, match="法定 T\+1，当日买入份额无法直接平仓"):
        engine.close_lot(lot.lot_id, Decimal("11.20"), substitute_core=False)

    # Attempting substitute-core when core position is 0 must fail (No Naked Short Selling!)
    with pytest.raises(ValueError, match="底仓可用配额不足，严防裸卖空"):
        engine.close_lot(lot.lot_id, Decimal("11.20"), substitute_core=True)


def test_partial_close(test_engine):
    engine, _ = test_engine
    lot = engine.buy_lot("518880.SH", Decimal("6.00"), 2000)

    # Partial close 1000 shares
    updated_lot, trade = engine.close_lot(lot.lot_id, Decimal("6.60"), close_quantity=1000)
    assert updated_lot.remaining_quantity == 1000
    assert updated_lot.status == LotStatus.ACTIVE
    assert trade.quantity == 1000

    # Close remaining 1000 shares
    final_lot, final_trade = engine.close_lot(lot.lot_id, Decimal("6.80"), close_quantity=1000)
    assert final_lot.remaining_quantity == 0
    assert final_lot.status == LotStatus.CLOSED


def test_stats_computation(test_engine):
    engine, _ = test_engine
    lot1 = engine.buy_lot("518880.SH", Decimal("6.00"), 1000)
    engine.close_lot(lot1.lot_id, Decimal("6.60"))  # Win

    lot2 = engine.buy_lot("518880.SH", Decimal("6.00"), 1000)
    engine.close_lot(lot2.lot_id, Decimal("5.50"))  # Loss

    stats = engine.compute_stats()
    assert stats["total_trades"] == 2
    assert stats["winning_trades"] == 1
    assert stats["losing_trades"] == 1
    assert stats["win_rate"] == 0.5
    assert stats["total_realized_pnl"] > 0

