// Unified Strategy IR — language-independent executable representation.
// Pine is compiled to executable IR; other languages get static extraction and
// an explicit UNSUPPORTED_SEMANTIC for execution (never replaced by generic logic).

import { parsePine, exprText, type Diagnostic, type Expr, type Stmt } from "./pine";
import { detectLanguage, type Language } from "../parser";

export const IR_VERSION = "use-ir-1.0.0";

/** Functions the semantic engine executes exactly. Anything else → UNSUPPORTED_SEMANTIC. */
export const SUPPORTED_FUNCS = new Set([
  "strategy", "indicator", "input", "input.int", "input.float", "input.bool", "input.string", "input.source", "input.session", "input.color", "input.timeframe", "input.symbol", "input.text_area",
  "ta.ema", "ta.sma", "ta.rma", "ta.wma", "ta.rsi", "ta.atr", "ta.tr", "ta.macd", "ta.bb", "ta.stdev", "ta.highest", "ta.lowest",
  "ta.crossover", "ta.crossunder", "ta.cross", "ta.change", "ta.pivothigh", "ta.pivotlow", "ta.barssince", "ta.valuewhen", "ta.cum", "ta.vwap", "ta.supertrend",
  "ta.rising", "ta.falling",
  "math.abs", "math.max", "math.min", "math.round", "math.floor", "math.ceil", "math.sqrt", "math.log", "math.exp", "math.pow", "math.sign", "math.avg",
  "nz", "na", "fixnan", "time",
  "int", "float", "bool", "string", "str.tostring", "str.format_time",
  "request.security",
  "strategy.entry", "strategy.exit", "strategy.close", "strategy.close_all", "strategy.cancel", "strategy.cancel_all",
]);
/** Visual / alert output: no trading semantics, skipped explicitly. */
export const IGNORED_FUNCS = /^(plot|plotshape|plotchar|plotarrow|plotcandle|plotbar|hline|fill|bgcolor|barcolor|alert|alertcondition|label\.|line\.|box\.|table\.|color\.|log\.|runtime\.log)/;

