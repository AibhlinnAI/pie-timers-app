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
| Paddle API key (server, `pdl_live_apikey_…`) | Supabase → Edge Functions → Secrets, as `PADDLE_API_KEY`. Unrelated to the client-side token in `config.js` — this one calls Paddle's API from four functions, and that one only opens a checkout in the browser. `manage-subscription` uses it to open the customer portal. `create-checkout` uses it to read a price, read discounts and make the transaction for someone who subscribes while their free trial is running (5.6), so the key must be allowed to read prices, read discounts and write transactions. `expire-checkouts` uses it to list unpaid transactions and cancel the ones `create-checkout` made that nobody paid within about an hour (5.6), so the key must be allowed to read transactions as well. `paddle-webhook` uses it only as the net, to move a first payment that still lands short of the rule's date, so the key must be allowed to change subscriptions as well [check label: the permission names on a Paddle API key were not read from Paddle]. With the key missing, or not allowed to make a transaction, checkout does not open for an account in its free trial: the page says to try again, nobody is charged, and `create-checkout` logs "Could not make checkout". With a key that may not read transactions, nobody is charged either: `expire-checkouts` cancels nothing, unpaid prepared purchases stay open, and the function logs "Could not close checkouts" every ten minutes. |
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
- [ ] `cron.sql`, after all of the above, because the file schedules a job against edge functions that do
      not exist until 5.3.
- [ ] `schema-expire-checkouts.sql`, last: after `cron.sql`, and after
      `expire-checkouts` has been deployed (5.3). The file makes the
      ten-minute job that cancels unpaid prepared purchases, as a copy of
      a job `cron.sql` made. Nothing to edit. 5.6 has the tick, the row
      to expect and what to do with a red message. Without this file the
      function is deployed and never runs, and unpaid prepared purchases
      are never cancelled.

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

- [ ] Deploy the ten edge functions, each with `--no-verify-jwt` except
      `manage-subscription` and `create-checkout`: signin, delete-account,
      paddle-webhook, manage-subscription, create-checkout,
      expire-checkouts, notify-milestones, calendar-sync, google-connect,
      review-signin.
      (Those two are called with the signed-in user's own session token,
      so they are deployed bare. There is no `supabase/config.toml` to
      remember the setting, so the flag has to be right on every deploy.)
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
adds it (the Black Friday Launch Offer, 22 Nov 2026) the order is:

1. the SQL;
2. a look at what the Paddle API key may do (the tick below);
3. `supabase functions deploy paddle-webhook --no-verify-jwt`;
4. `supabase functions deploy create-checkout` (no flag on this one);
5. `supabase functions deploy expire-checkouts --no-verify-jwt`;
6. `supabase functions list` shows all three;
7. paste `supabase/schema-expire-checkouts.sql` into the SQL editor and
   read its check row;
8. Test A in 8.4, run from the browser console on the live site (it also
   makes the spares that Test D looks at);
9. Test B in 8.4;
10. Test C in 8.4: the old Buy button, which is the one time the net's date
   move meets Paddle before a customer needs it;
11. Test D in 8.4, at least 75 minutes after the spares were made: both
   have been cancelled, the one never opened and the one opened and left;
12. the merge to `main`, which is what sends out the pages and `billing.js`;
13. a look at the real Buy button (8.4, "After the merge");
14. the aibhlinn.ai advert, last.

The SQL and the three functions are run by hand; the pages and `billing.js`
go out when the branch is merged. That order is safe because the new
`paddle-webhook` works with the pages that are live now, and nothing calls
`create-checkout` until the new `billing.js` is live: deploying it changes
nothing for anyone until the merge. `expire-checkouts` is closed and idle
until its job exists (step 7). The job made before the function is
deployed would only collect 404s. From its first run the job cancels every
unpaid transaction `create-checkout` has made that is over an hour old,
ones made before today included, which is wanted. The one order that is not safe is the
merge going out while the `paddle-webhook` that is live is still an older
one ("If things are deployed in the wrong order", below). Merge only once Test A has shown, on a
real throwaway purchase, a first payment on the first whole day at or after
`2027-01-01T12:00Z` (1 or 2 Jan 2027 on your calendar; 8.4 says which): that
date is the offer. Publish the aibhlinn.ai site branch only after that merge
is live and `foundation.html` shows the Black Friday Launch Offer. Its advert
links to that page, and until then the live page still describes the October
offer.

**Checkout is given the right first-payment day, so nothing is moved
afterwards (the owner, 22 Nov 2026: "just make sure we get the date
right").** What Paddle's overlay then puts in front of the customer (a
date, a count of free days, or neither) has not been seen yet: Test A is
the first look, and it says what to do if the overlay shows neither. Until this release a checkout
opened on a catalogue trial price showed the purchase plus that price's
trial, and `paddle-webhook` moved the date afterwards, so the pages had to
say "Checkout may show an earlier first-payment date". That paragraph is off
all three pages. Now, while an account's own free trial is running,
`billing.js` asks the `create-checkout` function for a Paddle transaction.
The function works out, from the account's own row and the server's clock,
how many whole days of free time put the first payment at or after the
rule's date, makes a transaction whose price is a copy of the plain
catalogue price with that many days as its trial, checks Paddle's answer,
and hands back the transaction's id. Paddle's checkout counts the days from
the purchase itself, so the date it shows is the date it bills on, and
nothing is moved afterwards. `paddle-webhook` keeps the same rule as a net
that should have nothing to do. An account whose trial has ended opens the
plain catalogue price from `billing.js`, as before, and pays on the day.

**What "21 days" and "30 days" become.** A Paddle trial is a whole number of
days counted from the moment of purchase, and the rule's date is an exact
instant, so the day count is rounded up. The first payment is taken at the
time of day the customer subscribed, on the first such moment at or after
day 21 (monthly) or day 30 (yearly) from the account being made. That is
between 21 and 22 days after the account was made (30 and 31 yearly), and
never before it. During the offer it is between `2027-01-01T12:00Z` and
`2027-01-02T12:00Z`. Two people who made their accounts at the same moment
can differ by under 24 hours, set by the time of day each subscribed, never
by which day of the trial they subscribed on. `2027-01-01T12:00Z` is 10:30 pm
on 1 January in Adelaide, so most Australian offer subscribers will be shown
2 January 2027. "From 1 January 2027" stays true. All of this was read from
Paddle's documentation and run against stubs; Test A is the first real look.

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
      runs to the end of 5 December "even if an earlier trial had already ended".
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
- [ ] Nothing in Paddle's catalogue has to be changed for this release. An
      earlier plan had a tick here: set the monthly trial price's trial to
      7 days, so the date could be moved the same way for everyone. That
      step is retired, because `create-checkout` now gives each checkout
      its own number of free days and no catalogue trial price is opened.
      If it has already been done, leave it: nobody is charged early
      either way, as long as the net's move succeeds (Test C in 8.4 is
      where that is seen). It does change one number. That price is now
      opened only by an old cached page, and where this section says such
      a purchase is billed "14 days after subscribing" when its move is
      stuck, read 7 for the monthly plan. Your separate steps page may
      still carry the 7-day tick: it is outside this repo and was not
      changed here. Leave the two plain prices alone, and do not archive
      the two trial prices yet (8.1 says when).
