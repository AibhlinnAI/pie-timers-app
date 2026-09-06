/* ============================================================
   Pie Timers' own glue for the shared identity/entitlements modules.

   This file is the ONLY place in Pie Timers that says "pie-timers" as
   a product string. Everything upstream of it (identity/*.js) has no
   idea what app is calling it; everything downstream of it (the rest
   of app.js) never sees a product string at all — it asks
   hasCapability('can_sync') via CT.entitlements, a thin product-scoped
   wrapper defined below.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};
  var cfg = CT.config;
  var PRODUCT_ID = 'pie-timers';

  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return; // no account features configured

  /* Poll rather than use a callback: CT.turnstile owns the widget's
     callbacks already, and token() is the single place that knows
     whether one has arrived. */
  function waitForToken(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function poll() {
        var token = CT.turnstile.token();
        if (token || Date.now() > deadline) return resolve(token || '');
        setTimeout(poll, 200);
      }());
    });
  }

  window.Aibhlinn.identity.init({
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey,
    redirectUrl: cfg.redirectUrl || null,

    /* ── One protected sign-in path ──────────────────────────────
       identity's own signInWithEmail posts straight to Supabase's
       /auth/v1/otp, which has nowhere to put a bot check or a
       throttle. Pie Timers has both, in the `signin` edge function:
       Turnstile, then per-email and per-IP limits in Postgres, then
       Supabase's own limits behind that. Until this delegate existed
       the header panel bypassed all three while the Account tab's
       form used them -- two sign-in routes, one of them an open relay
       for emailing strangers at the expense of our sending quota and
       the domain's reputation.

       prepareSignIn draws the check when the panel opens, so the
       person is not left waiting on a widget after they have already
       pressed the button. CT.turnstile lives in billing.js, which
       loads after this file, so both hooks resolve it lazily at call
       time rather than capturing it here. */
    prepareSignIn: function (challengeHost) {
      if (!cfg.turnstileEnabled || !CT.turnstile) return Promise.resolve(false);
      return CT.turnstile.mount(challengeHost);
    },

    signIn: function (email, ctx) {
      if (!cfg.turnstileEnabled || !CT.turnstile) return CT.auth.signInWithEmail(email, '');

      return CT.turnstile.mount(ctx && ctx.challengeHost).then(function () {
        /* The widget is drawn when the panel opens, but a token only
           arrives once Cloudflare finishes -- and someone typing an
           email address fast can beat it. Wait a few seconds rather
           than standing aside the moment it is not ready, so the
           checked path is the normal one and not a race. */
        return waitForToken(6000);
      }).then(function (token) {
        if (token) {
          return CT.auth.signInWithEmail(email, token).then(function (result) {
            CT.turnstile.reset();   // tokens are single-use
            return result;
          });
        }

        /* Still nothing. Fall through to identity's own path rather
           than refusing: a bot check that will not complete must not
           become a sign-in nobody can complete. That request is
           unchecked -- the state the app was in before this delegate
           existed -- so it is not a new hole, but it is not where this
           ends either. Loud on purpose: silence is how the unchecked
           path survived unnoticed in the first place. */
        console.warn('Turnstile produced no token in time; signing in without ' +
                     'the bot check. See identity-bridge.js.');
        return null;   // null tells identity to use its own path
      });
    }
  });

  window.Aibhlinn.entitlements.init({
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey
  });

  // Pie Timers-scoped entitlement checks, so the rest of the app never
  // has to know the product id or import the suite module directly.
  CT.entitlements = {
    hasCapability: function (capability) {
      return window.Aibhlinn.entitlements.hasCapability(PRODUCT_ID, capability);
    },
    refresh: function () { return window.Aibhlinn.entitlements.refresh(); }
  };


  /* ── Session bridge ──────────────────────────────────────────────
     Both this file's identity module and CT.auth (supabase.js) keep
     their own session under their own localStorage key, and BOTH parse
     the magic-link `#access_token=` out of the URL and then strip it.
     identity-bridge.js is loaded before supabase.js, so identity always
     wins the race: it adopts the token, cleans the hash, and CT.auth
     finds nothing left to read.

     The result was a user who is genuinely signed in -- Supabase logs
     the sign-in, the identity UI shows the account -- while CT.auth
     reports signed out. openCheckout() then rejects every purchase with
     "Please sign in first", and sync, calendar and background alerts
     stay dark, because those all gate on CT.auth.isSignedIn().

     So: hand identity's session to CT.auth, now and whenever it
     changes. Deliberately one-directional. identity is the layer that
     wins the hash, so it is the source of truth; making CT.auth push
     back would reintroduce the same race in the other direction.

     This is glue, not the fix. The real fix is CT.auth becoming a
     facade over Aibhlinn.identity so there is one session and one
     store -- the migration identity-schema.sql's header already calls
     a deliberate follow-up. */
  function syncSessionToCTAuth() {
    if (!CT.auth || typeof CT.auth.adoptSession !== 'function') return;
    CT.auth.adoptSession(window.Aibhlinn.identity.getSession());
  }

  syncSessionToCTAuth();
  window.Aibhlinn.identity.onChange(syncSessionToCTAuth);

  /* supabase.js loads after this file, so CT.auth may not exist yet on
     first run. Catch it once the document is ready, by which point
     every script tag has executed. */
  document.addEventListener('DOMContentLoaded', syncSessionToCTAuth);

  document.addEventListener('DOMContentLoaded', function () {
    var header = document.getElementById('topbarSignin');
    if (header) {
      window.Aibhlinn.identityUI.mount({
        target: header,
        openLabel: 'Open Pie Timers',
        openHref: 'index.html',
        productName: 'Pie Timers',
        showSuiteContext: true
      });
    }

    var secondary = document.getElementById('upgradeSignin');
    if (secondary) {
      window.Aibhlinn.identityUI.mount({
        target: secondary,
        openLabel: 'Open Pie Timers',
        openHref: 'index.html',
        productName: 'Pie Timers',
        showSuiteContext: false // already said once, in the header
      });
    }
  });
})();
