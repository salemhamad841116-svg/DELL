// Next Candle reliability toolkit — pure, deterministic, no I/O.
// Walk-forward with embargo, calibration metrics, uncertainty intervals, regime/session
// breakdowns, drift (PSI) and the signal gate. Nothing here alters a frozen prediction.

import type { Candle, MarketRegime } from "../types";
import { detectRegimes } from "../regime";
import { applyCalibration, buildCalibration, fitLogistic, predictProba } from "../model";
import { buildDataset, labelMove, type Direction, type IndicatorSeries } from "./core";

export const RELIABILITY_VERSION = "nc-rel-1.1.0"; // 1.1: multinomial matrix-scaling calibration
/** Rows dropped between chronological splits (labels span 1 bar; features look back ≤ ~50). */
export const EMBARGO = 5;
export const MIN_PROB_GAP = 0.1;
export const MIN_REGIME_EVIDENCE = 20;
export const MIN_EVIDENCE = 30;

export type P3 = { up: number; down: number; neutral: number };
export const DIRS: Direction[] = ["UP", "DOWN", "NEUTRAL"];
export const pick = (p: P3): Direction => (p.up >= p.down && p.up >= p.neutral ? "UP" : p.down >= p.neutral ? "DOWN" : "NEUTRAL");

/** Wilson 95% interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export type CalibReport = {
  n: number; brier: number | null; logLoss: number | null; ece: number | null;
  curve: { from: number; to: number; n: number; meanConf: number | null; observed: number | null }[];
  confusion: Record<Direction, Record<Direction, number>>;
};

/** Multiclass Brier / log loss, top-label ECE (10 bins), confusion matrix (rows = predicted). */
export function calibrationReport(items: { p: P3; actual: Direction }[]): CalibReport {
  const confusion = Object.fromEntries(DIRS.map((a) => [a, Object.fromEntries(DIRS.map((b) => [b, 0]))])) as CalibReport["confusion"];
  const bins = Array.from({ length: 10 }, (_, k) => ({ from: k / 10, to: (k + 1) / 10, n: 0, sc: 0, hit: 0 }));
  let brier = 0, ll = 0;
  for (const { p, actual } of items) {
    const pred = pick(p);
    confusion[pred][actual]++;
    const v = { UP: p.up, DOWN: p.down, NEUTRAL: p.neutral };
    for (const d of DIRS) brier += (v[d] - (d === actual ? 1 : 0)) ** 2;
    ll += -Math.log(Math.min(Math.max(v[actual], 1e-9), 1));
    const c = v[pred]; const b = bins[Math.min(Math.floor(c * 10), 9)]!;
    b.n++; b.sc += c; if (pred === actual) b.hit++;
  }
  const n = items.length;
  const ece = n ? bins.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.hit / b.n - b.sc / b.n) : 0), 0) : null;
  return {
    n, brier: n ? brier / n : null, logLoss: n ? ll / n : null, ece,
    curve: bins.map((b) => ({ from: b.from, to: b.to, n: b.n, meanConf: b.n ? b.sc / b.n : null, observed: b.n ? b.hit / b.n : null })),
    confusion,
  };
}

/** Population Stability Index between a reference sample and a current sample (10 reference-quantile bins). */
export function psi(ref: number[], cur: number[]): number | null {
  const r = ref.filter(Number.isFinite).sort((a, b) => a - b), c = cur.filter(Number.isFinite);
  if (r.length < 50 || c.length < 20) return null;
  const edges = Array.from({ length: 9 }, (_, k) => r[Math.floor(((k + 1) / 10) * (r.length - 1))]!);
  const hist = (xs: number[]) => { const h = new Array(10).fill(0); for (const x of xs) { let k = 0; while (k < 9 && x > edges[k]!) k++; h[k]++; } return h.map((v) => Math.max(v / xs.length, 1e-4)); };
  const a = hist(r), b = hist(c);
  return a.reduce((s, ai, k) => s + (b[k]! - ai) * Math.log(b[k]! / ai), 0);
}

export type Session = "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NEW_YORK" | "LATE";
/** Forex trading session of a bar open time (UTC hours). */
export function sessionOf(ts: number): Session {
  const h = new Date(ts).getUTCHours();
  if (h < 7) return "ASIA";
  if (h < 12) return "LONDON";
  if (h < 16) return "LONDON_NY_OVERLAP";
  if (h < 21) return "NEW_YORK";
  return "LATE";
}

