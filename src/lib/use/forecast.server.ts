// Backend Next Candle worker: generation + scoring. Browser never generates/scores production forecasts.
import { DEFAULT_MIN_CONFIDENCE, FEATURE_VERSION, NC_MODEL_VERSION, NEUTRAL_ATR_K, buildDataset, closedBars, forecastNext, MIN_TRAIN_SAMPLES, indicatorSeries, labelMove, signalFrom } from "./forecast/core";
import { timeframeSeconds } from "./timeframes";
import { forwardStats, psi, sessionOf, shadowGate, shadowStats, signalGate, type ShadowRow, validateSetup, type ScoredRow, type ValidationReport } from "./forecast/reliability";
import type { Candle } from "./types";
import type { IndicatorSeries } from "./forecast/core";

export const NC_SELECT = "id,symbol,timeframe,prediction_time,source_bar_time,target_ts,direction,signal,min_confidence,confidence,bullish_probability,bearish_probability,neutral_probability,model_version,indicator_hash,feature_version,market_regime,reference_close,actual_open,actual_close,actual_move,atr_threshold,actual_result,correct,evaluation_status,scoring_status,scored_at,score_attempts,score_error,generated_by,generation_delay_ms,created_at,sample_size,evidence,strategy_id,calibrated_confidence,gate,explain,provider,session,nc_model_id";

const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;

export type GenInput = { symbol: string; timeframe: string; strategyId: string | null; minConfidence?: number | undefined; generatedBy: "worker" | "manual" };

