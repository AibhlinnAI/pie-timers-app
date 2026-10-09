#!/usr/bin/env node
/* ============================================================
   Service worker checks: app/sw.js and app/stall41/sw.js.

   Static cases: every precache entry is a real file in this repo, and
   every versioned script or stylesheet app/index.html asks for is
   precached by exactly that URL. Both matter more now that install is
   all-or-nothing: one missing file in the list would block every
   update, and a ?v= that disagrees with index.html leaves the app
   unable to start offline (the comment above SHELL in sw.js says why).

   Behaviour cases run each worker's own code in a vm sandbox, with
   fetch and the Cache API stubbed, and play the browser's part:
   - a good page is stored for offline use;
   - an error page is never stored, so it cannot replace the good copy;
   - a server error shows the stored copy instead, if there is one;
   - a 404 is shown as it is, and a redirect passes straight through;
   - with no network, the stored copy (or the app shell) is shown;
   - one failed precache file fails the whole install, so the old
     worker and its complete cache carry on.

   Nothing here touches the network.

   Run: node tools/check-sw.js   (PT_ROOT=<dir> checks another copy)
   Runs in smoke.yml on every pull request.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.PT_ROOT || path.join(__dirname, '..');
// LF either way, as in check-visits.js, so a Windows checkout matches too.
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let failures = 0, passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

/* ───────────────────────── Harness ───────────────────────── */

/* A Response stand-in with just what the workers use. */
function res(status, opts) {
  const o = Object.assign({ type: 'basic', body: 'body-' + status }, opts);
  const r = {
    status, type: o.type, body: o.body,
    ok: status >= 200 && status < 300,
    clone() { return res(status, o); },
  };
  return r;
}

/* Loads a worker into a fresh context. `network` decides each fetch:
   (url) => a res(), or the string 'offline' to reject. Returns handles
   to its listeners, its caches and what it fetched. */
function load(file, scope, network) {
  const source = readText(path.join(ROOT, file));
  const listeners = {};
  const stores = new Map();          // cache name -> Map(key -> response)
  const fetched = [];
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, scope).href;
  const cacheObj = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      put(req, r) { m.set(keyOf(req), r); return Promise.resolve(); },
      match(req) { return Promise.resolve(m.get(keyOf(req))); },
      /* Cache.add rejects on a network failure or a non-OK response,
         and stores nothing; that is the browser's behaviour. */
      add(req) {
        return doFetch(req).then((r) => {
          if (!r.ok) throw new TypeError('bad status ' + r.status);
          m.set(keyOf(req), r);
        });
      },
    };
  };
  function doFetch(req) {
    const url = keyOf(req);
    fetched.push(url);
    const r = network(url);
    return r === 'offline' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(r);
  }
  const caches = {
    open: (name) => Promise.resolve(cacheObj(name)),
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => Promise.resolve(stores.delete(name)),
    match(req) {
      for (const m of stores.values()) { const hit = m.get(keyOf(req)); if (hit) return Promise.resolve(hit); }
      return Promise.resolve(undefined);
    },
  };
  const self = {
    location: new URL(scope),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: { showNotification: () => Promise.resolve() },
  };
  function Request(url, init) { this.url = new URL(url, scope).href; this.init = init; }
  const ctx = vm.createContext({
    self, caches, clients: self.clients, fetch: doFetch, Request, URL, Promise, console,
    setTimeout, Date, Object, JSON,
  });
  vm.runInContext(source, ctx, { filename: file });
  const cacheName = /var CACHE = '([^']+)'/.exec(source)[1];
  return { listeners, stores, fetched, caches, cacheName, keyOf };
}

/* Dispatches an event and waits for everything it started, including
   the cache writes a handler does without waiting for them. */
async function settle() { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); }
async function navigate(w, url) {
  let responded;
  const event = {
    request: { method: 'GET', mode: 'navigate', url: new URL(url, w.keyOf('./')).href },
    respondWith(p) { responded = Promise.resolve(p); },
  };
  w.listeners.fetch(event);
  const out = responded ? await responded.catch((e) => ({ error: e })) : undefined;
  await settle();
  return out;
}
async function install(w) {
  let waited;
  w.listeners.install({ waitUntil(p) { waited = p; } });
  try { await waited; await settle(); return 'installed'; } catch (e) { await settle(); return 'failed'; }
}
const stored = (w, key) => (w.stores.get(w.cacheName) || new Map()).get(w.keyOf(key));