type Rows = { X: number[][]; y: Direction[]; idx: number[] };

export const CALIBRATION_METHOD = "multinomial matrix scaling (softmax over raw UP/DOWN logits, fit on the chronological validation split only)";
const lg = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
export type MatrixScaler = { wUp: [number, number]; bUp: number; wDn: [number, number]; bDn: number };
const softmax3 = (m: MatrixScaler, s: [number, number]): P3 => {
  const zu = m.wUp[0] * s[0] + m.wUp[1] * s[1] + m.bUp, zd = m.wDn[0] * s[0] + m.wDn[1] * s[1] + m.bDn;
  const mx = Math.max(zu, zd, 0), eu = Math.exp(zu - mx), ed = Math.exp(zd - mx), en = Math.exp(-mx), t = eu + ed + en;
  return { up: eu / t, down: ed / t, neutral: en / t };
};
/** Multiclass calibration: 6-parameter softmax (NEUTRAL = reference class) by gradient descent on cross-entropy, light L2 toward identity. */
export function fitMatrixScaler(scores: [number, number][], y: Direction[], iters = 600, lr = 0.05, l2 = 1e-3): MatrixScaler {
  const m: MatrixScaler = { wUp: [1, 0], bUp: 0, wDn: [0, 1], bDn: 0 };
  const n = scores.length || 1;
  for (let it = 0; it < iters; it++) {
    const g = { wu0: 0, wu1: 0, bu: 0, wd0: 0, wd1: 0, bd: 0 };
    scores.forEach((s, k) => {
      const p = softmax3(m, s); const eu = p.up - (y[k] === "UP" ? 1 : 0), ed = p.down - (y[k] === "DOWN" ? 1 : 0);
      g.wu0 += eu * s[0]; g.wu1 += eu * s[1]; g.bu += eu; g.wd0 += ed * s[0]; g.wd1 += ed * s[1]; g.bd += ed;
    });
    m.wUp = [m.wUp[0] - lr * (g.wu0 / n + l2 * (m.wUp[0] - 1)), m.wUp[1] - lr * (g.wu1 / n + l2 * m.wUp[1])];
    m.wDn = [m.wDn[0] - lr * (g.wd0 / n + l2 * m.wDn[0]), m.wDn[1] - lr * (g.wd1 / n + l2 * (m.wDn[1] - 1))];
    m.bUp -= lr * (g.bu / n); m.bDn -= lr * (g.bd / n);
  }
  return m;
}

/** Legacy (pre-2.1) calibration: independent one-vs-rest bins, renormalised. Kept only for the before/after report. */
function legacyTri(mUp: ReturnType<typeof fitLogistic>, mDn: ReturnType<typeof fitLogistic>, X: number[][], y: Direction[], cal: number[]) {
  const yUp = cal.map((i) => (y[i] === "UP" ? 1 : 0)), yDn = cal.map((i) => (y[i] === "DOWN" ? 1 : 0));
  const cUp = buildCalibration(yUp, cal.map((i) => predictProba(mUp, X[i]!))), cDn = buildCalibration(yDn, cal.map((i) => predictProba(mDn, X[i]!)));
  return (x: number[]): P3 => {
    const u = applyCalibration(cUp, predictProba(mUp, x)), d = applyCalibration(cDn, predictProba(mDn, x));
    const ne = Math.max(0, 1 - u - d), s = u + d + ne || 1;
    return { up: u / s, down: d / s, neutral: ne / s };
  };
}

