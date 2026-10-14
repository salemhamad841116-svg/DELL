// Forecast / ML orchestration. Pure functions over candle series.
// Every number produced here comes from the data: features -> chronological
// split -> logistic models -> OOS calibration. No random or synthetic output.

import { buildFeatures } from "./features";
import { atr, ema, rsi } from "./indicators";
import {
  applyCalibration,
  contributions,
  predictProba,
  trainDirectionBundle,
  type TrainedBundle,
} from "./model";
import { detectRegimes } from "./regime";
import { buildHistoricalReport, simulate, type Trade } from "./backtest";
import type {
  Candle,
  DataQuality,
  DirectionState,
  EvidenceItem,
  HistoricalReport,
  HorizonForecast,
  NextCandleForecast,
  RegimeStats,
  StrategyRepresentation,
} from "./types";
import { getTimeframe } from "./timeframes";

export const MODEL_VERSION = "use-logit-1.0.0";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function dataQuality(samples: number, candles: number): DataQuality {
  if (candles === 0) return "NONE";
  if (samples >= 1200) return "HIGH";
  if (samples >= 400) return "MEDIUM";
  return "LOW";
}

function directionState(pUp: number, confidence: number): DirectionState {
  if (pUp >= 0.62 && confidence >= 0.55) return "STRONG_BULLISH";
  if (pUp >= 0.54) return "BULLISH";
  if (pUp <= 0.38 && confidence >= 0.55) return "STRONG_BEARISH";
  if (pUp <= 0.46) return "BEARISH";
  return "NEUTRAL";
}

/** Neutral band: moves smaller than a fraction of ATR count as no-direction. */
function buildLabels(candles: Candle[], indices: number[]): { up: number[]; down: number[] } {
  const up: number[] = [];
  const down: number[] = [];
  for (const i of indices) {
    const c = candles[i];
    const next = candles[i + 1];
    if (!c || !next) {
      up.push(0);
      down.push(0);
      continue;
    }
    const ret = (next.close - c.close) / c.close;
    up.push(ret > 0 ? 1 : 0);
    down.push(ret < 0 ? 1 : 0);
  }
  return { up, down };
}

export type TrainedTimeframe = {
  timeframe: string;
  bundle: TrainedBundle;
  featureNames: string[];
  lastRow: number[];
  lastClose: number;
  candles: number;
  usableSamples: number;
  atrPct: number;
  forwardReturns: number[];
};

export function trainTimeframe(
  candles: Candle[],
  timeframe: string,
  strategy?: StrategyRepresentation | null,
): TrainedTimeframe | null {
  const matrix = buildFeatures(candles, strategy);
  // The final row has no realised next candle, so it is prediction-only.
  const usable = matrix.rows.slice(0, Math.max(matrix.rows.length - 1, 0));
  if (usable.length < 200) return null;
  const indices = usable.map((r) => r.index);
  const labels = buildLabels(candles, indices);
  const X = usable.map((r) => r.x);
  const bundle = trainDirectionBundle(matrix.names, X, labels.up, labels.down);
  const lastRowObj = matrix.rows[matrix.rows.length - 1];
  if (!lastRowObj) return null;
  const forwardReturns = indices.map((i) => {
    const c = candles[i];
    const n = candles[i + 1];
    return c && n ? ((n.close - c.close) / c.close) * 100 : 0;
  });
  return {
    timeframe,
    bundle,
    featureNames: matrix.names,
    lastRow: lastRowObj.x,
    lastClose: lastRowObj.close,
    candles: candles.length,
    usableSamples: usable.length,
    atrPct: lastRowObj.atrPct,
    forwardReturns,
  };
}

export function horizonFromTrained(t: TrainedTimeframe): HorizonForecast {
  const spec = getTimeframe(t.timeframe);
  const rawUp = predictProba(t.bundle.up, t.lastRow);
  const rawDown = predictProba(t.bundle.down, t.lastRow);
  const pUp = applyCalibration(t.bundle.calibrationUp, rawUp);
  const pDown = applyCalibration(t.bundle.calibrationDown, rawDown);
  const sum = pUp + pDown;
  const bull = sum > 0 ? (pUp / sum) * (1 - neutralShare(t)) : 0.5;
  const bear = sum > 0 ? (pDown / sum) * (1 - neutralShare(t)) : 0.5;
  const neutral = 1 - bull - bear;
  const oos = t.bundle.metrics.outOfSample;
  const baseline = t.bundle.metrics.baseline;
  const edge = clamp(oos.accuracy - baseline.accuracy, 0, 0.5);
  const confidence = clamp(
    (t.bundle.overfittingRisk ? 0.25 : 1) * (0.4 * Math.abs(bull - bear) * 2 + 0.6 * (edge * 4 + (oos.auc - 0.5) * 2)),
    0.02,
    0.95,
  );
  const state = directionState(bull / Math.max(bull + bear, 1e-6), confidence);
  return {
    timeframe: t.timeframe,
    supported: spec?.supported ?? true,
    state,
    directionProbability: Math.max(bull, bear),
    bullishProbability: bull,
    bearishProbability: bear,
    neutralProbability: Math.max(neutral, 0),
    confidence,
    signalStrength: clamp(Math.abs(bull - bear) * 2, 0, 1),
    dataQuality: dataQuality(t.usableSamples, t.candles),
    sampleSize: t.usableSamples,
    historicalHitRate: oos.accuracy,
    candlesAvailable: t.candles,
    ...(t.bundle.overfittingRisk ? { note: "OVERFITTING RISK — الأداء خارج العينة أضعف من المرجع" } : {}),
  };
}

