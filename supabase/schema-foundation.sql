-- ============================================================
-- Pie Timers: Foundation places
-- Run after schema-billing.sql, in Supabase → SQL Editor.
-- Idempotent: safe to re-run. It never deletes or renumbers a row.
-- Run it BEFORE deploying the paddle-webhook that calls it. Until it
-- has run, that function answers 500 to every new subscription and
-- Paddle keeps retrying.
--
-- Foundation is a price lock with 100 places: the first 100 people
-- to subscribe from 22 Nov 2026 to the end of 31 Dec 2026 (Adelaide
-- time). Subscriber 101 still subscribes at the same price, without
-- the lock. Nothing here ever blocks a purchase. This file is what
-- makes 100 mean 100.
--
-- The close was first the end of 5 Dec 2026. Mal moved it to the end
-- of 31 Dec 2026 on 22 Nov 2026. The closing instant is written into
-- the two function bodies below, and both are "create or replace", so
-- running this file again is what moves a database that still has the
-- old close. No row is touched. Check afterwards with
-- supabase/test-foundation.sql: its step 5 fails on the old close.
--
-- The cap is a property of the table, not of any code. place is
-- unique and must be 1 to 100, so a 101st place cannot be stored by
-- the function below, by a later version of it, or by hand.
--
-- One row per account Foundation has decided about:
--   place 1..100  a Foundation member
--   place null    no place: Foundation was full when they subscribed
--                 (note 'full'), the account was complimentary (note
--                 'complimentary'), or the owner withheld or withdrew
--                 it (any other note)
-- A row is decided once. The function never changes an existing row,
-- and a cancellation never touches this table, so a number once
-- given is never given to anyone else. Whether a member still holds
-- the lock is read from public.subscriptions (see "Reading the list").
--
-- The only write path is claim_foundation_place(), called by the
-- paddle-webhook edge function on subscription.created, or this
-- editor. anon, authenticated and service_role have no rights on the
-- table at all. The public pages read one thing,
-- foundation_status(): how many places are left and whether
-- Foundation is open.
--
-- The opening instant below is the 22 Nov boundary in trial_length()
-- (schema-access-codes.sql). The closing instant must match
-- FOUNDATION_CLOSES in app/pricing.html and app/foundation.html, the
-- pie on foundation.html, and the copy on those pages. If one moves,
-- move all of them. tools/foundation-test.mjs compares them.
-- paddle-webhook holds neither instant: it passes on when the
-- subscription was made and this file judges it. The close is NOT the
-- end of 5 Dec 2026 in trial_length(): that one is only the finish
-- line of the free trial for accounts made before 22 Nov.
-- ============================================================

create table if not exists public.foundation_claims (
  id            bigint generated always as identity primary key,

  -- The account. Null only once that account has been deleted: the
  -- place stays taken.
  user_id       uuid unique references auth.users (id) on delete set null,

  -- THE CAP. 1 to 100, or null for "holds no place". Unique, so no
  -- number is held twice; checked, so there is no 101.
  place         smallint
                constraint foundation_claims_place_key unique
                constraint foundation_claims_place_cap check (place between 1 and 100),

  -- The Paddle subscription that earned the place. If the account's
  -- live subscription is a different one, the lock has been lost.
  paddle_subscription_id text unique,

  -- The plan that is locked: 'monthly' or 'annual'.
  plan          text check (plan in ('monthly', 'annual')),

  -- Paddle's own created_at for the subscription. This instant, not
  -- the time the webhook arrived, is judged against the closing date.
  subscribed_at timestamptz,

  -- When this row was written. Places were given in this order.
  claimed_at    timestamptz not null default now(),

  -- Why there is no place, or the owner's remark. Never a name or an
  -- email address.
  note          text,

  constraint foundation_place_needs_subscription
    check (place is null
           or (paddle_subscription_id is not null and subscribed_at is not null))
);