- [ ] Check what the key behind `PADDLE_API_KEY` may do. `create-checkout`
      needs it to read prices, read discounts and write transactions.
      `expire-checkouts` needs it to read transactions and write
      transactions. `paddle-webhook` needs it to change subscriptions, and
      `manage-subscription` to make customer portal sessions [check label:
      Paddle's key permissions screen was not read, so the names there may
      differ]. A key that cannot write a transaction charges nobody: it
      stops checkout opening for accounts in their free trial, and Test A
      shows it at once.
- [ ] Confirm the SQL is in place one more time, straight before the
      functions go out: `select public.foundation_status();` answers. Do
      not deploy `paddle-webhook` until it does (see "wrong order" below).
- [ ] Deploy the webhook: `supabase functions deploy paddle-webhook --no-verify-jwt`.
      The flag matters. Paddle calls this function with a signature, not a
      Supabase token, and without the flag Supabase's gateway would ask
      Paddle for a token it never sends and turn every delivery away
      before the function runs. (Read from 5.3 and `app/README.md`, not
      run. Until 23 Nov 2026 this tick left the flag off.)
- [ ] Deploy the checkout function: `supabase functions deploy create-checkout`.
      No flag on this one: it is called with the signed-in user's own
      session token, like `manage-subscription`. It needs no new secret.
      Nothing calls it until the new `billing.js` is live, so deploying it
      changes nothing for anyone yet.
- [ ] Deploy the function that closes unpaid checkouts: `supabase functions deploy expire-checkouts --no-verify-jwt`.
      The flag matters here too. The scheduled job calls this function
      with the publishable key, which is not a session token, so without
      the flag Supabase's gateway would turn every run away. The function
      is closed by `CRON_SECRET` instead, the secret `notify-milestones`
      already uses, and is closed when that secret is not set. It needs no
      new secret. Nothing calls it until the tick after next is done.
- [ ] `supabase functions list` shows all three, each updated just now.
- [ ] Schedule it: paste the whole of `supabase/schema-expire-checkouts.sql` into the SQL editor and run it.
      One paste, nothing to edit, safe to run again. Nobody types the
      cron secret: the file copies the job `cron.sql` made for
      `notify-milestones` and swaps the function's name. Expect one row:
      `countdown-expire-checkouts`, then `3,13,23,33,43,53 * * * *`, then
      `true` four times. If a red message says nothing was changed, stop
      and bring the message back: nothing is scheduled. (One of the
      messages is about 25 seconds: the milestones job in the database
      does not wait 25 seconds for an answer as `cron.sql` sets, and
      `expire-checkouts` plans each run around that wait.) Never paste or
      print a job's command (no `select command from cron.job`, no
      `select * from cron.job`, and no `select * from
      cron.job_run_details`, which repeats the command for every run):
      the command holds the secret. This SQL
      was written against `cron.sql` as it stands in this repo and has
      never been run. Your paste is its first run.
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
- [ ] Run Test A in 8.4 on a throwaway account, from the browser console
      on the live site. Do not merge until checkout itself has shown the
      right first-payment day and `next_billed_at` in Paddle is that same
      day: the first whole day, counted from the purchase, at or after
      `2027-01-01T12:00Z`. (That is the date for an account made and
      subscribed on the same day until early December. 8.4 gives the
      dates after that, and what to do if the price or the date is not
      what it should be.)
- [ ] Run Test B in 8.4.
- [ ] Run Test C in 8.4, on another throwaway account still in its free
      trial: the live Buy button, which is still the old one and opens a
      catalogue trial price. It takes no money. It is the only time the
      net's date move, and the key's permission to make it, are seen
      against Paddle. It can only be run this way before the merge.
- [ ] Run Test D in 8.4, at least 75 minutes after Test A's spare was made.
      It takes no money. Do not merge until both spares from Test A read
      Canceled in Paddle and neither offers a purchase: the one that was
      never opened, and the one that was opened and left. Every prepared
      purchase a customer leaves behind is an opened one.
- [ ] Straight before the merge: `supabase functions list` shows `paddle-webhook`, `create-checkout` and `expire-checkouts` all updated in this sitting,
      the `expire-checkouts` log has a "checkouts closed:" line from the
      last ten minutes or so,
      and "first charge: checkout's date stands" was seen in the
      `paddle-webhook` log in Test A. Only the new `paddle-webhook` writes
      that line. Without it, do not merge: an older `paddle-webhook` under
      the new pages is the one order that can charge someone early (see
      "If things are deployed in the wrong order").
- [ ] Merge, which publishes the pages and `billing.js`. Open `pricing.html`
      and `foundation.html` signed out: both say 100 of 100 places.
- [ ] On a throwaway account still in its free trial, press the real Buy
      button on `pricing.html` (8.4, "After the merge").
- [ ] Block the Supabase host in the browser's developer tools and reload:
      Pricing says it could not check, Foundation shows no number.
