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
  currentPriceOverride?: number
): PhysicsRadarResult {
  // 负向防误杀边界守卫: 数据不足 5 根
  if (!bars || bars.length < 5) {
    const p = currentPriceOverride || (bars && bars.length > 0 ? bars[bars.length - 1].close : 0);
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
    m = round(volToday / maVol20, 2);
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
