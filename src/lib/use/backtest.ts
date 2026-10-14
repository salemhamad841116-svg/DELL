// Historical Intelligence Engine.
// Walks the series bar by bar, evaluates a signal at bar i using data up to i,
// and measures the outcome using bars strictly after i. No look-ahead.

import { atr } from "./indicators";
import { detectRegimes } from "./regime";
import { REGIME_LABELS } from "./regime";
import type {
  Bucket,
  Candle,
  HistoricalReport,
  HistoricalStats,
  MarketRegime,
} from "./types";

export type Trade = {
  index: number;
  ts: number;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  pnlPct: number;
  win: boolean;
  barsHeld: number;
  favorable: number;
  adverse: number;
  hour: number;
  weekday: number;
  month: number;
  regime: MarketRegime;
  volatilityBucket: string;
};

export type SignalFn = (i: number) => "LONG" | "SHORT" | null;

const emptyStats = (): HistoricalStats => ({
  observations: 0,
  trades: 0,
  winRate: 0,
  lossRate: 0,
  expectancy: 0,
  profitFactor: 0,
  maxDrawdown: 0,
  averageReturn: 0,
  averageFavorableExcursion: 0,
  averageAdverseExcursion: 0,
  averageTimeToTarget: 0,
  averageTimeToFailure: 0,
  longWinRate: 0,
  shortWinRate: 0,
  longTrades: 0,
  shortTrades: 0,
});

export function simulate(
  candles: Candle[],
  signal: SignalFn,
  opts: { tpAtr?: number; slAtr?: number; maxBars?: number; warmup?: number } = {},
): Trade[] {
  const tpAtr = opts.tpAtr ?? 2;
  const slAtr = opts.slAtr ?? 1;
  const maxBars = opts.maxBars ?? 24;
  const warmup = opts.warmup ?? 60;
  const atrSeries = atr(candles, 14);
  const { regimes } = detectRegimes(candles);
  const trades: Trade[] = [];
  let cooldownUntil = -1;

  for (let i = warmup; i < candles.length - 1; i += 1) {
    if (i < cooldownUntil) continue;
    const side = signal(i);
    if (!side) continue;
    const entryCandle = candles[i + 1];
    const base = candles[i];
    const a = atrSeries[i];
    if (!entryCandle || !base || !a || a <= 0) continue;
    const entry = entryCandle.open;
    const tp = side === "LONG" ? entry + tpAtr * a : entry - tpAtr * a;
    const sl = side === "LONG" ? entry - slAtr * a : entry + slAtr * a;

    let exit = entry;
    let bars = 0;
    let favorable = 0;
    let adverse = 0;
    let hit: "TP" | "SL" | "TIME" = "TIME";

    for (let j = i + 1; j < Math.min(i + 1 + maxBars, candles.length); j += 1) {
      const c = candles[j];
      if (!c) break;
      bars = j - i;
      const up = ((c.high - entry) / entry) * 100;
      const down = ((c.low - entry) / entry) * 100;
      favorable = Math.max(favorable, side === "LONG" ? up : -down);
      adverse = Math.min(adverse, side === "LONG" ? down : -up);
      const tpHit = side === "LONG" ? c.high >= tp : c.low <= tp;
      const slHit = side === "LONG" ? c.low <= sl : c.high >= sl;
      // Conservative: when both are touched in the same bar, assume the stop first.
      if (slHit) {
        exit = sl;
        hit = "SL";
        break;
      }
      if (tpHit) {
        exit = tp;
        hit = "TP";
        break;
      }
      exit = c.close;
    }

    const pnlPct = ((side === "LONG" ? exit - entry : entry - exit) / entry) * 100;
    const d = new Date(base.ts);
    const volPct = (a / base.close) * 100;
    trades.push({
      index: i,
      ts: base.ts,
      side,
      entry,
      exit,
      pnlPct,
      win: hit === "TP" || (hit === "TIME" && pnlPct > 0),
      barsHeld: bars,
      favorable,
      adverse,
      hour: d.getUTCHours(),
      weekday: d.getUTCDay(),
      month: d.getUTCMonth() + 1,
      regime: regimes[i] ?? "UNCERTAIN",
      volatilityBucket: volPct < 0.4 ? "منخفض" : volPct < 1 ? "متوسط" : volPct < 2 ? "مرتفع" : "شديد",
    });
    cooldownUntil = i + Math.max(bars, 1);
  }
  return trades;
}

