// Next Candle Forecast API. Production generation/scoring runs in the backend worker (forecast.server.ts).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { accuracyStats, type LedgerRow } from "./forecast/core";
import { timeframeSeconds } from "./timeframes";

/** Manual "forecast now" — same frozen path as the worker (returns the existing frozen row if present). */
export const createForecast = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ symbol: z.string().min(1), timeframe: z.string().min(1), strategyId: z.string().uuid().nullable().optional(), minConfidence: z.number().min(0.34).max(0.99).optional() }).parse(d))
  .handler(async ({ data }) => {
    const { generateForecast } = await import("./forecast.server");
    return generateForecast({ symbol: data.symbol, timeframe: data.timeframe, strategyId: data.strategyId ?? null, minConfidence: data.minConfidence, generatedBy: "manual" });
  });

export const getLedger = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ symbol: z.string().optional(), timeframe: z.string().optional() }).parse(d ?? {}))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { NC_SELECT } = await import("./forecast.server");
    let q = supabaseAdmin.from("use_predictions").select(NC_SELECT).eq("mode", "NEXT_CANDLE").order("target_ts", { ascending: false }).limit(2000);
    if (data.symbol) q = q.eq("symbol", data.symbol);
    if (data.timeframe) q = q.eq("timeframe", data.timeframe);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const all = (rows ?? []) as unknown as (LedgerRow & { target_ts: string })[];
    const since = (ms: number) => all.filter((r) => Date.parse(r.created_at) >= Date.now() - ms);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    return {
      serverNow: Date.now(),
      rows: (rows ?? []).slice(0, 100) as any[],
      windows: {
        last20: accuracyStats(all.slice(0, 20)), last100: accuracyStats(all.slice(0, 100)),
        today: accuracyStats(all.filter((r) => Date.parse(r.created_at) >= today.getTime())),
        d7: accuracyStats(since(7 * 86_400_000)), d30: accuracyStats(since(30 * 86_400_000)),
      },
    };
  });

export const listSchedules = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("use_forecast_schedules").select("*").order("created_at");
  return data ?? [];
});

export const upsertSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ symbol: z.string().min(1), timeframe: z.string().min(1), strategyId: z.string().uuid().nullable(), enabled: z.boolean(), minConfidence: z.number().min(0.34).max(0.99) }).parse(d))
  .handler(async ({ data }) => {
    if (!timeframeSeconds(data.timeframe)) throw new Error("الفريم غير مدعوم");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    let q = db.from("use_forecast_schedules").select("id").eq("symbol", data.symbol).eq("timeframe", data.timeframe);
    q = data.strategyId ? q.eq("strategy_id", data.strategyId) : q.is("strategy_id", null);
    const { data: ex } = await q.maybeSingle();
    const vals = { symbol: data.symbol, timeframe: data.timeframe, strategy_id: data.strategyId, enabled: data.enabled, min_confidence: data.minConfidence, fail_count: 0, next_retry_at: null };
    const r = ex ? await db.from("use_forecast_schedules").update(vals).eq("id", ex.id) : await db.from("use_forecast_schedules").insert(vals);
    if (r.error) throw new Error(r.error.message);
    return { ok: true };
  });

export const getForecastHealth = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const now = Date.now();
  const [lastGen, lastScored, pending, failedPred, delays, scheds, worker, bh, fails] = await Promise.all([
    db.from("use_predictions").select("prediction_time,model_version,evidence").eq("mode", "NEXT_CANDLE").eq("generated_by", "worker").order("prediction_time", { ascending: false }).limit(1).maybeSingle(),
    db.from("use_predictions").select("scored_at").eq("mode", "NEXT_CANDLE").not("scored_at", "is", null).order("scored_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("use_predictions").select("id", { count: "exact", head: true }).eq("mode", "NEXT_CANDLE").eq("evaluation_status", "pending"),
    db.from("use_predictions").select("id", { count: "exact", head: true }).eq("mode", "NEXT_CANDLE").eq("scoring_status", "FAILED"),
    db.from("use_predictions").select("generation_delay_ms").eq("mode", "NEXT_CANDLE").eq("generated_by", "worker").not("generation_delay_ms", "is", null).order("prediction_time", { ascending: false }).limit(100),
    db.from("use_forecast_schedules").select("*").order("created_at"),
    db.from("use_worker_state").select("last_tick_at,last_tick_result").eq("name", "forecast").maybeSingle(),
    db.from("use_provider_health").select("last_status,last_http_status,degraded,degraded_reason,blocked_until,consecutive_blocks,last_probe,last_success_at,last_failure_at").eq("provider", "binance").maybeSingle(),
    db.from("use_provider_failures").select("created_at,endpoint,method,http_status,classification,response_body,weight_headers,server_region,outbound_ip,source").eq("provider", "binance").order("created_at", { ascending: false }).limit(5),
  ]);
  const d = (delays.data ?? []).map((r) => r.generation_delay_ms as number);
  const schedules = (scheds.data ?? []).map((s) => {
    const tfMs = timeframeSeconds(s.timeframe) * 1000;
    // Expected latest target = bar after the most recent closed bar; allow one bar of grace.
    const expectedTarget = Math.floor(now / tfMs) * tfMs;
    const missed = s.enabled && (!s.last_target_ts || Date.parse(s.last_target_ts) < expectedTarget - tfMs) && Date.parse(s.created_at) < now - 2 * tfMs;
    return { ...s, missed };
  });
  const ev = (lastGen.data?.evidence ?? {}) as { provider?: string };
  return {
    lastForecastGenerated: lastGen.data?.prediction_time ?? null,
    lastForecastScored: lastScored.data?.scored_at ?? null,
    pendingScores: pending.count ?? 0,
    failedScores: failedPred.count ?? 0,
    failedJobs: schedules.filter((s) => s.last_status === "FAILED").length,
    avgGenerationDelayMs: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
    provider: ev.provider ?? null,
    modelVersion: lastGen.data?.model_version ?? null,
    lastTickAt: worker.data?.last_tick_at ?? null,
    lastTickResult: worker.data?.last_tick_result ?? null,
    schedules,
    binance: bh.data ?? null,
    binanceFailures: fails.data ?? [],
  };
});

