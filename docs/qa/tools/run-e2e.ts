#!/usr/bin/env bun
/**
 * run-e2e.ts — tp-5a3bfad8 L2 `line-qa-e2e-flow` 的 E2E 用例执行器 + 证据采集器。
 *
 *   bun docs/qa/tools/run-e2e.ts              # 全量实跑（自建 /tmp 沙箱，收工删除）；**默认只跑不改文档**
 *   bun docs/qa/tools/run-e2e.ts --write     # 全量实跑 + 回写 docs/qa/e2e-test-flow.md 的结果 / 证据路径列
 *   bun docs/qa/tools/run-e2e.ts --list      # 只列用例清单，不执行
 *
 * 文档回写契约（重要）：
 *   - 不带 `--write`：只产出 results.json 与证据，**绝不碰** e2e-test-flow.md（防止顺手的未评审文档变更被提交）；
 *   - 带 `--write`：跑完才回写；且仅限全量运行（筛选运行会跳过，以免把未跑用例写成 PENDING）；
 *   - `--no-writeback`：保留为向后兼容的无操作别名（新版默认即不写）。
 *
 * 隔离铁律（每次 trade 调用都必须同时满足，否则执行器拒绝执行）：
 *   1. 带 `--db /tmp/...`（沙箱路径）；
 *   2. `HOME=<沙箱>/fakehome`（内联重定向，绝不落到真实 HOME）；
 *   3. `LOT_TRADER_DB` / `TRADE_DB_PATH` / `LOT_TRADER_TOKEN_FILE` 全部指向沙箱。
 * 拒绝记录只追加到 `<证据目录>/harness-guard-violations.txt`，且被拒调用不进入 commands.log。
 *
 * 产出（仓库内，/tmp 沙箱收工即删）：
 *   docs/qa/evidence/tp-5a3bfad8-L2-<YYYYMMDD-HHMMSS>-commit-<sha>/
 *     isolation-start.txt / isolation-end.txt   （第一 / 最后一个动作）
 *     commands.log                               （ISO 时间戳 + op id + 完整环境前缀 + 退出码）
 *     <CASE_ID>__<n>.{cmd,stdout,stderr,exit}    （每个执行步一组）
 *     <CASE_ID>__<n>.rows-before.txt / rows-after.txt
 *     <CASE_ID>.json                             （用例级断言与证据清单）
 *     results.json                               （用例 ID → 结果 + 证据路径）
 * 并仅在显式传 `--write`（且为全量运行）时回写 docs/qa/e2e-test-flow.md 的「结果 / 证据路径」两列（不得手填）。
 */
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync, chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve, join } from "node:path";

// ------------------------------------------------------------------ 常量
const REPO = resolve(import.meta.dirname ?? import.meta.dir, "..", "..", "..");
const TRADE = join(REPO, "trade");
const FLOW_MD = join(REPO, "docs/qa/e2e-test-flow.md");
const MATRIX_MD = join(REPO, "docs/qa/user-operation-matrix.md");
const PROD_LEDGER = "/Users/ivywu/.trade/trade.db";
const PROD_TOKEN_DIR = "/Users/ivywu/.lot-trader";
const REPO_DASHBOARD = join(REPO, "lot-trader-global-dashboard.html");
const EXPECTED_PROD_LEDGER_SHA = "1ec361a6474809794841591a5f83bbf042c0159de1536fbed379ce568a2aef59";
const EXPECTED_DASHBOARD_SHA = "697b2a27eac0cdfb41b07a968d8534513a3383daee4b3c909d95b92c4f88e31a";
const EXPECTED_TRADE_SHA = "0447ac7da8f769fe89181eebe7f199e9cd57ba6b577c94cba47017b97cdd64b4";
const PORT_MIN = 18000;
const PORT_MAX = 18999;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TABLES = ["accounts", "symbols", "lots", "trades", "signals", "dividends"] as const;
type Table = typeof TABLES[number];
const LIST_ONLY = process.argv.includes("--list");
/** 供 L4 / 核验员使用：--out <dir> 把证据写到指定目录（沙箱仍固定在 /tmp 下，以维持 --db /tmp/… 隔离铁律）。
 *  文档回写：默认**不写**，只有显式 `--write` 才回写 docs/qa/e2e-test-flow.md。 */
const argOf = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT_DIR = argOf("--out");
/** 文档回写开关：默认 false（只跑不改），必须显式 `--write` 才写。 */
const WRITE_BACK = process.argv.includes("--write");
/** 旧旗标：新版默认即不写，保留以免既有脚本报未知参数。 */
const LEGACY_NO_WRITEBACK = process.argv.includes("--no-writeback");
/** 调试用：QA_E2E_ONLY=<正则> 只跑匹配的用例（正式两次实跑不带该变量，必须全量）。 */
const ONLY = (process.env.QA_E2E_ONLY ?? "").trim();
const selected = () => (ONLY ? CASES.filter((d) => new RegExp(ONLY).test(d.id)) : CASES);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const nowIso = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}+08:00`;
const nowHuman = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0800`;
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number; input?: string } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO,
    encoding: "utf-8",
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 256 * 1024 * 1024,
    env: opts.env ?? process.env,
    input: opts.input,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? (r.error ? -1 : 0), error: r.error ? String(r.error) : "" };
}
const sha256 = (p: string) => (existsSync(p) ? sh("shasum", ["-a", "256", p]).stdout.trim().split(/\s+/)[0] : "(absent)");
const fileMode = (p: string) => (existsSync(p) ? sh("stat", ["-f", "%Lp", p]).stdout.trim() : "(absent)");

// ------------------------------------------------------------------ 沙箱
const RUN_TS = new Date();
const RUN_STAMP = stamp(RUN_TS);
const RUN_HUMAN = nowHuman(RUN_TS);
const SANDBOX = OUT_DIR && resolve(OUT_DIR).startsWith("/tmp/") ? join(resolve(OUT_DIR), "sandbox") : `/tmp/qa-tp5a3bfad8-L2-${RUN_STAMP}`;
const FAKEHOME = join(SANDBOX, "fakehome");
const SANDBOX_DB_DIR = join(SANDBOX, "db");
const SANDBOX_ART = join(SANDBOX, "artifacts");
const SANDBOX_TOKEN = join(FAKEHOME, ".lot-trader", "session.token");
const HEAD = sh("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim();
const COMMIT_SHORT = HEAD.slice(0, 8);
const EVID = OUT_DIR ? resolve(OUT_DIR) : join(REPO, "docs/qa/evidence", `tp-5a3bfad8-L2-${RUN_STAMP}-commit-${COMMIT_SHORT}`);
const GUARD_LOG = join(EVID, "harness-guard-violations.txt");
const COMMANDS_LOG = join(EVID, "commands.log");

function bootstrapSandbox() {
  for (const d of [SANDBOX, FAKEHOME, SANDBOX_DB_DIR, SANDBOX_ART, join(FAKEHOME, ".lot-trader"), EVID]) {
    mkdirSync(d, { recursive: true });
  }
  // 沙箱凭据文件：确保绝不写真实 ~/.lot-trader/
  writeFileSync(join(FAKEHOME, ".gitkeep"), "");
}

/** 隔离快照：内容与 L1 的 isolation-start.txt 同构（可逐行 diff）。 */
function isolationSnapshot(): string {
  const lines: string[] = [];
  lines.push(`TIMESTAMP: ${nowHuman()}`);
  lines.push(`REPO: ${REPO}`);
  lines.push(`HEAD: ${HEAD}`);
  lines.push("");
  lines.push("--- prod ledger ---");
  lines.push(`${sha256(PROD_LEDGER)}  ${PROD_LEDGER}`);
  if (existsSync(PROD_LEDGER)) {
    const st = statSync(PROD_LEDGER);
    lines.push(`size=${st.size} mtime=${nowHuman(st.mtime)} mode=${fileMode(PROD_LEDGER)}`);
  }
  for (const s of ["-wal", "-shm"]) {
    const p = PROD_LEDGER + s;
    lines.push(`${sha256(p)}  ${p}`);
    if (existsSync(p)) { const st = statSync(p); lines.push(`size=${st.size} mtime=${nowHuman(st.mtime)}`); }
  }
  lines.push("");
  lines.push("--- ~/.lot-trader/ listing (without the '..' row) ---");
  if (existsSync(PROD_TOKEN_DIR)) {
    const out = sh("ls", ["-la", PROD_TOKEN_DIR]).stdout.split("\n").filter((l) => l.trim() && !/^total /.test(l) && !/\s\.\.?$/.test(l));
    lines.push(...out);
  } else lines.push("(absent)");
  lines.push("");
  lines.push("--- repo root dashboard html ---");
  lines.push(`${sha256(REPO_DASHBOARD)}  ${REPO_DASHBOARD}`);
  if (existsSync(REPO_DASHBOARD)) { const st = statSync(REPO_DASHBOARD); lines.push(`size=${st.size} mtime=${nowHuman(st.mtime)}`); }
  lines.push("");
  lines.push("--- ./trade binary ---");
  lines.push(`${sha256(TRADE)}  ${TRADE}`);
  if (existsSync(TRADE)) { const st = statSync(TRADE); lines.push(`size=${st.size} mtime=${nowHuman(st.mtime)} mode=${fileMode(TRADE)}`); }
  lines.push("");
  lines.push("--- git status --porcelain ---");
  lines.push(sh("git", ["-C", REPO, "status", "--porcelain"]).stdout.trimEnd() || "(clean)");
  lines.push("(end git status)");
  lines.push("");
  lines.push("--- git status --porcelain -- src tests scripts (expect empty) ---");
  lines.push(sh("git", ["-C", REPO, "status", "--porcelain", "--", "src", "tests", "scripts"]).stdout.trimEnd());
  lines.push("(end)");
  lines.push("");
  lines.push("--- protected docs sha256 ---");
  for (const f of ["docs/qa/acceptance-cases.md", "docs/qa/evidence-template.md", "docs/qa/regression-baseline.md",
    "docs/qa/release-gate.md", "docs/qa/safety-checklist.md", "docs/qa/reports/release-gate-report-latest.md"]) {
    lines.push(`${sha256(join(REPO, f))}  ${join(REPO, f)}`);
  }
  lines.push("");
  lines.push("--- evidence dirs ---");
  const evRoot = join(REPO, "docs/qa/evidence");
  if (existsSync(evRoot)) lines.push(...readdirSync(evRoot).filter((e) => !/^\./.test(e)).sort());
  lines.push("");
  lines.push("--- listeners on 127.0.0.1:18000-18999 ---");
  const lsof = sh("lsof", ["-nP", "-iTCP:18000-18999", "-sTCP:LISTEN"]).stdout.trim();
  lines.push(lsof ? lsof : "(none)");
  lines.push("(end listeners)");
  lines.push("");
  lines.push("--- prod hash expectation ---");
  lines.push(`prod_ledger_expected=${EXPECTED_PROD_LEDGER_SHA} matches=${sha256(PROD_LEDGER) === EXPECTED_PROD_LEDGER_SHA}`);
  lines.push(`repo_dashboard_expected=${EXPECTED_DASHBOARD_SHA} matches=${sha256(REPO_DASHBOARD) === EXPECTED_DASHBOARD_SHA}`);
  lines.push(`trade_binary_expected=${EXPECTED_TRADE_SHA} matches=${sha256(TRADE) === EXPECTED_TRADE_SHA}`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ 守卫
type ExecResult = {
  op: string; step: number; provider: string; cmd: string; argv: string[];
  exit: number; stdout: string; stderr: string; refused: boolean; startedAt: string; ms: number;
  rowsBefore?: Record<string, number>; rowsAfter?: Record<string, number>;
  files: string[];
};

let STEP_SEQ = 0;
const guardViolations: string[] = [];

function refuse(reason: string, op: string, cmd: string): ExecResult {
  const rec = `${nowIso()} | GUARD-REFUSED | op=${op} | reason=${reason} | cmd=${cmd}`;
  appendFileSync(GUARD_LOG, rec + "\n");
  guardViolations.push(rec);
  return { op, step: ++STEP_SEQ, provider: "guard", cmd, argv: [], exit: -9, stdout: "", stderr: `GUARD_VIOLATION: ${reason}`, refused: true, startedAt: nowIso(), ms: 0, files: [] };
}

function dbRows(db: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(db)) { for (const t of TABLES) out[t] = 0; return { ...out, __nodb: 1 }; }
  const q = TABLES.map((t) => `select '${t}'||'='||coalesce((select count(*) from ${t}),0)`).join(" union all ");
  const r = sh("sqlite3", [db, `${q};`], { timeout: 30_000 });
  for (const t of TABLES) out[t] = 0;
  for (const line of r.stdout.split("\n")) {
    const m = /^(\w+)=(\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** 唯一的 trade 执行口：所有 trade 调用都必须过这道守卫。 */
function runTradeGuarded(op: string, args: string[], extraEnv: Record<string, string> = {}, opts: { noGuard?: boolean } = {}): ExecResult {
  const step = ++STEP_SEQ;
  const dbIdx = args.indexOf("--db");
  const db = dbIdx >= 0 ? args[dbIdx + 1] : undefined;
  const cmd = `./trade ${args.join(" ")}`;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: FAKEHOME,
    LOT_TRADER_DB: db ?? SANDBOX_DB_DIR + "/unset.db",
    TRADE_DB_PATH: db ?? SANDBOX_DB_DIR + "/unset.db",
    LOT_TRADER_TOKEN_FILE: SANDBOX_TOKEN,
    ...extraEnv,
  };
  if (!opts.noGuard) {
    if (!db) return refuse("missing --db", op, cmd);
    if (!db.startsWith("/tmp/")) return refuse(`--db not under /tmp/: ${db}`, op, cmd);
    if (!db.startsWith(SANDBOX)) return refuse(`--db outside sandbox: ${db}`, op, cmd);
    if (env.HOME !== FAKEHOME) return refuse(`HOME not sandboxed: ${env.HOME}`, op, cmd);
  }
  const t0 = Date.now();
  const startedAt = nowIso();
  const rowsBefore = db ? dbRows(db) : undefined;
  const r = spawnSync(TRADE, args, { cwd: REPO, encoding: "utf-8", timeout: 90_000, maxBuffer: 256 * 1024 * 1024, env });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const exit = r.status ?? -1;
  const rowsAfter = db ? dbRows(db) : undefined;
  const ms = Date.now() - t0;
  const res: ExecResult = { op, step, provider: "trade", cmd, argv: args, exit, stdout, stderr, refused: false, startedAt, ms, rowsBefore, rowsAfter, files: [] };
  writeStepEvidence(res, env);
  appendFileSync(COMMANDS_LOG, `${startedAt} | op=${op}#${step} | cwd=${REPO} | env{HOME=${env.HOME} LOT_TRADER_DB=${env.LOT_TRADER_DB} TRADE_DB_PATH=${env.TRADE_DB_PATH} LOT_TRADER_TOKEN_FILE=${env.LOT_TRADER_TOKEN_FILE}${Object.entries(extraEnv).filter(([k]) => !["HOME", "LOT_TRADER_DB", "TRADE_DB_PATH", "LOT_TRADER_TOKEN_FILE"].includes(k)).map(([k, v]) => ` ${k}=${v}`).join("")}} | exit=${exit} | ms=${ms} | cmd=${cmd}\n`);
  return res;
}

const opFile = (op: string) => op.replace(/[^A-Za-z0-9_.-]/g, "-");
function writeStepEvidence(res: ExecResult, env: Record<string, string>) {
  const base = join(EVID, `${opFile(res.op)}__${res.step}`);
  const w = (suffix: string, text: string) => { const p = `${base}.${suffix}`; writeFileSync(p, text); res.files.push(p); return p; };
  w("cmd", `# provider=${res.provider}\n# startedAt=${res.startedAt}\n# exit=${res.exit}\n# env: HOME=${env.HOME ?? ""} LOT_TRADER_DB=${env.LOT_TRADER_DB ?? ""} TRADE_DB_PATH=${env.TRADE_DB_PATH ?? ""} LOT_TRADER_TOKEN_FILE=${env.LOT_TRADER_TOKEN_FILE ?? ""}\n$ ${res.cmd}\n`);
  w("stdout", res.stdout);
  w("stderr", res.stderr);
  w("exit", `${res.exit}\n`);
  if (res.rowsBefore) w("rows-before.txt", renderRows(res.rowsBefore));
  if (res.rowsAfter) w("rows-after.txt", renderRows(res.rowsAfter));
}
const renderRows = (rows: Record<string, number>) => Object.entries(rows).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

function delta(res: ExecResult, table: Table): number {
  if (!res.rowsBefore || !res.rowsAfter) return 0;
  return (res.rowsAfter[table] ?? 0) - (res.rowsBefore[table] ?? 0);
}

// ------------------------------------------------------------------ HTTP / serve / 其它 provider
type HttpResult = { op: string; step: number; cmd: string; status: number; headers: string; body: string; files: string[]; ms: number; bodyJson?: any };

/** 本 runner 拉起过的所有子进程：用例抛异常时也必须回收，不留残留监听。 */
const LIVE_CHILDREN = new Map<number, { child: ChildProcess; args: string[]; port: number }>();
function reapLeftovers(where: string): string[] {
  const killed: string[] = [];
  for (const [pid, rec] of LIVE_CHILDREN) {
    if (rec.child.exitCode === null && !rec.child.killed) {
      try { rec.child.kill("SIGKILL"); } catch { /* noop */ }
      killed.push(`pid=${pid} port=${rec.port} args=${rec.args.join(" ")}`);
    }
    LIVE_CHILDREN.delete(pid);
  }
  if (killed.length) appendFileSync(join(EVID, "harness-leftover-children.txt"), `${nowIso()} | reaped@${where} | ${killed.join(" ; ")}\n`);
  return killed;
}
process.on("exit", () => { reapLeftovers("process-exit"); });
process.on("SIGINT", () => { reapLeftovers("SIGINT"); process.exit(130); });
process.on("SIGTERM", () => { reapLeftovers("SIGTERM"); process.exit(143); });

class Ctx {
  id: string; def: CaseDef; db: string; steps: ExecResult[] = []; httpSteps: HttpResult[] = [];
  asserts: { label: string; ok: boolean; detail?: string }[] = [];
  notes: string[] = [];
  blocked?: string;
  private booted = false;
  constructor(def: CaseDef) {
    this.def = def; this.id = def.id;
    this.db = def.dbSuite ? join(SANDBOX_DB_DIR, `${def.dbSuite}.db`) : join(SANDBOX_DB_DIR, "__harness__.db");
  }
  /** 用例开跑前的沙箱建库预热：用真实命令在空库上自举 schema（DEFAULT 账户 + 种子标的），
   *  使后续每个步骤的行数差都是「自包含」的干净基线；freshDb 用例（验证 --help/首次自举）跳过。 */
  private bootstrapOnce(): void {
    if (this.booted) return;
    this.booted = true;
    if (this.def.freshDb || !this.def.dbSuite) return;
    const r = runTradeGuarded(`${this.id}/bootstrap`, ["account", "list", "--json", "--db", this.db]);
    r.provider = "bootstrap";
    this.steps.push(r);
  }
  // ---- trade
  async trade(sub: string, args: string[], extraEnv: Record<string, string> = {}): Promise<ExecResult> {
    this.bootstrapOnce();
    const full = [...sub.split(/\s+/).filter(Boolean), ...args];
    if (!args.includes("--db")) full.push("--db", this.db);
    const r = runTradeGuarded(this.id, full, extraEnv);
    this.steps.push(r);
    return r;
  }
  /** 完整 argv（用于验证 `--db` 位置无关等场景），仍受同一守卫约束。 */
  async tradeArgv(argv: string[], extraEnv: Record<string, string> = {}): Promise<ExecResult> {
    this.bootstrapOnce();
    const full = argv.includes("--db") ? argv : [...argv, "--db", this.db];
    const r = runTradeGuarded(this.id, full, extraEnv);
    this.steps.push(r);
    return r;
  }
  /** 隔离守卫实弹自检：故意提交违规调用，必须被拒。 */
  guardProbe(what: "no-db" | "foreign-home" | "foreign-db"): ExecResult {
    let r: ExecResult;
    if (what === "no-db") r = runTradeGuarded(this.id, ["account", "list", "--json"]);
    else if (what === "foreign-home") r = runTradeGuarded(this.id, ["account", "list", "--json", "--db", this.db], { HOME: "/Users/ivywu", LOT_TRADER_DB: this.db, TRADE_DB_PATH: this.db });
    else r = runTradeGuarded(this.id, ["account", "list", "--json", "--db", "/Users/ivywu/.trade/trade.db"]);
    this.steps.push(r);
    return r;
  }
  // ---- sqlite（沙箱内直接观测/注入，记录为独立 provider）
  sql(statement: string, opts: { expectChange?: boolean } = {}): ExecResult {
    this.bootstrapOnce();
    const step = ++STEP_SEQ;
    const t0 = Date.now(); const startedAt = nowIso();
    const rowsBefore = dbRows(this.db);
    const r = sh("sqlite3", [this.db, statement], { timeout: 30_000 });
    const rowsAfter = dbRows(this.db);
    const res: ExecResult = { op: this.id, step, provider: "sqlite", cmd: `sqlite3 ${this.db} "${statement}"`, argv: [statement], exit: r.status, stdout: r.stdout, stderr: r.stderr, refused: false, startedAt, ms: Date.now() - t0, rowsBefore, rowsAfter, files: [] };
    writeStepEvidence(res, { HOME: "-", LOT_TRADER_DB: "-", TRADE_DB_PATH: "-", LOT_TRADER_TOKEN_FILE: "-" });
    appendFileSync(COMMANDS_LOG, `${startedAt} | op=${this.id}#${step} | cwd=${REPO} | provider=sqlite | exit=${r.status} | ms=${res.ms} | cmd=sqlite3 ${this.db} "${statement}"\n`);
    this.steps.push(res);
    return res;
  }
  async fs(label: string, fn: () => Promise<string[] | void> | string[] | void): Promise<void> {
    const step = ++STEP_SEQ;
    const startedAt = nowIso();
    const t0 = Date.now();
    let err = "";
    let artifacts: string[] = [];
    try { const r = await fn(); if (Array.isArray(r)) artifacts = r.filter((x) => typeof x === "string" && existsSync(x)); } catch (e) { err = String(e); }
    const res: ExecResult = { op: this.id, step, provider: "fs", cmd: label, argv: [], exit: err ? 1 : 0, stdout: err, stderr: "", refused: false, startedAt, ms: Date.now() - t0, files: artifacts };
    writeStepEvidence(res, { HOME: "-", LOT_TRADER_DB: "-", TRADE_DB_PATH: "-", LOT_TRADER_TOKEN_FILE: "-" });
    appendFileSync(COMMANDS_LOG, `${startedAt} | op=${this.id}#${step} | cwd=${REPO} | provider=fs | exit=${res.exit} | ms=${res.ms} | cmd=${label}\n`);
    this.steps.push(res);
  }
  // ---- HTTP
  async http(method: string, url: string, opts: { headers?: string[]; label?: string; raw?: string[] } = {}): Promise<HttpResult> {
    const step = ++STEP_SEQ;
    const hdrArgs = (opts.headers ?? []).flatMap((h) => ["-H", h]);
    const args = ["-s", "-i", "-X", method, ...hdrArgs, ...(opts.raw ?? []), url];
    const t0 = Date.now(); const startedAt = nowIso();
    const r = sh("curl", args, { timeout: 30_000 });
    const raw = r.stdout;
    const m = /^HTTP\/[\d.]+\s+(\d+)/.exec(raw);
    const status = m ? Number(m[1]) : 0;
    const sep = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
    const headers = raw.slice(0, sep);
    const body = raw.slice(sep);
    let bodyJson: any;
    try { bodyJson = JSON.parse(body.slice(body.indexOf("{"))); } catch { /* not json */ }
    const res: HttpResult = { op: this.id, step, cmd: `curl -s -i -X ${method} ${(opts.headers ?? []).join(" ")} ${(opts.raw ?? []).join(" ")} ${url}`.replace(/\s+/g, " "), status, headers, body, files: [], ms: Date.now() - t0, bodyJson };
    const base = join(EVID, `${this.id}__${step}`);
    for (const [suffix, text] of [["http-cmd", `# startedAt=${startedAt}\n$ ${res.cmd}\n`], ["http-status", `${status}\n`], ["http-headers", headers], ["http-body", body]] as const) {
      const p = `${base}.${suffix}`; writeFileSync(p, text); res.files.push(p);
    }
    appendFileSync(COMMANDS_LOG, `${startedAt} | op=${this.id}#${step} | cwd=${REPO} | provider=curl | exit=${r.status} | http=${status} | ms=${res.ms} | cmd=${res.cmd}\n`);
    this.httpSteps.push(res);
    return res;
  }
  // ---- serve（子进程加入全局回收表；启动即落一份证据，stop() 再落停机证据）
  async serve(opts: { port?: number; args?: string[]; tokenFile?: string; explicitToken?: string; waitHealth?: boolean; json?: boolean } = {}): Promise<ServeSession> {
    this.bootstrapOnce();
    const port = opts.port ?? (await freePort());
    const tokenFile = opts.tokenFile ?? join(SANDBOX_ART, `${this.id}.token`);
    const args = ["serve", "--db", this.db, "--host", "127.0.0.1", "--port", String(port)];
    if (opts.json !== false) args.push("--json");
    if (opts.tokenFile !== "-") args.push("--token-file", tokenFile);
    if (opts.explicitToken) args.push("--token", opts.explicitToken);
    args.push(...(opts.args ?? []));
    const step = ++STEP_SEQ;
    const startedAt = nowIso();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>, HOME: FAKEHOME, LOT_TRADER_DB: this.db,
      TRADE_DB_PATH: this.db, LOT_TRADER_TOKEN_FILE: SANDBOX_TOKEN,
    };
    const cmd = `./trade ${args.join(" ")}`;
    const rowsBefore = dbRows(this.db);
    const bef = listenersOn(port);
    const child = spawn(TRADE, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) LIVE_CHILDREN.set(child.pid, { child, args, port });
    let out = ""; let err = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    let stopped = false;
    const session = {
      port, tokenFile, child, op: this.id, step, cmd, startedAt, rowsBefore, listenersBefore: bef,
      get stdout() { return out; }, get stderr() { return err; },
      readToken: () => (existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() : ""),
      stop: async (signal: NodeJS.Signals = "SIGTERM"): Promise<ExecResult> => {
        if (stopped) return this.steps[this.steps.length - 1];
        stopped = true;
        const exited: Promise<number> = new Promise((res) => child.on("exit", (code) => res(code ?? -1)));
        if (child.exitCode === null && !child.killed) child.kill(signal);
        const code = await Promise.race([exited, sleep(8000).then(() => -1)]);
        if (child.pid) LIVE_CHILDREN.delete(child.pid);
        await sleep(250);
        const released = await waitPortFree(port, 3000);
        const after = listenersOn(port);
        const res: ExecResult = {
          op: this.id, step, provider: "serve-stop", cmd, argv: args, exit: code, stdout: out, stderr: err,
          refused: false, startedAt, ms: Date.now() - Date.parse(startedAt), rowsBefore, rowsAfter: dbRows(this.db), files: [],
        };
        writeStepEvidence(res, env);
        const base = join(EVID, `${this.id}__${step}`);
        for (const [suffix, text] of [
          ["port-release.txt", `port=${port}\nsignal=${signal}\nexit=${code}\nreleased_within_3s=${released}\nlisteners_before=${bef || "(none)"}\nlisteners_after=${after || "(none)"}\n`],
          ["serve-stdout.txt", out], ["serve-stderr.txt", err],
        ] as const) { const p = `${base}.${suffix}`; writeFileSync(p, text); res.files.push(p); }
        appendFileSync(COMMANDS_LOG, `${startedAt} | op=${this.id}#${step} | cwd=${REPO} | env{HOME=${env.HOME} LOT_TRADER_DB=${env.LOT_TRADER_DB} TRADE_DB_PATH=${env.TRADE_DB_PATH} LOT_TRADER_TOKEN_FILE=${env.LOT_TRADER_TOKEN_FILE}} | exit=${code} | signal=${signal} | port=${port} | released=${released} | ms=${res.ms} | cmd=${cmd}\n`);
        this.steps.push(res);
        return res;
      },
    } as unknown as ServeSession;
    // 等待 ready / health
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    for (let i = 0; i < 60; i++) {
      const r = sh("curl", ["-s", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", healthUrl], { timeout: 5000 });
      if (r.stdout.trim() === "200") break;
      if (child.exitCode !== null) break;
      await sleep(200);
    }
    session.healthOk = sh("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", healthUrl]).stdout.trim() === "200";
    // 启动证据：即使用例后续抛异常也有留痕
    const startRes: ExecResult = {
      op: this.id, step, provider: "serve-start", cmd, argv: args, exit: session.healthOk ? 0 : -1, stdout: out, stderr: err,
      refused: false, startedAt, ms: Date.now() - Date.parse(startedAt), rowsBefore, rowsAfter: dbRows(this.db), files: [],
    };
    writeStepEvidence(startRes, env);
    const sbase = join(EVID, `${this.id}__${step}`);
    for (const [suffix, text] of [["serve-start-listener.txt", `port=${port}\nhealth_200=${session.healthOk}\nlisteners_before=${bef || "(none)"}\nlisteners_now=${listenersOn(port) || "(none)"}\n`]] as const) {
      const p = `${sbase}.${suffix}`; writeFileSync(p, text); startRes.files.push(p);
    }
    appendFileSync(COMMANDS_LOG, `${startedAt} | op=${this.id}#${step} | cwd=${REPO} | env{HOME=${env.HOME} LOT_TRADER_DB=${env.LOT_TRADER_DB} TRADE_DB_PATH=${env.TRADE_DB_PATH} LOT_TRADER_TOKEN_FILE=${env.LOT_TRADER_TOKEN_FILE}} | exit=${startRes.exit} | start=serve | health=${session.healthOk} | port=${port} | ms=${startRes.ms} | cmd=${cmd}\n`);
    this.steps.push(startRes);
    return session;
  }
  // ---- 断言
  expect(label: string, ok: boolean, detail = ""): void { this.asserts.push({ label, ok, detail }); }
  expectExit(res: ExecResult, want: number | "nonzero" | "zero", label?: string): void {
    const ok = want === "nonzero" ? res.exit !== 0 : want === "zero" ? res.exit === 0 : res.exit === want;
    this.expect(label ?? `exit ${want === "nonzero" ? "≠0" : want === "zero" ? "=0" : `=${want}`}`, ok, `actual exit=${res.exit}${res.refused ? " (GUARD_VIOLATION)" : ""}`);
  }
  expectDelta(res: ExecResult, table: Table, want: number, label?: string): void {
    const d = delta(res, table);
    this.expect(label ?? `${table} Δ=${want > 0 ? "+" : ""}${want}`, d === want, `actual Δ=${d} (before=${res.rowsBefore?.[table]} after=${res.rowsAfter?.[table]})`);
  }
  expectDeltaAll(res: ExecResult, want: number, label?: string): void {
    for (const t of TABLES) this.expectDelta(res, t, want, `${label ?? "全表行数不变"} · ${t}`);
  }
  expectText(res: ExecResult, re: RegExp, label?: string): void {
    const hay = res.stdout + res.stderr;
    this.expect(label ?? `输出匹配 ${re}`, re.test(hay), `matched=${re.test(hay)} · text=${JSON.stringify(hay.slice(0, 200))}`);
  }
  expectNoText(res: ExecResult, re: RegExp, label?: string): void {
    const hay = res.stdout + res.stderr;
    this.expect(label ?? `输出不得匹配 ${re}`, !re.test(hay), `matched=${re.test(hay)}`);
  }
  expectHttpStatus(res: HttpResult, want: number | "4xx" | "2xx", label?: string): void {
    const ok = typeof want === "number" ? res.status === want : want === "4xx" ? res.status >= 400 && res.status < 500 : res.status >= 200 && res.status < 300;
    this.expect(label ?? `HTTP ${want}`, ok, `actual HTTP ${res.status}`);
  }
  expectTrue(label: string, ok: boolean, detail = ""): void { this.expect(label, ok, detail); }
  block(reason: string): void { this.blocked = reason; this.notes.push(`BLOCKED: ${reason}`); }
  note(s: string): void { this.notes.push(s); }
  json(res: ExecResult): any { try { return JSON.parse(res.stdout); } catch { return undefined; } }
}

type ServeSession = {
  port: number; tokenFile: string; child: ChildProcess; op: string; step: number; cmd: string; startedAt: string;
  rowsBefore: Record<string, number>; listenersBefore: string; healthOk?: boolean;
  readonly stdout: string; readonly stderr: string;
  readToken(): string;
  stop(signal?: NodeJS.Signals): Promise<ExecResult>;
};

function listenersOn(port: number): string {
  return sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).stdout.trim().split("\n").slice(1).join(" | ");
}
async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    const free = await new Promise<boolean>((res) => {
      const s: Server = createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) return p;
  }
  throw new Error("no free port in 18000-18999");
}
async function waitPortFree(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(port, "127.0.0.1");
    });
    if (free) return true;
    await sleep(120);
  }
  return false;
}

