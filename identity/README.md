# AibhlínnAI shared identity & entitlements

One account authenticates a person across every AibhlínnAI app. This folder
is that layer. It is a sibling of `app/` (Pie Timers) and `supabase/`
(database), not a subdirectory of either — a second app is expected to
depend on this folder and nothing inside `app/`.

## Files

| File | Knows about | Depends on |
| --- | --- | --- |
| `identity.js` | Signing in, holding a session, signing out | Supabase Auth (GoTrue) only |
| `entitlements.js` | Whether an account can do X in product Y | `identity.js` for a session |
| `identity-ui.js` | A sign-in button + anchored panel | `identity.js` only |
| `identity-ui.css` | How that button/panel look | Host app's own `--ink`/`--card`/`--line`/`--accent` variables |

None of the four files hardcode `pie-timers`, `countdown`, or any other
product name in executable logic — the string appears only in comments and
doc examples, illustrating how a caller would use it. The one place it's
allowed to exist as an actual value is a product's own bridge file — see
`app/identity-bridge.js` for Pie Timers'.

## Public interface

```js
// identity.js
Aibhlinn.identity.init({ supabaseUrl, supabaseAnonKey, redirectUrl? })
Aibhlinn.identity.signInWithEmail(email)
Aibhlinn.identity.signInWithGoogle()
Aibhlinn.identity.signOut()
Aibhlinn.identity.deleteAccount(functionUrl)
Aibhlinn.identity.getSession()
Aibhlinn.identity.getUser()
Aibhlinn.identity.isSignedIn()
Aibhlinn.identity.validToken()          // Promise<string|null>
Aibhlinn.identity.onChange(fn)          // fn(session|null); returns an unsubscribe function

// entitlements.js
Aibhlinn.entitlements.init({ supabaseUrl, supabaseAnonKey })
Aibhlinn.entitlements.hasCapability(productId, capability)  // Promise<boolean>
Aibhlinn.entitlements.listCapabilities(productId)           // Promise<string[]>
Aibhlinn.entitlements.refresh()         // force-refetch after a checkout/grant

// identity-ui.js
Aibhlinn.identityUI.mount({
  target, openLabel, openHref, productName, showSuiteContext
})
```

A product never imports Pie Timers' code to use any of the above — that is
the whole point of this folder existing outside `app/`.

## The isolation test

`test-second-app.html` in this folder is a throwaway page that authenticates
and checks a capability using only `identity.js` and `entitlements.js` —
zero references to anything Pie-Timers-named. If a change to this folder
breaks that page, the separation has leaked.

## What this layer does NOT do

- **It does not decide what a session unlocks beyond capabilities.** A
  product asks `hasCapability('pie-timers', 'can_sync')`; it never asks
  "what plan is this account on". See `supabase/identity-schema.sql` for
  why that distinction is structural, not just a naming convention.
- **It does not request product-specific OAuth scope.** Pie Timers' Google
  Calendar access is requested by Pie Timers' own code
  (`app/supabase.js: connectGoogleCalendar`), using this module only to
  reach an already-signed-in session's token. A future app asking for its
  own extra scope does the same, independently.
- **It does not give two subdomains a shared signed-in session for free.**
  Sessions live in `localStorage`, which is scoped per origin.
  `pietimers.aibhlinn.ai` and a future `pomodoro.aibhlinn.ai` share the
  same *account* (same email, same `auth.users` row, same entitlements)
  but today each needs its own sign-in. True zero-click SSO across
  subdomains needs one of:
  - a shared cookie domain (`.aibhlinn.ai`), which means moving off the
    current localStorage-based session storage, or
  - a small `accounts.aibhlinn.ai` broker page apps redirect through and
    back, similar to a lightweight OAuth flow.

  This is a real decision with real trade-offs (cookie approach is
  simpler but ties every future app to the same top-level domain forever;
  a broker page is more flexible but is another moving part to build and
  keep working). Deliberately left open rather than picked silently —
  worth its own short conversation before the second app needs it.

## Deploying this folder

`identity/` is checked out at the repo root. The Pages workflow
(`.github/workflows/deploy.yml`) copies it into the published site
alongside `app/`'s own files at build time, so `app/index.html` can request
`identity/identity.js` as a normal relative path. If this folder is ever
split into its own repository (the natural move once a second app exists),
that copy step becomes a package install instead — nothing in the module
itself needs to change.
