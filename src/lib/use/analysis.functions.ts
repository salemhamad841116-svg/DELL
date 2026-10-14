// Prediction API — server functions for the public analysis view and the admin
// console. Heavy work (feature build + training) runs here, never in the browser.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { MODEL_VERSION, horizonFromTrained, nextCandleForecast, runBacktest, trainTimeframe, unsupportedHorizon } from "./engine";
import { parseStrategy, validateSecurity, detectLanguage } from "./parser";
import { MATRIX_TIMEFRAMES, getTimeframe } from "./timeframes";
import type { HistoricalReport, HorizonForecast, NextCandleForecast, StrategyRepresentation } from "./types";

const analysisInput = z.object({
  symbol: z.string().min(1),
  strategyId: z.string().uuid().nullable().optional(),
  timeframe: z.string().min(1).default("15m"),
});

export type AnalysisResult = {
  symbol: string;
  displayName: string;
  timeframe: string;
  matrix: HorizonForecast[];
  nextCandle: NextCandleForecast | null;
  historical: HistoricalReport | null;
  strategy: { id: string | null; name: string; representation: StrategyRepresentation | null } | null;
  dataSource: string;
  warnings: string[];
  generatedAt: string;
};

export const getBootstrap = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [symbols, strategies] = await Promise.all([
    supabaseAdmin
      .from("use_symbols")
      .select("symbol,display_name,asset_class,provider,category")
      .eq("enabled", true)
      .order("symbol"),
    supabaseAdmin
      .from("use_strategies")
      .select("id,name,status,enabled,language,version,timeframes,symbols,validation,parent_indicator_id")
      .order("created_at", { ascending: true }),
  ]);
  return {
    symbols: symbols.data ?? [],
    strategies: strategies.data ?? [],
    timeframes: MATRIX_TIMEFRAMES,
  };
});

