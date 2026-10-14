
-- Symbol catalog metadata
ALTER TABLE public.use_symbols
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'crypto',
  ADD COLUMN IF NOT EXISTS canonical_symbol text,
  ADD COLUMN IF NOT EXISTS market_type text NOT NULL DEFAULT 'spot',
  ADD COLUMN IF NOT EXISTS exchange text,
  ADD COLUMN IF NOT EXISTS dataset text,
  ADD COLUMN IF NOT EXISTS supported_timeframes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN IF NOT EXISTS status_detail text,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

-- XAUUSD is SPOT gold (OANDA), never GC futures.
UPDATE public.use_symbols SET asset_class='forex', category='metals', provider='oanda', provider_symbol='XAU_USD', market_type='spot', exchange='OTC', canonical_symbol='XAUUSD', display_name='Gold Spot (XAU/USD)' WHERE symbol='XAUUSD';
UPDATE public.use_symbols SET provider='binance', category='crypto', market_type='spot', exchange='BINANCE', canonical_symbol=symbol, supported_timeframes='{1m,5m,15m,30m,1h,4h,1D,1W}' WHERE asset_class='crypto';
UPDATE public.use_symbols SET provider='oanda', category='forex', market_type='spot', exchange='OTC', canonical_symbol=symbol WHERE symbol='EURUSD';

