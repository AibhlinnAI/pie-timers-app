-- ============================================================
-- Countdown Timers — billing / entitlements
-- Run after schema.sql, in Supabase → SQL Editor.
--
-- Design note: the FREE tier is everything on a single device.
-- The pies, schedule, calculator and in-app alerts are never
-- paywalled — people have to feel the benefit before there is
-- anything worth paying for. Paid adds only what costs money to
-- run: cross-device sync and background push.
-- ============================================================

create table if not exists public.subscriptions (
  user_id             uuid primary key references auth.users (id) on delete cascade,

  -- Mirrors Paddle's own status values.
  status              text        not null default 'none',
  -- 'annual' | 'monthly' | 'complimentary'
  plan                text,

  paddle_customer_id      text,
  paddle_subscription_id  text unique,

  -- Access runs to here. Null means no time-bounded access.
  current_period_end  timestamptz,
  cancel_at_period_end boolean    not null default false,

  -- Set by hand to grant free access to someone who cannot pay.
  complimentary       boolean     not null default false,

  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists subscriptions_paddle_sub_idx
  on public.subscriptions (paddle_subscription_id);

alter table public.subscriptions enable row level security;

drop policy if exists "own subscription: read" on public.subscriptions;

-- Read-only to the client. Every write comes from the Paddle webhook
-- using the service-role key, so a user cannot grant themselves access.
create policy "own subscription: read"
  on public.subscriptions for select
  using (auth.uid() = user_id);


-- ─────────────────────────── Entitlement ───────────────────────────
-- One place that decides whether an account is entitled, so the app,
-- the sync engine and the push job can never disagree about it.

create or replace function public.has_active_plan(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select s.complimentary
          or (
            s.status in ('active', 'trialing', 'past_due')
            and (s.current_period_end is null or s.current_period_end > now())
          )
      from public.subscriptions s
      where s.user_id = uid
    ),
    false
  );
$$;

-- Convenience view the client reads instead of interpreting raw status.
create or replace view public.my_entitlement
with (security_invoker = true) as
  select
    s.user_id,
    s.status,
    s.plan,
    s.current_period_end,
    s.cancel_at_period_end,
    s.complimentary,
    public.has_active_plan(s.user_id) as entitled
  from public.subscriptions s
  where s.user_id = auth.uid();


-- ─────────────────────────── Webhook audit log ───────────────────────────
-- Paddle retries on failure, so events must be idempotent. Recording the
-- event id and rejecting duplicates is what makes that safe.

create table if not exists public.billing_events (
  event_id    text primary key,
  event_type  text        not null,
  user_id     uuid references auth.users (id) on delete set null,
  payload     jsonb       not null,
  received_at timestamptz not null default now()
);

alter table public.billing_events enable row level security;
-- No policies: the client has no business reading raw billing events.


-- ─────────────────────────── Push gating ───────────────────────────
-- The milestone job should only push to entitled accounts. Marking the
-- subscription row is cheaper than joining on every run.

create or replace function public.entitled_user_ids()
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id from public.subscriptions s
  where public.has_active_plan(s.user_id);
$$;


-- ─────────────────────────── Granting free access ───────────────────────────
-- For anyone who genuinely cannot pay. Run this by hand:
--
--   insert into public.subscriptions (user_id, status, plan, complimentary)
--   select id, 'active', 'complimentary', true from auth.users
--   where email = 'someone@example.com'
--   on conflict (user_id) do update
--     set complimentary = true, status = 'active', plan = 'complimentary',
--         updated_at = now();
