#!/usr/bin/env bun
/**
 * Command line interface for Lot Trader (Executable: trade).
 */
import { AppDatabase } from "./db.ts";
import { TraderEngine } from "./engine.ts";
import { parseArgs } from "util";

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
  console.log(`usage: trade [-h] {lot,scan,stats} ...

Lot Trader Core CLI Engine (Unix Way & Hexagonal Architecture)

positional arguments:
  {lot,scan,stats}  Available subcommands
    lot             Lot operations (buy, add, list, close)
    scan            Scan active lots for signals (including trailing stop)
    stats           Performance statistics with multi-dimensional attribution

options:
  -h, --help        show this help message and exit
`);
}

function printLotHelp(): void {
  console.log(`usage: trade lot {buy,add,list,close} ...

Lot actions:
  buy               Buy / create a new initial lot
  add               Pyramid dip add to an existing lot (with anti-shake guard)
  list              List lots
  close             Close a lot (full or partial)
`);
}

async function handleLotBuy(engine: TraderEngine, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      symbol: { type: "string" },
      price: { type: "string" },
      qty: { type: "string" },
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
    const fee = values.fee ? parseFloat(values.fee as string) : undefined;
    const time = values.time ? new Date(values.time as string) : undefined;
    const parent = values.parent as string | undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.buyLot(symbol, price, qty, fee, time, parent, skipRisk);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: lot.lot_id,
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
      console.log(`标的代码: ${lot.symbol} | 数量: ${lot.buy_quantity} | 成交单价: ${lot.buy_price.toFixed(4)} 元`);
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
    const fee = values.fee ? parseFloat(values.fee as string) : undefined;
    const time = values.time ? new Date(values.time as string) : undefined;
    const skipRisk = Boolean(values["skip-risk"]);

    const lot = engine.addLot(parentId, price, {
      amount,
      qty,
      fee,
      buyTime: time,
      skipRiskCheck: skipRisk,
    });

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: lot.lot_id,
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
      console.log(`父批次: ${lot.parent_lot_id} | 递增后加仓层级: L${lot.pyramid_level}`);
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
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const status = (values.status as string) || "ACTIVE";
  const symbol = values.symbol as string | undefined;

  try {
    const lots = await engine.listLots(status, symbol);

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
        console.log(`暂无符合条件的批次数据 (status=${status}, symbol=${symbol || "None"})`);
        return;
      }

      const header = `${"Lot ID".padEnd(19)} | ${"Symbol".padEnd(10)} | ${"Name".padEnd(8)} | ${"Qty".padStart(6)} | ${"BuyCost".padStart(8)} | ${"Current".padStart(8)} | ${"Return".padStart(9)} | ${"PnL".padStart(10)} | ${"Action Advice".padEnd(14)}`;
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
        const symCol = l.symbol.padEnd(10);
        const nameCol = l.symbol_name.slice(0, 6).padEnd(8);
        const qtyCol = String(l.remaining_quantity).padStart(6);
        const costCol = bCostStr.padStart(8);
        const currCol = currStr.padStart(8);
        const retCol = formatRate(rRate).padStart(9);
        const pnlCol = pnlStr.padStart(10);
        const advCol = advice.padEnd(14);

        console.log(`${idCol} | ${symCol} | ${nameCol} | ${qtyCol} | ${costCol} | ${currCol} | ${retCol} | ${pnlCol} | ${advCol}`);
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
      "substitute-core": { type: "boolean", default: false },
      fee: { type: "string" },
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

    const [updatedLot, trade] = engine.closeLot(lotId, price, qty, substituteCore, fee);

    if (isJson) {
      const out = {
        code: 0,
        msg: "success",
        timestamp: new Date().toISOString(),
        data: {
          lot_id: updatedLot.lot_id,
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
      console.log(`批次ID: ${updatedLot.lot_id} | 当前状态: ${updatedLot.status}`);
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
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);

  try {
    let thresholds: Record<string, number> | undefined;
    if (values.thresholds) {
      thresholds = JSON.parse(values.thresholds as string);
    }

    const signals = await engine.scanSignals(thresholds);

    if (isJson) {
      const sigList = signals.map((s) => ({
        signal_id: s.signal_id,
        signal_type: s.signal_type,
        lot_id: s.lot_id,
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
        console.log(`【${s.signal_type}】标的: ${s.symbol} | 批次: ${s.lot_id}`);
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
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isJson = Boolean(values.json);
  const days = values.days ? parseInt(values.days as string, 10) : undefined;
  const symbol = values.symbol as string | undefined;

  try {
    const stats = engine.computeStats(days, symbol);

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

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === "-h" || rawArgs[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const db = new AppDatabase();
  const engine = new TraderEngine(db.getConnection());

  const command = rawArgs[0];
  const restArgs = rawArgs.slice(1);

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
  } else if (command === "scan") {
    await handleScan(engine, restArgs);
  } else if (command === "stats") {
    await handleStats(engine, restArgs);
  } else {
    printHelp();
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
