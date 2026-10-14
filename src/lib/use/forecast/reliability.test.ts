import { describe, it, expect } from "vitest";
import fixture from "../strategy/__golden__/btcusdt-1h-2026-08.json";
import type { Candle } from "../types";
import { forecastNext } from "./core";
import { calibrationReport, forwardStats, psi, sessionOf, signalGate, validateSetup, wilson } from "./reliability";

const candles: Candle[] = (fixture as unknown as { bars: number[][] }).bars.map(([ts, open, high, low, close, volume]) => ({ ts, open, high, low, close, volume } as Candle));
const noInd = { names: [], values: [], unsupported: [] };

describe("Next Candle reliability", () => {
  it("no lookahead: altering candles after the source bar never changes the forecast", () => {
    const cut = candles.slice(0, candles.length - 30);
    const a = forecastNext(cut, 3_600_000, noInd)!;
    const tampered = [...cut, ...candles.slice(candles.length - 30).map((c) => ({ ...c, close: c.close * 1.5 }))];
    const b = forecastNext(tampered.slice(0, cut.length), 3_600_000, noInd)!;
    expect(b.up).toBe(a.up); expect(b.down).toBe(a.down);
  });
  it("walk-forward validation is deterministic, embargoed and chronological", () => {
    const r1 = validateSetup(candles, noInd)!, r2 = validateSetup(candles, noInd)!;
    expect(r1).toBeTruthy();
    expect(r1.oosAccuracy).toBe(r2.oosAccuracy);
    expect(r1.embargo).toBeGreaterThan(0);
    expect(r1.split.trainTo < r1.split.validationTo && r1.split.validationTo < r1.split.testTo).toBe(true);
    expect(r1.walkForward.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < r1.walkForward.length; i++) expect(r1.walkForward[i]!.from > r1.walkForward[i - 1]!.to).toBe(true);
  });
  it("calibration metrics", () => {
    const perfect = calibrationReport([{ p: { up: 1, down: 0, neutral: 0 }, actual: "UP" }, { p: { up: 0, down: 1, neutral: 0 }, actual: "DOWN" }]);
    expect(perfect.brier).toBeCloseTo(0); expect(perfect.ece).toBeCloseTo(0);
    const bad = calibrationReport([{ p: { up: 0.9, down: 0.05, neutral: 0.05 }, actual: "DOWN" }]);
    expect(bad.ece).toBeCloseTo(0.9); expect(bad.confusion.UP.DOWN).toBe(1);
    const w = wilson(55, 100)!; expect(w.lo).toBeLessThan(0.55); expect(w.hi).toBeGreaterThan(0.55);
    expect(psi(Array.from({ length: 200 }, (_, i) => i), Array.from({ length: 100 }, (_, i) => i * 2))).toBeLessThan(0.1);
    expect(sessionOf(Date.UTC(2026, 0, 5, 13))).toBe("LONDON_NY_OVERLAP");
  });
  it("gate: slight edge or unverified model → NO SIGNAL, never forced", () => {
    const report = { wfStd: 0.02, wfBeatsBaseline: 4, regimes: [], pass: true };
    const ok = signalGate({ p: { up: 0.62, down: 0.2, neutral: 0.18 }, minConf: 0.55, sampleSize: 900, minSamples: 200, dataQuality: "HIGH", regime: "RANGE", model: { status: "VERIFIED", report } });
    expect(ok.signal).toBe("UP");
    const slim = signalGate({ p: { up: 0.56, down: 0.5, neutral: 0 }, minConf: 0.55, sampleSize: 900, minSamples: 200, dataQuality: "HIGH", regime: "RANGE", model: { status: "VERIFIED", report } });
    expect(slim.signal).toBe("LOW_CONFIDENCE"); expect(slim.reason).toMatch(/NO SIGNAL — INSUFFICIENT CONFIDENCE/);
    const degraded = signalGate({ p: { up: 0.7, down: 0.1, neutral: 0.2 }, minConf: 0.55, sampleSize: 900, minSamples: 200, dataQuality: "HIGH", regime: "RANGE", model: { status: "DEGRADED", report } });
    expect(degraded.signal).toBe("LOW_CONFIDENCE");
  });
  it("forward stats: NEUTRAL / NO SIGNAL never change directional accuracy", () => {
    const base = { evaluation_status: "evaluated", bullish_probability: 0.6, bearish_probability: 0.2, neutral_probability: 0.2, market_regime: "RANGE" };
    const rows = [
      { ...base, signal: "UP", direction: "UP", actual_result: "UP", correct: true, target_ts: "2026-09-01T00:00:00Z" },
      { ...base, signal: "DOWN", direction: "DOWN", actual_result: "UP", correct: false, target_ts: "2026-09-01T00:05:00Z" },
    ];
    const extra = [
      { ...base, signal: "LOW_CONFIDENCE", direction: "UP", actual_result: "DOWN", correct: null, target_ts: "2026-09-01T00:10:00Z" },
      { ...base, signal: "NEUTRAL", direction: "NEUTRAL", actual_result: "UP", correct: null, target_ts: "2026-09-01T00:15:00Z" },
    ];
    expect(forwardStats(rows).directional.accuracy).toBe(0.5);
    expect(forwardStats([...rows, ...extra]).directional.accuracy).toBe(0.5);
    expect(forwardStats([...rows, ...extra]).noSignal).toBe(1);
  });
});