export type TriModel = { predict: (x: number[]) => P3; raw: (x: number[]) => P3; legacy: (x: number[]) => P3; mUp: ReturnType<typeof fitLogistic>; mDn: ReturnType<typeof fitLogistic>; scaler: MatrixScaler };
/** Fit one-vs-rest logits on `tr`, then a multiclass calibrator on the (later, embargoed) `cal` rows only. */
export function fitTri(X: number[][], y: Direction[], tr: number[], cal: number[]): TriModel {
  const Xt = tr.map((i) => X[i]!);
  const mUp = fitLogistic(Xt, tr.map((i) => (y[i] === "UP" ? 1 : 0))), mDn = fitLogistic(Xt, tr.map((i) => (y[i] === "DOWN" ? 1 : 0)));
  const sc = (x: number[]): [number, number] => [lg(predictProba(mUp, x)), lg(predictProba(mDn, x))];
  const scaler = fitMatrixScaler(cal.map((i) => sc(X[i]!)), cal.map((i) => y[i]!));
  const raw = (x: number[]): P3 => { const u = predictProba(mUp, x), d = predictProba(mDn, x), ne = Math.max(0, 1 - u - d), s = u + d + ne || 1; return { up: u / s, down: d / s, neutral: ne / s }; };
  return { predict: (x) => softmax3(scaler, sc(x)), raw, legacy: legacyTri(mUp, mDn, X, y, cal), mUp, mDn, scaler };
}
function trainTri(X: number[][], y: Direction[], tr: number[], cal: number[]) { return fitTri(X, y, tr, cal).predict; }

function labelled(candles: Candle[], ind: IndicatorSeries): Rows & { names: string[] } {
  const ds = buildDataset(candles, ind);
  const X: number[][] = [], y: Direction[] = [], idx: number[] = [];
  ds.idx.forEach((i, r) => { const nx = candles[i + 1]; if (!nx) return; X.push(ds.X[r]!); y.push(labelMove(candles[i]!.close, nx.close, ds.atr[i] ?? null)); idx.push(i); });
  return { X, y, idx, names: ds.names };
}

export type Baselines = { majority: number; persistence: number; prior: number };
function baselines(y: Direction[], test: number[], trainClassFreq: Record<Direction, number>, prevLabel: (i: number) => Direction | null): Baselines {
  const n = test.length || 1;
  const cnt: Record<Direction, number> = { UP: 0, DOWN: 0, NEUTRAL: 0 };
  let pers = 0;
  for (const i of test) { cnt[y[i]!]++; if (prevLabel(i) === y[i]) pers++; }
  const trainMaj = DIRS.reduce((a, b) => (trainClassFreq[b] > trainClassFreq[a] ? b : a), "UP" as Direction);
  // prior = expected accuracy of predicting randomly with training class frequencies
  const prior = DIRS.reduce((s, d) => s + trainClassFreq[d] * (cnt[d] / n), 0);
  return { majority: cnt[trainMaj] / n, persistence: pers / n, prior };
}

export type CalibSummary = { n: number; ece: number | null; brier: number | null; logLoss: number | null };
export type FoldResult = { from: string; to: string; samples: number; accuracy: number; baseline: Baselines };
export type RegimeStat = { regime: MarketRegime; n: number; accuracy: number | null; baseline: number | null; reliable: boolean | null };
export type ValidationReport = {
  version: string; embargo: number; samples: number; features: number;
  split: { train: number; validation: number; test: number; trainTo: string; validationTo: string; testTo: string };
  historicalAccuracy: number; oosAccuracy: number; oosCI: { lo: number; hi: number } | null; oosBaselines: Baselines;
  walkForward: FoldResult[]; wfMean: number; wfStd: number; wfBeatsBaseline: number;
  calibration: CalibReport; calibrationCompare?: { method: string; evaluatedOn: string; uncalibrated: CalibSummary; legacyBinned: CalibSummary; calibrated: CalibSummary; calibrationFitSplit: CalibSummary; threshold: number; scaler: MatrixScaler }; directional: { n: number; accuracy: number | null; up: { n: number; acc: number | null }; down: { n: number; acc: number | null } };
  regimes: RegimeStat[]; sessions: { session: Session; n: number; accuracy: number | null }[];
  featureRef: { name: string; values: number[] }[];
  checks: { name: string; pass: boolean; detail: string }[]; pass: boolean;
  disclaimer: string;
};

