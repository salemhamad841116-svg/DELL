import type { NextCandleForecast } from "@/lib/use/types";
import { REGIME_LABELS } from "@/lib/use/regime";
import { Chip, Panel, Stat, numFmt, pct } from "./primitives";
import { cn } from "@/lib/utils";

const DIRECTION_LABEL: Record<NextCandleForecast["direction"], string> = {
  BULLISH: "Bullish lean",
  BEARISH: "Bearish lean",
  NEUTRAL: "No clear lean",
};

export function NextCandle({ f }: { f: NextCandleForecast }) {
  const tone = f.direction === "BULLISH" ? "bull" : f.direction === "BEARISH" ? "bear" : "neutral";
  return (
    <Panel
      title="Next Candle"
      subtitle="Probabilities based on verified data — not a guaranteed outcome."
      action={
        <div className="flex flex-wrap gap-1.5">
          <Chip>{f.timeframe}</Chip>
          <Chip>{REGIME_LABELS[f.regime] ?? f.regime}</Chip>
          {f.overfittingRisk && <Chip tone="warn">OVERFITTING RISK</Chip>}
        </div>
      }
    >
      <div className={cn("num text-2xl", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
        {DIRECTION_LABEL[f.direction]}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Bullish probability" value={pct(f.bullishProbability)} tone="bull" />
        <Stat label="Bearish probability" value={pct(f.bearishProbability)} tone="bear" />
        <Stat label="Neutral probability" value={pct(f.neutralProbability)} />
        <Stat label="Calibrated confidence" value={pct(f.confidence)} hint="Calibrated from out-of-sample behavior" />
        <Stat label="Expected return" value={`${numFmt(f.expectedReturn)}%`} />
        <Stat label="Expected volatility" value={`${numFmt(f.expectedVolatility)}%`} />
        <Stat label="Expected range (low)" value={numFmt(f.expectedLow, 4)} />
        <Stat label="Expected range (high)" value={numFmt(f.expectedHigh, 4)} />
        <Stat label="Reference price" value={numFmt(f.referenceClose, 4)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft">
        <span>Sample size: {f.sampleSize}</span>
        <span>Model version: {f.modelVersion}</span>
        <span>Latest data: {new Date(f.dataTimestamp).toLocaleString("en")}</span>
        <span>Data quality: {f.dataQuality}</span>
      </div>
    </Panel>
  );
}

export function Evidence({ f }: { f: NextCandleForecast }) {
  const max = Math.max(...f.evidence.map((e) => Math.abs(e.contribution)), 1);
  return (
    <Panel title="Forecast explanation" subtitle="Model contributions to the current decision (scaled logit points), including opposing factors.">
      <ul className="space-y-2">
        {f.evidence.map((e) => (
          <li key={e.label} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-[11px] text-ink-soft">{e.label}</span>
            <span className="relative h-2 flex-1 rounded-full bg-muted">
              <span
                className={cn(
                  "absolute inset-y-0 rounded-full",
                  e.contribution >= 0 ? "left-1/2 bg-bull" : "right-1/2 bg-bear",
                )}
                style={{ width: `${(Math.abs(e.contribution) / max) * 50}%` }}
              />
            </span>
            <span className="num w-16 text-left text-xs">
              {e.contribution > 0 ? "+" : ""}
              {e.contribution.toFixed(1)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-ink-soft">
        These are statistical relationships extracted by the model, not proof of causation.
      </p>
    </Panel>
  );
}

export function ModelQuality({ f }: { f: NextCandleForecast }) {
  const rows: { label: string; m: NextCandleForecast["metrics"]["train"] }[] = [
    { label: "Train", m: f.metrics.train },
    { label: "Validation", m: f.metrics.validation },
    { label: "Out of sample", m: f.metrics.outOfSample },
    { label: "Baseline", m: f.metrics.baseline },
  ];
  return (
    <Panel title="Model performance" subtitle="60/20/20 chronological split with no random shuffling, with a mandatory baseline comparison.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-xs">
          <thead className="text-ink-soft">
            <tr className="border-b border-glass-border">
              <th className="py-2 font-medium">Group</th>
              <th className="py-2 font-medium">Samples</th>
              <th className="py-2 font-medium">Accuracy</th>
              <th className="py-2 font-medium">Log Loss</th>
              <th className="py-2 font-medium">Brier</th>
              <th className="py-2 font-medium">AUC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-glass-border/70 last:border-0">
                <td className="py-2 text-ink">{r.label}</td>
                <td className="num py-2">{r.m.samples}</td>
                <td className="num py-2">{pct(r.m.accuracy)}</td>
                <td className="num py-2">{numFmt(r.m.logLoss, 3)}</td>
                <td className="num py-2">{numFmt(r.m.brier, 3)}</td>
                <td className="num py-2">{numFmt(r.m.auc, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.metrics.walkForward.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] text-ink-soft">Walk-Forward (expanding windows)</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {f.metrics.walkForward.map((m, i) => (
              <Stat key={i} label={`Window ${i + 1}`} value={pct(m.accuracy)} hint={`AUC ${numFmt(m.auc, 2)}`} />
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Current market regime" value={REGIME_LABELS[f.regime] ?? f.regime} />
        <Stat label="Same-regime samples" value={String(f.regimeStats.samples)} />
        <Stat label="Same-regime success rate" value={pct(f.regimeStats.successRate)} />
      </div>
    </Panel>
  );
}
