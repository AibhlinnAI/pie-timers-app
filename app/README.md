# Pie Timers

> *Some days you eat the pie. Some days the pie eats you.*

A live app replacement for `Countdown Timers.xlsx`. Everything the workbook did with
`NOW()` + F9 now updates itself once a second.

**The name and the tagline are the product thesis.** Time is a pie that empties
whether you look at it or not. Naming both directions — eating it, and being eaten
by it — is deliberate: the app never scolds anyone for a bad day. The pie simply
empties, and tomorrow there is another one. Keep that tone in any copy you add.

Published by Aibhlínn AI.

## Running it

Double-click `index.html`. That's the whole install — no Node, no build step, no
dependencies, no internet connection required. In this mode the app is entirely
local: no account, no sync, in-app alerts only.

Accounts, sync and background notifications need the app **served over HTTPS**
(or from `localhost`), because service workers and Web Push refuse to run from
`file://`. See *Deploying* below. Serving it also enables the browser's
**Install app** option, via `manifest.webmanifest` and `icon.svg`.

The app degrades cleanly: until `config.js` is filled in, the Account tab explains
that sync is not set up and everything else works exactly as before.

## What carried over from the workbook

| Workbook sheet | App equivalent |
| --- | --- |
| Countdown Dashboard | **Dashboard** tab — now live, not a snapshot |
| Daily Countdown Timers | Day strip + weekly schedule preview |
| Countdown Reducing Pie Timers | The two reducing pies |
| Countdown Calculator | **Calculator** tab |

The weekly schedule defaults are the exact values from the workbook, converted from
Excel day-fractions to minutes past midnight:

| Day | Start | Lunch \| Head Home | End of day |
| --- | --- | --- | --- |
| Monday | 9:15 AM | 1:00 PM | 7:00 PM |
| Tuesday | 8:50 AM | 1:00 PM | 2:50 PM |
| Wednesday | 8:00 AM | 3:10 PM | 7:00 PM |
| Thursday | 9:20 AM | 12:30 PM | 2:40 PM |
| Friday | 8:40 AM | 12:30 PM | 2:40 PM |

Saturday and Sunday are present but switched off, showing `N/A | WFH` — the same
label the workbook used.

## What's new

- **Live ticking.** No F9. The tick is aligned to the top of each second so the
  clock never visibly stalls, and it re-syncs whenever the tab regains focus.
- **Editable schedule.** The Schedule tab writes straight to local storage. Untick
  a day to mark it `N/A | WFH`.
- **Milestone alerts** at 30 / 15 / 10 / 5 minutes remaining and on completion,
  with an optional chime. Each alert fires once per day.
- **Urgent state.** Under 15 minutes, a pie and its bar switch to the orange
  accent.

### Appointments

Add anything with a fixed time on the Schedule tab — a meeting, a call, a pickup —
and the soonest one counts down on the Dashboard as a third pie. When it passes,
the next one takes over automatically. Milestone alerts fire for appointments too.

**The focus window** is what makes the pie meaningful. A work day has a natural
start, so its pie can span start→finish. A meeting has no such anchor, so it uses
a fixed window instead (default 1 hour, set in Settings): the pie sits full while
the appointment is further away than the window, then drains through it. A full
pie therefore always means the same thing — "at least this long to go" — which is
what makes it readable at a glance rather than something to decode.

Appointments are free, on one device, and sync with everything else on a plan.

### Calendar sync

Connect a calendar on the Schedule tab and meetings appear on their own. Works with
Google, Outlook, iCloud, Fastmail — anything publishing a private iCal address. No
OAuth and no app-store review, which is why it ships before the Google one-click
version.

Synced events and manual appointments are treated identically once loaded: the
countdown simply takes whichever comes next. Synced entries are read-only in the
app — the calendar owns them.

**All-day events are deliberately excluded from the countdown.** "Counting down to
today" is not useful, and an all-day entry would otherwise block real meetings for
the whole day. They still appear in the list, tagged.

