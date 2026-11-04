import { Database } from "bun:sqlite";
import { QuoteProvider, DailyBar, normalizeSymbol } from "./quotes.ts";
import { round } from "./calc.ts";

export interface LinearRegressionResult {
  slope: number;       // k
  intercept: number;   // b
  mean_y: number;      // P_mean
  normalized_slope_pct: number; // v = (k / P_mean) * 100%
}

export interface PhysicsRadarResult {
  symbol: string;
  name: string;
  current_price: number;
  data_bars_count: number;
  // 1. 速度 (动量斜率 v)
  v_short: number;     // 5日短期动量速度 (%)
  v_mid: number;       // 20日中期动量速度 (%)
  // 2. 加速度 a 与刹车状态
  a: number;           // a = v_short_current - v_short_prev (%/日)
  brake_status: string; // ACCELERATING_UP | ACCELERATING_DOWN | BRAKING_BOTTOM | BRAKING_TOP | STEADY
  // 3. 惯性质量 m
  m: number;           // Vol_today / MA(Vol, 20)
  // 4. 多空合力 F
  F: number;           // F = m * a
  force_status: string; // STRONG_SUPPORT | STRONG_RESISTANCE | NEUTRAL
  // 4.1 博弈参与度与合力置信度加权 (Confidence-Weighted Effective Force)
  turnover_rate: number;     // τ 当日真实换手率 (%)，0 表示不可用/缺失
  confidence_weight: number; // W_conf 置信度加权系数，钳制于 [0.10, 2.00]
  confidence_level: "NONE" | "LOW" | "MEDIUM" | "HIGH"; // 参与度置信等级
  effective_force: number;   // F_eff = F × W_conf (有效置信合力)
  // 5. 流体阻尼系数 μ
  mu: number;          // Vol_today / (Max(High - Low, 0.001) / Close_today)
  // 6. 周期空间位置
  pct_rank_60: number; // 60日价格分位数 (%)
  pullback_60: number; // 距60日最高点回撤 (%)
  pct_rank_250: number; // 250日价格分位数 (%)
  pullback_250: number; // 距250日最高点回撤 (%)
  min_60: number;
  max_60: number;
  min_250: number;
  max_250: number;
}

/**
 * 换手率规模锚点 [τ%, W_abs]
 * 逻辑：换手率越低，参与博弈的筹码越少，同样的斜率越可能是“地量假动作”，必须大幅折价；
 * 换手率进入放量区间后给予温和溢价上限，避免天量情绪过热被无限放大。
 */
export const TURNOVER_SCALE_ANCHORS: ReadonlyArray<[number, number]> = [
  [0.02, 0.15],
  [0.05, 0.22],
  [0.10, 0.33],
  [0.20, 0.45],
  [0.40, 0.70],
  [0.60, 0.84],
  [0.80, 0.93],
  [1.00, 1.00],
  [1.50, 1.06],
  [2.00, 1.12],
  [3.00, 1.18],
  [5.00, 1.25],
];

/**
 * 相对活跃倍数锚点 [γ, W_rel]，γ = τ / τ̄20 (无历史换手率序列时以成交量倍数 m 等价替代)
 * 1.00 = 与近 20 日均量持平 → 中性基准 1.00
 */
export const RELATIVE_SURGE_ANCHORS: ReadonlyArray<[number, number]> = [
  [0.30, 0.65],
  [0.50, 0.75],
  [0.80, 0.92],
  [1.00, 1.00],
  [1.50, 1.12],
  [2.00, 1.22],
  [3.00, 1.35],
  [5.00, 1.45],
];

/** W_conf 硬性钳制区间，防止极端数据击穿 */
export const CONFIDENCE_WEIGHT_CLAMP: readonly [number, number] = [0.10, 2.00];
/** 置信等级分界：W_conf < 0.80 → LOW；[0.80, 1.20) → MEDIUM；≥ 1.20 → HIGH（HIGH 额外要求换手率证据可用） */
export const CONFIDENCE_LEVEL_LOW_MAX = 0.80;
export const CONFIDENCE_LEVEL_HIGH_MIN = 1.20;
/** 换手率缺失时的置信上限：没有绝对参与度证据，绝不宣称 HIGH */
export const MISSING_TURNOVER_WEIGHT_CAP = 1.20;

/**
 * 分段线性插值（锚点必须按 x 升序）；区间外做端点饱和，绝不外推或产生 NaN。
 */
