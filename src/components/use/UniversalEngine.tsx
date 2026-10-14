import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Chip, Panel } from "@/components/use/primitives";
import { runUniversalAnalysis } from "@/lib/use/universal.functions";
import { runSensitivitySweep } from "@/lib/use/sensitivity.functions";

type Sym = { symbol: string };
type Strat = { id: string; name: string };
const f = (v: unknown, d = 2) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "n/a");

export function UniversalEngine({ symbols, strategies, timeframes }: { symbols: Sym[]; strategies: Strat[]; timeframes: string[] }) {
  const [sid, setSid] = useState(""); const [sym, setSym] = useState("EUR/USD"); const [tf, setTf] = useState("5m");
  const run = useServerFn(runUniversalAnalysis);
  const m = useMutation({ mutationFn: async () => JSON.parse((await run({ data: { strategyId: sid, symbol: sym, timeframe: tf } })).json) });
  const r = m.data as unknown as { status: string; steps: { n: number; name: string; status: string; detail: string }[]; classification: unknown; static: { findings: { code: string; message: string; line: number }[]; contradictions: { message: string }[] }; quant: Record<string, Record<string, unknown>> | null; analysisId: string } | undefined;
  const sens = useServerFn(runSensitivitySweep);
  const sm = useMutation({ mutationFn: async () => (await sens({ data: { strategyId: sid, symbol: sym, timeframe: tf } })) as any });
  const sr = sm.data as any;
  const sel = "rounded border border-border bg-background px-2 py-1 text-sm";
  return (
    <Panel title="Universal Strategy Engine — محرك تحليل الاستراتيجيات">
      <p className="mb-2 text-xs text-muted-foreground">Static code checks + metrics from the latest saved backtest for this strategy/symbol/timeframe. Run a Professional Backtest first.</p>
      <div className="flex flex-wrap gap-2">
        <select className={sel} value={sid} onChange={(e) => setSid(e.target.value)}><option value="">— strategy —</option>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select className={sel} value={sym} onChange={(e) => setSym(e.target.value)}>{symbols.map((s) => <option key={s.symbol}>{s.symbol}</option>)}</select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)}>{timeframes.map((t) => <option key={t}>{t}</option>)}</select>
        <button className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" disabled={!sid || m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Analyzing…" : "Analyze strategy"}</button>
        <button className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50" disabled={!sid || sm.isPending} onClick={() => sm.mutate()}>{sm.isPending ? "Sweeping…" : "Parameter sensitivity"}</button>
      </div>
      {m.error && <p className="mt-2 text-sm text-destructive">{(m.error as Error).message}</p>}
      {sm.error && <p className="mt-2 text-sm text-destructive">{(sm.error as Error).message}</p>}
      {sr && (sr.status !== "OK" ? <p className="mt-2 text-sm text-destructive">{sr.status}: {sr.message}</p> : (
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex flex-wrap gap-2"><Chip tone={sr.overfitRisk === "LOW" ? "bull" : "bear"}>Overfit risk {sr.overfitRisk}</Chip><span className="text-muted-foreground">{sr.provider} · {sr.bars} bars · {sr.periodStart?.slice(0, 10)} → {sr.periodEnd?.slice(0, 10)} · {sr.fillPolicy}</span></div>
          {sr.sweeps.map((w: any) => (
            <div key={w.name} className="rounded border border-border p-2"><b>{w.name}</b> (default {w.default}) · stability {f(w.stability * 100, 0)}%
              <div className="mt-1 grid grid-cols-5 gap-1">{w.variants.map((v: any) => (
                <div key={v.value} className={`rounded p-1 ${v.netProfit > 0 ? "bg-primary/15" : "bg-destructive/15"} ${v.value === w.default ? "ring-1 ring-foreground" : ""}`}>
                  <div>{v.value}</div><div>Net {f(v.netProfit)}</div><div>PF {f(v.profitFactor)}</div><div>{v.trades} tr</div></div>))}</div></div>))}
          {!sr.sweeps.length && <p className="text-muted-foreground">No numeric inputs to sweep.</p>}
          {sr.walkForward?.status === "INSUFFICIENT_DATA" && <p className="text-muted-foreground">Walk-forward: not enough bars.</p>}
          {sr.walkForward?.status === "OK" && <div className="rounded border border-border p-2"><b>Walk-forward</b> efficiency {sr.walkForward.efficiency == null ? "n/a" : sr.walkForward.efficiency.toFixed(2)}{sr.walkForward.rounds.map((r: any) => <div key={r.fold}>Fold {r.fold}: {JSON.stringify(r.chosen)} · IS {r.isNet?.toFixed(2) ?? "n/a"} · OOS {r.oosNet?.toFixed(2) ?? "n/a"} ({r.oosTrades} trades) · default OOS {r.defaultOosNet?.toFixed(2) ?? "n/a"}</div>)}</div>}
        </div>))}
      {r && (
        <div className="mt-3 space-y-3 text-sm">
          <Chip tone={r.status === "FINAL_VERIFIED" ? "bull" : "bear"}>{r.status}</Chip>
          <table className="w-full text-xs"><tbody>{r.steps.map((s) => (
            <tr key={s.n} className="border-b border-border"><td className="py-1 pr-2">{s.n}. {s.name}</td><td className={s.status === "PASS" ? "text-primary" : s.status === "FAIL" ? "text-destructive" : "text-muted-foreground"}>{s.status}</td><td className="text-muted-foreground">{s.detail}</td></tr>
          ))}</tbody></table>
          {[...r.static.findings.filter((x) => x.code !== "UNUSED_VARIABLE"), ...r.static.contradictions].slice(0, 20).map((x, i) => <div key={i} className="text-xs text-destructive">{"line" in x ? `L${x.line}: ` : ""}{x.message}</div>)}
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(r.classification, null, 1)}</pre>
          {r.quant && (
            <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              {(["net", "gross"] as const).map((k) => (
                <div key={k} className="rounded border border-border p-2"><b>{k === "net" ? "Net (after costs)" : "Gross (before commission)"}</b>
                  <div>Trades {String(r.quant![k]!["trades"])}</div><div>Win rate {f(Number(r.quant![k]!["winRate"]) * 100, 1)}%</div>
                  <div>PF {f(r.quant![k]!["profitFactor"])}</div><div>Expectancy {f(r.quant![k]!["expectancy"])}</div><div>Max DD {f(r.quant![k]!["maxDrawdownPct"])}%</div></div>
              ))}
              <div className="rounded border border-border p-2"><b>Risk</b><div>VaR95 {f(r.quant["risk"]!["var95"], 3)}%</div><div>CVaR95 {f(r.quant["risk"]!["cvar95"], 3)}%</div><div>Skew {f(r.quant["risk"]!["skewness"])}</div><div>Kurtosis {f(r.quant["risk"]!["excessKurtosis"])}</div></div>
              <div className="rounded border border-border p-2"><b>Splits (PF)</b>{(["train", "validation", "oos"] as const).map((p) => <div key={p}>{p} {f((r.quant!["splits"] as Record<string, Record<string, unknown>>)[p]!["profitFactor"])}</div>)}<div>Overfit {String(r.quant["overfitRisk"])}</div></div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Analysis ID {r.analysisId}</p>
        </div>
      )}
    </Panel>
  );
}
