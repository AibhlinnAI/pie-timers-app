#!/usr/bin/env node
/* ============================================================
   Service worker checks: app/sw.js and app/stall41/sw.js.

   Static cases: every precache entry is a real file at the address the
   browser will ask for (deploy.yml publishes app/ at the root and
   identity/ at /identity/), and every versioned URL app/index.html asks
   for is precached by exactly that URL. Both matter more now that an
   update is all-or-nothing: one dead entry would block every update, and
   a ?v= that disagrees with index.html leaves the app unable to start
   offline (the comment above SHELL in sw.js says why). The lists are
   read from the workers' own code, run in a sandbox, not scraped.

   Behaviour cases run each worker's own code in a vm sandbox, with fetch
   and the Cache API stubbed as the browser behaves. B13 and B16 give both
   workers one shared cache store, as they share one on the origin; the
   other cases give each worker its own:
   - a good page is stored for offline use, and an error page never is;
   - on a server error the stored copy is shown, if there is one;
   - a 404 is shown as it is;
   - a redirect: the app worker stores it (so /nsw26 still reaches
     /nsw26/ offline); the stall worker passes it through;
   - with no network, the stored copy (or the app shell) is shown;
   - diagnostics.html (and /diagnostics) is never stored or substituted;
   - the stall worker stores only its page, not other files opened in a
     tab, and the app worker's release never deletes the stall's cache;
   - an update with one failed file fails as a whole, so the old worker
     and its cache carry on; a first install keeps what arrived, and a
     page it missed is topped up after the next good navigation;
   - every error response a precache gets has its body cancelled (an
     unread one stalls a real install in Chromium);
   - each worker reads only its own cache;
   - every precache fetch goes past the HTTP cache (cache: 'reload').

   Nothing here touches the network.

   Run: node tools/check-sw.js   (PT_ROOT=<dir> checks another copy)
   Runs in smoke.yml on every pull request, and in deploy.yml's guard
   before every publish.
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

const ORIGIN = 'https://pietimers.aibhlinn.ai';
const APP = ORIGIN + '/';
const STALL = ORIGIN + '/stall41/';

/* A Response stand-in with just what the workers use. `text` is what the
   page would show; `body` is a stream stand-in whose cancel() is logged,
   because an error response nobody cancels stalls a real install. */
const cancelled = [];
function res(status, opts) {
  const o = Object.assign({ type: 'basic', text: 'body-' + status }, opts);
  const r = {
    status, type: o.type, text: o.text, url: o.url,
    ok: o.type !== 'opaqueredirect' && status >= 200 && status < 300,
    clone() { return res(status, o); },
  };
  r.body = o.type === 'opaqueredirect' ? null : { cancel() { cancelled.push(r); return Promise.resolve(); } };
  return r;
}

/* Loads a worker into a fresh context. `network(url)` returns a res(),
   or 'offline' to reject. opts.shared: a cache store shared with another
   worker (one origin, one CacheStorage). opts.active: an older worker is
   already active, so this install is an update. */
function load(file, scope, network, opts) {
  const o = opts || {};
  const source = readText(path.join(ROOT, file));
  const listeners = {};
  const stores = o.shared || new Map();   // cache name -> Map(url -> response)
  const fetched = [], modes = [];
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, scope).href;
  function doFetch(req) {
    const url = keyOf(req);
    fetched.push(url);
    modes.push(req && req.init ? req.init.cache : undefined);
    const r = network(url);
    return r === 'offline' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(r);
  }
  const cacheObj = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      put(req, r) { m.set(keyOf(req), r); return Promise.resolve(); },
      match(req) { return Promise.resolve(m.get(keyOf(req))); },
      // Rejects on a failed fetch or a non-OK response and stores nothing, as the browser does.
      add(req) {
        return doFetch(req).then((r) => {
          if (!r.ok) throw new TypeError('bad status ' + r.status);
          m.set(keyOf(req), r);
        });
      },
      // All or nothing: stores nothing unless every response is OK.
      addAll(reqs) {
        return Promise.all(reqs.map(doFetch)).then((rs) => {
          rs.forEach((r) => { if (!r.ok) throw new TypeError('bad status ' + r.status); });
          rs.forEach((r, i) => m.set(keyOf(reqs[i]), r));
        });
      },
    };
  };
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
    location: new URL(scope + 'sw.js'),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: { active: o.active ? {} : null, showNotification: () => Promise.resolve() },
  };
  function Request(url, init) { this.url = new URL(url, scope).href; this.init = init; }
  const ctx = vm.createContext({
    self, caches, clients: self.clients, fetch: doFetch, Request, URL, Promise, console,
    setTimeout, Date, Object, JSON,
  });
  vm.runInContext(source, ctx, { filename: file });
  return { ctx, listeners, stores, fetched, modes, caches, keyOf, scope };
}

