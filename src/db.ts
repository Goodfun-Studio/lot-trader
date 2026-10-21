/**
 * Database connection and initialization using bun:sqlite.
 */
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync } from "fs";
import { AccountRepository, DEFAULT_ACCOUNT_ID } from "./accounts.ts";

export const DEFAULT_DB_PATH = join(homedir(), ".trade", "trade.db");

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
    account_id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    broker_code VARCHAR(32) DEFAULT 'CUSTOM',
    currency VARCHAR(10) DEFAULT 'CNY',
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
    account_id VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
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
    peak_price DECIMAL(10, 4),
    trailing_stop_active BOOLEAN DEFAULT 0,
    buy_reason TEXT,
    close_reason TEXT,
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


CREATE TABLE IF NOT EXISTS dividends (
    dividend_id VARCHAR(32) PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
    symbol VARCHAR(20) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    ex_date DATE NOT NULL,
    shares_count INT,
    dividend_per_share DECIMAL(10, 4),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(symbol) REFERENCES symbols(symbol)
);

CREATE TABLE IF NOT EXISTS trades (
    trade_id VARCHAR(32) PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
    lot_id VARCHAR(32) NOT NULL,
    action VARCHAR(20) NOT NULL,
    price DECIMAL(10, 4) NOT NULL,
    quantity INT NOT NULL,
    fee DECIMAL(10, 2) DEFAULT 0.00,
    realized_pnl DECIMAL(12, 2) DEFAULT 0.00,
    reason TEXT,
    executed_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SEED_SYMBOLS: Array<[string, string, string, string, number]> = [
  // Gold ETFs & Commodity (Native T+0)
  ["518880.SH", "黄金ETF", "ETF", "NATIVE_T0", 100],
  ["159934.SZ", "黄金ETF", "ETF", "NATIVE_T0", 100],
  ["518800.SH", "黄金基金", "ETF", "NATIVE_T0", 100],
  ["159937.SZ", "黄金ETF", "ETF", "NATIVE_T0", 100],
  ["511010.SH", "国债ETF", "ETF", "NATIVE_T0", 100],
  ["511260.SH", "十年国债ETF", "ETF", "NATIVE_T0", 100],
  // Cross-border ETFs (Native T+0)
  ["513130.SH", "恒生科技ETF", "ETF", "NATIVE_T0", 100],
  ["513180.SH", "恒生科技指数ETF", "ETF", "NATIVE_T0", 100],
  ["513050.SH", "中概互联ETF", "ETF", "NATIVE_T0", 100],
  ["513500.SH", "标普500ETF", "ETF", "NATIVE_T0", 100],
  ["513100.SH", "纳指ETF", "ETF", "NATIVE_T0", 100],
  ["159941.SZ", "纳指ETF", "ETF", "NATIVE_T0", 100],
  // Regular A-Share Stocks & Broad Market ETFs (Statutory T+1)
  ["600519.SH", "贵州茅台", "STOCK", "STATUTORY_T1", 100],
  ["000001.SZ", "平安银行", "STOCK", "STATUTORY_T1", 100],
  ["510300.SH", "沪深300ETF", "ETF", "STATUTORY_T1", 100],
  ["510500.SH", "中证500ETF", "ETF", "STATUTORY_T1", 100],
  ["588000.SH", "科创50ETF", "ETF", "STATUTORY_T1", 100],
  ["159915.SZ", "创业板ETF", "ETF", "STATUTORY_T1", 100],
];

export class AppDatabase {
  public dbPath: string;
  private _conn: Database | null = null;

  constructor(dbPath?: string) {
    if (!dbPath) {
      const envDb = process.env.LOT_TRADER_DB || process.env.TRADE_DB_PATH;
      this.dbPath = envDb ? envDb : DEFAULT_DB_PATH;
    } else {
      this.dbPath = dbPath;
    }

    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }

    this.initSchema();
  }

  public getConnection(): Database {
    if (!this._conn) {
      this._conn = new Database(this.dbPath);
      this._conn.run("PRAGMA journal_mode = WAL;");
      this._conn.run("PRAGMA busy_timeout = 5000;");
      this._conn.run("PRAGMA foreign_keys = ON;");
    }
    return this._conn;
  }

  public initSchema(): void {
    const conn = this.getConnection();
    conn.exec(SCHEMA_SQL);

    // Apply incremental migrations for existing databases
    try {
      conn.run("ALTER TABLE lots ADD COLUMN peak_price DECIMAL(10, 4);");
    } catch {
      // Column might already exist
    }
    try {
      conn.run("ALTER TABLE lots ADD COLUMN trailing_stop_active BOOLEAN DEFAULT 0;");
    } catch {
      // Column might already exist
    }

    try {
      conn.run("ALTER TABLE lots ADD COLUMN account_id VARCHAR(50) NOT NULL DEFAULT 'DEFAULT';");
    } catch {
      // Column might already exist
    }
    try {
      conn.run("ALTER TABLE trades ADD COLUMN account_id VARCHAR(50) NOT NULL DEFAULT 'DEFAULT';");
    } catch {
      // Column might already exist
    }

    // Decision rationale (Decision Thesis) columns: additive, nullable, never blocking.
    for (const ddl of [
      "ALTER TABLE lots ADD COLUMN buy_reason TEXT;",
      "ALTER TABLE lots ADD COLUMN close_reason TEXT;",
      "ALTER TABLE trades ADD COLUMN reason TEXT;",
    ]) {
      try {
        conn.run(ddl);
      } catch {
        // Column might already exist
      }
    }

    // Account registry: seed the generic fallback, then backfill every account id already
    // present in the ledger so legacy databases surface all accounts without manual setup.
    const accounts = new AccountRepository(conn);
    accounts.ensureAccount(DEFAULT_ACCOUNT_ID);
    accounts.registerAccountsFromLedger();

    const insertStmt = conn.prepare(`
      INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertTx = conn.transaction(() => {
      for (const [sym, name, aCls, setM, lotS] of SEED_SYMBOLS) {
        insertStmt.run(sym, name, aCls, setM, lotS);
      }
    });
    insertTx();
  }

  public close(): void {
    if (this._conn) {
      this._conn.close();
      this._conn = null;
    }
  }
}
