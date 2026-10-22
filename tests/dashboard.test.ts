import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppDatabase } from "../src/db.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

const WEB_TITLE = "Lot-Trader 全局投资组合全景透视看板";

/** Essential containers that must survive the template interpolation. */
const REQUIRED_MARKERS = [
  "<!DOCTYPE html>",
  "<html",
  "</html>",
  `<title>${WEB_TITLE}</title>`,
  // Tab panes
  'id="tab-global"',
  'id="tab-holdings"',
  'id="tab-targets"',
  'id="tab-lots"',
  'id="tab-trades"',
  'id="tab-radar"',
  // Physically separated lot sub-views (time dimension vs return-rate dimension)
  'id="subview-lot-time"',
  'id="subview-lot-pnl"',
  // Table bodies
  'id="tbody-holdings"',
  'id="tbody-time"',
  'id="tbody-pnl"',
  'id="tbody-trades"',
  // Symbol drill-down modal
  'id="target-modal-overlay"',
];

function makeTempWorkspace(): { dir: string; db: string; out: string; binDir: string } {
  const dir = join(tmpdir(), `dash_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });

  // The Python generator shells out to `trade ... --json`; point that at the freshly
  // compiled-from-source CLI so the test never touches the globally installed binary.
  const shim = join(binDir, "trade");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`);
  chmodSync(shim, 0o755);

  return { dir, db: join(dir, "dashboard-test.db"), out: join(dir, "test-dashboard.html"), binDir };
}

async function runCli(
  args: string[],
  opts: { db: string; binDir: string; cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: {
      ...process.env,
      LOT_TRADER_DB: opts.db,
      TRADE_DB_PATH: opts.db,
      PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe("trade dashboard CLI primitive", () => {
  it("renders a complete, valid standalone HTML dashboard", async () => {
    const ws = makeTempWorkspace();
    try {
      // Seed a lot so the dashboard has real aggregated data to render.
      const buy = await runCli(
        ["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
        ws,
      );
      expect(buy.exitCode).toBe(0);
      expect(JSON.parse(buy.stdout).code).toBe(0);

      const res = await runCli(["dashboard", "--out", ws.out, "--json"], ws);
      expect(res.exitCode).toBe(0);

      const payload = JSON.parse(res.stdout);
      expect(payload.code).toBe(0);
      expect(realpathSync(payload.data.out)).toBe(realpathSync(ws.out));
      expect(payload.data.bytes).toBeGreaterThan(20_000);
      expect(payload.data.script.endsWith("generate_dashboard.py")).toBe(true);

      expect(statSync(ws.out).size).toBe(payload.data.bytes);

      const html = readFileSync(ws.out, "utf-8");
      for (const marker of REQUIRED_MARKERS) {
        expect(html.includes(marker)).toBe(true);
      }

      // Every template placeholder must have been interpolated away.
      expect(/\{\{[A-Z_]+\}\}/.test(html)).toBe(false);

      // Sanity: balanced document shell.
      expect(html.trim().startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html.trim().endsWith("</html>")).toBe(true);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("defaults the output to ./lot-trader-global-dashboard.html in the current working directory", async () => {
    const ws = makeTempWorkspace();
    const workDir = join(ws.dir, "work");
    mkdirSync(workDir, { recursive: true });
    try {
      const buy = await runCli(["lot", "buy", "--symbol", "159934.SZ", "--price", "7.10", "--qty", "1000", "--json"], ws);
      expect(buy.exitCode).toBe(0);

      const res = await runCli(["dashboard", "--json"], { ...ws, cwd: workDir });
      expect(res.exitCode).toBe(0);

      const expected = join(workDir, "lot-trader-global-dashboard.html");
      expect(realpathSync(JSON.parse(res.stdout).data.out)).toBe(realpathSync(expected));
      expect(statSync(expected).size).toBeGreaterThan(20_000);
      expect(readFileSync(expected, "utf-8")).toContain(WEB_TITLE);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders an empty ledger without exploding", async () => {
    const ws = makeTempWorkspace();
    try {
      const fresh = join(ws.dir, "fresh.db");
      const res = await runCli(["dashboard", "--out", ws.out, "--db", fresh, "--json"], ws);
      expect(res.exitCode).toBe(0);
      expect(statSync(ws.out).size).toBeGreaterThan(20_000);
      expect(readFileSync(ws.out, "utf-8")).toContain(WEB_TITLE);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("localizes extra asset-class pillars and keeps every pillar colour distinct (P3-1 / P3-2)", async () => {
    const ws = makeTempWorkspace();
    try {
      const buy = await runCli(
        ["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
        ws,
      );
      expect(buy.exitCode).toBe(0);

      // Grow the ledger into extra asset classes plus one unknown code the label map has never
      // seen. Fixtures are raw SQL so the test asserts rendering, not symbol inference.
      const ledger = new AppDatabase(ws.db);
      const conn = ledger.getConnection();
      const fixtures: Array<[string, string, string]> = [
        ["019547.SH", "国债", "BOND"],
        ["161725.SZ", "白酒基金", "FUND"],
        ["X9.SH", "神秘资产", "WEIRDASSET"],
      ];
      for (const [sym, name, cls] of fixtures) {
        conn.run(
          `INSERT OR IGNORE INTO symbols (symbol, name, asset_class, settlement_mode, lot_size)
           VALUES ('${sym}', '${name}', '${cls}', 'STATUTORY_T1', 100)`,
        );
        conn.run(
          `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
           VALUES ('LOT-TEST-${sym}', 'DEFAULT', '${sym}', '2026-01-01T09:30:00', 10.0, 100, 100, 10.0, 'ACTIVE')`,
        );
      }
      ledger.close();

      const res = await runCli(["dashboard", "--out", ws.out, "--json"], ws);
      expect(res.exitCode).toBe(0);
      const html = readFileSync(ws.out, "utf-8");

      const borders = [
        ...html.matchAll(/data-alloc-class="([A-Z_]+)" style="border-top: 4px solid (var\(--[a-z]+\));"/g),
      ];
      const byClass: Record<string, string> = {};
      for (const match of borders) byClass[match[1]] = match[2];

      // P3-1: BOND / FUND must not borrow the purple owned by the CASH card.
      expect(byClass.CASH).toBe("var(--purple)");
      expect(byClass.BOND).not.toBe("var(--purple)");
      expect(byClass.FUND).not.toBe("var(--purple)");
      expect(byClass.BOND).not.toBe(byClass.FUND);

      // No two pillar cards may share a border colour.
      const usedColours = Object.values(byClass);
      expect(usedColours.length).toBeGreaterThanOrEqual(4);
      expect(new Set(usedColours).size).toBe(usedColours.length);

      // P3-2: titles are localized; the raw uppercase code never leaks into a card title.
      expect(html).toContain("🏛 债券固收层");
      expect(html).toContain("🧺 场外基金层");
      expect(html).toContain("📁 其他资产层");
      expect(html).not.toContain("📁 BOND 资产层");
      expect(html).not.toContain("📁 FUND 资产层");
      expect(html).not.toContain("📁 WEIRDASSET 资产层");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits non-zero with a JSON error when the template is missing", async () => {
    const ws = makeTempWorkspace();
    try {
      const res = await runCli(
        ["dashboard", "--out", ws.out, "--template", join(ws.dir, "missing.html"), "--json"],
        ws,
      );
      expect(res.exitCode).toBe(1);
      const payload = JSON.parse(res.stdout);
      expect(payload.code).toBe(1);
      expect(payload.msg).toContain("Template not found");
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