/* Dispatches an event and waits for everything it started, including the
   cache writes a handler makes without waiting for them. */
async function settle() { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); }
async function navigate(w, url) {
  let responded = null;
  const event = {
    request: { method: 'GET', mode: 'navigate', url: new URL(url, w.scope).href },
    respondWith(p) { responded = Promise.resolve(p); },
  };
  w.listeners.fetch(event);
  const out = responded ? await responded.catch((e) => ({ error: String(e) })) : 'not handled';
  await settle();
  return out;
}
async function get(w, url) {
  let responded = null;
  const event = {
    request: { method: 'GET', mode: 'cors', url: new URL(url, w.scope).href },
    respondWith(p) { responded = Promise.resolve(p); },
  };
  w.listeners.fetch(event);
  const out = responded ? await responded.catch((e) => ({ error: String(e) })) : 'not handled';
  await settle();
  return out;
}
async function lifecycle(w, type) {
  let waited;
  w.listeners[type]({ waitUntil(p) { waited = p; } });
  try { await waited; await settle(); return 'done'; }
  catch (e) { await settle(); if (process.env.PT_DEBUG) console.error(type, e); return 'failed'; }
}
const stored = (w, key) => (w.stores.get(w.ctx.CACHE) || new Map()).get(w.keyOf(key));

/* ───────────────────────── Static cases ───────────────────────── */

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
/* The repo file the browser gets for a URL, as deploy.yml publishes it. */
function servedFile(u, scope) {
  let p = new URL(u, scope).pathname;
  if (p.endsWith('/')) p += 'index.html';
  p = p.slice(1);
  return path.join(ROOT, p.startsWith('identity/') ? '' : 'app', p);
}

const appSW = load('app/sw.js', APP, () => res(200));
const stallSW = load('app/stall41/sw.js', STALL, () => res(200));
const SHELL = appSW.ctx.SHELL || [];
const FILES = stallSW.ctx.FILES || [];

check('S1 app/sw.js has a SHELL list and a CACHE name', SHELL.length > 10 && /^countdown-timers-/.test(appSW.ctx.CACHE), [SHELL.length, appSW.ctx.CACHE]);
const missing = SHELL.filter((u) => !isFile(servedFile(u, APP)));
check('S2 every app/sw.js SHELL entry is a real file (' + SHELL.length + ' checked)', missing.length === 0, missing);
check('S3 app/stall41/sw.js has a FILES list and a CACHE name', FILES.length > 0 && /^stall41-/.test(stallSW.ctx.CACHE), [FILES.length, stallSW.ctx.CACHE]);
const stallMissing = FILES.filter((u) => !isFile(servedFile(u, STALL)));
check('S4 every app/stall41/sw.js FILES entry is a real file (' + FILES.length + ' checked)', stallMissing.length === 0, stallMissing);

const index = readText(path.join(ROOT, 'app', 'index.html'));
// Every versioned token, however it is quoted. The comment text "file.js?v=<release>" cannot match.
const versioned = [...new Set([...index.matchAll(/[\w./-]+\?v=[\w.-]+/g)].map((m) => m[0]))];
check('S5 app/index.html loads versioned files', versioned.length > 0, versioned);
const unshelled = versioned.filter((u) => !SHELL.includes(u));
check('S6 every versioned URL app/index.html asks for is precached exactly (' + versioned.length + ' checked)',
  unshelled.length === 0, unshelled);

/* ───────────────────────── Behaviour cases ───────────────────────── */