Feeds refresh every 15 minutes via `pg_cron`, or on demand with **Refresh**.
Events are cached locally so the countdown survives going offline.

**Privacy — read this before launch.** An iCal address is a bearer token for
somebody's entire calendar: no expiry, no second factor. Handle accordingly.

- It is never returned to the browser after being saved. The client reads
  `my_calendar_feeds`, a view that omits the URL entirely.
- Only the edge function, using the service-role key, can read it back.
- It is **not encrypted at rest** — it sits in Postgres protected by row-level
  security and Supabase's disk encryption. If you want envelope encryption, that
  is a worthwhile hardening job and is not yet done.
- The sync function refuses localhost, private ranges and the cloud metadata
  address, because it fetches a URL a user supplied. Without that check it would
  be a server-side request forgery hole.

### Google one-click

**Connect Google Calendar** re-authorises with Google, adding the
`calendar.readonly` scope. Google's own API expands recurrence for us
(`singleEvents=true`), so none of the iCalendar reader is involved and events land
in the same table — the merge, the pie and the list are unchanged.

Read-only is the only scope requested. Nothing in the app can alter a calendar.

**Read this before launching it.** `calendar.readonly` is a Google *sensitive
scope*, and that carries real constraints:

- **Verification is required** before public use: privacy policy, a demo video, a
  written justification, and a review that takes weeks.
- Until verified, the app sits in **Testing** mode, capped at **100 test users you
  add by hand** in the Google Cloud console.
- **In Testing mode, Google refresh tokens expire after 7 days.** Every connected
  user must reconnect weekly until verification completes. The app handles this
  gracefully — it deactivates the feed, explains what happened, and shows
  *Reconnect* rather than *Refresh* — but it is a poor experience to launch on.

So: the iCal path is what to ship with. Start Google verification in parallel and
turn this on when it clears.

**Disconnect genuinely revokes.** It calls Google's revoke endpoint as well as
deleting the row, because deleting our record alone would leave the grant live in
the user's Google account, which is not what the button appears to promise.

**The refresh token** is a long-lived key to the calendar. It arrives in the OAuth
redirect fragment, goes straight to the server, and is never written to
`localStorage`, never stored client-side, and never returned by any read — the
client view exposes only a `has_google` boolean. Like the iCal URL it is **not
encrypted at rest**.

### What the iCalendar reader does and does not do

Supported: `VEVENT`, `DTSTART`/`DTEND`/`DURATION`, all-day events, `TZID` via the
IANA database, `RRULE` with `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`
(including ordinals like `3TU` and `-1FR`), `BYMONTHDAY`, `BYMONTH`, plus `EXDATE`,
`RECURRENCE-ID` overrides and `STATUS:CANCELLED`.

Not supported: `BYSETPOS`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR`/`BYMINUTE`,
`WKST`-sensitive weekly maths, `VTIMEZONE` definitions for zones outside the IANA
database, and per-attendee status (a meeting you declined still shows).

`ical.js` is written as plain JavaScript rather than TypeScript on purpose: it
means the exact shipping file can be unit-tested in a plain JS engine instead of a
hand-copied approximation of it.

### Why the timers are solid pies

## Why the timers are solid pies

The pies are filled wedges, not rings. The whole point is that the coloured
**area** shrinks in proportion to the time left, so "how much of my day is
gone" can be judged at a glance without reading, counting or converting any
numbers — the same principle as a Time Timer. A ring only thins at the rim,
which is far weaker as a spatial cue.

Twelve rim marks (four emphasised, at the quarters) give the eye fixed reference
points to judge the wedge against. Rendered area is linear in time remaining to
within 0.01% across the full sweep, so the visual is honest at every fraction.

If you change the dial size, `DIAL_CX` / `DIAL_CY` / `DIAL_R` in `app.js` must
match the `cx` / `cy` / `r` in the SVG markup in `index.html`.
- **Tab-title countdown.** The remaining time shows in the browser tab.
- **12/24-hour clock**, optional seconds, export/import of settings as JSON.
- **Overnight shifts** work — a timer whose target is before its start correctly
  wraps past midnight.

## Colour scheme

Lifted verbatim from the workbook's styles, defined as CSS variables at the top of
`styles.css`:

`#2E1838` plum · `#4B2A5A` purple · `#8A4DA5` purple-lift · `#7030A0` violet ·
`#32493C` forest · `#FF8A00` orange · `#F6D7B0` cream ·
tints `#F1EAF5` `#D7CCE2` `#E8EFEA` `#D9EAD3` `#F4F1F7` `#FFF2CC` ·
muted text `#6B5E70`