export function statsFromTrades(trades: Trade[], observations: number): HistoricalStats {
  const s = emptyStats();
  s.observations = observations;
  s.trades = trades.length;
  if (trades.length === 0) return s;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0));
  s.winRate = wins.length / trades.length;
  s.lossRate = losses.length / trades.length;
  s.averageReturn = trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length;
  s.expectancy = s.averageReturn;
  s.profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  s.averageFavorableExcursion = trades.reduce((a, t) => a + t.favorable, 0) / trades.length;
  s.averageAdverseExcursion = trades.reduce((a, t) => a + t.adverse, 0) / trades.length;
  s.averageTimeToTarget = wins.length ? wins.reduce((a, t) => a + t.barsHeld, 0) / wins.length : 0;
  s.averageTimeToFailure = losses.length ? losses.reduce((a, t) => a + t.barsHeld, 0) / losses.length : 0;
  const longs = trades.filter((t) => t.side === "LONG");
  const shorts = trades.filter((t) => t.side === "SHORT");
  s.longTrades = longs.length;
  s.shortTrades = shorts.length;
  s.longWinRate = longs.length ? longs.filter((t) => t.pnlPct > 0).length / longs.length : 0;
  s.shortWinRate = shorts.length ? shorts.filter((t) => t.pnlPct > 0).length / shorts.length : 0;

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  s.maxDrawdown = maxDd;
  return s;
}

function bucketBy(trades: Trade[], key: (t: Trade) => string): Bucket[] {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t);
    const list = map.get(k) ?? [];
    list.push(t);
    map.set(k, list);
  }
  return Array.from(map.entries())
    .map(([k, list]) => ({
      key: k,
      samples: list.length,
      winRate: list.filter((t) => t.pnlPct > 0).length / list.length,
      averageReturn: list.reduce((a, t) => a + t.pnlPct, 0) / list.length,
    }))
    .sort((a, b) => b.samples - a.samples);
}

export function buildHistoricalReport(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  trades: Trade[],
): HistoricalReport {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const spanDays = first && last ? (last.ts - first.ts) / 86_400_000 : 0;
  return {
    symbol,
    timeframe,
    periodStart: first ? new Date(first.ts).toISOString() : null,
    periodEnd: last ? new Date(last.ts).toISOString() : null,
    stats: statsFromTrades(trades, candles.length),
    byHour: bucketBy(trades, (t) => `${String(t.hour).padStart(2, "0")}:00`),
    byWeekday: bucketBy(trades, (t) => ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"][t.weekday] ?? "?"),
    byMonth: bucketBy(trades, (t) => `شهر ${t.month}`),
    byRegime: bucketBy(trades, (t) => REGIME_LABELS[t.regime] ?? t.regime),
    byVolatility: bucketBy(trades, (t) => t.volatilityBucket),
    aggregates: [
      { key: "الشموع", samples: candles.length, winRate: 0, averageReturn: 0 },
      { key: "الأيام", samples: Math.round(spanDays), winRate: 0, averageReturn: 0 },
      { key: "الأسابيع", samples: Math.round(spanDays / 7), winRate: 0, averageReturn: 0 },
      { key: "الأشهر", samples: Math.round(spanDays / 30), winRate: 0, averageReturn: 0 },
      { key: "السنوات", samples: Number((spanDays / 365).toFixed(2)), winRate: 0, averageReturn: 0 },
    ],
    featureCombinations: bucketBy(trades, (t) => `${REGIME_LABELS[t.regime] ?? t.regime} + تقلب ${t.volatilityBucket}`).slice(0, 12),
  };
}