export function interpolateAnchors(
  x: number,
  anchors: ReadonlyArray<[number, number]>,
  fallback: number
): number {
  if (!Number.isFinite(x) || anchors.length === 0) return fallback;
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      const span = x1 - x0;
      if (span <= 0) return y1;
      const t = (x - x0) / span;
      const y = y0 + (y1 - y0) * t;
      return Number.isFinite(y) ? y : y0;
    }
  }
  return last[1];
}

export interface ConfidenceWeightResult {
  turnover_rate: number;
  confidence_weight: number;
  confidence_level: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  /** 相对活跃倍数 γ (换手率缺失时退化为成交量倍数 m) */
  relative_activity: number;
  /** 换手率绝对规模是否为有效证据 */
  turnover_available: boolean;
}

/**
 * 计算置信度加权系数 W_conf 与等级。
 *
 * W_conf = clamp(W_abs(τ) × W_rel(γ), 0.10, 2.00)
 *   - W_abs：当日换手率的绝对规模（判断是否“地量”）；
 *   - W_rel：相对近 20 日均量的放量倍数（判断是否“重兵对决”）。
 *
 * 负向防误杀守卫：
 *   1. τ 缺失 / 0 / 负数 / NaN / Infinity → 视为不可用：W_abs = 1.0（不折价也不溢价），
 *      并封顶 W_conf ≤ 1.20，等级永不宣称 HIGH（HIGH 需同时具备绝对换手率证据）；
 *   2. γ 缺失 / 0 / 负数 / NaN / Infinity → 视为无相对证据：W_rel = 1.0；
 *   3. 任何路径均返回有限数值，绝不产生 NaN / Infinity / 除零。
 */
export function computeConfidenceWeight(
  turnoverRate?: number | null,
  volumeMultiple?: number | null
): ConfidenceWeightResult {
  const tauAvailable =
    typeof turnoverRate === "number" && Number.isFinite(turnoverRate) && turnoverRate > 0;
  const tau = tauAvailable ? (turnoverRate as number) : 0;

  const gammaAvailable =
    typeof volumeMultiple === "number" && Number.isFinite(volumeMultiple) && volumeMultiple > 0;
  const gamma = gammaAvailable ? (volumeMultiple as number) : 1.0;

  const wAbs = tauAvailable ? interpolateAnchors(tau, TURNOVER_SCALE_ANCHORS, 1.0) : 1.0;
  const wRel = interpolateAnchors(gamma, RELATIVE_SURGE_ANCHORS, 1.0);

  let weight = wAbs * wRel;
  if (!Number.isFinite(weight)) weight = 1.0;
  weight = Math.min(
    CONFIDENCE_WEIGHT_CLAMP[1],
    Math.max(CONFIDENCE_WEIGHT_CLAMP[0], weight)
  );
  if (!tauAvailable) {
    weight = Math.min(weight, MISSING_TURNOVER_WEIGHT_CAP);
  }

  // 等级：NONE 表示无数据；LOW < 0.80 ≤ MEDIUM；HIGH 需 W_conf ≥ 1.20 **且**具备绝对换手率证据
  let level: "NONE" | "LOW" | "MEDIUM" | "HIGH" = "MEDIUM";
  if (weight < CONFIDENCE_LEVEL_LOW_MAX) level = "LOW";
  else if (tauAvailable && weight >= CONFIDENCE_LEVEL_HIGH_MIN) level = "HIGH";

  return {
    turnover_rate: tauAvailable ? round(tau, 4) : 0,
    confidence_weight: round(weight, 4),
    confidence_level: level,
    relative_activity: round(gamma, 4),
    turnover_available: tauAvailable,
  };
}

/**
 * 最小二乘一阶线性回归: y = kx + b
 * x 取 0, 1, ..., N - 1
 */
