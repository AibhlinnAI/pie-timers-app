# Applying the database schema

Everything here is **idempotent** — safe to run again if you are unsure whether it
took. Nothing drops a table or deletes user data.

## The short version

In Supabase → **SQL Editor**, open a new query, then paste and run each file's
contents in this order:

| # | File | What it creates | Needed if |
| - | ---- | --------------- | --------- |
| 1 | `schema.sql` | profiles, push subscriptions, notification log | Always |
| 2 | `schema-billing.sql` | subscriptions, entitlement, billing events | Always |
| 3 | `schema-access-codes.sql` | **two-month free trial**, friends-and-family codes | Always |
| 4 | `schema-ratelimit.sql` | sign-in throttle store | Always |
| 5 | `schema-calendar.sql` | calendar feeds and events, **appointments column** | Always |
| 6 | `schema-google-calendar.sql` | Google one-click columns | Only for Google |
| 7 | `cron.sql` | the scheduled jobs — **edit the placeholders first** | After deploying functions |

Steps 1–6 are plain copy-paste with nothing to edit. **Only `cron.sql` needs
editing**, and only after the edge functions are deployed, because it points at
their URLs.

Two of these are needed even if you skip the optional features:

- **Step 3** carries the free-trial trigger, not just the access codes.
- **Step 5** adds the `appointments` column to `timer_profiles`. Without it, manual
  appointments do not sync between devices.

## Checking it worked

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;
```

Expect: `access_codes`, `billing_events`, `calendar_events`, `calendar_feeds`,
`code_attempts`, `code_redemptions`, `notification_log`, `push_subscriptions`,
`signin_attempts`, `subscriptions`, `timer_profiles`.

Row-level security must be on for every one of them:

```sql
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relkind = 'r'
 order by relname;
```

Every row should read `true`. If any is `false`, that table is readable by anyone
holding the public anon key — re-run the file that created it.

Confirm the trial trigger exists:

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created_grant_trial';
```

Then sign up a test account and check it was granted:

```sql
select u.email, s.status, s.plan, s.current_period_end
  from auth.users u join public.subscriptions s on s.user_id = u.id
 order by s.created_at desc limit 5;
```

Expect `trialing` / `trial` and a date about 60 days out.

## Scheduled jobs

After running `cron.sql`:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Expect `countdown-calendar-sync`, `countdown-milestones`,
`countdown-prune-calendar`, `countdown-prune-code-attempts`,
`countdown-prune-log`, `countdown-prune-signins`.

If something is not firing:

```sql
select jobname, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

## If a run fails partway

Every file can simply be run again. The common causes:

- **`schema "cron" does not exist`** — the `pg_cron` extension is not enabled.
  Each schema file creates it, so re-running the file usually fixes it. Otherwise
  enable `pg_cron` and `pg_net` under Database → Extensions.
- **`relation "subscriptions" does not exist`** — step 2 has not run yet. The order
  in the table above matters.
- **Placeholders in `cron.sql`** — `<PROJECT_REF>`, `<SERVICE_KEY>` and
  `<CRON_SECRET>` must all be replaced with real values, or the jobs will be
  created but silently fail.

## A note on secrets

`cron.sql` contains your service-role key once filled in. That key bypasses every
row-level security policy. Keep the filled-in copy out of public source control,
and treat it as you would a database password.