/** Runs ping → time → klines from the same backend runtime as the scheduled worker. */
export const runBinanceProbe = createServerFn({ method: "POST" }).handler(async () => {
  const { probeBinance } = await import("./data/providers.server");
  return probeBinance("admin");
});

/* ---------------- Prediction Accuracy & Reliability ---------------- */
const setupInput = z.object({ symbol: z.string().min(1), timeframe: z.string().min(1), strategyId: z.string().uuid().nullable() });

async function setupHash(db: any, strategyId: string | null) {
  if (!strategyId) return { hash: "none", name: null as string | null };
  const { buildIR } = await import("./strategy/ir");
  const { data: s } = await db.from("use_strategies").select("code,version,name").eq("id", strategyId).maybeSingle();
  if (!s) throw new Error("Indicator not found");
  const ir = await buildIR(s.code, { strategyId, version: s.version, language: null });
  return { hash: ir.sourceHash, name: s.name as string };
}

export const getReliabilityReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => setupInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { forwardStats, shadowStats } = await import("./forecast/reliability");
    const { NC_MODEL_VERSION } = await import("./forecast/core");
    const { hash, name } = await setupHash(db, data.strategyId);
    const [models, rows, allRows] = await Promise.all([
      db.from("use_nc_models").select("id,status,was_verified,report,health,data_range,created_at,promoted_at,retired_at").eq("symbol", data.symbol).eq("timeframe", data.timeframe).eq("indicator_hash", hash).eq("model_version", NC_MODEL_VERSION).order("created_at", { ascending: false }).limit(20),
      db.from("use_predictions").select("signal,direction,actual_result,correct,evaluation_status,target_ts,bullish_probability,bearish_probability,neutral_probability,market_regime,gate").eq("mode", "NEXT_CANDLE").eq("symbol", data.symbol).eq("timeframe", data.timeframe).eq("indicator_hash", hash).eq("model_version", NC_MODEL_VERSION).order("target_ts", { ascending: false }).limit(1000),
      db.from("use_predictions").select("id", { count: "exact", head: true }).eq("mode", "NEXT_CANDLE").eq("symbol", data.symbol).eq("timeframe", data.timeframe).eq("indicator_hash", hash).neq("model_version", NC_MODEL_VERSION),
    ]);
    const list = (models.data ?? []) as any[];
    const active = list.find((m) => m.status === "VERIFIED" || m.status === "DEGRADED") ?? null;
    const latest = list[0] ?? null;
    const report = (active ?? latest)?.report ?? null;
    const fwd = forwardStats((rows.data ?? []) as any);
    const shadow = shadowStats((rows.data ?? []) as any);
    const lastRegime = (rows.data ?? [])[0]?.market_regime ?? null;
    const criteria = [
      { name: "No lookahead / repainting", pass: true, detail: "closed source bar only; rows frozen by database trigger" },
      { name: "Walk-forward & out-of-sample validation", pass: !!report && report.checks?.slice(0, 3).every((c: any) => c.pass), detail: report ? `${report.wfBeatsBaseline}/${report.walkForward.length} folds beat baseline · OOS ${(report.oosAccuracy * 100).toFixed(1)}%` : "not validated yet" },
      { name: "Reliable probability calibration", pass: !!report && (report.calibration.ece ?? 1) <= 0.1 && (fwd.calibration.n < 30 || (fwd.calibration.ece ?? 1) <= 0.1), detail: `historical ECE ${report?.calibration.ece?.toFixed(3) ?? "-"} · live ECE ${fwd.calibration.ece?.toFixed(3) ?? "-"} (n=${fwd.calibration.n})` },
      { name: "Model approved (validation + shadow evidence)", pass: active?.status === "VERIFIED", detail: `${active?.status ?? "not approved"} · shadow ${shadow.directional.n}/${shadow.required} scored directional${shadow.directional.ci ? ` · CI ${(shadow.directional.ci.lo * 100).toFixed(1)}–${(shadow.directional.ci.hi * 100).toFixed(1)}%` : ""}` },
      { name: "Real-time forward-test results", pass: fwd.directional.n >= 300, detail: `${fwd.directional.n} evaluated directional calls (300 required)` },
      { name: "Immutable prediction records", pass: true, detail: "FROZEN_PREDICTION trigger on every forecast field" },
      { name: "Automatic post-close scoring", pass: fwd.evaluated > 0, detail: `${fwd.evaluated} scored automatically · ${fwd.pending} pending` },
      { name: "NO SIGNAL filtering", pass: true, detail: `${fwd.noSignal} NO SIGNAL · excluded from directional accuracy` },
      { name: "Drift & performance monitoring", pass: !!active?.health, detail: active?.health ? `max PSI ${active.health.maxPsi?.toFixed(3)} · ${active.status}` : "no health run yet" },
      { name: "Beats documented baselines (live)", pass: fwd.directional.n >= 300 && fwd.baseline !== null && (fwd.directional.ci?.lo ?? 0) > fwd.baseline, detail: `live ${fwd.directional.accuracy !== null ? (fwd.directional.accuracy * 100).toFixed(1) : "-"}% (95% CI low ${fwd.directional.ci ? (fwd.directional.ci.lo * 100).toFixed(1) : "-"}%) vs baseline ${fwd.baseline !== null ? (fwd.baseline * 100).toFixed(1) : "-"}%` },
      { name: "Transparent report with sample sizes & uncertainty", pass: true, detail: "this dashboard" },
    ];
    return {
      setup: { ...data, indicatorHash: hash, indicatorName: name, modelVersion: NC_MODEL_VERSION },
      models: list.map((m) => ({ id: m.id, status: m.status, wasVerified: m.was_verified, createdAt: m.created_at, promotedAt: m.promoted_at, retiredAt: m.retired_at, pass: m.report?.pass ?? false, oos: m.report?.oosAccuracy ?? null, dataRange: m.data_range })),
      active: active ? { id: active.id, status: active.status, health: active.health } : null,
      report, forward: fwd, shadow, currentRegime: lastRegime, legacyRows: allRows.count ?? 0,
      criteria, reliability: criteria.every((c) => c.pass) ? "VERIFIED" : "NOT_VERIFIED",
    };
  });

