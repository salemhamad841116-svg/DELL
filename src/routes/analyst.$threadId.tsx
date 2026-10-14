import { useChat } from "@ai-sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import mark from "@/assets/analyst-mark.jpg";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { getThread } from "@/lib/use/analyst.functions";

export const Route = createFileRoute("/analyst/$threadId")({
  component: ThreadPage,
  notFoundComponent: () => <div className="p-6">Thread not found</div>,
  errorComponent: ({ error }) => <div className="p-6 text-destructive">{(error as Error).message}</div>,
});

const TOOL_LABEL: Record<string, string> = {
  list_context: "Indicators & symbols",
  save_indicator: "Save indicator",
  analyze_pattern: "Historical Pattern Analyzer",
  forecast_next_candle: "Next Candle Forecast",
  generate_pine: "TradingView Pine Code Generator",
};

const EXAMPLES = [
  "How many times did the price reach R3 then S1 within the same hour on EUR/USD 5m?",
  "If the price reaches R3 now, what is the probability of the next candle's direction?",
  "Generate a TradingView indicator that displays the next-candle signal.",
];

function ThreadPage() {
  const { threadId } = Route.useParams();
  const get = useServerFn(getThread);
  const q = useQuery({ queryKey: ["analyst-thread", threadId], queryFn: () => get({ data: { id: threadId } }) });
  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">…</div>;
  if (!q.data) return <div className="p-6">Thread not found</div>;
  return <ChatWindow key={threadId} threadId={threadId} initial={JSON.parse(q.data.messagesJson) as UIMessage[]} />;
}

function ChatWindow({ threadId, initial }: { threadId: string; initial: UIMessage[] }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const { messages, sendMessage, status, stop } = useChat({
    id: threadId,
    messages: initial,
    transport: new DefaultChatTransport({ api: "/api/analyst", body: { threadId } }),
    onError: (e) => toast.error(/402/.test(e.message) ? "AI credits exhausted — top up in Settings → Plans & credits." : /429/.test(e.message) ? "Rate limited — try again shortly." : e.message),
    onFinish: () => { qc.invalidateQueries({ queryKey: ["analyst-threads"] }); },
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => { if (!busy) ref.current?.focus(); }, [busy, threadId]);

  const submit = (t: string) => {
    if (!t.trim() || busy) return;
    sendMessage({ text: t });
    setText("");
  };

  return (
    <div className="flex h-full flex-col" dir="auto">
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState icon={<img src={mark} alt="" className="size-14 rounded-full" />} title="AI Strategy Analyst" description="Paste Pine code or pick a saved indicator, then ask. Every number comes from Market Compass's real engines.">
              <div className="mt-4 flex flex-col gap-2">
                {EXAMPLES.map((e) => (<button key={e} onClick={() => submit(e)} className="rounded-md border border-border px-3 py-2 text-start text-sm hover:bg-muted">{e}</button>))}
              </div>
            </ConversationEmptyState>
          ) : messages.map((m) => (
            <Message from={m.role} key={m.id}>
              <MessageContent className={m.role === "user" ? "bg-primary text-primary-foreground" : ""}>
                {m.parts.map((p, i) => {
                  if (p.type === "text") return <MessageResponse key={i}>{p.text}</MessageResponse>;
                  if (p.type === "reasoning") return null;
                  if (p.type.startsWith("tool-")) {
                    const tp = p as any;
                    const name = p.type.slice(5);
                    return (
                      <Tool key={i} defaultOpen={false}>
                        <ToolHeader type={tp.type} state={tp.state} title={TOOL_LABEL[name] ?? name} />
                        <ToolContent>
                          <ToolInput input={tp.input} />
                          <ToolOutput output={tp.output?.code ? <pre className="max-h-96 overflow-auto text-xs">{tp.output.code}</pre> : tp.output} errorText={tp.errorText} />
                        </ToolContent>
                      </Tool>
                    );
                  }
                  return null;
                })}
              </MessageContent>
            </Message>
          ))}
          {status === "submitted" && <Shimmer>Analyzing…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl p-3">
        <PromptInput onSubmit={(msg) => submit(msg.text ?? "")}>
          <PromptInputTextarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or paste Pine code…" className="min-h-28" />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} onStop={stop} disabled={!busy && !text.trim()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
