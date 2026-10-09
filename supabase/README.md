# Applying the database schema

Everything here is **idempotent** — safe to run again if you are unsure whether a file
took. Nothing drops a table or deletes user data.

## The short version

In Supabase → **SQL Editor**, open a new query, then paste and run each file's
contents in this order:

| # | File | What the file creates | Needed if |
| - | ---- | --------------- | --------- |
| 1 | `schema.sql` | profiles, push subscriptions, notification log | Always |
| 2 | `schema-billing.sql` | subscriptions, entitlement, billing events | Always |
| 3 | `schema-access-codes.sql` | **14-day free trial**, friends-and-family codes | Always |
| 4 | `schema-ratelimit.sql` | sign-in throttle store | Always |
| 5 | `schema-calendar.sql` | calendar feeds and events, **appointments column** | Always |
| 6 | `schema-breaks.sql` | **breaks column** (extra breaks, lunch's length) | Always, before deploying functions |
| 7 | `schema-google-calendar.sql` | Google one-click columns | Only for Google |
| 8 | `schema-tester-signups.sql` | the Android tester form's write-only `tester_signups` | Always |
| 9 | `schema-visit-counts.sql` | first-open totals, the tag list, and their nightly job | Always |
| 10 | `cron.sql` | the scheduled jobs — **edit the placeholders first** | After deploying functions |

Steps 1–9 are plain copy-paste with nothing to edit. **Only `cron.sql` needs
editing**, and only after the edge functions are deployed, because the file points at
their URLs.

Three of these are needed even if you skip the optional features:

- **Step 3** carries the free-trial trigger, not just the access codes.
- **Step 5** adds the `appointments` column to `timer_profiles`. Without that column, manual
  appointments do not sync between devices.
- **Step 6** adds the `breaks` column to `timer_profiles`, and must run before the edge
  functions are deployed: `notify-milestones` asks for `breaks` by name, so without the
  column it cannot read any profile and no pushes are sent for anyone. The live project
  already has the column (added 27 Sep 2026).

## Checking the run worked

```sql
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;
```

Expect: `access_codes`, `billing_events`, `calendar_events`, `calendar_feeds`,
`code_attempts`, `code_redemptions`, `notification_log`, `push_subscriptions`,
`signin_attempts`, `subscriptions`, `tester_signups`, `timer_profiles`,
`visit_counts`, `visit_sources`.

Row-level security must be on for every one of them:

```sql
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relkind = 'r'
 order by relname;
```

Every row should read `true`. If any is `false`, that table is readable by anyone
holding the public anon key — re-run the file that created the key.

Confirm the trial trigger exists:

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created_grant_trial';
```

Then sign up a test account and check the grant landed:

```sql
select u.email, s.status, s.plan, s.current_period_end
  from auth.users u join public.subscriptions s on s.user_id = u.id
 order by s.created_at desc limit 5;
```

Expect `trialing` / `trial` and a date 14 days out — or, for an account
made during launch month before 18 Oct 2026, `2026-11-01 00:00+10:30`
exactly. `select public.trial_length();` says which rule is live.

## Scheduled jobs

After running `cron.sql`:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Expect `countdown-calendar-sync`, `countdown-milestones`,
`countdown-prune-calendar`, `countdown-prune-code-attempts`,
`countdown-prune-log`, `countdown-prune-signins`,
`countdown-settle-visit-counts`, `countdown-vacuum-visit-counts`. The last
two come from `schema-visit-counts.sql`, not `cron.sql`.

If something is not firing:

```sql
select jobname, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

`succeeded` there only means the request was queued. What the function
answered is in `net._http_response`, which keeps about six hours. On
27–28 Sep 2026 every calendar-sync run answered 546 for at least that long
while `cron.job_run_details` said `succeeded` every time:

```sql
select status_code, count(*), min(created), max(created)
  from net._http_response group by 1 order by 1;
```

A healthy calendar-sync run answers 200 with counts only, for example
`{"ok":true,"due":8,"synced":8,"failed":0,"died":0,"deferred":0}`. `died` is
a feed whose own worker was killed or timed out; that feed's row says so in
`last_error`, which the person sees in the app.

## Reading the first-open counts

`schema-visit-counts.sql` keeps daily totals of the first time the app opens
in a browser (`app/visits.js`, `privacy.html` section 9). Read them in the
SQL Editor, or Table Editor → `visit_counts`. There is no view on purpose.

```sql
-- First opens a day, last 30 days (Adelaide dates)
select day,
       sum(n) filter (where platform = 'web')  as web,
       sum(n) filter (where platform = 'play') as play,
       sum(n)                                   as total
  from public.visit_counts
 where kind = 'first_open'
   and day > (now() at time zone 'Australia/Adelaide')::date - 30
 group by day order by day desc;

-- Where they came from, over a range
select c.source,
       coalesce(s.label, case c.source when 'none' then 'no tag' else 'tag not on the list' end) as what,
       sum(c.n) as first_opens
  from public.visit_counts c
  left join public.visit_sources s using (source)
 where c.kind = 'first_open'
   and c.day between date '2026-10-01' and date '2026-10-31'
 group by 1, 2 order by 3 desc;
```

How to read them:

- They are first opens per **browser**, not people. A private window, an
  iPhone home-screen app or cleared site data counts again; GPC/DNT, blocked
  storage or a send that failed does not count at all.
- Safari on iPhone and Mac deletes a site's stored data, the "already
  counted" note included, after 7 days of browsing without a visit to it. A
  returning Safari visitor who has been away that long counts again, usually
  under `none`. Nothing in the browser can prevent this without keeping
  something about them on the server, which the count refuses to do.
- `play` means this browser's **first open happened in the Play app**. The
  Play app runs inside the phone's Chrome and shares its storage, so someone
  who used the website in Chrome on that phone first (almost every current
  tester, who joined through the web form) appears only under `web`, and
  their Play installs never show up here. It is not a count of Play installs:
  use Play Console for those.
- Google's pre-launch report opens the Play app on 5–10 freshly wiped test
  devices for every upload to a testing track, and each one looks exactly
  like a new person. Keep the report off while counting is on (DEPLOY.md
  5.5, step 6) until the wrapper sends `#count=off` on those devices. If it
  ran anyway, release days show extra `play | none` first opens. Google's
  own review of a release can add one or two as well.
- A day's rows are rewritten together shortly after midnight Adelaide time
  (the `countdown-settle-visit-counts` job), so no row keeps a trace of the
  request that last added to it. Today's rows have not been rewritten yet.
- `current_date` in the SQL Editor is UTC, so always use the Adelaide
  expression above.
- `none` is an untagged link (typed, bookmarked, shared, the t-shirt code);
  `other` is a tag not on the list in `visit_sources`.
- A cell stuck at 100000, or a day far above any before it with nothing to
  explain it (an event, a printed code, a Play release), is abuse: anyone
  holding the public key can add to a total. There is no second count to
  check it against: `pietimers.aibhlinn.ai` is DNS only in Cloudflare, so
  our Cloudflare account keeps no logs or totals of the app (`DEPLOY.md`
  3.1). The project's API traffic does pass through Cloudflare, as
  Supabase's own network provider, but that is Supabase's account, not
  ours. For `play`, Play Console's install figures are a separate check.
- Before sharing numbers outside the business, merge any cell under 5 into a
  bigger group.

## If a run fails partway

Every file can simply be run again. The common causes:

- **`schema "cron" does not exist`** — the `pg_cron` extension is not enabled.
  Each schema file creates the role grant, so re-running the file usually repairs this. Otherwise
  enable `pg_cron` and `pg_net` under Database → Extensions.
- **`relation "subscriptions" does not exist`** — step 2 has not run yet. The order
  in the table above matters.
- **Placeholders in `cron.sql`** — `<PROJECT_REF>`, `<ANON_KEY>` and
  `<CRON_SECRET>` must all be replaced with real values, or the jobs will be
  created but silently fail.

## A note on secrets

`cron.sql`'s `Authorization` header only has to satisfy the edge function
gateway's own JWT check, not grant any real permission -- the functions the gateway
calls read their own service-role key from their own environment, never from
this header — so the call deliberately uses the anon key (already public in
`app/config.js`) instead of the service-role key. `<CRON_SECRET>` is the
real gate, and must match the `CRON_SECRET` set on both the
`notify-milestones` and `calendar-sync` functions, and both those functions
now fail closed (reject every request) when unset, rather than
silently accepting anything. Keep the filled-in copy of this file out of
public source control regardless — the cron secret is still worth
protecting, just not at "database password" severity.