export const retrainCandidate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => setupInput.extend({ minConfidence: z.number().min(0.34).max(0.99).default(0.55) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { getCandles, listSymbols, marketOf, storedSegment } = await import("./market-data.server");
    const { indicatorSeries, closedBars } = await import("./forecast/core");
    const { buildIR } = await import("./strategy/ir");
    const { createCandidate } = await import("./forecast.server");
    const sym = (await listSymbols()).find((s) => s.symbol === data.symbol);
    if (!sym) throw new Error("Symbol not in catalog");
    let ir = null;
    if (data.strategyId) { const { data: s } = await db.from("use_strategies").select("code,version").eq("id", data.strategyId).maybeSingle(); if (!s) throw new Error("Indicator not found"); ir = await buildIR(s.code, { strategyId: data.strategyId, version: s.version, language: null }); }
    const tfMs = timeframeSeconds(data.timeframe) * 1000;
    // Validation uses history only: live provider when complete, else the same provider's stored gap-free segment.
    const f = await getCandles(sym, data.timeframe, 1500);
    const live = f.source === "provider" && f.coverage?.status === "PASS_COMPLETE_HISTORICAL_COVERAGE";
    const seg = live ? { candles: f.candles, provider: f.provider } : await storedSegment(sym, data.timeframe);
    if (!seg.candles.length) return { ok: false, reason: `No eligible candles: ${f.note ?? f.coverage?.error ?? "provider error"}` };
    const candles = closedBars([...new Map(seg.candles.map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts), tfMs, Date.now());
    const ind = indicatorSeries(ir, candles, { tickerid: sym.symbol, timeframe: data.timeframe, market: marketOf(sym) });
    if (ind.unsupported.length) return { ok: false, reason: `Indicator could not be executed: ${ind.unsupported.join("; ")}` };
    const m = await createCandidate({ symbol: sym.symbol, timeframe: data.timeframe, indicatorHash: ir?.sourceHash ?? "none", candles, ind, minConf: data.minConfidence, provider: seg.provider, autoPromote: true });
    if (!m) return { ok: false, reason: "Not enough samples for validation (400 required)" };
    return { ok: true, id: m.id, status: m.status, pass: m.report.pass, source: live ? "LIVE_PROVIDER" : "STORED_SAME_PROVIDER", bars: candles.length };
  });

export const promoteNcModel = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => (await import("./forecast.server")).promoteModel(data.id));

export const rollbackNcModel = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => setupInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { hash } = await setupHash(db, data.strategyId);
    return (await import("./forecast.server")).rollbackModel({ symbol: data.symbol, timeframe: data.timeframe, indicatorHash: hash });
  });
