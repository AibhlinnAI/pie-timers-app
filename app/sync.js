/* ============================================================
   Sync engine — keeps the local schedule/settings in step with
   the signed-in user's row in Supabase.

   Conflict rule: last write wins, compared on updatedAt. This is
   the right trade-off here because the data is a single small
   document edited by one person on a handful of devices, and a
   merge UI would cost more than the merge is worth. Ties break in
   favour of the remote copy so devices converge rather than
   ping-pong.

   Last write wins only between copies that have met. A copy that has
   never been in step with the signed-in account loses to its row
   whatever its timestamp, keeping only the appointments made on it
   before signing in. See the note above syncedAccount.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};

  var PUSH_DEBOUNCE_MS = 1500;
  var POLL_INTERVAL_MS = 60 * 1000;
  var DEVICE_KEY = 'countdown-timers/device/v1';
  var SYNCED_KEY = 'countdown-timers/synced-account/v1';
  var NO_ACCOUNT = '';

  // local | signed-out | free | syncing | synced | offline | error
  var status = 'local';
  var detail = '';
  var pushTimer = null;
  var pollTimer = null;
  var pendingPush = false;
  var statusListeners = [];

  /* A stable per-device id, so a device can recognise its own writes. */
  var deviceId = (function () {
    try {
      var existing = localStorage.getItem(DEVICE_KEY);
      if (existing) return existing;
      var made = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, made);
      return made;
    } catch (e) {
      return 'dev_ephemeral';
    }
  })();

  /* The account this device's copy was last in step with: its user id,
     NO_ACCOUNT, or null before init() has run here for the first time.

     updatedAt alone cannot tell a fresh install from a device holding
     unsent edits. A new install starts at 0, but dismissing the welcome
     panel saves and stamps it with the current time, so by the time
     someone signs in, the defaults are "newer" than the account's
     real row. Last write wins then pushed them over it: schedule and
     settings, and an empty appointment list over the real one. Every
     device they owned pulled the empty copy next.

     Kept through sign-out, so signing back in to the same account
     still sends edits made in between. */
  var syncedAccount = (function () {
    try { return localStorage.getItem(SYNCED_KEY); } catch (e) { return null; }
  })();

  function setSyncedAccount(value) {
    syncedAccount = value;
    try { localStorage.setItem(SYNCED_KEY, value); } catch (e) { /* memory only */ }
  }

  function inStepWith(user) {
    return Boolean(user) && syncedAccount === user.id;
  }

  /* Appointments made before this device first signed in exist nowhere
     else, so they join the account's list rather than vanish with the
     rest of the local copy. Matched on id, which the conference agenda
     shares across devices, or on what and when, in case the same
     appointment was typed on both. */
  function mergeAppointments(remote, local) {
    var ids = {};
    var slots = {};
    remote.forEach(function (a) {
      ids[a.id] = true;
      slots[a.title + '|' + a.date + '|' + a.time] = true;
    });
    var added = local.filter(function (a) {
      return !ids[a.id] && !slots[a.title + '|' + a.date + '|' + a.time];
    });
    return { list: remote.concat(added), added: added.length };
  }

  function setStatus(next, message) {
    status = next;
    detail = message || '';
    statusListeners.forEach(function (fn) {
      try { fn(status, detail); } catch (e) { /* keep the rest running */ }
    });
  }

  /* ─────────────────────────── Pull ─────────────────────────── */

  /* `manual` marks a pull the user asked for by pressing "Sync now".
     Those are always allowed, even without a plan — someone's own
     schedule must never be held hostage to a lapsed payment. Only the
     automatic background sync is gated. */
  function pull(manual) {
    if (!CT.auth.isSignedIn()) return Promise.resolve(false);
    if (!navigator.onLine) { setStatus('offline'); return Promise.resolve(false); }
    if (!manual && !CT.billing.isEntitled()) { setStatus('free'); return Promise.resolve(false); }

    setStatus('syncing');

    return CT.db.getProfile().then(function (row) {
      var user = CT.auth.getUser();

      if (!row) {
        // First device for this account — seed the server from local state.
        if (user) setSyncedAccount(user.id);
        return push(true).then(function () { return true; });
      }

      var local = CT.app.getState();
      var remoteAt = Date.parse(row.updated_at) || 0;
      // Never in step with this account: older than any row it holds.
      var localAt = inStepWith(user) ? (local.updatedAt || 0) : 0;

      // Tie goes to remote so every device lands on the same copy.
      if (remoteAt >= localAt) {
        // Older rows predate this column; fall back to what is already
        // here rather than wiping the local list.
        var appointments = row.appointments || local.appointments;
        var kept = 0;

        // Only from a copy no account has held. One left by another
        // account is on that account's row already, and does not belong
        // in this one.
        if (syncedAccount === NO_ACCOUNT) {
          var merged = mergeAppointments(appointments, local.appointments);
          appointments = merged.list;
          kept = merged.added;
        }

        CT.app.replaceState({
          schedule: row.schedule,
          settings: row.settings,
          appointments: appointments,
          // Kept appointments make this copy newer than the row, even
          // on a clock running behind the one that wrote it.
          updatedAt: kept ? Math.max(Date.now(), remoteAt + 1) : remoteAt
        }, { fromSync: true });
        if (user) setSyncedAccount(user.id);

        if (kept) return push(true).then(function () { return true; });
        setStatus('synced');
        return true;
      }

      // Local is genuinely newer — send the row up.
      return push(true).then(function () { return true; });
    }).catch(function (err) {
      setStatus('error', err.message);
      return false;
    });
  }

  /* ─────────────────────────── Push ─────────────────────────── */

  function push(immediate) {
    if (!CT.auth.isSignedIn()) return Promise.resolve(false);
    if (!CT.billing.isEntitled()) { setStatus('free'); return Promise.resolve(false); }

    if (!navigator.onLine) {
      pendingPush = true;              // retried by the 'online' handler
      setStatus('offline');
      return Promise.resolve(false);
    }

    if (!immediate) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { push(true); }, PUSH_DEBOUNCE_MS);
      return Promise.resolve(false);
    }

    clearTimeout(pushTimer);

    // An edit made after signing in but before the first pull lands
    // would send this copy up unseen. pull() compares, then pushes.
    var user = CT.auth.getUser();
    if (user && !inStepWith(user)) return pull();

    var local = CT.app.getState();
    var stamp = local.updatedAt || Date.now();

    setStatus('syncing');

    return CT.db.saveProfile({
      schedule: local.schedule,
      settings: local.settings,
      appointments: local.appointments,
      updated_at: new Date(stamp).toISOString(),
      device_id: deviceId
    }).then(function () {
      pendingPush = false;
      setStatus('synced');
      return true;
    }).catch(function (err) {
      pendingPush = true;
      setStatus('error', err.message);
      return false;
    });
  }

  /* ─────────────────────────── Wiring ─────────────────────────── */

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (CT.auth.isSignedIn() && navigator.onLine && !document.hidden) pull();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() { clearInterval(pollTimer); }

  function init() {
    if (!CT.config.isConfigured) {
      setStatus('local');
      return;
    }

    // Handle the return leg of a magic link or Google sign-in. The result
    // is stashed because app.js needs the provider token from there, and the
    // URL fragment can only be read once.
    var redirect = CT.auth.consumeRedirect();
    CT.pendingRedirect = redirect;
    if (redirect && redirect.error) setStatus('error', redirect.error);

    /* Once per device, the first time this runs. A device already signed
       in has been syncing under plain last write wins, so its copy is in
       step with that account. A sign-in arriving in this very URL is
       new, and counts as none, same as being signed out. */
    if (syncedAccount === null) {
      var bootUser = CT.auth.getUser();
      var carried = CT.auth.isSignedIn() && !(redirect && redirect.signedIn) && bootUser;
      setSyncedAccount(carried ? bootUser.id : NO_ACCOUNT);
    }

    CT.auth.onChange(function (session) {
      if (session) {
        startPolling();
        CT.auth.loadUser()
          // Entitlement must be known before syncing decides what is permitted.
          .then(function () { return CT.billing.refresh(); })
          .then(function () { return pull(); })
          .then(function () { CT.notify.refreshSubscription(); })
          .catch(function (err) { setStatus('error', err.message); });
      } else {
        stopPolling();
        setStatus('signed-out');
      }
    });

    if (CT.auth.isSignedIn()) {
      startPolling();
      CT.auth.loadUser()
        .then(pull)
        .then(function () { CT.notify.refreshSubscription(); })
        .catch(function (err) { setStatus('error', err.message); });
    } else {
      setStatus('signed-out');
    }

    window.addEventListener('online', function () {
      if (CT.auth.isSignedIn()) {
        if (pendingPush) push(true);
        else pull();
      }
    });

    window.addEventListener('offline', function () {
      if (CT.auth.isSignedIn()) setStatus('offline');
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && CT.auth.isSignedIn() && navigator.onLine) pull();
    });
  }

  CT.sync = {
    init: init,
    pull: pull,
    push: push,
    deviceId: deviceId,
    getStatus: function () { return { status: status, detail: detail }; },
    /* Called by app.js when the local copy is wiped with its account. */
    forgetAccount: function () { setSyncedAccount(NO_ACCOUNT); },
    onStatus: function (fn) {
      statusListeners.push(fn);
      fn(status, detail);
      return function () {
        statusListeners = statusListeners.filter(function (f) { return f !== fn; });
      };
    },
    /* Called by app.js whenever the user changes something locally. */
    notifyLocalChange: function () { push(false); }
  };
})();
