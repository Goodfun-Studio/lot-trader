#!/usr/bin/env bun
/**
 * check-e2e-report.ts — tp-5a3bfad8 L4 `line-qa-runbook-report` 的 E2E 报告 checker。
 *
 *   bun docs/qa/tools/check-e2e-report.ts docs/qa/reports/e2e-report-<ts>-commit-<sha>.md
 *   bun docs/qa/tools/check-e2e-report.ts <报告> --results <证据目录或 results.json>
 *   bun docs/qa/tools/check-e2e-report.ts <报告> --flow docs/qa/e2e-test-flow.md
 *   bun docs/qa/tools/check-e2e-report.ts <报告> --inject-missing-field     # 自检：真删一个字段
 *   bun docs/qa/tools/check-e2e-report.ts <报告> --inject-result-mismatch   # 自检：真改一条结果
 *   bun docs/qa/tools/check-e2e-report.ts <报告> --strict                   # 任一计数非 0 退出码 1
 *
 * 输出恰好一行：
 *   cases=<N> missing_fields=<N> evidence_missing=<N> result_mismatch=<N>
 *
 * 口径：
 *   cases           报告里解析出的用例块数；必须等于 `docs/qa/e2e-test-flow.md` 的用例行数，
 *                   也必须等于 results.json 的用例数
 *   missing_fields  五字段（命令 / 输入·环境 / 前状态 / 后状态 / 判据）中缺失或值为空的**实例**数
 *   evidence_missing 报告的 §5 执行步证据索引与 results.json 的 cases[].evidence 不一致，
 *                   或引用的证据文件在磁盘上不存在的**用例**数
 *   result_mismatch 报告里用例结果与 results.json 不一致（含只存在于一侧）的**用例**数
 *
 * 诊断与配对口径：
 *   报告 §1 的「证据目录」必须等于 results.json 的 meta.evidenceDir —— 不等就说明「报告」与
 *   「--results」不是同一次运行（跨次混搭）。这一项不算进上面四个计数，而是打 `# problem:`
 *   并由 `--strict` 视作失败。
 *
 * 自检注入都是**真改报告文本**，再走同一条检测路径 —— 不是把计数 +1：
 *   --inject-missing-field     删掉第一条含「前状态」的用例块里的那一行
 *   --inject-result-mismatch   把第一条 PASS 用例的 result=PASS 改成 result=FAIL
 *   两个可以同时给，按顺序各改一处。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dirname ?? import.meta.dir, "..", "..", "..");

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const REPORT_ARG = argOf("--report") ?? positional[0];
const RESULTS_ARG = argOf("--results");
const FLOW_ARG = argOf("--flow") ?? join(REPO, "docs/qa/e2e-test-flow.md");
const INJECT_MISSING = has("--inject-missing-field");
const INJECT_MISMATCH = has("--inject-result-mismatch");
const STRICT = has("--strict");
const VERBOSE = process.env.QA_REPORT_VERBOSE === "1";

const die = (msg: string, code = 2): never => {
  console.error(`check-e2e-report: FATAL: ${msg}`);
  process.exit(code);
};

if (!REPORT_ARG) die("缺少报告路径（或 --report <报告>）");
const REPORT_PATH = isAbsolute(REPORT_ARG) ? REPORT_ARG : resolve(process.cwd(), REPORT_ARG);
if (!existsSync(REPORT_PATH)) die(`报告不存在: ${REPORT_PATH}`);

// ------------------------------------------------------------------ 证据与用例表
/** results.json 路径：--results 可给「证据目录」或直接给 results.json。 */
function resolveResults(): string {
  if (RESULTS_ARG) {
    const p = isAbsolute(RESULTS_ARG) ? RESULTS_ARG : resolve(process.cwd(), RESULTS_ARG);
    if (!existsSync(p)) die(`--results 路径不存在: ${p}`);
    if (statSync(p).isDirectory()) {
      const r = join(p, "results.json");
      if (!existsSync(r)) die(`--results 目录里没有 results.json: ${p}`);
      return r;
    }
    return p;
  }
  // 未指定：从报告 §1 的「证据目录」行反查
  const text = readFileSync(REPORT_PATH, "utf-8");
  const m = /^\|\s*证据目录\s*\|\s*`([^`]+)`\s*\|/m.exec(text);
  if (m) {
    const cand = join(REPO, m[1].replace(/^\.\//, ""));
    if (existsSync(join(cand, "results.json"))) return join(cand, "results.json");
  }
  return "";
}
const RESULTS_PATH = resolveResults();
if (!RESULTS_PATH) die("无法定位 results.json：报告缺少「证据目录」行，或该目录下没有 results.json；请显式传 --results");

type ResultsJson = {
  meta?: { evidenceDir?: string; [k: string]: unknown };
  summary?: { total?: number; [k: string]: unknown };
  cases: Record<string, { result: string; kind?: string; evidence?: string[] }>;
};
const results: ResultsJson = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
const rc = results.cases ?? {};
const EVID_DIR = results.meta?.evidenceDir ? join(REPO, String(results.meta.evidenceDir).replace(/^\.\//, "")) : resolve(RESULTS_PATH, "..");

/** 用例表用例 ID（`docs/qa/e2e-test-flow.md` 的 `| E2E-…` 行）。 */
const flowIds = new Set<string>();
if (existsSync(FLOW_ARG)) {
  for (const line of readFileSync(FLOW_ARG, "utf-8").split("\n")) {
    if (!/^\|\s*E2E-/.test(line)) continue;
    const id = line.replace(/^\|\s*/, "").split("|")[0].trim();
    if (/^E2E-[A-Z]+-\d+$/.test(id)) flowIds.add(id);
  }
}
const resultsIds = new Set(Object.keys(rc));

// ------------------------------------------------------------------ 报告解析（唯一的检测路径）
const FIELD_LABELS = ["命令", "输入/环境", "前状态", "后状态", "判据"] as const;
type Block = { id: string; result: string; lineNo: number; fields: Map<string, string> };

function parseReport(text: string): { blocks: Block[]; byId: Map<string, Block>; indexResults: Map<string, string>; evidenceIndex: Map<string, string[]> } {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const byId = new Map<string, Block>();
  const indexResults = new Map<string, string>();
  const evidenceIndex = new Map<string, string[]>();
  let cur: Block | null = null;
  let inEvidenceIndex = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // §5 执行步证据索引（围栏内 `ID: a.json, b.cmd`）
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inEvidenceIndex && inFence) {
      const m = /^(E2E-[A-Z]+-\d+):\s*(.*)$/.exec(line.trim());
      if (m) evidenceIndex.set(m[1], m[2] === "(无证据文件)" ? [] : m[2].split(",").map((s) => s.trim()).filter(Boolean));
      continue;
    }

    // 用例块头
    const h = /^###\s+(E2E-[A-Z]+-\d+)\s+·\s+result=(\S+)(?:\s+·\s+kind=(\S+))?(?:\s+·\s+guards=(\S+))?/.exec(line);
    if (h) {
      cur = { id: h[1], result: h[2], lineNo: i + 1, fields: new Map() };
      blocks.push(cur);
      if (!byId.has(cur.id)) byId.set(cur.id, cur);
      else console.error(`check-e2e-report: problem: 用例块重复: ${cur.id}@${cur.lineNo}`);
      continue;
    }
    // §2.2 索引表行：| E2E-… | kind | guards | **RESULT** | ev |
    const t = /^\|\s*(E2E-[A-Z]+-\d+)\s*\|/.exec(line);
    if (t) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length >= 4) {
        const r = cells[3].replace(/\*\*/g, "").trim();
        if (/^(PASS|FAIL|BLOCKED)$/.test(r)) indexResults.set(cells[0], r);
      }
      inEvidenceIndex = /执行步证据索引/.test(line);
      continue;
    }
    if (/^##\s+5\.\s*执行步证据索引/.test(line)) { inEvidenceIndex = true; cur = null; continue; }
    if (/^##\s+/.test(line)) { inEvidenceIndex = false; cur = null; continue; }

    // 五字段
    if (cur) {
      const f = /^-\s+\*\*(命令|输入\/环境|前状态|后状态|判据)\*\*：\s*(.*)$/.exec(line);
      if (f) {
        const val = f[2].trim();
        if (!cur.fields.has(f[1])) cur.fields.set(f[1], val);
        else console.error(`check-e2e-report: problem: 字段重复 ${cur.id} ${f[1]}@${i + 1}`);
      }
    }
  }
  return { blocks, byId, indexResults, evidenceIndex };
}

const rawReport = readFileSync(REPORT_PATH, "utf-8");
let reportText = rawReport;
const injectedAll: string[] = [];

if (INJECT_MISSING) {
  // 真删：第一条含「前状态」的字段行
  const lines = reportText.split("\n");
  const idx = lines.findIndex((l) => /^-\s+\*\*前状态\*\*：/.test(l.trimEnd()));
  if (idx < 0) die("--inject-missing-field: 报告里找不到任何「前状态」字段行，无法注入");
  const removed = lines[idx];
  lines.splice(idx, 1);
  reportText = lines.join("\n");
  injectedAll.push(`missing_field: 删除了第 ${idx + 1} 行 ${JSON.stringify(removed)}`);
}
if (INJECT_MISMATCH) {
  // 真改：第一条 PASS 用例的 result=PASS → result=FAIL
  const lines = reportText.split("\n");
  const idx = lines.findIndex((l) => /^###\s+E2E-[A-Z]+-\d+\s+·\s+result=PASS/.test(l));
  if (idx < 0) die("--inject-result-mismatch: 报告里找不到 result=PASS 的用例块，无法注入");
  const before = lines[idx];
  const after = before.replace("result=PASS", "result=FAIL");
  lines[idx] = after;
  reportText = lines.join("\n");
  injectedAll.push(`result_mismatch: 第 ${idx + 1} 行 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

