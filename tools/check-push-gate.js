#!/usr/bin/env node
/* ============================================================
   Push gate check: does Background alerts (settings.push) really
   decide whether alerts arrive while the app is closed?

   Until v136 the switch gated nothing. A device subscribed to push
   whatever it said, sync.js subscribed again after every pull, and
   notify-milestones sent to every account with Milestone alerts on.
   Three places have to agree for the switch to mean what it says,
   and this holds each of them to it:

   1. app/notify.js: refreshSubscription() subscribes only while the
      switch is on. Run for real, in a stubbed browser.
   2. app/sync.js: nothing subscribes except through
      followPushSetting(), which reads the switch. Read as text: this
      proves the calls are wired that way, not what a pull then does.
   3. supabase/functions/notify-milestones/index.ts: wantsPush() needs
      Milestone alerts and Background alerts both on, and run() asks
      it. The function is lifted out of the file and run.

   It checks the files in the repo. It cannot see what is deployed:
   the edge function only changes when it is deployed (CLAUDE.md).

   Run: node tools/check-push-gate.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
let count = 0;
function check(name, ok, detail) {
  count++;
  if (ok) { console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

/* ─────────────────────────── 1. notify.js ─────────────────────────── */

/* One stubbed browser: push is supported, notifications are allowed,
   someone is signed in. Only the switch varies, unless a test says so. */
function browser(opts) {
  const calls = { subscribed: 0, saved: 0, removed: [], unsubscribed: 0 };
  let current = opts.existing ? makeSub() : null;

  function makeSub() {
    return {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: () => { calls.unsubscribed++; current = null; return Promise.resolve(true); },
    };
  }

  const reg = {
    pushManager: {
      getSubscription: () => Promise.resolve(current),
      subscribe: () => { calls.subscribed++; current = makeSub(); return Promise.resolve(current); },
    },
  };

  const state = { settings: { alerts: true, push: opts.push } };
  const win = {
    PushManager: function () {},
    Notification: { permission: opts.permission || 'granted' },
    navigator: { serviceWorker: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg) } },
    location: { protocol: 'https:', hostname: 'example.test', pathname: '/' },
    console: { warn() {} },
    Promise, Uint8Array, Intl, Date,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    CT: {
      config: { pushConfigured: true, vapidPublicKey: 'AAAA' },
      auth: { isSignedIn: () => opts.signedIn !== false },
      db: {
        savePushSubscription: () => { calls.saved++; return Promise.resolve(); },
        removePushSubscription: (endpoint) => { calls.removed.push(endpoint); return Promise.resolve(); },
      },
      app: { getState: () => state },
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('app/notify.js'), win, { filename: 'notify.js' });
  return { notify: win.CT.notify, calls, state };
}

async function notifyChecks() {
  console.log('\napp/notify.js');

  let b = browser({ push: false });
  let sub = await b.notify.refreshSubscription();
  check('N1 switch off: refreshSubscription() does not subscribe',
    sub === null && b.calls.subscribed === 0 && b.calls.saved === 0, b.calls);

  b = browser({ push: undefined });
  sub = await b.notify.refreshSubscription();
  check('N2 switch never touched: off, so it does not subscribe',
    sub === null && b.calls.subscribed === 0 && b.calls.saved === 0, b.calls);

  b = browser({ push: true });
  sub = await b.notify.refreshSubscription();
  check('N3 switch on: it subscribes and saves the subscription',
    !!sub && b.calls.subscribed === 1 && b.calls.saved === 1, b.calls);

  b = browser({ push: false, existing: true });
  sub = await b.notify.refreshSubscription();
  check('N4 switch off with a subscription left from before v136: it is not saved again',
    sub === null && b.calls.saved === 0, b.calls);

  b = browser({ push: true, permission: 'denied' });
  sub = await b.notify.refreshSubscription();
  check('N5 switch on, notifications blocked: still does not subscribe',
    sub === null && b.calls.subscribed === 0, b.calls);

  b = browser({ push: true, signedIn: false });
  sub = await b.notify.refreshSubscription();
  check('N6 switch on, signed out: still does not subscribe',
    sub === null && b.calls.subscribed === 0, b.calls);

  b = browser({ push: false, existing: true });
  await b.notify.unsubscribe();
  check('N7 unsubscribe() drops the subscription and removes this device\'s row',
    b.calls.unsubscribed === 1 && b.calls.removed.length === 1 &&
    b.calls.removed[0] === 'https://push.example/abc', b.calls);

  /* The switch is read at the moment of the call, not when the file loads. */
  b = browser({ push: false });
  b.state.settings.push = true;
  sub = await b.notify.refreshSubscription();
  check('N8 the switch is read afresh on each call', !!sub && b.calls.subscribed === 1, b.calls);
}

/* ─────────────────────────── 1b. notify.js in the Android app ─────────────────────────── */

