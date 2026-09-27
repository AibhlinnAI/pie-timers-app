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
  /* Pulls can overlap: the minute's poll, coming back to the tab, the
     'online' event and Sync now each start one, and their answers can
     come back in any order. Each pull is numbered as it starts. An answer
     that comes back after a pull started later than it has been answered
     is dropped, unless its row is newer than the one that answer held:
     applied after it, an older row would put back what the newer one took
     away (a break removed on another device, say), then push it. Nothing
     is lost by dropping it: the newer answer has already been dealt with.
     A newer row is still taken, in case the older request reached the
     server last. */
  var pullsStarted = 0;
  var pullAnswered = 0;
  var answeredRowAt = 0;
  /* Counts the rows this copy has taken in. A push that fails once one
     has been taken since it started carried a copy that is no longer
     this one, so it leaves nothing waiting to go up (see push()). */
  var rowsTaken = 0;

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

  /* Whether timer_profiles has the breaks column: null until this copy
     knows, then true or false. A column PostgREST does not know makes it
     refuse the WHOLE upsert (PGRST204), which would stop every sync, so
     `breaks` is only ever sent once the column has been seen (R12): on a
     pulled row, or, before any row exists or before the first pull, by
     asking for the column and getting 200 back. Each pull says again,
     from its row. A "no" from asking is never kept: the next push asks
     again, so one odd answer cannot hold the breaks back for good. */
  var breaksColumn = null;

  function knowBreaksColumn() {
    if (breaksColumn !== null) return Promise.resolve(breaksColumn);
    // A supabase.js from before breaks cannot ask, so nothing is sent.
    if (typeof CT.db.probeBreaksColumn !== 'function') return Promise.resolve(false);
    return CT.db.probeBreaksColumn().then(function (exists) {
      if (exists) breaksColumn = true;
      return exists;
    });
  }

  /* The breaks this push may carry, with the savedAt they were saved
     with, or null. An app.js from before breaks has none to give. Nor is
     a blank record given, one that is empty and was never saved on this
     device: it says nothing the row needs, so a lunch-only device sends
     and asks exactly what it did before breaks, and its next pull brings
     the account's. */
  function breaksToPush() {
    var offered = typeof CT.app.breaksToPush === 'function' ? CT.app.breaksToPush() : null;
    return offered && !offered.blank ? offered : null;
  }

  /* Whether a pull has compared this copy with the row since the page
     loaded, or since a push was last held back or failed. Until one has,
     breaks saved here that no push has carried may be older than ones
     another device has sent meanwhile, so the push pulls first and the
     pull decides (CT.app.breaksNeedPull()). A copy with no such breaks
     pushes as it always has. */
  var compared = false;

  function breaksNeedPull() {
    return !compared && typeof CT.app.breaksNeedPull === 'function' && CT.app.breaksNeedPull();
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
    var pullNumber = ++pullsStarted;

    return CT.db.getProfile().then(function (row) {
      var rowAt = row ? Date.parse(row.updated_at) || 0 : 0;
      // A newer pull's answer is in. The status is already that one's.
      if (pullNumber < pullAnswered && rowAt <= answeredRowAt) return true;
      pullAnswered = Math.max(pullAnswered, pullNumber);
      answeredRowAt = rowAt;
      var user = CT.auth.getUser();
      compared = true;

      if (!row) {
        // First device for this account — seed the server from local state.
        if (user) setSyncedAccount(user.id);
        // Its breaks included: with no row, there are none newer anywhere.
        if (typeof CT.app.confirmBreaks === 'function') CT.app.confirmBreaks();
        return push(true).then(function () { return true; });
      }

      // select=* returns every column, so the row itself says.
      var rowHasBreaks = Object.prototype.hasOwnProperty.call(row, 'breaks');
      breaksColumn = rowHasBreaks;

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

        var incoming = {
          schedule: row.schedule,
          settings: row.settings,
          appointments: appointments,
          // Kept appointments make this copy newer than the row, even
          // on a clock running behind the one that wrote it.
          updatedAt: kept ? Math.max(Date.now(), remoteAt + 1) : remoteAt
        };
        /* Passed exactly as the row has it, null included, and only when
           the row has the column at all: replaceState() keeps this
           copy's breaks when the key is missing (R11). Never
           `row.breaks || local`, and never merged. On a first sign-in
           the account's breaks replace the device's, as its schedule does.
           Otherwise breaks saved here after the row was written, and not
           yet sent, are newer than the row's: replaceState() keeps them,
           and says so when it has also taken the week they were saved
           with, and then they go up. */
        if (rowHasBreaks) incoming.breaks = row.breaks;
        var keptBreaks = CT.app.replaceState(incoming, {
          fromSync: true, rowAt: inStepWith(user) ? remoteAt : undefined
        }) === true;
        rowsTaken++;
        if (user) setSyncedAccount(user.id);

        if (kept || keptBreaks) return push(true).then(function () { return true; });
        /* This copy is the row now, so nothing is waiting to go up. A push
           held back offline, or one that failed, and then sent here by
           push() to pull first, would otherwise stay pending: the next
           'online' event would send this copy, stamp and all, over
           whatever another device has sent since. */
        pendingPush = false;
        /* An edit's push still waiting out its debounce is older than
           this row (remoteAt >= localAt above), so the row has won it; the
           timer would only send the copy just taken in back up, blind. */
        clearTimeout(pushTimer);
        setStatus('synced');
        return true;
      }

      /* Local is genuinely newer — send the row up. Its breaks, though, only
         if this copy can vouch for them: an older copy of the app may have
         stamped the week here without knowing the breaks exist. If not,
         the row's breaks are taken first and go back up with the rest,
         unless they are this device's own, saved after the row was
         written: the row's time lets pulledBreaks() tell. */
      if (rowHasBreaks && typeof CT.app.pulledBreaks === 'function') CT.app.pulledBreaks(row.breaks, remoteAt);
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
      compared = false;                // and the row may have moved on by then
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

    /* Breaks saved here and not yet sent, with no pull since the page
       loaded or since a push was held back or failed: another device may
       have sent newer ones meanwhile, and this push would put these over
       them. The pull compares, keeps whichever is newer, then pushes. The
       'online' handler's push comes through here too. */
    if (breaksNeedPull()) return pull();

    setStatus('syncing');

    /* The breaks travel in this payload and nowhere else (R10), and only
       once the column is known to exist (R12). Then always the whole
       record, the first device's seed included, never null or {} in its
       place: either of those would wipe every device's breaks. If the
       check itself fails, so does this push, and it is retried like any
       other: sending without the breaks would stamp the row as newer
       than breaks it does not have.

       While app.js has no breaks it can vouch for, or only a blank record
       (breaksToPush() gives null), the payload leaves `breaks` out
       altogether, nothing is asked, and the column keeps what it has.
       That covers every push, including the 'online' handler's, which
       sends without pulling first unless breaksNeedPull() says above. */
    var takenBefore = rowsTaken;
    var asking = breaksToPush() ? knowBreaksColumn() : Promise.resolve(false);
    return asking.then(function (known) {
      var local = CT.app.getState();
      var stamp = local.updatedAt || Date.now();
      var payload = {
        schedule: local.schedule,
        settings: local.settings,
        appointments: local.appointments,
        updated_at: new Date(stamp).toISOString(),
        device_id: deviceId
      };
      var sent = known ? breaksToPush() : null;
      if (sent) payload.breaks = sent.breaks;
      return CT.db.saveProfile(payload).then(function () {
        if (sent && typeof CT.app.breaksPushed === 'function') CT.app.breaksPushed(sent.savedAt);
      });
    }).then(function () {
      pendingPush = false;
      setStatus('synced');
      return true;
    }).catch(function (err) {
      /* Retried by the 'online' handler, unless a pull has taken in a
         row since this push set out: this copy is that row now, and
         sending it by itself would put it, stamp and all, over whatever
         another device has sent since. The next pull or edit sends
         anything newer. */
      if (rowsTaken === takenBefore) {
        pendingPush = true;
        compared = false;
      }
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
