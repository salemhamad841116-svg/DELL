// Binary learners (pure TS): L2 logistic regression, gradient-boosted stumps, their ensemble,
// and isotonic calibration (pool-adjacent-violators) fit on out-of-fold predictions only.
export type Model = { predict: (x: number[]) => number };

export function standardizer(X: number[][]) {
  const d = X[0]?.length ?? 0;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / X.length));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - (mu[j] ?? 0)) ** 2 / X.length));
  const s = sd.map((v) => Math.sqrt(v) || 1);
  return (x: number[]) => x.map((v, j) => (v - mu[j]) / s[j]);
}

const sig = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitLogistic(X: number[][], y: number[], l2 = 1e-2, epochs = 200, lr = 0.1): Model {
  const z = standardizer(X);
  const Z = X.map(z);
  const d = Z[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e += 1) {
    const g = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i += 1) {
      const r = Z[i]!;
      const err = sig(b + r.reduce((s, v, j) => s + v * w[j], 0)) - y[i]!;
      gb += err;
      for (let j = 0; j < d; j += 1) g[j] += err * r[j]!;
    }
    for (let j = 0; j < d; j += 1) w[j] -= lr * (g[j] / Z.length + l2 * w[j]);
    b -= (lr * gb) / Z.length;
  }
  return { predict: (x) => { const r = z(x); return sig(b + r.reduce((s, v, j) => s + v * w[j], 0)); } };
}

type Stump = { j: number; t: number; left: number; right: number };

/** Gradient boosting with depth-1 trees on log-loss; thresholds from feature quantiles. */
export function fitGBM(X: number[][], y: number[], rounds = 60, lr = 0.1): Model {
  const n = X.length, d = X[0]?.length ?? 0;
  const p0 = Math.min(0.99, Math.max(0.01, y.reduce((a, b) => a + b, 0) / n));
  const base = Math.log(p0 / (1 - p0));
  const F = new Array(n).fill(base);
  const cuts = Array.from({ length: d }, (_, j) => {
    const s = X.map((r) => r[j]!).sort((a, b) => a - b);
    return [0.2, 0.4, 0.6, 0.8].map((q) => s[Math.floor(q * (n - 1))]!);
  });
  const stumps: Stump[] = [];
  for (let m = 0; m < rounds; m += 1) {
    const g = F.map((f, i) => y[i]! - sig(f)); // negative gradient
    const h = F.map((f) => { const p = sig(f); return p * (1 - p); });
    let best: Stump | null = null, bestGain = -Infinity;
    for (let j = 0; j < d; j += 1) for (const t of cuts[j]!) {
      let gl = 0, hl = 0, gr = 0, hr = 0;
      for (let i = 0; i < n; i += 1) if (X[i]![j]! <= t) { gl += g[i]!; hl += h[i]!; } else { gr += g[i]!; hr += h[i]!; }
      const gain = (gl * gl) / (hl + 1) + (gr * gr) / (hr + 1);
      if (gain > bestGain) { bestGain = gain; best = { j, t, left: gl / (hl + 1), right: gr / (hr + 1) }; }
    }
    if (!best) break;
    stumps.push(best);
    for (let i = 0; i < n; i += 1) F[i] += lr * (X[i]![best.j]! <= best.t ? best.left : best.right);
  }
  return { predict: (x) => sig(stumps.reduce((f, s) => f + lr * (x[s.j]! <= s.t ? s.left : s.right), base)) };
}

export function ensemble(models: Model[]): Model {
  return { predict: (x) => models.reduce((s, m) => s + m.predict(x), 0) / models.length };
}

/** Isotonic regression (PAV). Returns a monotone step function p → calibrated p. */
export function fitIsotonic(p: number[], y: number[]): (v: number) => number {
  const idx = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const blocks: { x: number; sum: number; n: number }[] = [];
  for (const i of idx) {
    blocks.push({ x: p[i]!, sum: y[i]!, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.n) {
      const b = blocks.pop()!, a = blocks[blocks.length - 1]!;
      a.sum += b.sum; a.n += b.n; a.x = b.x;
    }
  }
  return (v) => {
    for (const b of blocks) if (v <= b.x) return b.sum / b.n;
    const last = blocks[blocks.length - 1];
    return last ? last.sum / last.n : v;
  };
}
