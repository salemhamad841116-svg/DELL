// Indicator Historical Pattern Analyzer — pure, deterministic, no I/O.
// Contract:
//  - Level values are the indicator's OWN series as they existed on each bar (computed bar-by-bar by the
//    semantic engine from candles[0..i]); nothing is recomputed with future data.
//  - An event starts on a bar whose [low, high] contains the source level of THAT bar.
//  - Target is reached on a later bar whose range crosses the target level of THAT bar.
//  - If the touch bar also crosses the target, OHLC cannot tell the order → resolved with real
//    lower-timeframe (1m) candles when available, otherwise AMBIGUOUS (excluded from the success rate).
//  - Next-candle stats use only events whose touch bar AND next bar are fully closed.

import type { Candle } from "../types";
import { labelMove, type Direction } from "../forecast/core";
import { wilson } from "../forecast/reliability";

export const PATTERN_MODEL_VERSION = "pattern-freq-1.0.0";

export type WindowRule = { kind: "SAME_CLOCK_HOUR" } | { kind: "MINUTES"; minutes: number };
export type PatternConfig = { source: string; target: string; window: WindowRule };
export type Outcome = "SUCCESS" | "FAILED" | "EXPIRED_INCOMPLETE" | "AMBIGUOUS";

export type PatternEvent = {
  touchTs: number; touchIso: string; sourceLevel: number;
  outcome: Outcome; resolvedBy: "OHLC" | "LOWER_TF_1M" | null;
  reachTs: number | null; reachIso: string | null; targetLevel: number | null;
  minutesToTarget: number | null; deadlineIso: string;
  hour: number; weekday: number;
  nextBar: { ts: number; close: number; direction: Direction } | null;
  note?: string;
};

const crosses = (c: { high: number; low: number }, lvl: number) => c.low <= lvl && lvl <= c.high;
const reaches = (c: { high: number; low: number }, lvl: number, below: boolean) => (below ? c.low <= lvl : c.high >= lvl);

function deadline(ts: number, w: WindowRule): number {
  if (w.kind === "SAME_CLOCK_HOUR") return Math.floor(ts / 3_600_000) * 3_600_000 + 3_600_000;
  return ts + w.minutes * 60_000;
}

/** Order inside one ambiguous bar using real 1m candles only. */
function resolveIntrabar(m1: Candle[], barTs: number, tfMs: number, src: number, tgt: number, below: boolean): { ok: boolean; reachTs: number | null } | null {
  const inside = m1.filter((c) => c.ts >= barTs && c.ts < barTs + tfMs);
  if (inside.length < Math.round(tfMs / 60_000)) return null; // incomplete 1m coverage → cannot resolve
  let touched = false;
  for (const c of inside) {
    const s = crosses(c, src), t = reaches(c, tgt, below);
    if (!touched) {
      if (s && t) return null; // same 1m bar: still unknown
      if (s) touched = true;
      continue; // target before source touch is not an occurrence of this pattern
    }
    if (t) return { ok: true, reachTs: c.ts };
  }
  return touched ? { ok: false, reachTs: null } : null;
}

export function analyzePattern(candles: Candle[], tfMs: number, names: string[], values: number[][], cfg: PatternConfig, opts: { now: number; atr: (number | null)[]; m1?: Candle[] | undefined }) {
  const si = names.indexOf(cfg.source), ti = names.indexOf(cfg.target);
  if (si < 0 || ti < 0) return { error: `Series not found: ${si < 0 ? cfg.source : ""} ${ti < 0 ? cfg.target : ""}`.trim(), events: [] as PatternEvent[] };
  const S = values[si]!, T = values[ti]!;
  const events: PatternEvent[] = [];
  let i = 1;
  while (i < candles.length) {
    const c = candles[i]!, prev = candles[i - 1]!;
    const src = S[i], prevSrc = S[i - 1];
    // Fresh touch only: the previous bar did not already touch the (then-current) source level.
    if (!Number.isFinite(src) || !crosses(c, src!) || (Number.isFinite(prevSrc) && crosses(prev, prevSrc!))) { i++; continue; }
    const tgt0 = T[i];
    if (!Number.isFinite(tgt0)) { i++; continue; }
    const below = tgt0! < src!;
    const dl = deadline(c.ts, cfg.window);
    const nb = candles[i + 1] && candles[i + 1]!.ts + tfMs <= opts.now ? candles[i + 1]! : null;
    const ev: PatternEvent = {
      touchTs: c.ts, touchIso: new Date(c.ts).toISOString(), sourceLevel: src!, outcome: "FAILED", resolvedBy: "OHLC",
      reachTs: null, reachIso: null, targetLevel: null, minutesToTarget: null, deadlineIso: new Date(dl).toISOString(),
      hour: new Date(c.ts).getUTCHours(), weekday: new Date(c.ts).getUTCDay(),
      nextBar: nb ? { ts: nb.ts, close: nb.close, direction: labelMove(c.close, nb.close, opts.atr[i] ?? null) } : null,
    };
    let j = i;
    if (reaches(c, tgt0!, below)) {
      const r = opts.m1 ? resolveIntrabar(opts.m1, c.ts, tfMs, src!, tgt0!, below) : null;
      if (!r) { ev.outcome = "AMBIGUOUS"; ev.resolvedBy = null; ev.note = opts.m1 ? "1m data incomplete or both levels in the same 1m bar" : "no 1m data"; }
      else if (r.ok) { ev.outcome = "SUCCESS"; ev.resolvedBy = "LOWER_TF_1M"; ev.reachTs = r.reachTs; ev.targetLevel = tgt0!; }
      else ev.resolvedBy = "LOWER_TF_1M"; // touched source, target not hit later inside the bar → continue scanning
    }
    if (ev.outcome === "FAILED") {
      for (j = i + 1; j < candles.length && candles[j]!.ts < dl; j++) {
        const t = T[j]; const k = candles[j]!;
        if (Number.isFinite(t) && reaches(k, t!, below)) { ev.outcome = "SUCCESS"; ev.reachTs = k.ts; ev.targetLevel = t!; break; }
      }
      // Window not fully observed with closed bars → not a failure yet.
      if (ev.outcome === "FAILED" && (j >= candles.length || candles[candles.length - 1]!.ts + tfMs < dl)) {
        if (candles[candles.length - 1]!.ts + tfMs < dl) ev.outcome = "EXPIRED_INCOMPLETE";
      }
    }
    if (ev.reachTs !== null) { ev.reachIso = new Date(ev.reachTs).toISOString(); ev.minutesToTarget = (ev.reachTs - c.ts) / 60_000; }
    events.push(ev);
    i = Math.max(i + 1, j + 1); // one event at a time: next search after this event resolves
  }
  return { error: null as string | null, events };
}

