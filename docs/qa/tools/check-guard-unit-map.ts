#!/usr/bin/env bun
/**
 * tp-5a3bfad8 · L3 `line-qa-guard-unit-map` checker
 *
 * 校验 `docs/qa/guard-unit-test-map.md` 把 L1 守卫清单（`docs/qa/user-operation-matrix.md` §11）
 * 的每一条守卫映射到一条覆盖其「合法不误伤」断言的 bun 单测。
 *
 * 输出一行：
 *   guards=<N> mapped=<N> gap=<N> blank=<N> test_missing=<N> not_pass=<N> excerpt_mismatch=<N> copy_drift=<N> parse_mismatch=<N>
 * 之后是 `#` 前缀的诊断行（不影响上面那一行的解析）。
 *
 * 隔离：把仓库拷进 `/tmp` 沙箱的 `repo/`（排除 `.git`、整个 `docs/qa/`、看板产物），
 * HOME / TMPDIR / LOT_TRADER_DB / TRADE_DB_PATH / LOT_TRADER_TOKEN_FILE 全部重定向进沙箱，
 * `bun test` 只在副本里跑，跑完删掉副本。
 *
 * 子进程环境：**白名单构造**，只传 PATH（原样继承）+ 上列沙箱变量；父进程的
 * CLAUDECODE / CLAUDE_* / AI_AGENT / AGENT / REPL_ID / CURSOR* / CODEX* / ANTHROPIC* /
 * OPENAI* / MCP* 一律不传。原因：bun 1.3.14 在 CLAUDECODE=1 或 REPL_ID=1 下会关掉逐用例
 * 输出（不再打印 `(pass) <用例名>`），靠环境净化把格式钉住；解析结果还会与日志末尾汇总行
 * 对账，不一致就报 parse_mismatch 并让 checker 失败，绝不静默当成 absent。
 *
 * 开关：
 *   --inject-missing-test      把一条 MAPPED 改指向不存在的用例名，必须输出 test_missing=1
 *   --inject-excerpt-mismatch  篡改一条断言摘录，必须输出 excerpt_mismatch=1
 *   --leak-parent-env          对照组：故意继承父进程全量环境（净化前的行为），
 *                              agent 环境下应当 parse_mismatch=1 且退出码非 0
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", ".."); // docs/qa/tools -> repo root
const matrixPath = join(repoRoot, "docs", "qa", "user-operation-matrix.md");
const mapPath = join(repoRoot, "docs", "qa", "guard-unit-test-map.md");
const testsDir = join(repoRoot, "tests");

const EXPECTED_COLUMNS = 8;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const injectMissingTest = argv.includes("--inject-missing-test");
const injectExcerptMismatch = argv.includes("--inject-excerpt-mismatch");
const keepSandbox = argv.includes("--keep-sandbox");
const leakParentEnv = argv.includes("--leak-parent-env");
const evidenceDirArgIndex = argv.indexOf("--evidence-dir");
const evidenceDirArg =
  evidenceDirArgIndex >= 0 && argv[evidenceDirArgIndex + 1] ? argv[evidenceDirArgIndex + 1] : null;

function isoNow(): string {
  return new Date().toISOString();
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim();
}

// ---------------------------------------------------------------------------
// evidence dir
// ---------------------------------------------------------------------------

function pickEvidenceDir(): string {
  if (evidenceDirArg) return resolve(evidenceDirArg);
  const root = join(repoRoot, "docs", "qa", "evidence");
  if (existsSync(root)) {
    const candidates = readdirSync(root)
      .filter((name) => name.startsWith("tp-5a3bfad8-L3-"))
      .sort()
      .reverse();
    if (candidates.length > 0) return join(root, candidates[0]);
  }
  const head = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return join(root, `tp-5a3bfad8-L3-${stamp}-commit-${head}`);
}

const evidenceDir = pickEvidenceDir();
mkdirSync(evidenceDir, { recursive: true });
const commandsLog = join(evidenceDir, "commands.log");

function logCommand(entry: {
  op: string;
  cmd: string;
  cwd: string;
  home: string;
  exitCode: number | string;
}): void {
  appendFileSync(
    commandsLog,
    `${isoNow()} op=${entry.op} home=${entry.home} cwd=${entry.cwd} exit=${entry.exitCode} cmd=${entry.cmd}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// 1. parse the L1 guard list from the matrix (§11)
// ---------------------------------------------------------------------------

function parseGuards(path: string): { ids: string[]; sha: string } {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const ids: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s*11\.\s*守卫清单/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const m = line.match(/^\|\s*\*\*(G-\d+)\*\*\s*\|/);
    if (m) ids.push(m[1]);
  }
  return { ids, sha: sha256(text) };
}

// ---------------------------------------------------------------------------
// 2. parse the map table
// ---------------------------------------------------------------------------

interface MapRow {
  id: string;
  status: string;
  file: string;
  caseName: string;
  line: string;
  excerpt: string;
  note: string;
  result: string;
}

function parseMap(path: string): MapRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const headerIdx = lines.findIndex((l) => /^\|\s*G-ID\s*\|\s*状态\s*\|/.test(l));
  if (headerIdx < 0) throw new Error("map table header `| G-ID | 状态 |` not found in " + path);
  const rows: MapRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== EXPECTED_COLUMNS) {
      throw new Error(
        `map row has ${cells.length} cells, expected ${EXPECTED_COLUMNS}: ${line.slice(0, 120)}`,
      );
    }
    const id = cells[0].replace(/\*/g, "").trim();
    if (!/^G-\d+$/.test(id)) continue;
    rows.push({
      id,
      status: cells[1],
      file: cells[2],
      caseName: cells[3],
      line: cells[4],
      excerpt: cells[5],
      note: cells[6],
      result: cells[7],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. sandbox copy + sha256 manifest
// ---------------------------------------------------------------------------

const COMPARE_ROOT_FILES = ["package.json", "tsconfig.json", "bun.lock"];
const COMPARE_DIRS = ["src", "tests", "scripts"];

const EXCLUDED_NAMES = new Set([
  ".git",
  ".DS_Store",
  "lot-trader-global-dashboard.html",
  "dist",
  "trade",
  "tsconfig.tsbuildinfo",
]);

function copyRepo(dest: string): void {
  cpSync(repoRoot, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => {
      const rel = relative(repoRoot, src);
      if (rel === "") return true;
      const parts = rel.split(sep);
      if (parts.some((p) => EXCLUDED_NAMES.has(p))) return false;
      // Whole docs/qa (L1/L2 write there in parallel; leaving it in would make copy_drift cry wolf).
      if (rel === "docs/qa" || rel.startsWith(`docs/qa${sep}`)) return false;
      return true;
    },
  });
}

function walkFiles(root: string, relPrefix: string, out: string[]): void {
  const abs = relPrefix ? join(root, relPrefix) : root;
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function manifestOf(root: string): Map<string, string> {
  const rels: string[] = [];
  for (const dir of COMPARE_DIRS) walkFiles(root, dir, rels);
  for (const f of COMPARE_ROOT_FILES) {
    if (existsSync(join(root, f))) rels.push(f);
  }
  const manifest = new Map<string, string>();
  for (const rel of rels.sort()) {
    manifest.set(rel, sha256File(join(root, rel)));
  }
  return manifest;
}

function manifestText(manifest: Map<string, string>): string {
  return (
    [...manifest.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([rel, hash]) => `${hash}  ${rel}`)
      .join("\n") + "\n"
  );
}

function countDrift(a: Map<string, string>, b: Map<string, string>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let drift = 0;
  for (const key of keys) if (a.get(key) !== b.get(key)) drift++;
  return drift;
}

// ---------------------------------------------------------------------------
// 4. isolated bun test run
// ---------------------------------------------------------------------------

interface TestRun {
  exitCode: number;
  log: string;
  statusByName: Map<string, string>;
  pass: number;
  fail: number;
  skip: number;
  footer: string[];
  footerPass: number | null;
  footerFail: number | null;
  footerSkip: number | null;
  footerRan: number | null;
  footerFiles: number | null;
  childEnvKeys: string[];
  strippedAgentEnv: string[];
}

/** Keys that make bun 1.3.14 drop per-test `(pass)` lines (or merely look agent-ish). Report-only. */
const AGENT_ENV_PATTERNS: RegExp[] = [
  /^CLAUDECODE$/,
  /^CLAUDE_/,
  /^AI_AGENT$/,
  /^AGENT$/,
  /^REPL_ID$/,
  /^CURSOR/,
  /^CODEX/,
  /^ANTHROPIC/,
  /^OPENAI/,
  /^MCP/,
];

interface ChildEnvPlan {
  env: Record<string, string>;
  keys: string[];
  strippedAgentEnv: string[];
  whitelist: boolean;
}

function buildChildEnv(sandbox: string): ChildEnvPlan {
  const sandboxVars: Record<string, string> = {
    HOME: join(sandbox, "fakehome"),
    TMPDIR: join(sandbox, "tmp"),
    LOT_TRADER_DB: join(sandbox, "run", "lot-trader.db"),
    TRADE_DB_PATH: join(sandbox, "run", "trade.db"),
    LOT_TRADER_TOKEN_FILE: join(sandbox, "run", "session.token"),
  };
  const strippedAgentEnv = Object.keys(process.env)
    .filter((key) => AGENT_ENV_PATTERNS.some((re) => re.test(key)))
    .sort();

  if (leakParentEnv) {
    // Control group: the pre-fix behaviour — inherit the whole parent env (only LOT_TRADER_*/TRADE_*
    // are stripped so the sandbox ledger still wins). Agent markers leak through on purpose.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^LOT_TRADER_/.test(key) || /^TRADE_/.test(key)) continue;
      env[key] = value;
    }
    const merged = { ...env, ...sandboxVars };
    return { env: merged, keys: Object.keys(merged).sort(), strippedAgentEnv, whitelist: false };
  }

  // Whitelist: PATH stays verbatim (so the test matrix is not degraded), everything else is sandbox.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ...sandboxVars,
  };
  return { env, keys: Object.keys(env).sort(), strippedAgentEnv, whitelist: true };
}

