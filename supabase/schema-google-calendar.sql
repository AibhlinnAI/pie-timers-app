-- ============================================================
-- Countdown Timers — Google Calendar (one-click)
-- Run after schema-calendar.sql, in Supabase → SQL Editor.
--
-- Google connections reuse the calendar_feeds / calendar_events
-- tables, so everything downstream — the merge, the pie, the
-- list — is unchanged. Only how events arrive differs.
-- ============================================================

alter table public.calendar_feeds
  add column if not exists kind text not null default 'ical';        -- 'ical' | 'google'

alter table public.calendar_feeds
  add column if not exists google_refresh_token text;

alter table public.calendar_feeds
  add column if not exists google_account_email text;

alter table public.calendar_feeds
  add column if not exists google_calendar_id text default 'primary';

-- An iCal feed needs a URL; a Google feed needs a refresh token.
-- Neither is optional for its own kind.
alter table public.calendar_feeds
  alter column feed_url drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calendar_feeds_kind_shape'
  ) then
    -- A Google row may lose its token when the grant dies; it is then
    -- deactivated and kept so the UI can prompt for a reconnect.
    alter table public.calendar_feeds add constraint calendar_feeds_kind_shape
      check (
        (kind = 'ical'   and feed_url is not null) or
        (kind = 'google' and (google_refresh_token is not null or active = false))
      );
  end if;
end $$;

-- One Google connection per user keeps reconnection idempotent.
create unique index if not exists calendar_feeds_one_google_per_user
  on public.calendar_feeds (user_id) where kind = 'google';


-- The client-facing view must expose neither the feed URL nor the
-- refresh token — both are bearer credentials for the whole calendar.
create or replace view public.my_calendar_feeds
with (security_invoker = true) as
  select id, user_id, label, kind, active,
         last_synced, last_error, event_count, created_at,
         google_account_email,
         (feed_url is not null and feed_url <> '')             as has_url,
         (google_refresh_token is not null)                     as has_google
    from public.calendar_feeds
   where user_id = auth.uid();


-- ─────────────────────────── Notes ───────────────────────────
--
-- Revoking access:
--   Deleting the row here stops this app syncing, but does NOT revoke
--   the grant at Google. The google-disconnect function calls Google's
--   revoke endpoint so the token is genuinely dead, which is what a
--   user pressing "Disconnect" reasonably expects.
--
-- Checking connections:
--   select user_id, kind, google_account_email, last_synced, last_error
--     from public.calendar_feeds order by created_at desc;
