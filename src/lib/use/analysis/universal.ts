// Universal Strategy Engine pipeline (pure). Static analysis of the IR + quantitative
// analysis of a real backtest trade list. Never invents metrics: every number comes from trades.
import type { StrategyIR } from "../strategy/ir";
import type { Trade } from "../strategy/backtester";
import { analyzeStatic, classifyStrategy } from "./static";
import { performance, risk, signalQuality, breakeven } from "./quant";

export type StepStatus = "PASS" | "FAIL" | "WARN" | "SKIPPED";
export type Step = { n: number; name: string; status: StepStatus; detail: string };
export type BacktestInput = { runId: string; trades: Trade[]; status: string; coverageStatus: string | null; initialCapital: number; observedDays: number; stepMs: number; periodStart: string; periodEnd: string; datasetHash: string | null; provider: string | null };

/** Chronological split of trades by entry time: 60% train / 20% validation / 20% OOS. */
export function splitTrades(trades: Trade[]) {
  const s = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  const a = Math.floor(s.length * 0.6), b = Math.floor(s.length * 0.8);
  return { train: s.slice(0, a), validation: s.slice(a, b), oos: s.slice(b) };
}

export function runUniversal(ir: StrategyIR, timeframe: string, bt: BacktestInput | null) {
  const steps: Step[] = [];
  const add = (name: string, status: StepStatus, detail: string) => steps.push({ n: steps.length + 1, name, status, detail });
  const st = analyzeStatic(ir);
  const c = st.counts;
  add("Parse", c.syntaxErrors ? "FAIL" : "PASS", `${c.syntaxErrors} syntax errors`);
  add("Semantic support", c.unsupported ? "FAIL" : "PASS", `${c.unsupported} unsupported constructs`);
  add("Symbol table", c.unresolvedIdentifiers ? "FAIL" : "PASS", `${c.symbols} symbols, ${c.unresolvedIdentifiers} unresolved`);
  add("Data flow", c.circular ? "FAIL" : "PASS", `${st.flows.length} signal flows, ${c.circular} circular`);
  add("Control flow", c.deadCode || c.unreachableConditions ? "WARN" : "PASS", `${st.cfg.branches} branches, ${st.cfg.loops} loops, ${c.deadCode} dead, ${c.unreachableConditions} unreachable`);
  add("Logical consistency", c.contradictions ? "FAIL" : "PASS", `${c.contradictions} contradictions`);
  add("Entry/exit present", c.entries ? "PASS" : "FAIL", `${c.entries} entries, ${c.exits} exits`);
  const classification = classifyStrategy(ir, st, timeframe);
  add("Classification", "PASS", "rule-based");

  let quant: Record<string, unknown> | null = null;
  if (!bt) {
    for (const n of ["Historical data", "Backtest", "Costs", "Risk", "Signal quality", "Validation splits"]) add(n, "SKIPPED", "no completed backtest run for this strategy/symbol/timeframe");
  } else {
    add("Historical data", bt.coverageStatus === "PASS_COMPLETE_HISTORICAL_COVERAGE" ? "PASS" : "FAIL", `coverage ${bt.coverageStatus ?? "unknown"}`);
    add("Backtest", bt.status.startsWith("COMPLETED") && bt.trades.length > 0 ? "PASS" : "FAIL", `${bt.status}, ${bt.trades.length} trades`);
    const net = performance(bt.trades, bt.initialCapital);
    const grossTrades = bt.trades.map((t) => ({ ...t, pnl: t.pnl + t.commission }));
    const gross = performance(grossTrades, bt.initialCapital);
    add("Costs", (net.expectancy ?? 0) > 0 ? "PASS" : "WARN", `net expectancy ${net.expectancy?.toFixed(2) ?? "n/a"}, gross ${gross.expectancy?.toFixed(2) ?? "n/a"}`);
    const rk = risk(bt.trades);
    add("Risk", "PASS", `VaR95 ${rk.var95?.toFixed(3) ?? "n/a"}%`);
    const sq = signalQuality(bt.trades, bt.observedDays, bt.stepMs, gross, net);
    add("Signal quality", sq.overtrading ? "WARN" : "PASS", sq.overtrading ?? `${sq.signalsPerDay?.toFixed(2) ?? "n/a"} signals/day`);
    const sp = splitTrades(bt.trades);
    const parts = { train: performance(sp.train, bt.initialCapital), validation: performance(sp.validation, bt.initialCapital), oos: performance(sp.oos, bt.initialCapital) };
    const trainPF = parts.train.profitFactor ?? 0, oosPF = parts.oos.profitFactor ?? 0;
    const overfit = sp.oos.length < 10 ? "INSUFFICIENT_OOS" : trainPF > 1.2 && oosPF < 1 ? "HIGH" : "LOW";
    add("Validation splits", overfit === "HIGH" ? "FAIL" : overfit === "INSUFFICIENT_OOS" ? "WARN" : "PASS", `train PF ${trainPF.toFixed(2)} → OOS PF ${oosPF.toFixed(2)} (${sp.oos.length} OOS trades), overfit risk ${overfit}`);
    quant = { net, gross, risk: rk, signalQuality: sq, breakeven: breakeven(gross, net), splits: parts, overfitRisk: overfit };
  }

  const blocked =
    c.syntaxErrors || c.unsupported || c.unresolvedIdentifiers ? "BLOCKED_UNRESOLVED_IDENTIFIERS"
    : c.contradictions ? "BLOCKED_LOGICAL_CONTRADICTION"
    : !bt || steps.find((s) => s.name === "Historical data")?.status === "FAIL" ? "BLOCKED_INCOMPLETE_HISTORICAL_DATA"
    : steps.find((s) => s.name === "Backtest")?.status === "FAIL" ? "BLOCKED_BACKTEST_FAILURE"
    : (quant?.["overfitRisk"] as string) !== "LOW" ? "BLOCKED_OVERFIT_RISK"
    : null;
  return { status: blocked ?? "FINAL_VERIFIED", steps, static: st, classification, quant };
}
export type UniversalReport = ReturnType<typeof runUniversal>;
