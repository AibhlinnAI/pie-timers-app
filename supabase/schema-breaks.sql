-- ============================================================
-- Countdown Timers — multiple breaks
-- Run after schema.sql, in Supabase → SQL Editor. Safe to run twice.
--
-- RUN ON THE LIVE PROJECT (tgapmpbcqqnpsldehuqa) on 27 Sep 2026, before
-- the app that uses it shipped, and verified there: jsonb, nullable, no
-- default, empty on every row, and served by the REST API.
-- ============================================================

-- Extra breaks and lunch's length live in their own column, NOT inside
-- schedule or settings. Copies of the app from before this release
-- rebuild those two columns from a fixed list of fields and send them back
-- whole, so anything new inside them would be erased by the next stale
-- tab or phone. They never name this column, and an upsert leaves a
-- column it does not name alone (proved on the live data first: rows
-- saved weeks after they were made kept their original created_at).
--
-- Nullable with no default on purpose: the app sends it only once it has
-- seen the column exist, and null means "no extra breaks".
alter table public.timer_profiles add column if not exists breaks jsonb;

comment on column public.timer_profiles.breaks is
  'Extra breaks and lunch''s length: {v:1, days:{Day:{lunchMinutes, extras:[...]}}}. Written only by the new app; older copies never send it. See the multiple breaks design doc.';

-- PostgREST caches the schema; without this it answers PGRST204 for the
-- new column until its next reload.
notify pgrst, 'reload schema';
