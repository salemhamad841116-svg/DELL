// Pine Script (v5/v6 subset) lexer + parser → AST with exact source locations.
// Unsupported constructs are never guessed: they become UNSUPPORTED_SEMANTIC diagnostics.

export type Loc = { line: number; col: number };
export type Expr =
  | { k: "num"; v: number; loc: Loc }
  | { k: "str"; v: string; loc: Loc }
  | { k: "bool"; v: boolean; loc: Loc }
  | { k: "na"; loc: Loc }
  | { k: "id"; name: string; loc: Loc }
  | { k: "call"; fn: string; args: Expr[]; named: Record<string, Expr>; loc: Loc; cid?: number }
  | { k: "idx"; target: Expr; offset: Expr; loc: Loc; cid?: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; loc: Loc }
  | { k: "un"; op: string; a: Expr; loc: Loc }
  | { k: "tern"; c: Expr; a: Expr; b: Expr; loc: Loc }
  | { k: "tuplelit"; items: Expr[]; loc: Loc }
  | { k: "switch"; subj: Expr | null; cases: { when: Expr | null; val: Expr }[]; loc: Loc };
export type Stmt =
  | { k: "decl"; name: string; persistent: boolean; typ: string | null; expr: Expr; loc: Loc }
  | { k: "assign"; name: string; op: string; expr: Expr; loc: Loc }
  | { k: "tuple"; names: string[]; expr: Expr; loc: Loc }
  | { k: "if"; cond: Expr; then: Stmt[]; else: Stmt[] | null; loc: Loc }
  | { k: "expr"; expr: Expr; loc: Loc }
  | { k: "for"; v: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; loc: Loc }
  | { k: "while"; cond: Expr; body: Stmt[]; loc: Loc }
  | { k: "break"; loc: Loc }
  | { k: "continue"; loc: Loc }
  | { k: "fn"; name: string; params: string[]; body: Stmt[]; loc: Loc }
  | { k: "type"; name: string; fields: { name: string; typ: string; def: Expr | null; loc: Loc }[]; loc: Loc };

export type Diagnostic = { code: "UNSUPPORTED_SEMANTIC" | "PARSE_ERROR"; construct: string; line: number; col: number; text: string };

type Tok = { t: "num" | "str" | "id" | "op" | "nl" | "indent" | "dedent" | "eof"; v: string; loc: Loc };

// Value types plus persistent drawing-object types (line/label/box/table/…).
// Drawing objects are chart-only: the engine tracks the variable but ignores draw calls.
const TYPES = new Set([
  "float", "int", "bool", "string", "color",
  "line", "label", "box", "table", "polyline", "linefill", "chart.point",
  "series", "simple", "const",
]);
const UNSUPPORTED_KW: Record<string, string> = {
  switch: "switch", import: "library import",
  method: "method", export: "library export",
};