export const runAnalysis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => analysisInput.parse(d))
  .handler(async ({ data }): Promise<AnalysisResult> => {
    const { getCandles, listSymbols } = await import("./market-data.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const symbols = await listSymbols();
    const sym = symbols.find((s) => s.symbol === data.symbol) ?? symbols[0];
    if (!sym) throw new Error("لا توجد رموز مُهيأة");

    type StrategyRow = {
      id: string;
      name: string;
      code: string;
      representation: unknown;
      version: number;
    };
    let strategyRow: StrategyRow | null = null;
    if (data.strategyId) {
      const { data: row } = await supabaseAdmin
        .from("use_strategies")
        .select("id,name,code,representation,version")
        .eq("id", data.strategyId)
        .maybeSingle();
      strategyRow = (row as StrategyRow | null) ?? null;
    }
    const representation: StrategyRepresentation | null = strategyRow
      ? ((strategyRow.representation as StrategyRepresentation | null) ??
        parseStrategy(strategyRow.code ?? "", strategyRow.name))
      : null;

    const warnings: string[] = [];
    const matrix: HorizonForecast[] = [];
    let nextCandle: NextCandleForecast | null = null;
    let historical: HistoricalReport | null = null;
    let dataSource = "BLOCKED_REAL_PROVIDER_FETCH_FAILED";

    const primary = data.timeframe;
    const wanted = Array.from(new Set([primary, ...MATRIX_TIMEFRAMES]));

    for (const tf of wanted) {
      const spec = getTimeframe(tf);
      if (!spec || !spec.supported) {
        matrix.push(unsupportedHorizon(tf, "غير متاح من مزود البيانات — لا يتم تلفيق أرقام"));
        continue;
      }
      const fetched = await getCandles(sym, tf, tf === primary ? 1500 : 900);
      if (tf === primary && fetched.provider) {
        dataSource = fetched.source === "cache" ? `${fetched.provider} (مخزن مؤقتاً)` : fetched.provider;
        if (fetched.coverage) dataSource += ` · ${fetched.coverage.status} ${fetched.coverage.coveragePercent}%`;
      }
      if (fetched.note) warnings.push(`${tf}: ${fetched.note}`);
      if (fetched.candles.length < 300) {
        matrix.push(unsupportedHorizon(tf, `بيانات غير كافية (${fetched.candles.length} شمعة)`));
        continue;
      }
      const trained = trainTimeframe(fetched.candles, tf, representation);
      if (!trained) {
        matrix.push(unsupportedHorizon(tf, "عدد العينات أقل من الحد الأدنى للتدريب"));
        continue;
      }
      matrix.push(horizonFromTrained(trained));
      if (tf === primary) {
        nextCandle = nextCandleForecast(sym.symbol, trained, fetched.candles, representation);
        historical = runBacktest(sym.symbol, tf, fetched.candles, representation).report;
      }
    }

    if (nextCandle) {
      const target = nextCandle;
      await supabaseAdmin.from("use_predictions").insert({
        symbol: sym.symbol,
        timeframe: primary,
        strategy_id: strategyRow?.id ?? null,
        strategy_version: strategyRow?.version ?? null,
        model_version: MODEL_VERSION,
        input_data_version: target.dataTimestamp,
        market_regime: target.regime,
        direction: target.direction,
        bullish_probability: target.bullishProbability,
        bearish_probability: target.bearishProbability,
        neutral_probability: target.neutralProbability,
        confidence: target.confidence,
        expected_return: target.expectedReturn,
        expected_low: target.expectedLow,
        expected_high: target.expectedHigh,
        expected_volatility: target.expectedVolatility,
        data_quality: target.dataQuality,
        sample_size: target.sampleSize,
        evidence: target.evidence,
        reference_close: target.referenceClose,
        target_ts: new Date(
          new Date(target.dataTimestamp).getTime() + (getTimeframe(primary)?.seconds ?? 900) * 1000,
        ).toISOString(),
        evaluation_status: "pending",
      });

      if (historical) {
        await supabaseAdmin.from("use_backtests").insert({
          strategy_id: strategyRow?.id ?? null,
          symbol: sym.symbol,
          timeframe: primary,
          split: "full",
          period_start: historical.periodStart,
          period_end: historical.periodEnd,
          sample_size: historical.stats.observations,
          stats: historical.stats,
          patterns: {
            byHour: historical.byHour.slice(0, 8),
            byWeekday: historical.byWeekday,
            byRegime: historical.byRegime,
          },
        });
      }
    }

    return {
      symbol: sym.symbol,
      displayName: sym.display_name,
      timeframe: primary,
      matrix,
      nextCandle,
      historical,
      strategy: strategyRow
        ? { id: strategyRow.id, name: strategyRow.name, representation }
        : null,
      dataSource,
      warnings,
      generatedAt: new Date().toISOString(),
    };
  });

/* ------------------------------ Admin section ------------------------------ */

export const saveStrategy = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().nullable().optional(),
        name: z.string().min(2),
        description: z.string().optional().default(""),
        code: z.string().min(10),
        symbols: z.array(z.string()).default([]),
        timeframes: z.array(z.string()).default([]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const language = detectLanguage(data.code);
    const validation = validateSecurity(data.code, language);
    const representation = parseStrategy(data.code, data.name);
    // Detect Language → Syntax Parse → Detect Script Type → Validate → Save.
    // Absence of orders only disables backtesting; it never blocks saving.
    const { buildIR } = await import("./strategy/ir");
    const ir = await buildIR(data.code, { language });
    const script = {
      scriptType: ir.scriptType,
      validity: ir.validity,
      scriptStatus: ir.executable ? "EXECUTABLE_STRATEGY" : ir.scriptType === "INDICATOR" ? "INDICATOR_ONLY" : ir.scriptType === "LIBRARY" ? "LIBRARY_ONLY" : ir.validity === "INVALID_CODE" ? "INVALID_CODE" : "NOT_EXECUTABLE",
      backtestExecutable: ir.executable,
      notExecutableReason: ir.notExecutableReason,
      diagnostics: ir.diagnostics.map((d) => ({ code: d.code, construct: d.construct, line: d.line, col: d.col })),
    };
    Object.assign(validation, script);
    const payload = {
      name: data.name,
      description: data.description,
      language,
      code: data.code,
      symbols: data.symbols,
      timeframes: data.timeframes,
      representation,
      validation,
      status: validation.safe && script.validity !== "INVALID_CODE" ? "validated" : "draft",
      params: Object.fromEntries(representation.parameters.map((p) => [p.name, p.value])),
    };
    if (data.id) {
      const { data: prev } = await supabaseAdmin.from("use_strategies").select("code,version").eq("id", data.id).maybeSingle();
      const version = (prev?.version ?? 1) + (prev && prev.code !== data.code ? 1 : 0);
      const { data: row, error } = await supabaseAdmin
        .from("use_strategies")
        .update({ ...payload, version })
        .eq("id", data.id)
        .select("id")
        .single();
      if (error) throw error;
      return { id: row.id, validation, representation };
    }
    const { data: row, error } = await supabaseAdmin
      .from("use_strategies")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id, validation, representation };
  });

const LIFECYCLE = ["draft", "validated", "backtested", "walk_forward", "paper", "approved", "published"] as const;

export const setStrategyLifecycle = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(LIFECYCLE),
        enabled: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Analysis-only release: enabling a strategy never authorises live orders.
    const { error } = await supabaseAdmin
      .from("use_strategies")
      .update({
        status: data.status,
        ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
      })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/** Deletes a strategy and its derived artifacts. Refuses when frozen forecasts reference it (immutable ledger). */
