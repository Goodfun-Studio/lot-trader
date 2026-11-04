#!/usr/bin/env bun
/**
 * Command line interface for Lot Trader (Executable: trade).
 */
import { AppDatabase, DEFAULT_DB_PATH } from "./db.ts";
import { TraderEngine } from "./engine.ts";
import { computePhysicsRadar, PhysicsRadarResult } from "./physics.ts";
import { normalizeSymbol } from "./quotes.ts";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  readSessionTokenFile,
  resolveSessionTokenFile,
  startServe,
} from "./serve.ts";
import { parseArgs } from "util";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";

const DASHBOARD_DEFAULT_OUT = "lot-trader-global-dashboard.html";

/**
 * Default probe base baked into the generated dashboard page. Kept in lockstep with
 * `DEFAULT_SERVE_HOST`/`DEFAULT_SERVE_PORT` so "no --api-base" means "do not change anything".
 */
const DASHBOARD_DEFAULT_API_BASE = `http://${DEFAULT_SERVE_HOST}:${DEFAULT_SERVE_PORT}`;

const HELP_FLAGS = new Set(["-h", "--help"]);

/** True when `-h` / `--help` appears anywhere in the token list. */
function hasHelpFlag(args: string[]): boolean {
  return args.some((token) => HELP_FLAGS.has(token));
}

/** Whether a single token is a help request (`undefined` is never a help request). */
function isHelpToken(token: string | undefined): boolean {
  return token !== undefined && HELP_FLAGS.has(token);
}

/**
 * Ledger path precedence, applied identically by every subcommand:
 *
 *   explicit `--db <path>`  >  $LOT_TRADER_DB  >  $TRADE_DB_PATH  >  ~/.trade/trade.db
 *
 * A command-line `--db` always beats the environment, so `trade scan --db /tmp/sandbox.db`
 * can never be silently redirected to the default ledger.
 */
export function resolveCliDbPath(explicitDb?: string): string {
  const explicit = (explicitDb ?? "").trim();
  return explicit || process.env.LOT_TRADER_DB || process.env.TRADE_DB_PATH || DEFAULT_DB_PATH;
}

/**
 * Pull a GLOBAL `--name <value>` / `--name=<value>` option out of the raw argv, wherever it
 * appears. Every occurrence (and its value) is removed from the returned token list so a
 * downstream subcommand parser can never mistake the global option for a positional argument.
 * The first occurrence wins.
 */
export function extractGlobalOption(args: string[], name: string): { value?: string; rest: string[] } {
  const long = `--${name}`;
  const eqPrefix = `--${name}=`;
  const rest: string[] = [];
  let value: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === long) {
      const next = args[i + 1];
      if (next !== undefined) {
        if (value === undefined) value = next;
        i += 1; // consume the value: drop both tokens from the subcommand argv
      }
      continue;
    }
    if (token.startsWith(eqPrefix)) {
      if (value === undefined) value = token.slice(eqPrefix.length);
      continue;
    }
    rest.push(token);
  }

  return { value, rest };
}

// ==== DECLARED FLAG CONTRACT ==============================================================
// Single source of truth for the flags every command path declares. Each entry is handed to
// `parseArgs` verbatim (so the parser can never accept anything this table does not declare)
// AND to `findUndeclaredFlag`, which rejects undeclared flags in `main()` BEFORE the ledger is
// ever opened. `parseArgs({strict:false})` alone silently swallowed e.g. `dividend add
// --ex-date 2026-01-01`, so the spelling mistake was dropped on the floor while the command
// still exited 0.
type CliFlagSpec =
  | { type: "string"; short?: string; default?: string }
  | { type: "boolean"; short?: string; default?: boolean };

/**
 * The `dashboard` block lives here too: the subcommand takes its declared flags from this table
 * like every other path, so an undeclared flag (`trade dashboard --zzz-bogus`, which used to be
 * swallowed silently and still exit 0) is now rejected before the ledger is ever opened.
 */
export const CLI_FLAG_SPECS: Record<string, Record<string, CliFlagSpec>> = {
  dashboard: {
    out: { type: "string", short: "o" },
    open: { type: "boolean", default: false },
    template: { type: "string", short: "t" },
    db: { type: "string" },
    token: { type: "string" },
    "token-file": { type: "string" },
    "scripts-dir": { type: "string" },
    "api-base": { type: "string" },
    json: { type: "boolean", default: false },
  },
  serve: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    db: { type: "string" },
    token: { type: "string" },
    "token-file": { type: "string" },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
  "account list": {
    all: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  "account add": {
    id: { type: "string" },
    name: { type: "string" },
    broker: { type: "string" },
    currency: { type: "string" },
    json: { type: "boolean", default: false },
  },
  "lot buy": {
    symbol: { type: "string" },
    price: { type: "string" },
    qty: { type: "string" },
    account: { type: "string" },
    reason: { type: "string" },
    fee: { type: "string" },
    time: { type: "string" },
    parent: { type: "string" },
    "skip-risk": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  "lot add": {
    "parent-lot-id": { type: "string" },
    parent: { type: "string" },
    price: { type: "string" },
    amount: { type: "string" },
    qty: { type: "string" },
    account: { type: "string" },
    reason: { type: "string" },
    fee: { type: "string" },
    time: { type: "string" },
    "skip-risk": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  "lot list": {
    status: { type: "string", default: "ACTIVE" },
    symbol: { type: "string" },
    account: { type: "string" },
    json: { type: "boolean", default: false },
  },
  "lot close": {
    "lot-id": { type: "string" },
    price: { type: "string" },
    qty: { type: "string" },
    account: { type: "string" },
    reason: { type: "string" },
    "substitute-core": { type: "boolean", default: false },
    fee: { type: "string" },
    time: { type: "string" },
    json: { type: "boolean", default: false },
  },
  "lot edit": {
    "lot-id": { type: "string" },
    reason: { type: "string" },
    "buy-reason": { type: "string" },
    "close-reason": { type: "string" },
    append: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  position: {
    symbol: { type: "string" },
    cap: { type: "string" },
    "full-position-cap": { type: "string" },
    account: { type: "string" },
    json: { type: "boolean", default: false },
  },
  scan: {
    thresholds: { type: "string" },
    account: { type: "string" },
    json: { type: "boolean", default: false },
  },
  stats: {
    days: { type: "string" },
    symbol: { type: "string" },
    account: { type: "string" },
    json: { type: "boolean", default: false },
  },
  physics: {
    symbol: { type: "string" },
    json: { type: "boolean", default: false },
  },
  "dividend add": {
    symbol: { type: "string" },
    amount: { type: "string" },
    date: { type: "string" },
    account: { type: "string" },
    shares: { type: "string" },
    "per-share": { type: "string" },
    notes: { type: "string" },
    json: { type: "boolean", default: false },
  },
  "dividend list": {
    symbol: { type: "string" },
    account: { type: "string" },
    json: { type: "boolean", default: false },
  },
};

/** The threshold keys `SignalScanner` actually reads (see src/scanner.ts). */
export const SIGNAL_THRESHOLD_KEYS = [
  "take_profit_min",
  "trailing_activate",
  "trailing_pullback",
  "dip_1",
  "deep_value",
] as const;

/** `trade radar` is an alias of `trade physics`. */
export function resolveCommandPath(argv: string[]): string | undefined {
  const command = argv[0];
  if (!command) return undefined;
  const top = command === "radar" ? "physics" : command;
  if (top === "lot" || top === "account" || top === "dividend") {
    return argv[1] ? `${top} ${argv[1]}` : top;
  }
  return top;
}

/** Options object for `parseArgs`, taken from the one declared contract table. */
export function flagsFor(commandPath: string): Record<string, CliFlagSpec> {
  return CLI_FLAG_SPECS[commandPath] ?? {};
}

/**
 * Return the first token that is not a declared flag for `commandPath`, or `null` when every
 * `-`-prefixed token is declared. Positionals (and the value token of a declared string flag)
 * are not flags and are left alone.
 */
export function findUndeclaredFlag(commandPath: string, args: string[]): string | null {
  const spec = CLI_FLAG_SPECS[commandPath];
  if (!spec) return null;

  const longs = new Map<string, CliFlagSpec>();
  const shorts = new Map<string, CliFlagSpec>();
  for (const [name, def] of Object.entries(spec)) {
    longs.set(name, def);
    if (def.short) shorts.set(def.short, def);
  }

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") break; // everything after `--` is positional
    if (token === "-" || !token.startsWith("-")) continue; // positional

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const def = longs.get(name);
      if (!def) return token;
      if (def.type === "string" && eq === -1) {
        if (args[i + 1] !== undefined) i += 1; // consume the flag's value
      }
      continue;
    }

    // Short option, possibly clustered (`-p 8080`, `-p=8080`, `-p8080`).
    let j = 1;
    while (j < token.length) {
      const def = shorts.get(token[j]);
      if (!def) return token;
      if (def.type === "string") {
        if (j === token.length - 1 && args[i + 1] !== undefined) i += 1;
        break;
      }
      j += 1;
    }
  }

  return null;
}

/** Print a contract violation and exit non-zero without touching the ledger. */
function reportCliError(isJson: boolean, message: string): never {
  if (isJson) {
    console.error(JSON.stringify({ code: 1, msg: message, data: null }));
  } else {
    console.error(`❌ 错误: ${message}`);
  }
  process.exit(1);
}

/** Read the raw value of `--name <value>` / `--name=<value>` exactly like `parseArgs` does. */
export function readFlagValue(args: string[], name: string): string | boolean | undefined {
  const long = `--${name}`;
  const eqPrefix = `${long}=`;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") return undefined; // everything after `--` is positional
    if (token === long) {
      const next = args[i + 1];
      // A string option swallows the next token verbatim; a valueless trailing flag becomes `true`.
      return next === undefined ? true : next;
    }
    if (token.startsWith(eqPrefix)) return token.slice(eqPrefix.length);
  }
  return undefined;
}

/** True when `--json` (or `--json=true`) is present, so the error can be machine-readable. */
function wantsJsonOutput(args: string[]): boolean {
  return args.some((token) => token === "--json" || token === "--json=true");
}

/**
 * `stats --days` (D-05 / K-04).
 *
 * Two layers, like every other numeric flag:
 *   layer 1 — is this a legal numeric literal at all? (`parseNumericLiteral`, shared by ALL flags)
 *             so `--days 1e3` behaves exactly like `--price 1e3`.
 *   layer 2 — this flag's own rule: a positive whole number of days. `7.0` IS the whole number 7
 *             and is therefore accepted (== `--days 7`); `1.5`, `-1`, `0` and `abc` are not.
 * K-04 only ever required that `--days abc` must not succeed and empty the report; it never asked
 * for `7.0` to be refused — that was an over-strict extra, and refusing it was a false rejection.
 */
export function validateStatsDays(raw: unknown): { days?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--days");
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  const days = parsed.value;
  if (!Number.isSafeInteger(days) || days <= 0) {
    return { error: `--days 必须是正整数天数，收到: ${String(raw).trim()}` };
  }
  return { days };
}

/**
 * `dividend add --shares`: a positive whole share count. This is a holding snapshot rather than an
 * order, so there is no board-lot (100-share) rule here — only the shared literal layer plus the
 * whole-number layer. (`--shares 1,000` used to reach `parseInt` and silently record 1 share.)
 */
export function validateShares(raw: unknown): { shares?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--shares");
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  const shares = parsed.value;
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    return { error: `--shares 必须为正整数股数（单位: 股），收到: ${String(raw).trim()}` };
  }
  return { shares };
}

/** `dividend add --per-share`: a non-negative money amount per share (`0,05` must not become 0). */
export function validatePerShare(raw: unknown): { perShare?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--per-share");
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  if (parsed.value < 0) {
    return { error: `--per-share 必须是 >= 0 的有限数值（单位: 元，可为 0），收到: ${String(raw).trim()}` };
  }
  return { perShare: parsed.value };
}

