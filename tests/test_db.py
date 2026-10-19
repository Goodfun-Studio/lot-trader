"""Tests for Database and Schema."""
import sqlite3
import pytest
from lot_trader.db import Database


def test_database_init(tmp_path):
    db_file = tmp_path / "test_trade.db"
    db = Database(db_path=db_file)
    conn = db.get_connection()

    # Check tables exist
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    assert "symbols" in tables
    assert "lots" in tables
    assert "signals" in tables
    assert "trades" in tables

    # Check seed symbols
    gold_row = conn.execute("SELECT * FROM symbols WHERE symbol = '518880.SH'").fetchone()
    assert gold_row is not None
    assert gold_row["settlement_mode"] == "NATIVE_T0"

    stock_row = conn.execute("SELECT * FROM symbols WHERE symbol = '600519.SH'").fetchone()
    assert stock_row is not None
    assert stock_row["settlement_mode"] == "STATUTORY_T1"

    db.close()

