// Golden semantic suite — every build must reproduce these exact entries/exits/prices/metrics.
// Fixtures are real Binance BTCUSDT klines snapshots (no synthetic candles).
// Regenerate expectations deliberately with: UPDATE_GOLDEN=1 bunx vitest run src/lib/use/strategy
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Candle } from "../types";
import { buildIR } from "./ir";
import { runProfessionalBacktest, type BacktestSettings } from "./backtester";
import { PineRuntime, htfBucket } from "./executor";
import { parsePine } from "./pine";

const DIR = join(__dirname, "__golden__");
const load = (f: string): Candle[] => (JSON.parse(readFileSync(join(DIR, f), "utf8")).bars as number[][]).map(([ts, o, h, l, c, v]) => ({ ts: ts!, open: o!, high: h!, low: l!, close: c!, volume: v! }));
const H1 = load("btcusdt-1h-2026-08.json");
const M1 = load("btcusdt-1m-2026-08-20_22.json");
const STRATS = ["ema_cross", "rsi_threshold", "pivot_atr_state", "mtf_security", "trailing_stop", "limit_stop_entry", "session_filter", "persistent_state"];
const SETTINGS: BacktestSettings = { initialCapital: 10000, qtyType: "percent_of_equity", qty: 100, contractSize: 1, tickSize: 0.01, spread: 0, slippageTicks: 0, commissionType: "percent", commissionValue: 0.04, params: {}, fillPolicy: "CONSERVATIVE_SL_FIRST" };
const META = { tickerid: "BTCUSDT", timeframe: "1h", periodsPerYear: 365, market: "crypto", chartStepMs: 3_600_000 };
const code = (n: string) => readFileSync(join(DIR, "strategies", `${n}.pine`), "utf8");
const snap = (r: ReturnType<typeof runProfessionalBacktest>) => ({
  tradeCount: r.trades.length,
  trades: r.trades.map((t) => [t.dir, t.entryId, t.entryTs, t.entryPx, t.exitTs, t.exitPx, t.reason, +t.pnl.toFixed(6)]),
  metrics: Object.fromEntries(["trades", "wins", "losses", "winRate", "profitFactor", "expectancy", "maxDrawdownPct", "netProfitPct", "maxConsecutiveWins", "maxConsecutiveLosses"].map((k) => { const v = (r.metrics as Record<string, unknown>)[k]; return [k, typeof v === "number" ? +v.toFixed(8) : v]; })),
});

describe("golden strategies", () => {
  for (const name of STRATS) {
    it(`${name}: IR executable and exact golden reproduction`, async () => {
      const ir = await buildIR(code(name), { language: "pinescript" });
      expect(ir.diagnostics).toEqual([]);
      expect(ir.executable).toBe(true);
      const r = runProfessionalBacktest(ir, H1, SETTINGS, META);
      const s = snap(r);
      expect(s.tradeCount).toBeGreaterThan(0);
      const file = join(DIR, "expected", `${name}.json`);
      if (process.env["UPDATE_GOLDEN"] || !existsSync(file)) writeFileSync(file, JSON.stringify(s, null, 1));
      expect(s).toEqual(JSON.parse(readFileSync(file, "utf8")));
      // determinism: second run identical
      expect(snap(runProfessionalBacktest(ir, H1, SETTINGS, META))).toEqual(s);
    });

    it(`${name}: no lookahead — truncating future candles never changes the past`, async () => {
      const ir = await buildIR(code(name), { language: "pinescript" });
      const k = 500;
      const full = runProfessionalBacktest(ir, H1, SETTINGS, META).trades.filter((t) => t.exitBar < k - 1);
      const cut = runProfessionalBacktest(ir, H1.slice(0, k), SETTINGS, META).trades.filter((t) => t.exitBar < k - 1);
      expect(cut.map((t) => [t.entryTs, t.entryPx, t.exitTs, t.exitPx])).toEqual(full.map((t) => [t.entryTs, t.entryPx, t.exitTs, t.exitPx]));
    });
  }
});

