// Feature Engine — combines market features with strategy-derived features.
// Contract: the feature vector at index i is built ONLY from candles[0..i].
// Labels are derived by the caller from candle i+1, which keeps the training
// matrix free of look-ahead and target leakage.

import {
  adx,
  atr,
  bollinger,
  ema,
  macd,
  pivotLevels,
  rollingHigh,
  rollingLow,
  rollingVwap,
  rsi,
  sma,
  stdev,
} from "./indicators";
import type { Candle, StrategyRepresentation } from "./types";

export type FeatureRow = {
  index: number;
  ts: number;
  x: number[];
  close: number;
  atrPct: number;
  hour: number;
  weekday: number;
  month: number;
  trendStrength: number;
  volatilityRank: number;
};

export type FeatureMatrix = {
  names: string[];
  rows: FeatureRow[];
  hasVolume: boolean;
  warmup: number;
};

const num = (v: number | null | undefined, fallback = 0): number =>
  v === null || v === undefined || !Number.isFinite(v) ? fallback : v;

const safeDiv = (a: number, b: number): number => (b === 0 || !Number.isFinite(b) ? 0 : a / b);

function zscore(values: number[], i: number, length: number): number {
  if (i < length) return 0;
  let mean = 0;
  for (let j = i - length + 1; j <= i; j += 1) mean += values[j] ?? 0;
  mean /= length;
  let variance = 0;
  for (let j = i - length + 1; j <= i; j += 1) variance += ((values[j] ?? 0) - mean) ** 2;
  const sd = Math.sqrt(variance / length);
  return sd === 0 ? 0 : ((values[i] ?? 0) - mean) / sd;
}

function percentileRank(values: number[], i: number, length: number): number {
  if (i < length) return 0.5;
  const current = values[i] ?? 0;
  let below = 0;
  for (let j = i - length + 1; j <= i; j += 1) if ((values[j] ?? 0) <= current) below += 1;
  return below / length;
}