// ------------------------------------------------------------------ 用例框架
type Kind = "positive" | "violation" | "legal" | "pair_na";
type CaseDef = {
  id: string; stage: number; kind: Kind; guards: string[]; dbSuite: string;
  /** true = 本用例依赖「数据库文件尚不存在」这一前提（自举类断言），不得自动预热建库 */
  freshDb?: boolean;
  title: string; source: string; expect: string; run: (c: Ctx) => Promise<void>;
};
const CASES: CaseDef[] = [];
function C(def: CaseDef) { CASES.push(def); }

const caseResults = new Map<string, { kind: Kind; guards: string[]; result: string; blockedReason?: string; evidence: string[]; asserts: { label: string; ok: boolean; detail?: string }[] }>();

async function runCase(def: CaseDef) {
  const c = new Ctx(def);
  let result: string;
  try {
    await def.run(c);
    const failed = c.asserts.filter((a) => !a.ok);
    result = c.blocked ? "BLOCKED" : def.kind === "pair_na" ? "pair_na" : failed.length ? "FAIL" : "PASS";
  } catch (e) {
    c.asserts.push({ label: "执行期异常（harness error）", ok: false, detail: String(e) });
    result = "FAIL";
  }
  const stepsMeta = c.steps.map((s) => ({ n: s.step, provider: s.provider, cmd: s.cmd, exit: s.exit, refused: s.refused, ms: s.ms, files: s.files.map((f) => f.replace(REPO + "/", "")), deltas: s.rowsBefore && s.rowsAfter ? Object.fromEntries(TABLES.map((t) => [t, delta(s, t)])) : {} }));
  const evidence = [...new Set([...c.steps.flatMap((s) => s.files), ...c.httpSteps.flatMap((h) => h.files)])].map((f) => f.replace(REPO + "/", ""));
  const caseJson = {
    id: def.id, kind: def.kind, guards: def.guards, title: def.title, expect: def.expect, source: def.source,
    db: c.db, result, blockedReason: c.blocked, notes: c.notes, asserts: c.asserts, steps: stepsMeta,
  };
  const p = join(EVID, `${def.id}.json`);
  writeFileSync(p, JSON.stringify(caseJson, null, 2));
  evidence.unshift(p.replace(REPO + "/", ""));
  const rowsMd = [`# ${def.id} 逐表行数变化（写库前后）`, "", "| step | provider | exit | " + TABLES.map((t) => `${t}`).join(" | ") + " |", "|---|---|---|" + TABLES.map(() => "---").join("|") + "|"];
  for (const s of c.steps) {
    rowsMd.push(`| ${s.step} | ${s.provider} | ${s.exit} | ${TABLES.map((t) => (s.rowsBefore ? `${s.rowsBefore[t]}→${s.rowsAfter?.[t]} (${delta(s, t) >= 0 ? "+" : ""}${delta(s, t)})` : "—")).join(" | ")} |`);
  }
  const p2 = join(EVID, `${def.id}.rows.md`);
  writeFileSync(p2, rowsMd.join("\n") + "\n");
  evidence.push(p2.replace(REPO + "/", ""));
  caseResults.set(def.id, { kind: def.kind, guards: def.guards, result, blockedReason: c.blocked, evidence, asserts: c.asserts });
  return result;
}

// ================================================================== 用例定义
// ------------------------------------------------ 用例辅助
const ACCT = "CMB_MAIN";
function sqlOne(db: string, q: string): string { return sh("sqlite3", [db, q]).stdout.trim(); }
function dataOf(c: Ctx, res: ExecResult, label: string): any {
  const j = c.json(res);
  c.expectTrue(`${label} 返回可解析 JSON（code=0）`, !!j && (j.code === 0 || j.code === undefined), `stdout 头部=${JSON.stringify(res.stdout.slice(0, 160))}`);
  return j?.data;
}
async function currentPrice(c: Ctx, symbol: string): Promise<number> {
  const r = await c.trade("physics", [symbol, "--json"]);
  const d = c.json(r)?.data;
  const p = Number(d?.current_price ?? d?.physics?.current_price);
  c.expectTrue(`行情可用 ${symbol}`, Number.isFinite(p) && p > 0, `current_price=${p}`);
  return p;
}
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const r4 = (n: number) => Math.round(n * 10000) / 10000;

C({
  id: "E2E-P-01", stage: 0, kind: "positive", guards: [], dbSuite: "p01-help", freshDb: true,
  title: "help 是零写库只读操作：根级 --help 不建库",
  source: "MANUAL.md §核心交互铁律 7（任何层级 -h/--help 都是零写库的纯只读操作）；./trade --help",
  expect: "exit 0 · 输出含 usage 与九个一级子命令 · 六表行数全 0（不得创建数据库文件）",
  run: async (c) => {
    const r = await c.tradeArgv(["--help"]);
    c.expectExit(r, 0);
    c.expectText(r, /usage: trade/, "输出含 usage");
    for (const sub of ["lot", "account", "position", "scan", "stats", "physics", "dashboard", "serve", "dividend"]) {
      c.expectText(r, new RegExp(`\\b${sub}\\b`), `子命令清单含 ${sub}`);
    }
    c.expectTrue("数据库文件未被创建", !existsSync(c.db), `db=${c.db} exists=${existsSync(c.db)}`);
    c.expectTrue("无任何库内表行数", TABLES.every((t) => (dbRows(c.db)[t] ?? 0) === 0), `rows=${JSON.stringify(dbRows(c.db))}`);
  },
});

C({
  id: "E2E-P-02", stage: 0, kind: "positive", guards: [], dbSuite: "p02-bootstrap", freshDb: true,
  title: "空库自举：account list 建库并初始化 schema",
  source: "MANUAL.md 命令速查（account list）；L1 矩阵 G-DB-BAD-PARENT（--db 指向不存在路径时自动建库）",
  expect: "exit 0 · 数据库文件被创建且六表齐备 · accounts 表 0 行（不写业务数据）",
  run: async (c) => {
    const r = await c.trade("account list", ["--json"]);
    c.expectExit(r, 0);
    c.expectTrue("数据库文件已创建", existsSync(c.db), `db=${c.db}`);
    const names = sqlOne(c.db, "select group_concat(name,',') from sqlite_master where type='table';").split(",");
    for (const t of TABLES) c.expectTrue(`表 ${t} 存在`, names.includes(t), `tables=${names.join(",")}`);
    c.expectTrue("accounts 仅含自举的默认账户（1 行）", Number(sqlOne(c.db, "select count(*) from accounts;")) === 1, `rows=${sqlOne(c.db, "select count(*) from accounts;")}`);
    for (const t of ["lots", "trades", "signals", "dividends"] as const) c.expectDelta(r, t, 0, `${t} 不因 list 写入`);
    c.expectTrue("符号表已初始化", Number(sqlOne(c.db, "select count(*) from symbols;")) > 0, `symbols=${sqlOne(c.db, "select count(*) from symbols;")}`);
  },
});

C({
  id: "E2E-N-01", stage: 0, kind: "violation", guards: ["G-01"], dbSuite: "n01-guard-self",
  title: "采集器隔离守卫实弹自检：缺 --db / 外部 HOME / 生产库路径一律执行前被拒",
  source: "safety-checklist.md §1.1/§1.2（严禁读写生产账本、必须显式 --db /tmp/…）；本线 run-e2e.ts 守卫",
  expect: "三次调用全部 exit=GUARD_VIOLATION（未执行）· 拒绝行只追加到 harness-guard-violations.txt · 被拒调用不进入 commands.log · 生产账本 sha256 不变",
  run: async (c) => {
    const a = c.guardProbe("no-db");
    const b = c.guardProbe("foreign-home");
    const d = c.guardProbe("foreign-db");
    for (const [i, r] of [a, b, d].entries()) {
      c.expectTrue(`第 ${i + 1} 次违规调用被拒（refused=true）`, r.refused === true, `refused=${r.refused} exit=${r.exit}`);
      c.expectTrue(`第 ${i + 1} 次违规调用未执行任何命令`, r.provider === "guard" && r.argv.length === 0, `provider=${r.provider}`);
    }
    c.expectTrue("违规文件含 3 条实弹自检拒绝行", guardViolations.filter((l) => l.includes("GUARD-REFUSED")).length >= 3, `count=${guardViolations.length}`);
    c.expectTrue("生产账本 sha256 与基准一致", sha256(PROD_LEDGER) === EXPECTED_PROD_LEDGER_SHA, `actual=${sha256(PROD_LEDGER)}`);
    c.expectTrue("~/.lot-trader/ 未被触碰", existsSync(PROD_TOKEN_DIR) && readdirSync(PROD_TOKEN_DIR).join(",") === "session.token.stale-bak", `listing=${existsSync(PROD_TOKEN_DIR) ? readdirSync(PROD_TOKEN_DIR).join(",") : "(absent)"}`);
  },
});

C({
  id: "E2E-P-03", stage: 0, kind: "legal", guards: ["G-01"], dbSuite: "p03-guard-control",
  title: "守卫对照：同一命令在沙箱 --db/HOME 下正常执行（不误拦）",
  source: "safety-checklist.md §1.1/§1.2；L1 矩阵 G-01 合法侧「全部放行，未被误杀」",
  expect: "exit 0 · 建库并初始化 schema · 沙箱内执行（生产账本不受影响）",
  run: async (c) => {
    const r = await c.trade("account list", ["--json"]);
    c.expectExit(r, 0);
    c.expectTrue("沙箱库已就绪", existsSync(c.db), `${c.db}`);
    c.expectTrue("生产账本 sha256 与基准一致", sha256(PROD_LEDGER) === EXPECTED_PROD_LEDGER_SHA, `actual=${sha256(PROD_LEDGER)}`);
  },
});

C({
  id: "E2E-N-02", stage: 0, kind: "violation", guards: ["G-02"], dbSuite: "n02-env-precedence",
  title: "环境变量不得压过显式 --db：哨兵库必须保持不存在",
  source: "MANUAL.md §全局选项（优先级 --db > $LOT_TRADER_DB > $TRADE_DB_PATH > ~/.trade/trade.db）；L1 矩阵 G-02 预期",
  expect: "exit 0 · 写入落在 --db 指定库（accounts+1）· LOT_TRADER_DB/TRADE_DB_PATH 指向的哨兵库文件始终不存在",
  run: async (c) => {
    const sentinel = join(SANDBOX_DB_DIR, "n02-sentinel-must-not-exist.db");
    rmSync(sentinel, { force: true });
    const r = await c.trade("account add", ["ENVOVER", "--name", "ENVOVER", "--json"], { LOT_TRADER_DB: sentinel, TRADE_DB_PATH: sentinel });
    c.expectExit(r, 0);
    c.expectDelta(r, "accounts", 1, "accounts 落在 --db 指定库 +1");
    c.expectTrue("哨兵库未被创建（环境变量未胜出）", !existsSync(sentinel), `sentinel=${sentinel} exists=${existsSync(sentinel)}`);
    c.expectTrue("账户确实落在 --db 指定库", sqlOne(c.db, "select count(*) from accounts where account_id='ENVOVER';") === "1", `rows=${sqlOne(c.db, "select count(*) from accounts where account_id='ENVOVER';")}`);
  },
});

C({
  id: "E2E-N-03", stage: 0, kind: "legal", guards: ["G-02"], dbSuite: "n03-db-position",
  title: "--db 位置无关：放在子命令之前同样生效",
  source: "MANUAL.md §全局选项（支持位置穿插）；L1 矩阵 G-02 预期「--db 位置无关」",
  expect: "exit 0 · accounts+1 且落在 --db 指定库",
  run: async (c) => {
    const r = await c.tradeArgv(["--db", c.db, "account", "add", "POSFIRST", "--name", "POSFIRST", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "accounts", 1);
    c.expectTrue("账户落在 --db 指定库", sqlOne(c.db, "select count(*) from accounts where account_id='POSFIRST';") === "1", "count=1");
  },
});

C({
  id: "E2E-N-04", stage: 0, kind: "violation", guards: ["G-03"], dbSuite: "n04-env-priority",
  title: "环境变量之间的优先级（LOT_TRADER_DB vs TRADE_DB_PATH）观测",
  source: "MANUAL.md §全局选项优先级；本话题隔离规则（每次调用必须带 --db /tmp/…）",
  expect: "BLOCKED · 缺失能力：需要一次不带 --db 的调用来观测 LOT_TRADER_DB 与 TRADE_DB_PATH 的优先级，而本线验收标准（每次调用必须带 --db /tmp/…）禁止这种调用；需老板授权一次不带 --db 的沙箱调用",
  run: async (c) => {
    c.block("缺失能力：不带 --db 的授权调用（观测 LOT_TRADER_DB vs TRADE_DB_PATH 的优先级必须去掉 --db，与本线隔离铁律冲突）");
    c.note("MANUAL.md §全局选项声明优先级为 --db > $LOT_TRADER_DB > $TRADE_DB_PATH > ~/.trade/trade.db，但该级回退无法在带 --db 的前提下实测。");
    c.expectTrue("本用例不产出可判定断言（BLOCKED）", true, "blocked");
  },
});

C({
  id: "E2E-N-05", stage: 0, kind: "legal", guards: ["G-03"], dbSuite: "n05-default-path",
  title: "默认账本路径回退（不带 --db 时落到 ~/.trade/trade.db）观测",
  source: "MANUAL.md §全局选项（默认 ~/.trade/trade.db）；本话题隔离规则",
  expect: "BLOCKED · 缺失能力：该级回退会解析到生产账本，本话题明令禁止读写；不得为了跑用例触碰生产账本",
  run: async (c) => {
    c.block("默认路径回退会解析到生产账本 ~/.trade/trade.db，本话题禁止读写生产账本");
    c.note("候选口径：由老板授权一次 HOME 重定向 + 不传 --db 的调用后单独验证。");
    c.expectTrue("本用例不产出可判定断言（BLOCKED）", true, "blocked");
    c.expectTrue("生产账本 sha256 与基准一致", sha256(PROD_LEDGER) === EXPECTED_PROD_LEDGER_SHA, `actual=${sha256(PROD_LEDGER)}`);
  },
});
// ------------------------------------------------ 阶段 1：正向全生命周期（同一沙箱库 lifecycle.db，连续链路）
const LIFE = "lifecycle";
const LIFE_STATE: { p05?: string; p08?: string; t1Today?: string; t1Core?: string } = {};

C({
  id: "E2E-P-04", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "① 账户注册（回归基线链路起点）",
  source: "acceptance-cases.md TC-P01；release-gate.md Gate 3 步骤 1",
  expect: "exit 0 · accounts+1 · JSON 返回 account_id=CMB_MAIN 且落盘",
  run: async (c) => {
    const r = await c.trade("account add", [ACCT, "--name", "主仓", "--broker", "CMB", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "accounts", 1);
    c.expectTrue("账户落盘", sqlOne(c.db, `select count(*) from accounts where account_id='${ACCT}';`) === "1", "count=1");
  },
});

C({
  id: "E2E-P-05", stage: 1, kind: "positive", guards: ["G-17"], dbSuite: LIFE,
  title: "② 首次建仓（NATIVE_T0 标的，市价买入避免越线）",
  source: "acceptance-cases.md TC-P02；regression-baseline.md §2 独立账本核算；G-17（--skip-risk 为文档化旁路）",
  expect: "exit 0 · lots+1 · trades+1 · status=ACTIVE · remaining_quantity=100 · cost_basis_unit=买入价（--fee 0）",
  run: async (c) => {
    const cur = await currentPrice(c, "518880.SH");
    const r = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", ACCT, "--reason", "首次建仓", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
    const d = dataOf(c, r, "lot buy");
    c.expectTrue("status=ACTIVE", d?.status === "ACTIVE", `status=${d?.status}`);
    c.expectTrue("cost_basis_unit=买入价", Math.abs(Number(d?.cost_basis_unit) - r4(cur)) < 1e-9, `cost=${d?.cost_basis_unit} price=${r4(cur)}`);
    const lst = await c.trade("lot list", ["--json", "--status", "ACTIVE", "--symbol", "518880.SH"]);
    const lot = (c.json(lst)?.data ?? []).find((x: any) => x.lot_id === d?.lot_id);
    c.expectTrue("批次列表 remaining_quantity=100", lot?.remaining_quantity === 100, `remaining=${lot?.remaining_quantity}`);
    LIFE_STATE.p05 = d?.lot_id;
  },
});

C({
  id: "E2E-P-06", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "③ 首次加仓放行并生成子层级（血缘链第一笔加仓不触发冷却）",
  source: "safety-checklist.md §6.1（拦截前提是「已发生过加仓」）/§6.2 层级递增；acceptance-cases.md TC-N03",
  expect: "exit 0 · lots+1 · trades+1 · 子批次 parent_lot_id=父批次 · pyramid_level=父+1",
  run: async (c) => {
    const parent = LIFE_STATE.p05!;
    const lvl = Number(sqlOne(c.db, `select pyramid_level from lots where lot_id='${parent}';`));
    const cur = await currentPrice(c, "518880.SH");   // 贴近市价加仓，避免把链路批次推到止盈线（P-08 需保证只有 1 条信号）
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.995)), "--qty", "100", "--account", ACCT, "--reason", "梯级加仓", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
    const child = sqlOne(c.db, `select lot_id||'|'||coalesce(parent_lot_id,'')||'|'||pyramid_level from lots where parent_lot_id='${parent}' order by lot_id desc limit 1;`).split("|");
    c.expectTrue("子批次继承父血缘", child[1] === parent, `parent_lot_id=${child[1]}`);
    c.expectTrue(`pyramid_level=父+1(${lvl + 1})`, Number(child[2]) === lvl + 1, `actual=${child[2]}`);
  },
});

C({
  id: "E2E-N-06", stage: 1, kind: "violation", guards: ["G-19"], dbSuite: LIFE,
  title: "④ 同源血缘链 48h 冷却期内二次加仓被拦截（回归基线链路的负向环节）",
  source: "safety-checklist.md §6.1（48 小时冷却拦截）；acceptance-cases.md TC-N02；release-gate.md Gate 3 步骤 3",
  expect: "exit≠0 · lots 不变 · trades 不变 · stderr 含「防抖」或「48」· 无新子批次、层级不递增",
  run: async (c) => {
    const parent = LIFE_STATE.p05!;
    const before = sqlOne(c.db, `select count(*) from lots where parent_lot_id='${parent}';`);
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", "1.9000", "--qty", "100", "--account", ACCT, "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, "nonzero");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /防抖|48/, "stderr 指出 48 小时防抖冷却");
    c.expectTrue("未生成新子批次", sqlOne(c.db, `select count(*) from lots where parent_lot_id='${parent}';`) === before, `before=${before}`);
  },
});

