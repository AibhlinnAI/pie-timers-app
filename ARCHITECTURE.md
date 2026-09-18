# Architecture

Pie Timers is the first of a planned series of low-cognition apps under the
AibhlínnAI name. This document exists so that decision stays real rather than
aspirational — the five things below are the ones later work (a second app,
a contributor, future-you six months from now) is most likely to either
forget or accidentally undo.

**Pie Timers ships as two products at once, not one or the other:**

- **A web app** at `pietimers.aibhlinn.ai` (GitHub Pages), with accounts
  and sync on Supabase and web subscriptions billed through Paddle.
- **An Android app** on Google Play, currently in **closed testing** in
  Play Console — a Trusted Web Activity wrapper over the same site (see
  `assetlinks.json` and `DEPLOY.md` §9). Section 5 below exists because of
  this second product.

Everything here is static HTML/CSS/JS with no build step and no npm
dependency, deployed as-is to GitHub Pages. The file the browser runs is the
file a person can read — see `app/README.md` for why that constraint exists
and what the constraint costs.

## 1. Shared identity layer

One AibhlínnAI account is meant to authenticate a person across every app in
the suite, not just this one. That lives in `identity/`, a sibling of `app/`
rather than a subdirectory — deliberately, so "not inside the Pie Timers
codebase" is a fact about the file tree, not just a comment.

- `identity/identity.js` — sign-in, session, sign-out. Knows nothing about
  Pie Timers, Pomodoro, or any other product name.
- `identity/entitlements.js` — capability checks (`can_sync`,
  `can_use_calendar`), never a plan name.
- `identity/identity-ui.js` / `identity-ui.css` — the sign-in button and
  panel, styled from the host app's own CSS variables rather than carrying
  a separate palette.
- `identity/test-second-app.html` — a throwaway page that authenticates and
  checks a capability using only the two files above. If a future change
  breaks this page, the separation has leaked back into Pie Timers-specific
  assumptions.

Full interface documentation: `identity/README.md`.

**What isn't solved yet:** two subdomains (`pietimers.aibhlinn.ai`, a future
`pomodoro.aibhlinn.ai`) share the same *account* the moment both import
`identity.js`, but not yet a shared *signed-in session* — sessions live in
`localStorage`, which is scoped per origin. True cross-subdomain SSO needs a
deliberate choice (a shared cookie domain, or a small auth-broker page apps
redirect through) before a second app ships. Documented as an open decision
in `identity/README.md`, not picked silently.

## 2. Suite-wide entitlements

`supabase/identity-schema.sql` defines an `identity` Postgres schema,
separate from Pie Timers' own `public` tables:

- `identity.product_entitlements` — one row per (account, product,
  capability, source, expiry). `source` distinguishes a subscription from a
  friends-and-family pass from a complimentary grant, but every source
  satisfies the same capability check identically.
- `identity.subscriptions` — one row per paid subscription, at the account
  level. A future suite bundle — one subscription unlocking several apps —
  is several rows in `product_entitlements` against one row here, not a
  schema change.
- `identity.grant_capability(...)` — the only way anything gets written.
  `security definer`, revoked from every client-facing role; only
  service-role code, such as an edge function, can call that function.

**What isn't migrated yet, and why that's deliberate:** the in-app gating
(sync, background push) still reads `public.subscriptions` /
`public.my_entitlement` (`supabase/schema-billing.sql`), the mechanism that
predates the identity schema. Moving the in-app gating onto the identity
schema, so `public.subscriptions` stops being that gate's source of truth,
is real surgery on live, working code and stays its own reviewed task.

**Self-certified hardship is gone, on purpose.** An earlier
`schema-hardship.sql` let anyone grant themselves access by asserting need.
The free tier does that job now: every feature that works on one device
works without paying, for anyone, forever, and A$2.90 buys only sync,
calendar and background alerts. `supabase/drop-hardship.sql` removes the old
`grant_hardship_access()` function and is safe to run against a project that
never had one. Capabilities already granted that way are left alone
deliberately — taking access back from someone who asked for help is not a
migration step. Anyone who still cannot pay gets a complimentary grant, a
one-line insert at the bottom of `schema-billing.sql`, offered freely.

`paddle-webhook` writes **both**: `public.subscriptions` stays the
authoritative record, and — after that write succeeds —
`mirrorToIdentitySchema()` grants `can_sync`, `can_use_calendar` and
`can_use_screensaver` in the identity schema too, time-bounded to the
subscription's own `current_period_end` rather than granted forever. That
expiry, not an explicit revoke call, is what stops access surviving a
cancellation: nothing re-grants once a subscription stops being active, so
the last grant simply lapses on schedule. The Windows screen saver
(`windows-screensaver/gate.html`) is the first surface that reads *only* the
identity schema for gating, with no `public.subscriptions` fallback, which
is exactly why that mirror write has to actually work.