alter table public.foundation_claims enable row level security;
-- No policies. Supabase's defaults grant new public tables to all
-- three API roles; none of them needs this one.
revoke all on table public.foundation_claims from anon, authenticated, service_role;


-- ─────────────────────────── The only write path ───────────────────────────
-- Safety properties:
--   1. One claim at a time: the table lock makes "find the lowest
--      free place, then take it" a single step. Readers are not
--      blocked. A hand edit in this editor queues behind it too.
--   2. Decided once: an account that already has a row gets that
--      row's answer back, so a Paddle retry or a replay changes
--      nothing and never takes a second place. A member's second
--      subscription is told the lock was lost; it is not given the
--      old place again and does not take a new one.
--   3. The closing date is judged on p_subscribed_at, which the
--      webhook takes from Paddle's signed payload, so a delivery
--      that arrives late is judged as of the purchase.
--   4. Even with all of the above removed, the table's own
--      constraints refuse a 101st place or a repeated number.
-- Answers:
--   {"member": true,  "place": n}                     a new place
--   {"member": true,  "place": n, "already": true}    asked again
--   {"member": false, "reason": "lock_lost", "already": true}  a member's
--        later subscription: the place was earned by a different one
--   {"member": false, "reason": "full"}               all 100 taken
--   {"member": false, "reason": "complimentary"}
--   {"member": false, "reason": "outside_window"}     no row is kept
--   {"member": false, "reason": "no_place", "already": true}   withheld or withdrawn
create or replace function public.claim_foundation_place(
  p_user_id         uuid,
  p_subscription_id text,
  p_subscribed_at   timestamptz,
  p_plan            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  -- Adelaide time (+10:30). Open from the start of 22 Nov 2026 to
  -- the end of 31 Dec 2026.
  c_opens  constant timestamptz := timestamptz '2026-11-22 00:00:00+10:30';
  c_closes constant timestamptz := timestamptz '2027-01-01 00:00:00+10:30';
  v_row    public.foundation_claims;
  v_place  smallint;
  v_plan   text := case when p_plan in ('monthly', 'annual') then p_plan end;
begin
  if p_user_id is null or p_subscribed_at is null
     or p_subscription_id is null or btrim(p_subscription_id) = '' then
    raise exception 'claim_foundation_place: account, subscription and time are all required';
  end if;

  lock table public.foundation_claims in share row exclusive mode;

  select * into v_row from public.foundation_claims where user_id = p_user_id;
  if found then
    if v_row.place is not null then
      -- The lock belongs to the subscription that earned it. A member
      -- who cancels and subscribes again has a new subscription: the
      -- row and the number stay as they are, nothing new is given, and
      -- the answer is the one "Reading the list" gives for that account.
      if v_row.paddle_subscription_id is distinct from p_subscription_id then
        return jsonb_build_object('member', false, 'already', true, 'reason', 'lock_lost');
      end if;
      return jsonb_build_object('member', true, 'place', v_row.place, 'already', true);
    end if;
    return jsonb_build_object(
      'member', false, 'already', true,
      'reason', case when v_row.note in ('full', 'complimentary')
                     then v_row.note else 'no_place' end);
  end if;

  -- Outside the window: not a Foundation subscription. No row, or
  -- every subscriber for ever after would add one.
  if p_subscribed_at < c_opens or p_subscribed_at >= c_closes then
    return jsonb_build_object('member', false, 'reason', 'outside_window');
  end if;

  -- A complimentary account is not a subscriber. paddle-webhook never
  -- clears the flag, so one that goes through checkout is still caught.
  if exists (select 1 from public.subscriptions s
              where s.user_id = p_user_id and s.complimentary) then
    insert into public.foundation_claims
      (user_id, paddle_subscription_id, plan, subscribed_at, note)
    values (p_user_id, p_subscription_id, v_plan, p_subscribed_at, 'complimentary');
    return jsonb_build_object('member', false, 'reason', 'complimentary');
  end if;

  select min(g.n)::smallint into v_place
    from generate_series(1, 100) as g(n)
   where not exists (select 1 from public.foundation_claims f where f.place = g.n);

  if v_place is null then
    -- Recorded, so the waiting list is in order and the answer is
    -- the same on a retry.
    insert into public.foundation_claims
      (user_id, paddle_subscription_id, plan, subscribed_at, note)
    values (p_user_id, p_subscription_id, v_plan, p_subscribed_at, 'full');
    return jsonb_build_object('member', false, 'reason', 'full');
  end if;

  insert into public.foundation_claims
    (user_id, place, paddle_subscription_id, plan, subscribed_at)
  values (p_user_id, v_place, p_subscription_id, v_plan, p_subscribed_at);

  return jsonb_build_object('member', true, 'place', v_place);
end;
$$;

revoke all on function public.claim_foundation_place(uuid, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.claim_foundation_place(uuid, text, timestamptz, text)
  to service_role;


-- ─────────────────────────── The only public read ───────────────────────────
-- Two facts and nothing else: how many places are left, and whether
-- Foundation is open. It takes no argument and reads nothing about
-- the caller, so the answer is the same for everyone. It takes no
-- lock, so it never waits behind a claim.
create or replace function public.foundation_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'places_left', greatest(0, 100 - taken.n),
    'open', now() >= timestamptz '2026-11-22 00:00:00+10:30'
        and now() <  timestamptz '2027-01-01 00:00:00+10:30'
        and taken.n < 100
  )
  from (select count(place)::int as n from public.foundation_claims) as taken;
$$;

revoke all on function public.foundation_status() from public, anon, authenticated;
grant execute on function public.foundation_status() to anon, authenticated;

-- Pick up the new functions without waiting for the schema cache.
notify pgrst, 'reload schema';


-- ── Checking the run worked (read-only) ──
-- Expect: false | false | false | false | false | true | true | true
-- select
--   has_table_privilege('anon', 'public.foundation_claims', 'select')          as anon_reads,
--   has_table_privilege('authenticated', 'public.foundation_claims', 'select') as signed_in_reads,
--   has_table_privilege('service_role', 'public.foundation_claims', 'insert')  as service_writes_directly,
--   has_function_privilege('anon', 'public.claim_foundation_place(uuid,text,timestamptz,text)', 'execute')          as anon_claims,
--   has_function_privilege('authenticated', 'public.claim_foundation_place(uuid,text,timestamptz,text)', 'execute') as signed_in_claims,
--   has_function_privilege('service_role', 'public.claim_foundation_place(uuid,text,timestamptz,text)', 'execute')  as service_claims,
--   has_function_privilege('anon', 'public.foundation_status()', 'execute')    as anon_status,
--   (select relrowsecurity from pg_class where oid = 'public.foundation_claims'::regclass) as rls_on;
--
-- Expect {"open": true, "places_left": 100} on a fresh run inside the window:
-- select public.foundation_status();


-- ── Reading the count and the list (SQL editor only; there is no view,
--    because a view in public is one more thing the API exposes) ──
--
-- The count:
-- select count(place) as taken, 100 - count(place) as places_left,
--        count(*) filter (where place is null and note = 'full') as waiting
--   from public.foundation_claims;
--
-- The members, and whether each still holds the lock. The email comes
-- from auth.users at read time; no address is stored in this table.
-- select f.place, f.plan,
--        f.subscribed_at at time zone 'Australia/Adelaide' as subscribed_adelaide,
--        case
--          when f.user_id is null then 'account deleted'
--          when s.paddle_subscription_id is distinct from f.paddle_subscription_id
--            then 'lock lost: a different subscription'
--          when s.status in ('active', 'trialing', 'past_due') then 'holds the lock'
--          else 'lock lost: ' || coalesce(s.status, 'no subscription')
--        end as standing,
--        s.cancel_at_period_end as leaving,
--        u.email
--   from public.foundation_claims f
--   left join public.subscriptions s on s.user_id = f.user_id
--   left join auth.users u on u.id = f.user_id
--  where f.place is not null
--  order by f.place;
--
-- Everyone without a place, the waiting list first and in order:
-- select f.id, f.note, f.claimed_at, u.email
--   from public.foundation_claims f
--   left join auth.users u on u.id = f.user_id
--  where f.place is null
--  order by (f.note = 'full') desc, f.claimed_at, f.id;
--
-- Subscriptions made inside the window that have no decision. Expect
-- no rows. A row here is a claim that never happened: run the
-- catch-up at the end of this file.
-- select distinct on (e.payload->'data'->>'id')
--        e.payload->'data'->>'id' as subscription,
--        (e.payload->'data'->>'created_at')::timestamptz as subscribed_at
--   from public.billing_events e
--  where e.event_type like 'subscription.%'
--    and e.user_id is not null
--    and (e.payload->'data'->>'created_at')::timestamptz >= timestamptz '2026-11-22 00:00:00+10:30'
--    and (e.payload->'data'->>'created_at')::timestamptz <  timestamptz '2027-01-01 00:00:00+10:30'
--    and not exists (select 1 from public.foundation_claims f where f.user_id = e.user_id)
--  order by e.payload->'data'->>'id', e.received_at;


-- ── Keeping an account out, or taking a place back ──
-- One statement does both. Before the account subscribes it writes a
-- row with no place, which the function then honours for good. After,
-- it empties the place and keeps the row, so the account cannot claim
-- again. The freed number goes to the next claim unless you give it
-- to the waiting list first (below): run the two together.
-- returning proves it matched: no row back means the address was wrong.
--
--   insert into public.foundation_claims as c (user_id, note)
--   select u.id, 'withheld: testing account'
--     from auth.users u where u.email = 'someone@example.com'
--   on conflict (user_id) do update
--      set note = 'withdrawn: testing account'
--                 || coalesce(' (was place ' || c.place || ')', ''),
--          place = null
--   returning id, place, note;
--
-- Give a free place to the first in line. Changes nothing if there
-- is no free place or nobody waiting:
--
--   update public.foundation_claims c
--      set place = (select min(g.n)::smallint from generate_series(1, 100) as g(n)
--                    where not exists (select 1 from public.foundation_claims f
--                                       where f.place = g.n)),
--          note = 'from the waiting list'
--    where c.id = (select id from public.foundation_claims
--                   where place is null and note = 'full'
--                   order by claimed_at, id limit 1)
--      and (select count(place) from public.foundation_claims) < 100
--   returning c.place, c.claimed_at;
--
-- Undo a withhold made by mistake, before the account has subscribed:
--
--   delete from public.foundation_claims f using auth.users u
--    where f.user_id = u.id and u.email = 'someone@example.com'
--      and f.place is null and f.paddle_subscription_id is null
--   returning f.id;


-- ── Catching up, after paddle-webhook is deployed, and whenever the
--    "no decision" query above returns a row ──
-- Replays every known subscription through the same function, in
-- Paddle's order. Safe to repeat: an account already decided gets the
-- same answer, and a subscription outside the window gets no row. On
-- 22 Nov 2026 it should give no new place, because nobody had
-- subscribed.
--
--   select x.subscribed_at,
--          public.claim_foundation_place(x.user_id, x.subscription, x.subscribed_at, x.plan) as decision
--     from (select distinct on (e.payload->'data'->>'id')
--                  e.user_id,
--                  e.payload->'data'->>'id' as subscription,
--                  (e.payload->'data'->>'created_at')::timestamptz as subscribed_at,
--                  case e.payload->'data'->'billing_cycle'->>'interval'
--                    when 'year' then 'annual' when 'month' then 'monthly' end as plan
--             from public.billing_events e
--            where e.event_type like 'subscription.%'
--              and e.user_id is not null
--              and e.payload->'data'->>'id' is not null
--              and e.payload->'data'->>'created_at' is not null
--            order by e.payload->'data'->>'id', e.received_at) x
--    order by x.subscribed_at;
