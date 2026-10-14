import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ConvertToStrategy } from "./ConvertToStrategy";

import { Chip, Panel, numFmt, pct } from "@/components/use/primitives";
import { getProBacktest, getStrategyIR, listProBacktests, runProBacktest } from "@/lib/use/strategy.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";

type Opt = { symbol: string; display_name: string; provider?: string };
type Strat = { id: string; name: string };
const sel = "rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink";
const f = (v: unknown, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const dur = (ms: unknown) => { if (typeof ms !== "number") return "—"; const h = ms / 3_600_000; return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`; };
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

export function ProBacktest({ symbols, strategies }: { symbols: Opt[]; strategies: Strat[] }) {
  const qc = useQueryClient();
  const runFn = useServerFn(runProBacktest);
  const listFn = useServerFn(listProBacktests);
  const getFn = useServerFn(getProBacktest);
  const irFn = useServerFn(getStrategyIR);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const [sid, setSid] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState("1h");
  const [start, setStart] = useState(new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(today.toISOString().slice(0, 10));
  const [spread, setSpread] = useState("0");
  const [slip, setSlip] = useState("0");
  const [comm, setComm] = useState("0.04");
  const [policy, setPolicy] = useState<"LOWER_TIMEFRAME_RESOLUTION" | "CONSERVATIVE_SL_FIRST" | "OPTIMISTIC_TP_FIRST">("LOWER_TIMEFRAME_RESOLUTION");
  const [sizing, setSizing] = useState<"default" | "fixed" | "risk_percent">("default");
  const [qty, setQty] = useState("1");
  const [openId, setOpenId] = useState<string | null>(null);
  const strategyId = sid || strategies[0]?.id || "";

  const ir = useQuery({ queryKey: ["use", "ir", strategyId], queryFn: () => irFn({ data: { id: strategyId } }), enabled: !!strategyId });
  const runs = useQuery({ queryKey: ["use", "pro-runs"], queryFn: () => listFn() });
  const detail = useQuery({ queryKey: ["use", "pro-run", openId], queryFn: () => getFn({ data: { id: openId! } }), enabled: !!openId });
  const run = useMutation({
    mutationFn: () => runFn({ data: { strategyId, symbol, timeframe: tf, start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z`, settings: { spread: +spread, slippageTicks: +slip, commissionValue: +comm, commissionType: "percent", fillPolicy: policy, ...(sizing === "default" ? {} : { qtyType: sizing, qty: +qty }) } } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["use", "pro-runs"] }); if (r.runId) setOpenId(r.runId); },
  });
  const irData = ir.data?.ir as any;
  const isNonStrategy = irData?.scriptType === "INDICATOR" || irData?.scriptType === "LIBRARY";
  const d = detail.data as any;
  const m: any = d?.metrics ?? {};

  return (
    <Panel title="الاختبار التاريخي الاحترافي (المرحلة 2)" subtitle="تنفيذ دلالي شمعة بشمعة للكود الأصلي على بيانات المرحلة 1 المتحقق منها — تنفيذ في الشمعة التالية، بدون نظر للمستقبل.">
      <div className="flex flex-wrap items-end gap-2">
        <select className={sel} value={strategyId} onChange={(e) => setSid(e.target.value)}>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select className={sel} value={symbol} onChange={(e) => setSymbol(e.target.value)}>{symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol} · {s.provider ?? ""}</option>)}</select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)}>{ANALYSIS_TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}</select>
        <input type="date" className={sel} value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" className={sel} value={end} onChange={(e) => setEnd(e.target.value)} />
        <label className="text-[11px] text-ink-soft">Spread<input className={`${sel} ms-1 w-20`} value={spread} onChange={(e) => setSpread(e.target.value)} /></label>
        <label className="text-[11px] text-ink-soft">Slippage ticks<input className={`${sel} ms-1 w-16`} value={slip} onChange={(e) => setSlip(e.target.value)} /></label>
        <label className="text-[11px] text-ink-soft">Commission %<input className={`${sel} ms-1 w-16`} value={comm} onChange={(e) => setComm(e.target.value)} /></label>
        <select className={sel} value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)} title="Same-bar TP/SL policy">
          <option value="LOWER_TIMEFRAME_RESOLUTION">LOWER_TIMEFRAME_RESOLUTION</option><option value="CONSERVATIVE_SL_FIRST">CONSERVATIVE_SL_FIRST</option><option value="OPTIMISTIC_TP_FIRST">OPTIMISTIC_TP_FIRST</option>
        </select>
        <select className={sel} value={sizing} onChange={(e) => setSizing(e.target.value as typeof sizing)}>
          <option value="default">Sizing: default</option><option value="fixed">Fixed Contracts / Units</option><option value="risk_percent">Risk % of Equity</option>
        </select>
        {sizing !== "default" && <input className={`${sel} w-20`} value={qty} onChange={(e) => setQty(e.target.value)} title={sizing === "fixed" ? "contracts" : "% risk"} />}
        <button onClick={() => run.mutate()} disabled={run.isPending || !strategyId || isNonStrategy} className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{run.isPending ? "جارٍ التنفيذ…" : "تشغيل"}</button>
      </div>
      {isNonStrategy && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-glass-border bg-background/60 p-2 text-xs text-ink">
          <span>لا يمكن تشغيل Backtest لأن الكود {irData.scriptType === "LIBRARY" ? "مكتبة" : "مؤشر"} ولا يحتوي أوامر دخول/خروج</span>
          {irData.scriptType === "INDICATOR" && <ConvertToStrategy strategyId={strategyId} />}
        </div>
      )}
      {run.data && (
        <p className="mt-2 text-xs text-ink" dir="ltr">
          {run.data.status}{"error" in run.data && run.data.error ? ` — ${run.data.error}` : ""}
          {"reproducibility" in run.data && run.data.reproducibility ? ` · Reproducibility vs ${run.data.reproducibility.previousRunId.slice(0, 8)}: trades ${run.data.reproducibility.sameTrades ? "IDENTICAL" : "DIFFERENT"}, metrics ${run.data.reproducibility.sameMetrics ? "IDENTICAL" : "DIFFERENT"}` : ""}
        </p>
      )}
      {run.error && <p className="mt-2 text-xs text-bear">{(run.error as Error).message}</p>}

      {irData && (
        <div className="mt-4 rounded-xl border border-glass-border p-3 text-xs text-ink" dir="ltr">
          <div className="mb-2 flex flex-wrap gap-2">
            <Chip tone={irData.executable ? "bull" : "bear"}>{irData.executable ? "IR EXECUTABLE" : "NOT EXECUTABLE"}</Chip>
            <Chip>{irData.sourceLanguage}{irData.languageVersion ? ` v${irData.languageVersion}` : ""}</Chip>
            <Chip>Type: {irData.scriptType}</Chip><Chip>{irData.irVersion}</Chip>
            <span className="font-mono text-ink-soft">hash {String(irData.sourceHash).slice(0, 16)}…</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div><b>Inputs</b>{(irData.inputs ?? []).map((x: any) => <div key={x.name} className="font-mono">{x.name} = {String(x.default)}</div>)}</div>
            <div><b>States (var)</b>{(irData.states ?? []).map((x: any) => <div key={x.name} className="font-mono">{x.name} := {x.init}</div>)}<b className="mt-1 block">Indicators</b>{(irData.indicators ?? []).map((x: any, i: number) => <div key={i} className="font-mono">L{x.line} {x.call}</div>)}</div>
            <div><b>Entry</b>{(irData.entryRules ?? []).map((x: any, i: number) => <div key={i} className="font-mono">L{x.line} {x.direction} {x.orderType} if {x.guard || "always"}</div>)}<b className="mt-1 block">Exit / Risk</b>{(irData.exitRules ?? []).map((x: any, i: number) => <div key={i} className="font-mono">L{x.line} {x.kind} {x.id ?? ""} {x.stop ? `stop=${x.stop}` : ""} {x.limit ? `limit=${x.limit}` : ""}</div>)}</div>
          </div>
          {(irData.diagnostics ?? []).length > 0 && <div className="mt-2 text-bear">{irData.diagnostics.map((x: any, i: number) => <div key={i} className="font-mono">{x.code} · {x.construct} · line {x.line}:{x.col} · {x.text}</div>)}</div>}
        </div>
      )}

      <div className="mt-4 max-h-64 overflow-auto rounded-xl border border-glass-border">
        <table className="w-full text-xs" dir="ltr">
          <thead className="sticky top-0 bg-background text-ink-soft"><tr>{["Time", "Symbol", "TF", "Provider", "Coverage", "Bars", "Trades", "PF", "Status", "Trades hash"].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
          <tbody>{(runs.data ?? []).map((r: any) => (
            <tr key={r.id} onClick={() => setOpenId(r.id)} className={`cursor-pointer border-t border-glass-border text-ink ${openId === r.id ? "bg-muted" : ""}`}>
              <td className="px-2 py-1">{r.created_at.slice(5, 19).replace("T", " ")}</td><td className="px-2 py-1">{r.symbol}</td><td className="px-2 py-1">{r.timeframe}</td>
              <td className="px-2 py-1">{r.provider ?? "—"}</td><td className="px-2 py-1">{r.coverage_percent != null ? `${r.coverage_percent}%` : "—"}</td><td className="px-2 py-1">{r.bar_count}</td>
              <td className="px-2 py-1">{r.metrics?.trades ?? "—"}</td><td className="px-2 py-1">{f(r.metrics?.profitFactor)}</td><td className="px-2 py-1">{r.status}</td>
              <td className="px-2 py-1 font-mono">{r.trades_hash ? r.trades_hash.slice(0, 12) : "—"}</td>
            </tr>))}</tbody>
        </table>
      </div>

      {d && (
        <div className="mt-4 space-y-3 text-xs text-ink" dir="ltr">
          <div className="grid gap-1 rounded-xl border border-glass-border p-3 font-mono sm:grid-cols-2">
            <div>Analysis ID: {d.analysis_id}</div><div>Strategy Hash: {String(d.strategy_hash).slice(0, 24)}…</div>
            <div>Provider: {d.provider ?? "—"} · Dataset: {d.dataset ?? "—"}</div><div>Symbol/TF: {d.symbol} {d.timeframe}</div>
            <div>Start: {d.period_start}</div><div>End: {d.period_end}</div>
            <div>Coverage Report: {d.coverage_report_id ?? "—"} ({d.coverage_status} {d.coverage_percent}%)</div><div>Bars: {d.bar_count} · Dataset hash {String(d.dataset_hash ?? "").slice(0, 16)}</div>
          </div>
          {d.error && <p className="text-bear">{d.error}</p>}
          {(m.warnings ?? []).length > 0 && <div className="rounded-xl border border-glass-border p-2 text-bear">{m.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}</div>}
          <div className="grid gap-1 rounded-xl border border-glass-border p-3 font-mono sm:grid-cols-2">
            <div>Fill policy: {d.settings?.fillPolicy} · ambiguous {m.fillStats?.ambiguousBars ?? 0} · resolved by 1m {m.fillStats?.resolvedByLowerTf ?? 0} · fallback SL-first {m.fillStats?.unresolvedFallbackSlFirst ?? 0}</div>
            <div>Sizing: {d.settings?.qtyType} {d.settings?.qty} {d.settings?.integerQty ? "(whole contracts)" : ""}</div>
            {d.settings?.contract && <div>Contract {d.settings.contract.root}: ×{d.settings.contract.multiplier} · tick {d.settings.contract.tickSize} = {d.settings.contract.tickValue} {d.settings.contract.currency} · margin {d.settings.contract.initialMargin ?? "n/a"}</div>}
            <div>Observed: {f(m.observedDays, 1)} days · trades {m.sampleSizeTrades} · daily returns {m.sampleSizeDailyReturns}</div>
            <div className="sm:col-span-2 text-ink-soft">Annualization: {m.annualizationMethod} · Calmar = {m.calmarLabel} · Sharpe/Sortino = {m.sharpeLabel}</div>
          </div>
          {m.trades !== undefined && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              {[
                ["Trades", m.trades], ["Wins", m.wins], ["Losses", m.losses], ["Win Rate", pct(m.winRate ?? 0)], ["Profit Factor", f(m.profitFactor)], ["Expectancy", f(m.expectancy)],
                ["Net %", f(m.netProfitPct)], ["Max DD %", f(m.maxDrawdownPct)], [`Sharpe${m.sharpeLabel && m.sharpeLabel !== "ANNUALIZED" ? " (est.)" : ""}`, f(m.sharpe)], [`Sortino${m.sharpeLabel && m.sharpeLabel !== "ANNUALIZED" ? " (est.)" : ""}`, f(m.sortino)], [`Calmar${m.calmarLabel === "ANNUALIZED_ESTIMATE" ? " (ANNUALIZED_ESTIMATE)" : ""}`, f(m.calmar)], ["Avg Hold", dur(m.avgHoldingMs)],
                ["Avg MFE %", f(m.avgMfePct, 3)], ["Avg MAE %", f(m.avgMaePct, 3)], ["Time to TP", dur(m.avgTimeToTpMs)], ["Time to SL", dur(m.avgTimeToSlMs)], ["Max Cons. W", m.maxConsecutiveWins], ["Max Cons. L", m.maxConsecutiveLosses],
              ].map(([k, v]) => <div key={String(k)} className="rounded-lg border border-glass-border p-2"><div className="text-[10px] text-ink-soft">{k}</div><div className="font-semibold">{String(v)}</div></div>)}
            </div>
          )}
          {d.breakdowns && Object.keys(d.breakdowns).length > 0 && (
            <div className="grid gap-2 sm:grid-cols-4">
              {Object.entries(d.breakdowns as Record<string, any[]>).map(([k, rows]) => (
                <div key={k} className="rounded-xl border border-glass-border p-2">
                  <div className="mb-1 font-semibold capitalize">{k}</div>
                  {rows.map((r) => <div key={r.key} className="flex justify-between gap-2 font-mono"><span>{r.key}</span><span>{r.trades}t · {pct(r.winRate, 0)} · {numFmt(r.netPnl, 0)}</span></div>)}
                </div>
              ))}
            </div>
          )}
          {Array.isArray(d.trades) && d.trades.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-xl border border-glass-border">
              <table className="w-full text-xs"><thead className="sticky top-0 bg-background text-ink-soft"><tr>{["#", "Dir", "Entry", "Entry Px", "Exit", "Exit Px", "Reason", "Bars", "PnL", "MFE", "MAE"].map((h) => <th key={h} className="px-2 py-1 text-left font-medium">{h}</th>)}</tr></thead>
                <tbody>{d.trades.slice(0, 300).map((t: any) => (
                  <tr key={t.n} className="border-t border-glass-border"><td className="px-2 py-1">{t.n}</td><td className="px-2 py-1">{t.dir}</td><td className="px-2 py-1">{iso(t.entryTs)}</td><td className="px-2 py-1">{t.entryPx}</td>
                    <td className="px-2 py-1">{iso(t.exitTs)}</td><td className="px-2 py-1">{t.exitPx}</td><td className="px-2 py-1">{t.reason}</td><td className="px-2 py-1">{t.bars}</td>
                    <td className={`px-2 py-1 ${t.pnl > 0 ? "text-bull" : "text-bear"}`}>{f(t.pnl)}</td><td className="px-2 py-1">{f(t.mfe)}</td><td className="px-2 py-1">{f(t.mae)}</td></tr>))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
