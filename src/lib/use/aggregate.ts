// Timeframe aggregation. Builds larger candles from a smaller base series.
// Only completed buckets are emitted, so no partial (future-leaking) candle
// ever reaches the feature engine.

import type { Candle } from "./types";
import { getTimeframe, timeframeSeconds } from "./timeframes";

function bucketStart(tsMs: number, seconds: number, timeframeId: string): number {
  const d = new Date(tsMs);
  if (timeframeId === "1W") {
    const day = d.getUTCDay();
    const monday = (day + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - monday);
  }
  if (timeframeId === "1M") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const ms = seconds * 1000;
  return Math.floor(tsMs / ms) * ms;
}

export function aggregateCandles(base: Candle[], targetTimeframe: string): Candle[] {
  const spec = getTimeframe(targetTimeframe);
  if (!spec) return [];
  const seconds = timeframeSeconds(targetTimeframe);
  const out: Candle[] = [];
  let current: Candle | null = null;
  let currentKey = -1;

  for (const c of base) {
    const key = bucketStart(c.ts, seconds, targetTimeframe);
    if (!current || key !== currentKey) {
      if (current) out.push(current);
      currentKey = key;
      current = {
        ts: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
      continue;
    }
    current.high = Math.max(current.high, c.high);
    current.low = Math.min(current.low, c.low);
    current.close = c.close;
    if (c.volume !== null) current.volume = (current.volume ?? 0) + c.volume;
  }
  if (current) out.push(current);
  // Drop the trailing bucket: it may still be forming.
  return out.slice(0, Math.max(out.length - 1, 0));
}