function parseTestRun(log: string): TestRun {
  const statusByName = new Map<string, string>();
  const footer: string[] = [];
  let footerPass: number | null = null;
  let footerFail: number | null = null;
  let footerSkip: number | null = null;
  let footerRan: number | null = null;
  let footerFiles: number | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\((pass|fail|skip)\)\s+(.*?)(?:\s+\[\d+(?:\.\d+)?\s*ms\])?$/);
    if (m) {
      const name = m[2];
      const status = m[1];
      const prev = statusByName.get(name);
      // bun re-prints every failure in the trailing detail block: dedupe by name, worst status wins.
      if (prev === undefined || (prev === "pass" && status !== "pass")) statusByName.set(name, status);
      continue;
    }
    const fp = line.match(/^\s*(\d+)\s+pass\b/);
    if (fp) {
      footerPass = Number(fp[1]);
      footer.push(line.trim());
      continue;
    }
    const ff = line.match(/^\s*(\d+)\s+fail\b/);
    if (ff) {
      footerFail = Number(ff[1]);
      footer.push(line.trim());
      continue;
    }
    const fs = line.match(/^\s*(\d+)\s+skip\b/);
    if (fs) {
      footerSkip = Number(fs[1]);
      footer.push(line.trim());
      continue;
    }
    const fr = line.match(/^Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/);
    if (fr) {
      footerRan = Number(fr[1]);
      footerFiles = Number(fr[2]);
      footer.push(line.trim());
    }
  }
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const status of statusByName.values()) {
    if (status === "pass") pass++;
    else if (status === "fail") fail++;
    else skip++;
  }
  return {
    exitCode: 0,
    log,
    statusByName,
    pass,
    fail,
    skip,
    footer,
    footerPass,
    footerFail,
    footerSkip,
    footerRan,
    footerFiles,
    childEnvKeys: [],
    strippedAgentEnv: [],
  };
}

