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

  var SESSION_KEY = 'countdown-timers/session/v1';
  var REFRESH_MARGIN_MS = 60 * 1000; // refresh a minute before expiry

  var session = null;      // { access_token, refresh_token, expires_at, user }
  var listeners = [];
  var refreshTimer = null;
  var refreshInFlight = null;

  /* ─────────────────────────── Utilities ─────────────────────────── */

  function authUrl(path) { return cfg.supabaseUrl + '/auth/v1' + path; }
  function restUrl(path) { return cfg.supabaseUrl + '/rest/v1' + path; }

  function redirectTarget() {
    if (cfg.redirectUrl) return cfg.redirectUrl;
    return location.origin + location.pathname;
  }

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(session); } catch (e) { /* a listener must not break the chain */ }
    });
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

  /* ─────────────────────────── Session storage ─────────────────────────── */

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function storeSession(next) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private browsing — session stays in memory only */ }
    scheduleRefresh();
    emit();
  }

  function adoptTokenResponse(data) {
    if (!data || !data.access_token) throw new Error('Sign-in response was incomplete.');
    storeSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      user: data.user || (session && session.user) || null
    });
    return session;
  }

  /* ─────────────────────────── Token refresh ─────────────────────────── */

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session || !session.refresh_token) return;
    var delay = session.expires_at - Date.now() - REFRESH_MARGIN_MS;
    // setTimeout saturates past ~24.8 days; clamp well below that anyway.
    refreshTimer = setTimeout(refresh, Math.min(Math.max(delay, 0), 30 * 60 * 1000));
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.resolve(null);
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = request(authUrl('/token?grant_type=refresh_token'), {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (data) {
      refreshInFlight = null;
      return adoptTokenResponse(data);
    }).catch(function (err) {
      refreshInFlight = null;
      // A rejected refresh token means the session is genuinely dead.
      if (err.status === 400 || err.status === 401) storeSession(null);
      throw err;
    });

    return refreshInFlight;
  }

  /* Return a valid access token, refreshing first if it is about to expire. */
  function validToken() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at - Date.now() > REFRESH_MARGIN_MS) {
      return Promise.resolve(session.access_token);
    }
    return refresh().then(function (s) { return s ? s.access_token : null; });
  }

  /* ─────────────────────────── Redirect handling ─────────────────────────── */

  /* Supabase returns tokens in the URL fragment after a magic link or
     OAuth round trip. Consume them, then scrub the address bar so the
     tokens are not left sitting in history. */
  function consumeRedirect() {
    var hash = location.hash || '';
    if (hash.indexOf('access_token=') === -1 && hash.indexOf('error=') === -1) return null;

    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var clean = location.pathname + location.search;

    if (params.get('error')) {
      var message = params.get('error_description') || params.get('error');
      history.replaceState(null, '', clean);
      return { error: message.replace(/\+/g, ' ') };
    }

    try {
      adoptTokenResponse({
        access_token: params.get('access_token'),
        refresh_token: params.get('refresh_token'),
        expires_in: parseInt(params.get('expires_in'), 10) || 3600
      });
    } catch (e) {
      history.replaceState(null, '', clean);
      return { error: e.message };
    }

    /* Google's own refresh token rides along when calendar scope was
       requested. It is returned to the caller and never stored here —
       it goes straight to the server and is then forgotten. */
    var providerRefreshToken = params.get('provider_refresh_token');

    history.replaceState(null, '', clean);
    return {
      signedIn: true,
      providerRefreshToken: providerRefreshToken || null
    };
  }

  /* ─────────────────────────── Public auth API ─────────────────────────── */

  var auth = {
    /* Email magic link — no password is ever collected or stored.

       Routed through the `signin` edge function whenever Turnstile is
       configured, because that is the only place a bot check and a
       throttle can sit. Without it the form would email any address
       given to it, as often as asked. */
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

    /* Google OAuth — hands off to Supabase, which returns to redirectTarget(). */
    signInWithGoogle: function () {
      var url = authUrl('/authorize') +
        '?provider=google' +
        '&redirect_to=' + encodeURIComponent(redirectTarget());
      location.assign(url);
    },

    /* Re-authorise with Google, additionally asking for read-only calendar
       access. access_type=offline is what yields a refresh token, and
       prompt=consent forces Google to re-issue one even if the user has
       approved before — without it a reconnect silently returns nothing. */
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
      var token = session && session.access_token;
      storeSession(null);
      if (!token) return Promise.resolve();
      return request(authUrl('/logout'), {
        method: 'POST',
        headers: {
          apikey: cfg.supabaseAnonKey,
          Authorization: 'Bearer ' + token
        }
      }).catch(function () { /* local sign-out already happened */ });
    },

    /* Fetch the user record for a freshly adopted token. */
    loadUser: function () {
      return validToken().then(function (token) {
        if (!token) return null;
        return request(authUrl('/user'), {
          headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token }
        });
      }).then(function (user) {
        if (user && session) {
          session.user = user;
          storeSession(session);
        }
        return user;
      });
    },

    /* Permanently delete the signed-in user and everything they own.
       The heavy lifting is server-side; this only proves who is asking. */
    deleteAccount: function () {
      return validToken().then(function (token) {
        if (!token) throw new Error('Not signed in.');
        return request(cfg.supabaseUrl + '/functions/v1/delete-account', {
          method: 'POST',
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: '{}'
        });
      }).then(function (result) {
        storeSession(null); // the account is gone; drop the session with it
        return result;
      });
    },

    /* Adopt a session minted elsewhere -- specifically by the shared
       identity module, which parses the magic-link hash before this
       file is even loaded (see identity-bridge.js for why). Takes a
       stored session object, not a token endpoint response, so there
       is no refresh round trip. Idempotent on the access token, so the
       bridge can call it on load and on every change without churn. */
    adoptSession: function (next) {
      if (!next || !next.access_token) {
        if (session) storeSession(null);
        return null;
      }
      if (session && session.access_token === next.access_token) return session;
      storeSession({
        access_token: next.access_token,
        refresh_token: next.refresh_token,
        expires_at: next.expires_at || (Date.now() + 3600000),
        user: next.user || null
      });
      return session;
    },

    getSession: function () { return session; },
    getUser: function () { return session && session.user; },
    isSignedIn: function () { return Boolean(session && session.access_token); },
    validToken: validToken,
    consumeRedirect: consumeRedirect,

    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
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
      return authedFetch('/push_subscriptions', {
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

    /* Self-certified hardship grant. No arguments — the database
       function reads auth.uid() itself, so this can only ever grant
       the caller's own account. Safe to call more than once. */
    grantHardshipAccess: function () {
      return authedFetch('/rpc/grant_hardship_access', { method: 'POST', body: '{}' });
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

  /* ─────────────────────────── Boot ─────────────────────────── */

  if (cfg.isConfigured) {
    session = loadSession();
    scheduleRefresh();
  }

  CT.auth = auth;
  CT.db = db;
})();
