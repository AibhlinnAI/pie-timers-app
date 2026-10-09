/* ============================================================
   Offline worker for /stall41/ only. Scoped to this folder, so it never
   serves or caches anything for the app itself, which has its own worker
   at app/sw.js. The page is self-contained apart from the two font files.
   ============================================================ */
/* global self, caches */
'use strict';

/* Bump when index.html or the manifest changes, or an installed copy
   keeps the old one: both are served from this cache. v2: the manifest
   asks for fullscreen, so an installed phone copy hides Android's status
   and navigation bars. v3: error pages are no longer stored. */
var CACHE = 'stall41-v3';

var FILES = [
  './',
  'manifest.webmanifest',
  '../fonts/instrument-sans-latin.woff2',
  '../fonts/instrument-sans-latin-ext.woff2',
  '../icon-512-any.png',
  '../icon-512-maskable.png'
];

/* cache.add(), except that an error response's body is cancelled. An
   unread error response is not released, and with three or more of them a
   first install stalled until Chromium gave up on it (see app/sw.js). */
function addOne(cache, url) {
  var request = new Request(url, { cache: 'reload' });
  return fetch(request).then(function (response) {
    if (!response.ok) {
      if (response.body) response.body.cancel();
      throw new TypeError(url + ' answered ' + response.status);
    }
    return cache.put(request, response);
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        /* As in app/sw.js: an update is all or nothing, so a failed file
           leaves the old worker and its complete cache in place; a first
           install keeps whatever arrived, because there is nothing to
           fall back on. */
        var strict = !!self.registration.active;
        return Promise.all(FILES.map(function (url) {
          var add = addOne(cache, url);
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
        return Promise.all(keys.filter(function (k) {
          return k.indexOf('stall41-') === 0 && k !== CACHE;
        }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* This worker reads only its own cache: the app's worker on the same
   origin keeps caches of its own, and caches.match() would search those
   too. */
function fromCache(request) {
  return caches.open(CACHE).then(function (c) { return c.match(request); });
}
function storedPage() { return fromCache('./'); }

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network first for the page, so a fix is picked up; the cached copy
  // when the venue Wi-Fi is down.
  if (request.mode === 'navigate') {
    /* Only the page itself. Opening manifest.webmanifest or sw.js in a
       tab is a navigation too, and must not be stored as the page. */
    if (!/\/stall41\/(index\.html)?$/.test(url.pathname)) return;

    event.respondWith(
      fetch(request)
        .then(function (response) {
          /* Only a good copy of the page replaces the stored one, as in
             app/sw.js. On a server error, the stored page is better than
             the error. */
          if (response.ok && response.type === 'basic') {
            var copy = response.clone();
            caches.open(CACHE).then(function (c) { c.put('./', copy); });
            return response;
          }
          if (response.status >= 500) {
            return storedPage().then(function (hit) { return hit || response; });
          }
          return response;
        })
        .catch(storedPage)
    );
    return;
  }

  event.respondWith(
    fromCache(request).then(function (hit) { return hit || fetch(request); })
  );
});
