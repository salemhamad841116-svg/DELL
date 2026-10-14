import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { DirectionMatrix } from "@/components/use/DirectionMatrix";
import { Historical } from "@/components/use/Historical";
import { Evidence, ModelQuality, NextCandle } from "@/components/use/NextCandle";
import { Chip, Panel } from "@/components/use/primitives";
import { NextCandleForecast } from "@/components/use/NextCandleForecast";
import { getBootstrap, runAnalysis, type AnalysisResult } from "@/lib/use/analysis.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Universal Strategy Engine — Strategy Data Analyst" },
      {
        name: "description",
        content:
          "A real strategy analysis engine: a direction matrix per timeframe, next-candle forecast with calibrated probabilities, historical analysis and prediction explanation.",
      },
      { property: "og:title", content: "Universal Strategy Engine — Strategy Data Analyst" },
      {
        property: "og:description",
        content:
          "Multi-timeframe direction matrix, next candle with probabilities, historical analysis and prediction explanation — real data, no random numbers.",
      },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { indicator?: string } => (typeof s['indicator'] === "string" ? { indicator: s['indicator'] } : {}),
  component: AnalysisPage,
});

function AnalysisPage() {
  const { indicator: initialIndicator } = Route.useSearch();
  const bootstrapFn = useServerFn(getBootstrap);
  const analyseFn = useServerFn(runAnalysis);

  const bootstrap = useQuery({
    queryKey: ["use", "bootstrap"],
    queryFn: () => bootstrapFn(),
  });

  const [mode, setMode] = useState<"forecast" | "analysis">("forecast");
  const [symbol, setSymbol] = useState<string>("");
  const [timeframe, setTimeframe] = useState<string>("1m");
  const [strategyId, setStrategyId] = useState<string>("");

  const symbols = bootstrap.data?.symbols ?? [];
  const strategies = bootstrap.data?.strategies ?? [];
  const activeSymbol = symbol || symbols[0]?.symbol || "";

  const analysis = useMutation<AnalysisResult>({
    mutationFn: () =>
      analyseFn({
        data: {
          symbol: activeSymbol,
          timeframe,
          strategyId: strategyId || null,
        },
      }),
  });

  const result = analysis.data;

  return (
    <div dir="auto" className="shell-gradient min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="glass flex flex-wrap items-start justify-between gap-4 rounded-2xl p-5">
          <div>
            <h1 className="text-lg font-semibold text-ink">Universal Strategy Engine</h1>
            <p className="mt-1 text-xs text-ink-soft">
              Analysis only — no buy or sell order is ever sent. All numbers are computed from verified market data.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/analyst" className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-primary-foreground">
              AI Strategy Analyst
            </Link>
            <Link to="/admin" className="rounded-full border border-glass-border px-4 py-1.5 text-xs text-ink hover:bg-muted">
              Admin Section
            </Link>
          </div>
        </header>

        <div className="glass flex gap-1 rounded-2xl p-1.5">
          {([["forecast", "Next Candle Forecast"], ["analysis", "Comprehensive Analysis"]] as const).map(([m, l]) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold ${mode === m ? "bg-ink text-primary-foreground" : "text-ink hover:bg-muted"}`}>{l}</button>
          ))}
        </div>

        {mode === "forecast" && (
          <>
            <Panel title="Symbol & Timeframe" subtitle="Each timeframe is independent: a 1m forecast targets only the next 1m candle.">
              <div className="grid gap-3 sm:grid-cols-2">
                <select value={activeSymbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink">
                  {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.display_name} · {s.provider}</option>)}
                </select>
                <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink">
                  {ANALYSIS_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </Panel>
            <NextCandleForecast key={`${activeSymbol}-${timeframe}`} symbol={activeSymbol} timeframe={timeframe} strategies={strategies} initialIndicatorId={initialIndicator} />
          </>
        )}

        {mode === "analysis" && (<>
        <Panel title="Analysis Space" subtitle="Choose the symbol, timeframe and strategy, then press the analyze button.">

          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1">
              <span className="text-[11px] text-ink-soft">Symbol</span>
              <select
                value={activeSymbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink"
              >
                {symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.display_name} · {s.provider}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-ink-soft">Primary timeframe</span>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink"
              >
                {ANALYSIS_TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-ink-soft">Strategy (optional)</span>
              <select
                value={strategyId}
                onChange={(e) => setStrategyId(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink"
              >
                <option value="">No strategy (market features only)</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.status}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={!activeSymbol || analysis.isPending}
                onClick={() => analysis.mutate()}
                className="w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {analysis.isPending ? "Analyzing…" : "Analyze"}
              </button>
            </div>
          </div>
          {analysis.isPending && (
            <p className="mt-3 text-[11px] text-ink-soft">
              Data is pulled for each timeframe, features are built, and training runs with a chronological split — this may take a minute.
            </p>
          )}
          {analysis.isError && (
            <p className="mt-3 text-xs text-bear">
              Could not complete the analysis: {(analysis.error as Error).message}
            </p>
          )}
        </Panel>

        {result && (
          <>
            <Panel title={`${result.displayName} · ${result.timeframe}`} subtitle={`Data source: ${result.dataSource} · ${new Date(result.generatedAt).toLocaleString("en")}`}>
              <div className="flex flex-wrap gap-1.5">
                <Chip>{result.symbol}</Chip>
                {result.strategy && <Chip>{result.strategy.name}</Chip>}
                {result.nextCandle?.overfittingRisk && <Chip tone="warn">OVERFITTING RISK</Chip>}
              </div>
              {result.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 text-[11px] text-ink-soft">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </Panel>

            <DirectionMatrix rows={result.matrix} />
            {result.nextCandle && <NextCandle f={result.nextCandle} />}
            {result.nextCandle && (
              <div className="grid gap-5 lg:grid-cols-2">
                <Evidence f={result.nextCandle} />
                <ModelQuality f={result.nextCandle} />
              </div>
            )}
            {result.historical && <Historical report={result.historical} />}
          </>
        )}
        </>)}
      </div>
    </div>
  );
}
