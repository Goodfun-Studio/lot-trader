/**
 * CLI argument contract (L2 line).
 *
 * Four "silent protection loss" defects, each guarded by an explicit negative case AND an
 * anti-false-positive control that proves a fully legal invocation is NOT rejected:
 *
 *   D-03 (K-03) an undeclared flag was silently swallowed (`dividend add --ex-date ...` fell back
 *               to today and still exited 0) — now every subcommand rejects undeclared flags
 *               BEFORE the ledger is opened, with zero writes.
 *   D-05 (K-04) `stats --days abc` reached SQLite as `-NaN days`, matched nothing and silently
 *               emptied the report while exiting 0 — now non-numeric/negative/zero/decimal is a
 *               usage error and the report is untouched.
 *   D-07 (K-05) `scan --thresholds '{"take_profit_min":"high"}'` disarmed the take-profit alert
 *               yet exited 0 — now bad JSON, non-numeric values and unknown keys are rejected
 *               before the scanner can touch `signals`.
 *   D-02        `scan --help` advertised `{"add":-0.1,"take":0.1}`, keys the scanner never reads
 *               — the help text now names exactly the keys the implementation reads, and the
 *               example is executed verbatim as a regression assertion.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SIGNAL_THRESHOLD_KEYS } from "../src/cli.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const TABLES = ["accounts", "symbols", "lots", "signals", "dividends", "trades"] as const;
const SYMBOL = "518880.SH";

const tempDirs: string[] = [];

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cli-contract-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.LOT_TRADER_DB;
  delete env.TRADE_DB_PATH;
  return Object.assign(env, overrides);
}

async function runCli(
  args: string[],
  dbPath: string,
  options: { home?: string } = {},
): Promise<RunResult> {
  const home = options.home ?? join(tempRoot("home"), "fakehome");
  const proc = Bun.spawn([process.execPath, "run", cliPath, "--db", dbPath, ...args], {
    cwd: repoRoot,
    env: cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

/** Row count of all six ledger tables — the "did anything get written" fingerprint. */
function countRows(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    counts[table] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }
  db.close();
  return counts;
}

/** Content fingerprint of `signals`, so a suppressed scan is visible even when counts tie. */
function signalsFingerprint(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query<{ signal_id: string; signal_type: string; trigger_return_rate: string }, []>(
      "SELECT signal_id, signal_type, trigger_return_rate FROM signals ORDER BY signal_id",
    )
    .all();
  db.close();
  return JSON.stringify(rows);
}

async function seedLedger(dbPath: string): Promise<string> {
  const res = await runCli(
    ["lot", "buy", "--symbol", SYMBOL, "--price", "6.12", "--qty", "2000", "--json"],
    dbPath,
  );
  expect(res.exitCode, res.stderr).toBe(0);
  const lotId = JSON.parse(res.stdout).data.lot_id as string;
  expect(lotId.startsWith("LOT-")).toBe(true);
  return lotId;
}

/** One closed, profitable trade — the data a `stats` report must not silently lose. */
async function seedClosedTrade(dbPath: string): Promise<void> {
  const lotId = await seedLedger(dbPath);
  const res = await runCli(["lot", "close", "--lot-id", lotId, "--price", "7.05", "--json"], dbPath);
  expect(res.exitCode, res.stderr).toBe(0);
}

function statsData(result: RunResult): any {
  return JSON.parse(result.stdout).data;
}

/**
 * A single ACTIVE batch pinned at ≈ +16% against the LIVE quote the scanner is about to read,
 * so the take-profit line (default +10%, or a custom 0.05) is genuinely crossed. The cost basis
 * is derived from the observed quote, which keeps the assertion stable if the quote drifts a few
 * percent between setup and scan.
 */
