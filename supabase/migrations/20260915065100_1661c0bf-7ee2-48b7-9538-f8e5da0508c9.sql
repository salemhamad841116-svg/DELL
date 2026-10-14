-- Universal Strategy Engine foundation

CREATE TABLE public.use_symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL UNIQUE,
  display_name text NOT NULL,
  asset_class text NOT NULL DEFAULT 'crypto',
  provider text NOT NULL DEFAULT 'finnhub',
  provider_symbol text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_symbols TO anon;
GRANT SELECT ON public.use_symbols TO authenticated;
GRANT ALL ON public.use_symbols TO service_role;
ALTER TABLE public.use_symbols ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_symbols public read" ON public.use_symbols FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_candles (
  symbol text NOT NULL,
  timeframe text NOT NULL,
  ts timestamptz NOT NULL,
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  volume double precision,
  source text NOT NULL DEFAULT 'finnhub',
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, ts)
);
CREATE INDEX use_candles_lookup ON public.use_candles (symbol, timeframe, ts DESC);
GRANT SELECT ON public.use_candles TO anon;
GRANT SELECT ON public.use_candles TO authenticated;
GRANT ALL ON public.use_candles TO service_role;
ALTER TABLE public.use_candles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_candles public read" ON public.use_candles FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  language text NOT NULL DEFAULT 'pinescript',
  code text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  symbols text[] NOT NULL DEFAULT '{}',
  timeframes text[] NOT NULL DEFAULT '{}',
  representation jsonb,
  validation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_strategies TO anon;
GRANT SELECT ON public.use_strategies TO authenticated;
GRANT ALL ON public.use_strategies TO service_role;
ALTER TABLE public.use_strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_strategies public read" ON public.use_strategies FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_backtests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid REFERENCES public.use_strategies(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  split text NOT NULL DEFAULT 'oos',
  period_start timestamptz,
  period_end timestamptz,
  sample_size integer NOT NULL DEFAULT 0,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  patterns jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX use_backtests_lookup ON public.use_backtests (symbol, timeframe, created_at DESC);
GRANT SELECT ON public.use_backtests TO anon;
GRANT SELECT ON public.use_backtests TO authenticated;
GRANT ALL ON public.use_backtests TO service_role;
ALTER TABLE public.use_backtests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_backtests public read" ON public.use_backtests FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid REFERENCES public.use_strategies(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  model_version text NOT NULL,
  algorithm text NOT NULL DEFAULT 'logistic_regression',
  status text NOT NULL DEFAULT 'trained',
  weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_names text[] NOT NULL DEFAULT '{}',
  feature_importance jsonb NOT NULL DEFAULT '{}'::jsonb,
  train_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  oos_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  calibration jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_size integer NOT NULL DEFAULT 0,
  overfitting_risk boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX use_models_lookup ON public.use_models (symbol, timeframe, created_at DESC);
GRANT SELECT ON public.use_models TO anon;
GRANT SELECT ON public.use_models TO authenticated;
GRANT ALL ON public.use_models TO service_role;
ALTER TABLE public.use_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_models public read" ON public.use_models FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  timeframe text NOT NULL,
  strategy_id uuid REFERENCES public.use_strategies(id) ON DELETE SET NULL,
  strategy_version integer,
  model_version text NOT NULL,
  input_data_version text,
  market_regime text,
  direction text NOT NULL,
  bullish_probability double precision NOT NULL,
  bearish_probability double precision NOT NULL,
  neutral_probability double precision NOT NULL,
  confidence double precision NOT NULL,
  expected_return double precision,
  expected_low double precision,
  expected_high double precision,
  expected_volatility double precision,
  data_quality text NOT NULL DEFAULT 'MEDIUM',
  sample_size integer NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reference_close double precision,
  target_ts timestamptz,
  actual_close double precision,
  actual_result text,
  evaluation_status text NOT NULL DEFAULT 'pending'
);
CREATE INDEX use_predictions_lookup ON public.use_predictions (symbol, timeframe, created_at DESC);
CREATE INDEX use_predictions_pending ON public.use_predictions (evaluation_status, target_ts);
GRANT SELECT ON public.use_predictions TO anon;
GRANT SELECT ON public.use_predictions TO authenticated;
GRANT ALL ON public.use_predictions TO service_role;
ALTER TABLE public.use_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_predictions public read" ON public.use_predictions FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.use_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX use_jobs_queue ON public.use_jobs (status, created_at);
GRANT SELECT ON public.use_jobs TO anon;
GRANT SELECT ON public.use_jobs TO authenticated;
GRANT ALL ON public.use_jobs TO service_role;
ALTER TABLE public.use_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_jobs public read" ON public.use_jobs FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.use_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER use_strategies_touch BEFORE UPDATE ON public.use_strategies
FOR EACH ROW EXECUTE FUNCTION public.use_touch_updated_at();

INSERT INTO public.use_symbols (symbol, display_name, asset_class, provider_symbol) VALUES
  ('BTCUSDT', 'BTC/USDT', 'crypto', 'BINANCE:BTCUSDT'),
  ('ETHUSDT', 'ETH/USDT', 'crypto', 'BINANCE:ETHUSDT'),
  ('SOLUSDT', 'SOL/USDT', 'crypto', 'BINANCE:SOLUSDT'),
  ('EURUSD', 'EUR/USD', 'forex', 'OANDA:EUR_USD'),
  ('XAUUSD', 'XAU/USD', 'commodity', 'OANDA:XAU_USD');

INSERT INTO public.use_strategies (name, description, language, code, status, enabled, params, symbols, timeframes, representation, validation) VALUES
  (
    'EMA/RSI Baseline',
    'استراتيجية مرجعية: تقاطع EMA مع تأكيد RSI و ATR لإدارة المخاطر.',
    'pinescript',
    '//@version=5
indicator("EMA RSI Baseline", overlay=true)
fastLen = input.int(12, "Fast EMA")
slowLen = input.int(26, "Slow EMA")
rsiLen  = input.int(14, "RSI Length")
atrLen  = input.int(14, "ATR Length")
emaFast = ta.ema(close, fastLen)
emaSlow = ta.ema(close, slowLen)
rsiVal  = ta.rsi(close, rsiLen)
atrVal  = ta.atr(atrLen)
longCondition  = ta.crossover(emaFast, emaSlow) and rsiVal > 50
shortCondition = ta.crossunder(emaFast, emaSlow) and rsiVal < 50
if longCondition
    strategy.entry("Long", strategy.long)
if shortCondition
    strategy.entry("Short", strategy.short)
strategy.exit("TP/SL", stop = close - 1.5 * atrVal, limit = close + 2.0 * atrVal)',
    'published',
    true,
    '{"fastLen":12,"slowLen":26,"rsiLen":14,"atrLen":14}'::jsonb,
    ARRAY['BTCUSDT','ETHUSDT','EURUSD'],
    ARRAY['5m','15m','1h','1D'],
    NULL,
    NULL
  );