The purple dial and green dial keep the pairing from the workbook's pie charts
(`4B2A5A`/`F1EAF5` and `32493C`/`E8EFEA`).

## Accounts & sync

Sign-in is **magic link or Google** — there is no password anywhere in the product,
so there is nothing to hash, reset, or leak.

Your schedule and settings live in one row per user. Sync runs on sign-in, on tab
focus, every 60 seconds, and 1.5 seconds after any edit (debounced). Edits made
offline are queued and pushed when the connection returns.

**Conflict rule: last write wins**, compared on `updatedAt`. This is the right
trade-off for a small single-user document edited on a handful of devices — a merge
UI would cost far more than it saves. Exact ties resolve in favour of the server so
devices converge instead of ping-ponging.

### Deleting an account

Account → **Delete my account**. The user must type `DELETE` to confirm; a single
misclick cannot trigger it.

Deleting the auth user needs the service-role key, which must never reach the
browser, so it runs in the `delete-account` edge function. That function takes the
user id **from the caller's own validated access token**, never from the request
body, so one user cannot delete another. It clears `push_subscriptions`,
`timer_profiles` and `notification_log`, then removes the auth user.

If the server call fails, nothing is destroyed — the error is shown and local data
is left untouched. On success the device's push subscription is released first, then
local storage is cleared and the app resets to the built-in defaults.

## Notifications

Milestones fire at **30, 15, 10 and 5 minutes remaining, and on completion**, once
per timer per day. There are two delivery paths:

| | Works when | Needs |
| --- | --- | --- |
| In-app + service worker | App open, including a background tab or minimised window | Nothing |
| Web Push | App fully closed | Account + VAPID key + the edge function |

Both paths tag a milestone identically (`YYYY-MM-DD\|timer\|milestone`), so a
milestone shows **once** even if both deliver it.

The timer maths is duplicated in `app.js` and in the edge function. Those two must
stay in step or the push will fire at a different moment than the in-app alert —
there is a comment marking this in both files.

## Plans and pricing

**Free forever, on one device:** the pies, the weekly schedule, the calculator and
in-app milestone alerts. The core benefit is never paywalled — people have to feel
the cognitive relief before there is anything worth paying for, and the free tier
is the best advertising the app has.

**Paid** adds only what actually costs money to run:

| | Free | Plan |
| --- | --- | --- |
| Reducing pies, schedule, calculator | ✅ | ✅ |
| In-app + background-tab alerts | ✅ | ✅ |
| Sync across devices | — | ✅ |
| Alerts when the app is fully closed | — | ✅ |

**Annual $19/yr. Monthly $2.90/mo** (=$34.80 a year). Priced low on purpose — the
goal is as many people as possible able to reach premium, not maximum revenue per
subscriber. The monthly price is a low barrier to try; the annual price saves
$15.80 and is the one to convert people onto once the timers have proved
themselves.

$19/yr is **$1.58 a month**, which is the number to lead with in any marketing —
it is a far easier figure to hear than the annual total, and it undercuts most
single-app subscriptions people already carry.

