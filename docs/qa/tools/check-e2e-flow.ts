#!/usr/bin/env bun
/**
 * check-e2e-flow.ts — 交叉核对 `docs/qa/e2e-test-flow.md`、L1 矩阵 `docs/qa/user-operation-matrix.md`
 * 与最新一次 E2E 实跑证据（`docs/qa/evidence/tp-5a3bfad8-L2-*\/results.json`）。
 *
 *   bun docs/qa/tools/check-e2e-flow.ts                  # 输出一行计数
 *   bun docs/qa/tools/check-e2e-flow.ts --strict         # 任一计数非 0 时退出码 1
 *   bun docs/qa/tools/check-e2e-flow.ts --flow /tmp/mut/flow.md --matrix /tmp/mut/matrix.md --results /tmp/mut/results.json
 *                                                        # 指向副本做变异自检（原件不动）
 *   bun docs/qa/tools/check-e2e-flow.ts --inject-uncovered      # 自检：写操作集合里加伪命令 → uncovered=1
 *   bun docs/qa/tools/check-e2e-flow.ts --inject-unpaired[=G-26] # 自检：内存中删掉该守卫的 legal 用例 → unpaired=1
 *   bun docs/qa/tools/check-e2e-flow.ts --inject-mismatch        # 自检：内存中把一条结果改成与证据不符 → result_mismatch=1
 *   bun docs/qa/tools/check-e2e-flow.ts --inject-pair-na-no-reason  # 自检：内存中删掉 pair_na 的原因 → 报错退出
 *
 * 输出恰好一行：
 *   cases=<N> pass=<N> fail=<N> blocked=<N> legal_fail=<N> pair_na=<N> uncovered=<N> unpaired=<N>
 *   evidence_missing=<N> blocked_no_reason=<N> result_mismatch=<N>
 *
 * 口径：
 *   uncovered           L1 矩阵「写库」列解析出的写操作命令路径中，没有任何 positive 用例引用其数量的条数（不硬编码）
 *   unpaired            四类守卫中缺 violation 或缺 legal 用例的条数。守卫类型含「拦截 / 状态转换 / 错误码映射」任一项即必须成对；
 *                       仅纯「安全门」类型且已标 pair_na（并写明原因）的才不计入
 *   evidence_missing    结果与证据对不上的用例数（results.json 列出的证据文件 / 用例表证据链缺失）
 *   blocked_no_reason   BLOCKED 用例的「预期」字段未写明缺失能力或待确认口径的条数（只看原因字段，不看结果列）
 *   result_mismatch     用例表结果列与 results.json 不一致（含仅存在于一侧）的条数
 *
 * 变异自检的注入都是**在内存里改数据、再走同一套检测逻辑**得出计数，不是常量加一。
 * 注意：只改用例表而不同步 results.json 的真实变异，会同时触发 result_mismatch（这是预期副作用）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO = resolve(import.meta.dirname ?? import.meta.dir, "..", "..", "..");
const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const pre = process.argv.find((a) => a.startsWith(`${name}=`));
  return pre ? pre.slice(name.length + 1) : undefined;
};
const FLOW = resolve(argOf("--flow") ?? join(REPO, "docs/qa/e2e-test-flow.md"));
const MATRIX = resolve(argOf("--matrix") ?? join(REPO, "docs/qa/user-operation-matrix.md"));
const EVID_ROOT = join(REPO, "docs/qa/evidence");
const STRICT_PAIR_TYPES = ["拦截", "状态转换", "错误码映射"];
const SECURITY_GATE = "安全门";
const INJECT_UNCOVERED = process.argv.includes("--inject-uncovered");
const INJECT_UNPAIRED = process.argv.some((a) => a === "--inject-unpaired" || a.startsWith("--inject-unpaired="));
const INJECT_UNPAIRED_GUARD = argOf("--inject-unpaired") ?? "G-15";
const INJECT_MISMATCH = process.argv.includes("--inject-mismatch");
const INJECT_PAIRNA = process.argv.includes("--inject-pair-na-no-reason");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.env.QA_CHECK_VERBOSE === "1";

for (const f of [FLOW, MATRIX]) if (!existsSync(f)) { console.error(`check-e2e-flow: FATAL: 缺少 ${f}`); process.exit(2); }

// ---------------------------------------------------------------- 1. 用例表
type Row = { id: string; guards: string[]; kind: string; steps: string; expect: string; source: string; result: string; evidence: string };
const flowText = readFileSync(FLOW, "utf-8");
const rows: Row[] = [];
for (const line of flowText.split("\n")) {
  if (!/^\|\s*E2E-/.test(line)) continue;
  const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  if (cells.length !== 8) { console.error(`check-e2e-flow: FATAL: 用例行字段不是 8 列（实际 ${cells.length} 列，疑似单元格内含竖线切开了表格）: ${line.slice(0, 100)}`); process.exit(2); }
  rows.push({ id: cells[0], guards: (cells[1].match(/G-\d+/g) ?? []), kind: cells[2], steps: cells[3], expect: cells[4], source: cells[5], result: cells[6], evidence: cells[7] });
}
if (!rows.length) { console.error("check-e2e-flow: FATAL: e2e-test-flow.md 未解析到任何用例行（是否还没跑过 run-e2e.ts？）"); process.exit(2); }

// ---------------------------------------------------------------- 2. results.json
const evDirs = existsSync(EVID_ROOT)
  ? readdirSync(EVID_ROOT).filter((d) => d.startsWith("tp-5a3bfad8-L2-") && statSync(join(EVID_ROOT, d)).isDirectory() && existsSync(join(EVID_ROOT, d, "results.json"))).sort().map((d) => join(EVID_ROOT, d))
  : [];
const latestDir = argOf("--results") ?? evDirs[evDirs.length - 1];
if (!latestDir) { console.error("check-e2e-flow: FATAL: 未找到任何带 results.json 的 L2 证据目录"); process.exit(2); }
const resultsPath = latestDir.endsWith(".json") ? latestDir : join(latestDir, "results.json");
if (!existsSync(resultsPath)) { console.error(`check-e2e-flow: FATAL: 缺少 ${resultsPath}`); process.exit(2); }
const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
const rc: Record<string, { result: string; evidence: string[]; kind?: string }> = results.cases ?? {};

// ---------------------------------------------------------------- 3. L1 矩阵（守卫类型 + 写操作命令路径）
const matrixLines = readFileSync(MATRIX, "utf-8").split("\n");
const guardType = new Map<string, string>();
let inGuardTable = false;
for (const line of matrixLines) {
  if (/^##\s*11\..*守卫清单/.test(line)) { inGuardTable = true; continue; }
  if (inGuardTable && /^##\s*12\./.test(line)) { inGuardTable = false; continue; }
  if (!inGuardTable) continue;
  const m = /^\|\s*\*\*(G-\d+)\*\*\s*\|\s*([^|]+?)\s*\|/.exec(line);
  if (m) guardType.set(m[1], m[2].replace(/[（(].*$/, "").trim());
}
if (!guardType.size) { console.error("check-e2e-flow: FATAL: 未能从 L1 矩阵 §11 解析出守卫清单"); process.exit(2); }

const allPaths = new Set<string>();
const writePaths = new Set<string>();
for (const line of matrixLines) {
  const m = /^\|\s*`([A-Z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
  if (!m) continue;
  const cmd = m[2].trim();
  const writeCell = m[4].replace(/\*\*/g, "").trim();
  allPaths.add(cmd);
  const isWrite = /\+[0-9]/.test(writeCell) || /建库/.test(writeCell);
  if (isWrite) writePaths.add(cmd);
}
if (!writePaths.size) { console.error("check-e2e-flow: FATAL: 未能从 L1 矩阵「写库」列解析出写操作命令路径"); process.exit(2); }
if (INJECT_UNCOVERED) writePaths.add("trade dividend purge");   // 自检：矩阵里不存在的伪写命令