export function buildFeatures(
  candles: Candle[],
  strategy?: StrategyRepresentation | null,
): FeatureMatrix {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume ?? 0);
  const hasVolume = volumes.some((v) => v > 0);

  const params = strategyParams(strategy);
  const emaFast = ema(closes, params.fastLen);
  const emaSlow = ema(closes, params.slowLen);
  const ema200 = ema(closes, 200);
  const sma50 = sma(closes, 50);
  const rsiSeries = rsi(closes, params.rsiLen);
  const rsiSlow = rsi(closes, 28);
  const atrSeries = atr(candles, params.atrLen);
  const macdSeries = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const vwap = rollingVwap(candles, 20);
  const adxSeries = adx(candles, 14);
  const hi20 = rollingHigh(candles, 20);
  const lo20 = rollingLow(candles, 20);
  const hi50 = rollingHigh(candles, 50);
  const lo50 = rollingLow(candles, 50);
  const returns = closes.map((c, i) => (i === 0 ? 0 : safeDiv(c - (closes[i - 1] ?? c), closes[i - 1] ?? c)));
  const realizedVol = stdev(returns, 20);

  const names = [
    "return_1",
    "return_3",
    "return_5",
    "return_10",
    "ema_fast_dist",
    "ema_slow_dist",
    "ema_cross_spread",
    "ema200_dist",
    "sma50_dist",
    "ema_slope",
    "rsi",
    "rsi_delta",
    "rsi_slow",
    "macd_hist",
    "macd_hist_delta",
    "atr_pct",
    "atr_ratio",
    "bb_position",
    "bb_width",
    "vwap_dist",
    "adx",
    "adx_delta",
    "range_high20_dist",
    "range_low20_dist",
    "range_high50_dist",
    "range_low50_dist",
    "break_of_structure",
    "market_structure",
    "body_ratio",
    "upper_wick_ratio",
    "lower_wick_ratio",
    "range_z",
    "realized_vol",
    "vol_percentile",
    "momentum_10",
    "pivot_dist",
    "camarilla_position",
    "hour_sin",
    "hour_cos",
    "weekday",
    "session_london",
    "session_newyork",
    "session_asia",
    "strategy_long_signal",
    "strategy_short_signal",
    "strategy_signal_age",
  ];
  if (hasVolume) {
    names.push("volume_z", "volume_trend", "volume_price_confirm");
  }

  const warmup = Math.max(200, params.slowLen + 40, 60);
  const rows: FeatureRow[] = [];
  let lastLongSignal = -1;
  let lastShortSignal = -1;

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (!c) continue;
    const prev = candles[i - 1];
    const fast = num(emaFast[i], c.close);
    const slow = num(emaSlow[i], c.close);
    const prevFast = num(emaFast[i - 1], fast);
    const prevSlow = num(emaSlow[i - 1], slow);
    const rsiNow = num(rsiSeries[i], 50);
    const crossUp = prevFast <= prevSlow && fast > slow && rsiNow > 50;
    const crossDown = prevFast >= prevSlow && fast < slow && rsiNow < 50;
    if (crossUp) lastLongSignal = i;
    if (crossDown) lastShortSignal = i;

    if (i < warmup) continue;

    const atrNow = num(atrSeries[i], (c.high - c.low) || c.close * 0.001);
    const atrPct = safeDiv(atrNow, c.close);
    const atrAvg = num(atrSeries[i - 20], atrNow);
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const date = new Date(c.ts);
    const hour = date.getUTCHours();
    const weekday = date.getUTCDay();
    const month = date.getUTCMonth() + 1;
    const bbUpper = num(bb.upper[i], c.close);
    const bbLower = num(bb.lower[i], c.close);
    const bbMid = num(bb.middle[i], c.close);
    const pivots = pivotLevels(prev ?? c);
    const structure =
      num(hi20[i], c.high) > num(hi20[i - 10], c.high) && num(lo20[i], c.low) > num(lo20[i - 10], c.low)
        ? 1
        : num(hi20[i], c.high) < num(hi20[i - 10], c.high) && num(lo20[i], c.low) < num(lo20[i - 10], c.low)
          ? -1
          : 0;
    const prevHigh20 = num(rollingHighAt(hi20, i - 1), c.high);
    const prevLow20 = num(rollingLowAt(lo20, i - 1), c.low);
    const bos = c.close > prevHigh20 ? 1 : c.close < prevLow20 ? -1 : 0;

    const x: number[] = [
      num(returns[i]),
      safeDiv(c.close - num(closes[i - 3], c.close), num(closes[i - 3], c.close)),
      safeDiv(c.close - num(closes[i - 5], c.close), num(closes[i - 5], c.close)),
      safeDiv(c.close - num(closes[i - 10], c.close), num(closes[i - 10], c.close)),
      safeDiv(c.close - fast, c.close),
      safeDiv(c.close - slow, c.close),
      safeDiv(fast - slow, c.close),
      safeDiv(c.close - num(ema200[i], c.close), c.close),
      safeDiv(c.close - num(sma50[i], c.close), c.close),
      safeDiv(fast - prevFast, c.close),
      (rsiNow - 50) / 50,
      (rsiNow - num(rsiSeries[i - 3], rsiNow)) / 50,
      (num(rsiSlow[i], 50) - 50) / 50,
      safeDiv(num(macdSeries.hist[i]), c.close),
      safeDiv(num(macdSeries.hist[i]) - num(macdSeries.hist[i - 3]), c.close),
      atrPct,
      safeDiv(atrNow, atrAvg) - 1,
      safeDiv(c.close - bbLower, bbUpper - bbLower || 1) - 0.5,
      safeDiv(bbUpper - bbLower, bbMid || 1),
      safeDiv(c.close - num(vwap[i], c.close), c.close),
      num(adxSeries[i], 20) / 100,
      (num(adxSeries[i], 20) - num(adxSeries[i - 5], 20)) / 100,
      safeDiv(num(hi20[i], c.high) - c.close, c.close),
      safeDiv(c.close - num(lo20[i], c.low), c.close),
      safeDiv(num(hi50[i], c.high) - c.close, c.close),
      safeDiv(c.close - num(lo50[i], c.low), c.close),
      bos,
      structure,
      safeDiv(body, range || 1),
      safeDiv(c.high - Math.max(c.open, c.close), range || 1),
      safeDiv(Math.min(c.open, c.close) - c.low, range || 1),
      zscore(
        candles.map((k) => k.high - k.low),
        i,
        50,
      ),
      num(realizedVol[i]),
      percentileRank(
        candles.map((k) => k.high - k.low),
        i,
        100,
      ),
      safeDiv(c.close - num(closes[i - 10], c.close), atrNow || 1),
      safeDiv(c.close - pivots.pivot, c.close),
      safeDiv(c.close - pivots.camarillaL3, (pivots.camarillaH3 - pivots.camarillaL3) || 1) - 0.5,
      Math.sin((2 * Math.PI * hour) / 24),
      Math.cos((2 * Math.PI * hour) / 24),
      weekday / 6,
      hour >= 7 && hour < 16 ? 1 : 0,
      hour >= 12 && hour < 21 ? 1 : 0,
      hour >= 0 && hour < 9 ? 1 : 0,
      lastLongSignal >= 0 && i - lastLongSignal <= 3 ? 1 : 0,
      lastShortSignal >= 0 && i - lastShortSignal <= 3 ? 1 : 0,
      lastLongSignal >= 0 || lastShortSignal >= 0
        ? Math.min(i - Math.max(lastLongSignal, lastShortSignal), 50) / 50
        : 1,
    ];

    if (hasVolume) {
      x.push(
        zscore(volumes, i, 50),
        safeDiv(volumes[i] ?? 0, avg(volumes, i, 20)) - 1,
        Math.sign(num(returns[i])) * Math.min(safeDiv(volumes[i] ?? 0, avg(volumes, i, 20)), 3),
      );
    }

    rows.push({
      index: i,
      ts: c.ts,
      x: x.map((v) => (Number.isFinite(v) ? v : 0)),
      close: c.close,
      atrPct,
      hour,
      weekday,
      month,
      trendStrength: num(adxSeries[i], 20),
      volatilityRank: percentileRank(
        candles.map((k) => k.high - k.low),
        i,
        100,
      ),
    });
  }

  return { names, rows, hasVolume, warmup };
}

function avg(values: number[], i: number, length: number): number {
  let sum = 0;
  let count = 0;
  for (let j = Math.max(0, i - length + 1); j <= i; j += 1) {
    sum += values[j] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function rollingHighAt(series: (number | null)[], i: number): number | null {
  return i < 0 ? null : (series[i] ?? null);
}

function rollingLowAt(series: (number | null)[], i: number): number | null {
  return i < 0 ? null : (series[i] ?? null);
}

function strategyParams(strategy?: StrategyRepresentation | null): {
  fastLen: number;
  slowLen: number;
  rsiLen: number;
  atrLen: number;
} {
  const defaults = { fastLen: 12, slowLen: 26, rsiLen: 14, atrLen: 14 };
  if (!strategy) return defaults;
  const read = (needle: string, fallback: number): number => {
    const hit = strategy.parameters.find((p) => p.name.toLowerCase().includes(needle));
    return typeof hit?.value === "number" && hit.value > 1 ? Math.round(hit.value) : fallback;
  };
  return {
    fastLen: read("fast", defaults.fastLen),
    slowLen: read("slow", defaults.slowLen),
    rsiLen: read("rsi", defaults.rsiLen),
    atrLen: read("atr", defaults.atrLen),
  };
}
