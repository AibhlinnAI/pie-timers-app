#!/usr/bin/env node
/* ============================================================
   Smoke test — does every script actually LOAD?

   Written after a refactor removed two functions the boot block
   still called. `node --check` passed on every file, because an
   undefined function reference is valid syntax; the failure only
   happens when the line runs. supabase.js threw on load, never
   reached its last two lines, and shipped with neither CT.auth
   nor CT.db assigned -- the whole data layer silently absent, for
   the ten minutes it took a max-age=600 cache to expire.

   So this runs each script in order, in a stubbed browser, and
   asserts the globals it is supposed to leave behind. It proves
   the file executes and exports; it proves nothing about what the
   exports then do. That is the point -- it is the cheapest check
   that would have caught the worst deploy of the day.

   Run: node tools/smoke.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* Loaded in the order index.html loads them, because that order is
   load-bearing: identity-bridge.js runs before supabase.js exists,
   and each file may depend on what the ones before it left behind. */
const SCRIPTS = [
  ['identity/identity.js',      ['Aibhlinn.identity']],
  ['identity/entitlements.js',  ['Aibhlinn.entitlements']],
  ['identity/identity-ui.js',   ['Aibhlinn.identityUI']],
  ['app/config.js',             ['CT.config']],
  ['app/identity-bridge.js',    ['CT.entitlements']],
  ['app/supabase.js',           ['CT.auth', 'CT.db']],
  ['app/billing.js',            ['CT.turnstile', 'CT.billing']],
  ['app/notify.js',             ['CT.notify']],
  ['app/sync.js',               ['CT.sync']],
];

/* A DOM stub that says yes to everything. Deliberately shallow: the
   goal is to let module bodies run to completion, not to simulate a
   browser. Anything that needs a real DOM belongs in a browser test. */
function makeElement() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false, textContent: '', value: '', innerHTML: '', checked: false,
    children: [], childElementCount: 0, firstElementChild: null, isConnected: true,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => makeElement(), querySelectorAll: () => [],
    closest: () => null, focus() {}, click() {}, remove() {}, insertBefore() {},
  };
  return el;
}

function makeSandbox() {
  const doc = {
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
    hidden: false,
    readyState: 'loading',
    createElement: () => makeElement(),
    getElementById: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };

  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const win = {
    document: doc,
    localStorage: storage,
    sessionStorage: storage,
    location: { origin: 'https://pietimers.aibhlinn.ai', pathname: '/', search: '', hash: '', href: 'https://pietimers.aibhlinn.ai/', assign() {}, replace() {}, reload() {} },
    history: { replaceState() {} },
    navigator: { onLine: true, userAgent: 'smoke', serviceWorker: { register: () => Promise.resolve({}), ready: Promise.resolve({}), getRegistrations: () => Promise.resolve([]) } },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Promise, URLSearchParams, Intl, Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    crypto: { getRandomValues: (a) => a, randomUUID: () => 'smoke-uuid' },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Notification: { permission: 'default', requestPermission: () => Promise.resolve('default') },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  return win;
}

function resolve(sandbox, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), sandbox);
}

const sandbox = makeSandbox();
vm.createContext(sandbox);

let failures = 0;

for (const [file, exports] of SCRIPTS) {
  const full = path.join(ROOT, file);
  let source;
  try {
    source = fs.readFileSync(full, 'utf8');
  } catch (err) {
    console.error(`FAIL  ${file} — cannot read (${err.message})`);
    failures++;
    continue;
  }

  try {
    vm.runInContext(source, sandbox, { filename: file });
  } catch (err) {
    console.error(`FAIL  ${file} — threw on load: ${err.message}`);
    failures++;
    continue;
  }

  const missing = exports.filter((name) => resolve(sandbox, name) == null);
  if (missing.length) {
    console.error(`FAIL  ${file} — loaded but did not define: ${missing.join(', ')}`);
    failures++;
    continue;
  }

  console.log(`ok    ${file}${exports.length ? '  →  ' + exports.join(', ') : ''}`);
}

/* The methods the rest of the app calls on CT.auth. Listed explicitly
   because the facade delegates to identity: a rename on either side
   leaves a property that is simply undefined, and undefined is exactly
   what "signed out" looks like from a call site. */
const AUTH_METHODS = [
  'signInWithEmail', 'signInWithGoogle', 'connectGoogleCalendar',
  'wasConnectingGoogle', 'signOut', 'loadUser', 'deleteAccount',
  'consumeRedirect', 'getSession', 'getUser', 'isSignedIn',
  'validToken', 'onChange',
];

const auth = resolve(sandbox, 'CT.auth');
if (auth) {
  const missing = AUTH_METHODS.filter((m) => typeof auth[m] !== 'function');
  if (missing.length) {
    console.error(`FAIL  CT.auth is missing: ${missing.join(', ')}`);
    failures++;
  } else {
    console.log(`ok    CT.auth  →  ${AUTH_METHODS.length} methods`);
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll scripts load and export what they should.');
