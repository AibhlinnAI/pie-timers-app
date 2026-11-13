-- ============================================================
-- Countdown Timers — Background alerts: keep them for the people
-- who already get them
--
-- A one-off for a project that ran the app from before v136. A new
-- project never needs it. Run in Supabase → SQL Editor. Safe to run
-- twice: the second run finds nobody.
--
-- NOT RUN YET on the live project (tgapmpbcqqnpsldehuqa). When it
-- has run, replace this line with the date and the three numbers.
--
-- THE ORDER MATTERS:
--   1. run this file, and see still_off = 0 in step 3;
--   2. publish app v136 (merge to main) straight afterwards. If time
--      has passed since step 1, run this file again first;
--   3. deploy notify-milestones.
-- The app must not go out first. From v136 a device whose Background
-- alerts switch is off removes its own row from push_subscriptions the
-- next time it opens. That row is the only record of who was getting
-- alerts with the app closed, so after that there is nobody left here
-- to find. (The function going out first is the smaller mistake: their
-- alerts stop, and come back when this has run.)
-- ============================================================

-- Until v136 the Background alerts switch (settings.push) stopped
-- nothing. Every signed-in device that had allowed notifications was
-- subscribed, and notify-milestones sent to every subscription whose
-- account had Milestone alerts (settings.alerts) on. The switch is off
-- by default, so nearly everyone getting alerts with the app closed has
-- it off. From v136 and the function deployed with it, the switch
-- means what it says, and those people would lose their alerts without
-- being told. Mal's decision, 10 Oct 2026: they keep them.
--
-- So for every account that gets alerts with the app closed today
-- (Milestone alerts on, and at least one subscription), Background
-- alerts is switched on. Their switch then shows what they already
-- have, and switching it off works from then on.
--
-- This cannot tell someone who never touched the switch from someone
-- who switched it off and was subscribed again anyway. Both read
-- push = false. The second group will find it on.


-- ─────────────────────────── 1. Preview ───────────────────────────
-- How many accounts step 2 will change. Changes nothing.

select count(*) as to_switch_on
  from public.timer_profiles p
 where p.settings -> 'alerts' = 'true'::jsonb
   and p.settings -> 'push' is distinct from 'true'::jsonb
   and exists (select 1 from public.push_subscriptions s where s.user_id = p.user_id);


-- ─────────────────────────── 2. Switch it on ───────────────────────────
-- updated_at has to move, and forwards. Sync is last write wins on this
-- column (app/sync.js): a row that is not newer than a device's own copy
-- loses to it, and that device would send push = false straight back.
-- now() covers every device with a true clock. The other half covers a
-- device whose clock runs ahead: the row it last wrote is stamped later
-- than now(), so the row moves one millisecond past its own stamp. A
-- tie goes to the row.
--
-- A device holding an edit it has not sent yet still wins, as it would
-- over any other device. Run this when the app is quiet, and run step 3
-- afterwards.

with switched as (
  update public.timer_profiles p
     set settings   = jsonb_set(p.settings, '{push}', 'true'::jsonb),
         updated_at = greatest(now(), p.updated_at + interval '1 millisecond')
   where p.settings -> 'alerts' = 'true'::jsonb
     and p.settings -> 'push' is distinct from 'true'::jsonb
     and exists (select 1 from public.push_subscriptions s where s.user_id = p.user_id)
  returning 1
)
select count(*) as switched_on from switched;


-- ─────────────────────────── 3. Check ───────────────────────────
-- Expect still_off = 0. Anything else is an account that gets alerts
-- with the app closed today and would stop: run step 2 again.

select count(*) filter (where p.settings -> 'push' = 'true'::jsonb)           as background_alerts_on,
       count(*) filter (where p.settings -> 'push' is distinct from 'true'::jsonb) as still_off
  from public.timer_profiles p
 where p.settings -> 'alerts' = 'true'::jsonb
   and exists (select 1 from public.push_subscriptions s where s.user_id = p.user_id);
