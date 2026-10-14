// Purged K-Fold with embargo (López de Prado). Sample i's label spans [i, i+horizon].
// Training samples whose label window overlaps the test window are purged; the `embargo`
// samples right after the test block are also removed.
export type Fold = { train: number[]; test: number[] };

export function purgedKFold(n: number, k: number, horizon = 1, embargo = 5): Fold[] {
  if (k < 2 || n < k * 2) throw new Error(`purgedKFold: need n ≥ 2k (n=${n}, k=${k})`);
  const folds: Fold[] = [];
  const size = Math.floor(n / k);
  for (let f = 0; f < k; f += 1) {
    const start = f * size;
    const end = f === k - 1 ? n - 1 : start + size - 1;
    const test: number[] = [];
    for (let i = start; i <= end; i += 1) test.push(i);
    const train: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (i >= start && i <= end) continue;
      if (i < start && i + horizon >= start) continue; // label overlaps test window
      if (i > end && i <= end + horizon + embargo) continue; // embargo after test
      train.push(i);
    }
    folds.push({ train, test });
  }
  return folds;
}

/** Throws if any train sample's label window [i, i+h] touches a test window (±embargo after). */
export function assertNoLeakage(folds: Fold[], horizon = 1, embargo = 5): true {
  for (const [fi, f] of folds.entries()) {
    const lo = Math.min(...f.test), hi = Math.max(...f.test);
    for (const i of f.train) {
      const overlaps = i + horizon >= lo && i <= hi + horizon + embargo;
      if (overlaps) throw new Error(`LEAKAGE fold ${fi}: train sample ${i} overlaps test [${lo},${hi}]`);
    }
  }
  return true;
}
