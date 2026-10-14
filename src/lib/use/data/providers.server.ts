// The single historical-data pipeline for the whole app (Admin coverage + Analysis).
// Provider Resolver → Historical Adapter → Cache → Coverage Report (Market Calendar).
// Every adapter: start/end, pagination, retry + exponential backoff, rate limit,
// dedup, sort, UTC normalisation, incomplete-candle exclusion. Never synthesises data.

import type { Candle } from "../types";
import { getTimeframe } from "../timeframes";
import { buildCoverage, type DataCoverageReport } from "./coverage";
import { decodeDbn, decodeDbnTimestamps, dominantInstrument } from "./dbn";
import { exchangeFor, expectedBars, type MarketType } from "./calendar";

export type FetchRequest = { symbol: string; providerSymbol: string; market: MarketType; timeframe: string; start: number; end: number };
export type AdapterResult = { candles: Candle[]; duplicates: number; httpStatus: number; requests: number; availableEnd?: number };
export type ProviderState = "OK" | "NOT_CONFIGURED" | "NOT_ENTITLED" | "AUTH_FAILED" | "RATE_LIMITED" | "NOT_SUPPORTED" | "NO_DATA" | "PROVIDER_ERROR" | "PROVIDER_ACCESS_BLOCKED";

export type ProviderTier = "PRODUCTION" | "BACKUP_ONLY" | "DISABLED";

export class ProviderError extends Error {
  constructor(public state: ProviderState, message: string, public httpStatus: number | null = null, public requests = 0, public detail: FailureDetail | null = null) {
    super(message);
  }
}

export type FailureDetail = { endpoint: string; method: string; status: number; body: string; headers: Record<string, string>; weight: Record<string, string> };

/** Strip query-string secrets and header values that could carry credentials. */
const SECRET_HDR = /authorization|cookie|api[-_]?key|token|secret/i;
function failureDetail(url: string, method: string, res: Response, body: string): FailureDetail {
  const headers: Record<string, string> = {}; const weight: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (SECRET_HDR.test(k)) return; headers[k] = v; if (/weight|order-count|retry-after/i.test(k)) weight[k] = v; });
  const u = new URL(url); for (const k of [...u.searchParams.keys()]) if (SECRET_HDR.test(k)) u.searchParams.set(k, "***");
  return { endpoint: u.toString(), method, status: res.status, body: body.slice(0, 2000), headers, weight };
}

export interface HistoricalDataProvider {
  id: string;
  label: string;
  production: boolean;
  /** PRODUCTION = eligible for VERIFIED; BACKUP_ONLY = exploratory, never verified; DISABLED = never called. */
  tier?: ProviderTier;
  configured(): boolean;
  supports(market: MarketType, timeframe: string): boolean;
  fetch(req: FetchRequest): Promise<AdapterResult>;
}

type Ctx = { id: string; requests: number; lastStatus: number; availableEnd?: number };
const lastCall = new Map<string, number>();

function stateFor(status: number): ProviderState {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "PROVIDER_ACCESS_BLOCKED"; // WAF/geo/IP block until the cause is confirmed
  if (status === 402) return "NOT_ENTITLED";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

async function fetchRetry(ctx: Ctx, url: string, init: RequestInit = {}, gapMs = 120, tries = 4): Promise<Response> {
  let last: ProviderError | null = null;
  for (let i = 0; i < tries; i++) {
    const wait = (lastCall.get(ctx.id) ?? 0) + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall.set(ctx.id, Date.now());
    ctx.requests++;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      last = new ProviderError("PROVIDER_ERROR", `${ctx.id}: network ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      continue;
    }
    ctx.lastStatus = res.status;
    if (res.ok) return res;
    const full = (await res.text().catch(() => "")).replace(/[A-Za-z0-9_-]{24,}/g, "***");
    const body = full.slice(0, 180);
    last = new ProviderError(stateFor(res.status), `${ctx.id} HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status, ctx.requests, failureDetail(url, init.method ?? "GET", res, full));
    if (res.status !== 429 && res.status < 500) break; // terminal
    const ra = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** i + Math.random() * 250));
  }
  throw last ?? new ProviderError("PROVIDER_ERROR", `${ctx.id} failed`);
}

