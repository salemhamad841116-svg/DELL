// Professional Backtest Engine — next-bar execution broker + metrics.
// Order fills happen on bar t+1 for orders created at the close of bar t.
// Same-bar SL/TP ambiguity is resolved conservatively (stop first). No lookahead.

import type { Candle } from "../types";
import { detectRegimes } from "../regime";
import { PineRuntime, SemanticError, type BrokerView, type OrderIntent } from "./executor";
import type { StrategyIR } from "./ir";

export type BacktestSettings = {
  initialCapital: number;
  /** fixed = contracts/units; percent_of_equity = notional %; risk_percent = % equity risked to the stop. */
  qtyType: "fixed" | "percent_of_equity" | "risk_percent";
  /** Same-bar TP/SL resolution policy — stored with every run. */
  fillPolicy?: "CONSERVATIVE_SL_FIRST" | "OPTIMISTIC_TP_FIRST" | "LOWER_TIMEFRAME_RESOLUTION";
  /** Futures: whole contracts only. */
  integerQty?: boolean;
  /** risk_percent fallback when no stop order exists at fill: ATR(14) × this. */
  riskAtrMult?: number;
  qty: number;
  contractSize: number;
  tickSize: number;
  spread: number; // price units, full spread (half applied each side)
  slippageTicks: number; // market & stop fills
  commissionType: "percent" | "per_contract" | "per_order";
  commissionValue: number;
  params: Record<string, unknown>;
};

export type Trade = {
  n: number; dir: "LONG" | "SHORT"; entryId: string; exitId: string;
  signalBar: number; entryBar: number; exitBar: number; entryTs: number; exitTs: number;
  entryPx: number; exitPx: number; qty: number; pnl: number; pnlPct: number; commission: number;
  reason: "TP" | "SL" | "TRAIL" | "CLOSE" | "REVERSE";
  bars: number; holdMs: number; mfe: number; mae: number; mfePct: number; maePct: number;
  hour: number; weekday: string; month: string; session: string; regime: string; volatility: string;
};

type Pos = { dir: 1 | -1; qty: number; entryPx: number; entryBar: number; signalBar: number; entryTs: number; entryId: string; comm: number; best: number; worst: number };
type PendingEntry = Extract<OrderIntent, { kind: "entry" }> & { placed: number };
type ExitOrder = Extract<OrderIntent, { kind: "exit" }>;

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const sessionOf = (ts: number) => { const h = new Date(ts).getUTCHours(); return h < 7 ? "Asia" : h < 13 ? "London" : h < 21 ? "New York" : "Off-hours"; };

