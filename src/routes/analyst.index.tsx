import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";

import { createThread, listThreads } from "@/lib/use/analyst.functions";

export const Route = createFileRoute("/analyst/")({ component: Pick });

function Pick() {
  const nav = useNavigate();
  const list = useServerFn(listThreads);
  const create = useServerFn(createThread);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    (async () => {
      const t = await list();
      const id = t[0]?.id ?? (await create()).id;
      nav({ to: "/analyst/$threadId", params: { threadId: id }, replace: true });
    })();
  }, [list, create, nav]);
  return <div className="p-6 text-sm text-muted-foreground">…</div>;
}