export async function generateForecast(inp: GenInput) {
  const db = await admin();
  const { getCandles, listSymbols, marketOf } = await import("./market-data.server");
  const { buildIR } = await import("./strategy/ir");
  const sym = (await listSymbols()).find((s) => s.symbol === inp.symbol);
  if (!sym) throw new Error("الرمز غير متاح");
  const tfMs = timeframeSeconds(inp.timeframe) * 1000;
  if (!tfMs) throw new Error("الفريم غير مدعوم");
  const minConf = inp.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  let code = ""; let strategyVersion: number | null = null; let strategyName: string | null = null;
  if (inp.strategyId) {
    const { data: s } = await db.from("use_strategies").select("code,version,name").eq("id", inp.strategyId).maybeSingle();
    if (!s) throw new Error("المؤشر غير موجود");
    code = s.code; strategyVersion = s.version; strategyName = s.name;
  }
  const ir = code ? await buildIR(code, { strategyId: inp.strategyId, version: strategyVersion, language: null }) : null;
  const indicatorHash = ir?.sourceHash ?? "none";

  const fetched = await getCandles(sym, inp.timeframe, 1500);
  const now = Date.now(); // server clock — authoritative with candle timestamps
  const pState = fetched.coverage?.providerState;
  // Live provider failed → PROVIDER_ERROR (never forecast from cached/stale/substituted candles).
  if (fetched.source !== "provider" || (pState && pState !== "OK")) {
    return { status: "PROVIDER_ERROR" as const, note: `${pState ?? "PROVIDER_ERROR"}: ${fetched.coverage?.error ?? fetched.note ?? "live fetch failed"}`.slice(0, 300), prediction: null, warnings: [] as string[] };
  }
  // Dedup + sort before any feature generation.
  const candles = closedBars([...new Map(fetched.candles.map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts), tfMs, now);
  const src = candles[candles.length - 1];
  const loader = { attempts: fetched.attempts ?? [], availableEnd: fetched.availableEnd ? new Date(fetched.availableEnd).toISOString() : null, closedBars: candles.length };
  if (!src) return { status: "BLOCKED_NO_DATA" as const, note: fetched.note ?? "لا توجد بيانات", prediction: null, warnings: [] as string[] };
  const targetIso = new Date(src.ts + tfMs).toISOString();
  const findExisting = () => db.from("use_predictions").select(NC_SELECT).eq("mode", "NEXT_CANDLE").eq("symbol", sym.symbol).eq("timeframe", inp.timeframe)
    .eq("indicator_hash", indicatorHash).eq("model_version", NC_MODEL_VERSION).eq("target_ts", targetIso).maybeSingle();

  const existing = await findExisting();
  if (existing.data) return { status: "FROZEN_EXISTING" as const, prediction: existing.data, warnings: [] as string[], note: null, targetIso };

  // Provider's historical feed ends before the latest closed bar → a "next candle" forecast would target the past.
  if (fetched.availableEnd && fetched.availableEnd < now - 2 * tfMs) {
    return { status: "BLOCKED_PROVIDER_DELAYED" as const, note: `${fetched.provider}: البيانات المنشورة تنتهي عند ${new Date(fetched.availableEnd).toISOString()} (تأخر التغذية التاريخية) — لا يمكن توقع الشمعة القادمة الحقيقية`, prediction: null, warnings: [] as string[], loader };
  }
  if (src.ts + 2 * tfMs <= now && marketOf(sym) === "crypto") {
    return { status: "BLOCKED_STALE_DATA" as const, note: `آخر شمعة مغلقة ${new Date(src.ts).toISOString()} ليست الأحدث`, prediction: null, warnings: [] as string[] };
  }

  // Non-crypto feed whose last closed bar lags by >2 bars → delayed/stale; never forecast a past "next candle".
  if (src.ts + 2 * tfMs <= now && marketOf(sym) === "forex") {
    return { status: "BLOCKED_PROVIDER_DELAYED" as const, note: `${fetched.provider}: آخر شمعة مغلقة ${new Date(src.ts).toISOString()} متأخرة ${Math.round((now - src.ts - tfMs) / 1000)}s عن الوقت الحالي — بيانات متأخرة أو السوق مغلق`, prediction: null, warnings: [] as string[], loader };
  }
  // Any market: more than half of the target bar already elapsed → the forecast is no longer "next candle".
  if (now > src.ts + tfMs + tfMs / 2) {
    return { status: "BLOCKED_PROVIDER_DELAYED" as const, note: `${fetched.provider}: آخر شمعة مغلقة ${new Date(src.ts).toISOString()} وصلت متأخرة — مضى أكثر من نصف الشمعة الهدف`, prediction: null, warnings: [] as string[], loader };
  }
  const ind = indicatorSeries(ir, candles, { tickerid: sym.symbol, timeframe: inp.timeframe, market: marketOf(sym) });
  const warnings = [...ind.unsupported.map((u) => `ميزة غير مدعومة — تم تجاهل قيم المؤشر: ${u}`)];
  if (fetched.note) warnings.push(fetched.note);
  const model = await activeModel({ symbol: sym.symbol, timeframe: inp.timeframe, indicatorHash, candles, ind, minConf, provider: fetched.provider });
  const f = forecastNext(candles, tfMs, ind);
  if (!f) {
    const ds = buildDataset(candles, ind);
    const available = Math.max(ds.idx.length - 1, 0), warmup = candles.length - ds.idx.length;
    return { status: "BLOCKED_INSUFFICIENT_SAMPLES" as const, note: `Required samples ${MIN_TRAIN_SAMPLES} · available ${available} (closed bars ${candles.length}, warm-up ${warmup})`, prediction: null, warnings, loader, samples: { required: MIN_TRAIN_SAMPLES, available, warmup, closedBars: candles.length } };
  }

  const dataQuality = fetched.coverage?.status === "PASS_COMPLETE_HISTORICAL_COVERAGE" ? "HIGH" as const : fetched.coverage && fetched.coverage.coveragePercent >= 95 ? "MEDIUM" as const : "LOW" as const;
  const gate = signalGate({ p: f, minConf, sampleSize: f.sampleSize, minSamples: MIN_TRAIN_SAMPLES, dataQuality, regime: f.regime, model: { status: model?.status ?? null, report: model?.report ?? null } });
  void signalFrom;
  // Shadow: frozen with the row at prediction time; experimental only, never the user-facing signal.
  const shadow = model?.status === "VERIFIED" ? null : shadowGate({ p: f, minConf, sampleSize: f.sampleSize, minSamples: MIN_TRAIN_SAMPLES, dataQuality, regime: f.regime, model: { status: model?.status ?? null, report: model?.report ?? null } });
  const refFeatures = new Set((model?.report.featureRef ?? []).map((x) => x.name));
  const explain = {
    sourceCandle: { ts: new Date(src.ts).toISOString(), open: src.open, high: src.high, low: src.low, close: src.close },
    targetCandle: { opens: targetIso, closes: new Date(src.ts + 2 * tfMs).toISOString() },
    indicator: { id: inp.strategyId, name: strategyName, version: strategyVersion, hash: indicatorHash },
    indicatorValues: f.indicatorValues,
    comparableSamples: f.sampleSize, oos: f.oos,
    model: { version: NC_MODEL_VERSION, featureVersion: FEATURE_VERSION, registryId: model?.id ?? null, status: model?.status ?? null },
    contributions: f.contributionsRaw, contributionModel: f.contributionModel,
    probabilities: { up: f.up, down: f.down, neutral: f.neutral }, threshold: minConf, minGap: 0.1,
    decision: gate.signal, reason: gate.reason ?? (gate.signal === "NEUTRAL" ? "Expected move smaller than 0.1 × ATR(14) — NEUTRAL" : "All reliability checks passed"),
    driftFeatures: Object.fromEntries(Object.entries(f.liveFeatures).filter(([k]) => refFeatures.has(k))),
  };
  const row = {
    calibrated_confidence: f.confidence, gate: { checks: gate.checks, reason: gate.reason, ...(shadow ? { shadow: { ...shadow, note: "EXPERIMENTAL — model not approved; not a trading signal" } } : {}) }, explain,
    provider: fetched.provider, session: sessionOf(src.ts + tfMs), nc_model_id: model?.id ?? null,
    mode: "NEXT_CANDLE", symbol: sym.symbol, timeframe: inp.timeframe,
    strategy_id: inp.strategyId, strategy_version: strategyVersion,
    model_version: NC_MODEL_VERSION, feature_version: FEATURE_VERSION, indicator_hash: indicatorHash,
    input_data_version: `${fetched.provider ?? "?"}:${new Date(src.ts).toISOString()}`,
    prediction_time: new Date(now).toISOString(), source_bar_time: new Date(src.ts).toISOString(), target_ts: targetIso,
    market_regime: f.regime, direction: f.direction, signal: gate.signal, min_confidence: minConf,
    bullish_probability: f.up, bearish_probability: f.down, neutral_probability: f.neutral, confidence: f.confidence,
    reference_close: f.referenceClose, sample_size: f.sampleSize,
    data_quality: dataQuality,
    evidence: { top: f.evidence, oos: f.oos, overfittingRisk: f.overfittingRisk, indicatorFeatures: f.indicatorFeatures, featureCount: f.featureCount, strategyName, provider: fetched.provider },
    evaluation_status: "pending", scoring_status: "PENDING_DATA",
    generated_by: inp.generatedBy, generation_delay_ms: Math.max(0, now - (src.ts + tfMs)),
  };
  const ins = await db.from("use_predictions").insert(row).select(NC_SELECT).single();
  if (ins.error) {
    if (ins.error.code === "23505") {
      const again = await findExisting();
      return { status: "FROZEN_EXISTING" as const, prediction: again.data, warnings, note: null, targetIso };
    }
    throw new Error(ins.error.message);
  }
  return { status: "CREATED" as const, prediction: ins.data, warnings, note: null, targetIso };
}

const MAX_SCORE_ATTEMPTS = 20;
const backoffMs = (attempt: number) => Math.min(2 ** attempt, 60) * 60_000;

/** Score every due forecast using the real target candle from the Phase 1 data path. Idempotent. */
export async function scorePending(limit = 200) {
  const db = await admin();
  const { getCandles, listSymbols, marketOf } = await import("./market-data.server");
  const { atr } = await import("./indicators");
  const nowIso = new Date().toISOString();
  const { data: pend } = await db.from("use_predictions").select("id,symbol,timeframe,target_ts,source_bar_time,direction,signal,score_attempts,next_score_at")
    .eq("mode", "NEXT_CANDLE").eq("evaluation_status", "pending").or(`next_score_at.is.null,next_score_at.lte.${nowIso}`).order("target_ts").limit(limit);
  const now = Date.now();
  const due = (pend ?? []).filter((p) => p.target_ts && Date.parse(p.target_ts) + timeframeSeconds(p.timeframe) * 1000 <= now);
  const syms = await listSymbols();
  const groups = new Map<string, typeof due>();
  for (const p of due) { const k = `${p.symbol}|${p.timeframe}`; groups.set(k, [...(groups.get(k) ?? []), p]); }
  const out = { due: due.length, scored: 0, pendingData: 0, noTrade: 0, providerError: 0, failed: 0 };

  const retry = async (p: (typeof due)[number], status: "PENDING_DATA" | "PROVIDER_ERROR", err: string | null) => {
    const attempts = (p.score_attempts ?? 0) + 1;
    if (attempts >= MAX_SCORE_ATTEMPTS) {
      await db.from("use_predictions").update({ scoring_status: "FAILED", evaluation_status: "failed", score_attempts: attempts, score_error: err ?? status, scored_at: new Date().toISOString() }).eq("id", p.id).eq("evaluation_status", "pending");
      out.failed++; return;
    }
    await db.from("use_predictions").update({ scoring_status: status, score_attempts: attempts, score_error: err, next_score_at: new Date(Date.now() + backoffMs(attempts)).toISOString() }).eq("id", p.id).eq("evaluation_status", "pending");
    if (status === "PROVIDER_ERROR") out.providerError++; else out.pendingData++;
  };

  for (const [k, list] of groups) {
    const [s, tf] = k.split("|") as [string, string];
    const sym = syms.find((x) => x.symbol === s);
    if (!sym) { for (const p of list) await retry(p, "PROVIDER_ERROR", "symbol not in catalog"); continue; }
    const tfMs = timeframeSeconds(tf) * 1000;
    const oldest = Math.min(...list.map((p) => Date.parse(p.source_bar_time ?? p.target_ts!)));
    const bars = Math.min(Math.ceil((now - oldest) / tfMs) + 40, 1500);
    let candles: Candle[] = []; let liveFailed: string | null = null;
    // Same-provider stored candles first (saves provider quota); live fetch only when a target is not stored yet.
    const { readCache, resolveProvider } = await import("./data/providers.server");
    const provId = resolveProvider(marketOf(sym), tf).prov?.id;
    const stored = provId ? closedBars(await readCache(sym.symbol, tf, provId, oldest - 300 * tfMs, now + tfMs), tfMs, now) : [];
    const storedTs = new Set(stored.map((c) => c.ts));
    if (stored.length && list.every((p) => storedTs.has(Date.parse(p.target_ts!)) && storedTs.has(Date.parse(p.source_bar_time!)))) candles = stored;
    else try {
      const f = await getCandles(sym, tf, bars);
      if (f.source !== "provider") liveFailed = `${f.coverage?.providerState ?? "PROVIDER_ERROR"}: ${f.coverage?.error ?? f.note ?? "live fetch failed"}`.slice(0, 300);
      candles = closedBars(f.candles, tfMs, now);
    }
    catch (e) { for (const p of list) await retry(p, "PROVIDER_ERROR", (e as Error).message.slice(0, 300)); continue; }
    const a = atr(candles, 14);
    const lastTs = candles.length ? candles[candles.length - 1]!.ts : 0;
    for (const p of list) {
      const tts = Date.parse(p.target_ts!); const sts = Date.parse(p.source_bar_time!);
      const ti = candles.findIndex((c) => c.ts === tts); const si = candles.findIndex((c) => c.ts === sts);
      if (ti < 0 || si < 0) {
        // Target bar absent although later bars exist → outside crypto this is a no-trade bar; in 24/7 crypto it is a real gap.
        if (lastTs > tts && si >= 0) {
          if (marketOf(sym) !== "crypto") {
            await db.from("use_predictions").update({ scoring_status: "NO_TRADE_INTERVAL", evaluation_status: "no_trade", scored_at: new Date().toISOString(), score_error: null }).eq("id", p.id).eq("evaluation_status", "pending");
            out.noTrade++; continue;
          }
        }
        if (liveFailed) { await retry(p, "PROVIDER_ERROR", liveFailed); continue; }
        await retry(p, "PENDING_DATA", ti < 0 ? "target candle not yet available" : "source candle not in window");
        continue;
      }
      const src = candles[si]!; const tgt = candles[ti]!;
      const atrV = a[si] ?? null;
      const actual = labelMove(src.close, tgt.close, atrV);
      const sig = p.signal ?? p.direction;
      const correct = sig === "UP" || sig === "DOWN" ? sig === actual : null;
      const { error } = await db.from("use_predictions").update({
        actual_open: tgt.open, actual_close: tgt.close, actual_move: tgt.close - src.close,
        atr_threshold: atrV !== null ? atrV * NEUTRAL_ATR_K : null, actual_result: actual, correct,
        evaluation_status: "evaluated", scoring_status: "SCORED", evaluated_at: new Date().toISOString(), scored_at: new Date().toISOString(), score_error: null,
      }).eq("id", p.id).eq("evaluation_status", "pending");
      if (!error) out.scored++;
    }
  }
  return out;
}

const MAX_SCHEDULES_PER_TICK = 25;

/** One worker tick: single-flight lease → generate for every due schedule → score → release. */
export async function workerTick() {
  const db = await admin();
  const leaseUntil = new Date(Date.now() + 55_000).toISOString();
  const nowIso = new Date().toISOString();
  const { data: lease } = await db.from("use_worker_state").update({ lease_until: leaseUntil }).eq("name", "forecast").or(`lease_until.is.null,lease_until.lt.${nowIso}`).select("name");
  if (!lease?.length) return { skipped: "LOCKED" };
  const started = Date.now();
  const gen = { created: 0, existing: 0, blocked: 0, providerError: 0, errors: 0 };
  try {
    // Binance degraded → one controlled ping/time/klines probe per tick from this same worker runtime.
    let probe: any = null;
    const { data: bh } = await db.from("use_provider_health").select("degraded").eq("provider", "binance").maybeSingle();
    if (bh?.degraded) { const { probeBinance } = await import("./data/providers.server"); probe = await probeBinance("worker"); }
    const { data: scheds } = await db.from("use_forecast_schedules").select("*").eq("enabled", true).or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`).order("last_run_at", { ascending: true, nullsFirst: true }).limit(MAX_SCHEDULES_PER_TICK);
    const { listSymbols, marketOf } = await import("./market-data.server");
    const { exchangeFor, isOpen } = await import("./data/calendar");
    const symRows = await listSymbols();
    for (const s of scheds ?? []) {
      // Quota guard: the next source bar closes at last_target_ts + tf → no provider call before then.
      const stfMs = timeframeSeconds(s.timeframe) * 1000;
      if (s.last_target_ts && Date.parse(s.last_target_ts) + stfMs > Date.now() && (s.last_status === "CREATED" || s.last_status === "FROZEN_EXISTING")) { gen.existing++; continue; }
      const sm = symRows.find((x) => x.symbol === s.symbol);
      if (sm) { const ex = exchangeFor(marketOf(sm), sm.provider_symbol); if (!isOpen(ex, Date.now() - stfMs)) { gen.blocked++; continue; } } // market closed → no provider call
      if (s.last_status && s.last_status !== "CREATED" && s.last_run_at && Date.parse(s.last_run_at) > Date.now() - Math.min(stfMs / 2, 120_000)) { gen.blocked++; continue; } // throttle retries
      try {
        const r = await generateForecast({ symbol: s.symbol, timeframe: s.timeframe, strategyId: s.strategy_id, minConfidence: s.min_confidence, generatedBy: "worker" });
        if (r.status === "CREATED") gen.created++; else if (r.status === "FROZEN_EXISTING") gen.existing++; else if (r.status === "PROVIDER_ERROR") gen.providerError++; else gen.blocked++;
        await db.from("use_forecast_schedules").update({ last_run_at: new Date().toISOString(), last_status: r.status, last_error: r.note ?? null, last_target_ts: r.prediction?.target_ts ?? s.last_target_ts, fail_count: 0, next_retry_at: null }).eq("id", s.id);
      } catch (e) {
        gen.errors++;
        const fc = (s.fail_count ?? 0) + 1;
        await db.from("use_forecast_schedules").update({ last_run_at: new Date().toISOString(), last_status: "FAILED", last_error: (e as Error).message.slice(0, 300), fail_count: fc, next_retry_at: new Date(Date.now() + Math.min(2 ** fc, 30) * 60_000).toISOString() }).eq("id", s.id);
      }
    }
    const score = await scorePending(300);
    const health = await healthCheck().catch((e) => ({ error: (e as Error).message }));
    const result = { gen, score, probe, health, ms: Date.now() - started };
    await db.from("use_worker_state").update({ last_tick_at: new Date().toISOString(), last_tick_result: result }).eq("name", "forecast");
    return result;
  } finally {
    await db.from("use_worker_state").update({ lease_until: null }).eq("name", "forecast");
  }
}

/** Accepts the worker token stored in the database (used by the scheduler) or the platform cron secret. */
export async function authorizeWorker(request: Request): Promise<boolean> {
  const tok = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!tok) return false;
  const db = await admin();
  const { data } = await db.from("use_worker_state").select("token").eq("name", "forecast").maybeSingle();
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const h = (v: string) => createHash("sha256").update(v).digest();
  if (data?.token && timingSafeEqual(h(tok), h(data.token))) return true;
  const cron = process.env["LOVABLE_CRON_SECRET"];
  return !!cron && timingSafeEqual(h(tok), h(cron));
}

/* ---------------- Model registry (validation evidence per setup) ---------------- */
// The logistic weights are refit from closed history at every forecast (deterministic).
// The registry row is the validated *configuration evidence* (walk-forward, calibration, regime reliability)
// that the gate requires; a setup forecasts directionally only while its row is VERIFIED.

export type ModelRow = { id: string; status: string; report: ValidationReport; created_at: string; was_verified: boolean };

export async function activeModel(a: { symbol: string; timeframe: string; indicatorHash: string; candles: Candle[]; ind: IndicatorSeries; minConf: number; provider: string | null }): Promise<ModelRow | null> {
  const db = await admin();
  const base = () => db.from("use_nc_models").select("id,status,report,created_at,was_verified").eq("symbol", a.symbol).eq("timeframe", a.timeframe).eq("indicator_hash", a.indicatorHash).eq("model_version", NC_MODEL_VERSION);
  const { data: live } = await base().in("status", ["VERIFIED", "DEGRADED"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (live) return live as unknown as ModelRow;
  // No validated model: validate once per 24h on the same closed candles (never on future data).
  const { data: cand } = await base().eq("status", "CANDIDATE").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (cand && Date.parse(cand.created_at) > Date.now() - 86_400_000) return cand as unknown as ModelRow;
  return createCandidate({ ...a, autoPromote: true });
}

/** Frozen shadow ledger for a setup (current model version only). */
export async function shadowEvidence(setup: { symbol: string; timeframe: string; indicatorHash: string }) {
  const db = await admin();
  const { data } = await db.from("use_predictions").select(FWD_SELECT + ",gate").eq("mode", "NEXT_CANDLE").eq("symbol", setup.symbol).eq("timeframe", setup.timeframe).eq("indicator_hash", setup.indicatorHash).eq("model_version", NC_MODEL_VERSION).order("target_ts", { ascending: false }).limit(2000);
  return shadowStats((data ?? []) as unknown as ShadowRow[]);
}

export async function createCandidate(a: { symbol: string; timeframe: string; indicatorHash: string; candles: Candle[]; ind: IndicatorSeries; minConf: number; provider: string | null; autoPromote: boolean }): Promise<ModelRow | null> {
  const db = await admin();
  const report = validateSetup(a.candles, a.ind, a.minConf);
  if (!report) return null;
  const { data: anyLive } = await db.from("use_nc_models").select("id").eq("symbol", a.symbol).eq("timeframe", a.timeframe).eq("indicator_hash", a.indicatorHash).eq("model_version", NC_MODEL_VERSION).in("status", ["VERIFIED", "DEGRADED"]).limit(1);
  // Approval = independent historical validation AND genuine shadow forward evidence (≥300 scored directional calls, CI above baseline, ECE ≤ 0.10).
  const shadowOk = report.pass ? (await shadowEvidence(a)).pass : false;
  const promote = a.autoPromote && report.pass && shadowOk && !anyLive?.length; // first model only; replacements need explicit promotion
  const { data, error } = await db.from("use_nc_models").insert({
    symbol: a.symbol, timeframe: a.timeframe, indicator_hash: a.indicatorHash, model_version: NC_MODEL_VERSION,
    status: promote ? "VERIFIED" : "CANDIDATE", was_verified: promote, promoted_at: promote ? new Date().toISOString() : null,
    report: report as never, data_range: { provider: a.provider, from: new Date(a.candles[0]!.ts).toISOString(), to: new Date(a.candles[a.candles.length - 1]!.ts).toISOString(), bars: a.candles.length } as never,
  }).select("id,status,report,created_at,was_verified").single();
  if (error) throw new Error(error.message);
  return data as unknown as ModelRow;
}

export async function promoteModel(id: string) {
  const db = await admin();
  const { data: m } = await db.from("use_nc_models").select("*").eq("id", id).maybeSingle();
  if (!m) throw new Error("Model not found");
  if (m.status !== "CANDIDATE") throw new Error(`Only CANDIDATE models can be promoted (is ${m.status})`);
  if (!(m.report as unknown as ValidationReport).pass) throw new Error("Candidate failed independent validation — cannot replace the verified model");
  const sh = await shadowEvidence({ symbol: m.symbol, timeframe: m.timeframe, indicatorHash: m.indicator_hash });
  if (!sh.pass) throw new Error(`Shadow forward evidence insufficient: ${sh.directional.n}/${sh.required} scored directional calls, CI low ${sh.directional.ci ? (sh.directional.ci.lo * 100).toFixed(1) : "-"}% vs baseline ${sh.baseline !== null ? (sh.baseline * 100).toFixed(1) : "-"}%, ECE ${sh.calibration.ece?.toFixed(3) ?? "-"}`);
  const now = new Date().toISOString();
  await db.from("use_nc_models").update({ status: "RETIRED", retired_at: now }).eq("symbol", m.symbol).eq("timeframe", m.timeframe).eq("indicator_hash", m.indicator_hash).eq("model_version", m.model_version).in("status", ["VERIFIED", "DEGRADED"]);
  await db.from("use_nc_models").update({ status: "VERIFIED", was_verified: true, promoted_at: now }).eq("id", id);
  return { ok: true };
}

export async function rollbackModel(setup: { symbol: string; timeframe: string; indicatorHash: string }) {
  const db = await admin();
  const q = () => db.from("use_nc_models").select("id,status,created_at").eq("symbol", setup.symbol).eq("timeframe", setup.timeframe).eq("indicator_hash", setup.indicatorHash).eq("model_version", NC_MODEL_VERSION);
  const { data: cur } = await q().in("status", ["VERIFIED", "DEGRADED"]).limit(1).maybeSingle();
  const { data: prev } = await q().eq("status", "RETIRED").eq("was_verified", true).neq("id", cur?.id ?? "00000000-0000-0000-0000-000000000000").order("promoted_at", { ascending: false }).limit(1).maybeSingle();
  if (!prev) throw new Error("No previously verified model to roll back to");
  const now = new Date().toISOString();
  if (cur) await db.from("use_nc_models").update({ status: "RETIRED", retired_at: now }).eq("id", cur.id);
  await db.from("use_nc_models").update({ status: "VERIFIED", retired_at: null, promoted_at: now }).eq("id", prev.id);
  return { ok: true, restored: prev.id };
}

const FWD_SELECT = "signal,direction,actual_result,correct,evaluation_status,target_ts,bullish_probability,bearish_probability,neutral_probability,market_regime,explain";

/** Live monitoring: forward accuracy vs naive baseline + feature drift → DEGRADED suspends directional calls. */
export async function healthCheck() {
  const db = await admin();
  const { data: models } = await db.from("use_nc_models").select("id,symbol,timeframe,indicator_hash,status,report").eq("model_version", NC_MODEL_VERSION).in("status", ["VERIFIED", "DEGRADED"]);
  const out: Record<string, string> = {};
  for (const m of models ?? []) {
    const { data: rows } = await db.from("use_predictions").select(FWD_SELECT).eq("mode", "NEXT_CANDLE").eq("symbol", m.symbol).eq("timeframe", m.timeframe).eq("indicator_hash", m.indicator_hash).eq("model_version", NC_MODEL_VERSION).order("target_ts", { ascending: false }).limit(500);
    const st = forwardStats((rows ?? []) as unknown as ScoredRow[]);
    const rep = m.report as unknown as ValidationReport;
    const drift = (rep.featureRef ?? []).map((f) => ({ feature: f.name, psi: psi(f.values, (rows ?? []).map((r) => ((r.explain as { driftFeatures?: Record<string, number> } | null)?.driftFeatures ?? {})[f.name]!).filter((v) => v !== undefined)) }));
    const maxPsi = Math.max(0, ...drift.map((d) => d.psi ?? 0));
    const status = st.degraded ? "DEGRADED" : "VERIFIED";
    const health = { at: new Date().toISOString(), directional: st.directional, baseline: st.baseline, degraded: st.degraded, drift, maxPsi, driftAlert: maxPsi > 0.25, ece: st.calibration.ece };
    await db.from("use_nc_models").update({ status, health: health as never }).eq("id", m.id);
    out[`${m.symbol} ${m.timeframe}`] = status;
  }
  return out;
}
