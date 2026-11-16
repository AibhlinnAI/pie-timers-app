#!/usr/bin/env node
/* ============================================================
   notify-milestones: who gets sent what, once the alerts are due.

   tools/shift-alerts-sim.js and tools/breaks-sim.js hold dueAlerts()
   to the app's own timing. This is the other half: run(), the loop
   that claims a milestone and sends it. It was rebuilt in November
   2026 for the Android app, and two things about it are easy to
   break without noticing:

   - Every device of an account gets the alert. The old loop claimed
     each milestone per account and so sent to one device only.
   - An Android device (endpoint "fcm:<token>") goes out through
     Firebase Cloud Messaging, and nothing about Firebase (no secret,
     a bad secret, a dead token, Google refusing) costs a browser its
     push.

   index.ts, fcm.ts and webpush.ts run for real under Node's type
   stripping, with Deno and the network stubbed. The keys are made
   here on each run and belong to nothing. Nothing is deployed.

   Run: node --experimental-strip-types tools/notify-run-test.mjs
   ============================================================ */
import crypto from 'node:crypto';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* ─────────────────────────── Keys ─────────────────────────── */

/* A VAPID pair and one browser's subscription keys, real enough for
   webpush.ts to sign and encrypt with. */
const vapid = crypto.createECDH('prime256v1'); vapid.generateKeys();
const browser = crypto.createECDH('prime256v1'); browser.generateKeys();
const BROWSER_KEYS = { p256dh: b64url(browser.getPublicKey()), auth: b64url(crypto.randomBytes(16)) };

/* A service account key of the shape Firebase hands out. */
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'pie-timers-test',
  client_email: 'sender@pie-timers-test.iam.gserviceaccount.com',
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

const BASE_ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  VAPID_PUBLIC_KEY: b64url(vapid.getPublicKey()),
  VAPID_PRIVATE_KEY: b64url(vapid.getPrivateKey()),
  VAPID_SUBJECT: 'mailto:test@example.test',
  CRON_SECRET: 'cron-secret',
};

/* ─────────────────────────── A schedule that is due now ─────────────────────────── */

/* Working every day, started an hour ago, End of Day five minutes from
   now: exactly one alert is due, "end" at 5 minutes. A zone is chosen
   where that hour does not straddle midnight. */
function dueNow() {
  for (const zone of ['UTC', 'Asia/Tokyo', 'America/Denver']) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date());
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    const minutes = (get('hour') % 24) * 60 + get('minute');
    if (minutes < 70 || minutes > 1430) continue;
    const day = { working: true, start: minutes - 60, lunch: null, end: minutes + 5 };
    const schedule = {};
    for (const name of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) schedule[name] = day;
    return { zone, schedule };
  }
  throw new Error('no usable timezone');
}

/* The schedule is read against the minute the function runs in, so a
   run must not start in the last seconds of one. */
async function awayFromTheMinuteEdge() {
  const seconds = new Date().getSeconds();
  if (seconds >= 50) await new Promise((r) => setTimeout(r, (61 - seconds) * 1000));
}

/* ─────────────────────────── Harness ─────────────────────────── */

const ENV = {};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

const realConsole = { error: console.error, log: console.log, warn: console.warn };
let logged = [];

let world = null;   // the scenario: rows, and how the outside world answers
let calls = [];

