import type { Candle } from "../types";
import { expectedBars, type Exchange, type MarketType } from "./calendar";

export type MissingRange = { from: string; to: string; bars: number };
export type CoverageStatus =
  | "PASS_COMPLETE_HISTORICAL_COVERAGE"
  | "PARTIAL_HISTORICAL_COVERAGE"
  | "PARTIAL_KNOWN_PROVIDER_GAPS"
  | "FAIL_PROVIDER_MISMATCH"
  | "BLOCKED_REAL_PROVIDER_FETCH_FAILED";

export type DataCoverageReport = {
  requestedProvider: string;
  actualProvider: string | null;
  dataset: string;
  marketType: MarketType;
  exchange: Exchange;
  timeframe: string;
  requestedStart: string;
  requestedEnd: string;
  actualFirstBar: string | null;
  actualLastBar: string | null;
  expectedBars: number;
  loadedBars: number;
  missingBars: number;
  duplicateBars: number;
  unexpectedBars: number;
  coveragePercent: number;
  providerChanges: string[];
  providerMatch: "PASS" | "FAIL";
  missingRanges: MissingRange[];
  complete: boolean;
  status: CoverageStatus;
  providerTier: string;
  /** Trade-derived schemas (Databento OHLCV): absent minute ≠ missing data. */
  expectedSessionBars: number;
  tradeActiveBars: number;
  noTradeIntervals: number;
  trueMissingBars: number;
  outOfSessionRecords: number;
  gapClassification: "TIMESTAMP_CONTINUITY" | "TRADE_VERIFIED";
  contractRolls: { ts: string; oldInstrumentId: number; newInstrumentId: number; continuousSymbol: string }[];
  providerState?: string;
  error?: string;
};

export function buildCoverage(args: {
  requestedProvider: string; actualProvider: string | null; dataset: string; market: MarketType; exchange: Exchange;
  timeframe: string; stepMs: number; start: number; end: number; candles: Candle[];
  duplicates: number; providerTier?: string; noTradeTs?: Set<number>; continuousSymbol?: string; providerChanges?: string[]; error?: string; providerState?: string;
}): DataCoverageReport {
  const { candles, stepMs } = args;
  // Only closed bars are expected: the forming bar is excluded.
  const closedEnd = Math.min(args.end, Math.floor(Date.now() / stepMs) * stepMs);
  const variableLength = stepMs >= 7 * 86_400_000; // weeks/months: calendar-length buckets, provider-defined
  const expected = variableLength ? candles.map((c) => c.ts) : expectedBars(args.exchange, stepMs, args.start, closedEnd);
  const expectedSet = new Set(expected);
  const have = new Set(candles.map((c) => (variableLength ? c.ts : Math.floor(c.ts / stepMs) * stepMs)));
  const absent = expected.filter((t) => !have.has(t));
  const noTrade = args.noTradeTs;
  const missing = noTrade ? absent.filter((t) => !noTrade.has(t)) : absent;
  const rolls: DataCoverageReport["contractRolls"] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1]!.instrumentId, b = candles[i]!.instrumentId;
    if (a != null && b != null && a !== b) rolls.push({ ts: new Date(candles[i]!.ts).toISOString(), oldInstrumentId: a, newInstrumentId: b, continuousSymbol: args.continuousSymbol ?? "" });
  }
  const unexpected = variableLength ? 0 : [...have].filter((t) => !expectedSet.has(t)).length;
  const ranges: MissingRange[] = [];
  for (const t of missing) {
    const last = ranges[ranges.length - 1];
    if (last && t - new Date(last.to).getTime() <= stepMs) { last.to = new Date(t).toISOString(); last.bars += 1; }
    else ranges.push({ from: new Date(t).toISOString(), to: new Date(t).toISOString(), bars: 1 });
  }
  const providerMatch = args.actualProvider !== null && args.actualProvider === args.requestedProvider ? "PASS" : "FAIL";
  const pct = expected.length ? ((expected.length - missing.length) / expected.length) * 100 : 0; // no-trade minutes count as covered
  const complete = candles.length > 0 && missing.length === 0 && unexpected === 0 && providerMatch === "PASS";
  const status: CoverageStatus =
    candles.length === 0 ? "BLOCKED_REAL_PROVIDER_FETCH_FAILED"
      : providerMatch === "FAIL" ? "FAIL_PROVIDER_MISMATCH"
        : complete ? "PASS_COMPLETE_HISTORICAL_COVERAGE"
          : args.providerTier === "BACKUP_ONLY" ? "PARTIAL_KNOWN_PROVIDER_GAPS" : "PARTIAL_HISTORICAL_COVERAGE";
  return {
    requestedProvider: args.requestedProvider,
    actualProvider: args.actualProvider,
    dataset: args.dataset,
    marketType: args.market,
    exchange: args.exchange,
    timeframe: args.timeframe,
    requestedStart: new Date(args.start).toISOString(),
    requestedEnd: new Date(closedEnd).toISOString(),
    actualFirstBar: candles[0] ? new Date(candles[0].ts).toISOString() : null,
    actualLastBar: candles.length ? new Date(candles[candles.length - 1]!.ts).toISOString() : null,
    expectedBars: expected.length,
    loadedBars: candles.length,
    missingBars: missing.length,
    duplicateBars: args.duplicates,
    unexpectedBars: unexpected,
    coveragePercent: Math.floor(pct * 100) / 100,
    providerChanges: args.providerChanges ?? [],
    providerMatch,
    missingRanges: ranges.slice(0, 200),
    complete,
    status,
    providerTier: args.providerTier ?? "PRODUCTION",
    expectedSessionBars: expected.length,
    tradeActiveBars: expected.length - absent.length,
    noTradeIntervals: absent.length - missing.length,
    trueMissingBars: missing.length,
    outOfSessionRecords: unexpected,
    gapClassification: noTrade ? "TRADE_VERIFIED" : "TIMESTAMP_CONTINUITY",
    contractRolls: rolls,
    ...(args.providerState ? { providerState: args.providerState } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}
