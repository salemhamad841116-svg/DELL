ALTER TABLE public.use_predictions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'ANALYSIS',
  ADD COLUMN IF NOT EXISTS prediction_time timestamptz,
  ADD COLUMN IF NOT EXISTS source_bar_time timestamptz,
  ADD COLUMN IF NOT EXISTS indicator_hash text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS feature_version text,
  ADD COLUMN IF NOT EXISTS correct boolean,
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS use_predictions_nc_unique
  ON public.use_predictions (symbol, timeframe, indicator_hash, target_ts)
  WHERE mode = 'NEXT_CANDLE';
CREATE INDEX IF NOT EXISTS use_predictions_nc_pending
  ON public.use_predictions (evaluation_status, target_ts) WHERE mode = 'NEXT_CANDLE';

CREATE OR REPLACE FUNCTION public.use_predictions_freeze()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.mode <> 'NEXT_CANDLE' THEN RETURN NEW; END IF;
  IF NEW.symbol IS DISTINCT FROM OLD.symbol OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.bullish_probability IS DISTINCT FROM OLD.bullish_probability OR NEW.bearish_probability IS DISTINCT FROM OLD.bearish_probability
     OR NEW.neutral_probability IS DISTINCT FROM OLD.neutral_probability OR NEW.target_ts IS DISTINCT FROM OLD.target_ts
     OR NEW.source_bar_time IS DISTINCT FROM OLD.source_bar_time OR NEW.prediction_time IS DISTINCT FROM OLD.prediction_time
     OR NEW.reference_close IS DISTINCT FROM OLD.reference_close OR NEW.model_version IS DISTINCT FROM OLD.model_version
     OR NEW.indicator_hash IS DISTINCT FROM OLD.indicator_hash OR NEW.feature_version IS DISTINCT FROM OLD.feature_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'FROZEN_PREDICTION: forecast fields are immutable';
  END IF;
  IF OLD.evaluation_status <> 'pending' THEN
    RAISE EXCEPTION 'FROZEN_PREDICTION: already evaluated';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS use_predictions_freeze_trg ON public.use_predictions;
CREATE TRIGGER use_predictions_freeze_trg BEFORE UPDATE ON public.use_predictions
  FOR EACH ROW EXECUTE FUNCTION public.use_predictions_freeze();