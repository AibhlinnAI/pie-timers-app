/* ============================================================
   Notification manager.

   Two delivery paths, because no single one covers every case:

   1. Service worker notifications — fired by this page while the
      app is open, including when its tab is in the background or
      the window is minimised. Reliable, works with no server.

   2. Web Push — sent by the Supabase edge function on a schedule,
      so milestones still arrive when the app is fully closed.
      Needs an account and a VAPID key.

   Path 1 always runs. Path 2 layers on top when configured, and
   the service worker de-duplicates by tag so a milestone shows
   once even if both paths deliver it.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};

  var registration = null;
  var readyPromise = null;

  /* Service workers need a secure context; file:// is not one. */
  var supported = ('serviceWorker' in navigator) &&
                  (location.protocol === 'https:' || location.hostname === 'localhost');

  var pushSupported = supported && ('PushManager' in window);

  /* ─────────────────────────── Registration ─────────────────────────── */

  function register() {
    if (!supported) return Promise.resolve(null);
    if (readyPromise) return readyPromise;

    readyPromise = navigator.serviceWorker.register('sw.js', { scope: './' })
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

  function permission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  function requestPermission() {
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

  /* Subscribe this device and hand the endpoint to Supabase.
     Safe to call repeatedly — it reuses an existing subscription. */
  function refreshSubscription() {
    if (!pushSupported || !CT.config.pushConfigured) return Promise.resolve(null);
    if (!CT.auth || !CT.auth.isSignedIn()) return Promise.resolve(null);
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

  function unsubscribe() {
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
    register: register,
    permission: permission,
    requestPermission: requestPermission,
    show: show,
    refreshSubscription: refreshSubscription,
    unsubscribe: unsubscribe,
    syncScheduleToWorker: syncScheduleToWorker
  };
})();
