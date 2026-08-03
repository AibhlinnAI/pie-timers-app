-- ============================================================
-- Countdown Timers — free trial + access codes
-- Run after schema-billing.sql, in Supabase → SQL Editor.
--
-- Design: there is NO public launch promo code. Everyone gets a
-- two-month trial automatically on sign-up, which does the same
-- job with nothing to leak, guess, or resell.
--
-- Two months rather than one is deliberate: the value of these
-- timers only becomes obvious after living with them across a
-- few real working weeks.
--
-- Access codes remain only for friends and family, and are
-- hardened accordingly: single-use, random, optionally bound to
-- one email address, and rate limited.
-- ============================================================


-- Needed for the cleanup job at the end. Idempotent, and repeated in each
-- schema file so they can be run in any order without failing.
create extension if not exists pg_cron;


-- ═══════════════════════════ FREE TRIAL ═══════════════════════════
-- Granted by a trigger on account creation rather than by anything
-- the client can call, so it cannot be requested twice or forged.

create or replace function public.grant_trial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.subscriptions
    (user_id, status, plan, current_period_end, updated_at)
  values
    (new.id, 'trialing', 'trial', now() + interval '60 days', now())
  on conflict (user_id) do nothing;   -- never overwrite a real subscription
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_grant_trial on auth.users;

create trigger on_auth_user_created_grant_trial
  after insert on auth.users
  for each row execute function public.grant_trial();

-- Backfill anyone who signed up before this was added.
insert into public.subscriptions (user_id, status, plan, current_period_end, updated_at)
select u.id, 'trialing', 'trial', now() + interval '60 days', now()
  from auth.users u
 where not exists (select 1 from public.subscriptions s where s.user_id = u.id)
on conflict (user_id) do nothing;


-- ═══════════════════════════ ACCESS CODES ═══════════════════════════

create table if not exists public.access_codes (
  code             text primary key,           -- stored UPPERCASE
  label            text,                       -- a note to yourself
  kind             text        not null default 'friends',

  -- NULL grants perpetual access.
  grants_days      integer,

  -- Kept for flexibility, but personal codes should always be 1.
  max_redemptions  integer     not null default 1,
  redeemed_count   integer     not null default 0,

  -- The strongest control by far: a code bound to an address is
  -- worthless to anyone else, so there is nothing to resell.
  restricted_to_email text,

  expires_at       timestamptz,
  active           boolean     not null default true,
  created_at       timestamptz not null default now()
);

alter table public.access_codes
  add column if not exists restricted_to_email text;

alter table public.access_codes enable row level security;
-- No client policies. If the browser could read this table, every code
-- could simply be listed.


