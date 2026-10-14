import { describe, expect, it } from "vitest";
import { analyzePattern, summarize, nextCandleFromPattern } from "./analyzer";

const T = 300_000; const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ ts: H * 100 + i * T, open: o, high: h, low: l, close: c, volume: 0 });

describe("pattern analyzer", () => {
  const candles = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 100, 108), bar(2, 108, 108, 94, 95), bar(3, 95, 96, 94, 95)];
  const names = ["r3", "s1"]; const values = [[110, 110, 110, 110], [95, 95, 95, 95]];
  it("detects touch → target on a later bar with historical levels", () => {
    const r = analyzePattern(candles, T, names, values, { source: "r3", target: "s1", window: { kind: "SAME_CLOCK_HOUR" } }, { now: Infinity, atr: [1, 1, 1, 1] });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.outcome).toBe("SUCCESS");
    expect(r.events[0]!.minutesToTarget).toBe(5);
    expect(summarize(r.events).successRate).toBe(1);
  });
  it("flags same-bar touch of both levels as AMBIGUOUS without 1m data", () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 94, 100)];
    const r = analyzePattern(c, T, names, [[110, 110], [95, 95]], { source: "r3", target: "s1", window: { kind: "MINUTES", minutes: 60 } }, { now: Infinity, atr: [1, 1] });
    expect(r.events[0]!.outcome).toBe("AMBIGUOUS");
  });
  it("resolves same-bar ambiguity from real 1m candles", () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 110, 94, 100)];
    const b = c[1]!.ts;
    const m1 = [0, 1, 2, 3, 4].map((k) => ({ ts: b + k * 60_000, open: 100, high: k === 1 ? 110 : 101, low: k === 3 ? 94 : 99, close: 100, volume: 0 }));
    const r = analyzePattern(c, T, names, [[110, 110], [95, 95]], { source: "r3", target: "s1", window: { kind: "MINUTES", minutes: 60 } }, { now: Infinity, atr: [1, 1], m1 });
    expect(r.events[0]!.outcome).toBe("SUCCESS");
    expect(r.events[0]!.resolvedBy).toBe("LOWER_TF_1M");
  });
  it("returns NO_SIGNAL with few samples", () => {
    const r = analyzePattern(candles, T, names, values, { source: "r3", target: "s1", window: { kind: "SAME_CLOCK_HOUR" } }, { now: Infinity, atr: [1, 1, 1, 1] });
    expect(nextCandleFromPattern(r.events, 0.55).signal).toBe("NO_SIGNAL");
  });
});
