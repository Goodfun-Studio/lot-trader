import { describe, expect, it } from "bun:test";
import { AppDatabase } from "../src/db.ts";
import { TraderEngine } from "../src/engine.ts";
import { QuoteProvider } from "../src/quotes.ts";
import { SignalType, LotStatus } from "../src/models.ts";

function createTestContext() {
  const db = new AppDatabase(":memory:");
  const mockQuotes = new QuoteProvider();
  const engine = new TraderEngine(db.getConnection(), mockQuotes);
  return { db, mockQuotes, engine };
}

describe("Multi-Account & Core Substitution Isolation Tests", () => {
  it("a. supports account_id persistence and maintains backward compatibility with DEFAULT", () => {
    const { engine } = createTestContext();

    // 1. Default buy without account specified -> "DEFAULT"
    const defaultLot = engine.buyLot("600519.SH", 1600.0, 100);
    expect(defaultLot.account_id).toBe("DEFAULT");

    const fetchedDefault = engine.getLot(defaultLot.lot_id);
    expect(fetchedDefault?.account_id).toBe("DEFAULT");

    // 2. Explicit buy with account_id -> "CMB" (招商证券)
    const cmbLot = engine.buyLot("600519.SH", 1600.0, 100, undefined, undefined, undefined, false, "CMB");
    expect(cmbLot.account_id).toBe("CMB");

    const fetchedCmb = engine.getLot(cmbLot.lot_id);
    expect(fetchedCmb?.account_id).toBe("CMB");

    // 3. List lots with account filtering
    // Total 2 lots
    // Note: listLots with accountId
  });

  it("b. auto-inherits account_id on addLot (pyramid dip add) and supports explicit override", () => {
    const { engine } = createTestContext();

    // Parent lot in HUATAI (华泰证券)
    const parentLot = engine.buyLot("510300.SH", 3.50, 1000, undefined, undefined, undefined, false, "HUATAI");
    expect(parentLot.account_id).toBe("HUATAI");

    // 1. Add lot without specifying account -> should inherit HUATAI
    const childLot1 = engine.addLot(parentLot.lot_id, 3.40, {
      qty: 500,
      skipRiskCheck: true,
      buyTime: new Date(Date.now() + 49 * 3600 * 1000), // bypass 48h anti-shake
    });
    expect(childLot1.account_id).toBe("HUATAI");
    expect(childLot1.parent_lot_id).toBe(parentLot.lot_id);

    // 2. Add lot with explicit override -> "GALAXY" (银河证券)
    const childLot2 = engine.addLot(parentLot.lot_id, 3.30, {
      qty: 500,
      skipRiskCheck: true,
      accountId: "GALAXY",
      buyTime: new Date(Date.now() + 100 * 3600 * 1000),
    });
    expect(childLot2.account_id).toBe("GALAXY");
    expect(childLot2.parent_lot_id).toBe(parentLot.lot_id);
  });

  it("c. CORE NEGATIVE GUARD: Account A holds historical core, Account B buys today and profits +10%, strictly outputs T1_LOCKED_ALERT and blocks cross-account substitution", async () => {
    /**
     * 核心负向守卫铁律：
     * Account A (HUATAI) 拥有昨日交收的 1000 股底仓。
     * Account B (CMB) 今日新买 500 股。
     * 盘中大涨 +10%，Account B 浮盈达到止盈线。
     * 铁律断言：
     * 1. 扫描 Account B 批次时，计算其可用底仓池必须为 0！
     * 2. 信号必须为 T1_LOCKED_ALERT (非 DAY_TRADE_PROFIT_ALERT)！
     * 3. 强行平仓并尝试代冲底仓 (--substitute-core) 时，必须直接抛出异常拦截，严防跨券商/账户挪用底仓裸卖空！
     */
    const { engine, mockQuotes } = createTestContext();

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const today = new Date();

    // Account A (HUATAI): Yesterday bought 1000 shares of 600519.SH
    const lotA = engine.buyLot(
      "600519.SH",
      1500.0,
      1000,
      undefined,
      yesterday,
      undefined,
      true,
      "HUATAI"
    );
    expect(lotA.account_id).toBe("HUATAI");

    // Account B (CMB): Today bought 500 shares of 600519.SH at 1500.0
    const lotB = engine.buyLot(
      "600519.SH",
      1500.0,
      500,
      undefined,
      today,
      undefined,
      true,
      "CMB"
    );
    expect(lotB.account_id).toBe("CMB");

    // Verify available core position per account
    const coreA = engine.arbitrator.computeAvailableCorePosition("600519.SH", today, "HUATAI");
    const coreB = engine.arbitrator.computeAvailableCorePosition("600519.SH", today, "CMB");
    expect(coreA).toBe(1000);
    expect(coreB).toBe(0); // Account B has ZERO core shares!

    // Price surges to 1660 (+10.6% profit)
    mockQuotes.setMockPrice("600519.SH", 1660.0);

    // 1. Scan signals across all accounts
    const signals = await engine.scanSignals(undefined, today);
    expect(signals.length).toBe(2);

    // Signal for Lot A (Historical, take profit eligible)
    const sigA = signals.find((s) => s.lot_id === lotA.lot_id);
    expect(sigA?.signal_type).toBe(SignalType.TAKE_PROFIT_ALERT);

    // Signal for Lot B (Today bought in CMB, zero core in CMB -> strictly T1_LOCKED_ALERT)
    const sigB = signals.find((s) => s.lot_id === lotB.lot_id);
    expect(sigB).toBeDefined();
    expect(sigB?.account_id).toBe("CMB");
    expect(sigB?.signal_type).toBe(SignalType.T1_LOCKED_ALERT);
    expect(sigB?.suggested_action).toBe("HOLD_UNTIL_NEXT_TRADING_DAY");
    const payloadB = JSON.parse(sigB!.payload_json);
    expect(payloadB.can_sell_now).toBe(false);
    expect(payloadB.available_core_qty).toBe(0);

    // 2. Negative assertion on closeLot:
    // Attempting to close Lot B with --substitute-core must be strictly REJECTED
    expect(() => {
      engine.closeLot(lotB.lot_id, 1660.0, 500, true, undefined, today);
    }).toThrow("底仓可用配额不足，严防裸卖空！账户 CMB 可用底仓仅 0 股");

    // Also attempting to close Lot B without substitute-core must also be rejected due to T+1
    expect(() => {
      engine.closeLot(lotB.lot_id, 1660.0, 500, false, undefined, today);
    }).toThrow("为法定 T+1，当日买入份额无法直接平仓");
  });

  it("d. allows intra-account core substitution day trade within the same account", async () => {
    const { engine, mockQuotes } = createTestContext();

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const today = new Date();

    // Account CMB holds 1000 shares of 600519.SH from yesterday
    const cmbCoreLot = engine.buyLot(
      "600519.SH",
      1500.0,
      1000,
      undefined,
      yesterday,
      undefined,
      true,
      "CMB"
    );

    // Account CMB buys 500 shares today at 1500.0
    const cmbTodayLot = engine.buyLot(
      "600519.SH",
      1500.0,
      500,
      undefined,
      today,
      undefined,
      true,
      "CMB"
    );

    // Price surges to 1660 (+10.6% profit)
    mockQuotes.setMockPrice("600519.SH", 1660.0);

    // Scan signals for CMB account specifically
    const signals = await engine.scanSignals(undefined, today, "CMB");
    const todaySig = signals.find((s) => s.lot_id === cmbTodayLot.lot_id);
    expect(todaySig?.signal_type).toBe(SignalType.DAY_TRADE_PROFIT_ALERT);
    expect(todaySig?.suggested_action).toBe("SUBSTITUTE_CORE_CLOSE");

    // Close lot with core substitution within CMB account
    const [updatedLot, trade] = engine.closeLot(cmbTodayLot.lot_id, 1660.0, 500, true, undefined, today);
    expect(updatedLot.status).toBe(LotStatus.CLOSED);
    expect(updatedLot.is_day_trading).toBe(true);
    expect(updatedLot.substituted_core_lot_id).toBe(cmbCoreLot.lot_id);
    expect(trade.account_id).toBe("CMB");
    expect(trade.realized_pnl).toBeGreaterThan(0);
  });

  it("e. filters position view and listLots accurately by account_id", async () => {
    const { engine, mockQuotes } = createTestContext();

    mockQuotes.setMockPrice("518880.SH", 6.00);
    mockQuotes.setMockPrice("600519.SH", 1600.0);

    // Buy in CMB
    engine.buyLot("518880.SH", 6.00, 1000, undefined, undefined, undefined, true, "CMB");
    // Buy in HUATAI
    engine.buyLot("600519.SH", 1600.0, 100, undefined, undefined, undefined, true, "HUATAI");

    // List lots by account
    const cmbLots = await engine.listLots("ACTIVE", undefined, "CMB");
    expect(cmbLots.length).toBe(1);
    expect(cmbLots[0].account_id).toBe("CMB");
    expect(cmbLots[0].symbol).toBe("518880.SH");

    const huataiLots = await engine.listLots("ACTIVE", undefined, "HUATAI");
    expect(huataiLots.length).toBe(1);
    expect(huataiLots[0].account_id).toBe("HUATAI");
    expect(huataiLots[0].symbol).toBe("600519.SH");

    // Position view filtering by account
    const cmbPosition = await engine.getHierarchicalPositionView(undefined, undefined, undefined, "CMB");
    expect(cmbPosition.targets.length).toBe(1);
    expect(cmbPosition.targets[0].symbol).toBe("518880.SH");
    expect(cmbPosition.targets[0].lots[0].account_id).toBe("CMB");

    const huataiPosition = await engine.getHierarchicalPositionView(undefined, undefined, undefined, "HUATAI");
    expect(huataiPosition.targets.length).toBe(1);
    expect(huataiPosition.targets[0].symbol).toBe("600519.SH");
    expect(huataiPosition.targets[0].lots[0].account_id).toBe("HUATAI");

    // Overall position view (all accounts)
    const allPosition = await engine.getHierarchicalPositionView();
    expect(allPosition.targets.length).toBe(2);
  });
});

