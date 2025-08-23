create table if not exists public.events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  session_id text,
  event_name text not null,
  page text,
  variant text,
  method text,
  lang text,
  tz text,
  country_guess text,
  referrer text,
  meta jsonb
);
create index if not exists idx_events_ts on public.events (ts);
create index if not exists idx_events_event on public.events (event_name);
create index if not exists idx_events_country on public.events (country_guess);
alter table public.events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where polname='events_insert_anon') then
    create policy events_insert_anon on public.events for insert to anon with check (true);
  end if;
  if not exists (select 1 from pg_policies where polname='events_insert_auth') then
    create policy events_insert_auth on public.events for insert to authenticated with check (true);
  end if;
end $$;