C({
  id: "E2E-P-07", stage: 1, kind: "legal", guards: ["G-19", "G-21"], dbSuite: LIFE,
  title: "⑤ 冷却窗口外的加仓放行（回填父批次与首笔加仓的历史成交时间）",
  source: "safety-checklist.md §6.2 层级递增；acceptance-cases.md TC-N03；运行手册 D-01 规避说明（只用过去时间，不用未来 --time）",
  expect: "exit 0 · lots+1 · trades+1 · 子批次 pyramid_level=父+1 · 无可冷却拒绝文案",
  run: async (c) => {
    const cur = await currentPrice(c, "159934.SZ");
    const t50 = hoursAgoIso(50), t49 = hoursAgoIso(49);
    const p = await c.trade("lot buy", ["159934.SZ", "--price", String(r4(cur)), "--qty", "100", "--account", ACCT, "--time", t50, "--reason", "历史父批次回填", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(p, 0);
    const parent = dataOf(c, p, "lot buy(回填父批次)")?.lot_id;
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", ACCT, "--time", t49, "--reason", "历史加仓回填", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0);
    const lvl = Number(sqlOne(c.db, `select pyramid_level from lots where lot_id='${parent}';`));
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", ACCT, "--reason", "冷却期外加仓", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "冷却期外（上一次加仓在 49 小时前）必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
    c.expectNoText(r, /防抖/, "不得出现冷却拒绝文案");
    const child = sqlOne(c.db, `select lot_id||'|'||coalesce(parent_lot_id,'')||'|'||pyramid_level from lots where parent_lot_id='${parent}' order by lot_id desc limit 1;`).split("|");
    c.expectTrue("子批次继承父血缘", child[1] === parent, `parent_lot_id=${child[1]}`);
    c.expectTrue(`pyramid_level=父+1(${lvl + 1})`, Number(child[2]) === lvl + 1, `actual=${child[2]}`);
  },
});

C({
  id: "E2E-P-08", stage: 1, kind: "positive", guards: ["G-30", "G-32"], dbSuite: LIFE,
  title: "⑥ 浮盈越 +15% 激活移动止盈并记录峰值（扫描链路）",
  source: "regression-baseline.md §2 动态跟踪止盈（+15% 激活 / 记录 peak_price）；acceptance-cases.md TC-P04",
  expect: "exit 0 · signals+1 · 该批次 trailing_stop_active=true · peak_price≈现价 · 信号类型为可卖止盈",
  run: async (c) => {
    const cur = await currentPrice(c, "518880.SH");
    const price = r4(cur / 1.16);
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(price), "--qty", "100", "--account", ACCT, "--reason", "止盈链路", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lotId = dataOf(c, b, "lot buy(止盈链路)")?.lot_id;
    LIFE_STATE.p08 = lotId;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    c.expectDelta(sc, "signals", 1, "单个越线批次产生 1 条信号");
    const sig = (c.json(sc)?.data?.signals ?? []).find((s: any) => s.lot_id === lotId);
    c.expectTrue("该批次发出止盈告警", !!sig && /TAKE_PROFIT|TRAILING_STOP/.test(String(sig.signal_type)), `signal_type=${sig?.signal_type}`);
    c.expectTrue("触发收益率 ≥15%", Number(sig?.trigger_return_rate) >= 0.15, `trigger_return_rate=${sig?.trigger_return_rate}`);
    const lst = await c.trade("lot list", ["--json", "--status", "ACTIVE", "--symbol", "518880.SH"]);
    const lot = (c.json(lst)?.data ?? []).find((x: any) => x.lot_id === lotId);
    c.expectTrue("trailing_stop_active=true", lot?.trailing_stop_active === true, `actual=${lot?.trailing_stop_active}`);
    c.expectTrue("peak_price 已记录且≈现价", Number(lot?.peak_price) >= cur * 0.99, `peak_price=${lot?.peak_price} cur=${cur}`);
  },
});

C({
  id: "E2E-P-09", stage: 1, kind: "positive", guards: ["G-23"], dbSuite: LIFE,
  title: "⑦ 部分平仓：剩余持仓保持 ACTIVE",
  source: "regression-baseline.md §2（支持指定数量部分平仓，剩余部分保持 ACTIVE）；help lot close",
  expect: "exit 0 · trades+1 · 该批次 remaining_quantity 由 100 降为 50 · status 保持 ACTIVE",
  run: async (c) => {
    const lotId = LIFE_STATE.p08!;
    const r = await c.trade("lot close", ["--lot-id", lotId, "--price", "2.5000", "--qty", "50", "--account", ACCT, "--fee", "0", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "trades", 1);
    const d = dataOf(c, r, "lot close(部分)");
    c.expectTrue("remaining_quantity=50", Number(d?.remaining_quantity) === 50, `remaining=${d?.remaining_quantity}`);
    c.expectTrue("lot_status=ACTIVE", d?.lot_status === "ACTIVE", `status=${d?.lot_status}`);
  },
});

C({
  id: "E2E-P-10", stage: 1, kind: "positive", guards: ["G-27"], dbSuite: LIFE,
  title: "⑧ 全部平仓：状态置 CLOSED 并核算实现收益",
  source: "release-gate.md Gate 3 步骤 5；regression-baseline.md §2；acceptance-cases.md TC-P04",
  expect: "exit 0 · trades+1 · status=CLOSED · realized_pnl≠0 · 该批次不再出现在 ACTIVE 列表",
  run: async (c) => {
    const lotId = LIFE_STATE.p08!;
    const r = await c.trade("lot close", ["--lot-id", lotId, "--price", "2.6000", "--account", ACCT, "--reason", "全部平仓", "--fee", "0", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "trades", 1);
    const d = dataOf(c, r, "lot close(全部)");
    c.expectTrue("status=CLOSED", d?.lot_status === "CLOSED", `status=${d?.lot_status}`);
    c.expectTrue("批次已 CLOSED", sqlOne(c.db, `select status from lots where lot_id='${lotId}';`) === "CLOSED", "sqlite status");
    c.expectTrue("实现收益非 0", Number(sqlOne(c.db, `select realized_pnl from lots where lot_id='${lotId}';`)) !== 0, `realized_pnl=${sqlOne(c.db, `select realized_pnl from lots where lot_id='${lotId}';`)}`);
  },
});

C({
  id: "E2E-P-11", stage: 1, kind: "positive", guards: ["G-28"], dbSuite: LIFE,
  title: "⑨ 决策理由追加：只改理由列，会计与状态零漂移",
  source: "help lot edit（--buy-reason/--append）；MANUAL.md 铁律 6（买卖理由可回溯）；G-28 预期",
  expect: "exit 0 · 各表行数全 0 变化 · buy_reason 变为「原值+追加值」· cost_basis_unit/status/remaining_quantity 不变",
  run: async (c) => {
    const lotId = LIFE_STATE.p05!;
    const snap = (q: string) => sqlOne(c.db, `select ${q} from lots where lot_id='${lotId}';`);
    const before = { reason: snap("coalesce(buy_reason,'')"), cost: snap("cost_basis_unit"), status: snap("status"), remain: snap("remaining_quantity") };
    const r = await c.trade("lot edit", ["--lot-id", lotId, "--buy-reason", "（追加）复盘补充", "--append", "--json"]);
    c.expectExit(r, 0);
    c.expectDeltaAll(r, 0, "理由修改不改行数");
    const after = { reason: snap("coalesce(buy_reason,'')"), cost: snap("cost_basis_unit"), status: snap("status"), remain: snap("remaining_quantity") };
    c.expectTrue("buy_reason 被追加", after.reason.startsWith(before.reason) && after.reason !== before.reason, `before=${JSON.stringify(before.reason)} after=${JSON.stringify(after.reason)}`);
    for (const k of ["cost", "status", "remain"] as const) c.expectTrue(`${k} 零漂移`, before[k] === after[k], `before=${before[k]} after=${after[k]}`);
  },
});

C({
  id: "E2E-P-12", stage: 1, kind: "positive", guards: ["G-26"], dbSuite: LIFE,
  title: "⑩ 代冲平仓：T+1 标的用同账户历史底仓完成日内回转",
  source: "regression-baseline.md §2 日内底仓置换法则；acceptance-cases.md TC-N08（正向侧）；help lot close --substitute-core",
  expect: "exit 0 · trades+1 · 当日批次剩余量减少 · substituted_core_lot_id 指向本账户历史底仓",
  run: async (c) => {
    const cur = await currentPrice(c, "510300.SH");
    const core = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", ACCT, "--time", hoursAgoIso(30), "--reason", "历史底仓", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(core, 0);
    const coreId = dataOf(c, core, "lot buy(底仓)")?.lot_id;
    const today = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "200", "--account", ACCT, "--reason", "当日买入", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(today, 0);
    const todayId = dataOf(c, today, "lot buy(当日)")?.lot_id;
    LIFE_STATE.t1Today = todayId; LIFE_STATE.t1Core = coreId;
    const r = await c.trade("lot close", ["--lot-id", todayId, "--price", String(r4(cur * 1.01)), "--qty", "200", "--account", ACCT, "--substitute-core", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "同账户有底仓时 --substitute-core 必须放行");
    c.expectDelta(r, "trades", 1);
    c.expectTrue("代冲底仓指向本账户历史底仓", sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${todayId}';`) === coreId, `actual=${sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${todayId}';`)}`);
    c.expectTrue("当日批次剩余量归零/状态更新", sqlOne(c.db, `select remaining_quantity from lots where lot_id='${todayId}';`) === "0", `remaining=${sqlOne(c.db, `select remaining_quantity from lots where lot_id='${todayId}';`)}`);
  },
});

C({
  id: "E2E-P-13", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "⑪ 现金分红登记与流水合计",
  source: "SKILL.md §5 现金分红管理原语；MANUAL.md §8（自动输出累计分红总额）；help dividend add/list",
  expect: "exit 0 · dividends+1 · dividend list --json total_amount=100.00 且含该笔流水",
  run: async (c) => {
    const r = await c.trade("dividend add", ["--symbol", "518880.SH", "--amount", "100.00", "--date", "2026-01-15", "--account", ACCT, "--notes", "E2E分红", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "dividends", 1);
    const l = await c.trade("dividend list", ["--json"]);
    const d = dataOf(c, l, "dividend list");
    c.expectTrue("流水合计=100.00", Number(d?.total_amount) === 100, `total_amount=${d?.total_amount}`);
    c.expectTrue("流水含该笔", (d?.dividends ?? []).some((x: any) => Number(x.amount) === 100 && x.symbol === "518880.SH"), `n=${(d?.dividends ?? []).length}`);
  },
});

C({
  id: "E2E-P-14", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "⑫ position 三层聚合与账本逐项核对",
  source: "MANUAL.md §position/三层视图；SKILL.md §3 三层分层聚合；regression-baseline.md §2 独立账本核算",
  expect: "exit 0 · portfolio.total_cost=Σ(cost_basis_unit×remaining_quantity) · total_active_lots=ACTIVE 批次数 · total_symbols_count=ACTIVE 标的数 · 标的层市值=Σ(批次剩余×现价)",
  run: async (c) => {
    const r = await c.trade("position", ["--json"]);
    c.expectExit(r, 0);
    const d = dataOf(c, r, "position");
    const ps = d?.portfolio_summary;
    const ledgerCost = Number(sqlOne(c.db, "select round(sum(cost_basis_unit*remaining_quantity),2) from lots where status='ACTIVE';"));
    const ledgerLots = Number(sqlOne(c.db, "select count(*) from lots where status='ACTIVE';"));
    const ledgerSyms = Number(sqlOne(c.db, "select count(distinct symbol) from lots where status='ACTIVE';"));
    c.expectTrue("total_cost 与账本一致", Math.abs(Number(ps?.total_cost) - ledgerCost) <= 0.01, `cli=${ps?.total_cost} ledger=${ledgerCost}`);
    c.expectTrue("total_active_lots 与账本一致", Number(ps?.total_active_lots) === ledgerLots, `cli=${ps?.total_active_lots} ledger=${ledgerLots}`);
    c.expectTrue("total_symbols_count 与账本一致", Number(ps?.total_symbols_count) === ledgerSyms, `cli=${ps?.total_symbols_count} ledger=${ledgerSyms}`);
    const symSum = (d?.targets ?? []).reduce((a: number, t: any) => a + Number(t.total_quantity) * Number(t.current_price), 0);
    c.expectTrue("标的层市值合计=组合总市值", Math.abs(symSum - Number(ps?.total_market_value)) <= 0.02, `symSum=${symSum.toFixed(2)} portfolio=${ps?.total_market_value}`);
    c.expectTrue("组合占比列存在且非 NaN", (d?.targets ?? []).every((t: any) => Number.isFinite(Number(t.portfolio_weight))), `weights=${(d?.targets ?? []).map((t: any) => t.portfolio_weight).join(",")}`);
  },
});

C({
  id: "E2E-P-15", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "⑬ stats 多维战绩与账本逐项核对",
  source: "regression-baseline.md §2（trade stats 按标的/操盘类型多维归因）；SKILL.md §stats",
  expect: "exit 0 · total_trades=成交流水笔数(非 BUY) · total_realized_pnl=Σ批次 realized_pnl · by_symbol/by_trade_type 合计与总量一致",
  run: async (c) => {
    const r = await c.trade("stats", ["--json"]);
    c.expectExit(r, 0);
    const d = dataOf(c, r, "stats");
    const trades = Number(sqlOne(c.db, "select count(*) from trades where action<>'BUY';"));
    const pnl = Number(sqlOne(c.db, "select round(coalesce(sum(realized_pnl),0),2) from lots;"));
    c.expectTrue("total_trades 与流水一致", Number(d?.total_trades) === trades, `cli=${d?.total_trades} ledger=${trades}`);
    c.expectTrue("total_realized_pnl 与账本一致", Math.abs(Number(d?.total_realized_pnl) - pnl) <= 0.01, `cli=${d?.total_realized_pnl} ledger=${pnl}`);
    const typeSum = Object.values(d?.by_trade_type ?? {}).reduce((a: number, t: any) => a + Number(t.total_trades), 0);
    c.expectTrue("按操盘类型拆分合计=总笔数", typeSum === Number(d?.total_trades), `typeSum=${typeSum} total=${d?.total_trades}`);
    const symSum = Object.values(d?.by_symbol ?? {}).reduce((a: number, t: any) => a + Number(t.total_trades), 0);
    c.expectTrue("按标的拆分合计=总笔数", symSum === Number(d?.total_trades), `symSum=${symSum} total=${d?.total_trades}`);
  },
});

C({
  id: "E2E-P-16", stage: 1, kind: "positive", guards: ["G-35", "G-37"], dbSuite: LIFE,
  title: "⑭ 看板单文件生成：自定义模板生效、产物 0600、无外部静态资源",
  source: "regression-baseline.md §3（单文件看板）；MANUAL.md §看板文件自身权限 0600（覆盖已存在宽权限文件）；G-37（--template 生效）",
  expect: "exit 0 · 产物存在且非空 · 权限 0600 · 含自定义模板标记 · 无 http(s) 外部静态资源引用",
  run: async (c) => {
    const tpl = join(SANDBOX_ART, "e2e-template.html");
    const out = join(SANDBOX_ART, "lifecycle-dashboard.html");
    writeFileSync(tpl, readFileSync(join(REPO, "scripts/template_base.html"), "utf-8") + "\n<!-- QA-CUSTOM-TEMPLATE-MARKER -->\n");
    const r = await c.trade("dashboard", ["--out", out, "--template", tpl, "--token", "e2e-explicit-token-0000000000000000000000000000000000000000000000000000", "--json"]);
    c.expectExit(r, 0);
    c.expectTrue("产物存在且非空", existsSync(out) && statSync(out).size > 10000, `size=${existsSync(out) ? statSync(out).size : 0}`);
    c.expectTrue("产物权限 0600", fileMode(out) === "600", `mode=${fileMode(out)}`);
    const html = readFileSync(out, "utf-8");
    c.expectTrue("自定义模板标记生效", html.includes("QA-CUSTOM-TEMPLATE-MARKER"), "marker search");
    c.expectTrue("无外部静态资源引用", !/(src|href)="https?:\/\//.test(html), `external=${(html.match(/(src|href)="https?:\/\//g) ?? []).length}`);
    c.expectTrue("会话令牌已注入", /window\.__LOT_TRADER_SESSION_TOKEN__\s*=\s*"e2e-explicit-token/.test(html), "token injection");
    await c.fs(`归档看板产物到证据目录：${out}`, () => {
      const dst = join(EVID, `${c.id}__dashboard.html`);
      copyFileSync(out, dst);
      const notes = join(EVID, `${c.id}__dashboard-forensics.txt`);
      writeFileSync(notes, `src=${out}\nbytes=${statSync(out).size}\nmode=${fileMode(out)}\nsha256=${sha256(out)}\nmarker=${html.includes("QA-CUSTOM-TEMPLATE-MARKER")}\nexternal_static_refs=${(html.match(/(src|href)="https?:\/\//g) ?? []).length}\n`);
      return [dst, notes];
    });
  },
});

C({
  id: "E2E-P-17", stage: 1, kind: "positive", guards: [], dbSuite: LIFE,
  title: "⑮ headless 浏览器加载看板：非白屏、无 NaN、含持仓标的",
  source: "regression-baseline.md §3（纯前端自驱模式，无白屏、无 NaN，每 5 秒轮询行情）；release-gate.md Gate 4",
  expect: "exit 0 · 渲染 DOM 文本长度 >1000 · DOM 含持仓标的代码 · 渲染文本中不出现 NaN · 记录运行时 8080 占用状态",
  run: async (c) => {
    const out = join(SANDBOX_ART, "lifecycle-dashboard.html");
    const port8080 = listenersOn(8080) || "(none)";
    await c.fs(`记录运行时 8080 占用状态：${port8080}`, () => {
      const p = join(EVID, `${c.id}__port-8080-at-browser-time.txt`);
      writeFileSync(p, `listeners_8080=${port8080}\nat=${nowIso()}\n` + `note=本行记录 headless 浏览器加载看板时刻 8080 的监听状态；本线端口边界 18000-18999 且不使用 8080（也未使用 --port 0）\n`);
      return [p];
    });
    if (!existsSync(CHROME)) { c.block(`本机未安装可用的 headless 浏览器（${CHROME} 不存在），缺失能力：浏览器驱动`); return; }
    const udd = join(SANDBOX_ART, "chrome-profile");
    mkdirSync(udd, { recursive: true });
    const dom = join(SANDBOX_ART, "dashboard-dom.html");
    const shot = join(SANDBOX_ART, "dashboard-screenshot.png");
    await c.fs(`headless chrome --virtual-time-budget=8000 --dump-dom file://${out}`, () => {
      const rr = sh(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + udd, "--virtual-time-budget=8000", "--window-size=1600,1000", "--dump-dom", "file://" + out], { timeout: 120_000 });
      writeFileSync(dom, rr.stdout + (rr.stderr ? `\n<!-- stderr -->\n${rr.stderr}` : ""));
      sh(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + udd + "-shot", "--virtual-time-budget=8000", "--window-size=1600,1000", `--screenshot=${shot}`, "file://" + out], { timeout: 120_000 });
      const domCopy = join(EVID, `${c.id}__browser-dom.html`);
      const shotCopy = join(EVID, `${c.id}__browser-screenshot.png`);
      copyFileSync(dom, domCopy);
      if (existsSync(shot)) copyFileSync(shot, shotCopy);
      const notes = join(EVID, `${c.id}__browser-notes.txt`);
      writeFileSync(notes, `chrome=${CHROME}\nuser_data_dir=${udd}（全新，仅 /tmp 沙箱内）\nfile=file://${out}\ndom_bytes=${existsSync(dom) ? statSync(dom).size : 0}\nscreenshot_bytes=${existsSync(shot) ? statSync(shot).size : 0}\nlisteners_8080_at_browser_time=${port8080}\n`);
      return [domCopy, shotCopy, notes];
    });
    const text = readFileSync(dom, "utf-8");
    const bodyText = text.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    c.expectTrue("DOM 非空白（长度>1000）", text.length > 1000, `dom_len=${text.length}`);
    c.expectTrue("渲染文本含持仓标的", /518880\.SH|黄金ETF|159934/.test(bodyText), `snippet=${bodyText.slice(0, 200)}`);
    c.expectTrue("渲染文本不出现 NaN", !/NaN/.test(bodyText), `nan_hits=${(bodyText.match(/NaN/g) ?? []).length}`);
    c.expectTrue("截图产物存在", existsSync(shot) && statSync(shot).size > 1000, `size=${existsSync(shot) ? statSync(shot).size : 0}`);
  },
});

C({
  id: "E2E-P-18", stage: 1, kind: "positive", guards: ["G-06", "G-07"], dbSuite: LIFE,
  title: "⑯ serve 读回并与 CLI 口径逐项交叉核对",
  source: "MANUAL.md §7（/api/summary、/api/lots 字段契约）；SKILL.md §serve；release-gate.md Gate 4 服务探活",
  expect: "exit 0（SIGTERM 优雅停机）· /api/summary 与 /api/lots 均 HTTP 200 · portfolio.total_cost/total_active_lots 与 position --json 一致 · 批次剩余量与 lot list --json 一致 · 停机后端口释放",
  run: async (c) => {
    const token = "e2e-serve-token-" + "a".repeat(48);
    const s = await c.serve({ explicitToken: token });
    c.expectTrue("serve 健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    const base = `http://127.0.0.1:${s.port}`;
    const hs = await c.http("GET", `${base}/api/summary`, { headers: [`Authorization: Bearer ${token}`] });
    const hl = await c.http("GET", `${base}/api/lots?status=ACTIVE`, { headers: [`Authorization: Bearer ${token}`] });
    c.expectHttpStatus(hs, 200); c.expectHttpStatus(hl, 200);
    const pos = dataOf(c, await c.trade("position", ["--json"]), "position");
    const cliLots = (c.json(await c.trade("lot list", ["--json", "--status", "ACTIVE"]))?.data ?? []);
    c.expectTrue("summary.total_cost=position.total_cost", Math.abs(Number(hs.bodyJson?.portfolio?.total_cost) - Number(pos?.portfolio_summary?.total_cost)) <= 0.01, `http=${hs.bodyJson?.portfolio?.total_cost} cli=${pos?.portfolio_summary?.total_cost}`);
    c.expectTrue("summary.total_active_lots=position.total_active_lots", Number(hs.bodyJson?.portfolio?.total_active_lots) === Number(pos?.portfolio_summary?.total_active_lots), `http=${hs.bodyJson?.portfolio?.total_active_lots} cli=${pos?.portfolio_summary?.total_active_lots}`);
    c.expectTrue("api/lots 条数=CLI ACTIVE 批次数", Number(hl.bodyJson?.total) === cliLots.length, `http=${hl.bodyJson?.total} cli=${cliLots.length}`);
    const mism = (hl.bodyJson?.lots ?? []).filter((l: any) => {
      const m = cliLots.find((x: any) => x.lot_id === l.lot_id);
      return !m || Number(m.remaining_quantity) !== Number(l.remaining_quantity) || Number(m.cost_basis_unit) !== Number(l.cost_basis_unit);
    });
    c.expectTrue("逐批次 remaining/cost 与 CLI 一致", mism.length === 0, `mismatches=${mism.length}`);
    c.expectTrue("summary.symbols 与 position.targets 标的集合一致", JSON.stringify((hs.bodyJson?.symbols ?? []).map((x: any) => x.symbol).sort()) === JSON.stringify((pos?.targets ?? []).map((x: any) => x.symbol).sort()), `http=${(hs.bodyJson?.symbols ?? []).map((x: any) => x.symbol)} cli=${(pos?.targets ?? []).map((x: any) => x.symbol)}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0, "SIGTERM 优雅停机 exit=0");
    c.expectTrue("停机后端口已释放", (await waitPortFree(s.port, 3000)) === true, `port=${s.port}`);
  },
});
// ------------------------------------------------ 阶段 2：负向守卫（每条成对：violation=触发侧 / legal=不触发侧）
const BUDGET_ENV: Record<string, string> = { LOT_TRADER_PORTFOLIO_BUDGET: "10000" };
async function seedAcct(c: Ctx, id = "ACC") {
  const r = await c.trade("account add", [id, "--name", id, "--broker", "CMB", "--json"]);
  c.expectExit(r, 0, `前置：账户 ${id} 登记 exit 0`);
}
/** cost 模式下 qty=1000 股、price=cost/1000（四位小数）→ 成本精确到 0.01 元。 */
async function buyCost(c: Ctx, o: { symbol: string; cost?: number; price?: number; qty?: number; account?: string; env?: Record<string, string>; skip?: boolean; time?: string; reason?: string; fee?: number }) {
  const qty = o.qty ?? 1000;
  const price = o.price ?? r4((o.cost ?? 0) / qty);
  const args = [o.symbol, "--price", String(price), "--qty", String(qty), "--account", o.account ?? "ACC", "--fee", String(o.fee ?? 0), "--reason", o.reason ?? "e2e", "--json"];
  if (o.skip !== false) args.push("--skip-risk");
  if (o.time) args.push("--time", o.time);
  return c.trade("lot buy", args, o.env ?? {});
}
const LOT_OF = (c: Ctx, where: string) => sqlOne(c.db, `select lot_id from lots where ${where} order by lot_id desc limit 1;`);

C({
  id: "E2E-N-07", stage: 2, kind: "violation", guards: ["G-04"], dbSuite: "n07-bind-nonloopback",
  title: "非回环地址一律拒绝监听",
  source: "safety-checklist.md §2.1；MANUAL.md §7 硬约束 1；矩阵 G-04 预期",
  expect: "exit≠0 · stderr 指出仅允许回环地址 · 18000-18999 内不得出现新监听 · 各表行数 0 变化（0.0.0.0 / 局域网 IP 两种输入各一次）",
  run: async (c) => {
    for (const host of ["0.0.0.0", "192.168.31.44"]) {
      const p = await freePort();
      const r = await c.trade("serve", ["--host", host, "--port", String(p), "--token-file", join(SANDBOX_ART, `n07-${host}.token`)]);
      c.expectExit(r, "nonzero", `--host ${host} 必须拒绝启动`);
      c.expectText(r, /127\.0\.0\.1|回环|loopback/, `--host ${host} 文案指出只允许回环`);
      c.expectTrue(`--host ${host} 未建立监听`, listenersOn(p) === "", `listeners=${listenersOn(p) || "(none)"}`);
      c.expectDeltaAll(r, 0, `--host ${host} 被拒后零写入`);
    }
  },
});

C({
  id: "E2E-N-08", stage: 2, kind: "legal", guards: ["G-04"], dbSuite: "n08-bind-loopback",
  title: "回环地址正常绑定且仅回环可达",
  source: "safety-checklist.md §2.1；MANUAL.md §7 硬约束 1",
  expect: "exit 0（SIGTERM）· /api/health HTTP 200 · 监听地址为 127.0.0.1 · 停机后端口释放",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    c.expectTrue("健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    const bind = listenersOn(s.port);
    c.expectTrue("监听落在 127.0.0.1", /127\.0\.0\.1/.test(bind), `listeners=${bind}`);
    c.expectTrue("未监听通配地址", !/\*:/.test(bind), `listeners=${bind}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0, "SIGTERM 优雅停机 exit 0");
    c.expectTrue("停机后端口释放", (await waitPortFree(s.port, 3000)) === true, `port=${s.port}`);
  },
});

C({
  id: "E2E-N-09", stage: 2, kind: "violation", guards: ["G-05"], dbSuite: "n09-token-mode-forced",
  title: "预置宽权限凭据文件必须被收敛为 0600",
  source: "safety-checklist.md §3.1（生成时必须 0600）；MANUAL.md §7（写入后 chmod 0600，覆盖已存在宽权限文件）",
  expect: "exit 0（SIGTERM）· 预置 0644 的凭据文件在 serve 启动后权限位变为 600 · 内容为 64 位 hex",
  run: async (c) => {
    await seedAcct(c);
    const tf = join(SANDBOX_ART, "n09-preset-wide.token");
    writeFileSync(tf, "pre-existing-token-value\n");
    chmodSync(tf, 0o644);
    c.expectTrue("前置：预置文件权限为 644", fileMode(tf) === "644", `mode=${fileMode(tf)}`);
    const s = await c.serve({ tokenFile: tf });
    c.expectTrue("健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    c.expectTrue("凭据文件权限被收敛为 600", fileMode(tf) === "600", `mode=${fileMode(tf)}`);
    c.expectTrue("凭据内容为 64 位 hex", /^[0-9a-f]{64}$/.test(readFileSync(tf, "utf-8").trim()), `len=${readFileSync(tf, "utf-8").trim().length}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-10", stage: 2, kind: "legal", guards: ["G-05"], dbSuite: "n10-token-fresh",
  title: "全新凭据文件 0600 生成且服务可用（不误伤）",
  source: "safety-checklist.md §3.1/§3.2（0600 + 32 字节高熵令牌）；MANUAL.md §7",
  expect: "exit 0 · 凭据文件权限 600 · 内容为 64 位 hex · /api/health HTTP 200",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    c.expectTrue("凭据文件已生成且权限 600", fileMode(s.tokenFile) === "600", `mode=${fileMode(s.tokenFile)}`);
    c.expectTrue("凭据为 64 位 hex", /^[0-9a-f]{64}$/.test(s.readToken()), `token_len=${s.readToken().length}`);
    c.expectTrue("健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-11", stage: 2, kind: "violation", guards: ["G-06"], dbSuite: "n11-auth-reject",
  title: "受保护端点缺凭据/错凭据严格 401",
  source: "safety-checklist.md §3.3（必须严格返回 HTTP 401 UNAUTHORIZED）；MANUAL.md §7 拒绝口径",
  expect: "GET /api/summary 与 /api/lots 在（无 Authorization、错误 Bearer、错误 ?token=）三种输入下均 HTTP 401",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/summary`);
    const b = await c.http("GET", `${base}/api/lots`, { headers: ["Authorization: Bearer deadbeef-deadbeef"] });
    const d = await c.http("GET", `${base}/api/lots?token=deadbeef-deadbeef"`);
    c.expectHttpStatus(a, 401, "无凭据 /api/summary → 401");
    c.expectHttpStatus(b, 401, "错误 Bearer /api/lots → 401");
    c.expectHttpStatus(d, 401, "错误查询串 token → 401");
    c.expectTrue("响应体声明 UNAUTHORIZED", /UNAUTHORIZED/.test(a.body + b.body + d.body), `body=${a.body.slice(0, 120)}`);
    c.expectTrue("未泄露账本字段", !/remaining_quantity|total_cost|lot_id/.test(a.body + b.body + d.body), "leak scan");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-12", stage: 2, kind: "legal", guards: ["G-06"], dbSuite: "n12-auth-allow",
  title: "正确凭据放行（401 守卫不误伤合法调用）",
  source: "safety-checklist.md §3.3；MANUAL.md §7（Authorization: Bearer 或 ?token= 两种传递方式）",
  expect: "带正确 Bearer 的 /api/summary 与 /api/lots 均 HTTP 200；查询串方式同样 200",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    const b = await c.http("GET", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    const d = await c.http("GET", `${base}/api/lots?token=${tok}`);
    c.expectHttpStatus(a, 200, "/api/summary 正确凭据 → 200");
    c.expectHttpStatus(b, 200, "/api/lots 正确凭据 → 200");
    c.expectHttpStatus(d, 200, "查询串凭据 → 200");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-13", stage: 2, kind: "violation", guards: ["G-07"], dbSuite: "n13-401-zero-leak",
  title: "401 响应体零账本字段（账本零泄漏）",
  source: "safety-checklist.md §3.4（401 响应体必须为纯错误信息，严禁包含任何账本字段）；MANUAL.md §7",
  expect: "全部 401 响应体中不出现账户 ID、标的代码、批次 ID、成本/市值/持仓字段；响应体只含错误信息",
  run: async (c) => {
    await seedAcct(c, "LEAKACC");
    await buyCost(c, { symbol: "518880.SH", cost: 2000, account: "LEAKACC" });
    const lot = LOT_OF(c, "account_id='LEAKACC'");
    const s = await c.serve({});
    const base = `http://127.0.0.1:${s.port}`;
    const probes = [
      await c.http("GET", `${base}/api/summary`),
      await c.http("GET", `${base}/api/lots`),
      await c.http("GET", `${base}/api/lots?symbol=518880.SH`),
      await c.http("GET", `${base}/api/lots?account=LEAKACC`),
    ];
    for (const [i, r] of probes.entries()) {
      c.expectHttpStatus(r, 401, `探针 ${i + 1} → 401`);
      const leaks = [lot, "LEAKACC", "518880.SH", "remaining_quantity", "total_cost", "cost_basis_unit"].filter((k) => k && r.body.includes(k));
      c.expectTrue(`探针 ${i + 1} 响应体零账本字段`, leaks.length === 0, `leaks=${leaks.join(",") || "(none)"} body=${JSON.stringify(r.body.slice(0, 160))}`);
    }
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-14", stage: 2, kind: "legal", guards: ["G-07"], dbSuite: "n14-200-has-ledger",
  title: "授权后响应体正常携带账本数据（零泄漏门不误封合法读取）",
  source: "MANUAL.md §7（/api/summary、/api/lots 字段契约）；SKILL.md §4",
  expect: "带正确凭据的 /api/lots HTTP 200 且响应含该批次 ID 与 remaining_quantity；/api/summary 含 portfolio 字段",
  run: async (c) => {
    await seedAcct(c, "OKACC");
    await buyCost(c, { symbol: "518880.SH", cost: 2000, account: "OKACC" });
    const lot = LOT_OF(c, "account_id='OKACC'");
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    const b = await c.http("GET", `${base}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200);
    c.expectTrue("响应含批次 ID", a.body.includes(lot), `lot=${lot}`);
    c.expectTrue("响应含 remaining_quantity", /remaining_quantity/.test(a.body), "field scan");
    c.expectHttpStatus(b, 200);
    c.expectTrue("summary 含 portfolio", b.bodyJson?.portfolio !== undefined, `keys=${Object.keys(b.bodyJson ?? {}).join(",")}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-15", stage: 2, kind: "violation", guards: ["G-08"], dbSuite: "n15-host-forgery",
  title: "伪造 Host 头被拒（DNS rebinding 防护）",
  source: "矩阵 G-08 预期输出（拒绝请求；携带正确凭据也拒绝）；MANUAL.md §7 本地回环门禁",
  expect: "Host: evil.example.com 时 /api/health 与带正确凭据的 /api/lots 均 HTTP 4xx，且不返回账本字段",
  run: async (c) => {
    await seedAcct(c, "HOSTACC");
    await buyCost(c, { symbol: "518880.SH", cost: 2000, account: "HOSTACC" });
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/health`, { headers: ["Host: evil.example.com"] });
    const b = await c.http("GET", `${base}/api/lots`, { headers: ["Host: evil.example.com", `Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, "4xx", "伪造 Host 的 /api/health → 4xx");
    c.expectHttpStatus(b, "4xx", "伪造 Host + 正确凭据的 /api/lots → 4xx");
    c.expectTrue("伪造 Host 响应不含账本字段", !/remaining_quantity|HOSTACC/.test(a.body + b.body), `body=${JSON.stringify((a.body + b.body).slice(0, 160))}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-16", stage: 2, kind: "legal", guards: ["G-08"], dbSuite: "n16-host-ok",
  title: "合法 Host（回环地址）放行（防误杀）",
  source: "矩阵 G-08 预期（合法 Host 正常放行）；MANUAL.md §7",
  expect: "Host: 127.0.0.1:<port> 的 /api/health HTTP 200",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/health`, { headers: [`Host: 127.0.0.1:${s.port}`] });
    c.expectHttpStatus(a, 200, "合法 Host → 200");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-17", stage: 2, kind: "violation", guards: ["G-09"], dbSuite: "n17-origin-bad",
  title: "非白名单 Origin 被拒且不回跨域放行头",
  source: "矩阵 G-09 预期（拒绝请求且不回跨域放行头）；L1 §12.2 TC-N08 来源映射",
  expect: "Origin: http://evil.example.com 的 /api/lots HTTP 4xx 且响应头无 Access-Control-Allow-Origin",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/lots`, { headers: ["Origin: http://evil.example.com", `Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, "4xx", "非法 Origin → 4xx");
    c.expectTrue("无 Access-Control-Allow-Origin", !/Access-Control-Allow-Origin/i.test(a.headers), `headers=${a.headers.split("\r\n").filter((h) => /access-control/i.test(h)).join(" | ")}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-18", stage: 2, kind: "legal", guards: ["G-09"], dbSuite: "n18-origin-good",
  title: "回环来源在白名单内放行并回放行头",
  source: "矩阵 G-09 预期（白名单内来源正常放行并回放行头）",
  expect: "Origin: http://127.0.0.1:<port> 的 /api/lots HTTP 200 且响应头含 Access-Control-Allow-Origin",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/lots`, { headers: [`Origin: http://127.0.0.1:${s.port}`, `Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200, "回环 Origin → 200");
    c.expectTrue("回放 Access-Control-Allow-Origin", /Access-Control-Allow-Origin/i.test(a.headers), `headers=${a.headers.split("\r\n").filter((h) => /access-control/i.test(h)).join(" | ")}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-19", stage: 2, kind: "violation", guards: ["G-10"], dbSuite: "n19-write-method",
  title: "写方法打到只读引擎被拒",
  source: "./trade serve --help（read-only JSON API）；矩阵 G-10 预期（写方法被拒）",
  expect: "带正确凭据的 POST /api/summary 与 DELETE /api/lots 均 HTTP 4xx，且账本行数不变",
  run: async (c) => {
    await seedAcct(c);
    const before = dbRows(c.db);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("POST", `${base}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    const b = await c.http("DELETE", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, "4xx", "POST /api/summary → 4xx");
    c.expectHttpStatus(b, "4xx", "DELETE /api/lots → 4xx");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
    const after = dbRows(c.db);
    c.expectTrue("账本各表行数不变", TABLES.every((t) => before[t] === after[t]), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  },
});

C({
  id: "E2E-N-20", stage: 2, kind: "legal", guards: ["G-10"], dbSuite: "n20-preflight",
  title: "浏览器预检请求放行（读方法不误伤）",
  source: "矩阵 G-10 预期（预检返回无内容并回跨域方法）；MANUAL.md §7 端点契约",
  expect: "OPTIONS /api/lots HTTP 2xx（204）且回 Access-Control-Allow-Methods 含 GET；随后 GET 仍 200",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("OPTIONS", `${base}/api/lots`, { headers: [`Origin: http://127.0.0.1:${s.port}`, "Access-Control-Request-Method: GET"] });
    c.expectHttpStatus(a, "2xx", "OPTIONS 预检 → 2xx");
    c.expectTrue("回放允许方法含 GET", /Access-Control-Allow-Methods:[^\r\n]*GET/i.test(a.headers), `headers=${a.headers.split("\r\n").filter((h) => /access-control/i.test(h)).join(" | ")}`);
    const g = await c.http("GET", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(g, 200, "GET 读方法仍 200");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-21", stage: 2, kind: "violation", guards: ["G-11"], dbSuite: "n21-unknown-endpoint",
  title: "未知端点与路径穿越被拒",
  source: "矩阵 G-11 预期（带凭据时未找到；穿越请求不越界）",
  expect: "带正确凭据的 /api/nope HTTP 4xx；带 --path-as-is 原样发出的 /../../etc/passwd 同样 HTTP 4xx，响应不含系统文件内容与任何账本字段",
  run: async (c) => {
    await seedAcct(c, "TRAVACC");
    await buyCost(c, { symbol: "518880.SH", cost: 2000, account: "TRAVACC" });
    const lot = LOT_OF(c, "account_id='TRAVACC'");
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/nope`, { headers: [`Authorization: Bearer ${tok}`] });
    // --path-as-is：禁止 curl 规范化路径，确保真的发出带 ../ 的穿越请求（否则等于没测）
    const b = await c.http("GET", `${base}/../../etc/passwd`, { headers: [`Authorization: Bearer ${tok}`], raw: ["--path-as-is"] });
    c.expectHttpStatus(a, "4xx", "未知端点 → 4xx");
    c.expectHttpStatus(b, "4xx", "路径穿越（--path-as-is 原样发出）→ 4xx");
    c.expectTrue("穿越请求确实带 ../ 原样发出", b.cmd.includes("--path-as-is"), `cmd=${b.cmd}`);
    c.expectTrue("穿越响应不含系统文件内容", !/root:/.test(b.body), `body=${JSON.stringify(b.body.slice(0, 120))}`);
    const leaks = [lot, "TRAVACC", "518880.SH", "remaining_quantity", "total_cost"].filter((k) => k && b.body.includes(k));
    c.expectTrue("穿越响应不含账本字段", leaks.length === 0, `leaks=${leaks.join(",") || "(none)"}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-22", stage: 2, kind: "legal", guards: ["G-11"], dbSuite: "n22-known-endpoint",
  title: "已知端点放行（404 门不误伤合法路径）",
  source: "MANUAL.md §7 端点契约（/api/health 公开、/api/summary 与 /api/lots 需令牌）",
  expect: "/api/health、/api/summary、/api/lots 三个已知端点分别 HTTP 200",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/health`);
    const b = await c.http("GET", `${base}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    const d = await c.http("GET", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200, "/api/health → 200");
    c.expectHttpStatus(b, 200, "/api/summary → 200");
    c.expectHttpStatus(d, 200, "/api/lots → 200");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-23", stage: 2, kind: "violation", guards: ["G-12"], dbSuite: "n23-graceful-stop",
  title: "优雅停机状态转换发生：进程退出、端口释放、临时凭据删除",
  source: "safety-checklist.md §2.3；MANUAL.md §7 硬约束 3 与令牌生命周期；矩阵 G-12 预期",
  expect: "SIGTERM 与 SIGINT 各一次：exit 0 · 3 秒内端口不再被占用 · 自动生成的凭据文件被删除",
  run: async (c) => {
    await seedAcct(c);
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      const tf = join(SANDBOX_ART, `n23-${sig}.token`);
      const s = await c.serve({ tokenFile: tf });
      c.expectTrue(`${sig} 前服务可用`, s.healthOk === true, `healthOk=${s.healthOk}`);
      c.expectTrue(`${sig} 前凭据文件存在`, existsSync(tf), `tf=${tf}`);
      const stop = await s.stop(sig);
      c.expectExit(stop, 0, `${sig} exit 0`);
      c.expectTrue(`${sig} 后端口 3 秒内释放`, (await waitPortFree(s.port, 3000)) === true, `port=${s.port}`);
      c.expectTrue(`${sig} 后自动凭据被删除`, !existsSync(tf), `exists=${existsSync(tf)}`);
    }
  },
});

C({
  id: "E2E-N-24", stage: 2, kind: "legal", guards: ["G-12"], dbSuite: "n24-serve-stays-up",
  title: "运行期间不误触发停机（端口保持占用、服务保持可用）",
  source: "safety-checklist.md §2.3（仅在收到 SIGINT/SIGTERM 后才停机）；MANUAL.md §7",
  expect: "连续 3 次探活（间隔 0.5s）均 HTTP 200 · 端口全程处于 LISTEN · 进程未被回收",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    const base = `http://127.0.0.1:${s.port}`;
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await c.http("GET", `${base}/api/health`)).status);
      await sleep(500);
      c.expectTrue(`第 ${i + 1} 次探活后端口仍 LISTEN`, listenersOn(s.port) !== "", `listeners=${listenersOn(s.port) || "(none)"}`);
    }
    c.expectTrue("3 次探活均 200", codes.every((x) => x === 200), `codes=${codes.join(",")}`);
    c.expectTrue("进程仍存活", s.child.exitCode === null, `exitCode=${s.child.exitCode}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-25", stage: 2, kind: "violation", guards: ["G-13"], dbSuite: "n25-explicit-token-kept",
  title: "显式令牌启动：停机后外部凭据文件不被删除",
  source: "MANUAL.md §7 令牌生命周期（--token 显式指定的令牌不删除）；矩阵 G-13 预期",
  expect: "exit 0（SIGTERM）· 预置凭据文件停机后仍存在且内容等于显式令牌",
  run: async (c) => {
    await seedAcct(c);
    const tf = join(SANDBOX_ART, "n25-external.token");
    const tok = "e2e-explicit-" + "b".repeat(52);
    writeFileSync(tf, `${tok}\n`);
    const s = await c.serve({ tokenFile: tf, explicitToken: tok });
    c.expectTrue("健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
    c.expectTrue("停机后外部凭据文件仍存在", existsSync(tf), `exists=${existsSync(tf)}`);
    c.expectTrue("内容等于显式令牌", readFileSync(tf, "utf-8").trim() === tok, `content_len=${readFileSync(tf, "utf-8").trim().length}`);
  },
});

C({
  id: "E2E-N-26", stage: 2, kind: "legal", guards: ["G-13"], dbSuite: "n26-explicit-token-auth",
  title: "显式令牌可正常鉴权（不误伤）",
  source: "MANUAL.md §7（--token 固定令牌，Bearer / ?token= 均可）；./trade serve --help",
  expect: "带显式令牌的 /api/summary HTTP 200",
  run: async (c) => {
    await seedAcct(c);
    const tok = "e2e-explicit-" + "c".repeat(52);
    const s = await c.serve({ explicitToken: tok });
    const a = await c.http("GET", `http://127.0.0.1:${s.port}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200, "显式令牌 → 200");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-27", stage: 2, kind: "violation", guards: ["G-14"], dbSuite: "n27-degraded-orphan",
  title: "账本结构异常（有流水无批次）报降级并给出原因",
  source: "MANUAL.md §7「查不到 ≠ 没有」降级防线（触发条件①）；本线任务书补充（孤儿数据期望 degraded:true 并带原因）",
  expect: "/api/summary 与 /api/lots 均 HTTP 200 且 degraded=true · degraded_reason 非空",
  run: async (c) => {
    await seedAcct(c);
    await buyCost(c, { symbol: "518880.SH", cost: 2000 });
    const inj = c.sql("delete from lots;");
    c.expectTrue("注入孤儿账本：trades 保留 / lots 清空", Number(sqlOne(c.db, "select count(*) from trades;")) > 0 && Number(sqlOne(c.db, "select count(*) from lots;")) === 0, `trades=${sqlOne(c.db, "select count(*) from trades;")} lots=${sqlOne(c.db, "select count(*) from lots;")}`);
    c.note(`沙箱内状态注入（仅 /tmp 沙箱库）：${inj.cmd}`);
    const s = await c.serve({});
    const tok = s.readToken();
    const base = `http://127.0.0.1:${s.port}`;
    const a = await c.http("GET", `${base}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    const b = await c.http("GET", `${base}/api/lots`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200, "/api/summary 仍 200");
    c.expectTrue("summary degraded=true", a.bodyJson?.degraded === true, `degraded=${a.bodyJson?.degraded}`);
    c.expectTrue("summary degraded_reason 非空", typeof a.bodyJson?.degraded_reason === "string" && a.bodyJson.degraded_reason.length > 0, `reason=${a.bodyJson?.degraded_reason}`);
    c.expectTrue("lots degraded=true", b.bodyJson?.degraded === true, `degraded=${b.bodyJson?.degraded}`);
    c.expectTrue("lots degraded_reason 非空", typeof b.bodyJson?.degraded_reason === "string" && b.bodyJson.degraded_reason.length > 0, `reason=${b.bodyJson?.degraded_reason}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-28", stage: 2, kind: "legal", guards: ["G-14"], dbSuite: "n28-degraded-empty",
  title: "白板空库不误报降级",
  source: "MANUAL.md §7 负向防误杀（全新白板空库标记 degraded:false）；本线任务书补充",
  expect: "/api/summary HTTP 200 且 degraded=false · degraded_reason=null",
  run: async (c) => {
    await c.trade("account list", ["--json"]);
    const s = await c.serve({});
    const tok = s.readToken();
    const a = await c.http("GET", `http://127.0.0.1:${s.port}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200);
    c.expectTrue("degraded=false", a.bodyJson?.degraded === false, `degraded=${a.bodyJson?.degraded}`);
    c.expectTrue("degraded_reason=null", a.bodyJson?.degraded_reason === null, `reason=${a.bodyJson?.degraded_reason}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-29", stage: 2, kind: "violation", guards: ["G-15"], dbSuite: "n29-cap-block",
  title: "组合级 30% 硬顶：越线买入被拦截",
  source: "safety-checklist.md §4.1（单标的拟买入后占比超过总投资组合 30.00% 时坚决拦截）；acceptance-cases.md TC-N07",
  expect: "exit≠0 · lots 不变 · trades 不变 · stderr 含「30」与硬顶文案（标的总 4000 / 其他标的 7000 → 占比 36.36%）",
  run: async (c) => {
    await seedAcct(c);
    const anchor = await buyCost(c, { symbol: "159934.SZ", cost: 7000, reason: "锚定其他标的（旁路建仓）" });
    c.expectExit(anchor, 0, "前置：锚定标的建仓 exit 0");
    const r = await buyCost(c, { symbol: "518880.SH", cost: 4000, skip: false, reason: "越线买入" });
    c.expectExit(r, "nonzero", "越线买入必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /30/, "文案含 30% 硬顶");
  },
});

C({
  id: "E2E-N-30", stage: 2, kind: "legal", guards: ["G-15"], dbSuite: "n30-cap-pass",
  title: "线内买入放行（硬顶不误杀）",
  source: "safety-checklist.md §4.1；acceptance-cases.md TC-N01（合法入参防误杀）",
  expect: "exit 0 · lots+1 · trades+1（标的总 2000 / 其他标的 7000 → 占比 22.22%）",
  run: async (c) => {
    await seedAcct(c);
    const anchor = await buyCost(c, { symbol: "159934.SZ", cost: 7000, reason: "锚定其他标的（旁路建仓）" });
    c.expectExit(anchor, 0);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 2000, skip: false, reason: "线内买入" });
    c.expectExit(r, 0, "线内买入必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-31", stage: 2, kind: "violation", guards: ["G-16"], dbSuite: "n31-cap-boundary-over",
  title: "硬顶边界：刚越线 0.001% 也必须拦截",
  source: "safety-checklist.md §4.1（超过 30.00% 坚决拦截）；MANUAL.md 铁律 4",
  expect: "exit≠0 · lots 不变（预算 10000、拟买 3000.10 元 → 占比 30.001%，严格大于阈值）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 3000.10, skip: false, env: BUDGET_ENV, reason: "越线 0.001%" });
    c.expectExit(r, "nonzero", "越线 0.001% 必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /30/, "文案含 30% 硬顶");
  },
});

C({
  id: "E2E-N-32", stage: 2, kind: "legal", guards: ["G-16"], dbSuite: "n32-cap-boundary-on",
  title: "硬顶边界：恰好 30.00% 放行（严格大于才拦截）",
  source: "safety-checklist.md §4.1（「超过 30.00% 时」才拦截，等于不算超过）；MANUAL.md 铁律 4",
  expect: "exit 0 · lots+1 · trades+1（预算 10000、拟买 3000.00 元 → 占比恰好 30.00%）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 3000.00, skip: false, env: BUDGET_ENV, reason: "恰好 30%" });
    c.expectExit(r, 0, "恰好线上必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-33", stage: 2, kind: "violation", guards: ["G-17"], dbSuite: "n33-skip-risk-on",
  title: "显式旁路参数生效：越线买入被放行并落库",
  source: "safety-checklist.md §4.1；./trade lot buy --help（--skip-risk: Skip the pre-trade full-position budget check）；矩阵 G-17 预期",
  expect: "exit 0 · lots+1 · trades+1（预算 10000、拟买 4000 元 → 占比 40%，本应被硬顶拦截，带 --skip-risk 后放行）",
  run: async (c) => {
    await seedAcct(c);
    const blocked = await buyCost(c, { symbol: "518880.SH", cost: 4000, skip: false, env: BUDGET_ENV, reason: "先证明会被拦" });
    c.expectExit(blocked, "nonzero", "对照：不带旁路时同一输入被拦截");
    const r = await buyCost(c, { symbol: "518880.SH", cost: 4000, env: BUDGET_ENV, reason: "带旁路买入" });
    c.expectExit(r, 0, "带 --skip-risk 必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-34", stage: 2, kind: "legal", guards: ["G-17"], dbSuite: "n34-skip-risk-off",
  title: "线内买入不带旁路也正常放行（旁路守卫不误伤）",
  source: "safety-checklist.md §4.1；acceptance-cases.md TC-N01",
  expect: "exit 0 · lots+1 · trades+1（预算 10000、拟买 2000 元 → 占比 20%，不触发旁路）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 2000, skip: false, env: BUDGET_ENV, reason: "线内买入" });
    c.expectExit(r, 0, "线内买入必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-35", stage: 2, kind: "legal", guards: ["G-18"], dbSuite: "n35-cap-same-symbol-nobudget",
  title: "空组合且无预算时首个标的买入不受 30% 上限约束（K-01 已裁定：现状合理）",
  source: "老板 2026-10-24 裁定 K-01（现状合理，不记缺陷）：空组合且无预算时，第一个标的的买入不受 30% 上限约束；矩阵 §13 D-13 记录的「跨标的组合窗口」实测口径",
  expect: "exit 0 · lots+1 · trades+1 · 无硬顶拦截文案（老板 2026-10-24 裁定 K-01：该行为现状合理，不作为缺陷）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 20064, skip: false, reason: "K01-单标的无预算" });
    c.expectExit(r, 0, "空组合且无预算时首个标的买入必须放行（K-01）");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
    c.expectNoText(r, /硬顶|超过 30\.00%/, "不得出现硬顶拦截文案（K-01）");
  },
});

C({
  id: "E2E-N-36", stage: 2, kind: "legal", guards: ["G-18"], dbSuite: "n36-cap-same-symbol-under",
  title: "同一标的继续累加但占比仍低于 30% 时放行",
  source: "safety-checklist.md §4.1（未超 30% 不得拦截）；acceptance-cases.md TC-N01",
  expect: "exit 0 · lots+1（预算 10000：先买 2000 元=20%，再买同一标的 1000 元 → 累计 3000 元=30%，两次都放行）",
  run: async (c) => {
    await seedAcct(c);
    const a = await buyCost(c, { symbol: "518880.SH", cost: 2000, skip: false, env: BUDGET_ENV, reason: "同标的首笔" });
    c.expectExit(a, 0, "首笔 20% 放行");
    const b = await buyCost(c, { symbol: "518880.SH", cost: 1000, skip: false, env: BUDGET_ENV, reason: "同标的追加" });
    c.expectExit(b, 0, "同标的追加至 30% 放行");
    c.expectDelta(b, "lots", 1);
    c.expectDelta(b, "trades", 1);
  },
});
C({
  id: "E2E-N-99", stage: 2, kind: "violation", guards: ["G-18"], dbSuite: "n99-cap-window-boundary",
  title: "K-01 裁定的边界：组合内已有其他标的时 30% 组合窗口照常拦截",
  source: "老板 2026-10-24 裁定 K-01（仅「空组合且无预算」豁免，一旦组合内有其他标的，30% 组合窗口照常生效）；safety-checklist.md §4.1（越线坚决拦截）；矩阵 G-18 预期（跨标的组合窗口口径）",
  expect: "exit≠0 · lots/trades 不变 · 文案含 30% 硬顶（锚定其他标的成本 7000 元后拟买 4000 元 → 窗口占比 4000／11000＝36.36%）",
  run: async (c) => {
    await seedAcct(c);
    const anchor = await buyCost(c, { symbol: "159934.SZ", cost: 7000, skip: true, reason: "锚定其他标的（旁路建仓）" });
    c.expectExit(anchor, 0, "前置：锚定标的建仓 exit 0");
    const r = await buyCost(c, { symbol: "518880.SH", cost: 4000, skip: false, reason: "K01-窗口越线" });
    c.expectExit(r, "nonzero", "组合内已有其他标的时，窗口越线必须拦截（K-01 边界）");
    c.expectDeltaAll(r, 0, "拦截后零写入（K-01 边界）");
    c.expectText(r, /30|硬顶/, "文案含 30% 硬顶（K-01 边界）");
  },
});

C({
  id: "E2E-N-37", stage: 2, kind: "violation", guards: ["G-19"], dbSuite: "n37-cooldown-block",
  title: "同源血缘链 48h 冷却期内二次加仓被拦截",
  source: "safety-checklist.md §6.1（同源血缘链 48 小时内已发生过加仓，严格拦截频密补仓）；acceptance-cases.md TC-N02",
  expect: "首次加仓 exit 0（守卫前提是「已发生过加仓」）· 第二次加仓 exit≠0 · lots/trades 不变 · stderr 含「防抖」或「48」",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const parent = dataOf(c, b, "lot buy")?.lot_id;
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0, "首个加仓（链上尚无加仓）放行");
    const a2 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a2, "nonzero", "冷却期内二次加仓必须拦截");
    c.expectDeltaAll(a2, 0, "拦截后零写入");
    c.expectText(a2, /防抖|48/, "文案含 48 小时防抖冷却");
  },
});

C({
  id: "E2E-N-38", stage: 2, kind: "legal", guards: ["G-19"], dbSuite: "n38-cooldown-pass",
  title: "上次加仓已在 48h 之外时正常放行（冷却守卫不误伤）",
  source: "safety-checklist.md §6.1；acceptance-cases.md TC-N03（超过 48 小时冷却窗口后的同源加仓必须正常放行）",
  expect: "回填父批次（50h 前）与首笔加仓（49h 前）后，本次加仓 exit 0 · lots+1 · trades+1 · 无冷却拒绝文案",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const p = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--time", hoursAgoIso(50), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(p, 0);
    const parent = dataOf(c, p, "lot buy(回填父批次)")?.lot_id;
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--time", hoursAgoIso(49), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0, "历史回填的首笔加仓放行");
    const a2 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a2, 0, "上次加仓在 49 小时前 → 必须放行");
    c.expectDelta(a2, "lots", 1);
    c.expectDelta(a2, "trades", 1);
    c.expectNoText(a2, /防抖/, "不得出现冷却拒绝文案");
  },
});

C({
  id: "E2E-N-39", stage: 2, kind: "violation", guards: ["G-20"], dbSuite: "n39-pyramid-transition",
  title: "冷却窗口外状态转换发生：生成子批次且层级递增",
  source: "safety-checklist.md §6.2（子批次继承父血缘且 pyramid_level = parent.pyramid_level + 1）；矩阵 G-20 预期",
  expect: "exit 0 · lots+1 · 新批次 parent_lot_id=父批次 · pyramid_level=父+1",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const p = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--time", hoursAgoIso(50), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(p, 0);
    const parent = dataOf(c, p, "lot buy(回填父批次)")?.lot_id;
    const lvl = Number(sqlOne(c.db, `select pyramid_level from lots where lot_id='${parent}';`));
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "冷却窗口外转换发生");
    c.expectDelta(r, "lots", 1);
    const child = sqlOne(c.db, `select lot_id||'|'||coalesce(parent_lot_id,'')||'|'||pyramid_level from lots where parent_lot_id='${parent}' order by lot_id desc limit 1;`).split("|");
    c.expectTrue("子批次继承父血缘", child[1] === parent, `parent_lot_id=${child[1]}`);
    c.expectTrue(`pyramid_level=父+1(${lvl + 1})`, Number(child[2]) === lvl + 1, `actual=${child[2]}`);
  },
});

C({
  id: "E2E-N-40", stage: 2, kind: "legal", guards: ["G-20"], dbSuite: "n40-pyramid-no-transition",
  title: "冷却窗口内状态转换不发生：不生成子批次、层级不递增",
  source: "safety-checklist.md §6.1+§6.2（冷却拦截必须先于层级递增生效）；MANUAL.md 铁律 3",
  expect: "第二次加仓 exit≠0 · 该父批次下子批次数不变 · 已有子批次 pyramid_level 不变",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    const parent = dataOf(c, b, "lot buy")?.lot_id;
    c.expectExit(b, 0);
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0);
    const snap = sqlOne(c.db, `select group_concat(lot_id||':'||pyramid_level) from lots where parent_lot_id='${parent}';`);
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, "nonzero", "冷却期内不得发生转换");
    const snap2 = sqlOne(c.db, `select group_concat(lot_id||':'||pyramid_level) from lots where parent_lot_id='${parent}';`);
    c.expectTrue("子批次集合与层级零变化", snap === snap2, `before=${snap} after=${snap2}`);
    c.expectDeltaAll(r, 0, "无新批次、无新流水");
  },
});

C({
  id: "E2E-N-41", stage: 2, kind: "violation", guards: ["G-21"], dbSuite: "n41-future-time-bypass",
  title: "未来成交时间不得绕过 48h 冷却（缺陷 D-01 回归）",
  source: "safety-checklist.md §6.1（冷却判断应以真实时钟为准，未来成交时间不得成为绕过口）；MANUAL.md 铁律 3",
  expect: "链上已有近期加仓时，把本次加仓 --time 写成未来值必须仍被拦截（exit≠0 · lots/trades 零变化）；文案指出拦截原因（冷却窗口或成交时间晚于当前）；现状被放行即 FAIL（缺陷 D-01）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const parent = dataOf(c, b, "lot buy")?.lot_id;
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0, "链上先发生一次加仓（近实时）");
    const future = new Date(Date.now() + 50 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", "ACC", "--time", future, "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, "nonzero", "未来成交时间的加仓必须被拦截（D-01）");
    c.expectDeltaAll(r, 0, "拦截后零写入（D-01）");
    // D-01 修法为「冷却改用真实时钟 + 新增『成交时间不得晚于当前』守卫」，因此未来时间的
    // 拦截文案改为后者；两条路径都属于合规拦截原因，断言放宽为「二者之一」。
    c.expectText(r, /晚于当前时间|防抖|48/, "文案指出拦截原因（成交时间晚于当前 / 冷却窗口）（D-01）");
  },
});

C({
  id: "E2E-N-42", stage: 2, kind: "legal", guards: ["G-21"], dbSuite: "n42-real-time-pass",
  title: "真实时间轴上的合法加仓不被误伤",
  source: "safety-checklist.md §6.1/§6.2；acceptance-cases.md TC-N03",
  expect: "回填父批次（50h）+ 历史首笔加仓（49h）后，本次（真实时间）加仓 exit 0 · lots+1 · 无冷却文案",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const p = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--time", hoursAgoIso(50), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(p, 0);
    const parent = dataOf(c, p, "lot buy(回填父批次)")?.lot_id;
    const a1 = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.99)), "--qty", "100", "--account", "ACC", "--time", hoursAgoIso(49), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a1, 0);
    const r = await c.trade("lot add", ["--parent-lot-id", parent, "--price", String(r4(cur * 0.98)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "真实时间轴上的合法加仓必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectNoText(r, /防抖/, "不得出现冷却文案");
  },
});

C({
  id: "E2E-N-43", stage: 2, kind: "violation", guards: ["G-22"], dbSuite: "n43-qty-illegal",
  title: "非法股数（非整百 / 零 / 负数）逐条拦截",
  source: "safety-checklist.md §4.1 上下文；acceptance-cases.md TC-N01（整百股数）；矩阵 G-22 预期",
  expect: "qty=150 / 0 / -100 三次均 exit≠0 · 每次 lots/trades 零变化 · 文案说明股数约束（「100 股整数倍」或「必须为正整数股数」）",
  run: async (c) => {
    await seedAcct(c);
    for (const q of ["150", "0", "-100"]) {
      const r = await c.trade("lot buy", ["518880.SH", "--price", "2.0000", "--qty", q, "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
      c.expectExit(r, "nonzero", `qty=${q} 必须拦截`);
      c.expectDeltaAll(r, 0, `qty=${q} 零写入`);
      c.expectText(r, /整数倍|必须为正整数|大于 0/, `qty=${q} 文案说明股数约束`);
    }
  },
});

C({
  id: "E2E-N-44", stage: 2, kind: "legal", guards: ["G-22"], dbSuite: "n44-qty-legal",
  title: "合法整百股数放行（股数守卫不误伤）",
  source: "acceptance-cases.md TC-N01；regression-baseline.md §2",
  expect: "exit 0 · lots+1 · trades+1",
  run: async (c) => {
    await seedAcct(c);
    const r = await c.trade("lot buy", ["518880.SH", "--price", "2.0000", "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "整百股数必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-45", stage: 2, kind: "violation", guards: ["G-23"], dbSuite: "n45-close-over-qty",
  title: "平仓数量超过剩余可用量被拦截",
  source: "矩阵 G-23 预期（拒绝平仓）；./trade lot close --help（--qty 部分平仓）",
  expect: "exit≠0 · trades 不变 · 批次 remaining_quantity 不变 · 文案含「超过剩余可用数量」",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--qty", "99999", "--fee", "0", "--json"]);
    c.expectExit(r, "nonzero", "超量平仓必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /超过剩余可用数量/, "文案指出超出可用量");
    c.expectTrue("批次剩余量不变", sqlOne(c.db, `select remaining_quantity from lots where lot_id='${lot}';`) === "100", `remaining=${sqlOne(c.db, `select remaining_quantity from lots where lot_id='${lot}';`)}`);
  },
});

C({
  id: "E2E-N-46", stage: 2, kind: "legal", guards: ["G-23"], dbSuite: "n46-close-partial",
  title: "可用范围内的部分平仓放行（数量守卫不误伤）",
  source: "regression-baseline.md §2（支持指定数量部分平仓，剩余部分保持 ACTIVE）",
  expect: "exit 0 · trades+1 · remaining_quantity 由 100 降为 60（平仓 40 股）· 状态保持 ACTIVE",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--qty", "40", "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "部分平仓必须放行");
    c.expectDelta(r, "trades", 1);
    const d = dataOf(c, r, "lot close(部分)");
    c.expectTrue("remaining_quantity=60（100-40）", Number(d?.remaining_quantity) === 60, `remaining=${d?.remaining_quantity}`);
    c.expectTrue("状态保持 ACTIVE", d?.lot_status === "ACTIVE", `status=${d?.lot_status}`);
  },
});

C({
  id: "E2E-N-47", stage: 2, kind: "violation", guards: ["G-24"], dbSuite: "n47-close-acct-mismatch",
  title: "指定账户与批次归属不符时拒绝平仓",
  source: "矩阵 G-24 预期（拒绝平仓）；./trade lot close --help（--account Expected owning account (mismatch is rejected)）",
  expect: "exit≠0 · trades 不变 · 批次状态/剩余量不变 · 文案含「账户不匹配」",
  run: async (c) => {
    await seedAcct(c, "ACCA");
    await seedAcct(c, "ACCB");
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur)), "--account", "ACCB", "--fee", "0", "--json"]);
    c.expectExit(r, "nonzero", "账户不匹配必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /账户不匹配/, "文案指出账户不匹配");
  },
});

C({
  id: "E2E-N-48", stage: 2, kind: "legal", guards: ["G-24"], dbSuite: "n48-close-acct-ok",
  title: "账户归属正确时平仓放行（归属守卫不误伤）",
  source: "./trade lot close --help；矩阵 G-24 合法侧",
  expect: "exit 0 · trades+1 · 批次状态 CLOSED",
  run: async (c) => {
    await seedAcct(c, "ACCA");
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACCA", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur)), "--qty", "100", "--account", "ACCA", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "归属正确必须放行");
    c.expectDelta(r, "trades", 1);
    c.expectTrue("批次已 CLOSED", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "CLOSED", `status=${sqlOne(c.db, `select status from lots where lot_id='${lot}';`)}`);
  },
});

C({
  id: "E2E-N-49", stage: 2, kind: "violation", guards: ["G-25"], dbSuite: "n49-t1-locked",
  title: "法定 T+1 当日买入且账户无底仓时拒绝平仓",
  source: "regression-baseline.md §2 日内底仓置换法则；MANUAL.md 铁律 5；矩阵 G-25 预期",
  expect: "exit≠0 · trades 不变 · 批次状态不变 · 文案提示可指定 --substitute-core",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "510300.SH");
    const b = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "200", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(T+1 当日)")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--qty", "200", "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(r, "nonzero", "无底仓的当日 T+1 份额必须拒绝");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /T\+1|substitute-core/, "文案指出 T+1 锁定并提示代冲参数");
    c.expectTrue("批次仍 ACTIVE", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "ACTIVE", "status scan");
  },
});

C({
  id: "E2E-N-50", stage: 2, kind: "legal", guards: ["G-25"], dbSuite: "n50-t1-subcore-ok",
  title: "同账户有历史底仓时 --substitute-core 放行（T+1 锁定不误伤）",
  source: "regression-baseline.md §2 日内底仓置换法则（当日可用底仓量等于前一交易日活跃批次数量总和）",
  expect: "exit 0 · trades+1 · 当日批次剩余量归零 · substituted_core_lot_id 指向历史底仓",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "510300.SH");
    const core = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", "ACC", "--time", hoursAgoIso(30), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(core, 0);
    const coreId = dataOf(c, core, "lot buy(历史底仓)")?.lot_id;
    const today = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "200", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(today, 0);
    const lot = dataOf(c, today, "lot buy(当日)")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--qty", "200", "--account", "ACC", "--substitute-core", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "有底仓时代冲必须放行");
    c.expectDelta(r, "trades", 1);
    c.expectTrue("代冲底仓指向历史底仓", sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${lot}';`) === coreId, `actual=${sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${lot}';`)}`);
  },
});

C({
  id: "E2E-N-51", stage: 2, kind: "violation", guards: ["G-26"], dbSuite: "n51-subcore-cross-acct",
  title: "跨账户代冲被拒（代冲配额按账户隔离）",
  source: "MANUAL.md 铁律 5（日内代冲严禁跨账户挪用底仓）；acceptance-cases.md TC-N08",
  expect: "exit≠0 · trades 不变 · B 账户当日批次状态/剩余量不变 · 文案指出可用配额不足",
  run: async (c) => {
    await seedAcct(c, "XA");
    await seedAcct(c, "XB");
    const cur = await currentPrice(c, "510300.SH");
    const coreA = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", "XA", "--time", hoursAgoIso(30), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(coreA, 0, "A 账户历史底仓就位");
    const todayB = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "200", "--account", "XB", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(todayB, 0);
    const lotB = dataOf(c, todayB, "lot buy(B 当日)")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lotB, "--price", String(r4(cur * 1.01)), "--qty", "200", "--account", "XB", "--substitute-core", "--fee", "0", "--json"]);
    c.expectExit(r, "nonzero", "跨账户代冲必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /配额不足|底仓/, "文案指出底仓配额不足");
    c.expectTrue("B 当日批次仍 ACTIVE 且剩余量未变", sqlOne(c.db, `select status||'|'||remaining_quantity from lots where lot_id='${lotB}';`) === "ACTIVE|200", `actual=${sqlOne(c.db, `select status||'|'||remaining_quantity from lots where lot_id='${lotB}';`)}`);
  },
});

C({
  id: "E2E-N-52", stage: 2, kind: "legal", guards: ["G-26"], dbSuite: "n52-subcore-same-acct",
  title: "本账户补足底仓后代冲放行（账户隔离不误伤）",
  source: "MANUAL.md 铁律 5；regression-baseline.md §2；矩阵 G-26 合法侧（给 B 补上自己的底仓后放行）",
  expect: "exit 0 · trades+1 · B 当日批次剩余量归零 · substituted_core_lot_id 指向 B 自己的底仓",
  run: async (c) => {
    await seedAcct(c, "XA");
    await seedAcct(c, "XB");
    const cur = await currentPrice(c, "510300.SH");
    const coreA = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", "XA", "--time", hoursAgoIso(30), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(coreA, 0);
    const coreB = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", "XB", "--time", hoursAgoIso(30), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(coreB, 0, "B 账户自己的历史底仓就位");
    const coreBId = dataOf(c, coreB, "lot buy(B 底仓)")?.lot_id;
    const todayB = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "200", "--account", "XB", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(todayB, 0);
    const lotB = dataOf(c, todayB, "lot buy(B 当日)")?.lot_id;
    const r = await c.trade("lot close", ["--lot-id", lotB, "--price", String(r4(cur * 1.01)), "--qty", "200", "--account", "XB", "--substitute-core", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "本账户有底仓时代冲必须放行");
    c.expectDelta(r, "trades", 1);
    c.expectTrue("代冲底仓指向 B 自己的底仓", sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${lotB}';`) === coreBId, `actual=${sqlOne(c.db, `select substituted_core_lot_id from lots where lot_id='${lotB}';`)}`);
  },
});

C({
  id: "E2E-N-53", stage: 2, kind: "violation", guards: ["G-27"], dbSuite: "n53-close-twice",
  title: "已 CLOSED 批次重复平仓被拒绝",
  source: "矩阵 G-27 预期（拒绝重复平仓）；./trade lot close --help",
  expect: "exit≠0 · trades 不变 · 批次状态仍为 CLOSED · 文案含「已经是 CLOSED」",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const c1 = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(c1, 0, "首次全部平仓 exit 0");
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.02)), "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(r, "nonzero", "重复平仓必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /CLOSED/, "文案指出批次已 CLOSED");
    c.expectTrue("状态仍为 CLOSED", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "CLOSED", "status scan");
  },
});

C({
  id: "E2E-N-54", stage: 2, kind: "legal", guards: ["G-27"], dbSuite: "n54-close-once",
  title: "活跃批次单次平仓状态转换成立（重复平仓门不误伤）",
  source: "regression-baseline.md §2；release-gate.md Gate 3 步骤 5",
  expect: "exit 0 · trades+1 · 状态 ACTIVE→CLOSED",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    c.expectTrue("前置状态 ACTIVE", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "ACTIVE", "status before");
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.01)), "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "单次平仓必须放行");
    c.expectDelta(r, "trades", 1);
    c.expectTrue("状态转换为 CLOSED", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "CLOSED", `status=${sqlOne(c.db, `select status from lots where lot_id='${lot}';`)}`);
  },
});

C({
  id: "E2E-N-55", stage: 2, kind: "violation", guards: ["G-28"], dbSuite: "n55-edit-append",
  title: "理由追加生效且会计/状态字段零漂移（含 --buy-reason 的声明契约）",
  source: "./trade lot edit --help（--append Append to the existing thesis）；./trade lot buy --help（建仓侧的理由旗标是 --reason）；MANUAL.md 铁律 6；矩阵 G-28 预期",
  expect: "`lot buy --buy-reason` 属未声明参数必须 exit≠0 且零写入（--buy-reason 只属于 `lot edit`）· 建仓用 --reason exit 0 · edit --append exit 0 · 各表行数 0 变化 · buy_reason = 原值+追加值 · cost_basis_unit/status/remaining_quantity/realized_pnl 零漂移",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    // 声明契约：`lot buy --help` 只声明 --reason；--buy-reason 是 `lot edit` 的旗标。
    // D-03 生效后把它传给 `lot buy` 会被判为未声明参数并拒（本用例顺带把这条契约钉死，
    // 原用例误用该旗标建仓，是靠 D-03 的静默忽略才「通过」的）。
    const alias = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--buy-reason", "original-thesis", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(alias, "nonzero", "`lot buy --buy-reason` 属未声明参数，必须被拒（D-03 契约）");
    c.expectDeltaAll(alias, 0, "未声明参数被拒后零写入");
    c.expectText(alias, /未声明的参数|--buy-reason/, "文案指出未声明参数 --buy-reason");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--reason", "original-thesis", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const q = "coalesce(buy_reason,'')||'|'||cost_basis_unit||'|'||status||'|'||remaining_quantity||'|'||realized_pnl";
    const before = sqlOne(c.db, `select ${q} from lots where lot_id='${lot}';`);
    const r = await c.trade("lot edit", ["--lot-id", lot, "--buy-reason", "appended-thesis", "--append", "--json"]);
    c.expectExit(r, 0, "理由追加必须成功");
    c.expectDeltaAll(r, 0, "理由修改不改行数");
    const after = sqlOne(c.db, `select ${q} from lots where lot_id='${lot}';`);
    const [br, ...restBefore] = before.split("|");
    const [ar, ...restAfter] = after.split("|");
    c.expectTrue("buy_reason 在原值上追加", ar.startsWith(br) && ar !== br, `before=${br} after=${ar}`);
    c.expectTrue("会计与状态字段零漂移", restBefore.join("|") === restAfter.join("|"), `before=${restBefore.join("|")} after=${restAfter.join("|")}`);
  },
});

