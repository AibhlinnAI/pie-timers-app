# Deploying Pie Timers

Target: **https://pietimers.aibhlinn.ai**, served from GitHub Pages out of
`AibhlinnAI/pie-timers-app`.

Work through this in order. Steps 1–4 get the app live. Steps 5–8 turn on the
services. You can stop after step 4 and have a working, free, on-device app —
which is deliberate, because that is what most people will use.

---

## Before you start

**The repo will be public.** GitHub Pages needs a public repo on the free plan.
That is fine — every file in `app/` is downloaded by the browser anyway, so
nothing there was ever private. The Supabase anon key and the Paddle client
token are *designed* to be public and are protected by row-level security.

These must **never** be committed:

| Secret | Correct home |
| --- | --- |
| Supabase service-role key | Supabase → Edge Functions → Secrets |
| VAPID **private** key | Supabase → Edge Functions → Secrets |
| Paddle webhook secret | Supabase → Edge Functions → Secrets |
| Paddle API key (server, `pdl_live_apikey_…`) | Supabase → Edge Functions → Secrets, as `PADDLE_API_KEY`. Unrelated to the client-side token in `config.js` — this one calls Paddle's API from two functions, and that one only opens a checkout in the browser. `manage-subscription` uses it to open the customer portal. `paddle-webhook` uses it to move a new subscriber's first payment date (5.6), so the key must be allowed to change subscriptions [check label: the permission names on a Paddle API key were not read from Paddle]. With the key missing, or not allowed to do that, `paddle-webhook` still switches Premium on but answers 500 to every subscription made on a trial price. |
| Turnstile secret key | Supabase → Edge Functions → Secrets |
| Google client secret | Supabase → Edge Functions → Secrets |
| Store review address and code (`REVIEW_EMAIL`, `REVIEW_CODE`) | Supabase → Edge Functions → Secrets, and Play Console → Sign-in details. Nowhere else. See `app/README.md` step 4c. |
| Resend API key | Supabase → Authentication → SMTP |

`.gitignore` covers the usual accidents, and the deploy workflow refuses to
publish on finding a private key or a service-role JWT in `app/`. Neither is a
substitute for not pasting them in.

---

## 1. Create the repo

On github.com, create **`pie-timers-app`**, public, with no README or
`.gitignore` (this project already has one).

Then, from the project folder:

```bash
git init -b main
```

```bash
git add . && git commit -m "Pie Timers: initial release"
```

```bash
git remote add origin https://github.com/AibhlinnAI/pie-timers-app.git
```

```bash
git push -u origin main
```

## 2. Turn on Pages

Repo → **Settings → Pages → Source: GitHub Actions**.

Do not pick "Deploy from a branch". The workflow in
`.github/workflows/deploy.yml` uploads only the `app/` folder, which is what
keeps `supabase/` out of the published site.

The first deploy runs automatically on push. Watch the run in the **Actions** tab.

## 3. Point the domain

DNS for `aibhlinn.ai` is on Cloudflare. Add:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | `pietimers` | `aibhlinnai.github.io` | **DNS only (grey cloud)** |

Two things that are easy to get wrong here, and both fail quietly:

- The target is the **user** domain `aibhlinnai.github.io` — not the repo URL,
  and note the `ai` on the end of `aibhlinnai`. A typo still resolves, because
  every `*.github.io` shares the same four IP addresses, so the record looks
  healthy while the domain never verifies.
- Leave the proxy **grey**. Orange-clouded, GitHub cannot validate the domain
  and the certificate stays pending forever, which looks like a GitHub fault.
  Leave it grey afterwards too: see 3.1 before ever switching it.

Then repo → **Settings → Pages → Custom domain** → `pietimers.aibhlinn.ai` → Save.
The domain is kept in Settings from then on. `app/CNAME` holds the same name,
but GitHub may ignore that file for a deploy made by Actions, as this one is,
so after a **Remove** the domain has to be entered here again by hand.

Wait for the DNS check to go green, then tick **Enforce HTTPS**. This can take
up to an hour while the certificate is issued. Do not skip this step: without HTTPS
the service worker will not register and push notifications cannot work at all.

### 3.1 The Cloudflare proxy: not used, and why

`pietimers.aibhlinn.ai` stays **DNS only**. Turning it orange was researched on
9 and 10 Oct 2026 and deferred until after Launch Month. If it is ever revisited,
these come first, in this order:

1. **Disclose it.** `privacy.html` sections 6 and 9 must say that Cloudflare
   passes the app's files on, keeps server logs, and gives daily totals, and
   that change must be live before the cloud turns orange. Today they say
   none of this, because none of it happens.
2. **Plan for certificate renewal.** GitHub renews the site's certificate
   itself, and that is reported to fail while the record is proxied. Under
   Full (strict), an expired certificate is error 526 on every page. The
   routine is: grey the cloud, wait for the new certificate, orange it again.
   If that report holds, the routine comes round at every renewal: about
   every two months on today's 90-day certificates, and more often as Let's
   Encrypt shortens lifetimes (64 days from February 2027, 45 from February
   2028). Measure the real interval first: read the live certificate's
   expiry date, and check whether it moves while the record is proxied.
3. **Turn off everything that changes a response, before the switch.** Not
   four settings but about twenty, several on by default: Email Address
   Obfuscation (it would rewrite every `mailto:` link), Automatic HTTPS
   Rewrites, Rocket Loader, Cloudflare Fonts, Speed Brain, Early Hints, Web
   Analytics automatic setup, Zaraz, Bot Fight Mode and its JavaScript
   Detections, Replace insecure JavaScript libraries, Always Online, Network
   Error Logging and client-side script monitoring, plus anything Cloudflare
   has switched on since. Pin each one off for this hostname with a
   Configuration Rule, and bypass the cache with a Cache Rule.
4. **Then check, from outside.** Every page served through the proxy must be
   byte-identical to the repo, with no added `nel`, `report-to`,
   `speculation-rules` or `set-cookie` header. `deploy.yml`'s tracker check
   cannot see anything added at Cloudflare's edge.

Only Flexible SSL/TLS (or Off) causes the redirect loop with Enforce HTTPS.
Full (strict) is the right mode because it also checks GitHub's certificate,
which is exactly why a lapsed one takes the site down.

## 4. Check the site

Open **https://pietimers.aibhlinn.ai/diagnostics.html**.

At this point expect: secure context PASS, legal pages PASS, Supabase N/A.
That is a correct result for an app with no backend yet.

---

## 5. Supabase

Create the project in **ap-southeast-2 (Sydney)**. The privacy policy states
that region as fact — if you pick another one, change `privacy.html` section 5
the same day.

### 5.1 Run the SQL, in this order

Each file is idempotent, so re-running one is safe. Tick them off as they go.

- [ ] `schema.sql`
- [ ] `schema-billing.sql`
- [ ] `schema-access-codes.sql`
      (`relaunch-2026-11.sql` is not part of a fresh setup. It was a one-off
      for the accounts that existed when the launch offer was reset on
      22 Nov 2026, and matches no rows on a project made after that.)
