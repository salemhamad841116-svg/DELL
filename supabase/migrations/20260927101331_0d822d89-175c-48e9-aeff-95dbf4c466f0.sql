create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;

-- Background forecast schedules: one row per symbol × timeframe × indicator.
create table public.use_forecast_schedules (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  timeframe text not null,
  strategy_id uuid references public.use_strategies(id) on delete cascade,
  enabled boolean not null default true,
  min_confidence double precision not null default 0.55,
  last_run_at timestamptz,
  last_target_ts timestamptz,
  last_status text,
  last_error text,
  fail_count integer not null default 0,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index use_forecast_schedules_uniq on public.use_forecast_schedules (symbol, timeframe, coalesce(strategy_id, '00000000-0000-0000-0000-000000000000'::uuid));
grant select on public.use_forecast_schedules to anon, authenticated;
grant all on public.use_forecast_schedules to service_role;
alter table public.use_forecast_schedules enable row level security;
create policy "use_forecast_schedules public read" on public.use_forecast_schedules for select to anon, authenticated using (true);
create trigger use_forecast_schedules_touch before update on public.use_forecast_schedules for each row execute function public.use_touch_updated_at();

-- Worker config + single-flight lease (service-role only).
create table public.use_worker_state (
  name text primary key,
  token text not null default encode(gen_random_bytes(32), 'hex'),
  lease_until timestamptz,
  last_tick_at timestamptz,
  last_tick_result jsonb,
  updated_at timestamptz not null default now()
);
grant all on public.use_worker_state to service_role;
alter table public.use_worker_state enable row level security;
insert into public.use_worker_state (name) values ('forecast');

-- Scoring fields (prediction fields stay frozen by the existing trigger).
alter table public.use_predictions
  add column signal text,
  add column min_confidence double precision,
  add column generated_by text,
  add column generation_delay_ms integer,
  add column scoring_status text not null default 'PENDING_DATA',
  add column actual_open double precision,
  add column actual_move double precision,
  add column atr_threshold double precision,
  add column scored_at timestamptz,
  add column score_attempts integer not null default 0,
  add column next_score_at timestamptz,
  add column score_error text;
alter table public.use_predictions disable trigger use_predictions_freeze_trg;
update public.use_predictions set scoring_status = 'SCORED', scored_at = evaluated_at where mode='NEXT_CANDLE' and evaluation_status='evaluated';
alter table public.use_predictions enable trigger use_predictions_freeze_trg;

drop index if exists public.use_predictions_nc_unique;
create unique index use_predictions_nc_unique on public.use_predictions (symbol, timeframe, target_ts, model_version, indicator_hash) where mode = 'NEXT_CANDLE';