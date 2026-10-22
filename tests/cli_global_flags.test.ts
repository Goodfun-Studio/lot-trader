/**
 * CLI global-flag guards.
 *
 * Negative-path first: this suite exists because `trade scan --help` used to run a REAL scan
 * against the default ledger (writing ~119 derived rows into `signals`) and because `--db` was
 * silently ignored by `lot / account / position / scan / stats / physics / dividend`.
 *
 * Two invariants are asserted here, both against the real spawned binary:
 *   1. Every `-h` / `--help` prints usage, exits 0, and leaves the ledger byte-for-byte untouched
 *      (no create, no migrate, no WAL refresh, no derived rows).
 *   2. `--db <path>` is honoured by EVERY subcommand and beats $LOT_TRADER_DB / $TRADE_DB_PATH,
 *      so a sandbox ledger is the only thing ever read or written.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");

const tempDirs: string[] = [];

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cli-flags-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A copy of the ambient environment with the ledger env vars removed (and optional overrides
 * applied), so a subprocess can never inherit the developer's real ledger.
 */
function cleanEnv(overrides: Record<string, string> = {}, drop: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of ["LOT_TRADER_DB", "TRADE_DB_PATH", ...drop]) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** sha256 of a ledger plus its WAL/SHM siblings, so any write (even an empty WAL) is visible. */
function ledgerFingerprint(dbPath: string): string {
  const hash = createHash("sha256");
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      hash.update(suffix);
      hash.update(readFileSync(file));
      hash.update(String(statSync(file).mtimeMs));
    } else {
      hash.update(`${suffix}:absent`);
    }
  }
  return hash.digest("hex");
}

