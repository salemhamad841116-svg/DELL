// Parameter sensitivity sweep over the same candles and settings as the latest stored backtest run.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({ strategyId: z.string().uuid(), symbol: z.string().min(1).max(40), timeframe: z.string().min(1).max(10) });

export const runSensitivitySweep = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { buildIR } = await import("./strategy/ir");
    const { runSensitivity, runWalkForward } = await import("./analysis/sensitivity");
    const { fetchHistorical, resolveProvider } = await import("./data/providers.server");
    const { marketOf } = await import("./market-data.server");
    const { aggregateCandles } = await import("./aggregate");
    const { getTimeframe } = await import("./timeframes");
    const { data: s } = await db.from("use_strategies").select("id,code,language,version").eq("id", data.strategyId).single();
    if (!s) throw new Error("Strategy not found");
    const { data: run } = await db.from("use_backtest_runs").select("id,settings,period_start,period_end,dataset_hash")
      .eq("strategy_id", s.id).eq("symbol", data.symbol).eq("timeframe", data.timeframe).like("status", "COMPLETED%")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!run) return { status: "BLOCKED_NO_BACKTEST", message: "Run a Professional Backtest for this strategy/symbol/timeframe first." };
    const { data: sym } = await db.from("use_symbols").select("symbol,asset_class,provider_symbol,dataset").eq("symbol", data.symbol).single();
    if (!sym) throw new Error("Symbol not in catalog");
    const spec = getTimeframe(data.timeframe)!;
    const market = marketOf(sym as never);
    const baseTf = resolveProvider(market, data.timeframe).prov?.supports(market, data.timeframe) ? data.timeframe : (spec.aggregateFrom ?? data.timeframe);
    const f = await fetchHistorical({ symbol: sym.symbol, providerSymbol: sym.provider_symbol, market, timeframe: baseTf, start: Date.parse(run.period_start), end: Date.parse(run.period_end) });
    if (!f.candles.length) return { status: "BLOCKED_INCOMPLETE_HISTORICAL_DATA", message: f.coverage.error ?? f.coverage.status };
    const candles = baseTf === data.timeframe ? f.candles : aggregateCandles(f.candles, data.timeframe);
    const ir = await buildIR(s.code, { strategyId: s.id, version: s.version, language: s.language });
    const st = run.settings as Record<string, unknown>;
    const settings = { ...st, fillPolicy: "CONSERVATIVE_SL_FIRST", params: (st["params"] as Record<string, unknown>) ?? {} } as never;
    const rep = runSensitivity(ir, candles, settings, { tickerid: sym.symbol, timeframe: data.timeframe, periodsPerYear: market === "crypto" ? 365 : 252, market, chartStepMs: spec.seconds * 1000 });
    const walkForward = runWalkForward(ir, candles, settings, { tickerid: sym.symbol, timeframe: data.timeframe, periodsPerYear: market === "crypto" ? 365 : 252, market, chartStepMs: spec.seconds * 1000 });
    return { status: "OK", walkForward, backtestRunId: run.id, bars: candles.length, provider: f.coverage.actualProvider, periodStart: run.period_start, periodEnd: run.period_end, fillPolicy: "CONSERVATIVE_SL_FIRST", ...rep };
  });
