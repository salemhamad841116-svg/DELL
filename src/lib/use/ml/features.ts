// Feature provenance: every feature from buildFeatures() is tagged with the analysis layer it comes from.
import { buildFeatures, type FeatureMatrix } from "../features";
import type { Candle, StrategyRepresentation } from "../types";

export type FeatureSource = "MARKET" | "INDICATOR" | "CONDITION";

const CONDITION = /^(strategy_|break_of_structure|market_structure)/;
const INDICATOR = /^(ema|sma|rsi|macd|atr|bb_|vwap|adx|pivot|camarilla)/;

export function sourceOf(name: string): FeatureSource {
  if (CONDITION.test(name)) return "CONDITION";
  if (INDICATOR.test(name)) return "INDICATOR";
  return "MARKET"; // returns, ranges, candle shape, volatility, session, volume
}

export type TaggedFeatures = FeatureMatrix & { sources: { name: string; source: FeatureSource }[] };

export function buildTaggedFeatures(candles: Candle[], strategy?: StrategyRepresentation | null): TaggedFeatures {
  const m = buildFeatures(candles, strategy);
  return { ...m, sources: m.names.map((name) => ({ name, source: sourceOf(name) })) };
}
