import { describe, expect, it } from "bun:test";
import { linearRegression, computePhysicsRadar } from "../src/physics.ts";
import { QuoteProvider, DailyBar } from "../src/quotes.ts";
import { spawnSync } from "child_process";
import { join } from "path";

describe("Physics Momentum Radar Core Tests", () => {
  it("a. validates linear regression slope, intercept, and normalized slope pct", () => {
    // Perfectly linear series: y = 2x + 10, x = 0..4 -> [10, 12, 14, 16, 18]
    // Mean = 14, slope = 2, normalized slope pct = (2 / 14) * 100 = 14.2857%
    const res = linearRegression([10, 12, 14, 16, 18]);
    expect(res.slope).toBeCloseTo(2, 4);
    expect(res.intercept).toBeCloseTo(10, 4);
    expect(res.mean_y).toBeCloseTo(14, 4);
    expect(res.normalized_slope_pct).toBeCloseTo(14.2857, 3);

    // Negative slope: y = -1x + 20 -> [20, 19, 18, 17, 16]
    // Mean = 18, slope = -1, normalized slope = (-1 / 18) * 100 = -5.5556%
    const resNeg = linearRegression([20, 19, 18, 17, 16]);
    expect(resNeg.slope).toBeCloseTo(-1, 4);
    expect(resNeg.normalized_slope_pct).toBeCloseTo(-5.5556, 3);
  });

  it("b. computes force F = m * a and fluid damping mu accurately", () => {
    // Construct 6 days of predictable bars
    // Bars 0..4 (prev 5): close = 10, 10, 10, 10, 10 -> v_prev = 0
    // Bars 1..5 (curr 5): close = 10, 10, 10, 10, 12 -> linear slope > 0 -> a > 0
    const bars: DailyBar[] = [
      { date: "2026-10-01", open: 10, close: 10, high: 10.5, low: 9.5, volume: 1000 },
      { date: "2026-10-02", open: 10, close: 10, high: 10.5, low: 9.5, volume: 1000 },
      { date: "2026-10-03", open: 10, close: 10, high: 10.5, low: 9.5, volume: 1000 },
      { date: "2026-10-04", open: 10, close: 10, high: 10.5, low: 9.5, volume: 1000 },
      { date: "2026-10-05", open: 10, close: 10, high: 10.5, low: 9.5, volume: 1000 },
      { date: "2026-10-06", open: 10, close: 12, high: 12.0, low: 10.0, volume: 2000 },
    ];
    // MA(vol, 20) over 6 bars = (1000*5 + 2000) / 6 = 1166.67
    // m = 2000 / 1166.67 = 1.71
    // High-Low = 2.0, Close = 12, amplitude = 2.0 / 12 = 0.166667
    // mu = 2000 / (2.0 / 12) = 12000
    const radar = computePhysicsRadar("600519.SH", "贵州茅台", bars);
    expect(radar.m).toBeGreaterThan(1.0);
    expect(radar.a).toBeGreaterThan(0);
    expect(radar.F).toBeCloseTo(radar.m * radar.a, 2);
    expect(radar.mu).toBeCloseTo(12000, 0);
    expect(radar.brake_status).toBe("ACCELERATING_UP");
  });

  it("c. CORE NEGATIVE GUARD: zero volume, extreme flat zero amplitude, and < 5 bars never throw or produce NaN/Infinity", () => {
    // Zero volume & zero amplitude
    const zeroBars: DailyBar[] = [
      { date: "2026-10-01", open: 10, close: 10, high: 10, low: 10, volume: 0 },
      { date: "2026-10-02", open: 10, close: 10, high: 10, low: 10, volume: 0 },
      { date: "2026-10-03", open: 10, close: 10, high: 10, low: 10, volume: 0 },
      { date: "2026-10-04", open: 10, close: 10, high: 10, low: 10, volume: 0 },
      { date: "2026-10-05", open: 10, close: 10, high: 10, low: 10, volume: 0 },
      { date: "2026-10-06", open: 10, close: 10, high: 10, low: 10, volume: 0 },
    ];
    const rZero = computePhysicsRadar("000001.SZ", "平安银行", zeroBars);
    expect(rZero.v_short).toBe(0);
    expect(rZero.v_mid).toBe(0);
    expect(rZero.a).toBe(0);
    expect(rZero.m).toBe(0);
    expect(rZero.F).toBe(0);
    expect(rZero.mu).toBe(0);
    expect(rZero.brake_status).toBe("STEADY");
    expect(rZero.force_status).toBe("NEUTRAL");
    expect(isNaN(rZero.v_short)).toBeFalse();
    expect(isFinite(rZero.mu)).toBeTrue();

    // Less than 5 bars
    const sparseBars: DailyBar[] = [
      { date: "2026-10-01", open: 10, close: 10, high: 10, low: 10, volume: 50 },
    ];
    const rSparse = computePhysicsRadar("000001.SZ", "平安银行", sparseBars);
    expect(rSparse.data_bars_count).toBe(1);
    expect(rSparse.v_short).toBe(0);
    expect(rSparse.a).toBe(0);
    expect(rSparse.F).toBe(0);
    expect(isNaN(rSparse.F)).toBeFalse();

    // Empty bars
    const rEmpty = computePhysicsRadar("000001.SZ", "平安银行", []);
    expect(rEmpty.data_bars_count).toBe(0);
    expect(rEmpty.current_price).toBe(0);
    expect(rEmpty.v_short).toBe(0);
  });

  it("d. validates CLI trade physics and --json output structure end-to-end", () => {
    const cliPath = join(__dirname, "../src/cli.ts");
    // Run trade physics 518880.SH
    const resText = spawnSync("bun", ["run", cliPath, "physics", "518880.SH"], {
      encoding: "utf8",
    });
    expect(resText.status).toBe(0);
    expect(resText.stdout).toContain("🎯 标的物理运动量化雷达");
    expect(resText.stdout).toContain("动量速度 (Velocity v)");
    expect(resText.stdout).toContain("动量加速度 (Acceleration a)");
    expect(resText.stdout).toContain("多空合力 F");

    // Run trade radar 518880.SH --json
    const resJson = spawnSync("bun", ["run", cliPath, "radar", "518880.SH", "--json"], {
      encoding: "utf8",
    });
    expect(resJson.status).toBe(0);
    const parsed = JSON.parse(resJson.stdout);
    expect(parsed.code).toBe(0);
    expect(parsed.msg).toBe("success");
    expect(parsed.data).toBeDefined();
    expect(parsed.data.symbol).toBe("518880.SH");
    expect(typeof parsed.data.v_short).toBe("number");
    expect(typeof parsed.data.a).toBe("number");
    expect(typeof parsed.data.m).toBe("number");
    expect(typeof parsed.data.F).toBe("number");
    expect(typeof parsed.data.mu).toBe("number");
    expect(typeof parsed.data.pct_rank_60).toBe("number");
    expect(typeof parsed.data.pullback_60).toBe("number");
    expect(parsed.data.data_bars_count).toBeGreaterThanOrEqual(5);
  });
});