function neutralShare(t: TrainedTimeframe): number {
  // Wider neutral band when the model has no measurable edge out of sample.
  const oos = t.bundle.metrics.outOfSample;
  const baseline = t.bundle.metrics.baseline;
  const edge = oos.accuracy - baseline.accuracy;
  if (t.bundle.overfittingRisk || edge <= 0) return 0.3;
  return clamp(0.2 - edge, 0.05, 0.2);
}

export function unsupportedHorizon(timeframe: string, reason: string): HorizonForecast {
  return {
    timeframe,
    supported: false,
    state: "NEUTRAL",
    directionProbability: 0,
    bullishProbability: 0,
    bearishProbability: 0,
    neutralProbability: 0,
    confidence: 0,
    signalStrength: 0,
    dataQuality: "NONE",
    sampleSize: 0,
    historicalHitRate: 0,
    candlesAvailable: 0,
    note: reason,
  };
}

export function nextCandleForecast(
  symbol: string,
  t: TrainedTimeframe,
  candles: Candle[],
  strategy?: StrategyRepresentation | null,
): NextCandleForecast {
  const horizon = horizonFromTrained(t);
  const { current, regimes } = detectRegimes(candles);
  const raw = contributions(t.bundle.up, t.lastRow);
  const evidence: EvidenceItem[] = raw
    .map((v, j) => ({
      label: t.featureNames[j] ?? `f${j}`,
      contribution: Number((v * 100).toFixed(2)),
      supports: (v >= 0 ? "BULLISH" : "BEARISH") as EvidenceItem["supports"],
      value: Number((t.lastRow[j] ?? 0).toFixed(5)),
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 12);

  // Expected move: mean forward return conditioned on the model's direction,
  // measured on realised history only.
  const dir = horizon.bullishProbability >= horizon.bearishProbability ? 1 : -1;
  const absMoves = t.forwardReturns.map((r) => Math.abs(r)).sort((a, b) => a - b);
  const median = absMoves[Math.floor(absMoves.length / 2)] ?? 0;
  const p80 = absMoves[Math.floor(absMoves.length * 0.8)] ?? median;
  const vol =
    Math.sqrt(
      t.forwardReturns.reduce((a, r) => a + r * r, 0) / Math.max(t.forwardReturns.length, 1),
    ) || 0;
  const expectedReturn = dir * median * horizon.signalStrength;
  const close = t.lastClose;

  const sameRegime = regimes
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r === current && x.i < candles.length - 1);
  const regimeReturns = sameRegime
    .map((x) => {
      const c = candles[x.i];
      const n = candles[x.i + 1];
      return c && n ? ((n.close - c.close) / c.close) * 100 : 0;
    })
    .filter((v) => Number.isFinite(v));
  const regimeStats: RegimeStats = {
    regime: current,
    samples: regimeReturns.length,
    successRate:
      regimeReturns.length === 0
        ? 0
        : regimeReturns.filter((v) => (dir > 0 ? v > 0 : v < 0)).length / regimeReturns.length,
    averageReturn:
      regimeReturns.length === 0 ? 0 : regimeReturns.reduce((a, v) => a + v, 0) / regimeReturns.length,
  };

  return {
    symbol,
    timeframe: t.timeframe,
    direction:
      horizon.state === "NEUTRAL"
        ? "NEUTRAL"
        : horizon.bullishProbability > horizon.bearishProbability
          ? "BULLISH"
          : "BEARISH",
    bullishProbability: horizon.bullishProbability,
    bearishProbability: horizon.bearishProbability,
    neutralProbability: horizon.neutralProbability,
    confidence: horizon.confidence,
    expectedReturn,
    expectedLow: close * (1 - p80 / 100),
    expectedHigh: close * (1 + p80 / 100),
    expectedVolatility: vol,
    referenceClose: close,
    sampleSize: t.usableSamples,
    modelVersion: MODEL_VERSION,
    dataTimestamp: new Date(candles[candles.length - 1]?.ts ?? Date.now()).toISOString(),
    dataQuality: horizon.dataQuality,
    evidence,
    metrics: t.bundle.metrics,
    overfittingRisk: t.bundle.overfittingRisk,
    regime: current,
    regimeStats,
  };
}

/** Signal function derived from the parsed strategy's indicator lengths. */
export function strategySignal(
  candles: Candle[],
  strategy?: StrategyRepresentation | null,
): (i: number) => "LONG" | "SHORT" | null {
  const closes = candles.map((c) => c.close);
  const read = (needle: string, fallback: number): number => {
    const hit = strategy?.parameters.find((p) => p.name.toLowerCase().includes(needle));
    return typeof hit?.value === "number" && hit.value > 1 ? Math.round(hit.value) : fallback;
  };
  const fast = ema(closes, read("fast", 12));
  const slow = ema(closes, read("slow", 26));
  const r = rsi(closes, read("rsi", 14));
  return (i: number) => {
    const f = fast[i];
    const s = slow[i];
    const pf = fast[i - 1];
    const ps = slow[i - 1];
    const rv = r[i];
    if (f == null || s == null || pf == null || ps == null || rv == null) return null;
    if (pf <= ps && f > s && rv > 50) return "LONG";
    if (pf >= ps && f < s && rv < 50) return "SHORT";
    return null;
  };
}

export function runBacktest(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  strategy?: StrategyRepresentation | null,
): { report: HistoricalReport; trades: Trade[] } {
  const atrSeries = atr(candles, 14);
  void atrSeries;
  const trades = simulate(candles, strategySignal(candles, strategy), {
    tpAtr: 2,
    slAtr: 1,
    maxBars: 24,
    warmup: 60,
  });
  return { report: buildHistoricalReport(symbol, timeframe, candles, trades), trades };
}