/* ───────────────────────── Static cases ───────────────────────── */

/* Where a precache URL lives in the repo. deploy.yml publishes app/ at
   the root and identity/ at /identity/. */
function repoPath(url, base) {
  const clean = url.split('?')[0];
  const rel = path.posix.normalize(path.posix.join(base, clean === './' || clean.endsWith('/') ? clean + 'index.html' : clean));
  return rel.startsWith('identity/') ? rel : path.posix.join('app', rel);
}
function listOf(file, name) {
  const src = readText(path.join(ROOT, file));
  const m = new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];').exec(src);
  // Entries only: strip comments first, so a quoted word in one is not read as a URL.
  return m ? [...m[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

const SHELL = listOf('app/sw.js', 'SHELL');
check('S1 app/sw.js has a SHELL list', SHELL.length > 10, SHELL.length);
const missing = SHELL.filter((u) => !fs.existsSync(path.join(ROOT, repoPath(u, ''))));
check('S2 every app/sw.js SHELL entry is a real file (' + SHELL.length + ' checked)', missing.length === 0, missing);

const STALL = listOf('app/stall41/sw.js', 'FILES');
check('S3 app/stall41/sw.js has a FILES list', STALL.length > 0, STALL.length);
const stallMissing = STALL.filter((u) => !fs.existsSync(path.join(ROOT, repoPath(u, 'stall41/'))));
check('S4 every app/stall41/sw.js FILES entry is a real file (' + STALL.length + ' checked)', stallMissing.length === 0, stallMissing);

const index = readText(path.join(ROOT, 'app', 'index.html'));
const versioned = [...index.matchAll(/(?:src|href)="([^":]+\?v=[^"]+)"/g)].map((m) => m[1]);
check('S5 app/index.html loads versioned files', versioned.length > 0, versioned);
const unshelled = versioned.filter((u) => !SHELL.includes(u));
check('S6 every versioned URL app/index.html asks for is precached exactly (' + versioned.length + ' checked)',
  unshelled.length === 0, unshelled);

/* ───────────────────────── Behaviour cases ───────────────────────── */

const APP = 'https://pietimers.aibhlinn.ai/';
const STALL_SCOPE = 'https://pietimers.aibhlinn.ai/stall41/';

(async () => {
  // B1. A good page is stored.
  {
    const w = load('app/sw.js', APP, () => res(200, { body: 'fresh privacy' }));
    const r = await navigate(w, 'privacy.html');
    check('B1 app: a good page is shown', r && r.status === 200);
    check('B1 app: a good page is stored for offline use', stored(w, 'privacy.html') && stored(w, 'privacy.html').body === 'fresh privacy');
  }

  // B2-B4. Error pages are never stored; a 5xx falls back to the stored copy.
  for (const status of [500, 502, 526]) {
    let net = () => res(200, { body: 'good privacy' });
    const w = load('app/sw.js', APP, (u) => net(u));
    await navigate(w, 'privacy.html');
    net = () => res(status, { body: 'error page ' + status });
    const r = await navigate(w, 'privacy.html');
    check('B2 app: a ' + status + ' does not replace the stored page', stored(w, 'privacy.html').body === 'good privacy');
    check('B3 app: on a ' + status + ', the stored page is shown instead', r && r.body === 'good privacy', r && r.body);
  }
  {
    const w = load('app/sw.js', APP, () => res(503, { body: 'error page 503' }));
    const r = await navigate(w, 'privacy.html');
    check('B4 app: a 5xx with nothing stored shows the server\'s page', r && r.status === 503);
    check('B4 app: and stores nothing', !stored(w, 'privacy.html'));
  }

  // B5. A 404 is an answer: shown, never stored, never swapped for a stale copy.
  {
    let net = () => res(200, { body: 'old page' });
    const w = load('app/sw.js', APP, (u) => net(u));
    await navigate(w, 'gone.html');
    net = () => res(404, { body: 'not found' });
    const r = await navigate(w, 'gone.html');
    check('B5 app: a 404 is shown as the server sent it', r && r.status === 404);
    check('B5 app: a 404 does not overwrite the stored copy', stored(w, 'gone.html').body === 'old page');
  }

  // B6. A redirect (fetch of a navigation gives an opaque redirect) passes through, unstored.
  {
    const w = load('app/sw.js', APP, () => res(0, { type: 'opaqueredirect', body: '' }));
    const r = await navigate(w, 'stall41');
    check('B6 app: a redirect passes straight through to the browser', r && r.type === 'opaqueredirect');
    check('B6 app: a redirect is not stored', !stored(w, 'stall41'));
  }

  // B7. Offline: the stored copy, or the app shell.
  {
    let net = (u) => res(200, { body: 'page ' + new URL(u).pathname });
    const w = load('app/sw.js', APP, (u) => net(u));
    await navigate(w, 'terms.html');
    await navigate(w, 'index.html');
    net = () => 'offline';
    const a = await navigate(w, 'terms.html');
    const b = await navigate(w, 'never-visited.html');
    check('B7 app: offline shows the stored copy of a page', a && a.body === 'page /terms.html', a && a.body);
    check('B7 app: offline, an unvisited page falls back to the app shell', b && b.body === 'page /index.html', b && b.body);
  }

  // B8. Install is all or nothing.
  {
    const w = load('app/sw.js', APP, () => res(200));
    check('B8 app: install succeeds when every shell file arrives', (await install(w)) === 'installed');
    check('B8 app: and stores every shell file', SHELL.every((u) => stored(w, u)), SHELL.filter((u) => !stored(w, u)));
  }
  const APPJS = SHELL.find((u) => u.startsWith('app.js'));
  for (const [label, bad] of [['a 5xx', () => res(503)], ['a dropped connection', () => 'offline'], ['a 404', () => res(404)]]) {
    const w = load('app/sw.js', APP, (u) => (u === APP + APPJS ? bad() : res(200)));
    check('B9 app: ' + label + ' on ' + APPJS + ' fails the whole install', (await install(w)) === 'failed');
  }
  {
    // The old cache must survive a failed install: activate never runs, so it is untouched.
    const w = load('app/sw.js', APP, (u) => (u.endsWith('/styles.css') ? res(500) : res(200)));
    w.stores.set('countdown-timers-v1', new Map([[w.keyOf('index.html'), res(200, { body: 'old shell' })]]));
    const outcome = await install(w);
    check('B10 app: after a failed install the old cache is still there', outcome === 'failed' && w.stores.has('countdown-timers-v1'));
  }

  // B11-B14. The same rules for the stall worker, which stores its page under './'.
  {
    let net = () => res(200, { body: 'stall page' });
    const w = load('app/stall41/sw.js', STALL_SCOPE, (u) => net(u));
    await navigate(w, './?display=1');
    check('B11 stall41: a good page is stored', stored(w, './') && stored(w, './').body === 'stall page');
    net = () => res(526, { body: 'error page' });
    const r = await navigate(w, './');
    check('B12 stall41: an error page does not replace the stored page', stored(w, './').body === 'stall page');
    check('B12 stall41: on a 5xx, the stored page is shown instead', r && r.body === 'stall page');
    net = () => 'offline';
    const off = await navigate(w, './');
    check('B13 stall41: offline shows the stored page', off && off.body === 'stall page');
  }
  {
    const w = load('app/stall41/sw.js', STALL_SCOPE, (u) => (u.endsWith('manifest.webmanifest') ? res(500) : res(200)));
    check('B14 stall41: one failed file fails the whole install', (await install(w)) === 'failed');
    const ok = load('app/stall41/sw.js', STALL_SCOPE, () => res(200));
    check('B14 stall41: install succeeds when every file arrives', (await install(ok)) === 'installed');
  }

  if (failures) { console.error(failures + ' check(s) failed, ' + passes + ' passed.'); process.exitCode = 1; }
  else console.log('All ' + passes + ' service worker checks passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
