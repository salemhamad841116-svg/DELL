// Advanced static analysis over the real Pine AST (pine.ts → ir.ts). Pure: no I/O.
// Symbol table → dependency graph → data flow → control flow → logical checks → classification.
import type { Expr, Stmt } from "../strategy/pine";
import type { StrategyIR } from "../strategy/ir";

export type SymKind = "INPUT" | "VARIABLE" | "STATE" | "FUNCTION" | "PARAM" | "LOOP_VAR" | "TYPE" | "TUPLE";
export type SymbolEntry = { name: string; kind: SymKind; line: number; col: number; refs: number; type: string | null; scope: string };
export type Finding = { code: string; severity: "ERROR" | "WARNING" | "INFO"; message: string; line: number; col: number };
export type NodeRole = "MARKET_DATA" | "INPUT" | "INDICATOR" | "CONDITION" | "VALUE" | "SIGNAL";

const SERIES = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "time", "time_close", "bar_index", "hour", "minute", "dayofweek", "dayofmonth", "month", "year", "timenow", "na", "last_bar_index"]);
const MARKET = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
const NS = /^(strategy|syminfo|barstate|math|ta|dayofweek|barmerge|timeframe|format|size|position|text|alert|shape|location|display|xloc|yloc|extend|font|plot|line|label|hline|order|color|session|currency|str|array|map|matrix|chart|request|input|runtime|log|table|box|polyline|linefill|adjustment|scale|earnings|dividends|splits)\./;

const exprIds = (e: Expr, out: { name: string; line: number; col: number; hist: boolean }[] = [], hist = false): typeof out => {
  switch (e.k) {
    case "id": out.push({ name: e.name, line: e.loc.line, col: e.loc.col, hist }); break;
    case "call": e.args.forEach((a) => exprIds(a, out, hist)); Object.values(e.named).forEach((a) => exprIds(a, out, hist)); break;
    case "idx": exprIds(e.target, out, true); exprIds(e.offset, out, hist); break;
    case "bin": exprIds(e.a, out, hist); exprIds(e.b, out, hist); break;
    case "un": exprIds(e.a, out, hist); break;
    case "tern": exprIds(e.c, out, hist); exprIds(e.a, out, hist); exprIds(e.b, out, hist); break;
    case "tuplelit": e.items.forEach((x) => exprIds(x, out, hist)); break;
    case "switch": if (e.subj) exprIds(e.subj, out, hist); e.cases.forEach((c) => { if (c.when) exprIds(c.when, out, hist); exprIds(c.val, out, hist); }); break;
    default: break;
  }
  return out;
};
const calls = (e: Expr, out: string[] = []): string[] => {
  if (e.k === "call") { out.push(e.fn); e.args.forEach((a) => calls(a, out)); Object.values(e.named).forEach((a) => calls(a, out)); }
  else if (e.k === "idx") { calls(e.target, out); calls(e.offset, out); }
  else if (e.k === "bin") { calls(e.a, out); calls(e.b, out); }
  else if (e.k === "un") calls(e.a, out);
  else if (e.k === "tern") { calls(e.c, out); calls(e.a, out); calls(e.b, out); }
  else if (e.k === "tuplelit") e.items.forEach((x) => calls(x, out));
  else if (e.k === "switch") { if (e.subj) calls(e.subj, out); e.cases.forEach((c) => { if (c.when) calls(c.when, out); calls(c.val, out); }); }
  return out;
};

/** Canonical text of an expression (used to compare conditions). */
export function exprKey(e: Expr): string {
  switch (e.k) {
    case "num": return String(e.v);
    case "str": return JSON.stringify(e.v);
    case "bool": return String(e.v);
    case "na": return "na";
    case "id": return e.name;
    case "call": return `${e.fn}(${[...e.args.map(exprKey), ...Object.entries(e.named).sort().map(([k, v]) => `${k}=${exprKey(v)}`)].join(",")})`;
    case "idx": return `${exprKey(e.target)}[${exprKey(e.offset)}]`;
    case "bin": return `(${exprKey(e.a)} ${e.op} ${exprKey(e.b)})`;
    case "un": return `${e.op}(${exprKey(e.a)})`;
    case "tern": return `(${exprKey(e.c)}?${exprKey(e.a)}:${exprKey(e.b)})`;
    case "tuplelit": return `[${e.items.map(exprKey).join(",")}]`;
    case "switch": return `switch`;
  }
}

