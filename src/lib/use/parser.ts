// Strategy Parser + Unified Strategy Representation (USR).
// Language detection -> lightweight AST-ish scan -> USR + security validation.
// The parser is generic: it extracts whatever indicators, rules and parameters
// the code declares. It is never tailored to one specific strategy.

import type { SecurityValidation, StrategyRepresentation } from "./types";

export type Language = "pinescript" | "mql5" | "javascript" | "typescript" | "python" | "unknown";

export function detectLanguage(code: string): Language {
  const c = code.toLowerCase();
  if (/\/\/@version=|study\(|indicator\(|strategy\.entry|ta\./.test(code)) return "pinescript";
  if (/#property|ontick\s*\(|iclose\s*\(|mqlrates|inpu?t\s+(double|int)\s/i.test(code)) return "mql5";
  if (/\bdef\s+\w+\s*\(|import\s+pandas|numpy\s+as\s+np|self\./.test(code)) return "python";
  if (/:\s*(number|string|boolean)\b|interface\s+\w+|type\s+\w+\s*=/.test(code)) return "typescript";
  if (/function\s+\w+\s*\(|=>|const\s+\w+\s*=/.test(c)) return "javascript";
  return "unknown";
}

const DANGEROUS: { rule: string; re: RegExp; detail: string }[] = [
  { rule: "network", re: /\b(fetch|request\.get|urllib|httpclient|webrequest|socket)\b/i, detail: "طلبات شبكة خارجية" },
  { rule: "filesystem", re: /\b(fs\.|open\s*\(|fileopen|fileread|filewrite)\b/i, detail: "وصول لنظام الملفات" },
  { rule: "process", re: /\b(child_process|subprocess|exec\s*\(|system\s*\(|os\.popen)\b/i, detail: "تشغيل عمليات نظام" },
  { rule: "eval", re: /\b(eval|new Function|exec)\s*\(/i, detail: "تنفيذ كود ديناميكي" },
  { rule: "order-execution", re: /\b(ordersend|strategy\.entry|strategy\.close|placeorder|createorder)\b/i, detail: "أوامر تنفيذ حقيقية — تُحيّد في وضع التحليل" },
  { rule: "credentials", re: /\b(api[_-]?key|secret|password|token)\s*[:=]/i, detail: "بيانات حساسة داخل الكود" },
];

export function validateSecurity(code: string, language: Language): SecurityValidation {
  const findings: SecurityValidation["findings"] = [];
  for (const d of DANGEROUS) {
    if (d.re.test(code)) {
      findings.push({
        severity: d.rule === "order-execution" ? "warning" : "critical",
        rule: d.rule,
        detail: d.detail,
      });
    }
  }
  if (code.length > 200_000) {
    findings.push({ severity: "warning", rule: "size", detail: "الكود كبير جداً — قد يستهلك موارد التحليل" });
  }
  if (language === "unknown") {
    findings.push({ severity: "warning", rule: "language", detail: "لم يتم التعرف على اللغة بثقة" });
  }
  const critical = findings.some((f) => f.severity === "critical");
  return {
    safe: !critical,
    language,
    findings,
    sandboxRequired: language !== "pinescript" || critical,
  };
}

function uniq<T>(arr: T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((v) => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const INDICATOR_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "EMA", re: /\b(?:ta\.)?ema\s*\(\s*([\w.\[\]]+)?\s*,?\s*(\d+)?/gi },
  { name: "SMA", re: /\b(?:ta\.)?sma\s*\(\s*([\w.\[\]]+)?\s*,?\s*(\d+)?/gi },
  { name: "RSI", re: /\b(?:ta\.)?rsi\s*\(\s*([\w.\[\]]+)?\s*,?\s*(\d+)?/gi },
  { name: "ATR", re: /\b(?:ta\.)?atr\s*\(\s*(\d+)?/gi },
  { name: "MACD", re: /\b(?:ta\.)?macd\s*\(/gi },
  { name: "BOLLINGER", re: /\b(?:ta\.)?bb\s*\(|bollinger/gi },
  { name: "VWAP", re: /\bvwap\b/gi },
  { name: "ADX", re: /\badx|dmi\b/gi },
  { name: "STOCH", re: /\b(?:ta\.)?stoch\s*\(/gi },
];

const NUMBER_PARAM =
  /\b(?:input(?:\.int|\.float|\.bool)?|inp|var|let|const|double|int|extern)\s*([A-Za-z_]\w*)?\s*[:=]?\s*(?:input(?:\.int|\.float)?\s*\(\s*)?(-?\d+(?:\.\d+)?)/g;

export function parseStrategy(code: string, name: string): StrategyRepresentation {
  const language = detectLanguage(code);
  const lines = code.split(/\r?\n/);

  const indicators: StrategyRepresentation["indicators"] = [];
  for (const pat of INDICATOR_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const lenRaw = m[2] ?? m[1];
      const length = lenRaw && /^\d+$/.test(lenRaw) ? Number(lenRaw) : null;
      indicators.push({ name: pat.name, source: m[1] && !/^\d+$/.test(m[1]) ? m[1] : "close", length });
    }
  }

  const parameters: StrategyRepresentation["parameters"] = [];
  let pm: RegExpExecArray | null;
  const paramRe = new RegExp(NUMBER_PARAM.source, NUMBER_PARAM.flags);
  while ((pm = paramRe.exec(code)) !== null) {
    if (!pm[1]) continue;
    const value = Number(pm[2]);
    if (!Number.isFinite(value)) continue;
    parameters.push({ name: pm[1], value, type: Number.isInteger(value) ? "int" : "float" });
  }

  const entryRules: StrategyRepresentation["entryRules"] = [];
  const exitRules: StrategyRepresentation["exitRules"] = [];
  const riskRules: StrategyRepresentation["riskRules"] = [];
  const timeframeRules: StrategyRepresentation["timeframeRules"] = [];
  const sessionFilters: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const low = line.toLowerCase();

    if (/(longcondition|buy|long)\b/.test(low) && /(=|:=|if|and|>|crossover)/.test(low)) {
      entryRules.push({ side: "BUY", expression: line.slice(0, 240) });
    }
    if (/(shortcondition|sell|short)\b/.test(low) && /(=|:=|if|and|<|crossunder)/.test(low)) {
      entryRules.push({ side: "SELL", expression: line.slice(0, 240) });
    }
    if (/\b(exit|close|takeprofit|take_profit|tp)\b/.test(low)) {
      exitRules.push({ kind: /tp|profit/.test(low) ? "TAKE_PROFIT" : "EXIT", expression: line.slice(0, 240) });
    }
    if (/\b(stoploss|stop_loss|\bsl\b)\b/.test(low)) {
      riskRules.push({ kind: "SL", expression: line.slice(0, 240) });
    }
    if (/\b(takeprofit|take_profit|\btp\b)\b/.test(low)) {
      riskRules.push({ kind: "TP", expression: line.slice(0, 240) });
    }
    if (/\btrail/.test(low)) riskRules.push({ kind: "TRAIL", expression: line.slice(0, 240) });
    if (/\b(qty|lot|position_size|risk_percent)\b/.test(low)) {
      riskRules.push({ kind: "SIZE", expression: line.slice(0, 240) });
    }
    const tf = low.match(/\b(1|3|5|15|30|45|60|240|360|480)(m|min)?\b\s*(timeframe|resolution)|timeframe\.(\w+)|period_(\w+)/);
    if (tf) timeframeRules.push({ timeframe: tf[4] ?? tf[5] ?? tf[1] ?? "?", context: line.slice(0, 120) });
    if (/session|hour\s*[<>=]|time\(/.test(low)) sessionFilters.push(line.slice(0, 160));
  }

  const dependencies = uniq(
    Array.from(code.matchAll(/^\s*(?:import|from|#include|require)\s*[<"']?([\w./@-]+)/gm)).map((m) => m[1] ?? ""),
    (v) => v,
  ).filter(Boolean);

  const lookbackBars = Math.max(
    200,
    ...indicators.map((i) => (i.length ?? 0) * 3),
    ...parameters.filter((p) => typeof p.value === "number" && (p.value as number) < 500).map((p) => Number(p.value) * 3),
  );

  return {
    metadata: {
      name,
      language,
      version: "1",
      detectedFrom: language === "unknown" ? "heuristic" : "signature",
      lines: lines.length,
    },
    parameters: uniq(parameters, (p) => p.name).slice(0, 40),
    indicators: uniq(indicators, (i) => `${i.name}:${i.length ?? "-"}:${i.source}`).slice(0, 40),
    features: uniq(indicators, (i) => i.name).map((i) => i.name.toLowerCase()),
    entryRules: uniq(entryRules, (r) => r.side + r.expression).slice(0, 30),
    exitRules: uniq(exitRules, (r) => r.kind + r.expression).slice(0, 30),
    riskRules: uniq(riskRules, (r) => r.kind + r.expression).slice(0, 30),
    timeframeRules: uniq(timeframeRules, (r) => r.timeframe + r.context).slice(0, 20),
    sessionFilters: uniq(sessionFilters, (s) => s).slice(0, 20),
    dependencies: dependencies.slice(0, 30),
    lookbackBars: Math.min(lookbackBars, 2000),
  };
}
