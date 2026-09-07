/* ============================================================
   Minimal Supabase client — auth (GoTrue) + data (PostgREST).
   Written against the HTTP API directly so the app keeps its
   "no build step, no dependencies" property.
   Exposes window.CT.auth and window.CT.db.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};
  var cfg = CT.config;

  /* No session state, no refresh timer, no listener list, no localStorage
     key. Aibhlinn.identity holds all of it -- see the note above the
     facade below for why this module stopped keeping its own copy. */

  /* ─────────────────────────── Utilities ─────────────────────────── */

  function authUrl(path) { return cfg.supabaseUrl + '/auth/v1' + path; }
  function restUrl(path) { return cfg.supabaseUrl + '/rest/v1' + path; }

  function redirectTarget() {
    if (cfg.redirectUrl) return cfg.redirectUrl;
    return location.origin + location.pathname;
  }

  /* Surface a useful message rather than "[object Object]". */
  function describeError(payload, status) {
    if (!payload) return 'Request failed (' + status + ').';
    return payload.error_description ||
           payload.msg ||
           payload.message ||
           payload.error ||
           ('Request failed (' + status + ').');
  }

  function request(url, options) {
    return fetch(url, options).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var body = null;
        if (text) {
          try { body = JSON.parse(text); } catch (e) { body = { message: text }; }
        }
        if (!res.ok) {
          var err = new Error(describeError(body, res.status));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  /* ─────────────────────────── Session ───────────────────────────
     There is no session here any more. Aibhlinn.identity owns it: one
     store, one refresh timer, one place the magic-link hash is read.

     This module used to keep its own, under its own localStorage key,
     with its own refresh timer and its own hash parsing -- and because
     identity-bridge.js loads first, identity always won the race for
     the hash and this copy stayed empty. A signed-in person therefore
     looked signed out to everything gated on CT.auth: sync, calendar,
     background alerts, and checkout, which rejected every purchase with
     "Please sign in first".

     Bridging the two sessions fixed that and immediately produced two
     more faults -- both modules refreshing the same rotating refresh
     token, and a listener that stored the session it was listening to.
     Neither was a coincidence: two owners of one thing is the fault,
     and copying between them is not a cure. So CT.auth is now a facade.

     What stays here is what is genuinely Pie Timers': the bot-checked
     sign-in route, and the calendar-scope Google round trip. */
  function id() {
    return (window.Aibhlinn && window.Aibhlinn.identity) || null;
  }

  function validToken() {
    var i = id();
    return i ? i.validToken() : Promise.resolve(null);
  }

  /* ─────────────────────────── Public auth API ─────────────────────────── */

  var auth = {
    /* Email magic link — no password is ever collected or stored.

       Routed through the `signin` edge function whenever Turnstile is
       configured, because that is the only place a bot check and a
       throttle can sit. Without it the form would email any address
       given to it, as often as asked. This is the one auth call that
       does NOT go to identity: identity posts straight to Supabase,
       which is exactly what this exists to avoid. */
    signInWithEmail: function (email, turnstileToken) {
      if (cfg.turnstileEnabled) {
        return request(cfg.supabaseUrl + '/functions/v1/signin', {
          method: 'POST',
          headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email,
            turnstileToken: turnstileToken || '',
            redirectTo: redirectTarget()
          })
        });
      }

      return request(authUrl('/otp'), {
        method: 'POST',
        headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          create_user: true,
          options: { email_redirect_to: redirectTarget() }
        })
      });
    },

    signInWithGoogle: function () {
      var i = id();
      if (i) i.signInWithGoogle();
    },

    /* Re-authorise with Google, additionally asking for read-only calendar
       access. access_type=offline is what yields a refresh token, and
       prompt=consent forces Google to re-issue one even if the user has
       approved before — without it a reconnect silently returns nothing.
       Stays here rather than in identity: identity deliberately asks for
       nothing beyond identifying the person, and a product wanting more
       does that itself, afterwards. */
    connectGoogleCalendar: function () {
      var scopes = 'email profile https://www.googleapis.com/auth/calendar.readonly';
      var url = authUrl('/authorize') +
        '?provider=google' +
        '&scopes=' + encodeURIComponent(scopes) +
        '&access_type=offline' +
        '&prompt=consent' +
        '&redirect_to=' + encodeURIComponent(redirectTarget() + '#calendar-connected');
      try { sessionStorage.setItem('countdown-timers/connecting-google', '1'); } catch (e) { /* fine */ }
      location.assign(url);
    },

    wasConnectingGoogle: function () {
      try {
        var flag = sessionStorage.getItem('countdown-timers/connecting-google');
        sessionStorage.removeItem('countdown-timers/connecting-google');
        return flag === '1';
      } catch (e) {
        return false;
      }
    },

    signOut: function () {
      var i = id();
      return i ? i.signOut() : Promise.resolve();
    },

    loadUser: function () {
      var i = id();
      return i ? i.loadUser() : Promise.resolve(null);
    },

    /* Permanently delete the signed-in user and everything they own.
       The heavy lifting is server-side; this only names the function to
       call, since identity has no idea which product is asking. */
    deleteAccount: function () {
      var i = id();
      if (!i) return Promise.reject(new Error('Not signed in.'));
      return i.deleteAccount(cfg.supabaseUrl + '/functions/v1/delete-account');
    },

    /* identity.init() consumes the magic-link hash before this file is
       loaded, and the bridge keeps what it returned. Reading it here is
       what lets sync.js surface a redirect error without knowing any of
       that happened. Consumed once, like the hash it came from. */
    consumeRedirect: function () {
      var pending = CT.pendingIdentityRedirect || null;
      CT.pendingIdentityRedirect = null;
      return pending;
    },

    getSession: function () { var i = id(); return i ? i.getSession() : null; },
    getUser: function () { var i = id(); return i ? i.getUser() : null; },
    isSignedIn: function () { var i = id(); return Boolean(i && i.isSignedIn()); },
    validToken: validToken,

    onChange: function (fn) {
      var i = id();
      return i ? i.onChange(fn) : function () {};
    }
  };

  /* ─────────────────────────── Public data API ─────────────────────────── */

  function authedFetch(path, options) {
    return validToken().then(function (token) {
      if (!token) throw new Error('Not signed in.');
      var opts = options || {};
      var headers = Object.assign({
        apikey: cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      }, opts.headers || {});
      return request(restUrl(path), Object.assign({}, opts, { headers: headers }));
    });
  }

  var db = {
    /* Read this user's row. Returns null when they have never synced. */
    getProfile: function () {
      return authedFetch('/timer_profiles?select=*&limit=1')
        .then(function (rows) { return rows && rows.length ? rows[0] : null; });
    },

    /* Insert-or-update this user's row. RLS pins it to their own user_id. */
    saveProfile: function (payload) {
      var user = auth.getUser();
      if (!user) return Promise.reject(new Error('Not signed in.'));
      var row = Object.assign({ user_id: user.id }, payload);
      return authedFetch('/timer_profiles', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(row)
      }).then(function (rows) { return rows && rows.length ? rows[0] : null; });
    },

    /* Register a Web Push endpoint so the server can reach this device. */
    savePushSubscription: function (subscription, timezone) {
      var user = auth.getUser();
      if (!user) return Promise.reject(new Error('Not signed in.'));
      return authedFetch('/push_subscriptions?on_conflict=endpoint', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({
          user_id: user.id,
          endpoint: subscription.endpoint,
          keys: subscription.keys,
          timezone: timezone,
          updated_at: new Date().toISOString()
        })
      });
    },

    /* Read this user's entitlement. The view already filters to auth.uid(),
       and the client can only read it — every write comes from the Paddle
       webhook, so an account cannot grant itself access. */
    getEntitlement: function () {
      if (!CT.config.billingEnabled) {
        // No billing configured: treat every signed-in account as entitled.
        return Promise.resolve({ entitled: true, plan: null, status: 'unbilled' });
      }
      return authedFetch('/my_entitlement?select=*&limit=1')
        .then(function (rows) {
          if (rows && rows.length) return rows[0];
          return { entitled: false, plan: null, status: 'none' };
        })
        .catch(function () {
          // Never lock someone out of their own data because a lookup failed.
          return { entitled: true, plan: null, status: 'unknown' };
        });
    },

    /* ── Calendar feeds ──
       Reads go through my_calendar_feeds, a view that deliberately omits
       feed_url. That URL is a bearer secret for the whole calendar, so it
       is write-only from the browser's point of view: sent once on save,
       never returned. */
    listCalendarFeeds: function () {
      return authedFetch('/my_calendar_feeds?select=*&order=created_at');
    },

    addCalendarFeed: function (label, url) {
      var user = auth.getUser();
      if (!user) return Promise.reject(new Error('Not signed in.'));
      return authedFetch('/calendar_feeds', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: user.id,
          label: label || 'My calendar',
          feed_url: url
        })
      }).then(function (rows) { return rows && rows.length ? rows[0] : null; });
    },

    removeCalendarFeed: function (id) {
      return authedFetch('/calendar_feeds?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE'
      });
    },

    /* Ask the server to re-fetch and re-expand a feed now. */
    syncCalendarFeed: function (id) {
      return validToken().then(function (token) {
        if (!token) throw new Error('Not signed in.');
        return request(cfg.supabaseUrl + '/functions/v1/calendar-sync', {
          method: 'POST',
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ feedId: id })
        });
      });
    },

    /* Redeem a personal access code. All the checks — binding, single use,
       throttling — happen inside the database function. */
    redeemAccessCode: function (code) {
      return authedFetch('/rpc/redeem_access_code', {
        method: 'POST',
        body: JSON.stringify({ p_code: code })
      });
    },
    /* Hand Google's refresh token to the server. It is never kept here. */
    connectGoogle: function (refreshToken, email) {
      return validToken().then(function (token) {
        if (!token) throw new Error('Not signed in.');
        return request(cfg.supabaseUrl + '/functions/v1/google-connect', {
          method: 'POST',
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'connect',
            refreshToken: refreshToken,
            email: email || null
          })
        });
      });
    },

    /* Revokes at Google as well as deleting locally. */
    disconnectGoogle: function () {
      return validToken().then(function (token) {
        if (!token) throw new Error('Not signed in.');
        return request(cfg.supabaseUrl + '/functions/v1/google-connect', {
          method: 'POST',
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ action: 'disconnect' })
        });
      });
    },

    /* Occurrences the server has already expanded — no iCalendar here. */
    listCalendarEvents: function () {
      var from = new Date(Date.now() - 3600000).toISOString();
      return authedFetch(
        '/calendar_events?select=uid,title,starts_at,ends_at,all_day,location' +
        '&starts_at=gte.' + from + '&order=starts_at&limit=200'
      );
    },

    removePushSubscription: function (endpoint) {
      return authedFetch('/push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint), {
        method: 'DELETE'
      });
    }
  };

  /* No boot step. There is nothing to load and no timer to schedule --
     identity did both before this file was parsed. */


  CT.auth = auth;
  CT.db = db;
})();
