// Semantic Execution Engine — runs StrategyIR bar-by-bar on confirmed candles.
// Semantics: script evaluates at bar close (confirmed only, no intrabar/repaint), `var`
// state persists, history `x[n]` reads stored past values, ta.* keep per-call-site state
// (Pine call-count semantics), orders created at bar t are handed to the broker for t+1.
// Lookahead is structurally impossible: bar i only ever sees candles[0..i].

import type { Candle } from "../types";
import type { Expr, Stmt } from "./pine";
import { PINE_TF, type StrategyIR } from "./ir";
import { timeframeSeconds } from "../timeframes";

/** UDT instance: reference semantics like Pine objects (shared by all holders, fields mutable). */
export type UdtObj = { __udt: string; f: Record<string, V> };
export type V = number | boolean | string | null | V[] | UdtObj;
const isObj = (v: unknown): v is UdtObj => !!v && typeof v === "object" && !Array.isArray(v) && "__udt" in (v as object);
export type OrderIntent =
  | { kind: "entry"; id: string; dir: 1 | -1; qty: number | null; limit: number | null; stop: number | null; line: number }
  | { kind: "exit"; id: string; from: string | null; stop: number | null; limit: number | null; profit: number | null; loss: number | null; trailPoints: number | null; trailOffset: number | null; line: number }
  | { kind: "close"; id: string; line: number }
  | { kind: "close_all"; line: number }
  | { kind: "cancel"; id: string; line: number }
  | { kind: "cancel_all"; line: number };
export type BrokerView = { positionSize: number; avgPrice: number | null; equity: number; openTrades: number };

export class SemanticError extends Error {
  constructor(public line: number, msg: string) { super(`line ${line}: ${msg}`); }
}

const isNa = (v: V | undefined): v is null => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));
const num = (v: V | undefined): number | null => (isNa(v) ? null : typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : null);
const truthy = (v: V | undefined) => v === true || (typeof v === "number" && Number.isFinite(v) && v !== 0);

type VarSlot = { hist: V[]; persistent: boolean; inited: boolean };
type Frame = { vars: Map<string, VarSlot>; prefix: string };
type Ctl = "break" | "continue" | null;
type FnDef = Extract<Stmt, { k: "fn" }>;
type TypeDef = Extract<Stmt, { k: "type" }>;
type Security = { ends: number[]; vals: V[]; ptr: number; starts?: number[]; on?: boolean };

const MAX_LOOP = 10_000;

/** Bucket start/end (UTC) for an HTF id. 1W starts Monday, 1M calendar month. */
export function htfBucket(ts: number, tf: string, seconds: number): [number, number] {
  const d = new Date(ts);
  if (tf === "1W") { const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return [s, s + 7 * 86_400_000]; }
  if (tf === "1M") return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
  const ms = seconds * 1000; const s = Math.floor(ts / ms) * ms; return [s, s + ms];
}

/** UTC offset (ms) of America/New_York at instant ts. */
function nyOffset(ts: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const g = (t: string) => +p.find((x) => x.type === t)!.value;
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ts / 1000) * 1000;
}

/** Forex daily session bucket: 17:00 New York → 17:00 New York (TradingView/OANDA convention). */
export function fxDayBucket(ts: number): [number, number] {
  const off = nyOffset(ts); // constant within a session (DST switches happen while FX is closed)
  const shifted = ts + off + 7 * 3_600_000; // 17:00 NY → midnight
  const start = Math.floor(shifted / 86_400_000) * 86_400_000 - 7 * 3_600_000 - off;
  return [start, start + 86_400_000];
}

export type RuntimeMeta = { tickerid: string; timeframe: string; market?: string; presets?: Record<string, V> };

export class PineRuntime {
  private globals: Frame = { vars: new Map(), prefix: "" };
  private frame: Frame = this.globals;
  private instances = new Map<string, { vars: Map<string, VarSlot>; lastBar: number }>();
  private fns = new Map<string, FnDef>();
  private udts = new Map<string, TypeDef>();
  private sec = new Map<string, Security>();
  private depth = 0;
  private st = new Map<string, Record<string, unknown>>();
  private intents: OrderIntent[] = [];
  private i = 0;
  private broker: BrokerView = { positionSize: 0, avgPrice: null, equity: 0, openTrades: 0 };

  constructor(private ir: StrategyIR, private c: Candle[], private params: Record<string, unknown>, private mintick: number, private meta: RuntimeMeta) {
    for (const s of ir.program) { if (s.k === "fn") this.fns.set(s.name, s); if (s.k === "type") this.udts.set(s.name, s); }
    for (const [k, v] of Object.entries(meta.presets ?? {})) this.globals.vars.set(k, { hist: [v], persistent: true, inited: true });
  }

  step(i: number, broker: BrokerView): OrderIntent[] {
    this.i = i; this.broker = broker; this.intents = [];
    for (const s of this.globals.vars.values()) s.hist[i] = s.persistent ? (s.hist[i > 0 ? i - 1 : 0] ?? null) : null;
    this.exec(this.ir.program);
    return this.intents;
  }

