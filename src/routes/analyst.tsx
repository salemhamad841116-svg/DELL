import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";

import mark from "@/assets/analyst-mark.jpg";
import { Button } from "@/components/ui/button";
import { createThread, deleteThread, listThreads } from "@/lib/use/analyst.functions";

export const Route = createFileRoute("/analyst")({
  head: () => ({
    meta: [
      { title: "AI Strategy Analyst — Market Compass" },
      { name: "description", content: "AI Strategy Analyst: ask about your indicator, analyze historical patterns and forecast the next candle with real computed results." },
      { property: "og:title", content: "AI Strategy Analyst — Market Compass" },
      { property: "og:description", content: "Ask about your indicator, analyze historical patterns and forecast the next candle with real computed evidence." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalystLayout,
});

function AnalystLayout() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const params = useParams({ strict: false }) as { threadId?: string };
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const del = useServerFn(deleteThread);
  const threads = useQuery({ queryKey: ["analyst-threads"], queryFn: () => list() });

  const newThread = async () => {
    const { id } = await create();
    await qc.invalidateQueries({ queryKey: ["analyst-threads"] });
    nav({ to: "/analyst/$threadId", params: { threadId: id } });
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this conversation?")) return;
    await del({ data: { id } });
    await qc.invalidateQueries({ queryKey: ["analyst-threads"] });
    if (params.threadId === id) nav({ to: "/analyst" });
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border md:flex">
        <div className="flex items-center gap-2 p-3">
          <img src={mark} alt="" className="size-8 rounded-full" />
          <div className="text-sm font-semibold leading-tight">AI Strategy Analyst<div className="text-xs text-muted-foreground">AI Strategy Analyst</div></div>
        </div>
        <div className="px-3"><Button className="w-full" size="sm" onClick={newThread}><Plus className="size-4" /> New conversation</Button></div>
        <nav className="mt-3 flex-1 overflow-y-auto px-2">
          {threads.data?.map((t) => (
            <div key={t.id} className={`group flex items-center rounded-md ${params.threadId === t.id ? "bg-muted" : "hover:bg-muted/60"}`}>
              <Link to="/analyst/$threadId" params={{ threadId: t.id }} className="flex-1 truncate px-2 py-2 text-sm">{t.title}</Link>
              <button aria-label="Delete thread" onClick={() => remove(t.id)} className="p-2 text-muted-foreground opacity-0 group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </nav>
        <div className="flex gap-3 p-3 text-xs text-muted-foreground"><Link to="/">Home</Link><Link to="/admin">Admin</Link></div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col"><Outlet /></main>
    </div>
  );
}
