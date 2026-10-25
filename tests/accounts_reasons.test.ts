import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";
import { AccountRepository, BROKER_CODES, DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../src/accounts.ts";
import { LotStatus, SignalType } from "../src/models.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

function createTestContext() {
  const db = new AppDatabase(":memory:");
  const mockQuotes = new QuoteProvider();
  const engine = new TraderEngine(db.getConnection(), mockQuotes);
  return { db, mockQuotes, engine };
}

function tradeRows(engine: TraderEngine, lotId: string): any[] {
  return engine.conn
    .query<any, [string]>("SELECT * FROM trades WHERE lot_id = ? ORDER BY executed_at ASC")
    .all(lotId);
}

async function runCli(args: string[], envDb: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, LOT_TRADER_DB: envDb },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * The dashboard generator shells out to `trade ... --json`, so pin that lookup to this repo's
 * CLI source instead of whatever binary happens to be on PATH.
 */
async function runCliWithTradeShim(
  args: string[],
  envDb: string,
  binDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LOT_TRADER_DB: envDb,
      TRADE_DB_PATH: envDb,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("Accounts registry: schema, model & self-healing registration", () => {
  it("creates the accounts table with the documented columns and seeds the generic fallback", () => {
    const { db, engine } = createTestContext();
    const conn = db.getConnection();

    const tables = conn
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("accounts");

    const cols = conn
      .query<{ name: string }, []>("PRAGMA table_info(accounts)")
      .all()
      .map((r) => r.name);
    for (const c of ["account_id", "name", "broker_code", "currency", "is_active", "created_at"]) {
      expect(cols).toContain(c);
    }

    const fallback = engine.getAccount(DEFAULT_ACCOUNT_ID);
    expect(fallback).not.toBeNull();
    expect(fallback?.broker_code).toBe("CUSTOM");
    expect(fallback?.currency).toBe("CNY");
    expect(fallback?.is_active).toBe(true);

    db.close();
  });

  it("registers accounts via addAccount and lists them with broker presets", () => {
    const { db, engine } = createTestContext();

    const cmb = engine.addAccount("CMB_BROKERAGE", { name: "招商稳健仓", brokerCode: "CMB" });
    expect(cmb.account_id).toBe("CMB_BROKERAGE");
    expect(cmb.name).toBe("招商稳健仓");
    expect(cmb.broker_code).toBe("CMB");
    expect(cmb.currency).toBe("CNY");
    expect(cmb.is_active).toBe(true);

    const ibkr = engine.addAccount("IBKR_MAIN", { name: "盈透美股仓", brokerCode: "IBKR", currency: "USD" });
    expect(ibkr.currency).toBe("USD");

    const listed = engine.listAccounts().map((a) => a.account_id);
    expect(listed).toContain("CMB_BROKERAGE");
    expect(listed).toContain("IBKR_MAIN");

    db.close();
  });

  it("NEGATIVE GUARD: rejects duplicate, empty-name, unknown-broker and malformed account ids", () => {
    const { db, engine } = createTestContext();

    engine.addAccount("HTSC_MAIN", { name: "华泰主仓", brokerCode: "HTSC" });

    expect(() => engine.addAccount("HTSC_MAIN", { name: "重复登记" })).toThrow("账户已存在");
    expect(() => engine.addAccount("EMPTY_NAME", { name: "   " })).toThrow("账户别名不能为空");
    expect(() => engine.addAccount("BAD_BROKER", { name: "野券商", brokerCode: "NOT_A_BROKER" })).toThrow(
      "非法券商代码",
    );
    expect(() => engine.addAccount("BAD$ID", { name: "非法ID" })).toThrow("非法账户标识");
    expect(() => engine.addAccount("BAD_CURRENCY", { name: "坏币种", currency: "RMBX" })).toThrow("非法币种");

    // Every preset must be accepted verbatim.
    for (const code of BROKER_CODES) {
      expect(engine.addAccount(`ACC_${code}`, { name: `别名_${code}`, brokerCode: code }).broker_code).toBe(code);
    }

    db.close();
  });

  it("SELF-HEALING: buying into an unregistered account auto-inserts a CUSTOM record without interrupting entry", () => {
    const { db, engine } = createTestContext();
    const accounts = new AccountRepository(db.getConnection());

    expect(accounts.hasAccount("HTSC")).toBe(false);

    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "HTSC");
    expect(lot.account_id).toBe("HTSC");

    const healed = engine.getAccount("HTSC");
    expect(healed).not.toBeNull();
    expect(healed?.name).toBe("HTSC");
    expect(healed?.broker_code).toBe("CUSTOM");
    expect(healed?.currency).toBe("CNY");

    // A pre-registered alias/broker must never be overwritten by the self-heal path.
    engine.addAccount("PA_MAIN", { name: "平安两融", brokerCode: "PA" });
    engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "PA_MAIN");
    const preserved = engine.getAccount("PA_MAIN");
    expect(preserved?.name).toBe("平安两融");
    expect(preserved?.broker_code).toBe("PA");

    // Blank account falls back to the generic default, never to a broker literal.
    const defaultLot = engine.buyLot("518880.SH", 6.0, 1000);
    expect(defaultLot.account_id).toBe(DEFAULT_ACCOUNT_ID);

    db.close();
  });

  it("backfills legacy ledger accounts that were written before the registry existed", () => {
    const { db } = createTestContext();
    const conn = db.getConnection();

    // Simulate a pre-registry ledger row with no accounts entry.
    conn.run(
      `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity,
        buy_fee, cost_basis_unit, status, pyramid_level, can_sell_now, is_day_trading, realized_pnl)
       VALUES ('LOT-LEGACY-001', 'GALAXY', '518880.SH', ?, 6.0, 100, 100, 0, 6.0, 'ACTIVE', 0, 1, 0, 0)`,
      [new Date().toISOString()],
    );

    const accounts = new AccountRepository(conn);
    expect(accounts.hasAccount("GALAXY")).toBe(false);
    const registered = accounts.registerAccountsFromLedger();
    expect(registered).toBeGreaterThanOrEqual(1);
    expect(accounts.hasAccount("GALAXY")).toBe(true);
    expect(accounts.getAccount("GALAXY")?.broker_code).toBe("CUSTOM");

    db.close();
  });

  it("normalizes account ids deterministically and keeps the fallback generic", () => {
    expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("   ")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("  HTSC_MAIN ")).toBe("HTSC_MAIN");
    expect(normalizeAccountId("A")).toBe("A");
    expect(() => normalizeAccountId("X".repeat(33))).toThrow("非法账户标识");
  });
});

