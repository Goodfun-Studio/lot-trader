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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  LOOPBACK_HOSTS,
  TOOL_VERSION,
  PriceBook,
  buildLotsPayload,
  buildSummaryPayload,
  formatPortConflictError,
  normalizeAccountKey,
  resolveFullPositionCap,
  resolveServeDbPath,
  resolveServeHost,
  resolveServePort,
  startServe,
} from "../src/serve.ts";
import { AppDatabase } from "../src/db.ts";
import { QuoteProvider } from "../src/quotes.ts";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const templatePath = join(repoRoot, "scripts", "template_base.html");

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
}): Harness {
  const template = readFileSync(templatePath, "utf-8");
  const runtimeScript = extractRuntimeScript(template);
  const dashboardScript = extractDashboardScript(template)
    .replace("{{ACCOUNT_METRICS_JSON}}", JSON.stringify(fixtureMetrics()))
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
    if (url.includes("/api/health")) return options.healthProbe();
    if (url.includes("/api/summary")) {
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
       performRefresh: typeof performRefresh === 'function' ? performRefresh : null
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

    const resp = await fetch(`${srv.url}/api/health`);
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
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    expect(srv.port).toBeGreaterThan(0);
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}`);
    const body = (await (await fetch(`${srv.url}/api/health`)).json()) as Record<string, any>;
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

    const body = (await (await fetch(`${srv.url}/api/summary`)).json()) as Record<string, any>;
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
    expect(body.portfolio.remaining_budget).toBeCloseTo(
      body.portfolio.full_position_cap - body.portfolio.total_market_value,
      2,
    );

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

    const all = (await (await fetch(`${srv.url}/api/lots`)).json()) as Record<string, any>;
    expect(all.status).toBe("ok");
    expect(all.total).toBe(4);
    expect(everyNumberFinite(all)).toBe(true);

    const gold = (await (await fetch(`${srv.url}/api/lots?symbol=518880`)).json()) as Record<string, any>;
    expect(gold.total).toBe(2);
    expect(gold.filters.symbol).toBe("518880.SH");
    expect(gold.lots.every((l: any) => l.symbol === "518880.SH")).toBe(true);
    expect(gold.lots[0].price_source).toBe("live");

    const acc2 = (await (await fetch(`${srv.url}/api/lots?account=ACC2`)).json()) as Record<string, any>;
    expect(acc2.total).toBe(2);
    expect(acc2.lots.every((l: any) => l.account_id === "ACC2")).toBe(true);

    const closed = (await (await fetch(`${srv.url}/api/lots?status=CLOSED`)).json()) as Record<string, any>;
    expect(closed.total).toBe(1);
    expect(closed.lots[0].lot_id).toBe("LOT-CLOSED");
    expect(closed.lots[0].status).toBe("CLOSED");

    const active = (await (await fetch(`${srv.url}/api/lots?status=ACTIVE`)).json()) as Record<string, any>;
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

    const summary = (await (await fetch(`${srv.url}/api/summary`)).json()) as Record<string, any>;
    assertNoNaN(summary, "offline summary");
    expect(everyNumberFinite(summary)).toBe(true);
    for (const sym of summary.symbols) {
      expect(sym.price_source).toBe("cost_basis");
      expect(sym.current_price).toBeGreaterThan(0);
      expect(sym.market_value).toBeGreaterThan(0);
    }

    const lots = (await (await fetch(`${srv.url}/api/lots`)).json()) as Record<string, any>;
    assertNoNaN(lots, "offline lots");
    expect(everyNumberFinite(lots)).toBe(true);
  });

  it("answers 404/405/preflight without leaking a stack trace", async () => {
    const dbPath = trackDir(tempDbPath("http"));
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const missing = await fetch(`${srv.url}/api/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, any>;
    expect(missingBody.status).toBe("error");
    expect(JSON.stringify(missingBody)).not.toContain("    at ");

    const badMethod = await fetch(`${srv.url}/api/health`, { method: "POST" });
    expect(badMethod.status).toBe(405);

    const badStatus = await fetch(`${srv.url}/api/lots?status=EXPLODED`);
    expect(badStatus.status).toBe(400);
    const badStatusBody = (await badStatus.json()) as Record<string, any>;
    expect(badStatusBody.message).toContain("非法批次状态");

    const preflight = await fetch(`${srv.url}/api/health`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves an empty ledger without throwing", async () => {
    const dbPath = trackDir(tempDbPath("empty"));
    const srv = await startServe({ port: 0, dbPath, quoteProvider: new QuoteProvider({}) });
    openServers.push(srv);

    const summary = (await (await fetch(`${srv.url}/api/summary`)).json()) as Record<string, any>;
    expect(summary.status).toBe("ok");
    expect(summary.portfolio.total_active_lots).toBe(0);
    expect(summary.portfolio.total_cost).toBe(0);
    expect(summary.portfolio.overall_return_rate).toBe(0);
    expect(summary.symbols).toEqual([]);
    assertNoNaN(summary, "empty summary");

    const lots = (await (await fetch(`${srv.url}/api/lots`)).json()) as Record<string, any>;
    expect(lots.total).toBe(0);
    expect(lots.lots).toEqual([]);
  });
});

// ===========================================================================
// 2. Port conflict, host guard, graceful shutdown
// ===========================================================================

describe("trade serve: port conflict and lifecycle guards", () => {
  it("throws a readable error (not a raw stack) when the port is already taken", async () => {
    const dbPath = trackDir(tempDbPath("conflict"));
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

  it("shuts down gracefully on SIGTERM via the CLI and frees the port", async () => {
    const dbPath = trackDir(tempDbPath("sigterm"));
    seedLedger(dbPath);

    const proc = Bun.spawn([process.execPath, "run", cliPath, "serve", "--port", "0", "--db", dbPath, "--json"], {
      cwd: repoRoot,
      env: { ...process.env, LOT_TRADER_DB: dbPath },
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

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

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
      env: { ...process.env, LOT_TRADER_DB: dbPath, TRADE_DB_PATH: dbPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
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
});
