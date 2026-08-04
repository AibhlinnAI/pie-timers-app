-- ============================================================
-- Hardship / sliding-scale access. Run after schema-billing.sql
-- and identity-schema.sql, in Supabase → SQL Editor.
--
-- Self-certified, on purpose: no evidence, no justification field,
-- no review queue. The friction that already exists — creating a
-- genuine email account, itself throttled by the sign-in rate limit
-- in schema-ratelimit.sql — is the only barrier this design accepts.
-- Adding a form, a delay, or a manual approval step here would
-- directly contradict "no questions asked", which is the point of
-- this tier, not an oversight to be closed later.
--
-- Distinguished from the founder's manual complimentary grants
-- (schema-billing.sql's "Granting free access" note) by plan value
-- alone — 'hardship' vs 'complimentary' — so the two are told apart
-- in the database without a separate audit table. Counting self-serve
-- volume is one query away:
--   select count(*) from public.subscriptions where plan = 'hardship';
-- ============================================================

create or replace function public.grant_hardship_access()
returns jsonb
language plpgsql
security definer
set search_path = public, identity
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  -- Idempotent: a second click (a slow connection, an impatient tap)
  -- is a no-op success, never a duplicate or an error. Never shortens
  -- access someone already has — mirrors redeem_access_code's own rule.
  insert into public.subscriptions
    (user_id, status, plan, complimentary, current_period_end, updated_at)
  values
    (v_user, 'active', 'hardship', true, null, now())
  on conflict (user_id) do update
     set complimentary      = true,
         status             = 'active',
         -- A hardship grant never downgrades an existing paid or
         -- complimentary plan's label; it only ever adds coverage.
         plan               = coalesce(public.subscriptions.plan, 'hardship'),
         current_period_end = null,
         updated_at         = now();

  -- Suite-wide record too, so a future AibhlínnAI app sees this grant
  -- without knowing anything about Pie Timers or this table. Pie
  -- Timers' own gating still reads public.subscriptions above — see
  -- identity-schema.sql's note on why that migration is separate,
  -- deliberately unrushed work rather than done here.
  perform identity.grant_capability(v_user, 'pie-timers', 'can_sync', 'hardship', null);
  perform identity.grant_capability(v_user, 'pie-timers', 'can_use_calendar', 'hardship', null);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.grant_hardship_access() from public, anon;
grant execute on function public.grant_hardship_access() to authenticated;
