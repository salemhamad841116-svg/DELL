import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { Chip, Panel } from "@/components/use/primitives";
import { listSymbolCatalog, syncSymbolCatalog } from "@/lib/use/strategy.functions";

const CATS = [
  { id: "all", label: "All" }, { id: "forex", label: "Forex" }, { id: "crypto", label: "Crypto" }, { id: "metals", label: "Metals" },
  { id: "indices", label: "Indices" }, { id: "energy", label: "Energy" }, { id: "futures", label: "Futures" },
];

export function SymbolCatalog() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSymbolCatalog);
  const syncFn = useServerFn(syncSymbolCatalog);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["use", "catalog"], queryFn: () => listFn() });
  const sync = useMutation({ mutationFn: () => syncFn(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["use", "catalog"] }); qc.invalidateQueries({ queryKey: ["use", "bootstrap"] }); } });
  const rows = useMemo(() => (list.data ?? []).filter((r) => (cat === "all" || r.category === cat || (cat === "futures" && r.market_type === "futures")) && (!q || `${r.symbol} ${r.display_name}`.toLowerCase().includes(q.toLowerCase()))), [list.data, cat, q]);
  const tone = (s: string) => (s === "AVAILABLE" ? "bull" : s === "UNSUPPORTED" || s === "NOT_ENTITLED" ? "bear" : "neutral") as "bull" | "bear" | "neutral";
  return (
    <Panel title="كتالوج الرموز" subtitle="كل رمز مربوط بمزوده الحقيقي. XAUUSD (سبوت) منفصل عن GC (عقود آجلة)." action={
      <button onClick={() => sync.mutate()} disabled={sync.isPending} className="rounded-xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
        {sync.isPending ? "جارٍ المزامنة…" : "Sync Symbols From Providers"}
      </button>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {CATS.map((c) => (
          <button key={c.id} onClick={() => setCat(c.id)} className={`rounded-full border px-3 py-1 text-xs ${cat === c.id ? "border-primary bg-primary text-primary-foreground" : "border-glass-border text-ink"}`}>{c.label}</button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث…" className="ms-auto rounded-xl border border-glass-border bg-background/70 px-3 py-1.5 text-xs text-ink" />
      </div>
      {sync.data && <p className="mb-2 text-[11px] text-ink-soft" dir="ltr">{sync.data.map((r) => `${r.provider}: ${r.available}/${r.checked} (${r.note})`).join(" · ")}</p>}
      <div className="max-h-96 overflow-auto rounded-xl border border-glass-border">
        <table className="w-full text-xs" dir="ltr">
          <thead className="sticky top-0 bg-background text-ink-soft"><tr>{["Symbol", "Name", "Class", "Type", "Provider", "Provider Symbol", "Exchange / Dataset", "Timeframes", "Status"].map((h) => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t border-glass-border text-ink">
                <td className="px-2 py-1.5 font-mono">{r.symbol}</td>
                <td className="px-2 py-1.5">{r.display_name}</td>
                <td className="px-2 py-1.5">{r.category}</td>
                <td className="px-2 py-1.5">{r.market_type}</td>
                <td className="px-2 py-1.5 font-medium">{r.provider}</td>
                <td className="px-2 py-1.5 font-mono">{r.provider_symbol}</td>
                <td className="px-2 py-1.5">{r.exchange}{r.dataset ? ` · ${r.dataset}` : ""}</td>
                <td className="px-2 py-1.5">{(r.supported_timeframes ?? []).join(" ")}</td>
                <td className="px-2 py-1.5" title={r.status_detail ?? ""}><Chip tone={tone(r.status)}>{r.status}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