/**
 * K-05 (`scan --thresholds`): malformed JSON, a non-object payload, an unknown key or a
 * non-finite value all used to be swallowed by the scanner — `'{"take_profit_min":"high"}'`
 * silently disarmed the take-profit alert and still exited 0. Shared by the gate and the handler.
 */
export function validateScanThresholds(
  raw: unknown,
): { thresholds?: Record<string, number>; error?: string } {
  const rawText = raw === undefined ? "" : String(raw).trim();
  if (rawText === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { error: `--thresholds 不是合法 JSON: ${rawText}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `--thresholds 必须是 JSON 对象，例如 '{"take_profit_min":0.05}'` };
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(SIGNAL_THRESHOLD_KEYS as readonly string[]).includes(key)) {
      return { error: `--thresholds 含未知键 '${key}'；支持: ${SIGNAL_THRESHOLD_KEYS.join(", ")}` };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: `--thresholds['${key}'] 必须是有限数值，收到: ${JSON.stringify(value ?? null)}` };
    }
  }
  return { thresholds: parsed as Record<string, number> };
}

/**
 * B4 (round-3): the ONE numeric literal syntax accepted by every numeric CLI option.
 *
 * Round 2 gave `--fee` / `--amount` their own strict regex while `--price` / `--cap` kept raw
 * `parseFloat`, so the same literal could be accepted by one parameter and rejected by another
 * (`--price 1e3` = 0 vs `--fee 1e3` = 1) — and `parseFloat` silently truncated garbage:
 * `8,199` -> 8, `1,000` -> 1, `2.5abc` -> 2.5, `1_000` -> 1, all written to the ledger.
 *
 * Accepted: optional sign, digits with optional decimal point, or a bare `.fraction`, with an
 * optional `e`/`E` exponent — i.e. every literal JavaScript itself treats as a numeric literal.
 * Rejected: thousands separators, unit suffixes, embedded spaces, `_` separators, hex/octal
 * prefixes, `NaN`, `Infinity`, empty. Every numeric option calls THIS function, so literal
 * acceptance cannot drift between parameters; only the range rules differ (fee >= 0, price > 0, ...).
 */
export const NUMERIC_LITERAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Literals every numeric option must reject (asserted from the CLI in tests/evidence). */
export const NUMERIC_LITERALS_MUST_REJECT = [
  "8,199",
  "1,000",
  "2.5abc",
  "2.5 9",
  "1_000",
  "0x10",
  "abc",
  "NaN",
  "Infinity",
  "",
] as const;

/** Literals every numeric option must accept at the literal layer (`--qty` still needs an integer). */
export const NUMERIC_LITERALS_MUST_ACCEPT = [
  "2.0001",
  "8.199",
  "100",
  "5.5",
  "1e3",
  "1E3",
  "1.5e2",
  ".5",
  "+5",
  "5.",
] as const;

/**
 * Parse a user-supplied numeric literal: syntax + finiteness, nothing else. `undefined` means
 * "flag absent" and stays absent; `""` is a real (rejected) value, never "absent".
 */
export function parseNumericLiteral(
  raw: unknown,
  label: string,
): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const text = String(raw).trim();
  if (text === "") {
    return { error: `${label} 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: (空值)` };
  }
  if (!NUMERIC_LITERAL_PATTERN.test(text)) {
    return {
      error: `${label} 必须是合法数值字面量（禁止千分位逗号 / 单位后缀 / 下划线 / 十六进制），收到: ${text}`,
    };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { error: `${label} 必须是有限数值（非 NaN / Infinity），收到: ${text}` };
  }
  return { value };
}

/**
 * `--price`: a finite literal strictly greater than 0 (D-09, now closed at the literal layer).
 * The `非法成交价：` prefix keeps the wording L1's accepted CLI negative controls match on, while
 * the body now names the literal problem rather than a merely-impossible parsed value.
 */
export function validatePrice(raw: unknown): { price?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--price");
  if (parsed.error) return { error: `非法成交价：${parsed.error}` };
  if (parsed.value === undefined) return {};
  if (parsed.value <= 0) {
    return { error: `非法成交价：--price 必须为有限正数（> 0），收到: ${String(raw).trim()}` };
  }
  return { price: parsed.value };
}

/**
 * D-10 (`--fee`): a fee must be a finite, non-negative amount. `0` is legal (fee-free fills).
 * `parseFloat("abc")` yields NaN, which used to be written straight into `buy_fee` and
 * `cost_basis_unit` while the command still exited 0.
 */
export function validateFee(raw: unknown): { fee?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--fee");
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  if (parsed.value < 0) {
    return { error: `--fee 必须是 >= 0 的有限数值（单位: 元，可为 0），收到: ${String(raw).trim()}` };
  }
  return { fee: parsed.value };
}

/**
 * D-10 (`--qty`): a share count must be a finite positive integer. For the OPENING paths
 * (`lot buy` / `lot add`) it must also be a whole 100-share board lot, mirroring the engine's own
 * contract — the old code either fell through to the misleading "100 的整数倍" message (NaN) or
 * silently substituted a derived quantity (`lot add --qty abc` wrote 5200 shares!). `lot close`
 * keeps odd-lot closes legal (a 1-share remainder is a real order, master-confirmed), so there
 * `requireLotUnit` is false and only the NaN / zero / negative / fractional guard applies.
 */
export function validateQuantity(
  raw: unknown,
  label = "--qty",
  requireLotUnit = true,
): { quantity?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, label);
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  const quantity = parsed.value;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return { error: `${label} 必须为正整数股数（单位: 股），收到: ${String(raw).trim()}` };
  }
  if (requireLotUnit && quantity % 100 !== 0) {
    return { error: `${label} 必须是 100 股整数倍（一手 = 100 股），收到: ${quantity} 股` };
  }
  return { quantity };
}

/**
 * D-10 sibling guard (`lot add --amount`): the SAME fallback branch that let `--qty abc` slip
 * through (`if (!quantity || quantity <= 0) { baseAmount = amount > 0 ? amount : 10000 }`) turned
 * `--amount abc` / `0` / `-5000` into a silent deployment of the 10000 CNY default (5200 shares).
 * A supplied amount must therefore be a finite positive number; an OMITTED `--amount` keeps the
 * documented "deploy 10000 by default" behaviour untouched.
 */
export function validateAmount(raw: unknown): { amount?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, "--amount");
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  if (parsed.value <= 0) {
    return { error: `--amount 必须是 > 0 的有限数值（单位: 元），收到: ${String(raw).trim()}` };
  }
  return { amount: parsed.value };
}

/** `--cap` / `--full-position-cap`: a finite literal strictly greater than 0. */
export function validateCap(raw: unknown, label: string): { cap?: number; error?: string } {
  const parsed = parseNumericLiteral(raw, label);
  if (parsed.error) return { error: parsed.error };
  if (parsed.value === undefined) return {};
  if (parsed.value <= 0) {
    return { error: `${label} 必须为有限正数（> 0），收到: ${String(raw).trim()}` };
  }
  return { cap: parsed.value };
}

/**
 * D-08 (`dashboard --api-base`): the probe base baked into the generated page must be an absolute
 * http(s) origin — scheme + host + optional port, no path / query / fragment and no character that
 * could escape the JS string literal it lands in. A typo'd base used to be impossible to express
 * at all (the address was hardcoded), so the flag is the only new surface: refusing garbage here
 * is what keeps `--api-base http://127.0.0.1:18080` from silently probing the wrong endpoint.
 */
export const API_BASE_PATTERN = /^https?:\/\/[A-Za-z0-9\[](?:[A-Za-z0-9\-.:\[\]]*)\/?$/;

export function validateApiBase(raw: unknown): { apiBase?: string; error?: string } {
  if (raw === undefined) return {};
  const text = String(raw).trim();
  if (text === "") {
    return { error: `--api-base 不能为空（省略该参数即使用默认值 ${DASHBOARD_DEFAULT_API_BASE}）` };
  }
  if (!API_BASE_PATTERN.test(text)) {
    return {
      error: `--api-base 必须是形如 ${DASHBOARD_DEFAULT_API_BASE} 的探活基址（仅 http/https + 主机[:端口]，不含路径 / 查询串），收到: ${text}`,
    };
  }
  return { apiBase: text };
}

/** Value-level contract violation for a command path, resolved before the ledger is opened. */
export function findFlagValueError(commandPath: string, args: string[]): string | null {
  if (commandPath === "dashboard") {
    return validateApiBase(readFlagValue(args, "api-base")).error ?? null;
  }
  if (commandPath === "stats") {
    return validateStatsDays(readFlagValue(args, "days")).error ?? null;
  }
  if (commandPath === "scan") {
    return validateScanThresholds(readFlagValue(args, "thresholds")).error ?? null;
  }
  // D-10 + B4: all numeric flags are vetted here, through the ONE shared literal parser, so an
  // illegal literal can never open (let alone write) a ledger, and no two parameters can disagree
  // about what a legal literal looks like.
  if (commandPath === "lot buy" || commandPath === "lot add" || commandPath === "lot close") {
    const priceError = validatePrice(readFlagValue(args, "price")).error;
    if (priceError) return priceError;
    const feeError = validateFee(readFlagValue(args, "fee")).error;
    if (feeError) return feeError;
    const qtyError = validateQuantity(
      readFlagValue(args, "qty"),
      "--qty",
      commandPath !== "lot close",
    ).error;
    if (qtyError) return qtyError;
    if (commandPath === "lot add") {
      const amountError = validateAmount(readFlagValue(args, "amount")).error;
      if (amountError) return amountError;
    }
  }
  if (commandPath === "dividend add") {
    const amountError = validateAmount(readFlagValue(args, "amount")).error;
    if (amountError) return amountError;
    const sharesError = validateShares(readFlagValue(args, "shares")).error;
    if (sharesError) return sharesError;
    const perShareError = validatePerShare(readFlagValue(args, "per-share")).error;
    if (perShareError) return perShareError;
  }
  if (commandPath === "position") {
    const capError = validateCap(readFlagValue(args, "cap"), "--cap").error;
    if (capError) return capError;
    const fullCapError = validateCap(readFlagValue(args, "full-position-cap"), "--full-position-cap").error;
    if (fullCapError) return fullCapError;
  }
  return null;
}

function formatCurrency(val: number): string {
  return val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRate(rate: number): string {
  const r = rate * 100;
  if (r > 0) {
    return "+" + r.toFixed(2) + "%";
  }
  return r.toFixed(2) + "%";
}

function printHelp(): void {
  console.log(`usage: trade [-h] {lot,account,position,scan,stats,physics,dashboard,serve,dividend,config} ...

Lot Trader Core CLI Engine (Unix Way & Hexagonal Architecture)

positional arguments:
  {lot,account,position,scan,stats,physics,dashboard,serve,dividend,config}  Available subcommands
    lot             Lot operations (buy, add, list, close, edit)
    account         Broker account registry (add, list)
    position        Position / Holding aggregated view
    scan            Scan active lots for signals (including trailing stop)
    stats           Performance statistics with multi-dimensional attribution
    physics         Physics momentum radar analysis (velocity, acceleration, force, damping)
    dashboard       Render the global interactive HTML dashboard
    serve           Start the local read-only HTTP engine (loopback only)
    dividend        Cash dividend management (add, list)
    config          Configuration management (get, set, list)

options:
  --db PATH         SQLite database path, honoured by EVERY subcommand (global option).
                    Precedence: --db > $LOT_TRADER_DB > $TRADE_DB_PATH > ~/.trade/trade.db
  -h, --help        show this help message and exit
`);
}

function printServeHelp(): void {
  console.log(`usage: trade serve [-h] [--port ${DEFAULT_SERVE_PORT}] [--host ${DEFAULT_SERVE_HOST}] [--db <path>]
                       [--token <string>] [--token-file <path>]

Local HTTP Engine (read-only JSON API, loopback only)

options:
  --port, -p PORT   TCP port to bind (default: ${DEFAULT_SERVE_PORT}; 0 = ephemeral)
  --host HOST       Bind host, loopback only (default: ${DEFAULT_SERVE_HOST})
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  --token TOKEN     Fixed session token (default: 32 random bytes / 64 hex, regenerated per run)
  --token-file PATH Credential file, written with 0600 (default: $LOT_TRADER_TOKEN_FILE /
                    ~/.lot-trader/session.token). Auto-generated tokens are deleted on exit.
  --json            Emit a single machine-readable ready line instead of the banner
  --quiet           Suppress the startup banner
  -h, --help        show this help message and exit

endpoints:
  GET /api/health   Liveness probe: {status, version, db_path, timestamp}  [public, no token]
  GET /api/summary  Portfolio + multi-account + per-symbol snapshot        [token required]
  GET /api/lots     Lot detail list (?symbol= &account= &status=)          [token required]

session credential:
  The token is passed as \`Authorization: Bearer <token>\` or \`?token=<token>\`.
  Missing or wrong token => HTTP 401 UNAUTHORIZED with no ledger field at all.
  \`trade dashboard\` reads the credential file and injects it into the generated page.

notes:
  The engine refuses to bind any non-loopback host, so the ledger never leaves this machine.
  Stop it with Ctrl+C (SIGINT / SIGTERM are handled as graceful shutdowns).
`);
}

async function handleServe(args: string[], explicitDb?: string): Promise<void> {
  const { values } = parseArgs({
    args,
    options: flagsFor("serve"),
    strict: false,
  });

  const isJson = Boolean(values.json);
  const quiet = Boolean(values.quiet);

  try {
    const started = await startServe({
      port: (values.port as string | undefined) ?? DEFAULT_SERVE_PORT,
      host: (values.host as string | undefined) ?? DEFAULT_SERVE_HOST,
      dbPath: explicitDb ?? (values.db as string | undefined),
      token: values.token as string | undefined,
      tokenFile: values["token-file"] as string | undefined,
      quiet,
    });

    // The token itself is NEVER printed: only where it lives and how it is protected.
    const credentialNote = `${started.tokenFile} (0600, ${
      started.tokenSource === "generated" ? "自动生成，退出时清除" : "由 --token 指定"
    })`;

    if (isJson) {
      console.log(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            url: started.url,
            host: started.host,
            port: started.port,
            db_path: started.dbPath,
            version: started.version,
            auth: "bearer",
            token_file: started.tokenFile,
            token_source: started.tokenSource,
            token_ephemeral: started.ephemeralToken,
          },
        }),
      );
    } else if (!quiet) {
      console.log(`⚡ Lot-Trader 本地引擎已启动 (按 Ctrl+C 停止)`);
      console.log(`   地址: ${started.url}`);
      console.log(`   接口: GET /api/health | GET /api/summary | GET /api/lots?symbol=&account=&status=`);
      console.log(`   账本: ${started.dbPath}`);
      console.log(`   凭证: ${credentialNote}`);
      console.log(`   鉴权: /api/summary 与 /api/lots 需 Bearer Token（/api/health 保持公开探活）`);
      console.log(`   版本: v${started.version} • 仅监听本地回环地址，不对公网暴露`);
      console.log(`   看板: trade dashboard 会自动注入该凭证，顶栏指示灯 3 秒内转为「本地引擎已联动」`);
    }

    let stopping = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await started.stop();
      if (isJson) {
        console.log(JSON.stringify({ code: 0, msg: "stopped", data: { signal } }));
      } else if (!quiet) {
        console.log(`👋 本地引擎已优雅停止 (${signal})`);
      }
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    // Keep the process alive until a signal arrives (the listener alone is not a promise).
    await new Promise<void>(() => {});
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: message, data: null }));
    } else {
      console.error(`❌ ${message}`);
    }
    process.exit(1);
  }
}