/** Dedup, sort, window-clip, and drop the still-forming bar. */
function finalize(ctx: Ctx, raw: Candle[], stepMs: number, start: number, end: number): AdapterResult {
  const map = new Map<number, Candle>();
  let dup = 0;
  for (const c of raw) {
    if (![c.ts, c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    if (map.has(c.ts)) dup++;
    map.set(c.ts, c);
  }
  const now = Date.now();
  const candles = [...map.values()].filter((c) => c.ts >= start && c.ts < end && c.ts + stepMs <= now).sort((a, b) => a.ts - b.ts);
  return { candles, duplicates: dup, httpStatus: ctx.lastStatus, requests: ctx.requests, ...(ctx.availableEnd ? { availableEnd: ctx.availableEnd } : {}) };
}

const stepOf = (tf: string) => (getTimeframe(tf)?.seconds ?? 60) * 1000;
const newCtx = (id: string): Ctx => ({ id, requests: 0, lastStatus: 0 });

/* ---------------- Binance (production, crypto) ---------------- */
/** Public market-data-only host (no API key, no account endpoints). */
export const BINANCE_BASE = "https://data-api.binance.vision";
const BIN: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "6h": "6h", "8h": "8h", "1D": "1d", "1W": "1w", "1M": "1M" };
const binance: HistoricalDataProvider = {
  id: "binance", label: "Binance", production: true,
  configured: () => true,
  supports: (m, tf) => m === "crypto" && !!BIN[tf],
  async fetch(req) {
    const ctx = newCtx("binance");
    const step = stepOf(req.timeframe);
    const out: Candle[] = [];
    let cursor = req.start;
    for (let page = 0; page < 60 && cursor < req.end; page++) {
      const url = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(req.providerSymbol)}&interval=${BIN[req.timeframe]}&startTime=${cursor}&endTime=${req.end - 1}&limit=1000`;
      const rows = (await (await fetchRetry(ctx, url)).json()) as (string | number)[][];
      if (!rows.length) break;
      for (const r of rows) out.push({ ts: Number(r[0]), open: +r[1]!, high: +r[2]!, low: +r[3]!, close: +r[4]!, volume: +r[5]! });
      if (rows.length < 1000) break;
      cursor = Number(rows[rows.length - 1]![0]) + step;
    }
    return finalize(ctx, out, step, req.start, req.end);
  },
};

/* ---------------- Yahoo (auxiliary / test only — never preferred over an official source) ---------------- */
const YH: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1D": "1d", "1W": "1wk", "1M": "1mo" };
const YH_MAX_DAYS: Record<string, number> = { "1m": 7, "5m": 59, "15m": 59, "30m": 59, "60m": 729 };
const yahoo: HistoricalDataProvider = {
  id: "yahoo", label: "Yahoo Finance (auxiliary/test)", production: false,
  configured: () => true,
  supports: (m, tf) => m !== "crypto" && !!YH[tf],
  async fetch(req) {
    const ctx = newCtx("yahoo");
    const step = stepOf(req.timeframe);
    const interval = YH[req.timeframe]!;
    const maxDays = YH_MAX_DAYS[interval];
    const start = maxDays ? Math.max(req.start, Date.now() - maxDays * 86_400_000) : req.start;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(req.providerSymbol)}?interval=${interval}&period1=${Math.floor(start / 1000)}&period2=${Math.floor(req.end / 1000)}`;
    const j = (await (await fetchRetry(ctx, url, { headers: { "User-Agent": "Mozilla/5.0" } }, 300)).json()) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: Record<string, (number | null)[]>[] } }[]; error?: { description?: string } | null };
    };
    const r = j.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r?.timestamp || !q) throw new ProviderError("NO_DATA", `yahoo: ${j.chart?.error?.description ?? "empty response"}`, ctx.lastStatus, ctx.requests);
    const out: Candle[] = [];
    r.timestamp.forEach((t, i) => {
      const o = q["open"]?.[i], h = q["high"]?.[i], l = q["low"]?.[i], c = q["close"]?.[i];
      if (o == null || h == null || l == null || c == null) return;
      out.push({ ts: Math.floor((t * 1000) / step) * step, open: o, high: h, low: l, close: c, volume: q["volume"]?.[i] ?? null });
    });
    return finalize(ctx, out, step, start, req.end);
  },
};

/* ---------------- Keyed adapters: NOT_CONFIGURED without a key ---------------- */
function keyed(id: string, label: string, envKey: string, supports: (m: MarketType, tf: string) => boolean,
  impl: (ctx: Ctx, req: FetchRequest, key: string) => Promise<Candle[]>): HistoricalDataProvider {
  return {
    id, label, production: true,
    configured: () => !!process.env[envKey],
    supports,
    async fetch(req) {
      const key = process.env[envKey];
      if (!key) throw new ProviderError("NOT_CONFIGURED", `${id}: NOT_CONFIGURED (${envKey} missing)`);
      const ctx = newCtx(id);
      try {
        return finalize(ctx, await impl(ctx, req, key), stepOf(req.timeframe), req.start, req.end);
      } catch (e) {
        if (e instanceof ProviderError) { e.requests = ctx.requests; throw e; }
        throw new ProviderError("PROVIDER_ERROR", `${id}: ${(e as Error).message}`, ctx.lastStatus, ctx.requests);
      }
    },
  };
}