const isNot = (op: string) => op === "not" || op === "!";
const isAnd = (op: string) => op === "and" || op === "&&";
const isOr = (op: string) => op === "or" || op === "||";
const conj = (e: Expr): Expr[] => (e.k === "bin" && isAnd(e.op) ? [...conj(e.a), ...conj(e.b)] : [e]);
const constBool = (e: Expr): boolean | null => {
  if (e.k === "bool") return e.v;
  if (e.k === "un" && isNot(e.op)) { const v = constBool(e.a); return v === null ? null : !v; }
  if (e.k === "bin" && e.a.k === "num" && e.b.k === "num") {
    const a = e.a.v, b = e.b.v;
    switch (e.op) { case ">": return a > b; case "<": return a < b; case ">=": return a >= b; case "<=": return a <= b; case "==": return a === b; case "!=": return a !== b; }
  }
  if (e.k === "bin" && isAnd(e.op)) { const a = constBool(e.a), b = constBool(e.b); if (a === false || b === false) return false; if (a && b) return true; }
  if (e.k === "bin" && isOr(e.op)) { const a = constBool(e.a), b = constBool(e.b); if (a || b) return true; if (a === false && b === false) return false; }
  return null;
};
const FLIP: Record<string, string> = { ">": "<", "<": ">", ">=": "<=", "<=": ">=", "==": "==", "!=": "!=" };
/** Returns a reason when a conjunction can never be true (x and not x, a>b and a<b, x>5 and x<3, crossover & crossunder of same pair). */
export function contradiction(e: Expr): string | null {
  const parts = conj(e);
  const keys = parts.map(exprKey);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.k === "un" && isNot(p.op) && keys.includes(exprKey(p.a))) return `'${exprKey(p.a)}' and not '${exprKey(p.a)}'`;
    for (let j = i + 1; j < parts.length; j++) {
      const q = parts[j]!;
      if (p.k === "bin" && q.k === "bin" && FLIP[p.op] && FLIP[q.op]) {
        // Normalise q to the same operand order as p.
        let qa = exprKey(q.a), qb = exprKey(q.b), qop = q.op;
        const pa = exprKey(p.a), pb = exprKey(p.b);
        if (qa === pb && qb === pa) { [qa, qb] = [qb, qa]; qop = FLIP[qop]!; }
        if (qa === pa && qb === pb) {
          const bad = new Set([">|<", ">|<=", ">=|<", "<|>", "<=|>", "<|>=", "==|!=", "!=|==", ">|==", "<|==", "==|>", "==|<"]);
          if (bad.has(`${p.op}|${qop}`)) return `'${pa} ${p.op} ${pb}' and '${qa} ${qop} ${qb}'`;
        }
        // Same left side against two numeric bounds: x > 5 and x < 3.
        if (pa === exprKey(q.a) && p.b.k === "num" && q.b.k === "num") {
          const lo = (op: string, v: number) => (op === ">" || op === ">=" ? v : -Infinity);
          const hi = (op: string, v: number) => (op === "<" || op === "<=" ? v : Infinity);
          const L = Math.max(lo(p.op, p.b.v), lo(q.op, q.b.v)), H = Math.min(hi(p.op, p.b.v), hi(q.op, q.b.v));
          const strict = (p.op.length === 1 || q.op.length === 1);
          if (L > H || (L === H && strict)) return `'${pa} ${p.op} ${p.b.v}' and '${pa} ${q.op} ${q.b.v}'`;
        }
      }
      if (p.k === "call" && q.k === "call" && p.args.length === 2 && q.args.length === 2) {
        const pair = (c: typeof p) => `${exprKey(c.args[0]!)}|${exprKey(c.args[1]!)}`;
        const swap = (c: typeof p) => `${exprKey(c.args[1]!)}|${exprKey(c.args[0]!)}`;
        const fns = new Set([p.fn, q.fn]);
        if (fns.has("ta.crossover") && fns.has("ta.crossunder") && pair(p) === pair(q)) return `${p.fn} and ${q.fn} of the same series on one bar`;
        if (p.fn === "ta.crossover" && q.fn === "ta.crossover" && pair(p) === swap(q)) return `crossover(a,b) and crossover(b,a) on one bar`;
      }
    }
  }
  return null;
}

type Signal = { kind: "ENTRY" | "EXIT" | "CLOSE"; id: string | null; direction: "LONG" | "SHORT" | null; fn: string; guards: Expr[]; line: number; deps: string[] };

