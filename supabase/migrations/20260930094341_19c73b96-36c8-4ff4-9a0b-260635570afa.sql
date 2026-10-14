CREATE TABLE public.use_nc_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  timeframe text NOT NULL,
  indicator_hash text NOT NULL,
  model_version text NOT NULL,
  status text NOT NULL DEFAULT 'CANDIDATE',
  was_verified boolean NOT NULL DEFAULT false,
  report jsonb NOT NULL,
  data_range jsonb,
  health jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  retired_at timestamptz
);
GRANT ALL ON public.use_nc_models TO service_role;
ALTER TABLE public.use_nc_models ENABLE ROW LEVEL SECURITY;
CREATE INDEX use_nc_models_setup ON public.use_nc_models(symbol, timeframe, indicator_hash, status);
CREATE UNIQUE INDEX use_nc_models_one_verified ON public.use_nc_models(symbol, timeframe, indicator_hash, model_version) WHERE status IN ('VERIFIED','DEGRADED');

ALTER TABLE public.use_predictions
  ADD COLUMN calibrated_confidence double precision,
  ADD COLUMN gate jsonb,
  ADD COLUMN explain jsonb,
  ADD COLUMN provider text,
  ADD COLUMN session text,
  ADD COLUMN nc_model_id uuid;

CREATE OR REPLACE FUNCTION public.use_predictions_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.mode <> 'NEXT_CANDLE' THEN RETURN NEW; END IF;
  IF NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.signal IS DISTINCT FROM OLD.signal OR NEW.min_confidence IS DISTINCT FROM OLD.min_confidence
     OR NEW.bullish_probability IS DISTINCT FROM OLD.bullish_probability OR NEW.bearish_probability IS DISTINCT FROM OLD.bearish_probability
     OR NEW.neutral_probability IS DISTINCT FROM OLD.neutral_probability OR NEW.target_ts IS DISTINCT FROM OLD.target_ts
     OR NEW.source_bar_time IS DISTINCT FROM OLD.source_bar_time OR NEW.prediction_time IS DISTINCT FROM OLD.prediction_time
     OR NEW.reference_close IS DISTINCT FROM OLD.reference_close OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.indicator_hash IS DISTINCT FROM OLD.indicator_hash OR NEW.feature_version IS DISTINCT FROM OLD.feature_version
     OR NEW.calibrated_confidence IS DISTINCT FROM OLD.calibrated_confidence OR NEW.gate IS DISTINCT FROM OLD.gate
     OR NEW.explain IS DISTINCT FROM OLD.explain OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.session IS DISTINCT FROM OLD.session OR NEW.nc_model_id IS DISTINCT FROM OLD.nc_model_id
     OR NEW.market_regime IS DISTINCT FROM OLD.market_regime OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'FROZEN_PREDICTION: forecast fields are immutable';
  END IF;
  IF OLD.evaluation_status <> 'pending' THEN
    RAISE EXCEPTION 'FROZEN_PREDICTION: already evaluated';
  END IF;
  RETURN NEW;
END $function$;