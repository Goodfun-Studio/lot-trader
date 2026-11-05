/**
 * Issue #9 & #10 回归测试
 * - Issue #9: price_source 字段标记行情来源
 * - Issue #10: confidence_level 对数据不足场景返回 NONE
 */
import { describe, test, expect } from "bun:test";
import { computePhysicsRadar } from "../src/physics.ts";
import type { DailyBar } from "../src/quotes.ts";

describe("Issue #10: confidence_level 边界", () => {
  test("数据为 0 根时返回 NONE", () => {
    const result = computePhysicsRadar("999999.SH", "测试", []);
    expect(result.confidence_level).toBe("NONE");
    expect(result.data_bars_count).toBe(0);
  });

  test("数据为 1 根时返回 NONE", () => {
    const bar: DailyBar = {
      date: "2024-01-01",
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1000,
    };
    const result = computePhysicsRadar("518880.SH", "黄金ETF", [bar]);
    expect(result.confidence_level).toBe("NONE");
    expect(result.data_bars_count).toBe(1);
  });

  test("数据为 4 根时返回 NONE", () => {
    const bars: DailyBar[] = Array(4).fill(null).map((_, i) => ({
      date: `2024-01-0${i + 1}`,
      open: 10,
      high: 11,
      low: 9,
      close: 10 + i * 0.1,
      volume: 1000,
    }));
    const result = computePhysicsRadar("518880.SH", "黄金ETF", bars);
    expect(result.confidence_level).toBe("NONE");
    expect(result.data_bars_count).toBe(4);
  });

  test("数据为 5 根时计算正常置信度（不再是 NONE）", () => {
    const bars: DailyBar[] = Array(5).fill(null).map((_, i) => ({
      date: `2024-01-0${i + 1}`,
      open: 10,
      high: 11,
      low: 9,
      close: 10 + i * 0.1,
      volume: 1000,
    }));
    const result = computePhysicsRadar("518880.SH", "黄金ETF", bars);
    expect(result.confidence_level).not.toBe("NONE");
    expect(result.data_bars_count).toBe(5);
    // 5 根数据足以计算，应该返回 LOW/MEDIUM/HIGH
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(result.confidence_level);
  });

  test("数据不足时所有物理量为 0", () => {
    const result = computePhysicsRadar("999999.SH", "测试", []);
    expect(result.v_short).toBe(0);
    expect(result.v_mid).toBe(0);
    expect(result.a).toBe(0);
    expect(result.F).toBe(0);
    expect(result.effective_force).toBe(0);
  });
});

describe("Issue #9: price_source 字段：行情回落 vs 真实行情", () => {
  test("实际验证 position 返回正确的 price_source 值", async () => {
    // 真实行为断言：使用 TraderEngine 创建批次，验证 PositionAggregator 返回的 price_source
    const { AppDatabase } = await import("../src/db.ts");
    const { TraderEngine } = await import("../src/engine.ts");
    const { QuoteProvider } = await import("../src/quotes.ts");
    
    const db = new AppDatabase(":memory:");
    // 使用 fake QuoteProvider（离线化，避免真实网络请求）
    const fakeQuotes = new QuoteProvider();
    fakeQuotes.getQuotes = async () => ({}); // 返回空对象，强制 fallback 到 cost_basis
    fakeQuotes.setMockBars("999999.SH", []); // 设置空 K 线数据，避免网络请求
    const engine = new TraderEngine(db.getConnection(), fakeQuotes);
    
    // 使用引擎初始化数据库并创建账户
    engine.addAccount("TEST", { name: "Test Account" });
    
    // 买入一个不存在的标的（999999.SH），应该 fallback 到 cost_basis
    engine.buyLot(
      "999999.SH",     // symbol
      10.0,             // price
      100,              // quantity
      undefined,        // fee
      new Date("2024-01-01T10:00:00Z"),  // buyTime
      undefined,        // parentLotId
      false,            // skipRiskCheck
      "TEST"            // accountId
    );
    
    // 获取持仓视图
    const view = await engine.getHierarchicalPositionView();
    
    // 验证：不存在的标的（999999.SH）应该 fallback 到 cost_basis
    expect(view.targets.length).toBeGreaterThan(0);
    const target = view.targets[0];
    
    // 对于不存在的标的，应该是 cost_basis
    expect(target.price_source).toBe("cost_basis");
    expect(target.lots[0].price_source).toBe("cost_basis");
    
    db.getConnection().close();
  });

  test("验证 \"live\" 分支：有真实行情时返回 live", async () => {
    const { AppDatabase } = await import("../src/db.ts");
    const { TraderEngine } = await import("../src/engine.ts");
    const { QuoteProvider } = await import("../src/quotes.ts");
    
    const db = new AppDatabase(":memory:");
    // fake QuoteProvider 返回模拟行情
    const fakeQuotes = new QuoteProvider();
    fakeQuotes.getQuotes = async () => ({
      "518880.SH": {
        symbol: "518880.SH",
        name: "黄金ETF",
        current_price: 5.0,
        yesterday_close: 4.8,
        open_price: 4.9,
        high_price: 5.1,
        low_price: 4.85,
        volume: 1000000,
        amount: 5000000,
        time_str: new Date().toISOString(),
      },
    });
    // 设置 mock K 线数据，避免网络请求
    fakeQuotes.setMockBars("518880.SH", []);
    const engine = new TraderEngine(db.getConnection(), fakeQuotes);
    
    engine.addAccount("TEST", { name: "Test Account" });
    
    // 买入一个有行情的标的
    engine.buyLot(
      "518880.SH",
      4.5,
      100,
      undefined,
      new Date("2024-01-01T10:00:00Z"),
      undefined,
      false,
      "TEST"
    );
    
    const view = await engine.getHierarchicalPositionView();
    expect(view.targets.length).toBeGreaterThan(0);
    const target = view.targets[0];
    
    // 有真实行情时，应该是 live
    expect(target.price_source).toBe("live");
    expect(target.lots[0].price_source).toBe("live");
    
    db.getConnection().close();
  });
});