/** Full chronological validation: 60/20/20 with embargo + 5 expanding walk-forward folds (each with its own calibration slice). */
export function validateSetup(candles: Candle[], ind: IndicatorSeries, minConf = 0.55): ValidationReport | null {
  const L = labelled(candles, ind);
  const n = L.X.length;
  if (n < 400) return null;
  const iso = (r: number) => new Date(candles[L.idx[Math.min(r, n - 1)]!]!.ts).toISOString().slice(0, 16);
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const freq = (ix: number[]) => { const f: Record<Direction, number> = { UP: 0, DOWN: 0, NEUTRAL: 0 }; ix.forEach((i) => f[L.y[i]!]++); const s = ix.length || 1; DIRS.forEach((d) => (f[d] /= s)); return f; };
  const prev = (i: number) => (i > 0 ? L.y[i - 1]! : null);
  const regimes = detectRegimes(candles).regimes;

  const tEnd = Math.floor(n * 0.6), vEnd = Math.floor(n * 0.8);
  const tr = range(0, tEnd - EMBARGO), cal = range(tEnd, vEnd - EMBARGO), te = range(vEnd, n);
  const tm = fitTri(L.X, L.y, tr, cal); const tri = tm.predict;
  const preds = te.map((i) => ({ i, p: tri(L.X[i]!), actual: L.y[i]! }));
  const hits = preds.filter((x) => pick(x.p) === x.actual).length;
  const histHits = tr.filter((i) => pick(tri(L.X[i]!)) === L.y[i]).length;
  const oosB = baselines(L.y, te, freq(tr), prev);

  // Walk-forward: expanding train, 5 sequential test blocks over the last 50% of rows.
  const folds: FoldResult[] = [];
  const start = Math.floor(n * 0.5), block = Math.floor((n - start) / 5);
  for (let f = 0; f < 5; f++) {
    const a = start + f * block, b = f === 4 ? n : a + block;
    const calA = Math.floor(a * 0.8);
    const ftr = range(0, calA - EMBARGO), fcal = range(calA, a - EMBARGO), fte = range(a, b);
    if (ftr.length < 150 || fcal.length < 40 || !fte.length) continue;
    const ft = trainTri(L.X, L.y, ftr, fcal);
    const acc = fte.filter((i) => pick(ft(L.X[i]!)) === L.y[i]).length / fte.length;
    folds.push({ from: iso(a), to: iso(b - 1), samples: fte.length, accuracy: acc, baseline: baselines(L.y, fte, freq(ftr), prev) });
  }
  const wfMean = folds.reduce((s, f) => s + f.accuracy, 0) / (folds.length || 1);
  const wfStd = Math.sqrt(folds.reduce((s, f) => s + (f.accuracy - wfMean) ** 2, 0) / (folds.length || 1));
  const beats = folds.filter((f) => f.accuracy > Math.max(f.baseline.majority, f.baseline.persistence)).length;

  // Directional (gated) accuracy on OOS, same rule as production: winner UP/DOWN with conf ≥ minConf and gap ≥ MIN_PROB_GAP.
  const dirCalls = preds.filter(({ p }) => { const d = pick(p); return d !== "NEUTRAL" && Math.max(p.up, p.down) >= minConf && Math.abs(p.up - p.down) >= MIN_PROB_GAP; });
  const dAcc = (d?: Direction) => { const s = dirCalls.filter((x) => !d || pick(x.p) === d); return { n: s.length, acc: s.length ? s.filter((x) => pick(x.p) === x.actual).length / s.length : null }; };
  const all = dAcc();

  const regimeStats: RegimeStat[] = (["TRENDING_UP", "TRENDING_DOWN", "RANGE", "HIGH_VOLATILITY", "LOW_VOLATILITY", "BREAKOUT", "UNCERTAIN"] as MarketRegime[]).map((rg) => {
    const s = preds.filter((x) => regimes[L.idx[x.i]!] === rg);
    if (!s.length) return { regime: rg, n: 0, accuracy: null, baseline: null, reliable: null };
    const acc = s.filter((x) => pick(x.p) === x.actual).length / s.length;
    const b = baselines(L.y, s.map((x) => x.i), freq(tr), prev);
    const base = Math.max(b.majority, b.persistence);
    return { regime: rg, n: s.length, accuracy: acc, baseline: base, reliable: s.length >= MIN_REGIME_EVIDENCE ? acc >= base : null };
  });
  const sessions = (["ASIA", "LONDON", "LONDON_NY_OVERLAP", "NEW_YORK", "LATE"] as Session[]).map((ss) => {
    const s = preds.filter((x) => sessionOf(candles[L.idx[x.i]! + 1]!.ts) === ss);
    return { session: ss, n: s.length, accuracy: s.length ? s.filter((x) => pick(x.p) === x.actual).length / s.length : null };
  });
  const calib = calibrationReport(preds);
  const summ = (c: CalibReport) => ({ n: c.n, ece: c.ece, brier: c.brier, logLoss: c.logLoss });
  const calibrationCompare = {
    method: CALIBRATION_METHOD, evaluatedOn: "independent chronological test split (never used for fitting or calibration)",
    uncalibrated: summ(calibrationReport(te.map((i) => ({ p: tm.raw(L.X[i]!), actual: L.y[i]! })))),
    legacyBinned: summ(calibrationReport(te.map((i) => ({ p: tm.legacy(L.X[i]!), actual: L.y[i]! })))),
    calibrated: summ(calib),
    calibrationFitSplit: summ(calibrationReport(cal.map((i) => ({ p: tri(L.X[i]!), actual: L.y[i]! })))),
    threshold: 0.1, scaler: tm.scaler,
  };
  const bestBase = Math.max(oosB.majority, oosB.persistence, oosB.prior);
  const oosAcc = hits / (te.length || 1);
  const checks = [
    { name: "Out-of-sample beats best baseline", pass: oosAcc > bestBase, detail: `${(oosAcc * 100).toFixed(1)}% vs ${(bestBase * 100).toFixed(1)}%` },
    { name: "Walk-forward: ≥3 of folds beat baseline", pass: beats >= 3, detail: `${beats}/${folds.length}` },
    { name: "Walk-forward stable (std ≤ 8pp)", pass: wfStd <= 0.08, detail: `std ${(wfStd * 100).toFixed(1)}pp` },
    { name: "Calibration ECE ≤ 0.10", pass: (calib.ece ?? 1) <= 0.1, detail: `ECE ${calib.ece?.toFixed(3)}` },
    { name: "Embargoed chronological splits", pass: true, detail: `embargo ${EMBARGO} rows; scaler fit on train only` },
  ];
  // Reference distributions for drift: top-variance features on the training rows.
  const featureRef = L.names.map((name, j) => ({ name, values: tr.filter((_, k) => k % Math.max(1, Math.floor(tr.length / 300)) === 0).map((i) => L.X[i]![j]!) }))
    .filter((f) => new Set(f.values).size > 5).slice(0, 12);
  return {
    version: RELIABILITY_VERSION, embargo: EMBARGO, samples: n, features: L.names.length,
    split: { train: tr.length, validation: cal.length, test: te.length, trainTo: iso(tEnd - EMBARGO - 1), validationTo: iso(vEnd - EMBARGO - 1), testTo: iso(n - 1) },
    historicalAccuracy: histHits / (tr.length || 1), oosAccuracy: oosAcc, oosCI: wilson(hits, te.length), oosBaselines: oosB,
    walkForward: folds, wfMean, wfStd, wfBeatsBaseline: beats,
    calibration: calib, calibrationCompare, directional: { n: all.n, accuracy: all.acc, up: dAcc("UP"), down: dAcc("DOWN") },
    regimes: regimeStats, sessions, featureRef, checks, pass: checks.every((c) => c.pass),
    disclaimer: "Historical and out-of-sample results describe the past only. They are not a guarantee of future accuracy.",
  };
}

