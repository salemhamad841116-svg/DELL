import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { createForecast, getForecastHealth, getLedger, listSchedules, runBinanceProbe, upsertSchedule } from "@/lib/use/forecast.functions";
import { REGIME_LABELS } from "@/lib/use/regime";
import { timeframeSeconds } from "@/lib/use/timeframes";
import { Chip, Panel, Stat } from "./primitives";
import { cn } from "@/lib/utils";

type Strat = { id: string; name: string; validation: unknown };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const hhmm = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const hms = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—");
const LABEL: Record<string, string> = { UP: "↑ UP", DOWN: "↓ DOWN", NEUTRAL: "— NEUTRAL", LOW_CONFIDENCE: "NO SIGNAL — INSUFFICIENT CONFIDENCE" };
const STATUS_AR: Record<string, string> = { PENDING_DATA: "Pending data", SCORED: "Scored", NO_TRADE_INTERVAL: "No trade", PROVIDER_ERROR: "Provider error (retrying)", FAILED: "Failed" };

export function NextCandleForecast({ symbol, timeframe, strategies, initialIndicatorId }: { symbol: string; timeframe: string; strategies: Strat[]; initialIndicatorId?: string | undefined }) {
  const [indicatorId, setIndicatorId] = useState(initialIndicatorId ?? "");
  const [minConf, setMinConf] = useState(55);
  const qc = useQueryClient();
  const createFn = useServerFn(createForecast);
  const ledgerFn = useServerFn(getLedger);
  const schedFn = useServerFn(listSchedules);
  const upsertFn = useServerFn(upsertSchedule);
  const tfMs = timeframeSeconds(timeframe) * 1000;

  // Browser only displays persisted results; the backend worker generates and scores.
  const ledger = useQuery({ queryKey: ["nc-ledger", symbol, timeframe], queryFn: () => ledgerFn({ data: { symbol, timeframe } }), enabled: !!symbol, refetchInterval: 15_000 });
  const scheds = useQuery({ queryKey: ["nc-scheds"], queryFn: () => schedFn(), refetchInterval: 30_000 });
  const sched = scheds.data?.find((s) => s.symbol === symbol && s.timeframe === timeframe && (s.strategy_id ?? "") === indicatorId);
  useEffect(() => { if (sched) setMinConf(Math.round(sched.min_confidence * 100)); }, [sched?.id]);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => upsertFn({ data: { symbol, timeframe, strategyId: indicatorId || null, enabled, minConfidence: minConf / 100 } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["nc-scheds"] }),
  });
  const fc = useMutation({
    mutationFn: () => createFn({ data: { symbol, timeframe, strategyId: indicatorId || null, minConfidence: minConf / 100 } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["nc-ledger", symbol, timeframe] }),
  });

  const sel = strategies.find((s) => s.id === indicatorId);
  const rows = (ledger.data?.rows ?? []) as any[];
  const latest = rows.find((r) => (r.strategy_id ?? "") === indicatorId) ?? null;
  const p = (fc.data?.prediction as any) && (fc.data!.prediction as any).target_ts >= (latest?.target_ts ?? "") ? (fc.data!.prediction as any) : latest;

  // Countdown is visual only, anchored to server time.
  const [offset, setOffset] = useState(0);
  useEffect(() => { if (ledger.data?.serverNow) setOffset(ledger.data.serverNow - Date.now()); }, [ledger.data?.serverNow]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const targetClose = p?.target_ts ? Date.parse(p.target_ts) + tfMs : null;
  const left = targetClose ? Math.max(0, targetClose - (now + offset)) : null;

  const sig = p ? (p.signal ?? p.direction) : null;
  const tone = sig === "UP" ? "text-bull" : sig === "DOWN" ? "text-bear" : "text-ink-soft";
  const ev = (p?.evidence ?? {}) as { top?: { label: string; contribution: number }[]; oos?: { accuracy: number; baseline: number; samples: number }; overfittingRisk?: boolean; indicatorFeatures?: string[] };
  const w = ledger.data?.windows;

  return (
    <div className="space-y-5">
      <Panel title="Next Candle Forecast" subtitle="Forecasts are generated and scored on the server automatically after every candle closes — even with the browser closed. This page only displays the saved record.">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-[11px] text-ink-soft">Indicator or strategy (feature source)</span>
            <select value={indicatorId} onChange={(e) => setIndicatorId(e.target.value)} className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink">
              <option value="">No indicator (market features only)</option>
              {strategies.map((s) => <option key={s.id} value={s.id}>{s.name} · {(s.validation as { scriptType?: string } | null)?.scriptType ?? "?"}</option>)}
            </select>
            <span className="block text-[11px] text-ink-soft">Indicators (INDICATOR_ONLY) work here directly as forecast-only signals — no need for BUY/SELL/EXIT or TP/SL conditions or strategy.entry, and no need to convert them into a strategy.</span>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] text-ink-soft">Minimum signal confidence (%)</span>
            <input type="number" min={34} max={99} value={minConf} onChange={(e) => setMinConf(Math.min(99, Math.max(34, Number(e.target.value) || 55)))} className="num w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink" />
          </label>
          <div className="flex items-end">
            <button type="button" disabled={!symbol || fc.isPending} onClick={() => fc.mutate()} className="w-full rounded-xl border border-glass-border px-4 py-2.5 text-sm text-ink disabled:opacity-50">
              {fc.isPending ? "Computing…" : "Forecast now"}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {sched?.enabled ? <Chip tone="bull">Background run: enabled · {Math.round(sched.min_confidence * 100)}%</Chip> : <Chip>Background run: stopped</Chip>}
          <button type="button" disabled={!symbol || toggle.isPending} onClick={() => toggle.mutate(true)} className="rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {sched?.enabled ? "Save settings" : "Enable automatic server forecasting"}
          </button>
          {sched?.enabled && <button type="button" onClick={() => toggle.mutate(false)} className="rounded-xl border border-glass-border px-3 py-2 text-xs text-ink">Stop</button>}
          {sched?.last_status && <span className="text-[11px] text-ink-soft">Last run: {sched.last_status} · {hms(sched.last_run_at)}{sched.last_error ? ` · ${sched.last_error}` : ""}</span>}
        </div>
        <p className="mt-2 text-[11px] text-ink-soft">{symbol} · {timeframe} · {sel?.name ?? "Market features only"}</p>
        {fc.isError && <p className="mt-2 text-xs text-bear">{(fc.error as Error).message}</p>}
        {fc.data && !fc.data.prediction && <p className="mt-2 text-xs text-bear">{fc.data.status}: {fc.data.note}</p>}
        {fc.data?.warnings?.map((x) => <p key={x} className="mt-1 text-[11px] text-ink-soft">{x}</p>)}
      </Panel>

      {p && (
        <Panel title={`NEXT CANDLE — ${p.timeframe}`} subtitle={`${p.symbol} · ${p.generated_by === "worker" ? "Generated automatically by the server" : "Manual forecast"} · Frozen`}
          action={<div className="flex flex-wrap gap-1.5"><Chip>FROZEN: YES</Chip><Chip>LOOKAHEAD: OFF</Chip><Chip>REPAINT: NO</Chip>{ev.overfittingRisk && <Chip tone="warn">OVERFITTING RISK</Chip>}</div>}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className={cn("num font-semibold", tone, sig === "LOW_CONFIDENCE" ? "text-2xl" : "text-4xl")}>{LABEL[sig] ?? sig}</div>
              <div className="num mt-2 flex gap-4 text-sm">
                <span className="text-bull">UP {pct(p.bullish_probability)}</span>
                <span className="text-bear">DOWN {pct(p.bearish_probability)}</span>
                <span className="text-ink-soft">NEUTRAL {pct(p.neutral_probability)}</span>
              </div>
            </div>
            <div className="text-left">
              <div className="text-[11px] text-ink-soft">Countdown to target candle close (display only)</div>
              <div className="num text-2xl text-ink">{left === null ? "—" : `${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`}</div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Minimum signal confidence" value={pct(p.min_confidence)} />
            <Stat label="Source candle" value={hhmm(p.source_bar_time)} />
            <Stat label="Target candle" value={hhmm(p.target_ts)} />
            <Stat label="Forecast time (server)" value={hms(p.prediction_time)} hint={p.generation_delay_ms != null ? `${(p.generation_delay_ms / 1000).toFixed(1)}s after close` : ""} />
            <Stat label="Market regime" value={REGIME_LABELS[p.market_regime as keyof typeof REGIME_LABELS] ?? p.market_regime} />
            <Stat label="Model" value={`${p.model_version} · ${p.feature_version}`} />
            <Stat label="Out-of-sample accuracy" value={ev.oos ? `${pct(ev.oos.accuracy)} (baseline ${pct(ev.oos.baseline)})` : "—"} hint={ev.oos ? `${ev.oos.samples} samples` : ""} />
            <Stat label="Scoring status" value={STATUS_AR[p.scoring_status] ?? p.scoring_status ?? "—"} />
          </div>
          <div className="mt-3 text-[11px] text-ink-soft">
            Indicator fingerprint: <span className="num">{String(p.indicator_hash).slice(0, 16)}</span>
            {ev.indicatorFeatures && ev.indicatorFeatures.length > 0 && <> · Indicator values used: {ev.indicatorFeatures.join(", ")}</>}
          </div>
          {!p.explain && ev.top && <div className="mt-2 text-[11px] text-ink-soft">Strongest factors: {ev.top.map((e) => `${e.label} (${e.contribution > 0 ? "+" : ""}${e.contribution})`).join(" · ")}</div>}
          {p.explain && <WhyPrediction x={p.explain} gate={p.gate} />}
        </Panel>
      )}

      {w && (
        <Panel title="Forecast Accuracy" subtitle="From the frozen prediction ledger only — NEUTRAL and NO SIGNAL are never counted as correct or wrong.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-right text-xs">
              <thead className="text-ink-soft"><tr className="border-b border-glass-border">{["Period", "Scored", "Correct", "Wrong", "No signal", "Accuracy", "UP accuracy", "DOWN accuracy", "Pending"].map((h) => <th key={h} className="py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {([["Last 20", w.last20], ["Last 100", w.last100], ["Today", w.today], ["7 days", w.d7], ["30 days", w.d30]] as const).map(([l, s]) => (
                  <tr key={l} className="border-b border-glass-border/70 last:border-0">
                    <td className="py-2 text-ink">{l}</td><td className="num">{s.evaluated}</td><td className="num text-bull">{s.correct}</td><td className="num text-bear">{s.wrong}</td><td className="num">{s.neutral}</td>
                    <td className="num">{pct(s.accuracy)}</td><td className="num">{pct(s.upAccuracy.acc)} ({s.upAccuracy.n})</td><td className="num">{pct(s.downAccuracy.acc)} ({s.downAccuracy.n})</td><td className="num">{s.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-[11px] text-ink-soft">Confidence calibration (last 100):</div>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {w.last100.calibration.map((b) => <Stat key={b.from} label={`Confidence ${Math.round(b.from * 100)}–${Math.round(b.to * 100)}%`} value={pct(b.observed)} hint={`${b.n} forecasts`} />)}
          </div>
        </Panel>
      )}

      {ledger.data && (
        <Panel title="Forecast Ledger" subtitle="Every forecast is saved and cannot be edited; the result is written once after the target candle closes. Times are from the server clock.">
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[980px] text-right text-[11px]">
              <thead className="sticky top-0 bg-background text-ink-soft"><tr>{["Forecast time", "Source", "Target", "Signal", "UP/DOWN/NEU", "Actual", "Move", "Result", "Scored at", "By", "Fingerprint"].map((h) => <th key={h} className="py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = r.signal ?? r.direction;
                  return (
                    <tr key={r.id} className="border-t border-glass-border/70">
                      <td className="num py-1.5">{hms(r.prediction_time)}</td><td className="num">{hhmm(r.source_bar_time)}</td><td className="num">{hhmm(r.target_ts)}</td>
                      <td className={cn("num", s === "UP" && "text-bull", s === "DOWN" && "text-bear")}>{s === "LOW_CONFIDENCE" ? "NO SIGNAL" : LABEL[s] ?? s}</td>
                      <td className="num">{pct(r.bullish_probability)} / {pct(r.bearish_probability)} / {pct(r.neutral_probability)}</td>
                      <td className="num">{r.actual_result ?? "…"}</td>
                      <td className="num">{r.actual_move != null ? r.actual_move.toFixed(2) : "—"}{r.atr_threshold != null ? ` (±${r.atr_threshold.toFixed(2)})` : ""}</td>
                      <td>{r.evaluation_status !== "evaluated" ? (STATUS_AR[r.scoring_status] ?? "Pending") : r.correct === null ? "No signal" : r.correct ? "✓ Correct" : "✗ Wrong"}</td>
                      <td className="num">{hms(r.scored_at)}</td>
                      <td>{r.generated_by === "worker" ? "Server" : r.generated_by === "manual" ? "Manual" : "—"}</td>
                      <td className="num">{String(r.indicator_hash).slice(0, 10)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-3 text-xs text-ink-soft">No forecasts yet.</p>}
          </div>
        </Panel>
      )}
    </div>
  );
}

export function ForecastHealth() {
  const fn = useServerFn(getForecastHealth);
  const h = useQuery({ queryKey: ["nc-health"], queryFn: () => fn(), refetchInterval: 20_000 });
  const d = h.data;
  const probeFn = useServerFn(runBinanceProbe);
  const qc = useQueryClient();
  const probe = useMutation({ mutationFn: () => probeFn(), onSuccess: () => qc.invalidateQueries({ queryKey: ["nc-health"] }) });
  return (
    <Panel title="Next Candle — Background Worker Health" subtitle="The server generates and scores forecasts every minute without needing the browser open.">
      {!d ? <p className="text-xs text-ink-soft">{h.isError ? (h.error as Error).message : "Loading…"}</p> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Last forecast generated" value={hms(d.lastForecastGenerated)} />
            <Stat label="Last forecast scored" value={hms(d.lastForecastScored)} />
            <Stat label="Pending scoring" value={String(d.pendingScores)} />
            <Stat label="Failed jobs" value={`${d.failedJobs} schedules · ${d.failedScores} scorings`} />
            <Stat label="Avg generation delay" value={d.avgGenerationDelayMs == null ? "—" : `${(d.avgGenerationDelayMs / 1000).toFixed(1)}s`} />
            <Stat label="Provider" value={d.provider ?? "—"} />
            <Stat label="Model" value={d.modelVersion ?? "—"} />
            <Stat label="Last worker tick" value={hms(d.lastTickAt)} />
          </div>
          <BinanceStatus b={d.binance as any} fails={d.binanceFailures as any[]} probe={probe} lastTick={d.lastTickResult as any} />
          <div className="mt-3 space-y-1">
            {d.schedules.length === 0 && <p className="text-xs text-ink-soft">No enabled schedules — enable one from the Next Candle tab.</p>}
            {d.schedules.map((s: any) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 text-[11px] text-ink-soft">
                <Chip tone={!s.enabled ? "neutral" : s.missed || s.last_status === "FAILED" ? "warn" : "bull"}>{s.enabled ? (s.missed ? "MISSED FORECAST" : s.last_status ?? "WAITING") : "DISABLED"}</Chip>
                <span className="num text-ink">{s.symbol} · {s.timeframe}</span>
                <span>Indicator: {s.strategy_id ? String(s.strategy_id).slice(0, 8) : "none"}</span>
                <span>Last target: {hhmm(s.last_target_ts)}</span>
                {s.last_error && <span className="text-bear">{s.last_error}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function BinanceStatus({ b, fails, probe, lastTick }: { b: any; fails: any[]; probe: any; lastTick: any }) {
  const p = (probe.data ?? b?.last_probe) as any;
  const gen = lastTick?.gen;
  const pipelineOk = !b?.degraded && gen && (gen.created > 0 || gen.existing > 0) && !gen.providerError;
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line p-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="bull">BACKGROUND WORKER = HEALTHY</Chip>
        <Chip tone={pipelineOk ? "bull" : "warn"}>BACKGROUND FORECAST PIPELINE = {pipelineOk ? "RUNNING" : "NOT VERIFIED"}</Chip>
        <Chip tone={b?.degraded ? "bear" : "bull"}>{b?.degraded ? "BINANCE_DEGRADED" : "BINANCE OK"}</Chip>
        <button className="rounded-md border border-line px-2 py-1 text-ink hover:bg-muted" disabled={probe.isPending} onClick={() => probe.mutate()}>{probe.isPending ? "Checking…" : "Probe Binance from server"}</button>
      </div>
      {b?.degraded && <p className="text-bear">{b.degraded_reason} · retrying after {hms(b.blocked_until)} (consecutive blocks {b.consecutive_blocks})</p>}
      {p && (
        <div className="text-ink-soft">
          <span>Last check {hms(p.at)} ({p.source}) · Outbound IP {p.outboundIp ?? "—"} · Region {p.region ?? "—"} · {p.host}</span>
          <div className="mt-1 flex flex-wrap gap-2">{p.steps?.map((s: any) => <Chip key={s.endpoint} tone={s.ok ? "bull" : "bear"}>{s.endpoint.split("?")[0]} → {s.status ?? "ERR"} ({s.ms}ms){s.note ? ` · ${s.note}` : ""}</Chip>)}</div>
        </div>
      )}
      {fails.length > 0 && (
        <details><summary className="cursor-pointer text-ink-soft">Latest Binance errors ({fails.length})</summary>
          {fails.map((f, i) => (
            <div key={i} className="mt-1 border-t border-line pt-1 text-ink-soft">
              <div className="num">{hms(f.created_at)} · {f.method} {f.endpoint} → {f.http_status} · {f.classification} · {f.source} · IP {f.outbound_ip ?? "—"} · {f.server_region ?? "—"}</div>
              <div className="num">weight: {JSON.stringify(f.weight_headers)}</div>
              <div className="num line-clamp-2 break-all">{f.response_body}</div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** "Why this prediction?" — read from the frozen row only; nothing is recomputed. */
function WhyPrediction({ x, gate }: { x: any; gate: any }) {
  const f = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toPrecision(6) : v.toFixed(4)) : String(v ?? "—"));
  return (
    <details dir="ltr" className="mt-4 rounded-xl border border-glass-border p-3 text-left text-[11px] text-ink-soft" open>
      <summary className="cursor-pointer text-xs font-semibold text-ink">Why this prediction?</summary>
      <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <span>Source candle: {x.sourceCandle?.ts?.slice(0, 16)} UTC · close {f(x.sourceCandle?.close)}</span>
        <span>Target candle: opens {x.targetCandle?.opens?.slice(0, 16)} · closes {x.targetCandle?.closes?.slice(0, 16)} UTC</span>
        <span>Indicator: {x.indicator?.name ?? "market features only"}{x.indicator?.version ? ` v${x.indicator.version}` : ""} · {String(x.indicator?.hash ?? "").slice(0, 12)}</span>
        <span>Model: {x.model?.version} · registry {x.model?.status ?? "none"}</span>
        <span>Comparable historical samples: {x.comparableSamples}</span>
        <span>Probabilities: UP {(x.probabilities?.up * 100).toFixed(1)}% · DOWN {(x.probabilities?.down * 100).toFixed(1)}% · NEUTRAL {(x.probabilities?.neutral * 100).toFixed(1)}%</span>
        <span>Threshold: {(x.threshold * 100).toFixed(0)}% · min UP/DOWN gap {(x.minGap * 100).toFixed(0)}pp</span>
        <span className="font-semibold text-ink">Final: {x.decision === "LOW_CONFIDENCE" ? "NO SIGNAL — INSUFFICIENT CONFIDENCE" : x.decision}</span>
      </div>
      <p className="mt-2 text-ink">{x.reason}</p>
      {x.indicatorValues && Object.keys(x.indicatorValues).length > 0 && (
        <p className="mt-2">Indicator values at source bar: {Object.entries(x.indicatorValues).map(([k, v]) => `${k}=${f(v)}`).join(" · ")}</p>
      )}
      {x.contributions?.length > 0 && (
        <div className="mt-2">
          <div>Top feature contributions ({x.contributionModel}: weight × standardized value, real model output):</div>
          <ul className="num">{x.contributions.map((c: any) => <li key={c.feature}>{c.feature} = {f(c.value)} → {c.contribution > 0 ? "+" : ""}{c.contribution.toFixed(3)}</li>)}</ul>
        </div>
      )}
      {gate?.checks && (
        <ul className="mt-2">{gate.checks.map((c: any) => <li key={c.name} className={c.pass ? "text-bull" : "text-bear"}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>
      )}
    </details>
  );
}