C({
  id: "E2E-N-56", stage: 2, kind: "legal", guards: ["G-28"], dbSuite: "n56-edit-no-reason",
  title: "无理由的 edit 被拒且零字段漂移（安全更新不误伤）",
  source: "./trade lot edit --help；矩阵 G-28 预期（会计与状态字段零漂移）",
  expect: "exit≠0 · 各表行数 0 变化 · 全部会计/状态/理由字段逐字节不变 · 文案提示 Missing reason",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--reason", "keep-me", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0, "建仓侧理由旗标是 --reason（lot buy --help）");
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const snap = sqlOne(c.db, `select * from lots where lot_id='${lot}';`);
    const r = await c.trade("lot edit", ["--lot-id", lot, "--json"]);
    c.expectExit(r, "nonzero", "无理由必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /reason/, "文案提示缺少理由");
    c.expectTrue("批次整行逐字节不变", sqlOne(c.db, `select * from lots where lot_id='${lot}';`) === snap, `before=${snap.slice(0, 80)}`);
  },
});

C({
  id: "E2E-N-57", stage: 2, kind: "violation", guards: ["G-29"], dbSuite: "n57-deep-value-alert",
  title: "深跌越线：发出 DEEP_VALUE_ALERT 且严禁冻结、仍可平仓",
  source: "safety-checklist.md §5.1/§5.2（跌幅超 -20% 严禁冻结，必须保持 ACTIVE 并标注 DEEP_VALUE_ALERT）；acceptance-cases.md TC-N06",
  expect: "scan exit 0 且该批次命中 DEEP_VALUE_ALERT（payload status_preserved=ACTIVE / is_frozen=false）· lots.status 保持 ACTIVE · 平仓 exit 0 且状态转 CLOSED",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 0.75)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(深跌构造)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const sig = (c.json(sc)?.data?.signals ?? []).find((s: any) => s.lot_id === lot && s.signal_type === "DEEP_VALUE_ALERT");
    c.expectTrue("命中 DEEP_VALUE_ALERT", !!sig, `types=${(c.json(sc)?.data?.signals ?? []).map((s: any) => s.signal_type).join(",")}`);
    c.expectTrue("payload 声明 status_preserved=ACTIVE", sig?.payload?.status_preserved === "ACTIVE", `payload=${JSON.stringify(sig?.payload ?? {}).slice(0, 160)}`);
    c.expectTrue("payload 声明 is_frozen=false", sig?.payload?.is_frozen === false, `is_frozen=${sig?.payload?.is_frozen}`);
    c.expectTrue("批次状态仍 ACTIVE（未冻结）", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "ACTIVE", `status=${sqlOne(c.db, `select status from lots where lot_id='${lot}';`)}`);
    const r = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur)), "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(r, 0, "深跌批次仍可正常平仓");
    c.expectTrue("平仓后状态 CLOSED", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "CLOSED", "status after close");
  },
});

