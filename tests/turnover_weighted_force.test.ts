import { describe, expect, it } from "bun:test";
import {
  computeConfidenceWeight,
  computePhysicsRadar,
  interpolateAnchors,
  TURNOVER_SCALE_ANCHORS,
  RELATIVE_SURGE_ANCHORS,
  CONFIDENCE_WEIGHT_CLAMP,
  MISSING_TURNOVER_WEIGHT_CAP,
} from "../src/physics.ts";
import { DailyBar, QuoteProvider } from "../src/quotes.ts";
import { spawnSync } from "child_process";
import { join } from "path";

/** 构造 20 根可预测 K 线：前 19 根量能平稳，末根按 volToday 放量 */
function buildBars(volToday: number, volBase: number = 1000): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i < 19; i++) {
    bars.push({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      open: 10,
      close: 10,
      high: 10.5,
      low: 9.5,
      volume: volBase,
    });
  }
  bars.push({
    date: "2026-10-06",
    open: 10,
    close: 12,
    high: 12.0,
    low: 10.0,
    volume: volToday,
  });
  return bars;
}

describe("Turnover Participation & Confidence-Weighted Effective Force (F_eff = F × W_conf)", () => {
  // ---------------------------------------------------------------- 低换手 ----
  describe("a. LOW 置信度：地量参与度大幅折价 (W_conf ∈ [0.10, 0.50] 区间)", () => {
    it("极低换手 0.05% + 正常量能 → 折价至 0.22，等级 LOW", () => {
      const conf = computeConfidenceWeight(0.05, 1.0);
      expect(conf.turnover_available).toBeTrue();
      expect(conf.turnover_rate).toBe(0.05);
      expect(conf.relative_activity).toBe(1.0);
      // W_abs(0.05) = 0.22, W_rel(1.0) = 1.00
      expect(conf.confidence_weight).toBeCloseTo(0.22, 4);
      expect(conf.confidence_level).toBe("LOW");
      expect(conf.confidence_weight).toBeGreaterThanOrEqual(0.1);
      expect(conf.confidence_weight).toBeLessThanOrEqual(0.5);
    });

    it("老板案例 0.27% 换手 (茅台当日) → W_conf ≈ 0.5375，等级 LOW", () => {
      const conf = computeConfidenceWeight(0.27, 1.0);
      // W_abs 线性插值: 0.20→0.45, 0.40→0.70 ⇒ 0.45 + 0.25 * (0.07 / 0.20) = 0.5375
      expect(conf.confidence_weight).toBeCloseTo(0.5375, 4);
      expect(conf.confidence_level).toBe("LOW");
    });

    it("极低换手 0.10% 叠加缩量 0.5x → 双重折价 0.2475，等级 LOW", () => {
      const conf = computeConfidenceWeight(0.1, 0.5);
      expect(conf.confidence_weight).toBeCloseTo(0.33 * 0.75, 4);
      expect(conf.confidence_level).toBe("LOW");
    });

    it("锚点下界饱和：换手率 0.01%（低于首锚点）→ 0.15 × 1.0，绝不为负/不 NaN", () => {
      const conf = computeConfidenceWeight(0.01, 1.0);
      expect(conf.confidence_weight).toBeCloseTo(0.15, 4);
      expect(conf.confidence_level).toBe("LOW");
      expect(Number.isFinite(conf.confidence_weight)).toBeTrue();
    });
  });

  // -------------------------------------------------------------- 中枢基准 ----
  describe("b. MEDIUM 置信度：正常博弈中枢基准 W_conf ≈ 1.0", () => {
    it("换手 1.00% + 量能持平 (γ=1.0) → W_conf 恰好 1.0000，等级 MEDIUM", () => {
      const conf = computeConfidenceWeight(1.0, 1.0);
      expect(conf.confidence_weight).toBe(1.0);
      expect(conf.confidence_level).toBe("MEDIUM");
    });

    it("换手 0.90% → 0.965，等级 MEDIUM（未跌破 LOW 门槛 0.80）", () => {
      const conf = computeConfidenceWeight(0.9, 1.0);
      expect(conf.confidence_weight).toBeCloseTo(0.965, 4);
      expect(conf.confidence_level).toBe("MEDIUM");
    });

    it("换手 1.20% + 温和放量 1.1x → 1.024 × 1.024 = 1.0486，等级 MEDIUM", () => {
      const conf = computeConfidenceWeight(1.2, 1.1);
      expect(conf.confidence_weight).toBeCloseTo(1.0486, 4);
      expect(conf.confidence_level).toBe("MEDIUM");
    });
  });

  // -------------------------------------------------------------- 天量对决 ----
  describe("c. HIGH 置信度：天量重兵对决 → W_conf > 1.2 放大真合力", () => {
    it("老板案例 2.87% 换手 + 2.0x 放量 → 1.1722 × 1.22 = 1.4301，等级 HIGH", () => {
      const conf = computeConfidenceWeight(2.87, 2.0);
      expect(conf.confidence_weight).toBeCloseTo(1.4301, 4);
      expect(conf.confidence_level).toBe("HIGH");
      expect(conf.confidence_weight).toBeGreaterThan(1.2);
    });

    it("天量 5.00% + 5.0x 爆量 → 1.25 × 1.45 = 1.8125，等级 HIGH", () => {
      const conf = computeConfidenceWeight(5.0, 5.0);
      expect(conf.confidence_weight).toBeCloseTo(1.8125, 4);
      expect(conf.confidence_level).toBe("HIGH");
    });

    it("极端外推 (换手 10% + 量能 20x) 锚点饱和，钳制不超上限 2.00", () => {
      const conf = computeConfidenceWeight(10, 20);
      expect(conf.confidence_weight).toBeCloseTo(1.8125, 4);
      expect(conf.confidence_weight).toBeLessThanOrEqual(CONFIDENCE_WEIGHT_CLAMP[1]);
      expect(conf.confidence_level).toBe("HIGH");
    });

    it("HIGH 门槛精确性：W_conf 跨过 1.20 即升 HIGH，其下仍为 MEDIUM", () => {
      const boundary = computeConfidenceWeight(1.0, 1.2);
      expect(boundary.confidence_weight).toBeCloseTo(1.048, 4); // 1.00 × (1.00 + 0.10 * 0.4) = 1.048
      expect(boundary.confidence_level).toBe("MEDIUM");
      const above = computeConfidenceWeight(1.0, 2.0);
      expect(above.confidence_weight).toBeCloseTo(1.22, 4);
      expect(above.confidence_level).toBe("HIGH");
    });
  });

  // -------------------------------------------------------- 有效合力集成 ----
  describe("d. F_eff = F × W_conf 引擎集成（地量假动作 vs 放量真变盘）", () => {
    // 20 根：前 19 根 1000 手，末根 2000 手 → MA20 = 1050，m = 1.9048，F 显著为正
    const bars = buildBars(2000, 1000);

    it("同一根 K 线：低换手时 F_eff 被压至原始合力的 1/3 以下", () => {
      const radar = computePhysicsRadar("600519.SH", "贵州茅台", bars, undefined, 12, 0.08);
      expect(radar.F).toBeGreaterThan(1.0);
      expect(radar.confidence_level).toBe("LOW");
      expect(radar.effective_force).toBeCloseTo(radar.F * radar.confidence_weight, 4);
      expect(Math.abs(radar.effective_force)).toBeLessThan(Math.abs(radar.F) * 0.35);
    });

    it("同一根 K 线：天量换手 2.87% 时 F_eff 放大到原始合力的 1.3 倍以上", () => {
      const radar = computePhysicsRadar("600519.SH", "贵州茅台", bars, undefined, 12, 2.87);
      expect(radar.confidence_level).toBe("HIGH");
      expect(radar.confidence_weight).toBeCloseTo(1.4078, 3); // W_abs(2.87)=1.1722 × W_rel(1.9048)=1.2010
      expect(radar.effective_force).toBeCloseTo(radar.F * radar.confidence_weight, 4);
      expect(Math.abs(radar.effective_force)).toBeGreaterThan(Math.abs(radar.F) * 1.3);
    });

    it("原始合力 F 不受置信度加权污染（F 仍为 m × a，仅派生 F_eff）", () => {
      const low = computePhysicsRadar("600519.SH", "贵州茅台", bars, undefined, 12, 0.08);
      const high = computePhysicsRadar("600519.SH", "贵州茅台", bars, undefined, 12, 2.87);
      expect(low.F).toBe(high.F);
      expect(low.m).toBe(high.m);
      expect(low.effective_force).not.toBeCloseTo(high.effective_force, 2);
    });

    it("向下合力同样按 W_conf 折价 / 放大（做空抛压适用同一套置信度）", () => {
      const downBars: DailyBar[] = bars.map((b) => ({ ...b }));
      downBars[19] = { ...downBars[19], close: 8, low: 8, high: 10, volume: 2000 };
      const r = computePhysicsRadar("600519.SH", "贵州茅台", downBars, undefined, 8, 0.08);
      expect(r.F).toBeLessThan(0);
      expect(r.effective_force).toBeLessThan(0);
      expect(Math.abs(r.effective_force)).toBeLessThan(Math.abs(r.F));
      expect(Number.isFinite(r.effective_force)).toBeTrue();
    });

    it("存量调用方（不传换手率）不炸：F_eff 退化为相对量能锚点加权，绝不 NaN", () => {
      const radar = computePhysicsRadar("600519.SH", "贵州茅台", bars);
      expect(radar.turnover_rate).toBe(0);
      expect(Number.isFinite(radar.confidence_weight)).toBeTrue();
      expect(Number.isFinite(radar.effective_force)).toBeTrue();
      expect(radar.confidence_level).not.toBe("HIGH");
    });
  });

  // ------------------------------------------------------ 负向防误杀守卫 ----
  describe("e. 负向防误杀守卫：0 / 负数 / 缺失 / NaN / Infinity 全部安全降级", () => {
    it("换手率 0 视为不可用：W 不折价不溢价，等级 MEDIUM（不谎报 HIGH）", () => {
      const conf = computeConfidenceWeight(0, 1.0);
      expect(conf.turnover_rate).toBe(0);
      expect(conf.turnover_available).toBeFalse();
      expect(conf.confidence_weight).toBe(1.0);
      expect(conf.confidence_level).toBe("MEDIUM");
    });

    it("负数 / NaN / Infinity / undefined / null 均按缺失处理，绝不产生 NaN 或除零", () => {
      for (const bad of [-1.5, NaN, Infinity, -Infinity, undefined, null]) {
        const conf = computeConfidenceWeight(bad as any, 1.0);
        expect(conf.turnover_rate).toBe(0);
        expect(conf.confidence_weight).toBe(1.0);
        expect(conf.confidence_level).toBe("MEDIUM");
        expect(Number.isFinite(conf.confidence_weight)).toBeTrue();
      }
    });

    it("换手率缺失但量能爆量 50x → 封顶 1.20 且等级最多 MEDIUM（无绝对参与度证据不得宣称 HIGH）", () => {
      const conf = computeConfidenceWeight(undefined, 50);
      expect(conf.confidence_weight).toBeCloseTo(MISSING_TURNOVER_WEIGHT_CAP, 4);
      expect(conf.confidence_level).toBe("MEDIUM");
    });

    it("换手率缺失 + 地量 0.1x → 仍可由相对量能证据判 LOW", () => {
      const conf = computeConfidenceWeight(undefined, 0.1);
      expect(conf.turnover_available).toBeFalse();
      expect(conf.confidence_weight).toBeCloseTo(0.65, 4);
      expect(conf.confidence_level).toBe("LOW");
    });

    it("量能倍数 0 / 负数 / NaN → 视为无相对证据，退回中性 1.0", () => {
      for (const badGamma of [0, -3, NaN, Infinity]) {
        const conf = computeConfidenceWeight(1.0, badGamma as any);
        expect(conf.relative_activity).toBe(1.0);
        expect(conf.confidence_weight).toBe(1.0);
        expect(conf.confidence_level).toBe("MEDIUM");
      }
    });

    it("radar 数据不足 (<5 根) 时 F_eff = 0，换手率仍安全暴露且无 NaN", () => {
      const sparse: DailyBar[] = [
        { date: "2026-10-01", open: 10, close: 10, high: 10, low: 10, volume: 50 },
      ];
      const r = computePhysicsRadar("000001.SZ", "平安银行", sparse, undefined, 10, 0.3);
      expect(r.data_bars_count).toBe(1);
      expect(r.F).toBe(0);
      expect(r.effective_force).toBe(0);
      expect(r.turnover_rate).toBe(0.3);
      expect(r.confidence_level).toBe("LOW");
      expect(Number.isFinite(r.confidence_weight)).toBeTrue();

      const rBad = computePhysicsRadar("000001.SZ", "平安银行", sparse, undefined, 10, -9);
      expect(rBad.turnover_rate).toBe(0);
      expect(Number.isFinite(rBad.effective_force)).toBeTrue();
    });

    it("零成交量 + 零振幅 + 负换手率：全链路安全兜底", () => {
      const zeroBars: DailyBar[] = Array.from({ length: 6 }, (_, i) => ({
        date: `2026-10-0${i + 1}`,
        open: 10,
        close: 10,
        high: 10,
        low: 10,
        volume: 0,
      }));
      const r = computePhysicsRadar("000001.SZ", "平安银行", zeroBars, undefined, 10, -0.5);
      expect(r.m).toBe(0);
      expect(r.F).toBe(0);
      expect(r.effective_force).toBe(0);
      expect(r.turnover_rate).toBe(0);
      expect(r.confidence_weight).toBe(1.0);
      expect(isNaN(r.effective_force)).toBeFalse();
    });
  });

  // ------------------------------------------------ Mock 注入 & CLI 端到端 ----
  describe("f. Mock 换手率注入与 CLI 端到端呈现", () => {
    it("QuoteProvider 支持 Mock 换手率注入，非法值被忽略", async () => {
      const provider = new QuoteProvider({ "600519": { price: 1331.88, turnover_rate: 0.27 } });
      const q = await provider.getQuotes(["600519"]);
      expect(q["600519.SH"].current_price).toBe(1331.88);
      expect(q["600519.SH"].turnover_rate).toBe(0.27);

      provider.setMockTurnover("600519", NaN);
      const q2 = await provider.getQuotes(["600519"]);
      expect(q2["600519.SH"].turnover_rate).toBeUndefined();

      provider.setMockTurnover("600519", 2.87);
      const q3 = await provider.getQuotes(["600519"]);
      expect(q3["600519.SH"].turnover_rate).toBe(2.87);
    });

    it("trade physics 终端卡片含【博弈参与度与合力置信度】专栏", () => {
      const cliPath = join(__dirname, "../src/cli.ts");
      const res = spawnSync("bun", ["run", cliPath, "physics", "518880.SH"], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("博弈参与度与合力置信度");
      expect(res.stdout).toContain("当日换手率 τ");
      expect(res.stdout).toContain("置信度加权系数 W_conf");
      expect(res.stdout).toContain("有效置信合力 F_eff");
      expect(res.stdout).toMatch(/置信等级: \[(LOW|MEDIUM|HIGH)\]/);
    });

    it("trade physics --json 暴露全部 4 个新字段且数值自洽", () => {
      const cliPath = join(__dirname, "../src/cli.ts");
      const res = spawnSync("bun", ["run", cliPath, "physics", "518880.SH", "--json"], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      const d = parsed.data;
      expect(typeof d.turnover_rate).toBe("number");
      expect(typeof d.confidence_weight).toBe("number");
      expect(typeof d.effective_force).toBe("number");
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(d.confidence_level);
      expect(Number.isFinite(d.turnover_rate)).toBeTrue();
      expect(d.confidence_weight).toBeGreaterThanOrEqual(0.1);
      expect(d.confidence_weight).toBeLessThanOrEqual(2.0);
      // 第 38 项换手率在真实行情下应为正数 (0.01% ~ 50%)
      expect(d.turnover_rate).toBeGreaterThan(0);
      expect(d.turnover_rate).toBeLessThan(50);
      // F_eff 与 F、W_conf 自洽 (允许 4 位小数舍入误差)
      expect(Math.abs(d.effective_force - d.F * d.confidence_weight)).toBeLessThan(0.01);
    });

    it("锚点数据结构自洽：严格升序、权重非负、区间覆盖 0.10~2.00 钳制边界", () => {
      for (const anchors of [TURNOVER_SCALE_ANCHORS, RELATIVE_SURGE_ANCHORS]) {
        for (let i = 1; i < anchors.length; i++) {
          expect(anchors[i][0]).toBeGreaterThan(anchors[i - 1][0]);
          expect(anchors[i][1]).toBeGreaterThan(0);
        }
      }
      expect(TURNOVER_SCALE_ANCHORS[0][1]).toBeLessThanOrEqual(0.2);
      expect(interpolateAnchors(0.9, TURNOVER_SCALE_ANCHORS, 1.0)).toBeCloseTo(0.965, 4);
      expect(interpolateAnchors(NaN, TURNOVER_SCALE_ANCHORS, 1.0)).toBe(1.0);
    });
  });
});
