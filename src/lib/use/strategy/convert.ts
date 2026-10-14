// Intelligent Indicator → Strategy converter (browser-safe, pure).
// Indicator source → Pine AST → signal candidates (suggestions only) → user config →
// generated separate strategy() copy. Never invents logic: no candidates ⇒ NO_CLEAR_TRADING_RULES_DETECTED.

import { exprText, parsePine, type Expr, type Stmt } from "./pine";

export type Side = "BUY" | "SELL" | "EXIT";
export type Candidate = {
  id: string;
  name: string | null; // variable name when the condition is a named boolean
  expression: string; // condition to use (variable name or inline expression)
  original: string; // original source expression
  line: number;
  kind: "crossover" | "crossunder" | "threshold" | "state" | "breakout" | "bool" | "alert";
  suggested: Side | null;
  confidence: number; // 0..1 heuristic confidence of the suggested side
  reason: string;
};
export type Extraction = {
  status: "CANDIDATES_DETECTED" | "NO_CLEAR_TRADING_RULES_DETECTED";
  candidates: Candidate[];
  levels: { name: string; line: number; kind: string }[]; // numeric series usable as TP/SL levels
  atrVars: { name: string; line: number }[];
  definedNames: string[];
  sourceDiagnostics: { code: string; construct: string; line: number; col: number }[];
};

export type Rule = { expression: string; line: number | null; original: string; confidence: number | null; source: "DETECTED" | "MANUAL" };
export type LevelMode = "NONE" | "TICKS" | "POINTS" | "PERCENT" | "ATR" | "PRICE" | "INDICATOR";
export type Level = { mode: LevelMode; value: number; atrLength: number; longRef: string; shortRef: string };
export type ConvertConfig = {
  buy: Rule[];
  sell: Rule[];
  exit: Rule[];
  tp: Level;
  sl: Level;
  direction: "LONG_ONLY" | "SHORT_ONLY" | "BOTH";
  allowReentry: boolean;
  onePosition: boolean;
  pyramiding: number;
  trailing: { enabled: boolean; points: number; offset: number };
  breakEven: { enabled: boolean; triggerTicks: number };
  partialExit: { enabled: boolean; percent: number };
  orderType: "MARKET" | "LIMIT" | "STOP";
  orderOffsetTicks: number;
  fillTiming: "NEXT_BAR_OPEN" | "BAR_CLOSE";
};

export const defaultLevel = (): Level => ({ mode: "NONE", value: 0, atrLength: 14, longRef: "", shortRef: "" });

const BULL = /(bull|buy|long|up\b|^up|golden|oversold)/i;
const BEAR = /(bear|sell|short|down|dn\b|^dn|death|overbought)/i;
const EXIT = /(exit|close|flat|stop)/i;
const BUILTINS = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4", "bar_index", "time", "time_close", "na", "true", "false", "last_bar_index", "dayofweek", "hour", "minute", "month", "year", "dayofmonth"]);
const CMP = new Set([">", "<", ">=", "<=", "==", "!="]);

function walk(stmts: Stmt[], f: (s: Stmt, depth: number) => void, depth = 0) {
  for (const s of stmts) {
    f(s, depth);
    if (s.k === "if") { walk(s.then, f, depth + 1); if (s.else) walk(s.else, f, depth + 1); }
    if (s.k === "for" || s.k === "while" || s.k === "fn") walk(s.body, f, depth + 1);
  }
}
function ids(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case "id": out.add(e.name); break;
    case "call": e.args.forEach((a) => ids(a, out)); Object.values(e.named).forEach((a) => ids(a, out)); break;
    case "idx": ids(e.target, out); ids(e.offset, out); break;
    case "bin": ids(e.a, out); ids(e.b, out); break;
    case "un": ids(e.a, out); break;
    case "tern": ids(e.c, out); ids(e.a, out); ids(e.b, out); break;
    case "tuplelit": e.items.forEach((a) => ids(a, out)); break;
  }
  return out;
}
function isBoolish(e: Expr, boolVars: Set<string>): boolean {
  if (e.k === "call") return /^ta\.(crossover|crossunder|cross|rising|falling)$/.test(e.fn);
  if (e.k === "bin") return CMP.has(e.op) || ((e.op === "and" || e.op === "or") && (isBoolish(e.a, boolVars) || isBoolish(e.b, boolVars)));
  if (e.k === "un") return e.op === "not" && isBoolish(e.a, boolVars);
  if (e.k === "id") return boolVars.has(e.name);
  return false;
}
function findCall(e: Expr, re: RegExp): Extract<Expr, { k: "call" }> | null {
  if (e.k === "call") { if (re.test(e.fn)) return e; for (const a of e.args) { const r = findCall(a, re); if (r) return r; } }
  if (e.k === "bin") return findCall(e.a, re) ?? findCall(e.b, re);
  if (e.k === "un") return findCall(e.a, re);
  return null;
}