async function runBunTest(copyRoot: string, sandbox: string): Promise<TestRun> {
  const plan = buildChildEnv(sandbox);
  const env = plan.env;
  for (const dir of [env.HOME, env.TMPDIR, join(sandbox, "run")]) mkdirSync(dir, { recursive: true });

  const bunBin = process.execPath;
  const proc = Bun.spawn([bunBin, "test"], {
    cwd: copyRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  logCommand({
    op: leakParentEnv ? "bun-test-isolated-LEAK-CONTROL" : "bun-test-isolated",
    cmd: `${bunBin} test`,
    cwd: copyRoot,
    home: env.HOME,
    exitCode,
  });

  const log = `${stdout}${stderr}`;
  writeFileSync(join(evidenceDir, "bun-test-full.log"), log, "utf8");
  const run = parseTestRun(log);
  run.exitCode = exitCode;
  run.childEnvKeys = plan.keys;
  run.strippedAgentEnv = plan.strippedAgentEnv;
  // Append-only observation trail: any non-pass in the full suite is recorded, never overwritten.
  if (run.fail > 0 || run.skip > 0) {
    const failed = [...run.statusByName.entries()]
      .filter(([, status]) => status !== "pass")
      .map(([name, status]) => `${status}: ${name}`);
    appendFileSync(
      join(evidenceDir, "bun-test-nonpass-observations.log"),
      `${isoNow()} pass=${run.pass} fail=${run.fail} skip=${run.skip} exit=${exitCode} | ${failed.join(" || ")}\n`,
      "utf8",
    );
  }
  return run;
}

// ---------------------------------------------------------------------------
// 5. main
// ---------------------------------------------------------------------------

const started = isoNow();
const guardList = parseGuards(matrixPath);
let rows = parseMap(mapPath);

// --- injection switches (in-memory only; never write the map file) ---
const mappedRows = rows.filter((r) => r.status === "MAPPED");
let injected = "none";
const firstMapped = mappedRows[0];
if (injectMissingTest) {
  if (!firstMapped) throw new Error("--inject-missing-test: no MAPPED row to tamper with");
  firstMapped.caseName = `${firstMapped.caseName.split(" > ")[0]} > __INJECTED_NONEXISTENT_CASE__${Date.now()}`;
  injected = `${firstMapped.id}:missing-test`;
}
if (injectExcerptMismatch) {
  if (!firstMapped) throw new Error("--inject-excerpt-mismatch: no MAPPED row to tamper with");
  firstMapped.excerpt = `${firstMapped.excerpt} /* INJECTED-EXCERPT-MISMATCH */`;
  injected = `${firstMapped.id}:excerpt-mismatch`;
}

// --- sandbox ---
const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "")
  .replace(/-/g, "")
  .slice(0, 15);
const sandbox = `/tmp/tp-5a3bfad8-L3-${stamp}-${process.pid}`;
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });
const copyRoot = join(sandbox, "repo");

