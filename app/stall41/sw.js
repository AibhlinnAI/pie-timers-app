/* ============================================================
   Offline worker for /stall41/ only. Scoped to this folder, so it never
   serves or caches anything for the app itself, which has its own worker
   at app/sw.js. The page is self-contained apart from the two font files.
   ============================================================ */
/* global self, caches */
'use strict';

/* Bump when index.html changes, or an installed copy keeps the old page. */
var CACHE = 'stall41-v1';

var FILES = [
  './',
  'manifest.webmanifest',
  '../fonts/instrument-sans-latin.woff2',
  '../fonts/instrument-sans-latin-ext.woff2',
  '../icon-512-any.png',
  '../icon-512-maskable.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return Promise.all(FILES.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) {
          return k.indexOf('stall41-') === 0 && k !== CACHE;
        }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Network first for the page, so a fix is picked up; the cached copy
  // when the venue Wi-Fi is down.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(CACHE).then(function (c) { c.put('./', copy); });
          return response;
        })
        .catch(function () { return caches.match('./'); })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) { return hit || fetch(request); })
  );
});