const FH: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1D": "D", "1W": "W", "1M": "M" };
const finnhub = keyed("finnhub", "Finnhub", "FINNHUB_API_KEY", (_m, tf) => !!FH[tf], async (ctx, req, key) => {
  const kind = req.market === "stock" ? "stock" : req.market === "crypto" ? "crypto" : "forex";
  const url = `https://finnhub.io/api/v1/${kind}/candle?symbol=${encodeURIComponent(req.providerSymbol)}&resolution=${FH[req.timeframe]}&from=${Math.floor(req.start / 1000)}&to=${Math.floor(req.end / 1000)}&token=${key}`;
  const j = (await (await fetchRetry(ctx, url, {}, 1100)).json()) as { s: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[] };
  if (j.s !== "ok" || !j.t) throw new ProviderError("NO_DATA", `finnhub: ${j.s}`, ctx.lastStatus);
  return j.t.map((t, i) => ({ ts: t * 1000, open: j.o![i]!, high: j.h![i]!, low: j.l![i]!, close: j.c![i]!, volume: j.v?.[i] ?? null }));
});

const OG: Record<string, string> = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1D": "D", "1W": "W", "1M": "M" };
const oanda = keyed("oanda", "OANDA", "OANDA_API_KEY", (m, tf) => (m === "forex" || m === "metal") && !!OG[tf], async (ctx, req, key) => {
  const inst = req.providerSymbol.replace("=X", "").replace(/^(\w{3})(\w{3})$/, "$1_$2");
  const out: Candle[] = [];
  let from = req.start;
  for (let p = 0; p < 50 && from < req.end; p++) {
    const url = `https://api-fxtrade.oanda.com/v3/instruments/${inst}/candles?granularity=${OG[req.timeframe]}&price=M&from=${new Date(from).toISOString()}&count=5000`;
    const j = (await (await fetchRetry(ctx, url, { headers: { Authorization: `Bearer ${key}` } }, 100)).json()) as { candles: { time: string; complete: boolean; volume: number; mid: { o: string; h: string; l: string; c: string } }[] };
    if (!j.candles?.length) break;
    for (const c of j.candles) if (c.complete) out.push({ ts: Date.parse(c.time), open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, volume: c.volume });
    const last = Date.parse(j.candles[j.candles.length - 1]!.time);
    if (j.candles.length < 5000 || last <= from) break;
    from = last + 1;
  }
  return out;
});