- [ ] `schema-foundation.sql`: the 100 Foundation places. One table that
      cannot hold a 101st place, the one function `paddle-webhook` claims
      through, and the one function the Pricing and Foundation pages read.
      Run it **before** deploying `paddle-webhook` (5.3): until it has run,
      that function answers 500 to every new subscription and Paddle keeps
      retrying. See 5.6.
- [ ] `schema-ratelimit.sql`
- [ ] `schema-calendar.sql`
- [ ] `schema-breaks.sql` — always, and before the functions (5.3) or `cron.sql`:
      `notify-milestones` asks for the `breaks` column by name, so without it the
      function cannot read any profile and no pushes are sent for anyone. The live
      project already has the column (added 27 Sep 2026).
- [ ] `schema-google-calendar.sql`
- [ ] `identity-schema.sql`
- [ ] `schema-tester-signups.sql` — the Android tester form's write-only
      `tester_signups` table. Without it every sign-up from the form fails.
- [ ] `schema-visit-counts.sql` — the first-open totals and the tag list. Run it
      before `countFirstOpens` is turned on in `app/config.js` (see 5.5).
- [ ] `cron.sql` — last, because the file schedules a job against edge functions that do
      not exist until 5.3.

Then, on any project that existed before self-certified hardship was removed:

- [ ] `drop-hardship.sql` — drops `public.grant_hardship_access()`. Safe on a
      project that never had one, and worth running even where the function
      looks harmless: a `security definer` function nothing calls is attack
      surface earning nothing. Not needed on a project created from scratch
      today. Check with
      `select proname from pg_proc where proname = 'grant_hardship_access';`
      — no rows means nothing to do.

### 5.2 Expose the identity schema

**Dashboard step, no SQL. Nothing that reads the identity schema works
until this is done, and the failure is silent in both directions: the
paddle-webhook mirror throws on every event and Paddle retries forever,
while the screen saver reads a permission error instead of an empty set.**

- [ ] **Project settings → Data API → Exposed schemas** → add `identity`
      alongside `public` and `graphql_public`. Save.

Verify rather than assume — this query answers all of that at once:

```sql
select
  (select count(*) from information_schema.schemata
     where schema_name = 'identity')                        as schema_exists,
  (select count(*) from information_schema.tables
     where table_schema = 'identity')                       as relation_count,
  has_schema_privilege('service_role','identity','USAGE')   as svc_schema,
  has_function_privilege('service_role',
    'identity.grant_capability(uuid,text,text,text,timestamptz)',
    'EXECUTE')                                              as svc_exec,
  has_schema_privilege('authenticated','identity','USAGE')  as auth_schema,
  has_table_privilege('authenticated',
    'identity.my_entitlements','SELECT')                    as auth_view;
```

- [ ] `schema_exists` 1, `relation_count` 3 (two tables and a view), and the
      four privilege columns all `true`.

Note that `current_setting('pgrst.db_schemas', true)` returns NULL in the SQL
editor whether or not the schema is exposed — the setting applies to the
`authenticator` role, not your session. Do not read anything into the result. To check
exposure from outside, request the schema over the REST API: `PGRST106 Invalid
schema` means not exposed, and a permissions error means exposed and correctly
locked down.

### 5.3 Edge functions and URL configuration

- [ ] Deploy the eight edge functions, each with `--no-verify-jwt` except
      `manage-subscription`: signin, delete-account, paddle-webhook,
      manage-subscription, notify-milestones, calendar-sync, google-connect,
      review-signin.
- [ ] **Authentication → URL Configuration → Site URL**:
      `https://pietimers.aibhlinn.ai` — no trailing slash.
- [ ] **Redirect URLs**: `https://pietimers.aibhlinn.ai/**` — both asterisks.

Sign-in links silently fail to return if these do not match, and this is the most
common cause of "the email arrived but clicking the link does nothing".

### 5.4 Wire the app up

- [ ] Put the project URL and the **publishable** key into `app/config.js`.
- [ ] Push, then rerun diagnostics. Every table and function should PASS.

### 5.5 The first-open count

`app/visits.js` adds one to a daily total the first time the app opens in a
browser (`privacy.html` section 9, `ARCHITECTURE.md` rule 3). It ships
switched off, and goes on in this order, because the disclosure must be live
before anything is counted:

1. The Cloudflare proxy disclosure (branch `cloudflare-proxy-counts`) merges
   first. Done: PR #34, live 30 Sep 2026. Withdrawn 10 Oct 2026: the record
   was never proxied, so `privacy.html` now names Cloudflare only for
   Turnstile and for email to our `@aibhlinn.ai` addresses (6.3). Do not
   restore it unless the proxy is switched on (see 3.1).
2. Before the counter's pull request merges, settle these:
   - the Supabase plan's retention figures. Done 10 Oct 2026: the project is
     on Free, so `privacy.html` says request logs and the sign-in log are kept
     1 day and that there are no backups. If the plan changes, the comment at
     the top of `privacy.html` lists the four statements to change;
   - "Last updated" at the top of `privacy.html`: set it to the merge date.
     Section 13 promises the date always reflects the current version;
   - the next free `CACHE` number, used in `CACHE` and in `visits.js?v=` in
     both `index.html` and `sw.js`.
3. Run `supabase/schema-visit-counts.sql` in the SQL Editor, then the checks
   at the end of that file. They include the nightly job that rewrites each
   finished day's totals together (see the file's header for why).
   Done 10 Oct 2026 (via `supabase db query --linked -f`, the file as
   merged in #35: blob 4712467ca3ba, which a rebase or squash leaves
   unchanged): every check matched, an anonymous read of either table is
   refused (401, 42501), and the function answers 204 while counting nothing
   for an unknown platform. Re-running the file is safe, but it re-grants
   execute to anon, so re-run it after a kill-switch revoke only on purpose.
4. Merge the counter with `countFirstOpens: false`. The disclosure is live and
   nothing is counted yet. Done: #35, live 10 Oct 2026 (CACHE v118).
5. Decide whether the promise in `privacy.html` section 13 (an email before a
   material change) applies, and check the new `privacy.html` is live.
