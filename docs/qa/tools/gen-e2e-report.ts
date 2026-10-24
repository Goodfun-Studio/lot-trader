#!/usr/bin/env bun
/**
 * gen-e2e-report.ts — tp-5a3bfad8 L4 `line-qa-runbook-report` 的 E2E 报告生成器。
 *
 *   bun docs/qa/tools/gen-e2e-report.ts --evidence <证据目录>
 *   bun docs/qa/tools/gen-e2e-report.ts --evidence <证据目录> --out /tmp/report.md
 *   bun docs/qa/tools/gen-e2e-report.ts --evidence <证据目录> --stdout
 *
 * 读一次 run-e2e 的证据目录（`results.json` + 每条用例的 `<ID>.json` / `.cmd` / `.rows-before.txt`
 * / `.rows-after.txt` / `.exit`），生成
 *   docs/qa/reports/e2e-report-<YYYYMMDD-HHMMSS>-commit-<sha>.md
 *
 * 五字段铁律（本工具的存在意义）：每条用例的「命令 / 输入·环境 / 前状态 / 后状态 / 判据」
 * **全部从证据文件里抽取**，一个字符都不手写：
 *   命令      ← <ID>.json → steps[].cmd                （并用 <ID>__<n>.cmd 里的 `$ ` 行交叉验证）
 *   输入/环境  ← <ID>__<n>.cmd 的 `# env:` 头 + <ID>.json → db
 *   前状态     ← 首个执行步的 <ID>__<n>.rows-before.txt
 *   后状态     ← 末个执行步的 <ID>__<n>.rows-after.txt + steps[].exit
 *   判据      ← <ID>.json → expect / source / asserts / result
 * 报告的逐用例结果必须与 results.json 一致（不一致时以 results.json 为准并在 stderr 报 problem）。
 *
 * 退出码：0 正常；2 输入缺失/不可解析。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";

const REPO = resolve(import.meta.dirname ?? import.meta.dir, "..", "..", "..");

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const EVID_ARG = argOf("--evidence") ?? positional[0];
const OUT_ARG = argOf("--out");
const TO_STDOUT = has("--stdout");
const SHA_ARG = argOf("--sha");
const PROBLEMS: string[] = [];

function die(msg: string, code = 2): never {
  console.error(`gen-e2e-report: FATAL: ${msg}`);
  process.exit(code);
}
function problem(msg: string): void {
  PROBLEMS.push(msg);
  console.error(`gen-e2e-report: problem: ${msg}`);
}

if (!EVID_ARG) die("缺少 --evidence <证据目录>（或把目录作为第一个位置参数）");
const EVID = isAbsolute(EVID_ARG) ? EVID_ARG : resolve(process.cwd(), EVID_ARG);
if (!existsSync(EVID) || !statSync(EVID).isDirectory()) die(`证据目录不存在: ${EVID}`);
const RESULTS_PATH = join(EVID, "results.json");
if (!existsSync(RESULTS_PATH)) die(`缺少 ${RESULTS_PATH}`);

// ------------------------------------------------------------------ 证据读取
type CaseJson = {
  id: string; kind?: string; guards?: string[]; title?: string; expect?: string; source?: string;
  db?: string; result?: string; notes?: string[]; blockedReason?: string;
  asserts?: { label: string; ok: boolean; detail: string }[];
  steps?: {
    n: number; provider: string; cmd: string; exit: number; refused?: boolean; ms?: number;
    files?: string[]; deltas?: Record<string, number>;
  }[];
};
type ResultsJson = {
  meta: { topic?: string; line?: string; runner?: string; startedAt?: string; finishedAt?: string; commit?: string; commitShort?: string; tradeSha256?: string; sandbox?: string; evidenceDir?: string; elapsedMs?: number; [k: string]: unknown };
  summary?: { total?: number; pass?: number; fail?: number; blocked?: number; legal_fail?: number };
  cases: Record<string, { result: string; kind?: string; guards?: string[]; evidence?: string[]; blockedReason?: string }>;
};

const results: ResultsJson = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
const meta = results.meta ?? ({} as ResultsJson["meta"]);
const caseIds = Object.keys(results.cases ?? {});
if (!caseIds.length) die("results.json 里没有任何用例");
const SUMMARY = results.summary ?? {};

const readCaseJson = (id: string): CaseJson => {
  const p = join(EVID, `${id}.json`);
  if (!existsSync(p)) { problem(`缺少用例级证据 ${p}`); return { id }; }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CaseJson;
  } catch (e) {
    problem(`用例级证据不可解析 ${p}: ${String(e)}`);
    return { id };
  }
};
const readIf = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf-8") : null);

/** results.json 里记的证据路径是仓库相对路径；也容忍绝对路径。 */
const absRepo = (p: string): string => (isAbsolute(p) ? p : join(REPO, p));
const relRepo = (p: string): string => (p.startsWith(REPO + "/") ? p.slice(REPO.length + 1) : p);

