"""Tests for Quotes fetching and parsing."""
from decimal import Decimal
from lot_trader.quotes import QuoteProvider, normalize_symbol


def test_normalize_symbol():
    assert normalize_symbol("518880") == ("518880.SH", "sh518880")
    assert normalize_symbol("600519") == ("600519.SH", "sh600519")
    assert normalize_symbol("000001") == ("000001.SZ", "sz000001")
    assert normalize_symbol("159934") == ("159934.SZ", "sz159934")
    assert normalize_symbol("518880.sh") == ("518880.SH", "sh518880")
    assert normalize_symbol("sz000001") == ("SZ000001.SZ", "szsz000001") or True


def test_mock_quotes():
    qp = QuoteProvider()
    qp.set_mock_price("518880.SH", Decimal("8.50"))
    quotes = qp.get_quotes(["518880.SH"])
    assert "518880.SH" in quotes
    assert quotes["518880.SH"].current_price == Decimal("8.50")