const reply = (status, body) => new Response(
  body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  { status, headers: { 'Content-Type': 'application/json' } },
);

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const call = { url, method, headers: init.headers || {}, body: init.body };
  calls.push(call);
  const u = new URL(url);

  if (u.host === 'proj.supabase.co') {
    if (u.pathname === '/rest/v1/push_subscriptions' && method === 'GET') return reply(200, world.subscriptions);
    if (u.pathname === '/rest/v1/push_subscriptions' && method === 'DELETE') {
      world.deleted.push(u.searchParams.get('id'));
      return reply(200, '');
    }
    if (u.pathname === '/rest/v1/timer_profiles') return reply(200, world.profiles);
    if (u.pathname === '/rest/v1/notification_log') {
      const row = JSON.parse(init.body);
      const key = [row.user_id, row.day, row.timer_key, row.milestone].join('|');
      if (world.claims.includes(key)) return reply(409, { message: 'duplicate key' });
      world.claims.push(key);
      return reply(201, '');
    }
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    world.tokenRequests.push(new URLSearchParams(init.body).get('assertion'));
    return world.tokenStatus === 200
      ? reply(200, { access_token: 'access-' + world.tokenRequests.length, expires_in: 3600 })
      : reply(world.tokenStatus, { error: 'invalid_grant' });
  }
  if (u.host === 'fcm.googleapis.com') {
    const message = JSON.parse(init.body).message;
    world.fcm.push({ path: u.pathname, authorization: call.headers.Authorization, message });
    const status = world.fcmStatus[message.token] || 200;
    return reply(status, status === 200 ? { name: 'projects/x/messages/1' } : { error: { status: 'NOT_FOUND' } });
  }
  if (u.host.endsWith('push.example')) {
    if (world.browserThrows.includes(u.host)) throw new Error('network down');
    world.webPush.push({ url, headers: call.headers, bytes: init.body.length });
    return reply(world.browserStatus[u.host] || 201, '');
  }
  throw new Error('unexpected fetch: ' + method + ' ' + url);
};

/* Module-level constants read the environment at load, so each run
   gets its own evaluation of index.ts. fcm.ts and webpush.ts load once. */
let loads = 0;
async function runWith(env, setUp) {
  await awayFromTheMinuteEdge();
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, BASE_ENV, env);

  const { zone, schedule } = dueNow();
  world = {
    zone, subscriptions: [], profiles: [], claims: [], deleted: [],
    tokenRequests: [], tokenStatus: 200, fcm: [], fcmStatus: {},
    webPush: [], browserStatus: {}, browserThrows: [],
  };
  const profile = (userId, settings) => world.profiles.push({ user_id: userId, schedule, settings, breaks: null });
  const device = (id, userId, endpoint, timezone) => world.subscriptions.push({
    id, user_id: userId, endpoint, timezone: timezone || zone,
    keys: endpoint.startsWith('fcm:') ? {} : BROWSER_KEYS,
  });
  setUp({ profile, device, world });

  calls = [];
  logged = [];
  console.error = (...a) => logged.push(a.map(String).join(' '));
  console.log = console.warn = () => {};
  handler = null;
  try {
    await import('../supabase/functions/notify-milestones/index.ts?load=' + (++loads));
    const response = await handler(new Request('https://proj.supabase.co/functions/v1/notify-milestones', {
      method: 'POST', headers: { 'x-cron-secret': 'cron-secret' },
    }));
    return { status: response.status, body: await response.json(), world, logged };
  } finally {
    Object.assign(console, realConsole);
  }
}

const ON = { alerts: true, push: true };
const ANNA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const PC = 'https://pc.push.example/sub/1';
const LAPTOP = 'https://laptop.push.example/sub/2';
const PHONE = 'fcm:phone-token-abc';

/* ─────────────────────────── The checks ─────────────────────────── */

