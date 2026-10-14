import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { analyzeIndicator, commitConversion, previewConversion } from "@/lib/use/convert.functions";
import { runProBacktest } from "@/lib/use/strategy.functions";
import { defaultLevel, type Candidate, type ConvertConfig, type Level, type LevelMode, type Rule, type Side } from "@/lib/use/strategy/convert";
import { StrategyCode } from "./StrategyCode";

const inp = "rounded-lg border border-glass-border bg-background/70 px-2 py-1 font-mono text-xs text-ink";
const btn = "rounded-lg border border-glass-border px-3 py-1.5 text-xs text-ink hover:bg-muted disabled:opacity-50";
const primary = "rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50";

const baseCfg = (): ConvertConfig => ({
  buy: [], sell: [], exit: [], tp: defaultLevel(), sl: defaultLevel(), direction: "BOTH", allowReentry: true, onePosition: false, pyramiding: 0,
  trailing: { enabled: false, points: 200, offset: 50 }, breakEven: { enabled: false, triggerTicks: 100 }, partialExit: { enabled: false, percent: 50 },
  orderType: "MARKET", orderOffsetTicks: 0, fillTiming: "NEXT_BAR_OPEN",
});
const fromCandidate = (c: Candidate): Rule => ({ expression: c.expression, line: c.line, original: c.original, confidence: c.confidence, source: "DETECTED" });
const MODES: { id: LevelMode; label: string }[] = [
  { id: "NONE", label: "None" }, { id: "TICKS", label: "Ticks" }, { id: "POINTS", label: "Points" }, { id: "PERCENT", label: "Percent" },
  { id: "ATR", label: "ATR Multiple" }, { id: "PRICE", label: "Fixed Price Level" }, { id: "INDICATOR", label: "Indicator Level" },
];

function LevelEditor({ label, v, set, levels }: { label: string; v: Level; set: (l: Level) => void; levels: string[] }) {
  return (
    <div className="space-y-1 rounded-lg border border-glass-border p-2" dir="ltr">
      <div className="text-[11px] font-semibold text-ink">{label}</div>
      <select className={inp} value={v.mode} onChange={(e) => set({ ...v, mode: e.target.value as LevelMode })}>
        {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {["TICKS", "POINTS", "PERCENT", "ATR", "PRICE"].includes(v.mode) && (
        <label className="block text-[11px] text-ink-soft">{v.mode === "ATR" ? "× ATR" : v.mode === "PRICE" ? "Long price" : "Value"}
          <input type="number" className={`${inp} ml-1 w-24`} value={v.value} onChange={(e) => set({ ...v, value: Number(e.target.value) })} />
        </label>
      )}
      {v.mode === "ATR" && <label className="block text-[11px] text-ink-soft">ATR length <input type="number" className={`${inp} ml-1 w-16`} value={v.atrLength} onChange={(e) => set({ ...v, atrLength: Number(e.target.value) })} /></label>}
      {v.mode === "PRICE" && <label className="block text-[11px] text-ink-soft">Short price <input type="number" className={`${inp} ml-1 w-24`} value={v.shortRef} onChange={(e) => set({ ...v, shortRef: e.target.value })} /></label>}
      {v.mode === "INDICATOR" && (
        <div className="flex flex-wrap gap-1 text-[11px] text-ink-soft">
          {(["longRef", "shortRef"] as const).map((k) => (
            <label key={k}>{k === "longRef" ? "Long" : "Short"}
              <input list="use-levels" className={`${inp} ml-1 w-24`} value={v[k]} onChange={(e) => set({ ...v, [k]: e.target.value })} />
            </label>
          ))}
          <datalist id="use-levels">{levels.map((l) => <option key={l} value={l} />)}</datalist>
        </div>
      )}
    </div>
  );
}

function RuleList({ side, rules, set }: { side: Side; rules: Rule[]; set: (r: Rule[]) => void }) {
  const [manual, setManual] = useState("");
  return (
    <div className="rounded-lg border border-glass-border p-2">
      <div className="mb-1 text-[11px] font-semibold text-ink">Detected {side} Rules</div>
      {rules.length === 0 && <p className="text-[11px] text-ink-soft">—</p>}
      {rules.map((r, i) => (
        <div key={i} className="mb-1 space-y-0.5 border-b border-glass-border pb-1 text-[11px]" dir="ltr">
          <div className="text-ink-soft">{r.source === "DETECTED" ? `Line ${r.line} · confidence ${Math.round((r.confidence ?? 0) * 100)}%` : "Manual"} · <span className="font-mono">{r.original}</span></div>
          <div className="flex gap-1">
            <input className={`${inp} flex-1`} value={r.expression} onChange={(e) => set(rules.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)))} />
            <button type="button" className={btn} onClick={() => set(rules.filter((_, j) => j !== i))}>Remove</button>
          </div>
        </div>
      ))}
      <div className="mt-1 flex gap-1" dir="ltr">
        <input className={`${inp} flex-1`} placeholder="manual condition, e.g. ta.crossover(a, b)" value={manual} onChange={(e) => setManual(e.target.value)} />
        <button type="button" className={btn} disabled={!manual.trim()} onClick={() => { set([...rules, { expression: manual.trim(), line: null, original: manual.trim(), confidence: null, source: "MANUAL" }]); setManual(""); }}>Add</button>
      </div>
    </div>
  );
}

