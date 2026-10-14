import { createFileRoute } from "@tanstack/react-router";
import type { UIMessage } from "ai";
import { z } from "zod";

const body = z.object({ threadId: z.string().uuid(), messages: z.array(z.any()) });

export const Route = createFileRoute("/api/analyst")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = body.safeParse(await request.json());
        if (!parsed.success) return new Response("Bad request", { status: 400 });
        const { threadId } = parsed.data;
        const messages = parsed.data.messages as UIMessage[];
        const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
        const t = await db.from("use_chat_threads" as never).select("id,title").eq("id", threadId).maybeSingle();
        if (!t.data) return new Response("Thread not found", { status: 404 });
        const save = async (all: UIMessage[]) => {
          const rows = all.map((m) => ({ thread_id: threadId, sdk_id: m.id, role: m.role, parts: m.parts }));
          const { error } = await db.from("use_chat_messages" as never).upsert(rows as never, { onConflict: "thread_id,sdk_id" });
          if (error) console.error("[analyst] save failed", error.message);
          const firstText = all.find((m) => m.role === "user")?.parts.find((p) => p.type === "text") as { text?: string } | undefined;
          const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
          // Default thread title set by the DB migration (Arabic: "\u0645\u062d\u0627\u062f\u062b\u0629 \u062c\u062f\u064a\u062f\u0629" = "New conversation").
          if ((t.data as unknown as { title: string }).title === "\u0645\u062d\u0627\u062f\u062b\u0629 \u062c\u062f\u064a\u062f\u0629" && firstText?.text) upd["title"] = firstText.text.slice(0, 60);
          const u = await db.from("use_chat_threads" as never).update(upd as never).eq("id", threadId);
          if (u.error) console.error("[analyst] thread update failed", u.error.message);
        };
        // Save the user's message right away so it survives a closed browser.
        await save(messages);
        const { streamAnalyst } = await import("@/lib/use/analyst/agent.server");
        return streamAnalyst(request, messages, save);
      },
    },
  },
});
