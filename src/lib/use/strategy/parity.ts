// TradingView parity certification: compares a TradingView Strategy Tester
// "List of trades" CSV export against engine trades. Pure, no approximation:
// trades are paired by direction + closest entry time within a tolerance.
import type { Trade } from "./backtester";

export type TvTrade = { n: number; dir: "LONG" | "SHORT"; entryTs: number; exitTs: number; entryPx: number; exitPx: number; qty: number; pnl: number; entrySignal: string; exitSignal: string };

export type ParityContext = {
  symbol: string; exchange: string; timeframe: string; timezone: "UTC";
  from: string; to: string; inputs: Record<string, unknown>;
  capital: number; commission: number; slippage: number; sizing: string;
};

export type ParityReport = {
  status: "PARITY_PASS" | "PARITY_FAIL" | "PARITY_INVALID_EXPORT";
  context: ParityContext; tvCount: number; engineCount: number; matched: number;
  missingTrades: TvTrade[]; extraTrades: Trade[]; directionMismatches: { tv: TvTrade; engine: Trade }[];
  maxEntryTimeDeltaMs: number; maxExitTimeDeltaMs: number; maxEntryPriceDelta: number; maxExitPriceDelta: number;
  pairs: { tv: number; engine: number; entryTimeDeltaMs: number; exitTimeDeltaMs: number; entryPriceDelta: number; exitPriceDelta: number; qtyDelta: number | null; pnlDelta: number | null; tvExitSignal: string; engineExitReason: string | null }[];
  priceMismatches: number; timestampMismatches: number; qtyMismatches: number; pnlMismatches: number;
  errors: string[];
};

function splitCsv(line: string, sep: string) {
  const out: string[] = []; let cur = ""; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out.map((s) => s.trim());
}

// Timestamps in the export must be UTC (chart timezone set to UTC before export).
function parseUtc(s: string): number {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
}

export function parseTradingViewCsv(csv: string): { trades: TvTrade[]; errors: string[] } {
  const errors: string[] = [];
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { trades: [], errors: ["Export is empty"] };
  const sep = lines[0]!.includes("\t") ? "\t" : lines[0]!.includes(";") && !lines[0]!.includes(",") ? ";" : ",";
  const head = splitCsv(lines[0]!, sep).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const iN = col("trade #", "trade"), iT = col("type"), iD = col("date/time", "date"), iP = col("price");
  const iQ = col("contracts", "quantity", "size", "qty");
  const iS = col("signal"); const iPL = head.findIndex((h) => h.startsWith("profit") || h.startsWith("net p&l") || h === "p&l" || h.startsWith("p&l"));
  if ([iN, iT, iD, iP].some((i) => i < 0)) return { trades: [], errors: ["Missing columns: need Trade #, Type, Date/Time, Price"] };
  const acc = new Map<number, Partial<TvTrade>>();
  for (const l of lines.slice(1)) {
    const c = splitCsv(l, sep) as string[]; const n = +c[iN]!; const type = (c[iT] ?? "").toLowerCase();
    const ts = parseUtc(c[iD] ?? ""); const px = +String(c[iP]).replace(/[^0-9.\-]/g, "");
    if (!Number.isFinite(n) || !Number.isFinite(ts) || !Number.isFinite(px)) { errors.push(`Unparseable row: ${l}`); continue; }
    const t = acc.get(n) ?? { n };
    t.dir = type.includes("short") ? "SHORT" : "LONG";
    if (iQ >= 0) t.qty = +String(c[iQ]).replace(/[^0-9.\-]/g, "");
    const sig = iS >= 0 ? (c[iS] ?? "") : "";
    if (type.startsWith("entry")) { t.entryTs = ts; t.entryPx = px; t.entrySignal = sig; }
    else if (type.startsWith("exit")) { t.exitTs = ts; t.exitPx = px; t.exitSignal = sig; if (iPL >= 0) t.pnl = +String(c[iPL]).replace(/[^0-9.\-]/g, ""); }
    else errors.push(`Unknown type "${c[iT]}" in trade ${n}`);
    acc.set(n, t);
  }
  const trades: TvTrade[] = [];
  for (const t of acc.values()) {
    // Open trades (no exit) are excluded from parity; reported as an error for visibility.
    if (t.entryTs == null || t.exitTs == null) { errors.push(`Trade ${t.n} is open/incomplete — excluded`); continue; }
    trades.push({ n: t.n!, dir: t.dir!, entryTs: t.entryTs, exitTs: t.exitTs, entryPx: t.entryPx!, exitPx: t.exitPx!, qty: t.qty ?? NaN, pnl: t.pnl ?? NaN, entrySignal: t.entrySignal ?? "", exitSignal: t.exitSignal ?? "" });
  }
  trades.sort((a, b) => a.entryTs - b.entryTs);
  return { trades, errors };
}

