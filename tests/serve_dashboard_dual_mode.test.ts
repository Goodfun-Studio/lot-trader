/**
 * Dual-mode dashboard test matrix.
 *
 * Three layers, all of them negative-path first:
 *  1. `trade serve` HTTP contract  — health / summary / lots, loopback-only, readable port conflict.
 *  2. Generated dashboard contract — the template + the rendered HTML really carry the dual-mode runtime.
 *  3. Front-end runtime guards     — dead network, garbage quote payloads, closed local engine.
 *                                    Driven through a deterministic DOM/timer sandbox so a missing
 *                                    service or a 502 body can never paint NaN, blank the page, or
 *                                    raise an uncaught exception.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  DEFAULT_TOKEN_FILE,
  LOOPBACK_HOSTS,
  TOOL_VERSION,
  PriceBook,
  buildLotsPayload,
  buildSummaryPayload,
  createRequestHandler,
  extractRequestToken,
  formatPortConflictError,
  generateSessionToken,
  isAllowedHostHeader,
  isAllowedOrigin,
  isSensitiveRoute,
  isTokenAuthorized,
  assessLedgerHealth,
  normalizeAccountKey,
  readLedgerLots,
  readSessionTokenFile,
  resolveAllowedOrigin,
  resolveFullPositionCap,
  resolveServeDbPath,
  resolveServeHost,
  resolveServePort,
  startServe,
  writeSessionTokenFile,
} from "../src/serve.ts";
import { AppDatabase } from "../src/db.ts";
import { QuoteProvider } from "../src/quotes.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const templatePath = join(repoRoot, "scripts", "template_base.html");

// Every in-process `trade serve` publishes a 0600 credential file. Point the default at a
// throwaway dir so the suite never touches the owner's real ~/.lot-trader/session.token.
const tokenRoot = mkdtempSync(join(tmpdir(), "dual_tokens_"));
const defaultTokenFile = join(tokenRoot, "session.token");
process.env.LOT_TRADER_TOKEN_FILE = defaultTokenFile;

afterAll(() => {
  rmSync(tokenRoot, { recursive: true, force: true });
});

/**
 * Local API fetch that carries the session credential.
 * `token === null` => deliberately unauthenticated (every negative test uses this).
 */
function apiGet(
  srv: { url: string; token?: string },
  path: string,
  init: RequestInit = {},
  token: string | null | undefined = srv.token,
): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${srv.url}${path}`, { ...init, headers });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tempDbPath(tag: string): string {
  const dir = join(tmpdir(), `dual_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "ledger.db");
}

/** Seed a two-account ledger so every aggregate has something real to sum. */
function seedLedger(dbPath: string): void {
  const db = new AppDatabase(dbPath);
  const conn = db.getConnection();
  conn.run(
    `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
     VALUES ('LOT-GOLD', 'DEFAULT', '518880.SH', '2025-01-02T09:30:00', 6.10, 1000, 1000, 6.10, 'ACTIVE')`,
  );
  conn.run(
    `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
     VALUES ('LOT-GOLD2', 'DEFAULT', '518880.SH', '2025-01-03T09:30:00', 6.20, 500, 500, 6.20, 'ACTIVE')`,
  );
  conn.run(
    `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
     VALUES ('LOT-NAS', 'ACC2', '159934.SZ', '2025-02-03T09:30:00', 7.00, 800, 800, 7.00, 'ACTIVE')`,
  );
  conn.run(
    `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status, close_time, close_avg_price, realized_pnl)
     VALUES ('LOT-CLOSED', 'ACC2', '159934.SZ', '2025-01-10T09:30:00', 6.50, 300, 0, 6.50, 'CLOSED', '2025-01-20T09:30:00', 7.00, 149.37)`,
  );
  conn.run(
    `INSERT INTO trades (trade_id, account_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at)
     VALUES ('TR-1', 'ACC2', 'LOT-CLOSED', 'SELL_REGULAR', 7.00, 300, 0.42, 149.37, '2025-01-20T09:30:00')`,
  );
  db.close();
}

/**
 * Materialize a schema-only ledger file (no lots). `trade serve` is read-only and refuses to
 * create a missing database, so every negative/empty-book fixture must exist on disk first.
 */
function createEmptyLedger(dbPath: string): void {
  const db = new AppDatabase(dbPath);
  db.close();
}

function assertNoNaN(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  expect(text.includes("NaN"), `${label} must not contain NaN`).toBe(false);
  expect(text.includes("Infinity"), `${label} must not contain Infinity`).toBe(false);
}

function everyNumberFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(everyNumberFinite);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(everyNumberFinite);
  }
  return true;
}

/** Deterministic DOM/timer sandbox: no real timers, no browser, no flakiness. */
interface SandboxElement {
  id: string;
  tag: string;
  textContent: string;
  className: string;
  title: string;
  innerHTML: string;
  style: Record<string, string>;
  offsetWidth: number;
  attrs: Record<string, string>;
  children: Record<string, SandboxElement>;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string): void };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): SandboxElement | null;
  closest(selector: string): SandboxElement | null;
  appendChild(child: SandboxElement): SandboxElement;
  removeChild(child: SandboxElement): void;
  select(): void;
}

