/* ============================================================
   AibhlínnAI shared entitlements module.

   Answers exactly one question: can this account do X in product Y —
   never "what plan is this account on". A product asks
   hasCapability('pie-timers', 'can_sync'), gets true or false, and
   never learns or cares whether that came from a subscription, a
   hardship grant, or a friends-and-family pass. That distinction is
   deliberate: it is what lets a hardship grant, a suite bundle, and a
   single-app subscription all satisfy the same check with no branching
   in product code.

   Depends on identity.js for a session, and on the `identity` schema
   (supabase/identity-schema.sql) being applied and exposed via
   PostgREST. Requires Aibhlinn.identity.init() to have been called
   first.

   Usage:
     Aibhlinn.entitlements.init({ supabaseUrl, supabaseAnonKey });
     Aibhlinn.entitlements.hasCapability('pie-timers', 'can_sync')
       .then(function (allowed) { ... });
   ============================================================ */
(function (global) {
  'use strict';

  var Aibhlinn = global.Aibhlinn = global.Aibhlinn || {};

  var cfg = null;
  var cache = null;        // list of { product_id, capability, expires_at }
  var cachedAt = 0;
  var CACHE_MS = 30 * 1000; // short — a webhook can change this mid-session

  function restUrl(path) { return cfg.supabaseUrl + '/rest/v1' + path; }

  function request(url, options) {
    return fetch(url, options).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var body = null;
        if (text) { try { body = JSON.parse(text); } catch (e) { body = { message: text }; } }
        if (!res.ok) {
          var err = new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function authedFetch(path) {
    var identity = Aibhlinn.identity;
    if (!identity) return Promise.reject(new Error('identity.js must load before entitlements.js.'));
    return identity.validToken().then(function (token) {
      if (!token) throw new Error('Not signed in.');
      return request(restUrl(path), {
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: 'Bearer ' + token,
          /* identity is a separate exposed schema from the product's
             own `public` tables — PostgREST needs telling which one. */
          'Accept-Profile': 'identity'
        }
      });
    });
  }

  function fetchEntitlements(force) {
    var identity = Aibhlinn.identity;
    if (!identity || !identity.isSignedIn()) { cache = []; return Promise.resolve(cache); }
    if (!force && cache && (Date.now() - cachedAt < CACHE_MS)) return Promise.resolve(cache);

    return authedFetch('/my_entitlements?select=*').then(function (rows) {
      cache = rows || [];
      cachedAt = Date.now();
      return cache;
    });
  }

  var entitlements = {
    init: function (config) {
      cfg = config;
      var identity = Aibhlinn.identity;
      if (identity) {
        // A sign-out or a fresh sign-in invalidates whatever was cached
        // for the previous account.
        identity.onChange(function () { cache = null; });
      }
    },

    /* The one call product code should actually use. */
    hasCapability: function (productId, capability) {
      return fetchEntitlements(false).then(function (rows) {
        return rows.some(function (row) {
          return row.product_id === productId && row.capability === capability;
        });
      }).catch(function () {
        // A lookup failure should never silently lock someone out of
        // data they already have on their own device — fail open for
        // read access, the product itself decides what that means.
        return false;
      });
    },

    /* All capabilities for one product, e.g. to render a features list. */
    listCapabilities: function (productId) {
      return fetchEntitlements(false).then(function (rows) {
        return rows.filter(function (row) { return row.product_id === productId; })
                    .map(function (row) { return row.capability; });
      });
    },

    /* Force a re-fetch — call right after a checkout completes or a
       hardship grant is submitted, rather than waiting on the cache. */
    refresh: function () {
      return fetchEntitlements(true);
    }
  };

  Aibhlinn.entitlements = entitlements;
})(window);
