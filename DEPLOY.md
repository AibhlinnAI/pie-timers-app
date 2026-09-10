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

| Secret | Where it belongs |
| --- | --- |
| Supabase service-role key | Supabase → Edge Functions → Secrets |
| VAPID **private** key | Supabase → Edge Functions → Secrets |
| Paddle webhook secret | Supabase → Edge Functions → Secrets |
| Paddle API key (server, `pdl_live_apikey_…`) | Supabase → Edge Functions → Secrets, as `PADDLE_API_KEY`. Unrelated to the client-side token in `config.js` — this one calls Paddle's API from `manage-subscription`, that one only opens a checkout in the browser. |
| Turnstile secret key | Supabase → Edge Functions → Secrets |
| Google client secret | Supabase → Edge Functions → Secrets |
| Resend API key | Supabase → Authentication → SMTP |

`.gitignore` covers the usual accidents, and the deploy workflow refuses to
publish if it finds a private key or a service-role JWT in `app/`. Neither is a
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

The first deploy runs automatically on push. Watch it in the **Actions** tab.

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
  You can enable the proxy later, but then Cloudflare's SSL/TLS mode must be
  Full (strict) or you get a redirect loop.

Then repo → **Settings → Pages → Custom domain** → `pietimers.aibhlinn.ai` → Save.
`app/CNAME` already contains this, so it survives every redeploy.

Wait for the DNS check to go green, then tick **Enforce HTTPS**. This can take
up to an hour while the certificate is issued. Do not skip it: without HTTPS
the service worker will not register and push notifications cannot work at all.

## 4. Check it

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
- [ ] `schema-ratelimit.sql`
- [ ] `schema-calendar.sql`
- [ ] `schema-google-calendar.sql`
- [ ] `identity-schema.sql`
- [ ] `cron.sql` — last: it schedules a job against edge functions that do
      not exist until 5.3.

### 5.2 Expose the identity schema

**Dashboard step, no SQL. Nothing that reads the identity schema works
until this is done, and the failure is silent in both directions: the
paddle-webhook mirror throws on every event and Paddle retries forever,
while the screen saver reads a permission error instead of an empty set.**

- [ ] **Project settings → Data API → Exposed schemas** → add `identity`
      alongside `public` and `graphql_public`. Save.

Verify rather than assume — this query answers all of it at once:

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
`authenticator` role, not your session. Do not read anything into it. To check
exposure from outside, request the schema over the REST API: `PGRST106 Invalid
schema` means not exposed, and a permissions error means exposed and correctly
locked down.

### 5.3 Edge functions and URL configuration

- [ ] Deploy the six edge functions.
- [ ] **Authentication → URL Configuration → Site URL**:
      `https://pietimers.aibhlinn.ai` — no trailing slash.
- [ ] **Redirect URLs**: `https://pietimers.aibhlinn.ai/**` — both asterisks.

Sign-in links silently fail to return if these do not match. It is the most
common cause of "the email arrived but clicking it does nothing".

### 5.4 Wire the app up

- [ ] Put the project URL and the **publishable** key into `app/config.js`.
- [ ] Push, then rerun diagnostics. Every table and function should PASS.

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
      it.
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

### 6.2 Point Supabase at it

- [ ] Resend → **API Keys → Create API Key**, sending permission only,
      restricted to `aibhlinn.ai`. It is shown once.
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

### 6.3 Prove it

- [ ] Request a sign-in link and confirm it arrives.
- [ ] Check spam. A brand-new sending domain has no reputation and the first
      few messages often land there.

If you sign in on an address at `aibhlinn.ai`, remember incoming mail runs
through Cloudflare Email Routing: a rule (or catch-all) must exist for that
exact address, and its destination must be verified, or the link is dropped
with no error anywhere.

### 6.4 Make the sign-in email a code, not a link

A link in the sign-in email only signs in the browser that opens it — no use to
someone whose inbox is on a phone while the app is open on a locked-down work
machine. Worse, corporate mail scanners (Safe Links, Mimecast, Proofpoint) fetch
every URL in an inbound message, which can spend a one-time link before the person
ever reads the email. So the template sends **only the code**, which is typed into
whichever device is running the app.

Supabase mints the code (`{{ .Token }}`) for the same `/auth/v1/otp` request that
would have carried a link. The default templates render the link, not the code —
you have to swap it.

- [ ] **Authentication → Emails**. In **both** the *Magic Link* template and the
      *Confirm signup* template (new accounts get the second one), remove the
      `{{ .ConfirmationURL }}` anchor and put the code in its place:

```html
<h2>Your sign-in code</h2>
<p>Enter this code to finish signing in:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:3px">{{ .Token }}</p>
<p>It expires shortly. If you didn't ask to sign in, ignore this email.</p>
```

- [ ] Do not leave a bare `{{ .ConfirmationURL }}` anywhere in the body, even as
      plain text — a scanner will still follow it and burn the code.
- [ ] Change the **Subject heading** on both templates too — it is a separate
      field above the body and the stock text says "magic link" / "confirm your
      signup". Set it to something like `Your Pie Timers sign-in code`.
- [ ] Shorten the code's lifetime at **Authentication → Providers → Email → Email
      OTP Expiration** — default is 3600s; 600s is plenty and narrows the window
      on a code read to the wrong person.