writeFileSync(
  join(evidenceDir, "checker-env.txt"),
  [
    `started=${started}`,
    `repo=${repoRoot}`,
    `head=${git(["rev-parse", "HEAD"])}`,
    `bun=${process.execPath}`,
    `sandbox=${sandbox}`,
    `evidence_dir=${evidenceDir}`,
    `flags=${argv.join(" ") || "(none)"}`,
    "",
  ].join("\n"),
  "utf8",
);

copyRepo(copyRoot);

const repoManifest = manifestOf(repoRoot);
const copyManifest = manifestOf(copyRoot);
writeFileSync(join(evidenceDir, "copy-sha256-repo.txt"), manifestText(repoManifest), "utf8");
writeFileSync(join(evidenceDir, "copy-sha256-copy.txt"), manifestText(copyManifest), "utf8");
const copyDrift = countDrift(repoManifest, copyManifest);

logCommand({
  op: "sandbox-copy",
  cmd: `cp -R (exclude .git, docs/qa, lot-trader-global-dashboard.html, dist, trade) ${repoRoot}/ -> ${copyRoot}/`,
  cwd: repoRoot,
  home: "(unset)",
  exitCode: copyDrift === 0 ? 0 : `drift=${copyDrift}`,
});

// --- isolated test run ---
const run = await runBunTest(copyRoot, sandbox);
const postRunRepoManifest = manifestOf(repoRoot);
const postRunDrift = countDrift(postRunRepoManifest, repoManifest);

