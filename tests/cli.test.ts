import { describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

async function runCli(args: string[], envDb: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LOT_TRADER_DB: envDb,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe("CLI End-to-End Tests", () => {
  it("runs full lot lifecycle via CLI with JSON output and tables", async () => {
    const testDb = join(tmpdir(), `cli_test_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.db`);

    // 1. Buy Gold ETF via CLI
    const p1 = await runCli(["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"], testDb);
    expect(p1.exitCode).toBe(0);
    const res1 = JSON.parse(p1.stdout);
    expect(res1.code).toBe(0);
    const lotId = res1.data.lot_id;
    expect(lotId.startsWith("LOT-")).toBe(true);

    // 2. List lots via CLI
    const p2 = await runCli(["lot", "list", "--json"], testDb);
    expect(p2.exitCode).toBe(0);
    const res2 = JSON.parse(p2.stdout);
    expect(res2.data.length).toBe(1);
    expect(res2.data[0].lot_id).toBe(lotId);

    // 3. List lots in table mode
    const p2Table = await runCli(["lot", "list"], testDb);
    expect(p2Table.exitCode).toBe(0);
    expect(p2Table.stdout).toContain("518880.SH");

    // 4. Scan signals
    const p3 = await runCli(["scan", "--json"], testDb);
    expect(p3.exitCode).toBe(0);
    const res3 = JSON.parse(p3.stdout);
    expect(res3.data.signals).toBeDefined();

    // 5. Close lot via CLI
    const p4 = await runCli(["lot", "close", "--lot-id", lotId, "--price", "7.05", "--json"], testDb);
    expect(p4.exitCode).toBe(0);
    const res4 = JSON.parse(p4.stdout);
    expect(res4.code).toBe(0);
    expect(res4.data.lot_status).toBe("CLOSED");
    expect(res4.data.realized_pnl).toBeGreaterThan(1800);

    // 6. Check stats via CLI
    const p5 = await runCli(["stats", "--json"], testDb);
    expect(p5.exitCode).toBe(0);
    const res5 = JSON.parse(p5.stdout);
    expect(res5.data.total_trades).toBe(1);
    expect(res5.data.winning_trades).toBe(1);
    expect(res5.data.win_rate).toBe(1.0);

    // 7. Check stats in ASCII table mode
    const p5Table = await runCli(["stats"], testDb);
    expect(p5Table.exitCode).toBe(0);
    expect(p5Table.stdout).toContain("操盘战绩统计报表");
  });
});

