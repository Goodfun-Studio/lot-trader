#!/usr/bin/env bun
/**
 * Command line interface for Lot Trader (Executable: trade).
 */
import { AppDatabase } from "./db.ts";
import { TraderEngine } from "./engine.ts";
import { computePhysicsRadar, PhysicsRadarResult } from "./physics.ts";
import { normalizeSymbol } from "./quotes.ts";
import { parseArgs } from "util";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";

const DASHBOARD_DEFAULT_OUT = "lot-trader-global-dashboard.html";

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
  console.log(`usage: trade [-h] {lot,position,scan,stats,physics,dashboard,dividend} ...

Lot Trader Core CLI Engine (Unix Way & Hexagonal Architecture)

positional arguments:
  {lot,position,scan,stats,physics,dashboard}  Available subcommands
    lot             Lot operations (buy, add, list, close)
    position        Position / Holding aggregated view
    scan            Scan active lots for signals (including trailing stop)
    stats           Performance statistics with multi-dimensional attribution
    physics         Physics momentum radar analysis (velocity, acceleration, force, damping)
    dashboard       Render the global interactive HTML dashboard
    dividend        Cash dividend management (add, list)

options:
  -h, --help        show this help message and exit
`);
}

function printDashboardHelp(): void {
  console.log(`usage: trade dashboard [-h] [--out <path>] [--open] [--template <path>] [--db <path>]

Global Interactive HTML Dashboard Generator

options:
  --out, -o PATH    Output HTML file path (default: ./${DASHBOARD_DEFAULT_OUT})
  --open            Open the generated dashboard with the system default browser
  --template, -t    Front-end template HTML path (default: template_base.html next to the script)
  --db PATH         SQLite database path (default: $LOT_TRADER_DB / $TRADE_DB_PATH / ~/.trade/trade.db)
  --json            Emit structured JSON result instead of human readable text
  -h, --help        show this help message and exit
`);
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

async function handleDashboard(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", short: "o" },
      open: { type: "boolean", default: false },
      template: { type: "string", short: "t" },
      db: { type: "string" },
      "scripts-dir": { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const outPath = resolve((values.out as string | undefined) || DASHBOARD_DEFAULT_OUT);
  const dbPath = resolveDashboardDb(values.db as string | undefined);

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

    const proc = Bun.spawn(
      [pythonCommand(), scriptPath, "--out", outPath, "--template", template, "--db", dbPath],
      { cwd: process.cwd(), env: childEnv, stdout: isJson ? "pipe" : "inherit", stderr: isJson ? "pipe" : "inherit" },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Dashboard generator failed (exit ${exitCode}):\n${(stderr || stdout).trim()}`);
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
          data: { out: outPath, script: scriptPath, template, db: dbPath, bytes: size, opened: Boolean(values.open) },
        }),
      );
    } else {
      console.log(`🌐 全局看板已生成: ${outPath} (${size.toLocaleString("en-US")} bytes)`);
      console.log(`   脚本: ${scriptPath}`);
      console.log(`   模板: ${template}`);
      console.log(`   数据: ${dbPath}`);
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
  console.log(`usage: trade lot {buy,add,list,close} ...

Lot actions:
  buy               Buy / create a new initial lot [--account <ACC>]
  add               Pyramid dip add to an existing lot (with anti-shake guard) [--account <ACC>]
  list              List lots [--account <ACC>]
  close             Close a lot (full or partial) [--account <ACC>]
`);
}

async function handleLotBuy(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      symbol: { type: "string" },
      price: { type: "string" },
      qty: { type: "string" },
      account: { type: "string" },
      fee: { type: "string" },
      time: { type: "string" },
      parent: { type: "string" },
      "skip-risk": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);

  try {
    if (!values.symbol || !values.price || !values.qty) {
      throw new Error("Missing required arguments: --symbol, --price, --qty");
    }

    const symbol = values.symbol as string;
    const price = parseFloat(values.price as string);
    const qty = parseInt(values.qty as string, 10);
    const account = values.account ? (values.account as string).trim() : undefined;
    const fee = values.fee ? parseFloat(values.fee as string) : undefined;
    const time = values.time ? new Date(values.time as string) : undefined;
    const parent = values.parent as string | undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.buyLot(symbol, price, qty, fee, time, parent, skipRisk, account);

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
  const { values } = parseArgs({
    args,
    options: {
      "parent-lot-id": { type: "string" },
      parent: { type: "string" },
      price: { type: "string" },
      amount: { type: "string" },
      qty: { type: "string" },
      account: { type: "string" },
      fee: { type: "string" },
      time: { type: "string" },
      "skip-risk": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const parentId = (values["parent-lot-id"] as string) || (values.parent as string);

  try {
    if (!parentId || !values.price) {
      throw new Error("Missing required arguments: --parent-lot-id (or --parent), --price");
    }

    const price = parseFloat(values.price as string);
    const amount = values.amount ? parseFloat(values.amount as string) : undefined;
    const qty = values.qty ? parseInt(values.qty as string, 10) : undefined;
    const account = values.account ? (values.account as string).trim() : undefined;
    const fee = values.fee ? parseFloat(values.fee as string) : undefined;
    const time = values.time ? new Date(values.time as string) : undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.addLot(parentId, price, {
      amount,
      qty,
      fee,
      buyTime: time,
      skipRiskCheck: skipRisk,
      accountId: account,
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
        },
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`✅ 成功完成梯级加仓！批次ID: ${lot.lot_id}`);
      console.log(`所属账户: ${lot.account_id} | 父批次: ${lot.parent_lot_id} | 递增后加仓层级: L${lot.pyramid_level}`);
      console.log(`标的代码: ${lot.symbol} | 加仓数量: ${lot.buy_quantity} 股 | 成交单价: ${lot.buy_price.toFixed(4)} 元`);
      console.log(`加仓全成本单价: ${lot.cost_basis_unit.toFixed(4)} 元 | 规费: ${lot.buy_fee.toFixed(2)} 元`);
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
    options: {
      status: { type: "string", default: "ACTIVE" },
      symbol: { type: "string" },
      account: { type: "string" },
      json: { type: "boolean", default: false },
    },
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

      const header = `${"Lot ID".padEnd(19)} | ${"Account".padEnd(10)} | ${"Symbol".padEnd(10)} | ${"Name".padEnd(8)} | ${"Qty".padStart(6)} | ${"BuyCost".padStart(8)} | ${"Current".padStart(8)} | ${"Return".padStart(9)} | ${"PnL".padStart(10)} | ${"Action Advice".padEnd(14)}`;
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

        console.log(`${idCol} | ${accCol} | ${symCol} | ${nameCol} | ${qtyCol} | ${costCol} | ${currCol} | ${retCol} | ${pnlCol} | ${advCol}`);
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
  const { values } = parseArgs({
    args,
    options: {
      "lot-id": { type: "string" },
      price: { type: "string" },
      qty: { type: "string" },
      account: { type: "string" },
      "substitute-core": { type: "boolean", default: false },
      fee: { type: "string" },
      time: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);

  try {
    if (!values["lot-id"] || !values.price) {
      throw new Error("Missing required arguments: --lot-id, --price");
    }

    const lotId = values["lot-id"] as string;
    const price = parseFloat(values.price as string);
    const qty = values.qty ? parseInt(values.qty as string, 10) : undefined;
    const substituteCore = Boolean(values["substitute-core"]);
    const fee = values.fee ? parseFloat(values.fee as string) : undefined;
    const time = values.time ? new Date(values.time as string) : undefined;
    const account = values.account ? (values.account as string).trim() : undefined;

    if (account) {
      const targetLot = engine.getLot(lotId);
      if (targetLot && targetLot.account_id !== account) {
        throw new Error(`批次账户不匹配：批次 ${lotId} 属于账户 ${targetLot.account_id}，而非指定的 ${account}`);
      }
    }

    const [updatedLot, trade] = engine.closeLot(lotId, price, qty, substituteCore, fee, time);

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

async function handleScan(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      thresholds: { type: "string" },
      account: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const account = values.account ? (values.account as string).trim() : undefined;

  try {
    let thresholds: Record<string, number> | undefined;
    if (values.thresholds) {
      thresholds = JSON.parse(values.thresholds as string);
    }

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
    options: {
      days: { type: "string" },
      symbol: { type: "string" },
      account: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const days = values.days ? parseInt(values.days as string, 10) : undefined;
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
    options: {
      symbol: { type: "string" },
      json: { type: "boolean", default: false },
    },
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
    options: {
      symbol: { type: "string" },
      cap: { type: "string" },
      "full-position-cap": { type: "string" },
      account: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const symbol = values.symbol as string | undefined;
  const capStr = (values.cap as string) || (values["full-position-cap"] as string);
  const customCap = capStr ? parseFloat(capStr) : undefined;
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
      options: {
        symbol: { type: "string" },
        amount: { type: "string" },
        date: { type: "string" },
        account: { type: "string" },
        shares: { type: "string" },
        "per-share": { type: "string" },
        notes: { type: "string" },
        json: { type: "boolean", default: false },
      },
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

    try {
      const div = engine.addDividend({
        symbol: values.symbol as string,
        amount: parseFloat(values.amount as string),
        exDate: values.date as string | undefined,
        accountId: values.account as string | undefined,
        sharesCount: values.shares ? parseInt(values.shares as string, 10) : undefined,
        dividendPerShare: values["per-share"] ? parseFloat(values["per-share"] as string) : undefined,
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
      options: {
        symbol: { type: "string" },
        account: { type: "string" },
        json: { type: "boolean", default: false },
      },
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

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === "-h" || rawArgs[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const db = new AppDatabase();
  const engine = new TraderEngine(db.getConnection());

  const command = rawArgs[0];
  const restArgs = rawArgs.slice(1);

  // The dashboard primitive renders from the ledger directly; it needs no engine instance.
  if (command === "dashboard") {
    if (restArgs[0] === "-h" || restArgs[0] === "--help") {
      printDashboardHelp();
      process.exit(0);
    }
    await handleDashboard(restArgs);
    db.close();
    return;
  }

  if (command === "lot") {
    if (restArgs.length === 0 || restArgs[0] === "-h" || restArgs[0] === "--help") {
      printLotHelp();
      process.exit(0);
    }
    const subCmd = restArgs[0];
    const subArgs = restArgs.slice(1);
    if (subCmd === "buy") {
      await handleLotBuy(engine, subArgs);
    } else if (subCmd === "add") {
      await handleLotAdd(engine, subArgs);
    } else if (subCmd === "list") {
      await handleLotList(engine, subArgs);
    } else if (subCmd === "close") {
      await handleLotClose(engine, subArgs);
    } else {
      printLotHelp();
      process.exit(1);
    }
  } else if (command === "position") {
    await handlePosition(engine, restArgs);
  } else if (command === "scan") {
    await handleScan(engine, restArgs);
  } else if (command === "stats") {
    await handleStats(engine, restArgs);
  } else if (command === "physics" || command === "radar") {
    await handlePhysics(engine, restArgs);
  } else if (command === "dividend") {
    await handleDividend(engine, restArgs);
  } else {
    printHelp();
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
