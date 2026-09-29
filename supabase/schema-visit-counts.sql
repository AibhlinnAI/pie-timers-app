-- ============================================================
-- First-open counts
-- ------------------------------------------------------------
-- Daily totals of the first time Pie Timers opens in a browser, by
-- Adelaide day, by the tag on the link (#src= or ?src=) and by
-- whether it was the Play app or the web. Written only through
-- public.count_first_open(), which app/visits.js calls once per
-- browser, ever. Disclosed in app/privacy.html section 9, which
-- ARCHITECTURE.md rule 3 requires to be live BEFORE this counts.
--
-- Totals and nothing else. No IP address, no user or device id, no
-- user agent, no time finer than a day, no row per visit. The
-- function below never reads request.headers (where PostgREST puts
-- the caller's IP headers), auth.uid() or inet_client_addr().
-- tools/check-visits.js fails the build if visit_counts gains a
-- column or this file mentions any of those. Change privacy.html
-- section 9 BEFORE changing anything here.
--
-- Tags are an allowlist (visit_sources). A tag names a place or a
-- printed item many people see, NEVER a person: a tag handed to one
-- person turns a count into "this person opened the app". A tag not
-- on the list is counted as 'other', an untagged open as 'none'.
-- Add a tag to the list at the bottom of this file AND run its
-- insert before printing a code that carries it.
--
-- Anyone holding the public key can call the function, so a total
-- can be inflated; nothing here can tell a script from a person
-- without storing what this file refuses to store. The damage is
-- bounded instead: closed vocabularies, at most (tags + 2) x 2 rows a
-- day, each cell stops at 100000, and the answer is the same for
-- every call, so nobody can read a total or probe which tags exist.
--
-- HOW TO RUN: Supabase -> SQL Editor -> New query, paste this whole
-- file, Run. Needs nothing else run first. Idempotent: safe to
-- re-run. Then run the checks at the end.
--
-- HOW TO READ THE COUNTS: SQL Editor (runs as the owner, so RLS does
-- not apply), or Table Editor -> visit_counts. The queries are at the
-- end of this file and in supabase/README.md. There is deliberately
-- no view: a view in public is one more thing the API exposes.
-- ============================================================

-- ── The tags that are recorded as themselves ──
create table if not exists public.visit_sources (
  source   text primary key
           check (source ~ '^[a-z0-9][a-z0-9-]{0,23}$' and source not in ('none', 'other')),
  -- What the tag was printed on or where it was shown. Never a person's name.
  label    text not null,
  added_on date not null default current_date
);

alter table public.visit_sources enable row level security;
-- No policies: read and written only from the SQL editor.
revoke all on table public.visit_sources from anon, authenticated;

-- ── The totals ──
create table if not exists public.visit_counts (
  -- Adelaide's calendar day, stamped by the database, never the browser.
  day      date    not null,
  -- Only first opens are counted. Another kind is a privacy.html change first.
  kind     text    not null check (kind in ('first_open')),
  -- A listed tag, 'none' (no tag) or 'other' (a tag not on the list).
  source   text    not null check (source ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  -- 'play' is the Android app from Google Play (CT.inPlayApp); 'web' is everything else.
  platform text    not null check (platform in ('web', 'play')),
  n        integer not null default 0 check (n >= 0),
  primary key (day, kind, source, platform)
);

alter table public.visit_counts enable row level security;
-- No policies at all. Supabase's default privileges grant new public
-- tables to anon and authenticated; RLS with no policy already blocks
-- them, and this makes it explicit.
revoke all on table public.visit_counts from anon, authenticated;

-- ── The only write path ──
-- Security definer so it can write a table anon has no rights on, as
-- tester_signups_skip_repeat() reads past RLS. kind is fixed here, not
-- chosen by the caller. Bad input is coerced, never raised, so the
-- answer never differs: no error to probe with, and an old cached
-- client and a newer server never fail on each other. lock_timeout
-- makes a flood on one hot row fail fast instead of queueing the
-- connections sync needs.
create or replace function public.count_first_open(p_source text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
set lock_timeout = '200ms'
as $$
declare
  -- left() first, so a megabyte of junk costs nothing to normalise.
  v_source text := lower(btrim(left(coalesce(p_source, ''), 64)));
begin
  if p_platform is null or p_platform not in ('web', 'play') then
    return;                                   -- not our client; count nothing
  end if;

  if v_source = '' then
    v_source := 'none';
  elsif not exists (select 1 from public.visit_sources s where s.source = v_source) then
    v_source := 'other';
  end if;

  insert into public.visit_counts as c (day, kind, source, platform, n)
  values ((now() at time zone 'Australia/Adelaide')::date, 'first_open', v_source, p_platform, 1)
  on conflict (day, kind, source, platform)
  do update set n = c.n + 1
  where c.n < 100000;                         -- a runaway shows as a flat 100000
end;
$$;

-- Revoke the Postgres and Supabase defaults, then grant exactly one
-- caller. The browser always sends the publishable key, so it runs as
-- anon, signed in or not.
revoke all on function public.count_first_open(text, text) from public, anon, authenticated;
grant execute on function public.count_first_open(text, text) to anon;

-- ── Every tag that exists ──
-- Add a line here in the same commit as the QR code or poster that
-- uses it, then run just that insert in the SQL editor.
insert into public.visit_sources (source, label) values
  ('test',     'Mal checking the count, in a private window'),
  ('stall41',  'Stall 41 QR codes (app/stall41/), once reprinted with #src=stall41'),
  ('ndexpo26', 'Stall QR codes at the ndexpo26 event (app/ndexpo26/)'),
  ('nls26',    'Stall QR codes at the nls26 event (app/nls26/)'),
  ('nsw26',    'Stall QR codes at the nsw26 event (app/nsw26/)'),
  ('nwc26',    'Stall QR codes at the nwc26 event (app/nwc26/)')
on conflict (source) do nothing;

-- Pick up the new function without waiting for the schema cache.
notify pgrst, 'reload schema';

-- ── Checking the run worked (read-only) ──
-- Expect: false | false | false | true | false
-- select
--   has_table_privilege('anon', 'public.visit_counts', 'select')   as anon_reads_counts,
--   has_table_privilege('anon', 'public.visit_counts', 'insert')   as anon_writes_counts,
--   has_table_privilege('anon', 'public.visit_sources', 'select')  as anon_reads_sources,
--   has_function_privilege('anon', 'public.count_first_open(text,text)', 'execute')          as anon_counts,
--   has_function_privilege('authenticated', 'public.count_first_open(text,text)', 'execute') as signed_in_counts;
--
-- Expect: day, kind, source, platform, n
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'visit_counts' order by ordinal_position;
--
-- Expect: no rows (nothing may add a column's worth of data behind the function's back)
-- select tgname from pg_trigger where tgrelid = 'public.visit_counts'::regclass and not tgisinternal;
--
-- Expect: off (if on, each row would carry the time of its last increment)
-- show track_commit_timestamp;
--
-- app/diagnostics.html also shows "Table: visit_counts ... Exists and is
-- locked down" once this has run.

-- ── Reading the counts ──
-- "current_date" in the SQL editor is UTC: always use the Adelaide
-- expression below. 'none' is an untagged link (typed, bookmarked,
-- shared, the t-shirt QR); 'other' a tag not on the list.
--
-- First opens a day, last 30 days:
-- select day,
--        sum(n) filter (where platform = 'web')  as web,
--        sum(n) filter (where platform = 'play') as play,
--        sum(n)                                   as total
--   from public.visit_counts
--  where kind = 'first_open'
--    and day > (now() at time zone 'Australia/Adelaide')::date - 30
--  group by day
--  order by day desc;
--
-- Where they came from, over a range (an event week, say):
-- select c.source,
--        coalesce(s.label, case c.source when 'none' then 'no tag' else 'tag not on the list' end) as what,
--        sum(c.n) as first_opens
--   from public.visit_counts c
--   left join public.visit_sources s using (source)
--  where c.kind = 'first_open'
--    and c.day between date '2026-10-01' and date '2026-10-31'
--  group by 1, 2
--  order by 3 desc;