function printDashboardHelp(): void {
  console.log(`usage: trade dashboard [-h] [--out <path>] [--open] [--template <path>] [--db <path>]
                         [--token <string>] [--token-file <path>] [--api-base <url>]

Global Interactive HTML Dashboard Generator

options:
  --out, -o PATH    Output HTML file path (default: ./${DASHBOARD_DEFAULT_OUT})
  --open            Open the generated dashboard with the system default browser
  --template, -t    Front-end template HTML path (default: template_base.html next to the script)
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  --token TOKEN     Session token to embed (default: read the credential file below)
  --token-file PATH Credential file (default: $LOT_TRADER_TOKEN_FILE / ~/.lot-trader/session.token)
  --api-base URL    Probe base the page heartbeats against (default: ${DASHBOARD_DEFAULT_API_BASE}).
                    Pass the address \`trade serve\` is actually listening on, e.g.
                    \`trade serve --port 18080\` + \`--api-base http://127.0.0.1:18080\`,
                    so the page can leave standalone mode without binding the default port.
  --json            Emit structured JSON result instead of human readable text
  -h, --help        show this help message and exit

notes:
  When an active credential is found it is injected as window.__LOT_TRADER_SESSION_TOKEN__
  so the page can call /api/summary and /api/lots; without one the page stays in
  pure front-end standalone mode.
`);
}

function printLotBuyHelp(): void {
  console.log(`usage: trade lot buy [-h] [--symbol <SYM>] [--price <NUM>] [--qty <N>]
                     [--account <ACC>] [--reason <TEXT>] [--fee <NUM>] [--time <ISO>]
                     [--parent <LOT_ID>] [--skip-risk] [--json] [--db <path>]

Buy / create a new initial lot.

positional shorthand:
  trade lot buy <symbol> <price> <qty>

options:
  --symbol SYM      Instrument code, e.g. 518880.SH
  --price NUM       Fill price
  --qty N           Share / unit count
  --account ACC     Broker account id (unknown ids are auto-registered as CUSTOM)
  --reason TEXT     Decision thesis stored on the lot
  --fee NUM         Commission and fees
  --time ISO        Explicit fill timestamp
  --parent LOT_ID   Parent lot id when this buy inherits a core position
  --skip-risk       Skip the pre-trade full-position budget check
  --json            Emit machine-readable JSON
  --db PATH         SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help        show this help message and exit
`);
}

function printLotAddHelp(): void {
  console.log(`usage: trade lot add [-h] [--parent-lot-id <LOT_ID>] [--price <NUM>] [--amount <NUM>]
                     [--qty <N>] [--account <ACC>] [--reason <TEXT>] [--fee <NUM>]
                     [--time <ISO>] [--skip-risk] [--json] [--db <path>]

Pyramid dip add to an existing lot (with anti-shake guard).

positional shorthand:
  trade lot add <lot_id> <price>

options:
  --parent-lot-id ID  Parent lot id (alias: --parent)
  --price NUM         Fill price
  --amount NUM        Cash amount to deploy (converted to shares)
  --qty N             Explicit share / unit count
  --account ACC       Broker account id
  --reason TEXT       Decision thesis for this add
  --fee NUM           Commission and fees
  --time ISO          Explicit fill timestamp
  --skip-risk         Skip the pre-trade full-position budget check
  --json              Emit machine-readable JSON
  --db PATH           SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help          show this help message and exit
`);
}

function printLotListHelp(): void {
  console.log(`usage: trade lot list [-h] [--status ACTIVE|CLOSED|ALL] [--symbol <SYM>] [--account <ACC>]
                      [--json] [--db <path>]

List lots with live price, return rate and action advice.

options:
  --status STATUS   Lot status filter (default: ACTIVE)
  --symbol SYM      Filter by instrument code
  --account ACC     Filter by broker account
  --json            Emit machine-readable JSON
  --db PATH         SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help        show this help message and exit
`);
}

function printLotCloseHelp(): void {
  console.log(`usage: trade lot close [-h] [--lot-id <LOT_ID>] [--price <NUM>] [--qty <N>]
                       [--account <ACC>] [--reason <TEXT>] [--substitute-core]
                       [--fee <NUM>] [--time <ISO>] [--json] [--db <path>]

Close a lot (full or partial) and record the realized PnL.

positional shorthand:
  trade lot close <lot_id> <price> [qty]

options:
  --lot-id LOT_ID   Lot to close
  --price NUM       Fill price
  --qty N           Partial quantity (omit to close the whole remaining position)
  --account ACC     Expected owning account (mismatch is rejected)
  --reason TEXT     Close thesis
  --substitute-core Reverse-T+0 core substitution
  --fee NUM         Commission and fees
  --time ISO        Explicit fill timestamp
  --json            Emit machine-readable JSON
  --db PATH         SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help        show this help message and exit
`);
}

function printLotEditHelp(): void {
  console.log(`usage: trade lot edit [-h] [<lot_id> | --lot-id <LOT_ID>] [--reason <TEXT>]
                      [--buy-reason <TEXT>] [--close-reason <TEXT>] [--append]
                      [--json] [--db <path>]

Update the decision thesis (buy / close rationale) of a lot.

options:
  --lot-id LOT_ID     Target lot id (or pass it as the first positional)
  --reason TEXT       Buy thesis (alias of --buy-reason)
  --buy-reason TEXT   Buy thesis
  --close-reason TEXT Close thesis
  --append            Append to the existing thesis instead of overwriting
  --json              Emit machine-readable JSON
  --db PATH           SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help          show this help message and exit
`);
}

function printLotSubcommandHelp(subCmd: string | undefined): void {
  switch (subCmd) {
    case "buy":
      printLotBuyHelp();
      return;
    case "add":
      printLotAddHelp();
      return;
    case "list":
      printLotListHelp();
      return;
    case "close":
      printLotCloseHelp();
      return;
    case "edit":
      printLotEditHelp();
      return;
    default:
      printLotHelp();
  }
}

function printPositionHelp(): void {
  console.log(`usage: trade position [-h] [list] [--symbol <SYM>] [--cap <NUM>]
                       [--full-position-cap <NUM>] [--account <ACC>] [--json] [--db <path>]

Hierarchical position / holding view with per-symbol aggregation.

options:
  --symbol SYM              Restrict to a single instrument
  --cap NUM                 Override the per-symbol full-position budget
  --full-position-cap NUM   Alias of --cap
  --account ACC             Filter by broker account
  --json                    Emit machine-readable JSON
  --db PATH                 SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help                show this help message and exit
`);
}

function printScanHelp(): void {
  console.log(`usage: trade scan [-h] [--thresholds <JSON>] [--account <ACC>] [--json] [--db <path>]

Scan active lots for pyramid-add / trailing-stop signals.

options:
  --thresholds JSON   Override signal thresholds. Keys are exactly the ones the scanner reads,
                      all values finite numbers:
                        take_profit_min    take-profit line (default 0.10  = +10%)
                        trailing_activate  trailing-stop arming line (default 0.15)
                        trailing_pullback  trailing-stop pullback line (default 0.03)
                        dip_1              level-1 dip-buy line (default -0.10)
                        deep_value         deep-value line (default -0.20)
                      Example: '{"take_profit_min":0.05,"dip_1":-0.08}'
  --account ACC       Filter by broker account
  --json              Emit machine-readable JSON
  --db PATH           SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help          show this help message and exit
`);
}

function printStatsHelp(): void {
  console.log(`usage: trade stats [-h] [--days <N>] [--symbol <SYM>] [--account <ACC>] [--json] [--db <path>]

Performance statistics with multi-dimensional attribution.

options:
  --days N        Only count trades from the last N days
  --symbol SYM    Filter by instrument code
  --account ACC   Filter by broker account
  --json          Emit machine-readable JSON
  --db PATH       SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help      show this help message and exit
`);
}

function printPhysicsHelp(): void {
  console.log(`usage: trade physics [-h] [<symbol> | --symbol <SYM>] [--json] [--db <path>]
                        (alias: trade radar)

Physics momentum radar: velocity, acceleration, mass, force, damping.

options:
  --symbol SYM    Instrument code, e.g. 600519 or 518880.SH
  --json          Emit machine-readable JSON
  --db PATH       SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help      show this help message and exit
`);
}

