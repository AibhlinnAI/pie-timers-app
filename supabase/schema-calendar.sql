-- ============================================================
-- Countdown Timers — calendar sync
-- Run after schema-billing.sql, in Supabase → SQL Editor.
-- ============================================================

-- Manual appointments were added after the first release and need a
-- home on the profile row. Without this they do not sync between
-- devices. Safe to run on an existing database.
alter table public.timer_profiles
  add column if not exists appointments jsonb not null default '[]'::jsonb;


-- ─────────────────────────── Feeds ───────────────────────────
--
-- PRIVACY: feed_url is a bearer secret. Anyone holding it can read
-- that person's entire calendar, forever, with no further auth. It
-- is therefore never exposed to the browser after being saved — the
-- select policy below deliberately omits it, and only the edge
-- function (service-role) ever reads it back.

create table if not exists public.calendar_feeds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  label        text        not null default 'My calendar',
  feed_url     text        not null,
  active       boolean     not null default true,

  last_synced  timestamptz,
  last_error   text,
  event_count  integer     not null default 0,

  created_at   timestamptz not null default now()
);

create index if not exists calendar_feeds_user_idx on public.calendar_feeds (user_id);

alter table public.calendar_feeds enable row level security;

drop policy if exists "own feeds: read"   on public.calendar_feeds;
drop policy if exists "own feeds: insert" on public.calendar_feeds;
drop policy if exists "own feeds: update" on public.calendar_feeds;
drop policy if exists "own feeds: delete" on public.calendar_feeds;

create policy "own feeds: read"
  on public.calendar_feeds for select using (auth.uid() = user_id);
create policy "own feeds: insert"
  on public.calendar_feeds for insert with check (auth.uid() = user_id);
create policy "own feeds: update"
  on public.calendar_feeds for update using (auth.uid() = user_id)
                                with check (auth.uid() = user_id);
create policy "own feeds: delete"
  on public.calendar_feeds for delete using (auth.uid() = user_id);

-- The client reads this instead of the table, so the secret URL never
-- travels to the browser. Only whether one is set.
create or replace view public.my_calendar_feeds
with (security_invoker = true) as
  select id, user_id, label, active, last_synced, last_error, event_count, created_at,
         (feed_url is not null and feed_url <> '') as has_url
    from public.calendar_feeds
   where user_id = auth.uid();


-- ─────────────────────────── Expanded events ───────────────────────────
-- The edge function writes the next couple of weeks of occurrences here,
-- already expanded from any recurrence rules, so the client never has to
-- parse iCalendar or reason about timezones.

create table if not exists public.calendar_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  feed_id    uuid        not null references public.calendar_feeds (id) on delete cascade,

  uid        text        not null,      -- iCalendar UID
  title      text        not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  all_day    boolean     not null default false,
  location   text,

  -- One row per occurrence of a recurring event.
  unique (feed_id, uid, starts_at)
);

create index if not exists calendar_events_user_start_idx
  on public.calendar_events (user_id, starts_at);

alter table public.calendar_events enable row level security;

drop policy if exists "own events: read" on public.calendar_events;
create policy "own events: read"
  on public.calendar_events for select using (auth.uid() = user_id);

-- Writes come only from the sync edge function using the service-role key.


-- ─────────────────────────── Housekeeping ───────────────────────────

-- Needed for the cleanup job below. Idempotent, and repeated in each
-- schema file so they can be run in any order without failing.
create extension if not exists pg_cron;

create or replace function public.prune_calendar_events()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.calendar_events where starts_at < now() - interval '1 day';
$$;

select cron.unschedule('countdown-prune-calendar')
where exists (select 1 from cron.job where jobname = 'countdown-prune-calendar');

select cron.schedule(
  'countdown-prune-calendar',
  '41 3 * * *',
  $$ select public.prune_calendar_events(); $$
);

-- The 15-minute feed refresh lives in cron.sql, not here. Anything needing
-- your project ref and keys belongs in the one file you edit, so these
-- schema files stay copy-paste safe.
