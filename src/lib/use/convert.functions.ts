// Intelligent Indicator → Strategy conversion API. Suggestions only; never auto-invents rules.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const rule = z.object({ expression: z.string().min(1), line: z.number().nullable(), original: z.string(), confidence: z.number().nullable(), source: z.enum(["DETECTED", "MANUAL"]) });
const level = z.object({ mode: z.enum(["NONE", "TICKS", "POINTS", "PERCENT", "ATR", "PRICE", "INDICATOR"]), value: z.number(), atrLength: z.number(), longRef: z.string(), shortRef: z.string() });
export const convertConfigSchema = z.object({
  buy: z.array(rule), sell: z.array(rule), exit: z.array(rule), tp: level, sl: level,
  direction: z.enum(["LONG_ONLY", "SHORT_ONLY", "BOTH"]), allowReentry: z.boolean(), onePosition: z.boolean(), pyramiding: z.number().int().min(0).max(100),
  trailing: z.object({ enabled: z.boolean(), points: z.number(), offset: z.number() }),
  breakEven: z.object({ enabled: z.boolean(), triggerTicks: z.number() }),
  partialExit: z.object({ enabled: z.boolean(), percent: z.number() }),
  orderType: z.enum(["MARKET", "LIMIT", "STOP"]), orderOffsetTicks: z.number().min(0), fillTiming: z.enum(["NEXT_BAR_OPEN", "BAR_CLOSE"]),
});
const input = z.object({ id: z.string().uuid(), config: convertConfigSchema });

async function loadIndicator(id: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row, error } = await supabaseAdmin.from("use_strategies").select("id,name,code,language,version,symbols,timeframes").eq("id", id).single();
  if (error || !row) throw new Error("Indicator not found");
  const { buildIR, sha256 } = await import("./strategy/ir");
  const ir = await buildIR(row.code, { language: row.language });
  return { row, ir, hash: await sha256(row.code), supabaseAdmin };
}

export const analyzeIndicator = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { row, ir, hash } = await loadIndicator(data.id);
    const { extractCandidates } = await import("./strategy/convert");
    const ex = extractCandidates(row.code);
    return { id: row.id, name: row.name, scriptType: ir.scriptType, sourceHash: hash, code: row.code, ...ex };
  });