export type GateCheck = { name: string; pass: boolean; detail: string };
export type GateInput = {
  p: P3; minConf: number; sampleSize: number; minSamples: number; dataQuality: "HIGH" | "MEDIUM" | "LOW";
  regime: MarketRegime; model: { status: string | null; report: Pick<ValidationReport, "wfStd" | "wfBeatsBaseline" | "regimes" | "pass"> | null };
};

/** Every check must pass for a directional call; otherwise NO SIGNAL — INSUFFICIENT CONFIDENCE. */
export function signalGate(g: GateInput): { signal: Direction | "LOW_CONFIDENCE"; checks: GateCheck[]; reason: string | null } {
  const d = pick(g.p);
  const conf = Math.max(g.p.up, g.p.down, g.p.neutral);
  const rg = g.model.report?.regimes.find((r) => r.regime === g.regime);
  const checks: GateCheck[] = [
    { name: "Calibrated confidence ≥ threshold", pass: d === "NEUTRAL" || (d === "UP" ? g.p.up : g.p.down) >= g.minConf, detail: `${(conf * 100).toFixed(1)}% vs ${(g.minConf * 100).toFixed(0)}%` },
    { name: "UP/DOWN separation ≥ 10pp", pass: d === "NEUTRAL" || Math.abs(g.p.up - g.p.down) >= MIN_PROB_GAP, detail: `${(Math.abs(g.p.up - g.p.down) * 100).toFixed(1)}pp` },
    { name: "Historical sample strength", pass: g.sampleSize >= g.minSamples, detail: `${g.sampleSize} ≥ ${g.minSamples}` },
    { name: "Data quality", pass: g.dataQuality !== "LOW", detail: g.dataQuality },
    { name: "Model verified & healthy", pass: g.model.status === "VERIFIED", detail: g.model.status ?? "no validated model" },
    { name: "Model uncertainty (walk-forward stable)", pass: !!g.model.report && g.model.report.wfStd <= 0.08 && g.model.report.wfBeatsBaseline >= 3, detail: g.model.report ? `std ${(g.model.report.wfStd * 100).toFixed(1)}pp · ${g.model.report.wfBeatsBaseline} folds > baseline` : "n/a" },
    { name: "Regime compatibility", pass: !rg || rg.reliable !== false, detail: rg ? `${g.regime}: ${rg.accuracy !== null ? (rg.accuracy * 100).toFixed(1) : "-"}% vs ${rg.baseline !== null ? (rg.baseline * 100).toFixed(1) : "-"}% (n=${rg.n}${rg.reliable === null ? ", insufficient evidence" : ""})` : `${g.regime}: not seen in test` },
  ];
  if (d === "NEUTRAL") return { signal: "NEUTRAL", checks, reason: null };
  const failed = checks.filter((c) => !c.pass);
  return failed.length ? { signal: "LOW_CONFIDENCE", checks, reason: `NO SIGNAL — INSUFFICIENT CONFIDENCE: ${failed.map((c) => c.name).join("; ")}` } : { signal: d, checks, reason: null };
}