function makeElement(id: string, tag = "div"): SandboxElement {
  const classes = new Set<string>();
  const el: SandboxElement = {
    id,
    tag,
    textContent: "",
    className: "",
    title: "",
    innerHTML: "",
    style: {},
    offsetWidth: 1,
    attrs: {},
    children: {},
    classList: {
      add(c) {
        classes.add(c);
      },
      remove(c) {
        classes.delete(c);
      },
      contains(c) {
        return classes.has(c);
      },
      toggle(c) {
        if (classes.has(c)) classes.delete(c);
        else classes.add(c);
      },
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    querySelector(selector) {
      if (Object.prototype.hasOwnProperty.call(el.children, selector)) return el.children[selector];
      const field = selector.match(/^\[data-field="(.+)"\]$/);
      if (field) {
        const child = makeElement(`${id}:${field[1]}`, "strong");
        el.children[selector] = child;
        return child;
      }
      return null;
    },
    closest() {
      return el;
    },
    appendChild(child) {
      el.children[`#child-${Object.keys(el.children).length}`] = child;
      return child;
    },
    removeChild() {},
    select() {},
  };
  return el;
}

interface Harness {
  sandbox: Record<string, any>;
  hooks: Record<string, any>;
  cards: SandboxElement[];
  holdingRows: SandboxElement[];
  lotRows: SandboxElement[];
  timers: Array<{ id: number; fn: () => void; ms: number; repeat: boolean }>;
  errors: string[];
  rejections: string[];
  fetchCalls: string[];
  fetchInits: Array<{ url: string; init: any }>;
  runTimers(msFilter?: number): void;
  settle<T = any>(promise: Promise<T> | any): Promise<T>;
  element(id: string): SandboxElement;
  allText(): string;
  stop(): void;
}

const RUNTIME_SCRIPT_ID = "live-client-runtime";

function extractRuntimeScript(html: string): string {
  const match = html.match(new RegExp(`<script id="${RUNTIME_SCRIPT_ID}">([\\s\\S]*?)</script>`));
  if (!match) throw new Error("live-client-runtime script not found in template");
  return match[1];
}

/** The dashboard's own inline script = everything after the embedded-data marker (minus runtime). */
function extractDashboardScript(html: string): string {
  const marker = "<!-- Embedded Client-side Data -->";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("embedded-data marker not found in template");
  const rest = html.slice(start);
  const open = rest.indexOf("<script>");
  const close = rest.lastIndexOf("</script>");
  if (open < 0 || close < 0) throw new Error("dashboard script block not found");
  return rest.slice(open + "<script>".length, close);
}

function fixtureTargets() {
  return {
    "518880.SH": {
      ALL: {
        symbol: "518880.SH",
        name: "黄金ETF",
        shares: 1500,
        cost_unit: 6.1333,
        current_price: 6.6,
        market_value: 9900,
        floating_pnl: 500,
        return_rate: 0.06,
        price_source: "live",
        lots: [
          {
            lot_id: "LOT-GOLD",
            account_id: "DEFAULT",
            status: "ACTIVE",
            qty: 1000,
            cost_unit: 6.1,
            buy_price: 6.1,
            price_now_or_close: 6.6,
            pnl: 480,
            return_rate: 0.08,
            buy_time: "2025-01-02 09:30",
            close_time: null,
            tag: "<span>[持仓观察]</span>",
          },
        ],
      },
      DEFAULT: {
        symbol: "518880.SH",
        name: "黄金ETF",
        shares: 1500,
        cost_unit: 6.1333,
        current_price: 6.6,
        market_value: 9900,
        floating_pnl: 500,
        return_rate: 0.06,
        lots: [],
      },
    },
    "159934.SZ": {
      ALL: {
        symbol: "159934.SZ",
        name: "黄金ETF",
        shares: 800,
        cost_unit: 7.0,
        current_price: 7.2,
        market_value: 5760,
        floating_pnl: 160,
        return_rate: 0.0286,
        lots: [],
      },
    },
  };
}

/** Per-account, per-asset-class pillar payload (mirrors generate_dashboard.py's shape). */
function fixtureAllocClasses() {
  const card = (label: string) => ({
    ratio_str: "50.0%",
    ratio_cls: "val-green",
    desc: `${label} 动态聚合示例`,
    stats_html: '<div>持仓市值: <strong>¥1.00 万元</strong></div>',
  });
  return {
    ALL: { ETF: card("ETF"), STOCK: card("STOCK"), CASH: card("CASH") },
    DEFAULT: { ETF: card("ETF"), STOCK: card("STOCK"), CASH: card("CASH") },
    ACC2: { ETF: card("ETF"), STOCK: card("STOCK"), CASH: card("CASH") },
  };
}

function fixtureMetrics() {
  const base = {
    label: "默认账户",
    short_label: "默认",
    active_syms_count: 1,
    active_lots_count: 1,
    cost_val: 6133.3,
    cost_str: "¥6,133.30",
    mkt_val: 9900,
    mkt_str: "¥9,900.00",
    mkt_w_str: "0.99 万",
    pnl_val: 500,
    pnl_str: "+¥500.00 (8.15%)",
    pnl_cls: "val-green",
    multiple_str: "1.06x",
    closed_trades_count: 0,
    win_trades_count: 0,
    loss_trades_count: 0,
    realized_pnl_val: 0,
    realized_pnl_str: "+¥0.00",
    win_rate_str: "0.00%",
    win_loss_ratio_str: "--",
    dividends_val: 0,
    dividends_str: "+¥0.00",
    withdrawn_val: 0,
    withdrawn_str: "+¥0.00",
    pos_count: 1,
    neg_count: 0,
    pos_sum_str: "+¥0.05万",
    neg_sum_str: "¥0.00万",
    global_pnl_str: "+¥0.05 万",
  };
  return {
    ALL: { ...base, acc: "ALL", label: "全账户合并", short_label: "全账户" },
    DEFAULT: { ...base, acc: "DEFAULT" },
    ACC2: { ...base, acc: "ACC2", label: "第二账户", short_label: "二户" },
  };
}

/**
 * Build a harness running the real dashboard runtime + real dashboard script.
 * `quoteResponse` decides what the (stubbed) external network answers.
 */
function createHarness(options: {
  quoteBody?: string;
  quoteThrows?: boolean;
  quoteMap?: Record<string, string>;
  healthProbe: () => Promise<any> | any;
  summaryBody?: any;
  /** When true /api/summary answers 401 UNAUTHORIZED (stale or missing credential). */
  summaryUnauthorized?: boolean;
}): Harness {
  const template = readFileSync(templatePath, "utf-8");
  const runtimeScript = extractRuntimeScript(template);
  const dashboardScript = extractDashboardScript(template)
    .replace("{{ACCOUNT_METRICS_JSON}}", JSON.stringify(fixtureMetrics()))
    .replace("{{ALLOC_CLASS_METRICS_JSON}}", JSON.stringify(fixtureAllocClasses()))
    .replace("{{TARGET_JS_JSON}}", JSON.stringify(fixtureTargets()))
    .replace(/\{\{[A-Z_]+\}\}/g, "");

  const elements = new Map<string, SandboxElement>();
  const element = (id: string): SandboxElement => {
    let el = elements.get(id);
    if (!el) {
      el = makeElement(id);
      elements.set(id, el);
    }
    return el;
  };

  // pre-create the containers the script inspects with classList / attributes
  const indicator = element("mode-indicator");
  indicator.classList.add("mode-indicator");
  indicator.classList.add("standalone");
  const overlay = element("target-modal-overlay");
  overlay.classList.add("modal-overlay");

  const cards: SandboxElement[] = Object.keys(fixtureTargets()).map((sym) => {
    const card = makeElement(`card-${sym}`, "div");
    card.classList.add("target-card");
    card.setAttribute("data-sym", sym);
    card.setAttribute("data-account", "ALL");
    return card;
  });

  const holdingRows: SandboxElement[] = [
    { sym: "518880.SH", acc: "ALL", cost: 9200, mkt: 9900, pnl: 500, lots: 2, qty: 1500 },
    { sym: "159934.SZ", acc: "ALL", cost: 5600, mkt: 5760, pnl: 160, lots: 1, qty: 800 },
  ].map((row) => {
    const el = makeElement(`hold-${row.sym}`, "tr");
    el.setAttribute("data-symbol", row.sym);
    el.setAttribute("data-account", row.acc);
    el.setAttribute("data-cost-val", String(row.cost));
    el.setAttribute("data-mkt-val", String(row.mkt));
    el.setAttribute("data-pnl-val", String(row.pnl));
    el.setAttribute("data-lots", String(row.lots));
    el.setAttribute("data-qty", String(row.qty));
    return el;
  });

  const lotRows: SandboxElement[] = [
    { sym: "518880.SH", lot: "LOT-GOLD", qty: 1000, cost: 6.1 },
  ].map((row) => {
    const el = makeElement(`lot-${row.lot}`, "tr");
    el.setAttribute("data-symbol", row.sym);
    el.setAttribute("data-lot-id", row.lot);
    el.setAttribute("data-status", "ACTIVE");
    el.setAttribute("data-qty", String(row.qty));
    el.setAttribute("data-cost-unit", String(row.cost));
    return el;
  });

  const timers: Array<{ id: number; fn: () => void; ms: number; repeat: boolean }> = [];
  let timerId = 1;
  const errors: string[] = [];
  const rejections: string[] = [];
  const fetchCalls: string[] = [];
  const fetchInits: Array<{ url: string; init: any }> = [];

  const onRejection = (reason: unknown) => {
    rejections.push(String(reason));
  };
  process.on("unhandledRejection", onRejection);

  const fakeSetTimeout = (fn: () => void, ms: number) => {
    const id = timerId++;
    timers.push({ id, fn, ms: Number(ms) || 0, repeat: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const fakeSetInterval = (fn: () => void, ms: number) => {
    const id = timerId++;
    timers.push({ id, fn, ms: Number(ms) || 0, repeat: true });
    return id as unknown as ReturnType<typeof setInterval>;
  };
  const clearTimer = (id: unknown) => {
    const idx = timers.findIndex((t) => t.id === Number(id));
    if (idx >= 0) timers.splice(idx, 1);
  };

  const quoteMap = options.quoteMap ?? {};

  async function fakeFetch(input: any, init?: any): Promise<any> {
    const url = String(input);
    fetchCalls.push(url);
    fetchInits.push({ url, init: init ?? null });
    if (url.includes("/api/health")) return options.healthProbe();
    if (url.includes("/api/summary")) {
      if (options.summaryUnauthorized) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ status: "error", code: "UNAUTHORIZED", message: "未授权：请提供合法的本地会话 Token。" }),
          text: async () => '{"status":"error","code":"UNAUTHORIZED"}',
        };
      }
      if (!options.summaryBody) throw new Error("summary offline");
      return { ok: true, status: 200, json: async () => options.summaryBody };
    }
    if (url.includes("qt.gtimg.cn")) {
      if (options.quoteThrows) throw new Error("network down");
      const body = options.quoteBody ?? "";
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
        text: async () => body,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }

  const fakeDocument = {
    getElementById: (id: string) => element(id),
    querySelector: () => null,
    querySelectorAll(selector: string) {
      if (selector === '[data-sym]' || selector.startsWith(".target-card")) return cards;
      if (selector.startsWith("#tbody-holdings tr")) return holdingRows;
      if (selector.startsWith("tr[data-lot-id]")) return lotRows;
      if (selector === ".modal-filter-btn" || selector === ".nav-btn" || selector === ".tab-pane") return [];
      return [];
    },
    createElement: (tag: string) => makeElement(`created-${tag}`, tag),
    addEventListener() {},
    head: null as unknown as SandboxElement,
    body: null as unknown as SandboxElement,
    documentElement: null as unknown as SandboxElement,
  };
  document_head: {
    const href = makeElement("head", "head");
    const body = makeElement("body", "body");
    fakeDocument.head = href;
    fakeDocument.body = body;
    fakeDocument.documentElement = href;
  }

  const sandbox: Record<string, any> = {
    document: fakeDocument,
    fetch: fakeFetch,
    setTimeout: fakeSetTimeout,
    clearTimeout: clearTimer,
    setInterval: fakeSetInterval,
    clearInterval: clearTimer,
    console,
    navigator: {},
    location: { href: "file:///tmp/dashboard.html" },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const runtimeFactory = new Function(
    "window",
    "document",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "TextDecoder",
    "AbortController",
    "fetch",
    `${runtimeScript}\n`,
  );
  runtimeFactory(
    sandbox,
    fakeDocument,
    fakeSetTimeout,
    clearTimer,
    fakeSetInterval,
    clearTimer,
    TextDecoder,
    AbortController,
    fakeFetch,
  );

  const scriptFactory = new Function(
    "window",
    "document",
    "LiveClientRuntime",
    "ACCOUNT_METRICS",
    "TARGETS_DATA",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "fetch",
    "console",
    "TextDecoder",
    "AbortController",
    "navigator",
    "location",
    `with (window) { ${dashboardScript} }\nwindow.__hooks = {
       LIVE: typeof LIVE !== 'undefined' ? LIVE : null,
       toggleLiveQuotes: typeof toggleLiveQuotes === 'function' ? toggleLiveQuotes : null,
       toggleLocalServicePanel: typeof toggleLocalServicePanel === 'function' ? toggleLocalServicePanel : null,
       copyServeCommand: typeof copyServeCommand === 'function' ? copyServeCommand : null,
       applyLiveKpis: typeof applyLiveKpis === 'function' ? applyLiveKpis : null,
       updateSymbolLive: typeof updateSymbolLive === 'function' ? updateSymbolLive : null,
       collectLiveSymbols: typeof collectLiveSymbols === 'function' ? collectLiveSymbols : null,
       renderModeIndicator: typeof renderModeIndicator === 'function' ? renderModeIndicator : null,
       heartbeatTick: typeof heartbeatTick === 'function' ? heartbeatTick : null,
       performRefresh: typeof performRefresh === 'function' ? performRefresh : null,
       renderAllocPillars: typeof renderAllocPillars === 'function' ? renderAllocPillars : null,
       showDegradedBanner: typeof showDegradedBanner === 'function' ? showDegradedBanner : null,
       hideDegradedBanner: typeof hideDegradedBanner === 'function' ? hideDegradedBanner : null,
       setGlobalAccountFilter: typeof setGlobalAccountFilter === 'function' ? setGlobalAccountFilter : null
     };`,
  );
  scriptFactory(
    sandbox,
    fakeDocument,
    sandbox.LiveClientRuntime,
    fixtureMetrics(),
    fixtureTargets(),
    fakeSetTimeout,
    clearTimer,
    fakeSetInterval,
    clearTimer,
    fakeFetch,
    console,
    TextDecoder,
    AbortController,
    sandbox.navigator,
    sandbox.location,
  );

  return {
    sandbox,
    hooks: sandbox.__hooks ?? {},
    cards,
    holdingRows,
    lotRows,
    timers,
    errors,
    rejections,
    fetchCalls,
    fetchInits,
    runTimers(msFilter?: number) {
      const snapshot = timers.slice();
      for (const timer of snapshot) {
        if (msFilter !== undefined && timer.ms !== msFilter && timer.ms % msFilter !== 0) continue;
        try {
          timer.fn();
        } catch (err) {
          errors.push(String(err));
        }
      }
    },
    async settle<T = any>(promise: Promise<T> | any): Promise<T> {
      let settled = false;
      let value: any;
      let failure: any = null;
      (promise as Promise<any>).then(
        (v: any) => {
          settled = true;
          value = v;
        },
        (e: any) => {
          settled = true;
          failure = e;
        },
      );
      for (let i = 0; i < 400 && !settled; i += 1) {
        await Bun.sleep(1);
        const snapshot = timers.slice();
        for (const timer of snapshot) {
          try {
            timer.fn();
          } catch (err) {
            errors.push(String(err));
          }
        }
      }
      if (failure) throw failure;
      if (!settled) throw new Error("settle() timed out: promise never resolved");
      return value as T;
    },
    element,
    allText() {
      const parts: string[] = [];
      for (const el of elements.values()) {
        parts.push(el.textContent ?? "");
        for (const child of Object.values(el.children)) parts.push(child.textContent ?? "");
      }
      for (const card of cards) {
        for (const child of Object.values(card.children)) parts.push(child.textContent ?? "");
      }
      for (const row of holdingRows.concat(lotRows)) {
        for (const child of Object.values(row.children)) parts.push(child.textContent ?? "");
      }
      return parts.join(" | ");
    },
    stop() {
      process.off("unhandledRejection", onRejection);
    },
  };
}

const openServers: Array<{ stop(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openServers.length) {
    const srv = openServers.pop()!;
    try {
      await srv.stop();
    } catch {
      /* already stopped */
    }
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir(dbPath: string): string {
  const dir = join(dbPath, "..");
  tempDirs.push(dir);
  return dbPath;
}

// ===========================================================================
// 1. HTTP engine contract
// ===========================================================================

describe("trade serve: local HTTP engine contract", () => {
  it("GET /api/health returns compliant JSON with status ok and no NaN", async () => {
    const dbPath = trackDir(tempDbPath("health"));
    seedLedger(dbPath);

    const srv = await startServe({
      port: 0,
      dbPath,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6 }),
    });
    openServers.push(srv);

    const resp = await apiGet(srv, "/api/health");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");

    const body = (await resp.json()) as Record<string, any>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe(TOOL_VERSION);
    expect(body.db_path).toBe(dbPath);
    expect(typeof body.timestamp).toBe("number");
    expect(Number.isFinite(body.timestamp)).toBe(true);
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(srv.port);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints).toContain("/api/health");
    expect(everyNumberFinite(body)).toBe(true);
    assertNoNaN(body, "health payload");
  });

  it("binds an OS-assigned ephemeral port and reports it back on the health payload", async () => {
    const dbPath = trackDir(tempDbPath("ephemeral"));
    createEmptyLedger(dbPath);
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    expect(srv.port).toBeGreaterThan(0);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
    const body = (await (await apiGet(srv, "/api/health")).json()) as Record<string, any>;
    expect(body.port).toBe(srv.port);
  });

  it("GET /api/summary aggregates portfolio, accounts and symbols consistently", async () => {
    const dbPath = trackDir(tempDbPath("summary"));
    seedLedger(dbPath);

    const srv = await startServe({
      port: 0,
      dbPath,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6, "159934.SZ": 7.35 }),
    });
    openServers.push(srv);

    const body = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    expect(body.status).toBe("ok");
    assertNoNaN(body, "summary payload");
    expect(everyNumberFinite(body)).toBe(true);

    // Layer 1: portfolio
    expect(body.portfolio.total_active_lots).toBe(3);
    expect(body.portfolio.total_symbols_count).toBe(2);
    expect(body.portfolio.currency ?? body.currency).toBe("CNY");
    expect(body.portfolio.full_position_cap).toBeGreaterThan(0);
    expect(body.portfolio.total_cost).toBeGreaterThan(0);
    expect(body.portfolio.total_market_value).toBeGreaterThan(body.portfolio.total_cost);
    expect(body.portfolio.total_floating_pnl).toBeGreaterThan(0);
    // Layer 1 must not fabricate a portfolio-wide budget out of the Layer 2 per-symbol cap:
    // the old `cap - total_market_value` produced a negative budget and a 2412% utilisation.
    expect(body.portfolio.full_position_cap_scope).toBe("per_symbol");
    expect(body.portfolio.remaining_budget).toBeNull();
    expect(body.portfolio.budget_utilization_rate).toBeNull();

    // Layer 1b: multi-account roll-up
    const accountIds = body.accounts.map((a: any) => a.account_id).sort();
    expect(accountIds).toContain("DEFAULT");
    expect(accountIds).toContain("ACC2");
    const sumCost = body.accounts.reduce((sum: number, a: any) => sum + a.total_cost, 0);
    const sumMkt = body.accounts.reduce((sum: number, a: any) => sum + a.total_market_value, 0);
    expect(sumCost).toBeCloseTo(body.portfolio.total_cost, 2);
    expect(sumMkt).toBeCloseTo(body.portfolio.total_market_value, 2);

    const acc2 = body.accounts.find((a: any) => a.account_id === "ACC2");
    expect(acc2.closed_trades).toBe(1);
    expect(acc2.win_trades).toBe(1);
    expect(acc2.realized_pnl).toBeCloseTo(149.37, 2);
    expect(acc2.withdrawn_cash).toBeCloseTo(149.37, 2);

    // Layer 2: per-symbol
    expect(body.symbols.length).toBe(2);
    const gold = body.symbols.find((s: any) => s.symbol === "518880.SH");
    expect(gold.current_price).toBe(6.6);
    expect(gold.price_source).toBe("live");
    expect(gold.total_quantity).toBe(1500);
    expect(gold.avg_cost_price).toBeCloseTo((6.1 * 1000 + 6.2 * 500) / 1500, 3);
    expect(gold.active_lots).toBe(2);
    expect(gold.accounts).toContain("DEFAULT");

    // CLOSED lots must never leak into the live snapshot
    const lotIds = body.symbols.flatMap((s: any) => s.accounts);
    expect(lotIds).not.toContain("LOT-CLOSED");
  });

  it("GET /api/lots supports symbol / account / status filters", async () => {
    const dbPath = trackDir(tempDbPath("lots"));
    seedLedger(dbPath);

    const srv = await startServe({
      port: 0,
      dbPath,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6, "159934.SZ": 7.35 }),
    });
    openServers.push(srv);

    const all = (await (await apiGet(srv, "/api/lots")).json()) as Record<string, any>;
    expect(all.status).toBe("ok");
    expect(all.total).toBe(4);
    expect(everyNumberFinite(all)).toBe(true);

    const gold = (await (await apiGet(srv, "/api/lots?symbol=518880")).json()) as Record<string, any>;
    expect(gold.total).toBe(2);
    expect(gold.filters.symbol).toBe("518880.SH");
    expect(gold.lots.every((l: any) => l.symbol === "518880.SH")).toBe(true);
    expect(gold.lots[0].price_source).toBe("live");

    const acc2 = (await (await apiGet(srv, "/api/lots?account=ACC2")).json()) as Record<string, any>;
    expect(acc2.total).toBe(2);
    expect(acc2.lots.every((l: any) => l.account_id === "ACC2")).toBe(true);

    const closed = (await (await apiGet(srv, "/api/lots?status=CLOSED")).json()) as Record<string, any>;
    expect(closed.total).toBe(1);
    expect(closed.lots[0].lot_id).toBe("LOT-CLOSED");
    expect(closed.lots[0].status).toBe("CLOSED");

    const active = (await (await apiGet(srv, "/api/lots?status=ACTIVE")).json()) as Record<string, any>;
    expect(active.total).toBe(3);
  });

  it("never emits NaN when the quote feed is dead (cost-basis fallback)", async () => {
    const dbPath = trackDir(tempDbPath("offline"));
    seedLedger(dbPath);

    // Empty mock provider => getQuotes cannot resolve anything => cost-basis fallback.
    class DeadProvider extends QuoteProvider {
      override async getQuotes(): Promise<Record<string, never>> {
        throw new Error("network unreachable");
      }
    }

    const srv = await startServe({ port: 0, dbPath, quoteProvider: new DeadProvider() });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    assertNoNaN(summary, "offline summary");
    expect(everyNumberFinite(summary)).toBe(true);
    for (const sym of summary.symbols) {
      expect(sym.price_source).toBe("cost_basis");
      expect(sym.current_price).toBeGreaterThan(0);
      expect(sym.market_value).toBeGreaterThan(0);
    }

    const lots = (await (await apiGet(srv, "/api/lots")).json()) as Record<string, any>;
    assertNoNaN(lots, "offline lots");
    expect(everyNumberFinite(lots)).toBe(true);
  });

  it("answers 404/405/preflight without leaking a stack trace", async () => {
    const dbPath = trackDir(tempDbPath("http"));
    createEmptyLedger(dbPath);
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const missing = await apiGet(srv, "/api/nope");
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, any>;
    expect(missingBody.status).toBe("error");
    expect(JSON.stringify(missingBody)).not.toContain("    at ");

    const badMethod = await apiGet(srv, "/api/health", { method: "POST" });
    expect(badMethod.status).toBe(405);

    const badStatus = await apiGet(srv, "/api/lots?status=EXPLODED");
    expect(badStatus.status).toBe(400);
    const badStatusBody = (await badStatus.json()) as Record<string, any>;
    expect(badStatusBody.message).toContain("非法批次状态");

    const preflight = await apiGet(srv, "/api/health", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    // No Origin header => no CORS origin is minted. The old `*` wildcard is gone for good.
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("vary")).toContain("Origin");
  });

  it("serves an empty ledger without throwing", async () => {
    const dbPath = trackDir(tempDbPath("empty"));
    createEmptyLedger(dbPath);
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    expect(summary.status).toBe("ok");
    expect(summary.portfolio.total_active_lots).toBe(0);
    expect(summary.portfolio.total_cost).toBe(0);
    expect(summary.portfolio.overall_return_rate).toBe(0);
    expect(summary.symbols).toEqual([]);
    assertNoNaN(summary, "empty summary");
    // "查不到 ≠ 没有" anti-false-positive: a brand-new schema-only book is a legitimate
    // empty portfolio, NOT a degraded one. The alert must not cry wolf here.
    expect(summary.degraded).toBe(false);
    expect(summary.degraded_reason).toBeNull();

    const lots = (await (await apiGet(srv, "/api/lots")).json()) as Record<string, any>;
    expect(lots.total).toBe(0);
    expect(lots.lots).toEqual([]);
    expect(lots.degraded).toBe(false);
    expect(lots.degraded_reason).toBeNull();
  });
});

