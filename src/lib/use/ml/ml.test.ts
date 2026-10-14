import { describe, it, expect } from "vitest";
import { purgedKFold, assertNoLeakage } from "./purged_cv";
import { fitIsotonic, fitGBM } from "./models";
import { trustGate } from "./trust";
import { sourceOf } from "./features";

describe("ml", () => {
  it("purged k-fold removes overlapping and embargoed samples", () => {
    const f = purgedKFold(100, 5, 1, 5);
    expect(assertNoLeakage(f, 1, 5)).toBe(true);
    expect(f[1]!.train).not.toContain(19); // label of 19 touches test start 20
    expect(f[1]!.train).not.toContain(45); // inside embargo after test end 39
    expect(f[1]!.train).toContain(46);
  });
  it("leakage check catches a leaking fold", () => {
    expect(() => assertNoLeakage([{ train: [9], test: [10, 11] }], 1, 5)).toThrow(/LEAKAGE/);
  });
  it("isotonic output is monotone", () => {
    const iso = fitIsotonic([0.1, 0.2, 0.3, 0.4], [1, 0, 1, 1]);
    expect(iso(0.1)).toBeLessThanOrEqual(iso(0.4));
    expect(iso(0.4)).toBe(1);
  });
  it("GBM learns a threshold", () => {
    const X = Array.from({ length: 200 }, (_, i) => [i / 200]);
    const m = fitGBM(X, X.map((r) => (r[0]! > 0.5 ? 1 : 0)));
    expect(m.predict([0.9])).toBeGreaterThan(0.8);
    expect(m.predict([0.1])).toBeLessThan(0.2);
  });
  it("trust gate rejects below 55% confidence", () => {
    const r = trustGate({ probs: { UP: 0.5, DOWN: 0.3, NEUTRAL: 0.2 }, oofSamples: 500, oofAccuracy: 0.6, baselineAccuracy: 0.4, ece: 0.05, regimeMatches: true });
    expect(r.trusted).toBe(false);
  });
  it("tags feature sources", () => {
    expect(sourceOf("rsi")).toBe("INDICATOR");
    expect(sourceOf("strategy_long_signal")).toBe("CONDITION");
    expect(sourceOf("return_1")).toBe("MARKET");
  });
});