if (injectedAll.length) {
  // 把注入后的真实文本落盘到 /tmp 并立刻回收，证明确实是「改了文本再走同一条检测路径」
  const dir = mkdtempSync(join(tmpdir(), "check-e2e-report-inject-"));
  const p = join(dir, "report.injected.md");
  writeFileSync(p, reportText);
  for (const s of injectedAll) console.error(`check-e2e-report: ${s}`);
  console.error(`check-e2e-report: 注入副本 ${p}（${reportText.length} bytes，已走同一条检测路径）`);
  rmSync(dir, { recursive: true, force: true });
  console.error(`check-e2e-report: 注入副本已删除 ${dir}`);
}

const { blocks, byId, indexResults, evidenceIndex } = parseReport(reportText);

// ------------------------------------------------------------------ 报告 ⇄ results.json 配对
const reportEvidLine = /^\|\s*证据目录\s*\|\s*`([^`]+)`\s*\|/m.exec(rawReport);
const reportEvid = reportEvidLine ? reportEvidLine[1].replace(/^\.\//, "").replace(/\/+$/, "") : "(报告未写证据目录)";
const metaEvid = String(results.meta?.evidenceDir ?? "(results.json 未写 evidenceDir)").replace(/^\.\//, "").replace(/\/+$/, "");
const pairingOk = reportEvid === metaEvid;

// ------------------------------------------------------------------ 计数
const reportIds = new Set(blocks.map((b) => b.id));

// missing_fields：五字段实例数
let missingFields = 0;
for (const b of blocks) {
  for (const label of FIELD_LABELS) {
    const v = b.fields.get(label);
    if (v === undefined || v === "") {
      missingFields++;
      if (VERBOSE) console.error(`  missing_fields: ${b.id} 缺少「${label}」`);
    }
  }
}

// evidence_missing：报告 §5 索引 ⇄ results.json ⇄ 磁盘
let evidenceMissing = 0;
const evProblems: string[] = [];
for (const id of reportIds) {
  const fromResults = (rc[id]?.evidence ?? []).map((p) => String(p).split("/").pop() as string).sort();
  const fromReport = [...(evidenceIndex.get(id) ?? [])].sort();
  const setEq = fromResults.length === fromReport.length && fromResults.every((v, i) => v === fromReport[i]);
  const diskMissing = fromResults.filter((f) => !existsSync(join(EVID_DIR, f)));
  if (!setEq || diskMissing.length) {
    evidenceMissing++;
    const bits: string[] = [];
    if (!setEq) bits.push(`索引与 results.json 不一致（报告 ${fromReport.length} 项 / results ${fromResults.length} 项）`);
    if (diskMissing.length) bits.push(`磁盘缺失 ${diskMissing.slice(0, 3).join(",")}${diskMissing.length > 3 ? "…" : ""}`);
    evProblems.push(`${id}: ${bits.join("；")}`);
    if (VERBOSE) console.error(`  evidence_missing: ${evProblems[evProblems.length - 1]}`);
  }
}

// result_mismatch：报告用例结果 / §2.2 索引结果 ⇄ results.json；以及用例集合差异
const mismatchIds = new Set<string>();
for (const id of reportIds) {
  const rec = rc[id];
  if (!rec) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} 只存在于报告`); continue; }
  const b = byId.get(id)!;
  if (b.result !== rec.result) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} 用例块=${b.result} results.json=${rec.result}`); }
  const ix = indexResults.get(id);
  if (ix !== undefined && ix !== rec.result) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} §2.2 索引=${ix} results.json=${rec.result}`); }
}
for (const id of resultsIds) if (!reportIds.has(id)) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} 只存在于 results.json`); }
for (const id of flowIds) if (!reportIds.has(id)) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} 只存在于 e2e-test-flow.md`); }
for (const id of reportIds) if (flowIds.size && !flowIds.has(id)) { mismatchIds.add(id); if (VERBOSE) console.error(`  result_mismatch: ${id} 只存在于报告（用例表无此条）`); }

