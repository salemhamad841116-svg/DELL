// Next Candle Forecast core — browser-safe, deterministic, no I/O.
// Contract: features at bar i use candles[0..i] only; the label of bar i is bar i+1.
// A forecast is produced only from a FULLY CLOSED source bar and targets exactly the next bar
// of the same timeframe.

import { atr } from "../indicators";
import { buildFeatures } from "../features";
import { metrics, predictProba, contributions } from "../model";
import { fitTri } from "./reliability";
import { detectRegimes } from "../regime";
import type { Candle, MarketRegime, ModelMetrics } from "../types";
import { PineRuntime, type V } from "../strategy/executor";
import type { StrategyIR } from "../strategy/ir";

export const FEATURE_VERSION = "nc-feat-1.0.0";
export const NC_MODEL_VERSION = "nc-logit-2.1.0"; // 2.1: multinomial matrix-scaling calibration + shadow forecasts
/** NEUTRAL when |move| < NEUTRAL_ATR_K × ATR(14) of the source bar. */
export const NEUTRAL_ATR_K = 0.1;

export type Direction = "UP" | "DOWN" | "NEUTRAL";

export function labelMove(sourceClose: number, targetClose: number, atrValue: number | null, k = NEUTRAL_ATR_K): Direction {
  const d = targetClose - sourceClose;
  const thr = atrValue && Number.isFinite(atrValue) ? atrValue * k : 0;
  if (Math.abs(d) <= thr || d === 0) return "NEUTRAL";
  return d > 0 ? "UP" : "DOWN";
}

/** Drop any bar that is still forming at `now`. */
export function closedBars(candles: Candle[], tfMs: number, now: number): Candle[] {
  let n = candles.length;
  while (n > 0 && candles[n - 1]!.ts + tfMs > now) n -= 1;
  return n === candles.length ? candles : candles.slice(0, n);
}

export type IndicatorSeries = { names: string[]; values: number[][]; unsupported: string[] };

/** Execute an indicator/strategy through the semantic engine and capture its top-level numeric series. */
export function indicatorSeries(ir: StrategyIR | null, candles: Candle[], meta: { tickerid: string; timeframe: string; market?: string }): IndicatorSeries {
  if (!ir) return { names: [], values: [], unsupported: [] };
  const unsupported = ir.diagnostics.filter((d) => d.code === "UNSUPPORTED_SEMANTIC" || d.code === "PARSE_ERROR").map((d) => `${d.construct} @${d.line}:${d.col}`);
  if (unsupported.length || ir.sourceLanguage !== "pinescript") return { names: [], values: [], unsupported: unsupported.length ? unsupported : [`${ir.sourceLanguage}: execution not supported`] };
  const inputs = new Set(ir.inputs.map((x) => x.name));
  const names: string[] = [];
  for (const s of ir.program) {
    if (s.k === "decl" && !inputs.has(s.name)) names.push(s.name);
    if (s.k === "tuple") names.push(...s.names);
  }
  const uniq = Array.from(new Set(names));
  const rt = new PineRuntime(ir, candles, {}, 0.01, meta);
  const raw: V[][] = uniq.map(() => []);
  try {
    for (let i = 0; i < candles.length; i++) {
      rt.step(i, { positionSize: 0, avgPrice: null, equity: 0, openTrades: 0 });
      uniq.forEach((n, k) => { raw[k]![i] = rt.valueAt(n, i); });
    }
  } catch (e) {
    return { names: [], values: [], unsupported: [`runtime: ${(e as Error).message}`] };
  }
  const outNames: string[] = []; const outVals: number[][] = [];
  uniq.forEach((n, k) => {
    const col = raw[k]!;
    if (!col.some((v) => typeof v === "number" || typeof v === "boolean")) return; // strings/arrays are not features
    outNames.push(n);
    outVals.push(col.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN)));
  });
  return { names: outNames, values: outVals, unsupported: [] };
}

export type NCDataset = { names: string[]; X: number[][]; idx: number[]; atr: (number | null)[] };