export const deleteStrategy = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("use_predictions").select("id", { count: "exact", head: true }).eq("strategy_id", data.id);
    if ((count ?? 0) > 0) {
      return { ok: false, reason: `لا يمكن الحذف: ${count} توقعًا مجمّدًا مرتبطًا بها في السجل غير القابل للتعديل. عطّلها بدلًا من ذلك.` };
    }
    for (const t of ["use_backtests", "use_backtest_runs", "use_models", "use_forecast_schedules"] as const) {
      const { error } = await supabaseAdmin.from(t).delete().eq("strategy_id", data.id);
      if (error) throw error;
    }
    await supabaseAdmin.from("use_strategies").update({ parent_indicator_id: null }).eq("parent_indicator_id", data.id);
    const { error } = await supabaseAdmin.from("use_strategies").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true, reason: null };
  });

/** Exact stored source (byte-for-byte) + SHA-256 for integrity. Viewing is not gated by lifecycle status. */
export const getStrategyCode = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin.from("use_strategies")
      .select("id,name,language,code,version,status,updated_at,symbols,timeframes").eq("id", data.id).maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.code));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const pine = row.code.match(/\/\/@version=(\d+)/)?.[1];
    return { ...row, hash, languageLabel: row.language === "pinescript" && pine ? `Pine Script v${pine}` : row.language };
  });

export const getStrategyDetail = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [strategy, backtests, predictions] = await Promise.all([
      supabaseAdmin.from("use_strategies").select("*").eq("id", data.id).maybeSingle(),
      supabaseAdmin
        .from("use_backtests")
        .select("*")
        .eq("strategy_id", data.id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("use_predictions")
        .select("*")
        .eq("strategy_id", data.id)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    return {
      strategy: strategy.data ?? null,
      backtests: backtests.data ?? [],
      predictions: predictions.data ?? [],
    };
  });

export const getPredictionLog = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("use_predictions")
    .select(
      "id,created_at,symbol,timeframe,model_version,strategy_version,market_regime,direction,bullish_probability,bearish_probability,confidence,expected_return,data_quality,sample_size,actual_result,evaluation_status",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
});

/* ------------------------------ Background jobs ----------------------------- */
// Heavy work (backtests) is queued in use_jobs and processed one job at a time
// with a lease, never inside the analysis request.

const jobInput = z.object({
  kind: z.enum(["backtest"]),
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  strategyId: z.string().uuid().nullable().optional(),
});

export const enqueueJob = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => jobInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("use_jobs")
      .insert({ kind: data.kind, payload: data })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id };
  });

export const listJobs = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("use_jobs")
    .select("id,kind,payload,status,progress,attempts,error,result,created_at,finished_at")
    .order("created_at", { ascending: false })
    .limit(20);
  return data ?? [];
});

export const processNextJob = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { getCandles, listSymbols } = await import("./market-data.server");
  const now = new Date().toISOString();
  const { data: job } = await supabaseAdmin
    .from("use_jobs")
    .select("*")
    .or(`status.eq.queued,and(status.eq.running,lease_until.lt.${now})`)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!job) return { processed: false };
  await supabaseAdmin
    .from("use_jobs")
    .update({
      status: "running",
      attempts: job.attempts + 1,
      started_at: now,
      lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      progress: 10,
    })
    .eq("id", job.id);
  try {
    const p = jobInput.parse(job.payload);
    const sym = (await listSymbols()).find((s) => s.symbol === p.symbol);
    if (!sym) throw new Error("رمز غير معروف");
    let rep: StrategyRepresentation | null = null;
    if (p.strategyId) {
      const { data: s } = await supabaseAdmin
        .from("use_strategies")
        .select("name,code,representation")
        .eq("id", p.strategyId)
        .maybeSingle();
      if (s) rep = (s.representation as StrategyRepresentation | null) ?? parseStrategy(s.code, s.name);
    }
    const fetched = await getCandles(sym, p.timeframe, 1500);
    if (fetched.candles.length < 300) throw new Error(`بيانات غير كافية (${fetched.candles.length})`);
    const report = runBacktest(sym.symbol, p.timeframe, fetched.candles, rep).report;
    await supabaseAdmin.from("use_backtests").insert({
      strategy_id: p.strategyId ?? null,
      symbol: sym.symbol,
      timeframe: p.timeframe,
      split: "full",
      period_start: report.periodStart,
      period_end: report.periodEnd,
      sample_size: report.stats.observations,
      stats: report.stats,
      patterns: { byHour: report.byHour.slice(0, 8), byWeekday: report.byWeekday, byRegime: report.byRegime },
    });
    await supabaseAdmin
      .from("use_jobs")
      .update({ status: "done", progress: 100, finished_at: new Date().toISOString(), result: report.stats as never, error: null })
      .eq("id", job.id);
  } catch (e) {
    await supabaseAdmin
      .from("use_jobs")
      .update({ status: job.attempts + 1 >= 3 ? "failed" : "queued", error: (e as Error).message, lease_until: null })
      .eq("id", job.id);
  }
  return { processed: true, id: job.id };
});