describe("Cross-account core substitution: physical isolation negative guard", () => {
  it("NEGATIVE GUARD: account A with core cannot lend it to account B's same-day T+1 lot", async () => {
    const { db, engine, mockQuotes } = createTestContext();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const today = new Date();

    engine.addAccount("CMB_MAIN", { name: "招商稳健仓", brokerCode: "CMB" });
    engine.addAccount("CITIC_MAIN", { name: "中信趋势仓", brokerCode: "CITIC" });

    // Account A (CMB_MAIN): core 1000 shares settled yesterday.
    const coreLot = engine.buyLot("600519.SH", 1500.0, 1000, undefined, yesterday, undefined, true, "CMB_MAIN");
    // Account B (CITIC_MAIN): 500 shares bought today, zero core.
    const todayLot = engine.buyLot("600519.SH", 1500.0, 500, undefined, today, undefined, true, "CITIC_MAIN");

    expect(engine.arbitrator.computeAvailableCorePosition("600519.SH", today, "CMB_MAIN")).toBe(1000);
    expect(engine.arbitrator.computeAvailableCorePosition("600519.SH", today, "CITIC_MAIN")).toBe(0);

    mockQuotes.setMockPrice("600519.SH", 1660.0);

    // Scanner must lock account B instead of offering a cross-account substitute-close.
    const signals = await engine.scanSignals(undefined, today, "CITIC_MAIN");
    expect(signals.length).toBe(1);
    expect(signals[0].lot_id).toBe(todayLot.lot_id);
    expect(signals[0].account_id).toBe("CITIC_MAIN");
    expect(signals[0].signal_type).toBe(SignalType.T1_LOCKED_ALERT);
    const payload = JSON.parse(signals[0].payload_json);
    expect(payload.available_core_qty).toBe(0);
    expect(payload.can_sell_now).toBe(false);

    // Physical isolation: substitution close from B is rejected hard, regardless of A's core.
    expect(() => {
      engine.closeLot(todayLot.lot_id, 1660.0, 500, true, undefined, today);
    }).toThrow(/账户 CITIC_MAIN 标的 600519\.SH 总底仓 0 股，今日已代冲 0 股，剩余可用配额仅 0 股，申请代冲 500 股/);

    // A's own core is untouched by the rejected attempt.
    const coreLotAfter = engine.getLot(coreLot.lot_id)!;
    expect(coreLotAfter.remaining_quantity).toBe(1000);
    expect(coreLotAfter.status).toBe(LotStatus.ACTIVE);
    expect(engine.arbitrator.computeAvailableCorePosition("600519.SH", today, "CMB_MAIN")).toBe(1000);

    db.close();
  });

  it("positive control: substitution works inside the same account and stamps the substituted core lot", async () => {
    const { db, engine } = createTestContext();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const today = new Date();

    engine.addAccount("HTSC_MAIN", { name: "华泰对冲仓", brokerCode: "HTSC" });
    const coreLot = engine.buyLot("600519.SH", 1500.0, 1000, undefined, yesterday, undefined, true, "HTSC_MAIN");
    const todayLot = engine.buyLot("600519.SH", 1500.0, 500, undefined, today, undefined, true, "HTSC_MAIN");

    const [closed, trade] = engine.closeLot(todayLot.lot_id, 1660.0, 500, true, undefined, today);
    expect(closed.status).toBe(LotStatus.CLOSED);
    expect(closed.is_day_trading).toBe(true);
    expect(closed.substituted_core_lot_id).toBe(coreLot.lot_id);
    expect(trade.account_id).toBe("HTSC_MAIN");
    expect(trade.realized_pnl).toBeGreaterThan(0);

    db.close();
  });
});

