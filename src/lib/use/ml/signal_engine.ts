// End-to-end: candles → tagged features → purged CV (OOF) → isotonic calibration → regime → trust gate → signal.
// Labels come from candle i+1 only; features at i use candles[0..i] only.
import type { Candle } from "../types";
import { buildTaggedFeatures } from "./features";
import { purgedKFold, assertNoLeakage } from "./purged_cv";
import { fitLogistic, fitGBM, ensemble, fitIsotonic, type Model } from "./models";
import { trustGate } from "./trust";

type Cls = "UP" | "DOWN" | "NEUTRAL";
const CLASSES: Cls[] = ["UP", "DOWN", "NEUTRAL"];

export function label(cur: Candle, next: Candle, atrPct: number): Cls {
  const r = (next.close - cur.close) / cur.close;
  const band = 0.1 * atrPct;
  return r > band ? "UP" : r < -band ? "DOWN" : "NEUTRAL";
}

const fit = (X: number[][], y: number[]): Model => ensemble([fitLogistic(X, y), fitGBM(X, y)]);
const norm = (p: number[]) => { const s = p.reduce((a, b) => a + b, 0) || 1; return p.map((v) => v / s); };

function ece(probs: number[][], y: number[], bins = 10) {
  let e = 0;
  for (let b = 0; b < bins; b += 1) {
    const idx = probs.map((p, i) => i).filter((i) => { const c = Math.max(...probs[i]!); return c >= b / bins && c < (b + 1) / bins; });
    if (!idx.length) continue;
    const conf = idx.reduce((s, i) => s + Math.max(...probs[i]!), 0) / idx.length;
    const acc = idx.filter((i) => probs[i]!.indexOf(Math.max(...probs[i]!)) === y[i]).length / idx.length;
    e += (idx.length / probs.length) * Math.abs(conf - acc);
  }
  return e;
}

export function runSignalEngine(candles: Candle[], opts: { k?: number; embargo?: number; minConfidence?: number } = {}) {
  const k = opts.k ?? 5, embargo = opts.embargo ?? 5;
  const fm = buildTaggedFeatures(candles);
  const rows = fm.rows.filter((r) => r.index + 1 < candles.length);
  const live = fm.rows[fm.rows.length - 1];
  const X = rows.map((r) => r.x);
  const y = rows.map((r) => CLASSES.indexOf(label(candles[r.index]!, candles[r.index + 1]!, r.atrPct)));
  const folds = purgedKFold(X.length, k, 1, embargo);
  assertNoLeakage(folds, 1, embargo);

  // Out-of-fold raw probabilities per class.
  const oof: number[][] = X.map(() => [0, 0, 0]);
  const covered = new Set<number>();
  for (const f of folds) {
    const Xt = f.train.map((i) => X[i]!);
    CLASSES.forEach((_, c) => {
      const m = fit(Xt, f.train.map((i) => (y[i] === c ? 1 : 0)));
      for (const i of f.test) oof[i]![c] = m.predict(X[i]!);
    });
    f.test.forEach((i) => covered.add(i));
  }
  const iso = CLASSES.map((_, c) => fitIsotonic(oof.map((p) => p[c]!), y.map((v) => (v === c ? 1 : 0))));
  const cal = oof.map((p) => norm(p.map((v, c) => iso[c]!(v))));
  const acc = cal.filter((p, i) => p.indexOf(Math.max(...p)) === y[i]).length / cal.length;
  const counts = CLASSES.map((_, c) => y.filter((v) => v === c).length);
  const baseline = Math.max(...counts) / y.length;
  const calEce = ece(cal, y);

  // Final models on all labelled rows; prediction for the latest closed candle.
  const finals = CLASSES.map((_, c) => fit(X, y.map((v) => (v === c ? 1 : 0))));
  const raw = live ? finals.map((m) => m.predict(live.x)) : [1 / 3, 1 / 3, 1 / 3];
  const p = norm(raw.map((v, c) => iso[c]!(v)));
  const probs = { UP: p[0]!, DOWN: p[1]!, NEUTRAL: p[2]! };

  // Regime: trend vs range by ADX, compared with the training majority.
  const regimeOf = (adx: number) => (adx >= 25 ? "TREND" : "RANGE");
  const trainTrend = rows.filter((r) => regimeOf(r.trendStrength) === "TREND").length / Math.max(1, rows.length);
  const regime = live ? regimeOf(live.trendStrength) : "UNKNOWN";
  const regimeMatches = regime === "TREND" ? trainTrend >= 0.2 : trainTrend <= 0.8;

  const gate = trustGate({ probs, oofSamples: covered.size, oofAccuracy: acc, baselineAccuracy: baseline, ece: calEce, regimeMatches, minConfidence: opts.minConfidence });
  const signal = !gate.trusted ? "NO SIGNAL" : probs.UP > probs.DOWN ? "UP" : "DOWN";
  return { signal, probs, gate, regime, oof: { samples: covered.size, accuracy: acc, baseline, ece: calEce, folds: folds.length, embargo }, features: fm.sources, targetTs: live?.ts ?? null };
}
