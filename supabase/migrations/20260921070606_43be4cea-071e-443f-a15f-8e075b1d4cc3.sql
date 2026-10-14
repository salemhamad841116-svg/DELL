UPDATE public.use_symbols SET provider = 'binance', provider_symbol = symbol WHERE asset_class = 'crypto';
UPDATE public.use_symbols SET provider = 'yahoo', provider_symbol = 'EURUSD=X' WHERE symbol = 'EURUSD';
UPDATE public.use_symbols SET provider = 'yahoo', provider_symbol = 'GC=F' WHERE symbol = 'XAUUSD';