/* The Play app from release 7: no PushManager and no Notification, and a
   bridge object in their place (android/.../MainActivity.java). The same
   switch has to decide there too. */
function androidApp(opts) {
  const calls = { saved: [], removed: [], shown: [], requested: 0, tokenAsked: 0 };
  const store = new Map(Object.entries(opts.stored || {}));
  let allowed = !!opts.allowed;
  const state = { settings: { alerts: true, push: opts.push } };

  const win = {
    navigator: { serviceWorker: { register: () => Promise.reject(new Error('unused')), ready: new Promise(() => {}) } },
    location: { protocol: 'https:', hostname: 'pietimers.aibhlinn.ai', pathname: '/' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    console: { warn() {} },
    Promise, Intl, Date, String,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 20)),
    CT: {
      config: { isConfigured: true, pushConfigured: false },
      auth: { isSignedIn: () => opts.signedIn !== false },
      db: {
        savePushSubscription: (sub, tz) => { calls.saved.push({ endpoint: sub.endpoint, keys: sub.keys, tz }); return Promise.resolve(); },
        removePushSubscription: (endpoint) => { calls.removed.push(endpoint); return Promise.resolve(); },
      },
      app: { getState: () => state },
    },
  };
  const answer = () => setTimeout(() => win.PieTimersPushResult({
    permission: allowed ? 'granted' : 'denied', token: allowed ? (opts.token === undefined ? 'tok-1' : opts.token) : null,
  }), 0);
  win.PieTimersAndroidPush = {
    permission: () => (allowed ? 'granted' : 'denied'),
    request: () => { calls.requested++; if (opts.grantsWhenAsked) allowed = true; answer(); },
    token: () => { calls.tokenAsked++; if (!opts.silent) answer(); },
    show: (title, body, tag) => { calls.shown.push({ title, body, tag }); },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('app/notify.js'), win, { filename: 'notify.js' });
  return { notify: win.CT.notify, calls, state, store };
}

async function androidChecks() {
  console.log('\napp/notify.js, in the Android app');
  const ENDPOINT_KEY = 'countdown-timers/phone-alerts-endpoint';

  let a = androidApp({ push: true, allowed: true });
  check('A1 the bridge makes push supported', a.notify.nativePush === true && a.notify.pushSupported === true);

  let sub = await a.notify.refreshSubscription();
  check('A2 switch on, allowed: the token is saved as "fcm:<token>" with no keys',
    !!sub && a.calls.saved.length === 1 && a.calls.saved[0].endpoint === 'fcm:tok-1' &&
    JSON.stringify(a.calls.saved[0].keys) === '{}', a.calls.saved);
  check('A3 and the endpoint is remembered for switching off', a.store.get(ENDPOINT_KEY) === 'fcm:tok-1');

  a = androidApp({ push: false, allowed: true });
  sub = await a.notify.refreshSubscription();
  check('A4 switch off: the app is not even asked for its token',
    sub === null && a.calls.tokenAsked === 0 && a.calls.saved.length === 0, a.calls);

  a = androidApp({ push: true, allowed: false });
  sub = await a.notify.refreshSubscription();
  check('A5 switch on, notifications not allowed: nothing is saved',
    sub === null && a.calls.tokenAsked === 0 && a.calls.saved.length === 0, a.calls);

  a = androidApp({ push: true, allowed: true, signedIn: false });
  sub = await a.notify.refreshSubscription();
  check('A6 switch on, signed out: nothing is saved', sub === null && a.calls.saved.length === 0, a.calls);

  a = androidApp({ push: true, allowed: true, token: null });
  sub = await a.notify.refreshSubscription();
  check('A7 Firebase gives no token: nothing is saved', sub === null && a.calls.saved.length === 0, a.calls);

  a = androidApp({ push: true, allowed: true, silent: true });
  sub = await a.notify.refreshSubscription();
  check('A8 the app never answers: gives up, saves nothing', sub === null && a.calls.saved.length === 0, a.calls);

  a = androidApp({ push: true, allowed: true, token: 'tok-2', stored: { [ENDPOINT_KEY]: 'fcm:tok-1' } });
  await a.notify.refreshSubscription();
  check('A9 a replaced token: the new one is saved and the old row removed',
    a.calls.saved[0] && a.calls.saved[0].endpoint === 'fcm:tok-2' &&
    a.calls.removed.length === 1 && a.calls.removed[0] === 'fcm:tok-1', a.calls);

  a = androidApp({ push: false, allowed: true, stored: { [ENDPOINT_KEY]: 'fcm:tok-1' } });
  await a.notify.unsubscribe();
  check('A10 unsubscribe() removes this phone\'s row and forgets it',
    a.calls.removed.length === 1 && a.calls.removed[0] === 'fcm:tok-1' && !a.store.has(ENDPOINT_KEY), a.calls);

  a = androidApp({ push: false, allowed: true });
  await a.notify.unsubscribe();
  check('A11 unsubscribe() with nothing registered does nothing', a.calls.removed.length === 0, a.calls);

  a = androidApp({ push: true, allowed: false });
  check('A12 never asked: permission reads "default", not "denied"', a.notify.permission() === 'default', a.notify.permission());
  let answer = await a.notify.requestPermission();
  check('A13 asked and refused: "denied", and it stays that way',
    answer === 'denied' && a.calls.requested === 1 && a.notify.permission() === 'denied', answer);

  a = androidApp({ push: true, allowed: false, grantsWhenAsked: true });
  answer = await a.notify.requestPermission();
  check('A14 asked and allowed: "granted"', answer === 'granted' && a.notify.permission() === 'granted', answer);

  a = androidApp({ push: true, allowed: true });
  answer = await a.notify.requestPermission();
  check('A15 already allowed: no prompt', answer === 'granted' && a.calls.requested === 0, a.calls);

  const shown = await a.notify.show('End of Day', '5 minutes remaining.', '2026-11-18|end|5');
  check('A16 show() hands the alert and its tag to the app',
    shown === true && a.calls.shown.length === 1 && a.calls.shown[0].tag === '2026-11-18|end|5', a.calls.shown);

  a = androidApp({ push: true, allowed: false });
  const hidden = await a.notify.show('End of Day', '5 minutes remaining.', 't');
  check('A17 show() does nothing while notifications are not allowed', hidden === false && a.calls.shown.length === 0);
}