Display prices live in `config.js` under `paddle` — change them there, not in the
markup, and keep them in step with the actual prices set in Paddle. Paddle's
checkout always shows the real localised, tax-inclusive figure.

### What each plan actually nets you

Paddle takes roughly 5% + a **fixed 50c per transaction**:

| | Customer pays | Fees | You keep |
| --- | --- | --- | --- |
| Annual | $19.00/yr | $1.45 | **$17.55/yr** |
| Monthly | $34.80/yr | $7.74 (12 × 64.5c) | **$27.06/yr** |

Worth knowing: at these prices a monthly subscriber who stays a full year is worth
*more* to you than an annual one. Annual still wins in practice — cash up front,
no monthly churn, no failed-card dunning, and far less admin for the user. But the
$15.80 discount is a genuine cost to you, not a free lever, so don't deepen it
casually.

**Against the goal:** at ~$17.55 net per annual subscriber, covering Claude Max at
roughly $100–200/month (~$1,200–2,400/year) needs about **69–137 active
subscribers**. That's meaningfully more than the $24 price needed — a deliberate
trade: lower revenue per person, in exchange for the price being less of a barrier
to the people this app is built for.

**Nobody is locked out of their own data.** If a plan lapses, automatic sync stops
but "Sync now" still downloads the schedule, and Settings → Export still works.

### Free trial

**Everyone gets two months free on sign-up.** No card, no code, nothing to enter.
It is granted by a database trigger on account creation, so it cannot be requested
twice or forged from the client.

Two months rather than one is deliberate: these timers only prove themselves after
a few real working weeks.

The app stays quiet during the trial and only starts mentioning payment in the last
14 days. When it ends, automatic sync stops but nothing is deleted, no card is
charged, and "Sync now" still downloads.

**This replaces the launch promo code.** A public "first 50 free" code would end up
on coupon sites; a universal trial achieves the same thing with nothing to leak,
guess or resell.

### Access codes (friends and family)

Codes exist only for people you personally give access to, and are built so there
is nothing worth selling:

- **Bound to one email address.** The redeeming account's own address must match, so
  a shared or sold code does nothing for anyone else.
- **Single use**, so a leak costs exactly one slot and you can see whose.
- **Random and unguessable** — `MATE-K7P2-QX9M`, from an alphabet with no `0/O/1/I`
  so it can be read aloud.
- **Rate limited** to ten attempts an hour per account, so a dictionary attack on
  the redemption endpoint gets nowhere.
- **Wrong-email and nonexistent codes return an identical error**, so the response
  cannot be used to discover which codes are real.

Mint one:

```sql
select public.mint_access_code('friend@example.com', 'Jo — perpetual');
```

Add a third argument for a limited grant, e.g. `365` for a year. Kill one instantly
with `update public.access_codes set active = false where code = '…';`.

**Complimentary access** for anyone who cannot pay is a one-line SQL insert — see
the bottom of `supabase/schema-billing.sql`. Offer it freely.

### Discount codes

The checkout accepts any discount code you create in Paddle → Discounts, entered in
the field above the plan cards. Paddle validates it and shows the result in its own
overlay, so a mistyped or expired code fails gracefully.

If you run a public promotion, assume the code reaches a coupon site eventually —
that is near-certain. Cap redemptions and set an expiry in Paddle rather than
trying to prevent it.

## Deploying

**1 — Host the `app/` folder** on any static HTTPS host (Netlify, Vercel, Cloudflare
Pages, GitHub Pages). No build step; upload the folder as-is.

**2 — Create a Supabase project**, then run these in the SQL Editor, in order.
Full instructions and verification queries are in `supabase/README.md`.

```
supabase/schema.sql             core tables + row-level security
supabase/schema-billing.sql     subscriptions + entitlement
supabase/schema-access-codes.sql two-month trial + friends-and-family codes
supabase/schema-ratelimit.sql   sign-in throttle store
supabase/schema-calendar.sql    calendar feeds + expanded events
supabase/schema-google-calendar.sql  Google one-click columns
```