// --- counters (declared before the reconciliation so it can report first) ---
let mapped = 0;
let gap = 0;
let blank = 0;
let testMissing = 0;
let notPass = 0;
let excerptMismatch = 0;
const problems: string[] = [];

// --- footer reconciliation FIRST: parsed per-test counts MUST equal the summary block. ---
// 放在逐守卫检查之前，是为了让它的 problem 行永远排在 problems 的第一条、不会被打印上限截掉。
let parseMismatch = 0;
let parseMismatchDetail = "";
{
  const parsedTotal = run.pass + run.fail + run.skip;
  const footerSkipExpected = run.footerSkip ?? 0;
  if (run.footerPass === null || run.footerFail === null) {
    parseMismatch = 1;
    parseMismatchDetail =
      `日志末尾汇总行缺失（footerPass=${run.footerPass} footerFail=${run.footerFail}），逐用例状态不可信`;
  } else if (
    run.pass !== run.footerPass ||
    run.fail !== run.footerFail ||
    run.skip !== footerSkipExpected ||
    (run.footerRan !== null && run.footerRan !== parsedTotal)
  ) {
    parseMismatch = 1;
    parseMismatchDetail =
      `解析出 pass=${run.pass} fail=${run.fail} skip=${run.skip}（合计 ${parsedTotal}），` +
      `日志汇总行为 [${run.footer.join(" | ")}]，两者不一致 —— 逐用例状态不可信，not_pass / 映射结论不得采信`;
  }
  if (parseMismatch === 1) problems.push(`parse_mismatch: ${parseMismatchDetail}`);
}

// --- per-guard checks ---
const byId = new Map(rows.map((r) => [r.id, r]));
const fileCache = new Map<string, string>();

for (const guardId of guardList.ids) {
  const row = byId.get(guardId);
  if (!row || row.status === "") {
    blank++;
    problems.push(`blank: ${guardId} has no row / empty status`);
    continue;
  }
  if (row.status === "GAP") {
    gap++;
    continue;
  }
  if (row.status !== "MAPPED") {
    blank++;
    problems.push(`blank: ${guardId} status "${row.status}" is neither MAPPED nor GAP`);
    continue;
  }
  mapped++;

  // (a) the mapped case must exist in the named test file.
  const fileRel = row.file;
  const fileAbs = join(repoRoot, fileRel);
  let fileText: string | null = null;
  if (!fileRel.includes(".test.ts") || !existsSync(fileAbs)) {
    testMissing++;
    problems.push(`test_missing: ${guardId} file not found: ${fileRel}`);
  } else {
    fileText = fileCache.get(fileRel) ?? readFileSync(fileAbs, "utf8");
    fileCache.set(fileRel, fileText);
    const itName = row.caseName.split(" > ").pop() ?? "";
    if (!fileText.includes(`"${itName}"`)) {
      testMissing++;
      problems.push(`test_missing: ${guardId} case not in ${fileRel}: ${row.caseName}`);
    } else if (run.statusByName.get(row.caseName) !== "pass") {
      notPass++;
      problems.push(
        `not_pass: ${guardId} ${row.caseName} => ${run.statusByName.get(row.caseName) ?? "absent from run log"}`,
      );
    }
  }

  // (b) the verbatim excerpt must sit within ±5 lines of the quoted line number.
  const lineNo = Number.parseInt(row.line, 10);
  const fileLines = fileText === null ? readFileSync(fileAbs, "utf8").split("\n") : fileText.split("\n");
  if (!Number.isFinite(lineNo) || lineNo < 1 || lineNo > fileLines.length) {
    excerptMismatch++;
    problems.push(`excerpt_mismatch: ${guardId} line ${row.line} out of range for ${fileRel}`);
  } else {
    const lo = Math.max(1, lineNo - 5);
    const hi = Math.min(fileLines.length, lineNo + 5);
    let found = false;
    for (let i = lo; i <= hi; i++) {
      if (fileLines[i - 1] !== undefined && fileLines[i - 1].includes(row.excerpt)) {
        found = true;
        break;
      }
    }
    if (!found) {
      excerptMismatch++;
      problems.push(`excerpt_mismatch: ${guardId} excerpt not found in ${fileRel}:${lo}-${hi}`);
    }
  }
}

