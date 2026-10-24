#!/usr/bin/env bun
/**
 * check-op-matrix.ts — cross-check `docs/qa/user-operation-matrix.md` against the live `./trade --help` tree.
 * Path: docs/qa/tools/check-op-matrix.ts   (QA tooling lives under docs/qa/tools/, never under scripts/)
 *
 * Run from the repository root:
 *     bun docs/qa/tools/check-op-matrix.ts
 *     bun docs/qa/tools/check-op-matrix.ts --inject-canary
 *     bun docs/qa/tools/check-op-matrix.ts --strict        # exit 1 when any counter is non-zero
 *
 * Output is exactly one line:
 *     commands=<N> flags=<N> missing=<N> extra=<N> evidence_missing=<N> ghost_db=<N>
 *
 * Definitions
 *   commands          declared command paths discovered from the --help tree (see "command discovery")
 *   flags             total number of (help-owner group, flag) declarations the help tree carries
 *   missing           declared in help but not written in the matrix   (target 0)
 *   extra             written in the matrix but not declared in help   (target 0)
 *   evidence_missing  matrix rows whose evidence path does not exist on disk (target 0)
 *   ghost_db          how many of the non-existent /tmp --db targets got created      (target 0)
 *
 * Exit code: 0 by default (this is a reporter). With --strict it exits 1 when a counter is non-zero.
 * Set QA_MATRIX_VERBOSE=1 for a per-item breakdown on stdout/stderr.
 *
 * Command discovery — a documented superset of the `{…}` recursion the task mandates
 *   1. every `{a,b,c}` brace group on a `usage:` line, recursed per command path
 *   2. optional single-word subcommands written as `[list]` right after the command path
 *      (`trade position [list]` really does dispatch `trade position list`)
 *   3. aliases written as `(alias: trade radar)` — the alias really does dispatch
 *   Steps 2 and 3 only ADD declared commands, so they cannot hide a `missing` hit.
 *
 * Flag attribution (why it is grouped by "help owner")
 *   Some leaves ship no dedicated help and fall back to their parent's text
 *   (`trade account add --help` prints the `trade account` help). Comparing strictly per path would
 *   force the matrix to repeat the parent's flags on every leaf. Instead each command path maps to a
 *   help owner: the deepest ancestor whose help text differs from its own parent's help text.
 *   Flags are compared per owner group, so a group may declare a flag on any of its rows.
 *   Root-level flags (`--db`, `--help`) are inherited by every group on both sides.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname ?? import.meta.dir, "..", "..", "..");
// QA_MATRIX_PATH lets a reviewer point the checker at a COPY of the matrix (used by the mutation
// test); everything else stays anchored to the repository root, so the evidence paths still resolve.
const MATRIX = process.env.QA_MATRIX_PATH
  ? resolve(process.env.QA_MATRIX_PATH)
  : resolve(REPO, "docs/qa/user-operation-matrix.md");
const TRADE = resolve(REPO, "trade");
const CANARY = "--qa-canary-flag";
const CANARY_TARGET = "scan";   // command key as discovered from the help tree (no leading "trade")
const injectCanary = process.argv.includes("--inject-canary");
const strict = process.argv.includes("--strict");

/** A --db target that must stay non-existent for the whole run: proves --help never bootstraps a ledger. */
const GHOST_DB = `/tmp/qa-op-matrix-check-ghost-${process.pid}.db`;

const problems: string[] = [];
const die = (msg: string): never => { console.error(`check-op-matrix: FATAL: ${msg}`); process.exit(2); };

/** Every `trade …` invocation carries an explicit --db pointing at a non-existent /tmp path. */
function runHelp(pathParts: string[]): { text: string; code: number } {
  const r = spawnSync(TRADE, [...pathParts, "--help", "--db", GHOST_DB], {
    cwd: REPO,
    encoding: "utf-8",
    env: { ...process.env, LOT_TRADER_DB: GHOST_DB, TRADE_DB_PATH: GHOST_DB },
    timeout: 30_000,
  });
  if (r.error) die(`failed to spawn ${TRADE}: ${r.error.message}`);
  return { text: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? -1 };
}

