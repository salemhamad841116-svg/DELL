// AI Strategy Analyst — the model only parses intent and explains; every number comes from the engines below.
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";

import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId, withLovableAiGatewayRunIdHeader } from "./run-id.server";

const SYSTEM = `You are "AI Strategy Analyst" inside Market Compass.
Reply in the user's language (Arabic or English).
HARD RULES:
- Never invent statistics, sample counts, accuracy, probabilities, indicator values, trades or provider data. Every number you state must come from a tool result in this conversation. If no tool gave it, say it is not computed.
- Route requests: historical level patterns (e.g. R3 → S1 within the same hour / N minutes) → analyze_pattern. Next candle direction → forecast_next_candle (general model) or analyze_pattern with the pattern (pattern-conditioned). TradingView code → generate_pine. Strategy analysis / code errors / performance / risk / classification → analyze_strategy. Parameter robustness / overfitting / sensitivity → sensitivity_sweep. Pasted Pine code → save_indicator first, then use its id.
- If symbol, timeframe, indicator or levels are missing and cannot be inferred, call list_context and ask the user.
- Level names (source/target) must be exact series names from the tool's "series" list; if unsure, run analyze_pattern once and read "series".
- Keep the historical reach-target probability SEPARATE from the next-candle UP/DOWN/NEUTRAL probabilities. Never merge them.
- Always show: provider, symbol, timeframe, historical range, candles, valid samples, excluded/ambiguous events.
- For forecasts show a "Why this prediction?" section with only the values present in the tool output (source/target candle, levels, samples, UP/DOWN/NEUTRAL, required confidence, result, Frozen, Lookahead OFF, Repaint NO). NO SIGNAL is a valid result; never force a direction.
- Code merging/editing is not available yet in this chat: say so instead of writing modified Pine by hand. Never execute trades.`;

const pct = (x: unknown) => (typeof x === "number" ? Math.round(x * 1000) / 10 : x);

