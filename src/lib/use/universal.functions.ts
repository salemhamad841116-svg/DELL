// Universal Strategy Engine: static analysis + quant analysis on the latest stored backtest run.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({ strategyId: z.string().uuid(), symbol: z.string().min(1).max(40), timeframe: z.string().min(1).max(10) });

export const runUniversalAnalysis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { buildIR, sha256 } = await import("./strategy/ir");
    const { runUniversal } = await import("./analysis/universal");
    const { getTimeframe } = await import("./timeframes");
    const { data: s } = await db.from("use_strategies").select("id,name,code,language,version").eq("id", data.strategyId).single();
    if (!s) throw new Error("Strategy not found");
    const ir = await buildIR(s.code, { strategyId: s.id, version: s.version, language: s.language });
    const { data: run } = await db.from("use_backtest_runs").select("id,trades,status,coverage_status,settings,metrics,period_start,period_end,dataset_hash,provider")
      .eq("strategy_id", s.id).eq("symbol", data.symbol).eq("timeframe", data.timeframe).like("status", "COMPLETED%")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const step = (getTimeframe(data.timeframe)?.seconds ?? 60) * 1000;
    const bt = run ? {
      runId: run.id, trades: (run.trades ?? []) as never, status: run.status, coverageStatus: run.coverage_status,
      initialCapital: Number((run.settings as Record<string, unknown>)?.["initialCapital"] ?? 10000),
      observedDays: Number((run.metrics as Record<string, unknown>)?.["observedDays"] ?? 0), stepMs: step,
      periodStart: run.period_start, periodEnd: run.period_end, datasetHash: run.dataset_hash, provider: run.provider,
    } : null;
    const report = runUniversal(ir, data.timeframe, bt);
    const strategyHash = await sha256(s.code);
    const full = { ...report, strategy: { id: s.id, name: s.name, version: s.version }, backtestRunId: bt?.runId ?? null };
    const { data: row, error } = await db.from("use_analysis_runs").insert({
      strategy_id: s.id, strategy_hash: strategyHash, symbol: data.symbol, timeframe: data.timeframe, provider: bt?.provider ?? null,
      dataset_hash: bt?.datasetHash ?? null, period_start: bt?.periodStart ?? null, period_end: bt?.periodEnd ?? null, status: report.status, report: full as never,
    }).select("id,analysis_id").single();
    if (error) throw new Error(error.message);
    return { json: JSON.stringify({ id: row.id, analysisId: row.analysis_id, strategyHash, ...full }) };
  });