That requirement caught a real bug: `paddle-webhook` used to log an event id
*before* processing the event, as a combined claim-and-audit write. A failure
partway through — the subscriptions upsert, or this mirror — left the event
already logged, so Paddle's retry saw a duplicate and never redid the part
that failed. Fixed by splitting that into a read-only duplicate check up
front and a record-as-processed write at the very end, only once every write
the event triggers has actually succeeded. If this function is ever touched
again, keep that order — recording the event id anywhere before the work is
done quietly brings the bug back.

## 3. No ads, no tracking — permanent, not a preference

No advertising SDK, no third-party analytics, no tracking pixel, no data sale
or sharing for marketing, ever. This came from direct feedback from the
people this app is built for, not a generic privacy stance — see
`countdown-timers-commercial-goals` in project memory for the origin.

If first-party analytics are ever added, they must be aggregate,
non-identifying, and disclosed in `privacy.html` before shipping — not
after.

**Enforced, not just stated:** `.github/workflows/deploy.yml` has a build
step, "Refuse to publish ad or tracking dependencies", that greps `app/` and
`identity/` for the domains and script globals of known ad/tracking vendors
(Google Analytics/Tag Manager, Meta Pixel, Mixpanel, Segment, Hotjar,
Amplitude, Sentry, and others) and fails the deploy if any appear. The check
cannot catch a vendor nobody has named, so the check is no substitute for
reading a diff before merging one — but a dependency added without anyone
noticing what arrived does fail loudly instead of quietly shipping.

The commitment is also stated in the app, in the footer of every page:
*"No ads. No tracking. No selling your data. Ever."* — not buried in the
privacy policy alone.

## 4. Every byte comes from our own origin

The app makes no third-party request at all, and that is a consequence of
section 3 rather than a separate rule. Two things follow, and both are easy
to undo by accident:

- **The typeface is self-hosted.** `app/fonts/` carries Instrument Sans as
  two woff2 files (one variable face per subset, covering weights 400–700)
  under the SIL Open Font License, with `OFL.txt` shipped alongside as the
  licence requires. Loading the same face from Google's CDN would be one
  line shorter and is the obvious "simplification" for a future reader — so
  here is why not: a CDN font is a third-party request on every page load,
  fails to resolve with the network off, and reads badly beside the footer
  promise on the same page. Both files are precached in `sw.js`.
- **No CDN, no npm, no build step.** Nothing arrives at a browser that is
  not in this repository.

Aptos remains the first fallback in the stack, but Aptos ships only with
Microsoft 365 and recent Windows — never on Android, iOS or Mac. Self-hosting
therefore made typography *more* consistent, not less.

## 5. Google Play anti-steering

The Android app on Google Play is a Trusted Web Activity over this same site
(see `DEPLOY.md` §9), and Play's Payments policy prohibits steering a Play
user to pay outside Play Billing. So the Play app is consumption-only.
Someone who subscribed on the web keeps their features there, but it shows
no prices, no checkout, no customer portal and no link to any of them.

The site tells the Play app apart by its referrer,
`android-app://ai.aibhlinn.pietimers`, which the wrapper sends on the launch
page only. `app/app.js` remembers it for the visit in sessionStorage
(`countdown-timers/play-app`) as `IN_PLAY_APP`, and exposes it as
`CT.inPlayApp`. Gated on it: the upgrade panel with its prices and code
fields, both Premium Feature buttons, the header plan chip's trial and offer
states, the Manage button, the welcome panel's "needs no card", the footer
Pricing and Refund Policy links, and the Android tester invite. The Settings
row that leads to Account drops Premium and cancelling from its line. The one
line left is "Some features need an AibhlínnAI Premium subscription." As a
backstop, `billing.js` refuses to open checkout or the portal there.
`pricing.html` and `foundation.html` send a Play visit back to the app, and
`privacy.html` and `terms.html` hide their links to pricing and refunds, each
reading the same sessionStorage key.

Only the referrer counts, never display mode (`inAppWindow()`). An installed
web app or an iPhone home screen icon is still the web, and keeps its prices.

Offers are gated out rather than reworded on purpose. Editing copy per
context is how this constraint quietly breaks six months later, when someone
changes the wording without knowing why the wording was chosen.