describe("MTF leakage", () => {
  const src = `//@version=6\nstrategy("mtf probe")\nlen = input.int(5, "len")\nhc = request.security(syminfo.tickerid, "240", close)\nhe = request.security(syminfo.tickerid, "240", ta.sma(close, len))\nif false\n    strategy.entry("L", strategy.long)`;
  const series = async (candles: Candle[]) => {
    const ir = await buildIR(src, { language: "pinescript" });
    const rt = new PineRuntime(ir, candles, {}, 0.01, { tickerid: "BTCUSDT", timeframe: "1h", market: "crypto" });
    return candles.map((_, i) => { rt.step(i, { positionSize: 0, avgPrice: null, equity: 0, openTrades: 0 }); return [rt.valueAt("hc", i), rt.valueAt("he", i)]; });
  };

  it("HTF value at bar i is the close of the last 4h bucket fully closed by bar i's close", async () => {
    const v = await series(H1);
    H1.forEach((c, i) => {
      const closeT = c.ts + 3_600_000;
      const done = H1.filter((x) => htfBucket(x.ts, "4h", 14400)[1] <= closeT);
      const expected = done.length ? done[done.length - 1]!.close : null;
      expect(v[i]![0]).toBe(expected);
    });
  });

  it("HTF value only changes on bars that close a 4h bucket (never mid-bucket)", async () => {
    const v = await series(H1);
    for (let i = 1; i < H1.length; i++) if (v[i]![0] !== v[i - 1]![0]) expect((H1[i]!.ts + 3_600_000) % 14_400_000).toBe(0);
  });

  it("perturbing future candles never alters past HTF values", async () => {
    const k = 400;
    const base = await series(H1);
    const bumped = H1.map((c, i) => (i > k ? { ...c, open: c.open * 1.1, high: c.high * 1.1, low: c.low * 1.1, close: c.close * 1.1 } : c));
    const alt = await series(bumped);
    expect(alt.slice(0, k + 1)).toEqual(base.slice(0, k + 1));
  });

  it("lookahead_on and lower-TF requests are rejected with exact locations", async () => {
    const ir = await buildIR(`//@version=6\nstrategy("x")\na = request.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on)\nb = request.security_lower_tf(syminfo.tickerid, "1", close)\nif a > 0\n    strategy.entry("L", strategy.long)`);
    expect(ir.executable).toBe(false);
    expect(ir.diagnostics.map((d) => [d.code, d.line])).toEqual([["UNSUPPORTED_SEMANTIC", 3], ["UNSUPPORTED_SEMANTIC", 4]]);
  });
});

describe("parser diagnostics", () => {
  it("unsupported constructs carry line:col", async () => {
    const ir = await buildIR(`//@version=6\nstrategy("x")\nswitch x\n    1 => 2\nm = array.new_float(0)\nif close > open\n    strategy.entry("L", strategy.long)`);
    expect(ir.diagnostics.some((d) => d.construct === "switch" && d.line === 3 && d.col === 1)).toBe(true);
    expect(ir.diagnostics.some((d) => d.construct.includes("array.new_float") && d.line === 5)).toBe(true);
  });
  it("functions, loops and tuple returns parse", () => {
    const r = parsePine(`f(a, b) =>\n    s = 0.0\n    for i = 0 to 3\n        s += a\n    [s, b]\n[x, y] = f(1, 2)`);
    expect(r.diagnostics).toEqual([]);
    expect(r.program.map((s) => s.k)).toEqual(["fn", "tuple"]);
  });
});

describe("same-bar TP/SL fill policy", () => {
  // Strategy with wide-range bars → TP and SL both touched in the same 1h bar.
  const src = `//@version=6\nstrategy("amb")\nif strategy.position_size == 0\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", profit=15000, loss=15000)`;
  const chart = M1.reduce<Candle[]>((acc, c) => {
    const t = Math.floor(c.ts / 3_600_000) * 3_600_000; const l = acc[acc.length - 1];
    if (!l || l.ts !== t) acc.push({ ...c, ts: t }); else { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; l.volume = (l.volume ?? 0) + (c.volume ?? 0); }
    return acc;
  }, []);
  it("policies differ only on ambiguous bars; LTF resolution uses real 1m path", async () => {
    const ir = await buildIR(src);
    const run = (p: NonNullable<BacktestSettings["fillPolicy"]>) => runProfessionalBacktest(ir, chart, { ...SETTINGS, fillPolicy: p }, { ...META, ltf: M1 });
    const c = run("CONSERVATIVE_SL_FIRST"); const o = run("OPTIMISTIC_TP_FIRST"); const l = run("LOWER_TIMEFRAME_RESOLUTION");
    expect(c.fillStats.ambiguousBars).toBeGreaterThan(0);
    expect(l.fillStats.resolvedByLowerTf + l.fillStats.unresolvedFallbackSlFirst).toBe(l.fillStats.ambiguousBars);
    expect(c.trades.filter((t) => t.reason === "TP").length).toBeLessThanOrEqual(o.trades.filter((t) => t.reason === "TP").length);
    // LTF result must match a manual 1m walk for every resolved ambiguous trade
    for (const t of l.trades) {
      const bars = M1.filter((m) => m.ts >= chart[t.exitBar]!.ts && m.ts < chart[t.exitBar]!.ts + 3_600_000);
      const sl = t.entryPx - 150; const tp = t.entryPx + 150;
      const first = bars.find((b) => b.low <= sl || b.high >= tp);
      if (first && !(first.low <= sl && first.high >= tp) && t.exitBar !== t.entryBar) expect(t.reason).toBe(first.low <= sl ? "SL" : "TP");
    }
  });
});
