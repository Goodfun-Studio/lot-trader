/**
 * L1 · engine-layer input-guard hardening (D-09 / D-01 / D-06).
 *
 * Scope of this file: the three defects assigned to the L1 line, each with BOTH sides covered —
 * the violation side (must be refused, zero writes) and the legal side (must NOT be mis-killed).
 * The legal side is the acceptance core: a guard that also blocks `2.0001` buys or a legitimate
 * -49h backfilled pyramid add is a worse bug than the one it fixes.
 *
 *   D-09 (P0) price must be a finite positive number on every write path (buy / add / close).
 *             `parseFloat("abc")` -> NaN, and NaN / Infinity / 0 / negative used to be inserted
 *             verbatim (`buy_price NULL`, `total_cost null`, negative fees).
 *   D-01 (P0) the 48h anti-shake cooldown must be measured against the REAL clock, and `--time`
 *             must never be in the future (it used to be trusted as "now", so forging a future
 *             fill time walked straight through the cooldown on the same lineage).
 *   D-06 (P3) the 30% hard-cap message must print a ratio distinguishable from the 30.00%
 *             threshold it claims to exceed (2 decimals rounded back to "30.00%").
 *
 * CLI cases run with the ledger fully sandboxed: HOME is redirected to a throwaway dir, the
 * default-ledger env vars are stripped, and every call passes an explicit --db inside the temp
 * dir. `~/.trade/trade.db` is never opened.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh sandbox directory (used both as workdir and as a fake $HOME). */
