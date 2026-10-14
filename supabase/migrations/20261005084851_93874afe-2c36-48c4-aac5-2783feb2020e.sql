CREATE TABLE public.use_analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL DEFAULT gen_random_uuid(),
  strategy_id uuid REFERENCES public.use_strategies(id) ON DELETE SET NULL,
  strategy_hash text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  provider text,
  dataset_hash text,
  period_start timestamptz,
  period_end timestamptz,
  status text NOT NULL,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_analysis_runs TO anon, authenticated;
GRANT ALL ON public.use_analysis_runs TO service_role;
ALTER TABLE public.use_analysis_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_analysis_runs public read" ON public.use_analysis_runs FOR SELECT TO anon, authenticated USING (true);