async function seedTakeProfitBatch(dbPath: string): Promise<{ livePrice: number }> {
  const buy = await runCli(
    ["lot", "buy", "--symbol", SYMBOL, "--price", "7.07", "--qty", "2000", "--json"],
    dbPath,
  );
  expect(buy.exitCode, buy.stderr).toBe(0);

  const pos = await runCli(["position", "--json"], dbPath);
  expect(pos.exitCode, pos.stderr).toBe(0);
  const targets = JSON.parse(pos.stdout).data.targets;
  expect(targets.length).toBe(1);
  const livePrice = targets[0].current_price as number;
  expect(livePrice).toBeGreaterThan(0);

  // returnRate = (price / cost) * (1 - fee) - 1  =>  cost = price * (1 - fee) / 1.16
  const cost = (livePrice * (1 - 0.0002)) / 1.16;
  const db = new Database(dbPath);
  db.run("UPDATE lots SET cost_basis_unit = ? WHERE status = 'ACTIVE'", [cost.toFixed(6)]);
  db.close();

  return { livePrice };
}

function scanSignals(result: RunResult): Array<{ signal_type: string; trigger_return_rate: number }> {
  return JSON.parse(result.stdout).data.signals;
}

// ---------------------------------------------------------------------------
// D-03 (K-03) — undeclared flags must be a hard error with zero writes
// ---------------------------------------------------------------------------

