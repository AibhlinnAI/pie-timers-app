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
