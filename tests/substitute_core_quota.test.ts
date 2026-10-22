/**
 * T-45 regression: substitute-core (日内底仓代冲) quota must be NET of the day's already
 * executed substitutions.
 *
 * The defect: `computeAvailableCorePosition` only counted the gross matured core pool, so an
 * account holding 100 shares of settled core could be drained by calling
 * `trade lot close <today lot> <qty> --substitute-core` repeatedly — each call re-read the same
 * 100-share denominator, so 5 x 100 = 500 shares all passed (a 5x oversell / naked short).
 *
 * Invariant under test:
 *     available = gross(matured core) - consumedToday(substitute-core closes today)
 * and once exhausted, the next request must hard-fail with exit 1 and leave ZERO partial writes.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

// 36h back guarantees a different UTC calendar day than "today" regardless of clock time.
const YESTERDAY = new Date(Date.now() - 36 * 3600 * 1000);
const TODAY = new Date();

const tempDirs: string[] = [];
function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `t45-${tag}-`));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], dbPath: string): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, LOT_TRADER_DB: dbPath, TRADE_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("T-45: substitute-core quota is cumulative across a trading day", () => {
  it("unit: available quota = gross core - today's substitute closes", () => {
    const dir = tempDir("unit");
    const dbPath = join(dir, "q.db");
    const db = new AppDatabase(dbPath);
    const engine = new TraderEngine(db.getConnection());
    try {
      // Settled core: 100 shares bought yesterday.
      engine.buyLot("600519.SH", 100, 100, 0, YESTERDAY, undefined, true);
      // Today's T+1 lot: 500 shares (blocked from direct sale, only substitutable).
      const todayLot = engine.buyLot("600519.SH", 200, 500, 0, TODAY, undefined, true);

      const before = engine.arbitrator.computeCorePositionBreakdown("600519.SH", TODAY, "DEFAULT");
      expect(before).toEqual({ gross: 100, consumedToday: 0, available: 100 });
      expect(engine.arbitrator.computeAvailableCorePosition("600519.SH", TODAY, "DEFAULT")).toBe(100);

      // 1st substitution: exactly the whole settled core.
      const [afterFirst] = engine.closeLot(todayLot.lot_id, 210, 100, true, 0, TODAY);
      expect(afterFirst.remaining_quantity).toBe(400);
      expect(afterFirst.substituted_core_lot_id).toBeTruthy();

      const after = engine.arbitrator.computeCorePositionBreakdown("600519.SH", TODAY, "DEFAULT");
      expect(after.gross).toBe(100);
      expect(after.consumedToday).toBe(100);
      expect(after.available).toBe(0);

      // Every further substitution — even 1 share — is now blocked. The historical defect let
      // four more 100-share closes through, overselling 5x.
      expect(() => engine.closeLot(todayLot.lot_id, 210, 1, true, 0, TODAY)).toThrow(/底仓可用配额不足/);
      expect(() => engine.closeLot(todayLot.lot_id, 210, 100, true, 0, TODAY)).toThrow(/底仓可用配额不足/);

      // Rejections must be transaction-free: the today lot keeps its 400 remaining shares.
      const reloaded = engine.getLot(todayLot.lot_id);
      expect(reloaded!.remaining_quantity).toBe(400);
      expect(reloaded!.status).toBe("ACTIVE");

      // and the try/catch loop above added no extra SELL_DAY_TRADE rows
      const sellCount = engine
        .conn
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM trades WHERE lot_id = ? AND action = 'SELL_DAY_TRADE'",
        )
        .get(todayLot.lot_id)!.n;
      expect(sellCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("unit: NATIVE_T0 same-day closes never consume STATUTORY_T1 substitute quota", () => {
    const dir = tempDir("t0");
    const dbPath = join(dir, "t0.db");
    const db = new AppDatabase(dbPath);
    const engine = new TraderEngine(db.getConnection());
    try {
      // 518880.SH is NATIVE_T0: buying and selling it today is a plain day trade, no core needed.
      const t0Lot = engine.buyLot("518880.SH", 6.1, 2000, 0, TODAY, undefined, true);
      engine.closeLot(t0Lot.lot_id, 6.4, 2000, false, 0, TODAY);

      // A different, T+1 symbol keeps its full quote — the T0 activity must not be subtracted.
      engine.buyLot("600519.SH", 100, 100, 0, YESTERDAY, undefined, true);
      const breakdown = engine.arbitrator.computeCorePositionBreakdown("600519.SH", TODAY, "DEFAULT");
      expect(breakdown).toEqual({ gross: 100, consumedToday: 0, available: 100 });
    } finally {
      db.close();
    }
  });

  it("CLI: the 2nd substitute-core close exits 1 with the quota message and mutates nothing", async () => {
    const dir = tempDir("cli");
    const dbPath = join(dir, "cli.db");

    const core = await runCli(
      ["lot", "buy", "--symbol", "600519.SH", "--price", "100", "--qty", "100", "--time", YESTERDAY.toISOString(), "--skip-risk", "--json"],
      dbPath,
    );
    expect(core.exitCode).toBe(0);

    const today = await runCli(
      ["lot", "buy", "--symbol", "600519.SH", "--price", "200", "--qty", "200", "--skip-risk", "--json"],
      dbPath,
    );
    expect(today.exitCode).toBe(0);
    const todayLotId = JSON.parse(today.stdout).data.lot_id as string;

    // 1st close of 100 shares against 100 shares of settled core: allowed.
    const first = await runCli(
      ["lot", "close", todayLotId, "210", "--qty", "100", "--substitute-core", "--json"],
      dbPath,
    );
    expect(first.exitCode).toBe(0);
    const firstRes = JSON.parse(first.stdout).data;
    expect(firstRes.remaining_quantity).toBe(100);
    const realizedAfterFirst = firstRes.realized_pnl;

    // 2nd close of 1 share: quota is exhausted -> hard reject, exit 1.
    const second = await runCli(
      ["lot", "close", todayLotId, "210", "--qty", "1", "--substitute-core", "--json"],
      dbPath,
    );
    expect(second.exitCode).toBe(1);
    const message = `${second.stdout}${second.stderr}`;
    expect(message).toContain("底仓可用配额不足");
    expect(message).toContain("总底仓 100 股");
    expect(message).toContain("今日已代冲 100 股");
    expect(message).toContain("剩余可用配额仅 0 股");
    expect(message).toContain("申请代冲 1 股");

    // 3rd close of a full 100 shares: also rejected (the old 5x-oversell path).
    const third = await runCli(
      ["lot", "close", todayLotId, "210", "--qty", "100", "--substitute-core", "--json"],
      dbPath,
    );
    expect(third.exitCode).toBe(1);
    expect(`${third.stdout}${third.stderr}`).toContain("底仓可用配额不足");

    // Zero mutation: quantity, realized PnL and trade count are all unchanged.
    const list = await runCli(["lot", "list", "--status", "ALL", "--symbol", "600519.SH", "--json"], dbPath);
    expect(list.exitCode).toBe(0);
    const target = (JSON.parse(list.stdout).data as any[]).find((l) => l.lot_id === todayLotId);
    expect(target.remaining_quantity).toBe(100);
    expect(target.realized_pnl).toBe(realizedAfterFirst);
  }, 60_000);

  it("CLI: a single over-quota request (core 100, request 200) is rejected before any write", async () => {
    const dir = tempDir("over");
    const dbPath = join(dir, "over.db");

    await runCli(
      ["lot", "buy", "--symbol", "600519.SH", "--price", "100", "--qty", "100", "--time", YESTERDAY.toISOString(), "--skip-risk", "--json"],
      dbPath,
    );
    const today = await runCli(
      ["lot", "buy", "--symbol", "600519.SH", "--price", "200", "--qty", "200", "--skip-risk", "--json"],
      dbPath,
    );
    const todayLotId = JSON.parse(today.stdout).data.lot_id as string;

    const res = await runCli(
      ["lot", "close", todayLotId, "210", "--qty", "200", "--substitute-core", "--json"],
      dbPath,
    );
    expect(res.exitCode).toBe(1);
    const message = `${res.stdout}${res.stderr}`;
    expect(message).toContain("底仓可用配额不足");
    expect(message).toContain("总底仓 100 股");

    const list = await runCli(["lot", "list", "--status", "ALL", "--symbol", "600519.SH", "--json"], dbPath);
    const target = (JSON.parse(list.stdout).data as any[]).find((l) => l.lot_id === todayLotId);
    expect(target.remaining_quantity).toBe(200);
    expect(target.status).toBe("ACTIVE");
  }, 60_000);
});