(async () => {
  /* The rules both workers share, run for each. The stall worker stores
     its page under './' whatever the URL, so it is asked again with a
     query string to pin that. */
  const WORKERS = [
    { tag: 'app', file: 'app/sw.js', scope: APP, page: 'privacy.html', key: 'privacy.html', again: 'privacy.html' },
    { tag: 'stall41', file: 'app/stall41/sw.js', scope: STALL, page: './', key: './', again: './?display=1' },
  ];
  for (const W of WORKERS) {
    const T = W.tag + ': ';
    {
      const w = load(W.file, W.scope, () => res(200, { text: 'fresh page' }));
      const r = await navigate(w, W.page);
      check('B1 ' + T + 'a good page is shown', r && r.status === 200);
      check('B1 ' + T + 'a good page is stored for offline use', stored(w, W.key) && stored(w, W.key).text === 'fresh page');
    }
    for (const status of [500, 502, 526]) {
      let net = () => res(200, { text: 'good page' });
      const w = load(W.file, W.scope, (u) => net(u));
      await navigate(w, W.page);
      net = () => res(status, { text: 'error page ' + status });
      const r = await navigate(w, W.again);
      check('B2 ' + T + 'a ' + status + ' does not replace the stored page', stored(w, W.key).text === 'good page');
      check('B3 ' + T + 'on a ' + status + ', the stored page is shown instead', r && r.text === 'good page', r && r.text);
    }
    {
      const w = load(W.file, W.scope, () => res(503, { text: 'error page 503' }));
      const r = await navigate(w, W.page);
      check('B4 ' + T + 'a 5xx with nothing stored shows the server\'s page', r && r.status === 503);
      check('B4 ' + T + 'and stores nothing', !stored(w, W.key));
    }
    {
      let net = () => res(200, { text: 'good page' });
      const w = load(W.file, W.scope, (u) => net(u));
      await navigate(w, W.page);
      net = () => res(404, { text: 'not found' });
      const r = await navigate(w, W.again);
      check('B5 ' + T + 'a 404 is shown as the server sent it', r && r.status === 404);
      check('B5 ' + T + 'a 404 does not overwrite the stored page', stored(w, W.key).text === 'good page');
    }
    {
      let net = () => res(200, { text: 'good page' });
      const w = load(W.file, W.scope, (u) => net(u));
      await navigate(w, W.page);
      net = () => 'offline';
      const r = await navigate(w, W.again);
      check('B7 ' + T + 'offline shows the stored page', r && r.text === 'good page', r && r.text);
    }
    {
      const w = load(W.file, W.scope, () => res(200), { active: true });
      check('B8 ' + T + 'an update installs when every file arrives', (await lifecycle(w, 'install')) === 'done');
      const list = w.ctx.SHELL || w.ctx.FILES;
      check('B8 ' + T + 'and stores every file', list.every((u) => stored(w, u)), list.filter((u) => !stored(w, u)));
      check('B8 ' + T + 'every precache fetch goes past the HTTP cache', w.modes.length === list.length && w.modes.every((c) => c === 'reload'), w.modes);
    }
    {
      const list = load(W.file, W.scope, () => res(200)).ctx.SHELL || load(W.file, W.scope, () => res(200)).ctx.FILES;
      const victim = new URL(list[list.length - 1], W.scope).href;
      for (const [label, bad] of [['a 5xx', () => res(503)], ['a dropped connection', () => 'offline'], ['a 404', () => res(404)]]) {
        const w = load(W.file, W.scope, (u) => (u === victim ? bad() : res(200)), { active: true });
        check('B9 ' + T + label + ' on one file fails the whole update', (await lifecycle(w, 'install')) === 'failed');
      }
      const first = load(W.file, W.scope, (u) => (u === victim ? res(503) : res(200)));
      check('B9 ' + T + 'a first install with one failed file still installs', (await lifecycle(first, 'install')) === 'done');
      check('B9 ' + T + 'and stores every other file', list.filter((u) => new URL(u, W.scope).href !== victim).every((u) => stored(first, u)));
    }
  }

  // B6. Redirects: the app worker stores one and replays it offline; the stall worker passes it through.
  {
    let net = () => res(0, { type: 'opaqueredirect', text: '' });
    const w = load('app/sw.js', APP, (u) => net(u));
    const r = await navigate(w, 'nsw26');
    check('B6 app: a redirect passes straight through to the browser', r && r.type === 'opaqueredirect');
    net = () => 'offline';
    const off = await navigate(w, 'nsw26');
    check('B6 app: offline, a folder address without its slash still gets its redirect', off && off.type === 'opaqueredirect', off);
  }
  {
    let net = () => res(200, { text: 'stall page' });
    const w = load('app/stall41/sw.js', STALL, (u) => net(u));
    await navigate(w, './');
    net = () => res(0, { type: 'opaqueredirect', text: '' });
    const r = await navigate(w, './');
    check('B6 stall41: a redirect passes through', r && r.type === 'opaqueredirect');
    check('B6 stall41: a redirect is not stored as the page', stored(w, './').text === 'stall page');
  }

  // B10. Offline, an unvisited app page falls back to the app shell.
  {
    let net = (u) => res(200, { text: 'page ' + new URL(u).pathname });
    const w = load('app/sw.js', APP, (u) => net(u));
    await navigate(w, 'index.html');
    net = () => 'offline';
    const r = await navigate(w, 'never-visited.html');
    check('B10 app: offline, an unvisited page falls back to the app shell', r && r.text === 'page /index.html', r && r.text);
  }

  // B11. diagnostics.html is never handled, so never stored or substituted.
  {
    let net = () => res(200, { text: 'live health check' });
    const w = load('app/sw.js', APP, (u) => net(u));
    const a = await navigate(w, 'diagnostics.html');
    net = () => res(503);
    const b = await navigate(w, 'diagnostics.html');
    check('B11 app: diagnostics.html goes straight to the network', a === 'not handled' && b === 'not handled', [a, b]);
    check('B11 app: diagnostics.html is never stored', !stored(w, 'diagnostics.html'));
  }

  // B12. The stall worker stores only its page, not another file opened in a tab.
  {
    let net = () => res(200, { text: 'stall page' });
    const w = load('app/stall41/sw.js', STALL, (u) => net(u));
    await navigate(w, './');
    net = () => res(200, { text: '{"name":"Stall 41"}' });
    const r = await navigate(w, 'manifest.webmanifest');
    check('B12 stall41: a navigation to manifest.webmanifest is left to the network', r === 'not handled', r);
    check('B12 stall41: and the stored page is untouched', stored(w, './').text === 'stall page');
  }

  // B13. One origin, one cache store: an app release must not delete the stall's cache.
  {
    const shared = new Map();
    let net = () => res(200, { text: 'stall page' });
    const stall = load('app/stall41/sw.js', STALL, (u) => net(u), { shared });
    await lifecycle(stall, 'install'); await lifecycle(stall, 'activate');
    await navigate(stall, './');
    shared.set('countdown-timers-v1', new Map());
    net = () => res(200);
    const app = load('app/sw.js', APP, (u) => net(u), { shared, active: true });
    await lifecycle(app, 'install'); await lifecycle(app, 'activate');
    check('B13 app: activate deletes the app\'s own old cache', !shared.has('countdown-timers-v1'), [...shared.keys()]);
    check('B13 app: activate leaves the stall\'s cache alone', shared.has(stall.ctx.CACHE), [...shared.keys()]);
    net = () => 'offline';
    const r = await navigate(stall, './');
    check('B13 stall41: after an app release, the stall page still opens offline', r && r.text === 'stall page', r && r.text);
  }

  /* B13b. The stall worker reads its page from its own cache only. Before
     the stall worker existed on a device, the app worker could have stored
     an older /stall41/ in its cache; that stale copy must never win. */
  {
    const shared = new Map([['countdown-timers-v119', new Map([[STALL, res(200, { text: 'stale copy in the app cache' })]])]]);
    let net = () => res(200, { text: 'stall page' });
    const stall = load('app/stall41/sw.js', STALL, (u) => net(u), { shared });
    await navigate(stall, './');
    net = () => 'offline';
    const r = await navigate(stall, './');
    check('B13 stall41: offline, its own stored page wins over a copy in the app cache', r && r.text === 'stall page', r && r.text);
    net = () => res(503);
    const e = await navigate(stall, './');
    check('B13 stall41: on a 5xx, its own stored page wins too', e && e.text === 'stall page', e && e.text);
  }

  // B14. A failed update leaves the old cache in place (activate never runs).
  {
    const shared = new Map([['countdown-timers-v1', new Map([[APP + 'index.html', res(200, { text: 'old shell' })]])]]);
    const w = load('app/sw.js', APP, (u) => (u.endsWith('/styles.css') ? res(500) : res(200)), { shared, active: true });
    const outcome = await lifecycle(w, 'install');
    check('B14 app: after a failed update the old cache is still there', outcome === 'failed' && shared.has('countdown-timers-v1'));
  }

  // B15. Every error response a precache gets has its body cancelled, first install and update alike.
  for (const W of WORKERS) {
    for (const active of [false, true]) {
      cancelled.length = 0;
      const list = load(W.file, W.scope, () => res(200)).ctx.SHELL || load(W.file, W.scope, () => res(200)).ctx.FILES;
      const bad = new Set(list.slice(0, 3).map((u) => new URL(u, W.scope).href));
      const errors = [];
      const w = load(W.file, W.scope, (u) => { if (bad.has(u)) { const r = res(503); errors.push(r); return r; } return res(200); }, { active });
      await lifecycle(w, 'install');
      check('B15 ' + W.tag + ': ' + (active ? 'an update' : 'a first install') + ' cancels the body of every error response it gets',
        errors.length > 0 && errors.every((r) => cancelled.includes(r)), [errors.length, cancelled.length]);
    }
  }

  // B16. Each worker reads only its own cache: an app release serves its own new copy of a shared file.
  {
    const FONT = APP + 'fonts/instrument-sans-latin.woff2';
    const shared = new Map([['stall41-v3', new Map([[FONT, res(200, { text: 'old font in the stall cache' })]])]]);
    const app = load('app/sw.js', APP, () => res(200, { text: 'new font' }), { shared, active: true });
    await lifecycle(app, 'install'); await lifecycle(app, 'activate');
    const r = await get(app, FONT);
    check('B16 app: a file both workers precache comes from the app\'s own cache', r && r.text === 'new font', r && r.text);
    const stallShared = new Map([['countdown-timers-v119', new Map([[FONT, res(200, { text: 'app copy' })]])]]);
    const stall = load('app/stall41/sw.js', STALL, () => res(200, { text: 'from network' }), { shared: stallShared });
    const g = await get(stall, '../fonts/instrument-sans-latin.woff2');
    check('B16 stall41: a file it has not stored is fetched, not taken from the app cache', g && g.text === 'from network', g && g.text);
  }

  // B17. A page a first install missed is topped up after the next good navigation.
  {
    let failTerms = true;
    const w = load('app/sw.js', APP, (u) => (failTerms && u === APP + 'terms.html' ? res(503) : res(200, { text: 'page ' + new URL(u).pathname })));
    await lifecycle(w, 'install');
    check('B17 app: a first install that missed terms.html installs without it', !stored(w, 'terms.html'));
    failTerms = false;
    await navigate(w, './');
    check('B17 app: the next good navigation tops terms.html back up', stored(w, 'terms.html') && stored(w, 'terms.html').text === 'page /terms.html');
  }

  // B18. /diagnostics, which Pages also serves, is left to the network like /diagnostics.html.
  {
    const w = load('app/sw.js', APP, () => res(200, { text: 'live health check' }));
    const r = await navigate(w, 'diagnostics');
    check('B18 app: /diagnostics goes straight to the network', r === 'not handled', r);
    check('B18 app: /diagnostics is never stored', !stored(w, 'diagnostics'));
  }

  // B19. A stored redirect answers navigations only; a script fetch of the same address goes to the network.
  {
    let net = () => res(0, { type: 'opaqueredirect', text: '' });
    const w = load('app/sw.js', APP, (u) => net(u));
    await navigate(w, 'nsw26');
    net = () => res(200, { text: 'from network' });
    const r = await get(w, 'nsw26');
    check('B19 app: a fetch() of an address with a stored redirect is not given the redirect', r && r.type === 'basic' && r.text === 'from network', r);
  }

  if (failures) { console.error(failures + ' check(s) failed, ' + passes + ' passed.'); process.exitCode = 1; }
  else console.log('All ' + passes + ' service worker checks passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