/* ---------------- Twelve Data (production, forex spot) ---------------- */
const TD: Record<string, string> = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1D": "1day" };
/** Initial scope: major pairs only. */
// Crypto: only USD-quoted pairs as their own instruments (BTC/USD ≠ BTCUSDT — never mapped).
const TD_PAIRS = new Set(["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "BTC/USD", "ETH/USD"]);
export const twelveDataSymbol = (s: string) => s.replace("=X", "").replace("_", "/").replace(/^([A-Z]{3})([A-Z]{3})$/, "$1/$2");
const tdTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const twelvedata = keyed("twelvedata", "TWELVE_DATA", "TWELVE_DATA_API_KEY", (m, tf) => (m === "forex" || m === "crypto") && !!TD[tf], async (ctx, req, key) => {
  const sym = twelveDataSymbol(req.providerSymbol);
  if (!TD_PAIRS.has(sym)) throw new ProviderError("NOT_SUPPORTED", `twelvedata: ${sym} not enabled (EUR/USD, GBP/USD, USD/JPY, AUD/USD)`);
  const out: Candle[] = [];
  let end = req.end;
  // Newest-first pages of ≤5000, walking backwards until start is reached.
  for (let p = 0; p < 20 && end > req.start; p++) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${TD[req.timeframe]}&start_date=${encodeURIComponent(tdTime(req.start))}&end_date=${encodeURIComponent(tdTime(end))}&timezone=UTC&outputsize=5000&order=desc&apikey=${key}`;
    const j = (await (await fetchRetry(ctx, url, {}, 8000 / 8)).json()) as { status?: string; code?: number; message?: string; values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] };
    if (j.status === "error") {
      const code = j.code ?? 0;
      if (code === 400 && /no data/i.test(j.message ?? "")) break;
      throw new ProviderError(code === 401 ? "AUTH_FAILED" : code === 429 ? "RATE_LIMITED" : code === 403 ? "NOT_ENTITLED" : "PROVIDER_ERROR", `twelvedata ${code}: ${(j.message ?? "").replace(/[A-Za-z0-9]{24,}/g, "***").slice(0, 180)}`, code, ctx.requests);
    }
    const vals = j.values ?? [];
    if (!vals.length) break;
    for (const v of vals) out.push({ ts: Date.parse(v.datetime.replace(" ", "T") + (v.datetime.length > 10 ? "Z" : "T00:00:00Z")), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: v.volume != null ? +v.volume : null });
    const oldest = Date.parse(vals[vals.length - 1]!.datetime.replace(" ", "T") + "Z");
    if (vals.length < 5000 || oldest >= end) break;
    end = oldest - 1000;
  }
  const sorted = [...out].sort((a, b) => a.ts - b.ts);
  console.log(`[twelvedata] ${sym} ${TD[req.timeframe]} requested ${new Date(req.start).toISOString()} → ${new Date(req.end).toISOString()} · returned=${out.length} first=${sorted[0] ? new Date(sorted[0].ts).toISOString() : "-"} last=${sorted.length ? new Date(sorted[sorted.length - 1]!.ts).toISOString() : "-"} requests=${ctx.requests}`);
  return out;
});

/** App symbols → Databento parent symbols (outright with most volume is kept). */
// Continuous volume-ranked lead contract: resolves dynamically across rolls; instrument_id kept per bar.
const DB_MAP: Record<string, string> = { "GC=F": "GC.v.0", GC: "GC.v.0", "GC.FUT": "GC.v.0", "CL=F": "CL.v.0", CL: "CL.v.0", "CL.FUT": "CL.v.0", "ES=F": "ES.v.0", "NQ=F": "NQ.v.0" };
export const databentoSymbol = (s: string) => DB_MAP[s.toUpperCase()] ?? s;
const DB_SCHEMA: Record<string, string> = { "1m": "ohlcv-1m", "1h": "ohlcv-1h", "1D": "ohlcv-1d" };
const databento = keyed("databento", "Databento", "DATABENTO_API_KEY", (m, tf) => (m === "futures" || m === "metal" || m === "stock") && !!DB_SCHEMA[tf], async (ctx, req, key) => {
  const dataset = req.market === "stock" ? "XNAS.ITCH" : "GLBX.MDP3";
  const auth = { Authorization: `Basic ${btoa(`${key}:`)}` };
  // Clamp to the dataset's available end (historical feed lags real time).
  let end = req.end;
  try {
    const r = await fetchRetry(ctx, `https://hist.databento.com/v0/metadata.get_dataset_range?dataset=${dataset}`, { headers: auth }, 200, 2);
    const range = (await r.json()) as { end?: string };
    if (range.end) { end = Math.min(end, Date.parse(range.end)); ctx.availableEnd = Date.parse(range.end); }
  } catch (e) {
    if (e instanceof ProviderError && e.state !== "PROVIDER_ERROR") throw e;
  }
  const sym = databentoSymbol(req.providerSymbol);
  const stype = /\.(FUT|OPT)$/i.test(sym) ? "parent" : /\.(c|n|v)\.\d+$/.test(sym) ? "continuous" : "raw_symbol";
  const body = new URLSearchParams({ dataset, symbols: sym, schema: DB_SCHEMA[req.timeframe]!, start: new Date(req.start).toISOString(), end: new Date(end).toISOString(), encoding: "dbn", compression: "zstd", stype_in: stype });
  const res = await fetchRetry(ctx, "https://hist.databento.com/v0/timeseries.get_range", { method: "POST", body, headers: auth }, 200);
  const file = decodeDbn(new Uint8Array(await res.arrayBuffer()));
  const bars = stype === "parent" ? dominantInstrument(file.bars) : file.bars;
  console.log(`[databento] ${sym} ${req.timeframe} requested ${new Date(req.start).toISOString()} → ${new Date(req.end).toISOString()} (dataset end ${new Date(end).toISOString()}) · records=${file.recordsRead} bars=${bars.length} first=${bars[0] ? new Date(bars[0].ts).toISOString() : "-"} last=${bars.length ? new Date(bars[bars.length - 1]!.ts).toISOString() : "-"}`);
  return bars.map((b) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, instrumentId: b.instrumentId }));
});

/**
 * Databento OHLCV emits no record for intervals without trades. For each absent bar,
 * check the Trades schema: none → NO_TRADE_INTERVAL; trades present → TRUE_DATA_GAP.
 * Returns the set of bar timestamps verified as no-trade. Never fills candles.
 */
