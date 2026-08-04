/* ============================================================
   AibhlínnAI shared identity module.

   One account authenticates a person across every AibhlínnAI app.
   This file knows nothing about Pie Timers, Pomodoro, or whatever
   comes after — it only knows about signing in, holding a session,
   and signing out. A second app copies this file unmodified.

   Written against the Supabase HTTP API directly, matching every
   other AibhlínnAI app's "no build step, no dependencies" rule —
   the file the browser runs is the file a person can read.

   Usage (each app calls init() once with its own Supabase project
   values — the identity, not the project, is what's shared):

     Aibhlinn.identity.init({
       supabaseUrl: '...',
       supabaseAnonKey: '...',
       redirectUrl: '...'          // optional, defaults to current page
     });

     Aibhlinn.identity.onChange(function (session) { ... });
     Aibhlinn.identity.signInWithEmail('me@example.com');
     Aibhlinn.identity.isSignedIn();
     Aibhlinn.identity.signOut();

   What this module deliberately does NOT do:
     - it does not know what a "product" is (see entitlements.js)
     - it does not request Google Calendar scope or any other
       product-specific OAuth scope — that is Pie Timers' concern,
       requested by Pie Timers' own code, using this module only to
       reach an already-signed-in session's token
     - it does not decide what a session unlocks — see entitlements.js

   A note on cross-app sign-in: sessions are stored in this browser's
   localStorage, which is scoped per origin. Two apps on different
   subdomains (pietimers.aibhlinn.ai, pomodoro.aibhlinn.ai) do NOT
   automatically share a signed-in session just by both importing this
   file — localStorage cannot cross that boundary. What IS shared is
   the account itself: the same email, the same auth.users row, the
   same entitlements. Today, a person signs in once per subdomain.
   True zero-click SSO across subdomains needs either a shared cookie
   domain (.aibhlinn.ai) or a small auth-broker page apps redirect
   through — a real decision, deliberately left open here rather than
   built silently. See identity/README.md.
   ============================================================ */
(function (global) {
  'use strict';

  var Aibhlinn = global.Aibhlinn = global.Aibhlinn || {};

  var SESSION_KEY = 'aibhlinn/session/v1';
  var REFRESH_MARGIN_MS = 60 * 1000;

  var cfg = null;
  var session = null;
  var listeners = [];
  var refreshTimer = null;
  var refreshInFlight = null;

  function authUrl(path) { return cfg.supabaseUrl + '/auth/v1' + path; }

  function redirectTarget() {
    if (cfg.redirectUrl) return cfg.redirectUrl;
    return location.origin + location.pathname;
  }

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(session); } catch (e) { /* one listener must not break the rest */ }
    });
  }

  function describeError(payload, status) {
    if (!payload) return 'Request failed (' + status + ').';
    return payload.error_description || payload.msg || payload.message ||
           payload.error || ('Request failed (' + status + ').');
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

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function storeSession(next) {
    session = next;
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private browsing: session stays in memory only */ }
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

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session || !session.refresh_token) return;
    var delay = session.expires_at - Date.now() - REFRESH_MARGIN_MS;
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
      if (err.status === 400 || err.status === 401) storeSession(null);
      throw err;
    });

    return refreshInFlight;
  }

  function validToken() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at - Date.now() > REFRESH_MARGIN_MS) {
      return Promise.resolve(session.access_token);
    }
    return refresh().then(function (s) { return s ? s.access_token : null; });
  }

  /* Supabase returns tokens in the URL fragment after a magic link or
     OAuth round trip. Consumed once at init, then scrubbed from the
     address bar so they are not left sitting in browser history. */
  function consumeRedirect() {
    var hash = location.hash || '';
    if (hash.indexOf('access_token=') === -1 && hash.indexOf('error=') === -1) return null;

    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var clean = location.pathname + location.search;

    if (params.get('error')) {
      var message = (params.get('error_description') || params.get('error') || '').replace(/\+/g, ' ');
      history.replaceState(null, '', clean);
      return { error: message };
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

    /* A provider refresh token (e.g. Google, when a product asked for
       extra scope) rides along here. It is handed back to the caller
       and never stored by this module — a product-specific concern. */
    var providerRefreshToken = params.get('provider_refresh_token');
    history.replaceState(null, '', clean);
    return { signedIn: true, providerRefreshToken: providerRefreshToken || null };
  }

  var identity = {
    /* Call once per page load, before anything else in this module. */
    init: function (config) {
      cfg = config;
      session = loadSession();
      scheduleRefresh();
      return consumeRedirect();
    },

    /* Email magic link — no password is ever collected or stored,
       which matters for an audience this app is built for: one thing
       to remember (an email address) instead of two. */
    signInWithEmail: function (email, extra) {
      var body = {
        email: email,
        create_user: true,
        options: { email_redirect_to: redirectTarget() }
      };
      return request(authUrl('/otp'), {
        method: 'POST',
        headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign(body, extra || {}))
      });
    },

    /* Optional, secondary. Hands off to Supabase, which returns to
       redirectTarget(). Requests no scope beyond identifying the
       person — a product asking for more (e.g. calendar access)
       does that itself, separately, after the person is signed in. */
    signInWithGoogle: function () {
      var url = authUrl('/authorize') +
        '?provider=google' +
        '&redirect_to=' + encodeURIComponent(redirectTarget());
      location.assign(url);
    },

    signOut: function () {
      var token = session && session.access_token;
      storeSession(null);
      if (!token) return Promise.resolve();
      return request(authUrl('/logout'), {
        method: 'POST',
        headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token }
      }).catch(function () { /* local sign-out already happened */ });
    },

    loadUser: function () {
      return validToken().then(function (token) {
        if (!token) return null;
        return request(authUrl('/user'), {
          headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token }
        });
      }).then(function (user) {
        if (user && session) { session.user = user; storeSession(session); }
        return user;
      });
    },

    /* Deletes the AibhlínnAI account itself — every product's data
       with it, via each product's own cascading delete. Products with
       data to clean up beyond auth.users register that server-side;
       this module only proves who is asking. */
    deleteAccount: function (functionUrl) {
      return validToken().then(function (token) {
        if (!token) throw new Error('Not signed in.');
        return request(functionUrl, {
          method: 'POST',
          headers: {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: '{}'
        });
      }).then(function (result) {
        storeSession(null);
        return result;
      });
    },

    getSession: function () { return session; },
    getUser: function () { return session && session.user; },
    isSignedIn: function () { return Boolean(session && session.access_token); },
    validToken: validToken,

    onChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    }
  };

  Aibhlinn.identity = identity;
})(window);
