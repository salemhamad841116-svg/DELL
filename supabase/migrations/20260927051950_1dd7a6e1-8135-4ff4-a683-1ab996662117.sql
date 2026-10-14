ALTER TABLE public.use_strategies
  ADD COLUMN IF NOT EXISTS parent_indicator_id uuid REFERENCES public.use_strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_indicator_hash text,
  ADD COLUMN IF NOT EXISTS generated_strategy_hash text,
  ADD COLUMN IF NOT EXISTS conversion jsonb;