6. **Google Play, before anything counts.** Done 10 Oct 2026: the Data safety
   answers and the listing copy below were changed in Play Console and sent
   for review, and the Play Console pack matches. The Play app counts too (as
   `play`), so the Play-facing statements must change first:
   - **Data safety:** decide the answer and record it in the Play Console pack
     (a private working file, not in this repo; its section 5 today says
     "Not collected: ... app interactions"). Most likely: App activity → App
     interactions: collected, for Analytics, not shared. Google counts "the
     number of times they visit a page" as app interactions, and anonymised
     data is exempt only from the sharing answer, not the collection one.
     Update it in Play Console.
   - **Store listing:** the pack's section 8 copy says "No ads, no analytics,
     no trackers". Change it to "No ads, no third-party analytics, no
     trackers", matching `privacy.html`, in the pack and in Play Console.
   - **Pre-launch report: it cannot be turned off.** Older help pages
     describe a "Turn on pre-launch report" checkbox under Pre-launch report →
     Settings → Preferences. As of 10 Oct 2026 that section is gone: the page
     has only credentials, deep links, languages and a Robo script, and
     Google's help no longer mentions an opt-out. On every upload to a
     testing track it opens the Play app on 5–10 freshly wiped Test Lab
     devices. They pass every check in `visits.js` (no WebDriver, ordinary
     Chrome, empty storage, the Play referrer), so each is counted as a
     `play | none` first open. Until the wrapper fix in "The Play app and
     Google's test devices" below ships, read `play | none` on a day a build
     was uploaded as mostly robots. Google's own review of each release can
     add one or two `play` first opens as well; nothing on the web can tell.
7. Merge a one-line change: `countFirstOpens: true` in `app/config.js`, plus
   the next `CACHE` bump (v124 on 25 Oct 2026: v121 and v123 were claimed
   by unmerged branches). No `?v=` change: `config.js` is unversioned, and the
   `CACHE` bump is what makes installed copies fetch it again.
8. Check it live (it writes to production). Open
   `https://pietimers.aibhlinn.ai/#src=test` in a **Chrome, Edge or Safari**
   private window, not Firefox, Brave or DuckDuckGo: those send Global Privacy
   Control, and under GPC nothing is counted. Keep the tab in front for 5 s,
   then run:

   ```sql
   select day, source, platform, n
     from public.visit_counts
    where day = (now() at time zone 'Australia/Adelaide')::date
      and source in ('test', 'other');
   ```

   Expect `<today> | test | web | 1`. A row under `other` instead means the
   `visit_sources` insert did not run: run it, then check again in a new
   private window. Clean up with
   `delete from public.visit_counts where source = 'test';`.

**No row at all** means this browser was not counted, not that the SQL
failed. The usual reasons: the browser sends GPC or Do Not Track; it has
opened the app before, or has been marked with `#count=off`; the tab was
closed or hidden within about 2 s of loading (it will then send on its next
open); or it was offline. Try a fresh private window in Chrome or Edge before
looking at the SQL or the grants.

If the app ships before the SQL, the call answers 404 and those first opens are
silently lost.

#### To stop counting

`countFirstOpens: false` on its own is **not** an instant stop. `sw.js`
serves `config.js` cache-first under an unversioned URL, so a browser whose
first open is still pending (closed within 2 s, opened offline, never shown)
keeps reading the old `true` and sends on its next open. Even with a `CACHE`
bump, the first load after the deploy is still served by the old worker. So:

1. **At once, server-side:** in the SQL Editor run
   `revoke execute on function public.count_first_open(text, text) from anon;`.
   This stops every count immediately, including scripted calls with the
   public key. Browsers that still call get an error they ignore, and mark
   themselves counted. To undo, re-run the `grant execute ...` line from
   `schema-visit-counts.sql`. Re-running the whole file also re-grants, so for
   a lasting stop change the file too (and `tools/check-visits.js` S3 with it).
2. **Then, client-side:** merge `countFirstOpens: false` **with** the next
   `CACHE` bump, so the requests stop being made at all.

#### Surfaces that must never count

A foyer screen is a display, not an open.

- Kiosk and event pages (`/ndexpo26/`, `/nls26/`, `/nsw26/`, `/nwc26/`,
  `/stall41/`) load no shared scripts, so they never count. Their QR codes
  count when the scan lands in the app.
- The Windows screensaver loads the live app in its own WebView2 profile,
  which shares nothing with the person's browser. `Program.SaverUrl` ends in
  `#count=off`, so each profile is marked counted and sends nothing. A `.scr`
  built before that change counts once per install: rebuild it before counting
  goes on. `tools/check-visits.js` fails the build if the fragment is removed.

#### The Play app and Google's test devices

The only fix for the pre-launch report (step 6), since it cannot be turned
off, belongs in the Android
wrapper, which is not in this repository. Subclass Bubblewrap's
`LauncherActivity`, point the manifest's launcher activity at it, bump
`versionCode` and upload:

```java
public class LauncherActivity
    extends com.google.androidbrowserhelper.trusted.LauncherActivity {
  @Override
  protected Uri getLaunchingUrl() {
    Uri url = super.getLaunchingUrl();
    // Set on every Firebase Test Lab device, which the pre-launch report uses.
    if ("true".equals(Settings.System.getString(getContentResolver(), "firebase.test.lab"))) {
      return url.buildUpon().fragment("count=off").build();
    }
    return url;
  }
}
```

`visits.js` already honours `#count=off` and strips it before `app.js` runs;
Play detection uses the referrer, not the fragment, so it is unaffected. Once
that release is on every track, `play | none` is people again.

#### Tagging a QR code

1. Pick a tag for a place or a printed item, **never a person**: a tag handed to
   one person turns a total into "this person opened the app". Use `a-z`,
   `0-9` and `-`, 24 characters at most.
2. Add it to the seed list in `supabase/schema-visit-counts.sql` in the same
   commit, and run just its `insert` in the SQL Editor.
3. Encode `https://pietimers.aibhlinn.ai/#src=<tag>`.
4. Scan the printed code once with iOS Camera and once with Google Lens, but do
   not let the camera open it: the phone's ordinary browser profile has used
   the app before (or carries `#count=off`) and sends nothing. Copy the scanned
   address into a Chrome or Safari private window instead, or use a device
   that has never opened the app. Then run the query in step 8 above with your
   tag in place of `'test'`. Expect a row for today under your tag; if it
   lands in `other`, the insert did not run. No row at all: see "No row at
   all" above.
5. Mal's own devices, and any stall device that wipes its profile: open
   `/#count=off` once, or launch with it on the URL.

### 5.6 Foundation places

Foundation has 100 places and the database holds it to 100
(`supabase/schema-foundation.sql`). The order matters. For the release that
adds it (the Black Friday Launch Offer, 22 Nov 2026) the order is: the SQL,
then the 7-day trial on the monthly trial price in Paddle (the tick below
says why), then the `paddle-webhook` function, then Test A in 8.4, then the
pages, then the aibhlinn.ai advert. The SQL and the function are run by hand; the pages
go out when the branch is merged to `main`. Merge last, and only once Test A
has shown 1 Jan 2027 on a real throwaway purchase: that date is the offer.
Publish the aibhlinn.ai site branch only after that merge is live and
`foundation.html` shows the Black Friday Launch Offer. Its advert links to
that page, and until then the live page still describes the October offer.

