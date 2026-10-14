// Pure indicator math. Every function returns an array aligned with the input
// series where index i only ever depends on values at index <= i (no look-ahead).

import type { Candle } from "./types";

const at = (arr: number[], i: number): number => arr[i] ?? 0;

export function sma(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += at(values, i);
    if (i >= length) sum -= at(values, i - length);
    out.push(i >= length - 1 ? sum / length : null);
  }
  return out;
}

export function ema(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (length + 1);
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = at(values, i);
    if (i < length - 1) {
      sum += v;
      out.push(null);
      continue;
    }
    if (prev === null) {
      sum += v;
      prev = sum / length;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = [null];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = at(values, i) - at(values, i - 1);
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= length) {
      avgGain += gain / length;
      avgLoss += loss / length;
      out.push(i === length ? computeRsi(avgGain, avgLoss) : null);
      continue;
    }
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out.push(computeRsi(avgGain, avgLoss));
  }
  return out;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    const prev = candles[i - 1];
    if (!prev) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
}

export function atr(candles: Candle[], length: number): (number | null)[] {
  const tr = trueRange(candles);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < tr.length; i += 1) {
    const v = at(tr, i);
    if (i < length) {
      sum += v;
      out.push(i === length - 1 ? sum / length : null);
      if (i === length - 1) prev = sum / length;
      continue;
    }
    prev = ((prev ?? v) * (length - 1) + v) / length;
    out.push(prev);
  }
  return out;
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => {
    const a = f[i];
    const b = s[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
  const filled = line.map((v) => v ?? 0);
  const sig = ema(filled, signal);
  const hist = line.map((v, i) => {
    const sg = sig[i];
    return v === null || sg === null || sg === undefined ? null : v - sg;
  });
  return { line, signal: sig, hist };
}

export function stdev(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i < length - 1) {
      out.push(null);
      continue;
    }
    let mean = 0;
    for (let j = i - length + 1; j <= i; j += 1) mean += at(values, j);
    mean /= length;
    let variance = 0;
    for (let j = i - length + 1; j <= i; j += 1) variance += (at(values, j) - mean) ** 2;
    out.push(Math.sqrt(variance / length));
  }
  return out;
}

export function bollinger(
  values: number[],
  length = 20,
  mult = 2,
): { upper: (number | null)[]; lower: (number | null)[]; middle: (number | null)[] } {
  const mid = sma(values, length);
  const sd = stdev(values, length);
  const upper = values.map((_, i) => {
    const m = mid[i];
    const s = sd[i];
    return m === null || m === undefined || s === null || s === undefined ? null : m + mult * s;
  });
  const lower = values.map((_, i) => {
    const m = mid[i];
    const s = sd[i];
    return m === null || m === undefined || s === null || s === undefined ? null : m - mult * s;
  });
  return { upper, lower, middle: mid };
}

/** Rolling VWAP. Falls back to a typical-price average when the feed has no volume. */
export function rollingVwap(candles: Candle[], length = 20): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < length - 1) {
      out.push(null);
      continue;
    }
    let pv = 0;
    let vol = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      const c = candles[j];
      if (!c) continue;
      const typical = (c.high + c.low + c.close) / 3;
      const v = c.volume === null || c.volume <= 0 ? 1 : c.volume;
      pv += typical * v;
      vol += v;
    }
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

/** Wilder-style ADX as a trend-strength proxy. */
export function adx(candles: Candle[], length = 14): (number | null)[] {
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr = trueRange(candles);
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const p = candles[i - 1];
    if (!c || !p) {
      plusDM.push(0);
      minusDM.push(0);
      continue;
    }
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const smooth = (arr: number[]): (number | null)[] => {
    const res: (number | null)[] = [];
    let prev: number | null = null;
    let sum = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const v = at(arr, i);
      if (i < length) {
        sum += v;
        if (i === length - 1) {
          prev = sum;
          res.push(prev);
        } else res.push(null);
        continue;
      }
      prev = (prev ?? sum) - (prev ?? sum) / length + v;
      res.push(prev);
    }
    return res;
  };
  const sTr = smooth(tr);
  const sPlus = smooth(plusDM);
  const sMinus = smooth(minusDM);
  const dx: (number | null)[] = candles.map((_, i) => {
    const t = sTr[i];
    const p = sPlus[i];
    const m = sMinus[i];
    if (!t || p === null || p === undefined || m === null || m === undefined || t === 0) return null;
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    const denom = pdi + mdi;
    if (denom === 0) return null;
    return (Math.abs(pdi - mdi) / denom) * 100;
  });
  const out: (number | null)[] = [];
  let acc = 0;
  let count = 0;
  let prev: number | null = null;
  for (let i = 0; i < dx.length; i += 1) {
    const v = dx[i];
    if (v === null || v === undefined) {
      out.push(null);
      continue;
    }
    if (count < length) {
      acc += v;
      count += 1;
      if (count === length) {
        prev = acc / length;
        out.push(prev);
      } else out.push(null);
      continue;
    }
    prev = ((prev ?? v) * (length - 1) + v) / length;
    out.push(prev);
  }
  return out;
}

export function rollingHigh(candles: Candle[], length: number): (number | null)[] {
  return candles.map((_, i) => {
    if (i < length - 1) return null;
    let max = -Infinity;
    for (let j = i - length + 1; j <= i; j += 1) max = Math.max(max, candles[j]?.high ?? -Infinity);
    return Number.isFinite(max) ? max : null;
  });
}

export function rollingLow(candles: Candle[], length: number): (number | null)[] {
  return candles.map((_, i) => {
    if (i < length - 1) return null;
    let min = Infinity;
    for (let j = i - length + 1; j <= i; j += 1) min = Math.min(min, candles[j]?.low ?? Infinity);
    return Number.isFinite(min) ? min : null;
  });
}

/** Classic floor-trader pivot levels from the previous completed bar. */
export function pivotLevels(prev: Candle): {
  pivot: number;
  r1: number;
  s1: number;
  r2: number;
  s2: number;
  camarillaH3: number;
  camarillaL3: number;
} {
  const pivot = (prev.high + prev.low + prev.close) / 3;
  const range = prev.high - prev.low;
  return {
    pivot,
    r1: 2 * pivot - prev.low,
    s1: 2 * pivot - prev.high,
    r2: pivot + range,
    s2: pivot - range,
    camarillaH3: prev.close + (range * 1.1) / 4,
    camarillaL3: prev.close - (range * 1.1) / 4,
  };
}
