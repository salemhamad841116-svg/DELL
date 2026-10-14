import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useState, type ReactNode } from "react";

import { Chip } from "@/components/use/primitives";
import { getStrategyCode, saveStrategy } from "@/lib/use/analysis.functions";

const EXT: Record<string, string> = { pinescript: "pine", mql5: "mq5", python: "py", javascript: "js", typescript: "ts" };
const KW = /\b(strategy|indicator|input|if|else|for|while|return|var|varip|let|const|function|def|class|import|from|and|or|not|true|false|na|int|float|double|bool|string|void|series|switch|export|new|in|to|by|input\.\w+|ta\.\w+|math\.\w+|request\.\w+)\b/;
const TOKEN = /(\/\/.*|#.*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w.]*\b)/g;

function highlight(line: string, lang: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const t = m[0];
    const i = m.index ?? 0;
    if (i > last) out.push(line.slice(last, i));
    const comment = t.startsWith("//") || (lang === "python" && t.startsWith("#"));
    const cls = comment ? "text-ink-soft italic" : /^["']/.test(t) ? "text-bull" : /^\d/.test(t) ? "text-warn" : KW.test(t) && KW.exec(t)?.[0] === t ? "text-bear font-semibold" : "";
    out.push(cls ? <span key={i} className={cls}>{t}</span> : t);
    last = i + t.length;
    if (comment) { last = line.length; out[out.length - 1] = <span key={i} className={cls}>{line.slice(i)}</span>; break; }
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function StrategyCode({ id }: { id: string }) {
  const fetchFn = useServerFn(getStrategyCode);
  const saveFn = useServerFn(saveStrategy);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["use", "strategy-code", id], queryFn: () => fetchFn({ data: { id } }) });
  const [open, setOpen] = useState<"view" | "edit" | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { id, name: q.data!.name, code: draft, symbols: q.data!.symbols, timeframes: q.data!.timeframes } }),
    onSuccess: () => { setOpen("view"); void qc.invalidateQueries({ queryKey: ["use"] }); },
  });

  const s = q.data;
  const copy = async () => {
    if (!s) return;
    await navigator.clipboard.writeText(s.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const download = () => {
    if (!s) return;
    const url = URL.createObjectURL(new Blob([s.code], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.name.replace(/[^\w\u0600-\u06FF-]+/g, "_")}.${EXT[s.language] ?? "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const btn = "rounded-full border border-glass-border px-3 py-1 text-[11px] text-ink hover:bg-muted disabled:opacity-50";

  return (
    <div className="mt-3 rounded-xl border border-glass-border bg-background/50 p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-ink">Strategy Source Code</div>
      {q.isError && <p className="text-[11px] text-bear">تعذر تحميل الكود.</p>}
      {s && (
        <div dir="ltr" className="mb-2 flex flex-wrap gap-1.5 text-left">
          <Chip>{s.languageLabel}</Chip>
          <Chip>Version: v{s.version}</Chip>
          <Chip>Status: {s.status}</Chip>
          <Chip>Modified: {new Date(s.updated_at).toISOString().replace("T", " ").slice(0, 16)} UTC</Chip>
          <span className="num rounded-full border border-glass-border px-2 py-0.5 text-[10px] text-ink-soft" title={s.hash}>SHA-256 {s.hash.slice(0, 16)}…</span>
        </div>
      )}
      <div dir="ltr" className="flex flex-wrap gap-1.5">
        <button type="button" className={btn} disabled={!s} onClick={() => setOpen("view")}>View Code</button>
        <button type="button" className={btn} disabled={!s} onClick={copy}>{copied ? "Code copied ✓" : "Copy Code"}</button>
        <button type="button" className={btn} disabled={!s} onClick={() => { setDraft(s!.code); setOpen("edit"); }}>Edit Code</button>
        <button type="button" className={btn} disabled={!s} onClick={download}>Download .{s ? EXT[s.language] ?? "txt" : "…"}</button>
      </div>

      {open && s && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4" onClick={() => setOpen(null)}>
          <div
            dir="ltr"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col overflow-hidden rounded-2xl border border-glass-border bg-background text-left shadow-2xl"
            style={{ resize: "both", width: "min(1000px, 95vw)", height: "80vh", minWidth: 320, minHeight: 240, maxWidth: "98vw", maxHeight: "95vh" }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-glass-border p-3">
              <div className="text-sm font-semibold text-ink">{s.name} · {s.languageLabel} · v{s.version}</div>
              <div className="flex flex-wrap gap-1.5">
                {open === "view" ? (
                  <>
                    <button type="button" className={btn} onClick={copy}>{copied ? "Code copied ✓" : "Copy Full Code"}</button>
                    <button type="button" className={btn} onClick={download}>Download .{EXT[s.language] ?? "txt"}</button>
                  </>
                ) : (
                  <button type="button" className={btn} disabled={save.isPending || draft.length < 10} onClick={() => save.mutate()}>
                    {save.isPending ? "Saving…" : "Save (re-validate)"}
                  </button>
                )}
                <button type="button" className={btn} onClick={() => setOpen(null)}>Close</button>
              </div>
            </div>
            {save.isError && <p className="px-3 pt-2 text-[11px] text-bear">{(save.error as Error).message}</p>}
            {open === "view" ? (
              <div className="num flex-1 overflow-auto bg-background/80 text-xs leading-5">
                <table className="border-collapse">
                  <tbody>
                    {s.code.split("\n").map((l, i) => (
                      <tr key={i}>
                        <td className="sticky left-0 select-none bg-muted px-3 text-right text-ink-soft">{i + 1}</td>
                        <td className="whitespace-pre px-3 text-ink"><Fragment>{highlight(l, s.language)}</Fragment></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                wrap="off"
                className="num flex-1 resize-none overflow-auto bg-background/80 p-3 text-xs leading-5 text-ink outline-none"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
