"""Database connection and initialization."""
import os
import sqlite3
from pathlib import Path
from typing import Optional

DEFAULT_DB_PATH = Path.home() / ".trade" / "trade.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS symbols (
    symbol VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    asset_class VARCHAR(20) NOT NULL,
    settlement_mode VARCHAR(20) NOT NULL,
    lot_size INT DEFAULT 100,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lots (
    lot_id VARCHAR(32) PRIMARY KEY,
    parent_lot_id VARCHAR(32),
    symbol VARCHAR(20) NOT NULL,
    buy_time DATETIME NOT NULL,
    buy_price DECIMAL(10, 4) NOT NULL,
    buy_quantity INT NOT NULL,
    remaining_quantity INT NOT NULL,
    buy_fee DECIMAL(10, 2) DEFAULT 0.00,
    cost_basis_unit DECIMAL(10, 4) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    pyramid_level INT DEFAULT 0,
    can_sell_now BOOLEAN DEFAULT 0,
    is_day_trading BOOLEAN DEFAULT 0,
    substituted_core_lot_id VARCHAR(32),
    max_high_price DECIMAL(10, 4),
    max_low_price DECIMAL(10, 4),
    close_time DATETIME,
    close_avg_price DECIMAL(10, 4),
    realized_pnl DECIMAL(12, 2) DEFAULT 0.00,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(symbol) REFERENCES symbols(symbol)
);

CREATE TABLE IF NOT EXISTS signals (
    signal_id VARCHAR(32) PRIMARY KEY,
    lot_id VARCHAR(32) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    signal_type VARCHAR(30) NOT NULL,
    trigger_return_rate DECIMAL(6, 4) NOT NULL,
    trigger_price DECIMAL(10, 4) NOT NULL,
    suggested_action VARCHAR(50) NOT NULL,
    payload_json TEXT,
    is_handled BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(lot_id) REFERENCES lots(lot_id)
);

CREATE TABLE IF NOT EXISTS trades (
    trade_id VARCHAR(32) PRIMARY KEY,
    lot_id VARCHAR(32) NOT NULL,
    action VARCHAR(20) NOT NULL,
    price DECIMAL(10, 4) NOT NULL,
    quantity INT NOT NULL,
    fee DECIMAL(10, 2) DEFAULT 0.00,
    realized_pnl DECIMAL(12, 2) DEFAULT 0.00,
    executed_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

# Default symbols seed
SEED_SYMBOLS = [
    # Gold ETFs & Commodity (Native T+0)
    ("518880.SH", "黄金ETF", "ETF", "NATIVE_T0", 100),
    ("159934.SZ", "黄金ETF", "ETF", "NATIVE_T0", 100),
    ("518800.SH", "黄金基金", "ETF", "NATIVE_T0", 100),
    ("159937.SZ", "黄金ETF", "ETF", "NATIVE_T0", 100),
    ("511010.SH", "国债ETF", "ETF", "NATIVE_T0", 100),
    ("511260.SH", "十年国债ETF", "ETF", "NATIVE_T0", 100),
    # Cross-border ETFs (Native T+0)
    ("513130.SH", "恒生科技ETF", "ETF", "NATIVE_T0", 100),
    ("513180.SH", "恒生科技指数ETF", "ETF", "NATIVE_T0", 100),
    ("513050.SH", "中概互联ETF", "ETF", "NATIVE_T0", 100),
    ("513500.SH", "标普500ETF", "ETF", "NATIVE_T0", 100),
    ("513100.SH", "纳指ETF", "ETF", "NATIVE_T0", 100),
    ("159941.SZ", "纳指ETF", "ETF", "NATIVE_T0", 100),
    # Regular A-Share Stocks & Broad Market ETFs (Statutory T+1)
    ("600519.SH", "贵州茅台", "STOCK", "STATUTORY_T1", 100),
    ("000001.SZ", "平安银行", "STOCK", "STATUTORY_T1", 100),
    ("510300.SH", "沪深300ETF", "ETF", "STATUTORY_T1", 100),
    ("510500.SH", "中证500ETF", "ETF", "STATUTORY_T1", 100),
    ("588000.SH", "科创50ETF", "ETF", "STATUTORY_T1", 100),
    ("159915.SZ", "创业板ETF", "ETF", "STATUTORY_T1", 100),
]


class Database:
    def __init__(self, db_path: Optional[str or Path] = None):
        if db_path is None:
            env_db = os.environ.get("LOT_TRADER_DB")
            if env_db:
                self.db_path = Path(env_db)
            else:
                self.db_path = DEFAULT_DB_PATH
        else:
            self.db_path = Path(db_path)

        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._conn: Optional[sqlite3.Connection] = None
        self.init_schema()

    def get_connection(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(
                str(self.db_path),
                detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES,
                check_same_thread=False
            )
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA foreign_keys = ON;")
        return self._conn

    def init_schema(self) -> None:
        conn = self.get_connection()
        with conn:
            conn.executescript(SCHEMA_SQL)
            # Insert seed symbols if not exists
            for sym, name, a_cls, set_m, lot_s in SEED_SYMBOLS:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (sym, name, a_cls, set_m, lot_s),
                )

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

