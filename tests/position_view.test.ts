import { describe, expect, it } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";
import { SettlementMode } from "../src/models.ts";

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

describe("Position / Holding Aggregated View Tests", () => {
  it("1. calculates weighted average cost price and total quantity across multiple lots for a single symbol", async () => {
    const db = new AppDatabase(":memory:");
    const mockQuotes = new QuoteProvider();
    const engine = new TraderEngine(db.getConnection(), mockQuotes);

    // Buy lot 1: 1000 shares @ 10.00 (cost = 10,000 + default ETF fee 0.50 = 10,000.50, unit cost = 10.0005)
    // Buy lot 2: 2000 shares @ 8.00 (cost = 16,000 + default ETF fee 0.80 = 16,000.80, unit cost = 8.0004)
    engine.buyLot("518880.SH", 10.00, 1000, 0.50);
    engine.buyLot("518880.SH", 8.00, 2000, 0.80);

    // Current price is 9.00
    mockQuotes.setMockPrice("518880.SH", 9.00);

    const positions = await engine.getPositionSummaries();
    expect(positions.length).toBe(1);

    const p = positions[0];
    expect(p.symbol).toBe("518880.SH");
    expect(p.name).toBe("黄金ETF");
    expect(p.total_quantity).toBe(3000);
    expect(p.active_lots_count).toBe(2);

    // Total cost basis = 1000 * 10.0005 + 2000 * 8.0004 = 10000.50 + 16000.80 = 26001.30
    expect(p.total_cost_basis).toBeCloseTo(26001.30, 1);

    // Weighted average cost = 26001.30 / 3000 = 8.6671
    expect(p.avg_cost_price).toBeCloseTo(8.6671, 3);

    // Current price & market value = 9.00 * 3000 = 27,000.00
    expect(p.current_price).toBe(9.00);
    expect(p.market_value).toBe(27000.00);

    // Overall floating PnL should be positive
    expect(p.total_floating_pnl).toBeGreaterThan(0);
    expect(p.overall_return_rate).toBeGreaterThan(0);
  });

  it("2. computes available_core_qty correctly for Native T+0 and Statutory T+1", async () => {
    const db = new AppDatabase(":memory:");
    const mockQuotes = new QuoteProvider();
    const engine = new TraderEngine(db.getConnection(), mockQuotes);

    const now = new Date("2026-10-19T14:00:00Z");
    const twoDaysAgo = new Date("2026-10-17T10:00:00Z");

    // Symbol A: Gold ETF (Native T+0) -> all 2000 shares available immediately even if bought today
    engine.buyLot("518880.SH", 6.00, 2000, 0.50, now, undefined, true);

    // Symbol B: Stock 600519 (Statutory T+1) -> 500 shares bought 2 days ago, 300 shares bought today
    engine.buyLot("600519.SH", 1600.00, 500, 10.00, twoDaysAgo, undefined, true);
    engine.buyLot("600519.SH", 1650.00, 300, 6.00, now, undefined, true);

    mockQuotes.setMockPrice("518880.SH", 6.20);
    mockQuotes.setMockPrice("600519.SH", 1680.00);

    const positions = await engine.getPositionSummaries(undefined, now);
    expect(positions.length).toBe(2);

    const gold = positions.find((x) => x.symbol === "518880.SH")!;
    expect(gold.total_quantity).toBe(2000);
    expect(gold.available_core_qty).toBe(2000); // Native T+0: total = core

    const stock = positions.find((x) => x.symbol === "600519.SH")!;
    expect(stock.total_quantity).toBe(800);
    expect(stock.available_core_qty).toBe(500); // Only historical batch counts as available core
    expect(stock.active_lots_count).toBe(2);
  });

  it("3. calculates portfolio_weight and total market value across multiple symbols", async () => {
    const db = new AppDatabase(":memory:");
    const mockQuotes = new QuoteProvider();
    const engine = new TraderEngine(db.getConnection(), mockQuotes);

    // Symbol 1: 518880 (1000 shares @ 10, MV = 10,000)
    engine.buyLot("518880.SH", 10.00, 1000, 1.00, undefined, undefined, true);
    mockQuotes.setMockPrice("518880.SH", 10.00);

    // Symbol 2: 588000 (3000 shares @ 10, MV = 30,000)
    engine.buyLot("588000.SH", 10.00, 3000, 1.00, undefined, undefined, true);
    mockQuotes.setMockPrice("588000.SH", 10.00);

    // Total portfolio market value = 40,000
    // Weight 518880 = 10,000 / 40,000 = 25% (0.25)
    // Weight 588000 = 30,000 / 40,000 = 75% (0.75)
    const positions = await engine.getPositionSummaries();
    expect(positions.length).toBe(2);

    const pGold = positions.find((x) => x.symbol === "518880.SH")!;
    const pSci = positions.find((x) => x.symbol === "588000.SH")!;

    expect(pGold.market_value).toBe(10000.00);
    expect(pSci.market_value).toBe(30000.00);

    expect(pGold.portfolio_weight).toBe(0.25);
    expect(pSci.portfolio_weight).toBe(0.75);
    expect(pGold.portfolio_weight + pSci.portfolio_weight).toBeCloseTo(1.0, 4);
  });

  it("4. computes 4-level decision price lines accurately (+10%, +20%, -10%, -20%)", async () => {
    const db = new AppDatabase(":memory:");
    const mockQuotes = new QuoteProvider();
    const engine = new TraderEngine(db.getConnection(), mockQuotes);

    // Buy 1000 shares @ 10.00, 0 fee -> avg cost = 10.00
    engine.buyLot("518880.SH", 10.00, 1000, 0);
    mockQuotes.setMockPrice("518880.SH", 10.00);

    const positions = await engine.getPositionSummaries();
    expect(positions.length).toBe(1);

    const p = positions[0];
    expect(p.avg_cost_price).toBe(10.00);
    expect(p.target_tp_10).toBe(11.00);   // +10%
    expect(p.target_tp_20).toBe(12.00);   // +20%
    expect(p.target_dip_10).toBe(9.00);   // -10%
    expect(p.target_dip_20).toBe(8.00);   // -20%
  });

  it("5. validates CLI 'trade position' and 'trade position --json' end-to-end execution", async () => {
    const testDb = join(tmpdir(), "cli_pos_test_" + Date.now() + ".db");

    // Buy 2 lots for Gold ETF
    const p1 = await runCli(["lot", "buy", "--symbol", "518880.SH", "--price", "6.00", "--qty", "1000", "--json"], testDb);
    expect(p1.exitCode).toBe(0);

    const p2 = await runCli(["lot", "buy", "--symbol", "518880.SH", "--price", "7.00", "--qty", "1000", "--json"], testDb);
    expect(p2.exitCode).toBe(0);

    // Execute 'trade position --json'
    const pJson = await runCli(["position", "--json"], testDb);
    expect(pJson.exitCode).toBe(0);
    const res = JSON.parse(pJson.stdout);
    expect(res.code).toBe(0);
    expect(res.data.length).toBe(1);

    const pos = res.data[0];
    expect(pos.symbol).toBe("518880.SH");
    expect(pos.total_quantity).toBe(2000);
    expect(pos.active_lots_count).toBe(2);
    expect(pos.avg_cost_price).toBeCloseTo(6.50, 1);
    expect(pos.available_core_qty).toBe(2000);
    expect(pos.target_tp_10).toBeDefined();
    expect(pos.target_tp_20).toBeDefined();
    expect(pos.target_dip_10).toBeDefined();
    expect(pos.target_dip_20).toBeDefined();
    expect(pos.portfolio_weight).toBe(1.0);

    // Execute 'trade position' in ASCII table mode
    const pTable = await runCli(["position"], testDb);
    expect(pTable.exitCode).toBe(0);
    expect(pTable.stdout).toContain("标的级聚合持仓视图");
    expect(pTable.stdout).toContain("518880.SH");
    expect(pTable.stdout).toContain("TargetPrices");

    // Execute 'trade position list' alias
    const pListTable = await runCli(["position", "list"], testDb);
    expect(pListTable.exitCode).toBe(0);
    expect(pListTable.stdout).toContain("518880.SH");
  });
});
