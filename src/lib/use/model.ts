// ML Forecast Layer — L2-regularized logistic regression with strictly
// chronological splits, walk-forward validation, probability calibration and a
// mandatory comparison against a naive baseline.
//
// Hard rules encoded here:
//  * Never shuffle the series. Splits are always time-ordered.
//  * The out-of-sample tail is never seen during fitting or calibration.
//  * Calibration is learned on validation data only.

import type { ModelMetrics } from "./types";

export type Standardizer = { mean: number[]; std: number[] };

export type LogitModel = {
  weights: number[];
  bias: number;
  standardizer: Standardizer;
};

export type CalibrationBin = { from: number; to: number; observed: number; count: number };

export type TrainedBundle = {
  up: LogitModel;
  down: LogitModel;
  calibrationUp: CalibrationBin[];
  calibrationDown: CalibrationBin[];
  featureNames: string[];
  metrics: {
    train: ModelMetrics;
    validation: ModelMetrics;
    outOfSample: ModelMetrics;
    baseline: ModelMetrics;
    walkForward: ModelMetrics[];
  };
  featureImportance: { name: string; weight: number }[];
  overfittingRisk: boolean;
  sampleSize: number;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function fitStandardizer(rows: number[][]): Standardizer {
  const cols = rows[0]?.length ?? 0;
  const mean = new Array<number>(cols).fill(0);
  const std = new Array<number>(cols).fill(1);
  if (rows.length === 0) return { mean, std };
  for (let j = 0; j < cols; j += 1) {
    let sum = 0;
    for (const row of rows) sum += row[j] ?? 0;
    const m = sum / rows.length;
    let variance = 0;
    for (const row of rows) variance += ((row[j] ?? 0) - m) ** 2;
    mean[j] = m;
    std[j] = Math.sqrt(variance / rows.length) || 1;
  }
  return { mean, std };
}

function applyStandardizer(row: number[], s: Standardizer): number[] {
  return row.map((v, j) => ((v ?? 0) - (s.mean[j] ?? 0)) / (s.std[j] ?? 1));
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

export function fitLogistic(
  rows: number[][],
  labels: number[],
  options: { l2?: number; epochs?: number; lr?: number } = {},
): LogitModel {
  const l2 = options.l2 ?? 0.01;
  const epochs = options.epochs ?? 260;
  const lr0 = options.lr ?? 0.12;
  const standardizer = fitStandardizer(rows);
  const scaled = rows.map((r) => applyStandardizer(r, standardizer));
  const cols = scaled[0]?.length ?? 0;
  const weights = new Array<number>(cols).fill(0);
  let bias = 0;
  const n = scaled.length || 1;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const lr = lr0 / (1 + epoch * 0.01);
    const grad = new Array<number>(cols).fill(0);
    let gradBias = 0;
    for (let i = 0; i < scaled.length; i += 1) {
      const row = scaled[i] ?? [];
      let z = bias;
      for (let j = 0; j < cols; j += 1) z += (weights[j] ?? 0) * (row[j] ?? 0);
      const err = sigmoid(z) - (labels[i] ?? 0);
      for (let j = 0; j < cols; j += 1) grad[j] = (grad[j] ?? 0) + err * (row[j] ?? 0);
      gradBias += err;
    }
    for (let j = 0; j < cols; j += 1) {
      weights[j] = (weights[j] ?? 0) - lr * ((grad[j] ?? 0) / n + l2 * (weights[j] ?? 0));
    }
    bias -= lr * (gradBias / n);
  }

  return { weights, bias, standardizer };
}

export function predictProba(model: LogitModel, row: number[]): number {
  const scaled = applyStandardizer(row, model.standardizer);
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j += 1) z += (model.weights[j] ?? 0) * (scaled[j] ?? 0);
  return sigmoid(z);
}

export function contributions(model: LogitModel, row: number[]): number[] {
  const scaled = applyStandardizer(row, model.standardizer);
  return model.weights.map((w, j) => (w ?? 0) * (scaled[j] ?? 0));
}

export function metrics(labels: number[], probs: number[]): ModelMetrics {
  const n = labels.length;
  if (n === 0) {
    return { samples: 0, accuracy: 0, logLoss: 0, brier: 0, auc: 0.5, hitRateUp: 0, hitRateDown: 0 };
  }
  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let upHits = 0;
  let upCount = 0;
  let downHits = 0;
  let downCount = 0;
  for (let i = 0; i < n; i += 1) {
    const y = labels[i] ?? 0;
    const p = clamp(probs[i] ?? 0.5, 1e-6, 1 - 1e-6);
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === y) correct += 1;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    brier += (p - y) ** 2;
    if (pred === 1) {
      upCount += 1;
      if (y === 1) upHits += 1;
    } else {
      downCount += 1;
      if (y === 0) downHits += 1;
    }
  }
  return {
    samples: n,
    accuracy: correct / n,
    logLoss: logLoss / n,
    brier: brier / n,
    auc: rocAuc(labels, probs),
    hitRateUp: upCount === 0 ? 0 : upHits / upCount,
    hitRateDown: downCount === 0 ? 0 : downHits / downCount,
  };
}

function rocAuc(labels: number[], probs: number[]): number {
  const pairs = labels.map((y, i) => ({ y, p: probs[i] ?? 0.5 })).sort((a, b) => a.p - b.p);
  const pos = pairs.filter((x) => x.y === 1).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  let rankSum = 0;
  pairs.forEach((pair, idx) => {
    if (pair.y === 1) rankSum += idx + 1;
  });
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function buildCalibration(labels: number[], probs: number[], bins = 10): CalibrationBin[] {
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b += 1) {
    const from = b / bins;
    const to = (b + 1) / bins;
    let count = 0;
    let positives = 0;
    for (let i = 0; i < labels.length; i += 1) {
      const p = probs[i] ?? 0.5;
      if (p >= from && (p < to || (b === bins - 1 && p <= to))) {
        count += 1;
        positives += labels[i] ?? 0;
      }
    }
    out.push({ from, to, observed: count === 0 ? (from + to) / 2 : positives / count, count });
  }
  return out;
}