function printDividendAddHelp(): void {
  console.log(`usage: trade dividend add [-h] --symbol <SYM> --amount <NUM> [--date <YYYY-MM-DD>]
                           [--account <ACC>] [--shares <N>] [--per-share <NUM>]
                           [--notes <TEXT>] [--json] [--db <path>]

Record one cash dividend.

options:
  --symbol SYM       Instrument code
  --amount NUM       Cash amount received
  --date DATE        Ex-dividend date (default: today)
  --account ACC      Broker account id
  --shares N         Shares held on the ex-date
  --per-share NUM    Dividend per share
  --notes TEXT       Free-form note
  --json             Emit machine-readable JSON
  --db PATH          SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help         show this help message and exit
`);
}

function printDividendListHelp(): void {
  console.log(`usage: trade dividend list [-h] [--symbol <SYM>] [--account <ACC>] [--json] [--db <path>]

List cash dividends and the accumulated total.

options:
  --symbol SYM    Filter by instrument code
  --account ACC   Filter by broker account
  --json          Emit machine-readable JSON
  --db PATH       SQLite database path (global; default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help      show this help message and exit
`);
}

function printDividendSubcommandHelp(subCmd: string | undefined): void {
  switch (subCmd) {
    case "add":
      printDividendAddHelp();
      return;
    case "list":
      printDividendListHelp();
      return;
    default:
      printDividendHelp();
  }
}

/**
 * Locate the dashboard generator script + template shipped with the repo / skill bundles.
 * Resolution order: explicit env override -> executable sibling dirs -> source tree -> agent skill dirs.
 */
export function resolveDashboardScripts(explicitScriptDir?: string): { scriptPath: string; templatePath: string } {
  const candidates: string[] = [];

  if (explicitScriptDir) {
    candidates.push(explicitScriptDir);
  }
  if (process.env.LOT_TRADER_SCRIPTS_DIR) {
    candidates.push(process.env.LOT_TRADER_SCRIPTS_DIR);
  }

  const execDir = dirname(process.execPath);
  candidates.push(join(execDir, "scripts"));
  candidates.push(join(execDir, "..", "scripts"));
  // Source tree layout: <repo>/src/cli.ts -> <repo>/scripts
  candidates.push(join(import.meta.dir, "..", "scripts"));

  const home = homedir();
  for (const skillRoot of [".claude", ".codex", ".agents"]) {
    candidates.push(join(home, skillRoot, "skills", "lot-trader", "scripts"));
  }

  const seen = new Set<string>();
  for (const dir of candidates) {
    const absDir = isAbsolute(dir) ? dir : resolve(dir);
    if (seen.has(absDir)) continue;
    seen.add(absDir);

    const scriptPath = join(absDir, "generate_dashboard.py");
    const templatePath = join(absDir, "template_base.html");
    if (existsSync(scriptPath) && existsSync(templatePath)) {
      return { scriptPath, templatePath };
    }
  }

  throw new Error(
    `Dashboard generator not found. Looked for generate_dashboard.py + template_base.html in:\n  ${[...seen].join("\n  ")}\n` +
      `Set LOT_TRADER_SCRIPTS_DIR or run from the repo / an agent skill bundle.`,
  );
}

function pythonCommand(): string {
  return process.env.LOT_TRADER_PYTHON || "python3";
}

/** Make sure the nested `trade ... --json` calls made by the Python generator resolve to THIS binary. */
function resolveChildPath(): string | undefined {
  const execBase = process.execPath.split(/[\\/]/).pop() || "";
  const parentPath = process.env.PATH || "";
  if (execBase.toLowerCase().startsWith("trade")) {
    return [dirname(process.execPath), parentPath].filter(Boolean).join(":");
  }
  return parentPath || undefined;
}

function resolveDashboardDb(explicitDb?: string): string {
  return (
    explicitDb ||
    process.env.LOT_TRADER_DB ||
    process.env.TRADE_DB_PATH ||
    join(homedir(), ".trade", "trade.db")
  );
}