INSERT INTO public.use_symbols(symbol, display_name, asset_class, category, provider, provider_symbol, market_type, exchange, dataset, canonical_symbol, supported_timeframes)
SELECT v.* FROM (VALUES
 ('BNBUSDT','BNB/USDT','crypto','crypto','binance','BNBUSDT','spot','BINANCE',NULL,'BNBUSDT','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('XRPUSDT','XRP/USDT','crypto','crypto','binance','XRPUSDT','spot','BINANCE',NULL,'XRPUSDT','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('ADAUSDT','ADA/USDT','crypto','crypto','binance','ADAUSDT','spot','BINANCE',NULL,'ADAUSDT','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('DOGEUSDT','DOGE/USDT','crypto','crypto','binance','DOGEUSDT','spot','BINANCE',NULL,'DOGEUSDT','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('GC.v.0','Gold Futures (GC, continuous)','futures','metals','databento','GC.v.0','futures','COMEX','GLBX.MDP3','GC','{1m,1h,1D}'::text[]),
 ('SI.v.0','Silver Futures (SI, continuous)','futures','metals','databento','SI.v.0','futures','COMEX','GLBX.MDP3','SI','{1m,1h,1D}'::text[]),
 ('CL.v.0','WTI Crude Futures (CL, continuous)','futures','energy','databento','CL.v.0','futures','NYMEX','GLBX.MDP3','CL','{1m,1h,1D}'::text[]),
 ('NG.v.0','Natural Gas Futures (NG, continuous)','futures','energy','databento','NG.v.0','futures','NYMEX','GLBX.MDP3','NG','{1m,1h,1D}'::text[]),
 ('ES.v.0','E-mini S&P 500 (ES, continuous)','futures','indices','databento','ES.v.0','futures','CME','GLBX.MDP3','ES','{1m,1h,1D}'::text[]),
 ('NQ.v.0','E-mini Nasdaq-100 (NQ, continuous)','futures','indices','databento','NQ.v.0','futures','CME','GLBX.MDP3','NQ','{1m,1h,1D}'::text[]),
 ('YM.v.0','E-mini Dow (YM, continuous)','futures','indices','databento','YM.v.0','futures','CBOT','GLBX.MDP3','YM','{1m,1h,1D}'::text[]),
 ('6E.v.0','Euro FX Futures (6E, continuous)','futures','futures','databento','6E.v.0','futures','CME','GLBX.MDP3','6E','{1m,1h,1D}'::text[]),
 ('6B.v.0','British Pound Futures (6B, continuous)','futures','futures','databento','6B.v.0','futures','CME','GLBX.MDP3','6B','{1m,1h,1D}'::text[]),
 ('6J.v.0','Japanese Yen Futures (6J, continuous)','futures','futures','databento','6J.v.0','futures','CME','GLBX.MDP3','6J','{1m,1h,1D}'::text[]),
 ('GBPUSD','GBP/USD','forex','forex','oanda','GBPUSD=X','spot','OTC',NULL,'GBPUSD','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('USDJPY','USD/JPY','forex','forex','oanda','USDJPY=X','spot','OTC',NULL,'USDJPY','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('USDCHF','USD/CHF','forex','forex','oanda','USDCHF=X','spot','OTC',NULL,'USDCHF','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('AUDUSD','AUD/USD','forex','forex','oanda','AUDUSD=X','spot','OTC',NULL,'AUDUSD','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('NZDUSD','NZD/USD','forex','forex','oanda','NZDUSD=X','spot','OTC',NULL,'NZDUSD','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('USDCAD','USD/CAD','forex','forex','oanda','USDCAD=X','spot','OTC',NULL,'USDCAD','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('EURGBP','EUR/GBP','forex','forex','oanda','EURGBP=X','spot','OTC',NULL,'EURGBP','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('EURJPY','EUR/JPY','forex','forex','oanda','EURJPY=X','spot','OTC',NULL,'EURJPY','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('GBPJPY','GBP/JPY','forex','forex','oanda','GBPJPY=X','spot','OTC',NULL,'GBPJPY','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('AUDJPY','AUD/JPY','forex','forex','oanda','AUDJPY=X','spot','OTC',NULL,'AUDJPY','{1m,5m,15m,30m,1h,4h,1D,1W}'::text[]),
 ('XAGUSD','Silver Spot (XAG/USD)','forex','metals','oanda','XAG_USD','spot','OTC',NULL,'XAGUSD','{1m,5m,15m,30m,1h,4h,1D}'::text[])
) AS v(symbol, display_name, asset_class, category, provider, provider_symbol, market_type, exchange, dataset, canonical_symbol, supported_timeframes)
WHERE NOT EXISTS (SELECT 1 FROM public.use_symbols s WHERE s.symbol = v.symbol);

UPDATE public.use_symbols SET supported_timeframes='{1m,5m,15m,30m,1h,4h,1D,1W}' WHERE symbol='EURUSD';
UPDATE public.use_symbols SET supported_timeframes='{1m,5m,15m,30m,1h,4h,1D}' WHERE symbol='XAUUSD';

-- Professional backtest runs (reproducibility record)
CREATE TABLE public.use_backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL DEFAULT gen_random_uuid(),
  strategy_id uuid REFERENCES public.use_strategies(id) ON DELETE SET NULL,
  strategy_version integer,
  strategy_hash text NOT NULL,
  source_language text NOT NULL,
  provider text,
  dataset text,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  coverage_report_id uuid,
  coverage_status text,
  coverage_percent double precision,
  bar_count integer NOT NULL DEFAULT 0,
  dataset_hash text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ir jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  breakdowns jsonb NOT NULL DEFAULT '{}'::jsonb,
  trades jsonb NOT NULL DEFAULT '[]'::jsonb,
  trades_hash text,
  status text NOT NULL DEFAULT 'COMPLETED',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.use_backtest_runs TO anon, authenticated;
GRANT ALL ON public.use_backtest_runs TO service_role;
ALTER TABLE public.use_backtest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "use_backtest_runs public read" ON public.use_backtest_runs FOR SELECT TO anon, authenticated USING (true);

-- Reference strategies for Phase 2 acceptance
INSERT INTO public.use_strategies(name, description, language, code, status, enabled, version)
SELECT 'EMA Cross Reference', 'Simple reference strategy for reproducibility tests', 'pinescript', $pine$//@version=6
strategy("EMA Cross Reference", overlay=true)
fastLen = input.int(9, "Fast EMA")
slowLen = input.int(21, "Slow EMA")
atrLen = input.int(14, "ATR Length")
slMult = input.float(1.5, "SL x ATR")
tpMult = input.float(3.0, "TP x ATR")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
a = ta.atr(atrLen)
var float stopPx = na
var float tpPx = na
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
    stopPx := close - a * slMult
    tpPx := close + a * tpMult
if ta.crossunder(fast, slow)
    strategy.entry("S", strategy.short)
    stopPx := close + a * slMult
    tpPx := close - a * tpMult
if strategy.position_size > 0
    strategy.exit("LX", "L", stop=stopPx, limit=tpPx)
if strategy.position_size < 0
    strategy.exit("SX", "S", stop=stopPx, limit=tpPx)
$pine$, 'validated', true, 1
WHERE NOT EXISTS (SELECT 1 FROM public.use_strategies WHERE name='EMA Cross Reference');

INSERT INTO public.use_strategies(name, description, language, code, status, enabled, version)
SELECT 'Pivot ATR State Machine', 'Stateful pivot breakout with persistent state and ATR trailing stop', 'pinescript', $pine$//@version=6
strategy("Pivot ATR State Machine", overlay=true)
left = input.int(5, "Pivot Left")
right = input.int(5, "Pivot Right")
atrLen = input.int(14, "ATR Length")
trailMult = input.float(2.0, "Trail x ATR")
a = ta.atr(atrLen)
ph = ta.pivothigh(high, left, right)
pl = ta.pivotlow(low, left, right)
var float lastHigh = na
var float lastLow = na
var int state = 0
var float trail = na
if not na(ph)
    lastHigh := ph
if not na(pl)
    lastLow := pl
prevState = state
if state == 0 and close > lastHigh
    state := 1
else if state == 0 and close < lastLow
    state := -1
else if state == 1 and close < lastLow
    state := 0
else if state == -1 and close > lastHigh
    state := 0
if state == 1 and prevState != 1
    strategy.entry("Long", strategy.long)
    trail := close - a * trailMult
if state == -1 and prevState != -1
    strategy.entry("Short", strategy.short)
    trail := close + a * trailMult
if strategy.position_size > 0
    trail := math.max(nz(trail), close - a * trailMult)
    strategy.exit("LX", "Long", stop=trail)
if strategy.position_size < 0
    trail := math.min(nz(trail, close + a * trailMult), close + a * trailMult)
    strategy.exit("SX", "Short", stop=trail)
if state == 0 and prevState != 0
    strategy.close_all()
$pine$, 'validated', true, 1
WHERE NOT EXISTS (SELECT 1 FROM public.use_strategies WHERE name='Pivot ATR State Machine');