// ------------------------------------------------------------------ 1. help tree
type Node = { path: string[]; text: string };
const tree = new Map<string, Node>();
const kOf = (p: string[]) => p.join(" ");
let helpInvocations = 0;

function visit(path: string[]): void {
  const k = kOf(path);
  if (tree.has(k)) return;
  const res = runHelp(path);
  helpInvocations++;
  if (res.code !== 0) problems.push(`'trade ${k}' --help exited ${res.code}`);
  tree.set(k, { path, text: res.text });

  const usageLine = res.text.split("\n").find((l) => /^usage:/i.test(l.trim())) ?? "";
  const after = path.length === 0 ? usageLine : usageLine.slice(usageLine.indexOf(k) + k.length);

  for (const m of after.matchAll(/\{([^{}]*)\}/g))
    for (const child of m[1].split(",").map((s) => s.trim()).filter(Boolean)) visit([...path, child]);
  for (const m of after.matchAll(/\[([a-z][a-z0-9-]{1,20})\]/g))
    if (m[1] !== "h") visit([...path, m[1]]);
  for (const m of res.text.matchAll(/\(alias:\s*trade\s+([a-z0-9-]+)\)/gi)) visit([m[1]]);
}
visit([]);
const declaredCommands = [...tree.keys()];

// ------------------------------------------------------------------ 2. flags + help owners
const FLAG_RE = /(?<![\w-])--[a-zA-Z][a-zA-Z0-9-]*/g;
const flagsIn = (t: string): Set<string> => new Set(t.match(FLAG_RE) ?? []);

const root = tree.get("")!;
const rootFlags = flagsIn(root.text);

const ownerOf = new Map<string, string>();
for (const k of declaredCommands) {
  const path = tree.get(k)!.path;
  if (path.length === 0) { ownerOf.set(k, ""); continue; }
  const parent = kOf(path.slice(0, -1));
  const shared = tree.has(parent) && tree.get(parent)!.text === tree.get(k)!.text;
  ownerOf.set(k, shared ? ownerOf.get(parent)! : k);
}

const helpOwners = new Map<string, Set<string>>();
for (const k of declaredCommands) {
  const owner = ownerOf.get(k)!;
  const ownerText = tree.get(owner)?.text ?? tree.get(k)!.text;
  const bag = helpOwners.get(owner) ?? new Set<string>();
  for (const f of flagsIn(ownerText)) bag.add(f);
  for (const f of rootFlags) bag.add(f);
  helpOwners.set(owner, bag);
}
helpOwners.delete("");

let flagsTotal = [...helpOwners.values()].reduce((n, s) => n + s.size, 0);

if (injectCanary) {
  const owner = ownerOf.get(CANARY_TARGET);
  if (!owner) die(`canary target '${CANARY_TARGET}' not found in the help tree`);
  if (helpOwners.get(owner)!.has(CANARY)) die(`canary flag already present on '${owner}'`);
  helpOwners.get(owner)!.add(CANARY);   // pretend the help advertises one extra flag
  flagsTotal++;
}

// ------------------------------------------------------------------ 3. matrix parsing
if (!existsSync(MATRIX)) die(`matrix not found: ${MATRIX}`);
const lines = readFileSync(MATRIX, "utf-8").split("\n");
const EVIDENCE_ROOT_RE = /^\s*>\s*证据根目录\s*[:：]\s*`([^`]+)`/;

let evidenceRoot = "";
let matrixRows = 0;
const matrixOwners = new Map<string, Set<string>>();  // help owner -> flags declared by its rows
const matrixCommands = new Set<string>();
const declaredEvidence: string[] = [];
const otherEvidence: string[] = [];   // evidence column of the guard table + 证据： lines of the defect sections
const cell = (s: string) => s.replace(/`/g, "").replace(/\*\*/g, "").trim();

