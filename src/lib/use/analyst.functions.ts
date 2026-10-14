// AI Strategy Analyst — thread storage (server-only DB access via service role; tables have no client policies).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const listThreads = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { data, error } = await db.from("use_chat_threads" as never).select("id,title,updated_at").order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as { id: string; title: string; updated_at: string }[];
});

export const createThread = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { data, error } = await db.from("use_chat_threads" as never).insert({} as never).select("id").single();
  if (error) throw new Error(error.message);
  return { id: (data as unknown as { id: string }).id };
});

export const getThread = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const t = await db.from("use_chat_threads" as never).select("id,title").eq("id", data.id).maybeSingle();
    if (t.error) throw new Error(t.error.message);
    if (!t.data) return null;
    const m = await db.from("use_chat_messages" as never).select("sdk_id,role,parts").eq("thread_id", data.id).order("created_at");
    if (m.error) throw new Error(m.error.message);
    const rows = (m.data ?? []) as unknown as { sdk_id: string; role: string; parts: unknown[] }[];
    return { thread: t.data as unknown as { id: string; title: string }, messagesJson: JSON.stringify(rows.map((r) => ({ id: r.sdk_id, role: r.role, parts: r.parts }))) };
  });

export const deleteThread = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { error } = await db.from("use_chat_threads" as never).delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
