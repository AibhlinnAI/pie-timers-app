/* ============================================================
   Sync engine — keeps the local schedule/settings in step with
   the signed-in user's row in Supabase.

   Conflict rule: last write wins, compared on updatedAt. This is
   the right trade-off here because the data is a single small
   document edited by one person on a handful of devices, and a
   merge UI would cost more than it is worth. Ties break in
   favour of the remote copy so devices converge rather than
   ping-pong.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};

  var PUSH_DEBOUNCE_MS = 1500;
  var POLL_INTERVAL_MS = 60 * 1000;
  var DEVICE_KEY = 'countdown-timers/device/v1';

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
      if (!row) {
        // First device for this account — seed the server from local state.
        return push(true).then(function () { return true; });
      }

      var local = CT.app.getState();
      var localAt = local.updatedAt || 0;
      var remoteAt = Date.parse(row.updated_at) || 0;

      // Tie goes to remote so every device lands on the same copy.
      if (remoteAt >= localAt) {
        CT.app.replaceState({
          schedule: row.schedule,
          settings: row.settings,
          // Older rows predate this column; fall back to what is already
          // here rather than wiping the local list.
          appointments: row.appointments || local.appointments,
          updatedAt: remoteAt
        }, { fromSync: true });
        setStatus('synced');
        return true;
      }

      // Local is genuinely newer — send it up.
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
    // is stashed because app.js needs the provider token from it, and the
    // URL fragment can only be read once.
    var redirect = CT.auth.consumeRedirect();
    CT.pendingRedirect = redirect;
    if (redirect && redirect.error) setStatus('error', redirect.error);

    CT.auth.onChange(function (session) {
      if (session) {
        startPolling();
        CT.auth.loadUser()
          // Entitlement must be known before syncing decides what it may do.
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
