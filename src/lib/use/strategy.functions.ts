// Phase 2 server API: Strategy IR, professional backtests (reproducible), symbol catalog.
// Consumes the frozen Phase 1 pipeline (fetchHistorical) — never a separate loader.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const settingsSchema = z.object({
  initialCapital: z.number().positive().optional(),
  qtyType: z.enum(["fixed", "percent_of_equity", "risk_percent"]).optional(),
  fillPolicy: z.enum(["CONSERVATIVE_SL_FIRST", "OPTIMISTIC_TP_FIRST", "LOWER_TIMEFRAME_RESOLUTION"]).optional(),
  riskAtrMult: z.number().positive().optional(),
  qty: z.number().positive().optional(),
  contractSize: z.number().positive().optional(),
  tickSize: z.number().positive().optional(),
  spread: z.number().min(0).optional(),
  slippageTicks: z.number().min(0).optional(),
  commissionType: z.enum(["percent", "per_contract", "per_order"]).optional(),
  commissionValue: z.number().min(0).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const runInput = z.object({
  strategyId: z.string().uuid(),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  start: z.string(),
  end: z.string(),
  settings: settingsSchema.optional(),
});

/** Key-order-independent JSON (jsonb reorders keys). */
const canon = (v: unknown): string => v && typeof v === "object" ? (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`) : JSON.stringify(v ?? null);

/** Futures contract model (CME/COMEX/NYMEX/CBOT published specs). Margins are exchange-set and
 * change often — not stored unless a verified source is connected (null = not available). */
export const FUTURES_SPECS: Record<string, { multiplier: number; tickSize: number; tickValue: number; currency: string; exchange: string }> = {
  GC: { multiplier: 100, tickSize: 0.1, tickValue: 10, currency: "USD", exchange: "COMEX" },
  SI: { multiplier: 5000, tickSize: 0.005, tickValue: 25, currency: "USD", exchange: "COMEX" },
  CL: { multiplier: 1000, tickSize: 0.01, tickValue: 10, currency: "USD", exchange: "NYMEX" },
  NG: { multiplier: 10000, tickSize: 0.001, tickValue: 10, currency: "USD", exchange: "NYMEX" },
  ES: { multiplier: 50, tickSize: 0.25, tickValue: 12.5, currency: "USD", exchange: "CME" },
  NQ: { multiplier: 20, tickSize: 0.25, tickValue: 5, currency: "USD", exchange: "CME" },
  YM: { multiplier: 5, tickSize: 1, tickValue: 5, currency: "USD", exchange: "CBOT" },
  "6E": { multiplier: 125000, tickSize: 0.00005, tickValue: 6.25, currency: "USD", exchange: "CME" },
  "6B": { multiplier: 62500, tickSize: 0.0001, tickValue: 6.25, currency: "USD", exchange: "CME" },
  "6J": { multiplier: 12500000, tickSize: 0.0000005, tickValue: 6.25, currency: "USD", exchange: "CME" },
};

function instrumentDefaults(symbol: string, asset: string) {
  const root = symbol.split(".")[0]!;
  const f = FUTURES_SPECS[root];
  if (f) return { tickSize: f.tickSize, contractSize: f.multiplier, qtyType: "fixed" as const, qty: 1, integerQty: true,
    contract: { root, ...f, initialMargin: null, maintenanceMargin: null, marginSource: "not available (no verified margin feed)" } };
  if (asset === "forex") return { tickSize: /JPY/.test(symbol) ? 0.001 : /XAU/.test(symbol) ? 0.01 : 0.00001, contractSize: 1, qtyType: "fixed" as const, qty: 10000, integerQty: false, contract: null };
  return { tickSize: 0.01, contractSize: 1, qtyType: "percent_of_equity" as const, qty: 100, integerQty: false, contract: null };
}

export const getStrategyIR = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildIR, irSummary } = await import("./strategy/ir");
    const { data: row, error } = await supabaseAdmin.from("use_strategies").select("id,name,code,language,version").eq("id", data.id).single();
    if (error || !row) throw new Error("Strategy not found");
    const ir = await buildIR(row.code, { strategyId: row.id, version: row.version, language: row.language });
    return { name: row.name, ir: JSON.parse(JSON.stringify(irSummary(ir))) as Record<string, never> };
  });

export const runProBacktest = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => runInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildIR, irSummary, sha256 } = await import("./strategy/ir");
    const { runProfessionalBacktest } = await import("./strategy/backtester");
    const { fetchHistorical, resolveProvider } = await import("./data/providers.server");
    const { marketOf } = await import("./market-data.server");
    const { aggregateCandles } = await import("./aggregate");
    const { getTimeframe } = await import("./timeframes");

    const { data: strat } = await supabaseAdmin.from("use_strategies").select("id,name,code,language,version,conversion,parent_indicator_id,source_indicator_hash,generated_strategy_hash").eq("id", data.strategyId).single();
    if (!strat) throw new Error("Strategy not found");
    const { data: sym } = await supabaseAdmin.from("use_symbols").select("symbol,display_name,asset_class,provider_symbol,dataset").eq("symbol", data.symbol).single();
    if (!sym) throw new Error("Symbol not in catalog");
    const spec = getTimeframe(data.timeframe);
    if (!spec?.supported) throw new Error(`Timeframe ${data.timeframe} not supported`);

    const ir = await buildIR(strat.code, { strategyId: strat.id, version: strat.version, language: strat.language });
    const market = marketOf(sym);
    const baseTf = resolveProvider(market, data.timeframe).prov?.supports(market, data.timeframe) ? data.timeframe : (spec.aggregateFrom ?? data.timeframe);
    const baseStep = (getTimeframe(baseTf)?.seconds ?? spec.seconds) * 1000;
    const start = Math.floor(Date.parse(data.start) / baseStep) * baseStep;
    const end = Math.floor(Date.parse(data.end) / baseStep) * baseStep;
    if (!(end > start)) throw new Error("Invalid period");

    const decl = (ir.declaration ?? {}) as Record<string, unknown>;
    const inst = instrumentDefaults(sym.symbol, sym.asset_class);
    const declQtyType = decl["default_qty_type"] === "strategy.percent_of_equity" ? "percent_of_equity" : decl["default_qty_type"] === "strategy.fixed" ? "fixed" : null;
    const settings = {
      initialCapital: Number(decl["initial_capital"] ?? 10000),
      qtyType: declQtyType ?? inst.qtyType,
      qty: Number(decl["default_qty_value"] ?? inst.qty),
      contractSize: inst.contractSize, tickSize: inst.tickSize, spread: 0, integerQty: inst.integerQty, contract: inst.contract,
      fillPolicy: "LOWER_TIMEFRAME_RESOLUTION" as "CONSERVATIVE_SL_FIRST" | "OPTIMISTIC_TP_FIRST" | "LOWER_TIMEFRAME_RESOLUTION", riskAtrMult: 1.5,
      slippageTicks: Number(decl["slippage"] ?? 0),
      commissionType: (decl["commission_type"] === "strategy.commission.cash_per_contract" ? "per_contract" : decl["commission_type"] === "strategy.commission.cash_per_order" ? "per_order" : "percent") as "percent" | "per_contract" | "per_order",
      commissionValue: Number(decl["commission_value"] ?? 0),
      params: {} as Record<string, unknown>,
    };
    for (const [k, v] of Object.entries(data.settings ?? {})) if (v !== undefined) (settings as Record<string, unknown>)[k] = v;
    // Converter lineage + execution settings travel with the IR and the backtest run.
    const conv = (strat as { conversion?: { execution?: unknown } | null }).conversion;
    if (conv?.execution) (settings as Record<string, unknown>)["conversionExecution"] = conv.execution;
    const lineage = strat.parent_indicator_id ? { parentIndicatorId: strat.parent_indicator_id, sourceIndicatorHash: strat.source_indicator_hash, generatedStrategyHash: strat.generated_strategy_hash, execution: conv?.execution ?? null } : null;

    const base = {
      strategy_id: strat.id, strategy_version: strat.version, strategy_hash: ir.sourceHash, source_language: ir.sourceLanguage,
      symbol: sym.symbol, timeframe: data.timeframe, period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString(),
      settings: settings as never, ir: { ...irSummary(ir), ...(lineage ? { conversion: lineage } : {}) } as never,
    };
    if (!ir.executable && (ir.scriptType === "INDICATOR" || ir.scriptType === "LIBRARY")) {
      return { runId: null, status: "NOT_EXECUTABLE_" + ir.scriptType, error: ir.notExecutableReason ?? "", diagnostics: ir.diagnostics };
    }
    if (!ir.executable) {
      const { data: row } = await supabaseAdmin.from("use_backtest_runs").insert({ ...base, status: "BLOCKED_UNSUPPORTED_SEMANTIC", error: ir.diagnostics.map((d) => `${d.code}: ${d.construct} (line ${d.line}:${d.col})`).join("\n") }).select("id,analysis_id").single();
      return { runId: row?.id ?? null, status: "BLOCKED_UNSUPPORTED_SEMANTIC", diagnostics: ir.diagnostics };
    }

    const t0 = new Date(Date.now() - 1000).toISOString();
    const fetched = await fetchHistorical({ symbol: sym.symbol, providerSymbol: sym.provider_symbol, market, timeframe: baseTf, start, end });
    const { data: cov } = await supabaseAdmin.from("use_data_fetches").select("id").eq("symbol", sym.symbol).eq("timeframe", baseTf).gte("created_at", t0).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const candles = baseTf === data.timeframe ? fetched.candles : aggregateCandles(fetched.candles, data.timeframe);
    const c = fetched.coverage;
    const dataFields = {
      provider: c.actualProvider, dataset: sym.dataset ?? c.dataset, coverage_report_id: cov?.id ?? null, coverage_status: c.status,
      coverage_percent: c.coveragePercent, bar_count: candles.length,
      dataset_hash: await sha256(candles.map((k) => `${k.ts},${k.open},${k.high},${k.low},${k.close},${k.volume ?? ""}`).join("\n")),
    };
    if (!candles.length || c.status.startsWith("BLOCKED")) {
      const { data: row } = await supabaseAdmin.from("use_backtest_runs").insert({ ...base, ...dataFields, status: "BLOCKED_DATA", error: c.error ?? c.status }).select("id").single();
      return { runId: row?.id ?? null, status: "BLOCKED_DATA", error: c.error ?? c.status };
    }

    try {
      const btMeta = { tickerid: sym.symbol, timeframe: data.timeframe, periodsPerYear: market === "crypto" ? 365 : 252, market, chartStepMs: spec.seconds * 1000 };
      let res = runProfessionalBacktest(ir, candles, { ...settings, fillPolicy: settings.fillPolicy === "LOWER_TIMEFRAME_RESOLUTION" ? "CONSERVATIVE_SL_FIRST" : settings.fillPolicy }, btMeta);
      let lowerTf: Record<string, unknown> | null = null;
      if (settings.fillPolicy === "LOWER_TIMEFRAME_RESOLUTION") {
        // Only fetch 1m (same frozen pipeline) when ambiguous same-bar TP/SL actually occurred.
        if (res.fillStats.ambiguousBars > 0 && data.timeframe !== "1m" && resolveProvider(market, "1m").prov?.supports(market, "1m")) {
          const l = await fetchHistorical({ symbol: sym.symbol, providerSymbol: sym.provider_symbol, market, timeframe: "1m", start, end: end + spec.seconds * 1000 });
          lowerTf = { timeframe: "1m", provider: l.coverage.actualProvider, status: l.coverage.status, coverage: l.coverage.coveragePercent, bars: l.candles.length };
          res = runProfessionalBacktest(ir, candles, settings, { ...btMeta, ltf: l.candles });
        } else {
          res = runProfessionalBacktest(ir, candles, settings, btMeta);
          lowerTf = { note: res.fillStats.ambiguousBars ? "1m data not available from provider — fallback CONSERVATIVE_SL_FIRST" : "no ambiguous same-bar TP/SL — lower TF not needed" };
        }
      }
      (res.fillStats as Record<string, unknown>)["lowerTf"] = lowerTf;
      const tradesHash = await sha256(JSON.stringify(res.trades.map((t) => [t.dir, t.entryTs, t.entryPx, t.exitTs, t.exitPx, t.qty, t.reason])));
      const { data: row, error } = await supabaseAdmin.from("use_backtest_runs").insert({
        ...base, ...dataFields, metrics: { ...res.metrics, openTrade: res.openTrade, fillStats: res.fillStats, warnings: res.warnings } as never, breakdowns: res.breakdowns as never,
        trades: res.trades as never, trades_hash: tradesHash, status: c.status === "PASS_COMPLETE_HISTORICAL_COVERAGE" ? "COMPLETED_VERIFIED_DATA" : "COMPLETED_PARTIAL_DATA",
      }).select("id,analysis_id,created_at,metrics").single();
      if (error) throw new Error(error.message);
      const { data: prevs } = await supabaseAdmin.from("use_backtest_runs").select("id,trades_hash,metrics,settings,created_at")
        .eq("strategy_hash", ir.sourceHash).eq("dataset_hash", dataFields.dataset_hash).eq("symbol", sym.symbol).eq("timeframe", data.timeframe)
        .neq("id", row.id).order("created_at", { ascending: false }).limit(20);
      // Reproducibility compares only runs with identical settings (incl. fill policy).
      const prev = (prevs ?? []).find((x) => canon(x.settings) === canon(JSON.parse(JSON.stringify(settings))));
      const reproducibility = prev ? { previousRunId: prev.id, sameTrades: prev.trades_hash === tradesHash, sameMetrics: canon(prev.metrics) === canon(row.metrics) } : null;
      return { runId: row.id, analysisId: row.analysis_id, status: "COMPLETED", tradesHash, datasetHash: dataFields.dataset_hash, strategyHash: ir.sourceHash, coverage: { status: c.status, percent: c.coveragePercent, provider: c.actualProvider }, barCount: candles.length, metrics: res.metrics, reproducibility };
    } catch (e) {
      const msg = (e as Error).message;
      const { data: row } = await supabaseAdmin.from("use_backtest_runs").insert({ ...base, ...dataFields, status: "FAILED_SEMANTIC", error: msg }).select("id").single();
      return { runId: row?.id ?? null, status: "FAILED_SEMANTIC", error: msg };
    }
  });

export const listProBacktests = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("use_backtest_runs")
    .select("id,analysis_id,strategy_id,strategy_version,strategy_hash,source_language,provider,dataset,symbol,timeframe,period_start,period_end,coverage_report_id,coverage_status,coverage_percent,bar_count,dataset_hash,trades_hash,status,error,metrics,created_at")
    .order("created_at", { ascending: false }).limit(40);
  return data ?? [];
});

export const getProBacktest = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin.from("use_backtest_runs").select("*").eq("id", data.id).single();
    return row;
  });

// ---------- Symbol catalog ----------
function statusFor(provider: string, configured: Record<string, boolean>): { status: string; detail: string } {
  if (provider === "finnhub") return { status: "NOT_ENTITLED", detail: "Finnhub plan returns 403 for candles" };
  if (!configured[provider]) return { status: "NOT_CONFIGURED", detail: `${provider} credentials not supplied — Yahoo BACKUP_ONLY may be used explicitly` };
  return { status: "AVAILABLE", detail: `${provider} production source` };
}

export const listSymbolCatalog = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { providerStatus } = await import("./data/providers.server");
  const configured = Object.fromEntries(providerStatus().map((p) => [p.id, p.configured]));
  const { data } = await supabaseAdmin.from("use_symbols").select("*").order("category").order("symbol");
  return (data ?? []).map((r) => {
    const live = statusFor(r.provider, configured);
    const status = r.status === "UNSUPPORTED" || (r.status === "NOT_ENTITLED" && live.status === "AVAILABLE") ? r.status : live.status;
    return { ...r, status, status_detail: status === r.status && r.status_detail ? r.status_detail : live.detail };
  });
});

export const syncSymbolCatalog = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { providerStatus } = await import("./data/providers.server");
  const configured = Object.fromEntries(providerStatus().map((p) => [p.id, p.configured]));
  const { data: rows } = await supabaseAdmin.from("use_symbols").select("symbol,provider,provider_symbol");
  const now = new Date().toISOString();
  const report: { provider: string; checked: number; available: number; note: string }[] = [];
  const set = async (symbol: string, status: string, detail: string) => { await supabaseAdmin.from("use_symbols").update({ status, status_detail: detail, synced_at: now }).eq("symbol", symbol); };

  // Binance: verify each symbol is TRADING on the exchange.
  const bin = (rows ?? []).filter((r) => r.provider === "binance");
  try {
    const r = await fetch("https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING");
    const j = (await r.json()) as { symbols?: { symbol: string }[] };
    const live = new Set((j.symbols ?? []).map((s) => s.symbol));
    let ok = 0;
    for (const s of bin) { const has = live.has(s.provider_symbol); if (has) ok++; await set(s.symbol, has ? "AVAILABLE" : "UNSUPPORTED", has ? "Binance TRADING" : "not listed/trading on Binance"); }
    report.push({ provider: "binance", checked: bin.length, available: ok, note: `HTTP ${r.status}` });
  } catch (e) { report.push({ provider: "binance", checked: bin.length, available: 0, note: (e as Error).message }); }

  // Databento: resolve continuous symbols through the symbology API.
  const db = (rows ?? []).filter((r) => r.provider === "databento");
  const key = process.env["DATABENTO_API_KEY"];
  if (!key) { for (const s of db) await set(s.symbol, "NOT_CONFIGURED", "DATABENTO_API_KEY missing"); report.push({ provider: "databento", checked: db.length, available: 0, note: "NOT_CONFIGURED" }); }
  else {
    try {
      const d = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
      const d2 = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10);
      const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: db.map((s) => s.provider_symbol).join(","), stype_in: "continuous", stype_out: "instrument_id", start_date: d, end_date: d2 });
      const r = await fetch("https://hist.databento.com/v0/symbology.resolve", { method: "POST", body, headers: { Authorization: `Basic ${btoa(`${key}:`)}` } });
      const j = (await r.json()) as { result?: Record<string, unknown[]>; not_found?: string[] };
      let ok = 0;
      for (const s of db) {
        const has = !!j.result?.[s.provider_symbol]?.length;
        if (has) ok++;
        await set(s.symbol, r.status === 401 ? "NOT_CONFIGURED" : r.status === 403 ? "NOT_ENTITLED" : has ? "AVAILABLE" : "UNSUPPORTED", has ? "Databento GLBX.MDP3 continuous resolved" : `HTTP ${r.status}: not resolved`);
      }
      report.push({ provider: "databento", checked: db.length, available: ok, note: `HTTP ${r.status}` });
    } catch (e) { report.push({ provider: "databento", checked: db.length, available: 0, note: (e as Error).message }); }
  }

  // OANDA: explicit status only, no silent substitution.
  const oa = (rows ?? []).filter((r) => r.provider === "oanda");
  for (const s of oa) await set(s.symbol, configured["oanda"] ? "AVAILABLE" : "NOT_CONFIGURED", configured["oanda"] ? "OANDA token present" : "OANDA token not supplied");
  report.push({ provider: "oanda", checked: oa.length, available: configured["oanda"] ? oa.length : 0, note: configured["oanda"] ? "configured" : "NOT_CONFIGURED" });
  return report;
});
