-- ============================================================
-- Countdown Timers — database schema
-- Run this once in Supabase → SQL Editor.
--
-- Every table is protected by row-level security so the public
-- anon key can only ever reach the signed-in user's own rows.
-- ============================================================

-- ─────────────────────────── Profiles ───────────────────────────
-- One row per user holding their whole document. The data is small
-- and always read and written as a unit, so a single jsonb pair
-- beats a normalised schedule table here.

create table if not exists public.timer_profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  schedule    jsonb       not null default '{}'::jsonb,
  settings    jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  device_id   text,
  created_at  timestamptz not null default now()
);

alter table public.timer_profiles enable row level security;

drop policy if exists "own profile: read"   on public.timer_profiles;
drop policy if exists "own profile: insert" on public.timer_profiles;
drop policy if exists "own profile: update" on public.timer_profiles;
drop policy if exists "own profile: delete" on public.timer_profiles;

create policy "own profile: read"
  on public.timer_profiles for select
  using (auth.uid() = user_id);

create policy "own profile: insert"
  on public.timer_profiles for insert
  with check (auth.uid() = user_id);

create policy "own profile: update"
  on public.timer_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own profile: delete"
  on public.timer_profiles for delete
  using (auth.uid() = user_id);


-- ─────────────────────────── Push subscriptions ───────────────────────────
-- One row per device per user. The endpoint is unique so that
-- re-registering the same browser updates rather than duplicates.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  endpoint    text        not null unique,
  keys        jsonb       not null,
  timezone    text        not null default 'UTC',
  last_sent   timestamptz,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own subs: read"   on public.push_subscriptions;
drop policy if exists "own subs: insert" on public.push_subscriptions;
drop policy if exists "own subs: update" on public.push_subscriptions;
drop policy if exists "own subs: delete" on public.push_subscriptions;

create policy "own subs: read"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

create policy "own subs: insert"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

create policy "own subs: update"
  on public.push_subscriptions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own subs: delete"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);


-- ─────────────────────────── Delivery log ───────────────────────────
-- Guarantees a given milestone is pushed at most once per user per
-- day, even if the scheduler runs late, twice, or overlaps itself.

create table if not exists public.notification_log (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  day        date        not null,
  timer_key  text        not null,   -- 'lunch' | 'end'
  milestone  text        not null,   -- '30' | '15' | '10' | '5' | 'done'
  sent_at    timestamptz not null default now(),
  primary key (user_id, day, timer_key, milestone)
);

alter table public.notification_log enable row level security;

drop policy if exists "own log: read" on public.notification_log;

create policy "own log: read"
  on public.notification_log for select
  using (auth.uid() = user_id);

-- Writes come only from the edge function using the service role key,
-- which bypasses RLS. No client-facing insert policy is granted.


-- ─────────────────────────── Housekeeping ───────────────────────────

create or replace function public.prune_notification_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.notification_log where day < current_date - interval '7 days';
$$;
