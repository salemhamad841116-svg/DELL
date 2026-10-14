// Pine export for a verified historical pattern. Appends a documented block to an UNCHANGED copy
// of the original indicator. Probabilities are frozen server statistics, not re-estimated in Pine.
import type { PatternConfig } from "./analyzer";

export const PATTERN_PINE_MARKER = "// ===== Historical Pattern → Next Candle (Market Compass) =====";

export function patternPine(orig: string, cfg: PatternConfig, s: {
  symbol: string; timeframe: string; provider: string | null; from: string; to: string;
  samples: number; up: number; down: number; neutral: number; signal: string; reachRate: number | null; decided: number; minConf: number; alerts: boolean;
}): string {
  const f = (v: number) => v.toFixed(6);
  const win = cfg.window.kind === "SAME_CLOCK_HOUR" ? "same clock hour (UTC)" : `${cfg.window.minutes} minutes`;
  const sig = s.signal === "NO_SIGNAL" ? "NO SIGNAL" : s.signal;
  return `${orig.trimEnd()}

${PATTERN_PINE_MARKER}
// Symbol ${s.symbol} · Timeframe ${s.timeframe} · Provider ${s.provider ?? "?"} · History ${s.from} → ${s.to} (UTC)
// Pattern: fresh touch of ${cfg.source}; target ${cfg.target} within ${win}.
// Frozen server statistics: ${s.samples} comparable touches · reach-target rate ${s.reachRate === null ? "n/a" : (s.reachRate * 100).toFixed(1) + "%"} (${s.decided} decided)
// Next candle after a touch: UP ${(s.up * 100).toFixed(1)}% · DOWN ${(s.down * 100).toFixed(1)}% · NEUTRAL ${(s.neutral * 100).toFixed(1)}% → ${sig}
// DIFFERENCES vs server model:
//  1) Probabilities are constants copied from the server; Pine does not re-estimate them on new bars.
//  2) Server resolves same-bar source+target touches with 1m candles; Pine only sees chart OHLC.
//  3) TradingView's data feed may differ from ${s.provider ?? "the server provider"}; touches can differ by feed.
//  4) Server gating (samples, chronological hold-out, min confidence ${(s.minConf * 100).toFixed(0)}%) is applied once; result is baked in.
// Lookahead OFF · Repaint NO (signal is evaluated only on confirmed bars).
pc_touch = barstate.isconfirmed and low <= ${cfg.source} and high >= ${cfg.source} and not (low[1] <= ${cfg.source}[1] and high[1] >= ${cfg.source}[1])
pc_up = ${f(s.up)}
pc_dn = ${f(s.down)}
pc_ne = ${f(s.neutral)}
pc_signal = "${sig}"
plotshape(pc_touch, title="Pattern touch", style=shape.circle, location=location.abovebar, color=color.orange, size=size.tiny)
plot(pc_touch ? pc_up : na, title="Pattern P(UP)", display=display.data_window)
plot(pc_touch ? pc_dn : na, title="Pattern P(DOWN)", display=display.data_window)
plot(pc_touch ? pc_ne : na, title="Pattern P(NEUTRAL)", display=display.data_window)
${s.alerts ? `alertcondition(pc_touch, title="Pattern touch", message="${cfg.source} touched — next candle historical call: ${sig}")\n` : ""}`;
}