export function summarize(events: PatternEvent[]) {
  const decided = events.filter((e) => e.outcome === "SUCCESS" || e.outcome === "FAILED");
  const ok = decided.filter((e) => e.outcome === "SUCCESS");
  const group = (key: (e: PatternEvent) => number, n: number) => Array.from({ length: n }, (_, k) => {
    const d = decided.filter((e) => key(e) === k); const s = d.filter((e) => e.outcome === "SUCCESS").length;
    return { key: k, touches: events.filter((e) => key(e) === k).length, decided: d.length, success: s, rate: d.length ? s / d.length : null };
  }).filter((g) => g.touches > 0);
  const mins = ok.map((e) => e.minutesToTarget!).sort((a, b) => a - b);
  return {
    touches: events.length, success: ok.length,
    failed: events.filter((e) => e.outcome === "FAILED").length,
    expired: events.filter((e) => e.outcome === "EXPIRED_INCOMPLETE").length,
    ambiguous: events.filter((e) => e.outcome === "AMBIGUOUS").length,
    resolvedBy1m: events.filter((e) => e.resolvedBy === "LOWER_TF_1M").length,
    successRate: decided.length ? ok.length / decided.length : null,
    successCI: decided.length ? wilson(ok.length, decided.length) : null,
    avgMinutes: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null,
    medianMinutes: mins.length ? mins[Math.floor(mins.length / 2)]! : null,
    byHour: group((e) => e.hour, 24), byWeekday: group((e) => e.weekday, 7),
  };
}

export const PATTERN_MIN_SAMPLES = 30;

/** Next-candle probabilities conditioned on the pattern (source touch), with a chronological hold-out check. */
export function nextCandleFromPattern(events: PatternEvent[], minConf: number) {
  const s = events.filter((e) => e.nextBar);
  const freq = (arr: PatternEvent[]) => {
    const c = { UP: 0, DOWN: 0, NEUTRAL: 0 }; arr.forEach((e) => c[e.nextBar!.direction]++);
    const n = arr.length; // Laplace smoothing (+1) so tiny samples never give 0%/100%
    return { up: (c.UP + 1) / (n + 3), down: (c.DOWN + 1) / (n + 3), neutral: (c.NEUTRAL + 1) / (n + 3), counts: c, n };
  };
  const all = freq(s);
  const split = Math.floor(s.length * 0.7);
  const train = freq(s.slice(0, split)), test = s.slice(split);
  const pick = (p: { up: number; down: number; neutral: number }): Direction => (p.up >= p.down && p.up >= p.neutral ? "UP" : p.down >= p.neutral ? "DOWN" : "NEUTRAL");
  const trainPick = pick(train);
  const hits = test.filter((e) => e.nextBar!.direction === trainPick).length;
  const tc = { UP: 0, DOWN: 0, NEUTRAL: 0 }; test.forEach((e) => tc[e.nextBar!.direction]++);
  const baseline = test.length ? Math.max(tc.UP, tc.DOWN, tc.NEUTRAL) / test.length : 0;
  const holdout = { samples: test.length, pick: trainPick, accuracy: test.length ? hits / test.length : null, ci: test.length ? wilson(hits, test.length) : null, baselineUniform: 1 / 3, baselineMajority: baseline };
  const winner = pick(all);
  const pw = winner === "UP" ? all.up : winner === "DOWN" ? all.down : all.neutral;
  const checks = [
    { name: `Comparable samples ≥ ${PATTERN_MIN_SAMPLES}`, pass: s.length >= PATTERN_MIN_SAMPLES, detail: `${s.length}` },
    { name: "Hold-out (last 30%, chronological) agrees with the direction", pass: trainPick === winner && test.length >= 10, detail: `train pick ${trainPick}, full pick ${winner}, hold-out n=${test.length}` },
    { name: "Hold-out accuracy 95% CI low > 1/3 (uniform baseline)", pass: !!holdout.ci && holdout.ci.lo > 1 / 3, detail: holdout.ci ? `${(holdout.ci.lo * 100).toFixed(1)}%` : "n/a" },
    { name: `Winner probability ≥ ${(minConf * 100).toFixed(0)}%`, pass: pw >= minConf, detail: `${(pw * 100).toFixed(1)}%` },
  ];
  const failed = checks.find((c) => !c.pass);
  const signal = winner === "NEUTRAL" && !failed ? "NEUTRAL" : failed ? "NO_SIGNAL" : winner;
  return { probabilities: { up: all.up, down: all.down, neutral: all.neutral }, counts: all.counts, samples: s.length, winner, confidence: pw, holdout, checks, signal, reason: failed ? `${failed.name} — failed (${failed.detail})` : null };
}
