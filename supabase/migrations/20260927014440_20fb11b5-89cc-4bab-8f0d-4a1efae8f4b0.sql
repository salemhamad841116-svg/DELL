ALTER TABLE public.use_provider_health
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_failure_at timestamptz,
  ADD COLUMN last_http_status integer,
  ADD COLUMN request_count integer NOT NULL DEFAULT 0,
  ADD COLUMN rate_limit_state text NOT NULL DEFAULT 'OK';