/* ─────────────────────────── 2. sync.js ─────────────────────────── */

function syncChecks() {
  console.log('\napp/sync.js');
  const src = read('app/sync.js');

  const follow = /function followPushSetting\(\) \{[\s\S]*?\n  \}/.exec(src);
  check('S1 followPushSetting() exists', !!follow);
  const body = follow ? follow[0] : '';

  check('S2 it subscribes when the switch is on and unsubscribes when it is off',
    /getState\(\)\.settings\.push\s*\?\s*CT\.notify\.refreshSubscription\(\)\s*:\s*CT\.notify\.unsubscribe\(\)/.test(body));

  const direct = src.split('CT.notify.refreshSubscription').length - 1;
  check('S3 nothing else in sync.js subscribes (one mention of refreshSubscription, inside it)',
    direct === 1 && body.indexOf('CT.notify.refreshSubscription') !== -1, direct);

  const afterPull = src.split('.then(followPushAfterPull)').length - 1;
  check('S4 both start-up pulls are followed by followPushAfterPull', afterPull === 2, afterPull);

  check('S5 a pull that changes the switch is followed at once',
    /settings\.push !== pushWas\) followPushSetting\(\)/.test(src));
}

/* ─────────────────────────── 3. notify-milestones ─────────────────────────── */

function functionChecks() {
  console.log('\nsupabase/functions/notify-milestones/index.ts');
  const src = read('supabase/functions/notify-milestones/index.ts');

  const found = /function wantsPush\(settings[^)]*\)\s*\{([\s\S]*?)\r?\n\}/.exec(src);
  check('F1 wantsPush() exists', !!found);
  if (!found) return;

  /* The body has no type syntax, so it runs as it ships. */
  const wantsPush = new Function('settings', found[1]);
  const cases = [
    [{ alerts: true, push: true }, true, 'both on'],
    [{ alerts: true, push: false }, false, 'Background alerts off'],
    [{ alerts: true }, false, 'Background alerts never touched'],
    [{ alerts: false, push: true }, false, 'Milestone alerts off'],
    [{ alerts: true, push: 'true' }, false, 'a string is not on'],
    [{ alerts: true, push: 1 }, false, 'a number is not on'],
    [null, false, 'no settings'],
    [undefined, false, 'settings missing'],
  ];
  cases.forEach(function (c, i) {
    let got;
    try { got = wantsPush(c[0]); } catch (e) { got = 'threw: ' + e.message; }
    check('F' + (i + 2) + ' ' + c[2] + ': ' + (c[1] ? 'sends' : 'does not send'), got === c[1], got);
  });

  check('F10 run() asks wantsPush() before sending',
    /if \(!profile \|\| !wantsPush\(profile\.settings\)\) continue;/.test(src));
  check('F11 run() no longer decides on Milestone alerts alone',
    !/!profile\.settings\?\.alerts\) continue;/.test(src));
}

/* ─────────────────────────── Run ─────────────────────────── */

(async function () {
  await notifyChecks();
  await androidChecks();
  syncChecks();
  functionChecks();
  console.log('\n' + (failed ? failed + ' of ' + count + ' FAILED' : 'All ' + count + ' push gate checks passed'));
  process.exit(failed ? 1 : 0);
}()).catch(function (err) {
  console.error(err);
  process.exit(1);
});