async function databentoNoTrade(req: FetchRequest, absent: number[], stepMs: number): Promise<Set<number> | null> {
  const key = process.env["DATABENTO_API_KEY"];
  if (!key || !absent.length || absent.length > 2000) return absent.length ? null : new Set();
  const ctx = newCtx("databento");
  const auth = { Authorization: `Basic ${btoa(`${key}:`)}` };
  const sym = databentoSymbol(req.providerSymbol);
  const stype = /\.(c|n|v)\.\d+$/.test(sym) ? "continuous" : "raw_symbol";
  // merge contiguous absent bars into ranges → one Trades request per range
  // Cluster nearby absent bars (≤10 bars apart) so one Trades request covers several gaps.
  const ranges: [number, number][] = [];
  for (const t of absent) { const l = ranges[ranges.length - 1]; if (l && t - l[1] <= 10 * stepMs) l[1] = t + stepMs; else ranges.push([t, t + stepMs]); }
  const absentSet = new Set(absent);
  const noTrade = new Set<number>();
  const dataset = req.market === "stock" ? "XNAS.ITCH" : "GLBX.MDP3";
  const check = async ([a, b]: [number, number]) => {
    const body = new URLSearchParams({ dataset, symbols: sym, schema: "trades", start: new Date(a).toISOString(), end: new Date(b).toISOString(), encoding: "dbn", compression: "zstd", stype_in: stype });
    const res = await fetchRetry(ctx, "https://hist.databento.com/v0/timeseries.get_range", { method: "POST", body, headers: auth }, 100);
    const traded = new Set(decodeDbnTimestamps(new Uint8Array(await res.arrayBuffer())).map((ts) => Math.floor(ts / stepMs) * stepMs));
    for (let t = a; t < b; t += stepMs) if (absentSet.has(t) && !traded.has(t)) noTrade.add(t);
  };
  for (let i = 0; i < ranges.length; i += 8) await Promise.all(ranges.slice(i, i + 8).map(check));
  return noTrade;
}

binance.tier = "PRODUCTION";
oanda.tier = "PRODUCTION";
twelvedata.tier = "PRODUCTION";
databento.tier = "PRODUCTION";
finnhub.tier = "DISABLED"; // current plan returns 403 for candles
yahoo.tier = "BACKUP_ONLY"; yahoo.production = false;
export const PROVIDERS: HistoricalDataProvider[] = [binance, oanda, twelvedata, databento, finnhub, yahoo];

/**
 * Crypto routing option. Binance is BLOCKED_BY_SERVER_REGION (HTTP 403 on /ping from this backend),
 * so production crypto routes to Twelve Data. Switch back to "binance" only after probeBinance passes.
 * Twelve Data serves only its own USD pairs (BTC/USD, ETH/USD); USDT symbols then return NOT_SUPPORTED — never substituted.
 */
export const CRYPTO_ROUTING = "twelvedata" as "binance" | "twelvedata";
/** Source routing: crypto → CRYPTO_ROUTING, OANDA → forex spot, Databento → futures/gold/oil/indices/stocks, Yahoo → backup only. */
const PRIMARY: Partial<Record<MarketType, HistoricalDataProvider>> = { crypto: CRYPTO_ROUTING === "binance" ? binance : twelvedata, forex: oanda, futures: databento, metal: databento, stock: databento } as never;

/** Provider Resolver. Never silent: a backup substitution is returned with an explicit note. */
export function resolveProvider(market: MarketType, timeframe: string): { prov: HistoricalDataProvider | null; note?: string } {
  const primary = PRIMARY[market] ?? null;
  if (market === "crypto") return primary && primary.supports(market, timeframe) && primary.configured() ? { prov: primary } : { prov: null, note: `${primary?.label ?? "crypto"} NOT_CONFIGURED/NOT_SUPPORTED ${timeframe}` };
  if (primary && primary.supports(market, timeframe) && primary.configured()) return { prov: primary };
  // Forex: OANDA not configured → Twelve Data (explicit production source, never Yahoo while configured).
  if (market === "forex" && twelvedata.configured()) return twelvedata.supports(market, timeframe) ? { prov: twelvedata } : { prov: null, note: `twelvedata NOT_SUPPORTED ${timeframe}` };
  if (yahoo.supports(market, timeframe)) {
    const why = primary ? `${primary.label} ${primary.configured() ? "NOT_SUPPORTED " + timeframe : "NOT_CONFIGURED"}` : "no production source";
    return { prov: yahoo, note: `EXPLICIT_BACKUP: ${why} → Yahoo BACKUP_ONLY (not verifiable)` };
  }
  return { prov: primary };
}

