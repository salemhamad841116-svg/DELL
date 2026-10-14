import { useState } from "react";

import type { Bucket, HistoricalReport } from "@/lib/use/types";
import { Panel, Stat, numFmt, pct } from "./primitives";

const TABS: { id: keyof HistoricalReport | "stats"; label: string }[] = [
  { id: "stats", label: "Summary" },
  { id: "byHour", label: "By Hour" },
  { id: "byWeekday", label: "By Day" },
  { id: "byMonth", label: "By Month" },
  { id: "byRegime", label: "Market Regimes" },
  { id: "byVolatility", label: "Volatility" },
  { id: "featureCombinations", label: "Combined Patterns" },
  { id: "aggregates", label: "Time Coverage" },
];

function BucketTable({ rows, showPerf = true }: { rows: Bucket[]; showPerf?: boolean }) {
  if (rows.length === 0) return <p className="text-xs text-ink-soft">Not enough samples for this breakdown.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-right text-xs">
        <thead className="text-ink-soft">
          <tr className="border-b border-glass-border">
            <th className="py-2 font-medium">Group</th>
            <th className="py-2 font-medium">Samples</th>
            {showPerf && <th className="py-2 font-medium">Win Rate</th>}
            {showPerf && <th className="py-2 font-medium">Avg Return</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} className="border-b border-glass-border/70 last:border-0">
              <td className="py-2 text-ink">{b.key}</td>
              <td className="num py-2">{b.samples}</td>
              {showPerf && <td className="num py-2">{pct(b.winRate)}</td>}
              {showPerf && <td className="num py-2">{numFmt(b.averageReturn)}%</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Historical({ report }: { report: HistoricalReport }) {
  const [tab, setTab] = useState<string>("stats");
  const s = report.stats;
  return (
    <Panel
      title="Historical Analysis"
      subtitle={`${report.periodStart ? new Date(report.periodStart).toLocaleDateString("en") : "—"} ← ${
        report.periodEnd ? new Date(report.periodEnd).toLocaleDateString("en") : "—"
      } · ${s.observations} candles · ${s.trades} signals`}
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(String(t.id))}
            className={`rounded-full border px-3 py-1 text-[11px] transition ${
              tab === t.id
                ? "border-ink bg-ink text-primary-foreground"
                : "border-glass-border text-ink hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "stats" ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Win rate" value={pct(s.winRate)} tone="bull" />
          <Stat label="Loss rate" value={pct(s.lossRate)} tone="bear" />
          <Stat label="Expectancy" value={`${numFmt(s.expectancy)}%`} />
          <Stat label="Profit Factor" value={numFmt(s.profitFactor)} />
          <Stat label="Max drawdown" value={`${numFmt(s.maxDrawdown)}%`} tone="bear" />
          <Stat label="Average return" value={`${numFmt(s.averageReturn)}%`} />
          <Stat label="Max favorable excursion" value={`${numFmt(s.averageFavorableExcursion)}%`} tone="bull" />
          <Stat label="Max adverse excursion" value={`${numFmt(s.averageAdverseExcursion)}%`} tone="bear" />
          <Stat label="Time to target" value={`${numFmt(s.averageTimeToTarget, 1)} candles`} />
          <Stat label="Time to failure" value={`${numFmt(s.averageTimeToFailure, 1)} candles`} />
          <Stat label="Long (count / win rate)" value={`${s.longTrades} / ${pct(s.longWinRate)}`} />
          <Stat label="Short (count / win rate)" value={`${s.shortTrades} / ${pct(s.shortWinRate)}`} />
        </div>
      ) : (
        <BucketTable
          rows={(report[tab as keyof HistoricalReport] as Bucket[]) ?? []}
          showPerf={tab !== "aggregates"}
        />
      )}
    </Panel>
  );
}