function lex(src: string, diags: Diagnostic[]): { toks: Tok[]; version: number | null } {
  const toks: Tok[] = [];
  let version: number | null = null;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const indents = [0];
  let depth = 0;
  let prevEndsCont = false;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!;
    const lineNo = li + 1;
    const vm = raw.match(/^\s*\/\/\s*@version\s*=\s*(\d+)/);
    if (vm) { version = +vm[1]!; continue; }
    const code = stripComment(raw);
    if (!code.trim()) continue;
    const ind = (code.match(/^[ \t]*/)![0]).replace(/\t/g, "    ").length;
    const continuation = depth > 0 || prevEndsCont || (ind % 4 !== 0 && ind > indents[indents.length - 1]!);
    if (!continuation) {
      if (toks.length && toks[toks.length - 1]!.t !== "nl") toks.push({ t: "nl", v: "", loc: { line: lineNo - 1, col: 1 } });
      if (ind > indents[indents.length - 1]!) { indents.push(ind); toks.push({ t: "indent", v: "", loc: { line: lineNo, col: 1 } }); }
      while (ind < indents[indents.length - 1]!) { indents.pop(); toks.push({ t: "dedent", v: "", loc: { line: lineNo, col: 1 } }); }
    }
    let i = 0;
    while (i < code.length) {
      const ch = code[i]!;
      const loc = { line: lineNo, col: i + 1 };
      if (ch === " " || ch === "\t") { i++; continue; }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
        const m = code.slice(i).match(/^(\d*\.?\d+(?:[eE][-+]?\d+)?|\d+\.)/)!;
        toks.push({ t: "num", v: m[0], loc }); i += m[0].length; continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1; let s = "";
        while (j < code.length && code[j] !== ch) { if (code[j] === "\\") { s += code[j + 1] ?? ""; j += 2; } else s += code[j++]; }
        toks.push({ t: "str", v: s, loc }); i = j + 1; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const m = code.slice(i).match(/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*/)!;
        toks.push({ t: "id", v: m[0], loc }); i += m[0].length; continue;
      }
      const two = code.slice(i, i + 2);
      if ([":=", "==", "!=", "<=", ">=", "=>", "+=", "-=", "*=", "/="].includes(two)) { toks.push({ t: "op", v: two, loc }); i += 2; continue; }
      if ("+-*/%<>=?:()[],".includes(ch)) {
        if (ch === "(" || ch === "[") depth++;
        if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
        toks.push({ t: "op", v: ch, loc }); i++; continue;
      }
      diags.push({ code: "PARSE_ERROR", construct: `character '${ch}'`, line: lineNo, col: i + 1, text: raw.trim() });
      i++;
    }
    const last = toks[toks.length - 1];
    prevEndsCont = !!last && last.t === "op" && [",", "+", "-", "*", "/", "?", ":", "and", "or", "=", ":="].includes(last.v) && last.loc.line === lineNo;
    if (last && last.t === "id" && (last.v === "and" || last.v === "or") && last.loc.line === lineNo) prevEndsCont = true;
  }
  toks.push({ t: "nl", v: "", loc: { line: lines.length, col: 1 } });
  while (indents.length > 1) { indents.pop(); toks.push({ t: "dedent", v: "", loc: { line: lines.length, col: 1 } }); }
  toks.push({ t: "eof", v: "", loc: { line: lines.length + 1, col: 1 } });
  return { toks, version };
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

export type ParseResult = { version: number | null; program: Stmt[]; diagnostics: Diagnostic[]; lines: string[] };