type Score = { side: Side | null; conf: number; kind: Candidate["kind"]; reason: string };
function classify(name: string | null, e: Expr, v: { rsi: Set<string>; lvlHi: Set<string>; lvlLo: Set<string>; state: Set<string> }): Score {
  const text = exprText(e);
  let bull = 0, bear = 0, exit = 0; let kind: Candidate["kind"] = "bool"; const why: string[] = [];
  if (findCall(e, /^ta\.crossover$/)) { bull += 0.55; kind = "crossover"; why.push("ta.crossover"); }
  if (findCall(e, /^ta\.crossunder$/)) { bear += 0.55; kind = "crossunder"; why.push("ta.crossunder"); }
  // RSI-like thresholds
  const visitCmp = (x: Expr) => {
    if (x.k === "bin" && CMP.has(x.op)) {
      const l = x.a.k === "id" ? x.a.name : null; const r = x.b.k === "num" ? x.b.v : null;
      if (l && r !== null && v.rsi.has(l)) {
        kind = "threshold";
        if ((x.op === "<" || x.op === "<=") && r <= 40) { bull += 0.4; why.push(`${l} oversold < ${r}`); }
        if ((x.op === ">" || x.op === ">=") && r >= 60) { bear += 0.4; why.push(`${l} overbought > ${r}`); }
      }
      const rn = x.b.k === "id" ? x.b.name : null;
      if (l && rn && /^(close|high)$/.test(l) && v.lvlHi.has(rn) && (x.op === ">" || x.op === ">=")) { bull += 0.45; kind = "breakout"; why.push(`${l} breaks above ${rn}`); }
      if (l && rn && /^(close|low)$/.test(l) && v.lvlLo.has(rn) && (x.op === "<" || x.op === "<=")) { bear += 0.45; kind = "breakout"; why.push(`${l} breaks below ${rn}`); }
      if (l && v.state.has(l) && x.op === "==" && x.b.k === "num") { kind = "state"; if (x.b.v > 0) { bull += 0.35; why.push(`${l} == ${x.b.v}`); } else if (x.b.v < 0) { bear += 0.35; why.push(`${l} == ${x.b.v}`); } }
      if (l && v.state.has(l) && x.op === "==" && x.b.k === "un" && x.b.op === "-") { kind = "state"; bear += 0.35; why.push(`${l} == -…`); }
    }
    if (x.k === "bin") { visitCmp(x.a); visitCmp(x.b); }
    if (x.k === "un") visitCmp(x.a);
  };
  visitCmp(e);
  const label = `${name ?? ""} ${text}`;
  if (name && BULL.test(name)) { bull += 0.35; why.push(`name '${name}'`); }
  if (name && BEAR.test(name)) { bear += 0.35; why.push(`name '${name}'`); }
  if (name && EXIT.test(name)) { exit += 0.5; why.push(`name '${name}'`); }
  void label;
  const best = Math.max(bull, bear, exit);
  if (best === 0 || (bull > 0 && bull === bear)) return { side: null, conf: 0, kind, reason: why.join(", ") || "boolean condition, direction unclear" };
  const side: Side = exit === best ? "EXIT" : bull === best ? "BUY" : "SELL";
  const conflict = side === "BUY" ? bear : side === "SELL" ? bull : Math.max(bull, bear);
  return { side, conf: Math.max(0.1, Math.min(0.95, best - conflict * 0.5)), kind, reason: why.join(", ") };
}