function sandbox(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `l1-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn the real CLI with the default ledger env vars stripped and HOME redirected, so the only
 * ledger in play is the explicit `--db` passed in `args`.
 */
async function runCli(args: string[], dbPath: string, fakeHome: string): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "LOT_TRADER_DB" || key === "TRADE_DB_PATH") continue;
    env[key] = value;
  }
  env.HOME = fakeHome;

  const proc = Bun.spawn([process.execPath, "run", cliPath, "--db", dbPath, ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const TABLES = ["accounts", "lots", "signals", "trades", "dividends", "symbols"] as const;

/** Read the six user-data table row counts straight from the ledger file. */
function tableCounts(dbPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = 0;
  if (!existsSync(dbPath)) return counts;

  const conn = new Database(dbPath);
  try {
    for (const t of TABLES) {
      const row = conn.query(`SELECT count(*) AS c FROM ${t}`).get() as { c: number } | null;
      counts[t] = row ? row.c : 0;
    }
  } finally {
    conn.close();
  }
  return counts;
}

function createTestEngine(portfolioBudget?: number): { engine: TraderEngine; db: AppDatabase } {
  const db = new AppDatabase(":memory:");
  const engine = new TraderEngine(db.getConnection(), new QuoteProvider(), portfolioBudget);
  return { engine, db };
}

function engineCounts(engine: TraderEngine): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const row = engine.conn.query(`SELECT count(*) AS c FROM ${t}`).get() as { c: number };
    counts[t] = row.c;
  }
  return counts;
}

const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// D-09 · price must be a finite positive number
// ---------------------------------------------------------------------------

describe("L1 D-09: ledger prices must be finite positive numbers", () => {
  const ILLEGAL_PRICES: Array<[string, number]> = [
    ["NaN (parseFloat('abc'))", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative", -2.5],
  ];

  it("engine: lot buy rejects every non-finite / non-positive price with zero ledger writes", () => {
    for (const [, price] of ILLEGAL_PRICES) {
      const { engine, db } = createTestEngine();
      try {
        const before = engineCounts(engine);
        expect(() => engine.buyLot("518880.SH", price, 100, 0, undefined, undefined, true)).toThrow(/非法成交价/);
        expect(engineCounts(engine)).toEqual(before);
      } finally {
        db.close();
      }
    }
  });

  it("engine: lot add rejects every illegal price BEFORE deriving quantity from amount/price", () => {
    const { engine, db } = createTestEngine();
    try {
      const parent = engine.buyLot("518880.SH", 6.0, 1000, 0, undefined, undefined, true);
      for (const [, price] of ILLEGAL_PRICES) {
        const before = engineCounts(engine);
        // `amount` is supplied so the buggy path would have computed Infinity/NaN shares first.
        expect(() => engine.addLot(parent.lot_id, price, { amount: 10000, skipRiskCheck: true })).toThrow(
          /非法成交价/,
        );
        expect(engineCounts(engine)).toEqual(before);
      }
    } finally {
      db.close();
    }
  });

  it("engine: lot close rejects every illegal price with zero ledger writes", () => {
    const { engine, db } = createTestEngine();
    try {
      const lot = engine.buyLot("518880.SH", 6.0, 1000, 0, undefined, undefined, true);
      for (const [, price] of ILLEGAL_PRICES) {
        const before = engineCounts(engine);
        expect(() => engine.closeLot(lot.lot_id, price, 500, false, 0)).toThrow(/非法成交价/);
        expect(engineCounts(engine)).toEqual(before);
      }
      // The batch is untouched: still ACTIVE with its full remaining quantity.
      const reloaded = engine.getLot(lot.lot_id)!;
      expect(reloaded.remaining_quantity).toBe(1000);
      expect(reloaded.close_avg_price).toBeNull();
    } finally {
      db.close();
    }
  });

  it("CLI NEGATIVE CONTROL: abc / 0 / -2.5 buys all exit non-zero and write nothing", async () => {
    const home = sandbox("d09-neg-home");
    const dbPath = join(sandbox("d09-neg-db"), "buy.db");

    // First a legal call so the schema exists and the "before" snapshot is meaningful.
    const legal = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.00", "--qty", "100", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(legal.exitCode).toBe(0);
    const before = tableCounts(dbPath);

    for (const badPrice of ["abc", "0", "-2.5"]) {
      const res = await runCli(
        ["lot", "buy", "--symbol", "518880.SH", "--price", badPrice, "--qty", "100", "--account", "ACCA", "--reason", "d09", "--fee", "0", "--skip-risk", "--json"],
        dbPath,
        home,
      );
      expect(res.exitCode).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toContain("非法成交价");
      // Six-table snapshot must be byte-identical in row terms after every refusal.
      expect(tableCounts(dbPath)).toEqual(before);
    }
  });

  it("CLI NEGATIVE CONTROL: illegal prices on lot add and lot close are refused with zero writes", async () => {
    const home = sandbox("d09-add-close-home");
    const dbPath = join(sandbox("d09-add-close-db"), "ops.db");

    const parent = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.00", "--qty", "1000", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(parent.exitCode).toBe(0);
    const parentLotId = JSON.parse(parent.stdout).data.lot_id as string;

    const beforeAdd = tableCounts(dbPath);
    const badAdd = await runCli(
      ["lot", "add", "--parent-lot-id", parentLotId, "--price", "abc", "--amount", "10000", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(badAdd.exitCode).not.toBe(0);
    expect(`${badAdd.stdout}${badAdd.stderr}`).toContain("非法成交价");
    expect(tableCounts(dbPath)).toEqual(beforeAdd);

    const beforeClose = tableCounts(dbPath);
    const badClose = await runCli(
      ["lot", "close", "--lot-id", parentLotId, "--price", "-2.5", "--qty", "500", "--fee", "0", "--json"],
      dbPath,
      home,
    );
    expect(badClose.exitCode).not.toBe(0);
    expect(`${badClose.stdout}${badClose.stderr}`).toContain("非法成交价");
    expect(tableCounts(dbPath)).toEqual(beforeClose);
  });

  it("CLI POSITIVE CONTROL: legal prices 2.0001 and 8.199 are never mis-killed (lots+1, trades+1, cost_basis_unit == price)", async () => {
    const home = sandbox("d09-pos-home");

    for (const price of ["2.0001", "8.199"]) {
      const dbPath = join(sandbox(`d09-pos-${price}`), "legal.db");
      const before = tableCounts(dbPath);

      const res = await runCli(
        ["lot", "buy", "--symbol", "518880.SH", "--price", price, "--qty", "100", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
        dbPath,
        home,
      );
      expect(res.exitCode).toBe(0);
      const payload = JSON.parse(res.stdout);
      expect(payload.code).toBe(0);
      expect(payload.data.buy_price).toBe(Number(price));
      // `--fee 0` => cost_basis_unit is exactly the fill price, never NaN/null.
      expect(payload.data.cost_basis_unit).toBe(Number(price));

      const after = tableCounts(dbPath);
      expect(after.lots - before.lots).toBe(1);
      expect(after.trades - before.trades).toBe(1);
    }
  });

  it("engine POSITIVE CONTROL: 2.0001 buy keeps cost_basis_unit === buy_price", () => {
    const { engine, db } = createTestEngine();
    try {
      const lot = engine.buyLot("518880.SH", 2.0001, 100, 0, undefined, undefined, true);
      expect(lot.buy_price).toBe(2.0001);
      expect(lot.cost_basis_unit).toBe(2.0001);
      const reloaded = engine.getLot(lot.lot_id)!;
      expect(reloaded.buy_price).toBe(2.0001);
      expect(reloaded.cost_basis_unit).toBe(2.0001);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D-01 · cooldown uses the real clock; fill times may not be in the future
// ---------------------------------------------------------------------------

describe("L1 D-01: anti-shake cooldown runs on the real clock and refuses future fill times", () => {
  it("engine: future fill time is refused on buy, add and close with zero writes", () => {
    const { engine, db } = createTestEngine();
    try {
      const future = new Date(Date.now() + 60 * 60 * 1000);

      const beforeBuy = engineCounts(engine);
      expect(() => engine.buyLot("518880.SH", 6.0, 1000, 0, future, undefined, true)).toThrow(/不得晚于当前/);
      expect(engineCounts(engine)).toEqual(beforeBuy);

      const parent = engine.buyLot("518880.SH", 6.0, 1000, 0, undefined, undefined, true);
      const beforeAdd = engineCounts(engine);
      expect(() => engine.addLot(parent.lot_id, 5.0, { qty: 100, skipRiskCheck: true, buyTime: future })).toThrow(
        /不得晚于当前/,
      );
      expect(engineCounts(engine)).toEqual(beforeAdd);

      const beforeClose = engineCounts(engine);
      expect(() => engine.closeLot(parent.lot_id, 6.5, 500, false, 0, future)).toThrow(/不得晚于当前/);
      expect(engineCounts(engine)).toEqual(beforeClose);
      expect(engine.getLot(parent.lot_id)!.remaining_quantity).toBe(1000);
    } finally {
      db.close();
    }
  });

  it("engine: an unparseable --time is refused instead of inserting a NaN-stamped row", () => {
    const { engine, db } = createTestEngine();
    try {
      const before = engineCounts(engine);
      expect(() => engine.buyLot("518880.SH", 6.0, 1000, 0, new Date("not-a-date"), undefined, true)).toThrow(
        /非法成交时间/,
      );
      expect(engineCounts(engine)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("engine: a forged future time can no longer bypass the cooldown on a blocked lineage", () => {
    const { engine, db } = createTestEngine();
    try {
      const nowMs = Date.now();
      const base = engine.buyLot("518880.SH", 6.0, 2000, 0, new Date(nowMs - 120 * HOUR), undefined, true);
      const l1 = engine.addLot(base.lot_id, 5.4, { amount: 10000, skipRiskCheck: true, buyTime: new Date(nowMs - HOUR) });
      expect(l1.pyramid_level).toBe(1);

      // Same lineage, still inside the 48h window on the real clock.
      const forged = new Date(nowMs + 50 * HOUR);
      const before = engineCounts(engine);
      expect(() => engine.addLot(base.lot_id, 5.0, { amount: 10000, skipRiskCheck: true, buyTime: forged })).toThrow(
        /不得晚于当前/,
      );
      // ... and a legal (no --time) retry is still correctly blocked by the cooldown itself.
      expect(() => engine.addLot(base.lot_id, 5.0, { amount: 10000, skipRiskCheck: true })).toThrow(
        "防抖冷却窗口守卫拦截",
      );
      expect(engineCounts(engine)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("engine POSITIVE CONTROL: history-backfilled pyramid add outside the window is allowed (parent -72h, first add -49h, next add on the real clock)", () => {
    const { engine, db } = createTestEngine();
    try {
      const nowMs = Date.now();
      const parent = engine.buyLot("518880.SH", 6.0, 2000, 0, new Date(nowMs - 72 * HOUR), undefined, true);
      const first = engine.addLot(parent.lot_id, 5.4, {
        amount: 10000,
        skipRiskCheck: true,
        buyTime: new Date(nowMs - 49 * HOUR),
      });
      expect(first.pyramid_level).toBe(1);
      expect(first.parent_lot_id).toBe(parent.lot_id);

      // No --time: the real clock is 49h after the first add, so the window has genuinely elapsed.
      const second = engine.addLot(first.lot_id, 5.0, { amount: 10000, skipRiskCheck: true });
      expect(second.parent_lot_id).toBe(first.lot_id);
      expect(second.pyramid_level).toBe(first.pyramid_level + 1);
      expect(second.pyramid_level).toBe(2);
    } finally {
      db.close();
    }
  });

  it("CLI NEGATIVE CONTROL: --time in the future exits non-zero and writes nothing", async () => {
    const home = sandbox("d01-cli-home");
    const dbPath = join(sandbox("d01-cli-db"), "forgery.db");

    const parent = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.00", "--qty", "1000", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(parent.exitCode).toBe(0);
    const parentLotId = JSON.parse(parent.stdout).data.lot_id as string;

    const forgedTime = new Date(Date.now() + 50 * HOUR).toISOString();
    const before = tableCounts(dbPath);
    const forged = await runCli(
      ["lot", "add", "--parent-lot-id", parentLotId, "--price", "2.250", "--account", "ACCA", "--skip-risk", "--time", forgedTime, "--reason", "forged_future", "--fee", "0", "--json"],
      dbPath,
      home,
    );
    expect(forged.exitCode).not.toBe(0);
    expect(`${forged.stdout}${forged.stderr}`).toContain("不得晚于当前");
    expect(tableCounts(dbPath)).toEqual(before);
  });

  it("CLI POSITIVE CONTROL: a -49h backfilled add is accepted and the row is inserted", async () => {
    const home = sandbox("d01-cli-pos-home");
    const dbPath = join(sandbox("d01-cli-pos-db"), "backfill.db");

    const parent = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.00", "--qty", "1000", "--account", "ACCA", "--fee", "0", "--skip-risk", "--time", new Date(Date.now() - 72 * HOUR).toISOString(), "--json"],
      dbPath,
      home,
    );
    expect(parent.exitCode).toBe(0);
    const parentLotId = JSON.parse(parent.stdout).data.lot_id as string;

    const before = tableCounts(dbPath);
    const res = await runCli(
      ["lot", "add", "--parent-lot-id", parentLotId, "--price", "5.40", "--amount", "10000", "--account", "ACCA", "--skip-risk", "--time", new Date(Date.now() - 49 * HOUR).toISOString(), "--fee", "0", "--json"],
      dbPath,
      home,
    );
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.data.pyramid_level).toBe(1);
    expect(payload.data.parent_lot_id).toBe(parentLotId);

    const after = tableCounts(dbPath);
    expect(after.lots - before.lots).toBe(1);
    expect(after.trades - before.trades).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-06 · 30% hard-cap message must be distinguishable from its own threshold
// ---------------------------------------------------------------------------

describe("L1 D-06: 30% hard-cap message prints a ratio distinguishable from the threshold", () => {
  it("engine: interception still fires, zero writes, and the printed ratio is not '30.00%'", () => {
    const { engine, db } = createTestEngine(10000);
    try {
      engine.buyLot("518880.SH", 10.0, 700, 0, undefined, undefined, true); // 7,000 other-symbol value
      const before = engineCounts(engine);

      let message = "";
      try {
        engine.buyLot("159915.SZ", 3.0005, 1000, 0, undefined, undefined, false); // 3,000.50 -> 30.0035%
        throw new Error("expected the 30% hard cap to intercept");
      } catch (err: any) {
        message = err.message;
      }

      expect(message).toContain("组合级硬顶红线");
      expect(message).toContain("超过 30.00%");
      expect(message).toContain("30.0035%");
      expect(message).not.toContain("估算持仓占比为 30.00%");
      expect(engineCounts(engine)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("CLI: over-cap buy exits 1, mutates nothing, and the ratio is readable (30.0035% > 30.00%)", async () => {
    const home = sandbox("d06-cli-home");
    const dbPath = join(sandbox("d06-cli-db"), "risk-over.db");

    const parked = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "10.00", "--qty", "700", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(parked.exitCode).toBe(0);

    const before = tableCounts(dbPath);
    const res = await runCli(
      ["lot", "buy", "--symbol", "159915.SZ", "--price", "3.0005", "--qty", "1000", "--account", "ACCA", "--fee", "0", "--json"],
      dbPath,
      home,
    );

    expect(res.exitCode).toBe(1);
    const message = `${res.stdout}${res.stderr}`;
    expect(message).toContain("组合级硬顶红线");
    expect(message).toContain("30.0035%");
    expect(message).toContain("超过 30.00%");
    expect(message).not.toContain("占比为 30.00%");
    expect(tableCounts(dbPath)).toEqual(before);
  });

  it("CLI POSITIVE CONTROL: a buy that stays under the cap is still accepted", async () => {
    const home = sandbox("d06-pos-home");
    const dbPath = join(sandbox("d06-pos-db"), "risk-under.db");

    const parked = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "10.00", "--qty", "700", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"],
      dbPath,
      home,
    );
    expect(parked.exitCode).toBe(0);

    const before = tableCounts(dbPath);
    const res = await runCli(
      ["lot", "buy", "--symbol", "159915.SZ", "--price", "3.0000", "--qty", "900", "--account", "ACCA", "--fee", "0", "--json"],
      dbPath,
      home,
    );
    // 2700 / (7000 + 2700) = 27.84% — comfortably legal.
    expect(res.exitCode).toBe(0);
    const after = tableCounts(dbPath);
    expect(after.lots - before.lots).toBe(1);
    expect(after.trades - before.trades).toBe(1);
  });
});