export function analyzeStatic(ir: StrategyIR) {
  const table = new Map<string, SymbolEntry>();
  const findings: Finding[] = [];
  const edges = new Map<string, Set<string>>(); // var → vars it depends on (same-bar, non-history)
  const histEdges = new Map<string, Set<string>>();
  const exprOf = new Map<string, Expr>();
  const signals: Signal[] = [];
  const userFns = new Set(ir.program.filter((s) => s.k === "fn").map((s) => (s as { name: string }).name));
  const types = new Set(ir.program.filter((s) => s.k === "type").map((s) => (s as { name: string }).name));
  let cfgNodes = 0; let cfgEdges = 0; let branches = 0; let loops = 0;

  const declare = (name: string, kind: SymKind, line: number, col: number, type: string | null, scope: string) => {
    const key = scope === "global" ? name : `${scope}::${name}`;
    if (!table.has(key)) table.set(key, { name, kind, line, col, refs: 0, type, scope });
  };
  const lookup = (name: string, scopes: string[]) => {
    for (const s of scopes) { const k = s === "global" ? name : `${s}::${name}`; if (table.has(k)) return table.get(k)!; }
    return null;
  };
  const known = (name: string, scopes: string[]) => {
    if (SERIES.has(name) || NS.test(name) || lookup(name, scopes)) return true;
    const head = name.split(".")[0]!;
    return name.includes(".") && (lookup(head, scopes) !== null || types.has(head));
  };
  const use = (e: Expr, scopes: string[]) => {
    for (const r of exprIds(e)) {
      const s = lookup(r.name, scopes) ?? (r.name.includes(".") ? lookup(r.name.split(".")[0]!, scopes) : null);
      if (s) s.refs++;
      else if (!known(r.name, scopes)) findings.push({ code: "UNDEFINED_VARIABLE", severity: "ERROR", message: `'${r.name}' is used but never declared`, line: r.line, col: r.col });
    }
    for (const fn of calls(e)) if (userFns.has(fn)) { const s = table.get(fn); if (s) s.refs++; }
  };
  const depend = (name: string, e: Expr) => {
    const set = edges.get(name) ?? new Set(); const hs = histEdges.get(name) ?? new Set();
    for (const r of exprIds(e)) (r.hist ? hs : set).add(r.name.includes(".") && !NS.test(r.name) ? r.name.split(".")[0]! : r.name);
    edges.set(name, set); histEdges.set(name, hs);
  };

  // Pass 1: top-level functions and types are visible everywhere.
  for (const st of ir.program) {
    if (st.k === "fn") declare(st.name, "FUNCTION", st.loc.line, st.loc.col, null, "global");
    if (st.k === "type") declare(st.name, "TYPE", st.loc.line, st.loc.col, null, "global");
  }

  const walk = (body: Stmt[], scopes: string[], guards: Expr[], ctx: string) => {
    let terminated = false;
    for (const st of body) {
      cfgNodes++; cfgEdges++;
      if (terminated) findings.push({ code: "DEAD_CODE", severity: "WARNING", message: `Statement after break/continue in ${ctx} never runs`, line: st.loc.line, col: st.loc.col });
      const scope = scopes[0]!;
      switch (st.k) {
        case "decl": {
          use(st.expr, scopes);
          const isInput = st.expr.k === "call" && st.expr.fn.startsWith("input");
          declare(st.name, isInput ? "INPUT" : st.persistent ? "STATE" : "VARIABLE", st.loc.line, st.loc.col, st.typ ?? (isInput && st.expr.k === "call" ? st.expr.fn.replace(/^input\.?/, "") || "input" : null), scope);
          if (scope === "global") { depend(st.name, st.expr); exprOf.set(st.name, st.expr); }
          break;
        }
        case "assign": {
          use(st.expr, scopes);
          const target = st.name.split(".")[0]!;
          const s = lookup(target, scopes);
          if (!s && !known(st.name, scopes)) findings.push({ code: "UNDEFINED_VARIABLE", severity: "ERROR", message: `'${st.name}' is reassigned with ${st.op} but never declared`, line: st.loc.line, col: st.loc.col });
          if (scope === "global") { const hs = histEdges.get(target) ?? new Set(); for (const r of exprIds(st.expr)) hs.add(r.name); histEdges.set(target, hs); }
          break;
        }
        case "tuple": {
          use(st.expr, scopes);
          for (const n of st.names) { declare(n, "TUPLE", st.loc.line, st.loc.col, null, scope); if (scope === "global") { depend(n, st.expr); exprOf.set(n, st.expr); } }
          break;
        }
        case "if": {
          branches++; cfgEdges++;
          use(st.cond, scopes);
          const cb = constBool(st.cond);
          const why = contradiction(st.cond);
          if (cb === false || why) findings.push({ code: "UNREACHABLE_CONDITION", severity: "ERROR", message: `Condition can never be true${why ? `: ${why}` : " (constant false)"} — its branch is dead`, line: st.loc.line, col: st.loc.col });
          if (cb === true && st.else) findings.push({ code: "UNREACHABLE_CONDITION", severity: "WARNING", message: "Condition is always true — else branch never runs", line: st.loc.line, col: st.loc.col });
          walk(st.then, scopes, [...guards, st.cond], "if");
          if (st.else) walk(st.else, scopes, [...guards, { k: "un", op: "not", a: st.cond, loc: st.loc }], "else");
          break;
        }
        case "for": {
          loops++; cfgEdges++;
          use(st.from, scopes); use(st.to, scopes); if (st.step) use(st.step, scopes);
          declare(st.v, "LOOP_VAR", st.loc.line, st.loc.col, "int", scope);
          if (st.from.k === "num" && st.to.k === "num" && st.step?.k !== "num" && st.from.v > st.to.v) { /* Pine counts down — fine */ }
          walk(st.body, scopes, guards, "for");
          break;
        }
        case "while": {
          loops++; cfgEdges++;
          use(st.cond, scopes);
          if (constBool(st.cond) === false) findings.push({ code: "DEAD_CODE", severity: "WARNING", message: "while-loop condition is constant false — body never runs", line: st.loc.line, col: st.loc.col });
          if (constBool(st.cond) === true && !JSON.stringify(st.body).includes('"k":"break"')) findings.push({ code: "INFINITE_LOOP", severity: "ERROR", message: "while true without break", line: st.loc.line, col: st.loc.col });
          walk(st.body, scopes, guards, "while");
          break;
        }
        case "break": case "continue": terminated = true; break;
        case "fn": {
          const fs = `fn:${st.name}`;
          for (const p of st.params) declare(p, "PARAM", st.loc.line, st.loc.col, null, fs);
          walk(st.body, [fs, ...scopes], [], `function ${st.name}`);
          break;
        }
        case "type": {
          for (const f of st.fields) if (f.def) use(f.def, scopes);
          break;
        }
        case "expr": {
          use(st.expr, scopes);
          const e = st.expr;
          if (e.k === "call" && /^strategy\.(entry|exit|close|close_all|order)$/.test(e.fn)) {
            const dirTxt = e.args[1] ? exprKey(e.args[1]) : e.named["direction"] ? exprKey(e.named["direction"]!) : "";
            const kind = e.fn === "strategy.entry" || e.fn === "strategy.order" ? "ENTRY" : e.fn === "strategy.exit" ? "EXIT" : "CLOSE";
            const deps = new Set<string>();
            for (const g of guards) for (const r of exprIds(g)) deps.add(r.name);
            for (const r of exprIds(e)) deps.add(r.name);
            signals.push({ kind, fn: e.fn, id: e.args[0]?.k === "str" ? e.args[0].v : null, direction: kind === "ENTRY" ? (dirTxt === "strategy.long" ? "LONG" : dirTxt === "strategy.short" ? "SHORT" : null) : null, guards, line: e.loc.line, deps: [...deps] });
          }
          break;
        }
      }
    }
  };
  walk(ir.program, ["global"], [], "script");

  // Unused symbols.
  for (const s of table.values()) {
    if (s.refs === 0 && (s.kind === "VARIABLE" || s.kind === "INPUT" || s.kind === "STATE" || s.kind === "TUPLE") && !s.name.startsWith("_"))
      findings.push({ code: "UNUSED_VARIABLE", severity: "WARNING", message: `${s.kind.toLowerCase()} '${s.name}' is declared but never used`, line: s.line, col: s.col });
    if (s.refs === 0 && s.kind === "FUNCTION") findings.push({ code: "UNUSED_FUNCTION", severity: "WARNING", message: `function '${s.name}' is never called`, line: s.line, col: s.col });
  }

  // Circular same-bar dependencies (history references [n] are legal recursion).
  const cycles: string[][] = [];
  const state = new Map<string, number>();
  const stack: string[] = [];
  const dfs = (v: string) => {
    state.set(v, 1); stack.push(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (state.get(w) === 1) cycles.push([...stack.slice(stack.indexOf(w)), w]);
      else if (!state.get(w)) dfs(w);
    }
    stack.pop(); state.set(v, 2);
  };
  for (const v of edges.keys()) if (!state.get(v)) dfs(v);
  for (const c of cycles) findings.push({ code: "CIRCULAR_DEPENDENCY", severity: "ERROR", message: `Circular dependency: ${c.join(" → ")}`, line: table.get(c[0]!)?.line ?? 0, col: 0 });

  // Data-flow roles and transitive closure.
  const role = (name: string): NodeRole => {
    if (MARKET.has(name)) return "MARKET_DATA";
    const s = table.get(name);
    if (s?.kind === "INPUT") return "INPUT";
    const e = exprOf.get(name);
    if (e && calls(e).some((f) => f.startsWith("ta.") || f === "request.security")) return calls(e).some((f) => /cross|rising|falling/.test(f)) ? "CONDITION" : "INDICATOR";
    if (e && (e.k === "bin" && [">", "<", ">=", "<=", "==", "!=", "and", "or"].includes(e.op) || (e.k === "un" && isNot(e.op)) || e.k === "bool")) return "CONDITION";
    return "VALUE";
  };
  const closure = (names: string[]) => {
    const seen = new Set<string>(); const q = [...names];
    while (q.length) { const n = q.pop()!; if (seen.has(n)) continue; seen.add(n); for (const d of [...(edges.get(n) ?? []), ...(histEdges.get(n) ?? [])]) q.push(d); }
    return seen;
  };
  const flows = signals.map((s) => {
    const all = closure(s.deps);
    const by = (r: NodeRole) => [...all].filter((n) => role(n) === r).sort();
    const market = [...all].filter((n) => MARKET.has(n) || n.startsWith("strategy.position") || n === "time" || n === "hour");
    const indicatorCalls = [...new Set([...all].flatMap((n) => (exprOf.get(n) ? calls(exprOf.get(n)!) : [])).concat(s.guards.flatMap((g) => calls(g))).filter((f) => f.startsWith("ta.")))].sort();
    return { signal: `${s.kind}${s.direction ? " " + s.direction : ""}${s.id ? ` "${s.id}"` : ""}`, line: s.line, guard: s.guards.map(exprKey).join(" AND ") || "(always)",
      marketData: [...new Set(market)].sort(), inputs: by("INPUT"), indicators: by("INDICATOR"), indicatorCalls, conditions: by("CONDITION"), values: by("VALUE"), dependsOnMarket: market.length > 0 || indicatorCalls.length > 0 };
  });

  // Logical contradictions between signals.
  const contradictions: Finding[] = [];
  const longE = signals.filter((s) => s.kind === "ENTRY" && s.direction === "LONG");
  const shortE = signals.filter((s) => s.kind === "ENTRY" && s.direction === "SHORT");
  for (const l of longE) for (const sh of shortE) {
    const lk = l.guards.map(exprKey).sort().join("&"), sk = sh.guards.map(exprKey).sort().join("&");
    if (lk === sk) contradictions.push({ code: "LOGICAL_CONTRADICTION", severity: "ERROR", message: `BUY (line ${l.line}) and SELL (line ${sh.line}) fire under identical conditions: ${lk || "(always)"}`, line: sh.line, col: 0 });
  }
  for (const s of signals) {
    const g = s.guards.length ? s.guards.reduce((a, b) => ({ k: "bin", op: "and", a, b, loc: b.loc }) as Expr) : null;
    const why = g ? contradiction(g) : null;
    if (why) contradictions.push({ code: "LOGICAL_CONTRADICTION", severity: "ERROR", message: `${s.kind} at line ${s.line} can never fire: ${why}`, line: s.line, col: 0 });
  }

  const symbols = [...table.values()].sort((a, b) => a.line - b.line);
  const err = (c: string) => findings.filter((f) => f.code === c).length;
  return {
    symbols, findings, contradictions, flows,
    signals: signals.map((s) => ({ kind: s.kind, id: s.id, direction: s.direction, fn: s.fn, line: s.line, guard: s.guards.map(exprKey).join(" AND ") })),
    cfg: { nodes: cfgNodes, edges: cfgEdges, branches, loops },
    counts: {
      symbols: symbols.length, inputs: symbols.filter((s) => s.kind === "INPUT").length, functions: symbols.filter((s) => s.kind === "FUNCTION").length,
      syntaxErrors: ir.diagnostics.filter((d) => d.code === "PARSE_ERROR").length, unsupported: ir.diagnostics.filter((d) => d.code === "UNSUPPORTED_SEMANTIC").length,
      unresolvedIdentifiers: err("UNDEFINED_VARIABLE"), unused: err("UNUSED_VARIABLE") + err("UNUSED_FUNCTION"), deadCode: err("DEAD_CODE"),
      unreachableConditions: err("UNREACHABLE_CONDITION"), circular: err("CIRCULAR_DEPENDENCY"), contradictions: contradictions.length,
      entries: signals.filter((s) => s.kind === "ENTRY").length, exits: signals.filter((s) => s.kind !== "ENTRY").length,
    },
  };
}
export type StaticReport = ReturnType<typeof analyzeStatic>;

