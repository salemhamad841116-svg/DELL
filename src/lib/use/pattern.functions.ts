// Indicator Historical Pattern Analyzer — server entry. Uses the frozen Phase 1 data path (getCandles)
// and the semantic engine for the indicator's own bar-by-bar level values. No strategy conversion.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({
  strategyId: z.string().uuid(),
  symbol: z.string().min(1), timeframe: z.string().min(1),
  source: z.string().default(""), target: z.string().default(""),
  window: z.union([z.object({ kind: z.literal("SAME_CLOCK_HOUR") }), z.object({ kind: z.literal("MINUTES"), minutes: z.number().int().min(1).max(1440) })]),
  useLowerTf: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.55),
  freeze: z.boolean().default(false), alerts: z.boolean().default(true),
});

export const analyzeHistoricalPattern = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { buildIR, sha256 } = await import("./strategy/ir");
    const { indicatorSeries, closedBars } = await import("./forecast/core");
    const { getCandles, marketOf } = await import("./market-data.server");
    const { getTimeframe } = await import("./timeframes");
    const { atr } = await import("./indicators");
    const A = await import("./pattern/analyzer");
    const { patternPine, PATTERN_PINE_MARKER } = await import("./pattern/pine");

    const { data: row } = await db.from("use_strategies").select("id,name,code,version,language").eq("id", data.strategyId).maybeSingle();
    if (!row) return { status: "BLOCKED" as const, reason: "Indicator not found" };
    const ir = await buildIR(row.code, { language: row.language });
    if (ir.sourceLanguage !== "pinescript") return { status: "BLOCKED" as const, reason: `Only Pine indicators can be executed (got ${ir.sourceLanguage})` };
    const { data: sym } = await db.from("use_symbols").select("*").eq("symbol", data.symbol).maybeSingle();
    if (!sym) return { status: "BLOCKED" as const, reason: "Symbol not in catalog" };
    const spec = getTimeframe(data.timeframe); if (!spec?.supported) return { status: "BLOCKED" as const, reason: `Timeframe ${data.timeframe} not supported` };
    const tfMs = spec.seconds * 1000; const now = Date.now();

    const fetched = await getCandles(sym as never, data.timeframe, 1500);
    // History ≠ live freshness: if the live fetch is incomplete, use stored bars from the SAME provider
    // (newest gap-free segment). Freezing a forecast still requires a genuinely fresh bar (checked below).
    const { readCache } = await import("./data/providers.server");
    const { expectedBars, exchangeFor } = await import("./data/calendar");
    const provId = fetched.coverage?.requestedProvider ?? "twelvedata";
    let raw = fetched.candles; let dataMode: "LIVE_PROVIDER" | "STORED_SAME_PROVIDER" = "LIVE_PROVIDER";
    if (fetched.source !== "provider" || fetched.coverage?.status !== "PASS_COMPLETE_HISTORICAL_COVERAGE") {
      const stored = await readCache(sym.symbol, data.timeframe, provId, now - 60 * 86_400_000, now);
      const all = [...new Map([...stored, ...(fetched.source === "provider" ? raw : [])].map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts);
      const ex = exchangeFor(marketOf(sym as never), sym.provider_symbol);
      let start = 0;
      for (let i = all.length - 1; i > 0; i--) if (expectedBars(ex, tfMs, all[i - 1]!.ts + tfMs, all[i]!.ts).length > 0) { start = i; break; }
      raw = all.slice(start).slice(-3000); dataMode = "STORED_SAME_PROVIDER";
    }
    const candles = closedBars([...new Map(raw.map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts), tfMs, now);
    const dataInfo = { mode: dataMode, provider: fetched.provider ?? fetched.coverage?.requestedProvider ?? null, source: fetched.source, coverage: fetched.coverage?.status ?? null, coveragePercent: fetched.coverage?.coveragePercent ?? null, closedBars: candles.length, from: candles[0] ? new Date(candles[0].ts).toISOString() : null, to: candles.length ? new Date(candles[candles.length - 1]!.ts).toISOString() : null, note: fetched.note ?? null };
    if (candles.length < 50) return { status: "BLOCKED" as const, reason: `Not enough closed candles (${candles.length})`, data: dataInfo };
    const ind = indicatorSeries(ir, candles, { tickerid: sym.symbol, timeframe: data.timeframe, market: marketOf(sym as never) });
    if (ind.unsupported.length) return { status: "BLOCKED" as const, reason: "Indicator could not be executed", diagnostics: ind.unsupported, data: dataInfo };
    const alias = new Map<string, string>(); // label.new(x, <var>, "R3") → var shown as R3 on the chart
    for (const m of row.code.matchAll(/label\.new\([^,]+,\s*(\w+)\s*,\s*"([^"]{1,12})"/g)) if (!alias.has(m[1]!)) alias.set(m[1]!, m[2]!);
    const series = ind.names.map((n, k) => ({ name: n, label: alias.get(n) ?? null, last: ind.values[k]![candles.length - 1] ?? null }));
    if (!data.source || !data.target) return { status: "NEED_LEVELS" as const, series, data: dataInfo };

    // Real 1m candles (same provider path) only to order same-bar touches — never interpolated.
    let m1: typeof candles | undefined; let m1Info: string | null = null;
    if (data.useLowerTf && spec.seconds > 60) {
      const ratio = spec.seconds / 60;
      const f1 = await getCandles(sym as never, "1m", Math.min(5000, candles.length * ratio));
      const s1 = candles.length ? await readCache(sym.symbol, "1m", provId, candles[0]!.ts, now) : [];
      m1 = closedBars([...new Map([...s1, ...f1.candles].map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts), 60_000, now);
      m1Info = m1.length ? `${m1.length} 1m candles ${new Date(m1[0]!.ts).toISOString().slice(0, 16)} → ${new Date(m1[m1.length - 1]!.ts).toISOString().slice(0, 16)}` : `1m unavailable: ${f1.note ?? f1.coverage?.error ?? "no data"}`;
    }
    const cfg = { source: data.source, target: data.target, window: data.window };
    const res = A.analyzePattern(candles, tfMs, ind.names, ind.values, cfg, { now, atr: atr(candles, 14), m1 });
    if (res.error) return { status: "BLOCKED" as const, reason: res.error, series, data: dataInfo };
    const summary = A.summarize(res.events);
    const nc = A.nextCandleFromPattern(res.events, data.minConfidence);

    const last = candles[candles.length - 1]!; const li = candles.length - 1;
    const sv = ind.values[ind.names.indexOf(data.source)]![li], pv = ind.values[ind.names.indexOf(data.source)]![li - 1];
    const prev = candles[li - 1]!;
    const activeTouch = Number.isFinite(sv) && last.low <= sv! && sv! <= last.high && !(Number.isFinite(pv) && prev.low <= pv! && pv! <= prev.high);
    const a14 = atr(candles, 14)[li] ?? null;
    const current = { barIso: new Date(last.ts).toISOString(), close: last.close, high: last.high, low: last.low, atr14: a14, touchingSource: activeTouch, levels: Object.fromEntries(series.map((s) => [s.name, s.last])) };

    // Frozen ledger row — only when the latest closed bar is a fresh touch and target is still ahead.
    let frozen: { status: string; id?: string; note?: string } = { status: "NOT_REQUESTED" };
    if (data.freeze) {
      if (!activeTouch) frozen = { status: "NO_ACTIVE_TOUCH", note: `Latest closed bar ${current.barIso} does not freshly touch ${data.source}` };
      else if (now > last.ts + tfMs + tfMs / 2) frozen = { status: "BLOCKED_PROVIDER_DELAYED", note: "More than half of the target bar already elapsed" };
      else {
        const hash = await sha256(`${ir.sourceHash}|${JSON.stringify(cfg)}|${A.PATTERN_MODEL_VERSION}`);
        const target = new Date(last.ts + tfMs).toISOString();
        const r = {
          mode: "NEXT_CANDLE", symbol: sym.symbol, timeframe: data.timeframe, strategy_id: row.id, strategy_version: row.version,
          model_version: A.PATTERN_MODEL_VERSION, feature_version: "pattern-cond-1", indicator_hash: hash, provider: dataInfo.provider,
          prediction_time: new Date(now).toISOString(), source_bar_time: current.barIso, target_ts: target,
          direction: nc.winner, signal: nc.signal, min_confidence: data.minConfidence,
          bullish_probability: nc.probabilities.up, bearish_probability: nc.probabilities.down, neutral_probability: nc.probabilities.neutral,
          confidence: nc.confidence, calibrated_confidence: nc.confidence, reference_close: last.close, sample_size: nc.samples,
          data_quality: dataInfo.coverage === "PASS_COMPLETE_HISTORICAL_COVERAGE" ? "HIGH" : "MEDIUM",
          gate: { checks: nc.checks, reason: nc.reason }, generated_by: "pattern-analyzer",
          explain: { pattern: cfg, current, summary: { touches: summary.touches, success: summary.success, successRate: summary.successRate }, holdout: nc.holdout, decision: nc.signal, reason: nc.reason },
          evidence: { strategyName: row.name, provider: dataInfo.provider, pattern: cfg },
          evaluation_status: "pending", scoring_status: "PENDING_DATA", generation_delay_ms: Math.max(0, now - (last.ts + tfMs)),
        };
        const ins = await db.from("use_predictions").insert(r as never).select("id").single();
        frozen = ins.error ? (ins.error.code === "23505" ? { status: "FROZEN_EXISTING", note: "Already frozen for this target candle" } : { status: "ERROR", note: ins.error.message }) : { status: "CREATED", id: ins.data.id };
      }
    }

    // Pine export — only when the pattern forecast passed its checks (or is a validated NEUTRAL).
    let pine: { code: string | null; status: string; checks: { name: string; pass: boolean; detail: string }[] } = { code: null, status: "NOT_VERIFIED", checks: [] };
    if (nc.signal !== "NO_SIGNAL") {
      const decided = summary.success + summary.failed;
      const code = patternPine(row.code, cfg, { symbol: sym.symbol, timeframe: data.timeframe, provider: dataInfo.provider, from: dataInfo.from!.slice(0, 16), to: dataInfo.to!.slice(0, 16), samples: nc.samples, ...nc.probabilities, signal: nc.signal, reachRate: summary.successRate, decided, minConf: data.minConfidence, alerts: data.alerts });
      const gir = await buildIR(code, { language: "pinescript" });
      const bad = gir.diagnostics.filter((d) => d.code === "PARSE_ERROR" || d.code === "UNSUPPORTED_SEMANTIC");
      const checks = [
        { name: "Syntax / semantic validation", pass: !bad.length, detail: bad.map((d) => `${d.construct} @${d.line}:${d.col}`).join("; ") || "OK" },
        { name: "Script type INDICATOR (no orders)", pass: gir.scriptType === "INDICATOR" && !/strategy\.(entry|exit|close|order)\s*\(/.test(code), detail: gir.scriptType },
        { name: "Original code unchanged", pass: code.startsWith(row.code.trimEnd()), detail: "prefix identical" },
        { name: "Pattern block present", pass: code.includes(PATTERN_PINE_MARKER), detail: "OK" },
      ];
      pine = { code: checks.every((c) => c.pass) ? code : null, status: checks.every((c) => c.pass) ? "VERIFIED" : "BLOCKED", checks };
    }

    return {
      status: "OK" as const, indicator: { id: row.id, name: row.name, version: row.version, hash: ir.sourceHash }, data: dataInfo, m1Info, series, config: cfg,
      summary, events: res.events.slice(-500), eventsTotal: res.events.length, nextCandle: nc, current, frozen, pine,
      separateNote: "Reach-target probability (historical) and next-candle DOWN probability are different quantities and are computed separately.",
    };
  });

export const listPatternForecasts = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { PATTERN_MODEL_VERSION } = await import("./pattern/analyzer");
  const { data } = await db.from("use_predictions").select("id,symbol,timeframe,source_bar_time,target_ts,signal,direction,bullish_probability,bearish_probability,neutral_probability,confidence,sample_size,actual_result,correct,evaluation_status,scoring_status,explain")
    .eq("mode", "NEXT_CANDLE").eq("model_version", PATTERN_MODEL_VERSION).order("target_ts", { ascending: false }).limit(50);
  return data ?? [];
});