function tools() {
  return {
    list_context: tool({
      description: "List saved indicators/strategies and enabled symbols with their timeframes.",
      inputSchema: z.object({}),
      execute: async () => {
        const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
        const [s, y] = await Promise.all([
          db.from("use_strategies").select("id,name,language,status,enabled,updated_at").order("updated_at", { ascending: false }).limit(50),
          db.from("use_symbols").select("symbol,display_name,provider,supported_timeframes,status").eq("enabled", true).limit(200),
        ]);
        return { indicators: s.data ?? [], symbols: y.data ?? [] };
      },
    }),
    save_indicator: tool({
      description: "Save pasted Pine Script code as a new indicator (original kept unchanged). Returns its id.",
      inputSchema: z.object({ name: z.string(), code: z.string() }),
      execute: async ({ name, code }) => {
        const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
        const { buildIR } = await import("../strategy/ir");
        const ir = await buildIR(code, { language: "pinescript" });
        const bad = ir.diagnostics.filter((d) => d.code === "PARSE_ERROR" || d.code === "UNSUPPORTED_SEMANTIC");
        const { data, error } = await db.from("use_strategies").insert({ name, code, language: "pinescript", status: "draft", description: "Saved from AI Strategy Analyst" }).select("id").single();
        if (error) return { error: error.message };
        return { id: data.id, scriptType: ir.scriptType, sourceHash: ir.sourceHash, validation: bad.length ? "HAS_ERRORS" : "OK", errors: bad.slice(0, 15).map((d) => `${d.code} ${d.construct} @${d.line}:${d.col}`) };
      },
    }),
    analyze_pattern: tool({
      description: "Historical indicator pattern: price touches source level then reaches target level within a window. Uses the indicator's own bar-by-bar values; same-bar cases resolved with 1m or marked AMBIGUOUS. Also returns pattern-conditioned next-candle probabilities. Set freeze=true only if the user asks to freeze a forecast now.",
      inputSchema: z.object({
        strategyId: z.string(), symbol: z.string(), timeframe: z.string(),
        source: z.string(), target: z.string(),
        windowMinutes: z.number().nullable().describe("null = same clock hour"),
        minConfidence: z.number().nullable(), freeze: z.boolean(),
      }),
      execute: async (a) => {
        const { analyzeHistoricalPattern } = await import("../pattern.functions");
        const r = await analyzeHistoricalPattern({ data: {
          strategyId: a.strategyId, symbol: a.symbol, timeframe: a.timeframe, source: a.source, target: a.target,
          window: a.windowMinutes ? { kind: "MINUTES", minutes: Math.max(1, Math.min(1440, Math.round(a.windowMinutes))) } : { kind: "SAME_CLOCK_HOUR" },
          useLowerTf: true, minConfidence: a.minConfidence ?? 0.55, freeze: a.freeze, alerts: true,
        } }) as any;
        if (r.status !== "OK") return r;
        const s = r.summary;
        return {
          indicator: r.indicator, data: r.data, lowerTf: r.m1Info, series: r.series, config: r.config,
          summary: { touches: s.touches, success: s.success, failed: s.failed, expiredIncomplete: s.expired, ambiguous: s.ambiguous, resolvedBy1m: s.resolvedBy1m,
            successRatePct: pct(s.successRate), ci95Pct: s.successCI ? [pct(s.successCI.lo), pct(s.successCI.hi)] : null, avgMinutes: s.avgMinutes, medianMinutes: s.medianMinutes,
            byHour: s.byHour, byWeekday: s.byWeekday },
          nextCandle: { signal: r.nextCandle.signal, probabilitiesPct: { up: pct(r.nextCandle.probabilities.up), down: pct(r.nextCandle.probabilities.down), neutral: pct(r.nextCandle.probabilities.neutral) }, samples: r.nextCandle.samples, holdout: r.nextCandle.holdout, checks: r.nextCandle.checks, reason: r.nextCandle.reason },
          current: r.current, frozen: r.frozen, pineStatus: r.pine?.status, lastEvents: (r.events ?? []).slice(-15), eventsTotal: r.eventsTotal, note: r.separateNote,
          safeguards: { lookahead: "OFF", repaint: "NO", frozenLedger: true },
        };
      },
    }),
    forecast_next_candle: tool({
      description: "General Next Candle Forecast for an indicator on symbol/timeframe from the last fully closed bar. Frozen in the immutable ledger; returns UP/DOWN/NEUTRAL/NO SIGNAL with probabilities and explanation.",
      inputSchema: z.object({ strategyId: z.string().nullable(), symbol: z.string(), timeframe: z.string(), minConfidence: z.number().nullable() }),
      execute: async (a) => {
        const { createForecast } = await import("../forecast.functions");
        return await createForecast({ data: { symbol: a.symbol, timeframe: a.timeframe, strategyId: a.strategyId, minConfidence: a.minConfidence ?? undefined } });
      },
    }),
    generate_pine: tool({
      description: "Generate a separate TradingView Pine indicator copy with a Next Candle Forecast block (original unchanged, no strategy conversion). Returns status, hashes, checks and code.",
      inputSchema: z.object({ strategyId: z.string(), symbol: z.string(), timeframe: z.string(), minConfidence: z.number().nullable(), alerts: z.boolean() }),
      execute: async (a) => {
        const { generatePineCode } = await import("../tvpine.functions");
        const r = await generatePineCode({ data: { strategyId: a.strategyId, symbol: a.symbol, timeframe: a.timeframe, minConfidence: a.minConfidence ?? 0.55, alerts: a.alerts } }) as any;
        const { code, ...rest } = r;
        return { ...rest, codeAvailable: !!code, code };
      },
    }),
    analyze_strategy: tool({
      description: "Universal Strategy Engine: static code analysis (symbols, data flow, contradictions, classification) plus quant metrics from the latest stored completed backtest for strategy/symbol/timeframe. Returns FINAL_VERIFIED or an exact BLOCKED_ code.",
      inputSchema: z.object({ strategyId: z.string(), symbol: z.string(), timeframe: z.string() }),
      execute: async (a) => {
        const { runUniversalAnalysis } = await import("../universal.functions");
        const r = await runUniversalAnalysis({ data: a }) as { json: string };
        const full = JSON.parse(r.json);
        return { status: full.status, steps: full.steps, classification: full.classification, issues: full.static?.issues?.slice?.(0, 20), quant: full.quant, analysisId: full.analysisId };
      },
    }),
    sensitivity_sweep: tool({
      description: "Parameter sensitivity: reruns the real backtester with each numeric input at -30%..+30% on the latest stored backtest's candles. Returns net profit/PF per variant, stability and overfit risk.",
      inputSchema: z.object({ strategyId: z.string(), symbol: z.string(), timeframe: z.string() }),
      execute: async (a) => {
        const { runSensitivitySweep } = await import("../sensitivity.functions");
        return await runSensitivitySweep({ data: a });
      },
    }),
  };
}

export async function streamAnalyst(request: Request, messages: UIMessage[], onFinish: (all: UIMessage[]) => Promise<void>) {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return new Response("LOVABLE_API_KEY missing", { status: 401 });
  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses("openai/gpt-6-astra"),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    tools: tools(),
    stopWhen: stepCountIs(50),
    providerOptions: { openai: { forceReasoning: true, reasoningEffort: "medium", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] } },
  });
  // Keep running server-side and save the answer even if the browser closes.
  result.consumeStream();
  return withLovableAiGatewayRunIdHeader(
    result.toUIMessageStreamResponse({
      originalMessages: messages, sendReasoning: true,
      onFinish: async ({ messages: all }) => { await onFinish(all); },
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    }),
    runIdFetch,
  );
}
