import { describe, it, expect } from "vitest";
import fixture from "./__golden__/btcusdt-1h-2026-08.json";
import { buildIR } from "./ir";
import { indicatorSeries } from "../forecast/core";
import { generatePine, pineDataset, splitPineSource, trainPineModel, triProb } from "./pinegen";
import type { Candle } from "../types";

const candles: Candle[] = (fixture as unknown as { bars: number[][] }).bars.map(([ts, open, high, low, close, volume]) => ({ ts, open, high, low, close, volume } as Candle));
const SRC = `//@version=6
indicator("Pivot Levels",
  overlay=true)
len = input.int(14, "ATR")
a = ta.atr(len)
p = (high[1] + low[1] + close[1]) / 3
r1 = 2 * p - low[1]
s1 = 2 * p - high[1]
var line lr = na
lr := line.new(bar_index, r1, bar_index + 1, r1)
plot(r1)
`;

describe("TradingView Pine Code Generator", () => {
  it("splits multi-line declaration", () => {
    const s = splitPineSource(SRC);
    expect(s.version).toBe(6);
    expect(s.declaration).toBe('indicator("Pivot Levels",\n  overlay=true)');
    expect(s.body).not.toMatch(/indicator\(/);
  });
  it("generates valid indicator code that reproduces the model bar-by-bar", async () => {
    const meta = { tickerid: "BTCUSDT", timeframe: "1h" };
    const ir = await buildIR(SRC, { language: "pinescript" });
    const ind = indicatorSeries(ir, candles, meta);
    const model = trainPineModel(candles, ind, 100)!;
    expect(model).toBeTruthy();
    expect(model.features.some((f) => f.source === "INDICATOR")).toBe(true);
    const code = generatePine(SRC, model, { name: "Pivot Levels", sourceHash: ir.sourceHash, sourceVersion: 1, symbol: "BTCUSDT", timeframe: "1h", trainedFrom: "a", trainedTo: "b", minConfidence: 0.55, alerts: true });
    expect(code.startsWith("//@version=6")).toBe(true);
    expect(code).not.toMatch(/strategy\s*\(|strategy\.entry/);
    const gir = await buildIR(code, { language: "pinescript" });
    expect(gir.diagnostics.filter((d) => d.code === "PARSE_ERROR" || d.code === "UNSUPPORTED_SEMANTIC")).toEqual([]);
    expect(gir.scriptType).toBe("INDICATOR");
    const gs = indicatorSeries(gir, candles, meta);
    expect(gs.unsupported).toEqual([]);
    const ds = pineDataset(candles, ind);
    const up = gs.values[gs.names.indexOf("nc_up")]!;
    for (const r of [ds.X.length - 1, ds.X.length - 50]) {
      expect(Math.abs(up[ds.idx[r]!]! - triProb(model, ds.X[r]!).up)).toBeLessThan(1e-9);
    }
  });
});

describe("Pine model review safeguards", () => {
  const meta = { tickerid: "EUR/USD", timeframe: "1m" };
  it("replaces absolute bar/time features with relative ones and locks symbol/timeframe", async () => {
    const src = `//@version=6
indicator("Sig", overlay=true)
var int lastSignalBar = na
var int lastSignalTime = na
if close > ta.sma(close, 20) and close[1] <= ta.sma(close, 20)[1]
    lastSignalBar := bar_index
    lastSignalTime := time
evaluatedBar = bar_index
plot(close)
`;
    const ir = await buildIR(src, { language: "pinescript" });
    const ind = indicatorSeries(ir, candles, meta);
    const model = trainPineModel(candles, ind, 100)!;
    const names = model.features.map((f) => f.name);
    expect(names).not.toContain("lastSignalBar");
    expect(names).not.toContain("lastSignalTime");
    expect(names).not.toContain("evaluatedBar");
    expect(model.calibration.calibrated.ece).not.toBeNull();
    const code = generatePine(src, model, { name: "Sig", sourceHash: null, sourceVersion: 1, symbol: "EUR/USD", timeframe: "1m", trainedFrom: "a", trainedTo: "b", minConfidence: 0.55, alerts: true });
    expect(code).toContain("MODEL TRAINED FOR EURUSD 1m");
    expect(code).toContain('timeframe.period == "1"');
    expect(code).toContain("MISSING INPUT");
    const gir = await buildIR(code, { language: "pinescript" });
    const gs = indicatorSeries(gir, candles, meta);
    expect(gs.unsupported).toEqual([]);
    const ds = pineDataset(candles, ind);
    const up = gs.values[gs.names.indexOf("nc_up")]!;
    const r = ds.X.length - 1;
    expect(Math.abs(up[ds.idx[r]!]! - triProb(model, ds.X[r]!).up)).toBeLessThan(1e-9);
    // Wrong timeframe → lock disables forecast.
    const wrong = indicatorSeries(gir, candles, { tickerid: "GBP/USD", timeframe: "1m" });
    const sig = wrong.values[wrong.names.indexOf("nc_lockOk")]!;
    expect(sig[sig.length - 1]).toBeFalsy();
  });
});
