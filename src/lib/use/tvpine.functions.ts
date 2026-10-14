// Two independent TradingView modules:
//  1) generatePineCode — Indicator / Next Candle Forecast → Pine indicator() code (no BUY/SELL/TP/SL, no conversion)
//  2) runTvParity      — real strategy() backtest run ↔ TradingView Strategy Tester "List of trades" export
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const genInput = z.object({
  strategyId: z.string().uuid().nullable(),
  symbol: z.string().min(1), timeframe: z.string().min(1),
  minConfidence: z.number().min(0).max(1).default(0.55), alerts: z.boolean().default(true),
});

export const generatePineCode = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => genInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { buildIR, sha256 } = await import("./strategy/ir");
    const { indicatorSeries, closedBars } = await import("./forecast/core");
    const { trainPineModel, generatePine, triProb, pineDataset, tvLock, PINE_GEN_MODEL_VERSION } = await import("./strategy/pinegen");
    const { getCandles } = await import("./market-data.server");
    const { getTimeframe } = await import("./timeframes");

    let row: { name: string; code: string; version: number; language: string } | null = null;
    if (data.strategyId) {
      const { data: r } = await db.from("use_strategies").select("name,code,version,language").eq("id", data.strategyId).maybeSingle();
      if (!r) throw new Error("Indicator not found");
      row = r;
    }
    const blocked = (reason: string, extra: Record<string, unknown> = {}) => ({ status: "BLOCKED_PINE_GENERATION" as const, reason, code: null as string | null, checks: [] as { name: string; pass: boolean; detail: string }[], ...extra });
    const ir = row ? await buildIR(row.code, { language: row.language }) : null;
    if (ir && ir.sourceLanguage !== "pinescript") return blocked(`Source language ${ir.sourceLanguage} — only Pine sources can be embedded`);
    if (ir && ir.scriptType !== "INDICATOR") return blocked(`Source is ${ir.scriptType}. Pine Code Generator is for indicator()/forecast scripts; strategy() scripts use the Strategy Tester / Parity module.`);
    const srcBad = (ir?.diagnostics ?? []).filter((d) => d.code === "PARSE_ERROR" || d.code === "UNSUPPORTED_SEMANTIC");
    if (srcBad.length) return blocked("Source indicator does not validate", { diagnostics: srcBad.map((d) => `${d.code}: ${d.construct} @${d.line}:${d.col}`) });

    const { data: sym } = await db.from("use_symbols").select("*").eq("symbol", data.symbol).maybeSingle();
    if (!sym) return blocked("Symbol not in catalog");
    const spec = getTimeframe(data.timeframe); if (!spec?.supported) return blocked(`Timeframe ${data.timeframe} not supported`);
    const tfMs = spec.seconds * 1000;
    const REQUIRED = 200;
    const fetched = await getCandles(sym as never, data.timeframe, 1500);
    // Model training needs a complete run of real CLOSED bars — not live freshness.
    // When the live call fails, stored bars from the SAME provider are used, trimmed to the
    // newest gap-free segment (market-closed periods are not gaps). Never another provider.
    let raw = fetched.candles;
    let dataMode: "LIVE_PROVIDER" | "STORED_SAME_PROVIDER" = "LIVE_PROVIDER";
    const liveReason = fetched.coverage?.error ?? fetched.note ?? "";
    if (fetched.source !== "provider" || fetched.coverage?.status !== "PASS_COMPLETE_HISTORICAL_COVERAGE") {
      const { readCache } = await import("./data/providers.server");
      const { expectedBars, exchangeFor } = await import("./data/calendar");
      const { marketOf } = await import("./market-data.server");
      const prov = fetched.coverage?.requestedProvider ?? "twelvedata";
      const stored = await readCache(sym.symbol, data.timeframe, prov, Date.now() - 60 * 86_400_000, Date.now());
      const all = raw.length && fetched.source === "provider" ? [...new Map([...stored, ...raw].map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts) : stored;
      const ex = exchangeFor(marketOf(sym as never), sym.provider_symbol);
      // Walk back from the newest bar until the first true gap (a calendar-expected bar that is absent).
      let startIdx = 0;
      for (let i = all.length - 1; i > 0; i--) {
        const missingBetween = expectedBars(ex, tfMs, all[i - 1]!.ts + tfMs, all[i]!.ts).length;
        if (missingBetween > 0) { startIdx = i; break; }
      }
      raw = all.slice(startIdx).slice(-1500);
      dataMode = "STORED_SAME_PROVIDER";
    }
    const candles = closedBars([...new Map(raw.map((c) => [c.ts, c])).values()].sort((a, b) => a.ts - b.ts), tfMs, Date.now());
    const meta = { tickerid: sym.symbol, timeframe: data.timeframe };
    const ind = indicatorSeries(ir, candles, meta);
    if (ind.unsupported.length) return blocked("Indicator could not be executed", { diagnostics: ind.unsupported });
    const available = pineDataset(candles, ind).X.length;
    const dataInfo = {
      mode: dataMode, provider: fetched.coverage?.requestedProvider ?? null, closedBars: candles.length,
      warmup: candles.length - available, requiredSamples: REQUIRED, availableSamples: available,
      firstBar: candles[0] ? new Date(candles[0].ts).toISOString() : null, lastBar: candles.length ? new Date(candles[candles.length - 1]!.ts).toISOString() : null,
      liveFetch: dataMode === "LIVE_PROVIDER" ? "OK" : liveReason.replace(/\{.*$/, "").slice(0, 200) || "not complete",
      note: "Training uses history only; live forecast freshness is checked separately by the Next Candle worker.",
    };
    const model = available >= REQUIRED ? trainPineModel(candles, ind, REQUIRED) : null;
    // Before/after: legacy raw features (absolute time / bar index allowed) vs relative-only, same chronological split.
    const legacy = model ? trainPineModel(candles, ind, REQUIRED, { relativeOnly: false }) : null;
    const comparison = model && legacy ? {
      before: { features: legacy.features.map((f) => f.name), oos: legacy.oos, ece: legacy.calibration.calibrated.ece },
      after: { features: model.features.map((f) => f.name), oos: model.oos, ece: model.calibration.calibrated.ece },
    } : null;
    if (!model) return blocked(`BLOCKED_INSUFFICIENT_SAMPLES: ${available} available, ${REQUIRED} required (warm-up ${dataInfo.warmup}, ${candles.length} gap-free closed bars). Live fetch: ${dataInfo.liveFetch}`, { data: dataInfo });

    const code = generatePine(row?.code ?? null, model, {
      name: row?.name ?? `${sym.symbol} market features`, sourceHash: ir?.sourceHash ?? null, sourceVersion: row?.version ?? null,
      symbol: sym.symbol, timeframe: data.timeframe, minConfidence: data.minConfidence, alerts: data.alerts,
      trainedFrom: new Date(candles[0]!.ts).toISOString().slice(0, 16), trainedTo: new Date(candles[candles.length - 1]!.ts).toISOString().slice(0, 16),
    });

    // Validation of the generated script with the same Pine front-end.
    const gir = await buildIR(code, { language: "pinescript" });
    const checks: { name: string; pass: boolean; detail: string }[] = [];
    const syn = gir.diagnostics.filter((d) => d.code === "PARSE_ERROR");
    const uns = gir.diagnostics.filter((d) => d.code === "UNSUPPORTED_SEMANTIC");
    checks.push({ name: "Syntax Validation", pass: !syn.length, detail: syn.map((d) => `${d.construct} @${d.line}:${d.col}`).join("; ") || "OK" });
    checks.push({ name: "Unsupported Semantic Check", pass: !uns.length, detail: uns.map((d) => `${d.construct} @${d.line}:${d.col}`).join("; ") || "OK" });
    checks.push({ name: "Script Type = INDICATOR (no orders)", pass: gir.scriptType === "INDICATOR" && !/strategy\.(entry|exit|close|order)\s*\(/.test(code), detail: gir.scriptType });
    checks.push({ name: "Lookahead OFF / no request.security", pass: !/request\.security/.test(code.split("// ===== Next Candle Forecast")[1] ?? ""), detail: "forecast block uses only current & past bars" });
    // Dependency ordering + unresolved identifiers: every nc_x feature must evaluate through the engine.
    const gs = indicatorSeries(gir, candles, meta);
    const col = (n: string) => gs.values[gs.names.indexOf(n)];
    const missing = model.features.map((_, j) => `nc_x${j}`).filter((n) => !col(n));
    checks.push({ name: "Dependency Order / Unresolved Identifiers", pass: !gs.unsupported.length && !missing.length && !!col("nc_up"), detail: [...gs.unsupported, ...missing.map((m) => `unresolved: ${m}`)].join("; ") || "OK" });
    // Reproduction: generated Pine (run bar-by-bar) must equal the trained model on the last closed bar.
    const ds = pineDataset(candles, ind); const li = ds.idx[ds.idx.length - 1]!;
    const ref = triProb(model, ds.X[ds.X.length - 1]!);
    const got = { up: col("nc_up")?.[li] ?? NaN, down: col("nc_dn")?.[li] ?? NaN, neutral: col("nc_ne")?.[li] ?? NaN };
    const maxD = Math.max(Math.abs(got.up - ref.up), Math.abs(got.down - ref.down), Math.abs(got.neutral - ref.neutral));
    checks.push({ name: "Model Reproduction (Pine vs engine)", pass: maxD < 1e-6, detail: `max Δ probability ${Number.isFinite(maxD) ? maxD.toExponential(2) : "NaN"} on bar ${new Date(candles[li]!.ts).toISOString().slice(0, 16)}` });

    // Material-change gate: the generated copy must contain the full forecast block and differ from the source.
    const block = code.split("// ===== Next Candle Forecast (Market Compass) =====")[1] ?? "";
    const markers = ['"UP"', '"DOWN"', '"NEUTRAL"', '"NO SIGNAL"', "Confidence", "nc_frozenSig", "Lookahead OFF", "Repaint NO", ...(data.alerts ? ["alertcondition("] : [])];
    const absent = markers.filter((k) => !block.includes(k) && !code.includes(k));
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
    const same = !!row && norm(code) === norm(row.code);
    const addedLines = code.split("\n").length - (row ? row.code.split("\n").length : 0);
    const changed = !same && !!block.trim() && !absent.length;
    checks.push({ name: "Forecast Block Appended (material change)", pass: changed, detail: changed ? `+${addedLines} lines; markers present` : same ? "output identical to source" : `missing: ${absent.join(", ") || "forecast block"}` });

    const ok = checks.every((c) => c.pass);
    const status = !changed ? ("GENERATION_NO_CHANGE" as const) : ok ? ("VERIFIED" as const) : ("BLOCKED_PINE_GENERATION" as const);
    return {
      status, reason: !changed ? "Generated output is not materially different from the source — no Forecast block added" : ok ? "" : "Generated code failed validation — not offered for copy",
      code: ok ? code : null, sourceCode: row?.code ?? "", checks, data: dataInfo, pineVersion: +(code.match(/@version=(\d+)/)?.[1] ?? 6), scriptType: "INDICATOR",
      source: row ? { name: row.name, version: row.version, hash: ir?.sourceHash ?? null } : null,
      sourceHash: row ? await sha256(row.code) : null, addedLines,
      generatedHash: await sha256(code), modelVersion: PINE_GEN_MODEL_VERSION,
      features: model.features.map((f) => `${f.source}:${f.name}`), trainSamples: model.trainSamples, oos: model.oos,
      calibration: model.calibration, excluded: model.excluded, missingRows: model.missingRows, comparison,
      lock: tvLock(sym.symbol, data.timeframe).label,
      lastBar: { ts: new Date(candles[li]!.ts).toISOString(), ...ref },
    };
  });

const parityInput = z.object({ runId: z.string().uuid(), csv: z.string().min(10).max(5_000_000), timeToleranceMs: z.number().min(0).default(0), priceTolerance: z.number().min(0).default(0), pnlTolerance: z.number().min(0).default(0.01) });

export const runTvParity = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => parityInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { parseTradingViewCsv, compareParity } = await import("./strategy/parity");
    const { data: run } = await db.from("use_backtest_runs").select("id,symbol,timeframe,period_start,period_end,settings,trades,status,strategy_hash").eq("id", data.runId).maybeSingle();
    if (!run) throw new Error("Backtest run not found");
    const s = (run.settings ?? {}) as Record<string, unknown>;
    const engine = (Array.isArray(run.trades) ? run.trades : []) as never[];
    const { trades, errors } = parseTradingViewCsv(data.csv);
    const ctx = {
      symbol: run.symbol, exchange: "", timeframe: run.timeframe, timezone: "UTC" as const, from: run.period_start, to: run.period_end,
      inputs: (s["params"] ?? {}) as Record<string, unknown>, capital: Number(s["initialCapital"] ?? 0), commission: Number(s["commissionValue"] ?? 0),
      slippage: Number(s["slippageTicks"] ?? 0), sizing: `${s["qtyType"] ?? "?"} ${s["qty"] ?? ""}`.trim(),
    };
    // Only compare TradingView trades inside the engine run's period.
    const from = Date.parse(run.period_start), to = Date.parse(run.period_end);
    const inRange = trades.filter((t) => t.entryTs >= from && t.entryTs <= to);
    const report = compareParity(inRange, engine, ctx, { timeToleranceMs: data.timeToleranceMs, priceTolerance: data.priceTolerance, pnlTolerance: data.pnlTolerance }, errors);
    return { ...report, context: { ...report.context, inputs: {} as Record<string, string> }, inputsJson: JSON.stringify(ctx.inputs), strategyHash: run.strategy_hash, runStatus: run.status, outOfRangeTvTrades: trades.length - inRange.length,
      execution: { pyramiding: String(s["pyramiding"] ?? 1), fillPolicy: String(s["fillPolicy"] ?? ""), conversionExecution: JSON.stringify(s["conversionExecution"] ?? null) } };
  });
