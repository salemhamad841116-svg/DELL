// Analysis-side adapter over the single historical pipeline (data/providers.server.ts).
// No separate loader: every candle here comes from fetchHistorical → same resolver,
// adapters, cache, coverage report and market calendar as the Admin coverage test.

import { aggregateCandles } from "./aggregate";
import { getTimeframe } from "./timeframes";
import type { Candle } from "./types";
import { fetchHistorical, resolveProvider } from "./data/providers.server";
import type { MarketType } from "./data/calendar";
import type { DataCoverageReport } from "./data/coverage";

export type SymbolRow = { symbol: string; display_name: string; asset_class: string; provider_symbol: string };

export type CandleFetch = {
  candles: Candle[];
  source: "provider" | "cache" | "none";
  provider: string | null;
  coverage: DataCoverageReport | null;
  note?: string;
  /** Provider's published dataset end (historical feed lag), when known. */
  availableEnd?: number;
  /** Loader diagnostics: every window attempted. */
  attempts?: { start: string; end: string; bars: number; first: string | null; last: string | null }[];
};

export function marketOf(sym: SymbolRow): MarketType {
  if (sym.asset_class === "commodity") return "metal";
  return (["crypto", "forex", "metal", "futures", "stock"].includes(sym.asset_class) ? sym.asset_class : "stock") as MarketType;
}

/** Calendar-hours per wall-clock day, to size the request window for N bars. */
const DENSITY: Record<MarketType, number> = { crypto: 1, forex: 5 / 7, metal: 0.68, futures: 0.68, stock: (6.5 / 24) * (5 / 7) };
const MAX_WINDOW_ATTEMPTS = 4;

export async function getCandles(sym: SymbolRow, timeframe: string, bars = 1000): Promise<CandleFetch> {
  const spec = getTimeframe(timeframe);
  if (!spec || !spec.supported) return { candles: [], source: "none", provider: null, coverage: null, note: "الفريم غير متاح من مزود البيانات الحالي" };
  const market = marketOf(sym);
  const baseId = resolveProvider(market, timeframe).prov ? timeframe : (spec.aggregateFrom ?? timeframe);
  const baseSpec = getTimeframe(baseId);
  const ratio = Math.max(Math.round(spec.seconds / (baseSpec?.seconds ?? spec.seconds)), 1);
  const stepMs = (baseSpec?.seconds ?? spec.seconds) * 1000;
  let end = Date.now();
  let span = Math.ceil(((bars + 20) * ratio * stepMs) / DENSITY[market]);
  const attempts: NonNullable<CandleFetch["attempts"]> = [];
  let r: Awaited<ReturnType<typeof fetchHistorical>> | null = null;
  let out: Candle[] = [];
  // Weekends, holidays and provider publication lag shrink the window → widen it until enough closed bars exist.
  for (let k = 0; k < MAX_WINDOW_ATTEMPTS; k++) {
    const start = end - span;
    r = await fetchHistorical({ symbol: sym.symbol, providerSymbol: sym.provider_symbol, market, timeframe: baseId, start, end });
    out = baseId === timeframe ? r.candles : aggregateCandles(r.candles, timeframe);
    const at = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), bars: out.length,
      first: out[0] ? new Date(out[0].ts).toISOString() : null, last: out.length ? new Date(out[out.length - 1]!.ts).toISOString() : null };
    attempts.push(at);
    console.log(`[getCandles] ${sym.symbol} ${timeframe} attempt ${k + 1}: ${at.start} → ${at.end} bars=${out.length}/${bars} first=${at.first} last=${at.last}`);
    if (out.length >= bars || !r.candles.length || r.coverage.providerState !== "OK") break;
    if (r.availableEnd && r.availableEnd < end) end = r.availableEnd;
    span = Math.ceil(span * Math.min(Math.max((bars * 1.2) / Math.max(out.length, 1), 2), 8));
  }
  const { candles, coverage, fromCache, availableEnd } = r!;
  if (!candles.length) return { candles: [], source: "none", provider: null, coverage, note: coverage.error ?? coverage.status, attempts };
  const note = coverage.status === "PASS_COMPLETE_HISTORICAL_COVERAGE" ? undefined : `${coverage.status} · ${coverage.coveragePercent}% (${coverage.missingBars} ناقصة)`;
  return { candles: out.slice(-bars), source: fromCache ? "cache" : "provider", provider: coverage.actualProvider, coverage, attempts, ...(availableEnd ? { availableEnd } : {}), ...(note ? { note } : {}) };
}

export async function listSymbols(): Promise<SymbolRow[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("use_symbols").select("symbol,display_name,asset_class,provider_symbol").eq("enabled", true).order("symbol");
  return (data ?? []) as SymbolRow[];
}

/** Newest gap-free run of stored closed bars from the SAME provider (market-closed periods are not gaps).
 *  For model training/validation only — never for live forecasts. */
export async function storedSegment(sym: SymbolRow, timeframe: string, max = 1500): Promise<{ candles: Candle[]; provider: string | null }> {
  const { readCache, resolveProvider } = await import("./data/providers.server");
  const { expectedBars, exchangeFor } = await import("./data/calendar");
  const market = marketOf(sym);
  const prov = resolveProvider(market, timeframe).prov?.id ?? null;
  const stepMs = (getTimeframe(timeframe)?.seconds ?? 0) * 1000;
  if (!prov || !stepMs) return { candles: [], provider: prov };
  const all = await readCache(sym.symbol, timeframe, prov, Date.now() - 60 * 86_400_000, Date.now());
  const ex = exchangeFor(market, sym.provider_symbol);
  let start = 0;
  for (let i = all.length - 1; i > 0; i--) if (expectedBars(ex, stepMs, all[i - 1]!.ts + stepMs, all[i]!.ts).length > 0) { start = i; break; }
  return { candles: all.slice(start).slice(-max), provider: prov };
}
