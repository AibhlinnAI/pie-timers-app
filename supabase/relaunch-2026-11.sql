-- ============================================================
-- Pie Timers — the launch offer, reset on 22 Nov 2026
-- Run ONCE, in Supabase → SQL Editor, after schema-access-codes.sql
-- has been re-run with the new trial_length().
--
-- Pie Timers went public on Google Play on 22 Nov 2026 and the launch
-- offer was reset to match: an account made before 22 Nov 2026 gets
-- Premium free until the end of 5 Dec 2026 (6 Dec 00:00 +10:30,
-- Adelaide time), even if its earlier trial had already run out.
--
-- trial_length() cannot do this. It only acts when an account is
-- created, and every account this is for already exists. So this file
-- moves their trial rows to the new finish line directly.
--
-- What it touches: rows on the free trial (plan 'trial') that are not
-- complimentary and were made before 22 Nov. What it leaves alone:
-- complimentary accounts, anyone who has ever subscribed (their plan
-- is 'monthly' or 'annual', cancelled or not), and any trial that
-- already runs past the finish line.
--
-- Safe to run twice: the second run matches no rows.
-- ============================================================


-- 1. BEFORE. How many rows step 2 will move. On 22 Nov 2026 this was 31
--    (24 lapsed trials and 7 still running).
select count(*) as rows_to_move
  from public.subscriptions
 where plan = 'trial'
   and coalesce(complimentary, false) = false
   and created_at < timestamptz '2026-11-22 00:00:00+10:30'
   and (current_period_end is null
        or current_period_end < timestamptz '2026-12-06 00:00:00+10:30');


-- 2. THE CHANGE. Returns one row per account moved, with no personal
--    details: count the rows and compare with step 1.
update public.subscriptions
   set status = 'trialing',
       current_period_end = timestamptz '2026-12-06 00:00:00+10:30',
       updated_at = now()
 where plan = 'trial'
   and coalesce(complimentary, false) = false
   and created_at < timestamptz '2026-11-22 00:00:00+10:30'
   and (current_period_end is null
        or current_period_end < timestamptz '2026-12-06 00:00:00+10:30')
returning status, plan, current_period_end;


-- 3. AFTER. Expect rows_to_move = 0, and every trial row made before
--    22 Nov ending on or after the finish line.
select
  (select count(*)
     from public.subscriptions
    where plan = 'trial'
      and coalesce(complimentary, false) = false
      and created_at < timestamptz '2026-11-22 00:00:00+10:30'
      and (current_period_end is null
           or current_period_end < timestamptz '2026-12-06 00:00:00+10:30')) as rows_to_move,
  (select count(*)
     from public.subscriptions
    where plan = 'trial'
      and current_period_end = timestamptz '2026-12-06 00:00:00+10:30')      as on_the_finish_line,
  (select count(*)
     from public.subscriptions
    where coalesce(complimentary, false))                                    as complimentary_untouched;
