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
  syncChecks();
  functionChecks();
  console.log('\n' + (failed ? failed + ' of ' + count + ' FAILED' : 'All ' + count + ' push gate checks passed'));
  process.exit(failed ? 1 : 0);
}()).catch(function (err) {
  console.error(err);
  process.exit(1);
});
