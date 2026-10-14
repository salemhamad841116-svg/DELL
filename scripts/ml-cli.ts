// Usage: bun scripts/ml-cli.ts --synthetic [n]   |   bun scripts/ml-cli.ts --csv file.csv
// CSV columns: ts(epoch ms or ISO),open,high,low,close[,volume]
import { readFileSync } from "node:fs";
import { runSignalEngine } from "../src/lib/use/ml/signal_engine";
import type { Candle } from "../src/lib/use/types";

function synthetic(n: number): Candle[] {
  let seed = 42, px = 1.1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) - 0.5;
  return Array.from({ length: n }, (_, i) => {
    const o = px; px = px * (1 + rnd() * 0.002);
    return { ts: Date.UTC(2026, 0, 1) + i * 300_000, open: o, high: Math.max(o, px) * 1.0003, low: Math.min(o, px) * 0.9997, close: px, volume: null };
  });
}

function csv(path: string): Candle[] {
  return readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
    const [t, o, h, lo, c, v] = l.split(",");
    const ts = /^\d+$/.test(t!) ? Number(t) : Date.parse(t!);
    return { ts, open: +o!, high: +h!, low: +lo!, close: +c!, volume: v ? +v : null };
  });
}

const a = process.argv.slice(2);
const candles = a[0] === "--csv" && a[1] ? csv(a[1]) : a[0] === "--synthetic" ? synthetic(Number(a[1] ?? 1500)) : null;
if (!candles) { console.error("usage: --synthetic [n] | --csv <file>"); process.exit(1); }
const r = runSignalEngine(candles);
console.log(JSON.stringify({ ...r, features: undefined, featureSources: r.features.reduce<Record<string, number>>((m, f) => ((m[f.source] = (m[f.source] ?? 0) + 1), m), {}) }, null, 2));