**The terms were revised on 22 Nov 2026, and two things here changed with
them.** Foundation first closed at the end of 5 Dec 2026. It now closes at
the end of 31 Dec 2026 in the last time zone on Earth, the instant
`2027-01-01T12:00Z` (10:30 pm on 1 Jan in Adelaide, the same instant as the
first payment), or when all 100 places are taken. It was Adelaide midnight
for a few hours on 22 Nov; the owner moved it so the pages need no
"(Adelaide time)". The trial dates moved the same way: "before 22 Nov" is
before `2026-11-22T12:00Z` and "the end of 5 Dec" is `2026-12-06T12:00Z`. That instant is
written into the two functions in `schema-foundation.sql`, so if the file
was run before the change, run it again. It is idempotent and touches no
row. Then run `test-foundation.sql`: its step 5 fails on the old close. And
`paddle-webhook` carries a new first-payment rule (8.4), so deploy it again
as well. Until both are done the database closes Foundation on 5 December
and the function still uses the old rule, whatever the pages say. The end of
5 December is now only the trial finish line for accounts made before
22 Nov. It is not the offer's close and not a subscribe-by date.

- [ ] The trial rules the pages describe are running. Both are read-only:
      `select public.trial_length();` returns `14 days` (so
      `schema-access-codes.sql` has been re-run with the 22 Nov dates), and
      step 3 of `supabase/relaunch-2026-11.sql` returns `rows_to_move = 0`
      (so the accounts made before 22 Nov have been moved to the end of
      5 Dec). The pages tell an account made before 22 Nov that its trial
      runs to the end of 5 December "even if an earlier trial had run out".
      Until that file has been run, a lapsed account that believes it and
      subscribes is charged on the day.
- [ ] Before anything else, confirm Paddle's field names against events
      already stored (read-only):
      `select payload->'data'->>'created_at' as created_at,
              payload->'data'->>'started_at' as started_at,
              payload->>'occurred_at' as occurred_at
         from public.billing_events
        where event_type = 'subscription.created' limit 3;`
      `created_at` must be a timestamp, not null.
- [ ] The privacy policy change must be live with or before the pages (the
      Pricing and Foundation pages start asking Supabase for the count). It
      is in the same push as the pages, so never publish `pricing.html` or
      `foundation.html` without `privacy.html`.
- [ ] Mal has read and agreed the two new sentences in `privacy.html` before
      that push: the Foundation places count in the Supabase row of
      section 6, and the Foundation line under "What we keep". They were
      written as a draft on 22 Nov 2026. The same goes for the "Who can
      join" wording on `foundation.html`.
- [ ] Run `schema-foundation.sql`.
- [ ] Run the privilege check in that file. Expect
      `false | false | false | false | false | true | true | true`.
- [ ] `select public.foundation_status();` Expect
      `{"open": true, "places_left": 100}`.
- [ ] Run `supabase/test-foundation.sql`. It always ends in an error: that is
      what undoes it. Every line of the message must start with PASS. A FAIL
      on line 5 means the database still closes Foundation on 5 December:
      run `schema-foundation.sql` again.