export function runProfessionalBacktest(ir: StrategyIR, candles: Candle[], s: BacktestSettings, meta: { tickerid: string; timeframe: string; periodsPerYear: number; market?: string; ltf?: Candle[]; chartStepMs?: number }) {
  const policy = s.fillPolicy ?? "CONSERVATIVE_SL_FIRST";
  const fillStats = { policy, ambiguousBars: 0, resolvedByLowerTf: 0, unresolvedFallbackSlFirst: 0, tpFirst: 0 };
  const warnings: string[] = [];
  const ltf = meta.ltf ?? [];
  const stepMs = meta.chartStepMs ?? 0;
  /** Walk lower-TF bars inside chart bar i: which level was touched first? */
  const resolveLtf = (i: number, dir: 1 | -1, stop: number, limit: number): "SL" | "TP" | null => {
    const t0 = candles[i]!.ts; const t1 = t0 + stepMs;
    let lo = 0, hi = ltf.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ltf[m]!.ts < t0) lo = m + 1; else hi = m; }
    for (let j = lo; j < ltf.length && ltf[j]!.ts < t1; j++) {
      const b = ltf[j]!;
      const sH = dir === 1 ? b.low <= stop : b.high >= stop; const lH = dir === 1 ? b.high >= limit : b.low <= limit;
      if (sH && lH) return null;
      if (sH) return "SL"; if (lH) return "TP";
    }
    return null;
  };
  if (!ir.executable) throw new Error("IR is not executable: " + ir.diagnostics.map((d) => `${d.code} ${d.construct} @${d.line}:${d.col}`).join("; "));
  const rt = new PineRuntime(ir, candles, s.params, s.tickSize, { tickerid: meta.tickerid, timeframe: meta.timeframe, ...(meta.market ? { market: meta.market } : {}) });
  const tick = s.tickSize;
  const dec = Math.min(12, Math.max(0, Math.ceil(-Math.log10(tick)) + 1));
  const round = (p: number) => +(Math.round(p / tick) * tick).toFixed(dec);
  const regimes = detectRegimes(candles).regimes;
  const atrPct: (number | null)[] = [];
  { let a: number | null = null; const seed: number[] = [];
    candles.forEach((c, i) => { const p = candles[i - 1]; const tr = p ? Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)) : c.high - c.low;
      if (a === null) { seed.push(tr); if (seed.length === 14) a = seed.reduce((x, y) => x + y, 0) / 14; } else a = (a * 13 + tr) / 14;
      atrPct.push(a === null ? null : a / c.close); }); }
  const volSorted = atrPct.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const q = (f: number) => volSorted[Math.floor(f * (volSorted.length - 1))] ?? 0;
  const [v1, v2] = [q(1 / 3), q(2 / 3)];
  const volOf = (i: number) => { const v = atrPct[i]; return v == null ? "n/a" : v <= v1 ? "Low" : v <= v2 ? "Mid" : "High"; };

  let cash = s.initialCapital;
  let pos: Pos | null = null;
  const entries = new Map<string, PendingEntry>();
  const exits = new Map<string, ExitOrder>();
  let closes: { id: string | null }[] = [];
  const trades: Trade[] = [];
  const equity: { ts: number; eq: number }[] = [];
  const log: { bar: number; ts: number; event: string }[] = [];

  const comm = (px: number, qty: number) => s.commissionType === "percent" ? (px * qty * s.contractSize * s.commissionValue) / 100 : s.commissionType === "per_contract" ? qty * s.commissionValue : s.commissionValue;
  const fillPx = (raw: number, side: 1 | -1, slip: boolean) => round(raw + side * (s.spread / 2) + (slip ? side * s.slippageTicks * tick : 0));
  const view = (i: number): BrokerView => {
    const c = candles[i]!;
    const unreal = pos ? (c.close - pos.entryPx) * pos.dir * pos.qty * s.contractSize : 0;
    return { positionSize: pos ? pos.dir * pos.qty : 0, avgPrice: pos ? pos.entryPx : null, equity: cash + unreal, openTrades: pos ? 1 : 0 };
  };

  const closePos = (i: number, raw: number, slip: boolean, reason: Trade["reason"], exitId: string) => {
    if (!pos) return;
    const c = candles[i]!;
    const px = fillPx(raw, (-pos.dir) as 1 | -1, slip);
    const ec = comm(px, pos.qty);
    const gross = (px - pos.entryPx) * pos.dir * pos.qty * s.contractSize;
    const pnl = gross - pos.comm - ec;
    cash += gross - ec;
    const mfe = Math.max(0, (pos.best - pos.entryPx) * pos.dir, (px - pos.entryPx) * pos.dir);
    const mae = Math.max(0, (pos.entryPx - pos.worst) * pos.dir, (pos.entryPx - px) * pos.dir);
    const sig = pos.signalBar; const et = pos.entryTs;
    trades.push({
      n: trades.length + 1, dir: pos.dir === 1 ? "LONG" : "SHORT", entryId: pos.entryId, exitId, signalBar: sig, entryBar: pos.entryBar, exitBar: i,
      entryTs: et, exitTs: c.ts, entryPx: pos.entryPx, exitPx: px, qty: pos.qty, pnl, pnlPct: (pnl / (pos.entryPx * pos.qty * s.contractSize)) * 100,
      commission: pos.comm + ec, reason, bars: i - pos.entryBar, holdMs: c.ts - et, mfe, mae, mfePct: (mfe / pos.entryPx) * 100, maePct: (mae / pos.entryPx) * 100,
      hour: new Date(et).getUTCHours(), weekday: WD[new Date(et).getUTCDay()]!, month: new Date(et).toISOString().slice(0, 7), session: sessionOf(et),
      regime: regimes[sig] ?? "UNCERTAIN", volatility: volOf(sig),
    });
    log.push({ bar: i, ts: c.ts, event: `EXIT ${exitId} ${reason} @${px}` });
    pos = null;
    exits.clear();
  };

  const openPos = (i: number, o: PendingEntry, raw: number, slip: boolean) => {
    const c = candles[i]!;
    const px = fillPx(raw, o.dir, slip);
    const eq = view(i).equity;
    let qty: number;
    if (o.qty != null) qty = o.qty;
    else if (s.qtyType === "fixed") qty = s.qty;
    else if (s.qtyType === "percent_of_equity") qty = (eq * s.qty) / 100 / (px * s.contractSize);
    else {
      const ex = [...exits.values()].find((x) => (x.from === null || x.from === o.id) && x.stop !== null);
      const atrAbs = (atrPct[o.placed] ?? 0) * (candles[o.placed]?.close ?? px);
      const dist = ex?.stop != null ? Math.abs(px - ex.stop) : atrAbs * (s.riskAtrMult ?? 1.5);
      qty = dist > 0 ? (eq * s.qty) / 100 / (dist * s.contractSize) : 0;
    }
    if (s.integerQty) {
      const raw = qty; qty = Math.floor(qty + 1e-9);
      if (qty < 1 && raw > 0) { if (warnings.length < 50) warnings.push(`${new Date(c.ts).toISOString()}: risk sizing gave ${raw.toFixed(2)} contracts (<1) — entry skipped`); return; }
    }
    if (!(qty > 0)) return;
    qty = +qty.toFixed(8);
    const ec = comm(px, qty);
    cash -= ec;
    pos = { dir: o.dir, qty, entryPx: px, entryBar: i, signalBar: o.placed, entryTs: c.ts, entryId: o.id, comm: ec, best: px, worst: px };
    log.push({ bar: i, ts: c.ts, event: `ENTRY ${o.id} ${o.dir === 1 ? "LONG" : "SHORT"} @${px}` });
  };

  const fill = (i: number) => {
    const c = candles[i]!;
    // 1) market closes queued at previous bar close
    for (const cl of closes) if (pos && (cl.id === null || cl.id === pos.entryId)) closePos(i, c.open, true, "CLOSE", cl.id ?? "close_all");
    closes = [];
    // 2) entries
    for (const [id, o] of [...entries]) {
      let raw: number | null = null; let slip = true;
      if (o.limit === null && o.stop === null) raw = c.open;
      else if (o.stop !== null) { if (o.dir === 1 ? c.open >= o.stop : c.open <= o.stop) raw = c.open; else if (o.dir === 1 ? c.high >= o.stop : c.low <= o.stop) raw = o.stop; }
      else if (o.limit !== null) { slip = false; if (o.dir === 1 ? c.open <= o.limit : c.open >= o.limit) raw = c.open; else if (o.dir === 1 ? c.low <= o.limit : c.high >= o.limit) raw = o.limit; }
      if (o.limit === null && o.stop === null) entries.delete(id);
      if (raw === null) continue;
      entries.delete(id);
      if (pos && pos.dir === o.dir) continue; // pyramiding 0
      if (pos) closePos(i, raw, slip, "REVERSE", o.id);
      openPos(i, o, raw, slip);
    }
    // 3) exits for the open position
    const p = pos as Pos | null;
    if (!p) return;
    const ex = [...exits.values()].find((x) => x.from === null || x.from === p.entryId);
    if (ex) {
      let stop = ex.stop ?? (ex.loss !== null ? p.entryPx - p.dir * ex.loss * tick : null);
      const limit = ex.limit ?? (ex.profit !== null ? p.entryPx + p.dir * ex.profit * tick : null);
      let trailBinding = false;
      if (ex.trailPoints !== null && ex.trailOffset !== null && (p.best - p.entryPx) * p.dir >= ex.trailPoints * tick) {
        const ts = p.best - p.dir * ex.trailOffset * tick;
        if (stop === null || (ts - stop) * p.dir > 0) { stop = ts; trailBinding = true; }
      }
      const sr: Trade["reason"] = trailBinding ? "TRAIL" : "SL";
      if (stop !== null && (p.dir === 1 ? c.open <= stop : c.open >= stop)) return closePos(i, c.open, true, sr, ex.id);
      if (limit !== null && (p.dir === 1 ? c.open >= limit : c.open <= limit)) return closePos(i, c.open, false, "TP", ex.id);
      const sHit = stop !== null && (p.dir === 1 ? c.low <= stop : c.high >= stop);
      const lHit = limit !== null && (p.dir === 1 ? c.high >= limit : c.low <= limit);
      let first: "SL" | "TP" | null = sHit ? "SL" : lHit ? "TP" : null;
      if (sHit && lHit) {
        fillStats.ambiguousBars++;
        if (policy === "OPTIMISTIC_TP_FIRST") { first = "TP"; fillStats.tpFirst++; }
        else if (policy === "LOWER_TIMEFRAME_RESOLUTION") {
          const r = resolveLtf(i, p.dir, stop!, limit!);
          if (r) { first = r; fillStats.resolvedByLowerTf++; } else { first = "SL"; fillStats.unresolvedFallbackSlFirst++; }
        } else first = "SL";
      }
      if (first === "SL") { p.worst = p.dir === 1 ? Math.min(p.worst, stop!) : Math.max(p.worst, stop!); return closePos(i, stop!, true, sr, ex.id); }
      if (first === "TP") { p.best = p.dir === 1 ? Math.max(p.best, limit!) : Math.min(p.best, limit!); return closePos(i, limit!, false, "TP", ex.id); }
    }
    p.best = p.dir === 1 ? Math.max(p.best, c.high) : Math.min(p.best, c.low);
    p.worst = p.dir === 1 ? Math.min(p.worst, c.low) : Math.max(p.worst, c.high);
  };

  for (let i = 0; i < candles.length; i++) {
    if (i > 0) fill(i);
    let intents: OrderIntent[];
    try { intents = rt.step(i, view(i)); }
    catch (e) { if (e instanceof SemanticError) throw e; throw new SemanticError(0, (e as Error).message); }
    for (const it of intents) {
      if (it.kind === "entry") entries.set(it.id, { ...it, placed: i });
      else if (it.kind === "exit") exits.set(it.id, it);
      else if (it.kind === "close") closes.push({ id: it.id });
      else if (it.kind === "close_all") closes.push({ id: null });
      else if (it.kind === "cancel") { entries.delete(it.id); exits.delete(it.id); }
      else { entries.clear(); exits.clear(); }
    }
    equity.push({ ts: candles[i]!.ts, eq: view(i).equity });
  }
  const last = candles[candles.length - 1];
  const openTrade = pos && last ? { dir: (pos as Pos).dir === 1 ? "LONG" : "SHORT", entryTs: (pos as Pos).entryTs, entryPx: (pos as Pos).entryPx, markPx: last.close } : null;
    if (s.integerQty && candles.length) {
    const c0 = candles[candles.length - 1]!; const notional = c0.close * s.contractSize;
    const atr1 = (atrPct[candles.length - 1] ?? 0) * c0.close * s.contractSize;
    if (notional > s.initialCapital * 2) warnings.unshift(`EXCESSIVE_CONTRACT_EXPOSURE: 1 contract notional ≈ ${notional.toFixed(0)} vs capital ${s.initialCapital} (${(notional / s.initialCapital).toFixed(1)}×)`);
    if (atr1 > s.initialCapital * 0.02) warnings.unshift(`EXCESSIVE_CONTRACT_RISK: 1 ATR move on 1 contract ≈ ${atr1.toFixed(0)} = ${((atr1 / s.initialCapital) * 100).toFixed(1)}% of capital`);
  }
  return { trades, equity, openTrade, log: log.slice(-500), fillStats, warnings, metrics: computeMetrics(trades, equity, s.initialCapital, meta.periodsPerYear), breakdowns: breakdowns(trades) };
}