  /** Values of declared input variables (for HTF sub-runtimes). */
  inputValues(): Record<string, V> {
    const out: Record<string, V> = {};
    for (const inp of this.ir.inputs) { const sl = this.globals.vars.get(inp.name); if (sl) out[inp.name] = sl.hist[this.i] ?? null; }
    return out;
  }
  /** Read a global variable at bar i (tests / sub-runtimes). */
  valueAt(name: string, i: number): V { return this.globals.vars.get(name)?.hist[i] ?? null; }

  private slot(name: string) { return this.frame.vars.get(name) ?? (this.frame !== this.globals ? this.globals.vars.get(name) : undefined); }
  private key(cid: number) { return `${this.frame.prefix}:${cid}`; }

  private exec(stmts: Stmt[]): Ctl {
    for (const s of stmts) {
      switch (s.k) {
        case "fn": case "type": break;
        case "break": return "break";
        case "continue": return "continue";
        case "decl": {
          let sl = this.frame.vars.get(s.name);
          if (!sl) { sl = { hist: [], persistent: s.persistent, inited: false }; this.frame.vars.set(s.name, sl); }
          if (s.persistent && sl.inited) break;
          let v: V;
          if (s.expr.k === "call" && s.expr.fn.startsWith("input") && this.params[s.name] !== undefined) v = this.params[s.name] as V;
          else v = this.ev(s.expr);
          if (s.typ === "int" && typeof v === "number") v = Math.trunc(v);
          sl.hist[this.i] = v; sl.inited = true;
          break;
        }
        case "tuple": {
          const v = this.ev(s.expr);
          if (!Array.isArray(v)) throw new SemanticError(s.loc.line, "tuple destructuring of non-tuple");
          s.names.forEach((n, k) => {
            let sl = this.frame.vars.get(n);
            if (!sl) { sl = { hist: [], persistent: false, inited: true }; this.frame.vars.set(n, sl); }
            sl.hist[this.i] = v[k] ?? null;
          });
          break;
        }
        case "assign": {
          if (!this.slot(s.name) && s.name.includes(".")) {
            const obj = this.fieldOwner(s.name, s.loc.line);
            const field = s.name.slice(s.name.lastIndexOf(".") + 1);
            const rhs = this.ev(s.expr);
            if (s.op === ":=") obj.f[field] = rhs;
            else { const a = num(obj.f[field]); const b = num(rhs); obj.f[field] = a === null || b === null ? null : s.op === "+=" ? a + b : s.op === "-=" ? a - b : s.op === "*=" ? a * b : b === 0 ? null : a / b; }
            break;
          }
          const sl = this.slot(s.name);
          if (!sl) throw new SemanticError(s.loc.line, `assignment to undeclared '${s.name}'`);
          const rhs = this.ev(s.expr);
          if (s.op === ":=") sl.hist[this.i] = rhs;
          else {
            const a = num(sl.hist[this.i]); const b = num(rhs);
            sl.hist[this.i] = a === null || b === null ? null : s.op === "+=" ? a + b : s.op === "-=" ? a - b : s.op === "*=" ? a * b : b === 0 ? null : a / b;
          }
          break;
        }
        case "if": {
          const r = truthy(this.ev(s.cond)) ? this.exec(s.then) : s.else ? this.exec(s.else) : null;
          if (r) return r;
          break;
        }
        case "for": {
          const from = num(this.ev(s.from)); const to = num(this.ev(s.to));
          if (from === null || to === null) break;
          const stepV = s.step ? num(this.ev(s.step)) : (to >= from ? 1 : -1);
          if (!stepV) throw new SemanticError(s.loc.line, "for step must be non-zero");
          let sl = this.frame.vars.get(s.v);
          if (!sl) { sl = { hist: [], persistent: false, inited: true }; this.frame.vars.set(s.v, sl); }
          let n = 0;
          for (let x = from; stepV > 0 ? x <= to : x >= to; x += stepV) {
            if (++n > MAX_LOOP) throw new SemanticError(s.loc.line, `loop exceeded ${MAX_LOOP} iterations`);
            sl.hist[this.i] = x;
            const r = this.exec(s.body);
            if (r === "break") break;
          }
          break;
        }
        case "while": {
          let n = 0;
          while (truthy(this.ev(s.cond))) {
            if (++n > MAX_LOOP) throw new SemanticError(s.loc.line, `loop exceeded ${MAX_LOOP} iterations`);
            const r = this.exec(s.body);
            if (r === "break") break;
          }
          break;
        }
        case "expr": this.ev(s.expr); break;
      }
    }
    return null;
  }