// guard ids present in the map but not in the matrix (extra rows) are also a defect
for (const row of rows) {
  if (!guardList.ids.includes(row.id)) {
    blank++;
    problems.push(`blank: ${row.id} exists in the map but not in the L1 guard list`);
  }
}

// --- report ---
const summary =
  `guards=${guardList.ids.length} mapped=${mapped} gap=${gap} blank=${blank} ` +
  `test_missing=${testMissing} not_pass=${notPass} excerpt_mismatch=${excerptMismatch} copy_drift=${copyDrift} ` +
  `parse_mismatch=${parseMismatch}`;
console.log(summary);
console.log(`# matrix=${matrixPath}`);
console.log(`# matrix_sha256=${guardList.sha}`);
console.log(`# map=${mapPath} sha256=${sha256File(mapPath)}`);
console.log(`# repo_head=${git(["rev-parse", "HEAD"])}`);
console.log(`# bun=${process.execPath} (${Bun.version})`);
console.log(`# sandbox=${sandbox} (cwd of every bun test call; real path ${existsSync(sandbox) ? statSync(sandbox).isDirectory() ? "dir" : "?" : "?"})`);
console.log(`# evidence_dir=${evidenceDir}`);
console.log(`# injected=${injected}`);
console.log(
  `# child_env=${leakParentEnv ? "LEAK-CONTROL(all parent keys)" : "whitelist"}:${run.childEnvKeys.join(",")}`,
);
console.log(
  `# parent_agent_env_stripped=${run.strippedAgentEnv.length > 0 ? run.strippedAgentEnv.join(",") : "(none)"}`,
);
console.log(
  `# bun_test_files=${readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")).length} ` +
    `pass=${run.pass} fail=${run.fail} skip=${run.skip} exit=${run.exitCode}`,
);
console.log(`# bun_test_footer=${run.footer.join(" | ")}`);
console.log(`# copy_drift_pre_run=${copyDrift} post_run_repo_vs_copy_drift=${postRunDrift}`);
console.log(`# map_rows=${rows.length} mapped_plus_gap=${mapped + gap}`);
if (parseMismatch === 1) console.log(`# parse_mismatch_detail=${parseMismatchDetail}`);
if (problems.length === 0) {
  console.log("# problems=none");
} else {
  const limit = 25;
  for (const p of problems.slice(0, limit)) console.log(`# problem: ${p}`);
  if (problems.length > limit) {
    console.log(`# problem: ... (+${problems.length - limit} more suppressed, total ${problems.length})`);
  }
}

const expectedClean =
  blank === 0 &&
  testMissing === 0 &&
  notPass === 0 &&
  excerptMismatch === 0 &&
  copyDrift === 0 &&
  parseMismatch === 0 &&
  mapped + gap === guardList.ids.length;

if (!keepSandbox) rmSync(sandbox, { recursive: true, force: true });
logCommand({
  op: injectMissingTest ? "check-inject-missing-test" : injectExcerptMismatch ? "check-inject-excerpt-mismatch" : "check-guard-unit-map",
  cmd: `${process.execPath} docs/qa/tools/check-guard-unit-map.ts ${argv.join(" ")}`.trim(),
  cwd: repoRoot,
  home: "(inherited)",
  exitCode: expectedClean ? 0 : 1,
});

process.exit(expectedClean ? 0 : 1);
