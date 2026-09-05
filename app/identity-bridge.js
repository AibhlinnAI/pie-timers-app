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

  window.Aibhlinn.identity.init({
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey,
    redirectUrl: cfg.redirectUrl || null
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
