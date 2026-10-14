// TradingView Pine Code Generator — pure, deterministic, no I/O.
// Produces a complete indicator() script: the original indicator source (unchanged) +
// a Next Candle Forecast block whose model coefficients are frozen at generation time.
// Every feature below has an exact TS reference implementation mirroring Pine's
// ta.rma / ta.atr / ta.rsi / ta.ema seeding, so the Pine output reproduces the trained model.
// Never generates strategy() / orders: indicator & forecast mode needs no BUY/SELL/TP/SL.
import { fitLogistic, predictProba, type LogitModel } from "../model";
import type { Candle } from "../types";
import type { IndicatorSeries } from "../forecast/core";
import { calibrationReport, fitMatrixScaler, CALIBRATION_METHOD, type MatrixScaler } from "../forecast/reliability";

export const PINE_GEN_MODEL_VERSION = "nc-pine-logit-2.0.0" // 2.0: relative-only features, multiclass calibration, missing-input + symbol/timeframe lock;
export const PINE_NEUTRAL_ATR_K = 0.1;
const MAX_IND_FEATURES = 8;

// ---------- Pine-exact reference series ----------
function rma(src: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = []; let prev: number | null = null; const seed: number[] = [];
  for (const v of src) {
    if (v == null || !Number.isFinite(v)) { out.push(prev == null ? null : prev); continue; }
    if (prev == null) { seed.push(v); if (seed.length === n) prev = seed.reduce((a, b) => a + b, 0) / n; out.push(prev); continue; }
    prev = (v + (n - 1) * prev) / n; out.push(prev);
  }
  return out;
}
function emaP(src: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []; let prev: number | null = null; const a = 2 / (n + 1);
  src.forEach((v, i) => {
    if (prev == null) { if (i + 1 >= n) prev = src.slice(i + 1 - n, i + 1).reduce((x, y) => x + y, 0) / n; out.push(prev); return; }
    prev = a * v + (1 - a) * prev; out.push(prev);
  });
  return out;
}
export function pineAtr(c: Candle[], n = 14) {
  return rma(c.map((k, i) => (i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1]!.close), Math.abs(k.low - c[i - 1]!.close)))), n);
}
export function pineRsi(c: Candle[], n = 14) {
  const ch = c.map((k, i) => (i === 0 ? null : k.close - c[i - 1]!.close));
  const up = rma(ch.map((d) => (d == null ? null : Math.max(d, 0))), n);
  const dn = rma(ch.map((d) => (d == null ? null : Math.max(-d, 0))), n);
  return up.map((u, i) => { const d = dn[i]; if (u == null || d == null) return null; return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); });
}

export type PineFeature = { name: string; pine: string; source: "MARKET" | "INDICATOR" };
export const MARKET_FEATURES: PineFeature[] = [
  { name: "ret1", pine: "(close - close[1]) / close[1]", source: "MARKET" },
  { name: "ret3", pine: "close / close[3] - 1", source: "MARKET" },
  { name: "body_atr", pine: "(close - open) / nc_atr", source: "MARKET" },
  { name: "upper_wick_atr", pine: "(high - math.max(open, close)) / nc_atr", source: "MARKET" },
  { name: "lower_wick_atr", pine: "(math.min(open, close) - low) / nc_atr", source: "MARKET" },
  { name: "range_atr", pine: "(high - low) / nc_atr", source: "MARKET" },
  { name: "rsi14", pine: "nc_rsi / 100", source: "MARKET" },
  { name: "ema20_dist_atr", pine: "(close - nc_ema) / nc_atr", source: "MARKET" },
  { name: "atr_pct", pine: "nc_atr / close", source: "MARKET" },
];

export type ExcludedFeature = { name: string; reason: string };
export type PineDataset = { features: PineFeature[]; X: number[][]; idx: number[]; atr: (number | null)[]; excluded: ExcludedFeature[]; missingRows: number };
export type DatasetOptions = { /** false = legacy raw features (only for the before/after comparison). */ relativeOnly?: boolean };

