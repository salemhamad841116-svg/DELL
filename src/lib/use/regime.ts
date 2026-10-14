// Market Regime Detection — classifies the environment from data available at T.

import { adx, atr, ema, rollingHigh, rollingLow, stdev } from "./indicators";
import type { Candle, MarketRegime } from "./types";

export type RegimeSeries = {
  regimes: (MarketRegime | null)[];
  current: MarketRegime;
};

const num = (v: number | null | undefined, fallback: number): number =>
  v === null || v === undefined || !Number.isFinite(v) ? fallback : v;

export function detectRegimes(candles: Candle[]): RegimeSeries {
  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, 20);
  const emaSlow = ema(closes, 50);
  const adxSeries = adx(candles, 14);
  const atrSeries = atr(candles, 14);
  const returns = closes.map((c, i) => {
    const prev = closes[i - 1];
    return prev ? (c - prev) / prev : 0;
  });
  const vol = stdev(returns, 20);
  const hi = rollingHigh(candles, 20);
  const lo = rollingLow(candles, 20);

  const regimes: (MarketRegime | null)[] = candles.map((c, i) => {
    if (i < 60) return null;
    const fast = num(emaFast[i], c.close);
    const slow = num(emaSlow[i], c.close);
    const adxNow = num(adxSeries[i], 20);
    const atrNow = num(atrSeries[i], 0);
    const atrRef = num(atrSeries[i - 50], atrNow);
    const volNow = num(vol[i], 0);
    const volRef = num(vol[i - 50], volNow);
    const prevHigh = num(hi[i - 1], c.high);
    const prevLow = num(lo[i - 1], c.low);

    if (c.close > prevHigh * 1.0005 && adxNow > 22 && atrNow > atrRef * 1.15) return "BREAKOUT";
    if (c.close < prevLow * 0.9995 && adxNow > 22 && atrNow > atrRef * 1.15) return "BREAKOUT";
    if (volNow > volRef * 1.6 && adxNow < 25) return "HIGH_VOLATILITY";
    if (volNow < volRef * 0.6 && adxNow < 20) return "LOW_VOLATILITY";
    if (adxNow >= 22 && fast > slow) return "TRENDING_UP";
    if (adxNow >= 22 && fast < slow) return "TRENDING_DOWN";
    if (adxNow < 18) return "RANGE";
    return "UNCERTAIN";
  });

  const current = [...regimes].reverse().find((r): r is MarketRegime => r !== null) ?? "UNCERTAIN";
  return { regimes, current };
}

export const REGIME_LABELS: Record<MarketRegime, string> = {
  TRENDING_UP: "اتجاه صاعد",
  TRENDING_DOWN: "اتجاه هابط",
  RANGE: "عرضي / نطاق",
  HIGH_VOLATILITY: "تقلب مرتفع",
  LOW_VOLATILITY: "تقلب منخفض",
  BREAKOUT: "اختراق",
  UNCERTAIN: "غير محدد",
};