  /** User function call: each call site owns its own locals + ta state (Pine semantics). */
  private callUser(fn: FnDef, e: Extract<Expr, { k: "call" }>): V {
    if (++this.depth > 32) throw new SemanticError(e.loc.line, "recursion is not allowed in Pine");
    const args = e.args.map((a) => this.ev(a));
    const prefix = `${this.frame.prefix}/${e.cid}`;
    let inst = this.instances.get(prefix);
    if (!inst) { inst = { vars: new Map(), lastBar: -1 }; this.instances.set(prefix, inst); }
    if (inst.lastBar !== this.i) {
      for (const sl of inst.vars.values()) sl.hist[this.i] = sl.persistent ? (sl.hist[inst.lastBar] ?? null) : null;
      inst.lastBar = this.i;
    }
    fn.params.forEach((p, k) => {
      let sl = inst!.vars.get(p);
      if (!sl) { sl = { hist: [], persistent: false, inited: true }; inst!.vars.set(p, sl); }
      sl.hist[this.i] = args[k] ?? null;
    });
    const saved = this.frame;
    this.frame = { vars: inst.vars, prefix };
    try {
      const body = fn.body;
      const last = body[body.length - 1];
      const lead = last && (last.k === "expr" || last.k === "decl") ? body.slice(0, -1) : body;
      this.exec(lead);
      if (!last) return null;
      if (last.k === "expr") return this.ev(last.expr);
      if (last.k === "decl") { this.exec([last]); return this.frame.vars.get(last.name)?.hist[this.i] ?? null; }
      return null;
    } finally { this.frame = saved; this.depth--; }
  }