Two of these matter even if you skip the optional features:
`schema-access-codes.sql` carries the **two-month free trial trigger**, and
`schema-calendar.sql` adds the **`appointments` column** without which manual
appointments do not sync between devices.

`cron.sql` is deliberately not in this list — it is the only file with placeholders
to fill in, and it must wait until the edge functions exist. It is step 6 below.

**3 — Fill in `config.js`** with your Project URL and anon key (Project Settings →
API). Both are public by design; the RLS policies are what protect the data.

**4 — Configure auth** in Supabase → Authentication:
- URL Configuration → add your site URL to **Redirect URLs**
- Providers → enable **Google** and paste in your Google OAuth client ID/secret

**4a — Email sending (Resend).** Supabase's built-in mailer is a shared,
rate-limited relay that is not usable for real users. Since the magic link *is*
the login, an email that lands in spam is a total outage, not a minor annoyance.

1. Create a Resend account and add your sending domain.
2. Add the **SPF, DKIM and DMARC** DNS records Resend gives you. All three.
3. Use a subdomain such as `mail.yourdomain.com` so any reputation damage stays
   isolated from your main domain.
4. In Supabase → Project Settings → Authentication → SMTP Settings, enter
   `smtp.resend.com`, port `465`, username `resend`, and your Resend API key as
   the password. Set the sender to an address on your verified domain.
5. Raise the auth email rate limit (Authentication → Rate Limits) — the low
   default only exists because of the built-in mailer.

Send a test magic link to a Gmail, an Outlook and a work address before launch.
Inbox placement varies by provider and is the thing you actually care about.

**4b — Sign-in protection (Turnstile).** Without this the sign-in form will email
any address given to it, as often as asked — an email-bombing tool pointed at
strangers that burns your Resend quota and domain reputation.

1. Create a Turnstile widget at Cloudflare (free) for your domain.
2. Put the **site key** in `config.js` as `turnstileSiteKey`.
3. Set the secret and deploy the proxy:

```bash
supabase secrets set TURNSTILE_SECRET_KEY=... ALLOWED_ORIGIN=https://your-site.example
```

```bash
supabase functions deploy signin
```

Once `turnstileSiteKey` is set, the client stops calling `/auth/v1/otp` directly
and routes through the function instead. The function also throttles to 5 emails
per address and 15 per IP per hour, storing only hashes.

> If `TURNSTILE_SECRET_KEY` is unset the function **fails open** — it still sends,
> just without the bot check. That keeps a misconfiguration from locking everyone
> out, but it does mean you must confirm the secret is actually set in production.

**5 — For background push**, generate a VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

Put the public key in `config.js` as `vapidPublicKey`, then set the edge function's
secrets and deploy it:

```bash
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com CRON_SECRET=$(openssl rand -hex 32)
```

```bash
supabase functions deploy notify-milestones
```

**6 — Schedule it**: fill in the placeholders in `supabase/cron.sql` and run it.
It calls the function once a minute and prunes the delivery log nightly.

**7 — Deploy account deletion.** This one is required even if you skip push:

```bash
supabase secrets set ALLOWED_ORIGIN=https://your-site.example
```