function openWithSystemBrowser(target: string): void {
  const opener = process.platform === "darwin" ? ["open", target] : process.platform === "win32" ? ["cmd", "/c", "start", "", target] : ["xdg-open", target];
  const proc = Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

async function handleDashboard(args: string[], explicitDb?: string): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", short: "o" },
      open: { type: "boolean", default: false },
      template: { type: "string", short: "t" },
      db: { type: "string" },
      token: { type: "string" },
      "token-file": { type: "string" },
      "scripts-dir": { type: "string" },
      "api-base": { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const outPath = resolve((values.out as string | undefined) || DASHBOARD_DEFAULT_OUT);
  const dbPath = resolveDashboardDb(explicitDb ?? (values.db as string | undefined));
  // D-08: pass the caller's probe base straight through to the generator. Absent => the flag is
  // not forwarded at all, so the generator's own default (127.0.0.1:8080) is what lands in the page.
  const apiBase = ((values["api-base"] as string | undefined) ?? "").trim();

  try {
    const { scriptPath, templatePath } = resolveDashboardScripts(values["scripts-dir"] as string | undefined);
    const template = (values.template as string | undefined) || templatePath;

    if (!existsSync(template)) {
      throw new Error(`Template not found: ${template}`);
    }
    // The generator reads the ledger directly via sqlite3, so make sure the schema exists first
    // (opening a fresh path also seeds the full symbol universe).
    const ledger = new AppDatabase(dbPath);
    ledger.close();

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TRADE_DB_PATH: dbPath,
      LOT_TRADER_DB: dbPath,
    };
    const childPath = resolveChildPath();
    if (childPath) {
      childEnv.PATH = childPath;
    }

    // Credential hand-off: `trade dashboard` embeds the same token `trade serve` publishes,
    // so the generated page can authenticate against the local engine without user input.
    const generatorArgs = [scriptPath, "--out", outPath, "--template", template, "--db", dbPath];
    if (apiBase) {
      generatorArgs.push("--api-base", apiBase);
    }
    const explicitToken = ((values.token as string | undefined) ?? "").trim();
    const tokenFileArg = ((values["token-file"] as string | undefined) ?? "").trim();
    const tokenFile = resolveSessionTokenFile(tokenFileArg || undefined);
    childEnv.LOT_TRADER_TOKEN_FILE = tokenFile;
    if (explicitToken) {
      generatorArgs.push("--token", explicitToken);
    }
    if (tokenFileArg) {
      generatorArgs.push("--token-file", tokenFileArg);
    }
    // Report what the page will actually be able to prove, without printing the secret.
    const tokenSource = explicitToken
      ? "explicit"
      : readSessionTokenFile(tokenFile)
        ? "credential_file"
        : "none";

    const proc = Bun.spawn([pythonCommand(), ...generatorArgs], {
      cwd: process.cwd(),
      env: childEnv,
      stdout: isJson ? "pipe" : "inherit",
      stderr: isJson ? "pipe" : "inherit",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      // The generator reports expected failures as one clean Chinese line on stderr; surface it
      // verbatim instead of burying it behind a second English wrapper.
      const detail = (stderr || stdout).trim();
      throw new Error(
        detail
          ? `看板生成器执行失败 (exit ${exitCode}): ${detail}`
          : `看板生成器执行失败 (exit ${exitCode})（详见上方生成器错误输出）`,
      );
    }

    if (!existsSync(outPath)) {
      throw new Error(`Dashboard generator reported success but produced no file: ${outPath}`);
    }

    const size = statSync(outPath).size;

    if (values.open) {
      openWithSystemBrowser(outPath);
    }

    if (isJson) {
      console.log(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            out: outPath,
            script: scriptPath,
            template,
            db: dbPath,
            api_base: apiBase || DASHBOARD_DEFAULT_API_BASE,
            bytes: size,
            opened: Boolean(values.open),
            token_file: tokenFile,
            token_source: tokenSource,
          },
        }),
      );
    } else {
      console.log(`🌐 全局看板已生成: ${outPath} (${size.toLocaleString("en-US")} bytes)`);
      console.log(`   脚本: ${scriptPath}`);
      console.log(`   模板: ${template}`);
      console.log(`   数据: ${dbPath}`);
      console.log(`   探活基址: ${apiBase || DASHBOARD_DEFAULT_API_BASE}`);
      console.log(
        `   凭证: ${
          tokenSource === "explicit"
            ? "已通过 --token 注入"
            : tokenSource === "credential_file"
              ? `已注入活跃会话 Token (${tokenFile}, 0600)`
              : `未找到活跃 Token (${tokenFile})，页面将以纯前端自驱模式打开`
        }`,
      );
      if (values.open) {
        console.log(`   已在系统默认浏览器中打开。`);
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 生成看板失败: ${err.message}`);
    }
    process.exit(1);
  }
}

function printLotHelp(): void {
  console.log(`usage: trade lot [-h] {buy,add,list,close,edit} ...

Lot actions:
  buy               Buy / create a new initial lot [--account <ACC>] [--reason <TEXT>]
  add               Pyramid dip add to an existing lot (with anti-shake guard) [--account <ACC>] [--reason <TEXT>]
  list              List lots [--account <ACC>] [--status ACTIVE|CLOSED|ALL]
  close             Close a lot (full or partial) [--account <ACC>] [--reason <TEXT>]
  edit              Update the decision thesis of a lot [--reason <TEXT>] [--close-reason <TEXT>]

Positional shorthand (equivalent to the flags):
  trade lot buy <symbol> <price> <qty>
  trade lot add <lot_id> <price>
  trade lot close <lot_id> <price> [qty]
  trade lot edit <lot_id>

Global options (also accepted by every sub-action above):
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help        show this help message (also: trade lot <action> --help)
`);
}

function printAccountHelp(): void {
  console.log(`usage: trade account {add,list} ...

Broker account registry:
  list              List configured accounts [--all] [--json]
  add               Register an account: trade account add <account_id> --name <name> [--broker <code>] [--currency <ISO>]

Broker presets: CMB | CITIC | HTSC | EASTMONEY | GUOTAI | YINHE | GF | PA | FUTU | IBKR | CUSTOM
Unknown accounts passed to 'trade lot buy --account' are auto-registered as CUSTOM.

Global options:
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  -h, --help        show this help message and exit
`);
}

async function handleAccount(engine: TraderEngine, args: string[]): Promise<void> {
  const subAction = args[0];
  const restArgs = args.slice(1);

  if (!subAction || subAction === "-h" || subAction === "--help") {
    printAccountHelp();
    return;
  }

  if (subAction === "list") {
    const { values } = parseArgs({
      args: restArgs,
      options: flagsFor("account list"),
      strict: false,
    });
    const isJson = Boolean(values.json);

    try {
      const accounts = engine.listAccounts(Boolean(values.all));
      if (isJson) {
        console.log(JSON.stringify({ code: 0, msg: "success", data: accounts }, null, 2));
        return;
      }
      if (accounts.length === 0) {
        console.log("暂无已配置账户，可使用 trade account add <id> --name <别名> 登记。");
        return;
      }
      console.log(`🏛 已配置券商账户 (共 ${accounts.length} 个)`);
      console.log("-".repeat(90));
      console.log(
        "Account ID".padEnd(14) + " | " + "Name".padEnd(18) + " | " + "Broker".padEnd(10) + " | " + "Currency".padEnd(8) + " | " + "Status"
      );
      console.log("-".repeat(90));
      for (const a of accounts) {
        console.log(
          a.account_id.padEnd(14) + " | " +
          a.name.padEnd(18) + " | " +
          a.broker_code.padEnd(10) + " | " +
          a.currency.padEnd(8) + " | " +
          (a.is_active ? "ACTIVE" : "INACTIVE")
        );
      }
      console.log("-".repeat(90));
    } catch (err: any) {
      if (isJson) {
        console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
      } else {
        console.error(`❌ 查询账户失败: ${err.message}`);
      }
      process.exit(1);
    }
    return;
  }

  if (subAction === "add") {
    const { values, positionals } = parseArgs({
      args: restArgs,
      options: flagsFor("account add"),
      allowPositionals: true,
      strict: false,
    });
    const isJson = Boolean(values.json);
    const accountId = (values.id as string | undefined) || positionals[0];
    const name = values.name as string | undefined;

    try {
      if (!accountId || !name) {
        throw new Error("Missing required arguments: <account_id> (or --id), --name");
      }
      const account = engine.addAccount(accountId, {
        name,
        brokerCode: values.broker as string | undefined,
        currency: values.currency as string | undefined,
      });
      if (isJson) {
        console.log(JSON.stringify({ code: 0, msg: "success", data: account }, null, 2));
      } else {
        console.log(`✅ 账户登记成功: ${account.account_id}`);
        console.log(`别名: ${account.name} | 券商: ${account.broker_code} | 币种: ${account.currency} | 状态: ${account.is_active ? "ACTIVE" : "INACTIVE"}`);
      }
    } catch (err: any) {
      if (isJson) {
        console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
      } else {
        console.error(`❌ 账户登记失败: ${err.message}`);
      }
      process.exit(1);
    }
    return;
  }

  printAccountHelp();
  process.exit(1);
}

async function handleLotBuy(engine: TraderEngine, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: flagsFor("lot buy"),
    allowPositionals: true,
    strict: false,
  });

  const isJson = Boolean(values.json);

  try {
    const symbolArg = (values.symbol as string | undefined) || positionals[0];
    const priceArg = (values.price as string | undefined) || positionals[1];
    const qtyArg = (values.qty as string | undefined) || positionals[2];

    if (!symbolArg || !priceArg || !qtyArg) {
      throw new Error("Missing required arguments: --symbol, --price, --qty (or: trade lot buy <symbol> <price> <qty>)");
    }

    const symbol = symbolArg;
    // B4-2: the price is validated as a LITERAL, not just as its parsed value — `parseFloat`
    // truncates `8,199` to 8 and `2.5abc` to 2.5, silently writing a wrong-magnitude batch.
    const buyPriceResult = validatePrice(priceArg);
    if (buyPriceResult.error) throw new Error(buyPriceResult.error);
    const price = buyPriceResult.price!;
    // D-10: vet the share count and the fee before any write. Both accept a flag (`--qty` /
    // `--fee`) and `--qty` also has a positional form, so the label names whichever was used.
    const qtyResult = validateQuantity(
      qtyArg,
      values.qty !== undefined ? "--qty" : "--qty（或位置参数 3 <qty>）",
    );
    if (qtyResult.error) throw new Error(qtyResult.error);
    const qty = qtyResult.quantity!;
    const account = values.account ? (values.account as string).trim() : undefined;
    const reason = values.reason !== undefined ? (values.reason as string) : undefined;
    const feeResult = validateFee(values.fee);
    if (feeResult.error) throw new Error(feeResult.error);
    const fee = feeResult.fee;
    const time = values.time ? new Date(values.time as string) : undefined;
    const parent = values.parent as string | undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.buyLot(symbol, price, qty, fee, time, parent, skipRisk, account, reason);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: lot.lot_id,
          account_id: lot.account_id,
          symbol: lot.symbol,
          buy_time: lot.buy_time.toISOString(),
          buy_price: lot.buy_price,
          buy_quantity: lot.buy_quantity,
          cost_basis_unit: lot.cost_basis_unit,
          buy_fee: lot.buy_fee,
          status: lot.status,
          pyramid_level: lot.pyramid_level,
          can_sell_now: lot.can_sell_now,
          buy_reason: lot.buy_reason ?? null,
        },
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`✅ 成功录入买入批次: ${lot.lot_id}`);
      console.log(`所属账户: ${lot.account_id} | 标的代码: ${lot.symbol} | 数量: ${lot.buy_quantity} | 成交单价: ${lot.buy_price.toFixed(4)} 元`);
      console.log(`全成本单价: ${lot.cost_basis_unit.toFixed(4)} 元 | 规费: ${lot.buy_fee.toFixed(2)} 元 | 即刻可卖: ${lot.can_sell_now}`);
      if (lot.parent_lot_id) {
        console.log(`溯源父批次: ${lot.parent_lot_id} (加仓层级 L${lot.pyramid_level})`);
      }
      if (lot.buy_reason) {
        console.log(`买入理由: ${lot.buy_reason}`);
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 建仓失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleLotAdd(engine: TraderEngine, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: flagsFor("lot add"),
    allowPositionals: true,
    strict: false,
  });

  const isJson = Boolean(values.json);
  const parentId =
    (values["parent-lot-id"] as string) || (values.parent as string) || positionals[0];
  const priceArg = (values.price as string | undefined) || positionals[1];

  try {
    if (!parentId || !priceArg) {
      throw new Error("Missing required arguments: --parent-lot-id (or --parent), --price (or: trade lot add <lot_id> <price>)");
    }

    const addPriceResult = validatePrice(priceArg);
    if (addPriceResult.error) throw new Error(addPriceResult.error);
    const price = addPriceResult.price!;
    const addAmountResult = validateAmount(values.amount);
    if (addAmountResult.error) throw new Error(addAmountResult.error);
    const amount = addAmountResult.amount;
    // D-10: `lot add --qty abc` used to fall through to a DERIVED quantity (`!NaN` is true) and
    // silently write thousands of shares; `--fee abc` wrote NaN into cost_basis_unit.
    const addQtyResult = validateQuantity(values.qty, "--qty");
    if (addQtyResult.error) throw new Error(addQtyResult.error);
    const qty = addQtyResult.quantity;
    const account = values.account ? (values.account as string).trim() : undefined;
    const reason = values.reason !== undefined ? (values.reason as string) : undefined;
    const addFeeResult = validateFee(values.fee);
    if (addFeeResult.error) throw new Error(addFeeResult.error);
    const fee = addFeeResult.fee;
    const time = values.time ? new Date(values.time as string) : undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.addLot(parentId, price, {
      amount,
      qty,
      fee,
      buyTime: time,
      skipRiskCheck: skipRisk,
      accountId: account,
      reason,
    });

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: lot.lot_id,
          account_id: lot.account_id,
          parent_lot_id: lot.parent_lot_id,
          symbol: lot.symbol,
          buy_time: lot.buy_time.toISOString(),
          buy_price: lot.buy_price,
          buy_quantity: lot.buy_quantity,
          cost_basis_unit: lot.cost_basis_unit,
          buy_fee: lot.buy_fee,
          status: lot.status,
          pyramid_level: lot.pyramid_level,
          can_sell_now: lot.can_sell_now,
          buy_reason: lot.buy_reason ?? null,
        },
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`✅ 成功完成梯级加仓！批次ID: ${lot.lot_id}`);
      console.log(`所属账户: ${lot.account_id} | 父批次: ${lot.parent_lot_id} | 递增后加仓层级: L${lot.pyramid_level}`);
      console.log(`标的代码: ${lot.symbol} | 加仓数量: ${lot.buy_quantity} 股 | 成交单价: ${lot.buy_price.toFixed(4)} 元`);
      console.log(`加仓全成本单价: ${lot.cost_basis_unit.toFixed(4)} 元 | 规费: ${lot.buy_fee.toFixed(2)} 元`);
      if (lot.buy_reason) {
        console.log(`加仓理由: ${lot.buy_reason}`);
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 加仓失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleLotList(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: flagsFor("lot list"),
    strict: false,
  });

  const isJson = Boolean(values.json);
  const status = (values.status as string) || "ACTIVE";
  const symbol = values.symbol as string | undefined;
  const account = values.account ? (values.account as string).trim() : undefined;

  try {
    const lots = await engine.listLots(status, symbol, account);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: lots,
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      if (lots.length === 0) {
        console.log(`暂无符合条件的批次数据 (status=${status}, symbol=${symbol || "None"}, account=${account || "All"})`);
        return;
      }

      const header = `${"Lot ID".padEnd(19)} | ${"Account".padEnd(10)} | ${"Symbol".padEnd(10)} | ${"Name".padEnd(8)} | ${"Qty".padStart(6)} | ${"BuyCost".padStart(8)} | ${"Current".padStart(8)} | ${"Return".padStart(9)} | ${"PnL".padStart(10)} | ${"Action Advice".padEnd(14)} | ${"Buy Reason"}`;
      const sep = "-".repeat(header.length);
      console.log(sep);
      console.log(header);
      console.log(sep);

      for (const l of lots) {
        const rRate = l.return_rate;
        let advice = "[持仓观察]";
        if (l.trailing_stop_active) {
          advice = "[跟踪止盈]";
        } else if (rRate >= 0.10) {
          advice = "[可止盈]";
        } else if (rRate <= -0.20) {
          advice = "[深跌击球]";
        } else if (rRate <= -0.10) {
          advice = `[可加仓${l.pyramid_level + 1}]`;
        }

        const bCostStr = l.cost_basis_unit.toFixed(3);
        const currStr = l.current_price.toFixed(3);
        const pnlStr = (l.floating_pnl >= 0 ? "+" : "") + formatCurrency(l.floating_pnl);

        const idCol = l.lot_id.padEnd(19);
        const accCol = (l.account_id || "DEFAULT").padEnd(10);
        const symCol = l.symbol.padEnd(10);
        const nameCol = l.symbol_name.slice(0, 6).padEnd(8);
        const qtyCol = String(l.remaining_quantity).padStart(6);
        const costCol = bCostStr.padStart(8);
        const currCol = currStr.padStart(8);
        const retCol = formatRate(rRate).padStart(9);
        const pnlCol = pnlStr.padStart(10);
        const advCol = advice.padEnd(14);
        const reasonCol = (l.buy_reason || "--").replace(/\s+/g, " ").slice(0, 32);

        console.log(`${idCol} | ${accCol} | ${symCol} | ${nameCol} | ${qtyCol} | ${costCol} | ${currCol} | ${retCol} | ${pnlCol} | ${advCol} | ${reasonCol}`);
      }
      console.log(sep);
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 查询批次失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleLotClose(engine: TraderEngine, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: flagsFor("lot close"),
    allowPositionals: true,
    strict: false,
  });

  const isJson = Boolean(values.json);

  try {
    const lotIdArg = (values["lot-id"] as string | undefined) || positionals[0];
    const priceArg = (values.price as string | undefined) || positionals[1];
    const qtyArg = (values.qty as string | undefined) || positionals[2];

    if (!lotIdArg || !priceArg) {
      throw new Error("Missing required arguments: --lot-id, --price (or: trade lot close <lot_id> <price> [qty])");
    }

    const lotId = lotIdArg;
    const closePriceResult = validatePrice(priceArg);
    if (closePriceResult.error) throw new Error(closePriceResult.error);
    const price = closePriceResult.price!;
    // D-10: an omitted `--qty` still means "close the whole remaining position". When supplied it
    // must be a positive whole share count — `lot close --qty abc` used to blow up mid-write with
    // `NOT NULL constraint failed: lots.remaining_quantity` instead of a clean pre-write rejection.
    // Odd-lot closes stay legal here (a 1-share remainder is a real order), hence requireLotUnit=false.
    const closeQtyResult = validateQuantity(
      qtyArg,
      values.qty !== undefined ? "--qty" : "--qty（或位置参数 3 <qty>）",
      false,
    );
    if (closeQtyResult.error) throw new Error(closeQtyResult.error);
    const qty = closeQtyResult.quantity;
    const substituteCore = Boolean(values["substitute-core"]);
    const reason = values.reason !== undefined ? (values.reason as string) : undefined;
    const closeFeeResult = validateFee(values.fee);
    if (closeFeeResult.error) throw new Error(closeFeeResult.error);
    const fee = closeFeeResult.fee;
    const time = values.time ? new Date(values.time as string) : undefined;
    const account = values.account ? (values.account as string).trim() : undefined;

    if (account) {
      const targetLot = engine.getLot(lotId);
      if (targetLot && targetLot.account_id !== engine.resolveAccountFilter(account)) {
        throw new Error(`批次账户不匹配：批次 ${lotId} 属于账户 ${targetLot.account_id}，而非指定的 ${account}`);
      }
    }

    const [updatedLot, trade] = engine.closeLot(lotId, price, qty, substituteCore, fee, time, reason);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: updatedLot.lot_id,
          account_id: updatedLot.account_id,
          trade_id: trade.trade_id,
          action: trade.action,
          close_price: trade.price,
          close_quantity: trade.quantity,
          fee: trade.fee,
          realized_pnl: trade.realized_pnl,
          reason: trade.reason ?? null,
          buy_reason: updatedLot.buy_reason ?? null,
          close_reason: updatedLot.close_reason ?? null,
          remaining_quantity: updatedLot.remaining_quantity,
          lot_status: updatedLot.status,
          is_day_trading: updatedLot.is_day_trading,
          substituted_core_lot_id: updatedLot.substituted_core_lot_id,
        },
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      const isPartial = updatedLot.remaining_quantity > 0;
      console.log(`🎉 批次${isPartial ? "部分" : "全额"}平仓操作成功！流水号: ${trade.trade_id}`);
      console.log(`批次ID: ${updatedLot.lot_id} | 账户: ${updatedLot.account_id} | 当前状态: ${updatedLot.status}`);
      console.log(`平仓成交价: ${trade.price.toFixed(4)} 元 | 本次平仓股数: ${trade.quantity} 股 | 规费: ${trade.fee.toFixed(2)} 元`);
      console.log(`本次实现净利润: ${(trade.realized_pnl >= 0 ? "+" : "")}${formatCurrency(trade.realized_pnl)} 元`);
      if (updatedLot.is_day_trading) {
        console.log(`⚡ [日内等效T+0回转达成] 代冲底仓: ${updatedLot.substituted_core_lot_id || "天然T+0回转"}`);
      }
      if (isPartial) {
        console.log(`剩余持仓股数: ${updatedLot.remaining_quantity} 股 (状态保持 ACTIVE 继续监控)`);
      }
      if (trade.reason) {
        console.log(`平仓理由: ${trade.reason}`);
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 平仓失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleLotEdit(engine: TraderEngine, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: flagsFor("lot edit"),
    allowPositionals: true,
    strict: false,
  });

  const isJson = Boolean(values.json);
  const lotId = (values["lot-id"] as string | undefined) || positionals[0];

  try {
    if (!lotId) {
      throw new Error("Missing required arguments: <lot_id> (or --lot-id)");
    }

    const buyReason = values["buy-reason"] !== undefined ? (values["buy-reason"] as string) : (values.reason as string | undefined);
    const closeReason = values["close-reason"] as string | undefined;

    if (buyReason === undefined && closeReason === undefined) {
      throw new Error("Missing reason: pass --reason <TEXT> (buy thesis) and/or --close-reason <TEXT>");
    }

    const lot = engine.updateLotReason(lotId, {
      buyReason,
      closeReason,
      append: Boolean(values.append),
    });

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            code: 0,
            msg: "success",
            data: {
              lot_id: lot.lot_id,
              account_id: lot.account_id,
              symbol: lot.symbol,
              status: lot.status,
              buy_reason: lot.buy_reason ?? null,
              close_reason: lot.close_reason ?? null,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`✅ 批次 ${lot.lot_id} 决策理由已更新`);
      console.log(`账户: ${lot.account_id} | 标的: ${lot.symbol} | 状态: ${lot.status}`);
      console.log(`买入理由: ${lot.buy_reason || "--"}`);
      console.log(`平仓理由: ${lot.close_reason || "--"}`);
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 更新理由失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleScan(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: flagsFor("scan"),
    strict: false,
  });

  const isJson = Boolean(values.json);
  const account = values.account ? (values.account as string).trim() : undefined;

  // K-05: see `validateScanThresholds` — a typo'd key/value used to silently disarm the alert.
  // The pre-dispatch gate already rejected it before the ledger was opened; this is the same
  // validator applied to the parsed value so the two paths cannot drift.
  const thresholdsResult = validateScanThresholds(values.thresholds);
  if (thresholdsResult.error) reportCliError(isJson, thresholdsResult.error);
  const thresholds = thresholdsResult.thresholds;

  try {
    const signals = await engine.scanSignals(thresholds, undefined, account);

    if (isJson) {
      const sigList = signals.map((s) => ({
        signal_id: s.signal_id,
        signal_type: s.signal_type,
        lot_id: s.lot_id,
        account_id: s.account_id || "DEFAULT",
        symbol: s.symbol,
        trigger_return_rate: s.trigger_return_rate,
        trigger_price: s.trigger_price,
        suggested_action: s.suggested_action,
        payload: s.payload_json ? JSON.parse(s.payload_json) : {},
      }));

      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          total_signals: sigList.length,
          signals: sigList,
        },
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      if (signals.length === 0) {
        console.log("✨ 扫描完成：当前所有活跃批次运行正常，未触及加仓或止盈阈值。");
        return;
      }

      console.log(`🎯 盘中扫描完成，共捕获 ${signals.length} 条策略建议信号：`);
      console.log("=".repeat(80));
      for (const s of signals) {
        const payload = s.payload_json ? JSON.parse(s.payload_json) : {};
        console.log(`【${s.signal_type}】[账户: ${s.account_id || "DEFAULT"}] 标的: ${s.symbol} | 批次: ${s.lot_id}`);
        console.log(`当前价格: ${s.trigger_price.toFixed(4)} | 收益率: ${formatRate(s.trigger_return_rate)}`);
        console.log(`建议动作: ${s.suggested_action}`);
        if (payload.reason) {
          console.log(`决策依据: ${payload.reason}`);
        }
        if (payload.est_profit !== undefined) {
          console.log(`预期收益: +${formatCurrency(payload.est_profit)} 元`);
        }
        console.log("-".repeat(80));
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 扫描信号失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handleStats(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: flagsFor("stats"),
    strict: false,
  });

  const isJson = Boolean(values.json);
  // K-04: see `validateStatsDays` — `NaN`/negative/zero/decimal used to silently empty the
  // report while exiting 0. The pre-dispatch gate already rejected it before the ledger was
  // opened; this is the same validator applied to the parsed value so the two cannot drift.
  const daysResult = validateStatsDays(values.days);
  if (daysResult.error) reportCliError(isJson, daysResult.error);
  const days = daysResult.days;
  const symbol = values.symbol as string | undefined;
  const account = values.account ? (values.account as string).trim() : undefined;

  try {
    const stats = engine.computeStats(days, symbol, account);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: stats,
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log("📊 操盘战绩统计报表 (多维归因)");
      console.log("=".repeat(50));
      console.log(`总平仓笔数: ${String(stats.total_trades).padStart(6)} 笔`);
      console.log(`盈利笔数  : ${String(stats.winning_trades).padStart(6)} 笔`);
      console.log(`亏损笔数  : ${String(stats.losing_trades).padStart(6)} 笔`);
      console.log(`综合胜率  : ${(stats.win_rate * 100).toFixed(2).padStart(6)} %`);
      const pnlPrefix = stats.total_realized_pnl >= 0 ? "+" : "";
      console.log(`累计净利润: ${(pnlPrefix + formatCurrency(stats.total_realized_pnl)).padStart(12)} 元`);
      console.log(`盈亏比    : ${stats.profit_factor.toFixed(2).padStart(6)}`);
      console.log(`日内做T笔数: ${String(stats.day_trades_count).padStart(5)} 笔`);
      console.log("-".repeat(50));

      console.log("📌 按操盘类型归因:");
      const types = [
        ["普通波段", stats.by_trade_type.regular_swing],
        ["天然 T+0", stats.by_trade_type.native_t0],
        ["底仓代冲做T", stats.by_trade_type.core_substitution_t0],
      ] as const;

      for (const [tName, attr] of types) {
        const pPrefix = attr.total_realized_pnl >= 0 ? "+" : "";
        console.log(`  [${tName.padEnd(8)}] 笔数: ${String(attr.total_trades).padStart(3)} | 胜率: ${(attr.win_rate * 100).toFixed(1).padStart(5)}% | 净利: ${(pPrefix + formatCurrency(attr.total_realized_pnl)).padStart(10)} 元 | 盈亏比: ${attr.profit_factor.toFixed(2)}`);
      }

      if (Object.keys(stats.by_symbol).length > 0) {
        console.log("-".repeat(50));
        console.log("📌 按标的明细归因:");
        for (const [sym, attr] of Object.entries(stats.by_symbol)) {
          const pPrefix = attr.total_realized_pnl >= 0 ? "+" : "";
          console.log(`  [${sym.padEnd(10)}] 笔数: ${String(attr.total_trades).padStart(3)} | 胜率: ${(attr.win_rate * 100).toFixed(1).padStart(5)}% | 净利: ${(pPrefix + formatCurrency(attr.total_realized_pnl)).padStart(10)} 元 | 盈亏比: ${attr.profit_factor.toFixed(2)}`);
        }
      }
      console.log("=".repeat(50));
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 统计战绩失败: ${err.message}`);
    }
    process.exit(1);
  }
}


