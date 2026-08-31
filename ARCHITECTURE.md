# Architecture

Pie Timers is the first of a planned series of low-cognition apps under the
AibhlínnAI name. This document exists so that decision stays real rather than
aspirational — the four things below are the ones later work (a second app,
a contributor, future-you six months from now) is most likely to either
forget or accidentally undo.

Everything here is static HTML/CSS/JS with no build step and no npm
dependency, deployed as-is to GitHub Pages. The file the browser runs is the
file a person can read — see `app/README.md` for why that constraint exists
and what it costs.

## 1. Shared identity layer

One AibhlínnAI account is meant to authenticate a person across every app in
the suite, not just this one. That lives in `identity/`, a sibling of `app/`
rather than a subdirectory of it — deliberately, so "not inside the Pie
Timers codebase" is a fact about the file tree, not just a comment.

- `identity/identity.js` — sign-in, session, sign-out. Knows nothing about
  Pie Timers, Pomodoro, or any other product name.
- `identity/entitlements.js` — capability checks (`can_sync`,
  `can_use_calendar`), never a plan name.
- `identity/identity-ui.js` / `identity-ui.css` — the sign-in button and
  panel, styled from the host app's own CSS variables rather than carrying
  its own palette.
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
  hardship grant from a friends-and-family pass, but every source satisfies
  the same capability check identically.
- `identity.subscriptions` — one row per paid subscription, at the account
  level. A future suite bundle — one subscription unlocking several apps —
  is several rows in `product_entitlements` against one row here, not a
  schema change.
- `identity.grant_capability(...)` — the only way anything gets written.
  `security definer`, revoked from every client-facing role; only
  service-role code (an edge function, or a `security definer` function like
  `grant_hardship_access`) can call it.

**What isn't migrated yet, and why that's deliberate:** the in-app gating
(sync, background push) still reads `public.subscriptions` /
`public.my_entitlement` (`supabase/schema-billing.sql`), the mechanism that
predates the identity schema. `supabase/schema-hardship.sql` dual-writes: it
grants through `public.subscriptions.complimentary` so access takes effect in
the app *today*, and calls `identity.grant_capability` so a future suite app
sees the same grant without any Pie Timers-specific knowledge. Moving the
in-app gating itself onto the identity schema, so `public.subscriptions`
stops being that gate's source of truth, is real surgery on live, working
code and stays its own reviewed task.

`paddle-webhook` now writes **both**: `public.subscriptions` stays the
authoritative record it always was, and — after that succeeds —
`mirrorToIdentitySchema()` grants `can_sync`, `can_use_calendar` and
`can_use_screensaver` in the identity schema too, time-bounded to the
subscription's own `current_period_end` rather than granted forever. That
expiry, not an explicit revoke call, is what stops access surviving a
cancellation: nothing re-grants once a subscription stops being active, so
the last grant simply lapses on schedule. The Windows screen saver
(`windows-screensaver/gate.html`) is the first surface that reads *only* the
identity schema for its gating — it has no `public.subscriptions` fallback,
which is exactly why that mirror write has to actually work.

## 3. No ads, no tracking — permanent, not a preference

No advertising SDK, no third-party analytics, no tracking pixel, no data sale
or sharing for marketing, ever. This came from direct feedback from the
people this app is built for, not a generic privacy stance — see
`countdown-timers-commercial-goals` in project memory for the origin.

If first-party analytics are ever added, they must be aggregate,
non-identifying, and disclosed in `privacy.html` before they ship — not
after.

**Enforced, not just stated:** `.github/workflows/deploy.yml` has a build
step, "Refuse to publish ad or tracking dependencies", that greps `app/` and
`identity/` for the domains and script globals of known ad/tracking vendors
(Google Analytics/Tag Manager, Meta Pixel, Mixpanel, Segment, Hotjar,
Amplitude, Sentry, and others) and fails the deploy if any appear. It cannot
catch a vendor it doesn't know about, so it isn't a substitute for reading a
diff before merging it — but it does mean a dependency added without anyone
noticing what it was fails loudly instead of quietly shipping.

The commitment is also stated in the app itself, in the footer of every
page: *"No ads. No tracking. No selling your data. Ever."* — not buried in
the privacy policy alone.

## 4. Google Play anti-steering

Nothing in the app links to, mentions, or hints at web/Paddle pricing —
`app/billing.js`, the comment above `initPaddle()`. This matters specifically
because if Pie Timers is ever wrapped for Google Play (a Trusted Web Activity
over this same site — see `DEPLOY.md` §9 for what that actually requires),
Play's policy on external purchase links prohibits steering a Play user to
pay outside Play Billing. The annual-only offer stays exclusive to the normal
web context.

If a Play-specific build variant is ever introduced, the upgrade panel should
be gated out of that variant entirely rather than having its copy edited —
editing copy per-build is how this constraint quietly breaks six months
later when someone changes the wording without knowing why it was worded
that way.