/** Market features + indicator values (+ distance to price for level-like series), row per bar. */
export function buildDataset(candles: Candle[], ind: IndicatorSeries): NCDataset {
  const fm = buildFeatures(candles, null);
  const a = atr(candles, 14);
  const levelLike = ind.values.map((col) => {
    let hits = 0, n = 0;
    col.forEach((v, i) => { if (Number.isFinite(v)) { n++; if (Math.abs(v / candles[i]!.close - 1) < 0.2) hits++; } });
    return n > 0 && hits / n > 0.8;
  });
  const names = [...fm.names];
  ind.names.forEach((n, k) => { names.push(`ind:${n}`, `ind:${n}:na`); if (levelLike[k]) names.push(`dist:${n}`); });
  const X: number[][] = []; const idx: number[] = [];
  for (const r of fm.rows) {
    const i = r.index; const c = candles[i]!; const at = a[i] ?? null;
    const row = [...r.x];
    ind.values.forEach((col, k) => {
      const v = col[i]; const ok = v !== undefined && Number.isFinite(v);
      row.push(ok && !levelLike[k] ? v! : 0, ok ? 0 : 1);
      if (levelLike[k]) row.push(ok && at ? (c.close - v!) / at : 0);
    });
    X.push(row); idx.push(i);
  }
  return { names, X, idx, atr: a };
}

export type Accuracy3 = { samples: number; accuracy: number; up: ModelMetrics; down: ModelMetrics };

export type NCForecast = {
  direction: Direction;
  up: number; down: number; neutral: number; confidence: number;
  regime: MarketRegime;
  sourceBarTs: number; targetBarTs: number; targetCloseTs: number;
  referenceClose: number;
  sampleSize: number;
  oos: { samples: number; accuracy: number; baseline: number };
  overfittingRisk: boolean;
  evidence: { label: string; contribution: number }[];
  featureCount: number;
  indicatorFeatures: string[];
  /** Real weight × standardized value of the logit that produced the winning side (not rescaled). */
  contributionsRaw: { feature: string; value: number; contribution: number }[];
  contributionModel: string;
  liveFeatures: Record<string, number>;
  indicatorValues: Record<string, number | null>;
};

/** Train on closed history, forecast the bar after the last closed bar. */
export function forecastNext(candles: Candle[], tfMs: number, ind: IndicatorSeries): NCForecast | null {
  const ds = buildDataset(candles, ind);
  const last = candles.length - 1;
  const labels: Direction[] = []; const X: number[][] = [];
  let liveRow: number[] | null = null;
  ds.idx.forEach((i, r) => {
    if (i === last) { liveRow = ds.X[r]!; return; }
    const nxt = candles[i + 1]; if (!nxt) return;
    X.push(ds.X[r]!); labels.push(labelMove(candles[i]!.close, nxt.close, ds.atr[i] ?? null));
  });
  if (!liveRow || X.length < MIN_TRAIN_SAMPLES) return null;
  const n = X.length; const tEnd = Math.floor(n * 0.6), vEnd = Math.floor(n * 0.8);
  const yUp = labels.map((l) => (l === "UP" ? 1 : 0));
  const E = 5; // embargo rows between chronological splits (no leakage across the boundary)
  const rg = (x: number, y: number) => Array.from({ length: Math.max(0, y - x) }, (_, k) => x + k);
  const tm = fitTri(X, labels, rg(0, tEnd - E), rg(tEnd, vEnd - E)); // multiclass calibration on validation only
  const { mUp, mDn } = tm; const tri = tm.predict;
  const pv = (m: typeof mUp, a: number, b: number) => X.slice(a, b).map((x) => predictProba(m, x));
  const pick = (p: { up: number; down: number; neutral: number }): Direction => (p.up >= p.down && p.up >= p.neutral ? "UP" : p.down >= p.neutral ? "DOWN" : "NEUTRAL");
  // Untouched OOS evaluation.
  let hit = 0; const counts: Record<Direction, number> = { UP: 0, DOWN: 0, NEUTRAL: 0 };
  for (let i = vEnd; i < n; i++) { if (pick(tri(X[i]!)) === labels[i]) hit++; counts[labels[i]!]++; }
  const oosN = n - vEnd;
  const oosAcc = oosN ? hit / oosN : 0;
  const baseline = oosN ? Math.max(counts.UP, counts.DOWN, counts.NEUTRAL) / oosN : 0;
  const trainAcc = metrics(yUp.slice(0, tEnd - E), pv(mUp, 0, tEnd - E)).accuracy;
  const oosUpAcc = metrics(yUp.slice(vEnd), pv(mUp, vEnd, n)).accuracy;
  const p = tri(liveRow);
  const direction = pick(p);
  const contrib = contributions(direction === "DOWN" ? mDn : mUp, liveRow);
  const lr = liveRow as number[];
  const contributionsRaw = contrib.map((c, j) => ({ feature: ds.names[j]!, value: lr[j]!, contribution: c })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 10);
  const evidence = contrib.map((c, j) => ({ label: ds.names[j]!, contribution: +(c * 20).toFixed(2) })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 8);
  const src = candles[last]!;
  return {
    direction, ...p, confidence: Math.max(p.up, p.down, p.neutral),
    regime: detectRegimes(candles).current,
    sourceBarTs: src.ts, targetBarTs: src.ts + tfMs, targetCloseTs: src.ts + 2 * tfMs,
    referenceClose: src.close, sampleSize: n,
    oos: { samples: oosN, accuracy: oosAcc, baseline },
    overfittingRisk: trainAcc - oosUpAcc > 0.1 || oosAcc < baseline,
    evidence, featureCount: ds.names.length, indicatorFeatures: ind.names,
    contributionsRaw, contributionModel: direction === "DOWN" ? "P(DOWN) logit" : "P(UP) logit",
    liveFeatures: Object.fromEntries(ds.names.map((nm, j) => [nm, lr[j]!])),
    indicatorValues: Object.fromEntries(ind.names.map((nm, k) => [nm, ind.values[k]![last] ?? null])),
  };
}

