/**
 * Broker account registry.
 *
 * The ledger keys every lot / trade / dividend by `account_id`. This module owns the
 * canonical account primitives: id normalization, broker presets, self-healing
 * registration for quick-entry flows, and the read-side listing used by the CLI and
 * the dashboard generator.
 *
 * Design rules:
 *  - No broker/account literal is ever hardcoded outside this file (fallback = DEFAULT_ACCOUNT_ID / CUSTOM).
 *  - Registering an unknown account on write is non-blocking (quick entry must never stall),
 *    but registering a structurally invalid id is a hard error (deterministic guard).
 */
import { Database } from "bun:sqlite";

/** Generic fallback account used when no `--account` is supplied. Not a broker literal. */
export const DEFAULT_ACCOUNT_ID = "DEFAULT";
export const DEFAULT_ACCOUNT_NAME = "默认账户";

/** Mainstream broker presets. `CUSTOM` covers everything else (banks, prop accounts, ...). */
export const BROKER_CODES = [
  "CMB", // 招商证券
  "CITIC", // 中信证券
  "HTSC", // 华泰证券
  "EASTMONEY", // 东方财富
  "GUOTAI", // 国泰海通
  "YINHE", // 银河证券
  "GF", // 广发证券
  "PA", // 平安证券
  "FUTU", // 富途证券
  "IBKR", // 盈透证券
  "CUSTOM", // 其他/自定义
] as const;

export type BrokerCode = (typeof BROKER_CODES)[number];

export interface Account {
  account_id: string;
  name: string;
  broker_code: string;
  currency: string;
  is_active: boolean;
  created_at?: string | null;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Trim + fallback. Throws on structurally invalid ids so typos never leak into the ledger. */
export function normalizeAccountId(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_ACCOUNT_ID;
  if (!ACCOUNT_ID_RE.test(value)) {
    throw new Error(
      `非法账户标识: "${value}"。账户 ID 只允许 1-32 位字母/数字/下划线/点/连字符，且不能以符号开头。`,
    );
  }
  return value;
}

export function normalizeBrokerCode(raw?: string | null): string {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return "CUSTOM";
  if (!(BROKER_CODES as readonly string[]).includes(value)) {
    throw new Error(`非法券商代码: "${raw}"。可选值: ${BROKER_CODES.join(" | ")}`);
  }
  return value;
}

export function normalizeCurrency(raw?: string | null): string {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return "CNY";
  if (!CURRENCY_RE.test(value)) {
    throw new Error(`非法币种: "${raw}"。必须为 3 位 ISO 4217 代码，例如 CNY / HKD / USD。`);
  }
  return value;
}

function mapRow(row: any): Account {
  return {
    account_id: row.account_id,
    name: row.name,
    broker_code: row.broker_code || "CUSTOM",
    currency: row.currency || "CNY",
    is_active: Boolean(row.is_active),
    created_at: row.created_at ?? null,
  };
}

export interface AccountDefaults {
  name?: string;
  brokerCode?: string;
  currency?: string;
}

export class AccountRepository {
  private conn: Database;

  constructor(dbConn: Database) {
    this.conn = dbConn;
  }

  public getAccount(accountId: string): Account | null {
    const row = this.conn
      .query<any, [string]>("SELECT * FROM accounts WHERE account_id = ?")
      .get(normalizeAccountId(accountId));
    return row ? mapRow(row) : null;
  }

  public hasAccount(accountId: string): boolean {
    return this.getAccount(accountId) !== null;
  }

  /**
   * Self-healing registration: used by every write path that carries an account id.
   * Unknown accounts are inserted with CUSTOM defaults so quick entry is never interrupted;
   * already-registered accounts are returned untouched (alias/broker edits are preserved).
   */
  public ensureAccount(accountId?: string | null, defaults?: AccountDefaults): Account {
    const id = normalizeAccountId(accountId);
    const existing = this.conn
      .query<any, [string]>("SELECT * FROM accounts WHERE account_id = ?")
      .get(id);
    if (existing) return mapRow(existing);

    const name = (defaults?.name ?? "").trim() || (id === DEFAULT_ACCOUNT_ID ? DEFAULT_ACCOUNT_NAME : id);
    const brokerCode = normalizeBrokerCode(defaults?.brokerCode);
    const currency = normalizeCurrency(defaults?.currency);

    this.conn.run(
      `INSERT OR IGNORE INTO accounts (account_id, name, broker_code, currency, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [id, name, brokerCode, currency],
    );

    return this.getAccount(id)!;
  }

  /** Explicit `trade account add`: fails loudly when the account already exists. */
  public addAccount(
    accountId: string,
    options: { name: string; brokerCode?: string; currency?: string },
  ): Account {
    const id = normalizeAccountId(accountId);
    if (id === DEFAULT_ACCOUNT_ID && this.hasAccount(DEFAULT_ACCOUNT_ID)) {
      throw new Error(`账户 ${DEFAULT_ACCOUNT_ID} 为系统默认回退账户，已存在，无需重复登记。`);
    }
    const name = (options?.name ?? "").trim();
    if (!name) {
      throw new Error("账户别名不能为空 (--name)");
    }
    if (name.length > 50) {
      throw new Error(`账户别名过长 (${name.length} > 50)`);
    }
    if (this.hasAccount(id)) {
      throw new Error(`账户已存在: ${id}。如需修改请直接更新 accounts 表，避免重复登记。`);
    }

    const brokerCode = normalizeBrokerCode(options?.brokerCode);
    const currency = normalizeCurrency(options?.currency);

    this.conn.run(
      `INSERT INTO accounts (account_id, name, broker_code, currency, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [id, name, brokerCode, currency],
    );

    return this.getAccount(id)!;
  }

  public listAccounts(includeInactive: boolean = false): Account[] {
    const sql = includeInactive
      ? "SELECT * FROM accounts ORDER BY is_active DESC, account_id ASC"
      : "SELECT * FROM accounts WHERE is_active = 1 ORDER BY account_id ASC";
    const rows = this.conn.query<any, []>(sql).all();
    return rows.map(mapRow);
  }

  /** Ledger backfill: makes every account id already present in the books visible in `accounts`. */
  public registerAccountsFromLedger(): number {
    const ids = new Set<string>();
    for (const table of ["lots", "trades", "dividends"]) {
      const rows = this.conn
        .query<{ account_id: string | null }, []>(
          `SELECT DISTINCT account_id FROM ${table} WHERE account_id IS NOT NULL AND TRIM(account_id) <> ''`,
        )
        .all();
      for (const row of rows) {
        if (row.account_id) ids.add(row.account_id.trim());
      }
    }

    let registered = 0;
    for (const id of ids) {
      try {
        const existed = this.hasAccount(id);
        this.ensureAccount(id);
        if (!existed) registered += 1;
      } catch {
        // Legacy rows with structurally invalid ids must not brick the whole ledger.
      }
    }
    return registered;
  }
}