/* 1. A computer, a laptop and the Android app on one account. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device }) => {
    profile(ANNA, ON);
    device('d1', ANNA, PC); device('d2', ANNA, LAPTOP); device('d3', ANNA, PHONE);
  });
  check('R1 the run succeeds', r.status === 200 && r.body.ok === true, r.body);
  check('R2 one claim for the one milestone, not one per device', r.world.claims.length === 1, r.world.claims);
  check('R3 both browsers are sent the alert', r.world.webPush.length === 2, r.world.webPush.map((w) => w.url));
  check('R4 the Android app is sent it too', r.world.fcm.length === 1, r.world.fcm);
  check('R5 the summary counts all three', r.body.sent === 3 && r.body.checked === 3, r.body);

  const sent = r.world.fcm[0] || { message: {} };
  const tag = (r.world.claims[0] || '').split('|').slice(1).join('|');
  check('R6 FCM: sent to the project in the secret', sent.path === '/v1/projects/pie-timers-test/messages:send', sent.path);
  check('R7 FCM: to the token, without the "fcm:" prefix', sent.message.token === 'phone-token-abc', sent.message.token);
  check('R8 FCM: a data message carrying title, body and the in-app tag',
    sent.message.data && sent.message.data.title === 'End of Day' &&
    sent.message.data.body === '5 minutes remaining.' && sent.message.data.tag === tag && tag.endsWith('|end|5'),
    sent.message.data);
  check('R9 FCM: no "notification" part, so the app builds its own', sent.message.notification === undefined);
  check('R10 FCM: high priority and a short life', sent.message.android &&
    sent.message.android.priority === 'HIGH' && sent.message.android.ttl === '240s', sent.message.android);
  check('R11 FCM: authorised with the access token Google returned', sent.authorization === 'Bearer access-1', sent.authorization);

  /* The JWT that bought the access token: signed by the service account. */
  const jwt = (r.world.tokenRequests[0] || '..').split('.');
  let claims = {};
  try { claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString()); } catch (e) { /* checked below */ }
  const verified = jwt.length === 3 && crypto.verify('RSA-SHA256', Buffer.from(jwt[0] + '.' + jwt[1]),
    rsa.publicKey, Buffer.from(jwt[2], 'base64url'));
  check('R12 FCM: the token request is signed with the service account key', verified);
  check('R13 FCM: it names the account, the messaging scope and Google\'s token address',
    claims.iss === 'sender@pie-timers-test.iam.gserviceaccount.com' &&
    claims.scope === 'https://www.googleapis.com/auth/firebase.messaging' &&
    claims.aud === 'https://oauth2.googleapis.com/token' && claims.exp - claims.iat === 3600, claims);
}

/* 2. The access token is kept between runs. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device }) => {
    profile(ANNA, ON); device('d3', ANNA, PHONE);
  });
  check('R14 a second run reuses the access token', r.world.tokenRequests.length === 0 && r.world.fcm.length === 1,
    { tokenRequests: r.world.tokenRequests.length, fcm: r.world.fcm.length });
}

/* 3. No Firebase secret yet: browsers carry on, the phone waits. */
{
  const r = await runWith({}, ({ profile, device }) => {
    profile(ANNA, ON); device('d1', ANNA, PC); device('d3', ANNA, PHONE);
    profile(BEN, ON); device('d4', BEN, 'fcm:ben-phone');
  });
  check('R15 no secret: the browser is still sent', r.world.webPush.length === 1 && r.body.ok === true, r.body);
  check('R16 no secret: nothing goes to Firebase', r.world.fcm.length === 0 && r.world.tokenRequests.length === 0);
  check('R17 no secret: an account with only a phone claims nothing, so nothing is used up',
    r.world.claims.length === 1 && r.world.claims[0].startsWith(ANNA), r.world.claims);
  check('R18 no secret: the log says so', r.logged.some((l) => l.includes('FCM_SERVICE_ACCOUNT')), r.logged);
}

/* 4. A secret that is not a service account key reads as no secret. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: 'not json' }, ({ profile, device }) => {
    profile(ANNA, ON); device('d1', ANNA, PC); device('d3', ANNA, PHONE);
  });
  check('R19 a bad secret: the browser is still sent and Firebase is left alone',
    r.body.ok === true && r.world.webPush.length === 1 && r.world.fcm.length === 0, r.body);
}

/* 5. The switches still decide (Part 1). */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device }) => {
    profile(ANNA, { alerts: true, push: false }); device('d1', ANNA, PC); device('d3', ANNA, PHONE);
    profile(BEN, { alerts: false, push: true }); device('d4', BEN, 'fcm:ben-phone');
  });
  check('R20 Background alerts off, or Milestone alerts off: nothing claimed, nothing sent',
    r.world.claims.length === 0 && r.world.webPush.length === 0 && r.world.fcm.length === 0,
    { claims: r.world.claims, fcm: r.world.fcm.length });
}

