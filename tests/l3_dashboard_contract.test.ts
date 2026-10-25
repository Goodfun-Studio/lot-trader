/**
 * L3 — dashboard generator + CLI contract.
 *
 * Three defects, each with an explicit negative case AND an anti-false-kill control that proves a
 * fully legal invocation is still accepted:
 *
 *   D-04 (P3) `dashboard --out /missing-dir/x.html` used to print a raw interpreter traceback
 *             (`Traceback (most recent call last)` + `FileNotFoundError`) on stderr. The generator
 *             now refuses up front with ONE clean Chinese line naming the missing directory, and
 *             the legal path keeps generating a 0600 page exactly as before.
 *   D-08 (P2) the page's probe base was hardcoded to `http://127.0.0.1:8080` with no way to
 *             override it, so any `trade serve --port <other>` left the page stuck in standalone
 *             mode. `generate_dashboard.py --api-base` / `trade dashboard --api-base` now carry
 *             the address the caller is actually listening on — while the default (flag absent)
 *             stays byte-for-byte the old `127.0.0.1:8080`.
 *   plus      the `dashboard` path finally joins the shared undeclared-flag gate, so
 *             `trade dashboard --zzz-bogus` is refused before the ledger is ever opened.
 *
 * The D-08 live-link test binds a REAL `trade serve` listener inside the 18000-18999 range and
 * fetches the exact address baked into the generated page — no 8080 involved anywhere.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startServe, type StartedServe } from "../src/serve.ts";
import { CLI_FLAG_SPECS, findUndeclaredFlag, validateApiBase } from "../src/cli.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const templatePath = join(repoRoot, "scripts", "template_base.html");
const generatorPath = join(repoRoot, "scripts", "generate_dashboard.py");

const DEFAULT_API_BASE = "http://127.0.0.1:8080";
/** Every listener this suite binds stays inside the topic boundary range. */
const PORT_RANGE_START = 18000;
const PORT_RANGE_END = 18999;

const tempDirs: string[] = [];
const openServers: StartedServe[] = [];

afterAll(async () => {
  for (const srv of openServers) {
    await srv.stop();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  dir: string;
  db: string;
  out: string;
  binDir: string;
  tokenFile: string;
}

/**
 * A workspace whose `trade` shim points at the freshly-built CLI: the Python generator shells
 * out to `trade ... --json`, so the suite must never reach the globally installed binary.
 */
function makeWorkspace(tag: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), `l3-dashboard-${tag}-`));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "trade");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return {
    dir,
    db: join(dir, "ledger.db"),
    out: join(dir, "dashboard.html"),
    binDir,
    tokenFile: join(dir, "session.token"),
  };
}

/**
 * Seed a lot through the CLI rather than an in-process `AppDatabase`.
 *
 * The generator's ledger-open path runs `PRAGMA journal_mode = WAL`, which needs a moment of
 * exclusive access; keeping a second SQLite connection inside the test process makes that a race
 * (a pre-existing flake in `tests/dashboard.test.ts`, reported separately — not introduced here).
 * Seeding through the same CLI contract keeps this suite out of it.
 */
async function seedLedger(ws: Workspace): Promise<void> {
  const res = await runCli(
    ["lot", "buy", "--symbol", "518880.SH", "--price", "6.10", "--qty", "1000", "--json"],
    ws,
  );
  expect(res.exitCode, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).code).toBe(0);
}

