import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { Chip, Panel, numFmt, pct } from "@/components/use/primitives";
import { enqueueJob, listJobs, processNextJob } from "@/lib/use/analysis.functions";
import { ANALYSIS_TIMEFRAMES } from "@/lib/use/timeframes";

type Opt = { symbol: string; display_name: string };
type Strat = { id: string; name: string };

export function JobsPanel({ symbols, strategies }: { symbols: Opt[]; strategies: Strat[] }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listJobs);
  const enqFn = useServerFn(enqueueJob);
  const runFn = useServerFn(processNextJob);
  const [symbol, setSymbol] = useState("");
  const [tf, setTf] = useState("1h");
  const [sid, setSid] = useState("");
  const jobs = useQuery({ queryKey: ["use", "jobs"], queryFn: () => listFn(), refetchInterval: 5000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["use", "jobs"] });
  const enq = useMutation({
    mutationFn: () => enqFn({ data: { kind: "backtest", symbol: symbol || symbols[0]?.symbol, timeframe: tf, strategyId: sid || null } }),
    onSuccess: refresh,
  });
  const run = useMutation({ mutationFn: () => runFn(), onSuccess: refresh });
  const sel = "rounded-xl border border-glass-border bg-background/70 px-3 py-2 text-sm text-ink";
  return (
    <Panel title="قائمة المهام الخلفية" subtitle="الاختبارات التاريخية الثقيلة تُضاف للقائمة وتُعالج واحدة تلو الأخرى خارج طلب التحليل.">
      <div className="flex flex-wrap gap-2">
        <select className={sel} value={symbol || symbols[0]?.symbol || ""} onChange={(e) => setSymbol(e.target.value)}>
          {symbols.map((s) => <option key={s.symbol} value={s.symbol}>{s.display_name}</option>)}
        </select>
        <select className={sel} value={tf} onChange={(e) => setTf(e.target.value)}>
          {ANALYSIS_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className={sel} value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">بدون استراتيجية</option>
          {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button" onClick={() => enq.mutate()} disabled={enq.isPending} className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">إضافة اختبار تاريخي</button>
        <button type="button" onClick={() => run.mutate()} disabled={run.isPending} className="rounded-xl border border-glass-border px-4 py-2 text-sm text-ink disabled:opacity-50">{run.isPending ? "جاري المعالجة…" : "معالجة المهمة التالية"}</button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-ink-soft"><tr><th className="p-2 text-start">الوقت</th><th className="p-2 text-start">المهمة</th><th className="p-2 text-start">الحالة</th><th className="p-2 text-start">المحاولات</th><th className="p-2 text-start">النتيجة</th></tr></thead>
          <tbody>
            {(jobs.data ?? []).map((j) => {
              const p = j.payload as { symbol?: string; timeframe?: string };
              const r = j.result as { trades?: number; winRate?: number; profitFactor?: number } | null;
              return (
                <tr key={j.id} className="border-t border-glass-border">
                  <td className="p-2 num">{new Date(j.created_at).toLocaleString("ar")}</td>
                  <td className="p-2">{j.kind} · {p.symbol} · {p.timeframe}</td>
                  <td className="p-2"><Chip tone={j.status === "failed" ? "bear" : j.status === "done" ? "bull" : "neutral"}>{j.status}</Chip></td>
                  <td className="p-2 num">{j.attempts}</td>
                  <td className="p-2 num">{r ? `${r.trades} صفقة · فوز ${pct(r.winRate ?? 0)} · PF ${numFmt(r.profitFactor ?? 0, 2)}` : j.error ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(jobs.data ?? []).length === 0 && <p className="mt-2 text-xs text-ink-soft">لا توجد مهام بعد.</p>}
      </div>
    </Panel>
  );
}