describe("Decision thesis: buy / add / close reason persistence", () => {
  it("persists buy_reason on the lot and reason on the BUY trade", () => {
    const { db, engine } = createTestContext();

    const lot = engine.buyLot(
      "518880.SH",
      6.0,
      1000,
      undefined,
      undefined,
      undefined,
      true,
      "CMB_MAIN",
      "黄金突破周线压力位，央行增持逻辑成立",
    );

    expect(lot.buy_reason).toBe("黄金突破周线压力位，央行增持逻辑成立");

    const fetched = engine.getLot(lot.lot_id)!;
    expect(fetched.buy_reason).toBe("黄金突破周线压力位，央行增持逻辑成立");
    expect(fetched.close_reason).toBeNull();

    const trades = tradeRows(engine, lot.lot_id);
    expect(trades.length).toBe(1);
    expect(trades[0].action).toBe("BUY");
    expect(trades[0].reason).toBe("黄金突破周线压力位，央行增持逻辑成立");

    db.close();
  });

  it("BACKWARD COMPATIBILITY: omitting --reason stores NULL and never blocks the entry", () => {
    const { db, engine } = createTestContext();

    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN");
    expect(lot.buy_reason).toBeNull();

    const trades = tradeRows(engine, lot.lot_id);
    expect(trades[0].reason).toBeNull();

    // Blank / whitespace-only reasons degrade to NULL rather than an empty string.
    const blankLot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN", "   ");
    expect(blankLot.buy_reason).toBeNull();

    db.close();
  });

  it("persists add-lot (pyramid) reason and inherits the parent account", () => {
    const { db, engine } = createTestContext();
    const backfilled = new Date(Date.now() - 49 * 3600 * 1000);

    const parent = engine.buyLot("510300.SH", 3.5, 1000, undefined, undefined, undefined, true, "YUANHE_MAIN", "首批建仓");
    const child = engine.addLot(parent.lot_id, 3.3, {
      qty: 500,
      skipRiskCheck: true,
      buyTime: backfilled,
      reason: "回撤 -5.7% 触及第一档阶梯，按纪律摊薄均价",
    });

    expect(child.account_id).toBe("YUANHE_MAIN");
    expect(child.buy_reason).toBe("回撤 -5.7% 触及第一档阶梯，按纪律摊薄均价");

    const childTrades = tradeRows(engine, child.lot_id);
    expect(childTrades[0].reason).toBe("回撤 -5.7% 触及第一档阶梯，按纪律摊薄均价");

    db.close();
  });

  it("persists close_reason on the lot and reason on the SELL trade", () => {
    const { db, engine } = createTestContext();

    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN", "避险底仓");
    const [closed, trade] = engine.closeLot(
      lot.lot_id,
      7.0,
      undefined,
      false,
      undefined,
      undefined,
      "到达 +16% 移动止盈线，兑现利润",
    );

    expect(closed.status).toBe(LotStatus.CLOSED);
    expect(trade.reason).toBe("到达 +16% 移动止盈线，兑现利润");
    expect(closed.close_reason).toBe("到达 +16% 移动止盈线，兑现利润");
    // The buy thesis is never destroyed by the close review.
    expect(closed.buy_reason).toBe("避险底仓");

    const trades = tradeRows(engine, lot.lot_id);
    const sell = trades.find((t) => t.action.startsWith("SELL"));
    expect(sell.reason).toBe("到达 +16% 移动止盈线，兑现利润");

    db.close();
  });

  it("appends partial-close reviews instead of overwriting the earlier thesis", () => {
    const { db, engine } = createTestContext();

    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN", "建仓");
    engine.closeLot(lot.lot_id, 6.6, 400, false, undefined, undefined, "第一笔止盈 400 股");
    const [partial] = engine.closeLot(lot.lot_id, 6.8, 300, false, undefined, undefined, "第二笔止盈 300 股");

    expect(partial.remaining_quantity).toBe(300);
    expect(partial.close_reason).toBe("第一笔止盈 400 股\n第二笔止盈 300 股");

    // No-reason close keeps the accumulated review intact and does not throw.
    const [finalLot] = engine.closeLot(lot.lot_id, 6.9);
    expect(finalLot.status).toBe(LotStatus.CLOSED);
    expect(finalLot.close_reason).toBe("第一笔止盈 400 股\n第二笔止盈 300 股");

    db.close();
  });

  it("edits an existing lot thesis without touching accounting fields, and can clear it", () => {
    const { db, engine } = createTestContext();

    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN", "初始假设");
    const updated = engine.updateLotReason(lot.lot_id, { buyReason: "升级：避险+降息双逻辑" });

    expect(updated.buy_reason).toBe("升级：避险+降息双逻辑");
    expect(updated.buy_price).toBe(lot.buy_price);
    expect(updated.buy_quantity).toBe(lot.buy_quantity);
    expect(updated.cost_basis_unit).toBe(lot.cost_basis_unit);

    // Empty string clears the note back to NULL.
    const cleared = engine.updateLotReason(lot.lot_id, { buyReason: "" });
    expect(cleared.buy_reason).toBeNull();

    // Invalid targets must fail loudly, never silently no-op.
    expect(() => engine.updateLotReason("LOT-DOES-NOT-EXIST", { buyReason: "x" })).toThrow("批次不存在");
    expect(() => engine.updateLotReason(lot.lot_id, {})).toThrow("未提供任何需要更新的字段");

    db.close();
  });

  it("exposes both reasons through listLots JSON for downstream consumers", async () => {
    const { db, engine } = createTestContext();
    const lot = engine.buyLot("518880.SH", 6.0, 1000, undefined, undefined, undefined, true, "CMB_MAIN", "买入逻辑A");
    engine.closeLot(lot.lot_id, 6.5, 200, false, undefined, undefined, "部分止盈复盘B");

    const active = await engine.listLots("ACTIVE", undefined, "CMB_MAIN");
    expect(active.length).toBe(1);
    expect(active[0].buy_reason).toBe("买入逻辑A");
    expect(active[0].close_reason).toBe("部分止盈复盘B");

    db.close();
  });
});

