INSERT INTO public.use_symbols (symbol, display_name, asset_class, provider_symbol, enabled, category, canonical_symbol, market_type, exchange, provider, supported_timeframes, status, status_detail)
VALUES ('BTCUSD','BTC/USD','crypto','BTC/USD',true,'crypto','BTCUSD','spot','TWELVE_DATA','twelvedata',ARRAY['1m','5m','15m','30m','1h','4h','1D'],'AVAILABLE','Twelve Data BTC/USD (separate from Binance BTCUSDT)')
ON CONFLICT DO NOTHING;
UPDATE public.use_symbols SET status='NOT_CONFIGURED', status_detail='BINANCE = BLOCKED_BY_SERVER_REGION (HTTP 403)' WHERE provider_symbol LIKE '%USDT';
UPDATE public.use_forecast_schedules SET enabled=false, last_error='BINANCE = BLOCKED_BY_SERVER_REGION' WHERE symbol='BTCUSDT';
INSERT INTO public.use_forecast_schedules (symbol, timeframe, strategy_id, min_confidence, enabled)
VALUES ('BTCUSD','1m','0d9917ff-457a-4529-a87e-53890075aeb5',0.55,true);