C({
  id: "E2E-N-58", stage: 2, kind: "legal", guards: ["G-29"], dbSuite: "n58-not-deep",
  title: "未达深跌阈值不误报 DEEP_VALUE_ALERT、状态不转换",
  source: "safety-checklist.md §5.1（跌幅超 -20% 才进入深跌区）；acceptance-cases.md TC-N04/N05 同源防误杀纪律",
  expect: "scan exit 0 且该批次无 DEEP_VALUE_ALERT · lots.status 仍 ACTIVE",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur * 1.02)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(-1.96%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const hits = (c.json(sc)?.data?.signals ?? []).filter((s: any) => s.lot_id === lot);
    c.expectTrue("无 DEEP_VALUE_ALERT", !hits.some((s: any) => s.signal_type === "DEEP_VALUE_ALERT"), `types=${hits.map((s: any) => s.signal_type).join(",") || "(none)"}`);
    c.expectTrue("状态仍 ACTIVE", sqlOne(c.db, `select status from lots where lot_id='${lot}';`) === "ACTIVE", "status scan");
  },
});

C({
  id: "E2E-N-59", stage: 2, kind: "violation", guards: ["G-30"], dbSuite: "n59-trailing-alert",
  title: "浮盈越线且自峰值回撤越 3%：触发 TRAILING_STOP_ALERT",
  source: "regression-baseline.md §2（浮盈达 +15% 激活；自最高价回撤超 3% 立即发出 TRAILING_STOP_ALERT）；acceptance-cases.md TC-P04",
  expect: "首次 scan 后 trailing_stop_active=true · 峰值回撤越线后 scan 命中 TRAILING_STOP_ALERT（payload 含峰值 / 回撤比例 / 建议股数）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+16%)")?.lot_id;
    const sc1 = await c.trade("scan", ["--json"]);
    c.expectExit(sc1, 0);
    c.expectTrue("激活移动止盈", sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`) === "1", `flag=${sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`)}`);
    const inj = c.sql(`update lots set peak_price=${r4(cur * 1.05)} where lot_id='${lot}';`);
    c.note(`沙箱内状态注入（仅 /tmp 沙箱库，峰值只能随实时行情上行、无法用 CLI 制造回撤）：${inj.cmd}`);
    const sc2 = await c.trade("scan", ["--json"]);
    c.expectExit(sc2, 0);
    const sig = (c.json(sc2)?.data?.signals ?? []).find((s: any) => s.lot_id === lot && s.signal_type === "TRAILING_STOP_ALERT");
    c.expectTrue("命中 TRAILING_STOP_ALERT", !!sig, `types=${(c.json(sc2)?.data?.signals ?? []).map((s: any) => s.signal_type).join(",")}`);
    const pk = Object.keys(sig?.payload ?? {});
    c.expectTrue("payload 含峰值字段", pk.some((k) => /peak/i.test(k)), `keys=${pk.join(",")}`);
    c.expectTrue("payload 含回撤比例字段", pk.some((k) => /pull|draw/i.test(k)), `keys=${pk.join(",")}`);
    c.expectTrue("payload 含建议股数字段", pk.some((k) => /qty/i.test(k)), `keys=${pk.join(",")}`);
  },
});

