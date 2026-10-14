// Indicator Historical Pattern Analyzer → Next Candle. Indicator stays an indicator (no conversion).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { Chip, Panel, Stat } from "@/components/use/primitives";
import { analyzeHistoricalPattern, listPatternForecasts } from "@/lib/use/pattern.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";

type Opt = { symbol: string; display_name: string };
type Strat = { id: string; name: string; validation?: { scriptType?: string } | null };
const sel = "rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink";
const btn = "rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50";
const p = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function PatternAnalyzer({ symbols, strategies }: { symbols: Opt[]; strategies: Strat[] }) {
  const run = useServerFn(analyzeHistoricalPattern);
  const list = useServerFn(listPatternForecasts);
  const qc = useQueryClient();
  const indicators = strategies.filter((s) => s.validation?.scriptType === "INDICATOR");
  const [sid, setSid] = useState("");
  const [symbol, setSymbol] = useState(symbols.find((s) => s.symbol.includes("EUR"))?.symbol ?? symbols[0]?.symbol ?? "");
  const [tf, setTf] = useState("5m");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [wkind, setWkind] = useState<"SAME_CLOCK_HOUR" | "MINUTES">("SAME_CLOCK_HOUR");
  const [mins, setMins] = useState(60);
  const [lower, setLower] = useState(true);
  const [minConf, setMinConf] = useState(55);
  const [series, setSeries] = useState<{ name: string; label: string | null }[]>([]);
  const [copied, setCopied] = useState(false);
  const ledger = useQuery({ queryKey: ["pattern-ledger"], queryFn: () => list(), refetchInterval: 60_000 });
  const m = useMutation({
    mutationFn: (freeze: boolean) => run({ data: { strategyId: sid, symbol, timeframe: tf, source, target, window: wkind === "SAME_CLOCK_HOUR" ? { kind: "SAME_CLOCK_HOUR" } : { kind: "MINUTES", minutes: mins }, useLowerTf: lower, minConfidence: minConf / 100, freeze, alerts: true } }),
    onSuccess: (r) => { if ("series" in r && r.series) setSeries(r.series.map((s) => ({ name: s.name, label: s.label }))); void qc.invalidateQueries({ queryKey: ["pattern-ledger"] }); },
  });
  const r = m.data;
  const ok = r && r.status === "OK" ? r : null;
  const lab = (n: string) => series.find((x) => x.name === n)?.label ?? n;

  return (
    <Panel title="Indicator Historical Pattern Analyzer" subtitle="Analyzes historical cases from the indicator's own bar-by-bar values (without converting to a strategy) and links them to the next-candle forecast.">
      <div className="flex flex-wrap items-end gap-2">
        <select className={sel} value={sid} onChange={(e) => { setSid(e.target.value); setSeries([]); }} aria-label="Indicator">
          <option value="">Select an indicator…</option>
          {indicators.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className={sel} value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
          {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)}
        </select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)} aria-label="Timeframe">
          {ANALYSIS_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className={btn} disabled={!sid || m.isPending} onClick={() => { setSource(""); setTarget(""); m.mutate(false); }}>Load indicator levels</button>
      </div>
      {series.length > 0 && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">Source level
            <select className={`${sel} block`} value={source} onChange={(e) => setSource(e.target.value)}><option value="">—</option>{series.map((s) => <option key={s.name} value={s.name}>{s.label ? `${s.label} (${s.name})` : s.name}</option>)}</select>
          </label>
          <label className="text-xs text-muted-foreground">Target level
            <select className={`${sel} block`} value={target} onChange={(e) => setTarget(e.target.value)}><option value="">—</option>{series.map((s) => <option key={s.name} value={s.name}>{s.label ? `${s.label} (${s.name})` : s.name}</option>)}</select>
          </label>
          <label className="text-xs text-muted-foreground">Time window
            <select className={`${sel} block`} value={wkind} onChange={(e) => setWkind(e.target.value as never)}>
              <option value="SAME_CLOCK_HOUR">Same clock hour (UTC)</option><option value="MINUTES">Max minutes</option>
            </select>
          </label>
          {wkind === "MINUTES" && <input type="number" className={sel} value={mins} min={1} max={1440} onChange={(e) => setMins(+e.target.value)} aria-label="Minutes" />}
          <label className="text-xs text-muted-foreground">Min confidence %
            <input type="number" className={`${sel} block w-24`} value={minConf} min={34} max={95} onChange={(e) => setMinConf(+e.target.value)} />
          </label>
          <label className="flex items-center gap-1 text-xs text-ink"><input type="checkbox" checked={lower} onChange={(e) => setLower(e.target.checked)} />Resolve same-bar touches with 1m data</label>
          <button className={btn} disabled={!source || !target || m.isPending} onClick={() => m.mutate(false)}>Analyze Historical Pattern</button>
          <button className={btn} disabled={!source || !target || m.isPending} onClick={() => m.mutate(true)}>Analyze Historical Pattern → Forecast Next Candle</button>
        </div>
      )}
      {m.isPending && <p className="mt-3 text-xs text-muted-foreground">Running indicator bar by bar on closed candles…</p>}
      {m.error && <p className="mt-3 text-xs text-bear">{(m.error as Error).message}</p>}
      {r && r.status === "BLOCKED" && <p className="mt-3 text-xs text-bear" dir="auto">BLOCKED: {r.reason} {"diagnostics" in r && r.diagnostics ? r.diagnostics.join("; ") : ""}</p>}
      {r && "data" in r && r.data && (
        <p className="mt-3 text-[11px] text-muted-foreground">Provider {r.data.provider ?? "?"} · {r.data.closedBars} closed bars · {r.data.from?.slice(0, 16)} → {r.data.to?.slice(0, 16)} UTC · {r.data.mode === "STORED_SAME_PROVIDER" ? "stored bars (same provider)" : "live"} · coverage {r.data.coverage ?? "?"}{ok?.m1Info ? ` · ${ok.m1Info}` : ""}</p>
      )}

      {ok && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label={`${lab(ok.config.source)} touches`} value={String(ok.summary.touches)} />
            <Stat label={`Reached ${lab(ok.config.target)}`} value={String(ok.summary.success)} />
            <Stat label="Failed / expired" value={`${ok.summary.failed} / ${ok.summary.expired}`} />
            <Stat label="Ambiguous (excluded)" value={String(ok.summary.ambiguous)} />
            <Stat label="Historical success rate" value={p(ok.summary.successRate)} />
            <Stat label="95% range" value={ok.summary.successCI ? `${p(ok.summary.successCI.lo)} – ${p(ok.summary.successCI.hi)}` : "—"} />
            <Stat label="Avg time to target" value={ok.summary.avgMinutes === null ? "—" : `${ok.summary.avgMinutes.toFixed(1)} min`} />
            <Stat label="Resolved with 1m" value={String(ok.summary.resolvedBy1m)} />
          </div>

          <div className="rounded-xl border border-glass-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">Next candle after a {lab(ok.config.source)} touch</span>
              <Chip tone={ok.nextCandle.signal === "UP" ? "bull" : ok.nextCandle.signal === "DOWN" ? "bear" : "warn"}>{ok.nextCandle.signal === "NO_SIGNAL" ? "NO SIGNAL" : ok.nextCandle.signal}</Chip>
              <span className="text-xs text-muted-foreground">confidence {p(ok.nextCandle.confidence)} · {ok.nextCandle.samples} comparable samples</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
              <div>UP <b className="text-bull">{p(ok.nextCandle.probabilities.up)}</b></div>
              <div>DOWN <b className="text-bear">{p(ok.nextCandle.probabilities.down)}</b></div>
              <div>NEUTRAL <b>{p(ok.nextCandle.probabilities.neutral)}</b></div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Separate quantity — historical probability of eventually reaching {lab(ok.config.target)}: <b>{p(ok.summary.successRate)}</b>. {ok.separateNote}</p>
            {ok.nextCandle.reason && <p className="mt-1 text-xs text-bear" dir="auto">Why NO SIGNAL: {ok.nextCandle.reason}</p>}
            <details className="mt-2 text-xs"><summary className="cursor-pointer text-ink">Why this prediction?</summary>
              <ul className="mt-1 space-y-0.5">{ok.nextCandle.checks.map((c) => <li key={c.name}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>
              <p className="mt-1 text-muted-foreground">Counts after touches: UP {ok.nextCandle.counts.UP} · DOWN {ok.nextCandle.counts.DOWN} · NEUTRAL {ok.nextCandle.counts.NEUTRAL} (NEUTRAL = |move| ≤ 0.1×ATR14). Hold-out (last 30%): {ok.nextCandle.holdout.samples} samples, accuracy {p(ok.nextCandle.holdout.accuracy)}.</p>
            </details>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Current state: bar {ok.current.barIso.slice(0, 16)} · close {ok.current.close} · ATR14 {ok.current.atr14?.toFixed(5) ?? "—"} · {ok.current.touchingSource ? `touching ${lab(ok.config.source)} now` : `not touching ${lab(ok.config.source)}`}
              <div className="mt-1 flex flex-wrap gap-2">{Object.entries(ok.current.levels).slice(0, 16).map(([k, v]) => <span key={k}>{k}: {typeof v === "number" ? v.toFixed(5) : "na"}</span>)}</div>
            </div>
            {ok.frozen.status !== "NOT_REQUESTED" && <p className="mt-2 text-xs" dir="auto">Frozen forecast: <b>{ok.frozen.status}</b> {ok.frozen.note ?? ""}</p>}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <table className="w-full text-xs"><thead><tr className="text-muted-foreground"><th className="text-left">Hour UTC</th><th>Touches</th><th>Success</th><th>Rate</th></tr></thead>
              <tbody>{ok.summary.byHour.map((g) => <tr key={g.key}><td>{g.key}:00</td><td className="text-center">{g.touches}</td><td className="text-center">{g.success}</td><td className="text-center">{p(g.rate)}</td></tr>)}</tbody></table>
            <table className="w-full text-xs"><thead><tr className="text-muted-foreground"><th className="text-left">Weekday</th><th>Touches</th><th>Success</th><th>Rate</th></tr></thead>
              <tbody>{ok.summary.byWeekday.map((g) => <tr key={g.key}><td>{DAYS[g.key]}</td><td className="text-center">{g.touches}</td><td className="text-center">{g.success}</td><td className="text-center">{p(g.rate)}</td></tr>)}</tbody></table>
          </div>

          <details><summary className="cursor-pointer text-xs text-ink">All occurrences ({ok.eventsTotal})</summary>
            <div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-[11px]"><thead><tr className="text-muted-foreground"><th className="text-left">Touch (UTC)</th><th>Level</th><th>Outcome</th><th>Reached (UTC)</th><th>Min</th><th>Resolved</th><th>Next bar</th></tr></thead>
              <tbody>{[...ok.events].reverse().map((e) => <tr key={e.touchTs}><td>{e.touchIso.slice(0, 16)}</td><td>{e.sourceLevel.toFixed(5)}</td><td>{e.outcome}</td><td>{e.reachIso?.slice(0, 16) ?? "—"}</td><td>{e.minutesToTarget ?? "—"}</td><td>{e.resolvedBy ?? e.note}</td><td>{e.nextBar?.direction ?? "—"}</td></tr>)}</tbody></table></div>
          </details>

          <div className="rounded-xl border border-glass-border p-3">
            <div className="flex items-center gap-2"><span className="text-sm font-semibold text-ink">Pine Script export</span><Chip tone={ok.pine.status === "VERIFIED" ? "bull" : "warn"}>{ok.pine.status}</Chip></div>
            {!ok.pine.code && <p className="mt-1 text-xs text-muted-foreground">Export is available only when the pattern forecast passes its checks (not NO SIGNAL).</p>}
            {ok.pine.checks.length > 0 && <ul className="mt-1 text-xs">{ok.pine.checks.map((c) => <li key={c.name}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>}
            {ok.pine.code && (
              <>
                <div className="mt-2 flex gap-2">
                  <button className={btn} onClick={() => { void navigator.clipboard.writeText(ok.pine.code!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied ✓" : "Copy"}</button>
                  <button className={btn} onClick={() => { const b = new Blob([ok.pine.code!], { type: "text/plain" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${ok.indicator.name}-pattern-${symbol}-${tf}.pine`; a.click(); }}>Download .pine</button>
                </div>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-2 text-[11px]" dir="ltr">{ok.pine.code.split("// ===== Historical Pattern")[1] ? "// ===== Historical Pattern" + ok.pine.code.split("// ===== Historical Pattern")[1] : ok.pine.code}</pre>
              </>
            )}
          </div>
        </div>
      )}

      <details className="mt-4"><summary className="cursor-pointer text-xs text-ink">Frozen pattern forecasts & actual results ({ledger.data?.length ?? 0})</summary>
        <table className="mt-2 w-full text-[11px]"><thead><tr className="text-muted-foreground"><th className="text-left">Target (UTC)</th><th>Symbol</th><th>Signal</th><th>UP/DOWN/NEU</th><th>Samples</th><th>Actual</th><th>Correct</th></tr></thead>
          <tbody>{(ledger.data ?? []).map((x) => <tr key={x.id}><td>{x.target_ts?.slice(0, 16)}</td><td>{x.symbol} {x.timeframe}</td><td>{x.signal}</td><td>{p(x.bullish_probability)} / {p(x.bearish_probability)} / {p(x.neutral_probability)}</td><td>{x.sample_size}</td><td>{x.actual_result ?? x.scoring_status}</td><td>{x.correct === null ? "—" : x.correct ? "✓" : "✗"}</td></tr>)}</tbody></table>
      </details>
    </Panel>
  );
}