- [ ] `select public.foundation_status();` again. Still 100.
- [ ] In Paddle, set the monthly trial price's trial period to **7 days**.
      Catalogue, then Products, then the Pie Timers product, then the
      monthly price that carries a trial (its id is `monthlyTrialPriceId`
      in `app/config.js`), then edit its trial period [check label]. That
      menu path was not read from Paddle, so check each label as you go,
      and whether Paddle lets you change the trial on an existing price was
      not checked either. If it does not, make a new monthly price with a
      7-day trial and tell Claude its id: `monthlyTrialPriceId` in
      `config.js` then has to change, which is a code change with its own
      release. Leave the yearly trial price at 14 days and leave the two
      plain prices alone.
      Why (Mal, 22 Nov 2026: "consistency is critical when offering value
      for early loyalty"): Paddle counts a trial from the purchase, so
      checkout shows the purchase plus the trial, and `paddle-webhook`
      never moves a date earlier than checkout showed. With 14 days on the
      monthly price, someone who subscribes on day 10 of their trial is
      shown day 24 and keeps it, while someone who subscribes on day 1 gets
      day 21. Subscribing early is punished. With 7 days, checkout always
      shows a date on or before day 21, so the function always moves the
      date later, and every monthly subscriber ends on the same date:
      21 days after they made their account, or 1 Jan 2027 if that is
      later. Yearly needs no change: the purchase plus 14 days is at most
      day 28, under 30.
      If it is left at 14 days, nobody is charged early: the function still
      never moves a date earlier than checkout showed. But a monthly
      subscriber who subscribes after day 7 of their trial keeps a later
      date than one who subscribes early, and the pages' "Checkout may show
      an earlier first-payment date" is not what they see.
      Do this in the same sitting as the function deploy below, not days
      before it. With 7 days on the price, a move that does not happen
      means a charge 7 days after subscribing, so the function has to be
      the version that answers 500 and retries when a move fails (below).
      Afterwards, open the monthly checkout on a throwaway account that is
      still in its trial and confirm it shows a first payment 7 days out.
- [ ] Confirm the SQL is in place one more time, straight before the
      function goes out: `select public.foundation_status();` answers. Do
      not deploy the function until it does (see "wrong order" below).
- [ ] Deploy the function: `supabase functions deploy paddle-webhook`.
- [ ] Run the catch-up statement at the end of `schema-foundation.sql`. On
      22 Nov 2026 it gives no new place, because nobody had subscribed.
- [ ] Keep the paid testing service's accounts out. They do not qualify for
      Foundation (Mal's decision) and nothing in the database marks them, so
      run the withhold statement in `schema-foundation.sql` ("Keeping an
      account out") once for each tester sign-in address, with a note such
      as 'withheld: testing account'. Each run must return one row; no row
      means the address matched no account. Do this before the pages go
      out, because their trials run to 5 December and any of them can
      subscribe from the moment the offer is published. Keep the addresses
      out of this repo.
- [ ] Run Test A in 8.4 on a throwaway account. Do not publish the pages
      until it has shown `next_billed_at` on 1 Jan 2027. (That is the date
      for an account made and subscribed on the same day until early
      December. 8.4 gives the dates after that.)
- [ ] Publish the pages. Open `pricing.html` and `foundation.html` signed out:
      both say 100 of 100 places.
- [ ] Block the Supabase host in the browser's developer tools and reload:
      Pricing says it could not check, Foundation shows no number.
- [ ] With the pages live, sign in to the app as an account that has
      subscribed on a trial price and has not been charged yet (the Test A
      account, if its subscription is still there). Settings shows the plan
      as "Monthly, first payment from" and a date, not "Free trial". No
      plans are offered there. On `pricing.html`, the status line says
      "You're already on AibhlínnAI Premium", and choosing a plan says the
      same without opening checkout. This was read from the code and run
      against stubs (P22 in `tools/foundation-test.mjs`), never in a
      browser, so this tick is the first real look at it.
- [ ] Last, publish the aibhlinn.ai site branch, once the live
      `foundation.html` shows the Black Friday Launch Offer. That site's
      advert takes itself down after the end of 31 Dec 2026. Its
      time must not be earlier than `2027-01-01T12:00Z`, the instant this
      repo closes the offer: `.github/workflows/retire-offer.yml` in the site repo, which
      only runs once it is on that repo's `main`. Its README says how to
      run it by hand, and how to take down only the Foundation line if the
      100 places fill early.

**Nothing has to be taken down by hand on 1 January 2027.** The offer panel
on `pricing.html` and the hook on `foundation.html` are taken down by their
own scripts at the closing instant. The descriptions of both pages carry no
offer and no date. The offer sentence in `terms.html` opens with the day the
offer ends, so it stays true afterwards. Foundation closes in the database.
The first-payment rule has no cut-off.

**One thing still needs eyes, on that day and every other: a 500 from
`paddle-webhook`.** No page and no script can put right a first-payment move
that keeps failing ("What a retry cannot do", below). Everyone who subscribes
during the offer has their first payment from 12:00 UTC on 1 January 2027. A
monthly subscriber of 25 to 31 December whose move is stuck would be charged
7 days after subscribing, on 1 to 7 January, earlier than the day 21 the
pages promise. Before going away for any stretch that covers late December
or the first week of January:

- [ ] Search the `paddle-webhook` function log for "Could not defer first
      charge". Expect no line since it was last checked. If there is one,
      follow "What a retry cannot do" below before leaving.
- [ ] In Paddle, list the subscriptions whose status is `trialing` [check
      label: the Subscriptions list and its status filter were not read
      from Paddle]. None may show a next payment before 1 Jan 2027. A
      monthly one whose next payment is 7 days after it was made (14 days
      on yearly) is a move that did not happen.
- [ ] Decide who watches for a failed delivery while you are away, and
      check it reaches them [check label: where Paddle sends its
      failed-notification emails, and to which address, was not read from
      Paddle]. If nobody will be watching, that is a known gap: a stuck
      move in that window is found only afterwards.

The lock, by hand, if you want to see it (two SQL editor tabs, saves
nothing). Tab 1: `begin; lock table public.foundation_claims in share row
exclusive mode; select pg_sleep(8); rollback;` Tab 2, inside those 8 seconds:
run `test-foundation.sql`. It waits (or stops after 5 seconds with a lock
timeout), and `select public.foundation_status();` answers at once.

While Foundation is open, run the "no decision" query in the SQL file every
day or two. It should return no rows. A row is a subscriber whose claim
never happened: run the catch-up.

Also open each new subscription made on a trial price in Paddle and check
`next_billed_at` against the rule in 8.4. Until the new year that is 1 Jan
2027 (`2027-01-01T12:00:00Z`) for most accounts, and later for an account
whose own 30 days (yearly) or 21 days (monthly) run past it. It is never
before 1 Jan 2027, and never earlier than the date checkout showed. On a
monthly plan, with the 7-day trial on the price, checkout shows a date
7 days out and the function moves it every time.

A move that was needed and did not happen now retries (Mal's instruction,
22 Nov 2026; until then it was logged and answered 200). There are four ways
a move can fail: the Paddle key is missing ("PADDLE_API_KEY not set"); the
account's creation date could not be read (the lookup failed, there was no
row, or the date did not parse); the payload gave neither Paddle's own date
nor a purchase time; or Paddle refused the date change or could not be
reached. In each of them `paddle-webhook` first writes everything else (the
`public.subscriptions` row, the identity grants and the Foundation claim, so
Premium is on from the first attempt), writes a log line starting "Could not
defer first charge", and then answers 500 without recording the event, so
Paddle sends the event again and the move is tried again. A retry is safe:
the date is worked out from the account, the plan and the payload, so it is
the same date each time, and moving a date to where it already sits changes
nothing.

What a retry cannot do is fix a cause that does not go away by itself. A
missing key stays missing until it is set, and an account with no creation
date on record fails every time. Paddle stops retrying after its own limit
(not read from Paddle: check its notification log), and from then on the
customer is billed on the trial price's own schedule: 7 days after
subscribing on a monthly plan, 14 days on a yearly one. So treat a 500 from
this function as something to act on the same day. Search the function log
for "Could not defer first charge" and fix the cause first. Only a refusal
from Paddle names the subscription in its log line. Match the others to a
subscription by the time of the line. Then put the date right. Which way
depends on where the subscription is now:

- **Paddle is still retrying.** Leave it. With the cause fixed, the next
  retry makes the move. Do not move the date by hand while the cause is
  still there: the next retry writes the payload's short period end back
  over the row and fails again before it can write the moved one.
- **Paddle has stopped retrying, and the subscription is still `trialing`
  in Paddle with its first payment not yet taken and nothing changed since
  it was made (not cancelled, same plan).** Replay the delivery from
  Paddle's notification log.
- **Anything else: do not replay.** A `subscription.created` carries the
  status and the period end the subscription had when it was made, and the
  function writes them to the row as they are. Replayed after the first
  payment, or after the date the rule gives has passed, it moves nothing
  and leaves the row at `trialing` with a period end in the past, which
  switches a paying customer's Premium off until Paddle's next event. If
  the first payment has not been taken, move `next_billed_at` by hand in
  Paddle to the date the rule gives (8.4). If it has been taken, there is
  no date left to move, and what to do for the customer is a support
  decision.

After any of these, check `current_period_end` on the account's
`public.subscriptions` row equals `next_billed_at` in Paddle. If it does
not, set it by hand:

```sql
update public.subscriptions
   set current_period_end = '<next_billed_at from Paddle>', updated_at = now()
 where user_id = '<account uuid>';
```

For anyone who subscribes monthly
before about 25 Dec 2026, or yearly before about 18 Dec 2026, an unmoved
date would be a charge in December 2026 for someone promised none until
2027. This check does not end with the offer: the 30-day and 21-day rule is
permanent.

If things are deployed in the wrong order: pages before the SQL show "could
not check" and buying works as before. The function before the SQL is not
harmless, so do not do it. It answers 500 to every new subscription, after
Premium and the billing date are already written, and Paddle sends each one
again until the SQL exists. Each of those retries writes the event's original
period end back into `public.subscriptions` before the function writes the
moved one again (`extendFreePeriod` in `paddle-webhook`). The function is
built so the retry ends on the moved date, but that has only been checked
against stubs, never against Paddle. So after any 500 followed by a retry,
whatever caused it, check that account: `current_period_end` in
`public.subscriptions` must match `next_billed_at` in Paddle (1 Jan 2027,
`2027-01-01 12:00:00+00`, for most accounts until the new year). If it reads
the trial price's own end instead, the account would lose Premium before its
first payment: set it to the Paddle date by hand.

`node --experimental-strip-types tools/foundation-test.mjs` checks the
function's wiring, the SQL file's shape and both pages against stubs. It
runs no SQL. Only `test-foundation.sql` and the purchase in 8.4 Test A check
the deployed database.

## 6. Email (Resend)

**Do this before you try to sign in even once.** Supabase's built-in sender
allows roughly two messages an hour and only delivers to addresses on your own
team, so a real customer can never receive a sign-in link. The symptom is a
`429` and `email rate limit exceeded` — Supabase's own wording, not this app's.

### 6.1 Verify the domain

- [ ] Add `aibhlinn.ai` at [resend.com/domains](https://resend.com/domains) and
      pick the nearest region (ap-northeast-1 for Australia).
- [ ] Add every record Resend lists to Cloudflare DNS — an MX and a TXT on the
      `send` subdomain, and the `resend._domainkey` TXT.
- [ ] Set every one to **DNS only** (grey cloud). Proxying a mail record breaks
      that record.
- [ ] Optionally add a DMARC TXT at `_dmarc`: `v=DMARC1; p=none;`
- [ ] Click **Verify DNS Records**.

Cloudflare appends the zone name automatically, so enter `send`, not
`send.aibhlinn.ai` — the latter creates `send.aibhlinn.ai.aibhlinn.ai` and
verification fails for reasons that look mysterious.

Only ever publish **one** DMARC record. Two makes the policy undiscoverable
under RFC 7489, which is worse than having none.

Sending is gated on DKIM and SPF; DMARC is advisory. If Resend's status
flickers between verified and pending, that is their resolver cache, not your
DNS. Check the truth from outside with `nslookup -type=TXT _dmarc.aibhlinn.ai
1.1.1.1` and stop clicking Verify — repeated checks can re-cache a stale
answer.

### 6.2 Point Supabase at Resend

- [ ] Resend → **API Keys → Create API Key**, sending permission only,
      restricted to `aibhlinn.ai`. The key is shown once.
- [ ] Supabase → **Authentication → Emails → SMTP Settings** → enable custom
      SMTP:

```
Sender email    no-reply@aibhlinn.ai
Sender name     AibhlinnAI
Host            smtp.resend.com
Port            465
Username        resend
Password        <the re_ API key>
```

Username is literally `resend` — not your email, not the key. The key is the
password.

Keep the sender name ASCII. Non-ASCII display names need MIME encoding and
some clients render mojibake in the From line; the `í` belongs everywhere
customer-facing, not in a mail header.

### 6.3 Prove delivery

- [ ] Request a sign-in link and confirm the message arrives.
- [ ] Check spam. A brand-new sending domain has no reputation and the first
      few messages often land there.

If you sign in on an address at `aibhlinn.ai`, remember incoming mail runs
through Cloudflare Email Routing: a rule (or catch-all) must exist for that
exact address, and its destination must be verified, or the link is dropped
with no error anywhere.

That routing is also a disclosure. `privacy.html` section 6 names
Cloudflare for receiving mail sent to an `@aibhlinn.ai` address and passing
it on, and Google for holding it, because the destination mailbox is Gmail.
Replies, and any email we start ourselves (a tester's install link, a
"your account is deleted" notice), go out through Gmail's send-as for the
`aibhlinn.ai` address, which relays through Resend (`smtp.resend.com`),
not Google: so section 6 names Resend for our email to people as well as
for sign-in codes, and section 5 says it goes through Resend. If the MX
records, the destination or the send-as relay ever change, change sections
5 and 6 the same day.

### 6.4 Make the sign-in email a code, not a link

A link in the sign-in email only signs in the browser that opens the link — no use to
someone whose inbox is on a phone while the app is open on a locked-down work
machine. Worse, corporate mail scanners (Safe Links, Mimecast, Proofpoint) fetch
every URL in an inbound message, which can spend a one-time link before the person
ever reads the email. So the template sends **only the code**, which is typed into
whichever device is running the app.

Supabase mints the code (`{{ .Token }}`) for the same `/auth/v1/otp` request that
would have carried a link. The default templates render the link, not the code —
you have to swap them.

- [ ] **Authentication → Emails**. In **both** the *Magic Link* template and the
      *Confirm signup* template (new accounts get the second one), replace the whole
      body with the block below, which is deliberately image-free — a text wordmark,
      not the logo lockup: a new sending domain with no reputation delivers better
      without images, image-off clients still show the brand, and nothing in the
      email phones home. A second suite app reuses this block unchanged.

```html
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:0 auto;padding:8px 4px;color:#241A2E">
  <p style="font-size:15px;letter-spacing:.02em;color:#2E3A63;font-weight:600;margin:0 0 22px">AibhlínnAI</p>
  <h1 style="font-size:18px;margin:0 0 6px">Your AibhlínnAI sign-in code</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 18px;color:#5E5568">Enter this code to finish signing in:</p>
  <p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:0 0 18px">{{ .Token }}</p>
  <p style="font-size:13px;line-height:1.5;color:#8A8194;margin:0">This code expires shortly. If you didn't ask to sign in, ignore this email. Without this code, a sign-in attempt will be useless.</p>
</div>
```

The body names no product, so the *Subject heading* is where a person sees which
app asked — set the subject to `Your Pie Timers sign-in code` rather than repeating the
neutral wording.

- [ ] Do not leave a bare `{{ .ConfirmationURL }}` anywhere in the body, even as
      plain text — a scanner will still follow the URL and burn the code.
- [ ] Change the **Subject heading** on both templates too — the subject is a separate
      field above the body and the stock text says "magic link" / "confirm your
      signup". Set the subject to something like `Your Pie Timers sign-in code`.
- [ ] Shorten the code's lifetime at **Authentication → Providers → Email → Email
      OTP Expiration** — default is 3600s; 600s is plenty and narrows the window
      on a code read to the wrong person.
- [ ] Test across two devices: on device A request a code, read the code off device B's
      inbox, type the code into device A. ✅ device A lands signed in with no redirect.
      ❌ "Token has expired or is invalid" means the code expired, was already
      used, or the address on device A does not match the address the code was sent to.
      ❌ a message mentioning `otp_type` / `type` means the `type: 'email'` verify
      value needs revisiting for this GoTrue version — flag that.

The **Redirect URLs** allowlist (§5.3) still matters — the allowlist is used by the Google
OAuth return — so do not remove the allowlist just because the email no longer carries a link.

## 7. Push notifications

- [ ] Generate a VAPID key pair.
- [ ] Public half → `config.js`.
- [ ] Private half → Supabase secrets, and nowhere else.

Diagnostics verifies the public key decodes to a real 65-byte P-256 point,
which catches the common mistake of pasting the private one.

### 7.1 The Android app (Firebase Cloud Messaging)

The Play app cannot use Web Push, so from release 7 its closed-app alerts go
through Firebase. Three things have to exist, in this order:

- [ ] A Firebase project with two Android apps registered in it:
      `ai.aibhlinn.pietimers` and `ai.aibhlinn.pietimers.debug` (the test
      build). Its `google-services.json` goes in the private packages folder,
      never in this repo (`android/README.md`, "Firebase").
- [ ] A service account key for that project (**Project settings → Service
      accounts → Generate new private key**), saved as the Supabase secret
      `FCM_SERVICE_ACCOUNT`: the whole JSON file as the value. It is a
      credential. It goes in Supabase secrets and nowhere else.
- [ ] `supabase functions deploy notify-milestones --no-verify-jwt`, **before**
      release 7 reaches anyone. The function from before November 2026 does
      not know an `fcm:` row: it claims the milestone, fails to send it, and
      the account's browsers then get nothing for that milestone either.

Without the secret the function skips Android devices and says so in its log
once a run; browsers are unaffected. `node --experimental-strip-types
tools/notify-run-test.mjs` checks all of this against stubs. Nothing but a
real phone checks it against Google.

## 8. Paddle

Paddle will ask for your terms and privacy URLs during seller verification:

- https://pietimers.aibhlinn.ai/terms.html
- https://pietimers.aibhlinn.ai/privacy.html

Both are already linked from the footer of every page, which is what they check
for.

### 8.1 Catalogue

- [ ] Create the product and its four prices in **Catalogue → Products**:
      a yearly and a monthly price that are paid on the day, and a yearly
      and a monthly price with a trial set on the price (14 days on the
      yearly one, 7 days on the monthly one; 5.6 says why).
- [ ] Copy the four price ids into `app/config.js` → `paddle.annualPriceId`,
      `monthlyPriceId`, `annualTrialPriceId` and `monthlyTrialPriceId`.
- [ ] Check the base currency. `annualPrice`, `monthlyPrice`, `annualSaving`
      and `annualNote` in `config.js` are display labels only — Paddle charges
      the real localised amount. Prices are set in **AUD**, so the labels read
      `A$`. A bare `$` quotes one figure and charges another to anyone outside
      Australia.

### 8.2 Notification destination

**This is the step that entitles customers. Without this step, checkout still takes
money and nobody is ever entitled — silently, with no error the customer or the
app can see. Do not skip this, and do not treat a working checkout as evidence the
step is done.**

Order matters: Paddle mints the signing secret when the destination is created,
so the secret cannot be put in Supabase first.

- [ ] **Developer tools → Notifications → New destination**, in the
      **Production** environment.
- [ ] Type **Webhook**, URL = your `paddle-webhook` function URL:
      `https://<project-ref>.supabase.co/functions/v1/paddle-webhook`
- [ ] Leave **API version** at **1**. This is the notification payload
      version, and 1 is the current one for Paddle Billing — there is no 2 to
      choose. (An earlier version of this file said "notification version v2",
      conflating Paddle *Billing* — sometimes called the v2 platform, as
      opposed to Paddle Classic — with this per-destination field. Changing the version
      would not help and could break the payload `paddle-webhook` parses.)
- [ ] Tick exactly `subscription.created`, `subscription.updated`,
      `subscription.canceled`. Nothing else — the handler ignores every other
      event type, so extra ticks only add noise to the delivery log.
- [ ] Save, then reveal and copy the **signing secret** (`pdl_ntfset_…`).
- [ ] Supabase → **Edge Functions → Secrets** → set `PADDLE_WEBHOOK_SECRET` to
      that exact value.

### 8.3 Enable checkout itself

Two account-level settings gate whether Paddle will open a checkout at all.
Neither is part of the catalogue, and both fail with the same opaque
"Something went wrong" panel in the overlay.

- [ ] **Checkout → Checkout settings → Default payment link** →
      `https://pietimers.aibhlinn.ai/`, then Save.
- [ ] **Checkout → Website approval** → add `pietimers.aibhlinn.ai` and wait
      for the entry to move from **Pending** to approved. Subdomains are reviewed
      individually; approving `aibhlinn.ai` does not approve this one.

Approval requires the site to link to, or contain, terms of service, privacy
notice and refund policy. All three are linked from the footer of every page —
refunds via `terms.html#refunds`. Keep that true.

When either is missing, `POST checkout-service.paddle.com/transaction-checkout`
returns 400 with `"details": "transaction_checkout_not_enabled"`. Read that
body in the Network tab before assuming anything else is wrong; the overlay's
own message says nothing useful. The body is discarded when the overlay
closes, so read the body while the error is still on screen.

### 8.4 Prove the whole path end to end

Paddle removed per-destination test sends. **Simulations** (Developer tools →
Simulations) run in Sandbox only, so a Production destination can never be
given a synthetic event. The only way to exercise the live path is a real
purchase, refunded afterwards.

**Which price you get decides what this test proves.** `billing.js` hands
anyone still inside their account trial (runs to the end of 5 Dec 2026 for an
account made before 22 Nov 2026, 14 days from signup after) the *trial* price, so that
purchase authorises the card and takes **nothing** today — there is no charge
to refund, and the status stays `trialing`. Only a lapsed account takes the
plain price and pays on the spot. Run both, in this order, on a throwaway
account rather than your own.

Test A — still in trial, takes no money, exercises the most code:

- [ ] Buy the monthly plan through your own live checkout.
- [ ] Confirm the `public.subscriptions` row's **`plan` changes from `trial` to
      `monthly`**. The status stays `trialing` and does *not* become `active`
      on this path, and looking for `active` here reads a working webhook as a
      broken one.
- [ ] Confirm a row in `public.billing_events`.
- [ ] Confirm **three** rows in `identity.product_entitlements`: `can_sync`,
      `can_use_calendar`, `can_use_screensaver`. Note that `grant_trial` may
      already have written here, so check `source` and the timestamps rather
      than just counting rows.
- [ ] Confirm `next_billed_at` in Paddle follows the first-payment rule
      (`firstChargeAt` in `paddle-webhook`). The first payment is taken at
      the latest of three instants: the day the account was made plus
      30 days on a yearly plan or 21 days on a monthly plan
      (`FREE_DAYS_YEARLY`, `FREE_DAYS_MONTHLY`; 30 if the plan cannot be
      read); `LAUNCH_FIRST_CHARGE`; and Paddle's own `next_billed_at`, the
      date its checkout showed: the purchase plus the trial on the price,
      7 days on the monthly trial price once 5.6 is done, 14 on the yearly
      one. There is no
      subscribe-by date: the rule is keyed on **the account's creation
      date and the plan**, not on when the purchase is made. So a throwaway
      account made today and bought today on the monthly plan expects
      **1 Jan 2027** if it is made before 10:30 pm on 11 Dec 2026, Adelaide
      time (before 10:30 pm on 2 Dec on the yearly plan), and day 21
      (monthly) or day 30 (yearly) from account creation after that.
      Before you look at the result, note the first-payment date the
      checkout itself shows: on the monthly plan it should be 7 days out.
      If it shows 14, the trial on the monthly trial price has not been
      changed (5.6). With 7 days there, every monthly purchase made during
      a trial is moved, whichever day it is made on. (Left at 14, a monthly
      purchase made after day 7 of the trial from 18 Dec 2026 keeps
      Paddle's own date, nothing is sent to Paddle, and the test proves
      nothing about the key: buy on the day the account is made.) This is
      the only check that exercises `deferFirstCharge`, and therefore the
      only proof `PADDLE_API_KEY` is set. Without that key the function
      still switches Premium on, but it answers 500 to Paddle, logs "Could
      not defer first charge: PADDLE_API_KEY not set", and Paddle sends the
      event again, up to its own retry limit (5.6). The exact instant of
      `LAUNCH_FIRST_CHARGE` is `2027-01-01T12:00:00Z`: the moment the last
      time zone on Earth (UTC-12) reaches midnight on New Year's Eve, so
      "Pay nothing until 2027" holds on every customer's calendar. It is
      10:30 pm on 1 Jan in Adelaide. It is not Adelaide midnight, which is
      still 31 December 2026 everywhere to the west.
- [ ] Confirm `current_period_end` on the `public.subscriptions` row reads
      the same instant as `next_billed_at` (`2027-01-01 12:00:00+00` in the
      1 January case), not the trial price's own end (7 days out on
      monthly, 14 on yearly).
      `has_active_plan()` reads this column, so it is what keeps Premium on
      until the first payment.
- [ ] Read the function log for this purchase. If any delivery answered 500
      and was then retried, check `current_period_end` again after the
      retry: it must still read the moved date. Note here what Paddle sent after
      the repeated date move (a second `subscription.updated`, or nothing);
      that has not been observed yet.
- [ ] Confirm a row in `public.foundation_claims` for the test account with a
      place number, and that `select public.foundation_status();` shows one
      place fewer (so do `pricing.html` and `foundation.html`, once the new
      pages are published).
- [ ] Take the place back with the withdraw statement in
      `schema-foundation.sql` (the note can be 'withdrawn: owner test
      purchase'). Confirm `select public.foundation_status();` is back where
      it started. The row stays, so Test B's purchase on the same account
      takes no place.

Test B — the money path. Expire the same account's trial first:

```sql
update public.subscriptions
   set current_period_end = now() - interval '1 day'
 where user_id = '<test account uuid>';
```

- [ ] Buy the monthly plan again. This time the charge is real.
- [ ] Confirm the row flips to `active`/`monthly`.
- [ ] Refund and cancel in Paddle. Cancel Test A's subscription as well:
      it is a separate subscription, and left alone it takes its own first
      payment on its own date.

Diagnostics cannot check any of 8.2 or 8.4 for you — the exchange is server to server, so
this is the one you must watch happen.

Note that a fresh account is already entitled: `grant_trial` (in
`schema-access-codes.sql`) gives every new user a trial (`public.trial_length()`:
runs to the end of 5 Dec 2026 before 22 Nov 2026, 14 days from signup after), and the
upgrade panel only reappears in
the final 4 days. To reach checkout before then, call
`CT.billing.openCheckout('monthly')` from the console rather than editing data.

Reading a failure:

- **400 `transaction_checkout_not_enabled`** — see 8.3. Not your code.
- **401** — the secret in Supabase does not match the destination's. Recopy the secret.
- **500** — the signature passed and a write failed. Read the Supabase function
  logs, not the Paddle delivery log.
  A message starting `claim_foundation_place failed: 404` means
  `schema-foundation.sql` has not been run (5.6).
  A message starting `first charge not deferred` means the first-payment
  date should have been moved and was not. Premium is already on. The log
  line starting "Could not defer first charge" says why, and Paddle sends
  the event again (5.6).
- **200 but no row** — the event carried no `custom_data.user_id`. That means
  the checkout was opened outside `billing.js`, which always attaches the id.

### 8.5 Before switching `environment` to `'production'`

- [ ] Confirm the client token starts with `live_`. A `test_` token with
      `environment: 'production'`, or the reverse, produces a checkout that
      opens and then fails at payment. Diagnostics checks this pairing.
- [ ] Confirm 8.2 and 8.3 are actually done. Going live without 8.2 is the one
      failure that costs real customers real money: checkout succeeds, the
      payment is taken, and nobody is ever entitled.

---

## 9. Google Play (not built yet — this is the plan)

Three things have to exist before a `play-webhook` function is worth writing,
and none of them exist in this repo today:

1. **A Play Console developer account** ($25 one-off) and an app listing.
2. **An Android wrapper.** Pie Timers is a PWA, so this is a Trusted Web
   Activity — typically generated with
   [PWABuilder](https://www.pwabuilder.com/), not written by hand. The
   wrapper's own code is where a purchase is initiated, and must pass
   your AibhlínnAI account id as Play Billing's `obfuscatedAccountId` —
   that value is the *only* way a later server notification can be linked
   back to an account, since Play's Real-Time Developer Notifications
   (RTDN) carry a purchase token and a product id, never your user id.
3. **A service account** with Android Publisher API access, to look up
   what a purchase token actually means (plan, status, expiry) — RTDN
   itself is just a ping saying "something changed", not the detail.

Once those exist, `play-webhook` (Deno, matching `paddle-webhook`'s shape)
would:

- Verify the incoming request is genuinely from Google Pub/Sub — an OIDC
  bearer token, RS256-signed, checked against Google's published JWKS,
  with `aud` and `iss` verified. Same category of work as the HMAC check
  in `paddle-webhook`, just a different signing scheme.
- Decode the RTDN envelope, extract `purchaseToken` and `subscriptionId`.
- Exchange the service account's private key for an OAuth2 access token
  (a self-signed JWT to Google's token endpoint), then call
  `purchases.subscriptionsv2.get` to read the real subscription state and
  the `externalAccountId` set in step 2.
- Upsert into `identity.subscriptions` with `provider: 'play'`, and call
  `identity.grant_capability` for `can_sync` / `can_use_calendar` — the
  same identity-schema tables Paddle should eventually write to as well
  (see the note in `supabase/identity-schema.sql` about that migration
  being deliberately not done yet).
- Dedupe on Pub/Sub's `messageId`, the same idempotency shape as
  `claimEvent` in `paddle-webhook`.

**Anti-steering, in place and worth keeping deliberately:** the Play app
is consumption-only. The site recognises it by its referrer
(`CT.inPlayApp`, from `IN_PLAY_APP` in `app/app.js`) and hides every
price, checkout, customer portal and pricing link there, and `billing.js`
refuses to open Paddle in it. See `ARCHITECTURE.md` §5. Anything new that
sells needs the same gate, gated out rather than reworded.

## Redeploying

```bash
git add . && git commit -m "What changed" && git push
```

Pages redeploys in a minute or two.

**When you change any file in `app/`, bump `CACHE` in `app/sw.js`.** Installed
copies serve the old cached shell until the version string changes, so without
the bump your fix reaches new visitors and nobody else.

**As well as `CACHE`, bump the `?v=` of every changed js or css file, in
`app/index.html` and in `SHELL` in `app/sw.js` together**, or a browser can pair
the old file with the new page (see the comments beside `SHELL`).

## If you ever need to take the service down

The terms promise **60 days' notice by email and a pro-rata refund** before
shutting the service down, and to keep the free on-device version working for
as long as reasonably possible. That is a commitment you made in writing, so
plan a wind-down around that promise rather than switching the repo to private.
