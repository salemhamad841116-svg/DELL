import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getReliabilityReport, promoteNcModel, retrainCandidate, rollbackNcModel } from "@/lib/use/forecast.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";
import type { ValidationReport } from "@/lib/use/forecast/reliability";
import { Chip, Panel } from "./primitives";

type Sym = { symbol: string; display_name: string };
type Strat = { id: string; name: string; validation?: unknown };
const pc = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const ci = (c: { lo: number; hi: number } | null | undefined) => (c ? `95% CI ${pc(c.lo)}–${pc(c.hi)}` : "no data");
const sel = "rounded-lg border border-glass-border bg-background/70 px-2 py-1.5 text-xs text-ink";
const btn = "rounded-lg border border-glass-border px-3 py-1.5 text-xs text-ink disabled:opacity-50";

export function ReliabilityDashboard({ symbols, strategies }: { symbols: Sym[]; strategies: Strat[] }) {
  const indicators = strategies.filter((s) => (s.validation as { scriptType?: string } | null)?.scriptType === "INDICATOR");
  const [symbol, setSymbol] = useState(symbols.find((s) => s.symbol === "EURUSD")?.symbol ?? symbols[0]?.symbol ?? "");
  const [tf, setTf] = useState("5m");
  const [sid, setSid] = useState(indicators[0]?.id ?? "");
  const qc = useQueryClient();
  const repFn = useServerFn(getReliabilityReport), trainFn = useServerFn(retrainCandidate), promFn = useServerFn(promoteNcModel), rbFn = useServerFn(rollbackNcModel);
  const setup = { symbol, timeframe: tf, strategyId: sid || null };
  const key = ["nc-rel", symbol, tf, sid];
  const q = useQuery({ queryKey: key, queryFn: () => repFn({ data: setup }), enabled: !!symbol, refetchInterval: 60_000 });
  const done = () => qc.invalidateQueries({ queryKey: key });
  const train = useMutation({ mutationFn: () => trainFn({ data: { ...setup, minConfidence: 0.55 } }), onSettled: done });
  const prom = useMutation({ mutationFn: (id: string) => promFn({ data: { id } }), onSettled: done });
  const rb = useMutation({ mutationFn: () => rbFn({ data: setup }), onSettled: done });
  const r = q.data; const rep = (r?.report ?? null) as ValidationReport | null; const fw = r?.forward;
  const ev = (n: number) => (n < 30 ? <Chip tone="warn">insufficient evidence (n={n})</Chip> : <span className="text-ink-soft">n={n}</span>);
  const rows: [string, string, React.ReactNode][] = r ? [
    ["Historical Accuracy (train, in-sample)", pc(rep?.historicalAccuracy), rep ? <span className="text-ink-soft">n={rep.split.train}</span> : "—"],
    ["Out-of-Sample Accuracy", pc(rep?.oosAccuracy), rep ? <span className="text-ink-soft">n={rep.split.test} · {ci(rep.oosCI)} · baselines maj {pc(rep.oosBaselines.majority)} / persist {pc(rep.oosBaselines.persistence)} / prior {pc(rep.oosBaselines.prior)}</span> : "—"],
    ["Walk-Forward (mean ± std)", rep ? `${pc(rep.wfMean)} ± ${(rep.wfStd * 100).toFixed(1)}pp` : "—", rep ? <span className="text-ink-soft">{rep.wfBeatsBaseline}/{rep.walkForward.length} folds beat baseline</span> : "—"],
    ["Live Forward Accuracy (directional)", pc(fw!.directional.accuracy), <>{ev(fw!.directional.n)} <span className="text-ink-soft">{ci(fw!.directional.ci)} · baseline {pc(fw!.baseline)}</span></>],
    ["Last 100 Directional Predictions", pc(fw!.last100.accuracy), <>{ev(fw!.last100.n)} <span className="text-ink-soft">{ci(fw!.last100.ci)}</span></>],
    ["Last 500 Directional Predictions", pc(fw!.last500.accuracy), <>{ev(fw!.last500.n)} <span className="text-ink-soft">{ci(fw!.last500.ci)}</span></>],
    ["UP Accuracy", pc(fw!.up.accuracy), ev(fw!.up.n)],
    ["DOWN Accuracy", pc(fw!.down.accuracy), ev(fw!.down.n)],
    ["Confidence Calibration", `hist ECE ${rep?.calibration.ece?.toFixed(3) ?? "—"} · live ECE ${fw!.calibration.ece?.toFixed(3) ?? "—"}`, <span className="text-ink-soft">Brier {rep?.calibration.brier?.toFixed(3) ?? "—"} / {fw!.calibration.brier?.toFixed(3) ?? "—"} · LogLoss {rep?.calibration.logLoss?.toFixed(3) ?? "—"} / {fw!.calibration.logLoss?.toFixed(3) ?? "—"}</span>],
    ["Forecast Coverage", pc(fw!.coverage), <span className="text-ink-soft">total {fw!.total} · evaluated {fw!.evaluated} · pending {fw!.pending}</span>],
    ["NO SIGNAL Count", String(fw!.noSignal), <span className="text-ink-soft">NEUTRAL {fw!.neutral} — both excluded from directional accuracy</span>],
    ["Model Health", r.active?.status ?? "NO VERIFIED MODEL", r.active?.health ? <span className="text-ink-soft">max feature PSI {Number(r.active.health.maxPsi ?? 0).toFixed(3)}{r.active.health.driftAlert ? " · DRIFT ALERT" : ""}</span> : "—"],
    ["Current Market Regime", r.currentRegime ?? "—", "—"],
  ] : [];
  return (
    <Panel title="Next Candle — Prediction Accuracy & Reliability" subtitle="From frozen records and chronological validation only. Historical results describe the past and do not guarantee future accuracy.">
      <div className="flex flex-wrap items-end gap-2">
        <select className={sel} value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Reliability indicator">
          <option value="">Market features only</option>
          {indicators.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className={sel} value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Reliability symbol">{symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)}</select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)} aria-label="Reliability timeframe">{ANALYSIS_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <button type="button" className={btn} disabled={train.isPending} onClick={() => train.mutate()}>{train.isPending ? "Validating…" : "Validate / retrain candidate"}</button>
        <button type="button" className={btn} disabled={rb.isPending} onClick={() => rb.mutate()}>Rollback to last verified</button>
      </div>
      {train.data && <p className="mt-2 text-xs text-ink-soft">{train.data.ok ? `Candidate ${train.data.id?.slice(0, 8)} → ${train.data.status} (validation ${train.data.pass ? "PASS" : "FAIL"})` : train.data.reason}</p>}
      {[train.error, prom.error, rb.error, q.error].filter(Boolean).map((e, i) => <p key={i} className="mt-2 text-xs text-bear">{(e as Error).message}</p>)}
      {r && (
        <div dir="ltr" className="mt-3 space-y-3 text-left">
          <div className="flex flex-wrap gap-1.5">
            <Chip tone={r.reliability === "VERIFIED" ? "bull" : "warn"}>FUTURE FORECAST RELIABILITY: {r.reliability}</Chip>
            {r.active?.status === "DEGRADED" && <Chip tone="bear">MODEL_PERFORMANCE_DEGRADED — directional signals suspended</Chip>}
            <Chip>{r.setup.modelVersion}</Chip><Chip>{r.setup.indicatorName ?? "market features"} · {String(r.setup.indicatorHash).slice(0, 10)}</Chip>
            {r.legacyRows > 0 && <Chip>{r.legacyRows} older-version forecasts reported separately</Chip>}
          </div>
          <table className="w-full text-xs"><thead><tr className="text-ink-soft"><th className="py-1 text-left">Metric</th><th className="text-left">Result</th><th className="text-left">Evidence</th></tr></thead>
            <tbody>{rows.map(([m, v, e]) => <tr key={m} className="border-t border-glass-border"><td className="py-1 text-ink">{m}</td><td className="num text-ink">{v}</td><td className="text-[11px]">{e}</td></tr>)}</tbody></table>
          <div>
            <div className="text-xs font-semibold text-ink">Acceptance criteria</div>
            <ul className="text-[11px]">{r.criteria.map((c) => <li key={c.name} className={c.pass ? "text-bull" : "text-bear"}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>
          </div>
          {rep && (
            <div className="grid gap-3 text-[11px] text-ink-soft sm:grid-cols-2">
              <div><div className="font-semibold text-ink">Validation splits (embargo {rep.embargo} rows)</div>
                train {rep.split.train} → {rep.split.trainTo} · calibration {rep.split.validation} → {rep.split.validationTo} · test {rep.split.test} → {rep.split.testTo}
                <ul>{rep.walkForward.map((f) => <li key={f.from}>WF {f.from} → {f.to}: {pc(f.accuracy)} vs {pc(Math.max(f.baseline.majority, f.baseline.persistence))} (n={f.samples})</li>)}</ul>
                <ul>{rep.checks.map((c) => <li key={c.name} className={c.pass ? "text-bull" : "text-bear"}>{c.pass ? "✓" : "✗"} {c.name} — {c.detail}</li>)}</ul>
              </div>
              <div><div className="font-semibold text-ink">Regimes (test split)</div>
                <ul>{rep.regimes.filter((g) => g.n).map((g) => <li key={g.regime}>{g.regime}: {pc(g.accuracy)} vs {pc(g.baseline)} (n={g.n}) {g.reliable === false ? "→ NO SIGNAL in this regime" : g.reliable === null ? "· insufficient evidence" : ""}</li>)}</ul>
                <div className="mt-2 font-semibold text-ink">Calibration curve (test)</div>
                <ul>{rep.calibration.curve.filter((b) => b.n).map((b) => <li key={b.from}>{pc(b.from)}–{pc(b.to)}: predicted {pc(b.meanConf)} · observed {pc(b.observed)} (n={b.n})</li>)}</ul>
                <div className="mt-2 font-semibold text-ink">Confusion (rows = predicted)</div>
                <ul className="num">{(["UP", "DOWN", "NEUTRAL"] as const).map((p) => <li key={p}>{p}: {(["UP", "DOWN", "NEUTRAL"] as const).map((a) => `${a} ${rep.calibration.confusion[p][a]}`).join(" · ")}</li>)}</ul>
              </div>
            </div>
          )}
          {rep?.calibrationCompare && (
            <div className="text-[11px] text-ink-soft">
              <div className="font-semibold text-ink">Calibration report — {rep.calibrationCompare.method}</div>
              <div>Evaluated on: {rep.calibrationCompare.evaluatedOn} · acceptance ECE ≤ {rep.calibrationCompare.threshold.toFixed(2)} (unchanged)</div>
              <ul className="num">{([["Uncalibrated", rep.calibrationCompare.uncalibrated], ["Previous (binned one-vs-rest)", rep.calibrationCompare.legacyBinned], ["Multiclass calibrated (test)", rep.calibrationCompare.calibrated], ["Calibration-fit split (in-sample for the calibrator)", rep.calibrationCompare.calibrationFitSplit]] as const).map(([k, c]) => <li key={k}>{k}: ECE {c.ece?.toFixed(3) ?? "—"} · Brier {c.brier?.toFixed(3) ?? "—"} · LogLoss {c.logLoss?.toFixed(3) ?? "—"} (n={c.n})</li>)}</ul>
            </div>
          )}
          {r.shadow && (
            <div className="text-[11px] text-ink-soft">
              <div className="font-semibold text-ink">Shadow forecasts (experimental — model not approved; users see NO SIGNAL)</div>
              <div>Frozen before target open, scored after close. Kept separate from approved live accuracy.</div>
              <ul className="num">
                <li>Directional accuracy: {pc(r.shadow.directional.accuracy)} · {ci(r.shadow.directional.ci)} · {r.shadow.directional.n}/{r.shadow.required} scored directional {r.shadow.directional.n < 30 && "· insufficient evidence"}</li>
                <li>UP {pc(r.shadow.up.accuracy)} (n={r.shadow.up.n}) · DOWN {pc(r.shadow.down.accuracy)} (n={r.shadow.down.n}) · baseline {pc(r.shadow.baseline)}</li>
                <li>Coverage {pc(r.shadow.coverage)} · total {r.shadow.total} · evaluated {r.shadow.evaluated} · pending {r.shadow.pending} · NO SIGNAL {r.shadow.noSignal} · NEUTRAL {r.shadow.neutral}</li>
                <li>Calibration ECE {r.shadow.calibration.ece?.toFixed(3) ?? "—"} · Brier {r.shadow.calibration.brier?.toFixed(3) ?? "—"} · LogLoss {r.shadow.calibration.logLoss?.toFixed(3) ?? "—"} (n={r.shadow.calibration.n})</li>
                <li className={r.shadow.pass ? "text-bull" : "text-bear"}>Shadow approval evidence: {r.shadow.pass ? "PASS" : "NOT YET"}{r.shadow.degraded ? " · DEGRADED vs baseline" : ""}</li>
              </ul>
            </div>
          )}
          {fw && fw.directional.n > 0 && (
            <div className="grid gap-3 text-[11px] text-ink-soft sm:grid-cols-3">
              {([["Daily", fw.daily], ["Weekly", fw.weekly], ["Monthly", fw.monthly], ["Sessions", fw.sessions], ["Regimes (live)", fw.regimes]] as const).map(([t, g]) => (
                <div key={t}><div className="font-semibold text-ink">{t}</div><ul>{g.map((x) => <li key={x.key}>{x.key}: {pc(x.accuracy)} (n={x.n})</li>)}</ul></div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-ink-soft">
            <div className="font-semibold text-ink">Model registry</div>
            <ul>{r.models.map((m) => (
              <li key={m.id}>{m.createdAt.slice(0, 16)} · {m.status} · validation {m.pass ? "PASS" : "FAIL"} · OOS {pc(m.oos)} · {m.dataRange?.provider} {m.dataRange?.from?.slice(0, 10)}→{m.dataRange?.to?.slice(0, 10)}
                {m.status === "CANDIDATE" && m.pass && <button type="button" className={`${btn} ml-2`} onClick={() => prom.mutate(m.id)}>Promote</button>}</li>
            ))}</ul>
          </div>
          {rep && <p className="text-[11px] text-ink-soft">{rep.disclaimer}</p>}
        </div>
      )}
    </Panel>
  );
}