export function extractCandidates(code: string): Extraction {
  const parsed = parsePine(code);
  const top = parsed.program;
  const defined = new Set<string>();
  const boolVars = new Set<string>();
  const rsi = new Set<string>(), lvlHi = new Set<string>(), lvlLo = new Set<string>(), state = new Set<string>();
  const levels: Extraction["levels"] = []; const atrVars: Extraction["atrVars"] = [];
  const reassigned = new Set<string>();
  walk(top, (s) => { if (s.k === "assign") reassigned.add(s.name); });
  for (const s of top) {
    if (s.k === "tuple") s.names.forEach((n) => defined.add(n));
    if (s.k !== "decl") continue;
    defined.add(s.name);
    const e = s.expr;
    if (s.typ === "bool" || isBoolish(e, boolVars)) boolVars.add(s.name);
    if (findCall(e, /^ta\.rsi$/) || /rsi/i.test(s.name)) rsi.add(s.name);
    if (e.k === "call" && e.fn === "ta.atr") atrVars.push({ name: s.name, line: s.loc.line });
    const hi = /^(r\d|res|resistance|upper|ph|pivot_?high|hh|top|lasthigh)/i.test(s.name) || !!findCall(e, /^ta\.(pivothigh|highest)$/);
    const lo = /^(s\d|sup|support|lower|pl|pivot_?low|ll|bottom|lastlow)/i.test(s.name) || !!findCall(e, /^ta\.(pivotlow|lowest)$/);
    if (hi) lvlHi.add(s.name);
    if (lo) lvlLo.add(s.name);
    if (s.persistent && (s.typ === "int" || /state|trend|dir/i.test(s.name)) && reassigned.has(s.name)) state.add(s.name);
    if (!boolVars.has(s.name) && (hi || lo || /pivot|^pp$|^p$|^r\d$|^s\d$|band|basis|vwap|ema|sma/i.test(s.name))) levels.push({ name: s.name, line: s.loc.line, kind: hi ? "resistance/high" : lo ? "support/low" : "level" });
  }
  // lastHigh/lastLow updated from pivots → levels too
  walk(top, (s) => {
    if (s.k === "assign" && findCall(s.expr, /./) === null && s.expr.k === "id") {
      if (lvlHi.has(s.expr.name)) lvlHi.add(s.name);
      if (lvlLo.has(s.expr.name)) lvlLo.add(s.name);
    }
  });
  const vars = { rsi, lvlHi, lvlLo, state };
  const out: Candidate[] = []; const seen = new Set<string>();
  const push = (name: string | null, e: Expr, line: number, alertTitle?: string) => {
    const raw = exprText(e);
    const inner = raw.startsWith("(") && raw.endsWith(")") && !/\)\s*.*\(/.test(raw.slice(1, -1)) ? raw.slice(1, -1) : raw;
    const expression = name ?? inner;
    if (seen.has(expression)) {
      if (alertTitle) { const c = out.find((x) => x.expression === expression); if (c) bump(c, alertTitle); }
      return;
    }
    seen.add(expression);
    const sc = classify(name, e, vars);
    const c: Candidate = { id: `c${out.length + 1}`, name, expression, original: `${name ? `${name} = ` : ""}${inner}`, line, kind: sc.kind, suggested: sc.side, confidence: Number(sc.conf.toFixed(2)), reason: sc.reason };
    if (alertTitle) bump(c, alertTitle);
    out.push(c);
  };
  const bump = (c: Candidate, title: string) => {
    const s: Side | null = EXIT.test(title) ? "EXIT" : BULL.test(title) ? "BUY" : BEAR.test(title) ? "SELL" : null;
    if (!s) return;
    if (!c.suggested) { c.suggested = s; c.confidence = 0.5; } else if (c.suggested === s) c.confidence = Math.min(0.95, Number((c.confidence + 0.15).toFixed(2)));
    c.kind = c.kind === "bool" ? "alert" : c.kind; c.reason += `${c.reason ? ", " : ""}signal label '${title.trim()}'`;
  };
  for (const s of top) if (s.k === "decl" && boolVars.has(s.name)) push(s.name, s.expr, s.loc.line);
  // Conditions used by alertcondition/plotshape/plotchar/bgcolor (top-level only — globally scoped)
  for (const s of top) {
    if (s.k !== "expr" || s.expr.k !== "call") continue;
    const c = s.expr; if (!/^(alertcondition|plotshape|plotchar|plotarrow)$/.test(c.fn)) continue;
    const cond = c.args[0] ?? c.named["condition"] ?? c.named["series"]; if (!cond) continue;
    const titleE = c.fn === "alertcondition" ? (c.args[1] ?? c.named["title"]) : (c.named["title"] ?? c.args[1] ?? c.named["text"]);
    const title = titleE && titleE.k === "str" ? titleE.v : exprText(c.named["style"] ?? { k: "na", loc: c.loc });
    const loc = c.named["location"]; const locTxt = loc ? exprText(loc) : "";
    const hint = `${title} ${/belowbar/i.test(locTxt) || /triangleup|arrowup|labelup/i.test(title) ? "bull" : /abovebar/i.test(locTxt) || /triangledown|arrowdown|labeldown/i.test(title) ? "bear" : ""}`;
    if (cond.k === "id") { if (defined.has(cond.name)) push(cond.name, (top.find((x) => x.k === "decl" && x.name === cond.name) as Extract<Stmt, { k: "decl" }> | undefined)?.expr ?? cond, c.loc.line, hint); }
    else if (isBoolish(cond, boolVars)) push(null, cond, c.loc.line, hint);
  }
  const candidates = out.filter((c) => c.suggested || c.kind !== "bool");
  return {
    status: candidates.some((c) => c.suggested === "BUY" || c.suggested === "SELL") ? "CANDIDATES_DETECTED" : "NO_CLEAR_TRADING_RULES_DETECTED",
    candidates, levels, atrVars, definedNames: [...defined],
    sourceDiagnostics: parsed.diagnostics.map((d) => ({ code: d.code, construct: d.construct, line: d.line, col: d.col })),
  };
}

