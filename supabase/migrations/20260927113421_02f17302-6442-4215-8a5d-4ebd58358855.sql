alter table public.use_provider_health add column if not exists degraded boolean not null default false, add column if not exists degraded_reason text, add column if not exists blocked_until timestamptz, add column if not exists consecutive_blocks integer not null default 0, add column if not exists last_probe jsonb;
create table public.use_provider_failures (
  id uuid primary key default gen_random_uuid(),
  provider text not null, endpoint text not null, method text not null default 'GET',
  http_status integer, classification text not null, response_body text, response_headers jsonb,
  weight_headers jsonb, server_region text, outbound_ip text, source text, created_at timestamptz not null default now()
);
grant select on public.use_provider_failures to authenticated;
grant all on public.use_provider_failures to service_role;
alter table public.use_provider_failures enable row level security;
create policy "auth read provider failures" on public.use_provider_failures for select to authenticated using (true);
create index on public.use_provider_failures (provider, created_at desc);