export function ConvertToStrategy({ strategyId }: { strategyId: string }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<ConvertConfig | null>(null);
  const [view, setView] = useState<"code" | "compare" | null>(null);
  const [bt, setBt] = useState({ symbol: "BTCUSDT", timeframe: "1h", days: 30 });
  const qc = useQueryClient();
  const analyzeFn = useServerFn(analyzeIndicator);
  const previewFn = useServerFn(previewConversion);
  const commitFn = useServerFn(commitConversion);
  const runFn = useServerFn(runProBacktest);
  const an = useQuery({ queryKey: ["use", "convert-analyze", strategyId], queryFn: () => analyzeFn({ data: { id: strategyId } }), enabled: open });
  const preview = useMutation({ mutationFn: (c: ConvertConfig) => previewFn({ data: { id: strategyId, config: c } }) });
  const commit = useMutation({ mutationFn: (c: ConvertConfig) => commitFn({ data: { id: strategyId, config: c } }), onSuccess: (r) => { if (r.id) setView("code"); void qc.invalidateQueries({ queryKey: ["use", "bootstrap"] }); } });
  const run = useMutation({
    mutationFn: (id: string) => { const end = new Date(); end.setUTCHours(0, 0, 0, 0); const start = new Date(end.getTime() - bt.days * 86_400_000); return runFn({ data: { strategyId: id, symbol: bt.symbol, timeframe: bt.timeframe, start: start.toISOString(), end: end.toISOString() } }); },
  });

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded-full border border-glass-border px-3 py-1 text-[11px] text-ink hover:bg-muted">Convert to strategy</button>;
  if (an.isLoading) return <p className="text-[11px] text-ink-soft">Analyzing indicator…</p>;
  if (an.isError) return <p className="text-[11px] text-bear">{(an.error as Error).message}</p>;
  const a = an.data!;
  const init = () => {
    const c = baseCfg();
    for (const k of a.candidates) { if (k.suggested === "BUY") c.buy.push(fromCandidate(k)); else if (k.suggested === "SELL") c.sell.push(fromCandidate(k)); else if (k.suggested === "EXIT") c.exit.push(fromCandidate(k)); }
    return c;
  };
  const c = cfg ?? init();
  const up = (p: Partial<ConvertConfig>) => { setCfg({ ...c, ...p }); preview.reset(); };
  const unassigned = a.candidates.filter((k) => ![...c.buy, ...c.sell, ...c.exit].some((r) => r.expression === k.expression));
  const levels = [...a.levels.map((l) => l.name), ...a.atrVars.map((x) => x.name)];
  const done = commit.data?.id ? commit.data : null;

  return (
    <div className="mt-2 space-y-3 rounded-xl border border-glass-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-ink">Convert Indicator → Strategy (separate copy — original stays INDICATOR_ONLY)</div>
        <button type="button" className={btn} onClick={() => setOpen(false)}>Close</button>
      </div>

      {a.status === "NO_CLEAR_TRADING_RULES_DETECTED" ? (
        <div className="rounded-lg border border-bear/40 p-2 text-[11px] text-ink" dir="ltr">
          <b>NO_CLEAR_TRADING_RULES_DETECTED</b> — no entry/exit logic could be identified. Define the conditions manually below; the system will not invent rules.
        </div>
      ) : (
        <p className="text-[11px] text-ink-soft">Detected rules are suggestions only — review and edit them before confirming.</p>
      )}

      <div className="grid gap-2 md:grid-cols-3">
        <RuleList side="BUY" rules={c.buy} set={(r) => up({ buy: r })} />
        <RuleList side="SELL" rules={c.sell} set={(r) => up({ sell: r })} />
        <RuleList side="EXIT" rules={c.exit} set={(r) => up({ exit: r })} />
      </div>

      {unassigned.length > 0 && (
        <div className="rounded-lg border border-glass-border p-2 text-[11px]" dir="ltr">
          <div className="mb-1 font-semibold text-ink">Other candidates (direction unclear or removed)</div>
          {unassigned.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-1 text-ink-soft">
              <span className="font-mono text-ink">L{k.line}: {k.original}</span> <span>({k.kind}{k.reason ? ` · ${k.reason}` : ""})</span>
              {(["BUY", "SELL", "EXIT"] as const).map((s) => <button key={s} type="button" className={btn} onClick={() => up({ [s.toLowerCase()]: [...c[s.toLowerCase() as "buy"], fromCandidate(k)] } as Partial<ConvertConfig>)}>{s}</button>)}
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] font-semibold text-ink">Risk Rules</div>
        <div className="grid gap-2 md:grid-cols-2">
          <LevelEditor label="Take Profit" v={c.tp} set={(l) => up({ tp: l })} levels={levels} />
          <LevelEditor label="Stop Loss" v={c.sl} set={(l) => up({ sl: l })} levels={levels} />
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2" dir="ltr">
        <div className="space-y-1 rounded-lg border border-glass-border p-2 text-[11px] text-ink">
          <div className="font-semibold">Position Management</div>
          <select className={inp} value={c.direction} onChange={(e) => up({ direction: e.target.value as ConvertConfig["direction"] })}>
            <option value="BOTH">Long + Short</option><option value="LONG_ONLY">Long Only</option><option value="SHORT_ONLY">Short Only</option>
          </select>
          <label className="block"><input type="checkbox" checked={c.allowReentry} onChange={(e) => up({ allowReentry: e.target.checked })} /> Allow Re-entry (while condition stays true)</label>
          <label className="block"><input type="checkbox" checked={c.onePosition} onChange={(e) => up({ onePosition: e.target.checked })} /> One Position At A Time</label>
          <label className="block">Pyramiding <input type="number" min={0} className={`${inp} w-14`} value={c.pyramiding} onChange={(e) => up({ pyramiding: Number(e.target.value) })} /></label>
          <label className="block"><input type="checkbox" checked={c.trailing.enabled} onChange={(e) => up({ trailing: { ...c.trailing, enabled: e.target.checked } })} /> Trailing Stop — points <input type="number" className={`${inp} w-16`} value={c.trailing.points} onChange={(e) => up({ trailing: { ...c.trailing, points: Number(e.target.value) } })} /> offset <input type="number" className={`${inp} w-16`} value={c.trailing.offset} onChange={(e) => up({ trailing: { ...c.trailing, offset: Number(e.target.value) } })} /> (ticks)</label>
          <label className="block"><input type="checkbox" checked={c.breakEven.enabled} onChange={(e) => up({ breakEven: { ...c.breakEven, enabled: e.target.checked } })} /> Break Even after <input type="number" className={`${inp} w-16`} value={c.breakEven.triggerTicks} onChange={(e) => up({ breakEven: { ...c.breakEven, triggerTicks: Number(e.target.value) } })} /> ticks</label>
          <label className="block"><input type="checkbox" checked={c.partialExit.enabled} onChange={(e) => up({ partialExit: { ...c.partialExit, enabled: e.target.checked } })} /> Partial Exit <input type="number" className={`${inp} w-14`} value={c.partialExit.percent} onChange={(e) => up({ partialExit: { ...c.partialExit, percent: Number(e.target.value) } })} /> %</label>
        </div>
        <div className="space-y-1 rounded-lg border border-glass-border p-2 text-[11px] text-ink">
          <div className="font-semibold">Execution Settings</div>
          <select className={inp} value={c.orderType} onChange={(e) => up({ orderType: e.target.value as ConvertConfig["orderType"] })}>
            <option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option>
          </select>
          {c.orderType !== "MARKET" && <label className="block">Offset from close <input type="number" className={`${inp} w-16`} value={c.orderOffsetTicks} onChange={(e) => up({ orderOffsetTicks: Number(e.target.value) })} /> ticks</label>}
          <select className={inp} value={c.fillTiming} onChange={(e) => up({ fillTiming: e.target.value as ConvertConfig["fillTiming"] })}>
            <option value="NEXT_BAR_OPEN">Next Bar Open</option><option value="BAR_CLOSE">Bar Close</option>
          </select>
          <p className="text-ink-soft">Saved into the strategy code, the Strategy IR and every backtest run.</p>
        </div>
      </div>

      {a.sourceDiagnostics.length > 0 && (
        <div className="rounded-lg border border-glass-border p-2 text-[11px]" dir="ltr">
          <div className="font-semibold text-ink">Unsupported Semantics (source)</div>
          {a.sourceDiagnostics.map((d, i) => <div key={i} className="text-bear">{d.code}: {d.construct} @ {d.line}:{d.col}</div>)}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={preview.isPending} onClick={() => preview.mutate(c)}>{preview.isPending ? "Checking…" : "Preview & Check"}</button>
        <button type="button" className={primary} disabled={commit.isPending || !!done} onClick={() => commit.mutate(c)}>{commit.isPending ? "Generating…" : "Confirm — Generate Strategy"}</button>
      </div>
      {preview.isError && <p className="text-[11px] text-bear">{(preview.error as Error).message}</p>}

      {preview.data && (
        <div className="space-y-2 rounded-lg border border-glass-border p-2 text-[11px]" dir="ltr">
          <div className={`font-semibold ${preview.data.status === "READY" ? "text-ink" : "text-bear"}`}>{preview.data.status}</div>
          {preview.data.checks.map((k) => <div key={k.name}><span className={k.pass ? "text-bull" : "text-bear"}>{k.pass ? "PASS" : "FAIL"}</span> · {k.name} — <span className="text-ink-soft">{k.detail}</span></div>)}
          <div className="font-semibold text-ink">Indicator → Strategy Diff</div>
          {preview.data.sections.map((s) => (
            <div key={s.label}>
              <div className="text-ink">{s.label}</div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-1.5 font-mono text-[11px] text-ink">{s.lines.length ? s.lines.join("\n") : "(none)"}</pre>
            </div>
          ))}
        </div>
      )}

      {commit.data && !commit.data.id && (
        <div className="rounded-lg border border-bear/50 p-2 text-[11px] text-bear" dir="ltr">
          <b>CONVERSION_BLOCKED</b> — no strategy was created; the original indicator is unchanged.
          {commit.data.checks.filter((k) => !k.pass).map((k) => <div key={k.name}>• {k.name}: {k.detail}</div>)}
        </div>
      )}
      {commit.isError && <p className="text-[11px] text-bear">{(commit.error as Error).message}</p>}

      {done && done.id && (
        <div className="space-y-2 rounded-lg border border-glass-border p-2 text-[11px] text-ink" dir="ltr">
          <div className="font-semibold text-bull">CONVERSION_COMPLETE — new separate strategy() saved (linked to source indicator)</div>
          <div>Saved ✓ · Status <b>{done.lifecycle}</b> · Original indicator unchanged: <b>{done.originalUnchanged ? "YES" : "NO"}</b> · New strategy id <span className="font-mono">{done.id}</span></div>
          <div className="break-all text-ink-soft">parentIndicatorId {done.parentIndicatorId} · sourceIndicatorHash {done.sourceIndicatorHash} · generatedStrategyHash {done.generatedHash}</div>
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inp} w-24`} value={bt.symbol} onChange={(e) => setBt({ ...bt, symbol: e.target.value })} />
            <input className={`${inp} w-14`} value={bt.timeframe} onChange={(e) => setBt({ ...bt, timeframe: e.target.value })} />
            <input type="number" className={`${inp} w-14`} value={bt.days} onChange={(e) => setBt({ ...bt, days: Number(e.target.value) })} /> days
            <button type="button" className={primary} disabled={run.isPending} onClick={() => run.mutate(done.id!)}>{run.isPending ? "Running…" : "Run Backtest"}</button>
            <button type="button" className={btn} onClick={() => setView(view === "code" ? null : "code")}>View / Copy / Edit Code</button>
            <button type="button" className={btn} onClick={() => setView(view === "compare" ? null : "compare")}>Compare with Original Indicator</button>
          </div>
          {run.data && (run.data.status === "COMPLETED" && "metrics" in run.data
            ? <div>Backtest ✓ trades {String((run.data.metrics as Record<string, unknown>)["trades"])} · win rate {Number((run.data.metrics as Record<string, unknown>)["winRate"] ?? 0).toFixed(1)}% · coverage {run.data.coverage?.status}</div>
            : <div className="text-bear">{run.data.status}: {"error" in run.data ? run.data.error : ""}</div>)}
          {run.isError && <div className="text-bear">{(run.error as Error).message}</div>}
          {view === "code" && <StrategyCode id={done.id} />}
          {view === "compare" && (
            <div className="grid gap-2 md:grid-cols-2">
              <div><div className="font-semibold">Original indicator</div><pre className="max-h-96 overflow-auto rounded bg-muted/50 p-1.5 font-mono">{a.code}</pre></div>
              <div><div className="font-semibold">Generated strategy</div><pre className="max-h-96 overflow-auto rounded bg-muted/50 p-1.5 font-mono">{done.code}</pre></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