create table if not exists public.code_redemptions (
  code        text        not null references public.access_codes (code) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.code_redemptions enable row level security;

drop policy if exists "own redemptions: read" on public.code_redemptions;
create policy "own redemptions: read"
  on public.code_redemptions for select using (auth.uid() = user_id);


-- ─────────────────────── Brute-force protection ───────────────────────
-- Without this a signed-in account could work through a dictionary of
-- likely codes. Attempts are recorded per user; ten an hour is far more
-- than an honest person needs.

create table if not exists public.code_attempts (
  id           bigserial primary key,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  succeeded    boolean     not null default false,
  attempted_at timestamptz not null default now()
);

create index if not exists code_attempts_user_idx
  on public.code_attempts (user_id, attempted_at desc);

alter table public.code_attempts enable row level security;
-- No policies: only the redemption function touches this.


-- ─────────────────────────── Redemption ───────────────────────────
--
-- Safety properties:
--   1. The user id comes from auth.uid(), never a parameter.
--   2. SELECT ... FOR UPDATE locks the row, so a cap cannot be
--      exceeded by two simultaneous redemptions.
--   3. Failed attempts are counted and throttled.
--   4. A bound code checks the caller's own verified email.
--   5. Wrong-email and unknown-code return the SAME error, so the
--      response cannot be used to discover which codes exist.

create or replace function public.redeem_access_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code     public.access_codes;
  v_user     uuid := auth.uid();
  v_email    text;
  v_failures integer;
  v_expires  timestamptz;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  select count(*) into v_failures
    from public.code_attempts
   where user_id = v_user
     and succeeded = false
     and attempted_at > now() - interval '1 hour';

  if v_failures >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  insert into public.code_attempts (user_id, succeeded) values (v_user, false);

  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;

  select * into v_code
    from public.access_codes
   where code = upper(btrim(p_code))
   for update;

  if not found or not v_code.active then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;

  if v_code.expires_at is not null and v_code.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Bound codes: the caller must be the nominated address. Deliberately
  -- reported as 'unknown' so a wrong guess reveals nothing.
  if v_code.restricted_to_email is not null then
    select lower(email) into v_email from auth.users where id = v_user;
    if v_email is distinct from lower(v_code.restricted_to_email) then
      return jsonb_build_object('ok', false, 'error', 'unknown');
    end if;
  end if;

  -- Redeeming twice is a no-op success, not an error.
  if exists (
    select 1 from public.code_redemptions
     where code = v_code.code and user_id = v_user
  ) then
    update public.code_attempts set succeeded = true
     where id = (select max(id) from public.code_attempts where user_id = v_user);
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if v_code.redeemed_count >= v_code.max_redemptions then
    return jsonb_build_object('ok', false, 'error', 'exhausted');
  end if;

  insert into public.code_redemptions (code, user_id) values (v_code.code, v_user);
  update public.access_codes set redeemed_count = redeemed_count + 1
   where code = v_code.code;

  if v_code.grants_days is null then
    v_expires := null;                                   -- perpetual
  else
    v_expires := now() + make_interval(days => v_code.grants_days);
  end if;

  insert into public.subscriptions
    (user_id, status, plan, complimentary, current_period_end, updated_at)
  values
    (v_user, 'active', 'complimentary', true, v_expires, now())
  on conflict (user_id) do update
     set complimentary      = true,
         status             = 'active',
         plan               = 'complimentary',
         -- Never shorten access someone already has.
         current_period_end = case
           when excluded.current_period_end is null then null
           when public.subscriptions.current_period_end is null
             and public.subscriptions.complimentary then null
           else greatest(
             coalesce(public.subscriptions.current_period_end, excluded.current_period_end),
             excluded.current_period_end
           )
         end,
         updated_at         = now();

  update public.code_attempts set succeeded = true
   where id = (select max(id) from public.code_attempts where user_id = v_user);

  return jsonb_build_object('ok', true, 'grants_days', v_code.grants_days,
                            'expires_at', v_expires);
end;
$$;

revoke all on function public.redeem_access_code(text) from public, anon;
grant execute on function public.redeem_access_code(text) to authenticated;


-- ─────────────────────── Minting personal codes ───────────────────────
-- Random, single-use, and bound to one address. The alphabet omits
-- 0/O/1/I so a code can be read aloud without ambiguity.

create or replace function public.mint_access_code(
  p_email  text,
  p_label  text default null,
  p_days   integer default null       -- NULL = perpetual
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  i integer;
begin
  loop
    v_code := 'MATE-';
    for i in 1..4 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    v_code := v_code || '-';
    for i in 1..4 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.access_codes where code = v_code);
  end loop;

  insert into public.access_codes
    (code, label, kind, grants_days, max_redemptions, restricted_to_email)
  values
    (v_code, coalesce(p_label, p_email), 'friends', p_days, 1, lower(btrim(p_email)));

  return v_code;
end;
$$;

revoke all on function public.mint_access_code(text, text, integer) from public, anon, authenticated;


-- ═══════════════════════════ HOUSEKEEPING ═══════════════════════════

create or replace function public.prune_code_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.code_attempts where attempted_at < now() - interval '7 days';
$$;

select cron.unschedule('countdown-prune-code-attempts')
where exists (select 1 from cron.job where jobname = 'countdown-prune-code-attempts');

select cron.schedule(
  'countdown-prune-code-attempts',
  '52 3 * * *',
  $$ select public.prune_code_attempts(); $$
);


-- ═══════════════════════════ HOW TO USE ═══════════════════════════
--
-- Mint a perpetual code for one person:
--   select public.mint_access_code('friend@example.com', 'Jo — perpetual');
--
-- Mint a one-year code:
--   select public.mint_access_code('friend@example.com', 'Jo — 1 year', 365);
--
-- That code works ONLY for that address, once. Sharing or selling it
-- achieves nothing, because the redeeming account's own email must match.
--
-- See who has what:
--   select c.code, c.label, c.restricted_to_email, c.redeemed_count,
--          c.max_redemptions, c.active, r.redeemed_at
--     from public.access_codes c
--     left join public.code_redemptions r on r.code = c.code
--    order by c.created_at desc;
--
-- Kill a code immediately:
--   update public.access_codes set active = false where code = 'MATE-XXXX-XXXX';
--
-- Watch for abuse (a spike here means someone is guessing):
--   select user_id, count(*) filter (where not succeeded) as failures
--     from public.code_attempts
--    where attempted_at > now() - interval '1 day'
--    group by user_id order by failures desc limit 20;