const cases = reportIds.size;
const line = `cases=${cases} missing_fields=${missingFields} evidence_missing=${evidenceMissing} result_mismatch=${mismatchIds.size}`;
console.log(line);

// ------------------------------------------------------------------ 诊断（stderr，不影响那一行）
console.error(`  report=${REPORT_PATH.replace(REPO + "/", "")} blocks=${blocks.length}`);
console.error(`  results=${RESULTS_PATH.replace(REPO + "/", "")} results_cases=${resultsIds.size} flow_cases=${flowIds.size}`);
const nz: string[] = [];
if (!pairingOk) nz.push(`报告证据目录(${reportEvid}) != results.json meta.evidenceDir(${metaEvid}) —— 报告与 --results 不是同一次运行`);
if (flowIds.size && cases !== flowIds.size) nz.push(`cases(${cases}) != e2e-test-flow.md 用例数(${flowIds.size})`);
if (cases !== resultsIds.size) nz.push(`cases(${cases}) != results.json 用例数(${resultsIds.size})`);
if (evProblems.length) nz.push(`evidence_missing: ${evProblems.slice(0, 5).join(" | ")}${evProblems.length > 5 ? " …" : ""}`);
if (mismatchIds.size) nz.push(`result_mismatch ids: ${[...mismatchIds].slice(0, 8).join(",")}${mismatchIds.size > 8 ? " …" : ""}`);
for (const s of nz) console.error(`  # problem: ${s}`);
if (!nz.length) console.error(`  all clean`);

const nonZero = missingFields !== 0 || evidenceMissing !== 0 || mismatchIds.size !== 0 || !pairingOk || (flowIds.size > 0 && cases !== flowIds.size) || cases !== resultsIds.size;
if (STRICT && nonZero) process.exit(1);