```bash
supabase functions deploy delete-account
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by
Supabase automatically. Leaving `ALLOWED_ORIGIN` unset defaults to `*`, which is
fine for testing but should be pinned to your site before launch.

**8 — Billing (Paddle).**

1. Create a Paddle account and complete seller verification. Budget several days
   for this — they review new sellers, and it is not instant.
2. Create one product with two prices: annual and monthly.
3. Optionally create discount codes, each with a redemption limit and expiry.
4. Put the client token and both price IDs in `config.js`.
5. Add a webhook pointing at `.../functions/v1/paddle-webhook`, subscribed to the
   `subscription.*` events, then:

```bash
supabase secrets set PADDLE_WEBHOOK_SECRET=...
```

```bash
supabase functions deploy paddle-webhook
```

Test with Paddle's sandbox first — set `paddle.environment` to `'sandbox'` in
`config.js` and use sandbox keys. Verify a test purchase flips the Account tab to
a paid plan before switching to production.

Until `paddle.clientToken` and `annualPriceId` are set, **billing is off and every
signed-in account is treated as entitled**, so you can run the whole app without
payments while you get set up.

**9 — Calendar sync.**

```bash
supabase functions deploy calendar-sync
```

Then fill in the placeholders at the bottom of `supabase/schema-calendar.sql` and
run it, which schedules a refresh every 15 minutes. It reuses `CRON_SECRET` and
`ALLOWED_ORIGIN` from the earlier steps, so there are no new secrets to set.

Test with your own calendar first, and check a recurring meeting shows at the right
time — recurrence and timezones are where calendar bugs hide.

**10 — Google one-click** (optional; see the constraints above before committing).

1. Run `supabase/schema-google-calendar.sql`.
2. In Google Cloud console, enable the **Google Calendar API** and add
   `.../auth/calendar.readonly` to your OAuth consent screen's scopes.
3. Add your Supabase callback (`https://<ref>.supabase.co/auth/v1/callback`) to the
   OAuth client's authorised redirect URIs.
4. While unverified, add each tester under **Audience → Test users**.

```bash
supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
```

```bash
supabase functions deploy google-connect
```

```bash
supabase functions deploy calendar-sync
```

Re-deploy `calendar-sync` even if you already have it — it now handles both kinds.

## Files

```
app/
  index.html            markup and view structure
  styles.css            palette + all styling
  config.js             all your keys and price IDs (edit this)
  supabase.js           minimal auth + REST client, no dependencies
  billing.js            Turnstile, Paddle checkout, entitlement state
  sync.js               pull/push, conflict resolution, offline queue
  notify.js             permissions, service worker, push subscription
  app.js                schedule model, timer maths, render loop
  sw.js                 offline cache + push delivery
  manifest.webmanifest  PWA install metadata
  icon.svg              app icon

supabase/
  schema.sql            core tables + row-level security
  schema-billing.sql    subscriptions, entitlement, webhook audit log
  schema-ratelimit.sql  sign-in throttle store (hashes only)
  cron.sql              pg_cron schedule for the push job
  functions/notify-milestones/
    index.ts            works out who to alert and when
    webpush.ts          VAPID signing + RFC 8291 encryption
  functions/delete-account/
    index.ts            permanently removes the calling user
  functions/signin/
    index.ts            Turnstile-gated, throttled magic-link proxy
  functions/paddle-webhook/
    index.ts            keeps subscriptions in step with Paddle
  functions/calendar-sync/
    index.ts            fetches feeds, guards against request forgery
    ical.js             iCalendar reader + recurrence expansion
    google.ts           Google Calendar API reader
  functions/google-connect/
    index.ts            stores and revokes the Google grant
```

## Dependencies

The app loads **nothing** from a third party by default — no npm, no bundler, no
CDN. There are exactly two exceptions, both lazy-loaded and only on the Account
tab, because each vendor requires its own script and neither can be called over
plain HTTP:

- `challenges.cloudflare.com` — Turnstile, only when `turnstileSiteKey` is set
- `cdn.paddle.com` — checkout, only when `paddle.clientToken` is set

With neither configured, the app still starts, runs and works offline exactly as
it always did.

## Data & privacy

Signed out, everything stays in `localStorage` under `countdown-timers/v1` and
nothing leaves the device. Signed in, your schedule and settings are stored in your
own Supabase project — no third party is involved.

Row-level security means the public anon key can only ever reach the signed-in
user's own rows. The `notification_log` table has no client insert policy at all;
only the edge function writes to it, using the service-role key.