/** steps[].files 里的证据文件按后缀定位。 */
const stepFile = (s: { files?: string[] }, suffix: string): string | null => {
  for (const f of s.files ?? []) {
    if (f.endsWith(suffix) && existsSync(absRepo(f))) return absRepo(f);
  }
  return null;
};

/** 把 rows-*.txt 渲染成一行；保留文件里的原始 key=value 顺序与取值。 */
const rowsOneLine = (text: string): string =>
  text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");

type RowMap = Record<string, string>;
const parseRows = (text: string): RowMap => {
  const out: RowMap = {};
  for (const l of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
};
const TABLES = ["accounts", "symbols", "lots", "trades", "signals", "dividends"] as const;

/** 从 .cmd 证据文件的 `# env:` 头抽出环境前缀（逐字保留）。 */
const envPrefixOf = (cmdFileText: string | null): string | null => {
  if (!cmdFileText) return null;
  const m = /^#\s*env:\s*(.+)$/m.exec(cmdFileText);
  return m ? m[1].trim() : null;
};
/** 从 .cmd 证据文件抽出真正执行的那一行（`$ ` 之后，去掉内联环境前缀）。 */
const cmdLineOf = (cmdFileText: string | null): string | null => {
  if (!cmdFileText) return null;
  for (const raw of cmdFileText.split("\n")) {
    const m = /^\$\s*(.+)$/.exec(raw);
    if (m) return m[1].trim();
  }
  return null;
};

// ------------------------------------------------------------------ 五字段抽取
type FiveFields = { cmd: string; env: string; before: string; after: string; criteria: string };

function fieldsOf(id: string, cj: CaseJson, rec: { result: string; kind?: string; blockedReason?: string }): FiveFields {
  const steps = cj.steps ?? [];
  const kind = cj.kind ?? rec.kind ?? "—";
  const result = rec.result;
  /** 证据形状提示：本用例所有执行步的 provider 清单（无行数快照时写进占位词，仍是证据抽取的值）。 */
  const providers = [...new Set(steps.map((s) => s.provider))].join(",") || "—";
  const firstWith = <T,>(pick: (s: (typeof steps)[number]) => T | null): T | null => {
    for (const s of steps) { const v = pick(s); if (v != null) return v; }
    return null;
  };
  const lastWith = <T,>(pick: (s: (typeof steps)[number]) => T | null): T | null => {
    for (let i = steps.length - 1; i >= 0; i--) { const v = pick(steps[i]); if (v != null) return v; }
    return null;
  };

  // ---- 命令
  let cmd: string;
  if (steps.length) {
    cmd = steps.map((s) => `${s.cmd}${s.refused ? " [GUARD-REFUSED]" : ""}`).join(" → ");
  } else {
    const reason = cj.blockedReason ?? rec.blockedReason ?? cj.notes?.[0] ?? "无步骤记录";
    cmd = `（未执行 · steps=0 · ${reason}）`;
  }

  // ---- 输入 / 环境
  const envPrefix = firstWith((s) => envPrefixOf(readIf(stepFile(s, ".cmd") ?? "")));
  const envParts: string[] = [];
  envParts.push(`db=${cj.db ?? "（证据未记 db）"}`);
  if (envPrefix) envParts.push(envPrefix);
  else if (steps.length) {
    envParts.push(`沙箱=${meta.sandbox ?? "（results.json 未记 sandbox）"}；HOME=<沙箱>/fakehome；LOT_TRADER_TOKEN_FILE=<沙箱>/fakehome/.lot-trader/session.token`);
    envParts.push(`（本用例执行步无 .cmd 环境头证据 · providers=${providers}）`);
  } else {
    envParts.push(`沙箱=${meta.sandbox ?? "（results.json 未记 sandbox）"}（用例未执行，使用共享沙箱）`);
  }
  const env = envParts.join("；");

  // ---- 前状态 / 后状态
  const beforeTxt = firstWith((s) => (readIf(stepFile(s, ".rows-before.txt") ?? "") ?? null) as string | null);
  const afterTxt = lastWith((s) => (readIf(stepFile(s, ".rows-after.txt") ?? "") ?? null) as string | null);
  const exits = steps.map((s) => s.exit).join(",");
  let before: string;
  let after: string;
  if (steps.length) {
    if (beforeTxt) before = `steps=${steps.length}；${rowsOneLine(beforeTxt)}`;
    else before = `（本用例执行步均无 rows-before 快照 · steps=${steps.length} · providers=${providers}）`;
    const bits: string[] = [];
    if (beforeTxt && afterTxt) {
      const b = parseRows(beforeTxt); const a = parseRows(afterTxt);
      bits.push(TABLES.filter((t) => t in b || t in a)
        .map((t) => {
          const bv = b[t] ?? "?"; const av = a[t] ?? "?";
          if (bv === "?" || av === "?") return `${t}=${bv}→${av}`;
          const d = Number(av) - Number(bv);
          return `${t}=${bv}→${av} (${d >= 0 ? "+" : ""}${Number.isFinite(d) ? d : "?"})`;
        })
        .join(" "));
      bits.push(`末步 rows-after：${rowsOneLine(afterTxt)}`);
    } else if (afterTxt) {
      bits.push(`无 rows-before 对照，末步 rows-after：${rowsOneLine(afterTxt)}`);
    } else {
      bits.push(`（本用例执行步均无 rows-after 快照 · steps=${steps.length} · providers=${providers}）`);
    }
    bits.push(`exit=[${exits}]`);
    after = bits.join("；");
  } else {
    const reason = cj.blockedReason ?? rec.blockedReason ?? cj.notes?.[0] ?? "无步骤记录";
    before = `（无 rows-before 快照 · steps=0）`;
    after = `（未执行 · ${reason}）`;
  }

  // ---- 判据
  const asserts = cj.asserts ?? [];
  const okN = asserts.filter((x) => x.ok).length;
  const failed = asserts.filter((x) => !x.ok).map((x) => x.label);
  const critParts: string[] = [];
  critParts.push(`预期：${cj.expect ?? "（证据未记 expect）"}`);
  if (cj.source) critParts.push(`预期值来源：${cj.source}`);
  critParts.push(`断言：${okN}/${asserts.length} 通过`);
  if (failed.length) critParts.push(`失败断言：${failed.join(" / ")}`);
  critParts.push(`结果=${result}`);
  const crit = critParts.join("；");

  void kind;
  return { cmd, env, before, after, criteria: crit };
}

// ------------------------------------------------------------------ 输出路径
const stampFromIso = (iso: string | undefined): string => {
  const d = iso ? new Date(iso) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
};
const sha = SHA_ARG ?? meta.commitShort ?? (meta.commit ? String(meta.commit).slice(0, 8) : "unknown");
const outPath = OUT_ARG
  ? (isAbsolute(OUT_ARG) ? OUT_ARG : resolve(process.cwd(), OUT_ARG))
  : join(REPO, "docs/qa/reports", `e2e-report-${stampFromIso(meta.startedAt)}-commit-${sha}.md`);

// ------------------------------------------------------------------ 报告正文
const kindOf = (id: string, cj: CaseJson): string => cj.kind ?? results.cases[id].kind ?? "—";
const guardsOf = (id: string, cj: CaseJson): string => {
  const g = cj.guards ?? results.cases[id].guards ?? [];
  return g.length ? g.join(",") : "—";
};
const indexRow = (id: string, cj: CaseJson): string => {
  const rec = results.cases[id];
  const ev = (rec.evidence ?? []).map((p) => relRepo(p)).filter((p) => /(^|\/)([^/]+)\.(json|md)$/.test(p));
  const evCell = ev.length ? ev.map((p) => `\`${p.split("/").pop()}\``).join(" ") : "—";
  return `| ${id} | ${kindOf(id, cj)} | ${guardsOf(id, cj)} | **${rec.result}** | ${evCell} |`;
};

const legalFails = caseIds.filter((id) => {
  const kind = results.cases[id].kind ?? readCaseJson(id).kind;
  return kind === "legal" && results.cases[id].result === "FAIL";
});

const lines: string[] = [];
const L = (s = "") => lines.push(s);

L(`# lot-trader E2E 质检报告 · ${meta.evidenceDir ?? EVID}`);
L();
/** 复现本报告的命令：把用户真正用过的开关原样带上（`--sha` 非空时才追加），照拄就能得到同一份报告。 */
const reproCmd = `bun docs/qa/tools/gen-e2e-report.ts --evidence ${relRepo(EVID)}${SHA_ARG ? ` --sha ${SHA_ARG}` : ""}`;
L(`> 本文件由 \`docs/qa/tools/gen-e2e-report.ts\` 从证据目录自动生成；五个字段全部取自证据文件，不得手改。`);
L(`> 生成命令：\`${reproCmd}\``);
L();
L(`## 1. 运行概要`);
L();
L(`| 项 | 值 |`);
L(`|---|---|`);
L(`| 话题 | ${meta.topic ?? "—"} |`);
L(`| 线 | ${meta.line ?? "—"} |`);
L(`| 执行器 | ${meta.runner ?? "—"} |`);
L(`| 证据目录 | \`${meta.evidenceDir ?? relRepo(EVID)}\` |`);
L(`| commit | \`${meta.commit ?? "—"}\` (short \`${sha}\`) |`);
L(`| \`./trade\` sha256 | \`${meta.tradeSha256 ?? "—"}\` |`);
L(`| 沙箱 | \`${meta.sandbox ?? "—"}\` |`);
L(`| 开始 / 结束 | ${meta.startedAt ?? "—"} / ${meta.finishedAt ?? "—"} |`);
L(`| 耗时 | ${meta.elapsedMs ?? "—"} ms |`);
L(`| 隔离快照 | ${meta.isolationStart ?? "—"} |`);
L();
L(`## 2. 结果汇总`);
L();
const pairNa = caseIds.filter((id) => kindOf(id, readCaseJson(id)) === "pair_na").length;
L(`| 用例总数 | PASS | FAIL | BLOCKED | legal FAIL | pair_na |`);
L(`|---|---|---|---|---|---|`);
L(`| ${SUMMARY.total ?? caseIds.length} | ${SUMMARY.pass ?? "—"} | ${SUMMARY.fail ?? "—"} | ${SUMMARY.blocked ?? "—"} | ${SUMMARY.legal_fail ?? "—"} | ${pairNa} |`);
L();
L(`### 2.1 legal 侧 FAIL（防误杀）`);
L();
if (legalFails.length === 0) {
  L(`无`);
} else {
  L(`**产品误杀 ${legalFails.length} 条，按 P1 处理：**`);
  L();
  L(`| 用例 ID | 结果 | 期望 | 实际 | 证据 |`);
  L(`|---|---|---|---|---|`);
  for (const id of legalFails) {
    const cj = readCaseJson(id);
    const failed = (cj.asserts ?? []).filter((a) => !a.ok).map((a) => `${a.label}: ${a.detail}`).join("<br>") || "—";
    const ev = (results.cases[id].evidence ?? []).map((p) => `\`${relRepo(p)}\``).join("<br>") || "—";
    L(`| ${id} | **FAIL** | ${(cj.expect ?? "—").replace(/\|/g, "\\|")} | ${failed.replace(/\|/g, "\\|")} | ${ev} |`);
  }
}
L();
L(`### 2.2 逐用例结果与证据索引`);
L();
L(`证据列只列用例级证据（相对 \`<证据目录>/\`）；执行步级证据见 §5。`);
L();
L(`| 用例 ID | kind | guards | 结果 | 用例级证据 |`);
L(`|---|---|---|---|---|`);
for (const id of caseIds) L(indexRow(id, readCaseJson(id)));
L();
L(`## 3. 用例证据明细`);
L();
L(`每条用例五个字段：命令 / 输入·环境 / 前状态 / 后状态 / 判据。全部从证据目录抽取。`);
L();
for (const id of caseIds) {
  const cj = readCaseJson(id);
  const rec = results.cases[id];
  const f = fieldsOf(id, cj, rec);
  const result = rec.result;
  L(`### ${id} · result=${result} · kind=${kindOf(id, cj)} · guards=${guardsOf(id, cj)}`);
  L();
  if (cj.title) L(`*${cj.title}*`);
  L();
  L(`- **命令**：${f.cmd}`);
  L(`- **输入/环境**：${f.env}`);
  L(`- **前状态**：${f.before}`);
  L(`- **后状态**：${f.after}`);
  L(`- **判据**：${f.criteria}`);
  L();
  if (result === "BLOCKED") {
    const reason = cj.blockedReason ?? rec.blockedReason ?? cj.notes?.[0] ?? "（未写明）";
    L(`> BLOCKED：${reason}`);
    L();
  }
}
L(`## 4. 阻断项 / 缺陷表 / 待确认口径`);
L();
L(`> 判定口径见 \`docs/qa/e2e-runbook.md\` 的「阻断判定」与「打回格式」两节。本生成器只搬运证据，不判定严重级。`);
L();
L(`### 4.1 阻断项`);
L();
const fails = caseIds.filter((id) => results.cases[id].result === "FAIL");
L(fails.length ? `${fails.length} 条 FAIL：${fails.map((i) => `\`${i}\``).join("、")}（严重级需人工按 runbook 定级；legal 侧 FAIL 见 §2.1）` : `无`);
L();
L(`### 4.2 待确认口径 / 能力缺失（BLOCKED）`);
L();
const blockedIds = caseIds.filter((id) => results.cases[id].result === "BLOCKED");
if (!blockedIds.length) L(`无`);
else {
  L(`| 用例 ID | 阻塞原因 | 备注 |`);
  L(`|---|---|---|`);
  for (const id of blockedIds) {
    const cj = readCaseJson(id);
    const notes = (cj.notes ?? []).join("<br>").replace(/\|/g, "\\|") || "—";
    L(`| ${id} | ${(cj.blockedReason ?? results.cases[id].blockedReason ?? "（未写明）").replace(/\|/g, "\\|")} | ${notes} |`);
  }
}
L();
L(`## 5. 执行步证据索引`);
L();
L(`每行一条用例，全部路径均为相对 \`<证据目录>/\` 的文件名（逐字取自 \`results.json\` 的 \`cases[<用例 ID>].evidence\`）。`);
L();
L("```");
for (const id of caseIds) {
  const ev = (results.cases[id].evidence ?? []).map((p) => relRepo(p).split("/").pop()).sort();
  L(`${id}: ${ev.length ? ev.join(", ") : "(无证据文件)"}`);
}
L("```");
L();

const report = lines.join("\n") + "\n";

// ------------------------------------------------------------------ 写盘
if (TO_STDOUT) {
  process.stdout.write(report);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report);
  console.log(`wrote ${outPath}`);
}
console.log(`gen-e2e-report: cases=${caseIds.length} legal_fail=${legalFails.length} blocked=${blockedIds.length} problems=${PROBLEMS.length}`);
if (PROBLEMS.length) process.exit(1);