export function applyCalibration(bins: CalibrationBin[], p: number): number {
  const hit = bins.find((b) => p >= b.from && p < b.to) ?? bins[bins.length - 1];
  if (!hit || hit.count < 25) return p;
  // Shrink toward the raw probability when the bin is thin.
  const trust = clamp(hit.count / 200, 0, 1);
  return clamp(hit.observed * trust + p * (1 - trust), 0.01, 0.99);
}

export type SplitIndices = { train: number[]; validation: number[]; outOfSample: number[] };

/** Chronological 60/20/20 split. Never shuffled. */
export function timeSeriesSplit(n: number): SplitIndices {
  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const range = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let i = a; i < b; i += 1) out.push(i);
    return out;
  };
  return {
    train: range(0, trainEnd),
    validation: range(trainEnd, valEnd),
    outOfSample: range(valEnd, n),
  };
}

/** Expanding-window walk-forward folds over the train+validation region only. */
export function walkForwardFolds(n: number, folds = 5): { train: number[]; test: number[] }[] {
  const limit = Math.floor(n * 0.8);
  const out: { train: number[]; test: number[] }[] = [];
  const step = Math.floor(limit / (folds + 1));
  if (step < 50) return out;
  for (let f = 1; f <= folds; f += 1) {
    const trainEnd = step * f;
    const testEnd = Math.min(step * (f + 1), limit);
    const train: number[] = [];
    const test: number[] = [];
    for (let i = 0; i < trainEnd; i += 1) train.push(i);
    for (let i = trainEnd; i < testEnd; i += 1) test.push(i);
    if (test.length > 20) out.push({ train, test });
  }
  return out;
}

export function baselineMetrics(labels: number[], indices: number[]): ModelMetrics {
  // Naive baseline: unconditional class frequency of the training region.
  const cut = Math.floor(labels.length * 0.8);
  let ups = 0;
  for (let i = 0; i < cut; i += 1) ups += labels[i] ?? 0;
  const p = cut === 0 ? 0.5 : clamp(ups / cut, 0.01, 0.99);
  const y = indices.map((i) => labels[i] ?? 0);
  return metrics(
    y,
    y.map(() => p),
  );
}

export function trainDirectionBundle(
  featureNames: string[],
  X: number[][],
  labelsUp: number[],
  labelsDown: number[],
): TrainedBundle {
  const n = X.length;
  const split = timeSeriesSplit(n);
  const pick = (idx: number[]): number[][] => idx.map((i) => X[i] ?? []);
  const pickY = (idx: number[], y: number[]): number[] => idx.map((i) => y[i] ?? 0);

  const fitOn = [...split.train, ...split.validation];
  const upModelTrainOnly = fitLogistic(pick(split.train), pickY(split.train, labelsUp));
  const downModelTrainOnly = fitLogistic(pick(split.train), pickY(split.train, labelsDown));

  const trainProbs = split.train.map((i) => predictProba(upModelTrainOnly, X[i] ?? []));
  const valProbs = split.validation.map((i) => predictProba(upModelTrainOnly, X[i] ?? []));
  const calibrationUp = buildCalibration(pickY(split.validation, labelsUp), valProbs);
  const valProbsDown = split.validation.map((i) => predictProba(downModelTrainOnly, X[i] ?? []));
  const calibrationDown = buildCalibration(pickY(split.validation, labelsDown), valProbsDown);

  const oosProbs = split.outOfSample.map((i) =>
    applyCalibration(calibrationUp, predictProba(upModelTrainOnly, X[i] ?? [])),
  );

  const trainMetrics = metrics(pickY(split.train, labelsUp), trainProbs);
  const validationMetrics = metrics(pickY(split.validation, labelsUp), valProbs);
  const oosMetrics = metrics(pickY(split.outOfSample, labelsUp), oosProbs);
  const baseline = baselineMetrics(labelsUp, split.outOfSample);

  const walkForward: ModelMetrics[] = walkForwardFolds(n).map((fold) => {
    const m = fitLogistic(pick(fold.train), pickY(fold.train, labelsUp));
    const p = fold.test.map((i) => predictProba(m, X[i] ?? []));
    return metrics(pickY(fold.test, labelsUp), p);
  });

  // Final production models see train+validation only; the OOS tail stays untouched.
  const up = fitLogistic(pick(fitOn), pickY(fitOn, labelsUp));
  const down = fitLogistic(pick(fitOn), pickY(fitOn, labelsDown));

  const importance = up.weights
    .map((w, j) => ({ name: featureNames[j] ?? `f${j}`, weight: w ?? 0 }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  const overfittingRisk =
    trainMetrics.accuracy - oosMetrics.accuracy > 0.08 ||
    oosMetrics.accuracy <= baseline.accuracy ||
    oosMetrics.auc < 0.5 ||
    oosMetrics.logLoss > baseline.logLoss;

  return {
    up,
    down,
    calibrationUp,
    calibrationDown,
    featureNames,
    metrics: {
      train: trainMetrics,
      validation: validationMetrics,
      outOfSample: oosMetrics,
      baseline,
      walkForward,
    },
    featureImportance: importance.slice(0, 20),
    overfittingRisk,
    sampleSize: n,
  };
}
