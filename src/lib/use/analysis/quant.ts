// Quantitative analytics computed only from the engine's actual trade list / equity curve. Pure.
import type { Trade } from "../strategy/backtester";

const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
const sd = (x: number[]) => { if (x.length < 2) return 0; const m = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); };
const quantile = (sorted: number[], q: number) => { if (!sorted.length) return null; const p = (sorted.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (p - lo); };

/** Core performance from a trade list (pnl in account currency). */
export function performance(trades: Trade[], initial: number) {
  const w = trades.filter((t) => t.pnl > 0), l = trades.filter((t) => t.pnl <= 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
  const net = gw - gl;
  const avgWin = w.length ? gw / w.length : null, avgLoss = l.length ? -gl / l.length : null;
  const rr = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null;
  // Equity from trades (closed-trade curve) for drawdown on this subset.
  let eq = initial, peak = initial, maxDd = 0, ddStart = trades[0]?.entryTs ?? 0, maxDur = 0, peakTs = trades[0]?.entryTs ?? 0;
  for (const t of trades) { eq += t.pnl; if (eq >= peak) { peak = eq; peakTs = t.exitTs; } else { maxDd = Math.max(maxDd, peak - eq); maxDur = Math.max(maxDur, t.exitTs - peakTs); } }
  void ddStart;
  const r = trades.map((t) => t.pnlPct / 100);
  const s = sd(r), down = Math.sqrt(mean(r.map((x) => Math.min(x, 0) ** 2)));
  return {
    trades: trades.length, wins: w.length, losses: l.length, winRate: trades.length ? w.length / trades.length : null,
    grossProfit: gw, grossLoss: gl, netPnl: net, profitFactor: gl > 0 ? gw / gl : null, expectancy: trades.length ? net / trades.length : null,
    avgWin, avgLoss, riskReward: rr, maxDrawdown: maxDd, maxDrawdownPct: peak > 0 ? (maxDd / peak) * 100 : 0, drawdownDurationMs: maxDur,
    recoveryFactor: maxDd > 0 ? net / maxDd : null,
    sharpePerTrade: s > 0 ? mean(r) / s : null, sortinoPerTrade: down > 0 ? mean(r) / down : null,
    breakevenWinRate: rr !== null ? 1 / (1 + rr) : null,
  };
}

/** Risk analytics on per-trade returns (%). */
export function risk(trades: Trade[], worstN = 5) {
  const r = trades.map((t) => t.pnlPct);
  const sorted = [...r].sort((a, b) => a - b);
  const m = mean(r), s = sd(r), n = r.length;
  const skew = n > 2 && s > 0 ? (n / ((n - 1) * (n - 2))) * r.reduce((a, x) => a + ((x - m) / s) ** 3, 0) : null;
  const kurt = n > 3 && s > 0 ? ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * r.reduce((a, x) => a + ((x - m) / s) ** 4, 0) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)) : null;
  const jb = skew !== null && kurt !== null ? (n / 6) * (skew ** 2 + kurt ** 2 / 4) : null;
  const tail = (q: number) => { const v = quantile(sorted, q); if (v === null) return { var: null, cvar: null }; const t = sorted.filter((x) => x <= v); return { var: -v, cvar: t.length ? -mean(t) : null }; };
  const bins = 20; const lo = sorted[0] ?? 0, hi = sorted[n - 1] ?? 0; const w = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: 0 }));
  for (const x of r) hist[Math.min(bins - 1, Math.floor((x - lo) / w))]!.count++;
  return {
    sample: n, unit: "% per trade", var95: tail(0.05).var, cvar95: tail(0.05).cvar, var99: tail(0.01).var, cvar99: tail(0.01).cvar,
    skewness: skew, excessKurtosis: kurt, jarqueBera: jb,
    fatTails: kurt !== null && n >= 30 ? kurt > 1 : null, skewed: skew !== null && n >= 30 ? Math.abs(skew) > 0.5 : null,
    normalRejected: jb !== null && n >= 30 ? jb > 5.991 : null,
    worstTrades: [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, worstN).map((t) => ({ n: t.n, dir: t.dir, entryTs: t.entryTs, pnl: t.pnl, pnlPct: t.pnlPct, mae: t.mae })),
    maxAdverseExcursion: trades.length ? Math.max(...trades.map((t) => Math.abs(t.mae))) : null,
    maxAdverseExcursionPct: trades.length ? Math.max(...trades.map((t) => Math.abs(t.maePct))) : null,
    histogram: hist,
  };
}

