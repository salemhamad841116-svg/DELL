// Two separate TradingView modules. They share nothing but this file.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";

import { Chip, Panel } from "@/components/use/primitives";
import { listProBacktests } from "@/lib/use/strategy.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";
import { generatePineCode, runTvParity } from "@/lib/use/tvpine.functions";

type Opt = { symbol: string; display_name: string };
type Strat = { id: string; name: string; validation?: { scriptType?: string } | null };
const sel = "rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink";
const btn = "rounded-xl bg-ink px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50";
const pctf = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Module 1 — Indicator / Next Candle Forecast → TradingView Pine code. Never asks for BUY/SELL/TP/SL. */
export function PineCodeGenerator({ symbols, strategies }: { symbols: Opt[]; strategies: Strat[] }) {
  const gen = useServerFn(generatePineCode);
  const indicators = strategies.filter((s) => s.validation?.scriptType === "INDICATOR");
  const [sid, setSid] = useState<string>("");
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? "");
  const [tf, setTf] = useState("5m");
  const [minConf, setMinConf] = useState(55);
  const [alerts, setAlerts] = useState(true);
  const [copied, setCopied] = useState(false);
  const m = useMutation({ mutationFn: () => gen({ data: { strategyId: sid || null, symbol: symbol || symbols[0]!.symbol, timeframe: tf, minConfidence: minConf / 100, alerts } }) });
  const r = m.data;
  return (
    <Panel title="TradingView Pine Code Generator" subtitle="Indicator or Next Candle Forecast → Pine code ready to paste into TradingView. Does not require BUY/SELL/TP/SL or conversion to a strategy.">
      <div className="flex flex-wrap items-end gap-2">
        <select className={sel} value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Indicator">
          <option value="">No indicator (market features only)</option>
          {indicators.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className={sel} value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
          {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)}
        </select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)} aria-label="Timeframe">
          {ANALYSIS_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="text-xs text-ink-soft">Min confidence % <input type="number" min={0} max={100} value={minConf} onChange={(e) => setMinConf(+e.target.value)} className={`${sel} w-20`} /></label>
        <label className="flex items-center gap-1 text-xs text-ink"><input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} /> Alerts</label>
        <button type="button" className={btn} disabled={m.isPending || !symbols.length} onClick={() => m.mutate()}>{m.isPending ? "Generating…" : "Generate TradingView Pine Code"}</button>
      </div>
      {m.isError && <p className="mt-2 text-xs text-bear">{(m.error as Error).message}</p>}
      {r && (
        <div dir="ltr" className="mt-3 space-y-2 text-left">
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={r.status === "VERIFIED" ? "bull" : "bear"}>{r.status}</Chip>
            {"pineVersion" in r && <><Chip>Pine v{r.pineVersion}</Chip><Chip>Script: {r.scriptType}</Chip><Chip>{r.modelVersion}</Chip>
              {r.source ? <Chip>Source: {r.source.name} v{r.source.version}</Chip> : <Chip>Source: market features only</Chip>}
              <Chip>OOS {pctf(r.oos.accuracy)} vs baseline {pctf(r.oos.baseline)} (n={r.oos.samples})</Chip>
              {"lock" in r && <Chip>MODEL TRAINED FOR {r.lock}</Chip>}
              {"calibration" in r && <Chip>Calibration ECE {r.calibration.calibrated.ece?.toFixed(3) ?? "n/a"} (raw {r.calibration.raw.ece?.toFixed(3) ?? "n/a"}, limit {r.calibration.limit}) · {r.calibration.pass ? "PASS" : "FAIL — probabilities hidden, NO SIGNAL"}</Chip>}
              {"comparison" in r && r.comparison && <Chip>Before (raw features): OOS {pctf(r.comparison.before.oos.accuracy)} · After (relative): OOS {pctf(r.comparison.after.oos.accuracy)}</Chip>}
              {"excluded" in r && r.excluded.length > 0 && <Chip>Replaced/excluded: {r.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}</Chip>}
              <Chip>FUTURE FORECAST RELIABILITY = NOT VERIFIED</Chip></>}
          </div>
          {"generatedHash" in r && (
            <div className="num space-y-0.5 text-[11px] text-ink-soft">
              <div>Source Hash: {r.sourceHash ?? "— (no source indicator)"}</div>
              <div>Generated Hash: {r.generatedHash}</div>
              <div>Original indicator unchanged · generated copy adds +{r.addedLines} lines</div>
            </div>
          )}
          {r.reason && <p className="text-xs text-bear">{r.reason}</p>}
          {"data" in r && r.data && (() => { const d = r.data as Record<string, unknown>; return (
            <div className="text-[11px] text-muted-foreground grid grid-cols-2 gap-x-3">
              <span>Data: {String(d["mode"])} · {String(d["provider"])}</span>
              <span>Samples: {String(d["availableSamples"])} available / {String(d["requiredSamples"])} required</span>
              <span>Warm-up bars: {String(d["warmup"])} · closed bars: {String(d["closedBars"])}</span>
              <span>Range: {String(d["firstBar"] ?? "-").slice(0, 16)} → {String(d["lastBar"] ?? "-").slice(0, 16)}</span>
              <span className="col-span-2">Live fetch: {String(d["liveFetch"])}</span>
            </div>); })()}
          {"diagnostics" in r && Array.isArray(r.diagnostics) && <ul className="text-[11px] text-bear">{(r.diagnostics as string[]).map((d) => <li key={d}>{d}</li>)}</ul>}
          {r.checks.length > 0 && (
            <ul className="text-[11px]">{r.checks.map((c) => <li key={c.name} className={c.pass ? "text-bull" : "text-bear"}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>
          )}
          {r.code && "sourceCode" in r && <GeneratedViewer code={r.code} source={r.sourceCode} name={r.source?.name ?? "market-features"} />}
        </div>
      )}
    </Panel>
  );
}

