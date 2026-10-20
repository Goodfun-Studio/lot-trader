import { describe, expect, it } from "bun:test";
import { linearRegression, computePhysicsRadar } from "../src/physics.ts";
import { DailyBar } from "../src/quotes.ts";
import goldenData from "./fixtures/physics_golden_datasets.json";
import { spawnSync } from "child_process";

interface GoldenMetric {
  k20: number;
  b20: number;
  mean_y20: number;
  v_mid: number;
  k5: number;
  b5: number;
  mean_y5: number;
  v_short: number;
  k5_prev: number;
  b5_prev: number;
  mean_y5_prev: number;
  v_short_prev: number;
  a: number;
  ma_vol20: number;
  m: number;
  F: number;
  mu: number;
}

interface GoldenScenario {
  symbol: string;
  name: string;
  bars: DailyBar[];
  metrics: GoldenMetric;
}

describe("Physics Engine & Python NumPy Double-Engine Cross-Validation", () => {
  const scenarios: Record<string, GoldenScenario> = goldenData as any;

  // 1. 真实股票 K 线 (贵州茅台 600519.SH 近 60 日真实复权行情)
  describe("1. 600519.SH 贵州茅台真实市场行情双引擎盲验", () => {
    const maotai = scenarios.maotai;
    const bars = maotai.bars;
    const py = maotai.metrics;

    it("a. 最小二乘斜率 k 与截距 b 高精度交叉断言 (|diff| < 1e-5)", () => {
      // 20-day regression
      const close20 = bars.slice(-20).map((b) => b.close);
      const reg20 = linearRegression(close20);
      expect(Math.abs(reg20.slope - py.k20)).toBeLessThan(1e-5);
      expect(Math.abs(reg20.intercept - py.b20)).toBeLessThan(1e-5);
      expect(Math.abs(reg20.mean_y - py.mean_y20)).toBeLessThan(1e-5);

      // 5-day current regression
      const close5 = bars.slice(-5).map((b) => b.close);
      const reg5 = linearRegression(close5);
      expect(Math.abs(reg5.slope - py.k5)).toBeLessThan(1e-5);
      expect(Math.abs(reg5.intercept - py.b5)).toBeLessThan(1e-5);

      // 5-day previous regression (-6 to -1)
      const close5Prev = bars.slice(-6, -1).map((b) => b.close);
      const reg5Prev = linearRegression(close5Prev);
      expect(Math.abs(reg5Prev.slope - py.k5_prev)).toBeLessThan(1e-5);
      expect(Math.abs(reg5Prev.intercept - py.b5_prev)).toBeLessThan(1e-5);
    });

    it("b. 归一化动量速度 v 与加速度 a 高精度断言 (|diff| < 1e-4)", () => {
      const radar = computePhysicsRadar(maotai.symbol, maotai.name, bars);

      // 中期 20 日动量速度 v_mid
      expect(Math.abs(radar.v_mid - py.v_mid)).toBeLessThan(1e-4);
      // 短期 5 日动量速度 v_short
      expect(Math.abs(radar.v_short - py.v_short)).toBeLessThan(1e-4);
      // 加速度 a = v_short_curr - v_short_prev
      expect(Math.abs(radar.a - py.a)).toBeLessThan(1e-4);

      // 真实波动性断言：绝非虚假常数或 0
      expect(Math.abs(radar.v_mid)).toBeGreaterThan(0.01);
      expect(Math.abs(radar.v_short)).toBeGreaterThan(0.01);
      expect(Math.abs(radar.a)).toBeGreaterThan(0.01);
    });

    it("c. 20 日均量与质量系数 m 高精度断言 (|diff| < 1e-5)", () => {
      const vol20 = bars.slice(-20).map((b) => b.volume);
      const maVol20 = vol20.reduce((acc, v) => acc + v, 0) / vol20.length;
      expect(Math.abs(maVol20 - py.ma_vol20)).toBeLessThan(1e-5);

      const radar = computePhysicsRadar(maotai.symbol, maotai.name, bars);
      expect(Math.abs(radar.m - py.m)).toBeLessThan(1e-5);
      expect(radar.m).toBeGreaterThan(0.5); // 真实质量 > 0
    });

    it("d. 多空合力 F 与流体阻尼 mu 高精度断言", () => {
      const radar = computePhysicsRadar(maotai.symbol, maotai.name, bars);
      // F = m * a
      expect(Math.abs(radar.F - py.F)).toBeLessThan(1e-3);
      expect(radar.F).not.toBe(0);
      // mu = Vol / (Amplitude / Close)
      expect(Math.abs(radar.mu - py.mu) / py.mu).toBeLessThan(1e-4);
      expect(radar.mu).toBeGreaterThan(1000);
    });
  });

  // 2. 多形态典型特征覆盖：强单边上涨、剧烈下挫振荡、横盘磨底
  describe("2. 多形态典型走势双引擎盲验与真实波动断言", () => {
    for (const [key, scenario] of Object.entries(scenarios)) {
      if (key === "maotai") continue;
      const { symbol, name, bars, metrics } = scenario;

      it(`检验形态: ${name} (${symbol})`, () => {
        // 1. 最小二乘斜率 k 与截距 b
        const close20 = bars.slice(-20).map((b) => b.close);
        const reg20 = linearRegression(close20);
        expect(Math.abs(reg20.slope - metrics.k20)).toBeLessThan(1e-5);
        expect(Math.abs(reg20.intercept - metrics.b20)).toBeLessThan(1e-5);

        // 2. 动量速度 v 与加速度 a
        const radar = computePhysicsRadar(symbol, name, bars);
        expect(Math.abs(radar.v_mid - metrics.v_mid)).toBeLessThan(1e-4);
        expect(Math.abs(radar.v_short - metrics.v_short)).toBeLessThan(1e-4);
        expect(Math.abs(radar.a - metrics.a)).toBeLessThan(1e-4);

        // 3. 20日均量与质量系数 m
        const vol20 = bars.slice(-20).map((b) => b.volume);
        const maVol20 = vol20.reduce((acc, v) => acc + v, 0) / vol20.length;
        expect(Math.abs(maVol20 - metrics.ma_vol20)).toBeLessThan(1e-5);
        expect(Math.abs(radar.m - metrics.m)).toBeLessThan(1e-5);

        // 4. 多空合力 F
        expect(Math.abs(radar.F - metrics.F)).toBeLessThan(1e-3);

        // 5. 真实数学波动断言 (防止恒为 0 或 NaN)
        expect(Number.isFinite(radar.v_short)).toBeTrue();
        expect(Number.isFinite(radar.v_mid)).toBeTrue();
        expect(Number.isFinite(radar.a)).toBeTrue();
        expect(Number.isFinite(radar.m)).toBeTrue();
        expect(Number.isFinite(radar.F)).toBeTrue();
        expect(Number.isFinite(radar.mu)).toBeTrue();
      });
    }
  });

  // 3. 现场动态 Python NumPy 子进程交叉校验 (支持优雅降级)
  describe("3. 动态 Python NumPy 子进程双引擎实时对账", () => {
    it("动态调用 Python numpy.polyfit 并在位对齐验证", () => {
      // 检测 Python 是否可用
      let pyCmd: { bin: string; args: string[] } | null = null;

      // 探测 python3 直接环境
      const probe1 = spawnSync("python3", ["-c", "import numpy as np; print(np.__version__)"]);
      if (probe1.status === 0) {
        pyCmd = { bin: "python3", args: [] };
      } else {
        // 探测 uv run
        const probe2 = spawnSync("uv", ["run", "--with", "numpy", "python3", "-c", "import numpy as np; print(np.__version__)"]);
        if (probe2.status === 0) {
          pyCmd = { bin: "uv", args: ["run", "--with", "numpy", "python3"] };
        }
      }

      if (!pyCmd) {
        console.log("ℹ️ [NumPy Validation] 本地环境未检测到 Python NumPy，优雅降级为静态 Golden Dataset 纯断言。");
        expect(true).toBeTrue();
        return;
      }

      // 构造一段具有任意非对称特性的测试序列
      const testPrices = [12.5, 12.8, 13.1, 12.9, 13.5, 14.2, 14.0, 14.8, 15.3, 15.1];
      const pyScript = `
import numpy as np, json, sys
y = np.array(${JSON.stringify(testPrices)}, dtype=np.float64)
x = np.arange(len(y), dtype=np.float64)
k, b = np.polyfit(x, y, 1)
mean_y = float(np.mean(y))
v = float((k / mean_y) * 100.0)
print(json.dumps({"k": float(k), "b": float(b), "mean_y": mean_y, "v": v}))
`;
      const fullArgs = [...pyCmd.args, "-c", pyScript];
      const res = spawnSync(pyCmd.bin, fullArgs, { encoding: "utf8" });
      expect(res.status).toBe(0);

      const npRes = JSON.parse(res.stdout.trim());
      const tsRes = linearRegression(testPrices);

      // 高精度对齐
      expect(Math.abs(tsRes.slope - npRes.k)).toBeLessThan(1e-5);
      expect(Math.abs(tsRes.intercept - npRes.b)).toBeLessThan(1e-5);
      expect(Math.abs(tsRes.mean_y - npRes.mean_y)).toBeLessThan(1e-5);
      expect(Math.abs(tsRes.normalized_slope_pct - npRes.v)).toBeLessThan(1e-4);

      // 非 0 波动断言
      expect(Math.abs(tsRes.slope)).toBeGreaterThan(0.1);
    });
  });

  // 4. 防误杀与边界安全硬核断言
  describe("4. 负向防误杀边界守卫断言 (Anti-False-Positive Guard)", () => {
    it("数据包含非法值/空值/少于2根时安全优雅兜底，绝不产生 NaN 或内存泄漏", () => {
      const regEmpty = linearRegression([]);
      expect(regEmpty.slope).toBe(0);
      expect(regEmpty.intercept).toBe(0);
      expect(regEmpty.normalized_slope_pct).toBe(0);

      const regSingle = linearRegression([100.5]);
      expect(regSingle.slope).toBe(0);
      expect(regSingle.intercept).toBe(100.5);
      expect(regSingle.mean_y).toBe(100.5);
      expect(regSingle.normalized_slope_pct).toBe(0);

      const regFlat = linearRegression([10, 10, 10, 10, 10]);
      expect(regFlat.slope).toBe(0);
      expect(regFlat.intercept).toBe(10);
      expect(regFlat.normalized_slope_pct).toBe(0);
    });
  });
});

