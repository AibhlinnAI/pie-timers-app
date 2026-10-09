/* ============================================================
   Service worker — offline shell + push delivery.
   ============================================================ */
/* global self, caches, clients */
'use strict';

/* Bump this whenever a shell file changes, or installed copies keep
   serving the old one. */
var CACHE = 'countdown-timers-v119';

/* Versioned URLs: a file changed in a release is loaded by index.html as
   file.js?v=<release>, and listed here by EXACTLY that URL. The cache
   matches the whole URL, query included, so an unversioned entry here
   would cache a copy index.html never asks for, and leave the one it does
   ask for uncached: the app would not start offline. Bump the ?v= in both
   files together, for each file the release changes.

   styles.css is listed both ways: index.html asks for the versioned URL,
   while terms.html and privacy.html, precached below, ask for the plain
   one. */
var SHELL = [
  './',
  'index.html',
  /* Precached so the terms and privacy policy are readable offline —
     people are entitled to re-read what they agreed to. diagnostics.html
     is deliberately absent: a cached health check is a lie. */
  'terms.html',
  'privacy.html',
  'styles.css?v=113',
  'styles.css',
  /* The self-hosted face. Precached because styles.css asks for these
     and nothing else fetches them offline — without both the app still
     works with the network off, but silently in the fallback font, which
     is a difference people notice and cannot explain. */
  'fonts/instrument-sans-latin.woff2',
  'fonts/instrument-sans-latin-ext.woff2',
  'config.js',
  'visits.js?v=118',
  'identity-bridge.js?v=117',
  'identity/identity.js?v=117',
  'identity/email-typos.js',
  'identity/entitlements.js',
  'identity/identity-ui.js',
  'identity/identity-ui.css',
  /* Drawn by identity-ui.css as the Google sign-in button. */
  'identity/google-signin-light-pill.svg',
  'supabase.js?v=117',
  'billing.js',
  'notify.js',
  'sync.js?v=113',
  'qrcode.js',
  'app.js?v=117',
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
      /* An UPDATE is all or nothing. If any shell file fails to arrive (a
         dropped connection, a 5xx, an error page from anything in front of
         Pages), the install fails and the browser retries later, while the
         old worker and its complete cache carry on. Skipping the failed
         file instead, as this used to, still activated the new worker,
         whose activate step then deleted the old cache: the offline shell
         came up a file short with nothing to fall back on.

         A FIRST install keeps whatever arrived. There is no old worker to
         fall back on, and a failed first install leaves no worker at all,
         so navigator.serviceWorker.ready never resolves and notify.js
         cannot set up background alerts for the rest of the visit. The
         cache-first handler below stores a missed file the first time the
         page loads it.

         The reason updates used to skip a failed file, that one dead entry
         in this list would block every update, is now caught before it
         ships: tools/check-sw.js, in smoke.yml and in deploy.yml's guard,
         checks every entry here is a real file. */
      .then(function (cache) {
        var strict = !!self.registration.active;
        return Promise.all(SHELL.map(function (url) {
          /* cache:'reload' goes past the browser's HTTP cache to the server.
             Pages keeps files for ten minutes, so a plain add() soon after
             a deploy could store the OLD app.js under the NEW cache name,
             and it would then be served until the next bump. */
          var add = cache.add(new Request(url, { cache: 'reload' }));
          return strict ? add : add.catch(function () { return null; });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        /* Only this worker's own old caches. stall41/sw.js keeps its
           offline copy in a cache of its own on the same origin, and an
           app release must not wipe it. */
        return Promise.all(keys.map(function (key) {
          return key.indexOf('countdown-timers-') === 0 && key !== CACHE
            ? caches.delete(key) : null;
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
    /* Never stored, never substituted: a cached health check is a lie
       (see SHELL). The browser shows the server's real answer. */
    if (url.pathname.slice(-17) === '/diagnostics.html') return;

    event.respondWith(
      fetch(request)
        .then(function (response) {
          /* Only a good page replaces the stored one. This used to store
             whatever came back, so one error page (a Pages 404 or 5xx, or
             an error from anything in front of Pages) overwrote the copy
             that works offline, and was then shown offline.

             A redirect is stored too. Pages answers a folder address
             without its slash (/nsw26) with a redirect to /nsw26/, and the
             stored redirect is what still gets there offline. */
          if ((response.ok && response.type === 'basic') ||
              response.type === 'opaqueredirect') {
            var copy = response.clone();
            caches.open(CACHE).then(function (c) { c.put(request, copy); });
            return response;
          }
          /* The server is failing: the stored copy is better than its
             error page. A 404 is an answer, not a failure, so it is shown
             as it is. */
          if (response.status >= 500) {
            return caches.match(request).then(function (hit) {
              return hit || response;
            });
          }
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match('index.html');
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