function seedLedger(dbPath: string): Promise<RunResult> {
  return runCli(
    ["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
    { env: cleanEnv({ LOT_TRADER_DB: dbPath }) },
  );
}

// ---------------------------------------------------------------------------
// 1. `-h` / `--help` must be a pure no-op: usage on stdout, exit 0, ledger untouched
// ---------------------------------------------------------------------------

describe("CLI --help guards print usage, exit 0, and never touch the ledger", () => {
  const helpCases: Array<[string, string[]]> = [
    ["top level", ["--help"]],
    ["lot", ["lot", "--help"]],
    ["lot buy", ["lot", "buy", "--help"]],
    ["lot add", ["lot", "add", "--help"]],
    ["lot list", ["lot", "list", "-h"]],
    ["lot close", ["lot", "close", "--help"]],
    ["lot edit", ["lot", "edit", "--help"]],
    ["account", ["account", "--help"]],
    ["account list", ["account", "list", "--help"]],
    ["account add", ["account", "add", "-h"]],
    ["position", ["position", "--help"]],
    ["scan", ["scan", "--help"]],
    ["stats", ["stats", "--help"]],
    ["physics", ["physics", "--help"]],
    ["radar alias", ["radar", "--help"]],
    ["dividend", ["dividend", "--help"]],
    ["dividend add", ["dividend", "add", "--help"]],
    ["dividend list", ["dividend", "list", "-h"]],
    ["serve", ["serve", "--help"]],
    ["dashboard", ["dashboard", "--help"]],
  ];

  it("prints `usage:` and exits 0 for every first/second level help invocation", async () => {
    for (const [label, args] of helpCases) {
      const home = tempRoot("help-home");
      const result = await runCli(args, { env: cleanEnv({ HOME: home }) });
      expect(result.exitCode, `${label}: exit code`).toBe(0);
      expect(result.stdout, `${label}: usage banner`).toContain("usage:");
      // The hard default ledger must never be created just to print help.
      expect(existsSync(join(home, ".trade", "trade.db")), `${label}: default ledger created`).toBe(false);
    }
  });

  it("never creates the $LOT_TRADER_DB ledger when only help is requested", async () => {
    const root = tempRoot("help-env");
    const envDb = join(root, "env-ledger.db");
    for (const args of [
      ["scan", "--help"],
      ["stats", "--help"],
      ["position", "--help"],
      ["physics", "--help"],
      ["lot", "list", "--help"],
      ["account", "list", "--help"],
      ["dividend", "list", "--help"],
    ]) {
      const result = await runCli(args, { env: cleanEnv({ LOT_TRADER_DB: envDb, TRADE_DB_PATH: envDb }) });
      expect(result.exitCode, args.join(" ")).toBe(0);
      expect(existsSync(envDb), `${args.join(" ")}: env ledger created`).toBe(false);
      expect(existsSync(`${envDb}-wal`), `${args.join(" ")}: env WAL created`).toBe(false);
    }
  });

  it("leaves an existing default ledger byte-for-byte identical (P1-1: scan --help must not write signals)", async () => {
    const root = tempRoot("help-sha");
    const ledger = join(root, "default.db");
    const seeded = await seedLedger(ledger);
    expect(seeded.exitCode).toBe(0);

    const before = ledgerFingerprint(ledger);
    const beforeSize = statSync(ledger).size;

    for (const args of [
      ["scan", "--help"],
      ["stats", "--help"],
      ["position", "--help"],
      ["lot", "list", "--help"],
      ["account", "list", "--help"],
      ["dividend", "list", "--help"],
      ["physics", "--help"],
    ]) {
      const result = await runCli(args, { env: cleanEnv({ LOT_TRADER_DB: ledger, TRADE_DB_PATH: ledger }) });
      expect(result.exitCode, args.join(" ")).toBe(0);
      expect(result.stdout, args.join(" ")).toContain("usage:");
    }

    expect(ledgerFingerprint(ledger)).toBe(before);
    expect(statSync(ledger).size).toBe(beforeSize);
  });

  it("does not create a ledger for an unknown subcommand (exits non-zero, no side effect)", async () => {
    const root = tempRoot("unknown");
    const envDb = join(root, "env-ledger.db");
    const result = await runCli(["lot", "bogus"], { env: cleanEnv({ LOT_TRADER_DB: envDb }) });
    expect(result.exitCode).toBe(1);
    expect(existsSync(envDb)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. `--db <path>` must penetrate EVERY subcommand and beat the environment
// ---------------------------------------------------------------------------

describe("CLI --db <path> is honoured by every subcommand", () => {
  it("routes lot buy/list, account list, stats and scan to the --db sandbox only", async () => {
    const root = tempRoot("dbpen");
    const sandbox = join(root, "sandbox.db");
    const defaultLedger = join(root, "default.db");
    // Every invocation deliberately carries a hostile default: if `--db` were ignored, the
    // subcommand would silently create / touch this file.
    const env = cleanEnv({ LOT_TRADER_DB: defaultLedger, TRADE_DB_PATH: defaultLedger });

    // Positional shorthand AFTER the global flag: proves `--db` is stripped, not mistaken
    // for a positional argument.
    const buy = await runCli(
      ["lot", "buy", "--db", sandbox, "518880.SH", "6.12", "2000", "--json"],
      { env },
    );
    expect(buy.exitCode).toBe(0);
    const lotId = JSON.parse(buy.stdout).data.lot_id as string;
    expect(lotId.startsWith("LOT-")).toBe(true);
    expect(existsSync(defaultLedger)).toBe(false);

    const list = await runCli(["lot", "list", "--db", sandbox, "--json"], { env });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data.map((l: any) => l.lot_id)).toContain(lotId);
    expect(existsSync(defaultLedger)).toBe(false);

    const accounts = await runCli(["account", "list", "--db", sandbox, "--json"], { env });
    expect(accounts.exitCode).toBe(0);
    expect(JSON.parse(accounts.stdout).data.length).toBeGreaterThan(0);
    expect(existsSync(defaultLedger)).toBe(false);

    const stats = await runCli(["stats", "--db", sandbox, "--json"], { env });
    expect(stats.exitCode).toBe(0);
    expect(JSON.parse(stats.stdout).code).toBe(0);
    expect(existsSync(defaultLedger)).toBe(false);

    const scan = await runCli(["scan", "--db", sandbox, "--json"], { env });
    expect(scan.exitCode).toBe(0);
    expect(JSON.parse(scan.stdout).code).toBe(0);
    expect(existsSync(defaultLedger)).toBe(false);
  }, 60_000);

  it("accepts `--db` placed before the subcommand token without creating the default ledger", async () => {
    const root = tempRoot("dbprefix");
    const sandbox = join(root, "sandbox.db");
    const defaultLedger = join(root, "default.db");
    const env = cleanEnv({ LOT_TRADER_DB: defaultLedger, TRADE_DB_PATH: defaultLedger });

    const buy = await runCli(
      ["--db", sandbox, "lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
      { env },
    );
    expect(buy.exitCode).toBe(0);

    const list = await runCli(["--db", sandbox, "lot", "list", "--json"], { env });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data.length).toBe(1);
    expect(existsSync(defaultLedger)).toBe(false);

    // `--db` before a help flag must still only print usage, never touch either ledger.
    const help = await runCli(["--db", sandbox, "scan", "--help"], { env });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("usage:");
    expect(existsSync(defaultLedger)).toBe(false);
  }, 30_000);

  it("accepts the `--db=<path>` equals form and still isolates the default ledger", async () => {
    const root = tempRoot("dbeq");
    const sandbox = join(root, "sandbox.db");
    const defaultLedger = join(root, "default.db");
    const env = cleanEnv({ TRADE_DB_PATH: defaultLedger });

    const buy = await runCli(
      ["lot", "buy", `--db=${sandbox}`, "--symbol", "159934.SZ", "--price", "7.10", "--qty", "1000", "--json"],
      { env },
    );
    expect(buy.exitCode).toBe(0);

    const list = await runCli(["lot", "list", `--db=${sandbox}`, "--json"], { env });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data.map((l: any) => l.symbol)).toContain("159934.SZ");
    expect(existsSync(defaultLedger)).toBe(false);
  }, 30_000);

  it("keeps the environment-variable path working when no --db is given", async () => {
    const root = tempRoot("dbenv");
    const envDb = join(root, "env.db");
    const buy = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
      { env: cleanEnv({ LOT_TRADER_DB: envDb }) },
    );
    expect(buy.exitCode).toBe(0);
    expect(existsSync(envDb)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Regression: legitimate invocations keep working
// ---------------------------------------------------------------------------

describe("CLI regression: legitimate invocations are unaffected", () => {
  it("runs the normal lot lifecycle end-to-end without any help flag", async () => {
    const root = tempRoot("lifecycle");
    const ledger = join(root, "ledger.db");
    const env = cleanEnv({ LOT_TRADER_DB: ledger });

    const buy = await runCli(
      ["lot", "buy", "--symbol", "518880.SH", "--price", "6.12", "--qty", "2000", "--json"],
      { env },
    );
    expect(buy.exitCode).toBe(0);
    const lotId = JSON.parse(buy.stdout).data.lot_id as string;

    const close = await runCli(["lot", "close", lotId, "7.05", "--json"], { env });
    expect(close.exitCode).toBe(0);
    expect(JSON.parse(close.stdout).data.lot_status).toBe("CLOSED");

    const stats = await runCli(["stats", "--json"], { env });
    expect(stats.exitCode).toBe(0);
    expect(JSON.parse(stats.stdout).data.total_trades).toBe(1);
  }, 40_000);
});