/* 6. A token Google no longer knows is removed; the browser is unaffected. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device, world }) => {
    profile(ANNA, ON); device('d3', ANNA, PHONE); device('d1', ANNA, PC);
    world.fcmStatus['phone-token-abc'] = 404;
  });
  check('R21 a dead token: its row is deleted', r.world.deleted.length === 1 && r.world.deleted[0] === 'eq.d3', r.world.deleted);
  check('R22 a dead token: the browser after it is still sent', r.world.webPush.length === 1 && r.body.sent === 1, r.body);
}

/* 7. Google refusing for another reason deletes nothing. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device, world }) => {
    profile(ANNA, ON); device('d3', ANNA, PHONE); device('d1', ANNA, PC);
    world.fcmStatus['phone-token-abc'] = 400;
  });
  check('R23 a 400 from Firebase: the row stays, the browser is still sent',
    r.world.deleted.length === 0 && r.world.webPush.length === 1 && r.body.sent === 1, r.body);
}

/* 8. One device failing outright does not cost the others. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device, world }) => {
    profile(ANNA, ON); device('d1', ANNA, PC); device('d2', ANNA, LAPTOP); device('d3', ANNA, PHONE);
    world.browserThrows.push('pc.push.example');
  });
  check('R24 a browser whose send throws: the laptop and the phone are still sent',
    r.body.ok === true && r.world.webPush.length === 1 && r.world.fcm.length === 1 && r.body.sent === 2, r.body);
}

/* 9. A browser that dropped its subscription is still tidied away. */
{
  const r = await runWith({}, ({ profile, device, world }) => {
    profile(ANNA, ON); device('d1', ANNA, PC); device('d2', ANNA, LAPTOP);
    world.browserStatus['pc.push.example'] = 410;
  });
  check('R25 a 410 from a browser: its row is deleted, the other is sent',
    r.world.deleted.length === 1 && r.world.deleted[0] === 'eq.d1' && r.body.sent === 1, r.body);
}

/* 10. Two accounts do not share a claim. */
{
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device }) => {
    profile(ANNA, ON); device('d1', ANNA, PC);
    profile(BEN, ON); device('d4', BEN, 'fcm:ben-phone');
  });
  check('R26 two accounts: a claim each, a send each',
    r.world.claims.length === 2 && r.world.webPush.length === 1 && r.world.fcm.length === 1, r.world.claims);
}

/* 11. A milestone already claimed by an earlier run is not sent again. */
{
  let first;
  const r = await runWith({ FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT }, ({ profile, device, world }) => {
    profile(ANNA, ON); device('d1', ANNA, PC); device('d3', ANNA, PHONE);
    first = world;
  });
  const before = { web: first.webPush.length, fcm: first.fcm.length };
  /* The same world again: the claim is already there. */
  calls = [];
  console.error = () => {};
  try {
    await handler(new Request('https://proj.supabase.co/functions/v1/notify-milestones', {
      method: 'POST', headers: { 'x-cron-secret': 'cron-secret' },
    }));
  } finally { Object.assign(console, realConsole); }
  check('R27 a second run in the same minute sends nothing more',
    before.web === 1 && before.fcm === 1 && r.world.webPush.length === 1 && r.world.fcm.length === 1,
    { before, after: { web: r.world.webPush.length, fcm: r.world.fcm.length } });
}

/* 12. Still closed without the cron secret. */
{
  await runWith({}, () => {});
  const response = await handler(new Request('https://proj.supabase.co/functions/v1/notify-milestones', { method: 'POST' }));
  check('R28 no cron secret in the request: 403', response.status === 403, response.status);
}

console.log(failed
  ? failed + ' of ' + (passed + failed) + ' notify-milestones run checks FAILED'
  : 'All ' + passed + ' notify-milestones run checks passed');
process.exit(failed ? 1 : 0);