/** Classify an indicator column: absolute epoch time, absolute bar index, monotone counter, price level, or plain value. */
function classify(col: number[], c: Candle[]): "TIME" | "BAR" | "COUNTER" | "LEVEL" | "VALUE" {
  const fin: { v: number; i: number }[] = []; col.forEach((v, i) => { if (Number.isFinite(v)) fin.push({ v, i }); });
  if (!fin.length) return "VALUE";
  const sorted = fin.map((f) => f.v).sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)]!;
  if (med > 1e11) return "TIME"; // epoch milliseconds
  const ints = fin.every((f) => Number.isInteger(f.v));
  const mono = fin.every((f, k) => k === 0 || f.v >= fin[k - 1]!.v);
  if (ints && mono && sorted[sorted.length - 1]! - sorted[0]! > 20) return fin.every((f) => f.v >= 0 && f.v <= f.i) ? "BAR" : "COUNTER";
  let hits = 0; fin.forEach((f) => { if (Math.abs(f.v / c[f.i]!.close - 1) < 0.2) hits++; });
  return hits / fin.length > 0.8 ? "LEVEL" : "VALUE";
}

/** Row per bar using only bars ≤ i. Rows with any missing (na) input are excluded from training; Pine shows NO SIGNAL — MISSING INPUT. */
export function pineDataset(c: Candle[], ind: IndicatorSeries, opts: DatasetOptions = {}): PineDataset {
  const relativeOnly = opts.relativeOnly ?? true;
  const a = pineAtr(c); const r = pineRsi(c); const e = emaP(c.map((k) => k.close), 20);
  const feats = [...MARKET_FEATURES];
  const cols: ((i: number) => number)[] = [
    (i) => (c[i]!.close - c[i - 1]!.close) / c[i - 1]!.close,
    (i) => c[i]!.close / c[i - 3]!.close - 1,
    (i) => (c[i]!.close - c[i]!.open) / a[i]!,
    (i) => (c[i]!.high - Math.max(c[i]!.open, c[i]!.close)) / a[i]!,
    (i) => (Math.min(c[i]!.open, c[i]!.close) - c[i]!.low) / a[i]!,
    (i) => (c[i]!.high - c[i]!.low) / a[i]!,
    (i) => r[i]! / 100,
    (i) => (c[i]!.close - e[i]!) / a[i]!,
    (i) => a[i]! / c[i]!.close,
  ];
  const excluded: ExcludedFeature[] = [];
  const safeName = (n: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
  let added = 0;
  ind.names.forEach((name, k) => {
    if (added >= MAX_IND_FEATURES || !safeName(name) || name.startsWith("nc_")) return;
    const col = ind.values[k]!;
    const fin = col.filter(Number.isFinite);
    if (fin.length < c.length * 0.5) { excluded.push({ name, reason: "mostly na" }); return; }
    if (fin.every((v) => v === 0 || v === 1)) return; // boolean-like: no implicit number cast in Pine
    const kind = classify(col, c);
    let f: PineFeature; let fn: (i: number) => number;
    if (!relativeOnly) {
      const level = kind === "LEVEL";
      f = { name: level ? `${name}_dist_atr` : name, pine: level ? `(close - ${name}) / nc_atr` : `${name}`, source: "INDICATOR" };
      fn = level ? (i) => (c[i]!.close - col[i]!) / a[i]! : (i) => col[i]!;
    } else if (kind === "TIME") {
      f = { name: `${name}_min_since`, pine: `(time - ${name}) / 60000`, source: "INDICATOR" };
      fn = (i) => (c[i]!.ts - col[i]!) / 60000;
      excluded.push({ name, reason: "absolute time → replaced by minutes since" });
    } else if (kind === "BAR") {
      f = { name: `${name}_bars_since`, pine: `bar_index - ${name}`, source: "INDICATOR" };
      fn = (i) => i - col[i]!;
      excluded.push({ name, reason: "absolute bar index → replaced by bars since" });
    } else if (kind === "COUNTER") {
      excluded.push({ name, reason: "absolute monotone counter — not a valid predictive feature" }); return;
    } else if (kind === "LEVEL") {
      f = { name: `${name}_dist_atr`, pine: `(close - ${name}) / nc_atr`, source: "INDICATOR" }; fn = (i) => (c[i]!.close - col[i]!) / a[i]!;
    } else { f = { name, pine: `${name}`, source: "INDICATOR" }; fn = (i) => col[i]!; }
    // Constant after transform (e.g. evaluatedBar → bars since = 0): carries no information.
    const vals = c.map((_, i) => (i > 0 ? fn(i) : NaN)).filter(Number.isFinite);
    if (vals.length && Math.max(...vals) - Math.min(...vals) < 1e-12) { excluded.push({ name: f.name, reason: "constant after transform" }); return; }
    feats.push(f); cols.push(fn); added++;
  });
  const X: number[][] = []; const idx: number[] = []; let missingRows = 0;
  for (let i = 3; i < c.length; i++) {
    if (a[i] == null || r[i] == null || e[i] == null || !a[i]) continue;
    const row = cols.map((f) => f(i));
    if (row.every(Number.isFinite)) { X.push(row); idx.push(i); } else missingRows++;
  }
  return { features: feats, X, idx, atr: a, excluded, missingRows };
}

export const PINE_EMBARGO = 5;
export const PINE_ECE_LIMIT = 0.1;
export type PineCalib = { n: number; ece: number | null; brier: number | null; logLoss: number | null };
export type PineModel = {
  up: LogitModel; down: LogitModel; scaler: MatrixScaler | null; features: PineFeature[]; excluded: ExcludedFeature[];
  trainSamples: number; calibrationSamples: number; missingRows: number;
  oos: { samples: number; accuracy: number; baseline: number };
  calibration: { method: string; raw: PineCalib; calibrated: PineCalib; limit: number; pass: boolean };
};

type Dir = "UP" | "DOWN" | "NEUTRAL";
const lgt = (p: number) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
function rawTri(m: { up: LogitModel; down: LogitModel }, x: number[]) {
  const u = predictProba(m.up, x), d = predictProba(m.down, x); const ne = Math.max(0, 1 - u - d); const s = u + d + ne || 1;
  return { up: u / s, down: d / s, neutral: ne / s };
}
/** Calibrated 3-class probabilities (softmax matrix scaling over the UP/DOWN logits) — same formula as the generated Pine. */
export function triProb(m: { up: LogitModel; down: LogitModel; scaler?: MatrixScaler | null }, x: number[]) {
  if (!m.scaler) return rawTri(m, x);
  const s0 = lgt(predictProba(m.up, x)), s1 = lgt(predictProba(m.down, x)), k = m.scaler;
  const zu = k.wUp[0] * s0 + k.wUp[1] * s1 + k.bUp, zd = k.wDn[0] * s0 + k.wDn[1] * s1 + k.bDn;
  const mx = Math.max(zu, zd, 0), eu = Math.exp(zu - mx), ed = Math.exp(zd - mx), en = Math.exp(-mx), t = eu + ed + en;
  return { up: eu / t, down: ed / t, neutral: en / t };
}
const pick = (p: { up: number; down: number; neutral: number }): Dir => (p.up >= p.down && p.up >= p.neutral ? "UP" : p.down >= p.neutral ? "DOWN" : "NEUTRAL");
const summ = (items: { p: { up: number; down: number; neutral: number }; actual: Dir }[]): PineCalib => { const r = calibrationReport(items); return { n: r.n, ece: r.ece, brier: r.brier, logLoss: r.logLoss }; };

/** Chronological 60 / 20 / 20 with embargo: logits fit on train, multiclass calibration on validation only, untouched test for OOS + ECE. */
export function trainPineModel(c: Candle[], ind: IndicatorSeries, minSamples = 200, opts: DatasetOptions = {}): PineModel | null {
  const ds = pineDataset(c, ind, opts);
  const X: number[][] = []; const y: Dir[] = [];
  ds.idx.forEach((i, r) => {
    const n = c[i + 1]; if (!n) return;
    const d = n.close - c[i]!.close; const thr = (ds.atr[i] ?? 0) * PINE_NEUTRAL_ATR_K;
    X.push(ds.X[r]!); y.push(Math.abs(d) <= thr || d === 0 ? "NEUTRAL" : d > 0 ? "UP" : "DOWN");
  });
  if (X.length < minSamples) return null;
  const tEnd = Math.floor(X.length * 0.6), vEnd = Math.floor(X.length * 0.8);
  const trX = X.slice(0, tEnd - PINE_EMBARGO), trY = y.slice(0, tEnd - PINE_EMBARGO);
  const up = fitLogistic(trX, trY.map((l) => (l === "UP" ? 1 : 0)));
  const down = fitLogistic(trX, trY.map((l) => (l === "DOWN" ? 1 : 0)));
  const calIdx = Array.from({ length: Math.max(0, vEnd - PINE_EMBARGO - tEnd) }, (_, k) => tEnd + k);
  const scaler = fitMatrixScaler(calIdx.map((i) => [lgt(predictProba(up, X[i]!)), lgt(predictProba(down, X[i]!))] as [number, number]), calIdx.map((i) => y[i]!));
  const m = { up, down, scaler };
  let hit = 0; const cnt: Record<Dir, number> = { UP: 0, DOWN: 0, NEUTRAL: 0 };
  const rawItems: { p: ReturnType<typeof rawTri>; actual: Dir }[] = [], calItems: typeof rawItems = [];
  for (let i = vEnd; i < X.length; i++) {
    const p = triProb(m, X[i]!); if (pick(p) === y[i]) hit++; cnt[y[i]!]++;
    calItems.push({ p, actual: y[i]! }); rawItems.push({ p: rawTri(m, X[i]!), actual: y[i]! });
  }
  const n = X.length - vEnd;
  const calibrated = summ(calItems);
  return {
    up, down, scaler, features: ds.features, excluded: ds.excluded, trainSamples: trX.length, calibrationSamples: calIdx.length, missingRows: ds.missingRows,
    oos: { samples: n, accuracy: n ? hit / n : 0, baseline: n ? Math.max(cnt.UP, cnt.DOWN, cnt.NEUTRAL) / n : 0 },
    calibration: { method: CALIBRATION_METHOD, raw: summ(rawItems), calibrated, limit: PINE_ECE_LIMIT, pass: calibrated.ece != null && calibrated.ece <= PINE_ECE_LIMIT && n >= 100 },
  };
}

/** TradingView syminfo.ticker / timeframe.period equivalents for the lock. */
export function tvLock(symbol: string, timeframe: string) {
  const ticker = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const m = /^(\d+)([mhdwM])$/.exec(timeframe);
  const period = !m ? timeframe : m[2] === "m" ? m[1]! : m[2] === "h" ? String(+m[1]! * 60) : (m[1] === "1" ? "" : m[1]!) + ({ d: "D", w: "W", M: "M" } as Record<string, string>)[m[2]!]!;
  return { ticker, period, label: `${ticker} ${timeframe}` };
}

// ---------- Source handling ----------
/** Split source into version, declaration statement (balanced parens, may span lines) and body. */
export function splitPineSource(code: string): { version: number; declaration: string | null; body: string } {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  let version = 6;
  const vi = lines.findIndex((l) => /^\s*\/\/\s*@version\s*=\s*(\d+)/.test(l));
  if (vi >= 0) { version = +lines[vi]!.match(/(\d+)/)![1]!; lines.splice(vi, 1); }
  const text = lines.join("\n");
  const m = /^[ \t]*indicator\s*\(/m.exec(text);
  if (!m) return { version, declaration: null, body: text };
  let depth = 0; let j = m.index + m[0].length - 1; let inStr: string | null = null;
  for (; j < text.length; j++) {
    const ch = text[j]!;
    if (inStr) { if (ch === "\\") j++; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") inStr = ch; else if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) break; }
  }
  return { version, declaration: text.slice(m.index, j + 1).trim(), body: (text.slice(0, m.index) + text.slice(j + 1)).replace(/^\n+/, "") };
}

const num = (v: number) => (Number.isFinite(v) ? (Math.abs(v) < 1e-12 ? "0.0" : Number(v.toPrecision(12)).toString().replace(/^(-?\d+)$/, "$1.0")) : "0.0");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export type PineGenMeta = {
  name: string; sourceHash: string | null; sourceVersion: number | null; symbol: string; timeframe: string;
  trainedFrom: string; trainedTo: string; minConfidence: number; alerts: boolean;
};

function zExpr(m: LogitModel, fs: PineFeature[]) {
  const terms = fs.map((_, j) => `${num(m.weights[j] ?? 0)} * ((nc_x${j} - ${num(m.standardizer.mean[j] ?? 0)}) / ${num(m.standardizer.std[j] ?? 1)})`);
  return [num(m.bias), ...terms].join(" +\n     ");
}

export function generatePine(source: string | null, model: PineModel, meta: PineGenMeta): string {
  const src = source ? splitPineSource(source) : { version: 6, declaration: null, body: "" };
  const version = src.version >= 5 ? src.version : 6;
  const out: string[] = [];
  out.push(`//@version=${version}`);
  out.push(`// Generated by Market Compass — TradingView Pine Code Generator`);
  out.push(`// Script type: INDICATOR · Mode: NEXT CANDLE FORECAST · Model: ${PINE_GEN_MODEL_VERSION}`);
  out.push(`// Source: ${meta.name}${meta.sourceVersion != null ? ` v${meta.sourceVersion}` : ""} · SHA-256 ${meta.sourceHash ?? "none (market features only)"}`);
  out.push(`// Trained: ${meta.symbol} ${meta.timeframe} · ${meta.trainedFrom} → ${meta.trainedTo} UTC · train ${model.trainSamples} · OOS ${model.oos.samples} (acc ${(model.oos.accuracy * 100).toFixed(1)}% vs baseline ${(model.oos.baseline * 100).toFixed(1)}%)`);
  out.push(`// Frozen: computed only on confirmed (closed) bars for the NEXT bar · Lookahead OFF (no request.security) · Repaint NO`);
  out.push(`// MODEL TRAINED FOR ${tvLock(meta.symbol, meta.timeframe).label} — forecast is disabled on any other symbol/timeframe.`);
  out.push(`// Calibration: ${CALIBRATION_METHOD} · OOS ECE ${model.calibration.calibrated.ece?.toFixed(3) ?? "n/a"} (raw ${model.calibration.raw.ece?.toFixed(3) ?? "n/a"}, limit ${PINE_ECE_LIMIT}) → ${model.calibration.pass ? "PASS" : "FAIL — probabilities hidden, NO SIGNAL"}`);
  if (model.excluded.length) out.push(`// Excluded/replaced inputs: ${model.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}`);
  out.push(`// Historical/OOS only — not a guarantee. FUTURE FORECAST RELIABILITY = NOT VERIFIED until forward-tested.`);
  out.push(src.declaration ?? `indicator("${esc(meta.name)} — Next Candle Forecast", overlay=true)`);
  if (src.body.trim()) { out.push("", "// ===== Original indicator source (unchanged) ====="); out.push(src.body.trimEnd()); }
  out.push("", "// ===== Next Candle Forecast (Market Compass) =====");
  out.push(`nc_minConf = input.float(${(meta.minConfidence * 100).toFixed(1)}, "Minimum Signal Confidence %", minval=0, maxval=100) / 100`);
  out.push("nc_atr = ta.atr(14)", "nc_rsi = ta.rsi(close, 14)", "nc_ema = ta.ema(close, 20)");
  model.features.forEach((f, j) => out.push(`nc_x${j} = ${f.pine} // ${f.name}`));
  const lock = tvLock(meta.symbol, meta.timeframe);
  const ready = model.features.map((_, j) => `not na(nc_x${j})`).join(" and ");
  const sc = model.scaler ?? { wUp: [1, 0], bUp: 0, wDn: [0, 1], bDn: 0 };
  out.push(`nc_zUp = ${zExpr(model.up, model.features)}`);
  out.push(`nc_zDn = ${zExpr(model.down, model.features)}`);
  out.push(
    "// Model inputs: missing (na) values are never propagated — the forecast shows NO SIGNAL — MISSING INPUT.",
    `nc_ready = ${ready}`,
    `// Symbol / timeframe lock: coefficients were trained for ${lock.label} only.`,
    `nc_lockOk = (syminfo.ticker == "${lock.ticker}" or syminfo.ticker == "${esc(meta.symbol)}") and (timeframe.period == "${lock.period}" or timeframe.period == "${meta.timeframe}")`,
    `nc_calibrated = ${model.calibration.pass ? "true" : "false"} // OOS ECE ${model.calibration.calibrated.ece?.toFixed(3) ?? "n/a"} vs limit ${PINE_ECE_LIMIT}`,
    "nc_pUp = 1 / (1 + math.exp(-math.max(-30, math.min(30, nc_zUp))))",
    "nc_pDn = 1 / (1 + math.exp(-math.max(-30, math.min(30, nc_zDn))))",
    "nc_qUp = math.min(math.max(nc_pUp, 0.000001), 0.999999)",
    "nc_qDn = math.min(math.max(nc_pDn, 0.000001), 0.999999)",
    "nc_sUp = math.log(nc_qUp / (1 - nc_qUp))",
    "nc_sDn = math.log(nc_qDn / (1 - nc_qDn))",
    "// Multiclass calibration (softmax matrix scaling, fitted on the chronological validation split only).",
    `nc_cU = ${num(sc.wUp[0])} * nc_sUp + ${num(sc.wUp[1])} * nc_sDn + ${num(sc.bUp)}`,
    `nc_cD = ${num(sc.wDn[0])} * nc_sUp + ${num(sc.wDn[1])} * nc_sDn + ${num(sc.bDn)}`,
    "nc_mx = math.max(nc_cU, nc_cD, 0)",
    "nc_eU = math.exp(nc_cU - nc_mx)",
    "nc_eD = math.exp(nc_cD - nc_mx)",
    "nc_eN = math.exp(-nc_mx)",
    "nc_sum = nc_eU + nc_eD + nc_eN",
    "nc_up = nc_ready ? nc_eU / nc_sum : na",
    "nc_dn = nc_ready ? nc_eD / nc_sum : na",
    "nc_ne = nc_ready ? nc_eN / nc_sum : na",
    `nc_dir = nc_up >= nc_dn and nc_up >= nc_ne ? "UP" : nc_dn >= nc_ne ? "DOWN" : "NEUTRAL"`,
    `nc_state = not nc_lockOk ? "WRONG SYMBOL/TIMEFRAME" : not nc_ready or na(nc_up) ? "MISSING INPUT" : not nc_calibrated ? "UNCALIBRATED" : "OK"`,
    `nc_sig = nc_state != "OK" ? "NO SIGNAL" : nc_dir == "NEUTRAL" ? "NEUTRAL" : math.max(nc_up, nc_dn) < nc_minConf ? "NO SIGNAL" : nc_dir`,
    "",
    "// Frozen prediction for the next bar: updated only when the source bar is closed.",
    `var string nc_frozenSig = "NO SIGNAL"`,
    `var string nc_frozenState = "MISSING INPUT"`,
    "var float nc_frozenUp = na",
    "var float nc_frozenDn = na",
    "var float nc_frozenNe = na",
    "if barstate.isconfirmed",
    "    nc_frozenSig := nc_sig",
    "    nc_frozenState := nc_state",
    "    nc_frozenUp := nc_up",
    "    nc_frozenDn := nc_dn",
    "    nc_frozenNe := nc_ne",
    // Probabilities are shown only when inputs exist, the lock matches and OOS calibration passed.
    `nc_show = nc_frozenState == "OK" and not na(nc_frozenUp)`,
    "",
    `plotshape(barstate.isconfirmed and nc_sig == "UP", "NC UP", shape.triangleup, location.belowbar, color.new(color.green, 0), size=size.tiny)`,
    `plotshape(barstate.isconfirmed and nc_sig == "DOWN", "NC DOWN", shape.triangledown, location.abovebar, color.new(color.red, 0), size=size.tiny)`,
    `plotshape(barstate.isconfirmed and nc_sig == "NEUTRAL", "NC NEUTRAL", shape.circle, location.abovebar, color.new(color.gray, 0), size=size.tiny)`,
    "",
    "var table nc_tbl = table.new(position.top_right, 2, 9, border_width=1)",
    "if barstate.islast",
    `    table.cell(nc_tbl, 0, 0, "NEXT CANDLE", text_color=color.white, bgcolor=color.new(color.black, 0))`,
    `    table.cell(nc_tbl, 1, 0, nc_frozenSig, text_color=color.white, bgcolor=nc_frozenSig == "UP" ? color.green : nc_frozenSig == "DOWN" ? color.red : color.gray)`,
    `    table.cell(nc_tbl, 0, 1, "UP")`,
    `    table.cell(nc_tbl, 1, 1, nc_show ? str.tostring(nc_frozenUp * 100, "#.0") + "%" : "—")`,
    `    table.cell(nc_tbl, 0, 2, "DOWN")`,
    `    table.cell(nc_tbl, 1, 2, nc_show ? str.tostring(nc_frozenDn * 100, "#.0") + "%" : "—")`,
    `    table.cell(nc_tbl, 0, 3, "NEUTRAL")`,
    `    table.cell(nc_tbl, 1, 3, nc_show ? str.tostring(nc_frozenNe * 100, "#.0") + "%" : "—")`,
    `    table.cell(nc_tbl, 0, 4, "Confidence")`,
    `    table.cell(nc_tbl, 1, 4, nc_show ? str.tostring(math.max(nc_frozenUp, nc_frozenDn, nc_frozenNe) * 100, "#.0") + "%" : "—")`,
    `    table.cell(nc_tbl, 0, 5, "Status")`,
    `    table.cell(nc_tbl, 1, 5, nc_frozenState == "OK" ? "OK" : "NO SIGNAL — " + nc_frozenState)`,
    `    table.cell(nc_tbl, 0, 6, "Frozen · Lookahead OFF · Repaint NO")`,
    `    table.cell(nc_tbl, 1, 6, "YES")`,
    `    table.cell(nc_tbl, 0, 7, "MODEL TRAINED FOR ${lock.label}", text_color=color.white, bgcolor=nc_lockOk ? color.new(color.blue, 0) : color.new(color.red, 0))`,
    `    table.cell(nc_tbl, 1, 7, nc_lockOk ? "MATCH" : "DISABLED")`,
    `    table.cell(nc_tbl, 0, 8, "Model")`,
    `    table.cell(nc_tbl, 1, 8, "${PINE_GEN_MODEL_VERSION}")`,
  );
  if (meta.alerts) {
    out.push(
      "",
      `alertcondition(barstate.isconfirmed and nc_sig == "UP", "Next Candle UP", "Next Candle Forecast: UP")`,
      `alertcondition(barstate.isconfirmed and nc_sig == "DOWN", "Next Candle DOWN", "Next Candle Forecast: DOWN")`,
      `alertcondition(barstate.isconfirmed and nc_sig == "NEUTRAL", "Next Candle NEUTRAL", "Next Candle Forecast: NEUTRAL")`,
      `alertcondition(barstate.isconfirmed and nc_sig == "NO SIGNAL", "Next Candle NO SIGNAL", "Next Candle Forecast: NO SIGNAL / LOW CONFIDENCE")`,
    );
  }
  return out.join("\n") + "\n";
}
