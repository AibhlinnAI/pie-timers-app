/* ============================================================
   Notification manager.

   Two delivery paths, because no single one covers every case:

   1. Service worker notifications — fired by this page while the
      app is open, including when its tab is in the background or
      the window is minimised. Reliable, works with no server.

   2. Web Push — sent by the Supabase edge function on a schedule,
      so milestones still arrive when the app is fully closed.
      Needs an account, a VAPID key, and Background alerts switched
      on (settings.push).

   Path 1 always runs. Path 2 layers on top when configured, and
   the service worker de-duplicates by tag so a milestone shows
   once even if both paths deliver.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};

  var registration = null;
  var readyPromise = null;

  /* Service workers need a secure context; file:// is not one. */
  var supported = ('serviceWorker' in navigator) &&
                  (location.protocol === 'https:' || location.hostname === 'localhost');

  /* ─────────────────────────── The Android app ───────────────────────────
     The Play app is a WebView, and a WebView has no Notification and no
     PushManager. From release 7 the app offers its own bridge instead,
     PieTimersAndroidPush (android/.../MainActivity.java):

       permission()             "granted" or "denied", straight away
       request()                asks Android if it must, then answers
       token()                  answers without asking
       show(title, body, tag)   shows a phone notification now

     request() and token() answer by calling window.PieTimersPushResult
     with { permission, token }. The token is the phone's Firebase device
     token. It is saved in push_subscriptions as the endpoint "fcm:<token>"
     with no keys, beside the browsers, and notify-milestones sends to it
     through Firebase Cloud Messaging.

     An older Play app has no bridge. There nativePush is false, nothing
     below changes, and app.js says to update the app. */
  var nativeBridge = window.PieTimersAndroidPush || null;
  var nativePush = !!(nativeBridge && typeof nativeBridge.request === 'function' &&
                      typeof nativeBridge.show === 'function');

  var NATIVE_ASKED_KEY = 'countdown-timers/phone-alerts-asked';
  var NATIVE_ENDPOINT_KEY = 'countdown-timers/phone-alerts-endpoint';
  var NATIVE_ANSWER_MS = 20000;

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage blocked: asked again next time */ }
  }

  function nativeAllowed() {
    try { return nativeBridge.permission() === 'granted'; } catch (e) { return false; }
  }

  /* Everyone waiting on the app's next answer gets it. */
  var nativeWaiters = [];
  if (nativePush) {
    window.PieTimersPushResult = function (result) {
      var waiting = nativeWaiters;
      nativeWaiters = [];
      waiting.forEach(function (resolve) { resolve(result || null); });
    };
  }

  /* Calls request() or token() and resolves with the app's answer.
     `patient` is the permission prompt, which waits on a person and so
     has no time limit. Otherwise no answer in NATIVE_ANSWER_MS is null. */
  function askNative(method, patient) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(result) {
        if (done) return;
        done = true;
        resolve(result);
      }
      nativeWaiters.push(finish);
      if (!patient) setTimeout(function () { finish(null); }, NATIVE_ANSWER_MS);
      try { nativeBridge[method](); } catch (e) { finish(null); }
    });
  }

  var pushSupported = nativePush || (supported && ('PushManager' in window));

  /* ─────────────────────────── Registration ─────────────────────────── */

  function register() {
    if (!supported) return Promise.resolve(null);
    if (readyPromise) return readyPromise;

    readyPromise = navigator.serviceWorker.register('sw.js', {
      scope: './',
      /* Without this the browser may serve sw.js itself from HTTP cache --
         GitHub Pages sends max-age=600 -- so a new worker is not even
         noticed for ten minutes after a deploy, and users sit on a stale
         build with no way to know. skipWaiting/clients.claim in sw.js
         cannot help: they only run once the browser has fetched a worker
         the browser considers new. 'none' makes the update check always hit the
         network. */
      updateViaCache: 'none'
    })
      .then(function (reg) {
        registration = reg;
        return navigator.serviceWorker.ready;
      })
      .then(function (reg) {
        registration = reg;
        return reg;
      })
      .catch(function (err) {
        readyPromise = null;
        console.warn('Service worker registration failed:', err.message);
        return null;
      });

    return readyPromise;
  }

  /* ─────────────────────────── Permission ─────────────────────────── */

  /* In the Android app "not allowed" is where every phone starts on
     Android 13 and later, so it only reads as 'denied' once this app
     has asked and been refused. Until then it is 'default', as in a
     browser that has not been asked. */
  function permission() {
    if (nativePush) {
      if (nativeAllowed()) return 'granted';
      return stored(NATIVE_ASKED_KEY) ? 'denied' : 'default';
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  function requestPermission() {
    if (nativePush) {
      if (nativeAllowed()) return Promise.resolve('granted');
      /* Asked every time: Android shows its prompt while it still will,
         and answers "no" at once when it will not. */
      store(NATIVE_ASKED_KEY, '1');
      return askNative('request', true).then(function () { return permission(); });
    }
    if (typeof Notification === 'undefined') {
      return Promise.resolve('unsupported');
    }
    if (Notification.permission !== 'default') {
      return Promise.resolve(Notification.permission);
    }
    return Notification.requestPermission();
  }

  /* ─────────────────────────── Showing ─────────────────────────── */

  /* tag makes repeat deliveries of the same milestone collapse into one. */
  function show(title, body, tag) {
    if (permission() !== 'granted') return Promise.resolve(false);

    /* The Android app shows it itself, and remembers the tag, so the
       same milestone arriving from the server a moment later is not
       shown twice (Notifier.java). */
    if (nativePush) {
      try {
        nativeBridge.show(String(title || ''), String(body || ''), String(tag || 'countdown'));
        return Promise.resolve(true);
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    var options = {
      body: body,
      tag: tag || 'countdown',
      renotify: false,
      icon: 'icon.svg',
      badge: 'icon.svg',
      timestamp: Date.now(),
      data: { url: location.pathname }
    };

    if (registration && registration.showNotification) {
      return registration.showNotification(title, options)
        .then(function () { return true; })
        .catch(function () { return fallbackNotification(title, options); });
    }
    return Promise.resolve(fallbackNotification(title, options));
  }

  function fallbackNotification(title, options) {
    try {
      new Notification(title, options);
      return true;
    } catch (e) {
      return false; // some browsers forbid the constructor entirely
    }
  }

  /* ─────────────────────────── Web Push ─────────────────────────── */

  function urlBase64ToUint8Array(base64) {
    var padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    var raw = atob(padded);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* The Background alerts switch (settings.push in app.js). Off until
     someone turns it on. */
  function backgroundAlertsOn() {
    var state = CT.app && CT.app.getState ? CT.app.getState() : null;
    return !!(state && state.settings && state.settings.push);
  }

  /* Subscribe this device and hand the endpoint to Supabase, but only
     while Background alerts is switched on. Every caller comes through
     this check: the switch itself, sync.js after a pull, and the service
     worker's 'resubscribe' message. Before v136 nothing here read the
     switch, so a device subscribed whatever it said, and switching it off
     lasted until the next start.
     Safe to call repeatedly — an existing subscription is reused. */
  function refreshSubscription() {
    if (nativePush) return refreshNative();
    if (!pushSupported || !CT.config.pushConfigured) return Promise.resolve(null);
    if (!CT.auth || !CT.auth.isSignedIn()) return Promise.resolve(null);
    if (!backgroundAlertsOn()) return Promise.resolve(null);
    if (permission() !== 'granted') return Promise.resolve(null);

    return register().then(function (reg) {
      if (!reg) return null;
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(CT.config.vapidPublicKey)
        });
      });
    }).then(function (sub) {
      if (!sub) return null;
      var raw = sub.toJSON ? sub.toJSON() : null;
      var keys = (raw && raw.keys) || {
        p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
        auth: arrayBufferToBase64(sub.getKey('auth'))
      };
      var tz = 'UTC';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* default */ }

      return CT.db.savePushSubscription({ endpoint: sub.endpoint, keys: keys }, tz)
        .then(function () { return sub; });
    }).catch(function (err) {
      console.warn('Push subscription failed:', err.message);
      return null;
    });
  }

  /* The Android app's half of refreshSubscription(): the same four
     conditions, then the phone's token in place of a browser
     subscription. Run each time the app opens (sync.js, after the pull),
     which is also what picks up a token Firebase has replaced: the new
     one is saved and the old row removed. */
  function refreshNative() {
    if (!CT.config.isConfigured) return Promise.resolve(null);
    if (!CT.auth || !CT.auth.isSignedIn()) return Promise.resolve(null);
    if (!backgroundAlertsOn()) return Promise.resolve(null);
    if (!nativeAllowed()) return Promise.resolve(null);

    return askNative('token').then(function (result) {
      if (!result || !result.token) return null;
      var endpoint = 'fcm:' + result.token;
      var before = stored(NATIVE_ENDPOINT_KEY);
      var tz = 'UTC';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { /* default */ }

      return CT.db.savePushSubscription({ endpoint: endpoint, keys: {} }, tz).then(function () {
        store(NATIVE_ENDPOINT_KEY, endpoint);
        if (before && before !== endpoint) {
          CT.db.removePushSubscription(before).catch(function () { /* the server drops a dead token itself */ });
        }
        return { endpoint: endpoint };
      });
    }).catch(function (err) {
      console.warn('Phone alert registration failed:', err && err.message);
      return null;
    });
  }

  /* Removes this phone's row, so the server stops sending to it. The
     token itself is left with Firebase: without the row nothing is ever
     sent to it. If the row cannot be removed now (offline), the endpoint
     is kept so the next call tries again. */
  function unsubscribeNative() {
    var endpoint = stored(NATIVE_ENDPOINT_KEY);
    if (!endpoint) return Promise.resolve();
    if (!CT.auth || !CT.auth.isSignedIn()) return Promise.resolve();
    return CT.db.removePushSubscription(endpoint).then(function () {
      store(NATIVE_ENDPOINT_KEY, null);
    }).catch(function () { /* best effort */ });
  }

  function unsubscribe() {
    if (nativePush) return unsubscribeNative();
    if (!pushSupported) return Promise.resolve();
    return register().then(function (reg) {
      if (!reg) return null;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return null;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () {
        if (CT.auth && CT.auth.isSignedIn()) {
          return CT.db.removePushSubscription(endpoint).catch(function () { /* best effort */ });
        }
      });
    }).catch(function () { /* best effort */ });
  }

  /* Give the service worker the schedule so a push can name the right
     milestone even if the payload is stripped by the push service. */
  function syncScheduleToWorker(state) {
    if (!supported) return;
    register().then(function (reg) {
      var target = (reg && reg.active) || navigator.serviceWorker.controller;
      if (!target) return;
      target.postMessage({ type: 'schedule', payload: state });
    });
  }

  CT.notify = {
    supported: supported,
    pushSupported: pushSupported,
    /* True in the Android app from release 7: it shows notifications
       itself, through the bridge above. */
    nativePush: nativePush,
    register: register,
    permission: permission,
    requestPermission: requestPermission,
    show: show,
    refreshSubscription: refreshSubscription,
    unsubscribe: unsubscribe,
    syncScheduleToWorker: syncScheduleToWorker
  };
})();