// ---------------------------------------------------------------- classification
const CLASS_RULES: { label: string; test: (fn: string) => boolean; why: string }[] = [
  { label: "Trend Following", test: (f) => /^ta\.(ema|sma|wma|hma|vwma|rma|alma|supertrend|dmi|adx|sar|linreg)$/.test(f), why: "moving-average / trend filter" },
  { label: "Momentum", test: (f) => /^ta\.(rsi|macd|mom|roc|stoch|cci|tsi|mfi|wpr|cmo)$/.test(f), why: "momentum oscillator" },
  { label: "Mean Reversion", test: (f) => /^ta\.(bb|bbw|stdev|dev|percentrank)$/.test(f), why: "deviation-from-mean band" },
  { label: "Breakout", test: (f) => /^ta\.(highest|lowest|highestbars|lowestbars)$/.test(f), why: "range high/low breakout" },
  { label: "Pivot/Level Based", test: (f) => /^ta\.(pivothigh|pivotlow|pivot_point_levels)$|^request\.security$/.test(f), why: "pivot or higher-timeframe level" },
  { label: "Volatility", test: (f) => /^ta\.(atr|tr|kc|kcw|bbw|stdev)$/.test(f), why: "volatility measure" },
];
export function classifyStrategy(ir: StrategyIR, st: StaticReport, timeframe?: string) {
  const score = new Map<string, { score: number; evidence: string[] }>();
  const add = (label: string, w: number, ev: string) => { const s = score.get(label) ?? { score: 0, evidence: [] }; s.score += w; if (!s.evidence.includes(ev)) s.evidence.push(ev); score.set(label, s); };
  const signalCalls = new Set(st.flows.flatMap((f) => f.indicatorCalls));
  for (const ind of ir.indicators) for (const r of CLASS_RULES) if (r.test(ind.fn)) add(r.label, signalCalls.has(ind.fn) ? 2 : 1, `${ind.call} (line ${ind.line}) — ${r.why}${signalCalls.has(ind.fn) ? ", drives a signal" : ""}`);
  for (const t of ir.timeframeRules) add("Pivot/Level Based", 1, `${t.detail} (line ${t.line})`);
  for (const f of st.flows) {
    if (/crossover|crossunder/.test(f.guard) && /ema|sma|wma|hma/.test(f.indicatorCalls.join())) add("Trend Following", 2, `${f.signal}: moving-average cross — ${f.guard}`);
    if (/rsi|stoch|cci|wpr/.test(f.indicatorCalls.join()) && /\b(20|25|30|70|75|80)\b|lo|hi|oversold|overbought/i.test(f.guard)) add("Mean Reversion", 1, `${f.signal}: oscillator threshold — ${f.guard}`);
    if (/highest|lowest/.test(f.indicatorCalls.join()) && /close/.test(f.guard)) add("Breakout", 2, `${f.signal}: price vs range extreme — ${f.guard}`);
    if (/\b(r[1-4]|s[1-4]|pivot|pp|camarilla)\b/i.test(f.guard + f.values.join(" "))) add("Pivot/Level Based", 2, `${f.signal}: level names in guard — ${f.guard}`);
  }
  if (timeframe && /^(1m|3m|5m)$/.test(timeframe)) add("Scalping", 2, `chart timeframe ${timeframe}`);
  if (ir.sessionRules.length && timeframe && /^(1m|3m|5m|15m)$/.test(timeframe)) add("Scalping", 1, `session filter on ${timeframe}`);
  const ranked = [...score.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.score - a.score);
  const strong = ranked.filter((r) => r.score >= Math.max(2, (ranked[0]?.score ?? 0) * 0.6));
  const primary = strong.length >= 2 ? "Hybrid" : strong[0]?.label ?? "Unclassified";
  return { primary, components: strong.map((s) => s.label), ranked, rule: "score = 2 per signal-driving construct, 1 per auxiliary; Hybrid when ≥2 families score ≥60% of the top" };
}