export function compareParity(tv: TvTrade[], engine: Trade[], context: ParityContext, opt: { timeToleranceMs: number; priceTolerance: number; pnlTolerance?: number }, parseErrors: string[] = []): ParityReport {
  const used = new Set<number>();
  const pairs: ParityReport["pairs"] = []; const missing: TvTrade[] = []; const dirMis: ParityReport["directionMismatches"] = [];
  for (const t of tv) {
    let best = -1; let bestD = Infinity;
    engine.forEach((e, i) => { if (used.has(i)) return; const d = Math.abs(e.entryTs - t.entryTs); if (d < bestD) { bestD = d; best = i; } });
    if (best < 0 || bestD > opt.timeToleranceMs) { missing.push(t); continue; }
    used.add(best); const e = engine[best]!;
    if (e.dir !== t.dir) { dirMis.push({ tv: t, engine: e }); continue; }
    const both = (a: number | undefined, b: number | undefined) => (Number.isFinite(a) && Number.isFinite(b) ? (a as number) - (b as number) : null);
    pairs.push({ tv: t.n, engine: e.n, entryTimeDeltaMs: e.entryTs - t.entryTs, exitTimeDeltaMs: e.exitTs - t.exitTs, entryPriceDelta: e.entryPx - t.entryPx, exitPriceDelta: e.exitPx - t.exitPx,
      qtyDelta: both(e.qty, t.qty), pnlDelta: both(e.pnl, t.pnl), tvExitSignal: t.exitSignal ?? "", engineExitReason: e.reason ?? null });
  }
  const extra = engine.filter((_, i) => !used.has(i));
  const mx = (f: (p: ParityReport["pairs"][number]) => number) => pairs.reduce((m, p) => Math.max(m, Math.abs(f(p))), 0);
  const r = {
    maxEntryTimeDeltaMs: mx((p) => p.entryTimeDeltaMs), maxExitTimeDeltaMs: mx((p) => p.exitTimeDeltaMs),
    maxEntryPriceDelta: mx((p) => p.entryPriceDelta), maxExitPriceDelta: mx((p) => p.exitPriceDelta),
  };
  const pt = opt.pnlTolerance ?? 0.01;
  const priceMismatches = pairs.filter((p) => Math.abs(p.entryPriceDelta) > opt.priceTolerance || Math.abs(p.exitPriceDelta) > opt.priceTolerance).length;
  const timestampMismatches = pairs.filter((p) => p.entryTimeDeltaMs !== 0 || p.exitTimeDeltaMs !== 0).length;
  const qtyMismatches = pairs.filter((p) => p.qtyDelta != null && Math.abs(p.qtyDelta) > 1e-9).length;
  const pnlMismatches = pairs.filter((p) => p.pnlDelta != null && Math.abs(p.pnlDelta) > pt).length;
  const pass = !qtyMismatches && !pnlMismatches && tv.length > 0 && !missing.length && !extra.length && !dirMis.length &&
    r.maxEntryTimeDeltaMs === 0 && r.maxExitTimeDeltaMs === 0 && r.maxEntryPriceDelta <= opt.priceTolerance && r.maxExitPriceDelta <= opt.priceTolerance;
  return {
    status: tv.length === 0 ? "PARITY_INVALID_EXPORT" : pass ? "PARITY_PASS" : "PARITY_FAIL",
    context, tvCount: tv.length, engineCount: engine.length, matched: pairs.length,
    missingTrades: missing, extraTrades: extra, directionMismatches: dirMis, ...r, pairs, priceMismatches, timestampMismatches, qtyMismatches, pnlMismatches, errors: parseErrors,
  };
}