async function recordHealth(id: string, ok: boolean, ms: number, state: ProviderState, http: number | null, requests: number, error?: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("use_provider_health").select("*").eq("provider", id).maybeSingle();
  const now = new Date().toISOString();
  await supabaseAdmin.from("use_provider_health").upsert({
    provider: id,
    configured: state !== "NOT_CONFIGURED",
    last_status: state,
    last_error: ok ? (data?.last_error ?? null) : (error ?? null),
    last_latency_ms: ms,
    last_http_status: http,
    last_success_at: ok ? now : (data?.last_success_at ?? null),
    last_failure_at: ok ? (data?.last_failure_at ?? null) : now,
    request_count: (data?.request_count ?? 0) + requests,
    success_count: (data?.success_count ?? 0) + (ok ? 1 : 0),
    failure_count: (data?.failure_count ?? 0) + (ok ? 0 : 1),
    rate_limit_state: state === "RATE_LIMITED" ? "RATE_LIMITED" : "OK",
    updated_at: now,
  });
}

export async function readCache(symbol: string, timeframe: string, source: string, start: number, end: number): Promise<Candle[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The API caps each response at 1000 rows → page through the range.
  const rows: { ts: string; open: number; high: number; low: number; close: number; volume: number | null }[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await supabaseAdmin.from("use_candles").select("ts,open,high,low,close,volume")
      .eq("symbol", symbol).eq("timeframe", timeframe).eq("source", source)
      .gte("ts", new Date(start).toISOString()).lt("ts", new Date(end).toISOString()).order("ts").range(from, from + 999);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const m = new Map<number, Candle>();
  for (const r of rows) m.set(Date.parse(r.ts), { ts: Date.parse(r.ts), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

export type PipelineResult = { candles: Candle[]; coverage: DataCoverageReport; fromCache: boolean ; availableEnd?: number };

/**
 * The only historical fetch path. No silent provider switching: a failure is reported
 * as BLOCKED_REAL_PROVIDER_FETCH_FAILED. The cache is only used for the SAME provider
 * and is labelled in the report (providerChanges).
 */
export async function fetchHistorical(req: FetchRequest, providerId?: string): Promise<PipelineResult> {
  const exchange = exchangeFor(req.market, req.providerSymbol);
  const resolved = providerId ? { prov: PROVIDERS.find((p) => p.id === providerId) ?? null } : resolveProvider(req.market, req.timeframe);
  const prov = resolved.prov;
  const step = stepOf(req.timeframe);
  const requested = prov?.id ?? providerId ?? "none";
  let res: AdapterResult = { candles: [], duplicates: 0, httpStatus: 0, requests: 0 };
  let error: string | undefined;
  let state: ProviderState = "OK";
  let fromCache = false;
  const changes: string[] = resolved.note ? [resolved.note] : [];
  const t0 = Date.now();
  if (prov?.tier === "DISABLED") { error = `${prov.id}: DISABLED (plan does not include historical candles)`; state = "NOT_SUPPORTED"; }
  else if (!prov) { error = "NO_PROVIDER_FOR_MARKET_TIMEFRAME"; state = "NOT_SUPPORTED"; }
  else if (!prov.supports(req.market, req.timeframe)) { error = `${prov.id}: NOT_SUPPORTED for ${req.market} ${req.timeframe}`; state = "NOT_SUPPORTED"; }
  else if (await blockedUntil(prov.id)) { const until = await blockedUntil(prov.id); error = `${prov.id}: PROVIDER_ACCESS_BLOCKED — backing off until ${until}`; state = "PROVIDER_ACCESS_BLOCKED"; }
  else {
    try {
      res = await prov.fetch(req);
      if (!res.candles.length) { state = "NO_DATA"; error = `${prov.id}: NO_DATA in window`; }
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("PROVIDER_ERROR", (e as Error).message);
      state = pe.state; error = pe.message; res.httpStatus = pe.httpStatus ?? 0; res.requests = pe.requests;
      if (pe.detail) await logFailure(prov.id, pe.detail, state, "fetchHistorical").catch(() => undefined);
    }
    await updateBlockState(prov.id, state, error).catch(() => undefined);
    await recordHealth(prov.id, state === "OK", Date.now() - t0, state, res.httpStatus || null, res.requests, error).catch(() => undefined);
    if (state !== "OK" && state !== "NOT_CONFIGURED") {
      const cached = await readCache(req.symbol, req.timeframe, prov.id, req.start, req.end);
      if (cached.length) { res = { ...res, candles: cached }; fromCache = true; changes.push(`cache:${prov.id} (live fetch failed: ${state})`); }
    }
  }
  // Bars after the provider's published dataset end do not exist yet — never count them as missing.
  const covEnd = res.availableEnd && res.availableEnd < req.end ? Math.floor(res.availableEnd / step) * step : req.end;
  if (covEnd < req.end) changes.push(`${prov?.id}: dataset available until ${new Date(covEnd).toISOString()} (historical feed lag)`);
  const covArgs = {
    requestedProvider: requested, actualProvider: res.candles.length ? requested : null,
    dataset: `${req.symbol}:${req.timeframe}`, market: req.market, exchange, timeframe: req.timeframe, stepMs: step,
    start: req.start, end: covEnd, candles: res.candles, duplicates: res.duplicates,
    providerChanges: changes, providerTier: prov?.tier ?? "PRODUCTION", providerState: state, ...(error ? { error } : {}),
    ...(prov?.id === "databento" ? { continuousSymbol: databentoSymbol(req.providerSymbol) } : {}),
  };
  let coverage = buildCoverage(covArgs);
  if (prov?.id === "databento" && res.candles.length && coverage.missingBars > 0 && step < 86_400_000) {
    const have = new Set(res.candles.map((c) => c.ts));
    const absent = expectedBars(exchange, step, req.start, Math.min(covEnd, Math.floor(Date.now() / step) * step)).filter((t) => !have.has(t));
    try {
      const noTradeTs = await databentoNoTrade(req, absent, step);
      if (noTradeTs) coverage = buildCoverage({ ...covArgs, noTradeTs });
    } catch (e) { changes.push(`trade-gap check failed: ${(e as Error).message}`); }
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("use_data_fetches").insert({
    symbol: req.symbol, timeframe: req.timeframe, requested_provider: requested,
    actual_provider: coverage.actualProvider, status: coverage.status, coverage: coverage as never,
  });
  if (res.candles.length && !fromCache && prov) {
    const rows = res.candles.map((c) => ({ symbol: req.symbol, timeframe: req.timeframe, ts: new Date(c.ts).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, source: prov.id, ...(c.instrumentId != null ? { instrument_id: c.instrumentId } : {}) }));
    for (let i = 0; i < rows.length; i += 500) await supabaseAdmin.from("use_candles").upsert(rows.slice(i, i + 500), { onConflict: "symbol,timeframe,ts" });
  }
  return { candles: res.candles, coverage, fromCache, ...(res.availableEnd ? { availableEnd: res.availableEnd } : {}) };
}

export function providerStatus() {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, production: p.production, tier: p.tier ?? "PRODUCTION", configured: p.configured() }));
}

/* ---------------- Provider access-block state, failure log and probe ---------------- */

let egressCache: { ip: string | null; region: string | null; at: number } | null = null;
/** Outbound IP + edge region of THIS runtime (same one the scheduled worker uses). */
export async function egressInfo() {
  if (egressCache && Date.now() - egressCache.at < 600_000) return egressCache;
  try {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    const kv = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=") as [string, string]));
    egressCache = { ip: kv["ip"] ?? null, region: [kv["colo"], kv["loc"]].filter(Boolean).join("/") || null, at: Date.now() };
  } catch { egressCache = { ip: null, region: null, at: Date.now() }; }
  return egressCache;
}

async function logFailure(provider: string, d: FailureDetail, classification: string, source: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const eg = await egressInfo();
  await supabaseAdmin.from("use_provider_failures").insert({
    provider, endpoint: d.endpoint, method: d.method, http_status: d.status, classification: d.status === 403 ? "PROVIDER_ACCESS_BLOCKED / WAF_BLOCK" : classification,
    response_body: d.body, response_headers: d.headers, weight_headers: d.weight, server_region: eg.region, outbound_ip: eg.ip, source,
  });
}

async function blockedUntil(provider: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("use_provider_health").select("blocked_until").eq("provider", provider).maybeSingle();
  return data?.blocked_until && Date.parse(data.blocked_until) > Date.now() ? data.blocked_until : null;
}

/** 403 → controlled backoff (2,4,8… up to 30 min) and DEGRADED; any success clears it. */
async function updateBlockState(provider: string, state: ProviderState, error?: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (state === "OK") {
    await supabaseAdmin.from("use_provider_health").update({ degraded: false, degraded_reason: null, blocked_until: null, consecutive_blocks: 0 }).eq("provider", provider);
    return;
  }
  if (state === "RATE_LIMITED" && /credits for the day/i.test(error ?? "")) {
    // Daily quota exhausted: stop calling until the provider resets at 00:00 UTC.
    const d = new Date(); d.setUTCHours(24, 0, 30, 0);
    await supabaseAdmin.from("use_provider_health").update({ degraded: true, degraded_reason: `${provider.toUpperCase()}_DAILY_CREDITS_EXHAUSTED`, blocked_until: d.toISOString() }).eq("provider", provider);
    return;
  }
  if (state !== "PROVIDER_ACCESS_BLOCKED" || error?.includes("backing off")) return;
  const { data } = await supabaseAdmin.from("use_provider_health").select("consecutive_blocks").eq("provider", provider).maybeSingle();
  const n = (data?.consecutive_blocks ?? 0) + 1;
  await supabaseAdmin.from("use_provider_health").update({
    degraded: true, degraded_reason: `${provider.toUpperCase()}_DEGRADED: HTTP 403 PROVIDER_ACCESS_BLOCKED / WAF_BLOCK`,
    blocked_until: new Date(Date.now() + Math.min(2 ** n, 30) * 60_000).toISOString(), consecutive_blocks: n,
  }).eq("provider", provider);
}

/** ping → time → klines from the running backend. Success clears DEGRADED. */
export async function probeBinance(source: string) {
  const eg = await egressInfo();
  const steps: { endpoint: string; status: number | null; ms: number; ok: boolean; note?: string }[] = [];
  for (const path of ["/api/v3/ping", "/api/v3/time", "/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5"]) {
    const url = BINANCE_BASE + path; const t0 = Date.now();
    try {
      const res = await fetch(url);
      const body = await res.text();
      let note: string | undefined;
      if (res.ok && path.includes("klines")) { const rows = JSON.parse(body) as number[][]; note = `${rows.length} bars, last open ${new Date(Number(rows.at(-1)?.[0])).toISOString()}`; }
      steps.push({ endpoint: path, status: res.status, ms: Date.now() - t0, ok: res.ok, ...(note ? { note } : {}) });
      if (!res.ok) await logFailure("binance", failureDetail(url, "GET", res, body), "PROBE", source).catch(() => undefined);
    } catch (e) { steps.push({ endpoint: path, status: null, ms: Date.now() - t0, ok: false, note: (e as Error).message }); }
  }
  const ok = steps.every((s) => s.ok);
  const probe = { at: new Date().toISOString(), source, outboundIp: eg.ip, region: eg.region, host: BINANCE_BASE, ok, steps };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("use_provider_health").update({ last_probe: probe as never }).eq("provider", "binance");
  if (ok) await updateBlockState("binance", "OK");
  return probe;
}

/**
 * Databento server-side health check. Classifies without exposing the key:
 * KEY_MISSING · INVALID_OR_REVOKED_KEY (401) · AUTH_FAILED (403) · DELAYED_BY_PLAN (historical end lags) · LIVE_ENTITLEMENT_MISSING · OK.
 */
export async function probeDatabento() {
  const key = process.env["DATABENTO_API_KEY"];
  const at = new Date().toISOString();
  if (!key) return { at, category: "KEY_MISSING", httpStatus: null, datasetEnd: null, delaySec: null };
  const r = await fetch("https://hist.databento.com/v0/metadata.get_dataset_range?dataset=GLBX.MDP3", { headers: { Authorization: `Basic ${btoa(`${key}:`)}` } });
  const raw = await r.text(); const body = raw.replace(/db-[A-Za-z0-9]+/g, "***").slice(0, 300);
  if (r.status === 401) return { at, category: "INVALID_OR_REVOKED_KEY", httpStatus: 401, datasetEnd: null, delaySec: null, detail: body };
  if (r.status === 403) return { at, category: "AUTH_FAILED", httpStatus: 403, datasetEnd: null, delaySec: null, detail: body };
  if (!r.ok) return { at, category: "PROVIDER_ERROR", httpStatus: r.status, datasetEnd: null, delaySec: null, detail: body };
  const end = (JSON.parse(raw) as { end?: string }).end ?? null;
  const endMs = end ? Date.parse(end) : NaN;
  const delaySec = Number.isFinite(endMs) ? Math.round((Date.now() - endMs) / 1000) : null;
  // Historical API only; live gateway not provisioned → live forecasts stay BLOCKED_PROVIDER_DELAYED.
  const category = delaySec !== null && delaySec > 600 ? "DELAYED_BY_PLAN" : "OK";
  return { at, category, httpStatus: 200, datasetEnd: end, delaySec, liveEntitlement: "LIVE_ENTITLEMENT_MISSING", historical: "ENABLED" };
}