describe("CLI primitives: trade account & --reason", () => {
  it("drives the full account + reason lifecycle end-to-end with JSON output", async () => {
    const testDb = join(tmpdir(), `acct_reason_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`);

    // 1. Register two accounts with broker presets.
    const addCmb = await runCli(
      ["account", "add", "CMB_MAIN", "--name", "招商稳健仓", "--broker", "CMB", "--json"],
      testDb,
    );
    expect(addCmb.exitCode).toBe(0);
    const cmbPayload = JSON.parse(addCmb.stdout);
    expect(cmbPayload.code).toBe(0);
    expect(cmbPayload.data.account_id).toBe("CMB_MAIN");
    expect(cmbPayload.data.broker_code).toBe("CMB");

    const addPa = await runCli(
      ["account", "add", "PA_MAIN", "--name", "平安两融", "--broker", "PA", "--currency", "CNY", "--json"],
      testDb,
    );
    expect(addPa.exitCode).toBe(0);

    // 2. account list (table + JSON).
    const listTable = await runCli(["account", "list"], testDb);
    expect(listTable.exitCode).toBe(0);
    expect(listTable.stdout).toContain("CMB_MAIN");
    expect(listTable.stdout).toContain("招商稳健仓");

    const listJson = await runCli(["account", "list", "--json"], testDb);
    expect(listJson.exitCode).toBe(0);
    const accountIds = JSON.parse(listJson.stdout).data.map((a: any) => a.account_id);
    expect(accountIds).toContain("CMB_MAIN");
    expect(accountIds).toContain("PA_MAIN");
    expect(accountIds).toContain(DEFAULT_ACCOUNT_ID);

    // 3. Duplicate registration must fail with a deterministic error.
    const dup = await runCli(["account", "add", "CMB_MAIN", "--name", "重复", "--json"], testDb);
    expect(dup.exitCode).toBe(1);
    expect(JSON.parse(dup.stdout).msg).toContain("账户已存在");

    // 4. Buy with a positional shorthand + --reason.
    const buy = await runCli(
      ["lot", "buy", "518880.SH", "6.10", "2000", "--account", "CMB_MAIN", "--reason", "避险底仓+央行增持", "--json"],
      testDb,
    );
    expect(buy.exitCode).toBe(0);
    const buyPayload = JSON.parse(buy.stdout);
    expect(buyPayload.data.account_id).toBe("CMB_MAIN");
    expect(buyPayload.data.buy_reason).toBe("避险底仓+央行增持");
    const lotId = buyPayload.data.lot_id;

    // 5. Edit the buy thesis.
    const edit = await runCli(["lot", "edit", lotId, "--reason", "升级：降息周期加码", "--json"], testDb);
    expect(edit.exitCode).toBe(0);
    const editPayload = JSON.parse(edit.stdout);
    expect(editPayload.data.buy_reason).toBe("升级：降息周期加码");
    expect(editPayload.data.close_reason).toBeNull();

    // 6. Buy without --reason stays fully optional.
    const noReasonBuy = await runCli(
      ["lot", "buy", "--symbol", "159934.SZ", "--price", "7.10", "--qty", "1000", "--skip-risk", "--json"],
      testDb,
    );
    expect(noReasonBuy.exitCode).toBe(0);
    expect(JSON.parse(noReasonBuy.stdout).data.buy_reason).toBeNull();

    // 7. Close with a positional shorthand + --reason.
    const close = await runCli(["lot", "close", lotId, "7.00", "--reason", "触及 +14.7% 止盈线", "--json"], testDb);
    expect(close.exitCode).toBe(0);
    const closePayload = JSON.parse(close.stdout);
    expect(closePayload.data.lot_status).toBe("CLOSED");
    expect(closePayload.data.reason).toBe("触及 +14.7% 止盈线");
    expect(closePayload.data.close_reason).toBe("触及 +14.7% 止盈线");
    expect(closePayload.data.buy_reason).toBe("升级：降息周期加码");

    // 8. An unregistered account passed to buy is auto-registered, not rejected.
    const autoRegister = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.20", "--qty", "1000", "--account", "GUOTAI_NEW", "--skip-risk", "--json"],
      testDb,
    );
    expect(autoRegister.exitCode).toBe(0);
    expect(JSON.parse(autoRegister.stdout).data.account_id).toBe("GUOTAI_NEW");

    const afterList = await runCli(["account", "list", "--json"], testDb);
    const healed = JSON.parse(afterList.stdout).data.find((a: any) => a.account_id === "GUOTAI_NEW");
    expect(healed).toBeDefined();
    expect(healed.broker_code).toBe("CUSTOM");
  }, 60_000);
});