// ===========================================================================
// 1c. "查不到 ≠ 没有": a degraded ledger must be loud, never a silent flat book
// ===========================================================================

describe("trade serve: degraded ledger guards (empty book is never assumed)", () => {
  /** Wipe the lot book while the trade journal survives: the exact silent-data-loss shape. */
  function wipeLotBook(dbPath: string): void {
    const db = new AppDatabase(dbPath);
    try {
      db.getConnection().run("DELETE FROM lots");
    } finally {
      db.close();
    }
  }

  function exec(dbPath: string, sql: string): void {
    const db = new AppDatabase(dbPath);
    try {
      db.getConnection().run(sql);
    } finally {
      db.close();
    }
  }

  it("NEGATIVE anti-false-positive: a healthy seeded ledger is not degraded", async () => {
    const dbPath = trackDir(tempDbPath("healthy"));
    seedLedger(dbPath);
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({ "518880.SH": 6.6 }) });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    expect(summary.degraded).toBe(false);
    expect(summary.degraded_reason).toBeNull();
    expect(summary.portfolio.total_active_lots).toBeGreaterThan(0);

    const lots = (await (await apiGet(srv, "/api/lots")).json()) as Record<string, any>;
    expect(lots.degraded).toBe(false);
    expect(lots.degraded_reason).toBeNull();
  });

  it("flags degraded when trades survive but the lot book was emptied", async () => {
    const dbPath = trackDir(tempDbPath("degraded_wipe"));
    seedLedger(dbPath);
    wipeLotBook(dbPath);

    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    // Still HTTP 200 / status ok — but it must never claim the empty book is the truth.
    expect(summary.status).toBe("ok");
    expect(summary.degraded).toBe(true);
    expect(typeof summary.degraded_reason).toBe("string");
    expect(summary.degraded_reason).toContain("trades");
    expect(summary.degraded_reason).toContain("lots");
    expect(summary.portfolio.total_market_value).toBe(0);

    const lots = (await (await apiGet(srv, "/api/lots")).json()) as Record<string, any>;
    expect(lots.degraded).toBe(true);
    expect(lots.degraded_reason).toBe(summary.degraded_reason);
  });

  it("flags degraded when trades exist but no ACTIVE lot remains", async () => {
    const dbPath = trackDir(tempDbPath("degraded_noactive"));
    seedLedger(dbPath);
    exec(dbPath, "UPDATE lots SET status = 'CLOSED'");

    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    expect(summary.degraded).toBe(true);
    expect(summary.degraded_reason).toContain("活跃批次为 0");
    expect(summary.portfolio.total_active_lots).toBe(0);
  });

  it("flags degraded when CLOSED lots exist but the trade journal was emptied", async () => {
    const dbPath = trackDir(tempDbPath("degraded_notrades"));
    seedLedger(dbPath);
    exec(dbPath, "DELETE FROM trades");

    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({ "518880.SH": 6.6 }) });
    openServers.push(srv);

    const summary = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    expect(summary.degraded).toBe(true);
    expect(summary.degraded_reason).toContain("trades");
  });

  it("unit: an emptied symbols metadata table is degraded (raw ledger, no reseed)", () => {
    const dbPath = trackDir(tempDbPath("degraded_nosyms"));
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE symbols (symbol TEXT PRIMARY KEY, name TEXT, asset_class TEXT, settlement_mode TEXT);
      CREATE TABLE trades (
        trade_id TEXT PRIMARY KEY, account_id TEXT, lot_id TEXT, action TEXT,
        price REAL, quantity INTEGER, fee REAL, realized_pnl REAL, executed_at TEXT
      );
    `);
    raw.run(
      `INSERT INTO trades VALUES ('T-1','DEFAULT','L1','SELL_REGULAR',7.0,100,0,10,'2025-01-02T09:30:00')`,
    );
    const lotRow = {
      lot_id: "L1",
      account_id: "DEFAULT",
      symbol: "518880.SH",
      symbol_name: "黄金ETF",
      asset_class: "ETF",
      settlement_mode: "NATIVE_T0",
      buy_time: "2025-01-02T09:30:00",
      buy_price: 6.1,
      buy_quantity: 1000,
      remaining_quantity: 1000,
      cost_basis_unit: 6.1,
      status: "ACTIVE",
      pyramid_level: 0,
      is_day_trading: 0,
      peak_price: null,
      trailing_stop_active: 0,
      buy_reason: null,
      close_reason: null,
      close_time: null,
      close_avg_price: null,
      realized_pnl: 0,
    };
    const verdict = assessLedgerHealth(raw, [lotRow] as any);
    expect(verdict.degraded).toBe(true);
    expect(verdict.degraded_reason).toContain("symbols");
    raw.close();
  });

  it("unit: assessLedgerHealth is a pure read over rows + row counts", () => {
    const dbPath = trackDir(tempDbPath("health_unit"));
    createEmptyLedger(dbPath);
    const db = new AppDatabase(dbPath);
    try {
      const conn = db.getConnection();
      // Schema-only ledger: nothing to distrust yet.
      expect(assessLedgerHealth(conn, [])).toEqual({ degraded: false, degraded_reason: null });
      conn.run(
        `INSERT INTO trades (trade_id, account_id, lot_id, action, price, quantity, fee, realized_pnl, executed_at)
         VALUES ('T-1', 'DEFAULT', 'LOT-X', 'SELL_REGULAR', 7.0, 100, 0, 10, '2025-01-02T09:30:00')`,
      );
      const verdict = assessLedgerHealth(conn, []);
      expect(verdict.degraded).toBe(true);
      expect(verdict.degraded_reason).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

// ===========================================================================
// 1b. Network security guards: CORS allow-list + DNS-rebinding Host guard
//
// Both gates run before routing. Each test below is deliberately negative-first:
// a hostile `Origin` / `Host` must be a flat 403 with NO `Access-Control-Allow-Origin`
// and no ledger field, while every legitimate local client (file:// dashboard, loopback
// dev server, plain curl) must keep working — that is the anti-false-positive half.
// ===========================================================================

describe("trade serve: network security guards (CORS allow-list + DNS rebinding)", () => {
  async function bootSecured(tag: string) {
    const dbPath = trackDir(tempDbPath(tag));
    seedLedger(dbPath);
    const srv = await startServe({
      port: 0,
      dbPath,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6, "159934.SZ": 7.35 }),
    });
    openServers.push(srv);
    return { srv, dbPath };
  }

  it("unit: Host allow-list is exact-match loopback only (no suffix / LAN / malformed host)", () => {
    for (const allowed of [
      "127.0.0.1",
      "127.0.0.1:8080",
      "localhost",
      "localhost:8080",
      "LOCALHOST:3000",
      "localhost.",
      "[::1]",
      "[::1]:8080",
      "::1",
    ]) {
      expect(isAllowedHostHeader(allowed), `Host ${allowed} must be allowed`).toBe(true);
    }

    for (const blocked of [
      null,
      undefined,
      "",
      "   ",
      "attacker.example",
      "attacker.example:8080",
      "127.0.0.1.attacker.example",
      "127.0.0.1.attacker.example:8080",
      "localhost.attacker.example",
      "attacker-127.0.0.1",
      "10.0.0.1:8080",
      "192.168.1.5",
      "0.0.0.0",
      "1.2.3.4:8080",
      "127.0.0.1:abc",
      "127.0.0.1:",
      "[::1",
      "[::1]evil",
    ]) {
      expect(isAllowedHostHeader(blocked as any), `Host ${String(blocked)} must be rejected`).toBe(false);
    }
  });

  it("unit: Origin allow-list keeps file:// (null) + loopback, rejects every foreign origin", () => {
    for (const allowed of [
      "null",
      "NULL",
      "http://127.0.0.1:8080",
      "http://127.0.0.1",
      "http://localhost:3000",
      "https://127.0.0.1:8443",
      "http://[::1]:8080",
    ]) {
      expect(isAllowedOrigin(allowed), `Origin ${allowed} must be allowed`).toBe(true);
    }
    // `file://` is echoed as the literal opaque origin, never as the original casing.
    expect(resolveAllowedOrigin("NULL")).toBe("null");
    expect(resolveAllowedOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");

    for (const blocked of [
      null,
      undefined,
      "",
      "  ",
      "https://attacker.example",
      "http://attacker.example:8080",
      "http://127.0.0.1.attacker.example:8080",
      "http://localhost.attacker.example",
      "http://evil.example/?redirect=127.0.0.1",
      "http://127.0.0.1:8080/path",
      "http://user:pass@127.0.0.1:8080",
      "file:///Users/ivywu/ledger.html",
      "chrome-extension://abcdefghijklmnop",
      "http://10.0.0.1:8080",
      "*",
    ]) {
      expect(isAllowedOrigin(blocked as any), `Origin ${String(blocked)} must be rejected`).toBe(false);
    }
  });

  it("blocks a hostile Origin with 403 and emits no CORS header at all", async () => {
    const { srv, dbPath } = await bootSecured("cors-evil");

    for (const evil of [
      "https://attacker.example",
      "http://attacker.example:8080",
      "http://127.0.0.1.attacker.example:8080",
      "chrome-extension://abcdefghijklmnop",
    ]) {
      const resp = await apiGet(srv, "/api/summary", { headers: { Origin: evil } });
      expect(resp.status, `Origin ${evil} must be blocked`).toBe(403);
      expect(resp.headers.get("access-control-allow-origin")).toBeNull();

      const body = await resp.text();
      expect(body).toContain("ORIGIN_NOT_ALLOWED");
      // Not even a rejection may leak ledger content.
      for (const secret of ["total_cost", "full_position_cap", "518880.SH", "LOT-GOLD", "realized_pnl", dbPath]) {
        expect(body.includes(secret), `403 body must not leak ${secret}`).toBe(false);
      }

      // The preflight path is gated identically.
      const preflight = await apiGet(srv, "/api/summary", {
        method: "OPTIONS",
        headers: { Origin: evil, "Access-Control-Request-Method": "GET" },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("blocks DNS-rebinding Host headers with 403 before any business logic runs", async () => {
    const { srv } = await bootSecured("rebind-evil");

    for (const evilHost of [
      "attacker.example",
      "attacker.example:8080",
      "127.0.0.1.attacker.example:8080",
      "localhost.attacker.example",
      "10.0.0.1:8080",
    ]) {
      const resp = await apiGet(srv, "/api/summary", { headers: { Host: evilHost } });
      expect(resp.status, `Host ${evilHost} must be blocked`).toBe(403);
      expect(resp.headers.get("access-control-allow-origin")).toBeNull();

      const body = await resp.text();
      expect(body).toContain("HOST_NOT_ALLOWED");
      expect(body).not.toContain("total_cost");
      expect(body).not.toContain("518880.SH");
    }

    // Rebinding + a forged friendly Origin is still blocked (Host gate runs first).
    const both = await apiGet(srv, "/api/summary", {
      headers: { Host: "attacker.example", Origin: `http://127.0.0.1:${srv.port}` },
    });
    expect(both.status).toBe(403);
    expect(both.headers.get("access-control-allow-origin")).toBeNull();

    // ...and so is a rebinding Host on the preflight path.
    const preflight = await apiGet(srv, "/api/health", {
      method: "OPTIONS",
      headers: { Host: "attacker.example" },
    });
    expect(preflight.status).toBe(403);
  });

  it("still serves the file:// dashboard (Origin: null) and loopback origins (anti-false-positive)", async () => {
    const { srv } = await bootSecured("cors-ok");

    const cases: Array<{ sent: string; echoed: string }> = [
      { sent: "null", echoed: "null" },
      { sent: `http://127.0.0.1:${srv.port}`, echoed: `http://127.0.0.1:${srv.port}` },
      { sent: "http://localhost:3000", echoed: "http://localhost:3000" },
      { sent: "http://[::1]:8080", echoed: "http://[::1]:8080" },
      { sent: "https://127.0.0.1:8443", echoed: "https://127.0.0.1:8443" },
    ];

    for (const { sent, echoed } of cases) {
      const resp = await apiGet(srv, "/api/summary", { headers: { Origin: sent } });
      expect(resp.status, `Origin ${sent} must be served`).toBe(200);
      expect(resp.headers.get("access-control-allow-origin")).toBe(echoed);
      expect(resp.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(resp.headers.get("vary")).toContain("Origin");

      const body = (await resp.json()) as Record<string, any>;
      expect(body.status).toBe("ok");
      expect(body.portfolio.total_active_lots).toBe(3);
    }

    // Preflight from the file:// dashboard must still succeed and echo `null`.
    const preflight = await apiGet(srv, "/api/health", {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("accepts loopback Host variants and Origin-less CLI clients with no CORS leakage", async () => {
    const { srv } = await bootSecured("host-ok");

    for (const okHost of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `[::1]:${srv.port}`, "127.0.0.1"]) {
      const resp = await apiGet(srv, "/api/health", { headers: { Host: okHost } });
      expect(resp.status, `Host ${okHost} must be served`).toBe(200);
      const body = (await resp.json()) as Record<string, any>;
      expect(body.status).toBe("ok");
      // No Origin sent => read-only, no CORS origin header is minted.
      expect(resp.headers.get("access-control-allow-origin")).toBeNull();
    }

    // Plain curl-style request: no Origin header at all.
    const plain = await apiGet(srv, "/api/summary");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    expect((await plain.json()) as Record<string, any>).toMatchObject({ status: "ok" });
  });

  it("replays the owner's exact curl attacks: hostile Origin / Host => 403, plain curl => 200", async () => {
    const { srv } = await bootSecured("curl-live");

    const curl = async (args: string[]) => {
      const proc = Bun.spawn(["curl", "-sS", "--max-time", "8", "-i", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      return { out, err, exit };
    };

    const statusOf = (out: string): number => Number((out.split("\r\n")[0] || "").split(" ")[1]);

    const hostileOrigin = await curl(["-H", "Origin: https://attacker.example", `${srv.url}/api/summary`]);
    expect(hostileOrigin.exit).toBe(0);
    expect(statusOf(hostileOrigin.out)).toBe(403);
    expect(hostileOrigin.out.toLowerCase()).not.toContain("access-control-allow-origin");
    expect(hostileOrigin.out).not.toContain("518880.SH");

    const rebinding = await curl(["-H", "Host: attacker.example", `${srv.url}/api/summary`]);
    expect(rebinding.exit).toBe(0);
    expect(statusOf(rebinding.out)).toBe(403);
    expect(rebinding.out).toContain("HOST_NOT_ALLOWED");
    expect(rebinding.out).not.toContain("total_cost");

    const plain = await curl([`${srv.url}/api/health`]);
    expect(plain.exit).toBe(0);
    expect(statusOf(plain.out)).toBe(200);
    expect(plain.out).toContain("\"status\": \"ok\"");
    expect(plain.out.toLowerCase()).not.toContain("access-control-allow-origin");

    // The file:// dashboard path is the one legitimate cross-origin reader.
    const dashboard = await curl(["-H", "Origin: null", `${srv.url}/api/health`]);
    expect(statusOf(dashboard.out)).toBe(200);
    expect(dashboard.out.toLowerCase()).toContain("access-control-allow-origin: null");
  }, 30_000);
});

// ===========================================================================
// 1c. Session credential (`0600` local-protocol handshake)
//
// The CORS + Host gates turned "any page on this machine" into "a local dashboard or a
// loopback dev server". That still leaves one theoretical attacker: a hostile page can be
// rendered inside a sandboxed iframe whose `Origin` is the opaque `null` — byte-identical to
// the owner's own `file://` dashboard. No header rule can distinguish them, so the boundary
// moves down to the filesystem: a 32-byte secret in a `0600` file. Every test here is
// negative-first (no token / wrong token => 401 with zero ledger fields) plus the
// anti-false-positive half (Bearer, ?token=, public health, legal preflight).
// ===========================================================================

describe("trade serve: local session credential gate (0600 token)", () => {
  const FIXED_TOKEN = "0123456789abcdef".repeat(4); // 64 hex chars, explicit --token

  /** Ledger fingerprints that must never appear in a refusal body. */
  const LEDGER_FIELDS = [
    "total_cost",
    "total_market_value",
    "full_position_cap",
    "remaining_budget",
    "realized_pnl",
    "cost_basis_unit",
    "remaining_quantity",
    "portfolio",
    "symbols",
    "lots",
    "accounts",
    "518880.SH",
    "159934.SZ",
    "LOT-GOLD",
    "LOT-NAS",
  ];

  function assertLedgerFree(body: string, label: string): void {
    for (const field of LEDGER_FIELDS) {
      expect(body.includes(field), `${label} must not leak ${field}`).toBe(false);
    }
  }

  async function bootWithCredential(
    tag: string,
    options: { token?: string; tokenFile?: string } = {},
  ) {
    const dbPath = trackDir(tempDbPath(tag));
    seedLedger(dbPath);
    const tokenFile = options.tokenFile ?? join(dirname(dbPath), "session.token");
    const srv = await startServe({
      port: 0,
      dbPath,
      tokenFile,
      token: options.token,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6, "159934.SZ": 7.35 }),
    });
    openServers.push(srv);
    return { srv, dbPath, tokenFile };
  }

  it("unit: token comparison is exact-match, token generation is high-entropy hex", () => {
    expect(isTokenAuthorized("abc", "abc")).toBe(true);
    expect(isTokenAuthorized("abc", " abc ")).toBe(true); // a trailing newline in the file is fine
    expect(isTokenAuthorized("abc", "abcd")).toBe(false);
    expect(isTokenAuthorized("abc", "ABC")).toBe(false);
    expect(isTokenAuthorized("abc", "")).toBe(false);
    expect(isTokenAuthorized("abc", null)).toBe(false);
    expect(isTokenAuthorized("", "")).toBe(false);
    expect(isTokenAuthorized(undefined, "abc")).toBe(false);

    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);

    expect(isSensitiveRoute("/api/summary")).toBe(true);
    expect(isSensitiveRoute("/api/lots")).toBe(true);
    expect(isSensitiveRoute("/api/health")).toBe(false);
    expect(isSensitiveRoute("/")).toBe(false);
    expect(isSensitiveRoute("/api")).toBe(false);
    // Fail-closed: a ledger route nobody remembered to register is still protected.
    expect(isSensitiveRoute("/api/nope")).toBe(true);
    expect(isSensitiveRoute("/api/positions")).toBe(true);
  });

  it("unit: extractRequestToken reads Bearer and ?token=, ignores junk", () => {
    const url = new URL("http://127.0.0.1:8080/api/summary");
    const href = url.toString();

    const bearer = new Request(href, { headers: { Authorization: "Bearer s3cret" } });
    expect(extractRequestToken(bearer, url)).toBe("s3cret");

    const lower = new Request(href, { headers: { Authorization: "bearer s3cret" } });
    expect(extractRequestToken(lower, url)).toBe("s3cret");

    const query = new URL("http://127.0.0.1:8080/api/summary?token=s3cret");
    expect(extractRequestToken(new Request(query.toString()), query)).toBe("s3cret");

    const none = new Request(href);
    expect(extractRequestToken(none, url)).toBeNull();

    const basic = new Request(href, { headers: { Authorization: "Basic Zm9vOmJhcg==" } });
    expect(extractRequestToken(basic, url)).toBeNull();

    const blank = new URL("http://127.0.0.1:8080/api/summary?token=%20");
    expect(extractRequestToken(new Request(blank.toString()), blank)).toBeNull();
  });

  it("writes a 64-hex credential file with 0600 and nothing wider", async () => {
    const { srv, tokenFile } = await bootWithCredential("cred-mode");

    expect(existsSync(tokenFile)).toBe(true);
    // The whole authentication story is this bitmask: rwx for the owner, nothing for anyone else.
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    const stored = readFileSync(tokenFile, "utf8").trim();
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toBe(srv.token);
    expect(srv.tokenSource).toBe("generated");
    expect(srv.ephemeralToken).toBe(true);

    // A credential re-write must never widen the mode (umask or an inherited 0644 file).
    chmodSync(tokenFile, 0o644);
    writeSessionTokenFile(tokenFile, srv.token);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readSessionTokenFile(tokenFile)).toBe(srv.token);
  });

  it("NEGATIVE: no credential => 401 before any query, and the refusal carries no ledger field", async () => {
    const { srv, dbPath } = await bootWithCredential("cred-none");

    for (const path of ["/api/summary", "/api/lots", "/api/lots?status=ACTIVE", "/api/lots?symbol=518880"]) {
      const resp = await apiGet(srv, path, {}, null);
      expect(resp.status, `${path} without token`).toBe(401);
      expect(resp.headers.get("content-type")).toContain("application/json");

      const body = await resp.text();
      assertLedgerFree(body, `${path} 401 body`);
      expect(body).not.toContain(dbPath);
      const parsed = JSON.parse(body) as Record<string, any>;
      expect(parsed.status).toBe("error");
      expect(parsed.code).toBe("UNAUTHORIZED");
      expect(parsed.message).toBe("未授权：请提供合法的本地会话 Token。");
      expect(Object.keys(parsed).sort()).toEqual(["code", "message", "status"]);
    }
  });

  it("NEGATIVE: the auth gate runs before the business logic (bad filter still answers 401, not 400)", async () => {
    const { srv } = await bootWithCredential("cred-order");

    // `status=EXPLODED` normally throws `非法批次状态` -> 400. Reaching that branch would
    // mean the request was already parsed against the ledger; it must be 401 instead.
    const resp = await apiGet(srv, "/api/lots?status=EXPLODED", {}, null);
    expect(resp.status).toBe(401);
    expect((await resp.json()) as Record<string, any>).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("NEGATIVE: a wrong token of any shape is refused", async () => {
    const { srv } = await bootWithCredential("cred-wrong");

    const wrongTokens = [
      "",
      " ",
      "0".repeat(64),
      srv.token.slice(0, -1),
      `${srv.token}0`,
      srv.token.toUpperCase() === srv.token ? "deadbeef" : srv.token.toUpperCase(),
      "../../etc/passwd",
      "%00",
    ];

    for (const wrong of wrongTokens) {
      const viaHeader = await apiGet(srv, "/api/summary", {}, wrong);
      expect(viaHeader.status, `Bearer "${wrong}"`).toBe(401);

      const viaQuery = await apiGet(
        srv,
        `/api/summary?token=${encodeURIComponent(wrong)}`,
        {},
        null,
      );
      expect(viaQuery.status, `?token="${wrong}"`).toBe(401);
      assertLedgerFree(await viaQuery.text(), "wrong-token body");
    }
  });

  it("NEGATIVE: Origin:null (sandboxed iframe) + no token is still 401 — the blind-fire hole is closed", async () => {
    const { srv } = await bootWithCredential("cred-null-origin");

    // `Origin: null` is deliberately allow-listed, because that is what the owner's own
    // `file://` dashboard sends. The credential is the only thing separating the two.
    for (const path of ["/api/summary", "/api/lots"]) {
      const resp = await apiGet(srv, path, { headers: { Origin: "null" } }, null);
      expect(resp.status).toBe(401);
      // A readable refusal is required (the dashboard shows "unauthorized"), data is not.
      expect(resp.headers.get("access-control-allow-origin")).toBe("null");
      assertLedgerFree(await resp.text(), `Origin:null ${path} body`);
    }

    // Same attack from a real curl client: zero header games, no credential.
    const curl = async (args: string[]) => {
      const proc = Bun.spawn(["curl", "-sS", "--max-time", "8", "-i", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    };
    const statusOf = (out: string): number => Number((out.split("\r\n")[0] || "").split(" ")[1]);

    const sandboxed = await curl(["-H", "Origin: null", `${srv.url}/api/summary`]);
    expect(statusOf(sandboxed)).toBe(401);
    expect(sandboxed).toContain("UNAUTHORIZED");
    assertLedgerFree(sandboxed, "sandboxed iframe body");
  }, 30_000);

  it("accepts the Bearer header and the ?token= channel with identical full payloads", async () => {
    const { srv } = await bootWithCredential("cred-ok");

    const viaHeader = await apiGet(srv, "/api/summary");
    expect(viaHeader.status).toBe(200);
    const headerText = await viaHeader.text();
    const headerBody = JSON.parse(headerText) as Record<string, any>;
    expect(headerBody.status).toBe("ok");
    expect(headerBody.portfolio.total_active_lots).toBe(3);
    expect(headerBody.symbols.length).toBe(2);
    expect(everyNumberFinite(headerBody)).toBe(true);

    const viaQuery = await apiGet(srv, `/api/summary?token=${srv.token}`, {}, null);
    expect(viaQuery.status).toBe(200);

    // Query channel must not be a weaker copy of the same data.
    const queryBody = JSON.parse(await viaQuery.text()) as Record<string, any>;
    expect(queryBody.portfolio.total_cost).toBe(headerBody.portfolio.total_cost);
    expect(queryBody.portfolio.total_market_value).toBe(headerBody.portfolio.total_market_value);
    expect(queryBody.symbols.length).toBe(headerBody.symbols.length);

    const lotsByHeader = await apiGet(srv, "/api/lots?status=CLOSED");
    expect(lotsByHeader.status).toBe(200);
    const lotsBody = (await lotsByHeader.json()) as Record<string, any>;
    expect(lotsBody.total).toBe(1);
    expect(lotsBody.lots[0].lot_id).toBe("LOT-CLOSED");

    const lotsByQuery = await apiGet(srv, `/api/lots?status=CLOSED&token=${srv.token}`, {}, null);
    expect(lotsByQuery.status).toBe(200);
    expect(((await lotsByQuery.json()) as Record<string, any>).total).toBe(1);

    // A cookie-less curl with the Bearer header is a first-class client.
    const proc = Bun.spawn(
      ["curl", "-sS", "--max-time", "8", "-H", `Authorization: Bearer ${srv.token}`, `${srv.url}/api/lots`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const curlBody = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect((JSON.parse(curlBody) as Record<string, any>).status).toBe("ok");
  }, 30_000);

  it("/api/health stays public, tokenless and ledger-free (anti-false-positive probe)", async () => {
    const { srv } = await bootWithCredential("cred-health");

    const resp = await apiGet(srv, "/api/health", {}, null);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, any>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe(TOOL_VERSION);
    expect(body.port).toBe(srv.port);

    // A liveness probe must never become a side door into the ledger.
    for (const forbidden of ["portfolio", "symbols", "accounts", "lots", "total_cost", "518880.SH"]) {
      expect(Object.prototype.hasOwnProperty.call(body, forbidden)).toBe(false);
    }
    expect(JSON.stringify(body)).not.toContain("LOT-GOLD");

    // The index advertises the auth scheme instead of pretending to be open.
    const index = (await (await apiGet(srv, "/", {}, null)).json()) as Record<string, any>;
    expect(index.auth).toBe("bearer");
    expect(index.symbols).toBeUndefined();
  });

  it("OPTIONS preflight from a legal Origin allows the Authorization header without a token", async () => {
    const { srv } = await bootWithCredential("cred-preflight");

    const preflight = await apiGet(
      srv,
      "/api/summary",
      {
        method: "OPTIONS",
        headers: {
          Origin: "null",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      },
      null,
    );
    // Browsers never attach credentials to a preflight: it must pass on the Origin alone.
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect((preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
      "authorization",
    );
  });

  it("keeps an explicitly supplied token and never deletes the owner's credential file", async () => {
    const { srv, tokenFile } = await bootWithCredential("cred-explicit", { token: FIXED_TOKEN });

    expect(srv.token).toBe(FIXED_TOKEN);
    expect(srv.tokenSource).toBe("explicit");
    expect(srv.ephemeralToken).toBe(false);
    expect(readSessionTokenFile(tokenFile)).toBe(FIXED_TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

    expect((await apiGet(srv, "/api/summary")).status).toBe(200);
    expect((await apiGet(srv, "/api/summary", {}, null)).status).toBe(401);

    await srv.stop();
    openServers.pop();
    // An owner-supplied credential is the owner's property: it survives the shutdown.
    expect(existsSync(tokenFile)).toBe(true);
    expect(readSessionTokenFile(tokenFile)).toBe(FIXED_TOKEN);
    rmSync(tokenFile, { force: true });
  });

  it("rotates the token on restart, so a stale file value stops working", async () => {
    const first = await bootWithCredential("cred-rotate-1");
    const staleToken = first.srv.token;
    const tokenFile = first.tokenFile;

    await first.srv.stop();
    openServers.pop();
    // Auto-generated credentials die with the process they belong to.
    expect(existsSync(tokenFile)).toBe(false);

    const second = await startServe({
      port: 0,
      dbPath: first.dbPath,
      tokenFile,
      quoteProvider: new QuoteProvider({}),
    });
    openServers.push(second);

    expect(second.token).not.toBe(staleToken);
    expect(readSessionTokenFile(tokenFile)).toBe(second.token);
    expect((await apiGet(second, "/api/summary", {}, staleToken)).status).toBe(401);
    expect((await apiGet(second, "/api/summary")).status).toBe(200);
  });

  it("a failed boot (port already taken) never clobbers the running instance's credential", async () => {
    const first = await bootWithCredential("cred-clobber");
    const tokenFile = first.tokenFile;
    const published = readSessionTokenFile(tokenFile);

    let caught: any = null;
    try {
      const second = await startServe({
        port: first.srv.port,
        dbPath: first.dbPath,
        tokenFile,
        quoteProvider: new QuoteProvider({}),
      });
      openServers.push(second);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe("PORT_IN_USE");
    // The losing process must not delete or overwrite the winner's credential.
    expect(readSessionTokenFile(tokenFile)).toBe(published);
    expect((await apiGet(first.srv, "/api/summary")).status).toBe(200);
  });

  it("fails closed when the credential file cannot be written", async () => {
    const dbPath = trackDir(tempDbPath("cred-nowrite"));
    seedLedger(dbPath);
    // A directory where the file should be: open(2) fails, and `serve` must refuse to run
    // unauthenticated rather than silently serve the ledger without a credential.
    const tokenFile = join(dirname(dbPath), "blocked-token");
    mkdirSync(tokenFile, { recursive: true });

    let caught: any = null;
    try {
      const srv = await startServe({ port: 0, dbPath, tokenFile, quoteProvider: new QuoteProvider({}) });
      openServers.push(srv);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.message)).toContain("无法写入本地会话 Token 凭证文件");
  });

  it("exposes the credential flags in `trade serve --help`", async () => {
    const proc = Bun.spawn([process.execPath, "run", cliPath, "serve", "--help"], {
      cwd: repoRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("--token");
    expect(stdout).toContain("--token-file");
    expect(stdout).toContain("UNAUTHORIZED");
    expect(stdout).toContain("0600");
  }, 40_000);

  it("`trade dashboard` injects the live credential into the generated page", async () => {
    const dbPath = trackDir(tempDbPath("cred-dash"));
    seedLedger(dbPath);
    const outPath = join(dbPath, "..", "cred-dashboard.html");
    const binDir = join(dbPath, "..", "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "trade");
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`);
    chmodSync(shim, 0o755);

    const tokenFile = join(dbPath, "..", "active-session.token");
    const injected = "b".repeat(64);
    writeSessionTokenFile(tokenFile, injected);

    const runDashboard = async (out: string, extraEnv: Record<string, string> = {}) => {
      const proc = Bun.spawn(
        [process.execPath, "run", cliPath, "dashboard", "--out", out, "--db", dbPath, "--json"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            LOT_TRADER_DB: dbPath,
            TRADE_DB_PATH: dbPath,
            LOT_TRADER_TOKEN_FILE: tokenFile,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            ...extraEnv,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      expect(JSON.parse(stdout).code).toBe(0);
      return readFileSync(out, "utf-8");
    };

    const withCredential = await runDashboard(outPath);
    expect(withCredential).toContain(`window.__LOT_TRADER_SESSION_TOKEN__ = ${JSON.stringify(injected)};`);
    expect(withCredential).toContain("window.__LOT_TRADER_SESSION_AUTH_CONFIGURED__ = true;");
    expect(/\{\{[A-Z_]+\}\}/.test(withCredential)).toBe(false);
    // The runtime that consumes it is present too.
    expect(withCredential).toContain("function sessionToken()");
    expect(withCredential).toContain("Authorization: 'Bearer '");

    // No active credential (file removed): the page must still be generated, marked as
    // unconfigured, and keep its standalone path intact.
    rmSync(tokenFile, { force: true });
    const noCredentialPath = join(dbPath, "..", "no-credential-dashboard.html");
    const withoutCredential = await runDashboard(noCredentialPath);
    expect(withoutCredential).toContain("window.__LOT_TRADER_SESSION_TOKEN__ = \"\";");
    expect(withoutCredential).toContain("window.__LOT_TRADER_SESSION_AUTH_CONFIGURED__ = false;");
    expect(withoutCredential).toContain("模式：轻量独立（纯前端自驱）");
    expect(/\{\{[A-Z_]+\}\}/.test(withoutCredential)).toBe(false);
  }, 90_000);

  it("ships DEFAULT_TOKEN_FILE outside the repo and documents the 0600 contract", () => {
    expect(DEFAULT_TOKEN_FILE.endsWith(join(".lot-trader", "session.token"))).toBe(true);
    expect(DEFAULT_TOKEN_FILE.startsWith(repoRoot)).toBe(false);
  });
});

// ===========================================================================
// 2. Port conflict, host guard, graceful shutdown
// ===========================================================================

describe("trade serve: port conflict and lifecycle guards", () => {
  it("throws a readable error (not a raw stack) when the port is already taken", async () => {
    const dbPath = trackDir(tempDbPath("conflict"));
    createEmptyLedger(dbPath);
    const first = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(first);

    let caught: any = null;
    try {
      const second = await startServe({ port: first.port, dbPath, quoteProvider: new QuoteProvider({}) });
      openServers.push(second);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught instanceof Error).toBe(true);
    expect(caught.code).toBe("PORT_IN_USE");
    expect(caught.message).toContain(String(first.port));
    expect(caught.message).toContain("已被占用");
    expect(caught.message).toContain("trade serve --port");
    // Friendly banner, not a Node stack trace.
    expect(caught.message).not.toContain("EADDRINUSE");
    expect(caught.message).not.toContain("    at ");
  });

  it("refuses to bind a non-loopback host so the ledger never leaves the machine", async () => {
    expect(resolveServeHost(undefined)).toBe(DEFAULT_SERVE_HOST);
    expect(resolveServeHost("")).toBe(DEFAULT_SERVE_HOST);
    expect(resolveServeHost("localhost")).toBe("127.0.0.1");
    expect(resolveServeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveServeHost("::1")).toBe("::1");

    for (const evil of ["0.0.0.0", "192.168.1.10", "example.com", "10.0.0.1"]) {
      let error: Error | null = null;
      try {
        resolveServeHost(evil);
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error!.message).toContain("仅允许本地回环地址");
      expect(error!.message).toContain(evil);
    }
    expect(LOOPBACK_HOSTS).toContain("127.0.0.1");
  });

  it("validates ports, db path and full-position cap deterministically", () => {
    expect(resolveServePort(undefined)).toBe(DEFAULT_SERVE_PORT);
    expect(resolveServePort("")).toBe(DEFAULT_SERVE_PORT);
    expect(resolveServePort("0")).toBe(0);
    expect(resolveServePort("9090")).toBe(9090);
    for (const bad of ["abc", "-1", "70000", "1.5"]) {
      expect(() => resolveServePort(bad)).toThrow(/非法端口/);
    }

    expect(resolveServeDbPath("/tmp/x.db")).toBe("/tmp/x.db");
    const previous = process.env.LOT_TRADER_DB;
    process.env.LOT_TRADER_DB = "/tmp/env-ledger.db";
    expect(resolveServeDbPath(undefined)).toBe("/tmp/env-ledger.db");
    if (previous === undefined) delete process.env.LOT_TRADER_DB;
    else process.env.LOT_TRADER_DB = previous;

    expect(resolveFullPositionCap(undefined)).toBeGreaterThan(0);
    expect(resolveFullPositionCap("88888")).toBe(88888);
    expect(resolveFullPositionCap("nonsense")).toBeGreaterThan(0);

    expect(formatPortConflictError("127.0.0.1", 8080)).toContain("127.0.0.1:8080");
  });

  it("shuts down gracefully on SIGTERM, frees the port and drops the generated credential", async () => {
    const dbPath = trackDir(tempDbPath("sigterm"));
    seedLedger(dbPath);
    const tokenFile = join(dirname(dbPath), "sigterm-session.token");

    const proc = Bun.spawn([process.execPath, "run", cliPath, "serve", "--port", "0", "--db", dbPath, "--json"], {
      cwd: repoRoot,
      env: { ...process.env, LOT_TRADER_DB: dbPath, LOT_TRADER_TOKEN_FILE: tokenFile },
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = proc.stdout.getReader();
    let buffer = "";
    let ready: any = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !ready) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += new TextDecoder().decode(chunk.value);
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.code === 0 && parsed.data?.port) {
            ready = parsed;
            break;
          }
        } catch {
          /* partial line */
        }
      }
    }

    expect(ready).not.toBeNull();
    const readyPort = Number((ready as any).data.port);
    const url = `http://127.0.0.1:${readyPort}/api/health`;
    const healthBody = (await (await fetch(url)).json()) as Record<string, any>;
    expect(healthBody.status).toBe("ok");
    expect(healthBody.port).toBe(readyPort);

    // --- credential published by the CLI ---
    expect((ready as any).data.auth).toBe("bearer");
    expect((ready as any).data.token_file).toBe(tokenFile);
    expect((ready as any).data.token_source).toBe("generated");
    expect((ready as any).data.token_ephemeral).toBe(true);

    expect(existsSync(tokenFile)).toBe(true);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const published = readFileSync(tokenFile, "utf8").trim();
    expect(published).toMatch(/^[0-9a-f]{64}$/);
    // The startup line reports where the credential lives, never the secret itself.
    expect(JSON.stringify(ready)).not.toContain(published);

    const denied = await fetch(`http://127.0.0.1:${readyPort}/api/summary`);
    expect(denied.status).toBe(401);
    const deniedBody = (await denied.json()) as Record<string, any>;
    expect(deniedBody.code).toBe("UNAUTHORIZED");

    const authed = await fetch(`http://127.0.0.1:${readyPort}/api/summary`, {
      headers: { Authorization: `Bearer ${published}` },
    });
    expect(authed.status).toBe(200);

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // An auto-generated credential must not outlive the process that published it.
    expect(existsSync(tokenFile)).toBe(false);

    // Port must be released: nothing listens any more.
    let reachable = true;
    try {
      await fetch(url, { signal: AbortSignal.timeout(1200) });
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
  }, 40_000);

  it("CLI reports the port conflict as a friendly message and exits 1", async () => {
    const dbPath = trackDir(tempDbPath("cli-conflict"));
    createEmptyLedger(dbPath);
    const holder = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(holder);

    const proc = Bun.spawn(
      [process.execPath, "run", cliPath, "serve", "--port", String(holder.port), "--db", dbPath, "--json"],
      { cwd: repoRoot, env: { ...process.env, LOT_TRADER_DB: dbPath }, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout.trim().split("\n").pop() as string);
    expect(payload.code).toBe(1);
    expect(payload.msg).toContain("已被占用");
    expect(`${stdout}${stderr}`).not.toContain("EADDRINUSE");
    expect(`${stdout}${stderr}`).not.toContain("    at ");
  }, 40_000);

  it("exposes `trade serve` in the CLI help output", async () => {
    const proc = Bun.spawn([process.execPath, "run", cliPath, "--help"], {
      cwd: repoRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("serve");
    expect(stdout).toContain("local read-only HTTP engine");

    const serveHelp = Bun.spawn([process.execPath, "run", cliPath, "serve", "--help"], {
      cwd: repoRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const serveStdout = await new Response(serveHelp.stdout).text();
    expect(await serveHelp.exited).toBe(0);
    expect(serveStdout).toContain("--port");
    expect(serveStdout).toContain("--host");
    expect(serveStdout).toContain("--db");
    expect(serveStdout).toContain("/api/health");
    expect(serveStdout).toContain("/api/summary");
    expect(serveStdout).toContain("/api/lots");
  }, 40_000);
});

// ===========================================================================
// 3. Pure aggregation helpers (no server)
// ===========================================================================

describe("trade serve: payload builders and price cache", () => {
  it("PriceBook caches live quotes and falls back without caching failures", async () => {
    let calls = 0;
    class CountingProvider extends QuoteProvider {
      override async getQuotes(symbols: string[]): Promise<Record<string, any>> {
        calls += 1;
        if (symbols.includes("FAIL.SH")) throw new Error("boom");
        return Object.fromEntries(symbols.map((s) => [s, { current_price: 9.99 }]));
      }
    }
    const book = new PriceBook(new CountingProvider(), 50);

    const first = await book.load(["518880.SH"]);
    expect(first["518880.SH"].source).toBe("live");
    expect(first["518880.SH"].price).toBe(9.99);

    const second = await book.load(["518880.SH"]);
    expect(second["518880.SH"].price).toBe(9.99);
    expect(calls).toBe(1); // second hit came from the cache

    const failed = await book.load(["FAIL.SH"]);
    expect(failed["FAIL.SH"]).toBeUndefined();
    await book.load(["FAIL.SH"]);
    expect(calls).toBe(3); // a failure is never pinned in the cache
  });

  it("buildLotsPayload / buildSummaryPayload never yield NaN for degenerate ledgers", async () => {
    const dbPath = trackDir(tempDbPath("degenerate"));
    const appDb = new AppDatabase(dbPath);
    const conn = appDb.getConnection();
    // Nulls / zeros / empty strings: the exact shapes a half-imported ledger produces.
    conn.run(
      `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
       VALUES ('LOT-ZERO', '', '518880.SH', '2025-03-01T09:30:00', 0, 0, 0, 0, 'ACTIVE')`,
    );
    const db = appDb.getConnection();
    const lots = await buildLotsPayload(db, { dbPath, priceBook: new PriceBook(new QuoteProvider({})) });
    expect(lots.total).toBe(1);
    assertNoNaN(lots, "degenerate lots");
    expect(everyNumberFinite(lots)).toBe(true);
    expect(lots.lots[0].account_id).toBe("DEFAULT");
    expect(lots.lots[0].market_value).toBe(0);
    expect(lots.lots[0].return_rate).toBe(0);

    const summary = await buildSummaryPayload(db, { dbPath, priceBook: new PriceBook(new QuoteProvider({})) });
    assertNoNaN(summary, "degenerate summary");
    expect(everyNumberFinite(summary)).toBe(true);
    expect(summary.portfolio.overall_return_rate).toBe(0);
    appDb.close();
  });

  it("normalizeAccountKey maps blank ids onto the generic fallback", () => {
    expect(normalizeAccountKey(null)).toBe("DEFAULT");
    expect(normalizeAccountKey(undefined)).toBe("DEFAULT");
    expect(normalizeAccountKey("  ")).toBe("DEFAULT");
    expect(normalizeAccountKey("ACC2")).toBe("ACC2");
  });
});

// ===========================================================================
// 3b. Runtime defect matrix
//
// Four live-test defects found by the owner, each guarded by a negative-first test:
//   1. a typo'd `--db` silently created a database / the default ledger was touched anyway;
//   2. `readLedgerLots` swallowed `SQLITE_BUSY` into `[]` (fake 200 + "empty book");
//   3. Layer 1 subtracted the Layer 2 per-symbol cap from the whole portfolio (-117万 / 2412%);
//   4. `?account=cmb` matched nothing and `?account=NOPE` answered 200 + empty list.
// ===========================================================================

describe("trade serve: runtime defect matrix (negative guards)", () => {
  /** Ledger where the account id really is `CMB` (the exact shape the owner reported). */
  function seedCmbLedger(dbPath: string): void {
    createEmptyLedger(dbPath);
    const db = new AppDatabase(dbPath);
    db.getConnection().run(
      `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
       VALUES ('LOT-CMB', 'CMB', '518880.SH', '2025-04-02T09:30:00', 6.10, 1000, 1000, 6.10, 'ACTIVE')`,
    );
    db.close();
  }

  /** A book worth far more than one symbol's 50k cap: the shape that produced -117万. */
  function seedOverCapLedger(dbPath: string): void {
    createEmptyLedger(dbPath);
    const db = new AppDatabase(dbPath);
    db.getConnection().run(
      `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
       VALUES ('LOT-BIG', 'DEFAULT', '518880.SH', '2025-01-02T09:30:00', 6.10, 200000, 200000, 6.10, 'ACTIVE')`,
    );
    db.close();
  }

  /**
   * Materialize a fixture in a CHILD process, optionally running one seed statement.
   *
   * Two reasons this must not happen in-process:
   *   * `bun:sqlite` checkpoints a closed WAL lazily, so a live process can still rewrite the
   *     `-wal`/`-shm` ~1s after `close()` — that would make the "untouchable" default ledger
   *     move *after* we snapshot it (false positive);
   *   * a lingering parent connection keeps a lock on the file, and a second process opening
   *     it can fail with `database is locked`.
   * A separate process flushes and releases everything on exit.
   */
  function createLedgerInSubprocess(dbPath: string, seedSql?: string): void {
    const script = `import { AppDatabase } from "./src/db.ts";
const db = new AppDatabase(process.argv[1]);
const sql = process.argv[2];
if (sql) db.getConnection().run(sql);
db.close();`;
    const proc = Bun.spawnSync([process.execPath, "-e", script, dbPath, seedSql ?? ""], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`fixture creation failed: ${proc.stderr.toString()}`);
    }
    if (!existsSync(dbPath)) throw new Error(`fixture was not created: ${dbPath}`);
  }

  /**
   * Spawn `trade serve` and wait for its `--json` ready line.
   *
   * stdio goes to FILES rather than pipes, so the child never competes with the test runner for
   * a pipe, and the raw output stays on disk: a failure reports the child's exit code plus the
   * exact `{"code":1,...}` line it emitted instead of a bare timeout.
   */
  async function spawnServe(args: string[], env: Record<string, string>) {
    const logDir = mkdtempSync(join(tmpdir(), "defect_spawn_"));
    tempDirs.push(logDir);
    const outPath = join(logDir, "stdout.log");
    const errPath = join(logDir, "stderr.log");
    const outFd = openSync(outPath, "a");
    const errFd = openSync(errPath, "a");

    const proc = Bun.spawn([process.execPath, "run", cliPath, "serve", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdout: outFd,
      stderr: errFd,
      stdin: "ignore",
    });
    // The child owns the inherited descriptors now; the parent must drop its copies.
    closeSync(outFd);
    closeSync(errFd);

    const readOut = (): string => (existsSync(outPath) ? readFileSync(outPath, "utf8") : "");
    const readErr = (): string => (existsSync(errPath) ? readFileSync(errPath, "utf8") : "");

    let ready: any = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !ready) {
      for (const line of readOut().split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.code === 0 && parsed.data?.port) {
            ready = parsed;
            break;
          }
        } catch {
          /* partial line */
        }
      }
      if (ready || proc.exitCode !== null) break;
      await Bun.sleep(50);
    }
    return { proc, ready, readOut, readErr };
  }

  it("defect 4 unit: account keys are case-insensitive and blank maps to the generic fallback", () => {
    expect(normalizeAccountKey(null)).toBe("DEFAULT");
    expect(normalizeAccountKey(undefined)).toBe("DEFAULT");
    expect(normalizeAccountKey("  ")).toBe("DEFAULT");
    expect(normalizeAccountKey("ACC2")).toBe("ACC2");
    expect(normalizeAccountKey("cmb")).toBe("CMB");
    expect(normalizeAccountKey("Cmb")).toBe("CMB");
    expect(normalizeAccountKey(" CMB ")).toBe("CMB");
  });

  it("defect 1: a non-existent --db exits 1, prints a friendly refusal and creates NO file/WAL", async () => {
    const dir = join(tmpdir(), `defect1_ghost_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    tempDirs.push(dir);
    const ghost = join(dir, "ghost.db");

    const { proc, ready, readOut, readErr } = await spawnServe(["--port", "0", "--db", ghost, "--json"], {
      LOT_TRADER_TOKEN_FILE: join(dir, "session.token"),
    });
    const exitCode = await proc.exited;
    const stdout = readOut();
    const stderr = readErr();

    expect(ready).toBeNull();
    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout.trim().split("\n").pop() as string);
    expect(payload.code).toBe(1);
    expect(payload.msg).toContain("数据库文件不存在");
    expect(payload.msg).toContain("拒绝隐式建库");
    // The whole point: no implicit create, no SQLite sidecar files, not even the directory.
    expect(existsSync(ghost)).toBe(false);
    expect(existsSync(`${ghost}-wal`)).toBe(false);
    expect(existsSync(`${ghost}-shm`)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(`${stdout}${stderr}`).not.toContain("    at ");

    // The in-process API must fail closed too (no CLI-only guard).
    await expect(
      startServe({ port: 0, dbPath: ghost, quoteProvider: new QuoteProvider({}) }),
    ).rejects.toThrow(/数据库文件不存在/);
    expect(existsSync(ghost)).toBe(false);
  }, 40_000);

  it("defect 1: `serve --db <other>` never opens or touches the default ~/.trade ledger", async () => {
    const home = join(tmpdir(), `defect1_home_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });

    const defaultLedger = join(home, ".trade", "trade.db");
    createLedgerInSubprocess(defaultLedger);
    const artifacts = [defaultLedger, `${defaultLedger}-wal`, `${defaultLedger}-shm`];
    const fingerprint = (): string[] =>
      artifacts.map((p) => (existsSync(p) ? `${statSync(p).mtimeMs}|${statSync(p).size}` : "absent"));
    const before = fingerprint();

    const other = trackDir(tempDbPath("defect1_other"));
    // Created in a subprocess: this process must hold NO handle on the ledger under test.
    createLedgerInSubprocess(
      other,
      `INSERT INTO lots (lot_id, account_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
       VALUES ('LOT-OTHER', 'DEFAULT', '518880.SH', '2025-01-02T09:30:00', 6.10, 1000, 1000, 6.10, 'ACTIVE')`,
    );

    const tokenFile = join(home, "session.token");
    const { proc, ready, readOut, readErr } = await spawnServe(["--port", "0", "--db", other, "--json"], {
      HOME: home,
      LOT_TRADER_TOKEN_FILE: tokenFile,
    });
    try {
      expect(
        ready,
        `trade serve did not start (exit=${proc.exitCode}) out=${readOut()} err=${readErr()}`,
      ).not.toBeNull();
      // The engine is genuinely alive and bound to the EXPLICIT ledger.
      const port = Number((ready as any).data.port);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as Record<string, any>).db_path).toBe(other);

      // Read-only + isolated: the default ledger (and its shm/wal) is untouched.
      expect(fingerprint()).toEqual(before);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }

    expect(fingerprint()).toEqual(before);
  }, 40_000);

  it("defect 2: a real database failure is a 500 DATABASE_ERROR, never a fake 200 empty book", async () => {
    const dbPath = trackDir(tempDbPath("defect2"));
    seedLedger(dbPath);

    const lockedDb = {
      query() {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as Database;
    const handler = createRequestHandler(lockedDb, {
      dbPath,
      priceBook: new PriceBook(new QuoteProvider({})),
      fullPositionCap: 50000,
      startedAt: Date.now(),
      sessionToken: "defect-token",
      host: "127.0.0.1",
      port: 8080,
    });

    for (const route of ["/api/summary", "/api/lots"]) {
      const resp = await handler(
        new Request(`http://127.0.0.1:8080${route}`, {
          headers: { Host: "127.0.0.1:8080", Authorization: "Bearer defect-token" },
        }),
      );
      expect(resp.status).toBe(500);
      const body = (await resp.json()) as Record<string, any>;
      expect(body.status).toBe("error");
      expect(body.code).toBe("DATABASE_ERROR");
      expect(body.message).toContain("数据库查询失败");
      expect(body.message).toContain("SQLITE_BUSY");
      // A refusal must never look like a legitimately empty portfolio.
      expect(JSON.stringify(body)).not.toContain("total_cost");
      expect(JSON.stringify(body)).not.toContain("total\": 0");
    }
  });

  it("defect 2 anti-false-positive: a legacy ledger missing the newest columns still serves", () => {
    const dbPath = trackDir(tempDbPath("defect2_legacy"));
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE lots (
        lot_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, buy_time TEXT NOT NULL,
        buy_price REAL NOT NULL, buy_quantity INTEGER NOT NULL, remaining_quantity INTEGER NOT NULL,
        cost_basis_unit REAL NOT NULL, status TEXT NOT NULL
      );
    `);
    legacy.run(
      `INSERT INTO lots (lot_id, symbol, buy_time, buy_price, buy_quantity, remaining_quantity, cost_basis_unit, status)
       VALUES ('L1', '518880.SH', '2025-01-02T09:30:00', 6.1, 1000, 1000, 6.1, 'ACTIVE')`,
    );
    legacy.close();

    const db = new Database(dbPath);
    const rows = readLedgerLots(db);
    db.close();

    expect(rows.length).toBe(1);
    // Known-missing columns fall back per column; the row is NOT silently dropped.
    expect(rows[0].account_id).toBe("DEFAULT");
    expect(rows[0].peak_price).toBeNull();
    expect(rows[0].realized_pnl).toBe(0);
    expect(rows[0].trailing_stop_active).toBe(0);
  });

  it("defect 4: ?account=cmb / CMB / Cmb agree, and ?account=NOPE is a 400 (not an empty 200)", async () => {
    const dbPath = trackDir(tempDbPath("defect4"));
    seedCmbLedger(dbPath);
    const srv = await startServe({
      port: 0,
      dbPath,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6 }),
    });
    openServers.push(srv);

    const bodies = await Promise.all(
      ["cmb", "CMB", "Cmb"].map(async (value) => {
        const resp = await apiGet(srv, `/api/lots?account=${value}`);
        expect(resp.status).toBe(200);
        return (await resp.json()) as Record<string, any>;
      }),
    );

    expect(bodies[0].total).toBe(1);
    expect(bodies[1].total).toBe(1);
    expect(bodies[2].total).toBe(1);
    expect(bodies[0].filters.account).toBe("CMB");
    expect(bodies[1].filters.account).toBe("CMB");
    expect(bodies[2].filters.account).toBe("CMB");
    expect(bodies[0].lots[0].account_id).toBe("CMB");

    // `ALL` stays a legal wildcard, never an account lookup.
    const all = (await (await apiGet(srv, "/api/lots?account=ALL")).json()) as Record<string, any>;
    expect(all.status).toBe("ok");
    expect(all.total).toBe(1);
    expect(all.filters.account).toBeNull();

    // An unregistered account is a client error, not a silent empty list.
    const nope = await apiGet(srv, "/api/lots?account=NOPE");
    expect(nope.status).toBe(400);
    const nopeBody = (await nope.json()) as Record<string, any>;
    expect(nopeBody.status).toBe("error");
    expect(nopeBody.message).toContain("非法账户代码");
    expect(nopeBody.message).toContain("NOPE");
    expect(nopeBody.message).toContain("未在系统中登记");
    expect(JSON.stringify(nopeBody)).not.toContain("LOT-CMB");
  });

  it("defect 3: the portfolio never fabricates a budget; symbols keep a per-symbol utilisation", async () => {
    const dbPath = trackDir(tempDbPath("defect3"));
    seedOverCapLedger(dbPath);
    const srv = await startServe({
      port: 0,
      dbPath,
      fullPositionCap: 50000,
      quoteProvider: new QuoteProvider({ "518880.SH": 6.6 }),
    });
    openServers.push(srv);

    const body = (await (await apiGet(srv, "/api/summary")).json()) as Record<string, any>;
    const p = body.portfolio;

    // The exact shape that used to yield `remaining_budget = -1,170,601.42` and `24.412`.
    expect(p.total_market_value).toBeGreaterThan(50000);
    expect(p.full_position_cap).toBe(50000);
    expect(p.full_position_cap_scope).toBe("per_symbol");
    expect(p.remaining_budget).toBeNull();
    expect(p.budget_utilization_rate).toBeNull();
    // Nothing in the payload may carry a negative "budget" or >100% "utilisation" any more.
    expect(JSON.stringify(p)).not.toContain("remaining_budget\": -");

    // Layer 2 keeps the *meaningful* single-symbol utilisation.
    expect(body.symbols.length).toBe(1);
    const sym = body.symbols[0];
    expect(sym.full_position_cap).toBe(50000);
    expect(sym.current_position_rate).toBeCloseTo(sym.market_value / 50000, 4);
    expect(sym.cost_position_rate).toBeCloseTo(sym.total_cost_basis / 50000, 4);
    expect(sym.current_position_rate).toBeGreaterThan(0);
    expect(sym.current_position_rate).toBeCloseTo(1320000 / 50000, 4);
  });
});

// ===========================================================================
// 4. Dashboard template + generated HTML contract
// ===========================================================================

describe("dashboard dual-mode contract", () => {
  const template = readFileSync(templatePath, "utf-8");

  it("ships the standalone self-driving engine with pause control and flash feedback", () => {
    expect(template).toContain('id="live-client-runtime"');
    expect(template).toContain("qt.gtimg.cn");
    expect(template).toContain("QUOTE_REFRESH_MS = 5000");
    expect(template).toContain("IDLE_REFRESH_MS = 60000");
    expect(template).toContain("id=\"btn-live-toggle\"");
    expect(template).toContain("暂停行情刷新");
    expect(template).toContain("flash-up");
    expect(template).toContain("flash-down");
    expect(template).toMatch(/@keyframes priceFlashUp/);
    expect(template).toMatch(/@keyframes priceFlashDown/);
    expect(template).toContain("data-field=\"price\"");
    expect(template).toContain("data-field=\"mkt\"");
    expect(template).toContain("data-field=\"pnl\"");
    expect(template).toContain("data-field=\"rate\"");
    expect(template).toContain("applyLiveKpis");
  });

  it("ships the mode badge, the 3s heartbeat and the onboarding copy card", () => {
    expect(template).toContain('id="mode-indicator"');
    expect(template).toContain('id="mode-text"');
    expect(template).toContain("模式：轻量独立（纯前端自驱）");
    expect(template).toContain("模式：本地引擎已联动");
    expect(template).toContain("HEARTBEAT_MS = 3000");
    expect(template).toContain("/api/health");
    expect(template).toContain("http://127.0.0.1:8080");
    expect(template).toContain('id="local-service-card"');
    expect(template).toContain("trade serve");
    expect(template).toContain("copyServeCommand");
    expect(template).toContain("一键复制");
    expect(template).toContain("modeBreathGreen");
  });

  it("generated dashboard HTML carries the whole dual-mode runtime", async () => {
    const dbPath = trackDir(tempDbPath("gen"));
    seedLedger(dbPath);
    const outPath = join(dbPath, "..", "dual-mode.html");
    const binDir = join(dbPath, "..", "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "trade");
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`);
    chmodSync(shim, 0o755);

    const proc = Bun.spawn([process.execPath, "run", cliPath, "dashboard", "--out", outPath, "--db", dbPath, "--json"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LOT_TRADER_DB: dbPath,
        TRADE_DB_PATH: dbPath,
        LOT_TRADER_TOKEN_FILE: join(dirname(dbPath), "dashboard-session.token"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    expect(JSON.parse(stdout).code).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const html = readFileSync(outPath, "utf-8");
    for (const marker of [
      'id="live-client-runtime"',
      'id="mode-indicator"',
      'id="mode-text"',
      'id="btn-local-service"',
      'id="local-service-card"',
      'id="btn-live-toggle"',
      "模式：轻量独立（纯前端自驱）",
      "模式：本地引擎已联动",
      "trade serve",
      "copyServeCommand",
      "HEARTBEAT_MS = 3000",
      "QUOTE_REFRESH_MS = 5000",
      "/api/health",
      "flash-up",
    ]) {
      expect(html.includes(marker), `generated HTML missing ${marker}`).toBe(true);
    }

    // No template placeholder survived.
    expect(/\{\{[A-Z_]+\}\}/.test(html)).toBe(false);

    // No NaN reached the rendered markup (the inline runtime legitimately *mentions*
    // NaN in its guard code, so the script blocks are stripped before asserting).
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    expect(markup.includes("NaN")).toBe(false);
    expect(markup.includes("Infinity")).toBe(false);

    // Embedded client payloads must be NaN-free as well.
    const targetsPayload = html.match(/const TARGETS_DATA = ([\s\S]*?);\n/);
    const metricsPayload = html.match(/const ACCOUNT_METRICS = ([\s\S]*?);\n/);
    expect(targetsPayload).not.toBeNull();
    expect(metricsPayload).not.toBeNull();
    expect(targetsPayload![1].includes("NaN")).toBe(false);
    expect(metricsPayload![1].includes("NaN")).toBe(false);

    // The live hooks the runtime relies on are actually rendered.
    expect(html).toContain('data-field="price"');
    expect(html).toContain('data-field="rate"');
    expect(html).toMatch(/data-lot-id="LOT-GOLD"/);
    expect(html).toMatch(/data-status="ACTIVE"/);
  }, 60_000);
});

// ===========================================================================
// 4b. Zero hardcoded history: template + generated-output negative assertions
//
// The three-pillar cards used to be static prose ("60.2%", "¥75.2 万元", 纳指/标普/长江电力…).
// These are regression tripwires: any reintroduced literal fails the build.
// ===========================================================================

describe("dashboard: zero hardcoded history (P0 anti-regression)", () => {
  const template = readFileSync(templatePath, "utf-8");

  /** Stale phrases that were baked into template_base.html's pillar cards / narrative. */
  const STALE_TEMPLATE_LITERALS = [
    "60.2%",
    "12.5%",
    "27.3%",
    "¥75.2 万元",
    "+¥21.93 万元",
    "+8.89 万",
    "+8.57 万",
    "¥13.6 万元",
    "+¥4.01 万元",
    "+2.29 万",
    "+1.52 万",
    "2.29x",
    "1.57x",
    "+33.54 万元",
    "-34.75 万元",
    "1.8 万元",
  ];

  /** Private position names that must never live inside a *template*. */
  const PRIVATE_SYMBOL_LITERALS = [
    "纳指 ETF",
    "标普 500",
    "日经",
    "长江电力",
    "招商银行",
    "塔牌集团",
    "工商银行",
    "恒瑞",
    "我武",
    "海螺",
    "榨菜",
    "*ST美芝",
    "合盛",
    "恒生互联",
    "劲嘉",
    "天山",
  ];

  /** Unambiguous stale numbers that must never reappear verbatim in a generated page. */
  const STALE_GENERATED_LITERALS = [
    "¥75.2 万元",
    "+¥21.93 万元",
    "+8.89 万",
    "+8.57 万",
    "¥13.6 万元",
    "+¥4.01 万元",
    "+2.29 万",
    "+1.52 万",
    "+33.54 万元",
    "-34.75 万元",
    "1.8 万元",
    "13 只核心资产",
    "34 只 A 股赛道",
  ];

  it("NEGATIVE: the template carries no stale numbers and no private symbol names", () => {
    for (const literal of STALE_TEMPLATE_LITERALS) {
      expect(template.includes(literal), `template leaked stale literal ${literal}`).toBe(false);
    }
    for (const literal of PRIVATE_SYMBOL_LITERALS) {
      expect(template.includes(literal), `template leaked private symbol ${literal}`).toBe(false);
    }
    // The pillar section must be a data-driven placeholder, not prose.
    expect(template).toContain("{{ALLOC_PILLARS_HTML}}");
    expect(template).toContain("{{ALLOC_CLASS_METRICS_JSON}}");
  });

  it("NEGATIVE: the generator carries no hardcoded per-symbol history either", () => {
    const generator = readFileSync(join(repoRoot, "scripts", "generate_dashboard.py"), "utf-8");
    // Old per-symbol narratives such as `在场 18,000 份…浮盈超 8.5 万元 (+128.9%)`.
    for (const literal of ["浮盈超 9.3 万元", "浮盈超 8.5 万元", "豪取 12,094 元", "+1.52万"]) {
      expect(generator.includes(literal), `generator leaked stale narrative ${literal}`).toBe(false);
    }
    // The whole narrative is now derived from metrics, not from a lookup table.
    expect(generator).toContain("def build_strategy_note(m, strat_tag)");
  });

  it("generated HTML is fully ledger-driven and written with mode 0600", async () => {
    const dbPath = trackDir(tempDbPath("zero_hardcode"));
    seedLedger(dbPath);
    const outPath = join(dirname(dbPath), "zero-hardcode.html");
    const binDir = join(dirname(dbPath), "bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "trade");
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(cliPath)} "$@"\n`);
    chmodSync(shim, 0o755);

    const proc = Bun.spawn(
      [process.execPath, "run", cliPath, "dashboard", "--out", outPath, "--db", dbPath, "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          LOT_TRADER_DB: dbPath,
          TRADE_DB_PATH: dbPath,
          LOT_TRADER_TOKEN_FILE: join(dirname(dbPath), "zero-hardcode.token"),
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    // P0: the page embeds the 0600 session credential, so the file itself must be 0600
    // (owner-only). A umask-inherited 0644 leaks the token to every local user.
    expect(statSync(outPath).mode & 0o777).toBe(0o600);

    const html = readFileSync(outPath, "utf-8");
    for (const literal of STALE_GENERATED_LITERALS) {
      expect(html.includes(literal), `generated page leaked stale literal ${literal}`).toBe(false);
    }
    expect(/\{\{[A-Z_]+\}\}/.test(html)).toBe(false);

    // The pillars are rendered from real asset classes plus the cash-recycling layer.
    expect(html).toContain('id="alloc-grid"');
    expect(html).toContain('data-alloc-class="ETF"');
    expect(html).toContain('data-alloc-class="STOCK"');
    expect(html).toContain('data-alloc-class="CASH"');
    expect(html).toContain('id="alloc-class-ETF-ratio"');
    expect(html).toContain("const ALLOC_CLASS_METRICS = {");
    // Both seeded symbols are ETFs => the STOCK card must be a neutral placeholder, no guess.
    expect(html).toContain("当前账本暂无 asset_class=STOCK 的在场持仓");
  }, 60_000);
});

// ===========================================================================
// 5. Front-end negative guards (deterministic DOM sandbox)
// ===========================================================================

describe("dashboard front-end: quote feed negative guards", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(() => {
    if (harness) harness.stop();
  });

  it("parses a well-formed qt.gtimg.cn payload", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const body =
      'v_sh518880="1~黄金ETF~518880~6.120~6.050~6.080~12345~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20251022150000~6.15~6.02~6.20~6.00~12345~0~0~0.27";';
    const parsed = LCR.parseTencentPayload(body);
    expect(parsed.sh518880.price).toBe(6.12);
    expect(parsed.sh518880.prev_close).toBe(6.05);
    expect(parsed.sh518880.name).toBe("黄金ETF");

    const mapped = LCR.mapQuotesToSymbols(parsed, ["518880.SH"], {});
    expect(mapped["518880.SH"].price).toBe(6.12);
    expect(mapped["518880.SH"].direction).toBe("flat");
    expect(mapped["518880.SH"].prev_close).toBe(6.05);
  });

  it("NEGATIVE: an HTML 502 / truncated / empty quote body degrades to an empty map (no throw, no NaN)", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const hostileBodies = [
      "<html><body>502 Bad Gateway</body></html>",
      "upstream connect error or disconnect/reset before headers",
      'v_sh518880="1~x~518880~abc~def";',
      'v_sh518880="";',
      'v_999999="1~bogus~999999~1.0";',
      "",
      "null",
      "{}",
      'v_sh518880="1~黄金ETF~518880~6.120~6.050~6.080~12345',
    ];
    for (const body of hostileBodies) {
      const parsed = LCR.parseTencentPayload(body);
      expect(typeof parsed).toBe("object");
      expect(JSON.stringify(parsed)).not.toContain("NaN");
    }
    expect(LCR.parseTencentPayload("<html>502</html>")).toEqual({});
    expect(h.errors).toEqual([]);
  });

  it("NEGATIVE: total network failure resolves to an empty result instead of rejecting", async () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }), quoteThrows: true });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const result = await h.settle(
      LCR.fetchTencentQuotes({
        codes: ["sh518880"],
        url: "https://qt.gtimg.cn/q=sh518880",
        timeoutMs: 50,
        fetchImpl: async () => {
          throw new Error("Failed to fetch");
        },
      }),
    );
    expect(result.quotes).toEqual({});
    expect(result.error).toBe("network_error");
    expect(result.transport).toBe("none");
  });

  it("NEGATIVE: buildTencentQuoteUrl refuses an empty code list", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;
    expect(LCR.buildTencentQuoteUrl([])).toBe("");
    expect(LCR.buildTencentQuoteUrl(["", null, undefined])).toBe("");
    expect(LCR.dedupeCodes(["sh518880", "SH518880", "sz159934", "junk"])).toEqual(["sh518880", "sz159934"]);
    expect(LCR.buildTencentQuoteUrl(["518880.SH", "sz159934"])).toBe(
      "https://qt.gtimg.cn/q=sh518880,sz159934",
    );
  });

  it("NEGATIVE: no cell can ever render NaN after a garbage refresh", async () => {
    const h = createHarness({
      healthProbe: async () => ({ ok: false, status: 0 }),
      quoteBody: "<html>502 Bad Gateway</html>",
    });
    harness = h;

    // let the boot tick run
    h.runTimers(5000);
    await Bun.sleep(20);

    const text = h.allText();
    expect(text.includes("NaN")).toBe(false);
    expect(text.includes("undefined")).toBe(false);
    expect(h.element("mode-text").textContent).toContain("轻量独立");
    expect(h.errors).toEqual([]);

    // Now push a genuinely live quote through the same path.
    h.sandbox.LiveClientRuntime.mapQuotesToSymbols({}, ["518880.SH"], {});
    const applied = h.sandbox.LiveClientRuntime.computeHoldingLive({
      quantity: 1500,
      costUnit: 6.1333,
      price: 6.6,
    });
    expect(applied.marketValue).toBe(9900);
    // 9900 (mkt) - 9199.95 (cost) - 1.98 (est. ETF sell fee) = 698.07
    expect(applied.floatingPnl).toBeCloseTo(698.07, 2);
    expect(Number.isFinite(applied.returnRate)).toBe(true);
    expect(h.allText().includes("NaN")).toBe(false);
  });

  it("computeHoldingLive is NaN-proof for null / '' / NaN / negative inputs", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const inputs = [
      {},
      { quantity: null, costUnit: null, price: null },
      { quantity: "", costUnit: "", price: "" },
      { quantity: NaN, costUnit: NaN, price: NaN },
      { quantity: -100, costUnit: -1, price: -5 },
      { quantity: "abc", costUnit: "xyz", price: "nope" },
      { quantity: Infinity, costUnit: Infinity, price: Infinity },
      { quantity: 100, costUnit: 0, price: 5 },
      { quantity: 100, costUnit: 5, price: undefined },
    ];
    for (const input of inputs) {
      const live = LCR.computeHoldingLive(input);
      for (const key of ["price", "quantity", "costUnit", "marketValue", "costTotal", "floatingPnl", "returnRate", "dayChangePct"]) {
        expect(Number.isFinite(live[key]), `${key} for ${JSON.stringify(input)}`).toBe(true);
      }
      expect(live.returnRate).toBeGreaterThanOrEqual(-1.5);
      expect(live.returnRate).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("dashboard front-end: heartbeat upgrade and degradation", () => {
  let harness: Harness | null = null;

  afterEach(() => {
    if (harness) harness.stop();
  });

  it("NEGATIVE: a closed local engine demotes the badge to standalone with zero uncaught exceptions", async () => {
    // Every probe fails exactly like a stopped `trade serve` (connection refused).
    const h = createHarness({
      healthProbe: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
      },
      quoteBody: "",
    });
    harness = h;

    expect(h.element("mode-text").textContent).toContain("轻量独立");

    // One missed beat keeps the state (smooth); the second demotes it.
    h.runTimers(3000);
    await Bun.sleep(20);
    h.runTimers(3000);
    await Bun.sleep(20);

    const indicator = h.element("mode-indicator");
    expect(indicator.classList.contains("standalone")).toBe(true);
    expect(indicator.classList.contains("local")).toBe(false);
    expect(h.element("mode-text").textContent).toBe("模式：轻量独立（纯前端自驱）");

    // The status line must stay readable, never blank.
    expect(h.element("live-status").textContent.length).toBeGreaterThan(0);

    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
  });

  it("NEGATIVE: an HTTP-200-but-not-JSON health response is treated as offline", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON at position 0");
        },
      }),
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(20);
    h.runTimers(3000);
    await Bun.sleep(20);

    expect(h.element("mode-indicator").classList.contains("standalone")).toBe(true);
    expect(h.element("mode-text").textContent).toContain("轻量独立");
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
  });

  it("NEGATIVE: a health payload without status:ok never upgrades the mode", async () => {
    const h = createHarness({
      healthProbe: async () => ({ ok: true, status: 200, json: async () => ({ hello: "world" }) }),
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(20);
    h.runTimers(3000);
    await Bun.sleep(20);

    expect(h.element("mode-indicator").classList.contains("local")).toBe(false);
    expect(h.element("mode-text").textContent).toContain("轻量独立");
    expect(h.rejections).toEqual([]);
  });

  it("upgrades seamlessly to the local engine when /api/health answers", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", db_path: "/tmp/x.db", timestamp: Date.now() }),
      }),
      summaryBody: {
        status: "ok",
        symbols: [
          { symbol: "518880.SH", current_price: 6.66, price_source: "live" },
          { symbol: "159934.SZ", current_price: 7.28, price_source: "live" },
        ],
      },
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(30);

    const indicator = h.element("mode-indicator");
    expect(indicator.classList.contains("local")).toBe(true);
    expect(indicator.classList.contains("standalone")).toBe(false);
    expect(h.element("mode-text").textContent).toBe("模式：本地引擎已联动");

    // Data flow follows the engine: /api/summary is preferred while in LOCAL mode.
    h.runTimers(5000);
    await Bun.sleep(30);
    expect(h.fetchCalls.some((url) => url.includes("/api/summary"))).toBe(true);
    expect(h.allText().includes("NaN")).toBe(false);
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
  });

  it("hysteresis keeps LOCAL mode through a single missed beat", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;
    expect(LCR.nextMode("LOCAL", false, 1)).toBe("LOCAL");
    expect(LCR.nextMode("LOCAL", false, 2)).toBe("STANDALONE");
    expect(LCR.nextMode("STANDALONE", true, 0)).toBe("LOCAL");
    expect(LCR.nextMode("STANDALONE", false, 9)).toBe("STANDALONE");
  });

  it("probeLocalService never rejects and honours the timeout", async () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const dead = await h.settle(
      LCR.probeLocalService(async () => {
        throw new Error("ECONNREFUSED");
      }, "http://127.0.0.1:8080/api/health", 50),
    );
    expect(dead.ok).toBe(false);
    expect(dead.reason).toBe("network_error");

    // A hung socket must be cut by the timeout, not by an unhandled rejection.
    const hung = await h.settle(
      LCR.probeLocalService(() => new Promise(() => {}), "http://127.0.0.1:8080/api/health", 80),
    );
    expect(hung.ok).toBe(false);
    expect(hung.reason).toBe("timeout");

    const noFetch = await h.settle(LCR.probeLocalService(null, "http://127.0.0.1:8080/api/health", 50));
    expect(noFetch.ok).toBe(false);

    const healthy = await h.settle(
      LCR.probeLocalService(
        async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
        "http://127.0.0.1:8080/api/health",
        50,
      ),
    );
    expect(healthy.ok).toBe(true);
    expect(healthy.data.status).toBe("ok");
  });

  it("refresh policy: 5s while trading, 60s idle, paused stops the timer", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    const trading = new Date("2025-10-24T10:15:00");
    const lunch = new Date("2025-10-24T12:00:00");
    const closed = new Date("2025-10-24T15:30:00");
    const weekend = new Date("2025-10-25T10:15:00");
    expect(LCR.isTradingSession(trading)).toBe(true);
    expect(LCR.isTradingSession(lunch)).toBe(false);
    expect(LCR.isTradingSession(closed)).toBe(false);
    expect(LCR.isTradingSession(weekend)).toBe(false);
    expect(LCR.nextRefreshDelay(trading, false)).toBe(5000);
    expect(LCR.nextRefreshDelay(closed, false)).toBe(60000);
    expect(LCR.nextRefreshDelay(trading, true)).toBe(0);
  });

  it("pause / resume control toggles the engine without breaking the page", async () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }), quoteBody: "" });
    harness = h;

    h.hooks.toggleLiveQuotes();
    expect(h.hooks.LIVE.paused).toBe(true);
    expect(h.element("live-status").textContent).toContain("暂停");
    expect(h.element("btn-live-toggle").textContent).toContain("继续行情刷新");

    h.hooks.toggleLiveQuotes();
    expect(h.hooks.LIVE.paused).toBe(false);
    expect(h.element("btn-live-toggle").textContent).toContain("暂停行情刷新");
    expect(h.errors).toEqual([]);
  });

  it("onboarding card opens, copies the command and survives a clipboard failure", async () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;

    h.hooks.toggleLocalServicePanel();
    expect(h.element("local-service-card").classList.contains("open")).toBe(true);
    h.hooks.toggleLocalServicePanel(true);
    expect(h.element("local-service-card").classList.contains("open")).toBe(true);
    h.hooks.toggleLocalServicePanel(false);
    expect(h.element("local-service-card").classList.contains("open")).toBe(false);

    // No navigator.clipboard in the sandbox -> the textarea fallback must not throw.
    expect(() => h.hooks.copyServeCommand()).not.toThrow();
    await Bun.sleep(10);
    expect(h.errors).toEqual([]);
  });

  it("surfaces the degraded-ledger alert bar when /api/summary says degraded", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", db_path: "/tmp/x.db", timestamp: Date.now() }),
      }),
      summaryBody: {
        status: "ok",
        degraded: true,
        degraded_reason: "测试：批次表(lots)为 0 行",
        symbols: [{ symbol: "518880.SH", current_price: 6.66, price_source: "live" }],
      },
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(30);
    h.runTimers(5000);
    await Bun.sleep(30);

    expect(h.element("ledger-degraded-banner").classList.contains("open")).toBe(true);
    expect(h.element("ledger-degraded-reason").textContent).toContain("批次表(lots)为 0 行");
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
  });

  it("NEGATIVE anti-false-positive: a healthy ledger keeps the alert bar hidden", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", db_path: "/tmp/x.db", timestamp: Date.now() }),
      }),
      summaryBody: {
        status: "ok",
        degraded: false,
        degraded_reason: null,
        symbols: [{ symbol: "518880.SH", current_price: 6.66, price_source: "live" }],
      },
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(30);
    h.runTimers(5000);
    await Bun.sleep(30);

    expect(h.element("ledger-degraded-banner").classList.contains("open")).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it("account switching re-renders the dynamic pillar cards from the payload", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;

    h.hooks.renderAllocPillars("ALL");
    expect(h.element("alloc-class-ETF-ratio").textContent).toBe("50.0%");
    expect(h.element("alloc-class-ETF-desc").textContent).toContain("动态聚合示例");
    expect(h.element("alloc-class-CASH-stats").innerHTML).toContain("持仓市值");
    expect(h.errors).toEqual([]);
  });
});

// ===========================================================================
// 6. Front-end credential injection (dashboard <- 0600 token)
//
// The generated page must authenticate transparently when a credential was injected, and
// degrade to a fully self-driving page (no NaN, no uncaught error) when the local engine
// answers 401 because the token is missing or stale.
// ===========================================================================

describe("dashboard front-end: local session credential", () => {
  let harness: Harness | null = null;

  afterEach(() => {
    if (harness) harness.stop();
  });

  const LIVE_QUOTE_BODY =
    'v_sh518880="1~黄金ETF~518880~6.120~6.050~6.080~12345~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20251022150000~6.15~6.02~6.20~6.00~12345~0~0~0.27";';

  it("unit: sessionToken / authHeaders / withSessionToken stay inert without a credential", () => {
    const h = createHarness({ healthProbe: async () => ({ ok: false, status: 0 }) });
    harness = h;
    const LCR = h.sandbox.LiveClientRuntime;

    expect(LCR.sessionToken()).toBe("");
    expect(LCR.authHeaders()).toEqual({});
    expect(LCR.authHeaders(null)).toEqual({});
    expect(LCR.withSessionToken("http://127.0.0.1:8080/api/summary")).toBe(
      "http://127.0.0.1:8080/api/summary",
    );

    h.sandbox.__LOT_TRADER_SESSION_TOKEN__ = "  deadbeef  ";
    expect(LCR.sessionToken()).toBe("deadbeef");
    expect(LCR.authHeaders()).toEqual({ Authorization: "Bearer deadbeef" });
    expect(LCR.authHeaders("other")).toEqual({ Authorization: "Bearer other" });
    expect(LCR.withSessionToken("http://127.0.0.1:8080/api/summary")).toBe(
      "http://127.0.0.1:8080/api/summary?token=deadbeef",
    );
    expect(LCR.withSessionToken("http://127.0.0.1:8080/api/lots?status=ACTIVE")).toBe(
      "http://127.0.0.1:8080/api/lots?status=ACTIVE&token=deadbeef",
    );
    // Idempotent: an already-tagged URL is never double-tagged.
    expect(LCR.withSessionToken("http://127.0.0.1:8080/api/lots?token=x")).toBe(
      "http://127.0.0.1:8080/api/lots?token=x",
    );
    expect(LCR.withSessionToken("", "deadbeef")).toBe("");

    // Junk credentials must degrade to "unconfigured", never to a thrown error.
    for (const junk of [null, undefined, {}, [], 0, true]) {
      h.sandbox.__LOT_TRADER_SESSION_TOKEN__ = junk;
      expect(LCR.sessionToken()).toBe("");
      expect(LCR.authHeaders()).toEqual({});
    }
    expect(h.errors).toEqual([]);
  });

  it("attaches the credential as Bearer + ?token= when the engine speaks", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", port: 8080 }),
      }),
      summaryBody: {
        status: "ok",
        symbols: [{ symbol: "518880.SH", current_price: 6.66, price_source: "live" }],
      },
    });
    harness = h;
    h.sandbox.__LOT_TRADER_SESSION_TOKEN__ = "feedfacefeedface";

    h.runTimers(3000);
    await Bun.sleep(30);
    h.runTimers(5000);
    await Bun.sleep(30);

    const summaryCall = h.fetchInits.find((call) => call.url.includes("/api/summary"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall!.init.headers.Authorization).toBe("Bearer feedfacefeedface");
    expect(summaryCall!.url).toContain("token=feedfacefeedface");

    // The public heartbeat must NOT carry the credential (no preflight every 3s).
    const healthCall = h.fetchInits.find((call) => call.url.includes("/api/health"));
    expect(healthCall).toBeDefined();
    expect(healthCall!.init.headers).toBeUndefined();

    expect(h.element("mode-indicator").classList.contains("local")).toBe(true);
    expect(h.element("mode-text").textContent).toBe("模式：本地引擎已联动");
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
  });

  it("NEGATIVE: a 401 keeps the page self-driving with zero uncaught exceptions", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", port: 8080 }),
      }),
      summaryUnauthorized: true,
      quoteBody: LIVE_QUOTE_BODY,
    });
    harness = h;

    // Boot tick -> heartbeat upgrades to LOCAL -> /api/summary answers 401 -> demoted again.
    h.runTimers(3000);
    await Bun.sleep(30);
    h.runTimers(5000);
    await Bun.sleep(30);

    const indicator = h.element("mode-indicator");
    expect(indicator.classList.contains("standalone")).toBe(true);
    expect(indicator.classList.contains("local")).toBe(false);
    expect(h.element("mode-text").textContent).toBe("模式：轻量独立（纯前端自驱）");
    expect(indicator.title).toContain("凭证校验未通过");

    // The UI says what happened, in plain language, without blanking the status line.
    const status = h.element("live-status").textContent;
    expect(status).toContain("未授权/Token不匹配");
    expect(status).toContain("轻量自驱");

    // Quotes keep flowing from the public feed, and nothing paints NaN / "undefined".
    const text = h.allText();
    expect(text.includes("NaN")).toBe(false);
    expect(text.includes("undefined")).toBe(false);
    expect(h.fetchInits.some((call) => call.url.includes("qt.gtimg.cn"))).toBe(true);
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);

    // No credential configured => the request went out bare, and was refused.
    const summaryCall = h.fetchInits.find((call) => call.url.includes("/api/summary"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall!.init.headers).toBeUndefined();
    expect(summaryCall!.url).not.toContain("token=");
  });

  it("retries a rejected credential on a slow beat instead of latching the downgrade", async () => {
    const h = createHarness({
      healthProbe: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", version: "0.1.0", port: 8080 }),
      }),
      summaryUnauthorized: true,
      quoteBody: LIVE_QUOTE_BODY,
    });
    harness = h;

    h.runTimers(3000);
    await Bun.sleep(30);
    h.runTimers(5000);
    await Bun.sleep(30);
    expect(h.element("mode-indicator").classList.contains("standalone")).toBe(true);
    expect(h.element("live-status").textContent).toContain("未授权/Token不匹配");

    // A fresh page with the right credential is the normal path; here we simulate the
    // credential arriving after the fact and let the slow retry beat pick it up.
    h.sandbox.__LOT_TRADER_SESSION_TOKEN__ = "cafebabecafebabe";

    for (let beat = 0; beat < 21; beat += 1) {
      h.runTimers(3000);
      await Bun.sleep(5);
    }
    await Bun.sleep(40);

    // Still unauthorized (the stub answers 401 for every summary call) but the retry must
    // have carried the new credential instead of latching the old, tokenless verdict.
    const credentialed = h.fetchInits.filter(
      (call) =>
        call.url.includes("/api/summary") &&
        call.init &&
        call.init.headers &&
        call.init.headers.Authorization,
    );
    expect(credentialed.length).toBeGreaterThan(0);
    expect(credentialed[credentialed.length - 1].init.headers.Authorization).toBe(
      "Bearer cafebabecafebabe",
    );
    expect(h.errors).toEqual([]);
    expect(h.rejections).toEqual([]);
    expect(h.allText().includes("NaN")).toBe(false);
  });
});