- [ ] With the pages live, sign in to the app as an account that has
      subscribed during its free trial and has not been charged yet (the Test A
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
during the offer has their first payment from 12:00 UTC on 1 January 2027.
A purchase made through `create-checkout` needs no move, so a stuck move is
now only possible for a subscription that did not come through it: an older
cached page that opened one of the two retired catalogue trial prices, or
one of them opened by hand. Such a subscriber whose move is stuck would be
charged 14 days after subscribing (7 on the monthly plan, if the retired
7-day change was made in Paddle before it was retired), which can be
earlier than the pages promise. Test C in 8.4 is run once, before the
merge, to see that move succeed against Paddle.

**A fault in `create-checkout` charges nobody.** It stops checkout opening
for accounts in their free trial: the page says "Could not open checkout.
Please try again.", and the function writes a log line starting "Could not
make checkout". Nobody is told unless a customer writes in, so it is a sale
that waits, found only by reading the log. It is never a wrong charge: the
page does not fall back to another price.

**A fault in `expire-checkouts` charges nobody and cancels nothing.** It
leaves unpaid prepared purchases open, which is how things stood before
25 Nov 2026: one opened and paid after the account's own trial has ended
still starts a free period. The function writes a log line starting "Could
not close checkouts", and nobody is told. A run that leaves old unpaid ones
open for any reason other than somebody paying writes that same line, so
the search below finds it: Paddle refusing a cancel, a transaction that is
still unpaid and does not pass the second read, or more waiting with none
cancelled. `paddle-webhook`'s line "free
period on an account whose own free trial was not running" is still how
such a late payment is found. The same goes for any stretch when the
function is not deployed or its job is not scheduled.

Before going away for any stretch that covers late December or the first
week of January:

- [ ] Search the `paddle-webhook` function log for "Could not defer first
      charge". Expect no line since it was last checked. If there is one,
      follow "What a retry cannot do" below before leaving.
- [ ] Search it too for "first charge moved after checkout" and "trial
      subscription on a catalogue price". Neither is a fault, and nobody
      was charged early. Each one is a subscription that did not come
      through `create-checkout` (or, for the first, a date a few seconds
      short), so the customer was shown one date and is billed on a later
      one. A run of them means old pages are still about.
- [ ] Search it for "free period on an account whose own free trial was
      not running". This one is to look at. A subscription arrived with a
      free period, and when it was bought the account was not in its own
      free trial: the trial had ended, or the account already had a
      subscription. The terms give that person no free period: they pay
      on the day. Nobody was charged wrongly, and the function changed
      nothing, because it never moves a date earlier than checkout
      showed. It is one of three things: a transaction `create-checkout`
      made during the trial and that was paid later (Paddle does allow
      that: found on 25 Nov 2026. `expire-checkouts` now cancels such a
      transaction about an hour after it was made, so this should only
      be one paid within that hour of the trial ending, or one from a
      stretch when the job was not running); a retired
      catalogue trial price opened by hand; or, once in a while, someone
      whose trial ended in the minutes their checkout was open. Match the
      line to a subscription in Paddle by its time. What to do with that
      subscription (leave it, or cancel it in Paddle and write to the
      customer) is your call.
- [ ] Search it for "First payment later than the rule: by N hours". A day
      or two is a checkout left open, and there is nothing to do. So is a
      trial you extended by hand. Many days, on an account whose trial
      you did not extend, is a transaction made on one day and paid on a
      later one (`expire-checkouts` should now prevent that, so read its
      log as well): its free days are counted from the day it was paid, so
      that subscriber's first payment is later than someone else's with
      the same account day. Same as the line above: nobody was charged
      wrongly, and what to do is your call.
- [ ] Search the `create-checkout` function log for "Could not make
      checkout". A line now and then is a customer whose trial had just
      ended or who mistyped a discount code. The same line many times
      over, or any line naming Paddle or `PADDLE_API_KEY`, is checkout not
      opening for people in their trial: fix the cause before leaving
      (8.4, "Reading a failure"). Many lines saying "answered 429" are
      Paddle turning the function away for calling too often (its
      documentation allows 240 requests a minute from one address, then
      refuses for 60 seconds; read 23 Nov 2026). `create-checkout` has no
      limit on how often one signed-in account may call it, so one
      account calling in a loop could cause that for everyone. Nobody is
      charged by it. Many "checkout made" lines within minutes of each
      other, far more than there are new subscriptions, are the same
      thing seen earlier. Every one of those calls also leaves an unpaid
      prepared purchase for `expire-checkouts` to cancel, 120 an hour at
      most (the next tick).
- [ ] Search the `expire-checkouts` function log for "Could not close checkouts".
      Expect no line. One now and then that names a 429, says the list
      could not be reached, or says Paddle refused 1, is a run that gave
      way, and the next run ten minutes later is the retry. The same line
      run after run means unpaid prepared purchases are being left open:
      fix the cause before leaving (8.4, "Reading an answer from
      `expire-checkouts`"). Then look for "checkouts closed:". That line
      is written every ten minutes, so a gap in those lines means the job
      has stopped, and the made versus paid gap is open again for as long
      as the gap lasts. Then read the newest of those lines, not only
      that one is there. "more waiting yes" on several runs in a row
      means more are being made than the 120 an hour the function
      cancels, so the hour is not being kept for anyone: look in the
      `create-checkout` log for many "checkout made" lines (the tick
      above), because one account can make that many by itself. "being
      paid" above 0 on every run is a prepared purchase with a payment
      attempt that never settled: the function leaves that one open for
      good, and whether to cancel that one by hand in Paddle is your
      call. "not ours" above 0 is an unpaid API-made transaction the
      function does not recognise, which should not exist: bring the
      line back.
      No line names an account or a transaction: the cancelled ones are
      in Paddle's Transactions list, by status and time.
- [ ] In Paddle, list the subscriptions whose status is `trialing` [check
      label: the Subscriptions list and its status filter were not read
      from Paddle]. None may show a next payment before 1 Jan 2027, and
      none a next payment earlier than the rule's date for its own
      account and plan (8.4). One that does is a move that did not
      happen.
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

Also open each new subscription made during a free trial in Paddle (status
`trialing`) and check `next_billed_at` against the rule in 8.4. It is the
first whole day, counted from the moment of purchase, at or after the
rule's date: the same time of day as the purchase, and under 24 hours past
the rule's instant. Until the new year that is between
`2027-01-01T12:00:00Z` and `2027-01-02T12:00:00Z` for most accounts, and
later for an account whose own 30 days (yearly) or 21 days (monthly) run
past 1 January. It is never before `2027-01-01T12:00:00Z`, and never
earlier than the date checkout showed.

`paddle-webhook` is the net, and a move it needs and cannot make retries
(Mal's instruction, 22 Nov 2026; until then it was logged and answered
200). A purchase made through `create-checkout` needs no move, so what
follows is about a subscription that arrived another way. There are four ways
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
(Paddle's documentation says up to 60 tries over about two days for a live
destination; not observed: check its notification log), and from then on
the customer is billed on the date Paddle already holds. The only schedule
an unmoved date can fall back to now is the old catalogue trial prices'
own, 14 days after subscribing (7 on the monthly plan, if the retired
7-day change was made), for a purchase made from an old cached page. So
treat a 500 from
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

For anyone who subscribes on one of the old catalogue trial prices before
about 18 Dec 2026 (before about 25 Dec on the monthly plan, if that price
carries the retired 7-day change), an unmoved date would be a charge in
December 2026 for someone promised none until 2027. This check does not
end with the offer: the 30-day and 21-day rule is permanent.

If things are deployed in the wrong order: pages before the SQL show "could
not check" and buying works as before. The function before the SQL is not
harmless, so do not do it. It answers 500 to every new subscription, after
Premium and the billing date are already written, and Paddle sends each one
again until the SQL exists. Each of those retries writes the event's original
period end back into `public.subscriptions` before the function writes the
first-payment date again (`extendFreePeriod` in `paddle-webhook`). The
function is built so the retry ends on the first-payment date, but that has
only been checked against stubs, never against Paddle. So after any 500
followed by a retry, whatever caused it, check that account:
`current_period_end` in `public.subscriptions` must match `next_billed_at`
in Paddle. If it reads an earlier date instead, the account would lose
Premium before its first payment: set it to the Paddle date by hand.

**The merge before the new `paddle-webhook` is the dangerous order.** The
new `billing.js` opens checkouts whose first payment is weeks out, on the
date `create-checkout` worked out. An older `paddle-webhook` does not know
that. The one on `main` before this release moves every first payment to
the account's creation plus 30 days, "in whichever direction", earlier
included, and knows nothing of 1 January 2027 (read in `main`'s copy of
the file on 23 Nov 2026; which version is deployed was not checked).
Under the new pages it would move a first payment that checkout showed as
2 January 2027 back to 25 December 2026 for an account made on
25 November: a charge earlier than the customer was shown, which is the
one thing this release exists to prevent. So the merge waits for two things: `supabase functions list`
shows `paddle-webhook` updated in this sitting, and Test A's
`paddle-webhook` log has "first charge: checkout's date stands", a line
only the new function writes. If the merge has already gone out over an
older `paddle-webhook`: deploy the new one at once, then open every
subscription made since the merge in Paddle and check `next_billed_at`
against the rule (8.4); move any that is early by hand, and set
`current_period_end` to match (the statement above).

`create-checkout` deployed before the SQL, or before `paddle-webhook`,
harms nothing while the old pages are live: nothing calls it until the new
`billing.js` is out. The merge before `create-checkout` is deployed only
stops sales: the new `billing.js` would ask for a function that is not
there, and nobody in their free trial could open checkout until it is.
Nobody would be charged wrongly.

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

- [ ] Create the product and its two prices in **Catalogue → Products**: a
      yearly and a monthly price that are paid on the day, with no trial
      set on either. Those two are the only prices in use. `billing.js`
      opens them for an account whose trial has ended, and
      `create-checkout` copies them, with the right free days added, for
      an account whose trial is running (5.6).
- [ ] Copy the two price ids into `app/config.js` → `paddle.annualPriceId`
      and `monthlyPriceId`, and into `PLAIN_PRICE` in
      `supabase/functions/create-checkout/index.ts`. A test pins the two
      files equal.
- [ ] Discount codes: keep each one to the **product**, or to nothing.
      Never keep one to a price. For someone in their free trial,
      `create-checkout` buys a copy of the plain price, which is a
      different price in Paddle, so a discount kept to a price id cannot
      apply there. The function turns such a code away ("Discount code
      not recognised.") and makes no transaction, and it does the
      same for a code that has reached its end date or its limit of uses.
      Paddle still lists all of those as "active": that word only means
      not archived (read on Paddle's list-discounts page, 23 Nov 2026).
      A lapsed account opens the plain price itself, where Paddle's own
      overlay judges the code as it always did.
- [ ] The product also has two older prices with a trial set on the price,
      `annualTrialPriceId` and `monthlyTrialPriceId` in `config.js`. They
      are retired: nothing in `billing.js` opens them. Their ids stay in
      `config.js` for now, because a browser can pair an older cached
      `billing.js` with the new `config.js`, and that older file charges
      today if the ids are missing. Do not archive them in Paddle in the
      same release either: an old cached page can still open one, and
      what Paddle does with an archived price in checkout, or with a
      subscription already on it, was not read. Once
      "trial subscription on a catalogue price" has stopped appearing in
      the `paddle-webhook` log for a few weeks, archive both, then take
      the two ids out of `config.js` in a release of their own.
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

**Which path you take decides what this test proves.** While an account's
own free trial is running (to the end of 5 Dec 2026 for an account made
before 22 Nov 2026, 14 days from signup after), `billing.js` asks the
`create-checkout` function for a transaction that already carries the right
number of free days, so that purchase authorises the card and takes
**nothing** today — there is no charge to refund, and the status stays
`trialing`. Only a lapsed account opens the plain price and pays on the
spot. Run both, in this order, on a throwaway account rather than your own.
Then run Test C, on another throwaway account: it is the old Buy button,
and the one time the net under all this is seen working against Paddle.
Last, Test D: two spare transactions made in Test A and left unpaid, one
never opened and one opened and left, have been cancelled about an hour
later.

Test A — still in trial, takes no money, and is the first real purchase
through `create-checkout`. Everything about that function was read from
Paddle's documentation and run against stubs. This test is where it meets
Paddle, and the list at the end of it says what only this test can show.

Before the merge the live `billing.js` is still the old one, so Test A is
run from the browser console. Sign in on the live site as a throwaway
account that is still in its free trial, reload the page so nothing of
Paddle's is loaded yet, and open the console.

First, a spare. This makes one more transaction for the same account and
opens nothing:

```js
(async () => {
  const t = await CT.auth.validToken();
  const r = await fetch(CT.config.supabaseUrl + '/functions/v1/create-checkout', { method: 'POST', headers: { apikey: CT.config.supabaseAnonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ cadence: 'monthly' }) });
  console.log('spare', r.status, await r.json());
})();
```

- [ ] Write down the spare's `transactionId` and the time. Do not open it
      and do not pay it. It is looked at again in Test D, at least 75
      minutes from now, to see that `expire-checkouts` has cancelled it.
      (Until 25 Nov 2026 the spare was there to find out whether a
      transaction made earlier can still be opened later, and from which
      day Paddle then counts its free days. "What the spare found",
      below, has the answer.)

Then a second spare, opened and left. Every prepared purchase a customer
leaves behind is one that was opened: `billing.js` opens the overlay with
the customer's email straight after `create-checkout` answers. Whether
Paddle changes anything on a transaction once a checkout has been opened on
it (its origin, its custom data, how its payment attempts are listed) has
not been seen, and `expire-checkouts` tests all three. So one spare must be
opened. Paste the spare snippet above once more, write down the new id as
"the opened spare", and paste this with that id in it:

```js
(async () => {
  if (!window.Paddle) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  Paddle.Initialize({ token: CT.config.paddle.clientToken, checkout: { settings: { displayMode: 'overlay', theme: 'light' } } });
  Paddle.Checkout.open({ transactionId: '<the opened spare transactionId>', customer: { email: CT.auth.getUser().email } });
})();
```

- [ ] The overlay opens. Wait until the price shows and your email is
      filled in. **Do not pay.** Close the overlay. Write down the opened
      spare's id and the time. Test D looks at this one too.
- [ ] Your call, about two minutes: a third spare, for a theory. Read in
      Paddle's documentation on 25 Nov 2026 and never tried: the page
      that holds a checkout may be able to replace the custom data on
      that checkout's transaction, which is where `create-checkout`
      writes `made_by`. `expire-checkouts` also knows a transaction by
      the one-off price on it, so that this would not matter, and
      whether Paddle's list carries that price's description has not
      been seen either. To find out both: make one more spare, open it
      with the snippet above, and with the overlay open run
      `Paddle.Checkout.updateCheckout({ customData: { note: 'test' } })`
      in the console. Write down what the console says (an error is an
      answer too), close the overlay without paying, and write down the
      id as "the changed spare". Test D reads the result.
- [ ] Reload the page before going on, so the test itself starts with
      nothing of Paddle's loaded.

Then the test itself. Paste this. It sends exactly what the new
`billing.js` sends.

```js
(async () => {
  const t = await CT.auth.validToken();
  const r = await fetch(CT.config.supabaseUrl + '/functions/v1/create-checkout', { method: 'POST', headers: { apikey: CT.config.supabaseAnonKey, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ cadence: 'monthly' }) });
  const d = await r.json(); console.log(r.status, d);
  if (!d.transactionId) return;
  if (!window.Paddle) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  Paddle.Initialize({ token: CT.config.paddle.clientToken, checkout: { settings: { displayMode: 'overlay', theme: 'light' } } });
  Paddle.Checkout.open({ transactionId: d.transactionId, customer: { email: CT.auth.getUser().email } });
})();
```

- [ ] The console prints `200` and an answer with `ok: true`, a
      `transactionId`, `trialDays` and `firstPaymentFrom`. Write down
      `trialDays` and `firstPaymentFrom`. `firstPaymentFrom` is the rule's
      date for this account. Any other status: "Reading a failure" below,
      and stop.
- [ ] **Before paying**, write down what the overlay shows: the
      first-payment day or the count of free days, the price, the
      currency, whether tax is included, and whether your email is filled
      in. Write down which of the three it is: a first-payment day, a
      count of free days, or neither. The day checkout shows must be the
      purchase day plus `trialDays`
      days. This is the point of the release, and it is the first time it
      is seen: Paddle's documentation does not say what the overlay shows
      for a trial. If it shows neither a day nor a count, do not pay and
      do not merge yet ("If Test A fails", below).
- [ ] Change the country in the overlay to one outside Australia and note
      the price. The pages say "Checkout shows the final price, in
      Australian dollars", so the currency should stay A$ (seen on 25 Nov
      2026: Paddle has no currency conversions switched on, on this path or
      the old one). If another currency appears, somebody has switched
      conversions on in Paddle: **stop and do not merge** until the pages
      are read against what checkout now shows.
- [ ] Pay. Nothing is taken. In Paddle the subscription is `trialing`, and
      `next_billed_at` must be that day: the purchase time plus
      `trialDays` days, the same day the overlay showed, at or after the
      rule's date and under 24 hours after it.
      The rule's date (`firstChargeAt` in `paddle-webhook`, `freePeriod`
      in `create-checkout`) is the later of the day the account was made
      plus 30 days on a yearly plan or 21 days on a monthly plan
      (`FREE_DAYS_YEARLY`, `FREE_DAYS_MONTHLY`) and `LAUNCH_FIRST_CHARGE`.
      There is no subscribe-by date: it is keyed on **the account's
      creation date and the plan**, not on when the purchase is made. So
      a throwaway account made today and bought today on the monthly plan
      expects the rule's date to be **`2027-01-01T12:00:00Z`** if the
      account is made before 10:30 pm on 11 Dec 2026, Adelaide time
      (before 10:30 pm on 2 Dec on the yearly plan), and day 21 (monthly)
      or day 30 (yearly) from account creation after that.
      `next_billed_at` is then the first moment at or after it that falls
      at the time of day you paid. `2027-01-01T12:00:00Z` is 10:30 pm on
      1 Jan in Adelaide, so a purchase made before 10:30 pm in Adelaide
      shows **2 January 2027** there, and one made after 10:30 pm shows
      1 January. It is never before `2027-01-01T12:00:00Z`: the moment
      the last time zone on Earth (UTC-12) reaches midnight on New Year's
      Eve, so "Pay nothing until 2027" holds on every customer's calendar.
      It is not Adelaide midnight, which is still 31 December 2026
      everywhere to the west.
- [ ] Confirm the `public.subscriptions` row's **`plan` changes from `trial` to
      `monthly`**. The status stays `trialing` and does *not* become `active`
      on this path, and looking for `active` here reads a working webhook as a
      broken one. `current_period_end` reads the same instant as
      `next_billed_at`. `has_active_plan()` reads this column, so it is
      what keeps Premium on until the first payment.
- [ ] Confirm a row in `public.billing_events`, and that its payload
      carries `custom_data.user_id` (the test account's id) and
      `custom_data.trial_days`. Paddle's documentation says custom data on
      a transaction is copied to the subscription it makes; this is where
      that is seen. Without `user_id` there the webhook cannot tell whose
      purchase it is ("If Test A fails", below).
- [ ] Confirm **three** rows in `identity.product_entitlements`: `can_sync`,
      `can_use_calendar`, `can_use_screensaver`. Note that `grant_trial` may
      already have written here, so check `source` and the timestamps rather
      than just counting rows.
- [ ] Read the `create-checkout` function log. One line for this purchase:
      "checkout made: monthly, N days, first payment from ...", with the
      `trialDays` and `firstPaymentFrom` you wrote down, and no line
      starting "Could not make checkout".
- [ ] Read the `paddle-webhook` function log. It has "first charge:
      checkout's date stands". It has none of "first charge moved after
      checkout", "Could not defer first charge" and "trial subscription on
      a catalogue price". Nor does it have "free period on an account
      whose own free trial was not running": this account's trial is
      running. If any delivery answered 500 and was then
      retried, check `current_period_end` again after the retry: it must
      still read the same instant as `next_billed_at`.
- [ ] Confirm a row in `public.foundation_claims` for the test account with a
      place number, and that `select public.foundation_status();` shows one
      place fewer (so do `pricing.html` and `foundation.html`, once the new
      pages are published).
- [ ] Take the place back with the withdraw statement in
      `schema-foundation.sql` (the note can be 'withdrawn: owner test
      purchase'). Confirm `select public.foundation_status();` is back where
      it started. The row stays, so Test B's purchase on the same account
      takes no place.
- [ ] Open the customer portal for the test account from the app's
      Settings. It opens, and it names the plan properly (the price was
      made for this one transaction, and how the portal names such a
      price was not read).
- [ ] Repeat once on the yearly plan, on a second throwaway account still
      in its trial: change `cadence: 'monthly'` to `cadence: 'annual'` in
      the snippet. And once with a discount code, if any exist: add
      `discountCode: '<the code>'` beside `cadence`. Try a good code
      that is kept to the product or to nothing: the overlay must show
      the discounted price. Then, if you have one, try a code that has
      reached its end date, or one kept to a price: the console must
      print `422` and `discount_not_found`, and nothing opens. If a good
      code prints `502`, read the `create-checkout` log: Paddle refused
      the discount on this kind of transaction, and codes cannot be used
      by someone in their trial until that is understood.

What Test A does not show. With `create-checkout`, Paddle's own date is
already right, so `paddle-webhook` moves nothing in Test A, and the move
itself (`deferFirstCharge`) is not exercised by it. And `create-checkout`
answering 200 proves `PADDLE_API_KEY` is set and may read a price and
write a transaction, but not that it may change a subscription, which is
what the move needs. Test C, below, is where the move meets Paddle: run
it before the merge. When a move is needed and cannot be made,
`paddle-webhook` still switches Premium on, answers 500 to Paddle, logs
"Could not defer first charge", and Paddle sends the event again, up to
its own retry limit (5.6).

What only this test can show (none of it is in Paddle's documentation, or
it was read there and never run):

- what the overlay shows for a trial: a date, a count of days, or neither;
- that the trial is counted from the moment checkout completes;
- that a transaction made with no customer, address or currency is priced
  in the buyer's own currency and with tax shown, as a checkout opened on
  a catalogue price is;
- that the per-country prices copied from the catalogue price are used;
- that `custom_data` reaches `subscription.created`;
- that the overlay opens with `customer` beside `transactionId`, and fills
  in the email;
- that a discount set on the transaction shows in the overlay;
- that `current_billing_period.ends_at` in the payload is the same instant
  as `next_billed_at` (if not, the webhook writes the row to
  `next_billed_at` itself, and its log still says the date stands);
- how the customer portal and Paddle's receipts name a price made for one
  transaction;
- that the API key may do what the function asks of it;
- whether a transaction made earlier can still be opened later, and from
  which day its free days are then counted (answered on 25 Nov 2026:
  "What the spare found", below);
- what Paddle does with a discount that is set on a transaction like this
  one.

If Test A fails:

- **The overlay shows neither a first-payment day nor a count of free
  days.** Do not merge until you have decided what to do. The bill is
  right: every tick about `next_billed_at` can still pass. But the
  paragraph that warned about the date is off all three pages, so the
  customer would be shown no first-payment day anywhere before paying,
  which is not what "just make sure we get the date right" asked for. The
  choices are yours, and none is built. (One of them: the page says the
  number of free days before checkout opens. `create-checkout` already
  answers with it, as `trialDays`.)

- **The price is not in Australian dollars, or tax is not as the pages
  say.** Do not merge. Decided by the owner on 25 Nov 2026: prices are in
  Australian dollars everywhere, and `pricing.html` and `foundation.html`
  say "Prices are in Australian dollars and include GST or VAT. In some
  countries, such as Canada, sales tax is added at checkout. Checkout
  shows the final price, in Australian dollars." That was read from
  Paddle's price preview for the two catalogue prices (AU, NZ, GB and DE
  with tax inside A$2.90; Canada A$3.04 with tax on top; the United
  States with no tax when no ZIP code is given, not tried with one). If
  checkout shows anything else, the sentence or Paddle's settings have
  moved apart.
- **`custom_data` is missing from `subscription.created`.** Do not merge.
  The webhook would answer "unattributed" and the subscriber would have no
  Premium. Cancel the test subscription in Paddle.
- **The overlay will not open with `customer` beside `transactionId`.**
  Take `customer` out of that one call in `billing.js` (and the snippet).
  The customer then types their email; the purchase is still tied to the
  account by `user_id`.
- **The first-payment day is not the purchase day plus `trialDays`.** Do
  not merge, and write down both dates: the day arithmetic rests on Paddle
  counting whole days from the purchase.

Test B — the money path. Expire the same account's trial first:

```sql
update public.subscriptions
   set current_period_end = now() - interval '1 day'
 where user_id = '<test account uuid>';
```

- [ ] Buy the monthly plan again, through the live checkout (the Buy
      button, or `CT.billing.openCheckout('monthly')` from the console).
      This time the charge is real.
- [ ] Confirm the row flips to `active`/`monthly`.
- [ ] The `create-checkout` log shows no line for this purchase: a lapsed
      account never calls it. (Pasting the Test A snippet as this account
      prints `409` and `not_in_trial`, opens nothing, and does write one
      "Could not make checkout" line.)
- [ ] Refund and cancel in Paddle. Cancel Test A's subscription as well:
      it is a separate subscription, and left alone it takes its own first
      payment on its own date.

What the spare found. `create-checkout` fixes the free days on a
transaction when it makes it, and Paddle counts them from when it is paid.
Nothing ties the two together.

- **Found on 25 Nov 2026.** A prepared purchase left unpaid could still be
  opened a day later, after the account's own trial had ended, and still
  offered the full free period, counted from the day of payment. The
  terms give that person no free period: they pay on the day.
- **Paddle's documentation says nothing either way** about a transaction
  being opened long after it was made, or closing by age (read 23 and
  25 Nov 2026).
- **The owner's decision, 25 Nov 2026.** Unpaid prepared purchases are now
  cancelled about an hour after they are made. Cancelling a subscription
  after payment was offered and declined, and is not built.
- **How.** The `expire-checkouts` function runs every ten minutes (the
  `countdown-expire-checkouts` job). It cancels every transaction that
  `create-checkout` made, that nobody has paid, and that Paddle says was
  made 60 minutes ago or more. So a prepared purchase stays open for
  between 60 and about 70 minutes. It never cancels one that is billed,
  paid, completed or past due, one that belongs to a subscription, one
  made any other way (an invoice from the dashboard, a checkout opened
  on a catalogue price), or one younger than 60 minutes.
- **What is left.** The hour itself: someone whose trial ends inside the
  hour can still pay and start the free period. A transaction carrying a
  payment attempt that never settles is left alone. More than 120 an
  hour wait for later runs. `create-checkout` has no limit on how often
  one account may call it, so one account can make more than 120 an hour
  by itself, on purpose. The hour is not a ceiling against that: every
  unpaid one then waits longer, other people's included, and the log
  says "more waiting yes" run after run (5.6 says what to look for). A
  limit for each account needs a table to count in, which is your
  decision, and is not built. Any stretch when the function or the job is
  not running leaves them all open. And none of this is true until the
  function is deployed AND the job is scheduled (5.6).
- **A separate route, still open.** `expire-checkouts` only ever touches
  transactions that `create-checkout` made. The same free period after a
  trial has ended can be started today by opening one of the two retired
  catalogue trial prices by hand: their ids are in `app/config.js`, and
  the console line at the end of Test C does exactly that. Nothing
  cancels a checkout opened that way. This route stays open until those
  two prices are archived, and 8.1 says when. So never read this passage
  as "a free period after a trial has ended is now only possible within
  an hour". `paddle-webhook` still writes "free period on an account
  whose own free trial was not running" and "First payment later than
  the rule" in its log (5.6), which is how a late payment by either
  route is found.
- **Not yet seen.** Everything about `expire-checkouts` was read from
  Paddle's documentation on 25 Nov 2026 and run against stubs. Test D,
  below, is where it meets Paddle.

Test C — the net. Takes no money, and can only be run this way before the
merge. Until the merge the live Buy button is still the old one: it opens
a catalogue trial price, so Paddle's own date lands short of the rule and
`paddle-webhook` has to move it later. Nothing else in this release runs
that move against Paddle, and after the merge it is the only thing
between a returning visitor on an old cached page and a first payment in
December. A returning visitor's browser can go on running the old page and
the old `billing.js` from its cache for a while after the merge: the
`pricing.html` that is live now asks for `billing.js` by its plain name
(read in `main`'s copy on 23 Nov 2026, not tried in a browser).

- [ ] Sign in on the live site as another throwaway account that is still
      in its free trial and has no subscription (not the Test A account).
      Reload `pricing.html` and press the live Buy button for the monthly
      plan, or run `CT.billing.openCheckout('monthly')` from the console.
      The overlay shows a first payment about two weeks away (one week,
      if the retired 7-day change was made in Paddle). That short date is
      expected here. Pay. Nothing is taken.
- [ ] Read the `paddle-webhook` function log. It has "trial subscription
      on a catalogue price" and "first charge moved after checkout:
      checkout showed ..., rule gives ...". It has no "Could not defer
      first charge".
- [ ] In Paddle the subscription is `trialing` and `next_billed_at` is
      exactly the rule's instant, to the second, not rounded to a whole
      day: `2027-01-01T12:00:00Z` for an account made before
      `2026-12-11T12:00:00Z`.
- [ ] `current_period_end` on the account's `public.subscriptions` row is
      the same instant.
- [ ] If the log has "Could not defer first charge" instead: **stop and do
      not merge.** The line says why. "PADDLE_API_KEY not set", or a
      refusal from Paddle about permissions, means the key cannot change
      a subscription (5.6). Fix it; Paddle sends the event again by
      itself and the next attempt makes the move. Check the two dates
      above again afterwards.
- [ ] Take the Foundation place back (the withdraw statement, as in
      Test A), and cancel this subscription in Paddle.

If the merge has already happened, the live button is the new one and this
test cannot be run from it. The same purchase can still be made from the
console of a throwaway account in its trial, by opening the retired
monthly trial price directly:
`Paddle.Checkout.open({ items: [{ priceId: CT.config.paddle.monthlyTrialPriceId, quantity: 1 }], customer: { email: CT.auth.getUser().email }, customData: { user_id: CT.auth.getUser().id } })`,
after the two lines of the Test A snippet that load Paddle and call
`Paddle.Initialize`.

Test D: the hour. Takes no money. Run it before the merge, at least 75
minutes after the spares in Test A were made, and after
`supabase/schema-expire-checkouts.sql` has been run (5.6). It is the first
time `expire-checkouts` meets Paddle.

- [ ] Have the ids and times of the two spares from Test A: the first
      spare, never opened, and the opened spare, opened with your email
      and closed without paying. About 75 minutes after the later of the
      two, just before looking, make a fresh spare: sign in as a
      throwaway account still in its free trial and paste the "First, a
      spare" snippet from Test A again. Write down its id and the time.
- [ ] In Paddle, open Transactions [check label: the Transactions list and
      its status column were not read from Paddle]. The first spare reads
      Canceled. The opened spare reads Canceled. The fresh spare is still
      Draft.
- [ ] Read the `expire-checkouts` function log. The runs after the two
      spares' 60 minute marks have a line starting "checkouts closed:
      closed 1, ..." for each, or one line with "closed 2" (higher
      numbers if other unpaid ones were waiting). Between them the lines
      count both spares as closed. There is no line starting "Could not
      close checkouts".
- [ ] Reload the page, open the console, and paste this with the FIRST
      spare's id in it:

      ```js
      (async () => {
        if (!window.Paddle) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
        Paddle.Initialize({ token: CT.config.paddle.clientToken, checkout: { settings: { displayMode: 'overlay', theme: 'light' } } });
        Paddle.Checkout.open({ transactionId: '<the spare transactionId>' });
      })();
      ```

      **Do not pay.** Write down exactly what the overlay does: whether
      it opens at all, and what it says. Nobody has seen this. The test
      passes when no purchase is offered. Close it. Then do the same
      with the opened spare's id.
- [ ] If the first spare or the opened spare is still Draft or Ready after 80 minutes, or
      still opens and offers a purchase: **stop and do not merge.** If
      only the opened spare is left, opening a checkout changes
      something the function tests, and that is every real customer's
      case. Read the newest lines in the log:
      - "listed 0" means Paddle's list did not return the spare. The
        list asks for origin `api` only, so a spare whose origin Paddle
        reports as something else once a checkout has been opened on it
        shows up here, and never as "not ours". The documentation does
        not settle what Paddle does.
      - "not ours 1" means the list returned the spare and the function
        did not recognise it: its custom data did not come back in the
        shape `create-checkout` wrote AND the list entry did not carry
        the one-off price's description; or its `created_at` is in a
        format the function does not read; or a subscription id, an
        invoice number or a billed date is set on it; or its id is not
        the shape of a transaction id.
      - A line starting "Could not close checkouts" says why by itself
        ("Reading an answer from `expire-checkouts`", below). With
        "changed 1" and "still unpaid did not pass the second read",
        the single read most likely did not list the spare's payment
        attempts. With "refused 1", Paddle would not cancel, and the
        line gives the status and Paddle's short code. With "failed 1",
        Paddle could not be reached or answered with a fault.

      Bring the line back; nothing has been cancelled that should not
      be.
- [ ] If you made the changed spare in Test A: open that transaction in
      Paddle and read its custom data and its status. Custom data that
      still has `made_by` means the page could not replace it, and the
      theory is wrong for a transaction made through the API. Custom
      data without `made_by` and a status of Canceled means the theory
      is right and the price's own mark did its job. Custom data without
      `made_by` and still Draft after 80 minutes means the function does
      not recognise such a transaction, and anyone who knows the console
      line can keep a prepared purchase open: **stop and do not merge**,
      and bring back the newest log line.
- [ ] Optional, and your call. Make one more spare, open it in the overlay
      with the snippet above, and leave the overlay open past 75 minutes
      without paying. Write down what the overlay shows then, and whether
      it would still take a payment. **Do not pay.** This is what a
      customer who leaves checkout open for over an hour would see, and
      nobody has seen it. The page itself says nothing at that moment:
      `billing.js` does not listen to the overlay.

After the merge — the real button. Tests A and B ran before the new
`billing.js` was live, so one look is left:

- [ ] On a throwaway account still in its free trial, open `pricing.html`
      (reload it once first) and press the real Buy button. The overlay
      opens and shows the same kind of first-payment date Test A did.
      Close it without paying. The `create-checkout` log has one more
      "checkout made" line.

Diagnostics cannot check any of 8.2 or 8.4 for you — the exchange is server to server, so
this is the one you must watch happen.

Note that a fresh account is already entitled: `grant_trial` (in
`schema-access-codes.sql`) gives every new user a trial (`public.trial_length()`:
runs to the end of 5 Dec 2026 before 22 Nov 2026, 14 days from signup after). The
plans in Settings and the Get Premium button at the top of the page show for
the whole trial (since 25 Nov 2026), so the real Buy button is the way to reach
checkout. The Play app shows neither.

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
  the checkout was opened outside both `billing.js`, which attaches the id
  when it opens a plain price, and `create-checkout`, which writes it on
  the transaction it makes.

Reading an answer from `expire-checkouts` (in `net._http_response`, or in
the function log; `supabase/README.md` says how to read both). Every fault
writes one log line starting "Could not close checkouts", with counts and
no account or transaction id. None of them charges anybody, and a fault
cancels nothing that should stand.

- **403** with the text "Forbidden": the call did not carry the cron
  secret, or `CRON_SECRET` is not set on the function. Run
  `supabase/schema-expire-checkouts.sql` again; if `CRON_SECRET` was
  changed, run `cron.sql` first.
- **405**: the call was not a POST. The job always sends one.
- **503**, error "not_configured": `PADDLE_API_KEY` is not set.
- **502**, error "paddle": Paddle could not be reached, turned the run
  away, or answered with something that could not be read. The word
  after "stopped" in the line says which. "rate_limited" is a 429:
  Paddle turned the run away for calling too often, and the next run is
  the retry. "paddle_auth" is a 401 or 403: the key may not read or
  write transactions (5.6). "list_failed" is the list of unpaid
  transactions not arriving or not being readable; a status of 400 there
  means Paddle did not accept the list request as written, which stubs
  could not show. "paddle_failing" is three failures in a row, of reads
  or of cancels. "clock" means this server's clock and the time on
  Paddle's answer differ by more than a minute, so the run would not
  judge anything's age. With "stopped no" and "failed" above 0, single
  reads or cancels failed and the rest of the run went ahead.
- **502**, error "left_open": Paddle answered, and old unpaid ones were
  left open for a reason other than somebody paying. The line says
  which.
  - "Paddle refused N, and last a cancel answered 409 (...)": Paddle
    would not cancel, and this is its status and short code for the
    last one refused. Once in a while this is somebody paying in the
    instant between the second read and the cancel. Run after run means
    Paddle does not accept the cancel for some kind of transaction, and
    none of that kind is being cancelled: nobody has seen what Paddle
    answers here before Test D.
  - "N still unpaid did not pass the second read": the single read of a
    transaction came back unlike its entry on the list, most likely
    without its payment attempts listed. Those are counted under
    "changed" and are not cancelled.
  - "more are waiting and this run cancelled none": with "stopped
    pages", 120 or more old ones that the function cannot cancel are in
    front of the rest: ones being paid, or unpaid API-made ones it does
    not recognise ("not ours"). With "stopped reads", 40 in a row
    turned out to be being paid or already paid. Nothing is stored
    between runs, so the ones behind are not reached until the ones in
    front are dealt with by hand in Paddle.
- **200**, with "stopped cap", "stopped reads", "stopped pages" or
  "stopped time": not a fault by itself. The run cancelled some, reached
  its limit of 20 cancels sent, 40 second reads, 120 listed or 18
  seconds, says "more waiting yes", and the next run carries on. "more
  waiting yes" on several runs in a row means the hour is not being kept
  (5.6, the going-away ticks).
- **200**, the other counts. "changed" is one paid, billed or cancelled
  between the list and the second read, which is as it should be. "being
  paid" above 0 on every run is a payment attempt that never settled:
  that prepared purchase stays open for good unless you cancel it in
  Paddle. "not ours" above 0 is an unpaid API-made transaction with
  neither of `create-checkout`'s marks, which should not exist.
- **500**: something nobody planned for. The line names the kind of
  error and nothing else.
- **A 404, or a 401 that is not from the function**: the function is not
  deployed, or was deployed without `--no-verify-jwt`.
- **A row in `net._http_response` with no status and a time-out
  message**: the run took longer than the 25 seconds the job waits. The
  function starts no new transaction after 18 seconds and gives each
  request 3, so a run should end inside 24 and this should not be seen.
  Cancels already sent to Paddle stand. Whether Supabase lets the
  function finish and write its log line once the caller has hung up is
  not known.

Reading a failure from `create-checkout` (the status the Test A snippet
prints, or the browser's Network tab; the page itself only ever says to try
again). Every one writes a log line starting "Could not make checkout", with
the reason and no account id. None of them charges anybody or opens a
checkout.

- **401 `not_signed_in`** — no session token, or Supabase did not accept
  it. Sign in again.
- **409 `already_subscribed`** — the account has a subscription that is
  running. Nothing is made, so there is never a second one from here.
- **409 `not_in_trial`** — the account's own free trial is not running
  (ended, cancelled, or complimentary). That is the plain-price path:
  `billing.js` takes it on the next click.
- **422 `discount_not_found`** — a discount code was typed and Paddle has no
  active discount with that code that is open to checkout, or it has one
  that cannot be used here: it has reached its end date, it has been used
  as often as it allows, or it is kept to other products or to a price
  (8.1). The log line says which.
- **502 `paddle`** — Paddle refused, could not be reached, or answered with
  something other than what was asked for. The log line says which: the
  catalogue price could not be read or is not as expected (archived, a
  trial set on it, the wrong billing cycle); the discount lookup failed;
  Paddle refused the transaction (its own words follow, cut short); or
  "Paddle's answer did not match what was asked for", which means the
  transaction came back without the trial, the amount or the account that
  was sent, and was not opened. A refusal that mentions permissions is the
  API key (5.6). "answered 429" is Paddle turning the function away for
  calling too often (5.6, the going-away ticks).
- **503 `not_configured`** — `PADDLE_API_KEY` is not set.
- **503 `account_unreadable`** — the account's row could not be read, has
  no creation date, or gives a free period of more than a year. The last
  is a wrong date on the row: look at `created_at` and
  `current_period_end` for that account.
- **A 404, or a 401 that is not JSON with `not_signed_in` in it** — the
  function is not deployed, or Supabase's gateway turned the token away
  before the function ran. `supabase functions list`.

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
`billing.js` is loaded by `app/pricing.html` too: when its `?v=` is bumped,
bump it there as well, or the pricing page can open checkout with an old
`billing.js` (a test pins the two equal).

## If you ever need to take the service down

The terms promise **60 days' notice by email and a pro-rata refund** before
shutting the service down, and to keep the free on-device version working for
as long as reasonably possible. That is a commitment you made in writing, so
plan a wind-down around that promise rather than switching the repo to private.