export type ScoredRow = { signal: string | null; direction: string; actual_result: string | null; correct: boolean | null; evaluation_status: string; target_ts: string; bullish_probability: number; bearish_probability: number; neutral_probability: number; market_regime: string | null };

/** Live forward stats from frozen ledger rows only. NEUTRAL / NO SIGNAL never enter directional accuracy. */
export function forwardStats(rows: ScoredRow[]) {
  const ev = rows.filter((r) => r.evaluation_status === "evaluated" && r.actual_result);
  const sig = (r: ScoredRow) => r.signal ?? r.direction;
  const dir = ev.filter((r) => sig(r) === "UP" || sig(r) === "DOWN");
  const acc = (s: ScoredRow[]) => { const k = s.filter((r) => r.correct).length; return { n: s.length, correct: k, accuracy: s.length ? k / s.length : null, ci: wilson(k, s.length), evidence: s.length >= MIN_EVIDENCE ? "OK" : "INSUFFICIENT_EVIDENCE" }; };
  const sorted = [...dir].sort((a, b) => Date.parse(b.target_ts) - Date.parse(a.target_ts));
  const actualUp = dir.filter((r) => r.actual_result === "UP").length, actualDn = dir.filter((r) => r.actual_result === "DOWN").length;
  const baseline = dir.length ? Math.max(actualUp, actualDn) / dir.length : null;
  const calib = calibrationReport(ev.map((r) => ({ p: { up: r.bullish_probability, down: r.bearish_probability, neutral: r.neutral_probability }, actual: r.actual_result as Direction })));
  const group = <K extends string>(key: (r: ScoredRow) => K) => { const m = new Map<K, ScoredRow[]>(); dir.forEach((r) => m.set(key(r), [...(m.get(key(r)) ?? []), r])); return [...m.entries()].map(([k, s]) => ({ key: k, ...acc(s) })).sort((a, b) => (a.key < b.key ? 1 : -1)); };
  const wk = (ts: string) => { const d = new Date(ts); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const all = acc(dir);
  // Degraded = enough evidence and even the upper 95% bound is below the naive directional baseline.
  const degraded = dir.length >= 50 && baseline !== null && (all.ci?.hi ?? 1) < baseline;
  return {
    total: rows.length, evaluated: ev.length, pending: rows.filter((r) => r.evaluation_status === "pending").length,
    noSignal: rows.filter((r) => sig(r) === "LOW_CONFIDENCE").length, neutral: rows.filter((r) => sig(r) === "NEUTRAL").length,
    coverage: rows.length ? rows.filter((r) => sig(r) === "UP" || sig(r) === "DOWN").length / rows.length : null,
    directional: all, last100: acc(sorted.slice(0, 100)), last500: acc(sorted.slice(0, 500)),
    up: acc(dir.filter((r) => sig(r) === "UP")), down: acc(dir.filter((r) => sig(r) === "DOWN")),
    baseline, calibration: calib, degraded,
    distribution: { UP: rows.filter((r) => sig(r) === "UP").length, DOWN: rows.filter((r) => sig(r) === "DOWN").length, NEUTRAL: rows.filter((r) => sig(r) === "NEUTRAL").length, NO_SIGNAL: rows.filter((r) => sig(r) === "LOW_CONFIDENCE").length },
    daily: group((r) => r.target_ts.slice(0, 10)).slice(0, 31), weekly: group((r) => wk(r.target_ts)).slice(0, 12), monthly: group((r) => r.target_ts.slice(0, 7)).slice(0, 12),
    sessions: group((r) => sessionOf(Date.parse(r.target_ts))), regimes: group((r) => (r.market_regime ?? "UNCERTAIN") as string),
  };
}

/* ---------------- Shadow forecasts (unapproved model, experimental) ---------------- */
// Shadow = what the model WOULD call if it were approved. Same frozen row, same pre-close timing,
// same gate except the two model-approval checks. Never shown as a user-facing signal and never
// mixed into approved live accuracy.
const APPROVAL_CHECKS = new Set(["Model verified & healthy", "Model uncertainty (walk-forward stable)"]);
export function shadowGate(g: GateInput): { signal: Direction | "LOW_CONFIDENCE"; failed: string[] } {
  const r = signalGate(g);
  const failed = r.checks.filter((c) => !c.pass && !APPROVAL_CHECKS.has(c.name)).map((c) => c.name);
  const d = pick(g.p);
  return { signal: d === "NEUTRAL" ? "NEUTRAL" : failed.length ? "LOW_CONFIDENCE" : d, failed };
}

export type ShadowRow = ScoredRow & { gate: { shadow?: { signal: string } } | null };
export const SHADOW_REQUIRED = 300;
/** Shadow stats from frozen rows only (shadow signal was written at prediction time, before target open). */
export function shadowStats(rows: ShadowRow[]) {
  const sh = rows.filter((r) => r.gate?.shadow?.signal);
  const s = (r: ShadowRow) => r.gate!.shadow!.signal;
  const ev = sh.filter((r) => r.evaluation_status === "evaluated" && r.actual_result);
  const dir = ev.filter((r) => s(r) === "UP" || s(r) === "DOWN");
  const k = dir.filter((r) => s(r) === r.actual_result).length;
  const up = dir.filter((r) => r.actual_result === "UP").length, dn = dir.filter((r) => r.actual_result === "DOWN").length;
  const baseline = dir.length ? Math.max(up, dn) / dir.length : null;
  const ci = wilson(k, dir.length);
  const calib = calibrationReport(ev.map((r) => ({ p: { up: r.bullish_probability, down: r.bearish_probability, neutral: r.neutral_probability }, actual: r.actual_result as Direction })));
  const sub = (d: string) => { const x = dir.filter((r) => s(r) === d); const c = x.filter((r) => s(r) === r.actual_result).length; return { n: x.length, accuracy: x.length ? c / x.length : null, ci: wilson(c, x.length) }; };
  return {
    total: sh.length, evaluated: ev.length, pending: sh.filter((r) => r.evaluation_status === "pending").length,
    directional: { n: dir.length, correct: k, accuracy: dir.length ? k / dir.length : null, ci }, up: sub("UP"), down: sub("DOWN"),
    coverage: sh.length ? sh.filter((r) => s(r) === "UP" || s(r) === "DOWN").length / sh.length : null,
    noSignal: sh.filter((r) => s(r) === "LOW_CONFIDENCE").length, neutral: sh.filter((r) => s(r) === "NEUTRAL").length,
    baseline, calibration: calib,
    degraded: dir.length >= 50 && baseline !== null && (ci?.hi ?? 1) < baseline,
    required: SHADOW_REQUIRED,
    pass: dir.length >= SHADOW_REQUIRED && baseline !== null && (ci?.lo ?? 0) > baseline && (calib.ece ?? 1) <= 0.1,
  };
}