Session tokens are held in `localStorage`, the standard approach for a
no-backend-server SPA. If you later add a same-origin backend, moving them to
`HttpOnly` cookies would harden this against XSS.

## Notes for commercialisation

Billing, email deliverability, rate limiting and account deletion are all built.
What they still need is **your accounts and credentials** — see *Deploying*. None
of it is active until `config.js` and the function secrets are filled in.

Still genuinely open:

- **Support email — set.** `support@aibhlinn.ai`, in `config.js`. One change
  there updates the upgrade panel, the footer, the terms and the privacy policy;
  they all read from it. Make sure the mailbox actually exists and is monitored
  before launch — it is printed in both legal documents, so it is where refund
  requests, privacy requests and hardship requests will arrive.
- **Terms and a privacy policy.** Drafts are written: `terms.html` and
  `privacy.html`, linked from the footer of every page. Both carry an HTML
  comment listing what to fill in, and **neither has been reviewed by a lawyer**.
  Fill in `[LEGAL ENTITY NAME]`, `[ABN / ACN if registered]`, `[STATE]`,
  `[DATE]`, and — in the
  privacy policy — `[SUPABASE REGION]` and `[YOUR HOST]`. The region matters: it
  determines whether you are telling customers the truth about their data leaving
  Australia. Get both reviewed before the first sale.
- **Refund policy.** Written into `terms.html` as 30 days, no justification
  required, on top of the non-excludable Australian Consumer Law guarantees.
  Confirm it matches what you actually configure in Paddle.
- **Live verification.** Nothing here has been run against a real Supabase, Google,
  Resend, Turnstile or Paddle account — those need credentials only you can create.
  `diagnostics.html` does as much of that check as a browser can (see below).

### diagnostics.html

Deploy it, open it, read the reds. It checks, against whatever `config.js`
currently points at:

- HTTPS, service worker registration, and push support in this browser
- that the support address and the legal pages have no placeholders left
- that Supabase answers, that the anon key is accepted, and that email sign-in
  is enabled
- that every table exists **and that row-level security is actually on** — it
  asks each table for a row without a session, and a row coming back is
  reported as a live data leak, not a pass
- that every edge function is deployed, by sending an empty request that a
  deployed function rejects and a missing one 404s
- that the VAPID key decodes to a real 65-byte P-256 public key
- that the Paddle token, environment and price IDs are internally consistent
  (a live token with `environment: 'sandbox'` is the classic launch-day fault)

It performs no writes, sends no email and opens no checkout, so it is safe to
run in production. It also lists the five things only a human can test —
receiving a sign-in email, syncing between two real devices, a test purchase,
an account deletion, and an alert arriving with the app closed. Delete the file
before launch if you would rather not advertise which services you use; it
exposes no secrets, but it does name them.

## Verified

- **Against the workbook.** Friday 10:07 AM: total 230 / 360 minutes, elapsed 87,
  remaining 143 / 273 — identical to the spreadsheet. Edge cases covered: before
  start, after target, overnight wrap, missing target.
- **Client/server parity.** Every minute of the day across five schedules
  (7,200 checks) produces the same milestone in `app.js` and in the edge function.
  Zero mismatches.
- **Sync.** Remote-newer, local-newer, empty-remote seeding, exact ties, no-echo on
  adopt, corrupt server payloads, and network failure — 9 cases, all passing.
- **Crypto.** The RFC 8291 payload round-trips through an independent decryption
  implementation; header layout is correct; the VAPID JWT verifies against its
  public key; tampered ciphertext is rejected.
- **Boot.** Clean boot with no runtime errors, correct panel visibility for
  configured/unconfigured and signed-in/signed-out, at desktop and mobile widths.

Not verified here: a live Supabase round trip, real Google OAuth, and real push
delivery to a device. Those need deployed credentials, so test them once after
following *Deploying* above.
