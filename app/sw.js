/* ============================================================
   Service worker — offline shell + push delivery.
   ============================================================ */
/* global self, caches, clients */
'use strict';

/* Bump this whenever a shell file changes, or installed copies keep
   serving the old one. Bump it too when a page people may already have
   opened changes in a way their saved copy would get wrong (an event page
   going from demo to live, say): the fetch handler keeps the last copy of
   every page each person opened, and only a new CACHE clears them. */
var CACHE = 'countdown-timers-v105';

/* The app itself answers at the manifest's scope ('./') and start_url
   ('index.html'), resolved against this worker. Only these may fall back
   to the app shell offline; see the fetch handler. */
var APP_PAGES = [
  new URL('./', self.location.href).pathname,
  new URL('index.html', self.location.href).pathname
];

var SHELL = [
  './',
  'index.html',
  /* Precached so the terms and privacy policy are readable offline —
     people are entitled to re-read what they agreed to. diagnostics.html
     is deliberately absent: a cached health check is a lie. */
  'terms.html',
  'privacy.html',
  'styles.css',
  /* The self-hosted face. Precached because styles.css asks for these
     and nothing else fetches them offline — without both the app still
     works with the network off, but silently in the fallback font, which
     is a difference people notice and cannot explain. */
  'fonts/instrument-sans-latin.woff2',
  'fonts/instrument-sans-latin-ext.woff2',
  'config.js',
  'identity-bridge.js',
  'identity/identity.js',
  'identity/entitlements.js',
  'identity/identity-ui.js',
  'identity/identity-ui.css',
  /* Drawn by identity-ui.css as the Google sign-in button. */
  'identity/google-signin-light-pill.svg',
  'supabase.js',
  'billing.js',
  'notify.js',
  'sync.js',
  'qrcode.js',
  'app.js',
  'icon.svg',
  'icon-512-any.png',
  'icon-512-maskable.png',
  /* The header plan chip carries this image, so the file belongs in the shell rather
     than an image that arrives late and shifts the toolbar. */
  'aibhlinn-mark-40.png',
  'manifest.webmanifest'
];

/* ─────────────────────────── Lifecycle ─────────────────────────── */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; cache individually so one 404 is survivable.
      .then(function (cache) {
        return Promise.all(SHELL.map(function (url) {
          return cache.add(url).catch(function () { return null; });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ─────────────────────────── Fetch ─────────────────────────── */

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  // Never cache API traffic — auth and sync must always hit the network.
  if (url.origin !== self.location.origin) return;

  // Network-first for navigations so a deploy is picked up promptly,
  // cache-first for static assets so the app opens instantly offline.
  if (request.mode === 'navigate') {
    /* One saved copy per page, whatever the query. The host serves the
       same file for /nsw26/, /nsw26/?live=1 and /nsw26/?fbclid=…, so a
       copy per full URL only piles up entries, and an older one can
       answer a later visit. */
    var key = url.origin + url.pathname;
    event.respondWith(
      fetch(request)
        .then(function (response) {
          /* An error page must not replace a good copy, or a hosting blip
             while online becomes the app the next time it opens offline.
             Redirects (/nsw26 → /nsw26/) are kept so they work offline. */
          if (response.ok || response.type === 'opaqueredirect') {
            var copy = response.clone();
            caches.open(CACHE).then(function (c) { c.put(key, copy); });
          }
          return response;
        })
        .catch(function (err) {
          return caches.match(key).then(function (hit) {
            if (hit) return hit;
            if (APP_PAGES.indexOf(url.pathname) !== -1) return caches.match('index.html');
            /* Anything else fails as a network error, so the browser shows
               its own error page. The event pages (/nsw26/, /ndexpo26/
               and the rest) sit inside this worker's scope, so for anyone
               who has opened Pie Timers, web or Play app, falling back to
               index.html here would serve the app at /nsw26/?live=1: its
               relative styles.css and app.js resolve under /nsw26/ and
               fail, and the person gets a broken, unstyled "Pie Timers"
               page instead of the program. */
            throw err;
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE).then(function (c) { c.put(request, copy); });
        }
        return response;
      });
    })
  );
});

/* ─────────────────────────── Push ─────────────────────────── */

self.addEventListener('push', function (event) {
  var data = { title: 'Pie Timers', body: 'A milestone is due.', tag: 'countdown' };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text() || data.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // Matching tags collapse, so an in-page alert and a push for the
      // same milestone surface as one notification rather than two.
      tag: data.tag,
      renotify: false,
      icon: 'icon.svg',
      badge: 'icon.svg',
      timestamp: Date.now(),
      data: { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      /* openWindow creates a fresh top-level browsing context: no
         Referer, empty sessionStorage. Inside the Play app that is the
         one journey where the consumption-only gate has nothing to read.

         This worker deliberately does NOT stamp an "#in-app" marker on
         the target to compensate. One worker serves the Play app and
         every ordinary Chrome tab on this origin and cannot tell them
         apart, so stamping here would put WEB customers into
         consumption-only mode — no prices, and no route to the
         cancellation portal — for a whole browsing context, which is a
         worse failure than the leak it would close.

         TO CLOSE IT PROPERLY: stamp at notification-creation time, where
         the flag is actually known (notify.js has CT.inPlayApp; the push
         edge function would need to send the same field, defaulting to
         false). That waits on a device test of whether this window comes
         back as the TWA or as a plain Chrome tab. */
      if (clients.openWindow) return clients.openWindow(target);
      return null;
    })
  );
});

/* The push service can re-issue an endpoint; tell the page to re-register. */
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    clients.matchAll({ includeUncontrolled: true }).then(function (list) {
      list.forEach(function (client) {
        client.postMessage({ type: 'resubscribe' });
      });
    })
  );
});

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  if (msg.type === 'schedule') {
    self.__schedule = msg.payload; // read by future scheduling work
  }
});
