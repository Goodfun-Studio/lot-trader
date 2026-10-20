import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
