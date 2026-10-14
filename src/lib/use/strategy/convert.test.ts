// Converter acceptance: EMA crossover, RSI threshold, Pivot/ATR state indicators → separate strategy copies
// that execute on real Binance candles; ambiguous indicators yield NO_CLEAR_TRADING_RULES_DETECTED.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Candle } from "../types";
import { buildIR } from "./ir";
import { runProfessionalBacktest, type BacktestSettings } from "./backtester";
import { defaultLevel, extractCandidates, generateStrategy, type ConvertConfig, type Rule } from "./convert";

const DIR = join(__dirname, "__golden__");
const H1: Candle[] = (JSON.parse(readFileSync(join(DIR, "btcusdt-1h-2026-08.json"), "utf8")).bars as number[][]).map(([ts, o, h, l, c, v]) => ({ ts: ts!, open: o!, high: h!, low: l!, close: c!, volume: v! }));
const SETTINGS: BacktestSettings = { initialCapital: 10000, qtyType: "percent_of_equity", qty: 100, contractSize: 1, tickSize: 0.01, spread: 0, slippageTicks: 0, commissionType: "percent", commissionValue: 0.04, params: {}, fillPolicy: "CONSERVATIVE_SL_FIRST" };
const META = { tickerid: "BTCUSDT", timeframe: "1h", periodsPerYear: 365, market: "crypto", chartStepMs: 3_600_000 };

const EMA = `//@version=6
indicator("EMA Cross", overlay=true)
emaFast = ta.ema(close, 9)
emaSlow = ta.ema(close, 21)
bullSignal = ta.crossover(emaFast, emaSlow)
bearSignal = ta.crossunder(emaFast, emaSlow)
plot(emaFast)
plot(emaSlow)
`;
const RSI = `//@version=6
indicator("RSI Zones")
rsi = ta.rsi(close, 14)
plot(rsi)
alertcondition(rsi < 30, "Oversold buy", "RSI oversold")
alertcondition(rsi > 70, "Overbought sell", "RSI overbought")
`;
const PIVOT = `//@version=6
indicator("Pivot ATR State", overlay=true)
a = ta.atr(14)
ph = ta.pivothigh(high, 5, 5)
pl = ta.pivotlow(low, 5, 5)
var float lastHigh = na
var float lastLow = na
var int state = 0
if not na(ph)
    lastHigh := ph
if not na(pl)
    lastLow := pl
prevState = state
if state == 0 and close > lastHigh
    state := 1
else if state == 0 and close < lastLow
    state := -1
else if state != 0 and ((state == 1 and close < lastLow) or (state == -1 and close > lastHigh))
    state := 0
longStart = state == 1 and prevState != 1
shortStart = state == -1 and prevState != -1
plotshape(longStart, title="Long", location=location.belowbar)
plotshape(shortStart, title="Short", location=location.abovebar)
`;
// Persistent drawing objects (var line / var label, := reassignment, .new/.delete, na init)
// must parse cleanly: they are chart-only and never block conversion.
const DRAW = `//@version=5
indicator("Pivot Levels Lines", overlay=true)
var line lineP0 = na
var line lineR1 = na
var line lineR2 = na
var line lineR3 = na
var line lineS1 = na
var line lineS2 = na
var line lineS3 = na
var label labelR1 = na
line tmpLine = na
p = (high[1] + low[1] + close[1]) / 3
r1 = 2 * p - low[1]
s1 = 2 * p - high[1]
if barstate.islast
    line.delete(lineR1)
    lineR1 := line.new(bar_index - 1, r1, bar_index, r1, color=color.red)
    line.delete(lineS1)
    lineS1 := line.new(bar_index - 1, s1, bar_index, s1, color=color.green)
    label.delete(labelR1)
    labelR1 := label.new(bar_index, r1, "R1")
bullBreak = ta.crossover(close, r1)
bearBreak = ta.crossunder(close, s1)
plotshape(bullBreak, title="Bull", location=location.belowbar)
plotshape(bearBreak, title="Bear", location=location.abovebar)
plot(p)
`;
const VAGUE = `//@version=6
indicator("Just MAs", overlay=true)
m = ta.sma(close, 50)
plot(m)
`;

const base = (): ConvertConfig => ({ buy: [], sell: [], exit: [], tp: defaultLevel(), sl: defaultLevel(), direction: "BOTH", allowReentry: true, onePosition: false, pyramiding: 0, trailing: { enabled: false, points: 0, offset: 0 }, breakEven: { enabled: false, triggerTicks: 0 }, partialExit: { enabled: false, percent: 50 }, orderType: "MARKET", orderOffsetTicks: 0, fillTiming: "NEXT_BAR_OPEN" });
const accept = (src: string): ConvertConfig => {
  const ex = extractCandidates(src);
  const cfg = base();
  for (const c of ex.candidates) {
    const r: Rule = { expression: c.expression, line: c.line, original: c.original, confidence: c.confidence, source: "DETECTED" };
    if (c.suggested === "BUY") cfg.buy.push(r); else if (c.suggested === "SELL") cfg.sell.push(r); else if (c.suggested === "EXIT") cfg.exit.push(r);
  }
  return cfg;
};
async function runOk(src: string, cfg: ConvertConfig) {
  const g = generateStrategy(src, cfg);
  expect(g.blockers).toEqual([]);
  const ir = await buildIR(g.code, { language: "pinescript" });
  expect(ir.diagnostics).toEqual([]);
  expect(ir.executable).toBe(true);
  const r = runProfessionalBacktest(ir, H1, SETTINGS, META);
  expect(r.trades.length).toBeGreaterThan(0);
  return { g, r };
}

