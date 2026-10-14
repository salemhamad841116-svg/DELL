// Parameter sensitivity (pure). Sweeps each numeric input around its default, reruns the real
// backtester for every variant, and scores how stable the result is. No invented numbers.
import type { StrategyIR } from "../strategy/ir";
import { runProfessionalBacktest, type BacktestSettings } from "../strategy/backtester";
import type { Candle } from "../types";
import { performance } from "./quant";

export const SWEEP_STEPS = [-0.3, -0.15, 0, 0.15, 0.3];
export const MAX_SWEEP_INPUTS = 6;

export type Variant = { value: number; trades: number; netProfit: number; profitFactor: number | null; winRate: number | null };
export type InputSweep = { name: string; default: number; isInt: boolean; variants: Variant[]; stability: number };

/** Values to test for one numeric default (ints rounded, deduped, >0 kept when default >0). */
export function sweepValues(def: number, isInt: boolean): number[] {
  const out: number[] = [];
  for (const k of SWEEP_STEPS) {
    let v = def * (1 + k);
    if (isInt) v = Math.round(v);
    if (def > 0 && v <= 0) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Stability = share of variants that keep the base variant's sign of net profit (0..1). */
export function stabilityOf(variants: Variant[], base: Variant | undefined): number {
  if (!base || variants.length < 2) return 0;
  const sign = Math.sign(base.netProfit);
  const others = variants.filter((v) => v !== base);
  return others.filter((v) => Math.sign(v.netProfit) === sign && sign !== 0).length / others.length;
}

/** Overfit risk from sweeps: profitable base but neighbours mostly flip → HIGH. */
export function overfitFromSweeps(sweeps: InputSweep[]): "HIGH" | "MEDIUM" | "LOW" | "NO_NUMERIC_INPUTS" {
  if (!sweeps.length) return "NO_NUMERIC_INPUTS";
  const avg = sweeps.reduce((a, s) => a + s.stability, 0) / sweeps.length;
  return avg < 0.5 ? "HIGH" : avg < 0.75 ? "MEDIUM" : "LOW";
}

export function runSensitivity(ir: StrategyIR, candles: Candle[], settings: BacktestSettings, meta: Parameters<typeof runProfessionalBacktest>[3]) {
  const numeric = ir.inputs.filter((i) => typeof i.default === "number" && Number.isFinite(i.default) && i.default !== 0).slice(0, MAX_SWEEP_INPUTS);
  const sweeps: InputSweep[] = [];
  for (const inp of numeric) {
    const def = inp.default as number;
    const isInt = inp.kind === "input.int" || (Number.isInteger(def) && inp.kind !== "input.float");
    const variants: Variant[] = [];
    for (const value of sweepValues(def, isInt)) {
      try {
        const r = runProfessionalBacktest(ir, candles, { ...settings, params: { ...settings.params, [inp.name]: value } }, meta);
        const p = performance(r.trades, settings.initialCapital);
        variants.push({ value, trades: r.trades.length, netProfit: p.netPnl, profitFactor: p.profitFactor ?? null, winRate: p.winRate ?? null });
      } catch { /* variant that fails semantically is simply not reported */ }
    }
    const base = variants.find((v) => v.value === def);
    sweeps.push({ name: inp.name, default: def, isInt, variants, stability: stabilityOf(variants, base) });
  }
  return { sweeps, overfitRisk: overfitFromSweeps(sweeps), skipped: ir.inputs.length - numeric.length };
}
export type SensitivityReport = ReturnType<typeof runSensitivity>;

/** Walk-forward parameter selection: for each of `folds` rolling windows, pick the best value of every
 *  swept input on the in-sample slice (by net profit) and score it on the following unseen slice. */
export function runWalkForward(ir: StrategyIR, candles: Candle[], settings: BacktestSettings, meta: Parameters<typeof runProfessionalBacktest>[3], folds = 4) {
  const numeric = ir.inputs.filter((i) => typeof i.default === "number" && Number.isFinite(i.default) && i.default !== 0).slice(0, MAX_SWEEP_INPUTS);
  const seg = Math.floor(candles.length / (folds + 1));
  const run = (cs: Candle[], params: Record<string, unknown>) => {
    try { const r = runProfessionalBacktest(ir, cs, { ...settings, params: { ...settings.params, ...params } }, meta); return performance(r.trades, settings.initialCapital); } catch { return null; }
  };
  const rounds: { fold: number; chosen: Record<string, number>; isNet: number | null; oosNet: number | null; oosTrades: number; defaultOosNet: number | null }[] = [];
  if (seg < 50) return { status: "INSUFFICIENT_DATA" as const, rounds, efficiency: null };
  for (let k = 0; k < folds; k++) {
    const is = candles.slice(k * seg, (k + 1) * seg); const oos = candles.slice((k + 1) * seg, (k + 2) * seg);
    const chosen: Record<string, number> = {};
    for (const inp of numeric) {
      const def = inp.default as number; const isInt = inp.kind === "input.int" || (Number.isInteger(def) && inp.kind !== "input.float");
      let best = def, bestNet = -Infinity;
      for (const v of sweepValues(def, isInt)) { const p = run(is, { ...chosen, [inp.name]: v }); if (p && p.netPnl > bestNet) { bestNet = p.netPnl; best = v; } }
      chosen[inp.name] = best;
    }
    const pi = run(is, chosen), po = run(oos, chosen), pd = run(oos, {});
    rounds.push({ fold: k + 1, chosen, isNet: pi?.netPnl ?? null, oosNet: po?.netPnl ?? null, oosTrades: po?.trades ?? 0, defaultOosNet: pd?.netPnl ?? null });
  }
  const isSum = rounds.reduce((a, r) => a + (r.isNet ?? 0), 0), oosSum = rounds.reduce((a, r) => a + (r.oosNet ?? 0), 0);
  return { status: "OK" as const, rounds, efficiency: isSum > 0 ? oosSum / isSum : null };
}
