import { describe, it, expect } from "vitest";
import { sweepValues, stabilityOf, overfitFromSweeps, type Variant } from "./sensitivity";

const v = (value: number, netProfit: number): Variant => ({ value, trades: 10, netProfit, profitFactor: null, winRate: null });

describe("parameter sensitivity", () => {
  it("sweeps an int input ±30% around its default", () => {
    expect(sweepValues(14, true)).toEqual([10, 12, 14, 16, 18]);
  });
  it("stability = share of neighbours keeping the base profit sign", () => {
    const vs = [v(10, -5), v(12, 3), v(14, 8), v(16, 2), v(18, -1)];
    expect(stabilityOf(vs, vs[2])).toBe(0.5);
  });
  it("flags HIGH overfit when neighbours mostly flip", () => {
    expect(overfitFromSweeps([{ name: "a", default: 1, isInt: true, variants: [], stability: 0.25 }])).toBe("HIGH");
    expect(overfitFromSweeps([{ name: "a", default: 1, isInt: true, variants: [], stability: 1 }])).toBe("LOW");
  });
});