describe("D-03 undeclared flags are rejected, with zero writes", () => {
  it("`dividend add --ex-date/--record-date` exits non-zero, names the offender and writes nothing", async () => {
    const root = tempRoot("d03-illegal");
    const dbPath = join(root, "ledger.db");
    await seedLedger(dbPath);

    const before = countRows(dbPath);
    const res = await runCli(
      [
        "dividend", "add",
        "--symbol", SYMBOL,
        "--amount", "1.00",
        "--ex-date", "2026-01-01",
        "--record-date", "2026-01-02",
        "--account", "ACC",
        "--json",
      ],
      dbPath,
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--ex-date");
    expect(countRows(dbPath)).toEqual(before);
    expect(before.dividends).toBe(0);
  });

  it("is a GLOBAL rule: `lot buy --bogus` is rejected and creates no lot", async () => {
    const root = tempRoot("d03-global");
    const dbPath = join(root, "ledger.db");
    await seedLedger(dbPath);
    const before = countRows(dbPath);

    const res = await runCli(
      ["lot", "buy", "--bogus", "--symbol", SYMBOL, "--price", "1", "--qty", "1", "--json"],
      dbPath,
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--bogus");
    expect(countRows(dbPath)).toEqual(before);
  });

  it("rejects undeclared flags on every subcommand (scan/stats/position/account/dividend/physics)", async () => {
    const root = tempRoot("d03-matrix");
    const dbPath = join(root, "ledger.db");
    await seedLedger(dbPath);

    const cases: Array<[string, string[]]> = [
      ["scan", ["scan", "--take-profit", "0.1"]],
      ["stats", ["stats", "--day", "7"]],
      ["position", ["position", "--sym", SYMBOL]],
      ["account list", ["account", "list", "--all=true", "--verbose"]],
      ["account add", ["account", "add", "X", "--name", "x", "--broker", "X", "--bogus", "1"]],
      ["dividend list", ["dividend", "list", "--ex-date", "2026-01-01"]],
      ["physics", ["physics", SYMBOL, "--verbose"]],
      ["lot list", ["lot", "list", "--include-closed"]],
      ["lot close", ["lot", "close", "LOT-1", "1.0", "--all"]],
      ["lot edit", ["lot", "edit", "LOT-1", "--reason", "x", "--force"]],
    ];

    for (const [label, args] of cases) {
      const res = await runCli(args, dbPath);
      expect(res.exitCode, `${label}: ${args.join(" ")} :: ${res.stderr}`).toBe(1);
      expect(res.stderr, `${label}: undefined flag named in message`).toMatch(/未声明的参数/);
    }
  });

  it("never creates the ledger file when only an undeclared flag is wrong", async () => {
    const root = tempRoot("d03-no-create");
    const dbPath = join(root, "never-created.db");

    const res = await runCli(
      ["dividend", "add", "--symbol", SYMBOL, "--amount", "1", "--ex-date", "2026-01-01"],
      dbPath,
    );

    expect(res.exitCode).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it("LEGAL anti-false-positive: the full DECLARED dividend add flag set still records the dividend", async () => {
    const root = tempRoot("d03-legal");
    const dbPath = join(root, "ledger.db");
    await seedLedger(dbPath);
    const before = countRows(dbPath);

    const res = await runCli(
      [
        "dividend", "add",
        "--symbol", SYMBOL,
        "--amount", "12.34",
        "--date", "2026-01-01",
        "--account", "ACC",
        "--shares", "2000",
        "--per-share", "0.00617",
        "--notes", "legal full set",
        "--json",
      ],
      dbPath,
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).code).toBe(0);
    const after = countRows(dbPath);
    expect(after.dividends).toBe(before.dividends + 1);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ ex_date: string; amount: number; shares_count: number; dividend_per_share: number; notes: string }, []>(
        "SELECT ex_date, amount, shares_count, dividend_per_share, notes FROM dividends",
      )
      .get()!;
    db.close();
    // The declared --date is honoured: this is exactly what --ex-date used to silently drop.
    expect(row.ex_date).toBe("2026-01-01");
    expect(row.amount).toBe(12.34);
    expect(row.shares_count).toBe(2000);
    expect(row.notes).toBe("legal full set");
  });

  it("LEGAL anti-false-positive: declared flags on every subcommand are still accepted (no over-rejection)", async () => {
    const root = tempRoot("d03-declared-ok");
    const dbPath = join(root, "ledger.db");
    const lotId = await seedLedger(dbPath);

    const cases: string[][] = [
      ["lot", "list", "--status", "ACTIVE", "--json"],
      ["lot", "buy", "--symbol", "159915.SZ", "--price", "2.00", "--qty", "100", "--skip-risk", "--json"],
      ["lot", "add", "--parent-lot-id", lotId, "--price", "5.80", "--amount", "10000", "--skip-risk", "--json"],
      ["lot", "edit", lotId, "--reason", "thesis", "--json"],
      ["account", "list", "--all", "--json"],
      ["account", "add", "ACC2", "--name", "two", "--broker", "CUSTOM", "--currency", "CNY", "--json"],
      ["position", "--symbol", SYMBOL, "--cap", "50000", "--json"],
      ["scan", "--account", "ACC2", "--json"],
      ["stats", "--days", "3650", "--symbol", SYMBOL, "--json"],
      ["physics", SYMBOL, "--json"],
      ["dividend", "list", "--symbol", SYMBOL, "--json"],
    ];

    for (const args of cases) {
      const res = await runCli(args, dbPath);
      expect(res.exitCode, `${args.join(" ")} :: ${res.stderr}`).toBe(0);
      expect(res.stderr, `${args.join(" ")}: no undefined-flag error`).not.toContain("未声明的参数");
    }
  });
});

// ---------------------------------------------------------------------------
// D-05 (K-04) — `stats --days` must refuse anything that is not a positive integer
// ---------------------------------------------------------------------------

describe("D-05 `stats --days` rejects non-positive-integer values without touching the report", () => {
  it("non-numeric / negative / zero / decimal / empty --days exit non-zero and change nothing", async () => {
    const root = tempRoot("d05-illegal");
    const dbPath = join(root, "ledger.db");
    await seedClosedTrade(dbPath);

    const baseline = await runCli(["stats", "--json"], dbPath);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    const baselineData = statsData(baseline);
    expect(baselineData.total_trades).toBe(1);
    const baselineRows = countRows(dbPath);

    for (const bad of ["abc", "-5", "0", "1.5", "7.0", "", "1e3", "NaN", "0x10"]) {
      const res = await runCli(["stats", "--days", bad, "--json"], dbPath);
      expect(res.exitCode, `--days ${JSON.stringify(bad)} should be a usage error`).toBe(1);
      expect(res.stderr).toMatch(/--days/);

      // The report must not have been silently emptied...
      const after = await runCli(["stats", "--json"], dbPath);
      expect(after.exitCode).toBe(0);
      expect(statsData(after), `--days ${JSON.stringify(bad)} altered the report`).toEqual(baselineData);
      // ...and the ledger itself must be byte-for-row identical.
      expect(countRows(dbPath), `--days ${JSON.stringify(bad)} wrote rows`).toEqual(baselineRows);
    }
  });

  it("never creates the ledger for an illegal --days value", async () => {
    const root = tempRoot("d05-no-create");
    const dbPath = join(root, "never-created.db");

    const res = await runCli(["stats", "--days", "abc"], dbPath);

    expect(res.exitCode).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it("LEGAL anti-false-positive: --days 7 and --days 3650 exit 0 with the same trade count as no filter", async () => {
    const root = tempRoot("d05-legal");
    const dbPath = join(root, "ledger.db");
    await seedClosedTrade(dbPath);

    const unfiltered = statsData(await runCli(["stats", "--json"], dbPath));
    expect(unfiltered.total_trades).toBe(1);

    for (const days of ["7", "3650"]) {
      const res = await runCli(["stats", "--days", days, "--json"], dbPath);
      expect(res.exitCode, `${res.stderr}`).toBe(0);
      const data = statsData(res);
      expect(data.total_trades, `--days ${days} must not be emptied`).toBe(unfiltered.total_trades);
      expect(data.winning_trades).toBe(unfiltered.winning_trades);
      expect(data.total_realized_pnl).toBe(unfiltered.total_realized_pnl);
    }
  });
});

// ---------------------------------------------------------------------------
// D-07 (K-05) — `scan --thresholds` must validate JSON, keys and value types
// ---------------------------------------------------------------------------

describe("D-07 `scan --thresholds` validates type and key names before scanning", () => {
  it("illegal JSON / non-numeric value / unknown key exit non-zero and leave `signals` untouched", async () => {
    const root = tempRoot("d07-illegal");
    const dbPath = join(root, "ledger.db");
    await seedTakeProfitBatch(dbPath);

    // Baseline: the +16% batch really does cross the take-profit line and is persisted.
    const legal = await runCli(["scan", "--json"], dbPath);
    expect(legal.exitCode, legal.stderr).toBe(0);
    expect(scanSignals(legal).map((s) => s.signal_type)).toContain("TAKE_PROFIT_ALERT");
    const baselineSignals = signalsFingerprint(dbPath);
    expect(JSON.parse(baselineSignals).length).toBe(1);

    const illegal: Array<[string, string]> = [
      ["non-numeric value (silently disarmed the alert before)", '{"take_profit_min":"high"}'],
      ["unknown key `take` (the old help example)", '{"take":0.1}'],
      ["unknown key `add` (the old help example)", '{"add":-0.1}'],
      ["malformed JSON", "{not json"],
      ["JSON array instead of object", "[]"],
      ["JSON scalar instead of object", "1"],
      ["null value", '{"dip_1":null}'],
      ["boolean value", '{"trailing_activate":true}'],
    ];

    for (const [label, raw] of illegal) {
      const res = await runCli(["scan", "--thresholds", raw, "--json"], dbPath);
      expect(res.exitCode, `${label} (${raw}) must be rejected`).toBe(1);
      expect(signalsFingerprint(dbPath), `${label} changed the signals table`).toBe(baselineSignals);
    }
  });

  it("never creates the ledger for an illegal --thresholds value", async () => {
    const root = tempRoot("d07-no-create");
    const dbPath = join(root, "never-created.db");

    const res = await runCli(["scan", "--thresholds", '{"take_profit_min":"high"}'], dbPath);

    expect(res.exitCode).toBe(1);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it("LEGAL anti-false-positive: {\"take_profit_min\":0.05} exits 0 and re-hits TAKE_PROFIT_ALERT", async () => {
    const root = tempRoot("d07-legal");
    const dbPath = join(root, "ledger.db");
    await seedTakeProfitBatch(dbPath);

    const res = await runCli(["scan", "--thresholds", '{"take_profit_min":0.05}', "--json"], dbPath);
    expect(res.exitCode, res.stderr).toBe(0);
    const signals = scanSignals(res);
    expect(signals.map((s) => s.signal_type)).toContain("TAKE_PROFIT_ALERT");
    const hit = signals.find((s) => s.signal_type === "TAKE_PROFIT_ALERT")!;
    expect(hit.trigger_return_rate).toBeGreaterThan(0.05);

    // The legal override is honoured end-to-end (the row is persisted, not just printed).
    const db = new Database(dbPath, { readonly: true });
    const persisted = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM signals WHERE signal_type = 'TAKE_PROFIT_ALERT'")
      .get()!.n;
    db.close();
    expect(persisted).toBe(1);
  });

  it("LEGAL anti-false-positive: every declared threshold key is accepted together", async () => {
    const root = tempRoot("d07-all-keys");
    const dbPath = join(root, "ledger.db");
    await seedTakeProfitBatch(dbPath);

    // Documented defaults for every key except take_profit_min, which is lowered so the +16%
    // batch is expected to fire. This proves no declared key is rejected as "unknown".
    const allKeys =
      '{"take_profit_min":0.05,"trailing_activate":0.15,"trailing_pullback":0.03,"dip_1":-0.10,"deep_value":-0.20}';
    const res = await runCli(["scan", "--thresholds", allKeys, "--json"], dbPath);
    expect(res.exitCode, `${allKeys} :: ${res.stderr}`).toBe(0);
    expect(scanSignals(res).map((s) => s.signal_type)).toContain("TAKE_PROFIT_ALERT");
  });
});

// ---------------------------------------------------------------------------
// D-02 — `scan --help` must document exactly the keys the scanner reads
// ---------------------------------------------------------------------------

describe("D-02 `scan --help` example keys match the implementation", () => {
  it("help names exactly the scanner's key set and no longer advertises add/take", async () => {
    const root = tempRoot("d02-keys");
    const dbPath = join(root, "ledger.db");
    const help = await runCli(["scan", "--help"], dbPath);
    expect(help.exitCode).toBe(0);

    for (const key of SIGNAL_THRESHOLD_KEYS) {
      expect(help.stdout, `help must document ${key}`).toContain(key);
    }
    expect(help.stdout).not.toContain('"add"');
    expect(help.stdout).not.toContain('"take"');

    // Cross-check the help text against the scanner source so the doc cannot drift again.
    const scannerSrc = readFileSync(join(repoRoot, "src", "scanner.ts"), "utf8");
    const readKeys = [...scannerSrc.matchAll(/customThresholds\.([a-z_0-9]+)/g)].map((m) => m[1]);
    expect([...new Set(readKeys)].sort()).toEqual([...SIGNAL_THRESHOLD_KEYS].sort());
  });

  it("copying the --help example verbatim exits 0 and produces at least one signal", async () => {
    const root = tempRoot("d02-example");
    const dbPath = join(root, "ledger.db");
    await seedTakeProfitBatch(dbPath);

    const help = await runCli(["scan", "--help"], dbPath);
    const match = help.stdout.match(/'(\{[^']*\})'/);
    expect(match, "scan --help must show a runnable JSON example").not.toBeNull();
    const example = match![1];
    expect(example).toContain("take_profit_min");

    const res = await runCli(["scan", "--thresholds", example, "--json"], dbPath);
    expect(res.exitCode, `${example} :: ${res.stderr}`).toBe(0);
    expect(scanSignals(res).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Plain calls keep working (the broadest anti-false-positive control)
// ---------------------------------------------------------------------------

describe("anti-false-positive: plain invocations without optional flags still exit 0", () => {
  it("lot buy / lot list / position / stats / scan / dividend list all exit 0", async () => {
    const root = tempRoot("plain");
    const dbPath = join(root, "ledger.db");
    await seedLedger(dbPath);

    const plain: string[][] = [
      ["lot", "list"],
      ["position"],
      ["stats"],
      ["scan"],
      ["dividend", "list"],
      ["account", "list"],
    ];

    for (const args of plain) {
      const res = await runCli(args, dbPath);
      expect(res.exitCode, `${args.join(" ")} :: ${res.stderr}`).toBe(0);
    }
  });
});