/** Pine timeframe strings → engine timeframe ids. */
export const PINE_TF: Record<string, string> = { "1": "1m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "240": "4h", "D": "1D", "1D": "1D", "W": "1W", "1W": "1W", "M": "1M", "1M": "1M" };

export type IRInput = { name: string; kind: string; default: unknown; title: string | null; line: number };
export type IRRule = { id: string | null; guard: string; text: string; line: number; [k: string]: unknown };

export type StrategyIR = {
  irVersion: string;
  strategyId: string | null;
  strategyVersion: number | null;
  sourceLanguage: Language;
  languageVersion: number | null;
  sourceHash: string;
  executable: boolean;
  /** Script kind, independent of executability. */
  scriptType: "STRATEGY" | "INDICATOR" | "LIBRARY" | "UNKNOWN";
  /** Code validity (syntax + declaration), independent of whether it has orders. */
  validity: "VALID_STRATEGY" | "VALID_INDICATOR" | "VALID_LIBRARY" | "INVALID_CODE";
  notExecutableReason: string | null;
  declaration: Record<string, unknown> | null;
  inputs: IRInput[];
  indicators: { fn: string; call: string; line: number }[];
  states: { name: string; type: string | null; init: string; persistent: boolean; line: number }[];
  variables: { name: string; expr: string; line: number }[];
  entryRules: IRRule[];
  exitRules: IRRule[];
  riskRules: IRRule[];
  timeframeRules: { kind: string; detail: string; line: number }[];
  sessionRules: { kind: string; detail: string; line: number }[];
  crossovers: { fn: string; call: string; line: number }[];
  lookbacks: { expr: string; offset: string; line: number }[];
  functions: { name: string; params: string[]; line: number }[];
  loops: { kind: string; line: number }[];
  maxLookback: number;
  ignored: { fn: string; line: number }[];
  diagnostics: Diagnostic[];
  program: Stmt[];
};

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lit(e: Expr | undefined): unknown {
  if (!e) return null;
  if (e.k === "num" || e.k === "str" || e.k === "bool") return e.v;
  if (e.k === "un" && e.op === "-" && e.a.k === "num") return -e.a.v;
  if (e.k === "na") return null;
  return exprText(e);
}

export async function buildIR(code: string, meta: { strategyId?: string | null; version?: number | null; language?: string | null } = {}): Promise<StrategyIR> {
  const lang = ((meta.language && meta.language !== "unknown" ? meta.language : detectLanguage(code)) as Language);
  const ir: StrategyIR = {
    irVersion: IR_VERSION, strategyId: meta.strategyId ?? null, strategyVersion: meta.version ?? null,
    sourceLanguage: lang, languageVersion: null, sourceHash: await sha256(code), executable: false, scriptType: "UNKNOWN", validity: "INVALID_CODE", notExecutableReason: null,
    declaration: null, inputs: [], indicators: [], states: [], variables: [], entryRules: [], exitRules: [], riskRules: [],
    timeframeRules: [], sessionRules: [], crossovers: [], lookbacks: [], functions: [], loops: [], maxLookback: 0, ignored: [], diagnostics: [], program: [],
  };
  if (lang !== "pinescript") {
    ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: `${lang} semantic execution (static extraction only)`, line: 1, col: 1, text: (code.split("\n")[0] ?? "").trim() });
    return ir;
  }
  const parsed = parsePine(code);
  ir.languageVersion = parsed.version;
  ir.program = parsed.program;
  ir.diagnostics.push(...parsed.diagnostics);
  if (parsed.version !== null && parsed.version < 5) ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: `Pine v${parsed.version} (v5/v6 only)`, line: 1, col: 1, text: `//@version=${parsed.version}` });
  const line = (l: number) => (parsed.lines[l - 1] ?? "").trim();
  let cid = 0;
  const userVars = new Set<string>();
  const userFns = new Map<string, number>();
  for (const st of parsed.program) if (st.k === "fn") userFns.set(st.name, st.params.length);
  const udts = new Map<string, Set<string>>();
  for (const st of parsed.program) if (st.k === "type") udts.set(st.name, new Set(st.fields.map((f) => f.name)));
  let loopDepth = 0;
  const inputNames = new Set<string>();
  const unsup = (construct: string, l: { line: number; col: number }) => ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct, line: l.line, col: l.col, text: line(l.line) });
  /** request.security expression may only use builtins, inputs, literals and supported functions. */
  const secSafe = (e: Expr, l: { line: number; col: number }) => {
    const visit = (x: Expr): void => {
      if (x.k === "id" && userVars.has(x.name) && !inputNames.has(x.name)) unsup(`request.security expression references script variable '${x.name}' (inline the expression)`, x.loc);
      if (x.k === "call") { if (userFns.has(x.fn) || x.fn.startsWith("strategy.") || x.fn.startsWith("request.")) unsup(`request.security expression calls ${x.fn}()`, x.loc); x.args.forEach(visit); Object.values(x.named).forEach(visit); }
      if (x.k === "idx") { visit(x.target); visit(x.offset); }
      if (x.k === "bin") { visit(x.a); visit(x.b); }
      if (x.k === "un") visit(x.a);
      if (x.k === "tern") { visit(x.c); visit(x.a); visit(x.b); }
      if (x.k === "tuplelit") x.items.forEach(visit);
    };
    visit(e); void l;
  };

  const walkExpr = (e: Expr, guard: string) => {
    switch (e.k) {
      case "call": {
        e.cid = cid++;
        if (IGNORED_FUNCS.test(e.fn)) { ir.ignored.push({ fn: e.fn, line: e.loc.line }); return; }
        if (userFns.has(e.fn)) {
          if (userFns.get(e.fn) !== e.args.length || Object.keys(e.named).length) unsup(`call ${e.fn}() argument count/named args`, e.loc);
          e.args.forEach((a) => walkExpr(a, guard)); return;
        }
        const ctor = e.fn.match(/^([A-Za-z_]\w*)\.new$/);
        if (ctor && udts.has(ctor[1]!)) {
          const fields = udts.get(ctor[1]!)!;
          if (e.args.length > fields.size) unsup(`${e.fn}() too many arguments`, e.loc);
          for (const k of Object.keys(e.named)) if (!fields.has(k)) unsup(`${e.fn}() unknown field '${k}'`, e.loc);
          e.args.forEach((a) => walkExpr(a, guard)); Object.values(e.named).forEach((a) => walkExpr(a, guard)); return;
        }
        if (loopDepth > 0 && (e.fn.startsWith("ta.") || e.fn.startsWith("request."))) unsup(`${e.fn}() inside loop (series state per iteration is ambiguous)`, e.loc);
        if (e.fn === "request.security") {
          const tf = lit(e.named["timeframe"] ?? e.args[1]);
          const la = e.named["lookahead"] ? exprText(e.named["lookahead"]) : "barmerge.lookahead_off";
          const gaps = e.named["gaps"] ? exprText(e.named["gaps"]) : "barmerge.gaps_off";
          const sym = exprText(e.named["symbol"] ?? e.args[0] ?? { k: "na", loc: e.loc });
          const ex0 = e.named["expression"] ?? e.args[2];
          // lookahead_on is only leak-free with the canonical history offset X[n≥1] (previous confirmed HTF bar).
          const laSafe = la === "barmerge.lookahead_on" && ex0?.k === "idx" && ex0.offset.k === "num" && ex0.offset.v >= 1;
          if (la !== "barmerge.lookahead_off" && !laSafe) unsup(`request.security lookahead=${la} (future leak; only allowed as expr[n≥1])`, e.loc);
          if (gaps !== "barmerge.gaps_off") unsup(`request.security gaps=${gaps}`, e.loc);
          if (!["syminfo.tickerid", "syminfo.ticker"].includes(sym)) unsup(`request.security other symbol ${sym}`, e.loc);
          if (typeof tf !== "string" || !PINE_TF[tf]) unsup(`request.security timeframe ${String(tf)}`, e.loc);
          const ex = e.named["expression"] ?? e.args[2];
          if (!ex) unsup("request.security without expression", e.loc); else secSafe(ex, e.loc);
          ir.timeframeRules.push({ kind: "MTF_REQUEST", detail: `${typeof tf === "string" ? PINE_TF[tf] ?? tf : tf} · ${la === "barmerge.lookahead_on" ? "lookahead_on with [n≥1] (previous HTF bar, no leak)" : "lookahead_off"} · confirmed HTF bars only · ${ex ? exprText(ex) : ""}`, line: e.loc.line });
          if (ex) walkExpr(ex, guard);
          return;
        }
        if (!SUPPORTED_FUNCS.has(e.fn)) ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: `function ${e.fn}()`, line: e.loc.line, col: e.loc.col, text: line(e.loc.line) });
        if (e.fn === "strategy" || e.fn === "indicator") {
          ir.declaration = { kind: e.fn, title: lit(e.args[0]), ...Object.fromEntries(Object.entries(e.named).map(([k, v]) => [k, lit(v)])) };
          const pyr = Number(e.named["pyramiding"] && lit(e.named["pyramiding"]));
          if (lit(e.named["process_orders_on_close"]) === true) ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: "process_orders_on_close=true (engine fills on next bar)", line: e.loc.line, col: e.loc.col, text: line(e.loc.line) });
          if (pyr > 1) ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: `pyramiding=${pyr} (only 0/1)`, line: e.loc.line, col: e.loc.col, text: line(e.loc.line) });
          return;
        }
        if (e.fn.startsWith("ta.")) {
          ir.indicators.push({ fn: e.fn, call: exprText(e), line: e.loc.line });
          if (/cross/.test(e.fn)) ir.crossovers.push({ fn: e.fn, call: exprText(e), line: e.loc.line });
        }
        if (e.fn === "time") {
          const tz = e.named["timezone"] ?? e.args[2];
          const tzv = lit(tz);
          if (tzv !== "UTC" && tzv !== "GMT+0" && tzv !== "Etc/UTC") ir.diagnostics.push({ code: "UNSUPPORTED_SEMANTIC", construct: "time(session) without explicit \"UTC\" timezone", line: e.loc.line, col: e.loc.col, text: line(e.loc.line) });
          ir.sessionRules.push({ kind: "SESSION_FILTER", detail: exprText(e), line: e.loc.line });
        }
        if (e.fn.startsWith("strategy.")) {
          const named = Object.fromEntries(Object.entries(e.named).map(([k, v]) => [k, exprText(v)]));
          const rule: IRRule = { id: e.args[0] ? String(lit(e.args[0])) : null, guard, text: exprText(e), line: e.loc.line, ...named };
          if (e.fn === "strategy.entry") {
            const dir = e.args[1] ? exprText(e.args[1]) : named["direction"];
            ir.entryRules.push({ ...rule, direction: dir === "strategy.long" ? "LONG" : dir === "strategy.short" ? "SHORT" : dir, orderType: named["limit"] ? "LIMIT" : named["stop"] ? "STOP" : "MARKET" });
          } else if (e.fn === "strategy.exit") {
            const r = { ...rule, fromEntry: e.args[1] ? lit(e.args[1]) : named["from_entry"] ?? null, kind: "EXIT" };
            ir.exitRules.push(r);
            for (const k of ["stop", "limit", "profit", "loss", "trail_points", "trail_offset", "trail_price"]) if (named[k]) ir.riskRules.push({ id: rule.id, guard, text: `${k} = ${named[k]}`, line: e.loc.line, kind: k });
          } else ir.exitRules.push({ ...rule, kind: e.fn.replace("strategy.", "").toUpperCase() });
        }
        if (e.fn.startsWith("input")) { /* recorded at decl */ }
        e.args.forEach((a) => walkExpr(a, guard));
        Object.values(e.named).forEach((a) => walkExpr(a, guard));
        return;
      }
      case "idx": {
        e.cid = cid++;
        const off = lit(e.offset);
        ir.lookbacks.push({ expr: exprText(e.target), offset: String(off), line: e.loc.line });
        if (typeof off === "number") ir.maxLookback = Math.max(ir.maxLookback, off);
        walkExpr(e.target, guard); walkExpr(e.offset, guard); return;
      }
      case "bin": walkExpr(e.a, guard); walkExpr(e.b, guard); return;
      case "un": walkExpr(e.a, guard); return;
      case "tern": walkExpr(e.c, guard); walkExpr(e.a, guard); walkExpr(e.b, guard); return;
      case "tuplelit": e.items.forEach((x) => walkExpr(x, guard)); return;
      case "switch": if (e.subj) walkExpr(e.subj, guard); e.cases.forEach((c) => { if (c.when) walkExpr(c.when, guard); walkExpr(c.val, guard); }); return;
      default: return;
    }
  };

  const walk = (stmts: Stmt[], guard: string) => {
    for (const s of stmts) {
      if (s.k === "decl") {
        userVars.add(s.name);
        if (s.expr.k === "call" && s.expr.fn.startsWith("input")) {
          const title = lit(s.expr.named["title"] ?? s.expr.args[1]);
          inputNames.add(s.name);
          ir.inputs.push({ name: s.name, kind: s.expr.fn, default: lit(s.expr.named["defval"] ?? s.expr.args[0]), title: typeof title === "string" ? title : null, line: s.loc.line });
        } else if (s.persistent) ir.states.push({ name: s.name, type: s.typ, init: exprText(s.expr), persistent: true, line: s.loc.line });
        else ir.variables.push({ name: s.name, expr: exprText(s.expr), line: s.loc.line });
        walkExpr(s.expr, guard);
      } else if (s.k === "tuple") { s.names.forEach((n) => userVars.add(n)); ir.variables.push({ name: `[${s.names.join(", ")}]`, expr: exprText(s.expr), line: s.loc.line }); walkExpr(s.expr, guard); }
      else if (s.k === "assign") {
        const base = s.name.split(".")[0]!;
        if (!ir.states.some((x) => x.name === s.name) && !userVars.has(s.name) && !(s.name.includes(".") && userVars.has(base))) ir.diagnostics.push({ code: "PARSE_ERROR", construct: `assignment to undeclared '${s.name}'`, line: s.loc.line, col: s.loc.col, text: line(s.loc.line) });
        walkExpr(s.expr, guard);
      } else if (s.k === "if") {
        const g = exprText(s.cond);
        walkExpr(s.cond, guard);
        walk(s.then, guard ? `${guard} and ${g}` : g);
        if (s.else) walk(s.else, guard ? `${guard} and not ${g}` : `not ${g}`);
      } else if (s.k === "for" || s.k === "while") {
        ir.loops.push({ kind: s.k, line: s.loc.line });
        if (s.k === "for") { userVars.add(s.v); walkExpr(s.from, guard); walkExpr(s.to, guard); if (s.step) walkExpr(s.step, guard); }
        else walkExpr(s.cond, guard);
        loopDepth++; walk(s.body, guard); loopDepth--;
      } else if (s.k === "break" || s.k === "continue") {
        if (!loopDepth) ir.diagnostics.push({ code: "PARSE_ERROR", construct: `${s.k} outside loop`, line: s.loc.line, col: s.loc.col, text: line(s.loc.line) });
      } else if (s.k === "type") {
        for (const f of s.fields) if (f.def) walkExpr(f.def, guard);
      } else if (s.k === "fn") {
        ir.functions.push({ name: s.name, params: s.params, line: s.loc.line });
        const saved = new Set(userVars); s.params.forEach((x) => userVars.add(x));
        walk(s.body, guard);
        userVars.clear(); saved.forEach((x) => userVars.add(x));
      } else walkExpr(s.expr, guard);
    }
  };
  walk(parsed.program, "");
  ir.timeframeRules.unshift({ kind: "CHART_TIMEFRAME", detail: "script runs on the selected chart timeframe; confirmed bars only", line: 0 });
  const isLibrary = /^\s*library\s*\(/m.test(code);
  if (!ir.declaration && !isLibrary) ir.diagnostics.push({ code: "PARSE_ERROR", construct: "missing strategy()/indicator()/library() declaration", line: 1, col: 1, text: line(1) });
  const kind = ir.declaration?.["kind"];
  ir.scriptType = kind === "strategy" ? "STRATEGY" : kind === "indicator" ? "INDICATOR" : isLibrary ? "LIBRARY" : "UNKNOWN";
  const parseErr = ir.diagnostics.some((d) => d.code === "PARSE_ERROR" && !(isLibrary && /export|import/.test(d.construct)));
  ir.validity = parseErr || ir.scriptType === "UNKNOWN" ? "INVALID_CODE" : ir.scriptType === "STRATEGY" ? "VALID_STRATEGY" : ir.scriptType === "INDICATOR" ? "VALID_INDICATOR" : "VALID_LIBRARY";
  ir.executable = kind === "strategy" && !ir.diagnostics.length && ir.entryRules.length > 0;
  ir.notExecutableReason = ir.executable ? null
    : ir.validity === "INVALID_CODE" ? "INVALID_CODE"
    : ir.scriptType === "INDICATOR" ? "INDICATOR_ONLY — no trading orders"
    : ir.scriptType === "LIBRARY" ? "LIBRARY — no trading orders"
    : ir.diagnostics.length ? "UNSUPPORTED_SEMANTIC" : "STRATEGY has no strategy.entry() orders";
  return ir;
}

/** IR without the executable tree (for storage/UI). */
export function irSummary(ir: StrategyIR) {
  const { program: _p, ...rest } = ir;
  return rest;
}