/** Identifiers referenced by a user condition that are not defined at global scope. */
export function undefinedIdentifiers(expression: string, defined: Set<string>): string[] | "PARSE_ERROR" {
  const p = parsePine(`//@version=6\nindicator("x")\n__use_chk = ${expression}\n`);
  if (p.diagnostics.some((d) => d.code === "PARSE_ERROR")) return "PARSE_ERROR";
  const st = p.program.find((s) => s.k === "decl" && s.name === "__use_chk") as Extract<Stmt, { k: "decl" }> | undefined;
  if (!st) return "PARSE_ERROR";
  return [...ids(st.expr)].filter((n) => !n.includes(".") && !defined.has(n) && !BUILTINS.has(n));
}

export type DiffSection = { label: string; lines: string[] };
export type Generated = { code: string; declBefore: string; declAfter: string; sections: DiffSection[]; blockers: string[] };

function declSpan(src: string): { start: number; end: number } | null {
  const m = /^(\s*)indicator\s*\(/m.exec(src); if (!m) return null;
  const start = m.index + m[1]!.length; let i = src.indexOf("(", start), depth = 0; let q: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (q) { if (ch === q && src[i - 1] !== "\\") q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) return { start, end: i + 1 }; }
  }
  return null;
}
const or = (rules: Rule[]) => rules.map((r) => `(${r.expression.trim()})`).join(" or ");
const num = (n: number) => (Number.isFinite(n) ? String(Number(n.toFixed(10))) : "0");