export function parsePine(src: string): ParseResult {
  const diags: Diagnostic[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const { toks, version } = lex(src, diags);
  let p = 0;
  const peek = (o = 0) => toks[p + o]!;
  const next = () => toks[p++]!;
  const isOp = (v: string, o = 0) => peek(o).t === "op" && peek(o).v === v;
  const isId = (v: string, o = 0) => peek(o).t === "id" && peek(o).v === v;
  const lineText = (l: number) => (lines[l - 1] ?? "").trim();
  // Built-in types plus user-defined types declared anywhere in the script (Pine allows use before textual order only after declaration, but names are global).
  const types = new Set(TYPES);
  for (const m of src.matchAll(/^type[ \t]+([A-Za-z_]\w*)/gm)) types.add(m[1]!);
  class PErr extends Error { constructor(public loc: Loc, msg: string) { super(msg); } }
  const expectOp = (v: string) => { if (!isOp(v)) throw new PErr(peek().loc, `expected '${v}'`); return next(); };
  const unsupported = (construct: string, loc: Loc) => diags.push({ code: "UNSUPPORTED_SEMANTIC", construct, line: loc.line, col: loc.col, text: lineText(loc.line) });

  const skipLine = () => {
    let d = 0;
    while (peek().t !== "eof") {
      const t = next();
      if (t.t === "indent") d++;
      if (t.t === "dedent") { d--; if (d < 0) { p--; return; } if (d === 0) return; }
      if (t.t === "nl" && d <= 0 && peek().t !== "indent") return;
    }
  };

  function block(): Stmt[] {
    const out: Stmt[] = [];
    while (peek().t !== "dedent" && peek().t !== "eof") {
      if (peek().t === "nl") { next(); continue; }
      const s = stmt();
      if (s) out.push(s);
    }
    return out;
  }

  function indentedBlock(): Stmt[] {
    if (peek().t === "nl") next();
    if (peek().t !== "indent") throw new PErr(peek().loc, "expected indented block");
    next();
    const b = block();
    if (peek().t === "dedent") next();
    return b;
  }

  function stmt(): Stmt | null {
    const t = peek();
    try {
      if (t.t === "id" && UNSUPPORTED_KW[t.v]) { unsupported(UNSUPPORTED_KW[t.v]!, t.loc); skipLine(); return null; }
      if (t.t === "id" && t.v === "if") return ifStmt();
      if (t.t === "id" && t.v === "type" && peek(1).t === "id" && (peek(2).t === "nl")) {
        next(); const name = next().v;
        if (peek().t === "nl") next();
        if (peek().t !== "indent") throw new PErr(peek().loc, "expected indented type fields");
        next();
        const fields: { name: string; typ: string; def: Expr | null; loc: Loc }[] = [];
        while (peek().t !== "dedent" && peek().t !== "eof") {
          if (peek().t === "nl") { next(); continue; }
          const ft = next();
          if (ft.t !== "id" || !types.has(ft.v)) throw new PErr(ft.loc, `unsupported field type '${ft.v}'`);
          if (isOp("[") && isOp("]", 1)) throw new PErr(ft.loc, "array fields are not supported");
          const fn = next(); if (fn.t !== "id") throw new PErr(fn.loc, "expected field name");
          let def: Expr | null = null;
          if (isOp("=")) { next(); def = expr(); }
          fields.push({ name: fn.v, typ: ft.v, def, loc: ft.loc });
          endStmt();
        }
        if (peek().t === "dedent") next();
        return { k: "type", name, fields, loc: t.loc };
      }
      if (t.t === "id" && (t.v === "break" || t.v === "continue") && (peek(1).t === "nl" || peek(1).t === "dedent")) { next(); endStmt(); return { k: t.v, loc: t.loc }; }
      if (t.t === "id" && t.v === "while") { next(); const cond = expr(); const body = indentedBlock(); return { k: "while", cond, body, loc: t.loc }; }
      if (t.t === "id" && t.v === "for") {
        next();
        if (peek().t === "id" && isId("in", 1)) { unsupported("for...in loop (arrays)", t.loc); skipLine(); return null; }
        if (peek().t === "op" && peek().v === "[") { unsupported("for [i, x] in (arrays)", t.loc); skipLine(); return null; }
        const v = next().v; expectOp("=");
        const from = expr();
        if (!isId("to")) throw new PErr(peek().loc, "expected 'to'");
        next(); const to = expr();
        let step: Expr | null = null;
        if (isId("by")) { next(); step = expr(); }
        const body = indentedBlock();
        return { k: "for", v, from, to, step, body, loc: t.loc };
      }
      // user function definition: name(params) =>
      if (t.t === "id" && isOp("(", 1)) {
        let d = 0; let j = p + 1;
        for (; j < toks.length; j++) { const x = toks[j]!; if (x.v === "(") d++; if (x.v === ")") { d--; if (d === 0) break; } if (x.t === "nl") break; }
        if (toks[j + 1]?.v === "=>") {
          const name = next().v; next();
          const params: string[] = [];
          while (!isOp(")")) {
            while (peek().t === "id" && types.has(peek().v) && peek(1).t === "id") next();
            const pn = next();
            if (pn.t !== "id") throw new PErr(pn.loc, "invalid parameter");
            if (isOp("=")) { unsupported("default parameter values", pn.loc); skipLine(); return null; }
            params.push(pn.v);
            if (isOp(",")) next(); else break;
          }
          expectOp(")"); expectOp("=>");
          if (peek().t === "nl") return { k: "fn", name, params, body: indentedBlock(), loc: t.loc };
          const e = expr(); endStmt();
          return { k: "fn", name, params, body: [{ k: "expr", expr: e, loc: e.loc }], loc: t.loc };
        }
      }
      // tuple declaration
      if (isOp("[")) {
        let j = p + 1; const names: string[] = [];
        while (toks[j]?.t === "id") { names.push(toks[j]!.v); j++; if (toks[j]?.v === ",") j++; else break; }
        if (toks[j]?.v === "]" && toks[j + 1]?.v === "=") {
          p = j + 2; const e = expr(); endStmt(); return { k: "tuple", names, expr: e, loc: t.loc };
        }
      }
      let persistent = false; let typ: string | null = null;
      // varip == var on confirmed historical bars (no intrabar ticks exist in backtests).
      if (isId("var") || isId("varip")) { persistent = true; next(); }
      while (peek().t === "id" && types.has(peek().v) && (peek(1).t === "id" || (isOp("[", 1) && isOp("]", 2)))) {
        typ = next().v;
        if (isOp("[") && isOp("]", 1)) { unsupported(`${typ}[] array declaration`, peek().loc); skipLine(); return null; }
      }
      if ((isId("array") || isId("matrix") || isId("map")) && isOp("<", 1)) { unsupported(`${peek().v}<…> collection declaration`, peek().loc); skipLine(); return null; }
      if (peek().t === "id" && isOp("=", 1)) {
        const name = next().v; next(); const e = expr(); if (e.k !== "switch") endStmt();
        return { k: "decl", name, persistent, typ, expr: e, loc: t.loc };
      }
      if (persistent || typ) throw new PErr(peek().loc, "expected declaration");
      if (peek().t === "id" && peek(1).t === "op" && [":=", "+=", "-=", "*=", "/="].includes(peek(1).v)) {
        const name = next().v; const op = next().v; const e = expr(); if (e.k !== "switch") endStmt();
        return { k: "assign", name, op, expr: e, loc: t.loc };
      }
      const e = expr(); endStmt();
      return { k: "expr", expr: e, loc: t.loc };
    } catch (err) {
      const loc = err instanceof PErr ? err.loc : t.loc;
      diags.push({ code: "PARSE_ERROR", construct: (err as Error).message, line: loc.line, col: loc.col, text: lineText(loc.line) });
      skipLine();
      return null;
    }
  }

  function endStmt() {
    if (peek().t === "nl") { next(); return; }
    if (peek().t === "dedent" || peek().t === "eof") return;
    throw new PErr(peek().loc, `unexpected '${peek().v}'`);
  }

  function ifStmt(): Stmt {
    const loc = next().loc;
    const cond = expr();
    const then = indentedBlock();
    let els: Stmt[] | null = null;
    while (peek().t === "nl") next();
    if (isId("else")) {
      next();
      if (isId("if")) els = [ifStmt()];
      else els = indentedBlock();
    }
    return { k: "if", cond, then, else: els, loc };
  }

  function expr(): Expr { return ternary(); }
  function ternary(): Expr {
    const c = orE();
    if (isOp("?")) { const loc = next().loc; const a = ternary(); expectOp(":"); const b = ternary(); return { k: "tern", c, a, b, loc }; }
    return c;
  }
  function orE(): Expr { let a = andE(); while (isId("or")) { const loc = next().loc; a = { k: "bin", op: "or", a, b: andE(), loc }; } return a; }
  function andE(): Expr { let a = notE(); while (isId("and")) { const loc = next().loc; a = { k: "bin", op: "and", a, b: notE(), loc }; } return a; }
  function notE(): Expr { if (isId("not")) { const loc = next().loc; return { k: "un", op: "not", a: notE(), loc }; } return cmp(); }
  function cmp(): Expr {
    let a = add();
    while (peek().t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(peek().v)) { const t = next(); a = { k: "bin", op: t.v, a, b: add(), loc: t.loc }; }
    return a;
  }
  function add(): Expr {
    let a = mul();
    while (isOp("+") || isOp("-")) { const t = next(); a = { k: "bin", op: t.v, a, b: mul(), loc: t.loc }; }
    return a;
  }
  function mul(): Expr {
    let a = unary();
    while (isOp("*") || isOp("/") || isOp("%")) { const t = next(); a = { k: "bin", op: t.v, a, b: unary(), loc: t.loc }; }
    return a;
  }
  function unary(): Expr {
    if (isOp("-") || isOp("+")) { const t = next(); return { k: "un", op: t.v, a: unary(), loc: t.loc }; }
    return postfix();
  }
  function postfix(): Expr {
    let e = primary();
    for (;;) {
      if (isOp("[")) { const loc = next().loc; const off = expr(); expectOp("]"); e = { k: "idx", target: e, offset: off, loc }; continue; }
      break;
    }
    return e;
  }
  function primary(): Expr {
    const t = next();
    if (t.t === "num") return { k: "num", v: parseFloat(t.v), loc: t.loc };
    if (t.t === "str") return { k: "str", v: t.v, loc: t.loc };
    if (t.t === "op" && t.v === "(") { const e = expr(); expectOp(")"); return e; }
    if (t.t === "op" && t.v === "[") {
      const items: Expr[] = [];
      while (!isOp("]")) { items.push(expr()); if (isOp(",")) next(); else break; }
      expectOp("]");
      return { k: "tuplelit", items, loc: t.loc };
    }
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true", loc: t.loc };
      if (t.v === "na" && !isOp("(")) return { k: "na", loc: t.loc };
      if (t.v === "switch") {
        // switch expression: optional subject, one `when => value` per indented line, `=> value` default.
        const subj = peek().t === "nl" ? null : expr();
        if (peek().t === "nl") next();
        if (peek().t !== "indent") throw new PErr(peek().loc, "expected indented switch cases");
        next();
        const cases: { when: Expr | null; val: Expr }[] = [];
        while (peek().t !== "dedent" && peek().t !== "eof") {
          if (peek().t === "nl") { next(); continue; }
          let when: Expr | null = null;
          if (isOp("=>")) next(); else { when = expr(); expectOp("=>"); }
          if (peek().t === "nl") throw new PErr(peek().loc, "switch case with a statement block is not supported");
          cases.push({ when, val: expr() });
          endStmt();
        }
        if (peek().t === "dedent") next();
        return { k: "switch", subj, cases, loc: t.loc };
      }
      if (isOp("(")) {
        next();
        const args: Expr[] = []; const named: Record<string, Expr> = {};
        while (!isOp(")")) {
          if (peek().t === "id" && isOp("=", 1)) { const n = next().v; next(); named[n] = expr(); }
          else args.push(expr());
          if (isOp(",")) next(); else break;
        }
        expectOp(")");
        return { k: "call", fn: t.v, args, named, loc: t.loc };
      }
      return { k: "id", name: t.v, loc: t.loc };
    }
    throw new PErr(t.loc, `unexpected '${t.v || t.t}'`);
  }

  const program = block();
  return { version, program, diagnostics: diags, lines };
}

export function exprText(e: Expr): string {
  switch (e.k) {
    case "num": return String(e.v);
    case "str": return JSON.stringify(e.v);
    case "bool": return String(e.v);
    case "na": return "na";
    case "id": return e.name;
    case "call": {
      const a = e.args.map(exprText).concat(Object.entries(e.named).map(([k, v]) => `${k}=${exprText(v)}`));
      return `${e.fn}(${a.join(", ")})`;
    }
    case "idx": return `${exprText(e.target)}[${exprText(e.offset)}]`;
    case "bin": return `(${exprText(e.a)} ${e.op} ${exprText(e.b)})`;
    case "un": return e.op === "not" ? `not ${exprText(e.a)}` : `${e.op}${exprText(e.a)}`;
    case "tern": return `(${exprText(e.c)} ? ${exprText(e.a)} : ${exprText(e.b)})`;
    case "tuplelit": return `[${e.items.map(exprText).join(", ")}]`;
    case "switch": return `switch ${e.subj ? exprText(e.subj) : ""} {${e.cases.map((c) => `${c.when ? exprText(c.when) : ""} => ${exprText(c.val)}`).join("; ")}}`;
  }
}
