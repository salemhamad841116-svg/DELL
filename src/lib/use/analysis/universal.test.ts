import { describe, it, expect } from "vitest";
import { buildIR } from "../strategy/ir";
import { runUniversal, splitTrades } from "./universal";
import { performance } from "./quant";
import type { Trade } from "../strategy/backtester";

const head = `//@version=6\nstrategy("t")\n`;

describe("universal strategy engine gates", () => {
  it("blocks a script with a missing variable", async () => {
    const ir = await buildIR(head + `if close > missingVar\n    strategy.entry("L", strategy.long)`, { strategyId: "t", version: 1, language: "pinescript" });
    expect(runUniversal(ir, "5m", null).status).toBe("BLOCKED_UNRESOLVED_IDENTIFIERS");
  });
  it("blocks a contradictory condition", async () => {
    const ir = await buildIR(head + `a = ta.sma(close, 10)\nif close > a and close < a\n    strategy.entry("L", strategy.long)`, { strategyId: "t", version: 1, language: "pinescript" });
    expect(runUniversal(ir, "5m", null).status).toBe("BLOCKED_LOGICAL_CONTRADICTION");
  });
  it("valid script without a backtest is blocked for missing data", async () => {
    const ir = await buildIR(head + `a = ta.sma(close, 10)\nif ta.crossover(close, a)\n    strategy.entry("L", strategy.long)\nif ta.crossunder(close, a)\n    strategy.close("L")`, { strategyId: "t", version: 1, language: "pinescript" });
    expect(runUniversal(ir, "5m", null).status).toBe("BLOCKED_INCOMPLETE_HISTORICAL_DATA");
  });
});

describe("metrics from a known trade list", () => {
  const t = (pnl: number, i: number) => ({ pnl, pnlPct: pnl / 10, entryTs: i, exitTs: i + 1, commission: 0, mae: 0, maePct: 0 }) as unknown as Trade;
  it("win rate, profit factor, expectancy", () => {
    const p = performance([t(30, 1), t(-10, 2), t(20, 3), t(-10, 4)], 1000);
    expect(p.winRate).toBe(0.5);
    expect(p.profitFactor).toBe(2.5);
    expect(p.expectancy).toBe(7.5);
  });
  it("chronological 60/20/20 split", () => {
    const s = splitTrades(Array.from({ length: 10 }, (_, i) => t(1, 10 - i)));
    expect([s.train.length, s.validation.length, s.oos.length]).toEqual([6, 2, 2]);
    expect(s.oos[1]!.entryTs).toBe(10);
  });
});