async function check(code: string, cfg: z.infer<typeof convertConfigSchema>) {
  const { extractCandidates, generateStrategy, undefinedIdentifiers } = await import("./strategy/convert");
  const { buildIR, sha256 } = await import("./strategy/ir");
  const ex = extractCandidates(code);
  const defined = new Set(ex.definedNames);
  const gen = generateStrategy(code, cfg);
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const undef: string[] = []; const parseErr: string[] = [];
  const refs = [...cfg.buy, ...cfg.sell, ...cfg.exit].map((r) => r.expression);
  for (const l of [cfg.tp, cfg.sl]) if (l.mode === "INDICATOR") refs.push(...[l.longRef, l.shortRef].filter((x) => x.trim()));
  for (const r of refs) { const u = undefinedIdentifiers(r, defined); if (u === "PARSE_ERROR") parseErr.push(r); else undef.push(...u); }
  const ir = gen.code ? await buildIR(gen.code, { language: "pinescript" }) : null;
  const syntax = (ir?.diagnostics ?? []).filter((d) => d.code === "PARSE_ERROR");
  const unsup = (ir?.diagnostics ?? []).filter((d) => d.code === "UNSUPPORTED_SEMANTIC");
  checks.push({ name: "Syntax Validation", pass: !!ir && !syntax.length && !parseErr.length, detail: [...parseErr.map((p) => `cannot parse condition: ${p}`), ...syntax.map((d) => `${d.construct} @${d.line}:${d.col}`)].join("; ") || "OK" });
  checks.push({ name: "Unsupported Semantic Check", pass: !unsup.length, detail: unsup.map((d) => `${d.construct} @${d.line}:${d.col}`).join("; ") || "OK" });
  checks.push({ name: "Undefined Identifier Check", pass: !undef.length, detail: undef.length ? `undefined: ${[...new Set(undef)].join(", ")}` : "OK" });
  checks.push({ name: "Entry/Exit Completeness Check", pass: !gen.blockers.length && !!ir?.executable, detail: [...gen.blockers, ...(ir && !ir.executable && !gen.blockers.length ? [ir.notExecutableReason ?? "not executable"] : [])].join("; ") || "OK" });
  const hasOrders = /\bstrategy\s*\(/.test(gen.code) && !/^\s*indicator\s*\(/m.test(gen.code) && /strategy\.(entry|exit|close|close_all)\s*\(/.test(gen.code) && ir?.scriptType === "STRATEGY";
  checks.push({ name: "Generated strategy() Source Check", pass: hasOrders, detail: hasOrders ? "OK" : "generated source is not a strategy() with strategy.entry/exit/close orders" });
  const blocked = checks.some((c) => !c.pass);
  return { status: blocked ? "BLOCKED_STRATEGY_CONVERSION" as const : "READY" as const, checks, code: gen.code, sections: gen.sections, generatedHash: gen.code ? await sha256(gen.code) : null };
}

export const previewConversion = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const { row, ir } = await loadIndicator(data.id);
    if (ir.scriptType !== "INDICATOR") throw new Error("Source is not an indicator()");
    return check(row.code, data.config);
  });

export const commitConversion = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const { row, ir, hash, supabaseAdmin } = await loadIndicator(data.id);
    if (ir.scriptType !== "INDICATOR") throw new Error("Source is not an indicator()");
    const res = await check(row.code, data.config);
    if (res.status !== "READY") return { ...res, id: null as string | null, parentIndicatorId: row.id, sourceIndicatorHash: hash, originalUnchanged: true, lifecycle: null as string | null };
    const { detectLanguage, validateSecurity, parseStrategy } = await import("./parser");
    const { buildIR } = await import("./strategy/ir");
    const name = `${row.name} (Strategy)`;
    const language = detectLanguage(res.code);
    const validation = validateSecurity(res.code, language);
    const representation = parseStrategy(res.code, name);
    const gir = await buildIR(res.code, { language });
    Object.assign(validation, {
      scriptType: gir.scriptType, validity: gir.validity, scriptStatus: "DRAFT_UNVERIFIED", backtestExecutable: gir.executable, notExecutableReason: gir.notExecutableReason,
      diagnostics: gir.diagnostics.map((d) => ({ code: d.code, construct: d.construct, line: d.line, col: d.col })),
      verification: "UNVERIFIED",
    });
    const conversion = { config: data.config, checks: res.checks, sections: res.sections, convertedAt: new Date().toISOString(), execution: { orderType: data.config.orderType, orderOffsetTicks: data.config.orderOffsetTicks, fillTiming: data.config.fillTiming, direction: data.config.direction, pyramiding: data.config.pyramiding } };
    const { data: ins, error } = await supabaseAdmin.from("use_strategies").insert({
      name, description: `Generated from indicator ${row.id}`, language, code: res.code, symbols: row.symbols ?? [], timeframes: row.timeframes ?? [],
      representation: representation as never, validation: validation as never, status: "draft",
      params: Object.fromEntries(representation.parameters.map((p) => [p.name, p.value])),
      parent_indicator_id: row.id, source_indicator_hash: hash, generated_strategy_hash: res.generatedHash, conversion: conversion as never,
    }).select("id").single();
    if (error) throw new Error(error.message);
    const again = await loadIndicator(data.id);
    return { ...res, id: ins.id as string | null, parentIndicatorId: row.id, sourceIndicatorHash: hash, originalUnchanged: again.hash === hash, lifecycle: "DRAFT / UNVERIFIED" as string | null };
  });