  /** request.security with lookahead_off: only HTF bars whose close ≤ current chart-bar close. */
  private security(e: Extract<Expr, { k: "call" }>): V {
    const k = this.key(e.cid!);
    let s = this.sec.get(k);
    if (!s) {
      const tfLit = (e.named["timeframe"] ?? e.args[1]) as Expr;
      const tf = PINE_TF[tfLit.k === "str" ? tfLit.v : ""];
      if (!tf) throw new SemanticError(e.loc.line, "request.security timeframe");
      const htfSec = timeframeSeconds(tf); const chartSec = timeframeSeconds(this.meta.timeframe);
      if (!(htfSec >= chartSec)) throw new SemanticError(e.loc.line, `request.security ${tf} is lower than chart ${this.meta.timeframe} (use request.security_lower_tf — unsupported)`);
      const fxDaily = this.meta.market === "forex" && tf === "1D";
      if (this.meta.market && this.meta.market !== "crypto" && htfSec > 3600 && !fxDaily) throw new SemanticError(e.loc.line, `UNSUPPORTED_SEMANTIC session-aligned ${tf} buckets for ${this.meta.market} markets are not implemented (only ≤1h HTF outside 24/7 crypto)`);
      // Build HTF candles strictly from the verified chart candles.
      const buckets: Candle[] = []; const ends: number[] = [];
      for (const c of this.c) {
        const [b0, b1] = fxDaily ? fxDayBucket(c.ts) : htfBucket(c.ts, tf, htfSec);
        const last = buckets[buckets.length - 1];
        if (!last || last.ts !== b0) { buckets.push({ ts: b0, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }); ends.push(b1); }
        else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; if (c.volume != null) last.volume = (last.volume ?? 0) + c.volume; }
      }
      const ex = (e.named["expression"] ?? e.args[2]) as Expr;
      const sub = new PineRuntime({ ...this.ir, program: [{ k: "decl", name: "__sec", persistent: false, typ: null, expr: ex, loc: e.loc }] }, buckets, {}, this.mintick, { tickerid: this.meta.tickerid, timeframe: tf, ...(this.meta.market ? { market: this.meta.market } : {}), presets: this.inputValues() });
      const vals: V[] = buckets.map((_, j) => { sub.step(j, this.broker); return sub.valueAt("__sec", j); });
      const la = e.named["lookahead"];
      const on = !!la && la.k !== "str" && JSON.stringify(la).includes("lookahead_on");
      s = { ends, vals, ptr: -1, starts: buckets.map((b) => b.ts), on };
      this.sec.set(k, s);
    }
    if (s.on) {
      // lookahead_on with expr[n≥1] (validated in IR): value of the bucket containing this bar, which only reads completed buckets.
      const t = this.c[this.i]!.ts;
      while (s.ptr + 1 < s.starts!.length && s.starts![s.ptr + 1]! <= t) s.ptr++;
      return s.ptr >= 0 ? s.vals[s.ptr]! : null;
    }
    const closeT = this.c[this.i]!.ts + timeframeSeconds(this.meta.timeframe) * 1000;
    while (s.ptr + 1 < s.ends.length && s.ends[s.ptr + 1]! <= closeT) s.ptr++;
    return s.ptr >= 0 ? s.vals[s.ptr]! : null;
  }

  /** Resolve `a.b.c` → object owning field `c` (a must be a variable holding a UDT object). */
  private fieldOwner(path: string, line: number): UdtObj {
    const parts = path.split(".");
    let v: V | undefined = this.slot(parts[0]!)?.hist[this.i];
    for (let k = 1; k < parts.length - 1; k++) v = isObj(v) ? v.f[parts[k]!] : undefined;
    if (!isObj(v)) throw new SemanticError(line, `'${parts.slice(0, -1).join(".")}' is na or not an object (field access on na)`);
    if (!(parts[parts.length - 1]! in v.f)) throw new SemanticError(line, `type ${v.__udt} has no field '${parts[parts.length - 1]}'`);
    return v;
  }

  private bar(n = 0) { return this.c[this.i - n]; }

  private builtin(name: string, off: number, line: number): V {
    const b = this.bar(off);
    const series: Record<string, () => V> = {
      open: () => b?.open ?? null, high: () => b?.high ?? null, low: () => b?.low ?? null, close: () => b?.close ?? null,
      volume: () => (b && b.volume != null ? b.volume : null),
      hl2: () => (b ? (b.high + b.low) / 2 : null), hlc3: () => (b ? (b.high + b.low + b.close) / 3 : null), ohlc4: () => (b ? (b.open + b.high + b.low + b.close) / 4 : null),
      time: () => b?.ts ?? null, time_close: () => (b ? b.ts + timeframeSeconds(this.meta.timeframe) * 1000 : null), bar_index: () => (b ? this.i - off : null),
      hour: () => (b ? new Date(b.ts).getUTCHours() : null), minute: () => (b ? new Date(b.ts).getUTCMinutes() : null),
      dayofweek: () => (b ? new Date(b.ts).getUTCDay() + 1 : null), dayofmonth: () => (b ? new Date(b.ts).getUTCDate() : null),
      month: () => (b ? new Date(b.ts).getUTCMonth() + 1 : null), year: () => (b ? new Date(b.ts).getUTCFullYear() : null),
    };
    if (series[name]) return series[name]!();
    if (off !== 0) throw new SemanticError(line, `history reference on '${name}' not supported`);
    const consts: Record<string, V> = {
      "strategy.long": 1, "strategy.short": -1, "strategy.position_size": this.broker.positionSize, "strategy.position_avg_price": this.broker.avgPrice,
      "strategy.equity": this.broker.equity, "strategy.opentrades": this.broker.openTrades,
      "syminfo.mintick": this.mintick, "syminfo.tickerid": this.meta.tickerid, "syminfo.ticker": this.meta.tickerid, "timeframe.period": this.meta.timeframe,
      "barstate.isconfirmed": true, "barstate.islast": this.i === this.c.length - 1, "barstate.isfirst": this.i === 0, "barstate.isnew": true, "barstate.isrealtime": false, "barstate.ishistory": true,
      "math.pi": Math.PI, "math.e": Math.E, "ta.tr": this.tr(this.i),
      "dayofweek.sunday": 1, "dayofweek.monday": 2, "dayofweek.tuesday": 3, "dayofweek.wednesday": 4, "dayofweek.thursday": 5, "dayofweek.friday": 6, "dayofweek.saturday": 7,
      "strategy.percent_of_equity": "percent_of_equity", "strategy.fixed": "fixed", "strategy.cash": "cash",
      "barmerge.lookahead_off": "lookahead_off", "barmerge.gaps_off": "gaps_off",
    };
    if (name in consts) return consts[name]!;
    // Historical evaluation happens at bar close: timenow is the confirmed bar's close time (never the wall clock).
    if (name === "timenow") { const cb = this.bar(); return cb ? cb.ts + timeframeSeconds(this.meta.timeframe) * 1000 : null; }
    if (name === "syminfo.timezone") return "Etc/UTC";
    if (name === "format.mintick" || name === "format.percent" || name === "format.volume" || name === "format.price" || name === "format.inherit") return name;
    // Display-only enum constants (drawing/table/alert styling): carried as opaque tokens.
    if (/^(size|position|text|alert|shape|location|display|xloc|yloc|extend|font|plot|line|label|hline|order)\.[a-z_]+$/.test(name)) return name;
    throw new SemanticError(line, `unknown identifier '${name}'`);
  }

  private tr(i: number): number | null {
    const b = this.c[i]; if (!b) return null;
    const p = this.c[i - 1];
    return p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : b.high - b.low;
  }

  private ev(e: Expr): V {
    switch (e.k) {
      case "num": case "str": case "bool": return e.v;
      case "na": return null;
      case "id": {
        const sl = this.slot(e.name);
        if (sl) return sl.hist[this.i] ?? null;
        if (e.name.includes(".") && this.slot(e.name.split(".")[0]!)) { const o = this.fieldOwner(e.name, e.loc.line); return o.f[e.name.slice(e.name.lastIndexOf(".") + 1)] ?? null; }
        return this.builtin(e.name, 0, e.loc.line);
      }
      case "idx": {
        const n = num(this.ev(e.offset));
        if (n === null || n < 0 || !Number.isInteger(n)) throw new SemanticError(e.loc.line, "history offset must be a non-negative integer (no future reference)");
        if (e.target.k === "id") {
          const sl = this.slot(e.target.name);
          if (sl) return this.i - n >= 0 ? (sl.hist[this.i - n] ?? null) : null;
          return this.i - n >= 0 ? this.builtin(e.target.name, n, e.loc.line) : null;
        }
        const s = this.state(e.cid!, () => ({ buf: [] as V[] }));
        const buf = s["buf"] as V[];
        buf[this.i] = this.ev(e.target);
        return this.i - n >= 0 ? (buf[this.i - n] ?? null) : null;
      }
      case "un": {
        const a = this.ev(e.a);
        if (e.op === "not") return !truthy(a);
        const x = num(a); return x === null ? null : e.op === "-" ? -x : x;
      }
      case "bin": {
        if (e.op === "and") return truthy(this.ev(e.a)) && truthy(this.ev(e.b));
        if (e.op === "or") return truthy(this.ev(e.a)) || truthy(this.ev(e.b));
        const a = this.ev(e.a); const b = this.ev(e.b);
        if (e.op === "+" && (typeof a === "string" || typeof b === "string")) return isNa(a) || isNa(b) ? null : String(a) + String(b);
        if (e.op === "==" || e.op === "!=") {
          if (isNa(a) || isNa(b)) return false;
          const eq = typeof a === "number" || typeof b === "number" ? num(a) === num(b) : a === b;
          return e.op === "==" ? eq : !eq;
        }
        const x = num(a); const y = num(b);
        if (x === null || y === null) return ["<", ">", "<=", ">="].includes(e.op) ? false : null;
        switch (e.op) {
          case "+": return x + y; case "-": return x - y; case "*": return x * y;
          case "/": return y === 0 ? null : x / y; case "%": return y === 0 ? null : x % y;
          case "<": return x < y; case ">": return x > y; case "<=": return x <= y; case ">=": return x >= y;
        }
        throw new SemanticError(e.loc.line, `operator ${e.op}`);
      }
      case "tern": return truthy(this.ev(e.c)) ? this.ev(e.a) : this.ev(e.b);
      case "tuplelit": return e.items.map((x) => this.ev(x));
      case "switch": {
        const subj = e.subj ? this.ev(e.subj) : undefined;
        for (const c of e.cases) {
          if (!c.when) return this.ev(c.val);
          const w = this.ev(c.when);
          const hit = e.subj ? (!isNa(subj) && !isNa(w) && (typeof subj === "number" || typeof w === "number" ? num(subj) === num(w) : subj === w)) : truthy(w);
          if (hit) return this.ev(c.val);
        }
        return null;
      }
      case "call": {
        const uf = this.fns.get(e.fn);
        if (uf) return this.callUser(uf, e);
        if (e.fn === "request.security") return this.security(e);
        const ctor = e.fn.endsWith(".new") ? this.udts.get(e.fn.slice(0, -4)) : undefined;
        if (ctor) {
          const o: UdtObj = { __udt: ctor.name, f: {} };
          ctor.fields.forEach((fd, k) => {
            const x = e.named[fd.name] ?? e.args[k];
            let v: V = x ? this.ev(x) : fd.def ? this.ev(fd.def) : null;
            if (fd.typ === "int" && typeof v === "number") v = Math.trunc(v);
            o.f[fd.name] = v;
          });
          return o;
        }
        return this.call(e);
      }
    }
  }

  /** Pine str.tostring: na → "NaN", numeric format masks ("00", "#.##", "0.000"), format.mintick/percent. */
  private toStr(v: V, fmt: V, line: number): string {
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (isObj(v) || Array.isArray(v)) throw new SemanticError(line, "str.tostring of object/array");
    if (isNa(v)) return "NaN";
    const x = v as number;
    if (fmt === null || isNa(fmt)) return Number.isInteger(x) ? String(x) : String(+x.toFixed(10));
    if (fmt === "format.mintick") { const d = Math.max(0, Math.round(-Math.log10(this.mintick))); return x.toFixed(d); }
    if (fmt === "format.percent") return `${x.toFixed(2)}%`;
    if (fmt === "format.price" || fmt === "format.inherit") return String(+x.toFixed(10));
    if (fmt === "format.volume") return String(Math.round(x));
    const m = typeof fmt === "string" ? fmt.match(/^([#0,]*)(?:\.([#0]+))?$/) : null;
    if (!m) throw new SemanticError(line, `str.tostring format '${String(fmt)}' not supported`);
    const intPad = (m[1] ?? "").replace(/[#,]/g, "").length; const dec = m[2] ?? "";
    const req = (dec.match(/0/g) ?? []).length; const max = dec.length;
    let s = x.toFixed(max);
    if (max > req) { s = s.replace(/0+$/, ""); const cur = (s.split(".")[1] ?? "").length; if (cur < req) s = x.toFixed(req); s = s.replace(/\.$/, ""); }
    const neg = s.startsWith("-"); if (neg) s = s.slice(1);
    const [ip, fp] = s.split(".");
    let out = (ip ?? "").padStart(intPad, "0");
    if ((m[1] ?? "").includes(",")) out = out.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + out + (fp ? "." + fp : "");
  }

  private state<T extends Record<string, unknown>>(cid: number, init: () => T): T {
    const k = this.key(cid);
    let s = this.st.get(k);
    if (!s) { s = init(); this.st.set(k, s); }
    return s as T;
  }

  private call(e: Extract<Expr, { k: "call" }>): V {
    const fn = e.fn;
    const A = (k: number, name?: string): V => {
      const x = name && e.named[name] ? e.named[name] : e.args[k];
      return x ? this.ev(x) : null;
    };
    const N = (k: number, name?: string) => num(A(k, name));
    const has = (k: number, name?: string) => !!((name && e.named[name]) || e.args[k]);
    if (/^(plot|plotshape|plotchar|plotarrow|plotcandle|plotbar|hline|fill|bgcolor|barcolor|alert|alertcondition|label\.|line\.|box\.|table\.|color\.|log\.)/.test(fn)) return null;
    const S = this.state(e.cid!, () => ({}) as Record<string, unknown>);
    const push = (key: string, v: V) => { const arr = ((S[key] as V[]) ??= []) as V[]; arr.push(v); return arr; };
    const lenOf = (k: number, name = "length") => { const l = N(k, name); if (l === null || l < 1) throw new SemanticError(e.loc.line, `${fn}: invalid length`); return Math.trunc(l); };
    const smaOf = (arr: V[], len: number) => {
      if (arr.length < len) return null; let s = 0;
      for (let j = arr.length - len; j < arr.length; j++) { const x = num(arr[j]); if (x === null) return null; s += x; }
      return s / len;
    };
    const rmaStep = (key: string, x: number | null, len: number, alpha: number) => {
      const st = ((S[key] as { v: number | null; seed: number[] }) ??= { v: null, seed: [] });
      if (x === null) return st.v;
      if (st.v === null) { st.seed.push(x); if (st.seed.length === len) st.v = st.seed.reduce((a, b) => a + b, 0) / len; return st.v; }
      st.v = alpha * x + (1 - alpha) * st.v; return st.v;
    };

    switch (fn) {
      case "strategy": case "indicator": return null;
      case "input": case "input.int": case "input.float": case "input.bool": case "input.string": case "input.source": case "input.session": case "input.color": case "input.timeframe": case "input.symbol": case "input.text_area":
        return A(0, "defval");
      case "na": return isNa(A(0));
      case "nz": { const v = A(0); return isNa(v) ? (has(1, "replacement") ? A(1, "replacement") : 0) : v; }
      case "fixnan": { const v = A(0); if (!isNa(v)) S["last"] = v; return (S["last"] as V) ?? null; }
      case "math.abs": { const x = N(0); return x === null ? null : Math.abs(x); }
      case "math.sqrt": { const x = N(0); return x === null || x < 0 ? null : Math.sqrt(x); }
      case "math.log": { const x = N(0); return x === null || x <= 0 ? null : Math.log(x); }
      case "math.exp": { const x = N(0); return x === null ? null : Math.exp(x); }
      case "math.sign": { const x = N(0); return x === null ? null : Math.sign(x); }
      case "math.floor": { const x = N(0); return x === null ? null : Math.floor(x); }
      case "math.ceil": { const x = N(0); return x === null ? null : Math.ceil(x); }
      case "math.round": { const x = N(0); if (x === null) return null; const p = N(1, "precision"); const m = p ? 10 ** p : 1; return Math.round(x * m) / m; }
      case "math.pow": { const x = N(0); const y = N(1); return x === null || y === null ? null : x ** y; }
      case "math.max": case "math.min": case "math.avg": {
        const xs = e.args.map((a) => num(this.ev(a)));
        if (xs.some((x) => x === null)) return null;
        const v = xs as number[];
        return fn === "math.max" ? Math.max(...v) : fn === "math.min" ? Math.min(...v) : v.reduce((a, b) => a + b, 0) / v.length;
      }
      case "time": {
        const b = this.bar(); const sess = A(1, "session");
        if (!b) return null;
        if (typeof sess !== "string") return b.ts;
        const m = sess.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})(?::(\d+))?$/);
        if (!m) throw new SemanticError(e.loc.line, `session format '${sess}'`);
        const d = new Date(b.ts); const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
        const s0 = +m[1]! * 60 + +m[2]!; const s1 = +m[3]! * 60 + +m[4]!;
        const inT = s0 <= s1 ? mins >= s0 && mins < s1 : mins >= s0 || mins < s1;
        const inD = !m[5] || m[5].includes(String(d.getUTCDay() + 1));
        return inT && inD ? b.ts : null;
      }
      case "ta.tr": return this.tr(this.i);
      case "int": { const x = N(0); return x === null ? null : Math.trunc(x); }
      case "float": return N(0);
      case "bool": return isNa(A(0)) ? false : truthy(A(0));
      case "string": { const v = A(0); return isNa(v) ? null : String(v); }
      case "str.tostring": return this.toStr(A(0, "value"), has(1, "format") ? A(1, "format") : null, e.loc.line);
      case "str.format_time": {
        const t = N(0, "time"); if (t === null) return null;
        const fmt = String(A(1, "format") ?? "yyyy-MM-dd'T'HH:mm:ssZ"); const tz = has(2, "timezone") ? String(A(2, "timezone")) : "Etc/UTC";
        return formatTime(t, fmt, tz, e.loc.line);
      }
      case "ta.cum": { const x = N(0); S["s"] = ((S["s"] as number) ?? 0) + (x ?? 0); return S["s"] as number; }
      case "ta.sma": { const len = lenOf(1); return smaOf(push("src", A(0, "source")), len); }
      case "ta.wma": {
        const len = lenOf(1); const arr = push("src", A(0, "source"));
        if (arr.length < len) return null; let s = 0; let w = 0;
        for (let j = 0; j < len; j++) { const x = num(arr[arr.length - len + j]); if (x === null) return null; s += x * (j + 1); w += j + 1; }
        return s / w;
      }
      case "ta.ema": { const len = lenOf(1); return rmaStep("e", N(0, "source"), len, 2 / (len + 1)); }
      case "ta.rma": { const len = lenOf(1); return rmaStep("e", N(0, "source"), len, 1 / len); }
      case "ta.atr": { const len = lenOf(0); return rmaStep("e", this.tr(this.i), len, 1 / len); }
      case "ta.supertrend": {
        const factor = N(0, "factor") ?? 3; const len = lenOf(1, "atrPeriod"); const b = this.bar()!;
        const prevAtr = S["pa"] as number | null | undefined;
        const atr = rmaStep("e", this.tr(this.i), len, 1 / len); S["pa"] = atr;
        const pc = this.bar(1)?.close ?? null; const src = (b.high + b.low) / 2;
        if (atr === null) { S["lo"] = null; S["up"] = null; S["st"] = null; return [null, null]; }
        let lo = src - factor * atr; let up = src + factor * atr;
        const pLo = (S["lo"] as number | null) ?? 0; const pUp = (S["up"] as number | null) ?? 0;
        lo = lo > pLo || (pc !== null && pc < pLo) ? lo : pLo;
        up = up < pUp || (pc !== null && pc > pUp) ? up : pUp;
        const pSt = S["st"] as number | null;
        const dir = prevAtr == null ? 1 : pSt === pUp ? (b.close > up ? -1 : 1) : (b.close < lo ? 1 : -1);
        const st = dir === -1 ? lo : up;
        S["lo"] = lo; S["up"] = up; S["st"] = st;
        return [st, dir];
      }
      case "ta.rsi": {
        const len = lenOf(1); const x = N(0, "source"); const prev = S["prev"] as number | undefined;
        S["prev"] = x ?? prev;
        if (x === null || prev === undefined || prev === null) return null;
        const up = rmaStep("u", Math.max(x - prev, 0), len, 1 / len); const dn = rmaStep("d", Math.max(prev - x, 0), len, 1 / len);
        if (up === null || dn === null) return null;
        return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
      }
      case "ta.macd": {
        const x = N(0, "source"); const f = lenOf(1, "fastlen"); const s = lenOf(2, "slowlen"); const g = lenOf(3, "siglen");
        const ef = rmaStep("f", x, f, 2 / (f + 1)); const es = rmaStep("s", x, s, 2 / (s + 1));
        const m = ef === null || es === null ? null : ef - es;
        const sg = rmaStep("g", m, g, 2 / (g + 1));
        return [m, sg, m === null || sg === null ? null : m - sg];
      }
      case "ta.stdev": case "ta.bb": {
        const len = lenOf(1); const arr = push("src", A(0, "source")); const mean = smaOf(arr, len);
        if (mean === null) return fn === "ta.bb" ? [null, null, null] : null;
        let v = 0; for (let j = arr.length - len; j < arr.length; j++) v += (num(arr[j])! - mean) ** 2;
        const sd = Math.sqrt(v / len);
        if (fn === "ta.stdev") return sd;
        const mult = N(2, "mult") ?? 2; return [mean, mean + mult * sd, mean - mult * sd];
      }
      case "ta.highest": case "ta.lowest": {
        const oneArg = e.args.length === 1 && !e.named["source"];
        const src = oneArg ? this.builtin(fn === "ta.highest" ? "high" : "low", 0, e.loc.line) : A(0, "source");
        const len = oneArg ? lenOf(0) : lenOf(1);
        const arr = push("src", src); if (arr.length < len) return null;
        const w = arr.slice(-len).map(num); if (w.some((x) => x === null)) return null;
        return fn === "ta.highest" ? Math.max(...(w as number[])) : Math.min(...(w as number[]));
      }
      case "ta.rising": case "ta.falling": {
        const len = lenOf(1); const arr = push("src", A(0, "source")); if (arr.length < len + 1) return false;
        const x = num(arr[arr.length - 1]); const prev = arr.slice(-len - 1, -1).map(num);
        if (x === null || prev.some((p) => p === null)) return false;
        return fn === "ta.rising" ? x > Math.max(...(prev as number[])) : x < Math.min(...(prev as number[]));
      }
      case "ta.change": {
        const len = has(1, "length") ? lenOf(1) : 1; const arr = push("src", A(0, "source"));
        if (arr.length <= len) return null; const a = num(arr[arr.length - 1]); const b = num(arr[arr.length - 1 - len]);
        return a === null || b === null ? null : typeof A(0) === "boolean" ? a !== b : a - b;
      }
      case "ta.crossover": case "ta.crossunder": case "ta.cross": {
        const a = N(0, "source1"); const b = N(1, "source2"); const pa = S["pa"] as number | null | undefined; const pb = S["pb"] as number | null | undefined;
        S["pa"] = a; S["pb"] = b;
        if (a === null || b === null || pa == null || pb == null) return false;
        const over = a > b && pa <= pb; const under = a < b && pa >= pb;
        return fn === "ta.crossover" ? over : fn === "ta.crossunder" ? under : over || under;
      }
      case "ta.pivothigh": case "ta.pivotlow": {
        const hi = fn === "ta.pivothigh";
        const two = e.args.length === 2;
        const src = two ? this.builtin(hi ? "high" : "low", 0, e.loc.line) : A(0, "source");
        const l = Math.trunc(N(two ? 0 : 1, "leftbars") ?? 0); const r = Math.trunc(N(two ? 1 : 2, "rightbars") ?? 0);
        const arr = push("src", src); if (arr.length < l + r + 1) return null;
        const w = arr.slice(-(l + r + 1)).map(num); const c = w[l];
        if (c === null || c === undefined || w.some((x) => x === null)) return null;
        for (let j = 0; j < w.length; j++) {
          if (j === l) continue;
          const x = w[j]!;
          if (hi ? (j < l ? x >= c : x > c) : (j < l ? x <= c : x < c)) return null;
        }
        return c; // confirmed r bars after the pivot → no lookahead
      }
      case "ta.barssince": {
        const cnd = truthy(A(0)); const cnt = S["n"] as number | null | undefined;
        S["n"] = cnd ? 0 : cnt == null ? null : cnt + 1; return S["n"] as number | null;
      }
      case "ta.valuewhen": {
        const cnd = truthy(A(0)); const src = A(1); const occ = Math.trunc(N(2, "occurrence") ?? 0);
        const list = ((S["l"] as V[]) ??= []); if (cnd) list.push(src);
        return list.length > occ ? list[list.length - 1 - occ]! : null;
      }
      case "ta.vwap": {
        const b = this.bar()!; const x = N(0, "source") ?? (b.high + b.low + b.close) / 3; const vol = b.volume;
        if (vol == null) return null;
        const day = Math.floor(b.ts / 86_400_000);
        if (S["d"] !== day) { S["d"] = day; S["pv"] = 0; S["v"] = 0; }
        S["pv"] = (S["pv"] as number) + x * vol; S["v"] = (S["v"] as number) + vol;
        return (S["v"] as number) > 0 ? (S["pv"] as number) / (S["v"] as number) : null;
      }
      case "strategy.entry": {
        if (has(99, "when") && !truthy(A(99, "when"))) return null;
        const dir = N(1, "direction");
        if (dir !== 1 && dir !== -1) throw new SemanticError(e.loc.line, "strategy.entry direction");
        this.intents.push({ kind: "entry", id: String(A(0, "id")), dir, qty: N(99, "qty"), limit: N(99, "limit"), stop: N(99, "stop"), line: e.loc.line });
        return null;
      }
      case "strategy.exit": {
        if (has(99, "when") && !truthy(A(99, "when"))) return null;
        const from = A(1, "from_entry");
        this.intents.push({ kind: "exit", id: String(A(0, "id")), from: isNa(from) ? null : String(from), stop: N(99, "stop"), limit: N(99, "limit"), profit: N(99, "profit"), loss: N(99, "loss"), trailPoints: N(99, "trail_points"), trailOffset: N(99, "trail_offset"), line: e.loc.line });
        if (has(99, "trail_price")) throw new SemanticError(e.loc.line, "trail_price not supported (use trail_points)");
        return null;
      }
      case "strategy.close": { if (has(99, "when") && !truthy(A(99, "when"))) return null; this.intents.push({ kind: "close", id: String(A(0, "id")), line: e.loc.line }); return null; }
      case "strategy.close_all": { if (has(99, "when") && !truthy(A(99, "when"))) return null; this.intents.push({ kind: "close_all", line: e.loc.line }); return null; }
      case "strategy.cancel": this.intents.push({ kind: "cancel", id: String(A(0, "id")), line: e.loc.line }); return null;
      case "strategy.cancel_all": this.intents.push({ kind: "cancel_all", line: e.loc.line }); return null;
    }
    throw new SemanticError(e.loc.line, `UNSUPPORTED_SEMANTIC function ${fn}()`);
  }
}

/** Pine str.format_time (Java SimpleDateFormat subset): yyyy yy MM dd HH hh mm ss SSS a, quoted literals. */
export function formatTime(t: number, fmt: string, tz: string, line: number): string {
  const zone = /^(UTC|GMT)$/i.test(tz) ? "UTC" : tz.replace(/^GMT([+-]\d+)$/i, "Etc/GMT$1");
  let parts: Record<string, string>;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  } catch { throw new SemanticError(line, `str.format_time timezone '${tz}'`); }
  const H = +parts["hour"]! % 24;
  const map: Record<string, string> = {
    yyyy: parts["year"]!, yy: parts["year"]!.slice(-2), MM: parts["month"]!, dd: parts["day"]!, HH: String(H).padStart(2, "0"),
    hh: String(H % 12 || 12).padStart(2, "0"), mm: parts["minute"]!, ss: parts["second"]!, SSS: String(t % 1000).padStart(3, "0"), a: H < 12 ? "AM" : "PM",
  };
  let out = ""; let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "'") { const j = fmt.indexOf("'", i + 1); out += fmt.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? fmt.length : j + 1; continue; }
    const tok = ["yyyy", "SSS", "yy", "MM", "dd", "HH", "hh", "mm", "ss", "a"].find((k) => fmt.startsWith(k, i));
    if (tok) { out += map[tok]; i += tok.length; continue; }
    if (/[A-Za-z]/.test(fmt[i]!)) throw new SemanticError(line, `str.format_time pattern letter '${fmt[i]}' not supported`);
    out += fmt[i]; i++;
  }
  return out;
}
