-- ============================================================
-- Foundation rehearsal. Saves NOTHING: the block ends by raising an
-- exception on purpose, which undoes every change it made. Read the
-- PASS and FAIL lines in the error message.
-- Run in Supabase → SQL Editor after schema-foundation.sql.
-- It borrows three existing account ids for a few milliseconds. No
-- personal detail is read or printed.
-- ============================================================
do $$
declare
  v_when constant timestamptz := timestamptz '2026-11-30 12:00:00+10:30';
  v_a uuid; v_b uuid; v_c uuid;
  v_place int;
  r jsonb;
  v_out text := '';
  nl constant text := chr(10);
begin
  select u.id into v_a from auth.users u
   where not exists (select 1 from public.foundation_claims f where f.user_id = u.id)
     and not exists (select 1 from public.subscriptions s where s.user_id = u.id and s.complimentary)
   order by u.created_at limit 1;
  select u.id into v_b from auth.users u
   where u.id <> v_a
     and not exists (select 1 from public.foundation_claims f where f.user_id = u.id)
     and not exists (select 1 from public.subscriptions s where s.user_id = u.id and s.complimentary)
   order by u.created_at limit 1;
  select u.id into v_c from auth.users u
   where u.id <> v_a and u.id <> v_b
     and not exists (select 1 from public.foundation_claims f where f.user_id = u.id)
     and exists (select 1 from public.subscriptions s where s.user_id = u.id)
   order by u.created_at limit 1;

  if v_a is null or v_b is null or v_c is null then
    raise exception 'REHEARSAL NOT RUN. It needs three accounts with no Foundation row. Nothing was saved.';
  end if;
  if (select count(place) from public.foundation_claims) >= 100 then
    raise exception 'REHEARSAL NOT RUN. Foundation is already full. Nothing was saved.';
  end if;

  -- 1. One second before opening is too early, and leaves no row.
  r := public.claim_foundation_place(v_a, 'rehearsal_early', timestamptz '2026-11-21 23:59:59+10:30', 'monthly');
  v_out := v_out || nl || case when r->>'reason' = 'outside_window'
       and not exists (select 1 from public.foundation_claims where user_id = v_a)
    then 'PASS' else 'FAIL' end || ' 1 a subscription before opening gets no place: ' || r::text;

  -- 2. The closing instant itself is too late, and leaves no row.
  r := public.claim_foundation_place(v_a, 'rehearsal_late', timestamptz '2026-12-06 00:00:00+10:30', 'monthly');
  v_out := v_out || nl || case when r->>'reason' = 'outside_window'
       and not exists (select 1 from public.foundation_claims where user_id = v_a)
    then 'PASS' else 'FAIL' end || ' 2 a subscription at the closing instant gets no place: ' || r::text;

  -- 3. A complimentary account gets no place.
  update public.subscriptions set complimentary = true where user_id = v_c;
  r := public.claim_foundation_place(v_c, 'rehearsal_comp', v_when, 'annual');
  v_out := v_out || nl || case when r->>'reason' = 'complimentary' then 'PASS' else 'FAIL' end
    || ' 3 a complimentary account gets no place: ' || r::text;

  -- 4. Fill every free place but one.
  insert into public.foundation_claims (place, paddle_subscription_id, subscribed_at, note)
  select g.n, 'rehearsal_fill_' || g.n, v_when, 'rehearsal'
    from generate_series(1, 100) as g(n)
   where not exists (select 1 from public.foundation_claims f where f.place = g.n)
   order by g.n desc
   offset 1;

  -- 5. The last place goes to a purchase made one second before closing.
  r := public.claim_foundation_place(v_a, 'rehearsal_a', timestamptz '2026-12-05 23:59:59+10:30', 'monthly');
  v_place := (r->>'place')::int;
  v_out := v_out || nl || case when (r->>'member')::boolean and v_place between 1 and 100 then 'PASS' else 'FAIL' end
    || ' 5 the last place is given: ' || r::text;

  -- 6. Asking again gives the same place, not another.
  r := public.claim_foundation_place(v_a, 'rehearsal_a', timestamptz '2026-12-05 23:59:59+10:30', 'monthly');
  v_out := v_out || nl || case when (r->>'place')::int = v_place and (r->>'already')::boolean then 'PASS' else 'FAIL' end
    || ' 6 a retry returns the same place: ' || r::text;

  -- 7. The public answer is zero left and not open.
  r := public.foundation_status();
  v_out := v_out || nl || case when (r->>'places_left')::int = 0 and not (r->>'open')::boolean then 'PASS' else 'FAIL' end
    || ' 7 the public status says none left: ' || r::text;

  -- 8. Subscriber 101 is told full, and is on the waiting list.
  r := public.claim_foundation_place(v_b, 'rehearsal_b', v_when, 'annual');
  v_out := v_out || nl || case when r->>'reason' = 'full'
       and exists (select 1 from public.foundation_claims where user_id = v_b and place is null and note = 'full')
    then 'PASS' else 'FAIL' end || ' 8 subscriber 101 gets no place: ' || r::text;

  -- 9. Subscriber 101 asking again is still refused.
  r := public.claim_foundation_place(v_b, 'rehearsal_b', v_when, 'annual');
  v_out := v_out || nl || case when not (r->>'member')::boolean and r->>'reason' = 'full' then 'PASS' else 'FAIL' end
    || ' 9 a retry for subscriber 101 is still no: ' || r::text;

  -- 10. The table itself refuses place 101.
  begin
    insert into public.foundation_claims (place, paddle_subscription_id, subscribed_at)
    values (101, 'rehearsal_101', v_when);
    v_out := v_out || nl || 'FAIL 10 the table accepted place 101';
  exception when check_violation then
    v_out := v_out || nl || 'PASS 10 the table refuses place 101';
  end;

  -- 11. The table itself refuses a number twice.
  begin
    insert into public.foundation_claims (place, paddle_subscription_id, subscribed_at)
    values (v_place, 'rehearsal_twice', v_when);
    v_out := v_out || nl || 'FAIL 11 the table accepted a place twice';
  exception when unique_violation then
    v_out := v_out || nl || 'PASS 11 the table refuses a place twice';
  end;

  -- 12. Exactly 100 places are held.
  v_out := v_out || nl || case when (select count(place) from public.foundation_claims) = 100 then 'PASS' else 'FAIL' end
    || ' 12 exactly 100 places are held';

  -- 13. A member's second subscription does not carry the place across,
  --     and takes no new one. The row and the number stay as they were.
  r := public.claim_foundation_place(v_a, 'rehearsal_a_again', v_when, 'annual');
  v_out := v_out || nl || case when not (r->>'member')::boolean and r->>'reason' = 'lock_lost'
       and (select count(place) from public.foundation_claims) = 100
       and exists (select 1 from public.foundation_claims
                    where user_id = v_a and place = v_place and paddle_subscription_id = 'rehearsal_a')
    then 'PASS' else 'FAIL' end || ' 13 a member''s second subscription gets no place: ' || r::text;

  raise exception 'REHEARSAL FINISHED. Nothing was saved. %', v_out;
end $$;