const KW = /^(if|else|for|while|var|varip|and|or|not|true|false|na|import|export|method|switch|to|by)$/;
function hlLine(line: string) {
  const parts: ReactNode[] = [];
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?(?:e-?\d+)?\b)|([A-Za-z_][A-Za-z0-9_.]*)(\s*\()?/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    if (m[1]) parts.push(<span key={k++} className="text-ink-soft italic">{m[1]}</span>);
    else if (m[2]) parts.push(<span key={k++} className="text-bull">{m[2]}</span>);
    else if (m[3]) parts.push(<span key={k++} className="text-warn">{m[3]}</span>);
    else if (m[4]) parts.push(<span key={k++} className={KW.test(m[4]) ? "font-semibold text-bear" : m[5] ? "text-primary" : ""}>{m[4]}</span>, ...(m[5] ? [m[5]] : []));
    last = re.lastIndex;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function GeneratedViewer({ code, source, name }: { code: string; source: string; name: string }) {
  const [tab, setTab] = useState<"code" | "diff">("code");
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const srcSet = new Set(source.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()));
  const genSet = new Set(lines.map((l) => l.trimEnd()));
  const removed = source ? source.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() && !genSet.has(l.trimEnd())) : [];
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = `${name.replace(/[^A-Za-z0-9_-]+/g, "_")}_next_candle.pine`; a.click(); URL.revokeObjectURL(url);
  };
  const tabBtn = (t: "code" | "diff", l: string) => <button type="button" onClick={() => setTab(t)} className={`rounded-lg px-3 py-1 text-xs ${tab === t ? "bg-ink text-primary-foreground" : "text-ink"}`}>{l}</button>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={async () => { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied ✓" : "Copy Generated Pine Code"}</button>
        <button type="button" className={btn} onClick={download}>Download .pine</button>
        {tabBtn("code", "Generated Code")}{tabBtn("diff", "View Diff")}
      </div>
      <div className="num max-h-[32rem] overflow-auto rounded-xl border border-glass-border bg-background/80 py-2 text-[11px] leading-5 text-ink">
        {tab === "diff" && removed.map((l, i) => <div key={`r${i}`} className="whitespace-pre bg-bear/10 px-3 text-bear">- {l}</div>)}
        {lines.map((l, i) => {
          const added = !srcSet.has(l.trimEnd());
          if (tab === "diff") return <div key={i} className={`whitespace-pre px-3 ${added ? "bg-bull/10 text-bull" : "text-ink-soft"}`}>{added ? "+ " : "  "}{l}</div>;
          return <div key={i} className={`whitespace-pre px-3 ${added && source ? "border-l-2 border-bull" : ""}`}><span className="mr-3 inline-block w-8 select-none text-right text-ink-soft">{i + 1}</span>{hlLine(l)}</div>;
        })}
      </div>
    </div>
  );
}