async function handlePhysics(engine: TraderEngine, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: flagsFor("physics"),
    allowPositionals: true,
    strict: false,
  });

  const isJson = Boolean(values.json);
  let symbolInput = values.symbol as string | undefined;
  if (!symbolInput && positionals.length > 0) {
    symbolInput = positionals[0];
  }

  if (!symbolInput) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: "Missing required parameter: <symbol>", data: null }));
    } else {
      console.error("❌ 错误: 请指定要分析的标的代码，例如: trade physics 600519 或 trade physics 518880.SH");
    }
    process.exit(1);
  }

  const [stdSymbol, tcCode] = normalizeSymbol(symbolInput);

  try {
    // 1. Fetch real-time quote for latest price & name
    const quoteMap = await engine.quoteProvider.getQuotes([stdSymbol]);
    const quote = quoteMap[stdSymbol];
    const name = quote?.name || stdSymbol;
    const currentPrice = quote?.current_price || 0;

    // 2. Fetch daily bars (60 days and 250 days)
    const bars60 = await engine.quoteProvider.getDailyBars(stdSymbol, 60);
    const bars250 = await engine.quoteProvider.getDailyBars(stdSymbol, 250);

    const radar = computePhysicsRadar(stdSymbol, name, bars60, bars250, currentPrice, quote?.turnover_rate);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: radar,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    // ASCII Terminal Radar Card
    console.log("=".repeat(80));
    console.log(`🎯 标的物理运动量化雷达 (Physics Momentum Radar) - ${radar.symbol} (${radar.name})`);
    console.log("=".repeat(80));
    console.log(`最新现价: ${radar.current_price.toFixed(3).padStart(9)} 元 | 历史K线样本: ${String(radar.data_bars_count).padStart(3)} 日 | 数据源: 腾讯财经前复权`);
    console.log("-".repeat(80));

    const vShortSign = radar.v_short >= 0 ? "+" : "";
    const vMidSign = radar.v_mid >= 0 ? "+" : "";
    const aSign = radar.a >= 0 ? "+" : "";
    const fSign = radar.F >= 0 ? "+" : "";

    let brakeDesc = "平稳运行";
    if (radar.brake_status === "ACCELERATING_UP") brakeDesc = "加速上涨 (冲锋)";
    else if (radar.brake_status === "BRAKING_BOTTOM") brakeDesc = "减速筑底 (下坠刹车)";
    else if (radar.brake_status === "ACCELERATING_DOWN") brakeDesc = "加速下坠 (破位风险)";
    else if (radar.brake_status === "BRAKING_TOP") brakeDesc = "冲高减速 (滞涨蓄势)";

    let forceDesc = "多空均衡";
    if (radar.force_status === "STRONG_SUPPORT") forceDesc = "底部强承接托底 (外力显著做多)";
    else if (radar.force_status === "STRONG_RESISTANCE") forceDesc = "上方强抛压阻力 (外力显著做空)";

    console.log(`1. 动量速度 (Velocity v):`);
    console.log(`   • 5日短期动量斜率: ${vShortSign}${radar.v_short.toFixed(2)}% / 日`);
    console.log(`   • 20日中期动量斜率: ${vMidSign}${radar.v_mid.toFixed(2)}% / 日`);

    console.log(`2. 动量加速度 (Acceleration a) & 运行态势:`);
    console.log(`   • 加速度 a: ${aSign}${radar.a.toFixed(2)}% / 日²`);
    console.log(`   • 态势研判: [${radar.brake_status}] ${brakeDesc}`);

    console.log(`3. 惯性质量 (Inertial Mass m) & 多空博弈净合力 (Force F):`);
    console.log(`   • 惯性质量 m (当日成交/20日均量): ${radar.m.toFixed(2)}x`);
    console.log(`   • 多空合力 F (F = m × a): ${fSign}${radar.F.toFixed(2)} [${radar.force_status}] ${forceDesc}`);

    const effSign = radar.effective_force >= 0 ? "+" : "";
    const tauText = radar.turnover_rate > 0 ? `${radar.turnover_rate.toFixed(2)}%` : "不可用 (数据源缺失)";
    let confDesc = "正常博弈中枢 (参与度居中)";
    let confFlag = "";
    if (radar.confidence_level === "LOW") {
      confDesc = "参与度不足，警惕无量虚火";
      if (Math.abs(radar.F) >= 0.5) confFlag = " ⚠ 原始合力强但参与度低，结论待换手放大确认";
    } else if (radar.confidence_level === "HIGH") {
      confDesc = "天量对决，高确定性合力";
      confFlag = " ✅ 放量真变盘";
    }
    console.log(`4. 博弈参与度与合力置信度 (Participation τ & Confidence-Weighted Force):`);
    console.log(`   • 当日换手率 τ: ${tauText}`);
    console.log(`   • 置信度加权系数 W_conf: ${radar.confidence_weight.toFixed(2)}x  |  置信等级: [${radar.confidence_level}] ${confDesc}${confFlag}`);
    console.log(`   • 有效置信合力 F_eff = F × W_conf: ${effSign}${radar.effective_force.toFixed(2)}  (原始合力 F = ${fSign}${radar.F.toFixed(2)})`);

    console.log(`5. 流体阻尼与筹码承接 (Fluid Damping μ):`);
    console.log(`   • 阻尼系数 μ: ${radar.mu.toLocaleString("en-US", { maximumFractionDigits: 0 })} (单位振幅消耗量能密度)`);

    console.log(`6. 周期空间位置与区间回撤:`);
    console.log(`   • 60日空间位置: 分位数 ${radar.pct_rank_60.toFixed(1)}% | 距区间高点回撤: ${radar.pullback_60.toFixed(2)}% (区间: ${radar.min_60.toFixed(3)} ~ ${radar.max_60.toFixed(3)})`);
    console.log(`   • 250日空间位置: 分位数 ${radar.pct_rank_250.toFixed(1)}% | 距年线高点回撤: ${radar.pullback_250.toFixed(2)}% (区间: ${radar.min_250.toFixed(3)} ~ ${radar.max_250.toFixed(3)})`);
    console.log("=".repeat(80));
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 物理雷达分析失败: ${err.message}`);
    }
    process.exit(1);
  }
}

async function handlePosition(engine: TraderEngine, args: string[]): Promise<void> {
  // Support 'trade position list' or direct 'trade position'
  let actualArgs = args;
  if (actualArgs.length > 0 && actualArgs[0] === "list") {
    actualArgs = actualArgs.slice(1);
  }

  const { values } = parseArgs({
    args: actualArgs,
    options: flagsFor("position"),
    strict: false,
  });

  const isJson = Boolean(values.json);
  const symbol = values.symbol as string | undefined;
  const capIsAlias = values.cap !== undefined;
  const capStr = (values.cap as string) || (values["full-position-cap"] as string);
  const capResult = validateCap(capStr, capIsAlias ? "--cap" : "--full-position-cap");
  if (capResult.error) reportCliError(isJson, capResult.error);
  const customCap = capResult.cap;
  const account = values.account ? (values.account as string).trim() : undefined;

  try {
    const view = await engine.getHierarchicalPositionView(symbol, undefined, customCap, account);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: view,
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      if (view.targets.length === 0) {
        console.log(`暂无持仓标的数据 (symbol=${symbol || "None"}, account=${account || "All"})`);
        return;
      }

      const summary = view.portfolio_summary;
      const pnlPrefix = summary.total_floating_pnl >= 0 ? "+" : "";

      console.log("=".repeat(120));
      console.log(`💼 投资组合总览 (Portfolio Summary)${account ? ` [账户: ${account}]` : ""}`);
      console.log("=".repeat(120));
      console.log(`总持仓成本: ${formatCurrency(summary.total_cost).padStart(12)} 元 | 单标满仓额度: ${formatCurrency(summary.full_position_cap).padStart(10)} 元 | 持仓标的数: ${String(summary.total_symbols_count).padStart(3)} 个`);
      console.log(`总持仓市值: ${formatCurrency(summary.total_market_value).padStart(12)} 元 | 组合总盈亏额: ${(pnlPrefix + formatCurrency(summary.total_floating_pnl)).padStart(10)} 元 | 组合收益率: ${formatRate(summary.overall_return_rate).padStart(8)}`);
      console.log(`活跃买入批次: ${String(summary.total_active_lots).padStart(10)} 笔`);
      console.log("=".repeat(120));

      for (let idx = 0; idx < view.targets.length; idx++) {
        const t = view.targets[idx];
        const tPnlPrefix = t.total_floating_pnl >= 0 ? "+" : "";

        console.log(`\n[${idx + 1}] 标的: ${t.symbol} (${t.name})  |  资产类别: ${t.asset_class}  |  交易机制: ${t.settlement_mode}`);
        console.log("-".repeat(120));
        console.log(`  最新现价: ${t.current_price.toFixed(3)} 元  |  总持股数: ${t.total_quantity} 股  |  可用底仓: ${t.available_core_qty} 股  |  持仓成本均价: ${t.avg_cost_price.toFixed(3)} 元`);
        console.log(`  持仓总成本: ${formatCurrency(t.total_cost_basis)} 元  |  持仓总市值: ${formatCurrency(t.market_value)} 元  |  浮动盈亏: ${tPnlPrefix}${formatCurrency(t.total_floating_pnl)} 元 (${formatRate(t.overall_return_rate)})`);
        console.log(`  成本仓位比: ${(t.cost_position_rate * 100).toFixed(2)}%  |  当前市值仓位: ${(t.current_position_rate * 100).toFixed(2)}%  |  组合市值占比: ${(t.portfolio_weight * 100).toFixed(2)}%`);
        console.log(`  最近买入价: ${t.last_buy_price > 0 ? t.last_buy_price.toFixed(3) + " 元" : "无"}  |  建议加仓区间: < ${t.recommended_buy_in_point.toFixed(3)} (-10%)  |  建议止盈区间: > ${t.recommended_sale_out_point.toFixed(3)} (+10%)`);
        if (t.physics) {
          const p = t.physics;
          const v5Sign = p.v_short >= 0 ? "+" : "";
          const aSign = p.a >= 0 ? "+" : "";
          const effSign = p.effective_force >= 0 ? "+" : "";
          const tauText = p.turnover_rate > 0 ? `τ=${p.turnover_rate.toFixed(2)}%` : "τ=缺失";
          console.log(`  物理动量走势: 速度v(5d)=${v5Sign}${p.v_short.toFixed(2)}% | 加速度a=${aSign}${p.a.toFixed(2)}% [${p.brake_status}] | 质量m=${p.m.toFixed(2)}x | 合力F=${p.F.toFixed(2)} [${p.force_status}] → 有效合力F_eff=${effSign}${p.effective_force.toFixed(2)} [${p.confidence_level}] | 换手${tauText} × W_conf=${p.confidence_weight.toFixed(2)} | 阻尼μ=${p.mu.toFixed(0)}`);
        }

        if (t.lots.length > 0) {
          console.log(`  └─ 下属活跃批次明细 (共 ${t.lots.length} 笔):`);
          const subHeader = `     ${"Lot ID".padEnd(19)} | ${"Account".padEnd(10)} | ${"Buy Date".padEnd(10)} | ${"Buy Price".padStart(9)} | ${"Unit Cost".padStart(9)} | ${"Qty".padStart(6)} | ${"Return%".padStart(8)} | ${"Float PnL".padStart(10)} | ${"Can Sell".padEnd(8)} | ${"Action Advice".padEnd(12)}`;
          const subSep = "     " + "-".repeat(subHeader.length - 5);
          console.log(subSep);
          console.log(subHeader);
          console.log(subSep);

          for (const l of t.lots) {
            let advice = "[持仓观察]";
            if (l.trailing_stop_active) {
              advice = "[跟踪止盈]";
            } else if (l.return_rate >= 0.10) {
              advice = "[可止盈]";
            } else if (l.return_rate <= -0.20) {
              advice = "[深跌击球]";
            } else if (l.return_rate <= -0.10) {
              advice = `[可加仓${l.pyramid_level + 1}]`;
            }

            const lPnlStr = (l.floating_pnl >= 0 ? "+" : "") + formatCurrency(l.floating_pnl);
            const dateStr = l.buy_time.slice(0, 10);
            const canSellStr = l.can_sell_now ? "即刻可卖" : "T+1冻结";

            const idCol = l.lot_id.padEnd(19);
            const accCol = (l.account_id || "DEFAULT").padEnd(10);
            const dateCol = dateStr.padEnd(10);
            const bPriceCol = l.buy_price.toFixed(3).padStart(9);
            const costCol = l.cost_basis_unit.toFixed(3).padStart(9);
            const qtyCol = String(l.remaining_quantity).padStart(6);
            const retCol = formatRate(l.return_rate).padStart(8);
            const pnlCol = lPnlStr.padStart(10);
            const sellCol = canSellStr.padEnd(8);
            const advCol = advice.padEnd(12);

            console.log(`     ${idCol} | ${accCol} | ${dateCol} | ${bPriceCol} | ${costCol} | ${qtyCol} | ${retCol} | ${pnlCol} | ${sellCol} | ${advCol}`);
          }
          console.log(subSep);
        }
      }
      console.log("\n" + "=".repeat(120));
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ code: 1, msg: err.message, data: null }));
    } else {
      console.error(`❌ 查询持仓视图失败: ${err.message}`);
    }
    process.exit(1);
  }
}

export 
function printDividendHelp(): void {
  console.log(`usage: trade dividend [-h] {add,list} ...

Dividend Operations (Cash Dividends Management)

positional arguments:
  {add,list}        Dividend actions
    add             Record a cash dividend
    list            List cash dividends

options:
  -h, --help        show this help message and exit

Global options:
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
`);
}

async function handleDividend(engine: TraderEngine, args: string[]): Promise<void> {
  const subAction = args[0];
  const restArgs = args.slice(1);

  if (!subAction || subAction === "-h" || subAction === "--help") {
    printDividendHelp();
    return;
  }

  if (subAction === "add") {
    const { values } = parseArgs({
      args: restArgs,
      options: flagsFor("dividend add"),
      strict: false,
    });

    const isJson = Boolean(values.json);
    if (!values.symbol || !values.amount) {
      if (isJson) {
        console.error(JSON.stringify({ code: 1, msg: "Missing required --symbol or --amount" }));
      } else {
        console.error("❌ 错误: 录入分红必须指定 --symbol 和 --amount 参数。");
      }
      process.exit(1);
    }

    // round-4: the money/share operands go through the same literal layer as every other numeric
    // flag (`--amount 1,000` used to be recorded as 1 元, `--per-share 0,05` as 0).
    const divAmountResult = validateAmount(values.amount);
    if (divAmountResult.error) reportCliError(isJson, divAmountResult.error);
    const divSharesResult = validateShares(values.shares);
    if (divSharesResult.error) reportCliError(isJson, divSharesResult.error);
    const divPerShareResult = validatePerShare(values["per-share"]);
    if (divPerShareResult.error) reportCliError(isJson, divPerShareResult.error);

    try {
      const div = engine.addDividend({
        symbol: values.symbol as string,
        amount: divAmountResult.amount!,
        exDate: values.date as string | undefined,
        accountId: values.account as string | undefined,
        sharesCount: divSharesResult.shares,
        dividendPerShare: divPerShareResult.perShare,
        notes: values.notes as string | undefined,
      });

      if (isJson) {
        console.log(JSON.stringify({ code: 0, msg: "success", data: div }, null, 2));
      } else {
        console.log(`🎉 现金分红录入成功！流水号: ${div.dividend_id}`);
        console.log(`标的: ${div.symbol} | 账户: ${div.account_id} | 到账金额: ¥${div.amount.toFixed(2)} | 除息日: ${div.ex_date}`);
        if (div.notes) console.log(`备注: ${div.notes}`);
      }
    } catch (err: any) {
      if (isJson) {
        console.error(JSON.stringify({ code: 1, msg: err.message }));
      } else {
        console.error(`❌ 错误: ${err.message}`);
      }
      process.exit(1);
    }
  } else if (subAction === "list") {
    const { values } = parseArgs({
      args: restArgs,
      options: flagsFor("dividend list"),
      strict: false,
    });

    const isJson = Boolean(values.json);
    const divs = engine.getDividends({
      symbol: values.symbol as string | undefined,
      accountId: values.account as string | undefined,
    });
    const totalAmount = engine.getTotalDividends(
      values.symbol as string | undefined,
      values.account as string | undefined
    );

    if (isJson) {
      console.log(JSON.stringify({
        code: 0,
        msg: "success",
        data: {
          total_amount: totalAmount,
          dividends: divs,
        }
      }, null, 2));
    } else {
      console.log(`💰 现金分红流水记录 (共 ${divs.length} 笔，累计分红: ¥${totalAmount.toFixed(2)})`);
      console.log("-".repeat(95));
      console.log(
        "Dividend ID".padEnd(24) + " | " +
        "Symbol".padEnd(10) + " | " +
        "Account".padEnd(8) + " | " +
        "Ex-Date".padEnd(10) + " | " +
        "Amount (元)".padStart(12) + " | " +
        "Notes"
      );
      console.log("-".repeat(95));
      for (const d of divs) {
        console.log(
          d.dividend_id.padEnd(24) + " | " +
          d.symbol.padEnd(10) + " | " +
          d.account_id.padEnd(8) + " | " +
          d.ex_date.padEnd(10) + " | " +
          d.amount.toFixed(2).padStart(12) + " | " +
          (d.notes || "--")
        );
      }
      console.log("-".repeat(95));
    }
  } else {
    printDividendHelp();
    process.exit(1);
  }
}

function printConfigHelp(): void {
  console.log(`usage: trade config [-h] {get,set,list} ...

Configuration Management

positional arguments:
  {get,set,list}    Config actions
    get             Get a configuration value
    set             Set a configuration value
    list            List all configuration settings

options:
  -h, --help        show this help message and exit

Examples:
  trade config list
  trade config get full_position_cap
  trade config set full_position_cap 100000
`);
}

function handleConfig(args: string[]): void {
  const subAction = args[0];
  const restArgs = args.slice(1);

  if (!subAction || subAction === "-h" || subAction === "--help") {
    printConfigHelp();
    return;
  }

  if (subAction === "list") {
    const { loadConfig, getConfigSchema } = require("./config.ts");
    const config = loadConfig();
    const schema = getConfigSchema();
    
    console.log("=".repeat(80));
    console.log("配置文件: ~/.lot-trader/config.json");
    console.log("=".repeat(80));
    
    for (const [key, description] of Object.entries(schema)) {
      const value = config[key as keyof typeof config];
      const displayValue = value !== undefined ? String(value) : "<未设置>";
      console.log(`${key}:`);
      console.log(`  值: ${displayValue}`);
      console.log(`  说明: ${description}`);
      console.log();
    }
    
  } else if (subAction === "get") {
    const key = restArgs[0];
    if (!key) {
      console.error("❗ 错误: 请指定要查询的配置项");
      console.error("示例: trade config get full_position_cap");
      process.exit(1);
    }
    
    const { getConfigValue, getConfigSchema } = require("./config.ts");
    const schema = getConfigSchema();
    
    if (!(key in schema)) {
      console.error(`❗ 错误: 未知的配置项 '${key}'`);
      console.error("可用的配置项:");
      for (const k of Object.keys(schema)) {
        console.error(`  - ${k}`);
      }
      process.exit(1);
    }
    
    const value = getConfigValue(key);
    if (value !== undefined) {
      console.log(value);
    } else {
      console.log("<未设置>");
    }
    
  } else if (subAction === "set") {
    const key = restArgs[0];
    const value = restArgs[1];
    
    if (!key || value === undefined) {
      console.error("❗ 错误: 请指定要设置的配置项和值");
      console.error("示例: trade config set full_position_cap 100000");
      process.exit(1);
    }
    
    const { setConfigValue, getConfigSchema } = require("./config.ts");
    const schema = getConfigSchema();
    
    if (!(key in schema)) {
      console.error(`❗ 错误: 未知的配置项 '${key}'`);
      console.error("可用的配置项:");
      for (const k of Object.keys(schema)) {
        console.error(`  - ${k}`);
      }
      process.exit(1);
    }
    
    // Parse value based on key type
    let parsedValue: any = value;
    if (key === "full_position_cap" || key === "fee_rate") {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue) || parsedValue <= 0) {
        console.error(`❗ 错误: ${key} 必须是一个正数`);
        process.exit(1);
      }
    }
    
    setConfigValue(key, parsedValue);
    console.log(`✅ 配置已保存: ${key} = ${parsedValue}`);
    
  } else {
    printConfigHelp();
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // `--db <path>` is a GLOBAL option: it is extracted from wherever it appears in argv — even
  // before the subcommand token — and stripped before dispatch, so it can never be swallowed as
  // a positional argument. Precedence: --db > $LOT_TRADER_DB > $TRADE_DB_PATH > ~/.trade/trade.db.
  const { value: explicitDbArg, rest: argv } = extractGlobalOption(rawArgs, "db");
  const explicitDb = (explicitDbArg ?? "").trim() || undefined;
  const resolvedDbPath = resolveCliDbPath(explicitDb);

  if (argv.length === 0 || isHelpToken(argv[0])) {
    printHelp();
    process.exit(0);
  }

  const command = argv[0];
  const restArgs = argv.slice(1);

  // ==== UNDECLARED-FLAG GATE ============================================================
  // Runs BEFORE `getEngine()` is ever called, so a typo'd flag can never create/migrate/WAL the
  // ledger, let alone write a row. `-h` / `--help` stays a pure no-op and is exempt.
  if (!hasHelpFlag(argv)) {
    const commandPath = resolveCommandPath(argv);
    if (commandPath) {
      const offender = findUndeclaredFlag(commandPath, restArgs);
      if (offender) {
        reportCliError(
          wantsJsonOutput(restArgs),
          `未声明的参数 ${offender}（命令: trade ${commandPath}）。运行 'trade ${commandPath} --help' 查看支持的参数。`,
        );
      }
      const valueError = findFlagValueError(commandPath, restArgs);
      if (valueError) {
        reportCliError(wantsJsonOutput(restArgs), valueError);
      }
    }
  }

  // The ledger is opened LAZILY, and only by the subcommands that truly need it. Constructing
  // `AppDatabase` eagerly here used to mkdir + create + WAL the ledger before a single argument
  // was inspected: `trade scan --help` silently created ~/.trade/trade.db and even wrote
  // derived rows into `signals`.
  let db: AppDatabase | null = null;
  let engine: TraderEngine | null = null;
  const getEngine = (): TraderEngine => {
    if (!engine) {
      db = new AppDatabase(resolvedDbPath);
      engine = new TraderEngine(db.getConnection());
    }
    return engine;
  };
  const closeDb = (): void => {
    db?.close();
    db = null;
    engine = null;
  };

  // ==== ZERO-LEDGER-TOUCH HELP GUARDS ====================================================
  // Every `-h` / `--help` (top level, first level and second level) prints usage and exits 0
  // BEFORE getEngine() is ever called. Nothing here may open, create, migrate or WAL a
  // database file.

  // The dashboard primitive renders from the ledger directly; it needs no engine instance.
  // It brings its own (explicit) `--db` handle, so it must never open the default ledger.
  if (command === "dashboard") {
    if (hasHelpFlag(restArgs)) {
      printDashboardHelp();
      process.exit(0);
    }
    await handleDashboard(restArgs, explicitDb);
    return;
  }

  // The local HTTP engine owns its own database handle (it may bind a different --db path).
  if (command === "serve") {
    if (hasHelpFlag(restArgs)) {
      printServeHelp();
      process.exit(0);
    }
    await handleServe(restArgs, explicitDb);
    return;
  }

  if (command === "lot") {
    const subCmd = restArgs[0];
    if (subCmd === undefined || isHelpToken(subCmd)) {
      printLotHelp();
      process.exit(0);
    }
    if (hasHelpFlag(restArgs.slice(1))) {
      printLotSubcommandHelp(subCmd);
      process.exit(0);
    }
    const subArgs = restArgs.slice(1);
    if (subCmd === "buy") {
      await handleLotBuy(getEngine(), subArgs);
    } else if (subCmd === "add") {
      await handleLotAdd(getEngine(), subArgs);
    } else if (subCmd === "list") {
      await handleLotList(getEngine(), subArgs);
    } else if (subCmd === "close") {
      await handleLotClose(getEngine(), subArgs);
    } else if (subCmd === "edit") {
      await handleLotEdit(getEngine(), subArgs);
    } else {
      printLotHelp();
      process.exit(1);
    }
  } else if (command === "account") {
    const subAction = restArgs[0];
    if (subAction === undefined || isHelpToken(subAction) || hasHelpFlag(restArgs.slice(1))) {
      printAccountHelp();
      process.exit(0);
    }
    if (subAction !== "list" && subAction !== "add") {
      printAccountHelp();
      process.exit(1);
    }
    await handleAccount(getEngine(), restArgs);
  } else if (command === "position") {
    if (hasHelpFlag(restArgs)) {
      printPositionHelp();
      process.exit(0);
    }
    await handlePosition(getEngine(), restArgs);
  } else if (command === "scan") {
    if (hasHelpFlag(restArgs)) {
      printScanHelp();
      process.exit(0);
    }
    await handleScan(getEngine(), restArgs);
  } else if (command === "stats") {
    if (hasHelpFlag(restArgs)) {
      printStatsHelp();
      process.exit(0);
    }
    await handleStats(getEngine(), restArgs);
  } else if (command === "physics" || command === "radar") {
    if (hasHelpFlag(restArgs)) {
      printPhysicsHelp();
      process.exit(0);
    }
    await handlePhysics(getEngine(), restArgs);
  } else if (command === "dividend") {
    const subAction = restArgs[0];
    if (subAction === undefined || isHelpToken(subAction)) {
      printDividendHelp();
      process.exit(0);
    }
    if (hasHelpFlag(restArgs.slice(1))) {
      printDividendSubcommandHelp(subAction);
      process.exit(0);
    }
    if (subAction !== "add" && subAction !== "list") {
      printDividendHelp();
      process.exit(1);
    }
    await handleDividend(getEngine(), restArgs);
  } else if (command === "config") {
    if (hasHelpFlag(restArgs)) {
      printConfigHelp();
      process.exit(0);
    }
    handleConfig(restArgs);
  } else {
    printHelp();
    process.exit(1);
  }

  closeDb();
}

if (import.meta.main) {
  main();
}