export function linearRegression(values: number[]): LinearRegressionResult {
  const n = values.length;
  if (n < 2) {
    const mean = n === 1 ? values[0] : 0;
    return { slope: 0, intercept: mean, mean_y: mean, normalized_slope_pct: 0 };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = values[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;

  const denominator = sumXX - sumX * meanX;
  if (Math.abs(denominator) < 1e-12 || Math.abs(meanY) < 1e-12) {
    return { slope: 0, intercept: meanY, mean_y: meanY, normalized_slope_pct: 0 };
  }

  const slope = (sumXY - sumX * meanY) / denominator;
  const intercept = meanY - slope * meanX;
  const normalized_slope_pct = (slope / meanY) * 100;

  if (isNaN(slope) || !isFinite(slope) || isNaN(normalized_slope_pct) || !isFinite(normalized_slope_pct)) {
    return { slope: 0, intercept: meanY, mean_y: meanY, normalized_slope_pct: 0 };
  }

  return {
    slope: round(slope, 6),
    intercept: round(intercept, 6),
    mean_y: round(meanY, 6),
    normalized_slope_pct: round(normalized_slope_pct, 4),
  };
}

/**
 * 计算标的物理量化指标
 */
export function computePhysicsRadar(
  symbol: string,
  name: string,
  bars: DailyBar[],
  bars250?: DailyBar[],
  currentPriceOverride?: number,
  turnoverRate?: number
): PhysicsRadarResult {
  // 负向防误杀边界守卫: 数据不足 5 根
  if (!bars || bars.length < 5) {
    const p = currentPriceOverride || (bars && bars.length > 0 ? bars[bars.length - 1].close : 0);
    // 数据不足时 F = 0，有效合力必为 0；置信度仅作为数据质量旁注安全提供
    const guardConf = computeConfidenceWeight(turnoverRate, 0);
    
    // Issue #10 修复: 数据完全缺失时 confidence_level 应为 "NONE"
    const confidenceLevel = (!bars || bars.length === 0) ? "NONE" : guardConf.confidence_level;
    
    return {
      symbol,
      name,
      current_price: round(p, 3),
      data_bars_count: bars ? bars.length : 0,
      v_short: 0,
      v_mid: 0,
      a: 0,
      brake_status: "STEADY",
      m: 0,
      F: 0,
      force_status: "NEUTRAL",
      turnover_rate: guardConf.turnover_rate,
      confidence_weight: guardConf.confidence_weight,
      confidence_level: confidenceLevel,
      effective_force: 0,
      mu: 0,
      pct_rank_60: 0,
      pullback_60: 0,
      pct_rank_250: 0,
      pullback_250: 0,
      min_60: p,
      max_60: p,
      min_250: p,
      max_250: p,
    };
  }

  const n = bars.length;
  const lastBar = bars[n - 1];
  const currentPrice = currentPriceOverride && currentPriceOverride > 0 ? currentPriceOverride : lastBar.close;

  // 1. 速度 v (动量斜率)
  // 短期 5 日
  const close5 = bars.slice(-5).map((b) => b.close);
  const reg5Current = linearRegression(close5);
  const v_short = reg5Current.normalized_slope_pct;

  // 中期 20 日 (若不足20日，则取可用全部)
  const close20 = bars.slice(-20).map((b) => b.close);
  const reg20 = linearRegression(close20);
  const v_mid = reg20.normalized_slope_pct;

  // 2. 加速度 a 与刹车状态
  // a = v_short_current - v_short_prev
  // v_short_prev 取 bars[-6..-2]
  let a = 0;
  if (n >= 6) {
    const close5Prev = bars.slice(-6, -1).map((b) => b.close);
    const reg5Prev = linearRegression(close5Prev);
    a = round(v_short - reg5Prev.normalized_slope_pct, 4);
  } else {
    a = 0;
  }

  let brake_status = "STEADY";
  if (Math.abs(a) < 0.05) {
    brake_status = "STEADY";
  } else if (a > 0) {
    if (v_short >= 0) {
      brake_status = "ACCELERATING_UP"; // 加速上涨
    } else {
      brake_status = "BRAKING_BOTTOM"; // 减速筑底 (下跌中刹车减速)
    }
  } else {
    // a < 0
    if (v_short <= 0) {
      brake_status = "ACCELERATING_DOWN"; // 加速下跌
    } else {
      brake_status = "BRAKING_TOP"; // 冲高减速滞涨
    }
  }

  // 3. 惯性质量 m = Vol_today / MA(Vol, 20)
  const volSlice = bars.slice(-20).map((b) => b.volume);
  const sumVol = volSlice.reduce((acc, v) => acc + v, 0);
  const maVol20 = volSlice.length > 0 ? sumVol / volSlice.length : 0;
  const volToday = lastBar.volume;

  let m = 0;
  if (maVol20 > 0 && volToday > 0) {
    m = round(volToday / maVol20, 6);
  } else if (volToday === 0) {
    m = 0;
  }

  // 4. 多空合力 F = m * a
  const F = round(m * a, 4);
  let force_status = "NEUTRAL";
  if (F >= 0.5) {
    force_status = "STRONG_SUPPORT";
  } else if (F <= -0.5) {
    force_status = "STRONG_RESISTANCE";
  }

  // 4.1 博弈参与度 (换手率) → 置信度加权有效合力 F_eff = F × W_conf
  // 相对活跃倍数 γ 以“当日成交量 / 20 日均量”= m 作为等价锚点:
  //   γ = τ / τ̄20 == (Vol_today / FloatShares) / (MA20Vol / FloatShares) == Vol_today / MA20Vol
  const conf = computeConfidenceWeight(turnoverRate, m);
  let effectiveForce = F * conf.confidence_weight;
  if (!Number.isFinite(effectiveForce)) effectiveForce = 0;

  // 5. 流体阻尼系数 μ = Vol_today / (Max(High - Low, 0.001) / Close_today)
  const highToday = lastBar.high;
  const lowToday = lastBar.low;
  const closeToday = lastBar.close > 0 ? lastBar.close : 0.001;
  const amplitude = Math.max(highToday - lowToday, 0.001);
  const relativeAmp = amplitude / closeToday;

  let mu = 0;
  if (volToday > 0 && relativeAmp > 0) {
    mu = round(volToday / relativeAmp, 2);
  } else {
    mu = 0;
  }

  // 6. 周期空间位置 (60日 / 250日)
  const bars60 = bars.slice(-60);
  let min60 = Infinity;
  let max60 = -Infinity;
  for (const b of bars60) {
    if (b.low < min60) min60 = b.low;
    if (b.high > max60) max60 = b.high;
  }
  if (!isFinite(min60)) min60 = currentPrice;
  if (!isFinite(max60)) max60 = currentPrice;

  let pct_rank_60 = 0;
  if (max60 > min60) {
    pct_rank_60 = round(((currentPrice - min60) / (max60 - min60)) * 100, 2);
  }
  let pullback_60 = 0;
  if (max60 > 0) {
    pullback_60 = round(((currentPrice - max60) / max60) * 100, 2);
  }

  const dataset250 = bars250 && bars250.length > 0 ? bars250 : bars;
  const slice250 = dataset250.slice(-250);
  let min250 = Infinity;
  let max250 = -Infinity;
  for (const b of slice250) {
    if (b.low < min250) min250 = b.low;
    if (b.high > max250) max250 = b.high;
  }
  if (!isFinite(min250)) min250 = currentPrice;
  if (!isFinite(max250)) max250 = currentPrice;

  let pct_rank_250 = 0;
  if (max250 > min250) {
    pct_rank_250 = round(((currentPrice - min250) / (max250 - min250)) * 100, 2);
  }
  let pullback_250 = 0;
  if (max250 > 0) {
    pullback_250 = round(((currentPrice - max250) / max250) * 100, 2);
  }

  return {
    symbol,
    name,
    current_price: round(currentPrice, 3),
    data_bars_count: n,
    v_short: isNaN(v_short) || !isFinite(v_short) ? 0 : v_short,
    v_mid: isNaN(v_mid) || !isFinite(v_mid) ? 0 : v_mid,
    a: isNaN(a) || !isFinite(a) ? 0 : a,
    brake_status,
    m: isNaN(m) || !isFinite(m) ? 0 : m,
    F: isNaN(F) || !isFinite(F) ? 0 : F,
    force_status,
    turnover_rate: conf.turnover_rate,
    confidence_weight: conf.confidence_weight,
    confidence_level: conf.confidence_level,
    effective_force: round(effectiveForce, 4),
    mu: isNaN(mu) || !isFinite(mu) ? 0 : mu,
    pct_rank_60: isNaN(pct_rank_60) || !isFinite(pct_rank_60) ? 0 : pct_rank_60,
    pullback_60: isNaN(pullback_60) || !isFinite(pullback_60) ? 0 : pullback_60,
    pct_rank_250: isNaN(pct_rank_250) || !isFinite(pct_rank_250) ? 0 : pct_rank_250,
    pullback_250: isNaN(pullback_250) || !isFinite(pullback_250) ? 0 : pullback_250,
    min_60: round(min60, 3),
    max_60: round(max60, 3),
    min_250: round(min250, 3),
    max_250: round(max250, 3),
  };
}