/** Module 2 — strategy() backtest run ↔ TradingView Strategy Tester export. Independent of module 1. */
export function TvStrategyParity() {
  const list = useServerFn(listProBacktests);
  const par = useServerFn(runTvParity);
  const runs = useQuery({ queryKey: ["use", "pro-backtests"], queryFn: () => list() });
  const done = (runs.data ?? []).filter((r) => r.status === "COMPLETED" || r.status === "DONE" || (r.trades_hash && r.status !== "BLOCKED_DATA"));
  const [runId, setRunId] = useState("");
  const [csv, setCsv] = useState("");
  const [timeTol, setTimeTol] = useState(0);
  const [priceTol, setPriceTol] = useState(0);
  const m = useMutation({ mutationFn: () => par({ data: { runId: runId || done[0]!.id, csv, timeToleranceMs: timeTol * 60_000, priceTolerance: priceTol, pnlTolerance: 0.01 } }) });
  const r = m.data;
  return (
    <Panel title="TradingView Strategy Tester / Parity" subtitle="A separate module for strategy() strategies only: compare the List of trades file exported from TradingView (UTC) with the Backtest in Market Compass.">
      <div className="flex flex-wrap items-end gap-2">
        <select className={sel} value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Backtest run">
          {done.map((x) => <option key={x.id} value={x.id}>{x.symbol} {x.timeframe} · {x.period_start.slice(0, 10)}→{x.period_end.slice(0, 10)} · {x.strategy_hash?.slice(0, 8)}</option>)}
        </select>
        <input type="file" accept=".csv,text/csv" className="text-xs text-ink" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
        <label className="text-xs text-ink-soft">Time tol (min) <input type="number" min={0} value={timeTol} onChange={(e) => setTimeTol(+e.target.value)} className={`${sel} w-16`} /></label>
        <label className="text-xs text-ink-soft">Price tol <input type="number" min={0} step="any" value={priceTol} onChange={(e) => setPriceTol(+e.target.value)} className={`${sel} w-20`} /></label>
        <button type="button" className={btn} disabled={m.isPending || !done.length || csv.length < 10} onClick={() => m.mutate()}>{m.isPending ? "Comparing…" : "Compare with TradingView"}</button>
      </div>
      {!done.length && <p className="mt-2 text-xs text-ink-soft">Run a Professional Backtest for a strategy() strategy first.</p>}
      {m.isError && <p className="mt-2 text-xs text-bear">{(m.error as Error).message}</p>}
      {r && (
        <div dir="ltr" className="mt-3 space-y-2 text-left text-xs text-ink">
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={r.status === "PARITY_PASS" ? "bull" : "bear"}>{r.status}</Chip>
            <Chip>TV {r.tvCount} · Engine {r.engineCount} · Matched {r.matched}</Chip>
            <Chip>Missing {r.missingTrades.length}</Chip><Chip>Extra {r.extraTrades.length}</Chip><Chip>Direction {r.directionMismatches.length}</Chip>
            <Chip>Price {r.priceMismatches}</Chip><Chip>Timestamp {r.timestampMismatches}</Chip><Chip>Qty {r.qtyMismatches}</Chip><Chip>P&L {r.pnlMismatches}</Chip>
          </div>
          <p className="text-ink-soft">Context: {r.context.symbol} {r.context.timeframe} UTC · {r.context.from.slice(0, 10)}→{r.context.to.slice(0, 10)} · capital {r.context.capital} · commission {r.context.commission} · slippage {r.context.slippage} · sizing {r.context.sizing} · pyramiding {String(r.execution.pyramiding)} · TV trades outside period {r.outOfRangeTvTrades}</p>
          {r.errors.length > 0 && <ul className="text-warn">{r.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="max-h-80 overflow-auto">
            <table className="num w-full text-[11px]">
              <thead><tr className="text-ink-soft"><th>TV#</th><th>Eng#</th><th>ΔEntry t (s)</th><th>ΔExit t (s)</th><th>ΔEntry px</th><th>ΔExit px</th><th>ΔQty</th><th>ΔP&L</th><th>TV exit</th><th>Engine exit</th></tr></thead>
              <tbody>{r.pairs.map((p) => (
                <tr key={p.tv}><td>{p.tv}</td><td>{p.engine}</td><td>{p.entryTimeDeltaMs / 1000}</td><td>{p.exitTimeDeltaMs / 1000}</td><td>{p.entryPriceDelta.toFixed(4)}</td><td>{p.exitPriceDelta.toFixed(4)}</td><td>{p.qtyDelta?.toFixed(4) ?? "—"}</td><td>{p.pnlDelta?.toFixed(2) ?? "—"}</td><td>{p.tvExitSignal}</td><td>{p.engineExitReason}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
