import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../types";
import { closedBars, forecastNext, indicatorSeries, labelMove, buildDataset } from "./core";
import { buildIR } from "../strategy/ir";

const DIR = join(__dirname, "..", "strategy", "__golden__");
const H1: Candle[] = (JSON.parse(readFileSync(join(DIR, "btcusdt-1h-2026-08.json"), "utf8")).bars as number[][]).map(([ts, o, h, l, c, v]) => ({ ts: ts!, open: o!, high: h!, low: l!, close: c!, volume: v! }));
const HOUR = 3_600_000;

describe("next candle forecast", () => {
  it("drops a forming source bar", () => {
    const last = H1[H1.length - 1]!;
    expect(closedBars(H1, HOUR, last.ts + HOUR - 1).length).toBe(H1.length - 1);
    expect(closedBars(H1, HOUR, last.ts + HOUR).length).toBe(H1.length);
  });
  it("labels with ATR neutral threshold", () => {
    expect(labelMove(100, 100.05, 1)).toBe("NEUTRAL");
    expect(labelMove(100, 100.1, 1)).toBe("NEUTRAL");
    expect(labelMove(100, 100.11, 1)).toBe("UP");
    expect(labelMove(100, 99.8, 1)).toBe("DOWN");
  });
  it("targets exactly the next bar of the same timeframe and is deterministic", () => {
    const a = forecastNext(H1, HOUR, { names: [], values: [], unsupported: [] })!;
    const b = forecastNext(H1, HOUR, { names: [], values: [], unsupported: [] })!;
    expect(a.targetBarTs - a.sourceBarTs).toBe(HOUR);
    expect(a.sourceBarTs).toBe(H1[H1.length - 1]!.ts);
    expect(b).toEqual(a);
    expect(a.up + a.down + a.neutral).toBeCloseTo(1, 6);
  });
  it("indicator() values become features without orders, no lookahead", async () => {
    const ir = await buildIR(`//@version=6\nindicator("Piv ATR", overlay=true)\na = ta.atr(14)\npp = (high[1] + low[1] + close[1]) / 3\nr1 = 2 * pp - low[1]\ns1 = 2 * pp - high[1]\nplot(pp)`, {});
    expect(ir.scriptType).toBe("INDICATOR");
    const meta = { tickerid: "BTCUSDT", timeframe: "1h", market: "crypto" };
    const full = indicatorSeries(ir, H1, meta);
    expect(full.unsupported).toEqual([]);
    expect(full.names).toEqual(expect.arrayContaining(["a", "pp", "r1", "s1"]));
    const cut = 400;
    const part = indicatorSeries(ir, H1.slice(0, cut), meta);
    const dFull = buildDataset(H1, full); const dPart = buildDataset(H1.slice(0, cut), part);
    const r = dPart.idx.indexOf(cut - 1);
    expect(dFull.X[dFull.idx.indexOf(cut - 1)]).toEqual(dPart.X[r]);
    expect(forecastNext(H1, HOUR, full)).not.toBeNull();
  });
});
