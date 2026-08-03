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

Run the SQL from `supabase/`, in this order:

1. `schema.sql`
2. `schema-billing.sql`
3. `schema-access-codes.sql`
4. `schema-ratelimit.sql`
5. `schema-calendar.sql`
6. `schema-google-calendar.sql`
7. `cron.sql`

Deploy the six edge functions, then set **Authentication → URL Configuration**:

- Site URL: `https://pietimers.aibhlinn.ai`
- Redirect URLs: `https://pietimers.aibhlinn.ai/**`

Sign-in links silently fail to return if this does not match. It is the most
common cause of "the email arrived but clicking it does nothing".

Put the project URL and the **anon** key into `app/config.js`, push, and rerun
diagnostics. Every table and function should now report PASS.

## 6. Email (Resend)

Add `aibhlinn.ai` to Resend and set the SPF, DKIM and DMARC records it gives
you. Then point Supabase → Authentication → SMTP at Resend.

Send yourself a real sign-in link before going further. A brand-new domain with
no authentication records lands in spam, and from the customer's side that is
indistinguishable from the app being broken.

## 7. Push notifications

Generate a VAPID key pair. The **public** half goes in `config.js`; the private
half goes in Supabase secrets and nowhere else.

Diagnostics verifies the public key decodes to a real 65-byte P-256 point,
which catches the common mistake of pasting the private one.

## 8. Paddle

Paddle will ask for your terms and privacy URLs during seller verification:

- https://pietimers.aibhlinn.ai/terms.html
- https://pietimers.aibhlinn.ai/privacy.html

Both are already linked from the footer of every page, which is what they check
for.

Set the webhook to your `paddle-webhook` function URL, put the secret in
Supabase, and send a test event from **Paddle → Notifications**. Then confirm an
`entitlements` row appears. Diagnostics cannot check this for you — it is
server to server — so it is the one you must watch happen.

**Before switching `environment` to `'production'`:** make sure the client
token starts with `live_`. A `test_` token with `environment: 'production'`, or
the reverse, produces a checkout that opens and then fails at payment.
Diagnostics checks this pairing.

---

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