describe("indicator → strategy converter", () => {
  it("EMA crossover: detects bull/bear crosses and runs", async () => {
    const ex = extractCandidates(EMA);
    expect(ex.status).toBe("CANDIDATES_DETECTED");
    expect(ex.candidates.find((c) => c.name === "bullSignal")?.suggested).toBe("BUY");
    expect(ex.candidates.find((c) => c.name === "bearSignal")?.suggested).toBe("SELL");
    await runOk(EMA, accept(EMA));
  });
  it("RSI threshold: detects oversold/overbought and runs with ATR TP/SL", async () => {
    const ex = extractCandidates(RSI);
    expect(ex.candidates.find((c) => c.expression === "rsi < 30")?.suggested).toBe("BUY");
    expect(ex.candidates.find((c) => c.expression === "rsi > 70")?.suggested).toBe("SELL");
    const cfg = accept(RSI);
    cfg.tp = { ...defaultLevel(), mode: "ATR", value: 2, atrLength: 14 };
    cfg.sl = { ...defaultLevel(), mode: "ATR", value: 1, atrLength: 14 };
    cfg.allowReentry = false;
    await runOk(RSI, cfg);
  });
  it("Pivot/ATR state: detects state transitions, runs with percent SL + break-even", async () => {
    const ex = extractCandidates(PIVOT);
    expect(ex.candidates.find((c) => c.name === "longStart")?.suggested).toBe("BUY");
    expect(ex.candidates.find((c) => c.name === "shortStart")?.suggested).toBe("SELL");
    expect(ex.levels.map((l) => l.name)).toEqual(expect.arrayContaining(["ph", "pl"]));
    const cfg = accept(PIVOT);
    cfg.sl = { ...defaultLevel(), mode: "PERCENT", value: 1 };
    cfg.breakEven = { enabled: true, triggerTicks: 50000 };
    cfg.onePosition = true;
    const { g } = await runOk(PIVOT, cfg);
    expect(g.code.startsWith(PIVOT.replace('indicator("Pivot ATR State", overlay=true)', 'strategy("Pivot ATR State", overlay=true, pyramiding=0)').trimEnd())).toBe(true);
  });
  it("var line / var label drawing objects parse and convert", async () => {
    const ir0 = await buildIR(DRAW, { language: "pinescript" });
    expect(ir0.diagnostics).toEqual([]);
    expect(ir0.validity).toBe("VALID_INDICATOR");
    const ex = extractCandidates(DRAW);
    expect(ex.sourceDiagnostics).toEqual([]);
    expect(ex.candidates.find((c) => c.name === "bullBreak")?.suggested).toBe("BUY");
    expect(ex.candidates.find((c) => c.name === "bearBreak")?.suggested).toBe("SELL");
    const cfg = accept(DRAW);
    cfg.tp = { ...defaultLevel(), mode: "ATR", value: 2, atrLength: 14 };
    cfg.sl = { ...defaultLevel(), mode: "ATR", value: 1, atrLength: 14 };
    cfg.allowReentry = false; cfg.onePosition = true;
    const { g } = await runOk(DRAW, cfg);
    expect(/^\s*strategy\s*\(/m.test(g.code)).toBe(true);
    expect(/^\s*indicator\s*\(/m.test(g.code)).toBe(false);
    expect(g.code).toContain('strategy.entry("Long", strategy.long)');
    expect(g.code).toContain('strategy.exit("XL", "Long"');
  });
  it("collection types are reported as unsupported, not as syntax errors", async () => {
    const ir = await buildIR(`//@version=5\nindicator("c")\nvar line[] xs = na\nplot(close)\n`, { language: "pinescript" });
    expect(ir.diagnostics.every((d) => d.code === "UNSUPPORTED_SEMANTIC")).toBe(true);
  });
  it("no clear rules → NO_CLEAR_TRADING_RULES_DETECTED", () => {
    expect(extractCandidates(VAGUE).status).toBe("NO_CLEAR_TRADING_RULES_DETECTED");
  });
  it("blocks unsupported settings honestly", async () => {
    const cfg = accept(EMA); cfg.partialExit.enabled = true;
    expect(generateStrategy(EMA, cfg).blockers.length).toBeGreaterThan(0);
    const c2 = accept(EMA); c2.fillTiming = "BAR_CLOSE";
    const ir = await buildIR(generateStrategy(EMA, c2).code, { language: "pinescript" });
    expect(ir.diagnostics.some((d) => d.code === "UNSUPPORTED_SEMANTIC")).toBe(true);
  });
});
