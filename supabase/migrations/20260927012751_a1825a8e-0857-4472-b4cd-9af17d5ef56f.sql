CREATE TABLE public.use_data_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  timeframe text NOT NULL,
  requested_provider text NOT NULL,
  actual_provider text,
  status text NOT NULL,
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_data_fetches TO anon, authenticated;
GRANT ALL ON public.use_data_fetches TO service_role;
ALTER TABLE public.use_data_fetches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_data_fetches public read" ON public.use_data_fetches FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_provider_health (
  provider text PRIMARY KEY,
  configured boolean NOT NULL DEFAULT false,
  last_status text,
  last_error text,
  last_latency_ms integer,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_provider_health TO anon, authenticated;
GRANT ALL ON public.use_provider_health TO service_role;
ALTER TABLE public.use_provider_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_provider_health public read" ON public.use_provider_health FOR SELECT TO anon, authenticated USING (true);