/** Signal quality from executed trades. */
export function signalQuality(trades: Trade[], observedDays: number, stepMs: number, gross: ReturnType<typeof performance>, net: ReturnType<typeof performance>) {
  const gaps: number[] = []; let dup = 0;
  for (let i = 1; i < trades.length; i++) { const g = trades[i]!.entryTs - trades[i - 1]!.entryTs; gaps.push(g); if (trades[i]!.dir === trades[i - 1]!.dir && trades[i]!.signalBar - trades[i - 1]!.exitBar <= 1) dup++; }
  let cw = 0, cl = 0, mcw = 0, mcl = 0;
  for (const t of trades) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } mcw = Math.max(mcw, cw); mcl = Math.max(mcl, cl); }
  const by = (k: (t: Trade) => string) => { const m = new Map<string, Trade[]>(); for (const t of trades) m.set(k(t), [...(m.get(k(t)) ?? []), t]); return [...m.entries()].map(([key, ts]) => ({ key, trades: ts.length, winRate: ts.filter((t) => t.pnl > 0).length / ts.length, netPnl: ts.reduce((a, t) => a + t.pnl, 0) })); };
  const costShare = gross.netPnl > 0 ? (gross.netPnl - net.netPnl) / gross.netPnl : null;
  const overtrading = gross.netPnl > 0 && net.netPnl <= 0 ? "OVERTRADING: gross edge is erased by costs" : costShare !== null && costShare > 0.5 ? `OVERTRADING_RISK: costs take ${(costShare * 100).toFixed(0)}% of gross profit` : null;
  return {
    signalsPerDay: observedDays > 0 ? trades.length / observedDays : null, avgMinutesBetween: gaps.length ? mean(gaps) / 60000 : null, avgBarsBetween: gaps.length ? mean(gaps) / stepMs : null,
    duplicateSignals: dup, maxConsecutiveWins: mcw, maxConsecutiveLosses: mcl,
    bySession: by((t) => t.session), byDirection: by((t) => (t.dir === "LONG" ? "BUY" : "SELL")), byRegime: by((t) => t.regime),
    costShareOfGross: costShare, overtrading,
  };
}

/** Breakeven win rates before/after costs. */
export function breakeven(gross: ReturnType<typeof performance>, net: ReturnType<typeof performance>) {
  return {
    rawBreakevenWinRate: gross.breakevenWinRate, rawWinRate: gross.winRate,
    afterCostBreakevenWinRate: net.breakevenWinRate, afterCostWinRate: net.winRate,
    costPerTrade: gross.trades ? (gross.netPnl - net.netPnl) / gross.trades : null,
    edgePositiveRaw: (gross.expectancy ?? 0) > 0, edgePositiveAfterCosts: (net.expectancy ?? 0) > 0,
  };
}

export type SizingLimits = { maxRiskPerTrade: number; maxDailyRisk: number; maxExposure: number };
/** Position sizing suggestions; Kelly is never applied at full size and always capped by the limits. */
export function sizing(net: ReturnType<typeof performance>, equity: number, atr: number | null, price: number, contractSize: number, lim: SizingLimits, riskFraction: number, atrMult: number, signalsPerDay: number | null) {
  const W = net.winRate, R = net.riskReward;
  const kelly = W !== null && R !== null && R > 0 ? W - (1 - W) / R : null;
  const cap = (f: number | null) => (f === null ? null : Math.max(0, Math.min(f, lim.maxRiskPerTrade)));
  const perUnitRisk = atr !== null ? atr * atrMult * contractSize : null;
  const units = (f: number) => (perUnitRisk && perUnitRisk > 0 ? (equity * f) / perUnitRisk : null);
  const exposureCap = price > 0 ? (equity * lim.maxExposure) / (price * contractSize) : null;
  const clampU = (u: number | null) => (u === null ? null : exposureCap !== null ? Math.min(u, exposureCap) : u);
  const fixed = Math.min(riskFraction, lim.maxRiskPerTrade);
  const daily = signalsPerDay && signalsPerDay > 0 ? Math.min(fixed, lim.maxDailyRisk / signalsPerDay) : fixed;
  return {
    kelly: { raw: kelly, half: kelly !== null ? kelly / 2 : null, quarter: kelly !== null ? kelly / 4 : null, appliedFraction: cap(kelly !== null ? kelly / 4 : null), note: kelly !== null && kelly <= 0 ? "Kelly ≤ 0: no positive edge — size 0" : "quarter Kelly, capped by max risk per trade" },
    fixedFractional: { riskFraction: daily, units: clampU(units(daily)) },
    atrBased: { atr, atrMult, units: clampU(units(daily)) },
    volatilityBased: { units: atr && price ? clampU((equity * daily) / ((atr / price) * price * contractSize)) : null },
    limits: lim, exposureCapUnits: exposureCap,
  };
}

/** Pearson correlation of two aligned return series. */
export function correlation(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const x = a.slice(-n), y = b.slice(-n); const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
export function rollingCorrelation(a: number[], b: number[], win: number) {
  const out: (number | null)[] = []; const n = Math.min(a.length, b.length);
  for (let i = win; i <= n; i += Math.max(1, Math.floor(win / 4))) out.push(correlation(a.slice(i - win, i), b.slice(i - win, i)));
  return out;
}