function group(trades: Trade[]) {
  const w = trades.filter((t) => t.pnl > 0); const l = trades.filter((t) => t.pnl <= 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0); const gl = -l.reduce((a, t) => a + t.pnl, 0);
  return { trades: trades.length, wins: w.length, losses: l.length, winRate: trades.length ? w.length / trades.length : 0, netPnl: gw - gl, profitFactor: gl > 0 ? gw / gl : gw > 0 ? null : 0, expectancy: trades.length ? (gw - gl) / trades.length : 0 };
}

export function computeMetrics(trades: Trade[], equity: { ts: number; eq: number }[], initial: number, periodsPerYear: number) {
  const g = group(trades);
  const w = trades.filter((t) => t.pnl > 0); const l = trades.filter((t) => t.pnl <= 0);
  let peak = initial; let maxDd = 0; let maxDdPct = 0;
  for (const e of equity) { peak = Math.max(peak, e.eq); maxDd = Math.max(maxDd, peak - e.eq); maxDdPct = Math.max(maxDdPct, peak > 0 ? (peak - e.eq) / peak : 0); }
  const daily = new Map<number, number>();
  for (const e of equity) daily.set(Math.floor(e.ts / 86_400_000), e.eq);
  const dv = [...daily.values()]; const rets: number[] = [];
  for (let i = 1; i < dv.length; i++) rets.push(dv[i]! / dv[i - 1]! - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const dd = rets.length ? Math.sqrt(rets.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / rets.length) : 0;
  const final = equity[equity.length - 1]?.eq ?? initial;
  const days = equity.length > 1 ? (equity[equity.length - 1]!.ts - equity[0]!.ts) / 86_400_000 : 0;
  const cagr = days > 0 && final > 0 ? (final / initial) ** (365 / days) - 1 : 0;
  let cw = 0; let cl = 0; let mcw = 0; let mcl = 0;
  for (const t of trades) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } mcw = Math.max(mcw, cw); mcl = Math.max(mcl, cl); }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const tp = trades.filter((t) => t.reason === "TP"); const sl = trades.filter((t) => t.reason === "SL" || t.reason === "TRAIL");
  const observedDays = days;
  const annualizationMethod = `daily equity returns (UTC), mean/sd × √${periodsPerYear}; CAGR = (final/initial)^(365/observedDays) − 1`;
  return {
    observedDays, annualizationMethod, sampleSizeTrades: trades.length, sampleSizeDailyReturns: rets.length,
    calmarLabel: observedDays < 365 ? "ANNUALIZED_ESTIMATE" : "OBSERVED",
    sharpeLabel: rets.length < 60 ? "ANNUALIZED_ESTIMATE_SMALL_SAMPLE" : "ANNUALIZED",
    ...g, netProfitPct: ((final - initial) / initial) * 100, finalEquity: final,
    avgWin: avg(w.map((t) => t.pnl)), avgLoss: avg(l.map((t) => t.pnl)),
    maxDrawdown: maxDd, maxDrawdownPct: maxDdPct * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null,
    sortino: dd > 0 ? (mean / dd) * Math.sqrt(periodsPerYear) : null,
    cagrPct: cagr * 100, calmar: maxDdPct > 0 ? cagr / maxDdPct : null,
    avgMfe: avg(trades.map((t) => t.mfe)), avgMae: avg(trades.map((t) => t.mae)), avgMfePct: avg(trades.map((t) => t.mfePct)), avgMaePct: avg(trades.map((t) => t.maePct)),
    avgHoldingBars: avg(trades.map((t) => t.bars)), avgHoldingMs: avg(trades.map((t) => t.holdMs)),
    avgTimeToTpMs: avg(tp.map((t) => t.holdMs)), avgTimeToSlMs: avg(sl.map((t) => t.holdMs)), tpExits: tp.length, slExits: sl.length,
    maxConsecutiveWins: mcw, maxConsecutiveLosses: mcl, totalCommission: trades.reduce((a, t) => a + t.commission, 0),
  };
}

export function breakdowns(trades: Trade[]) {
  const by = (key: (t: Trade) => string) => {
    const m = new Map<string, Trade[]>();
    for (const t of trades) { const k = key(t); m.set(k, [...(m.get(k) ?? []), t]); }
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, ts]) => ({ key: k, ...group(ts) }));
  };
  return {
    direction: by((t) => t.dir), hour: by((t) => String(t.hour).padStart(2, "0")), weekday: by((t) => t.weekday), month: by((t) => t.month),
    session: by((t) => t.session), volatility: by((t) => t.volatility), regime: by((t) => t.regime), exitReason: by((t) => t.reason),
  };
}