function levelExpr(l: Level, dir: 1 | -1, kind: "TP" | "SL"): string | null {
  const sgn = (kind === "TP" ? 1 : -1) * dir; const op = sgn > 0 ? "+" : "-"; const avg = "strategy.position_avg_price";
  switch (l.mode) {
    case "NONE": return null;
    case "TICKS": return `${avg} ${op} ${num(l.value)} * syminfo.mintick`;
    case "POINTS": return `${avg} ${op} ${num(l.value)}`;
    case "PERCENT": return `${avg} * (1 ${op} ${num(l.value)} / 100)`;
    case "ATR": return `${avg} ${op} ${num(l.value)} * __use_atr_${kind.toLowerCase()}_e`;
    case "PRICE": return dir === 1 ? num(l.value) : num(Number(l.shortRef || l.value));
    case "INDICATOR": return (dir === 1 ? l.longRef : l.shortRef).trim() || null;
  }
}

export function generateStrategy(src: string, cfg: ConvertConfig): Generated {
  const blockers: string[] = [];
  const span = declSpan(src);
  if (!span) return { code: "", declBefore: "", declAfter: "", sections: [], blockers: ["No indicator() declaration found"] };
  const declBefore = src.slice(span.start, span.end);
  if (/\btimeframe\s*=|timeframe_gaps\s*=/.test(declBefore)) blockers.push("indicator(timeframe=…) has no strategy() equivalent");
  const extras = [`pyramiding=${cfg.pyramiding}`];
  if (cfg.fillTiming === "BAR_CLOSE") extras.push("process_orders_on_close=true");
  const declAfter = declBefore.replace(/^indicator\s*\(/, "strategy(").replace(/\)\s*$/, `, ${extras.join(", ")})`);
  const body = src.slice(0, span.start) + declAfter + src.slice(span.end);

  const longOn = cfg.direction !== "SHORT_ONLY" && cfg.buy.length > 0;
  const shortOn = cfg.direction !== "LONG_ONLY" && cfg.sell.length > 0;
  const preL: string[] = [], entryL: string[] = [], exitL: string[] = [], riskL: string[] = [], execL: string[] = [];
  execL.push(`// execution: order=${cfg.orderType}${cfg.orderType !== "MARKET" ? ` offset=${cfg.orderOffsetTicks} ticks` : ""}, fill=${cfg.fillTiming}, direction=${cfg.direction}, pyramiding=${cfg.pyramiding}, reentry=${cfg.allowReentry}, onePosition=${cfg.onePosition}`);
  const atrKinds: ("tp" | "sl")[] = []; if (cfg.tp.mode === "ATR") atrKinds.push("tp"); if (cfg.sl.mode === "ATR") atrKinds.push("sl");
  for (const k of atrKinds) { const l = k === "tp" ? cfg.tp : cfg.sl; preL.push(`__use_atr_${k} = ta.atr(${Math.max(1, Math.round(l.atrLength))})`, `var float __use_atr_${k}_e = na`); }
  if (cfg.breakEven.enabled) preL.push("var bool __use_be = false", "if strategy.position_size == 0", "    __use_be := false");

  const entry = (side: "Long" | "Short", rules: Rule[]) => {
    const dir = side === "Long" ? 1 : -1; const v = `__use_${side.toLowerCase()}_sig`;
    entryL.push(`${v} = ${or(rules)}`);
    let cond = cfg.allowReentry ? v : `${v} and not nz(${v}[1])`;
    // ATR-based TP/SL must be available on the entry bar, otherwise the exit prices would be na
    // and the position could never be closed. Skip such entries instead of opening a locked trade.
    for (const k of atrKinds) cond = `not na(__use_atr_${k}) and ${cond}`;
    if (cfg.onePosition) cond = `strategy.position_size == 0 and ${cond}`;
    const off = `${num(cfg.orderOffsetTicks)} * syminfo.mintick`;
    const px = cfg.orderType === "LIMIT" ? `, limit=close ${dir === 1 ? "-" : "+"} ${off}` : cfg.orderType === "STOP" ? `, stop=close ${dir === 1 ? "+" : "-"} ${off}` : "";
    entryL.push(`if ${cond}`, `    strategy.entry("${side}", strategy.${side.toLowerCase()}${px})`);
    for (const k of atrKinds) entryL.push(`    __use_atr_${k}_e := __use_atr_${k}`);
  };
  if (longOn) entry("Long", cfg.buy);
  if (shortOn) entry("Short", cfg.sell);
  if (!longOn && !shortOn) blockers.push("No entry rule for the selected direction (Entry/Exit completeness)");
  if (cfg.exit.length) exitL.push(`if ${or(cfg.exit)}`, "    strategy.close_all()");

  const exitBlock = (side: "Long" | "Short") => {
    const dir = side === "Long" ? 1 : -1;
    const tp = levelExpr(cfg.tp, dir, "TP"); let sl = levelExpr(cfg.sl, dir, "SL");
    const lines: string[] = [];
    if (cfg.breakEven.enabled) {
      const moved = dir === 1 ? `high - strategy.position_avg_price` : `strategy.position_avg_price - low`;
      lines.push(`    if ${moved} >= ${num(cfg.breakEven.triggerTicks)} * syminfo.mintick`, "        __use_be := true");
      const be = "strategy.position_avg_price";
      sl = sl ? `__use_be ? ${dir === 1 ? "math.max" : "math.min"}(${sl}, ${be}) : ${sl}` : `__use_be ? ${be} : na`;
    }
    const args = [tp && `limit=${tp}`, sl && `stop=${sl}`, cfg.trailing.enabled && `trail_points=${num(cfg.trailing.points)}`, cfg.trailing.enabled && `trail_offset=${num(cfg.trailing.offset)}`, cfg.partialExit.enabled && `qty_percent=${num(cfg.partialExit.percent)}`].filter(Boolean);
    if (!args.length) return;
    riskL.push(`if strategy.position_size ${dir === 1 ? ">" : "<"} 0`, ...lines, `    strategy.exit("${side === "Long" ? "XL" : "XS"}", "${side}", ${args.join(", ")})`);
  };
  if (longOn) exitBlock("Long");
  if (shortOn) exitBlock("Short");

  // Completeness: each enabled side needs an exit path.
  const hasRisk = cfg.tp.mode !== "NONE" || cfg.sl.mode !== "NONE" || cfg.trailing.enabled;
  if (longOn && !shortOn && !cfg.exit.length && !hasRisk) blockers.push("Long entries have no exit path (add EXIT rule, TP/SL, trailing, or SELL reversal)");
  if (shortOn && !longOn && !cfg.exit.length && !hasRisk) blockers.push("Short entries have no exit path (add EXIT rule, TP/SL, trailing, or BUY reversal)");
  if (cfg.tp.mode === "INDICATOR" && ((longOn && !cfg.tp.longRef.trim()) || (shortOn && !cfg.tp.shortRef.trim()))) blockers.push("TP indicator level not selected for every enabled side");
  if (cfg.sl.mode === "INDICATOR" && ((longOn && !cfg.sl.longRef.trim()) || (shortOn && !cfg.sl.shortRef.trim()))) blockers.push("SL indicator level not selected for every enabled side");
  if (cfg.partialExit.enabled) blockers.push("Partial exit (qty_percent) is not supported by the USE execution engine yet — disable it");

  const out = ["", "// ---- USE converter: generated order logic (original indicator unchanged) ----", ...execL, ...preL, ...entryL, ...exitL, ...riskL];
  const code = body.replace(/\s*$/, "") + "\n" + out.join("\n") + "\n";
  const sections: DiffSection[] = [
    { label: "Added strategy() declaration", lines: [`- ${declBefore}`, `+ ${declAfter}`] },
    { label: "Added entry rules", lines: entryL },
    { label: "Added exit rules", lines: exitL },
    { label: "Added TP/SL & position management", lines: [...preL, ...riskL] },
    { label: "Added execution settings", lines: [...execL, `pyramiding=${cfg.pyramiding}${cfg.fillTiming === "BAR_CLOSE" ? ", process_orders_on_close=true" : ""} (in strategy())`] },
  ];
  return { code, declBefore, declAfter, sections, blockers };
}
