import { describe, it, expect } from "vitest";
import { parseTradingViewCsv, compareParity, type ParityContext } from "./parity";
import type { Trade } from "./backtester";

const ctx: ParityContext = { symbol: "BTCUSDT", exchange: "BINANCE", timeframe: "60", timezone: "UTC", from: "2026-01-01", to: "2026-01-02", inputs: {}, capital: 10000, commission: 0, slippage: 0, sizing: "1 contract" };
const csv = `Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT
1,Exit long,Close,2026-01-01 05:00,101,1,1
1,Entry long,Long,2026-01-01 02:00,100,1,1
2,Exit short,Close,2026-01-01 09:00,99,1,1
2,Entry short,Short,2026-01-01 07:00,100,1,1`;
const e = (n: number, dir: "LONG" | "SHORT", en: string, ex: string, ep: number, xp: number) =>
  ({ n, dir, entryTs: Date.parse(en + "Z"), exitTs: Date.parse(ex + "Z"), entryPx: ep, exitPx: xp } as Trade);

describe("TradingView parity", () => {
  it("parses export in UTC and passes on exact match", () => {
    const { trades, errors } = parseTradingViewCsv(csv);
    expect(errors).toEqual([]); expect(trades).toHaveLength(2);
    const r = compareParity(trades, [e(1, "LONG", "2026-01-01T02:00", "2026-01-01T05:00", 100, 101), e(2, "SHORT", "2026-01-01T07:00", "2026-01-01T09:00", 100, 99)], ctx, { timeToleranceMs: 3600e3, priceTolerance: 1e-9 });
    expect(r.status).toBe("PARITY_PASS");
  });
  it("reports missing, extra, direction and deltas", () => {
    const { trades } = parseTradingViewCsv(csv);
    const r = compareParity(trades, [e(1, "SHORT", "2026-01-01T02:00", "2026-01-01T05:00", 100, 101), e(2, "LONG", "2026-01-01T20:00", "2026-01-01T21:00", 1, 1)], ctx, { timeToleranceMs: 3600e3, priceTolerance: 0 });
    expect(r.status).toBe("PARITY_FAIL");
    expect(r.directionMismatches).toHaveLength(1); expect(r.missingTrades).toHaveLength(1); expect(r.extraTrades).toHaveLength(1);
  });
});
