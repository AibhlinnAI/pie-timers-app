-- ============================================================
-- Countdown Timers — sign-in throttle store
-- Run after schema.sql, in Supabase → SQL Editor.
--
-- Only hashes are stored. Counting attempts does not require
-- keeping raw email addresses or IP addresses, so it does not.
-- ============================================================

-- Needed for the cleanup job below. Idempotent, and repeated in each
-- schema file so they can be run in any order without failing.
create extension if not exists pg_cron;

create table if not exists public.signin_attempts (
  id           bigserial primary key,
  email_hash   text        not null,
  ip_hash      text        not null,
  attempted_at timestamptz not null default now()
);

create index if not exists signin_attempts_email_idx
  on public.signin_attempts (email_hash, attempted_at desc);

create index if not exists signin_attempts_ip_idx
  on public.signin_attempts (ip_hash, attempted_at desc);

alter table public.signin_attempts enable row level security;
-- No policies at all: only the signin edge function touches this,
-- using the service-role key. The browser must never read it.


-- Attempts older than a day are useless — the window is one hour.
create or replace function public.prune_signin_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.signin_attempts where attempted_at < now() - interval '1 day';
$$;

-- Schedule the cleanup (pg_cron is enabled by supabase/cron.sql).
select cron.unschedule('countdown-prune-signins')
where exists (select 1 from cron.job where jobname = 'countdown-prune-signins');

select cron.schedule(
  'countdown-prune-signins',
  '23 4 * * *',
  $$ select public.prune_signin_attempts(); $$
);
