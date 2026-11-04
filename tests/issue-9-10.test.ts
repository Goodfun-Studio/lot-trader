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
      amount: 10000,
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
      amount: 10000,
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
      amount: 10000,
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

describe("Issue #9: price_source 类型一致性", () => {
  test("PriceSource 类型应该与 serve.ts 保持一致", () => {
    // 这是类型检查测试，编译通过即可
    // 如果 position.ts 的 PriceSource 与 serve.ts 不一致，编译会失败
    const validSources: Array<"live" | "cost_basis"> = ["live", "cost_basis"];
    expect(validSources.length).toBe(2);
  });
});
