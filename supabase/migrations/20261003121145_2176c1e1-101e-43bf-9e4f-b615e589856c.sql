CREATE TABLE public.use_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'محادثة جديدة',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.use_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.use_chat_threads(id) ON DELETE CASCADE,
  sdk_id text NOT NULL,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, sdk_id)
);
CREATE INDEX use_chat_messages_thread_idx ON public.use_chat_messages(thread_id, created_at);
GRANT ALL ON public.use_chat_threads TO service_role;
GRANT ALL ON public.use_chat_messages TO service_role;
ALTER TABLE public.use_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.use_chat_messages ENABLE ROW LEVEL SECURITY;