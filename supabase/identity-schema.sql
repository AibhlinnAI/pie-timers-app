-- ============================================================
-- AibhlínnAI shared identity & entitlements.
--
-- This schema knows nothing about Pie Timers. It knows about
-- accounts (auth.users, already product-agnostic — Supabase has no
-- idea what app is asking), and about which product each account can
-- use and why. A second app — the Pomodoro timer, or whatever comes
-- after it — reads and writes here through the same two tables,
-- never through anything named after Pie Timers.
--
-- Run once, after schema.sql. Independent of schema-billing.sql,
-- schema-access-codes.sql etc. — those remain Pie-Timers-specific
-- product data and stay in `public`. Migrating public.subscriptions
-- into this schema is a deliberate follow-up, not done here, because
-- it means re-pointing the live paddle-webhook function and a
-- signed-in customer's billing state should not move on the same
-- night as everything else. See README section "Migrating billing".
-- ============================================================

create schema if not exists identity;

-- ─────────────────────────── product_entitlements ───────────────────────────
-- One row per (account, product, capability). A capability is a verb —
-- "can_sync", "can_use_calendar" — never a plan name, so the app never
-- has to know what "Pro" means; it only asks "can this account do X".
--
-- product_id is a short slug ('pie-timers', 'pomodoro', ...). This is
-- the ONLY table in the identity schema that mentions a product at
-- all, and it does so as data, never as a column name or a table name.
create table if not exists identity.product_entitlements (
  id           uuid        primary key default gen_random_uuid(),
  account_id   uuid        not null references auth.users (id) on delete cascade,
  product_id   text        not null,
  capability   text        not null,
  source       text        not null,   -- 'subscription' | 'hardship' | 'complimentary' | 'trial'
  expires_at   timestamptz,            -- null = does not expire on its own
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, product_id, capability)
);

create index if not exists product_entitlements_account_idx
  on identity.product_entitlements (account_id);

alter table identity.product_entitlements enable row level security;

drop policy if exists "own entitlements: read" on identity.product_entitlements;
create policy "own entitlements: read"
  on identity.product_entitlements for select
  using (auth.uid() = account_id);

-- No insert/update/delete policy for authenticated users on purpose.
-- Every grant comes from a service-role edge function (a webhook, a
-- hardship request, a redeemed pass) so an account can never write
-- its own entitlement.

-- ─────────────────────────── subscriptions ───────────────────────────
-- One row per paid subscription, at the account level. A future suite
-- bundle — one subscription unlocking several apps — is a single row
-- here with several matching rows in product_entitlements, not a
-- schema change.
create table if not exists identity.subscriptions (
  id                   uuid        primary key default gen_random_uuid(),
  account_id           uuid        not null references auth.users (id) on delete cascade,
  provider             text        not null check (provider in ('paddle', 'play')),
  provider_subscription_id text    not null,
  status               text        not null,   -- 'active' | 'past_due' | 'canceled' | 'paused'
  plan                 text        not null,   -- 'monthly' | 'annual' — a label, not a capability
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create index if not exists subscriptions_account_idx
  on identity.subscriptions (account_id);

alter table identity.subscriptions enable row level security;

drop policy if exists "own subscription: read" on identity.subscriptions;
create policy "own subscription: read"
  on identity.subscriptions for select
  using (auth.uid() = account_id);

-- ─────────────────────────── convenience view ───────────────────────────
-- What the client actually reads. security_invoker means it runs as
-- the calling user, so the RLS policies above are what protect it —
-- the view itself grants nothing.
create or replace view identity.my_entitlements
with (security_invoker = true) as
  select product_id, capability, source, expires_at
    from identity.product_entitlements
   where account_id = auth.uid()
     and (expires_at is null or expires_at > now());

-- ─────────────────────────── grant helper ───────────────────────────
-- Used by edge functions (service role) to grant or refresh a
-- capability idempotently. Never exposed to the anon or authenticated
-- role — only the service role calls this.
create or replace function identity.grant_capability(
  p_account_id uuid,
  p_product_id text,
  p_capability text,
  p_source     text,
  p_expires_at timestamptz default null
) returns void
language sql
security definer
set search_path = identity, public
as $$
  insert into identity.product_entitlements
    (account_id, product_id, capability, source, expires_at, updated_at)
  values
    (p_account_id, p_product_id, p_capability, p_source, p_expires_at, now())
  on conflict (account_id, product_id, capability)
  do update set source = excluded.source,
                expires_at = excluded.expires_at,
                updated_at = now();
$$;

revoke all on function identity.grant_capability from public, anon, authenticated;

-- ============================================================
-- After running this file, one manual step in the dashboard:
-- Project Settings → Data API → Exposed schemas → add `identity`
-- alongside `public`. PostgREST only serves schemas listed there,
-- and there is no SQL equivalent — it is a project setting.
-- ============================================================