async function runCli(
  args: string[],
  ws: Workspace,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Never let an ambient ledger override the sandbox one.
  delete env.LOT_TRADER_DB;
  delete env.TRADE_DB_PATH;
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...env,
      PATH: `${ws.binDir}:${env.PATH ?? ""}`,
      LOT_TRADER_DB: ws.db,
      TRADE_DB_PATH: ws.db,
      LOT_TRADER_TOKEN_FILE: ws.tokenFile,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

/** Read the probe base the page will heartbeat against, straight out of the rendered markup. */function readBakedApiBase(html: string): string {
  const match = html.match(/var LOCAL_API_BASE = (["'])(.*?)\1;/);
  expect(match, "generated page carries no `var LOCAL_API_BASE = ...` assignment").not.toBeNull();
  return match![2];
}

function readLocalBaseFallback(html: string): string {
  const match = html.match(/localBase: LCR \? LCR\.LOCAL_API_BASE : (["'])(.*?)\1,/);
  expect(match, "generated page carries no `localBase:` fallback").not.toBeNull();
  return match![2];
}

/**
 * Evaluate the generated page's own front-end runtime (`<script id="live-client-runtime">`) so the
 * test can drive its real heartbeat probe and mode state machine — no DOM required for that path.
 */
function loadGeneratedRuntime(html: string): Record<string, any> {
  const match = html.match(/<script id="live-client-runtime">([\s\S]*?)<\/script>/);
  expect(match, "generated page carries no live-client-runtime block").not.toBeNull();
  const sandbox: Record<string, any> = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const factory = new Function(
    "window",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "TextDecoder",
    "AbortController",
    `${match![1]}\n`,
  );
  factory(sandbox, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, AbortController);
  return sandbox.LiveClientRuntime;
}

/** Bind a real listener on a free port inside 18000-18999. */
async function startServeInRange(ws: Workspace): Promise<StartedServe> {
  let lastErr: unknown = null;
  const offset = Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START + 1));
  for (let i = 0; i <= PORT_RANGE_END - PORT_RANGE_START; i += 1) {
    const port = PORT_RANGE_START + ((offset + i) % (PORT_RANGE_END - PORT_RANGE_START + 1));
    try {
      const srv = await startServe({
        port,
        host: "127.0.0.1",
        dbPath: ws.db,
        tokenFile: ws.tokenFile,
        quiet: true,
      });
      openServers.push(srv);
      return srv;
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code !== "PORT_IN_USE") throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ===========================================================================
// D-04 — missing output directory must never dump an interpreter traceback
// ===========================================================================

describe("L3 D-04 `dashboard --out` into a nonexistent directory", () => {
  it("fails with one clean Chinese line naming the missing directory and no traceback", async () => {
    const ws = makeWorkspace("d04-bad");
    const missingOut = join(ws.dir, "no-such-dir", "x.html");

    const res = await runCli(
      ["dashboard", "--out", missingOut, "--token-file", ws.tokenFile, "--db", ws.db],
      ws,
    );

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("输出目录不存在");
    expect(res.stderr).toContain(join(ws.dir, "no-such-dir"));
    // The whole defect: a raw interpreter dump used to follow the message.
    expect(res.stderr).not.toContain("Traceback");
    expect(res.stderr).not.toMatch(
      /(FileNotFoundError|NotADirectoryError|IsADirectoryError|PermissionError|OSError|SystemExit)/,
    );
    expect(res.stderr).not.toMatch(/^\s+File "/m);
    expect(existsSync(missingOut)).toBe(false);
  });

  it("keeps the same single-line reason in --json mode", async () => {
    const ws = makeWorkspace("d04-json");
    const res = await runCli(
      [
        "dashboard",
        "--out",
        join(ws.dir, "no-such-dir", "x.html"),
        "--token-file",
        ws.tokenFile,
        "--db",
        ws.db,
        "--json",
      ],
      ws,
    );

    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.code).toBe(1);
    expect(payload.msg).toContain("输出目录不存在");
    expect(payload.msg).not.toContain("Traceback");
    expect(JSON.stringify(payload)).not.toMatch(/(FileNotFoundError|OSError|SystemExit)/);
  });

  it("anti-false-kill: an existing directory still renders a 0600 page and exits 0", async () => {
    const ws = makeWorkspace("d04-ok");
    await seedLedger(ws);

    const res = await runCli(
      ["dashboard", "--out", ws.out, "--token-file", ws.tokenFile, "--db", ws.db],
      ws,
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stderr).not.toContain("Traceback");
    expect(existsSync(ws.out)).toBe(true);
    expect(statSync(ws.out).mode & 0o777).toBe(0o600);
    expect(res.stdout).toContain("Global dashboard successfully generated");
    expect(res.stdout).toContain("全局看板已生成");
    expect(res.stdout).toContain("探活基址: http://127.0.0.1:8080");
    expect(statSync(ws.out).size).toBeGreaterThan(10_000);
  });

  it("a pre-existing world-readable page is re-permissioned to 0600, not left at 0644", async () => {
    const ws = makeWorkspace("d04-mode");
    writeFileSync(ws.out, "<html>stale</html>", "utf-8");
    chmodSync(ws.out, 0o644);

    const res = await runCli(
      ["dashboard", "--out", ws.out, "--token-file", ws.tokenFile, "--db", ws.db, "--json"],
      ws,
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(statSync(ws.out).mode & 0o777).toBe(0o600);
    expect(readFileSync(ws.out, "utf-8")).toContain("<!DOCTYPE html>");
  });
});

// ===========================================================================
// D-08 — the probe base must be overridable, and the override must really link
// ===========================================================================

describe("L3 D-08 `dashboard --api-base` probe base", () => {
  it("anti-false-kill: with no flag the page keeps the default 127.0.0.1:8080", async () => {
    const ws = makeWorkspace("d08-default");
    await seedLedger(ws);

    const res = await runCli(
      ["dashboard", "--out", ws.out, "--token-file", ws.tokenFile, "--db", ws.db],
      ws,
    );

    expect(res.exitCode, res.stderr).toBe(0);
    const html = readFileSync(ws.out, "utf-8");
    expect(html).toContain(`var LOCAL_API_BASE = '${DEFAULT_API_BASE}';`);
    expect(readBakedApiBase(html)).toBe(DEFAULT_API_BASE);
    expect(readLocalBaseFallback(html)).toBe(DEFAULT_API_BASE);
    // No template placeholder may survive interpolation.
    expect(/\{\{[A-Z_]+\}\}/.test(html)).toBe(false);
  });

  it("bakes the caller's base and that exact address answers /api/health + /api/summary", async () => {
    const ws = makeWorkspace("d08-live");
    await seedLedger(ws);

    const srv = await startServeInRange(ws);
    expect(srv.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(srv.port).toBeLessThanOrEqual(PORT_RANGE_END);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);

    // The credential `trade serve` just published is the one `trade dashboard` injects.
    const res = await runCli(
      [
        "dashboard",
        "--out",
        ws.out,
        "--api-base",
        srv.url,
        "--token-file",
        srv.tokenFile,
        "--db",
        ws.db,
        "--json",
      ],
      ws,
    );
    expect(res.exitCode, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).data.api_base).toBe(srv.url);

    const html = readFileSync(ws.out, "utf-8");
    // The address the page probes is the address the listener actually owns — not 8080.
    expect(readBakedApiBase(html)).toBe(srv.url);
    expect(readLocalBaseFallback(html)).toBe(srv.url);
    expect(html).not.toContain(`'${DEFAULT_API_BASE}'`);
    // No executable block may still probe 8080; the only remaining mention is the static
    // onboarding copy that documents the DEFAULT `trade serve` invocation.
    const scriptChunks = html.split("<script").slice(1).map((chunk) => chunk.split("</script>")[0]);
    expect(scriptChunks.length).toBeGreaterThan(0);
    for (const chunk of scriptChunks) {
      expect(chunk).not.toContain(DEFAULT_API_BASE);
    }

    // Replay the page's own heartbeat: GET <baked base>/api/health must be reachable & public.
    const health = await fetch(`${readBakedApiBase(html)}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status: string };
    expect(healthBody.status).toBe("ok");

    // Full linkage: the injected credential authenticates against the same base.
    const token = readFileSync(srv.tokenFile, "utf-8").trim();
    const summary = await fetch(`${readBakedApiBase(html)}/api/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as { status: string; symbols: unknown[] };
    expect(summaryBody.status).toBe("ok");
    expect(Array.isArray(summaryBody.symbols)).toBe(true);

    // And the page's OWN runtime, driven with the address the page itself carries, flips the mode
    // badge from 独立模式 to 本地引擎已联动 — this is the actual acceptance criterion.
    const LCR = loadGeneratedRuntime(html);
    const probe = await LCR.probeLocalService(
      fetch,
      `${readBakedApiBase(html)}/api/health`,
      2500,
      null,
    );
    expect(probe.ok).toBe(true);
    expect(probe.data.status).toBe("ok");
    expect(LCR.nextMode("STANDALONE", probe.ok, 0)).toBe("LOCAL");
  });

  it("refuses a malformed base before the ledger is ever created", async () => {
    const badBases = [
      "http://127.0.0.1:18080/some/path",
      "http://127.0.0.1:18080?x=1",
      "http://127.0.0.1:18080#frag",
      "ftp://127.0.0.1:18080",
      "127.0.0.1:18080",
      "http://",
      "",
    ];

    for (const bad of badBases) {
      const ws = makeWorkspace(`d08-bad-${bad.replace(/[^a-z0-9]/gi, "_").slice(0, 12)}`);
      const res = await runCli(
        ["dashboard", "--out", ws.out, "--api-base", bad, "--db", ws.db],
        ws,
      );
      expect(res.exitCode, `--api-base ${bad} :: ${res.stderr}`).toBe(1);
      expect(res.stderr).toContain("--api-base");
      // The gate runs before dispatch: a rejected base can never materialize a ledger.
      expect(existsSync(ws.db), `--api-base ${bad} created ${ws.db}`).toBe(false);
      expect(existsSync(ws.out)).toBe(false);
    }
  });
});

// ===========================================================================
// `dashboard` joins the shared undeclared-flag gate
// ===========================================================================

describe("L3 dashboard undeclared-flag gate", () => {
  it("declares exactly the flags handleDashboard reads (so the gate can never under- or over-reject)", () => {
    const declared = Object.keys(CLI_FLAG_SPECS.dashboard ?? {}).sort();
    expect(declared).toEqual(
      [
        "api-base",
        "db",
        "json",
        "open",
        "out",
        "scripts-dir",
        "template",
        "token",
        "token-file",
      ].sort(),
    );
    expect(findUndeclaredFlag("dashboard", ["--zzz-bogus"])).toBe("--zzz-bogus");
    expect(findUndeclaredFlag("dashboard", ["--api-base", "http://127.0.0.1:18080"])).toBeNull();
    expect(findUndeclaredFlag("dashboard", ["-o", "x.html", "-t", "t.html"])).toBeNull();
  });

  it("validateApiBase accepts origins and rejects non-origins with a Chinese reason", () => {
    expect(validateApiBase("http://127.0.0.1:18080").error).toBeUndefined();
    expect(validateApiBase("https://localhost:18999/").error).toBeUndefined();
    expect(validateApiBase("http://[::1]:18080").error).toBeUndefined();
    expect(validateApiBase(undefined).error).toBeUndefined();
    for (const bad of ["http://127.0.0.1:18080/x", "127.0.0.1:18080", "ftp://h:1", "  "]) {
      expect(typeof validateApiBase(bad).error, bad).toBe("string");
    }
  });

  it("rejects --zzz-bogus with zero writes, and still accepts every legal form", async () => {
    const ws = makeWorkspace("gate");
    await seedLedger(ws);

    const bogus = await runCli(
      ["dashboard", "--out", ws.out, "--token-file", ws.tokenFile, "--zzz-bogus", "--db", ws.db],
      ws,
    );
    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain("未声明的参数 --zzz-bogus");
    expect(bogus.stderr).toContain("trade dashboard --help");
    expect(existsSync(ws.out)).toBe(false);

    const legal = await runCli(
      [
        "dashboard",
        "--out",
        ws.out,
        "--token-file",
        ws.tokenFile,
        "--api-base",
        "http://127.0.0.1:18000",
        "--db",
        ws.db,
      ],
      ws,
    );
    expect(legal.exitCode, legal.stderr).toBe(0);
    expect(existsSync(ws.out)).toBe(true);

    // --help stays a pure no-op for the dashboard path too.
    const help = await runCli(["dashboard", "--help"], ws);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--api-base");
  });

  it("keeps the shipped template free of a hardcoded probe literal", () => {
    const template = readFileSync(templatePath, "utf-8");
    // The runtime assignment is a quoted placeholder now (still valid JavaScript, so the raw
    // template stays evaluable); only the onboarding copy still hardcodes the default address.
    expect(template).not.toContain("var LOCAL_API_BASE = 'http://127.0.0.1:8080';");
    expect(template).toContain("var LOCAL_API_BASE = '{{LOCAL_API_BASE}}';");
    expect(template).toContain("localBase: LCR ? LCR.LOCAL_API_BASE : '{{LOCAL_API_BASE}}',");
    // The generator is the only writer of that placeholder.
    const generator = readFileSync(generatorPath, "utf-8");
    expect(generator).toContain('replace("{{LOCAL_API_BASE}}"');
    expect(generator).toContain("--local-api-base");
  });
});