const pathList = [...allPaths].sort((a, b) => b.split(" ").length - a.split(" ").length);
function referencedPaths(stepsText: string): Set<string> {
  const out = new Set<string>();
  const text = stepsText.replace(/<br\s*\/?>/gi, "\n").replace(/&nbsp;/g, " ");
  for (const raw of text.split("\n")) {
    const m = /(?:^|\s)(?:\.\/)?trade\b([^\n]*)/.exec(raw);
    if (!m) continue;
    const toks = m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
    for (const p of pathList) {
      const want = p.split(" ").slice(1);
      if (want.every((w, i) => toks[i] === w)) { out.add(p); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 4. 变异注入（改内存数据，走同一套检测）
if (INJECT_UNPAIRED) {
  const before = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "legal" && rows[i].guards.includes(INJECT_UNPAIRED_GUARD)) rows.splice(i, 1);
  if (rows.length === before) { console.error(`check-e2e-flow: FATAL: --inject-unpaired 未找到 ${INJECT_UNPAIRED_GUARD} 的 legal 用例，无法注入`); process.exit(2); }
  if (VERBOSE) console.error(`  [inject] 删除 ${INJECT_UNPAIRED_GUARD} 的 legal 用例 ${before - rows.length} 条 → 走同一套成对检查`);
}
if (INJECT_MISMATCH) {
  const victim = rows.find((r) => rc[r.id] && rc[r.id].result !== "FLIPPED");
  if (!victim) { console.error("check-e2e-flow: FATAL: --inject-mismatch 找不到可注入的用例"); process.exit(2); }
  victim.result = victim.result === "PASS" ? "FAIL" : "PASS";
  if (VERBOSE) console.error(`  [inject] 把 ${victim.id} 的结果列改成 ${victim.result}（与 results.json=${rc[victim.id].result} 不符）→ 走同一套比对`);
}
if (INJECT_PAIRNA) {
  const na = rows.filter((r) => r.kind === "pair_na");
  if (!na.length) { console.error("check-e2e-flow: FATAL: --inject-pair-na-no-reason 找不到 pair_na 用例"); process.exit(2); }
  na[0].expect = "pair_na";
  if (VERBOSE) console.error(`  [inject] 抹掉 ${na[0].id} 的 pair_na 原因 → 预期报错退出`);
}

// ---------------------------------------------------------------- 5. 计数
const resultCount = (v: string) => rows.filter((r) => r.result === v).length;
const cases = rows.length;
const pass = resultCount("PASS");
const fail = resultCount("FAIL");
const blocked = resultCount("BLOCKED");
const legal_fail = rows.filter((r) => r.kind === "legal" && r.result === "FAIL").length;
const pair_na = rows.filter((r) => r.kind === "pair_na").length;

// pair_na 必须写明原因（缺失 → 报错）
const pairNaReasonOk = (r: Row) => { const m = /原因[:：]\s*([\s\S]*)$/.exec(r.expect); return !!m && m[1].replace(/\s+/g, "").length >= 10; };
const badPairNa = rows.filter((r) => r.kind === "pair_na" && !pairNaReasonOk(r));

// uncovered
const positiveRefs = new Set<string>();
for (const r of rows) if (r.kind === "positive") for (const p of referencedPaths(r.steps)) positiveRefs.add(p);
const uncoveredList = [...writePaths].filter((p) => !positiveRefs.has(p));

// unpaired
const unpairedList: string[] = [];
const pairNaGuards = new Set<string>();
for (const r of rows) if (r.kind === "pair_na" && pairNaReasonOk(r)) for (const g of r.guards) pairNaGuards.add(g);
for (const [g, type] of guardType) {
  const strictComponents = STRICT_PAIR_TYPES.filter((t) => type.includes(t));   // 复合类型（如「状态转换 + 拦截」）任一项命中即必须成对
  const isGate = type.includes(SECURITY_GATE);
  if (!strictComponents.length && !isGate) continue;                            // 与四类守卫无关的类型不计
  const hasV = rows.some((r) => r.kind === "violation" && r.guards.includes(g));
  const hasL = rows.some((r) => r.kind === "legal" && r.guards.includes(g));
  const naExcused = !strictComponents.length && isGate && pairNaGuards.has(g);   // 仅纯安全门 + 有原因的 pair_na 才豁免
  if (naExcused) continue;
  if (!hasV || !hasL) unpairedList.push(`${g}(${type}${!hasV ? ",缺violation" : ""}${!hasL ? ",缺legal" : ""})`);
}

// evidence_missing + result_mismatch
let evidence_missing = 0;
for (const r of rows) {
  const rec = rc[r.id];
  const files = rec?.evidence ?? [];
  const mdRefs = [...r.evidence.matchAll(/\((\/[^)]+)\)/g)].map((m) => m[1]);
  const resolveRef = (p: string) => (existsSync(p) ? p : existsSync(join(REPO, p.replace(/^\//, ""))) ? join(REPO, p.replace(/^\//, "")) : p);
  const missing = [...files.map((f) => join(REPO, f)), ...mdRefs].filter((p) => !existsSync(resolveRef(p)));
  if (!rec || missing.length) {
    evidence_missing++;
    if (VERBOSE) console.error(`  evidence_missing: ${r.id} rec=${!!rec} missing=${missing.slice(0, 3).join(",")}`);
  }
}
let result_mismatch = 0;
for (const r of rows) {
  const rec = rc[r.id];
  if (!rec) { result_mismatch++; if (VERBOSE) console.error(`  result_mismatch: ${r.id} 仅存在于用例表`); continue; }
  if (rec.result !== r.result) { result_mismatch++; if (VERBOSE) console.error(`  result_mismatch: ${r.id} md=${r.result} results.json=${rec.result}`); }
}
for (const id of Object.keys(rc)) if (!rows.some((r) => r.id === id)) { result_mismatch++; if (VERBOSE) console.error(`  result_mismatch: ${id} 仅存在于 results.json`); }

// blocked_no_reason：只看「预期」字段（原因字段），不看结果列
const noReason = rows.filter((r) => r.result === "BLOCKED" && !/(口径待老板确认|缺失能力)/.test(r.expect));
const blocked_no_reason = noReason.length;
if (VERBOSE) for (const r of noReason) console.error(`  blocked_no_reason: ${r.id} expect=${r.expect.slice(0, 80)}`);

const line = `cases=${cases} pass=${pass} fail=${fail} blocked=${blocked} legal_fail=${legal_fail} pair_na=${pair_na} uncovered=${uncoveredList.length} unpaired=${unpairedList.length} evidence_missing=${evidence_missing} blocked_no_reason=${blocked_no_reason} result_mismatch=${result_mismatch}`;
console.log(line);

if (VERBOSE) {
  console.error(`  flow=${FLOW.replace(REPO + "/", "")}  matrix=${MATRIX.replace(REPO + "/", "")}  results=${resultsPath.replace(REPO + "/", "")}`);
  console.error(`  write-paths(${writePaths.size}): ${[...writePaths].join(" , ")}`);
  console.error(`  uncovered: ${uncoveredList.join(" , ") || "(none)"}`);
  console.error(`  unpaired: ${unpairedList.join(" , ") || "(none)"}`);
}

const nonZero = [uncoveredList.length, unpairedList.length, evidence_missing, blocked_no_reason, result_mismatch].some((n) => n !== 0);
if (badPairNa.length) {
  console.error(`check-e2e-flow: FATAL: pair_na 用例未写明原因（原因字段须含「原因：」+ 正文）: ${badPairNa.map((r) => r.id).join(",")}`);
  process.exit(2);
}
if (STRICT && nonZero) process.exit(1);