describe("Dashboard: zero hardcoded broker accounts", () => {
  it("renders a switcher entry for any registered account and keeps the template generic", async () => {
    const dir = join(tmpdir(), `dash_accounts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "trade");
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`);
    chmodSync(shim, 0o755);

    const dbPath = join(dir, "dash.db");
    const outPath = join(dir, "dash.html");

    try {
      const add = await runCli(
        ["account", "add", "HTSC_MAIN", "--name", "华泰趋势仓", "--broker", "HTSC", "--json"],
        dbPath,
      );
      expect(add.exitCode).toBe(0);

      const buy = await runCliWithTradeShim(
        ["lot", "buy", "518880.SH", "6.10", "2000", "--account", "HTSC_MAIN", "--reason", "避险底仓", "--json"],
        dbPath,
        binDir,
      );
      expect(buy.exitCode).toBe(0);

      const dash = await runCliWithTradeShim(["dashboard", "--out", outPath, "--json"], dbPath, binDir);
      expect(dash.exitCode).toBe(0);

      const html = readFileSync(outPath, "utf-8");
      // Any account id gets its own switcher button - no fixed broker list required.
      expect(html).toContain("btn-acc-HTSC_MAIN");
      expect(html).toContain("华泰趋势仓");
      expect(html).toContain("HTSC_MAIN");
      // The old hardcoded account buttons must be gone.
      expect(html.includes("btn-acc-cmb")).toBe(false);
      expect(html.includes("btn-acc-pa")).toBe(false);
      // No template placeholder may survive interpolation.
      expect(/\{\{[A-Z_]+\}\}/.test(html)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