/** Split a markdown table row on UNESCAPED pipes; `\|` stays inside its cell as a literal bar. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let esc = false;
  for (const ch of line) {
    if (esc) { cur += ch === "|" ? "|" : "\\" + ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "|") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// Table schemas are read from each operation table's HEADER row once, then applied to its data rows.
type Schema = { ncols: number; idIdx: number; cmdIdx: number; flagIdx: number; evIdx: number };
let schema: Schema | null = null;

const isSep = (l: string) => {
  if (!l.trim().startsWith("|")) return false;
  const b = splitRow(l).slice(1, -1);
  return b.length > 0 && b.every((c) => /^:?-{2,}:?$/.test(c));
};

for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  const er = line.match(EVIDENCE_ROOT_RE);
  if (er) { evidenceRoot = er[1].trim(); schema = null; continue; }
  if (!line.trim().startsWith("|")) { schema = null; continue; }
  const body = splitRow(line).slice(1, -1);
  if (body.length < 4) continue;
  if (body.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // separator row
  // any header row (the next line is a separator) that is NOT an operation table closes the current one
  if (isSep(lines[li + 1] ?? "")) {
    const hasId = body.some((c) => /OP-ID/i.test(c));
    const hasCmd = body.some((c) => /命令路径|command/i.test(c));
    if (!(hasId && hasCmd)) { schema = null; continue; }
  }

  const headId = body.findIndex((c) => /OP-ID/i.test(c));
  const headCmd = body.findIndex((c) => /命令路径|command/i.test(c));
  if (headId >= 0 && headCmd >= 0) {                        // header row -> (re)define the schema
    schema = {
      ncols: body.length, idIdx: headId, cmdIdx: headCmd,
      flagIdx: body.findIndex((c) => /^flags/i.test(c.replace(/`/g, ""))),
      evIdx: body.findIndex((c) => /证据/.test(c)),
    };
    continue;
  }
  // any OTHER table header (e.g. the BLOCKED list, which also starts with an OP-ID column)
  // closes the current operation table so its rows can never be mis-parsed with a stale schema
  if (!schema) continue;                                    // not inside an operation table
  if (body.length < schema.ncols) continue;
  if (!/^[A-Z][A-Za-z0-9_-]*$/.test(cell(body[schema.idIdx]))) continue;   // not an OP-ID shaped cell
  matrixRows++;

  const cmdPath = cell(body[schema.cmdIdx]).replace(/^trade\s*/, "").split(/\s+/).filter(Boolean).join(" ");
  if (!ownerOf.has(cmdPath)) {
    problems.push(`row '${cell(body[schema.idIdx])}' declares unknown command path 'trade ${cmdPath}'`);
    continue;
  }
  const owner = ownerOf.get(cmdPath)!;
  matrixCommands.add(owner);
  const bag = matrixOwners.get(owner) ?? new Set<string>();
  if (schema.flagIdx >= 0) for (const f of body[schema.flagIdx].match(FLAG_RE) ?? []) bag.add(f);
  matrixOwners.set(owner, bag);

  if (schema.evIdx >= 0)
    for (const m of body[schema.evIdx].matchAll(/`([^`]+)`/g)) {
      const p = m[1].trim();
      // no suffix filter: every path written in the evidence column must exist on disk
      if (p && !p.includes("|")) declaredEvidence.push(p);
    }
}

// root globals are inherited by every group
for (const bag of matrixOwners.values()) for (const f of rootFlags) bag.add(f);

// --- evidence columns of NON-operation tables (guard table, defect tables, draft-diff table,
// --- V-xx observation table). No suffix filter: every backticked token in the column is checked.
const coverage: Record<string, Set<string>> = { op_table: new Set(declaredEvidence), guard_table: new Set(), defect: new Set(), draft_diff: new Set(), observations: new Set() };
{
  let header: string[] | null = null;
  let category = "";
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim().startsWith("|")) {
      const pm = line.match(/^\s*证据[:：](.*)$/);
      if (pm) for (const m of pm[1].matchAll(/`([^`]+)`/g)) { const t = m[1].trim(); if (t) { otherEvidence.push(t); coverage.defect.add(t); } }
      header = null; category = ""; continue;
    }
    const body = splitRow(line).slice(1, -1);
    if (body.length < 2) continue;
    if (body.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (isSep(lines[li + 1] ?? "")) {
      header = body;
      const first = (body[0] ?? "").replace(/`/g, "").trim();
      const joined = body.join(" ");
      category = /G-ID/.test(first) ? "guard_table"
        : /草案/.test(joined) ? "draft_diff"
        : /^观测点$/.test(first) ? "defect"
        : /^#$/.test(first) ? "observations"
        : /OP-ID/.test(joined) ? "op_table" : "";
      continue;
    }
    if (!header || !category) continue;
    let col = -1;
    header.forEach((c, i) => { if (/^证据$/.test(c.trim().replace(/`/g, ""))) col = i; });
    if (col < 0 || col >= body.length) continue;
    for (const m of body[col].matchAll(/`([^`]+)`/g))
      for (const t of m[1].trim().split(/[、,，]/).map((x) => x.trim()).filter(Boolean)) {
        if (/\s/.test(t)) continue;                       // a real path never contains a space
        if (category === "op_table") continue;             // already counted by the schema pass
        coverage[category].add(t); otherEvidence.push(t);
      }
  }
}

// ------------------------------------------------------------------ 4. compare
const missing: string[] = [];
const extra: string[] = [];
for (const owner of new Set([...helpOwners.keys(), ...matrixOwners.keys()])) {
  if (owner === "") continue;   // the root command has no owner group of its own
  const h = helpOwners.get(owner) ?? new Set<string>();
  const m = matrixOwners.get(owner) ?? new Set<string>();
  if (!matrixCommands.has(owner)) { for (const f of h) missing.push(`${owner} ${f}`); continue; }
  for (const f of h) if (!m.has(f)) missing.push(`${owner} ${f}`);
  for (const f of m) if (!h.has(f)) extra.push(`${owner} ${f}`);
}

const resolveEvidence = (p: string) => {
  for (const cand of [resolve(REPO, evidenceRoot || ".", p), resolve(REPO, p), resolve(REPO, evidenceRoot || ".", "..", p)]) {
    if (existsSync(cand)) return true;
  }
  return false;
};
const evidenceMissing = [...declaredEvidence, ...otherEvidence].filter((p) => !resolveEvidence(p));
const evidenceChecked = declaredEvidence.length + otherEvidence.length;

// ------------------------------------------------------------------ 5. ghost_db
const ghostArtifacts = [GHOST_DB, `${GHOST_DB}-wal`, `${GHOST_DB}-shm`].filter((p) => existsSync(p));
const ghostDb = ghostArtifacts.length;
for (const p of ghostArtifacts) { try { rmSync(p, { force: true }); } catch { /* keep the count */ } }

// ------------------------------------------------------------------ 6. report
console.log(
  `commands=${declaredCommands.length} flags=${flagsTotal} ` +
  `missing=${missing.length} extra=${extra.length} ` +
  `evidence_missing=${evidenceMissing.length} ghost_db=${ghostDb}`
);

if (process.env.QA_MATRIX_VERBOSE === "1") {
  const uniq = (k: string) => coverage[k].size;
  const allUnique = new Set<string>([...coverage.op_table, ...coverage.guard_table, ...coverage.defect, ...coverage.draft_diff, ...coverage.observations]);
  console.log(`help invocations: ${helpInvocations} | matrix rows: ${matrixRows} | evidence paths checked: ${evidenceChecked}`);
  console.log(`coverage: op_table=${uniq("op_table")} guard_table=${uniq("guard_table")} defect=${uniq("defect")} draft_diff=${uniq("draft_diff")} observations=${uniq("observations")} unique_total=${allUnique.size}`);
  console.log(`missing: ${missing.join(", ") || "(none)"}`);
  console.log(`extra: ${extra.join(", ") || "(none)"}`);
  console.log(`evidence_missing: ${evidenceMissing.join(", ") || "(none)"}`);
  console.log(`problems: ${problems.join("; ") || "(none)"}`);
}
for (const p of problems) console.error(`check-op-matrix: ${p}`);

const bad = missing.length + extra.length + evidenceMissing.length + ghostDb;
process.exit(strict && bad > 0 ? 1 : 0);