export const MIN_TRAIN_SAMPLES = 200;
export const DEFAULT_MIN_CONFIDENCE = 0.55;
export type Signal = Direction | "LOW_CONFIDENCE";

/** Final signal = highest probability, gated: a directional winner below `minConf` becomes LOW_CONFIDENCE.
 *  (NEUTRAL = movement expected too small; LOW_CONFIDENCE = model not sure enough.) */
export function signalFrom(p: { up: number; down: number; neutral: number }, minConf = DEFAULT_MIN_CONFIDENCE): Signal {
  const d: Direction = p.up >= p.down && p.up >= p.neutral ? "UP" : p.down >= p.neutral ? "DOWN" : "NEUTRAL";
  if (d === "NEUTRAL") return "NEUTRAL";
  return (d === "UP" ? p.up : p.down) < minConf ? "LOW_CONFIDENCE" : d;
}

export type LedgerRow = { direction: string; signal?: string | null; actual_result: string | null; correct: boolean | null; confidence: number; created_at: string; evaluation_status: string };

export function accuracyStats(rows: LedgerRow[]) {
  const sig = (r: LedgerRow) => r.signal ?? r.direction;
  const ev = rows.filter((r) => r.evaluation_status === "evaluated");
  const signals = ev.filter((r) => sig(r) === "UP" || sig(r) === "DOWN");
  const correct = signals.filter((r) => r.correct).length;
  const dirAcc = (d: string) => { const s = signals.filter((r) => sig(r) === d); return { n: s.length, acc: s.length ? s.filter((r) => r.correct).length / s.length : null }; };
  const bins = [0.33, 0.45, 0.55, 0.65, 0.75, 1.01].slice(0, -1).map((from, k, arr) => {
    const to = [0.45, 0.55, 0.65, 0.75, 1.01][k]!;
    const s = signals.filter((r) => r.confidence >= from && r.confidence < to);
    void arr;
    return { from, to: Math.min(to, 1), n: s.length, observed: s.length ? s.filter((r) => r.correct).length / s.length : null };
  });
  return {
    total: rows.length, evaluated: ev.length, pending: rows.length - ev.length,
    correct, wrong: signals.length - correct, neutral: ev.length - signals.length,
    accuracy: signals.length ? correct / signals.length : null,
    upAccuracy: dirAcc("UP"), downAccuracy: dirAcc("DOWN"), calibration: bins,
  };
}