- [ ] Test across two devices: on device A request a code, read it off device B's
      inbox, type it into device A. ✅ device A lands signed in with no redirect.
      ❌ "Token has expired or is invalid" means the code expired, was already
      used, or the address on device A does not match the one it was sent to.
      ❌ a message mentioning `otp_type` / `type` means the `type: 'email'` verify
      value needs revisiting for this GoTrue version — flag it.

The **Redirect URLs** allowlist (§5.3) still matters — it is used by the Google
OAuth return — so do not remove it just because the email no longer carries a link.

## 7. Push notifications

- [ ] Generate a VAPID key pair.
- [ ] Public half → `config.js`.
- [ ] Private half → Supabase secrets, and nowhere else.

Diagnostics verifies the public key decodes to a real 65-byte P-256 point,
which catches the common mistake of pasting the private one.

## 8. Paddle

Paddle will ask for your terms and privacy URLs during seller verification:

- https://pietimers.aibhlinn.ai/terms.html
- https://pietimers.aibhlinn.ai/privacy.html

Both are already linked from the footer of every page, which is what they check
for.

### 8.1 Catalogue

- [ ] Create the product and its two prices in **Catalogue → Products**.
- [ ] Copy the two price ids into `app/config.js` → `paddle.annualPriceId` and
      `monthlyPriceId`.
- [ ] Check the base currency. `annualPrice`, `monthlyPrice`, `annualSaving`
      and `annualNote` in `config.js` are display labels only — Paddle charges
      the real localised amount. Prices are set in **AUD**, so the labels read
      `A$`. A bare `$` quotes one figure and charges another to anyone outside
      Australia.

### 8.2 Notification destination

**This is the step that entitles customers. Without it, checkout still takes
money and nobody is ever entitled — silently, with no error the customer or the
app can see. Do not skip it, and do not treat a working checkout as evidence it
is done.**

Order matters: Paddle mints the signing secret when the destination is created,
so the secret cannot be put in Supabase first.

- [ ] **Developer tools → Notifications → New destination**, in the
      **Production** environment.
- [ ] Type **Webhook**, URL = your `paddle-webhook` function URL:
      `https://<project-ref>.supabase.co/functions/v1/paddle-webhook`
- [ ] Notification version **v2**.
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
      for it to move from **Pending** to approved. Subdomains are reviewed
      individually; approving `aibhlinn.ai` does not approve this one.

Approval requires the site to link to, or contain, terms of service, privacy
notice and refund policy. All three are linked from the footer of every page —
refunds via `terms.html#refunds`. Keep it that way.

When either is missing, `POST checkout-service.paddle.com/transaction-checkout`
returns 400 with `"details": "transaction_checkout_not_enabled"`. Read that
body in the Network tab before assuming anything else is wrong; the overlay's
own message says nothing useful. The body is discarded when the overlay
closes, so read it while the error is still on screen.

### 8.4 Prove it end to end

Paddle removed per-destination test sends. **Simulations** (Developer tools →
Simulations) run in Sandbox only, so a Production destination can never be
given a synthetic event. The only way to exercise the live path is a real
purchase, refunded afterwards.

- [ ] Buy the monthly plan through your own live checkout.
- [ ] Confirm a row in `public.subscriptions` flips to `active`/`monthly`.
- [ ] Confirm a row in `public.billing_events`.
- [ ] Confirm **three** rows in `identity.product_entitlements`: `can_sync`,
      `can_use_calendar`, `can_use_screensaver`.
- [ ] Refund and cancel in Paddle.

Diagnostics cannot check any of 8.2 or 8.4 for you — it is server to server, so
it is the one you must watch happen.

Note that a fresh account is already entitled: `grant_trial` (in
`schema-access-codes.sql`) gives every new user a 60-day trial, and the upgrade
panel only reappears in the final 14 days. To reach checkout before then, call
`CT.billing.openCheckout('monthly')` from the console rather than editing data.

Reading a failure:

- **400 `transaction_checkout_not_enabled`** — see 8.3. Not your code.
- **401** — the secret in Supabase does not match the destination's. Recopy it.
- **500** — the signature passed and a write failed. Read the Supabase function
  logs, not the Paddle delivery log.
- **200 but no row** — the event carried no `custom_data.user_id`. That means
  the checkout was opened outside `billing.js`, which always attaches it.

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
   wrapper's own code is where a purchase is initiated, and it must pass
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

**Anti-steering, already true today and worth keeping true deliberately:**
nothing in the app links to Paddle, mentions a price, or references the web
checkout from inside what would become the Play-wrapped build — see the
comment above `initPaddle()` in `app/billing.js`. If a Play build variant
is ever introduced, gate the whole upgrade panel out of it rather than
editing its copy.

## Redeploying

```bash
git add . && git commit -m "What changed" && git push
```

Pages redeploys in a minute or two.

**When you change any file in `app/`, bump `CACHE` in `app/sw.js`.** Installed
copies serve the old cached shell until the version string changes, so without
the bump your fix reaches new visitors and nobody else.

## If you ever need to take it down

The terms promise **60 days' notice by email and a pro-rata refund** before
shutting the service down, and to keep the free on-device version working for
as long as reasonably possible. That is a commitment you made in writing, so
plan a wind-down around it rather than switching the repo to private.