C({
  id: "E2E-N-60", stage: 2, kind: "legal", guards: ["G-30"], dbSuite: "n60-trailing-no-alert",
  title: "已激活但回撤不足 3%：不触发 TRAILING_STOP_ALERT",
  source: "acceptance-cases.md TC-N05（已激活移动止盈的标的，回撤未达 3% 严禁误触发 TRAILING_STOP_ALERT）",
  expect: "trailing_stop_active=true（前提成立）· 峰值回撤 1.96% 时 scan 不得出现该批次的 TRAILING_STOP_ALERT",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+16%)")?.lot_id;
    const sc1 = await c.trade("scan", ["--json"]);
    c.expectExit(sc1, 0);
    c.expectTrue("激活移动止盈（前提成立）", sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`) === "1", `flag=${sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`)}`);
    const inj = c.sql(`update lots set peak_price=${r4(cur * 1.02)} where lot_id='${lot}';`);
    c.note(`沙箱内状态注入（仅 /tmp 沙箱库）：${inj.cmd}`);
    const sc2 = await c.trade("scan", ["--json"]);
    c.expectExit(sc2, 0);
    const hits = (c.json(sc2)?.data?.signals ?? []).filter((s: any) => s.lot_id === lot);
    c.expectTrue("回撤 1.96% 不得出现 TRAILING_STOP_ALERT", !hits.some((s: any) => s.signal_type === "TRAILING_STOP_ALERT"), `types=${hits.map((s: any) => s.signal_type).join(",") || "(none)"}`);
  },
});

C({
  id: "E2E-N-61", stage: 2, kind: "violation", guards: ["G-31"], dbSuite: "n61-no-false-alert",
  title: "回撤不足阈值 / 浮盈未达线时不得误报告警（误报抑制生效）",
  source: "acceptance-cases.md TC-N04（浮盈 +5%~+10% 严禁激活移动止盈）与 TC-N05（回撤 1%~2% 严禁误触发）；矩阵 G-31 预期",
  expect: "未达线批次 trailing_stop_active 保持 false 且无 TRAILING_STOP_ALERT；已激活但回撤 1.96% 的批次无 TRAILING_STOP_ALERT",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const a = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.10)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a, 0);
    const lotA = dataOf(c, a, "lot buy(+10%)")?.lot_id;
    const b = await c.trade("lot buy", ["159934.SZ", "--price", String(r4((await currentPrice(c, "159934.SZ")) / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lotB = dataOf(c, b, "lot buy(待激活)")?.lot_id;
    const sc1 = await c.trade("scan", ["--json"]);
    c.expectExit(sc1, 0);
    c.expectTrue("+10% 批次 trailing_stop_active 保持 false", sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lotA}';`) === "0", `flag=${sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lotA}';`)}`);
    const inj = c.sql(`update lots set peak_price=${r4(cur * 1.02)} where lot_id='${lotB}';`);
    c.note(`沙箱内状态注入（仅 /tmp 沙箱库）：${inj.cmd}`);
    const sc2 = await c.trade("scan", ["--json"]);
    c.expectExit(sc2, 0);
    const sigs = c.json(sc2)?.data?.signals ?? [];
    c.expectTrue("+10% 批次不得出现 TRAILING_STOP_ALERT", !sigs.some((s: any) => s.lot_id === lotA && s.signal_type === "TRAILING_STOP_ALERT"), `types=${sigs.filter((s: any) => s.lot_id === lotA).map((s: any) => s.signal_type).join(",") || "(none)"}`);
    c.expectTrue("回撤 1.96% 批次不得出现 TRAILING_STOP_ALERT", !sigs.some((s: any) => s.lot_id === lotB && s.signal_type === "TRAILING_STOP_ALERT"), `types=${sigs.filter((s: any) => s.lot_id === lotB).map((s: any) => s.signal_type).join(",") || "(none)"}`);
  },
});

C({
  id: "E2E-N-62", stage: 2, kind: "legal", guards: ["G-31"], dbSuite: "n62-alert-not-suppressed",
  title: "浮盈越线时止盈告警必须出现（抑制守卫不误吞真告警）",
  source: "regression-baseline.md §2（浮盈达 +15% 自动激活移动止盈）；safety-checklist.md §5.2 同源「必须标注告警」",
  expect: "scan exit 0 · 该批次命中止盈类告警（TAKE_PROFIT_ALERT 或 TRAILING_STOP_ALERT）· signals+1",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+16%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    c.expectDelta(sc, "signals", 1, "单个越线批次产生 1 条信号");
    const sig = (c.json(sc)?.data?.signals ?? []).find((s: any) => s.lot_id === lot);
    c.expectTrue("告警未被静默吞掉", !!sig && /TAKE_PROFIT|TRAILING_STOP/.test(String(sig.signal_type)), `signal_type=${sig?.signal_type}`);
  },
});

C({
  id: "E2E-N-63", stage: 2, kind: "violation", guards: ["G-32"], dbSuite: "n63-settlement-routing",
  title: "按结算机制与底仓可用量分流：T+1 锁定 / 天然 T+0 止盈各归其位",
  source: "acceptance-cases.md TC-N08（系统必须提示 T1_LOCKED_ALERT）；regression-baseline.md §2 日内底仓置换法则",
  expect: "T+1 当日无底仓的批次命中 T1_LOCKED_ALERT（不得报可卖止盈）· 天然 T+0 批次命中 TAKE_PROFIT_ALERT 且建议 CLOSE_PROFIT",
  run: async (c) => {
    await seedAcct(c);
    const curT1 = await currentPrice(c, "510300.SH");
    const curT0 = await currentPrice(c, "518880.SH");
    const t1 = await c.trade("lot buy", ["510300.SH", "--price", String(r4(curT1 / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(t1, 0);
    const lotT1 = dataOf(c, t1, "lot buy(T+1 当日 +16%)")?.lot_id;
    const t0 = await c.trade("lot buy", ["518880.SH", "--price", String(r4(curT0 / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(t0, 0);
    const lotT0 = dataOf(c, t0, "lot buy(NATIVE_T0 +16%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const sigs = c.json(sc)?.data?.signals ?? [];
    const sT1 = sigs.find((s: any) => s.lot_id === lotT1);
    const sT0 = sigs.find((s: any) => s.lot_id === lotT0);
    c.expectTrue("T+1 无底仓批次命中 T1_LOCKED_ALERT", sT1?.signal_type === "T1_LOCKED_ALERT", `signal_type=${sT1?.signal_type}`);
    c.expectTrue("T+1 批次不得报可卖止盈", sT1?.signal_type !== "TAKE_PROFIT_ALERT", `signal_type=${sT1?.signal_type}`);
    c.expectTrue("天然 T+0 批次命中 TAKE_PROFIT_ALERT", sT0?.signal_type === "TAKE_PROFIT_ALERT", `signal_type=${sT0?.signal_type}`);
    c.expectTrue("T+0 建议动作为 CLOSE_PROFIT", sT0?.suggested_action === "CLOSE_PROFIT", `suggested_action=${sT0?.suggested_action}`);
  },
});

C({
  id: "E2E-N-64", stage: 2, kind: "legal", guards: ["G-32"], dbSuite: "n64-t1-lock-not-misfire",
  title: "账户内已补足底仓时当日批次不再命中 T+1 锁定（分流不误判）",
  source: "regression-baseline.md §2（当日可用底仓量等于前一交易日活跃批次数量总和）；矩阵 G-32 预期（补足底仓后命中日内代冲止盈）",
  expect: "scan exit 0 · 当日 T+1 批次不得命中 T1_LOCKED_ALERT",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "510300.SH");
    const core = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur)), "--qty", "1000", "--account", "ACC", "--time", hoursAgoIso(30), "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(core, 0, "同账户历史底仓就位");
    const today = await c.trade("lot buy", ["510300.SH", "--price", String(r4(cur / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(today, 0);
    const lot = dataOf(c, today, "lot buy(T+1 当日 +16%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const hits = (c.json(sc)?.data?.signals ?? []).filter((s: any) => s.lot_id === lot);
    c.expectTrue("不得命中 T1_LOCKED_ALERT", !hits.some((s: any) => s.signal_type === "T1_LOCKED_ALERT"), `types=${hits.map((s: any) => s.signal_type).join(",") || "(none)"}`);
  },
});

C({
  id: "E2E-N-65", stage: 2, kind: "violation", guards: ["G-33"], dbSuite: "n65-threshold-override",
  title: "阈值覆盖必须生效且 help 示例键必须可用（缺陷 D-02 回归）",
  source: "./trade scan --help（Override signal thresholds, e.g. '{\"add\":-0.1,\"take\":0.1}'）；矩阵 §14.1 D-02（help 示例键与实现不一致）",
  expect: "+10% 批次在默认阈值下无信号；按 help 示例键覆盖后必须命中止盈信号（现状零信号即 FAIL）；按实现读取的键覆盖后应命中（对照）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.10)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+10%)")?.lot_id;
    const d = await c.trade("scan", ["--json"]);
    c.expectExit(d, 0);
    c.expectTrue("默认阈值下 +10% 无信号（前提）", !((c.json(d)?.data?.signals ?? []).some((s: any) => s.lot_id === lot)), "default scan");
    // D-02 的判据是「help 里给出的示例可用」，所以示例必须现场从 help 取，不能再写死一份
    // 可能过期的键集合（旧用例正是写死了 D-02 修复前的 add/take，D-07 生效后被拒 → 假 FAIL）。
    const help = await c.trade("scan", ["--help"]);
    c.expectExit(help, 0);
    const m = /Example:\s*'(\{[^']+\})'/.exec(help.stdout + help.stderr);
    c.expectTrue("scan --help 给出示例 JSON（D-02 前提）", !!m, `help=${(help.stdout + help.stderr).split("\n").slice(0, 12).join(" / ").slice(0, 240)}`);
    const example = m ? m[1] : "";
    const ex = await c.trade("scan", ["--json", "--thresholds", example]);
    c.expectExit(ex, 0, `照抄 help 示例必须被接受（example=${example}）`);
    c.expectTrue("help 示例键覆盖后 +10% 应命中止盈（D-02）", (c.json(ex)?.data?.signals ?? []).some((s: any) => s.lot_id === lot && /TAKE_PROFIT/.test(String(s.signal_type))), `example=${example} signals=${JSON.stringify((c.json(ex)?.data?.signals ?? []).map((s: any) => s.signal_type))}`);
    const stale = await c.trade("scan", ["--json", "--thresholds", '{"add":-0.1,"take":0.1}']);
    c.expectExit(stale, "nonzero", "D-02 修复前 help 里的旧示例键（add/take）现不在读取集内，必须被拒（D-07）");
    c.expectTrue("旧示例键被拒后零信号", ((c.json(stale)?.data?.signals ?? []) as any[]).length === 0, `stdout=${stale.stdout.slice(0, 160)}`);
    const wk = await c.trade("scan", ["--json", "--thresholds", '{"take_profit_min":0.05}']);
    c.expectExit(wk, 0);
    c.expectTrue("按实现读取的键覆盖后命中（对照）", (c.json(wk)?.data?.signals ?? []).some((s: any) => s.lot_id === lot && /TAKE_PROFIT/.test(String(s.signal_type))), `signals=${JSON.stringify((c.json(wk)?.data?.signals ?? []).map((s: any) => s.signal_type))}`);
  },
});

C({
  id: "E2E-N-66", stage: 2, kind: "legal", guards: ["G-33"], dbSuite: "n66-default-no-signal",
  title: "默认阈值下浮盈未达线：不激活移动止盈、不发卖出报警（不误伤）",
  source: "acceptance-cases.md TC-N04（浮盈 +5%/+10% 未达 +15% 阈值时严禁提前激活移动止盈，绝不发出卖出报警）；regression-baseline.md §2",
  expect: "浮盈 +5% 批次：trailing_stop_active 保持 0 · 无 TRAILING_STOP_ALERT · 无 TAKE_PROFIT_ALERT（均为终局卖出报警）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.05)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+5%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const hits = (c.json(sc)?.data?.signals ?? []).filter((s: any) => s.lot_id === lot);
    c.expectTrue("trailing_stop_active 严格保持 0", sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`) === "0", `flag=${sqlOne(c.db, `select trailing_stop_active from lots where lot_id='${lot}';`)}`);
    c.expectTrue("不发 TRAILING_STOP_ALERT", !hits.some((s: any) => s.signal_type === "TRAILING_STOP_ALERT"), `types=${hits.map((s: any) => s.signal_type).join(",") || "(none)"}`);
    c.expectTrue("不发 TAKE_PROFIT_ALERT", !hits.some((s: any) => s.signal_type === "TAKE_PROFIT_ALERT"), `types=${hits.map((s: any) => s.signal_type).join(",") || "(none)"}`);
  },
});

C({
  id: "E2E-N-67", stage: 2, kind: "violation", guards: ["G-34"], dbSuite: "n67-dividend-cash",
  title: "分红以累计现金形态入账（登记转换发生）",
  source: "SKILL.md §5（自动统计总分红金额）；MANUAL.md §8（自动输出累计分红总额及逐笔到账详情）；help dividend add/list",
  expect: "dividend add exit 0 · dividends+1 · dividend list --json total_amount=100.00 且流水含该笔（含除息日与账户）",
  run: async (c) => {
    await seedAcct(c);
    const r = await c.trade("dividend add", ["--symbol", "518880.SH", "--amount", "100.00", "--date", "2026-01-15", "--account", "ACC", "--notes", "e2e", "--json"]);
    c.expectExit(r, 0, "分红登记必须成功");
    c.expectDelta(r, "dividends", 1);
    const l = await c.trade("dividend list", ["--json"]);
    const d = dataOf(c, l, "dividend list");
    c.expectTrue("累计合计=100.00", Number(d?.total_amount) === 100, `total_amount=${d?.total_amount}`);
    const row = (d?.dividends ?? []).find((x: any) => Number(x.amount) === 100);
    c.expectTrue("流水含除息日与账户", row?.ex_date === "2026-01-15" && row?.account_id === "ACC", `row=${JSON.stringify(row ?? {}).slice(0, 160)}`);
  },
});

C({
  id: "E2E-N-68", stage: 2, kind: "legal", guards: ["G-34"], dbSuite: "n68-dividend-empty",
  title: "未登记分红的账本不虚增分红累计（登记门不误伤）",
  source: "SKILL.md §5；MANUAL.md §8；矩阵 DIV-LIST-EMPTY 预期（空库输出零笔与零金额）",
  expect: "dividend list exit 0 · total_amount=0 · dividends 表 0 行",
  run: async (c) => {
    await seedAcct(c);
    const l = await c.trade("dividend list", ["--json"]);
    c.expectExit(l, 0);
    const d = dataOf(c, l, "dividend list");
    c.expectTrue("累计合计=0", Number(d?.total_amount) === 0, `total_amount=${d?.total_amount}`);
    c.expectTrue("流水为空", (d?.dividends ?? []).length === 0, `n=${(d?.dividends ?? []).length}`);
    c.expectDelta(l, "dividends", 0, "读取不写库");
  },
});

C({
  id: "E2E-N-69", stage: 2, kind: "legal", guards: ["G-34"], dbSuite: "n69-dividend-cost-effect",
  title: "登记分红不冲减持仓成本、分红单独统计（K-02 已裁定：现状合理）",
  source: "老板 2026-10-24 裁定 K-02（现状合理，不记缺陷）：登记分红不冲减持仓成本，分红在战绩里单独统计；SKILL.md §5 / MANUAL.md §8 的累计分红口径",
  expect: "exit 0 · dividends+1 · 分红前后 cost_basis_unit／buy_price 逐字节相同 · dividend list 合计=登记金额 88.00（老板 2026-10-24 裁定 K-02）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const q = "cost_basis_unit||'|'||buy_price";
    const before = sqlOne(c.db, `select ${q} from lots where lot_id='${lot}';`);
    const div = await c.trade("dividend add", ["--symbol", "518880.SH", "--amount", "88.00", "--account", "ACC", "--json"]);
    c.expectExit(div, 0, "分红登记 exit 0（K-02）");
    c.expectDelta(div, "dividends", 1);
    const after = sqlOne(c.db, `select ${q} from lots where lot_id='${lot}';`);
    c.expectTrue("分红不冲减持仓成本（前后逐字节相同，K-02）", before === after, `before=${before} after=${after}`);
    const l = await c.trade("dividend list", ["--json"]);
    const d = dataOf(c, l, "dividend list");
    c.expectTrue("分红单独统计且合计=88.00（K-02）", Number(d?.total_amount) === 88, `total_amount=${d?.total_amount}`);
    c.note("老板 2026-10-24 裁定 K-02：现状合理，不记缺陷（分红不冲减成本、单独统计）。");
  },
});

C({
  id: "E2E-N-70", stage: 2, kind: "violation", guards: ["G-35"], dbSuite: "n70-dash-0600-forced",
  title: "看板产物必须 0600：预置宽权限文件也要被覆盖为 0600",
  source: "MANUAL.md §7 看板文件自身权限（写入时强制 chmod 0600，覆盖已存在的宽权限文件，生成后自校验）；safety-checklist.md §3.1",
  expect: "exit 0 · 预置 0644 的产物文件生成后权限位为 600",
  run: async (c) => {
    await seedAcct(c);
    const out = join(SANDBOX_ART, "n70-preset-wide.html");
    writeFileSync(out, "pre-existing wide file\n");
    chmodSync(out, 0o644);
    c.expectTrue("前置：预置文件权限 644", fileMode(out) === "644", `mode=${fileMode(out)}`);
    const r = await c.trade("dashboard", ["--out", out, "--token-file", join(SANDBOX_ART, "n70-absent.token"), "--json"]);
    c.expectExit(r, 0, "看板生成 exit 0");
    c.expectTrue("产物权限被收敛为 600", fileMode(out) === "600", `mode=${fileMode(out)}`);
  },
});

C({
  id: "E2E-N-71", stage: 2, kind: "legal", guards: ["G-35"], dbSuite: "n71-dash-single-file",
  title: "全新产物的 0600 与单文件自包含（权限门不误伤生成）",
  source: "regression-baseline.md §3（单文件直接双击打开）；MANUAL.md §7（产物 0600 + 自校验）",
  expect: "exit 0 · 产物非空且权限 600 · 无 http(s) 外部静态资源引用",
  run: async (c) => {
    await seedAcct(c);
    const out = join(SANDBOX_ART, "n71-fresh.html");
    const r = await c.trade("dashboard", ["--out", out, "--token", "n71-explicit-token-000000000000000000000000000000000000000000000000", "--json"]);
    c.expectExit(r, 0);
    c.expectTrue("产物非空", existsSync(out) && statSync(out).size > 10000, `size=${existsSync(out) ? statSync(out).size : 0}`);
    c.expectTrue("产物权限 600", fileMode(out) === "600", `mode=${fileMode(out)}`);
    const html = readFileSync(out, "utf-8");
    c.expectTrue("无外部静态资源引用", !/(src|href)="https?:\/\//.test(html), `external=${(html.match(/(src|href)="https?:\/\//g) ?? []).length}`);
  },
});

C({
  id: "E2E-N-72", stage: 2, kind: "violation", guards: ["G-36"], dbSuite: "n72-dash-token-inject",
  title: "有活跃凭据时令牌被注入页面且可直接调用本地引擎",
  source: "MANUAL.md §7 看板无感注入（注入 window.__LOT_TRADER_SESSION_TOKEN__，看板请求自动带 Bearer 头）",
  expect: "exit 0 · 产物含显式令牌字面量 · 用该令牌请求同库 serve 的 /api/summary HTTP 200",
  run: async (c) => {
    await seedAcct(c);
    const out = join(SANDBOX_ART, "n72-inject.html");
    const tok = "n72-token-" + "d".repeat(54);
    const r = await c.trade("dashboard", ["--out", out, "--token", tok, "--json"]);
    c.expectExit(r, 0);
    const html = readFileSync(out, "utf-8");
    c.expectTrue("令牌已注入页面", html.includes(`"${tok}"`), `inject=${html.includes(tok)}`);
    const s = await c.serve({ explicitToken: tok });
    const a = await c.http("GET", `http://127.0.0.1:${s.port}/api/summary`, { headers: [`Authorization: Bearer ${tok}`] });
    c.expectHttpStatus(a, 200, "注入的令牌可直接调用 /api/summary");
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-73", stage: 2, kind: "legal", guards: ["G-36"], dbSuite: "n73-dash-no-token",
  title: "无活跃凭据时页面留空并回落独立模式（不误伤生成）",
  source: "MANUAL.md §7（无凭据则留空；看板保持轻量独立模式）；./trade dashboard --help",
  expect: "exit 0 · 产物存在且非空 · 令牌占位符为空字符串 · 产物不包含任何形如 64 位 hex 的令牌",
  run: async (c) => {
    await seedAcct(c);
    const out = join(SANDBOX_ART, "n73-no-token.html");
    const r = await c.trade("dashboard", ["--out", out, "--token-file", join(SANDBOX_ART, "n73-absent.token"), "--json"]);
    c.expectExit(r, 0, "无凭据也必须能生成");
    c.expectTrue("产物非空", existsSync(out) && statSync(out).size > 10000, `size=${existsSync(out) ? statSync(out).size : 0}`);
    const html = readFileSync(out, "utf-8");
    c.expectTrue("令牌占位符为空", /window\.__LOT_TRADER_SESSION_TOKEN__\s*=\s*""/.test(html), `m=${JSON.stringify((html.match(/window\.__LOT_TRADER_SESSION_TOKEN__\s*=\s*"[^"]{0,20}/) ?? ["(none)"])[0])}`);
    c.expectTrue("无残留 64 位 hex 令牌", !/"[0-9a-f]{64}"/.test(html), "hex scan");
  },
});

C({
  id: "E2E-N-74", stage: 2, kind: "violation", guards: ["G-37"], dbSuite: "n74-dash-template-on",
  title: "指定自定义模板时产出自该模板",
  source: "./trade dashboard --help（--template Front-end template HTML path）；矩阵 G-37 预期",
  expect: "exit 0 · 产物含自定义模板标记 QA-CUSTOM-TEMPLATE-MARKER",
  run: async (c) => {
    await seedAcct(c);
    const tpl = join(SANDBOX_ART, "n74-template.html");
    const out = join(SANDBOX_ART, "n74-out.html");
    writeFileSync(tpl, readFileSync(join(REPO, "scripts/template_base.html"), "utf-8") + "\n<!-- QA-CUSTOM-TEMPLATE-MARKER -->\n");
    const r = await c.trade("dashboard", ["--out", out, "--template", tpl, "--token-file", join(SANDBOX_ART, "n74-absent.token"), "--json"]);
    c.expectExit(r, 0);
    c.expectTrue("模板标记生效", readFileSync(out, "utf-8").includes("QA-CUSTOM-TEMPLATE-MARKER"), "marker scan");
  },
});

C({
  id: "E2E-N-75", stage: 2, kind: "legal", guards: ["G-37"], dbSuite: "n75-dash-template-off",
  title: "不指定模板时不用自定义模板（默认路径不误伤）",
  source: "./trade dashboard --help（default: template_base.html next to the script）",
  expect: "exit 0 · 产物不得包含模板标记 QA-CUSTOM-TEMPLATE-MARKER",
  run: async (c) => {
    await seedAcct(c);
    const out = join(SANDBOX_ART, "n75-out.html");
    const r = await c.trade("dashboard", ["--out", out, "--token-file", join(SANDBOX_ART, "n75-absent.token"), "--json"]);
    c.expectExit(r, 0);
    c.expectTrue("默认模板不含自定义标记", !readFileSync(out, "utf-8").includes("QA-CUSTOM-TEMPLATE-MARKER"), "marker scan");
  },
});

C({
  id: "E2E-N-76", stage: 2, kind: "violation", guards: ["G-38"], dbSuite: "n76-account-illegal",
  title: "非法账户登记参数逐条拒绝且不落库",
  source: "矩阵 G-38 预期（重复账户 ID、非法券商、缺名称、非法币种逐条拒绝且不落库）；acceptance-cases.md TC-P01",
  expect: "重复 ID / 非法券商 / 非法币种 / 缺名称四次均 exit≠0 · accounts 行数始终不变 · 文案含非法值",
  run: async (c) => {
    const first = await c.trade("account add", ["DUPACC", "--name", "DUPACC", "--broker", "CMB", "--json"]);
    c.expectExit(first, 0, "前置：首次登记成功");
    const n = Number(sqlOne(c.db, "select count(*) from accounts;"));
    const cases = [
      ["重复 ID", ["DUPACC", "--name", "DUPACC", "--json"], /账户已存在/],
      ["非法券商", ["BADBROKERACC", "--name", "X", "--broker", "NOTABROKER", "--json"], /非法券商|可选值/],
      ["非法币种", ["BADCCYACC", "--name", "X", "--currency", "NOTACURRENCY", "--json"], /非法币种|ISO 4217/],
      ["缺名称", ["NONAMEACC", "--json"], /Missing|required/],
    ] as const;
    for (const [label, args, re] of cases) {
      const r = await c.trade("account add", [...args]);
      c.expectExit(r, "nonzero", `${label} 必须拦截`);
      c.expectDelta(r, "accounts", 0, `${label} 不得落库`);
      c.expectText(r, re, `${label} 文案说明原因`);
    }
    c.expectTrue("accounts 行数未变", Number(sqlOne(c.db, "select count(*) from accounts;")) === n, `before=${n} after=${sqlOne(c.db, "select count(*) from accounts;")}`);
  },
});

C({
  id: "E2E-N-77", stage: 2, kind: "legal", guards: ["G-38"], dbSuite: "n77-account-legal",
  title: "合法账户登记成功（登记校验不误伤）",
  source: "acceptance-cases.md TC-P01；release-gate.md Gate 3 步骤 1",
  expect: "exit 0 · accounts+1 · account_id 可回查",
  run: async (c) => {
    const r = await c.trade("account add", ["OKACC", "--name", "正常账户", "--broker", "CMB", "--currency", "CNY", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "accounts", 1);
    c.expectTrue("账户落盘", sqlOne(c.db, "select count(*) from accounts where account_id='OKACC';") === "1", "count=1");
  },
});

C({
  id: "E2E-N-78", stage: 2, kind: "violation", guards: ["G-39"], dbSuite: "n78-selfheal",
  title: "未登记账户与未知标的自愈登记/推断落行（转换发生）",
  source: "MANUAL.md 铁律 5（未登记账户买入时自愈登记）；./trade lot buy --help（unknown ids are auto-registered as CUSTOM）；矩阵 G-39 预期",
  expect: "exit 0 · accounts+1 · symbols+1 · lots+1 · trades+1",
  run: async (c) => {
    const r = await c.trade("lot buy", ["GHOSTSYM", "--price", "2.0000", "--qty", "100", "--account", "GHOSTACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "未知账户/标的不应阻断建仓");
    c.expectDelta(r, "accounts", 1, "账户自愈登记");
    c.expectDelta(r, "symbols", 1, "标的信息落行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-79", stage: 2, kind: "legal", guards: ["G-39"], dbSuite: "n79-no-dup-selfheal",
  title: "已登记账户与已登记标的不重复自愈（转换不重复发生）",
  source: "MANUAL.md 铁律 5；矩阵 G-39 预期（自愈登记；未知标的推断）",
  expect: "第二次买入 exit 0 · accounts/symbols 行数不再增长 · lots+1",
  run: async (c) => {
    const a = await c.trade("lot buy", ["518880.SH", "--price", "2.0000", "--qty", "100", "--account", "KNOWNACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(a, 0);
    const accN = Number(sqlOne(c.db, "select count(*) from accounts;"));
    const symN = Number(sqlOne(c.db, "select count(*) from symbols;"));
    const r = await c.trade("lot buy", ["518880.SH", "--price", "2.0000", "--qty", "100", "--account", "KNOWNACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0);
    c.expectDelta(r, "accounts", 0, "不得重复登记账户");
    c.expectDelta(r, "symbols", 0, "不得重复插入标的");
    c.expectDelta(r, "lots", 1);
    c.expectTrue("accounts/symbols 行数未变", Number(sqlOne(c.db, "select count(*) from accounts;")) === accN && Number(sqlOne(c.db, "select count(*) from symbols;")) === symN, `acc=${accN}→${sqlOne(c.db, "select count(*) from accounts;")} sym=${symN}→${sqlOne(c.db, "select count(*) from symbols;")}`);
  },
});

C({
  id: "E2E-N-80", stage: 2, kind: "violation", guards: ["G-40"], dbSuite: "n80-budget-block",
  title: "组合预算环境变量下的越线买入被拦截",
  source: "safety-checklist.md §4.2（满仓金额是绝对不可突破的硬约束，必须有确定性拦截并返回退出码非零）；矩阵 G-40 预期",
  expect: "exit≠0 · lots/trades 不变（LOT_TRADER_PORTFOLIO_BUDGET=10000、拟买 4000 元 → 占比 40%）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 4000, skip: false, env: BUDGET_ENV, reason: "预算越线" });
    c.expectExit(r, "nonzero", "预算越线必须拦截");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    c.expectText(r, /30/, "文案含 30% 硬顶红线");
  },
});

C({
  id: "E2E-N-81", stage: 2, kind: "legal", guards: ["G-40"], dbSuite: "n81-budget-pass",
  title: "组合预算环境变量下的线内买入放行",
  source: "safety-checklist.md §4.2；acceptance-cases.md TC-N01",
  expect: "exit 0 · lots+1 · trades+1（预算 10000、拟买 2000 元 → 占比 20%）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 2000, skip: false, env: BUDGET_ENV, reason: "预算线内" });
    c.expectExit(r, 0, "线内买入必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
  },
});

C({
  id: "E2E-N-82", stage: 2, kind: "violation", guards: ["G-41"], dbSuite: "n82-port-conflict",
  title: "端口已被占用时第二个服务被拒且不碰运行中实例的凭据文件",
  source: "safety-checklist.md §2.2（可读指引文案，严禁未捕获崩溃堆栈）；MANUAL.md §7 硬约束 2 与令牌生命周期（端口被占用导致启动失败时不会覆盖/删除正在运行实例的凭证文件）",
  expect: "第二个 serve exit≠0 · stderr 无语义化文案（含端口号）且无 Traceback · 占位实例的凭据文件内容与 mtime 不变",
  run: async (c) => {
    await seedAcct(c);
    const tf = join(SANDBOX_ART, "n82-shared.token");
    const holder = await c.serve({ tokenFile: tf });
    c.expectTrue("占位实例健康 200", holder.healthOk === true, `healthOk=${holder.healthOk}`);
    const tokBefore = readFileSync(tf, "utf-8");
    const mtimeBefore = statSync(tf).mtimeMs;
    const second = await c.serve({ port: holder.port, tokenFile: tf });
    const stop2 = await second.stop("SIGTERM");
    c.expectExit(stop2, "nonzero", "端口冲突时第二个服务必须退出非零");
    c.expectText(stop2, /端口|占用|已被/, "文案指出端口已被占用");
    c.expectNoText(stop2, /Traceback/, "不得抛出未捕获堆栈");
    c.expectDeltaAll(stop2, 0, "端口冲突被拒后零写入");
    c.expectTrue("占位实例凭据内容未被改写", readFileSync(tf, "utf-8") === tokBefore, `len_before=${tokBefore.trim().length} len_after=${readFileSync(tf, "utf-8").trim().length}`);
    c.expectTrue("占位实例凭据 mtime 未被刷新", statSync(tf).mtimeMs === mtimeBefore, `mtime ${mtimeBefore} → ${statSync(tf).mtimeMs}`);
    c.expectTrue("占位实例仍在监听", listenersOn(holder.port) !== "", `listeners=${listenersOn(holder.port) || "(none)"}`);
    const stop1 = await holder.stop("SIGTERM");
    c.expectExit(stop1, 0);
    c.expectTrue("停机后端口释放", (await waitPortFree(holder.port, 3000)) === true, `port=${holder.port}`);
  },
});

C({
  id: "E2E-N-83", stage: 2, kind: "legal", guards: ["G-41"], dbSuite: "n83-port-free",
  title: "空闲端口正常绑定并释放（端口门不误伤）",
  source: "safety-checklist.md §2.2/§2.3；release-gate.md Gate 4 服务探活",
  expect: "exit 0 · /api/health 200 · 监听端口落在 18000-18999 · 停机后端口释放",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({});
    c.expectTrue("健康探活 200", s.healthOk === true, `healthOk=${s.healthOk}`);
    c.expectTrue("端口在 18000-18999（不使用 8080 / 不使用 --port 0）", s.port >= PORT_MIN && s.port <= PORT_MAX, `port=${s.port}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
    c.expectTrue("停机后端口释放", (await waitPortFree(s.port, 3000)) === true, `port=${s.port}`);
  },
});

C({
  id: "E2E-N-84", stage: 2, kind: "violation", guards: ["G-42"], dbSuite: "n84-token-entropy",
  title: "每次自动生成高熵凭据：64 位 hex、互不相同、0600",
  source: "safety-checklist.md §3.1/§3.2（32 字节 64 字符十六进制高熵令牌，0600）；./trade serve --help",
  expect: "三次启动各自生成 64 位 hex 凭据 · 三者互不相同 · 每次权限位 600",
  run: async (c) => {
    await seedAcct(c);
    const toks: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const tf = join(SANDBOX_ART, `n84-token-${i}`);
      const s = await c.serve({ tokenFile: tf });
      c.expectTrue(`第 ${i} 次健康 200`, s.healthOk === true, `healthOk=${s.healthOk}`);
      const t = readFileSync(tf, "utf-8").trim();
      toks.push(t);
      c.expectTrue(`第 ${i} 次凭据为 64 位 hex`, /^[0-9a-f]{64}$/.test(t), `len=${t.length} sample=${t.slice(0, 8)}…`);
      c.expectTrue(`第 ${i} 次权限 600`, fileMode(tf) === "600", `mode=${fileMode(tf)}`);
      const stop = await s.stop("SIGTERM");
      c.expectExit(stop, 0);
    }
    c.expectTrue("三次凭据互不相同", new Set(toks).size === 3, `distinct=${new Set(toks).size}`);
  },
});

C({
  id: "E2E-N-85", stage: 2, kind: "pair_na", guards: ["G-42"], dbSuite: "n85-pair-na",
  title: "G-42 合法侧逻辑上不存在（性质断言）",
  source: "本线任务书补充（只有安全门类在某一侧逻辑上不存在时才可以标 pair_na 并写明原因，例如「token 64 位且互不相同」这类性质断言）",
  expect: "pair_na · 原因：G-42 是对随机凭据的性质断言（长度/字符集/唯一性/权限位），不存在一个「合法输入被误伤」的独立请求侧请求；显式令牌路径的反误伤已由 G-13 的 legal 用例（E2E-N-26）覆盖。本用例结果记为 pair_na，不计入 PASS",
  run: async (c) => {
    c.note("pair_na：G-42 为性质断言，无独立合法侧请求；显式令牌不被强制重生成的反误伤由 E2E-N-26（G-13 legal）覆盖。");
    c.note("本用例不产出可判定断言，结果由 runner 记为 pair_na，不计入 PASS/FAIL/BLOCKED。");
  },
});

C({
  id: "E2E-N-86", stage: 2, kind: "violation", guards: ["G-43"], dbSuite: "n86-json-quiet",
  title: "输出契约：--quiet 抑制启动横幅；--json 启动一行 ready、停机一行 stopped",
  source: "./trade serve --help（--json Emit a single machine-readable ready line；--quiet Suppress the startup banner）；矩阵 G-43 预期",
  expect: "--quiet 启动的 stdout 不含启动横幅 · --json 启动首行为可解析 JSON（code=0、含 port）· 停机后追加 msg=stopped 行",
  run: async (c) => {
    await seedAcct(c);
    const quiet = await c.serve({ json: false, args: ["--quiet"], tokenFile: join(SANDBOX_ART, "n86-quiet.token") });
    c.expectTrue("--quiet 启动仍可用（健康 200）", quiet.healthOk === true, `healthOk=${quiet.healthOk}`);
    c.expectTrue("--quiet 输出无启动横幅", !/Lot-Trader 本地引擎已启动/.test(quiet.stdout), `stdout=${JSON.stringify(quiet.stdout.slice(0, 120))}`);
    const qs = await quiet.stop("SIGTERM");
    c.expectExit(qs, 0);
    const js = await c.serve({ tokenFile: join(SANDBOX_ART, "n86-json.token") });
    const first = js.stdout.split("\n")[0];
    let parsed: any; try { parsed = JSON.parse(first); } catch { parsed = undefined; }
    c.expectTrue("--json 启动首行为可解析 JSON", !!parsed && parsed.code === 0, `line=${JSON.stringify(first.slice(0, 160))}`);
    c.expectTrue("--json ready 行含 port", Number(parsed?.data?.port) === js.port, `port=${parsed?.data?.port} want=${js.port}`);
    const ss = await js.stop("SIGTERM");
    c.expectExit(ss, 0);
    c.expectTrue("停机后追加 stopped 行", /"msg"\s*:\s*"stopped"/.test(ss.stdout), `stdout=${JSON.stringify(ss.stdout.slice(-160))}`);
  },
});

C({
  id: "E2E-N-87", stage: 2, kind: "legal", guards: ["G-43"], dbSuite: "n87-banner-present",
  title: "不给 --quiet 时启动横幅存在（输出不被误抑制）",
  source: "./trade serve --help（--quiet 为可选开关，默认打印启动横幅）",
  expect: "默认启动的 stdout 含启动横幅与监听地址（含实际端口）",
  run: async (c) => {
    await seedAcct(c);
    const s = await c.serve({ json: false, tokenFile: join(SANDBOX_ART, "n87-banner.token") });
    c.expectTrue("默认启动横幅存在", /Lot-Trader 本地引擎已启动/.test(s.stdout), `stdout=${JSON.stringify(s.stdout.slice(0, 120))}`);
    c.expectTrue("横幅含实际监听地址", new RegExp(`127\\.0\\.0\\.1:${s.port}`).test(s.stdout), `port=${s.port}`);
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0);
  },
});

C({
  id: "E2E-N-88", stage: 2, kind: "violation", guards: ["G-44"], dbSuite: "n88-threshold-illegal",
  title: "非法 JSON 与非法取值必须被拒（缺陷 D-07 回归）",
  source: "本线任务书补充（G-44：非法 JSON 期望 exit 1，非法取值属于违规侧期望被拒）；矩阵 G-44 预期",
  expect: "--thresholds 'not-json' exit≠0 且 signals 不变；--thresholds '{\"take_profit_min\":\"high\"}' 也必须 exit≠0（现状静默失效即 FAIL，缺陷 D-07）",
  run: async (c) => {
    await seedAcct(c);
    const a = await c.trade("scan", ["--json", "--thresholds", "not-json"]);
    c.expectExit(a, "nonzero", "非法 JSON 必须拒绝");
    c.expectDelta(a, "signals", 0, "被拒调用不得写库");
    const b = await c.trade("scan", ["--json", "--thresholds", '{"take_profit_min":"high"}']);
    c.expectExit(b, "nonzero", "非法取值类型必须拒绝（D-07）");
    c.expectDelta(b, "signals", 0, "被拒调用不得写库（D-07）");
  },
});

C({
  id: "E2E-N-89", stage: 2, kind: "legal", guards: ["G-44"], dbSuite: "n89-threshold-legal",
  title: "合法阈值覆盖真实生效（可升可降，校验门不误伤合法覆盖）",
  source: "SKILL.md §114（TAKE_PROFIT_ALERT：浮盈达标 +10%~+20%）；SKILL.md §96（建议止盈区间 > 最近买入价 × 1.10）；./trade scan --help（--thresholds 覆盖信号阈值）",
  expect: "默认阈值下 +16% 批次命中 TAKE_PROFIT_ALERT（前提）· 用实现键 take_profit_min=0.5 覆盖（提高线）后该批次止盈信号消失 · 用 take_profit_min=0.05 覆盖（降低线）后信号重新出现 · 三次调用均 exit 0 且不报错",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.16)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+16%)")?.lot_id;
    const hasTP = (res: ExecResult) => (c.json(res)?.data?.signals ?? []).some((x: any) => x.lot_id === lot && x.signal_type === "TAKE_PROFIT_ALERT");
    const def = await c.trade("scan", ["--json"]);
    c.expectExit(def, 0, "默认阈值扫描 exit 0");
    c.expectTrue("前提：默认阈值下 +16% 命中止盈", hasTP(def), `signals=${JSON.stringify((c.json(def)?.data?.signals ?? []).map((x: any) => x.signal_type))}`);
    const hi = await c.trade("scan", ["--json", "--thresholds", '{"take_profit_min":0.5}']);
    c.expectExit(hi, 0, "合法阈值 JSON（提高线）必须被接受");
    c.expectNoText(hi, /失败|error|Error/, "提高线覆盖不得报错");
    c.expectTrue("提高止盈线到 50% 后止盈信号消失（覆盖生效）", !hasTP(hi), `signals=${JSON.stringify((c.json(hi)?.data?.signals ?? []).map((x: any) => x.signal_type))}`);
    const lo = await c.trade("scan", ["--json", "--thresholds", '{"take_profit_min":0.05}']);
    c.expectExit(lo, 0, "合法阈值 JSON（降低线）必须被接受");
    c.expectTrue("降低止盈线到 5% 后止盈信号重新出现（覆盖生效）", hasTP(lo), `signals=${JSON.stringify((c.json(lo)?.data?.signals ?? []).map((x: any) => x.signal_type))}`);
  },
});

C({
  id: "E2E-N-90", stage: 2, kind: "violation", guards: ["G-45"], dbSuite: "n90-price-illegal",
  title: "价格非有限正数（非数值 / 零 / 负数）必须被拒（缺陷 D-09 回归）",
  source: "本线任务书补充（G-45：价格非数值、零、负数都应被拒，违规侧期望 exit≠0 且 lots 不变）；SAFETY/REGRESSION 均要求核算精度不得被 NaN/零/负值污染",
  expect: "--price abc / 0 / -2.5 三次均 exit≠0 且 lots/trades 零变化；现状全部落库即 FAIL（缺陷 D-09）",
  run: async (c) => {
    await seedAcct(c);
    for (const [price, label] of [["abc", "非数值"], ["0", "零价"], ["-2.5", "负价"]] as const) {
      const r = await c.trade("lot buy", ["518880.SH", "--price", price, "--qty", "100", "--account", "ACC", "--reason", `d09-${label}`, "--fee", "0", "--skip-risk", "--json"]);
      c.expectExit(r, "nonzero", `${label}必须被拦截（D-09）`);
      c.expectDeltaAll(r, 0, `${label}零写入（D-09）`);
    }
    c.expectTrue("库内不得出现非法价格", Number(sqlOne(c.db, "select count(*) from lots where buy_price<=0 or buy_price is null;")) === 0, `bad_rows=${sqlOne(c.db, "select count(*) from lots where buy_price<=0 or buy_price is null;")}`);
  },
});

C({
  id: "E2E-N-91", stage: 2, kind: "legal", guards: ["G-45"], dbSuite: "n91-price-legal",
  title: "合法正价格建仓放行（价格门不误杀）",
  source: "acceptance-cases.md TC-N01（正常价格 >0 绝不被误杀）；TC-P02",
  expect: "exit 0 · lots+1 · trades+1 · cost_basis_unit=买入价（--fee 0）",
  run: async (c) => {
    await seedAcct(c);
    const r = await c.trade("lot buy", ["518880.SH", "--price", "2.0000", "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(r, 0, "合法价格必须放行");
    c.expectDelta(r, "lots", 1);
    c.expectDelta(r, "trades", 1);
    const d = dataOf(c, r, "lot buy");
    c.expectTrue("cost_basis_unit=2.0000", Number(d?.cost_basis_unit) === 2, `cost=${d?.cost_basis_unit}`);
  },
});

C({
  id: "E2E-N-92", stage: 3, kind: "violation", guards: [], dbSuite: "n92-div-undeclared-flag",
  title: "缺陷 D-03 回归：未声明参数必须报错，不得静默忽略并落库",
  source: "老板 2026-10-24 裁定 K-03（是缺陷，维持 D-03）：未声明的参数不应被静默忽略，应该报错；./trade dividend add --help（只声明 --date，不存在 --ex-date/--record-date）",
  expect: "exit≠0 · 各表行数 0 变化 · dividends 保持 0 行 · 文案指出未声明参数（现状 exit 0 且静默落库 → FAIL，缺陷 D-03 复现）",
  run: async (c) => {
    await seedAcct(c);
    const r = await c.trade("dividend add", ["--symbol", "518880.SH", "--amount", "1.00", "--ex-date", "2026-01-01", "--record-date", "2026-01-02", "--account", "ACC", "--json"]);
    c.expectExit(r, "nonzero", "未声明参数必须报错（K-03/D-03）");
    c.expectDeltaAll(r, 0, "报错路径零写入（K-03/D-03）");
    c.expectTrue("不得落库（dividends 保持 0 行）", sqlOne(c.db, "select count(*) from dividends;") === "0", `dividends_rows=${sqlOne(c.db, "select count(*) from dividends;")}`);
    c.expectText(r, /未声明|未知|unknown|unrecognized|no such|不支持|非法/, "文案指出未声明参数（K-03/D-03）");
  },
});

C({
  id: "E2E-N-93", stage: 3, kind: "violation", guards: [], dbSuite: "n93-dash-baddir",
  title: "缺陷 D-04 回归：输出目录不存在时严禁未捕获堆栈",
  source: "regression-baseline.md §3（全程不报未捕获异常）；safety-checklist.md §2.2 同源纪律（严禁抛出未捕获崩溃堆栈）；矩阵 §14.1 D-04",
  expect: "exit≠0 · stderr 不得包含 Traceback（现状含解释器堆栈即 FAIL，缺陷 D-04）",
  run: async (c) => {
    await seedAcct(c);
    const r = await c.trade("dashboard", ["--out", join(SANDBOX_ART, "no-such-dir", "x.html"), "--token-file", join(SANDBOX_ART, "n93-absent.token"), "--json"]);
    c.expectExit(r, "nonzero", "输出目录不存在必须失败退出");
    c.expectDeltaAll(r, 0, "失败路径零写入");
    c.expectNoText(r, /Traceback/, "不得抛出未捕获堆栈（D-04）");
  },
});

C({
  id: "E2E-N-94", stage: 3, kind: "violation", guards: [], dbSuite: "n94-stats-bad-days",
  title: "缺陷 D-05 回归：非数值 --days 必须报错，不得返回成功并清空报表",
  source: "老板 2026-10-24 裁定 K-04（是缺陷，维持 D-05）：stats --days abc 不应返回成功并清空报表，应该报错；./trade stats --help（--days N）",
  expect: "exit≠0 · 各表行数 0 变化 · 不得静默把报表清空成零笔（现状 exit 0 且零笔 → FAIL，缺陷 D-05 复现）",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy")?.lot_id;
    const cl = await c.trade("lot close", ["--lot-id", lot, "--price", String(r4(cur * 1.02)), "--account", "ACC", "--fee", "0", "--json"]);
    c.expectExit(cl, 0, "前置：制造一笔平仓战绩 exit 0");
    const ok = await c.trade("stats", ["--json"]);
    const a = dataOf(c, ok, "stats(默认)");
    c.expectTrue("前置：默认窗口有平仓战绩", Number(a?.total_trades) > 0, `total_trades=${a?.total_trades}`);
    const bad = await c.trade("stats", ["--days", "abc", "--json"]);
    // 这一调用按本用例判据必须失败，因此不能用 dataOf（它断言「可解析且 code=0」）；
    // 原写法与用例自身「非数值 --days 必须报错」的判据互相矛盾（harness bug，不是产品问题）。
    const d = c.json(bad);
    c.expectExit(bad, "nonzero", "非数值 --days 必须报错（K-04/D-05）");
    c.expectDeltaAll(bad, 0, "零写入（K-04/D-05）");
    c.expectTrue("不得静默把报表清空成零笔（K-04/D-05）", !(bad.exit === 0 && Number(d?.total_trades) === 0 && Number(a?.total_trades) > 0), `default=${a?.total_trades} bad_exit=${bad.exit} bad=${d?.total_trades}`);
  },
});

C({
  id: "E2E-N-95", stage: 3, kind: "violation", guards: [], dbSuite: "n95-cap-message",
  title: "缺陷 D-06 回归：越线提示必须给出可区分的数值精度",
  source: "老板 2026-10-24 裁定 K-05（是缺陷，维持 D-06）：超限提示不应写成「30.00% 超过 30.00%」，应给出可区分的数值精度；safety-checklist.md §4.1（拦截本身必须成立）",
  expect: "exit≠0 · 各表行数 0 变化 · 文案中「拟买入占比」与「阈值」必须可区分（不得两者都显示 30.00%）（现状拦截成立但两者同为 30.00% → FAIL，缺陷 D-06 复现）",
  run: async (c) => {
    await seedAcct(c);
    const r = await buyCost(c, { symbol: "518880.SH", cost: 3000.10, skip: false, env: BUDGET_ENV, reason: "K05-边界文案" });
    c.expectExit(r, "nonzero", "越线拦截必须成立");
    c.expectDeltaAll(r, 0, "拦截后零写入");
    const msg = r.stdout + r.stderr;
    const mRatio = /占比为\s*([0-9.]+)%/.exec(msg);
    const mThr = /超过\s*([0-9.]+)%/.exec(msg);
    c.expectTrue("文案同时给出占比与阈值", !!mRatio && !!mThr, `msg=${JSON.stringify(msg.slice(0, 160))}`);
    c.expectTrue("占比与阈值可区分（K-05/D-06）", !!mRatio && !!mThr && mRatio[1] !== mThr[1], `ratio=${mRatio?.[1]} threshold=${mThr?.[1]}`);
  },
});

C({
  id: "E2E-N-96", stage: 3, kind: "violation", guards: [], dbSuite: "n96-dash-probe-base-override",
  title: "缺陷 D-08 回归：看板探活基址必须可由 --api-base 覆盖（不再写死 8080）",
  source: "regression-baseline.md §3（本地引擎联动模式心跳探活）；./trade dashboard --help（--api-base URL）；矩阵 §14.1 D-08 / §14.3 SERVE-8080-LINKED",
  expect: "dashboard --help 声明 --api-base · 产物内绑定探活基址的本地常量等于传入值（不再写死 8080）· exit 0 · 各表行数 0 变化",
  run: async (c) => {
    await seedAcct(c);
    const help = await c.trade("dashboard", ["--help"]);
    c.expectExit(help, 0);
    c.expectText(help, /--api-base/, "help 声明 --api-base（D-08 修复的可观测面）");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const out = join(SANDBOX_ART, "n96-dash.html");
    const r = await c.trade("dashboard", ["--out", out, "--token", "n96-token-" + "e".repeat(54), "--api-base", base, "--json"]);
    c.expectExit(r, 0);
    c.expectDeltaAll(r, 0, "生成看板不改任何表");
    const html = readFileSync(out, "utf-8");
    const bind = /LOCAL_API_BASE\s*=\s*'([^']*)'/.exec(html);
    c.expectTrue("产物内探活基址绑定到 --api-base 传入值（D-08）", !!bind && bind[1] === base, `bound=${bind ? bind[1] : "(none)"} want=${base}`);
    c.expectTrue("探活基址不再是写死的 8080", !!bind && !/:8080\b/.test(bind[1]), `bound=${bind ? bind[1] : "(none)"}`);
    const hits = (html.match(/127\.0\.0\.1:8080/g) ?? []).length;
    await c.fs(`归档覆盖了探活基址的看板产物：${out}`, () => {
      const dst = join(EVID, `${c.id}__dashboard.html`);
      copyFileSync(out, dst);
      const notes = join(EVID, `${c.id}__probe-base-forensics.txt`);
      writeFileSync(notes, `out=${out}\nbytes=${statSync(out).size}\napi_base_arg=${base}\nlocal_api_base_binding=${bind ? bind[1] : "(none)"}\nliteral_8080_occurrences=${hits}（说明文本/注释允许保留，探活绑定本身已覆盖）\n`);
      return [dst, notes];
    });
    c.note(`--api-base 生效：产物探活基址 = ${base}；页面内仍保留 127.0.0.1:8080 字样 ${hits} 处（说明文本与注释，非探活目标）。`);
  },
});

C({
  id: "E2E-N-98", stage: 3, kind: "violation", guards: [], dbSuite: "n98-tp-alert-band",
  title: "止盈告警线规则对齐：浮盈落在 +10%~+20% 区间必须发出 TAKE_PROFIT_ALERT",
  source: "SKILL.md §114（TAKE_PROFIT_ALERT：浮盈达标 +10%~+20%，建议平仓止盈）；SKILL.md §96（recommended_sale_out_point 建议止盈区间：> 最近买入价 × 1.10）",
  expect: "scan exit 0 · 浮盈 +11.98% 的批次命中 TAKE_PROFIT_ALERT · trigger_return_rate ∈ [0.10,0.20] · suggested_action=CLOSE_PROFIT · position --json 的该标的 recommended_sale_out_point ≈ round(最近买入价×1.10, 4)",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur / 1.12)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const lot = dataOf(c, b, "lot buy(+12%)")?.lot_id;
    const sc = await c.trade("scan", ["--json"]);
    c.expectExit(sc, 0);
    const sig = (c.json(sc)?.data?.signals ?? []).find((s: any) => s.lot_id === lot && s.signal_type === "TAKE_PROFIT_ALERT");
    c.expectTrue("命中 TAKE_PROFIT_ALERT（+10%~+20% 区间）", !!sig, `types=${(c.json(sc)?.data?.signals ?? []).map((s: any) => s.signal_type).join(",") || "(none)"}`);
    const rate = Number(sig?.trigger_return_rate);
    c.expectTrue("trigger_return_rate 落在 +10%~+20% 区间", rate >= 0.10 && rate <= 0.20, `trigger_return_rate=${sig?.trigger_return_rate}`);
    c.expectTrue("建议动作为平仓止盈", sig?.suggested_action === "CLOSE_PROFIT", `suggested_action=${sig?.suggested_action}`);
    const pos = dataOf(c, await c.trade("position", ["--json"]), "position");
    const t = (pos?.targets ?? []).find((x: any) => x.symbol === "518880.SH");
    const want = r4(Number(t?.last_buy_price) * 1.10);
    c.expectTrue("建议止盈区间 = 最近买入价×1.10", Math.abs(Number(t?.recommended_sale_out_point) - want) <= 0.0005, `actual=${t?.recommended_sale_out_point} want=${want} last_buy=${t?.last_buy_price}`);
  },
});

C({
  id: "E2E-N-97", stage: 3, kind: "violation", guards: [], dbSuite: "n97-dual-mode-greenlight",
  title: "看板与本地引擎联动转绿 / 停机平滑降级（双模冒烟，D-08 解阻后）",
  source: "release-gate.md Gate 4（双模冒烟）；regression-baseline.md §3（联通即转绿，端口关闭平滑降级）；矩阵 §14.3 SERVE-8080-LINKED / SERVE-DUAL-MODE-GREENLIGHT（缺失能力由 --api-base 补齐）",
  expect: "serve 在 18000-18999 端口就绪后，页面顶栏指示灯 class=local 且文案「本地引擎已联动」· 停机后重载同一页面平滑降级为 standalone（非白屏、无 NaN）· 停机 exit 0 且端口释放",
  run: async (c) => {
    await seedAcct(c);
    const cur = await currentPrice(c, "518880.SH");
    const b = await c.trade("lot buy", ["518880.SH", "--price", String(r4(cur)), "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"]);
    c.expectExit(b, 0);
    const s = await c.serve({});
    c.expectTrue("引擎健康探活 200", s.healthOk === true, `healthOk=${s.healthOk} port=${s.port}`);
    c.expectTrue("引擎端口落在 18000-18999", s.port >= PORT_MIN && s.port <= PORT_MAX, `port=${s.port}`);
    const base = `http://127.0.0.1:${s.port}`;
    const out = join(SANDBOX_ART, "n97-dual-mode.html");
    const g = await c.trade("dashboard", ["--out", out, "--token-file", s.tokenFile, "--api-base", base, "--json"]);
    c.expectExit(g, 0, "按引擎实际端口生成看板");
    const html = readFileSync(out, "utf-8");
    const bind = /LOCAL_API_BASE\s*=\s*'([^']*)'/.exec(html);
    c.expectTrue("产物探活基址 = 引擎实际地址", !!bind && bind[1] === base, `bound=${bind ? bind[1] : "(none)"} want=${base}`);
    if (!existsSync(CHROME)) { c.block(`本机未安装可用的 headless 浏览器（${CHROME} 不存在），缺失能力：浏览器驱动`); await s.stop("SIGTERM"); return; }
    const udd = join(SANDBOX_ART, "n97-chrome-profile");
    mkdirSync(udd, { recursive: true });
    const bodyTextOf = (dom: string) => dom.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // ---- ① 引擎在线：探活成功，顶栏转绿
    const domLinked = join(SANDBOX_ART, "n97-dom-linked.html");
    const shotLinked = join(SANDBOX_ART, "n97-shot-linked.png");
    await c.fs(`headless chrome 加载联动模式看板 file://${out}（serve 在线，port=${s.port}）`, () => {
      const rr = sh(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + udd, "--virtual-time-budget=9000", "--window-size=1600,1000", "--dump-dom", "file://" + out], { timeout: 120_000 });
      writeFileSync(domLinked, rr.stdout);
      sh(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=" + udd + "-shot", "--virtual-time-budget=9000", "--window-size=1600,1000", `--screenshot=${shotLinked}`, "file://" + out], { timeout: 120_000 });
      const dst = join(EVID, `${c.id}__browser-dom-linked.html`);
      copyFileSync(domLinked, dst);
      const shotDst = join(EVID, `${c.id}__browser-screenshot-linked.png`);
      if (existsSync(shotLinked)) copyFileSync(shotLinked, shotDst);
      return [dst, shotDst];
    });
    const linked = readFileSync(domLinked, "utf-8");
    const linkedBody = bodyTextOf(linked);
    const linkedCls = /<span id="mode-indicator"[^>]*class="([^"]*)"/.exec(linked);
    c.expectTrue("DOM 非空白（长度>1000）", linked.length > 1000, `dom_len=${linked.length}`);
    c.expectTrue("顶栏指示灯 class 含 local（联动转绿）", !!linkedCls && /\blocal\b/.test(linkedCls[1]), `class=${linkedCls ? linkedCls[1] : "(none)"}`);
    c.expectTrue("顶栏文案为「本地引擎已联动」", /本地引擎已联动/.test(linkedBody), `mode_text=${(/模式：[^<]{0,40}/.exec(linkedBody) ?? ["(none)"])[0]}`);
    c.expectTrue("联动模式渲染文本不出现 NaN", !/NaN/.test(linkedBody), `nan_hits=${(linkedBody.match(/NaN/g) ?? []).length}`);
    // ---- ② 引擎停机：同一页面重载 → 平滑降级，不白屏不 NaN
    const stop = await s.stop("SIGTERM");
    c.expectExit(stop, 0, "SIGTERM 优雅停机 exit 0");
    c.expectTrue("停机后端口释放", (await waitPortFree(s.port, 3000)) === true, `port=${s.port}`);
    const domDown = join(SANDBOX_ART, "n97-dom-after-stop.html");
    await c.fs(`headless chrome 重载同一看板 file://${out}（serve 已停机，port=${s.port}）`, () => {
      const rr = sh(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + udd + "-down", "--virtual-time-budget=9000", "--window-size=1600,1000", "--dump-dom", "file://" + out], { timeout: 120_000 });
      writeFileSync(domDown, rr.stdout);
      const dst = join(EVID, `${c.id}__browser-dom-after-stop.html`);
      copyFileSync(domDown, dst);
      return [dst];
    });
    const down = readFileSync(domDown, "utf-8");
    const downBody = bodyTextOf(down);
    const downCls = /<span id="mode-indicator"[^>]*class="([^"]*)"/.exec(down);
    c.expectTrue("停机后 DOM 非空白（长度>1000）", down.length > 1000, `dom_len=${down.length}`);
    c.expectTrue("停机后平滑降级为 standalone", !!downCls && /\bstandalone\b/.test(downCls[1]), `class=${downCls ? downCls[1] : "(none)"}`);
    c.expectTrue("降级后文案回落「轻量独立」", /轻量独立|纯前端自驱/.test(downBody), `mode_text=${(/模式：[^<]{0,40}/.exec(downBody) ?? ["(none)"])[0]}`);
    c.expectTrue("降级后渲染文本不出现 NaN（非白屏）", !/NaN/.test(downBody), `nan_hits=${(downBody.match(/NaN/g) ?? []).length}`);
    c.note(`联动转绿实证：port=${s.port}，页面探活基址 ${base}，顶栏 class=local 且文案「本地引擎已联动」；停机后同一页面降级为 standalone，两态 DOM 均 >1000 且无 NaN。`);
  },
});
// ------------------------------------------------ D-10：--fee / --qty 字面量层数值守卫（核验中新增缺陷）
C({
  id: "E2E-N-100", stage: 2, kind: "violation", guards: ["G-46"], dbSuite: "n100-fee-qty-literal-illegal",
  title: "缺陷 D-10 回归：--fee / --qty 非数值字面量必须被拒且零写入",
  source: "本线核验新增（D-10：字面量层数值契约覆盖每个数值旗标）；./trade lot buy --help（--fee NUM / --qty N）；矩阵 G-45 家族（非有限正数/非法字面量一律拒）",
  expect: "--fee abc 与 --qty abc 均 exit≠0 · 每次 lots/trades 零变化 · 文案指出该旗标必须是合法数值字面量",
  run: async (c) => {
    await seedAcct(c);
    for (const [flag, val] of [["--fee", "abc"], ["--qty", "abc"]] as [string, string][]) {
      const argv = ["518880.SH", "--price", "8.199", "--qty", "100", "--account", "ACC", "--fee", "0", "--skip-risk", "--json"];
      argv[argv.indexOf(flag) + 1] = val;
      const r = await c.trade("lot buy", argv);
      c.expectExit(r, "nonzero", `${flag}=${val} 必须拦截（D-10）`);
      c.expectDeltaAll(r, 0, `${flag}=${val} 零写入（D-10）`);
      c.expectText(r, /数值字面量/, `${flag}=${val} 文案说明数值字面量约束（D-10）`);
    }
  },
});

C({
  id: "E2E-P-19", stage: 2, kind: "legal", guards: ["G-46"], dbSuite: "n100-fee-qty-literal-legal",
  title: "合法 --fee / --qty 字面量放行且全成本单价有限（字面量守卫不误伤）",
  source: "本线核验新增（D-10 合法侧）；矩阵 BUY-OK-FLAGS（规费计入全成本单价）；acceptance-cases.md TC-01",
  expect: "--fee 0 / --fee 5.5 / --qty 100 三次均 exit 0 · 每次 lots+1 · cost_basis_unit 为有限正数 · --fee 5.5 时 cost_basis_unit = price + fee/qty",
  run: async (c) => {
    await seedAcct(c);
    const price = 8.199, qty = 100;
    for (const [flag, val] of [["--fee", "0"], ["--fee", "5.5"], ["--qty", "100"]] as [string, string][]) {
      const argv = ["518880.SH", "--price", String(price), "--qty", String(qty), "--account", "ACC", "--fee", "0", "--skip-risk", "--json"];
      argv[argv.indexOf(flag) + 1] = val;
      const r = await c.trade("lot buy", argv);
      c.expectExit(r, 0, `${flag}=${val} 必须放行`);
      c.expectDelta(r, "lots", 1);
      const lot = dataOf(c, r, `lot buy(${flag}=${val})`)?.lot_id;
      const raw = sqlOne(c.db, `select cost_basis_unit from lots where lot_id='${lot}';`);
      const cbu = Number(raw);
      c.expectTrue(`${flag}=${val} 的 cost_basis_unit 为有限正数`, Number.isFinite(cbu) && cbu > 0, `cost_basis_unit=${raw}`);
      if (flag === "--fee" && val === "5.5") {
        const want = r4(price + 5.5 / qty);
        c.expectTrue("--fee 5.5 计入全成本单价（price + fee/qty）", Math.abs(cbu - want) <= 0.00005, `actual=${raw} want=${want}`);
      }
    }
  },
});
/* CASE-TABLE-STAGE-3 */

// ------------------------------------------------------------------ md 回写
function renderCaseTables() {
  if (!existsSync(FLOW_MD)) { console.error(`run-e2e: ${FLOW_MD} 不存在，跳过回写`); return; }
  let md = readFileSync(FLOW_MD, "utf-8");
  const header = "| 用例 ID | 关联 G-xx | kind | 步骤命令 | 预期 | 预期值来源 | 结果 | 证据路径 |\n|---|---|---|---|---|---|---|---|";
  for (const stage of ["0", "1", "2", "3"]) {
    const begin = `<!-- CASE-TABLE-STAGE-${stage}:BEGIN -->`;
    const end = `<!-- CASE-TABLE-STAGE-${stage}:END -->`;
    if (!md.includes(begin) || !md.includes(end)) continue;
    const cell = (v: string) => String(v).replace(/\|/g, "／");   // 兜底：单元格内不得出现竖线，否则会切开 markdown 表格列
    const rows = CASES.filter((d) => String(d.stage) === stage).map((d) => {
      const r = caseResults.get(d.id);
      const steps = (r ? r.evidence.length : 0) > 0 ? (caseStepsOf(d.id) || "—") : "—";
      const result = r ? r.result : "PENDING";
      const ev = r ? r.evidence.filter((e) => e.endsWith(`${d.id}.json`)).map((e) => `[${d.id}.json](${join(REPO, e)})`).join("<br>") : "—";
      return `| ${d.id} | ${d.guards.length ? d.guards.join(" ") : "—"} | ${d.kind} | ${cell(steps)} | ${cell(d.expect)} | ${cell(d.source)} | ${result} | ${ev} |`;
    }).join("\n");
    const block = `${begin}\n${header}\n${rows}\n${end}`;
    md = md.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block);
  }
  writeFileSync(FLOW_MD, md);
}

function caseStepsOf(caseId: string): string {
  const p = join(EVID, `${caseId}.json`);
  if (!existsSync(p)) return "";
  const j = JSON.parse(readFileSync(p, "utf-8"));
  const cmds = (j.steps as any[]).filter((s) => s.provider === "trade" || s.provider === "serve-start" || s.provider === "serve-stop").map((s) => s.cmd).slice(0, 6);
  const http = (j.asserts ?? []).length;
  return cmds.length ? cmds.join("<br>") : "—";
}

// ------------------------------------------------------------------ 主流程
async function main() {
  if (LIST_ONLY) {
    for (const d of selected()) console.log(`${d.id}\tstage=${d.stage}\t${d.kind}\t${d.guards.join(",")}\t${d.title}`);
    console.log(`total=${selected().length}/${CASES.length}`);
    return;
  }
  bootstrapSandbox();
  // 第一个动作：隔离快照
  writeFileSync(join(EVID, "isolation-start.txt"), isolationSnapshot());
  console.log(`run-e2e: sandbox=${SANDBOX}${OUT_DIR && !resolve(OUT_DIR).startsWith("/tmp/") ? "（--out 不在 /tmp 下，沙箱仍固定在 /tmp 以维持 --db /tmp/… 隔离铁律）" : ""}`);
  console.log(`run-e2e: evidence=${EVID}${OUT_DIR ? "（--out 指定）" : ""}${WRITE_BACK ? " · --write：跑完回写 e2e-test-flow.md" : " · 默认不回写 e2e-test-flow.md（需显式 --write）"}`);
  if (LEGACY_NO_WRITEBACK) console.log("run-e2e: --no-writeback 已是默认行为（保留为向后兼容别名，本次无作用）");
  console.log(`run-e2e: cases=${selected().length}${ONLY ? ` (filtered by QA_E2E_ONLY=${ONLY}, full set ${CASES.length})` : ""}`);

  const started = Date.now();
  let i = 0;
  for (const def of selected()) {
    i++;
    const t0 = Date.now();
    const result = await runCase(def);
    const reaped = reapLeftovers(def.id);
    console.log(`[${String(i).padStart(3)}/${selected().length}] ${def.id.padEnd(12)} ${result.padEnd(7)} (${Date.now() - t0}ms) ${def.title}${reaped.length ? ` [reaped ${reaped.length} leftover child]` : ""}`);
  }

  const summary = { total: selected().length, pass: 0, fail: 0, blocked: 0, legal_fail: 0, pair_na: 0 };
  for (const [id, r] of caseResults) {
    if (r.kind === "pair_na") summary.pair_na++;
    if (r.result === "pair_na") continue;            // pair_na 不计入 PASS/FAIL/BLOCKED
    if (r.result === "PASS") summary.pass++;
    else if (r.result === "FAIL") summary.fail++;
    else if (r.result === "BLOCKED") summary.blocked++;
    if (r.kind === "legal" && r.result === "FAIL") summary.legal_fail++;
  }
  const results = {
    meta: {
      topic: "tp-5a3bfad8", line: "line-qa-e2e-flow", runner: "docs/qa/tools/run-e2e.ts",
      startedAt: nowIso(new Date(started)), finishedAt: nowIso(), commit: HEAD, commitShort: COMMIT_SHORT,
      tradeSha256: sha256(TRADE), sandbox: SANDBOX, evidenceDir: EVID.replace(REPO + "/", ""),
      isolationStart: readFileSync(join(EVID, "isolation-start.txt"), "utf-8").split("\n")[0],
      elapsedMs: Date.now() - started,
    },
    summary,
    cases: Object.fromEntries([...caseResults.entries()].map(([id, r]) => [id, { kind: r.kind, guards: r.guards, result: r.result, blockedReason: r.blockedReason, evidence: r.evidence, asserts: r.asserts }])),
  };
  writeFileSync(join(EVID, "results.json"), JSON.stringify(results, null, 2));
  // 文档回写：默认不写；仅显式 --write（且全量运行）才写。
  if (selected().length !== CASES.length) {
    console.log(`run-e2e: 本次是筛选运行（${selected().length}/${CASES.length} 条），跳过 e2e-test-flow.md 回写${WRITE_BACK ? "（即使传了 --write，以免把未跑用例写成 PENDING）" : ""}`);
  } else if (!WRITE_BACK) {
    console.log("run-e2e: e2e-test-flow.md 未改动（默认只跑不改文档；需要回写请显式传 --write）");
  } else {
    renderCaseTables();
  }
  // 最后一个动作：隔离快照
  writeFileSync(join(EVID, "isolation-end.txt"), isolationSnapshot());

  console.log(`run-e2e: total=${summary.total} pass=${summary.pass} fail=${summary.fail} blocked=${summary.blocked} legal_fail=${summary.legal_fail} pair_na=${summary.pair_na}`);
  // 清理 /tmp 沙箱（证据已全部落在仓库内）
  rmSync(SANDBOX, { recursive: true, force: true });
  console.log(`run-e2e: sandbox removed=${!existsSync(SANDBOX)}`);
}

await main();
