#!/usr/bin/env node
/* ============================================================
   Foundation cap tests -- the wiring around the 100 Foundation
   places: paddle-webhook's claim, the shape of the SQL file that
   holds the cap, and the two pages that show how many are left.

   Mal, 22 Nov 2026: "100 is 100." The number itself is held by the
   database (supabase/schema-foundation.sql: place is unique and must
   be 1 to 100). Nothing here can prove that, because nothing here
   runs SQL. What this file holds is everything around it:

   1. paddle-webhook claims a place only for subscription.created,
      only after the signature has passed and the subscriptions row is
      written, passes on the instant Paddle says the subscription was
      made, and answers 500 without recording the event when the claim
      fails, so Paddle retries. Premium and the billing date are
      written either way. A first-payment date that should have been
      moved and was not is treated the same way: Premium is written,
      the event is not recorded, and the answer is 500.
   2. The SQL file still has the constraints, the lock, the revokes
      and the two grants, and its dates match the function's and the
      pages'.
   3. The pages show a number or say "open" only after a fresh,
      well-formed answer, say nothing they cannot know, and do none of
      it inside the Google Play app.
   4. create-checkout (part C) gives someone who subscribes while
      their free trial is running a Paddle transaction with the right
      number of whole free days on it, decided on the server from the
      account's own row, so checkout shows the right first-payment day
      itself. It never hands out a transaction it has not checked, and
      never one for an account that is not in its own free trial.
      billing.js (P22) asks it only on that path, and never falls back
      to a catalogue price when it fails.
   5. expire-checkouts (part E) cancels the prepared purchases that
      create-checkout made and nobody paid for within an hour, and
      nothing else: never one that is billed, paid or completed, never
      one made any other way, never one younger than 60 minutes to the
      second. It is closed without the cron secret, sends Paddle one
      body only, and names no account or transaction in its log or its
      answer. A run that leaves old unpaid ones open, for a reason
      other than somebody paying, is a fault and never a healthy line.
      supabase/schema-expire-checkouts.sql is read as text.

   Each index.ts runs for real under Node's type stripping, with Deno
   and fetch stubbed, the way tools/review-signin-test.mjs does it. The
   real signature check runs: every delivery here is signed with the
   test secret. The pages' shared block runs in a vm sandbox with
   fetch answered in-process. Nothing touches the network, a database
   or Paddle.

   The secrets below are test values and are made not to look like
   real ones (deploy.yml refuses anything that does). The account ids
   are made up.

   The first real test of the SQL itself is supabase/test-foundation.sql,
   which the owner runs in the SQL editor and which rolls itself back.

   Run: node --experimental-strip-types tools/foundation-test.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Line endings made LF, as tools/check-visits.js does: a Windows
   checkout has CRLF and the checks below work line by line. */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

const USER_ID = '3c1d7e52-8a4b-4f60-9b2e-5d6f7a8b9c0d';
const USER_EMAIL = 'someone@example.test';
const SUB_ID = 'sub_test_1';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'publishable-test-key',
  PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PADDLE_API_KEY: 'test-paddle-key',
  /* Read by expire-checkouts alone (part E). */
  CRON_SECRET: 'test-cron-secret',
};

const at = (iso) => Date.parse(iso);
/* Foundation, and the Black Friday Launch Offer as a whole, run from the
   start of 22 Nov 2026 in Adelaide to the end of 31 Dec 2026 in the
   last time zone on Earth (UTC-12), noon UTC on 1 Jan 2027: the same
   instant as the first payment. (The close was first the end of 5 Dec,
   then the end of 31 Dec in Adelaide; the owner moved it both times on
   22 Nov 2026, the second time so the pages need no "(Adelaide time)".) */
const CLOSES = at('2027-01-01T12:00:00Z');
/* The close before that one, Adelaide midnight. Nothing may still use it. */
const ADELAIDE_CLOSE = at('2027-01-01T00:00:00+10:30');
const OPENS = at('2026-11-22T00:00:00+10:30');
/* The one thing that still ends at the end of 5 Dec 2026: the free
   trial of an account made before 22 Nov. Nothing in this file may
   treat it as the offer's close. OLD_CLOSE is where the offer once
   closed (Adelaide midnight); TRIAL_FINISH is where those trials end
   now, the end of 5 Dec in the last time zone. */
const OLD_CLOSE = at('2026-12-06T00:00:00+10:30');
const TRIAL_FINISH = at('2026-12-06T12:00:00Z');
const TRIAL_BOUNDARY = at('2026-11-22T12:00:00Z');

/* ─────────────────────── Edge function harness ─────────────────────── */

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

let logs = [];
const captured = {
  log: (...a) => { logs.push(a.map(String).join(' ')); },
  warn: (...a) => { logs.push(a.map(String).join(' ')); },
  error: (...a) => { logs.push(a.map(String).join(' ')); },
};

let calls = [];
let route = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url);
  const call = { url, host: u.host, path: u.pathname, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body };
  calls.push(call);
  const answer = route && await route(call);
  if (!answer) throw new Error('unexpected fetch: ' + call.method + ' ' + url);
  return answer;
};

const reply = (status, body) => new Response(
  status === 204 || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const WEBHOOK_SOURCE = read('supabase/functions/paddle-webhook/index.ts');
const CHECKOUT_SOURCE = read('supabase/functions/create-checkout/index.ts');
/* Starts an edge function afresh, by its folder name. It reads its
   secrets once, as it loads. The file is wrapped in a function, so it
   must hold no `export`. */
function startFunction(name, source) {
  handler = null;
  const file = path.join(ROOT, 'supabase', 'functions', name, 'index.ts');
  vm.runInThisContext('(function (console) {\n' + stripTypeScriptTypes(source) + '\n})', { filename: file })(captured);
  if (typeof handler !== 'function') throw new Error(name + ' did not register a handler');
  return handler;
}
const webhook = startFunction('paddle-webhook', WEBHOOK_SOURCE);
const checkout = startFunction('create-checkout', CHECKOUT_SOURCE);
/* The same two functions, started with no PADDLE_API_KEY among their
   secrets. */
const PADDLE_KEY = ENV.PADDLE_API_KEY;
delete ENV.PADDLE_API_KEY;
const webhookNoKey = startFunction('paddle-webhook', WEBHOOK_SOURCE);
const checkoutNoKey = startFunction('create-checkout', CHECKOUT_SOURCE);
const EXPIRE_SOURCE = read('supabase/functions/expire-checkouts/index.ts');
const expireNoKey = startFunction('expire-checkouts', EXPIRE_SOURCE);
ENV.PADDLE_API_KEY = PADDLE_KEY;
/* expire-checkouts (part E): as deployed; with no CRON_SECRET among its
   secrets; and with the sandbox switch on. */
const expire = startFunction('expire-checkouts', EXPIRE_SOURCE);
const CRON_KEPT = ENV.CRON_SECRET;
delete ENV.CRON_SECRET;
const expireNoSecret = startFunction('expire-checkouts', EXPIRE_SOURCE);
ENV.CRON_SECRET = CRON_KEPT;
ENV.PADDLE_ENVIRONMENT = 'sandbox';
const expireSandbox = startFunction('expire-checkouts', EXPIRE_SOURCE);
delete ENV.PADDLE_ENVIRONMENT;

/* Paddle-Signature: ts=<seconds>;h1=<hex hmac of "ts:body">. Signed with
   the test secret, so the function's own signatureValid() runs. */
function sign(body, nowMs, secret = WEBHOOK_SECRET) {
  const ts = Math.floor(nowMs / 1000);
  const h1 = crypto.createHmac('sha256', secret).update(ts + ':' + body).digest('hex');
  return 'ts=' + ts + ';h1=' + h1;
}

/* Answers every call paddle-webhook makes when all is well. Each part
   can be swapped per case. */
function webhookRoute(over = {}) {
  route = async (c) => {
    const key = c.method + ' ' + c.path;
    if (c.host === 'proj.supabase.co') {
      if (key === 'GET /rest/v1/billing_events') return over.duplicate ? over.duplicate(c) : reply(200, []);
      if (key === 'POST /rest/v1/subscriptions') return over.upsert ? over.upsert(c) : reply(201);
      if (key === 'PATCH /rest/v1/subscriptions') return over.extend ? over.extend(c) : reply(204);
      if (key === 'GET /rest/v1/subscriptions') return over.account ? over.account(c) : reply(200, [{ created_at: over.accountCreatedAt || '2026-11-20T10:00:00+10:30' }]);
      if (key === 'POST /rest/v1/rpc/claim_foundation_place') return over.claim ? over.claim(c) : reply(200, { member: true, place: 37 });
      if (key === 'POST /rest/v1/rpc/grant_capability') return reply(204);
      if (key === 'POST /rest/v1/billing_events') return over.record ? over.record(c) : reply(201);
    }
    if (c.host === 'api.paddle.com' && c.method === 'PATCH' && c.path.startsWith('/subscriptions/')) return over.paddle ? over.paddle(c) : reply(200, { data: {} });
    return undefined;
  };
}

const DEFAULT_NOW = at('2026-11-25T09:00:05+10:30');

function createdEvent(over = {}) {
  const data = {
    id: SUB_ID,
    status: 'trialing',
    created_at: '2026-11-25T09:00:00+10:30',
    next_billed_at: '2026-12-09T09:00:00+10:30',
    customer_id: 'ctm_test_1',
    billing_cycle: { interval: 'month' },
    current_billing_period: { ends_at: '2027-03-01T00:00:00Z' },
    custom_data: { user_id: USER_ID },
    ...(over.data || {}),
  };
  const event = {
    event_id: 'evt_test_1',
    event_type: 'subscription.created',
    occurred_at: '2026-11-25T09:00:02+10:30',
    ...over,
    data,
  };
  // JSON drops a key set to undefined, which is how a case removes one.
  return JSON.parse(JSON.stringify(event));
}

/* One signed delivery, with the clock held at `now` for its duration. */
async function deliver(event, opts = {}) {
  const now = opts.now ?? DEFAULT_NOW;
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  const header = 'signature' in opts ? opts.signature : sign(body, opts.signedAt ?? now);
  calls = [];
  logs = [];
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const response = await (opts.handler || webhook)(new Request('https://proj.supabase.co/functions/v1/paddle-webhook', {
      method: 'POST',
      headers: header === null ? {} : { 'Paddle-Signature': header },
      body,
    }));
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a plain-text answer */ }
    return { status: response.status, json, text };
  } finally {
    Date.now = realNow;
  }
}

const keys = () => calls.map((c) => c.method + ' ' + (c.host === 'proj.supabase.co' ? '' : c.host) + c.path);
const claims = () => calls.filter((c) => c.method === 'POST' && c.path === '/rest/v1/rpc/claim_foundation_place');
const grants = () => calls.filter((c) => c.path === '/rest/v1/rpc/grant_capability');
const patches = () => calls.filter((c) => c.host === 'api.paddle.com' && c.method === 'PATCH');
const recorded = () => calls.filter((c) => c.method === 'POST' && c.path === '/rest/v1/billing_events');
const upserts = () => calls.filter((c) => c.method === 'POST' && c.path === '/rest/v1/subscriptions');
/* The row's period end written again, after Paddle accepted the moved
   first-charge date. */
const extensions = () => calls.filter((c) => c.host === 'proj.supabase.co' && c.method === 'PATCH' && c.path === '/rest/v1/subscriptions');
const FIRST_CHARGE = '2027-01-01T12:00:00.000Z';
const indexOfCall = (pred) => calls.findIndex(pred);

/* ───────────────────── Part 1: the webhook, run for real ───────────────────── */

{
  webhookRoute();
  const event = createdEvent();
  const r = await deliver(event);
  const made = claims();
  check('W1 subscription.created makes exactly one claim', made.length === 1, keys());
  const sent = made[0] ? JSON.parse(made[0].body) : null;
  check('W1 ...with the account, the subscription, Paddle\'s created_at unchanged, and the plan',
    JSON.stringify(sent) === JSON.stringify({
      p_user_id: USER_ID, p_subscription_id: SUB_ID,
      p_subscribed_at: '2026-11-25T09:00:00+10:30', p_plan: 'monthly',
    }), sent);

  const h = (made[0] && made[0].headers) || {};
  check('W2 the claim carries the service key', h.apikey === 'service-key' && h.Authorization === 'Bearer service-key', Object.keys(h));
  check('W2 ...and names no other schema', !Object.keys(h).some((k) => k.toLowerCase() === 'content-profile'), Object.keys(h));

  const iUpsert = indexOfCall((c) => c.method === 'POST' && c.path === '/rest/v1/subscriptions');
  const iClaim = indexOfCall((c) => c.path === '/rest/v1/rpc/claim_foundation_place');
  const iGrant = indexOfCall((c) => c.path === '/rest/v1/rpc/grant_capability');
  const iPatch = indexOfCall((c) => c.host === 'api.paddle.com');
  const iRecord = indexOfCall((c) => c.method === 'POST' && c.path === '/rest/v1/billing_events');
  check('W3 the claim comes after the subscriptions row is written', iUpsert >= 0 && iClaim > iUpsert, keys());
  check('W3 ...before any identity grant', iGrant > iClaim, keys());
  check('W3 ...before the billing date is moved', iPatch > iClaim, keys());
  check('W3 ...and before the event is recorded', iRecord > iClaim && iRecord === calls.length - 1, keys());

  check('W4 a place answers 200', r.status === 200 && r.json && r.json.ok === true, r);
  check('W4 ...the event is recorded', recorded().length === 1, keys());
  check('W4 ...and the answer says which place', r.json && r.json.foundation && r.json.foundation.place === 37, r.json);

  const said = logs.join('\n');
  check('W14 the log says what Foundation decided', /foundation/.test(said), logs);
  check('W14 ...without the account id or the subscription id', !said.includes(USER_ID) && !said.includes(SUB_ID), logs);
}

{
  webhookRoute({ claim: () => reply(200, { member: false, reason: 'full' }) });
  const r = await deliver(createdEvent({ event_id: 'evt_test_full' }));
  check('W5 subscriber 101 is not an error', r.status === 200 && r.json && r.json.ok === true, r);
  check('W5 ...the event is recorded', recorded().length === 1, keys());
  check('W5 ...and the answer says Foundation was full', r.json && r.json.foundation && r.json.foundation.reason === 'full', r.json);
  check('W5 ...Premium and the billing date were written all the same', upserts().length === 1 && grants().length === 6 && patches().length === 1, keys());
}

for (const status of [500, 404]) {
  const event = createdEvent({ event_id: 'evt_test_retry_' + status });
  webhookRoute({ claim: () => reply(status, { message: 'no' }) });
  const r = await deliver(event);
  check('W6 a claim answering ' + status + ' makes the handler answer 500', r.status === 500 && r.json && r.json.ok === false, r);
  check('W6 ' + status + ': the event is NOT recorded, so Paddle retries', recorded().length === 0, keys());
  check('W6 ' + status + ': the subscriptions row was written', upserts().length === 1, keys());
  check('W6 ' + status + ': all three identity grants were made, and again with the moved date', grants().length === 6, keys());
  check('W6 ' + status + ': the billing date was moved', patches().length === 1, keys());
  check('W15 ' + status + ': the moved date was written to the row before the 500',
    extensions().length === 1 && JSON.parse(extensions()[0].body).current_period_end === FIRST_CHARGE, keys());
  const said = logs.join('\n');
  check('W14 ' + status + ': the failure is logged without the account id or the subscription id', said.includes('claim_foundation_place failed: ' + status) && !said.includes(USER_ID) && !said.includes(SUB_ID), logs);

  webhookRoute();
  const again = await deliver(event);
  check('W6 ' + status + ': the retry, with the claim answering, is a 200 and is recorded',
    again.status === 200 && claims().length === 1 && recorded().length === 1 && again.json.foundation.place === 37, { again, keys: keys() });
  /* The retry's upsert puts the payload's original period end back. The
     last word on the row, and on the grants, must still be the moved
     date, whatever Paddle sent in between. */
  const rowWrites = calls.filter((c) => c.path === '/rest/v1/subscriptions' && c.method !== 'GET');
  const lastRowWrite = rowWrites.length ? JSON.parse(rowWrites[rowWrites.length - 1].body) : {};
  check('W15 ' + status + ': the retry ends with the moved date on the row, not the original one',
    rowWrites.length === 2 && rowWrites[1].method === 'PATCH' && lastRowWrite.current_period_end === FIRST_CHARGE, keys());
  check('W15 ' + status + ': ...and on the identity grants',
    grants().length === 6 && grants().slice(3).every((g) => JSON.parse(g.body).p_expires_at === FIRST_CHARGE), keys());
}

{
  // A fetch that throws outright (a timeout, a dropped connection).
  webhookRoute({ claim: () => { throw new Error('socket closed'); } });
  const r = await deliver(createdEvent({ event_id: 'evt_test_throw' }));
  check('W6 a claim that cannot be reached is a 500, unrecorded, with Premium written',
    r.status === 500 && recorded().length === 0 && grants().length === 6 && patches().length === 1, keys());
}

for (const type of ['subscription.updated', 'subscription.canceled']) {
  webhookRoute();
  const r = await deliver(createdEvent({ event_id: 'evt_test_' + type, event_type: type }));
  check('W7 ' + type + ' makes no claim', r.status === 200 && claims().length === 0, keys());
  check('W7 ' + type + ' is still recorded', recorded().length === 1, keys());
  check('W7 ' + type + ' answers with no Foundation decision', r.json && r.json.foundation === null, r.json);
}

{
  webhookRoute({ duplicate: () => reply(200, [{ event_id: 'evt_test_1' }]) });
  const r = await deliver(createdEvent());
  check('W8 an event already recorded is answered as a duplicate', r.status === 200 && r.json && r.json.duplicate === true, r);
  check('W8 ...with no claim and no other write', claims().length === 0 && calls.length === 1, keys());
}

{
  webhookRoute();
  const r = await deliver(createdEvent({ event_id: 'evt_test_nouser', data: { custom_data: {} } }));
  check('W9 no account id in the payload: no claim', r.status === 200 && claims().length === 0 && r.json.unattributed === true, { r, keys: keys() });
  webhookRoute();
  const t = await deliver(createdEvent({ event_id: 'evt_test_txn', event_type: 'transaction.completed' }));
  check('W9 an event that is not about a subscription: no claim', t.status === 200 && claims().length === 0 && t.json.ignored === 'transaction.completed', { t, keys: keys() });
}

{
  const event = createdEvent({ event_id: 'evt_test_sig' });
  const body = JSON.stringify(event);
  webhookRoute();
  const missing = await deliver(event, { signature: null });
  check('W10 no signature: 401 and nothing is fetched', missing.status === 401 && calls.length === 0, keys());
  webhookRoute();
  const wrong = await deliver(event, { signature: sign(body, DEFAULT_NOW, 'another-secret') });
  check('W10 a signature made with another secret: 401 and nothing is fetched', wrong.status === 401 && calls.length === 0, keys());
  webhookRoute();
  const altered = await deliver(JSON.stringify({ ...event, event_id: 'evt_test_altered' }), { signature: sign(body, DEFAULT_NOW) });
  check('W10 a signature for a different body: 401 and nothing is fetched', altered.status === 401 && calls.length === 0, keys());
  webhookRoute();
  const stale = await deliver(event, { signedAt: DEFAULT_NOW - 301000 });
  check('W10 a signature older than five minutes: 401 and nothing is fetched', stale.status === 401 && calls.length === 0, keys());
}

{
  webhookRoute({ upsert: () => reply(500, { message: 'no' }) });
  const r = await deliver(createdEvent({ event_id: 'evt_test_upsert' }));
  check('W11 a failed subscriptions write: 500 and no claim', r.status === 500 && claims().length === 0 && recorded().length === 0, keys());
}

{
  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_started', data: { created_at: undefined, started_at: '2026-11-25T08:59:00+10:30' } }));
  const a = claims()[0] ? JSON.parse(claims()[0].body) : {};
  check('W12 no created_at: started_at is used', a.p_subscribed_at === '2026-11-25T08:59:00+10:30', a);

  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_occurred', data: { created_at: undefined } }));
  const b = claims()[0] ? JSON.parse(claims()[0].body) : {};
  check('W12 neither: occurred_at is the last resort', b.p_subscribed_at === '2026-11-25T09:00:02+10:30', b);

  webhookRoute();
  const none = await deliver(createdEvent({ event_id: 'evt_test_notime', occurred_at: undefined, data: { created_at: undefined } }));
  check('W12 no usable time at all: 500, nothing recorded, no claim', none.status === 500 && recorded().length === 0 && claims().length === 0, { none, keys: keys() });
  check('W12 ...and Premium was still written', upserts().length === 1 && grants().length === 6, keys());

  webhookRoute();
  const junk = await deliver(createdEvent({ event_id: 'evt_test_junktime', occurred_at: 'soon', data: { created_at: 'yesterday', started_at: 12345 } }));
  check('W12 times that do not parse are treated the same way', junk.status === 500 && recorded().length === 0 && claims().length === 0 && grants().length === 6, { junk, keys: keys() });
}

{
  /* The purchase clock. The delivery arrives five minutes after
     Foundation closed, for a purchase made one minute before. Foundation
     is judged as of the purchase. The first payment does not depend on
     when the purchase was made or delivered at all. */
  const late = at('2027-01-01T00:05:00+10:30');
  webhookRoute({ accountCreatedAt: '2026-12-25T10:00:00+10:30' });
  await deliver(createdEvent({
    event_id: 'evt_test_late', occurred_at: '2026-12-31T23:59:01+10:30',
    data: { created_at: '2026-12-31T23:59:00+10:30', next_billed_at: '2027-01-14T23:59:00+10:30' },
  }), { now: late });
  const sent = claims()[0] ? JSON.parse(claims()[0].body) : {};
  check('W13 a late delivery sends the purchase instant, not the arrival', sent.p_subscribed_at === '2026-12-31T23:59:00+10:30', sent);
  const moved = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 ...and its first payment is 21 days after the account was made (monthly), whenever it was delivered',
    moved.next_billed_at === '2027-01-14T23:30:00.000Z' && moved.proration_billing_mode === 'do_not_bill', moved);

  /* There is no subscribe-by date any more. This purchase is made after
     the end of 5 December, the old cut-off, and still gets 1 January. */
  webhookRoute({ accountCreatedAt: '2026-11-30T10:00:00+10:30' });
  await deliver(createdEvent({
    event_id: 'evt_test_after', occurred_at: '2026-12-06T00:01:01+10:30',
    data: { created_at: '2026-12-06T00:01:00+10:30', next_billed_at: '2026-12-20T00:01:00+10:30' },
  }), { now: at('2026-12-06T00:05:00+10:30') });
  const after = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 a purchase made after 5 December, while the trial is running, still gets 1 January 2027',
    at('2026-12-06T00:01:00+10:30') > OLD_CLOSE && after.next_billed_at === FIRST_CHARGE, after);

  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_inside' }));
  const inside = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 a purchase in November still gets 1 January 2027', inside.next_billed_at === FIRST_CHARGE, inside);
}

/* One purchase on a catalogue trial price: the kind of checkout the
   pages opened before create-checkout, and the kind an older cached page
   can still open. For these the webhook is the net. Paddle's own
   first-payment date, the one its checkout showed, is the purchase plus
   the trial that price carries in Paddle: `trialDays`, 14 unless a case
   says otherwise (7 was once the plan for the monthly one, and the net
   must hold for any length). Answers what the customer ends up with: the
   date sent to Paddle when one was sent, Paddle's own date when it was
   left. A purchase made through create-checkout is W25 onwards.

   `shown` is what the payload's next_billed_at says: null leaves it
   out, and a string that does not parse is sent as it is. `periodEnds`
   does the same for current_billing_period.ends_at, which on a trialing
   subscription is the same instant. Whatever the payload says or leaves
   out, the date Paddle really holds, the one checkout showed, is still
   there: that is `real`, and it is what `shown` and `firstPayment` in
   the answer are measured against. */
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
let purchaseCount = 0;
async function purchase({ account, bought, interval, shown, periodEnds, trialDays = 14, handler: use, over = {} }) {
  const real = typeof shown === 'string' && Number.isFinite(at(shown)) ? shown : iso(at(bought) + trialDays * DAY);
  const paddleDate = shown === undefined ? real : shown;
  const period = periodEnds === undefined ? real : periodEnds;
  webhookRoute({ accountCreatedAt: account, ...over });
  const r = await deliver(createdEvent({
    event_id: 'evt_test_rule_' + (++purchaseCount), occurred_at: bought,
    data: {
      created_at: bought,
      next_billed_at: paddleDate === null ? undefined : paddleDate,
      current_billing_period: period === null ? undefined : { ends_at: period },
      billing_cycle: interval === null ? undefined : { interval },
    },
  }), { now: at(bought) + 5000, handler: use });
  const sent = patches().map((p) => JSON.parse(p.body));
  return {
    r, sent,
    movedTo: sent.length === 1 ? sent[0].next_billed_at : null,
    extendedTo: extensions().length === 1 ? JSON.parse(extensions()[0].body).current_period_end : null,
    firstPayment: sent.length === 1 ? at(sent[0].next_billed_at) : at(real),
    shown: at(real),
    plan: claims()[0] ? JSON.parse(claims()[0].body).p_plan : undefined,
  };
}

{
  /* W17. The standing rule (Mal, 22 Nov 2026). Subscribe while the trial
     is running and the first payment is taken 30 days after the account
     was made on a yearly plan, 21 days on a monthly plan, and never
     before LAUNCH_FIRST_CHARGE. Each account here is made at 9 am in
     Adelaide and subscribes an hour later. The expected instants are
     written out, not computed, so this does not repeat the function's
     own sums. */
  const table = [
    // signed up              yearly                       monthly
    ['2026-11-22T09:00:00+10:30', FIRST_CHARGE,               FIRST_CHARGE],
    ['2026-12-02T09:00:00+10:30', FIRST_CHARGE,               FIRST_CHARGE],
    ['2026-12-06T09:00:00+10:30', '2027-01-04T22:30:00.000Z', FIRST_CHARGE],
    ['2026-12-11T09:00:00+10:30', '2027-01-09T22:30:00.000Z', FIRST_CHARGE],
    ['2026-12-12T09:00:00+10:30', '2027-01-10T22:30:00.000Z', '2027-01-01T22:30:00.000Z'],
    ['2027-02-01T09:00:00+10:30', '2027-03-02T22:30:00.000Z', '2027-02-21T22:30:00.000Z'],
  ];
  for (const [account, yearly, monthly] of table) {
    const day = account.slice(0, 10);
    const bought = iso(at(account) + 3600000);
    const y = await purchase({ account, bought, interval: 'year' });
    check('W17 yearly, account made ' + day + ': first payment ' + yearly, y.movedTo === yearly && y.plan === 'annual', y.sent);
    check('W17 yearly, account made ' + day + ': Premium runs to the same instant', y.extendedTo === yearly, y.extendedTo);
    const m = await purchase({ account, bought, interval: 'month' });
    check('W17 monthly, account made ' + day + ': first payment ' + monthly, m.movedTo === monthly && m.plan === 'monthly', m.sent);
    check('W17 monthly, account made ' + day + ': Premium runs to the same instant', m.extendedTo === monthly, m.extendedTo);
  }

  // The rule is the later of the two dates, checked against the sums too.
  check('W17 30 days after 6 Dec 2026 9 am Adelaide is 5 Jan 2027 9 am Adelaide',
    iso(at('2026-12-06T09:00:00+10:30') + 30 * DAY) === '2027-01-04T22:30:00.000Z' && at('2027-01-05T09:00:00+10:30') === at('2027-01-04T22:30:00.000Z'));
  check('W17 21 days after 12 Dec 2026 9 am Adelaide is 2 Jan 2027 9 am Adelaide',
    iso(at('2026-12-12T09:00:00+10:30') + 21 * DAY) === '2027-01-01T22:30:00.000Z' && at('2027-01-02T09:00:00+10:30') === at('2027-01-01T22:30:00.000Z'));

  /* Where each plan's own days overtake 1 January: 30 days before
     LAUNCH_FIRST_CHARGE is 10:30 pm on 2 December in Adelaide, and 21
     days before it is 10:30 pm on 11 December. */
  const edge = async (account, interval) => (await purchase({ account, bought: iso(at(account) + 3600000), interval })).movedTo;
  check('W17 yearly, account made just before 10:30 pm on 2 Dec: 1 January 2027',
    await edge('2026-12-02T22:00:00+10:30', 'year') === FIRST_CHARGE);
  check('W17 yearly, account made just after: its full 30 days',
    await edge('2026-12-02T23:00:00+10:30', 'year') === '2027-01-01T12:30:00.000Z');
  check('W17 monthly, account made just before 10:30 pm on 11 Dec: 1 January 2027',
    await edge('2026-12-11T22:00:00+10:30', 'month') === FIRST_CHARGE);
  check('W17 monthly, account made just after: its full 21 days',
    await edge('2026-12-11T23:00:00+10:30', 'month') === '2027-01-01T12:30:00.000Z');

  /* An account made before 22 November has its trial running to the end
     of 5 December. Its 30 or 21 days are long gone, so 1 January decides. */
  const old = await purchase({ account: '2026-09-07T10:00:00+10:30', bought: '2026-12-05T20:00:00+10:30', interval: 'month' });
  check('W17 an account made in September that subscribes on 5 December gets 1 January 2027', old.movedTo === FIRST_CHARGE, old.sent);

  const source = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  check('W17 the two lengths are named in paddle-webhook: 30 days yearly, 21 days monthly',
    /const FREE_DAYS_YEARLY = 30;/.test(source) && /const FREE_DAYS_MONTHLY = 21;/.test(source));
  check('W17 ...and the single 30-day rule is gone', !WEBHOOK_SOURCE.includes('FREE_DAYS_FROM_SIGNUP'));
}

{
  /* W18. The safety net. The first payment is never moved EARLIER than
     the date Paddle's checkout showed the customer, whatever trial the
     price carries. These cases run with a 14-day trial on the monthly
     catalogue trial price, which is what Paddle holds: a monthly
     customer who subscribes on day 10 was shown day 24, and day 21
     would be earlier than that. W22 has the same purchases on a 7-day
     trial. */
  const account = '2027-02-01T09:00:00+10:30';
  const day10 = await purchase({ account, bought: '2027-02-11T09:00:00+10:30', interval: 'month' });
  check('W18 monthly bought on day 10 of the trial: checkout showed day 24, later than day 21',
    day10.shown === at(account) + 24 * DAY && day10.shown > at(account) + 21 * DAY);
  check('W18 ...so the date is left on the one checkout showed: nothing is sent to Paddle',
    day10.r.status === 200 && day10.sent.length === 0, day10.sent);
  check('W18 ...the row is not rewritten, and the event is still recorded',
    day10.extendedTo === null && extensions().length === 0 && recorded().length === 1 && grants().length === 3, keys());

  const inOffer = await purchase({ account: '2026-12-12T09:00:00+10:30', bought: '2026-12-22T09:00:00+10:30', interval: 'month' });
  check('W18 the same during the offer: checkout showed 5 January, later than 1 January and than day 21, so nothing is sent',
    inOffer.shown === at('2027-01-05T09:00:00+10:30') && inOffer.sent.length === 0, inOffer.sent);

  const day7 = await purchase({ account, bought: '2027-02-08T09:00:00+10:30', interval: 'month' });
  check('W18 monthly bought on day 7: checkout showed day 21 itself, so nothing is sent', day7.sent.length === 0, day7.sent);

  const day6 = await purchase({ account, bought: '2027-02-07T09:00:00+10:30', interval: 'month' });
  check('W18 monthly bought on day 6: checkout showed day 20, so it is moved later, to day 21',
    day6.movedTo === '2027-02-21T22:30:00.000Z' && at(day6.movedTo) > day6.shown, day6.sent);

  const yearly13 = await purchase({ account, bought: '2027-02-14T09:00:00+10:30', interval: 'year' });
  check('W18 yearly bought on day 13: checkout showed day 27, so it is moved later, to day 30',
    yearly13.movedTo === '2027-03-02T22:30:00.000Z' && at(yearly13.movedTo) > yearly13.shown, yearly13.sent);

  const farOut = await purchase({ account, bought: '2027-02-02T09:00:00+10:30', interval: 'year', shown: '2027-06-01T00:00:00Z' });
  check('W18 a date from Paddle later than every rule is never pulled back', farOut.sent.length === 0, farOut.sent);

  const almost = await purchase({ account: '2026-11-25T09:00:00+10:30', bought: '2026-11-25T10:00:00+10:30', interval: 'month', shown: '2027-01-01T11:59:30Z' });
  check('W18 a date from Paddle 30 seconds short of 1 January 12:00 UTC is still moved to it', almost.movedTo === FIRST_CHARGE, almost.sent);

  /* No next_billed_at in the payload, or one that does not parse. The
     date checkout showed is still there, and the first payment must not
     land before it. The function falls back on the end of the billing
     period, then on the purchase plus 14 days (PADDLE_TRIAL_DAYS, the
     larger of the two trials in play), and with neither it moves
     nothing.

     A stand-in is a floor, not a reading of what Paddle holds, so the
     date is always SENT, even when the target is the stand-in itself.
     (It used to be skipped then. With a 7-day trial behind a 14-day
     stand-in that would leave Paddle's real, earlier date in place:
     W22.) Here Paddle really holds day 24, so the send sets the date to
     where it already is. */
  const day10bought = '2027-02-11T09:00:00+10:30';
  const day24 = at(day10bought) + 14 * DAY;
  const noDate = await purchase({ account, bought: day10bought, interval: 'month', shown: null });
  check('W18 monthly on day 10 with no next_billed_at in the payload: not moved earlier than purchase + 14 days',
    noDate.r.status === 200 && noDate.movedTo === iso(day24) && noDate.firstPayment >= day24 && noDate.firstPayment >= noDate.shown, noDate.sent);
  const junkMonthly = await purchase({ account, bought: day10bought, interval: 'month', shown: 'soon' });
  check('W18 ...and the same for one that does not parse', junkMonthly.movedTo === iso(day24) && junkMonthly.firstPayment >= junkMonthly.shown, junkMonthly.sent);
  const bare = await purchase({ account, bought: day10bought, interval: 'month', shown: null, periodEnds: null });
  check('W18 ...and with no billing period either, the purchase plus 14 days holds it',
    bare.r.status === 200 && bare.movedTo === iso(day24) && bare.firstPayment >= bare.shown, bare.sent);
  const bareJunk = await purchase({ account, bought: day10bought, interval: 'month', shown: 'soon', periodEnds: 'later' });
  check('W18 ...and with both unreadable', bareJunk.movedTo === iso(day24) && bareJunk.firstPayment >= bareJunk.shown, bareJunk.sent);
  const inOfferBare = await purchase({ account: '2026-12-12T09:00:00+10:30', bought: '2026-12-26T08:59:00+10:30', interval: 'month', shown: null, periodEnds: null });
  check('W18 ...and during the offer: bought on day 14 with no date, never pulled back to day 21',
    inOfferBare.sent.length === 1 && inOfferBare.firstPayment === at('2027-01-09T08:59:00+10:30') && inOfferBare.firstPayment >= inOfferBare.shown, inOfferBare.sent);
  const source18 = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  check('W18 the stand-in is 14 days, the larger of the two trials in play, and the rule itself never reads it',
    /const PADDLE_TRIAL_DAYS = 14;/.test(source18) && (source18.match(/PADDLE_TRIAL_DAYS/g) || []).length === 2 &&
    /function firstChargeAt\(/.test(source18) &&
    !/PADDLE_TRIAL_DAYS/.test((source18.match(/function firstChargeAt\([\s\S]*?\n\}/) || [''])[0]));
  check('W18 a date Paddle stated is left alone only when it is exactly the target; a stand-in never is',
    /if \(shown\.stated && Date\.parse\(shown\.at\) === target\.getTime\(\)\) return null;/.test(source18));

  /* The fallback is a floor, not a stop: a move LATER still goes ahead. */
  const junkDate = await purchase({ account, bought: day10bought, interval: 'year', shown: 'soon' });
  check('W18 yearly on day 10 with an unreadable date: still moved later, to day 30',
    junkDate.movedTo === '2027-03-02T22:30:00.000Z' && at(junkDate.movedTo) >= day24, junkDate.sent);
  const bareYearly = await purchase({ account, bought: day10bought, interval: 'year', shown: null, periodEnds: null });
  check('W18 ...and with no date of any kind in the payload', bareYearly.movedTo === '2027-03-02T22:30:00.000Z', bareYearly.sent);
  const bareDay6 = await purchase({ account, bought: '2027-02-07T09:00:00+10:30', interval: 'month', shown: null, periodEnds: null });
  check('W18 monthly on day 6 with no date: purchase + 14 days is day 20, so it is moved later, to day 21',
    bareDay6.movedTo === '2027-02-21T22:30:00.000Z' && at(bareDay6.movedTo) > bareDay6.shown, bareDay6.sent);

  /* Nothing to go on at all: no date from Paddle and no purchase time.
     Nothing is sent to Paddle, and the log says so. (Foundation cannot
     be judged without a purchase time either, so this delivery is a 500
     and Paddle sends it again.) */
  webhookRoute({ accountCreatedAt: account });
  const blind = await deliver(createdEvent({
    event_id: 'evt_test_blind', occurred_at: undefined,
    data: { created_at: undefined, next_billed_at: undefined, current_billing_period: undefined },
  }), { now: at(day10bought) + 5000 });
  const blindSaid = logs.join('\n');
  check('W18 with no date and no purchase time, no date is sent to Paddle at all', patches().length === 0 && extensions().length === 0, keys());
  check('W18 ...and it is logged, without the account id or the subscription id',
    blindSaid.includes('Could not defer first charge') && !blindSaid.includes(USER_ID) && !blindSaid.includes(SUB_ID), logs);
  check('W18 ...and the delivery is not recorded, so Paddle sends it again', blind.status === 500 && recorded().length === 0, blind);
}

{
  /* W21. The account's creation date could not be read, so the function
     cannot tell whether the first payment has to be moved. Left alone,
     the customer would be charged on checkout's date, which may be
     earlier than the pages say. So it is logged, with no account id and
     no subscription id, and the delivery is answered 500 without being
     recorded: Paddle sends it again. Premium is switched on all the
     same, on this first attempt. (Until 22 Nov 2026 this answered 200.) */
  const cases = {
    'a lookup answering 500': { over: { account: () => reply(500, { message: 'no' }) }, says: 'answered 500' },
    'a lookup answering 404': { over: { account: () => reply(404, { message: 'no' }) }, says: 'answered 404' },
    'no row for the account': { over: { account: () => reply(200, []) }, says: 'no creation date on record' },
    'a row with no created_at': { over: { account: () => reply(200, [{ created_at: null }]) }, says: 'no creation date on record' },
    'a created_at that does not parse': { over: { accountCreatedAt: 'last week' }, says: 'does not parse' },
  };
  let n = 0;
  for (const [name, c] of Object.entries(cases)) {
    const event = createdEvent({ event_id: 'evt_test_nodate_' + (++n) });
    webhookRoute(c.over);
    const r = await deliver(event);
    const said = logs.join('\n');
    check('W21 ' + name + ': nothing is sent to Paddle and the row is not rewritten', patches().length === 0 && extensions().length === 0, keys());
    check('W21 ' + name + ': it is logged as "Could not defer first charge"', said.includes('Could not defer first charge') && said.includes(c.says), logs);
    check('W21 ' + name + ': ...without the account id or the subscription id', !said.includes(USER_ID) && !said.includes(SUB_ID) && !r.text.includes(USER_ID) && !r.text.includes(SUB_ID), logs);
    check('W21 ' + name + ': the answer is 500 and the event is NOT recorded, so Paddle retries',
      r.status === 500 && r.json && r.json.ok === false && recorded().length === 0, { r, keys: keys() });
    check('W21 ' + name + ': Premium is still switched on, and the Foundation claim still made, on this first attempt',
      upserts().length === 1 && claims().length === 1 && grants().length === 3, keys());

    webhookRoute();
    const again = await deliver(event);
    check('W21 ' + name + ': the retry, with the date readable, moves the first payment and is recorded',
      again.status === 200 && patches().length === 1 && JSON.parse(patches()[0].body).next_billed_at === FIRST_CHARGE &&
      extensions().length === 1 && recorded().length === 1, { again, keys: keys() });
  }

  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_nodate_ok' }));
  check('W21 a move that goes ahead logs no such line', patches().length === 1 && !logs.join('\n').includes('Could not defer first charge'), logs);
}

{
  /* W22. The net, on a catalogue trial price whose trial is shorter
     than the rule's days. (This was the plan for consistency before
     create-checkout: a 7-day trial on Paddle's monthly trial price. It
     is retired, and checkout now shows the right date itself: part C.
     The cases stay because the webhook must still do this for any price
     it is handed.) With a 7-day trial, checkout shows the purchase plus
     7 days, which
     is never later than the account plus 21. So whichever day of the
     trial a monthly customer subscribes on, the date is moved LATER, to
     exactly 21 days after the account was made, or to 1 January 2027
     when that is later. "Day n" here is the last hour of the nth day of
     the trial. The expected instants are written out, not computed. */
  const accounts = [
    // account made               monthly: 21 days or 1 Jan    yearly: 30 days or 1 Jan
    ['2027-02-01T09:00:00+10:30', '2027-02-21T22:30:00.000Z', '2027-03-02T22:30:00.000Z'],
    ['2026-12-12T09:00:00+10:30', '2027-01-01T22:30:00.000Z', '2027-01-10T22:30:00.000Z'],
    ['2026-11-25T09:00:00+10:30', FIRST_CHARGE,               FIRST_CHARGE],
  ];
  for (const [account, monthly, yearly] of accounts) {
    const made = account.slice(0, 10);
    const ended = { seven: new Set(), fourteen: new Set(), yearly: new Set() };
    for (const n of [1, 5, 10, 14]) {
      const bought = iso(at(account) + n * DAY - 3600000);
      const T = 'W22 account made ' + made + ', monthly bought on day ' + n + ' of the trial';

      const seven = await purchase({ account, bought, interval: 'month', trialDays: 7 });
      ended.seven.add(seven.firstPayment);
      check(T + ', 7-day Paddle trial: checkout showed the purchase plus 7 days, never later than day 21',
        seven.shown === at(bought) + 7 * DAY && seven.shown <= at(account) + 21 * DAY);
      check(T + ', 7-day Paddle trial: moved to exactly ' + monthly,
        seven.r.status === 200 && seven.movedTo === monthly && seven.extendedTo === monthly && recorded().length === 1, seven.sent);
      check(T + ', 7-day Paddle trial: that is a move LATER than checkout showed', at(seven.movedTo) > seven.shown);

      /* The safety net: the same purchase while Paddle's monthly trial
         price still carries 14 days. Nobody is charged before the rule's
         date or before the date checkout showed. */
      const fourteen = await purchase({ account, bought, interval: 'month', trialDays: 14 });
      ended.fourteen.add(fourteen.firstPayment);
      check(T + ', 14-day Paddle trial: never earlier than checkout showed, never earlier than the rule',
        fourteen.r.status === 200 && fourteen.shown === at(bought) + 14 * DAY &&
        fourteen.firstPayment >= fourteen.shown && fourteen.firstPayment >= at(monthly) &&
        fourteen.firstPayment === Math.max(at(monthly), fourteen.shown), fourteen.sent);

      /* Yearly is unchanged: its trial price keeps 14 days, and the
         purchase plus 14 is at most day 28, under 30. */
      const year = await purchase({ account, bought, interval: 'year', trialDays: 14 });
      ended.yearly.add(year.firstPayment);
      check('W22 account made ' + made + ', yearly bought on day ' + n + ': moved to exactly ' + yearly,
        year.r.status === 200 && year.shown < at(account) + 30 * DAY && year.movedTo === yearly && year.extendedTo === yearly, year.sent);
    }
    check('W22 account made ' + made + ': with the 7-day trial every monthly subscriber ends on the same date, whichever day they subscribed',
      ended.seven.size === 1 && [...ended.seven][0] === at(monthly), [...ended.seven].map(iso));
    check('W22 account made ' + made + ': and so does every yearly subscriber', ended.yearly.size === 1 && [...ended.yearly][0] === at(yearly));
  }
  /* What leaving the monthly trial price at 14 days costs, written down
     so nobody mistakes it for fixed: after the offer, someone who
     subscribes on day 10 or 14 keeps a later date than someone who
     subscribes on day 1. Nobody is charged early. */
  {
    const account = '2027-02-01T09:00:00+10:30';
    const day1 = await purchase({ account, bought: iso(at(account) + 1 * DAY - 3600000), interval: 'month', trialDays: 14 });
    const day14 = await purchase({ account, bought: iso(at(account) + 14 * DAY - 3600000), interval: 'month', trialDays: 14 });
    check('W22 left at 14 days, a monthly subscriber on day 14 keeps day 28 where one on day 1 gets day 21',
      day1.firstPayment === at(account) + 21 * DAY && day14.sent.length === 0 && day14.firstPayment === at(account) + 28 * DAY - 3600000);
  }

  /* The 7-day trial behind a payload that states no next_billed_at.
     With the billing period's end to go on (the trial's end, the same
     instant), the date still lands on exactly day 21. With nothing but
     the purchase time, the 14-day stand-in holds it: the date is SENT,
     to the purchase plus 14 days. Paddle really holds the purchase plus
     7, which is day 17 here, earlier than the pages' day 21, so leaving
     it would have broken the promise. */
  const account = '2027-02-01T09:00:00+10:30';
  const bought = iso(at(account) + 10 * DAY - 3600000);
  const noDate = await purchase({ account, bought, interval: 'month', trialDays: 7, shown: null });
  check('W22 7-day trial, day 10, no next_billed_at but a billing period: still exactly day 21',
    noDate.r.status === 200 && noDate.movedTo === '2027-02-21T22:30:00.000Z', noDate.sent);
  const bare = await purchase({ account, bought, interval: 'month', trialDays: 7, shown: null, periodEnds: null });
  check('W22 7-day trial, day 10, no date of Paddle\'s at all: Paddle holds day 17, so the date is sent, to the purchase plus 14 days',
    bare.r.status === 200 && bare.shown < at(account) + 21 * DAY && bare.movedTo === iso(at(bought) + 14 * DAY) &&
    bare.firstPayment >= at(account) + 21 * DAY && bare.firstPayment >= bare.shown && bare.extendedTo === bare.movedTo, bare.sent);
  const bareEarly = await purchase({ account, bought: iso(at(account) + 1 * DAY - 3600000), interval: 'month', trialDays: 7, shown: null, periodEnds: null });
  check('W22 ...and on day 1 with no date at all: exactly day 21', bareEarly.movedTo === '2027-02-21T22:30:00.000Z', bareEarly.sent);
}

{
  /* W23. A move that was needed and did not happen. That is a
     customer left on a date earlier than the pages say (a purchase on a
     catalogue trial price; one made through create-checkout needs no
     move, W25). It is never answered 200. Each case: the answer is
     500, the subscriptions row and the identity grants are written
     (Premium is on from the first attempt), the Foundation claim is
     made, the event is NOT recorded, and the retry succeeds. The date
     is the same on the retry, so moving it twice is harmless. */
  const failures = {
    'no PADDLE_API_KEY': { handler: webhookNoKey, over: {}, says: 'Could not defer first charge: PADDLE_API_KEY not set', sent: 0 },
    'Paddle answering 400': { over: { paddle: () => reply(400, { error: 'no' }) }, says: 'Could not defer first charge for ' + SUB_ID + ': 400', sent: 1, namesSubscription: true },
    'Paddle answering 429': { over: { paddle: () => reply(429, { error: 'slow down' }) }, says: 'Could not defer first charge for ' + SUB_ID + ': 429', sent: 1, namesSubscription: true },
    'Paddle answering 500': { over: { paddle: () => reply(500, { error: 'no' }) }, says: 'Could not defer first charge for ' + SUB_ID + ': 500', sent: 1, namesSubscription: true },
    'Paddle out of reach': { over: { paddle: () => { throw new Error('socket closed'); } }, says: 'Could not defer first charge: Paddle could not be reached', sent: 1 },
    'the account lookup failing': { over: { account: () => reply(503, { message: 'no' }) }, says: 'Could not defer first charge: reading the account\'s creation date answered 503', sent: 0 },
    /* These two used to reach the log only as a bare TypeError or
       SyntaxError, with no line anyone could search for. */
    'the account lookup out of reach': { over: { account: () => { throw new TypeError('fetch failed'); } }, says: 'Could not defer first charge: the account lookup could not be reached', sent: 0 },
    'the account lookup answering something that is not JSON': { over: { account: () => reply(200, '<html>gateway</html>') }, says: 'Could not defer first charge: the account lookup\'s answer could not be read', sent: 0 },
  };
  let n = 0;
  for (const [name, f] of Object.entries(failures)) {
    for (const interval of ['month', 'year']) {
      const T = 'W23 ' + name + ' (' + interval + 'ly): ';
      const event = createdEvent({ event_id: 'evt_test_failed_move_' + (++n), data: { billing_cycle: { interval } } });
      webhookRoute(f.over);
      const r = await deliver(event, { handler: f.handler });
      const said = logs.join('\n');
      check(T + 'the answer is 500', r.status === 500 && r.json && r.json.ok === false && /first charge not deferred/.test(r.json.error), r);
      check(T + 'the event is NOT recorded, so Paddle retries', recorded().length === 0, keys());
      check(T + 'the subscriptions row was written', upserts().length === 1 && JSON.parse(upserts()[0].body).status === 'trialing', keys());
      check(T + 'Premium is on from this first attempt: all three identity grants were made',
        grants().length === 3 && grants().every((g) => JSON.parse(g.body).p_expires_at === '2027-03-01T00:00:00Z'), keys());
      check(T + 'the Foundation claim was made', claims().length === 1, keys());
      check(T + 'the row\'s period end is not rewritten to a date Paddle does not hold', extensions().length === 0, keys());
      check(T + (f.sent ? 'the move was tried once' : 'nothing was sent to Paddle'), patches().length === f.sent, keys());
      check(T + 'it is logged as "Could not defer first charge"', said.includes(f.says), logs);
      check(T + 'the answer names neither the account nor the subscription, and the log never names the account',
        !r.text.includes(USER_ID) && !r.text.includes(SUB_ID) && !said.includes(USER_ID) && (f.namesSubscription || !said.includes(SUB_ID)), { r, logs });
      /* Every write the failed attempt made comes before the failure. */
      const iFail = f.sent ? indexOfCall((c) => c.host === 'api.paddle.com') : calls.length;
      check(T + 'the row, the claim and the grants all came first',
        indexOfCall((c) => c.method === 'POST' && c.path === '/rest/v1/subscriptions') < iFail &&
        indexOfCall((c) => c.path === '/rest/v1/rpc/claim_foundation_place') < iFail &&
        calls.map((c, i) => (c.path === '/rest/v1/rpc/grant_capability' ? i : -1)).filter((i) => i >= 0).every((i) => i < iFail), keys());

      webhookRoute();
      const again = await deliver(event);
      const moved = patches().map((p) => JSON.parse(p.body));
      check(T + 'the retry succeeds: 200, the date moved to 1 January 2027, the event recorded',
        again.status === 200 && moved.length === 1 && moved[0].next_billed_at === FIRST_CHARGE && moved[0].proration_billing_mode === 'do_not_bill' &&
        extensions().length === 1 && JSON.parse(extensions()[0].body).current_period_end === FIRST_CHARGE && recorded().length === 1, { again, keys: keys() });
    }
  }

  /* A retry after a move that DID succeed (the delivery failed on
     something else) sends the same date again. Same date, twice. */
  {
    const event = createdEvent({ event_id: 'evt_test_move_twice' });
    webhookRoute({ record: () => reply(500, { message: 'no' }) });
    const first = await deliver(event);
    const firstMove = patches().map((p) => JSON.parse(p.body).next_billed_at);
    webhookRoute();
    const second = await deliver(event);
    const secondMove = patches().map((p) => JSON.parse(p.body).next_billed_at);
    check('W23 a retry after a successful move sends exactly the same date again',
      first.status === 500 && second.status === 200 && firstMove.length === 1 && secondMove.length === 1 && firstMove[0] === secondMove[0] && firstMove[0] === FIRST_CHARGE,
      { firstMove, secondMove });
  }

  /* Both held failures at once: still one 500, both logged, and the
     retry does both. */
  {
    const event = createdEvent({ event_id: 'evt_test_both_fail' });
    webhookRoute({ claim: () => reply(500, { message: 'no' }), paddle: () => reply(400, { error: 'no' }) });
    const r = await deliver(event);
    const said = logs.join('\n');
    check('W23 a failed claim and a failed move together: one 500, unrecorded, both logged, Premium written',
      r.status === 500 && recorded().length === 0 && grants().length === 3 && upserts().length === 1 &&
      said.includes('claim_foundation_place failed: 500') && said.includes('Could not defer first charge'), { r, logs });
    webhookRoute();
    const again = await deliver(event);
    check('W23 ...and the retry makes the claim and the move', again.status === 200 && claims().length === 1 && patches().length === 1 && recorded().length === 1, keys());
  }

  /* No key is not a failure when there is nothing to move. */
  {
    webhookRoute();
    const paid = await deliver(createdEvent({ event_id: 'evt_test_nokey_paid', data: { status: 'active' } }), { handler: webhookNoKey });
    check('W23 no PADDLE_API_KEY and a subscription that paid on the day: 200, recorded, no complaint',
      paid.status === 200 && recorded().length === 1 && patches().length === 0 && !logs.join('\n').includes('Could not defer first charge'), { paid, logs });
    const already = await purchase({ account: '2027-02-01T09:00:00+10:30', bought: '2027-02-02T09:00:00+10:30', interval: 'year', shown: '2027-06-01T00:00:00Z', handler: webhookNoKey });
    check('W23 no PADDLE_API_KEY and a date from Paddle that is already the right one: 200, recorded',
      already.r.status === 200 && already.sent.length === 0 && recorded().length === 1 && !logs.join('\n').includes('Could not defer first charge'), { r: already.r, logs });
  }

  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('W23 the held failure is thrown after the Foundation one and before the event is recorded',
    /if \(foundationError\) throw foundationError;\s*if \(deferError\) throw deferError;\s*await recordEvent\(eventId, eventType, userId, event\);/.test(code));
  check('W23 no failed move is left as a warning: the old "leaving the billing date" lines are gone',
    !/leaving the billing date|The billing date is left as Paddle set it/.test(WEBHOOK_SOURCE));
}

{
  /* W24. The rule is for someone who subscribes while their free trial
     is running, and for nobody else (Mal, 22 Nov 2026: "Initial payments
     will not be charged before 1 January 2027 if you sign on while in
     your free 14-day trial period"). An account whose trial has ended
     takes the plain price, pays on the day, and arrives here as an
     active subscription, not a trialing one. It is not moved, in
     December 2026 or at any other time, and nothing is asked of Paddle. */
  const lapsed = [
    ['month', '2026-12-15T10:00:00+10:30', '2027-01-15T10:00:00+10:30'],
    ['year', '2026-12-15T10:00:00+10:30', '2027-12-15T10:00:00+10:30'],
    ['month', '2026-12-31T23:00:00+10:30', '2027-01-31T23:00:00+10:30'],
    ['month', '2027-01-10T10:00:00+10:30', '2027-02-10T10:00:00+10:30'],
  ];
  let n = 0;
  for (const [interval, bought, renews] of lapsed) {
    for (const use of [webhook, webhookNoKey]) {
      const T = 'W24 a lapsed account subscribing ' + bought.slice(0, 10) + ' (' + interval + 'ly' + (use === webhookNoKey ? ', no Paddle key' : '') + '): ';
      // The account was made on 23 November; its 14 days ended on 7 December.
      webhookRoute({ accountCreatedAt: '2026-11-23T09:00:00+10:30' });
      const r = await deliver(createdEvent({
        event_id: 'evt_test_lapsed_' + (++n), occurred_at: bought,
        data: { status: 'active', created_at: bought, next_billed_at: renews, billing_cycle: { interval }, current_billing_period: { ends_at: renews } },
      }), { now: at(bought) + 5000, handler: use });
      const row = upserts()[0] ? JSON.parse(upserts()[0].body) : {};
      check(T + 'arrives as a paid subscription, not a trialing one', r.status === 200 && row.status === 'active' && row.current_period_end === renews, row);
      check(T + 'its payment date is NOT moved: nothing is sent to Paddle', patches().length === 0, keys());
      check(T + 'the row is not rewritten and the account\'s creation date is not even looked up',
        extensions().length === 0 && !calls.some((c) => c.method === 'GET' && c.path === '/rest/v1/subscriptions'), keys());
      check(T + 'the event is recorded and Premium runs to the end of the period paid for',
        recorded().length === 1 && grants().length === 3 && grants().every((g) => JSON.parse(g.body).p_expires_at === renews), keys());
      check(T + 'no "Could not defer" line', !logs.join('\n').includes('Could not defer first charge'), logs);
    }
  }
}

{
  /* W19. A plan interval that is missing or not recognised gets 30
     days, the later and safer of the two. */
  const account = '2027-02-01T09:00:00+10:30';
  const bought = '2027-02-01T10:00:00+10:30';
  const missing = await purchase({ account, bought, interval: null });
  check('W19 no billing interval in the payload: 30 days, not 21', missing.movedTo === '2027-03-02T22:30:00.000Z' && missing.plan === null, missing);
  for (const odd of ['week', 'day', 'MONTH', '']) {
    const r = await purchase({ account, bought, interval: odd });
    check('W19 an interval of "' + odd + '": 30 days', r.movedTo === '2027-03-02T22:30:00.000Z', r.sent);
  }
  const lateMissing = await purchase({ account: '2026-11-25T09:00:00+10:30', bought: '2026-11-25T10:00:00+10:30', interval: null });
  check('W19 ...and still never before 1 January 2027', lateMissing.movedTo === FIRST_CHARGE, lateMissing.sent);
}

{
  /* W20. Every account, every plan, every day of the trial: the first
     payment the customer ends up with is never before
     LAUNCH_FIRST_CHARGE, never before the plan's own days from the day
     the account was made, and never before the date checkout showed. */
  const bad = [];
  let tried = 0;
  /* Each purchase is tried three ways: with Paddle's date in the
     payload, with next_billed_at left out, and with no date of Paddle's
     in the payload at all. The date checkout showed is the same in all
     three, and so is the answer. */
  const PAYLOADS = [{}, { shown: null }, { shown: null, periodEnds: null }];
  /* Monthly is tried on two trial lengths a catalogue trial price
     might carry: 14 days, which Paddle's holds, and 7, shorter than the
     rule's days. Yearly keeps 14. */
  const audit = async (account, bought, interval) => {
    for (const trialDays of interval === 'month' ? [14, 7] : [14]) {
      for (const payload of PAYLOADS) await auditOne(account, bought, interval, payload, trialDays);
    }
  };
  const auditOne = async (account, bought, interval, payload, trialDays) => {
    const p = await purchase({ account, bought, interval, trialDays, ...payload });
    tried++;
    const days = interval === 'month' ? 21 : 30;
    /* The date no move may fall short of. It is Paddle's own date
       whenever the payload gives one. With no date of Paddle's in the
       payload the function stands in the purchase plus 14 days, which
       is Paddle's own date on a 14-day trial and a later one on a
       7-day trial. */
    const standIn = payload.shown === null && payload.periodEnds === null;
    const floor = standIn ? Math.max(p.shown, at(bought) + 14 * DAY) : p.shown;
    const ok = p.r.status === 200 && p.sent.length <= 1 &&
      p.firstPayment >= at(FIRST_CHARGE) &&
      p.firstPayment >= at(account) + days * DAY &&
      p.firstPayment >= p.shown &&
      // Exactly the latest of the three, so nobody is held longer either.
      p.firstPayment === Math.max(at(FIRST_CHARGE), at(account) + days * DAY, floor) &&
      /* On the 7-day trial, with Paddle's date in the payload, a monthly
         subscriber's date depends on the account alone, never on the
         day they subscribed. */
      (!(interval === 'month' && trialDays === 7 && !standIn) ||
        (p.sent.length === 1 && p.firstPayment === Math.max(at(FIRST_CHARGE), at(account) + 21 * DAY))) &&
      (p.movedTo === null || (p.extendedTo === p.movedTo && p.sent[0].proration_billing_mode === 'do_not_bill'));
    if (!ok) bad.push({ account, bought, interval, trialDays, payload, movedTo: p.movedTo, shown: iso(p.shown) });
  };
  // Accounts made on each day from the offer's first to 5 January 2027.
  for (let d = at('2026-11-22T00:00:00+10:30'); d <= at('2027-01-05T00:00:00+10:30'); d += DAY) {
    for (const offset of [0, 3, 6, 7, 8, 10, 13]) {
      for (const interval of ['year', 'month', null]) {
        await audit(iso(d + 9 * 3600000), iso(d + offset * DAY + 10 * 3600000), interval);
      }
    }
  }
  // Accounts made before 22 November, whose trials run to the end of 5 December.
  for (const account of ['2026-09-07T10:00:00+10:30', '2026-11-01T10:00:00+10:30', '2026-11-21T23:00:00+10:30']) {
    for (const bought of ['2026-11-22T10:00:00+10:30', '2026-11-30T10:00:00+10:30', '2026-12-05T23:59:00+10:30']) {
      for (const interval of ['year', 'month']) await audit(account, bought, interval);
    }
  }
  check('W20 nobody is charged before 1 January 2027 12:00 UTC, before their own days, or before the date checkout showed (' + tried + ' purchases)',
    bad.length === 0 && tried > 3800, bad.slice(0, 5));
}

{
  /* "Pay nothing until 2027" has to be true on the customer's own
     calendar, not only in Adelaide. Mal's rule: the first charge falls
     when the last time zone on Earth, UTC-12, reaches midnight on New
     Year's Eve. So it is 2027 in every zone from UTC-12 to UTC+14. */
  const charge = at(FIRST_CHARGE);
  const dayAt = (offsetHours) => new Date(charge + offsetHours * 3600000).toISOString().slice(0, 10);
  check('W16 the first charge is 1 January 2027 in Adelaide', dayAt(10.5) === '2027-01-01');
  check('W16 ...in Perth, London, New York and Los Angeles',
    [8, 0, -5, -8].every((h) => dayAt(h) === '2027-01-01'), [8, 0, -5, -8].map(dayAt));
  check('W16 ...and it is exactly midnight starting 1 January at UTC-12, the last zone',
    new Date(charge - 12 * 3600000).toISOString() === '2027-01-01T00:00:00.000Z', new Date(charge - 12 * 3600000).toISOString());
  const zones = [];
  for (let h = -12; h <= 14; h += 0.25) zones.push(h);
  check('W16 ...and already 2027 in every zone from UTC-12 to UTC+14',
    zones.every((h) => dayAt(h).slice(0, 4) === '2027'), zones.filter((h) => dayAt(h).slice(0, 4) !== '2027'));
  check('W16 ...and one second earlier it would still be 2026 at UTC-12',
    new Date(charge - 1000 - 12 * 3600000).toISOString().slice(0, 4) === '2026');
  const constant = (WEBHOOK_SOURCE.match(/const LAUNCH_FIRST_CHARGE = Date\.parse\("([^"]+)"\)/) || [])[1];
  check('W16 LAUNCH_FIRST_CHARGE in paddle-webhook is that instant', at(constant) === charge, constant);
}

{
  /* The moved date is written to the row and the grants once Paddle has
     accepted it, after the Paddle call and before the event is recorded. */
  webhookRoute();
  const r = await deliver(createdEvent({ event_id: 'evt_test_extend' }));
  const ext = extensions();
  const iPaddle = indexOfCall((c) => c.host === 'api.paddle.com');
  const iExtend = indexOfCall((c) => c.host === 'proj.supabase.co' && c.method === 'PATCH' && c.path === '/rest/v1/subscriptions');
  const iRecord = indexOfCall((c) => c.method === 'POST' && c.path === '/rest/v1/billing_events');
  check('W15 an accepted move writes the new period end to the row, once', r.status === 200 && ext.length === 1 &&
    JSON.parse(ext[0].body).current_period_end === FIRST_CHARGE, keys());
  check('W15 ...for this account and this subscription only',
    Boolean(ext[0]) && ext[0].url.includes('user_id=eq.' + USER_ID) && ext[0].url.includes('paddle_subscription_id=eq.' + SUB_ID), ext[0] && ext[0].url);
  check('W15 ...after Paddle answered and before the event is recorded', iPaddle >= 0 && iExtend > iPaddle && iRecord > iExtend, keys());
  check('W15 ...and the grants follow: first the date in the payload, then the moved one',
    grants().length === 6 &&
    grants().slice(0, 3).every((g) => JSON.parse(g.body).p_expires_at === '2027-03-01T00:00:00Z') &&
    grants().slice(3).every((g) => JSON.parse(g.body).p_expires_at === FIRST_CHARGE), grants().map((g) => g.body));

  webhookRoute({ paddle: () => reply(400, { error: 'no' }) });
  const refused = await deliver(createdEvent({ event_id: 'evt_test_refused' }));
  check('W15 a move Paddle refuses changes nothing on the row, and is a 500, unrecorded, so Paddle retries (W23)',
    refused.status === 500 && extensions().length === 0 && grants().length === 3 && recorded().length === 0, keys());

  webhookRoute({ extend: () => reply(500, { message: 'no' }) });
  const failed = await deliver(createdEvent({ event_id: 'evt_test_extend_fail' }));
  check('W15 a failed write of the moved date is a 500, unrecorded, so Paddle retries', failed.status === 500 && recorded().length === 0, keys());

  webhookRoute();
  const paid = await deliver(createdEvent({ event_id: 'evt_test_paid', data: { status: 'active' } }));
  check('W15 a subscription that paid on the day is not moved and not extended',
    paid.status === 200 && patches().length === 0 && extensions().length === 0, keys());
}

/* A purchase made through create-checkout, as it reaches the webhook.
   Paddle's own first-payment date is the purchase plus the whole days
   create-checkout put on the transaction (`days`), less `short`
   milliseconds when a case wants it to land short. The price is one
   made for the transaction, which Paddle marks "custom". `periodEnds`
   is the payload's current_billing_period.ends_at: the same instant
   unless a case says otherwise, null to leave the period out. `items`
   replaces the one item; `stated: false` leaves next_billed_at out. */
let checkoutPurchases = 0;
async function checkoutPurchase({ account, bought, interval, days, short = 0, periodEnds, priceType = 'custom', stated = true, items, handler: use, over = {}, now }) {
  const nextBilled = iso(at(bought) + days * DAY - short);
  const period = periodEnds === undefined ? nextBilled : periodEnds;
  webhookRoute({ accountCreatedAt: account, ...over });
  const r = await deliver(createdEvent({
    event_id: 'evt_test_checkout_' + (++checkoutPurchases), occurred_at: bought,
    data: {
      created_at: bought,
      next_billed_at: stated ? nextBilled : undefined,
      current_billing_period: period === null ? undefined : { starts_at: bought, ends_at: period },
      billing_cycle: { interval, frequency: 1 },
      custom_data: { user_id: USER_ID, trial_days: days, first_payment_from: 'not read by the webhook', made_by: 'create-checkout' },
      items: items || [{
        status: 'trialing', quantity: 1,
        trial_dates: { starts_at: bought, ends_at: nextBilled },
        price: { id: 'pri_test_made_for_this_one', type: priceType, billing_cycle: { interval, frequency: 1 }, trial_period: { interval: 'day', frequency: days } },
      }],
    },
  }), { now: now ?? at(bought) + 5000, handler: use });
  const sent = patches().map((p) => JSON.parse(p.body));
  return {
    r, sent, nextBilled, said: logs.join('\n'),
    movedTo: sent.length === 1 ? sent[0].next_billed_at : null,
    extendedTo: extensions().length === 1 ? JSON.parse(extensions()[0].body).current_period_end : null,
  };
}
const STANDS = "first charge: checkout's date stands";
const MOVED_AFTER = 'first charge moved after checkout';
const ON_CATALOGUE = 'trial subscription on a catalogue price';
const LATER_THAN_RULE = 'First payment later than the rule';

{
  /* W25. A purchase made through create-checkout. Its transaction
     carried the right number of whole free days, so Paddle's own date is
     already at or after both of the rule's instants. The webhook has
     nothing to move: nothing is sent to Paddle, the row is not written a
     second time, the Foundation claim is made, the event is recorded and
     the answer is 200. With no PADDLE_API_KEY it is the same, because no
     move means no key is asked for. The day counts and instants are the
     ones part C pins for create-checkout, written out here too. */
  const bought = [
    // account made            plan     bought                  days  Paddle's first payment
    ['2026-11-25T03:00:00Z', 'month', '2026-11-25T03:00:30Z', 38, '2027-01-02T03:00:30.000Z'],
    ['2026-11-25T03:00:00Z', 'year',  '2026-11-25T03:00:30Z', 38, '2027-01-02T03:00:30.000Z'],
    ['2027-02-01T00:00:00Z', 'month', '2027-02-14T00:00:00Z', 8,  '2027-02-22T00:00:00.000Z'],
    ['2027-02-01T00:00:00Z', 'year',  '2027-02-14T23:59:00Z', 17, '2027-03-03T23:59:00.000Z'],
    ['2026-09-07T00:00:00Z', 'month', '2026-12-06T11:59:00Z', 27, '2027-01-02T11:59:00.000Z'],
    ['2026-09-07T00:00:00Z', 'month', '2026-12-05T12:00:00Z', 27, '2027-01-01T12:00:00.000Z'],
    ['2026-11-21T13:30:00Z', 'month', '2026-11-21T13:31:00Z', 41, '2027-01-01T13:31:00.000Z'],
    ['2026-12-18T12:00:00Z', 'month', '2027-01-01T11:59:30Z', 8,  '2027-01-09T11:59:30.000Z'],
  ];
  for (const [account, interval, when, days, first] of bought) {
    for (const use of [webhook, webhookNoKey]) {
      const T = 'W25 through create-checkout, account ' + account.slice(0, 10) + ', ' + interval + 'ly, ' + days + ' days' + (use === webhookNoKey ? ', no Paddle key' : '') + ': ';
      const p = await checkoutPurchase({ account, bought: when, interval, days, handler: use });
      check(T + 'Paddle\'s own date is ' + first, p.nextBilled === first, p.nextBilled);
      check(T + 'nothing is sent to Paddle', p.r.status === 200 && p.sent.length === 0, { r: p.r, sent: p.sent });
      check(T + 'the row is written once and not again, and Premium runs to the first payment',
        upserts().length === 1 && JSON.parse(upserts()[0].body).current_period_end === first && JSON.parse(upserts()[0].body).status === 'trialing' &&
        extensions().length === 0 && grants().length === 3 && grants().every((g) => JSON.parse(g.body).p_expires_at === first), keys());
      check(T + 'the Foundation claim is made and the event is recorded', claims().length === 1 && recorded().length === 1, keys());
      check(T + 'the log says checkout\'s date stands, and nothing else about the date',
        p.said.includes(STANDS) && !p.said.includes(MOVED_AFTER) && !p.said.includes(ON_CATALOGUE) &&
        !p.said.includes(LATER_THAN_RULE) && !p.said.includes('Could not defer first charge'), logs);
      check(T + '...without the account id or the subscription id', !p.said.includes(USER_ID) && !p.said.includes(SUB_ID), logs);
    }
  }

  /* The net still works under it. The same purchase with Paddle's date
     2 seconds SHORT of the rule (clocks that disagree, say) is moved
     later, to exactly the rule's instant, and Premium follows it. */
  const short = await checkoutPurchase({ account: '2026-09-07T00:00:00Z', bought: '2026-12-05T12:00:00Z', interval: 'month', days: 27, short: 2000 });
  check('W25 a date 2 seconds short of the rule is moved later, to exactly the rule\'s instant',
    short.nextBilled === '2027-01-01T11:59:58.000Z' && short.r.status === 200 && short.movedTo === FIRST_CHARGE && short.sent[0].proration_billing_mode === 'do_not_bill', short.sent);
  check('W25 ...Premium runs to the moved date, and the event is recorded', short.extendedTo === FIRST_CHARGE && recorded().length === 1, keys());
  check('W25 ...and the log says so, with both dates and no id',
    short.said.includes(MOVED_AFTER + ': checkout showed 2027-01-01T11:59:58.000Z, rule gives 2027-01-01T12:00:00.000Z') &&
    !short.said.includes(STANDS) && !short.said.includes(USER_ID) && !short.said.includes(SUB_ID), logs);
  const shortRefused = await checkoutPurchase({ account: '2026-09-07T00:00:00Z', bought: '2026-12-05T12:00:00Z', interval: 'month', days: 27, short: 2000, over: { paddle: () => reply(400, { error: 'no' }) } });
  check('W25 ...and when Paddle refuses that move it is still a 500, unrecorded, with Premium written first',
    shortRefused.r.status === 500 && recorded().length === 0 && upserts().length === 1 && grants().length === 3 && claims().length === 1 &&
    extensions().length === 0 && shortRefused.said.includes('Could not defer first charge') && !shortRefused.said.includes(STANDS), { r: shortRefused.r, keys: keys() });
  const shortNoKey = await checkoutPurchase({ account: '2026-09-07T00:00:00Z', bought: '2026-12-05T12:00:00Z', interval: 'month', days: 27, short: 2000, handler: webhookNoKey });
  check('W25 ...and with no PADDLE_API_KEY a date that is short is a 500 too, never a quiet 200',
    shortNoKey.r.status === 500 && recorded().length === 0 && shortNoKey.said.includes('Could not defer first charge: PADDLE_API_KEY not set'), shortNoKey.r);

  /* A day too many is not an error either: later is always fine. */
  const long = await checkoutPurchase({ account: '2027-02-01T00:00:00Z', bought: '2027-02-14T00:00:00Z', interval: 'month', days: 9 });
  check('W25 a date a whole day later than the rule is left where checkout showed it', long.r.status === 200 && long.sent.length === 0 && long.said.includes(STANDS), long.sent);
}

{
  /* W26. Premium to the first payment when nothing is moved. Before
     create-checkout nearly every purchase was moved, and the move wrote
     the row's period end. Now nearly none is, so the row rests on the
     payload's billing period ending at the first payment. That is
     expected of Paddle, not seen. When the period is missing, or ends at
     another instant, the row and the three grants are written to
     Paddle's stated date. When it is the same instant, nothing is
     written twice. */
  const base = { account: '2026-11-25T03:00:00Z', bought: '2026-11-25T03:00:30Z', interval: 'month', days: 38 };
  const first = '2027-01-02T03:00:30.000Z';

  const none = await checkoutPurchase({ ...base, periodEnds: null });
  check('W26 no billing period in the payload: nothing is sent to Paddle, and the row is written to the first-payment date',
    none.r.status === 200 && none.sent.length === 0 && none.extendedTo === first && recorded().length === 1, keys());
  check('W26 ...for this account and this subscription only',
    extensions().length === 1 && extensions()[0].url.includes('user_id=eq.' + USER_ID) && extensions()[0].url.includes('paddle_subscription_id=eq.' + SUB_ID), extensions().map((e) => e.url));
  check('W26 ...and the three grants are made again, to that date',
    grants().length === 6 && grants().slice(3).every((g) => JSON.parse(g.body).p_expires_at === first), grants().map((g) => g.body));
  check('W26 ...and the log still says checkout\'s date stands', none.said.includes(STANDS) && !none.said.includes(MOVED_AFTER), logs);

  const earlier = await checkoutPurchase({ ...base, periodEnds: '2026-12-09T03:00:30Z' });
  check('W26 a billing period that ends BEFORE the first payment: the row is written to the first-payment date, so Premium does not stop early',
    earlier.r.status === 200 && earlier.sent.length === 0 && JSON.parse(upserts()[0].body).current_period_end === '2026-12-09T03:00:30Z' &&
    earlier.extendedTo === first && grants().length === 6, keys());
  const later = await checkoutPurchase({ ...base, periodEnds: '2027-02-02T03:00:30Z' });
  check('W26 a billing period that ends after it: the row is written to the first-payment date too', later.extendedTo === first && later.sent.length === 0, keys());

  const same = await checkoutPurchase({ ...base });
  check('W26 the same instant: the row is not written a second time', same.r.status === 200 && extensions().length === 0 && grants().length === 3, keys());
  const sameOtherwise = await checkoutPurchase({ ...base, periodEnds: '2027-01-02T13:30:30+10:30' });
  check('W26 the same instant written another way: still not written a second time',
    at('2027-01-02T13:30:30+10:30') === at(first) && sameOtherwise.r.status === 200 && extensions().length === 0 && grants().length === 3, keys());

  const failed = await checkoutPurchase({ ...base, periodEnds: null, over: { extend: () => reply(500, { message: 'no' }) } });
  check('W26 that write failing is a 500 and the event is NOT recorded, so Paddle retries',
    failed.r.status === 500 && recorded().length === 0 && upserts().length === 1 && claims().length === 1, { r: failed.r, keys: keys() });
  const heldClaim = await checkoutPurchase({ ...base, periodEnds: null, over: { claim: () => reply(500, { message: 'no' }) } });
  check('W26 a failed Foundation claim is still thrown after it: the row is written to the first-payment date first',
    heldClaim.r.status === 500 && recorded().length === 0 && heldClaim.extendedTo === first, { r: heldClaim.r, keys: keys() });

  /* Only for a date Paddle stated, that is still ahead, on a
     subscription that has not paid. */
  const past = await checkoutPurchase({ ...base, periodEnds: null, now: at(first) + DAY });
  check('W26 a delivery that arrives after the first-payment date writes no period end', past.r.status === 200 && extensions().length === 0 && past.sent.length === 0, keys());
  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_paid_no_period', data: { status: 'active', current_billing_period: undefined } }));
  check('W26 a subscription that paid on the day is never written to its next payment date', extensions().length === 0 && patches().length === 0 && recorded().length === 1, keys());
  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('W26 Paddle\'s own date is read once and used for the move, the log and this write',
    (code.match(/paddleFirstPaymentAt\(/g) || []).length === 2 && /const shown = paddleFirstPaymentAt\(data, event\);/.test(code) &&
    /if \(movedTo\) await extendFreePeriod\(userId, String\(data\.id\), status, movedTo\);/.test(code));
}

{
  /* W27. The stand-ins, now that a trial can be 40 days. When the
     payload states no next_billed_at, the webhook must still never move
     a first payment earlier than checkout showed. Its last stand-in used
     to be the purchase plus 14 days and nothing else, which for a 40-day
     trial is 26 days EARLIER than checkout showed. It now reads the
     trial the payload itself states: the trial's end on the item, then
     the trial length on the item's price.

     The account here was made on 1 February 2027 and its own trial was
     extended by hand, so create-checkout gave 40 days: the rule alone
     says 22 February (monthly), and checkout showed 13 March. */
  const base = { account: '2027-02-01T00:00:00Z', bought: '2027-02-01T00:00:30Z', interval: 'month', days: 40, stated: false, periodEnds: null };
  const shown = '2027-03-13T00:00:30.000Z';
  const ruleAlone = '2027-02-22T00:00:00.000Z';
  check('W27 forty days from the purchase is 13 March 2027, later than the rule alone', iso(at(base.bought) + 40 * DAY) === shown && at(shown) > at(ruleAlone));
  const item = (over = {}) => [{
    status: 'trialing', quantity: 1,
    trial_dates: { starts_at: base.bought, ends_at: shown },
    price: { id: 'pri_test_made_for_this_one', type: 'custom', trial_period: { interval: 'day', frequency: 40 } },
    ...over,
  }];

  const byDates = await checkoutPurchase({ ...base });
  check('W27 no next_billed_at and no billing period: the trial end on the item is the floor',
    byDates.r.status === 200 && byDates.movedTo === shown && byDates.extendedTo === shown, byDates.sent);
  const byDatesAlone = await checkoutPurchase({ ...base, items: item({ price: { type: 'custom', trial_period: null } }) });
  check('W27 ...on its own, with no trial length on the price to fall back on', byDatesAlone.movedTo === shown, byDatesAlone.sent);
  const byLength = await checkoutPurchase({ ...base, items: item({ trial_dates: undefined }) });
  check('W27 ...and without that, the purchase plus the 40 days on the item\'s price', byLength.movedTo === shown, byLength.sent);
  const junkDates = await checkoutPurchase({ ...base, items: item({ trial_dates: { ends_at: 'later' } }) });
  check('W27 ...and the same when the trial end does not parse', junkDates.movedTo === shown, junkDates.sent);
  const withPeriod = await checkoutPurchase({ ...base, periodEnds: shown, items: item({ trial_dates: { ends_at: '2027-04-01T00:00:00Z' } }) });
  check('W27 the billing period, when the payload has one, is still read before the items', withPeriod.movedTo === shown, withPeriod.sent);
  const twoItems = await checkoutPurchase({ ...base, items: [
    { trial_dates: { ends_at: '2027-02-15T00:00:30Z' }, price: { type: 'custom', trial_period: { interval: 'day', frequency: 14 } } },
    ...item(),
  ] });
  check('W27 with two items the latest trial end is the floor', twoItems.movedTo === shown, twoItems.sent);
  const twoLengths = await checkoutPurchase({ ...base, items: [
    { price: { type: 'custom', trial_period: { interval: 'day', frequency: 40 } } },
    { price: { type: 'custom', trial_period: { interval: 'day', frequency: 3 } } },
  ] });
  check('W27 ...and the longest trial length, when only lengths are stated', twoLengths.movedTo === shown, twoLengths.sent);
  const shortTrial = await checkoutPurchase({ ...base, items: item({ trial_dates: undefined, price: { type: 'standard', trial_period: { interval: 'day', frequency: 7 } } }) });
  check('W27 a stated length shorter than 14 days never shortens the stand-in: 14 days, then the rule',
    shortTrial.movedTo === ruleAlone && at(base.bought) + 14 * DAY < at(ruleAlone), shortTrial.sent);

  /* A length that is not plainly a number of days is not guessed at:
     the 14-day stand-in holds, and here the rule's own date is later. */
  for (const [name, trial] of Object.entries({
    'a frequency of 0': { interval: 'day', frequency: 0 },
    'a frequency of -5': { interval: 'day', frequency: -5 },
    'a frequency of 1000': { interval: 'day', frequency: 1000 },
    'a frequency of "40x"': { interval: 'day', frequency: '40x' },
    'a frequency of "40"': { interval: 'day', frequency: '40' },
    'a frequency of 40.5': { interval: 'day', frequency: 40.5 },
    'a week interval': { interval: 'week', frequency: 40 },
    'no trial on the price': null,
  })) {
    const r = await checkoutPurchase({ ...base, items: item({ trial_dates: undefined, price: { type: 'custom', trial_period: trial } }) });
    check('W27 ' + name + ' falls back to the purchase plus 14 days, so the rule\'s own date is sent', r.r.status === 200 && r.movedTo === ruleAlone, r.sent);
  }
  const noItems = await checkoutPurchase({ ...base, items: [] });
  check('W27 no items at all: the same', noItems.movedTo === ruleAlone, noItems.sent);
  const oddItems = await checkoutPurchase({ ...base, items: 'none' });
  check('W27 items that are not a list: the same, and no fault', oddItems.r.status === 200 && oddItems.movedTo === ruleAlone, oddItems.r);

  /* Whatever the payload leaves out, where it says 40 days the date sent
     is never earlier than the purchase plus 40 days. */
  const all = [byDates, byDatesAlone, byLength, junkDates, withPeriod, twoItems, twoLengths];
  check('W27 wherever the payload says 40 days, the date sent is never earlier than the purchase plus 40 days',
    all.every((p) => p.sent.length === 1 && at(p.movedTo) >= at(base.bought) + 40 * DAY), all.map((p) => p.movedTo));
  check('W27 a move worked out from a stand-in says so in the log, and never claims checkout showed that date',
    byLength.said.includes(MOVED_AFTER + ': the payload did not state checkout\'s date') && !byLength.said.includes('checkout showed 2') && !byLength.said.includes(STANDS), byLength.said);

  /* In the offer: 40 days from one second after noon UTC on 22 November
     is one second after LAUNCH_FIRST_CHARGE. With the trial read from
     the payload that second is kept; on the old 14-day stand-in the date
     sent would have been the rule's instant, one second EARLIER than
     checkout showed. */
  const inOffer = { account: '2026-11-22T12:00:00Z', bought: '2026-11-22T12:00:01Z', interval: 'month', days: 40, stated: false, periodEnds: null };
  const offerLength = await checkoutPurchase({ ...inOffer, items: [{ price: { type: 'custom', trial_period: { interval: 'day', frequency: 40 } } }] });
  check('W27 in the offer, 40 days stated on the price: the date sent is the purchase plus 40 days, not a second earlier',
    offerLength.movedTo === '2027-01-01T12:00:01.000Z' && at(offerLength.movedTo) > at(FIRST_CHARGE), offerLength.sent);

  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const standIn = (code.match(/function paddleFirstPaymentAt\([\s\S]*?\n\}/) || [''])[0];
  check('W27 the stand-ins read Paddle\'s own fields only, never custom_data, which a browser can write',
    standIn !== '' && !/custom_data/.test(standIn) && /trial_dates/.test(standIn) && /Math\.max\(PADDLE_TRIAL_DAYS, trialDays\)/.test(standIn));
}

{
  /* W28. The lines in the log. A free period on a price that was not
     made by create-checkout is a checkout that did not come through it:
     an older cached page on a retired catalogue trial price, or one
     opened by hand. It is handled exactly as before (W17, W18, W22, W23)
     and the log says what it was. */
  const account = '2027-02-01T09:00:00+10:30';
  const day6 = '2027-02-07T09:00:00+10:30';
  const catalogue = await checkoutPurchase({ account, bought: day6, interval: 'month', days: 14, priceType: 'standard' });
  check('W28 a free period on a catalogue price is logged as that', catalogue.said.includes(ON_CATALOGUE), logs);
  check('W28 ...and handled as before: moved later, to day 21, Premium with it, recorded',
    catalogue.r.status === 200 && catalogue.movedTo === '2027-02-21T22:30:00.000Z' && catalogue.extendedTo === catalogue.movedTo && recorded().length === 1, catalogue.sent);
  check('W28 ...with the move logged too: what checkout showed and what the rule gives',
    catalogue.said.includes(MOVED_AFTER + ': checkout showed 2027-02-20T22:30:00.000Z, rule gives 2027-02-21T22:30:00.000Z'), logs);
  const plain = await purchase({ account, bought: day6, interval: 'month' });
  check('W28 a payload with no items at all is logged the same way, and moved the same way',
    logs.join('\n').includes(ON_CATALOGUE) && plain.movedTo === '2027-02-21T22:30:00.000Z', logs);
  const day10 = await checkoutPurchase({ account, bought: '2027-02-11T09:00:00+10:30', interval: 'month', days: 14, priceType: 'standard' });
  check('W28 a catalogue price whose date is already late enough: logged, nothing sent, the date stands',
    day10.said.includes(ON_CATALOGUE) && day10.said.includes(STANDS) && day10.sent.length === 0 && day10.r.status === 200, logs);
  const refused = await checkoutPurchase({ account, bought: day6, interval: 'month', days: 14, priceType: 'standard', over: { paddle: () => reply(500, { error: 'no' }) } });
  check('W28 a catalogue price whose move fails: logged, and still a 500 that Paddle retries',
    refused.said.includes(ON_CATALOGUE) && refused.r.status === 500 && recorded().length === 0 && !refused.said.includes(STANDS) && !refused.said.includes(MOVED_AFTER), logs);

  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_log_paid', data: { status: 'active', items: [{ price: { type: 'standard' } }] } }));
  check('W28 a subscription that paid on the day logs none of these lines',
    ![STANDS, MOVED_AFTER, ON_CATALOGUE, LATER_THAN_RULE].some((line) => logs.join('\n').includes(line)), logs);
  for (const type of ['subscription.updated', 'subscription.canceled']) {
    webhookRoute();
    await deliver(createdEvent({ event_id: 'evt_test_log_' + type, event_type: type }));
    check('W28 ' + type + ' logs none of these lines', ![STANDS, MOVED_AFTER, ON_CATALOGUE, LATER_THAN_RULE].some((line) => logs.join('\n').includes(line)), logs);
  }

  /* A stated date well past the rule is said, and left alone. The
     account was made at midnight UTC on 1 February 2027, so the rule
     alone gives 22 February on a monthly plan. */
  const feb = { account: '2027-02-01T00:00:00Z', interval: 'month' };
  const hoursLater = async (h) => {
    const days = 21 + Math.floor(h / 24);
    // Bought so that the purchase plus whole days lands h hours past the rule.
    return checkoutPurchase({ ...feb, bought: iso(at('2027-02-01T00:00:00Z') + (h % 24) * 3600000), days });
  };
  const h48 = await hoursLater(48);
  check('W28 a stated date 48 hours after the rule: logged, in hours', h48.nextBilled === '2027-02-24T00:00:00.000Z' && h48.said.includes(LATER_THAN_RULE + ': by 48 hours.'), logs);
  check('W28 ...nothing is sent to Paddle, the date stands and the event is recorded',
    h48.r.status === 200 && h48.sent.length === 0 && extensions().length === 0 && recorded().length === 1 && h48.said.includes(STANDS), keys());
  const h37 = await hoursLater(37);
  check('W28 37 hours after: logged', h37.nextBilled === '2027-02-23T13:00:00.000Z' && h37.said.includes(LATER_THAN_RULE + ': by 37 hours.'), logs);
  const h36 = await hoursLater(36);
  check('W28 exactly 36 hours after: not logged', h36.nextBilled === '2027-02-23T12:00:00.000Z' && !h36.said.includes(LATER_THAN_RULE) && h36.said.includes(STANDS), logs);
  const h23 = await hoursLater(23);
  check('W28 23 hours after, which rounding up to whole days can give: not logged', !h23.said.includes(LATER_THAN_RULE) && h23.sent.length === 0, logs);
  const offer = await checkoutPurchase({ account: '2026-11-25T03:00:00Z', bought: '2026-11-25T12:00:00Z', interval: 'month', days: 40 });
  check('W28 in the offer it is measured from 1 January 2027 12:00 UTC: 72 hours after is logged as 72',
    offer.nextBilled === '2027-01-04T12:00:00.000Z' && offer.said.includes(LATER_THAN_RULE + ': by 72 hours.') && offer.sent.length === 0, logs);
  const every = [catalogue, day10, refused, h48, h37, offer].map((p) => p.said).join('\n');
  check('W28 none of the new lines names the account', !every.includes(USER_ID));
  check('W28 ...and none names the subscription, except the one line a refusal from Paddle always wrote',
    every.split('\n').filter((line) => line.includes(SUB_ID)).every((line) => line.startsWith('Could not defer first charge for ' + SUB_ID)), every.split('\n').filter((line) => line.includes(SUB_ID)));

  /* A log line must never be what fails a delivery. */
  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const note = (code.match(/function noteFirstCharge\([\s\S]*?\n\}/) || [''])[0];
  check('W28 the lines are written inside a try, and write nothing but the log',
    /^function noteFirstCharge\([^)]*\) \{\s*try \{/.test(note) && /\} catch \(_error\) \{\s*\}\s*\}$/.test(note) && !/fetch\(|rest\(|await /.test(note), note.slice(0, 200));
  check('W28 the "later than the rule" line changes no date: it returns nothing and is not awaited',
    /if \(shown\.stated\) noteIfLaterThanRule\(createdAt, plan, shown\.at\);/.test(code) &&
    !/return/.test((code.match(/function noteIfLaterThanRule\([\s\S]*?\n\}/) || ['return'])[0]));
}

{
  /* W29. A free period on an account whose own free trial was not
     running when the subscription was bought. create-checkout fixes the
     free days on the transaction when it is MADE; Paddle counts them
     from when it is PAID. If Paddle still opens a transaction made
     earlier (not known), one paid after the trial has ended starts a
     free period the terms do not give, and so does a retired catalogue
     trial price opened by hand. The webhook cannot undo it (it never
     moves a date earlier than checkout showed), so it says so: it reads
     the account's row BEFORE writing over it, and logs one line. That
     reading is for the log only and can never fail a delivery. */
  const OUTSIDE = 'free period on an account whose own free trial was not running';
  const isBefore = (c) => c.method === 'GET' && c.path === '/rest/v1/subscriptions' && c.url.includes('select=plan,');
  /* The row as it was before this event, for the first reading only;
     the later reading of created_at is answered as usual. */
  const withRow = (account, before) => ({
    account: (c) => (isBefore(c) ? (typeof before === 'function' ? before(c) : reply(200, before)) : reply(200, [{ created_at: account }])),
  });
  const feb = '2027-02-01T00:00:00Z';
  const trialRow = { plan: 'trial', status: 'trialing', current_period_end: '2027-02-15T00:00:00Z', complimentary: false, paddle_subscription_id: null };

  /* The usual purchase: day 13 of the trial, on a transaction with the
     17 days create-checkout gives a yearly plan that day. */
  const inTrial = await checkoutPurchase({ account: feb, bought: '2027-02-14T00:00:00Z', interval: 'year', days: 17, over: withRow(feb, [trialRow]) });
  const iBefore = indexOfCall(isBefore);
  const iUpsert = indexOfCall((c) => c.method === 'POST' && c.path === '/rest/v1/subscriptions');
  check('W29 the account\'s row is read before the event is written over it, once, by the account in the signed payload',
    calls.filter(isBefore).length === 1 && iBefore >= 0 && iBefore < iUpsert &&
    calls[iBefore].url === 'https://proj.supabase.co/rest/v1/subscriptions?user_id=eq.' + USER_ID + '&select=plan,status,current_period_end,complimentary,paddle_subscription_id', keys());
  check('W29 bought while the account\'s own trial was running: no such line, and everything else as W25',
    inTrial.r.status === 200 && !inTrial.said.includes(OUTSIDE) && inTrial.said.includes(STANDS) && inTrial.sent.length === 0 &&
    inTrial.nextBilled === '2027-03-03T00:00:00.000Z' && recorded().length === 1 && claims().length === 1 && grants().length === 3, logs);

  /* The finding's own case. The same account keeps a transaction made
     on day 0 (30 days on it) and pays it on 20 February, five days
     after its trial ended. Paddle counts 30 days from then: 22 March,
     19 days past the rule's 3 March. */
  const late = await checkoutPurchase({ account: feb, bought: '2027-02-20T00:00:00Z', interval: 'year', days: 30, over: withRow(feb, [trialRow]) });
  check('W29 a transaction paid after the account\'s trial had ended: the log says so',
    late.nextBilled === '2027-03-22T00:00:00.000Z' && late.said.split('\n').includes(OUTSIDE), logs);
  check('W29 ...and how far past the rule the first payment is: 456 hours',
    late.said.includes(LATER_THAN_RULE + ': by 456 hours.'), logs);
  check('W29 ...and nothing is changed by it: no date is sent to Paddle, the row runs to the date checkout showed, the event is recorded',
    late.r.status === 200 && late.sent.length === 0 && extensions().length === 0 && recorded().length === 1 && claims().length === 1 &&
    JSON.parse(upserts()[0].body).current_period_end === '2027-03-22T00:00:00.000Z' && late.said.includes(STANDS), keys());
  check('W29 ...and the line names neither the account nor the subscription', !late.said.includes(USER_ID) && !late.said.includes(SUB_ID), logs);

  /* A transaction made on day 0 and paid on day 13, inside the trial:
     no such line (the trial was running), but the first payment is 13
     days past the rule, and the other line says that. */
  const stretched = await checkoutPurchase({ account: feb, bought: '2027-02-14T00:00:00Z', interval: 'year', days: 30, over: withRow(feb, [trialRow]) });
  check('W29 a transaction made on day 0 and paid on day 13 of the trial: logged as later than the rule, by 312 hours, and left alone',
    stretched.nextBilled === '2027-03-16T00:00:00.000Z' && stretched.said.includes(LATER_THAN_RULE + ': by 312 hours.') &&
    !stretched.said.includes(OUTSIDE) && stretched.sent.length === 0 && stretched.r.status === 200, logs);

  const outside = {
    'the trial ended at the very instant of the purchase': [{ ...trialRow, current_period_end: '2027-02-20T00:00:00Z' }],
    'a trial row marked expired': [{ ...trialRow, status: 'expired', current_period_end: '2027-03-01T00:00:00Z' }],
    'an account that already had another subscription': [{ plan: 'annual', status: 'trialing', current_period_end: '2027-03-03T00:00:00Z', complimentary: false, paddle_subscription_id: 'sub_test_an_earlier_one' }],
    'an account whose subscription was cancelled and finished': [{ plan: 'monthly', status: 'canceled', current_period_end: '2027-02-10T00:00:00Z', complimentary: false, paddle_subscription_id: 'sub_test_an_earlier_one' }],
    'an account with no plan (plan null, status none)': [{ plan: null, status: 'none', current_period_end: null, complimentary: false, paddle_subscription_id: null }],
  };
  for (const [name, before] of Object.entries(outside)) {
    const p = await checkoutPurchase({ account: feb, bought: '2027-02-20T00:00:00Z', interval: 'year', days: 30, over: withRow(feb, before) });
    check('W29 ' + name + ': logged, once, and the delivery is a 200 as before',
      p.said.split('\n').filter((line) => line === OUTSIDE).length === 1 && p.r.status === 200 && recorded().length === 1, logs);
  }
  const running = {
    'a trial with a second to go': [{ ...trialRow, current_period_end: '2027-02-20T00:00:01Z' }],
    'a trial row with no end date': [{ ...trialRow, current_period_end: null }],
  };
  for (const [name, before] of Object.entries(running)) {
    const p = await checkoutPurchase({ account: feb, bought: '2027-02-20T00:00:00Z', interval: 'year', days: 30, over: withRow(feb, before) });
    check('W29 ' + name + ' is a trial that was running: not logged', !p.said.includes(OUTSIDE) && p.r.status === 200, logs);
  }

  /* A retried delivery reads the row its own first attempt wrote: plan
     annual, this subscription. That is not a second subscription. */
  const retried = await checkoutPurchase({ account: feb, bought: '2027-02-14T00:00:00Z', interval: 'year', days: 17,
    over: withRow(feb, [{ plan: 'annual', status: 'trialing', current_period_end: '2027-03-03T00:00:00Z', complimentary: false, paddle_subscription_id: SUB_ID }]) });
  check('W29 a retried delivery, reading the row its first attempt wrote, is not logged as one', !retried.said.includes(OUTSIDE) && retried.r.status === 200, logs);

  /* The reading can never be what fails a delivery, and when it cannot
     be made nothing is said. */
  const unreadable = {
    'the reading answers 500': () => reply(500, { message: 'no' }),
    'the reading cannot be reached': () => { throw new TypeError('fetch failed'); },
    'the reading is not JSON': () => reply(200, '<html>gateway</html>'),
    'the account has no row yet': () => reply(200, []),
    'the answer has no plan column in it': () => reply(200, [{ created_at: feb }]),
    'the answer is a list holding no row': () => reply(200, [null]),
    'the row\'s end date does not parse': () => reply(200, [{ ...trialRow, current_period_end: 'soon' }]),
  };
  for (const [name, before] of Object.entries(unreadable)) {
    const p = await checkoutPurchase({ account: feb, bought: '2027-02-20T00:00:00Z', interval: 'year', days: 30, over: withRow(feb, before) });
    check('W29 ' + name + ': nothing is said, and the delivery is a 200, recorded, with Premium written',
      !p.said.includes(OUTSIDE) && p.r.status === 200 && recorded().length === 1 && upserts().length === 1 && grants().length === 3 && claims().length === 1, { r: p.r, logs });
  }

  /* A retired catalogue trial price opened by hand on a lapsed account:
     both lines, and the date is still moved later as W28 has it. */
  const byHand = await checkoutPurchase({ account: feb, bought: '2027-02-20T00:00:00Z', interval: 'month', days: 14, priceType: 'standard',
    over: withRow(feb, [{ ...trialRow, status: 'expired' }]) });
  check('W29 a catalogue trial price opened on a lapsed account: both lines, and Paddle\'s date is left where checkout showed it',
    byHand.said.includes(ON_CATALOGUE) && byHand.said.includes(OUTSIDE) && byHand.r.status === 200 && byHand.sent.length === 0 &&
    byHand.nextBilled === '2027-03-06T00:00:00.000Z', { sent: byHand.sent, logs });
  const moveFails = await checkoutPurchase({ account: feb, bought: '2027-02-03T00:00:00Z', interval: 'month', days: 14, priceType: 'standard',
    over: { ...withRow(feb, [{ plan: 'annual', status: 'active', current_period_end: '2028-01-01T00:00:00Z', complimentary: false, paddle_subscription_id: 'sub_test_an_earlier_one' }]), paddle: () => reply(500, { error: 'no' }) } });
  check('W29 the line is written on the first attempt even when the move that follows fails and the delivery is a 500',
    moveFails.r.status === 500 && moveFails.said.includes(OUTSIDE) && moveFails.said.includes('Could not defer first charge') && recorded().length === 0, logs);

  /* Only a new subscription that arrived with a free period is looked
     at. Someone who paid on the day, a renewal and a cancellation are
     not, and no extra reading is made for them. */
  webhookRoute(withRow(feb, [{ ...trialRow, status: 'expired' }]));
  await deliver(createdEvent({ event_id: 'evt_test_outside_paid', data: { status: 'active' } }));
  check('W29 a subscription that paid on the day: the row is not read beforehand and nothing is said',
    calls.filter(isBefore).length === 0 && !logs.join('\n').includes(OUTSIDE), keys());
  for (const type of ['subscription.updated', 'subscription.canceled']) {
    webhookRoute(withRow(feb, [{ ...trialRow, status: 'expired' }]));
    await deliver(createdEvent({ event_id: 'evt_test_outside_' + type, event_type: type }));
    check('W29 ' + type + ': the row is not read beforehand and nothing is said', calls.filter(isBefore).length === 0 && !logs.join('\n').includes(OUTSIDE), keys());
  }

  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reading = (code.match(/async function ownTrialAtPurchase\([\s\S]*?\n\}/) || [''])[0];
  check('W29 the reading is inside a try, answers null on any fault, and writes nothing',
    /\): Promise<boolean \| null> \{\s*try \{/.test(reading) && /\} catch \(_error\) \{\s*return null;\s*\}\s*\}$/.test(reading) &&
    !/method:|console\.|throw|deferFailed/.test(reading) && (reading.match(/rest\(/g) || []).length === 1, reading.slice(0, 200));
  check('W29 ...and it makes the same test as create-checkout: plan trial, and entitled at the purchase instant',
    /return before\.plan === "trial" && entitled;/.test(reading) && /\(ends === null \|\| ends > bought\)/.test(reading) &&
    /row\.plan === "trial" && entitled/.test(CHECKOUT_SOURCE));
  check('W29 it changes no date: the rule and the move are given nothing from it',
    !/ownTrial/.test((code.match(/async function deferFirstCharge\([\s\S]*?\n\}/) || ['ownTrial'])[0]) &&
    !/ownTrial/.test((code.match(/function firstChargeAt\([\s\S]*?\n\}/) || ['ownTrial'])[0]));
}

/* ───────────────── Part C: create-checkout, run for real ─────────────────
   The function that makes the Paddle transaction for someone who
   subscribes while their own free trial is running. Supabase's sign-in
   check, the account's row and Paddle's API are all answered here. */

const CONFIG_SOURCE = read('app/config.js');
const configId = (key) => (CONFIG_SOURCE.match(new RegExp('\\b' + key + ": '([^']+)'")) || [])[1];
const TXN_ID = 'txn_01test0made0for0this0account';
const PRODUCT_ID = 'pro_01test0premium';
/* The two plain catalogue prices, as Paddle would answer for them. The
   ids are read from app/config.js, so a function that asks for any other
   price gets a 404 here. The amounts are in cents, as Paddle writes
   them, and are test values the function must copy and never hold. */
const CATALOGUE = {
  monthly: {
    id: configId('monthlyPriceId'), product_id: PRODUCT_ID, type: 'standard', status: 'active',
    name: 'Monthly', description: 'catalogue monthly',
    billing_cycle: { interval: 'month', frequency: 1 }, trial_period: null, tax_mode: 'internal',
    unit_price: { amount: '290', currency_code: 'AUD' },
    unit_price_overrides: [{ country_codes: ['NZ'], unit_price: { amount: '320', currency_code: 'NZD' } }],
    quantity: { minimum: 1, maximum: 50 },
  },
  annual: {
    id: configId('annualPriceId'), product_id: PRODUCT_ID, type: 'standard', status: 'active',
    name: 'Yearly', description: 'catalogue yearly',
    billing_cycle: { interval: 'year', frequency: 1 }, trial_period: null, tax_mode: 'internal',
    unit_price: { amount: '1900', currency_code: 'AUD' },
    unit_price_overrides: [],
    quantity: { minimum: 1, maximum: 50 },
  },
};
const CATALOGUE_BY_ID = { [CATALOGUE.monthly.id]: CATALOGUE.monthly, [CATALOGUE.annual.id]: CATALOGUE.annual };

/* The account's row for an account in its own free trial: made at 3 am
   UTC on 25 November 2026, on the standard 14 days. */
const TRIAL_ROW = {
  created_at: '2026-11-25T03:00:00Z', plan: 'trial', status: 'trialing',
  current_period_end: '2026-12-09T03:00:00Z', cancel_at_period_end: false, complimentary: false,
};
const ASKED_AT = at('2026-11-25T03:00:30Z');

/* Paddle's answer to POST /transactions: what was posted, with an id,
   the way Paddle answers. `change` lets a case spoil it. */
function transactionAnswer(c, change, status = 201) {
  const sent = JSON.parse(c.body);
  const data = {
    id: TXN_ID, status: 'draft', collection_mode: sent.collection_mode,
    custom_data: sent.custom_data, discount_id: sent.discount_id ?? null,
    items: sent.items.map((i) => ({
      quantity: i.quantity,
      price: { id: 'pri_test_made_for_this_one', type: 'custom', ...i.price, trial_period: { ...i.price.trial_period, requires_payment_method: true } },
    })),
  };
  if (change) change(data);
  return reply(status, { data });
}

/* Answers every call create-checkout makes when all is well. Each part
   can be swapped per case. */
function checkoutRoute(over = {}) {
  route = async (c) => {
    const key = c.method + ' ' + c.path;
    if (c.host === 'proj.supabase.co') {
      if (key === 'GET /auth/v1/user') return over.user ? over.user(c) : reply(200, { id: USER_ID, email: USER_EMAIL });
      if (key === 'GET /rest/v1/subscriptions') return over.account ? over.account(c) : reply(200, [{ ...TRIAL_ROW, ...(over.row || {}) }]);
    }
    if (c.host === 'api.paddle.com') {
      if (c.method === 'GET' && c.path.startsWith('/prices/')) {
        if (over.price) return over.price(c);
        const found = CATALOGUE_BY_ID[c.path.slice('/prices/'.length)];
        return found ? reply(200, { data: { ...found, ...(over.priceIs || {}) } }) : reply(404, { error: { code: 'not_found' } });
      }
      if (key === 'GET /discounts') return over.discounts ? over.discounts(c) : reply(200, { data: [] });
      if (key === 'POST /transactions') return over.transaction ? over.transaction(c) : transactionAnswer(c, over.answer);
    }
    return undefined;
  };
}

/* One request to create-checkout, with the clock held at `now`.
   `token: null` sends no Authorization header; `raw` sends that text as
   the body in place of JSON. */
async function ask(opts = {}) {
  const now = opts.now ?? ASKED_AT;
  const method = opts.method || 'POST';
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token !== null) headers.Authorization = 'Bearer ' + (opts.token ?? 'the-users-own-session-token');
  const body = method !== 'POST' ? undefined : ('raw' in opts ? opts.raw : JSON.stringify(opts.body ?? { cadence: 'monthly' }));
  calls = [];
  logs = [];
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const response = await (opts.handler || checkout)(new Request('https://proj.supabase.co/functions/v1/create-checkout', { method, headers, body }));
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* no body */ }
    return { status: response.status, json, text, origin: response.headers.get('Access-Control-Allow-Origin'), said: logs.join('\n') };
  } finally {
    Date.now = realNow;
  }
}

const toPaddle = () => calls.filter((c) => c.host === 'api.paddle.com');
const transactions = () => calls.filter((c) => c.host === 'api.paddle.com' && c.method === 'POST' && c.path === '/transactions');
const order = () => (transactions().length === 1 ? JSON.parse(transactions()[0].body) : null);
const rowReads = () => calls.filter((c) => c.host === 'proj.supabase.co' && c.path === '/rest/v1/subscriptions');
/* The same value whatever order its keys were written in. */
const canonical = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const same = (a, b) => canonical(a) === canonical(b);
/* A refusal: the status and the short code, nothing else in the answer,
   one log line somebody can search for, and no account, email or
   transaction id anywhere. */
function refusedWith(r, status, code) {
  return r.status === status && r.json && r.json.ok === false && r.json.error === code &&
    Object.keys(r.json).sort().join() === 'error,ok' &&
    logs.length === 1 && logs[0].startsWith('Could not make checkout: ') &&
    ![USER_ID, USER_EMAIL, 'txn_'].some((secret) => r.text.includes(secret) || r.said.includes(secret));
}

{
  /* C1. The day arithmetic. A Paddle trial is whole days from the
     purchase, and the rule's date is an exact instant, so the count is
     rounded UP: the first payment is at the time of day of the purchase,
     on the first such moment at or after the rule's date. Every number
     and instant here is written out, not worked out with the function's
     own sum. "Bought" is the moment the function is asked, which is the
     earliest the purchase can be. */
  const LAUNCH = '2027-01-01T12:00:00.000Z';
  const vectors = [
    // account made            its trial ends          plan       bought                  the rule's date             days  first payment
    ['2026-11-25T03:00:00Z', '2026-12-09T03:00:00Z', 'monthly', '2026-11-25T03:00:30Z', LAUNCH,                     38, '2027-01-02T03:00:30.000Z', 'seconds after the account was made'],
    ['2026-11-25T03:00:00Z', '2026-12-09T03:00:00Z', 'annual',  '2026-11-25T03:00:30Z', LAUNCH,                     38, '2027-01-02T03:00:30.000Z', 'seconds after the account was made'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'monthly', '2027-02-01T00:00:30Z', '2027-02-22T00:00:00.000Z', 21, '2027-02-22T00:00:30.000Z', 'seconds after, once the offer is over'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'annual',  '2027-02-01T00:00:30Z', '2027-03-03T00:00:00.000Z', 30, '2027-03-03T00:00:30.000Z', 'seconds after, once the offer is over'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'monthly', '2027-02-14T00:00:00Z', '2027-02-22T00:00:00.000Z', 8,  '2027-02-22T00:00:00.000Z', 'day 13, a whole number of days short: 8, not 9'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'annual',  '2027-02-14T00:00:00Z', '2027-03-03T00:00:00.000Z', 17, '2027-03-03T00:00:00.000Z', 'day 13, a whole number of days short: 17, not 18'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'monthly', '2027-02-13T18:00:00Z', '2027-02-22T00:00:00.000Z', 9,  '2027-02-22T18:00:00.000Z', 'day 13, in the evening'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'monthly', '2027-02-14T23:59:00Z', '2027-02-22T00:00:00.000Z', 8,  '2027-02-22T23:59:00.000Z', 'the last minute of the trial'],
    ['2027-02-01T00:00:00Z', '2027-02-15T00:00:00Z', 'annual',  '2027-02-14T23:59:00Z', '2027-03-03T00:00:00.000Z', 17, '2027-03-03T23:59:00.000Z', 'the last minute of the trial'],
    ['2026-09-07T00:00:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-12-06T11:59:00Z', LAUNCH,                     27, '2027-01-02T11:59:00.000Z', 'made in September, the last minute of its trial'],
    ['2026-09-07T00:00:00Z', '2026-12-06T12:00:00Z', 'annual',  '2026-12-06T11:59:00Z', LAUNCH,                     27, '2027-01-02T11:59:00.000Z', 'made in September, the last minute of its trial'],
    ['2026-09-07T00:00:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-12-05T12:00:00Z', LAUNCH,                     27, '2027-01-01T12:00:00.000Z', 'made in September, exactly 27 days before the instant'],
    ['2026-09-07T00:00:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-12-05T12:00:01Z', LAUNCH,                     27, '2027-01-01T12:00:01.000Z', 'one second later'],
    ['2026-09-07T00:00:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-12-05T11:59:59Z', LAUNCH,                     28, '2027-01-02T11:59:59.000Z', 'one second earlier'],
    ['2026-12-20T00:00:00Z', '2027-01-03T00:00:00Z', 'monthly', '2027-01-01T11:59:59Z', '2027-01-10T00:00:00.000Z', 9,  '2027-01-10T11:59:59.000Z', 'bought a second before 1 January 12:00 UTC'],
    ['2026-12-20T00:00:00Z', '2027-01-03T00:00:00Z', 'monthly', '2027-01-01T12:00:01Z', '2027-01-10T00:00:00.000Z', 9,  '2027-01-10T12:00:01.000Z', 'bought a second after it: nothing jumps'],
    ['2026-12-20T00:00:00Z', '2027-01-03T00:00:00Z', 'annual',  '2027-01-01T11:59:59Z', '2027-01-19T00:00:00.000Z', 18, '2027-01-19T11:59:59.000Z', 'bought a second before 1 January 12:00 UTC'],
    ['2026-12-20T00:00:00Z', '2027-01-03T00:00:00Z', 'annual',  '2027-01-01T12:00:01Z', '2027-01-19T00:00:00.000Z', 18, '2027-01-19T12:00:01.000Z', 'bought a second after it: nothing jumps'],
    ['2026-12-11T11:59:59Z', '2026-12-25T11:59:59Z', 'monthly', '2026-12-11T12:59:59Z', LAUNCH,                     21, '2027-01-01T12:59:59.000Z', 'the last account whose 21 days end before 1 January 12:00 UTC'],
    ['2026-12-11T12:00:01Z', '2026-12-25T12:00:01Z', 'monthly', '2026-12-11T13:00:01Z', '2027-01-01T12:00:01.000Z', 21, '2027-01-01T13:00:01.000Z', 'the first whose own 21 days decide'],
    ['2026-12-02T11:59:59Z', '2026-12-16T11:59:59Z', 'annual',  '2026-12-02T12:59:59Z', LAUNCH,                     30, '2027-01-01T12:59:59.000Z', 'the last account whose 30 days end before 1 January 12:00 UTC'],
    ['2026-12-02T12:00:01Z', '2026-12-16T12:00:01Z', 'annual',  '2026-12-02T13:00:01Z', '2027-01-01T12:00:01.000Z', 30, '2027-01-01T13:00:01.000Z', 'the first whose own 30 days decide'],
    ['2026-12-18T12:00:00Z', '2027-01-01T12:00:00Z', 'monthly', '2027-01-01T11:59:30Z', '2027-01-08T12:00:00.000Z', 8,  '2027-01-09T11:59:30.000Z', 'a trial that ends at 1 January 12:00 UTC, bought 30 seconds before'],
    ['2026-11-22T12:00:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-11-22T12:00:01Z', LAUNCH,                     40, '2027-01-01T12:00:01.000Z', 'the first standard account, a second after it was made'],
    ['2026-11-21T13:30:00Z', '2026-12-06T12:00:00Z', 'monthly', '2026-11-21T13:31:00Z', LAUNCH,                     41, '2027-01-01T13:31:00.000Z', 'made at midnight on 22 November in Adelaide: the longest standard free period'],
    /* A trial extended by hand: the first payment never falls inside the
       free trial the customer already has. */
    ['2027-02-01T00:00:00Z', '2027-05-01T00:00:00Z', 'monthly', '2027-03-15T06:00:00Z', '2027-05-01T00:00:00.000Z', 47, '2027-05-01T06:00:00.000Z', 'a trial extended by hand to 1 May'],
    /* An old row with no end date and a rule date long past: one day,
       never none. This path is for someone who owes nothing today. */
    ['2026-09-07T00:00:00Z', null,                   'monthly', '2027-03-15T06:00:00Z', LAUNCH,                     1,  '2027-03-16T06:00:00.000Z', 'a trial row with no end date, long after the rule\'s date'],
  ];
  for (const [created, ends, cadence, bought, target, days, first, what] of vectors) {
    const T = 'C1 account made ' + created + ', ' + cadence + ', bought ' + bought + ' (' + what + '): ';
    checkoutRoute({ row: { created_at: created, current_period_end: ends } });
    const r = await ask({ body: { cadence }, now: at(bought) });
    const sent = order();
    check(T + days + ' whole days are asked of Paddle', r.status === 200 && sent !== null &&
      same(sent.items[0].price.trial_period, { interval: 'day', frequency: days }), { r, trial: sent && sent.items[0].price.trial_period });
    check(T + 'the answer says ' + days + ' days and the rule\'s date ' + target,
      r.json && r.json.ok === true && r.json.trialDays === days && r.json.firstPaymentFrom === target && r.json.transactionId === TXN_ID &&
      Object.keys(r.json).sort().join() === 'firstPaymentFrom,ok,transactionId,trialDays', r.json);
    check(T + 'the first payment is ' + first + ', never before the rule\'s date', iso(at(bought) + days * DAY) === first && at(first) >= at(target));
    if (at(target) > at(bought)) {
      check(T + '...and less than 24 hours after it, with one day fewer landing before it',
        at(first) - at(target) < DAY && at(first) - DAY < at(target));
    }
    check(T + 'the transaction carries the same day count and date for the record',
      sent !== null && sent.custom_data.trial_days === days && sent.custom_data.first_payment_from === target, sent && sent.custom_data);
  }
  check('C1 the longest standard free period is 41 days', Math.max(...vectors.filter((v) => v[1] !== null && at(v[1]) - at(v[0]) <= 15 * DAY).map((v) => v[5])) === 41);

  /* Every account, every day of its trial, both plans, before the new
     year and after it. The first payment (asked-at plus the days) is at
     or after the rule's date, and one day fewer would be before it. The
     rule's date here is worked out without the trial's end, which shows
     that for a standard account the end of the trial never decides. */
  const bad = [];
  let tried = 0;
  let longest = 0;
  for (let day = at('2026-11-21T00:00:00Z'); day <= at('2027-02-10T00:00:00Z'); day += DAY) {
    for (const timeOfDay of [0, 7.25 * 3600000, 22.5 * 3600000 + 1000]) {
      const created = day + timeOfDay;
      const ends = created < TRIAL_BOUNDARY ? TRIAL_FINISH : created + 14 * DAY;
      for (const after of [1000, DAY, 6.5 * DAY, 13 * DAY + 3599000, ends - created - 1000]) {
        const now = created + after;
        if (now >= ends) continue;
        for (const cadence of ['monthly', 'annual']) {
          checkoutRoute({ row: { created_at: iso(created), current_period_end: iso(ends) } });
          const r = await ask({ body: { cadence }, now });
          tried++;
          const target = Math.max(created + (cadence === 'monthly' ? 21 : 30) * DAY, CLOSES);
          const n = r.json && r.json.trialDays;
          const sent = order();
          if (now >= at('2026-11-21T12:00:00Z')) longest = Math.max(longest, n || 0);
          const ok = r.status === 200 && Number.isInteger(n) && n >= 1 &&
            sent !== null && sent.items[0].price.trial_period.frequency === n &&
            r.json.firstPaymentFrom === iso(target) &&
            now + n * DAY >= target && now + (n - 1) * DAY < target;
          if (!ok) bad.push({ created: iso(created), bought: iso(now), cadence, n, from: r.json && r.json.firstPaymentFrom });
        }
      }
    }
  }
  check('C1 every account, every day of its trial, both plans: the days land at or after the rule\'s date and one fewer would not (' + tried + ' checkouts)',
    bad.length === 0 && tried > 2000, bad.slice(0, 5));
  check('C1 ...and nobody subscribing from 12:00 UTC on 21 November 2026 gets more than 41 days', longest === 41, longest);

  /* A row that cannot be trusted makes nothing. */
  const unreadable = {
    'a creation date that does not parse': { created_at: 'last week' },
    'no creation date': { created_at: null },
    'a trial end that does not parse': { current_period_end: 'soon' },
  };
  for (const [name, row] of Object.entries(unreadable)) {
    checkoutRoute({ row });
    const r = await ask();
    check('C1 ' + name + ': 503, and Paddle is not called', refusedWith(r, 503, 'account_unreadable') && toPaddle().length === 0, { r, keys: keys() });
  }
  /* A free period past a year is a wrong date on the row, not a gift. */
  const march = at('2027-03-15T06:00:00Z');
  checkoutRoute({ row: { created_at: '2027-02-01T00:00:00Z', current_period_end: iso(march + 366 * DAY + 1000) } });
  const tooLong = await ask({ now: march });
  check('C1 a row that would give 367 days: 503, and Paddle is not called',
    refusedWith(tooLong, 503, 'account_unreadable') && tooLong.said.includes('the free period is out of range') && toPaddle().length === 0, { tooLong, keys: keys() });
  checkoutRoute({ row: { created_at: '2027-02-01T00:00:00Z', current_period_end: iso(march + 366 * DAY) } });
  const longest366 = await ask({ now: march });
  check('C1 ...while 366 days, the stop itself, still goes through', longest366.status === 200 && longest366.json.trialDays === 366, longest366);
}

{
  /* C2. Who is asking, and what they can make it do. The account comes
     from the access token and from nowhere else. */
  checkoutRoute();
  const plainAsk = await ask();
  const authCall = calls.find((c) => c.path === '/auth/v1/user');
  check('C2 the token is checked with Supabase, with the publishable key and the caller\'s own token',
    Boolean(authCall) && authCall.headers.apikey === 'publishable-test-key' && authCall.headers.Authorization === 'Bearer the-users-own-session-token', authCall && authCall.headers);
  check('C2 the row is read for the account the token belongs to, with the service key',
    rowReads().length === 1 && rowReads()[0].url === 'https://proj.supabase.co/rest/v1/subscriptions?user_id=eq.' + USER_ID +
      '&select=created_at,plan,status,current_period_end,cancel_at_period_end,complimentary' &&
    rowReads()[0].headers.apikey === 'service-key' && rowReads()[0].headers.Authorization === 'Bearer service-key', rowReads().map((c) => c.url));
  check('C2 the transaction is tied to that account by the server', plainAsk.status === 200 && order().custom_data.user_id === USER_ID, order());
  check('C2 the order of work: sign-in check, the row, the catalogue price, then the transaction',
    keys().join(' | ') === 'GET /auth/v1/user | GET /rest/v1/subscriptions | GET api.paddle.com/prices/' + CATALOGUE.monthly.id + ' | POST api.paddle.com/transactions', keys());
  check('C2 Paddle is called with the server key', toPaddle().every((c) => c.headers.Authorization === 'Bearer test-paddle-key'), toPaddle().map((c) => c.headers));
  check('C2 the answer carries the CORS header the browser needs', plainAsk.origin === '*');
  const honest = calls.map((c) => [c.method, c.url, c.body]);

  /* Everything else a browser might send is ignored. The requests that
     follow are the same, byte for byte. */
  const OTHER = '11111111-2222-4333-8444-555555555555';
  checkoutRoute();
  const greedy = await ask({ body: {
    cadence: 'monthly', user_id: OTHER, userId: OTHER, account: OTHER, email: 'other@example.test',
    priceId: 'pri_something_else', price_id: 'pri_something_else', price: { unit_price: { amount: '1', currency_code: 'AUD' } },
    days: 400, trialDays: 400, trial_days: 400, trial_period: { interval: 'day', frequency: 400 },
    date: '2030-01-01T00:00:00Z', firstPaymentFrom: '2030-01-01T00:00:00Z', next_billed_at: '2030-01-01T00:00:00Z', now: '2020-01-01T00:00:00Z',
    custom_data: { user_id: OTHER }, customData: { user_id: OTHER }, plan: 'trial', created_at: '2030-01-01T00:00:00Z',
  } });
  check('C2 a body that also names an account, a price, a day count, a trial and dates changes nothing: the same requests, byte for byte',
    greedy.status === 200 && JSON.stringify(calls.map((c) => [c.method, c.url, c.body])) === JSON.stringify(honest) && greedy.text === plainAsk.text, calls.map((c) => c.body));
  check('C2 ...and the other account id appears nowhere', !calls.some((c) => (c.url + String(c.body)).includes(OTHER)));
  const code = CHECKOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readFromBody = [...new Set([...code.matchAll(/\basked\??\.(\w+)/g)].map((m) => m[1]))].sort();
  check('C2 the function reads two things from the body, the plan and a discount code', readFromBody.join() === 'cadence,discountCode', readFromBody);

  /* No token, or one Supabase does not accept. */
  checkoutRoute();
  const noToken = await ask({ token: null });
  check('C2 no token: 401, and nothing is fetched at all', refusedWith(noToken, 401, 'not_signed_in') && calls.length === 0, { noToken, keys: keys() });
  checkoutRoute();
  const emptyToken = await ask({ token: '' });
  check('C2 an empty token: 401, and nothing is fetched', refusedWith(emptyToken, 401, 'not_signed_in') && calls.length === 0, keys());
  checkoutRoute({ user: () => reply(401, { msg: 'invalid JWT' }) });
  const badToken = await ask();
  check('C2 a token Supabase rejects: 401, no row is read and nothing goes to Paddle',
    refusedWith(badToken, 401, 'not_signed_in') && rowReads().length === 0 && toPaddle().length === 0 && calls.length === 1, keys());
  checkoutRoute({ user: () => reply(200, { email: USER_EMAIL }) });
  const noId = await ask();
  check('C2 a sign-in answer with no account id: 401, no row is read', refusedWith(noId, 401, 'not_signed_in') && rowReads().length === 0 && toPaddle().length === 0, keys());
  checkoutRoute({ user: () => { throw new TypeError('fetch failed'); } });
  const authDown = await ask();
  check('C2 the sign-in check out of reach: 503, no row is read', refusedWith(authDown, 503, 'account_unreadable') && rowReads().length === 0 && toPaddle().length === 0, keys());

  checkoutRoute();
  const viaGet = await ask({ method: 'GET' });
  check('C2 a GET: 405, and nothing is fetched', refusedWith(viaGet, 405, 'method') && calls.length === 0, { viaGet, keys: keys() });
  checkoutRoute();
  const preflight = await ask({ method: 'OPTIONS', token: null });
  check('C2 an OPTIONS preflight: 204, the CORS headers, and nothing is fetched or logged',
    preflight.status === 204 && preflight.text === '' && preflight.origin === '*' && calls.length === 0 && logs.length === 0, { preflight, keys: keys() });

  const badBodies = {
    'a plan called "weekly"': { body: { cadence: 'weekly' } },
    'a plan called "Monthly"': { body: { cadence: 'Monthly' } },
    'a plan called "yearly"': { body: { cadence: 'yearly' } },
    'a plan that is a number': { body: { cadence: 12 } },
    'no plan': { body: {} },
    'a body that is not JSON': { raw: 'cadence=monthly' },
    'an empty body': { raw: '' },
    'a body of null': { raw: 'null' },
    'a discount code that is a number': { body: { cadence: 'monthly', discountCode: 10 } },
    'a discount code that is a list': { body: { cadence: 'monthly', discountCode: ['A'] } },
  };
  for (const [name, request] of Object.entries(badBodies)) {
    checkoutRoute();
    const r = await ask(request);
    check('C2 ' + name + ': 400, no row is read and nothing goes to Paddle', refusedWith(r, 400, 'bad_request') && rowReads().length === 0 && toPaddle().length === 0, { r, keys: keys() });
  }
}

{
  /* C2. Who is turned away. The function makes a transaction for an
     account whose OWN free trial is running, and for nobody else: it
     never makes a pay-today transaction, never a second subscription,
     and never gives a free period to an account whose trial has ended. */
  const future = '2027-06-01T00:00:00Z';
  const past = '2026-11-20T00:00:00Z';
  const subscribed = {
    'subscribed monthly, waiting for the first payment': { plan: 'monthly', status: 'trialing', current_period_end: future },
    'subscribed yearly, waiting for the first payment': { plan: 'annual', status: 'trialing', current_period_end: future },
    'a paying subscriber': { plan: 'annual', status: 'active', current_period_end: future },
    'a paying subscriber with no period end on the row': { plan: 'monthly', status: 'active', current_period_end: null },
    'a subscriber whose payment is overdue': { plan: 'monthly', status: 'past_due', current_period_end: future },
  };
  for (const [name, row] of Object.entries(subscribed)) {
    for (const cadence of ['monthly', 'annual']) {
      checkoutRoute({ row });
      const r = await ask({ body: { cadence } });
      check('C2 ' + name + ', asking for ' + cadence + ': 409 already subscribed, and nothing goes to Paddle',
        refusedWith(r, 409, 'already_subscribed') && toPaddle().length === 0, { r, keys: keys() });
    }
  }
  const notInTrial = {
    'a trial that has ended': { current_period_end: past },
    'a trial that ends at this very instant': { current_period_end: iso(ASKED_AT) },
    'a trial marked expired': { status: 'expired' },
    'a trial marked canceled': { status: 'canceled' },
    'a trial with no status': { status: null },
    'no plan at all': { plan: null, status: 'none', current_period_end: null },
    'a cancelled subscription that has finished': { plan: 'monthly', status: 'canceled', current_period_end: past },
    'a subscription that lapsed unpaid': { plan: 'annual', status: 'active', current_period_end: past },
    'complimentary access': { plan: 'complimentary', status: 'active', complimentary: true, current_period_end: null },
    'a subscription set to end': { plan: 'monthly', status: 'active', cancel_at_period_end: true, current_period_end: future },
    'a subscription set to end before its first payment': { plan: 'annual', status: 'trialing', cancel_at_period_end: true, current_period_end: future },
    'a plan this function does not know': { plan: 'lifetime', status: 'active', current_period_end: future },
  };
  for (const [name, row] of Object.entries(notInTrial)) {
    for (const cadence of ['monthly', 'annual']) {
      checkoutRoute({ row });
      const r = await ask({ body: { cadence } });
      check('C2 ' + name + ', asking for ' + cadence + ': 409 not in trial, and nothing goes to Paddle',
        refusedWith(r, 409, 'not_in_trial') && toPaddle().length === 0, { r, keys: keys() });
    }
  }
  /* Status "trialing" is what Paddle reports for a subscriber waiting
     for their first payment too. Only plan "trial" is a free trial. */
  const code = CHECKOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('C2 the free trial is plan "trial" and entitled, never status "trialing" alone',
    /if \(!\(row\.plan === "trial" && entitled\)\) \{/.test(code) && (code.match(/"trialing"/g) || []).length === 1);

  const unreadable = {
    'no row for the account': () => reply(200, []),
    'a row lookup answering 500': () => reply(500, { message: 'no' }),
    'a row lookup answering 404': () => reply(404, { message: 'no' }),
    'a row lookup answering something that is not JSON': () => reply(200, '<html>gateway</html>'),
    'a row lookup answering something that is not a list': () => reply(200, { message: 'odd' }),
    'a row lookup out of reach': () => { throw new TypeError('fetch failed'); },
  };
  for (const [name, account] of Object.entries(unreadable)) {
    checkoutRoute({ account });
    const r = await ask();
    check('C2 ' + name + ': 503, and nothing goes to Paddle', refusedWith(r, 503, 'account_unreadable') && toPaddle().length === 0, { r, keys: keys() });
  }

  checkoutRoute();
  const noKey = await ask({ handler: checkoutNoKey });
  check('C2 no PADDLE_API_KEY: 503 not configured, and nothing goes to Paddle',
    refusedWith(noKey, 503, 'not_configured') && noKey.said === 'Could not make checkout: PADDLE_API_KEY not set.' && toPaddle().length === 0, { noKey, keys: keys() });
  checkoutRoute({ row: { plan: 'monthly', status: 'active', current_period_end: future } });
  const noKeySubscribed = await ask({ handler: checkoutNoKey });
  check('C2 ...and a subscriber is still told they are subscribed, key or no key', refusedWith(noKeySubscribed, 409, 'already_subscribed'), noKeySubscribed);
}

{
  /* C2. What is asked of Paddle. One item, on a price made for this
     transaction alone: everything about what the customer pays is copied
     from the plain catalogue price as Paddle answers for it, and the
     free days are added. */
  for (const [cadence, word, interval] of [['monthly', 'monthly', 'month'], ['annual', 'yearly', 'year']]) {
    const plain = CATALOGUE[cadence];
    checkoutRoute();
    const r = await ask({ body: { cadence } });
    const sent = order();
    check('C2 ' + cadence + ': the catalogue price read is the plain one for that plan, and no discount is looked up',
      toPaddle().length === 2 && toPaddle()[0].method === 'GET' && toPaddle()[0].url === 'https://api.paddle.com/prices/' + plain.id, keys());
    check('C2 ' + cadence + ': the transaction is exactly this, and nothing more', r.status === 200 && same(sent, {
      items: [{ quantity: 1, price: {
        product_id: PRODUCT_ID,
        description: 'Premium ' + word + ', first payment after 38 days (create-checkout)',
        name: plain.name,
        billing_cycle: { interval, frequency: 1 },
        trial_period: { interval: 'day', frequency: 38 },
        tax_mode: 'internal',
        unit_price: plain.unit_price,
        unit_price_overrides: plain.unit_price_overrides,
        quantity: { minimum: 1, maximum: 1 },
      } }],
      collection_mode: 'automatic',
      custom_data: { user_id: USER_ID, trial_days: 38, first_payment_from: '2027-01-01T12:00:00.000Z', made_by: 'create-checkout' },
    }), sent);
    check('C2 ' + cadence + ': no customer, address or currency is set, so checkout fills them in',
      sent !== null && !['customer_id', 'address_id', 'currency_code', 'customer', 'discount_id'].some((k) => k in sent), sent && Object.keys(sent));
    check('C2 ' + cadence + ': the description names no account and no email',
      sent !== null && !sent.items[0].price.description.includes(USER_ID) && !sent.items[0].price.description.includes('@'));
    check('C2 ' + cadence + ': the success line in the log has the plan, the days and the date, and no id',
      logs.length === 1 && r.said === 'checkout made: ' + word + ', 38 days, first payment from 2027-01-01T12:00:00.000Z' &&
      !r.said.includes(USER_ID) && !r.said.includes(TXN_ID), logs);
    check('C2 ' + cadence + ': only the 200 answer carries the transaction id, and it carries no account id or email',
      r.json.transactionId === TXN_ID && !r.text.includes(USER_ID) && !r.text.includes(USER_EMAIL), r.text);
  }

  /* A price changed in Paddle is the price charged: nothing about the
     amount is written in the function. */
  checkoutRoute({ priceIs: { unit_price: { amount: '350', currency_code: 'NZD' }, tax_mode: 'external', unit_price_overrides: [{ country_codes: ['GB'], unit_price: { amount: '199', currency_code: 'GBP' } }] } });
  const changed = await ask();
  const changedPrice = changed.status === 200 ? order().items[0].price : {};
  check('C2 a price changed in Paddle is what the transaction carries: amount, currency, tax setting and per-country prices',
    same(changedPrice.unit_price, { amount: '350', currency_code: 'NZD' }) && changedPrice.tax_mode === 'external' &&
    same(changedPrice.unit_price_overrides, [{ country_codes: ['GB'], unit_price: { amount: '199', currency_code: 'GBP' } }]), changedPrice);
  checkoutRoute({ priceIs: { name: null, tax_mode: undefined, unit_price_overrides: undefined } });
  const bare = await ask();
  const barePrice = bare.status === 200 ? order().items[0].price : null;
  check('C2 a catalogue price with no name, no tax setting and no per-country prices: none is invented',
    barePrice !== null && !('name' in barePrice) && !('tax_mode' in barePrice) && same(barePrice.unit_price_overrides, []), barePrice);
  const code = CHECKOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const amounts = [...code.matchAll(/\bamount:\s*([^,}]+)/g)].map((m) => m[1].trim());
  check('C2 no amount and no currency is written in the function: both come from the catalogue price',
    amounts.length === 1 && amounts[0] === 'plain.unit_price.amount' && !/AUD|NZD|USD/.test(code) && !/["'`]\d{3,4}["'`]/.test(code), amounts);

  /* The catalogue price is not as expected: nothing is made. A
     half-configured catalogue stops; it does not charge. */
  const wrongPrices = {
    'archived': { priceIs: { status: 'archived' } },
    'on the wrong billing cycle': { priceIs: { billing_cycle: { interval: 'year', frequency: 1 } } },
    'billed every three months': { priceIs: { billing_cycle: { interval: 'month', frequency: 3 } } },
    'not recurring at all': { priceIs: { billing_cycle: null } },
    'already carrying a trial of its own': { priceIs: { trial_period: { interval: 'day', frequency: 14 } } },
    'without a product': { priceIs: { product_id: null } },
    'with a product id that is not one': { priceIs: { product_id: 'premium' } },
    'with an amount that is a number': { priceIs: { unit_price: { amount: 290, currency_code: 'AUD' } } },
    'with an amount in dollars and cents': { priceIs: { unit_price: { amount: '2.90', currency_code: 'AUD' } } },
    'with no currency': { priceIs: { unit_price: { amount: '290', currency_code: '' } } },
    'answering for another price': { priceIs: { id: 'pri_another_one' } },
    'not found': { price: () => reply(404, { error: { code: 'not_found' } }) },
    'answering 500': { price: () => reply(500, { error: 'no' }) },
    'answering 403, a key that may not read prices': { price: () => reply(403, { error: { code: 'forbidden' } }) },
    'answering something that is not JSON': { price: () => reply(200, '<html>') },
    'out of reach': { price: () => { throw new TypeError('fetch failed'); } },
  };
  for (const [name, over] of Object.entries(wrongPrices)) {
    checkoutRoute(over);
    const r = await ask();
    check('C2 the catalogue price ' + name + ': 502, and no transaction is made', refusedWith(r, 502, 'paddle') && transactions().length === 0, { r, keys: keys() });
  }
}

{
  /* C2. Paddle's answer is checked before anything is handed out. A
     transaction that came back without its trial would be a charge
     today; one with another amount, cycle or account is not the one
     asked for. None of them is ever given to the browser to open. */
  const spoiled = {
    'no id': (d) => { delete d.id; },
    'an id that is not a transaction id': (d) => { d.id = 'sub_01abc'; },
    'an id with something after it': (d) => { d.id = 'txn_01abc?x=1'; },
    'one day fewer': (d) => { d.items[0].price.trial_period.frequency = 37; },
    'one day more': (d) => { d.items[0].price.trial_period.frequency = 39; },
    'the days as text': (d) => { d.items[0].price.trial_period.frequency = '38'; },
    'a trial in weeks': (d) => { d.items[0].price.trial_period.interval = 'week'; },
    'no trial at all': (d) => { d.items[0].price.trial_period = null; },
    'a trial that needs no payment method': (d) => { d.items[0].price.trial_period.requires_payment_method = false; },
    'another amount': (d) => { d.items[0].price.unit_price.amount = '2900'; },
    'another currency': (d) => { d.items[0].price.unit_price.currency_code = 'USD'; },
    'another billing cycle': (d) => { d.items[0].price.billing_cycle.interval = 'year'; },
    'a billing cycle of two months': (d) => { d.items[0].price.billing_cycle.frequency = 2; },
    'another product': (d) => { d.items[0].price.product_id = 'pro_another'; },
    'another account': (d) => { d.custom_data.user_id = '11111111-2222-4333-8444-555555555555'; },
    'no custom data': (d) => { d.custom_data = null; },
    'two items': (d) => { d.items.push(d.items[0]); },
    'no items': (d) => { d.items = []; },
    'a quantity of 2': (d) => { d.items[0].quantity = 2; },
    'invoiced by hand, not charged automatically': (d) => { d.collection_mode = 'manual'; },
  };
  for (const [name, change] of Object.entries(spoiled)) {
    checkoutRoute({ answer: change });
    const r = await ask();
    check('C2 Paddle answering with ' + name + ': 502, and the transaction id is not handed out',
      refusedWith(r, 502, 'paddle') && r.said === 'Could not make checkout: Paddle\'s answer did not match what was asked for.' && transactions().length === 1, { r, logs });
  }
  const failures = {
    'refusing with 400': () => reply(400, { error: { code: 'bad_request', detail: 'no' } }),
    'refusing with 403, a key that may not write transactions': () => reply(403, { error: { code: 'forbidden' } }),
    'answering 500': () => reply(500, { error: 'no' }),
    'answering 200 with something that is not JSON': () => reply(200, '<html>'),
    'answering 200 with no data': () => reply(200, {}),
    'out of reach': () => { throw new TypeError('fetch failed'); },
  };
  for (const [name, transaction] of Object.entries(failures)) {
    checkoutRoute({ transaction });
    const r = await ask();
    check('C2 Paddle ' + name + ': 502, and nothing is handed out', refusedWith(r, 502, 'paddle'), { r, logs });
  }
  for (const status of [200, 201]) {
    checkoutRoute({ transaction: (c) => transactionAnswer(c, (d) => { delete d.collection_mode; }, status) });
    const r = await ask();
    check('C2 a good answer with status ' + status + ' and no collection mode stated is accepted', r.status === 200 && r.json.transactionId === TXN_ID, r);
  }

  /* Paddle's own words are logged for a refused transaction, cut short,
     with the account and its email taken out first. */
  checkoutRoute({ transaction: () => reply(400, { error: { code: 'invalid_field', detail: 'custom_data.user_id ' + USER_ID + ' of ' + USER_EMAIL + ' ' + 'x'.repeat(900) } }) });
  const quoted = await ask();
  check('C2 a refusal that quotes the account back: the log names the status, and not the account or the email',
    refusedWith(quoted, 502, 'paddle') && quoted.said.startsWith('Could not make checkout: Paddle refused the transaction with 400: ') &&
    quoted.said.includes('invalid_field') && quoted.said.includes('[account]') && quoted.said.includes('[email]'), logs);
  check('C2 ...and what Paddle said is cut to 300 characters',
    quoted.said.length <= 'Could not make checkout: Paddle refused the transaction with 400: '.length + 300, quoted.said.length);

  /* Something nobody planned for is still a refusal, never an opened
     checkout, and its own text is not logged. */
  checkoutRoute({ account: () => reply(200, [null]) });
  const odd = await ask();
  check('C2 a row that is not a row: 503, and nothing goes to Paddle', refusedWith(odd, 503, 'account_unreadable') && toPaddle().length === 0, odd);
}

{
  /* C2. A discount code. The code a customer typed is turned into
     Paddle's own id for it on the server, set on the transaction, and
     Paddle's answer must carry it. The function never carries on without
     a code the customer typed: they would see a price they were not
     expecting. */
  const DISCOUNT = { id: 'dsc_01test0early', code: 'EARLY10', status: 'active', enabled_for_checkout: true };
  const found = (list) => () => reply(200, { data: list });

  checkoutRoute({ discounts: found([DISCOUNT]) });
  const typed = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
  const lookup = toPaddle().find((c) => c.path === '/discounts');
  check('C2 a typed code is looked up in Paddle, among active discounts, after the price and before the transaction',
    Boolean(lookup) && lookup.url === 'https://api.paddle.com/discounts?code=EARLY10&status=active' &&
    keys().slice(2).join(' | ') === 'GET api.paddle.com/prices/' + CATALOGUE.monthly.id + ' | GET api.paddle.com/discounts | POST api.paddle.com/transactions', keys());
  check('C2 ...and set on the transaction by Paddle\'s own id, never by the typed text',
    typed.status === 200 && order().discount_id === 'dsc_01test0early' && !transactions()[0].body.includes('EARLY10'), order());
  const withDiscount = order();
  checkoutRoute();
  await ask();
  check('C2 ...and the rest of the transaction is the same as without a code: the same price, the same free days, the same account',
    same(withDiscount, { ...order(), discount_id: 'dsc_01test0early' }) && withDiscount.items[0].price.trial_period.frequency === 38, withDiscount);

  for (const [name, code] of Object.entries({ 'in lower case': 'early10', 'with spaces around it': '  EARLY10  ' })) {
    checkoutRoute({ discounts: found([DISCOUNT]) });
    const r = await ask({ body: { cadence: 'annual', discountCode: code } });
    check('C2 the code typed ' + name + ' is the same code', r.status === 200 && order().discount_id === 'dsc_01test0early' &&
      toPaddle().find((c) => c.path === '/discounts').url === 'https://api.paddle.com/discounts?code=' + code.trim() + '&status=active', keys());
  }
  checkoutRoute({ discounts: found([DISCOUNT]), answer: (d) => { d.discount_id = null; } });
  const dropped = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
  check('C2 Paddle answering without the discount that was set: 502, and the transaction is not handed out', refusedWith(dropped, 502, 'paddle'), dropped);
  checkoutRoute({ discounts: found([DISCOUNT]), answer: (d) => { d.discount_id = 'dsc_another'; } });
  const swapped = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
  check('C2 ...or with a different one: 502', refusedWith(swapped, 502, 'paddle'), swapped);

  const notFound = {
    'no discount has that code': [],
    'the list holds other codes only': [{ ...DISCOUNT, code: 'OTHER' }],
    'the discount is archived': [{ ...DISCOUNT, status: 'archived' }],
    'the discount is not open to checkout': [{ ...DISCOUNT, enabled_for_checkout: false }],
    'the discount has no code': [{ ...DISCOUNT, code: null }],
  };
  for (const [name, list] of Object.entries(notFound)) {
    checkoutRoute({ discounts: found(list) });
    const r = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
    check('C2 ' + name + ': 422, and no transaction is made', refusedWith(r, 422, 'discount_not_found') && transactions().length === 0, { r, keys: keys() });
  }
  /* "Active" in Paddle's list only means not archived. A discount that
     has reached its end date, has been used as often as it allows, or is
     kept to other products or prices is still listed as active, and
     Paddle's overlay is no longer there to say so. Each is answered as
     not found, with no transaction made. The clock is the server's:
     these are asked at 2026-11-25T03:00:30Z. */
  const unusable = {
    'the discount ended yesterday': [{ expires_at: '2026-11-24T03:00:30Z' }, 'has ended'],
    'the discount ended a second ago': [{ expires_at: '2026-11-25T03:00:29Z' }, 'has ended'],
    'the discount ends at this very instant': [{ expires_at: '2026-11-25T03:00:30Z' }, 'has ended'],
    'the discount has been used as often as it allows': [{ usage_limit: 50, times_used: 50 }, 'used as many times as it allows'],
    'the discount has been used more often than it allows': [{ usage_limit: 1, times_used: 3 }, 'used as many times as it allows'],
    'the discount is kept to the plain monthly price, which the copied price is not': [{ restrict_to: [CATALOGUE.monthly.id] }, 'kept to other products or prices'],
    'the discount is kept to both plain prices': [{ restrict_to: [CATALOGUE.monthly.id, CATALOGUE.annual.id] }, 'kept to other products or prices'],
    'the discount is kept to another product': [{ restrict_to: ['pro_01test0another'] }, 'kept to other products or prices'],
  };
  for (const [name, [fields, why]] of Object.entries(unusable)) {
    checkoutRoute({ discounts: found([{ ...DISCOUNT, usage_limit: null, times_used: 0, restrict_to: null, expires_at: null, ...fields }]) });
    const r = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
    check('C2 ' + name + ': 422, no transaction is made, and the log says why',
      refusedWith(r, 422, 'discount_not_found') && transactions().length === 0 && r.said.includes(why), { r, keys: keys() });
  }
  const usable = {
    'a discount with no end date, no limit and no restriction, each stated as null': {},
    'a discount that ends a second from now': { expires_at: '2026-11-25T03:00:31Z' },
    'a discount that ends next year': { expires_at: '2027-06-30T00:00:00Z' },
    'a discount with one use left': { usage_limit: 50, times_used: 49 },
    'a discount with no limit that has been used many times': { usage_limit: null, times_used: 900 },
    'a discount kept to this product': { restrict_to: [PRODUCT_ID] },
    'a discount kept to this product and to a price': { restrict_to: [CATALOGUE.annual.id, PRODUCT_ID] },
    'a discount with an empty list of restrictions': { restrict_to: [] },
  };
  for (const [name, fields] of Object.entries(usable)) {
    checkoutRoute({ discounts: found([{ ...DISCOUNT, usage_limit: null, times_used: 0, restrict_to: null, expires_at: null, ...fields }]) });
    const r = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
    check('C2 ' + name + ' is set on the transaction', r.status === 200 && order() !== null && order().discount_id === 'dsc_01test0early', { r, keys: keys() });
  }
  checkoutRoute({ discounts: found([{ ...DISCOUNT, expires_at: 'next week' }]) });
  const oddEnd = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
  check('C2 an end date that does not parse: 502, and no transaction is made without knowing', refusedWith(oddEnd, 502, 'paddle') && transactions().length === 0, oddEnd);
  /* The end date is judged on the server's clock, not on anything sent. */
  checkoutRoute({ discounts: found([{ ...DISCOUNT, expires_at: '2026-12-01T00:00:00Z' }]) });
  const beforeEnd = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' }, now: at('2026-11-30T23:59:59Z') });
  checkoutRoute({ discounts: found([{ ...DISCOUNT, expires_at: '2026-12-01T00:00:00Z' }]) });
  const afterEnd = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10', now: '2026-11-30T23:59:59Z', expires_at: '2099-01-01T00:00:00Z' }, now: at('2026-12-01T00:00:00Z') });
  check('C2 the same discount is taken a second before its end date and turned away at it, whatever the request says',
    beforeEnd.status === 200 && refusedWith(afterEnd, 422, 'discount_not_found') && transactions().length === 0, { beforeEnd, afterEnd });

  for (const [name, code] of Object.entries({ 'a comma': 'EARLY,LATE', 'a space': 'EARLY 10', 'an ampersand': 'A&status=archived', 'a slash': 'A/B', '65 characters': 'A'.repeat(65) })) {
    checkoutRoute({ discounts: found([DISCOUNT]) });
    const r = await ask({ body: { cadence: 'monthly', discountCode: code } });
    check('C2 a code with ' + name + ' is not the shape of a code: 422, and Paddle is not asked at all', refusedWith(r, 422, 'discount_not_found') && toPaddle().length === 0, { r, keys: keys() });
  }
  const lookupFailures = {
    'the lookup answering 500': () => reply(500, { error: 'no' }),
    'the lookup answering 403, a key that may not read discounts': () => reply(403, { error: { code: 'forbidden' } }),
    'the lookup out of reach': () => { throw new TypeError('fetch failed'); },
    'the lookup answering with no list': () => reply(200, { data: null }),
    'two discounts with that code': found([DISCOUNT, { ...DISCOUNT, id: 'dsc_01test0second' }]),
    'a discount with an id that is not one': found([{ ...DISCOUNT, id: 'early' }]),
  };
  for (const [name, discounts] of Object.entries(lookupFailures)) {
    checkoutRoute({ discounts });
    const r = await ask({ body: { cadence: 'monthly', discountCode: 'EARLY10' } });
    check('C2 ' + name + ': 502, and no transaction is made without the code', refusedWith(r, 502, 'paddle') && transactions().length === 0, { r, keys: keys() });
  }
  for (const [name, body] of Object.entries({ 'no code': { cadence: 'monthly' }, 'an empty code': { cadence: 'monthly', discountCode: '' }, 'a code of spaces': { cadence: 'monthly', discountCode: '   ' } })) {
    checkoutRoute({ discounts: () => { throw new Error('the discounts list must not be asked for'); } });
    const r = await ask({ body });
    check('C2 ' + name + ': no discount is looked up and none is set', r.status === 200 && !toPaddle().some((c) => c.path === '/discounts') && !('discount_id' in order()), keys());
  }
}

{
  /* C2. The rule's constants are repeated from paddle-webhook. If one
     moves, both move. */
  const stripped = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = stripped(CHECKOUT_SOURCE);
  const hook = stripped(WEBHOOK_SOURCE);
  const constant = (source, pattern) => (source.match(pattern) || [])[1];
  const launch = /const LAUNCH_FIRST_CHARGE = Date\.parse\("([^"]+)"\);/;
  check('C2 LAUNCH_FIRST_CHARGE is the same instant in create-checkout and paddle-webhook: 2027-01-01T12:00:00Z',
    constant(code, launch) === '2027-01-01T12:00:00Z' && constant(code, launch) === constant(hook, launch), [constant(code, launch), constant(hook, launch)]);
  check('C2 ...and so are the two lengths: 30 days yearly, 21 days monthly',
    constant(code, /const FREE_DAYS_YEARLY = (\d+);/) === '30' && constant(hook, /const FREE_DAYS_YEARLY = (\d+);/) === '30' &&
    constant(code, /const FREE_DAYS_MONTHLY = (\d+);/) === '21' && constant(hook, /const FREE_DAYS_MONTHLY = (\d+);/) === '21');
  check('C2 ...and a day', constant(code, /const DAY_MS = (\d+);/) === '86400000' && constant(hook, /const DAY_MS = (\d+);/) === '86400000');
  check('C2 the only date written into create-checkout is LAUNCH_FIRST_CHARGE',
    [...code.matchAll(/Date\.parse\("([^"]+)"\)/g)].length === 1 && !/\b20\d\d-\d\d-\d\d/.test(code.replace('2027-01-01T12:00:00Z', '')));
  check('C2 the count is rounded UP, never down, and never less than one day',
    /const days = Math\.max\(1, Math\.ceil\(\(target - now\) \/ DAY_MS\)\);/.test(code) && !/Math\.(floor|round|trunc)\(/.test(code));
  check('C2 the stop on a free period of more than a year is 366 days', constant(code, /const MAX_TRIAL_DAYS = (\d+);/) === '366');
  const plainPrices = constant(code, /const PLAIN_PRICE[^=]*= \{([^}]*)\};/) || '';
  check('C2 the two plain prices in create-checkout are the two in app/config.js',
    constant(plainPrices, /monthly: "([^"]+)"/) === configId('monthlyPriceId') && constant(plainPrices, /annual: "([^"]+)"/) === configId('annualPriceId') &&
    Boolean(configId('monthlyPriceId')) && Boolean(configId('annualPriceId')), plainPrices);
  check('C2 ...and neither retired catalogue trial price is anywhere in it',
    !CHECKOUT_SOURCE.includes(configId('monthlyTrialPriceId')) && !CHECKOUT_SOURCE.includes(configId('annualTrialPriceId')));
  check('C2 create-checkout holds no export (the harness, like Supabase, runs it as a script)', !/^\s*export\b/m.test(code));
  check('C2 it uses the same sandbox switch as paddle-webhook, not a host written in',
    /Deno\.env\.get\("PADDLE_ENVIRONMENT"\) \?\? "production"\) === "sandbox"/.test(code) && code.includes('https://sandbox-api.paddle.com') && code.includes('https://api.paddle.com'));
  check('C2 it never changes a subscription and never opens a portal: three kinds of call to Paddle, and no more',
    (code.match(/await paddle\(/g) || []).length === 3 && /paddle\("GET", `\/prices\//.test(code) && /paddle\("GET", `\/discounts\?/.test(code) && /paddle\("POST", "\/transactions"/.test(code));
}

/* ───────────────── Part E: expire-checkouts, run for real ─────────────────
   The function that cancels the prepared purchases create-checkout made
   and nobody paid for within an hour. Paddle's list, its single read and
   its cancel are all answered here. None of this has met Paddle: what
   the stub does is what Paddle's documentation says (read 25 Nov 2026),
   and DEPLOY.md 8.4 Test D is the first real look. */

const E_NOW = at('2026-11-25T05:00:00Z');
const CANCEL_TEXT = '{"status":"canceled"}';
let txnCount = 0;
/* A transaction as create-checkout leaves it: an unpaid draft, made
   through the API, about two hours old at E_NOW. Ids rise in the order
   they are made, as Paddle's do. */
function txn(over = {}) {
  txnCount++;
  return {
    id: 'txn_01e' + String(txnCount).padStart(6, '0'), status: 'draft', origin: 'api', collection_mode: 'automatic',
    subscription_id: null, invoice_number: null, billed_at: null,
    custom_data: { user_id: USER_ID, trial_days: 38, first_payment_from: '2027-01-01T12:00:00.000Z', made_by: 'create-checkout' },
    customer_id: 'ctm_01test', created_at: '2026-11-25T03:00:00.123456Z', payments: [],
    ...over,
  };
}

/* A stub Paddle holding `store`. The list applies the filters it is
   sent (unless ignoreFilters, where it hands back everything, so the
   function's own test must hold alone), sorts by id, pages by `after`
   30 at a time, and names a `next` address on a host nothing answers.
   opts.list, opts.get and opts.patch can spoil one call each: they are
   given the call, its count from 1, and the usual answer. */
function paddleStub(store, opts = {}) {
  const host = opts.host || 'api.paddle.com';
  const seen = { list: 0, get: 0, patch: 0 };
  route = async (c) => {
    if (c.host !== host) return undefined;
    if (c.method === 'GET' && c.path === '/transactions') {
      seen.list++;
      const q = new URL(c.url).searchParams;
      let rows = store.slice();
      if (!opts.ignoreFilters) {
        const statuses = (q.get('status') || '').split(',');
        const before = Date.parse(q.get('created_at[LTE]'));
        rows = rows.filter((t) => statuses.includes(t.status) && t.origin === q.get('origin') &&
          t.collection_mode === q.get('collection_mode') && typeof t.created_at === 'string' && Date.parse(t.created_at) <= before);
      }
      rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      const after = q.get('after');
      if (after) rows = rows.filter((t) => String(t.id) > after);
      const page = rows.slice(0, 30);
      const body = {
        data: page,
        meta: { pagination: { per_page: 30, next: 'https://next.paddle.test/transactions?after=' + (page.length ? page[page.length - 1].id : ''), has_more: rows.length > 30, estimated_total: rows.length } },
      };
      if (opts.list) {
        const out = await opts.list(c, seen.list, body);
        if (out instanceof Response) return out;
      }
      return reply(200, body);
    }
    const id = c.path.startsWith('/transactions/') ? c.path.slice('/transactions/'.length) : null;
    const found = id === null ? undefined : store.find((t) => t.id === id);
    if (c.method === 'GET' && id !== null) {
      seen.get++;
      const usual = () => (found ? reply(200, { data: found }) : reply(404, { error: { code: 'not_found' } }));
      return opts.get ? opts.get(c, seen.get, usual, found) : usual();
    }
    if (c.method === 'PATCH' && id !== null) {
      seen.patch++;
      const usual = () => {
        if (!found) return reply(404, { error: { code: 'not_found' } });
        found.status = 'canceled';
        return reply(200, { data: found });
      };
      return opts.patch ? opts.patch(c, seen.patch, usual, found) : usual();
    }
    return undefined;
  };
}

/* Neither the answer nor the log names an account, an email, a
   transaction or a Paddle customer. */
const namesNobody = (r) => ![USER_ID, USER_EMAIL, 'txn_', 'ctm_'].some((secret) => r.text.includes(secret) || r.said.includes(secret));

const E_COUNTS = ['changed', 'closed', 'failed', 'listed', 'more', 'notOurs', 'old', 'paying', 'refused', 'stopped', 'young'];
const E_KEYS_OK = [...E_COUNTS, 'ok'].sort().join();
const E_KEYS_FAULT = [...E_COUNTS, 'ok', 'error'].sort().join();
/* Everything that must hold for EVERY run in part E is looked at inside
   run() and anything wrong lands here. E10 and E11 expect it empty. */
const eBroken = [];
let eRuns = 0;
let ePatches = 0;

/* One request to expire-checkouts, with the clock held at `now` (or
   read from `now` when it is a function). `secret: null` sends no
   x-cron-secret header. */
async function run(opts = {}) {
  const now = opts.now ?? E_NOW;
  const method = opts.method || 'POST';
  const headers = { 'Content-Type': 'application/json' };
  if (opts.secret !== null) headers['x-cron-secret'] = opts.secret ?? 'test-cron-secret';
  const host = opts.host || 'api.paddle.com';
  calls = [];
  logs = [];
  const inner = route;
  const listedIds = new Set();
  route = async (c) => {
    const answer = inner && await inner(c);
    if (answer && c.method === 'GET' && c.path === '/transactions') {
      try { for (const t of (await answer.clone().json()).data || []) listedIds.add(t && t.id); } catch { /* not a list */ }
    }
    return answer;
  };
  const realNow = Date.now;
  Date.now = typeof now === 'function' ? now : () => now;
  let r;
  try {
    const response = await (opts.handler || expire)(new Request('https://proj.supabase.co/functions/v1/expire-checkouts',
      { method, headers, body: method === 'POST' ? (opts.body ?? '{}') : undefined }));
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* the gate answers in plain text */ }
    r = { status: response.status, json, text, said: logs.join('\n') };
  } finally {
    Date.now = realNow;
    route = inner;
  }

  eRuns++;
  const wrong = [];
  if (r.status === 403) {
    if (r.text !== 'Forbidden' || calls.length !== 0 || logs.length !== 0) wrong.push('the gate said or did something');
  } else {
    if (logs.length !== 1) wrong.push('log lines: ' + logs.length);
    const keys = r.json ? Object.keys(r.json).sort().join() : '';
    if (r.status === 200) {
      if (keys !== E_KEYS_OK || r.json.ok !== true || !String(logs[0]).startsWith('checkouts closed: ')) wrong.push('the 200 answer or its line');
    } else {
      if (keys !== (r.status === 502 ? E_KEYS_FAULT : 'error,ok') || r.json.ok !== false || !String(logs[0]).startsWith('Could not close checkouts: ')) wrong.push('the fault answer or its line');
    }
  }
  if (!namesNobody(r)) wrong.push('names somebody');
  calls.forEach((c, i) => {
    if (c.host !== host) wrong.push('a call to ' + c.host);
    if (c.method !== 'GET' && c.method !== 'PATCH') wrong.push('a ' + c.method);
    if (c.headers.Authorization !== 'Bearer test-paddle-key') wrong.push('the key was not sent as a bearer');
    if (c.method === 'GET' && (c.body !== undefined || 'Content-Type' in c.headers)) wrong.push('a GET with a body');
    if (c.method === 'PATCH') {
      ePatches++;
      if (c.body !== CANCEL_TEXT) wrong.push('a PATCH body: ' + c.body);
      if (!/^\/transactions\/txn_[a-z0-9]+$/.test(c.path)) wrong.push('a PATCH path');
      if (!listedIds.has(c.path.slice('/transactions/'.length))) wrong.push('a PATCH for an id the run did not list');
      const prior = calls[i - 1];
      if (!prior || prior.method !== 'GET' || prior.path !== c.path) wrong.push('a PATCH with no read straight before');
    }
  });
  if (wrong.length) eBroken.push({ run: opts.label || eRuns, wrong });
  return r;
}

const eLists = () => calls.filter((c) => c.method === 'GET' && c.path === '/transactions');
const eReads = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/transactions/'));
const ePatched = () => calls.filter((c) => c.method === 'PATCH').map((c) => c.path.slice('/transactions/'.length));
const eTouched = (id) => calls.some((c) => c.path === '/transactions/' + id);
const eLine = (counts) => `closed ${counts.closed ?? 0}, listed ${counts.listed ?? 0}, old enough and ours ${counts.old ?? 0}, too young ${counts.young ?? 0}, ` +
  `not ours ${counts.notOurs ?? 0}, being paid ${counts.paying ?? 0}, changed ${counts.changed ?? 0}, refused ${counts.refused ?? 0}, failed ${counts.failed ?? 0}, ` +
  `more waiting ${counts.more ? 'yes' : 'no'}, stopped ${counts.stopped ?? 'no'}`;
const EXPIRE_CODE = EXPIRE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

{
  /* E1. The gate. Closed without the cron secret, closed with the wrong
     one, and closed when the function has no secret set at all. Nothing
     is asked of Paddle and nothing is logged. */
  const store = [txn()];
  paddleStub(store);
  for (const [name, opts] of Object.entries({
    'no x-cron-secret header': { secret: null },
    'the wrong secret': { secret: 'not-the-secret' },
    'an empty secret': { secret: '' },
    'the secret in capitals': { secret: 'TEST-CRON-SECRET' },
    'the secret with more after it': { secret: 'test-cron-secret-and-more' },
    'a GET with no secret': { secret: null, method: 'GET' },
    'an OPTIONS with no secret': { secret: null, method: 'OPTIONS' },
    'the right secret, when the function has none set': { handler: expireNoSecret },
    'an empty secret, when the function has none set (fail closed)': { handler: expireNoSecret, secret: '' },
    'no header, when the function has none set': { handler: expireNoSecret, secret: null },
  })) {
    const r = await run(opts);
    check('E1 ' + name + ': 403 "Forbidden", nothing asked of Paddle, nothing logged',
      r.status === 403 && r.text === 'Forbidden' && calls.length === 0 && logs.length === 0, { status: r.status, text: r.text, calls: calls.length, logs });
  }
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await run({ method });
    check('E1 a ' + method + ' with the right secret: 405, nothing asked of Paddle',
      r.status === 405 && r.json?.error === 'method' && calls.length === 0, { status: r.status, text: r.text });
  }
  check('E1 ...and after all of that the transaction is still a draft', store[0].status === 'draft');
  const serve = EXPIRE_CODE.slice(EXPIRE_CODE.indexOf('Deno.serve(async (request) => {'));
  const gateLine = 'if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {\n    return new Response("Forbidden", { status: 403 });\n  }';
  check('E1 the gate is the same test notify-milestones makes, and is the first thing the handler does with the request',
    serve.includes(gateLine) && serve.indexOf('request', 'Deno.serve(async (request) => {'.length) === serve.indexOf(gateLine) + 'if (!CRON_SECRET || '.length &&
    read('supabase/functions/notify-milestones/index.ts').includes('if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {'));
  check('E1 CRON_SECRET is read from the function\'s own secrets, with no value written in',
    /const CRON_SECRET = Deno\.env\.get\("CRON_SECRET"\) \?\? "";/.test(EXPIRE_CODE));
}

{
  /* E2. No Paddle key: nothing is asked of Paddle. */
  const store = [txn()];
  paddleStub(store);
  const r = await run({ handler: expireNoKey });
  check('E2 with no PADDLE_API_KEY: 503 not_configured, nothing asked of Paddle, one line to search for',
    r.status === 503 && r.json?.error === 'not_configured' && calls.length === 0 &&
    r.said === 'Could not close checkouts: PADDLE_API_KEY not set.' && store[0].status === 'draft', { status: r.status, said: r.said });
  const closedFirst = await run({ handler: expireNoKey, secret: null });
  check('E2 ...and without the secret that copy is still closed first', closedFirst.status === 403);
}

{
  /* E3. The run when all is well: one draft and one that a checkout has
     filled in (ready), both made by create-checkout over an hour ago. */
  const a = txn();
  const b = txn({ status: 'ready', address_id: 'add_01test', created_at: '2026-11-25T03:30:00.000001Z' });
  const store = [b, a];
  paddleStub(store);
  const r = await run();
  check('E3 both are cancelled: 200, closed 2', r.status === 200 && r.json.ok === true && r.json.closed === 2 && r.json.old === 2 &&
    r.json.listed === 2 && r.json.more === false && r.json.stopped === null && a.status === 'canceled' && b.status === 'canceled', r.json);
  check('E3 one list, then a read and a cancel for each, the older first',
    same(calls.map((c) => c.method + ' ' + c.path), ['GET /transactions', 'GET /transactions/' + a.id, 'PATCH /transactions/' + a.id, 'GET /transactions/' + b.id, 'PATCH /transactions/' + b.id]),
    calls.map((c) => c.method + ' ' + c.path));
  const listUrl = eLists()[0].url;
  const q = new URL(listUrl).searchParams;
  check('E3 the list asks for unpaid, API-made, automatically collected transactions made over an hour ago, oldest first, 30 a page',
    q.get('status') === 'draft,ready' && q.get('origin') === 'api' && q.get('collection_mode') === 'automatic' &&
    q.get('created_at[LTE]') === '2026-11-25T04:00:00Z' && q.get('order_by') === 'id[ASC]' && q.get('per_page') === '30' && !q.has('after') &&
    [...q.keys()].length === 6, listUrl);
  check('E3 ...written as Paddle\'s own examples write them: square brackets and the comma as they are',
    listUrl === 'https://api.paddle.com/transactions?status=draft,ready&origin=api&collection_mode=automatic&created_at[LTE]=2026-11-25T04:00:00Z&order_by=id[ASC]&per_page=30', listUrl);
  check('E3 every call carries the key as a bearer, and only the cancel says what its body is',
    calls.every((c) => c.headers.Authorization === 'Bearer test-paddle-key') &&
    calls.filter((c) => c.method === 'PATCH').every((c) => c.headers['Content-Type'] === 'application/json' && c.body === CANCEL_TEXT));
  check('E3 one log line, counts only', r.said === 'checkouts closed: ' + eLine({ closed: 2, listed: 2, old: 2 }), r.said);

  /* The same run again finds nothing left to do. */
  const again = await run();
  check('E3 a second run finds nothing: 200, closed 0, one list and no more',
    again.status === 200 && again.json.closed === 0 && again.json.listed === 0 && calls.length === 1 && again.said === 'checkouts closed: ' + eLine({}), again.json);

  /* Sandbox. */
  const s = [txn()];
  paddleStub(s, { host: 'sandbox-api.paddle.com' });
  const sand = await run({ handler: expireSandbox, host: 'sandbox-api.paddle.com' });
  check('E3 with PADDLE_ENVIRONMENT sandbox every request goes to sandbox-api.paddle.com',
    sand.status === 200 && sand.json.closed === 1 && calls.length === 3 && calls.every((c) => c.host === 'sandbox-api.paddle.com'), calls.map((c) => c.host));
}

{
  /* E4. The filter. Each thing that must never be cancelled sits beside
     one good transaction, and is run twice: with the stub applying the
     list's filters, and with the stub ignoring them so the function's
     own test is all there is. The good one is cancelled; the other gets
     no cancel, and no second read either. */
  const mine = { user_id: USER_ID, trial_days: 38, first_payment_from: '2027-01-01T12:00:00.000Z', made_by: 'create-checkout' };
  const without = (key) => Object.fromEntries(Object.entries(mine).filter(([k]) => k !== key));
  const EXCLUDED = {
    'status billed': { status: 'billed' },
    'status paid': { status: 'paid' },
    'status completed': { status: 'completed' },
    'status past_due': { status: 'past_due' },
    'status canceled': { status: 'canceled' },
    'a status nobody has heard of': { status: 'pending_review' },
    'status "Draft" with a capital': { status: 'Draft' },
    'status missing': { status: undefined },
    'origin web (a checkout Paddle.js opened on a catalogue price)': { origin: 'web', custom_data: { user_id: USER_ID } },
    'origin web with made_by forged by the browser': { origin: 'web' },
    'origin subscription_recurring': { origin: 'subscription_recurring' },
    'origin subscription_charge': { origin: 'subscription_charge' },
    'origin subscription_update': { origin: 'subscription_update' },
    'origin subscription_payment_method_change': { origin: 'subscription_payment_method_change' },
    'origin subscription_import': { origin: 'subscription_import' },
    'origin "API" in capitals': { origin: 'API' },
    'origin missing': { origin: undefined },
    'a subscription id on it, origin api': { subscription_id: 'sub_01test' },
    'collection_mode manual (an invoice made in the dashboard)': { collection_mode: 'manual' },
    'collection_mode missing': { collection_mode: undefined },
    'an invoice number on it': { invoice_number: '325-10566' },
    'a billed date on it': { billed_at: '2026-11-25T03:10:00Z' },
    'custom_data null': { custom_data: null },
    'custom_data missing': { custom_data: undefined },
    'custom_data that is text': { custom_data: 'create-checkout' },
    'custom_data with user_id only (the plain price path)': { custom_data: { user_id: USER_ID } },
    'made_by someone-else': { custom_data: { ...mine, made_by: 'someone-else' } },
    'made_by "Create-Checkout" (case)': { custom_data: { ...mine, made_by: 'Create-Checkout' } },
    'made_by with a space after it': { custom_data: { ...mine, made_by: 'create-checkout ' } },
    'made_by missing': { custom_data: without('made_by') },
    'made_by right but no user_id': { custom_data: without('user_id') },
    'made_by right but an empty user_id': { custom_data: { ...mine, user_id: '' } },
    'made_by right but a user_id that is a number': { custom_data: { ...mine, user_id: 12345 } },
    'made_by right but trial_days missing': { custom_data: without('trial_days') },
    'made_by right but trial_days as text': { custom_data: { ...mine, trial_days: '38' } },
    'made_by right but trial_days not whole': { custom_data: { ...mine, trial_days: 38.5 } },
    'an id that is not the shape of a transaction id (capitals)': { id: 'txn_01E000BAD' },
    'an id of another kind of thing': { id: 'sub_01e000bad' },
    'an id with a path in it': { id: 'txn_01e/../customers' },
    'an id that is a number': { id: 987654321 },
    'created_at missing': { created_at: undefined },
    'created_at null': { created_at: null },
    'created_at that is not a date': { created_at: 'yesterday' },
    'created_at the right shape but no such day': { created_at: '2026-13-45T03:00:00Z' },
    'created_at with an offset in place of Z': { created_at: '2026-11-25T03:00:00+00:00' },
    'created_at as a number': { created_at: at('2026-11-25T03:00:00Z') },
    'created_at in the future': { created_at: '2026-11-25T05:00:01Z' },
    'created_at 59 minutes ago': { created_at: '2026-11-25T04:01:00Z' },
    'a payment that was captured, on the list': { payments: [{ status: 'captured' }] },
    'payments that is not a list': { payments: 'none' },
  };
  for (const [name, over] of Object.entries(EXCLUDED)) {
    for (const ignoreFilters of [false, true]) {
      const other = txn(over);
      const good = txn();
      const store = [other, good];
      const before = JSON.stringify(other);
      paddleStub(store, { ignoreFilters });
      const r = await run();
      check('E4 ' + name + (ignoreFilters ? ' (the list ignores its filters)' : '') + ': left alone, with no read and no cancel, and the good one beside it is cancelled',
        r.status === 200 && r.json.closed === 1 && good.status === 'canceled' && same(ePatched(), [good.id]) && eReads().length === 1 &&
        !eTouched(other.id) && JSON.stringify(other) === before &&
        (!ignoreFilters || (r.json.listed === 2 && r.json.notOurs + r.json.young + r.json.paying === 1)), r.json);
    }
  }
  check('E4 that was every exclusion twice', Object.keys(EXCLUDED).length >= 40);

  /* The second mark. THEORY, read in Paddle's documentation on
     25 Nov 2026 and never tried: the page that holds a checkout can
     replace the transaction's custom data, and made_by with it. The
     one-off price carries the free days, so a transaction is also known
     by that price: one item, a description ending "(create-checkout)",
     a trial of a whole number of days. `replaced` is custom data as a
     browser might leave it. */
  const replaced = { note: 'test' };
  const priced = (over = {}) => ({ items: [{ quantity: 1, price: { id: 'pri_01test', description: 'Premium monthly, first payment after 38 days (create-checkout)',
    trial_period: { interval: 'day', frequency: 38 }, billing_cycle: { interval: 'month', frequency: 1 }, ...over } }] });
  for (const [name, custom] of Object.entries({
    'custom data replaced by the page': replaced,
    'custom data with user_id only': { user_id: USER_ID },
    'custom data null': null,
    'made_by changed to other text': { ...mine, made_by: 'nobody' },
  })) {
    for (const ignoreFilters of [false, true]) {
      const one = txn({ custom_data: custom, ...priced() });
      paddleStub([one], { ignoreFilters });
      const r = await run();
      check('E4 ' + name + ', and the one-off price still on the transaction' + (ignoreFilters ? ' (the list ignores its filters)' : '') + ': known by the price, and cancelled',
        r.status === 200 && r.json.closed === 1 && r.json.notOurs === 0 && one.status === 'canceled' && same(ePatched(), [one.id]), r.json);
    }
  }
  const NOT_THE_PRICE = {
    'a description that does not end with the mark': priced({ description: 'Premium monthly (create-checkout) and more' }),
    'a description with the mark in capitals': priced({ description: 'Premium monthly (Create-Checkout)' }),
    'a description that is the mark with no space before it': priced({ description: 'Premium(create-checkout)' }),
    'no description': priced({ description: undefined }),
    'a description that is not text': priced({ description: 38 }),
    'the mark and no trial on the price': priced({ trial_period: null }),
    'the mark and a trial counted in months': priced({ trial_period: { interval: 'month', frequency: 1 } }),
    'the mark and a trial of 0 days': priced({ trial_period: { interval: 'day', frequency: 0 } }),
    'the mark and a trial of 1.5 days': priced({ trial_period: { interval: 'day', frequency: 1.5 } }),
    'two items, the first with the mark': { items: [priced().items[0], { quantity: 1, price: { description: 'Something else' } }] },
    'no items': { items: [] },
    'items that is not a list': { items: priced().items[0] },
    'an item with no price': { items: [{ quantity: 1 }] },
    'an item that is null': { items: [null] },
    'a catalogue trial price with no mark': priced({ description: 'Premium monthly, 14 day trial' }),
  };
  for (const [name, over] of Object.entries(NOT_THE_PRICE)) {
    const other = txn({ custom_data: replaced, ...over });
    const good = txn();
    paddleStub([other, good], { ignoreFilters: true });
    const r = await run();
    check('E4 no made_by, and ' + name + ': not known by the price, left alone with no read and no cancel',
      r.status === 200 && r.json.closed === 1 && r.json.notOurs === 1 && other.status === 'draft' && !eTouched(other.id) && same(ePatched(), [good.id]), r.json);
  }
  for (const [name, over] of Object.entries({
    'origin web': { origin: 'web' },
    'status paid': { status: 'paid' },
    'status past_due': { status: 'past_due' },
    'a subscription id': { subscription_id: 'sub_01test' },
    'collection_mode manual': { collection_mode: 'manual' },
    'made 59 minutes ago': { created_at: '2026-11-25T04:01:00Z' },
    'a payment captured': { payments: [{ status: 'captured' }] },
  })) {
    const other = txn({ custom_data: replaced, ...priced(), ...over });
    const good = txn();
    paddleStub([other, good], { ignoreFilters: true });
    const before = JSON.stringify(other);
    const r = await run();
    check('E4 the price mark never widens what may be cancelled. With the mark and ' + name + ': left alone',
      r.json.closed === 1 && JSON.stringify(other) === before && !eTouched(other.id) && same(ePatched(), [good.id]), r.json);
  }
  {
    /* What is NOT covered, and is stated in the function's notes: a list
       entry that carries no items. With made_by gone as well, nothing
       marks the transaction, so the run leaves that one open and counts
       "not ours". Whether Paddle's list carries the price is not known. */
    const one = txn({ custom_data: replaced });
    paddleStub([one]);
    const r = await run();
    check('E4 made_by gone and no items on the list entry: not recognised, left open, counted as not ours',
      r.status === 200 && r.json.closed === 0 && r.json.notOurs === 1 && one.status === 'draft' && calls.length === 1, r.json);
  }
}

{
  /* E5. The 60 minutes, to the second. The list ignores its filters, so
     this is the function's own arithmetic on Paddle's created_at. A
     fraction of a second is rounded UP: never early, at most a second
     late. Every instant is written out. */
  const BOUNDARY = [
    ['2026-11-25T03:00:00Z', '2026-11-25T03:59:59.999Z', false],
    ['2026-11-25T03:00:00Z', '2026-11-25T04:00:00.000Z', true],
    ['2026-11-25T03:00:00.610609Z', '2026-11-25T04:00:00.000Z', false],
    ['2026-11-25T03:00:00.610609Z', '2026-11-25T04:00:00.610Z', false],
    ['2026-11-25T03:00:00.610609Z', '2026-11-25T04:00:00.999Z', false],
    ['2026-11-25T03:00:00.610609Z', '2026-11-25T04:00:01.000Z', true],
    ['2026-11-25T03:00:00.000001Z', '2026-11-25T04:00:00.999Z', false],
    ['2026-11-25T03:00:00.000001Z', '2026-11-25T04:00:01.000Z', true],
    ['2026-11-25T03:00:00.000000Z', '2026-11-25T03:59:59.999Z', false],
    ['2026-11-25T03:00:00.000000Z', '2026-11-25T04:00:00.000Z', true],
    ['2026-11-25T03:00:00.0Z', '2026-11-25T04:00:00.000Z', true],
    ['2026-11-25T03:00:00.999999Z', '2026-11-25T04:00:00.999Z', false],
    ['2026-11-25T03:00:00.999999Z', '2026-11-25T04:00:01.000Z', true],
  ];
  for (const [created, now, closes] of BOUNDARY) {
    const one = txn({ created_at: created });
    paddleStub([one], { ignoreFilters: true });
    const r = await run({ now: at(now) });
    check('E5 made ' + created + ', run at ' + now + ': ' + (closes ? 'cancelled' : 'left alone as too young'),
      r.status === 200 && r.json.closed === (closes ? 1 : 0) && r.json.young === (closes ? 0 : 1) && one.status === (closes ? 'canceled' : 'draft') &&
      ePatched().length === (closes ? 1 : 0) && eReads().length === (closes ? 1 : 0), r.json);
  }
  /* Old enough on the list, and the second read says younger: the
     second read wins. */
  {
    const one = txn({ created_at: '2026-11-25T03:00:00Z' });
    paddleStub([one], { ignoreFilters: true, get: (_c, _n, _usual, t) => reply(200, { data: { ...t, created_at: '2026-11-25T04:30:00Z' } }) });
    const r = await run();
    check('E5 old enough on the list but under an hour on the second read: no cancel', r.json.closed === 0 && r.json.changed === 1 && ePatched().length === 0 && one.status === 'draft', r.json);
  }
  paddleStub([]);
  await run({ now: at('2026-11-25T04:00:00.500Z') });
  const sent = new URL(eLists()[0].url).searchParams.get('created_at[LTE]');
  check('E5 the cutoff sent to the list for a run at 04:00:00.500Z is 2026-11-25T03:00:00Z: whole seconds, an hour back', sent === '2026-11-25T03:00:00Z', sent);
  await run({ now: at('2026-11-25T04:00:00.000Z') });
  check('E5 ...and the same for a run on the second', new URL(eLists()[0].url).searchParams.get('created_at[LTE]') === '2026-11-25T03:00:00Z');
  /* The clock. The 60 minutes run from Paddle's created_at to a clock
     here, so a server clock AHEAD of Paddle's would cancel early (found
     in review, 25 Nov 2026: 5 minutes ahead cancelled at 55 minutes).
     The list answer's Date header is Paddle's own time. Up to a minute
     ahead, ages are worked out on Paddle's time. Over a minute apart,
     either way, the run stops as a fault. */
  const dated = (iso) => (_c, _n, body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', Date: new Date(at(iso)).toUTCString() } });
  for (const [name, server, paddleTime, created, want] of [
    ['this server 30 s ahead, made 60:15 ago by this server and 59:45 by Paddle', '2026-11-25T05:00:00Z', '2026-11-25T04:59:30Z', '2026-11-25T03:59:45Z', 'young'],
    ['this server 30 s ahead, made exactly 60:00 ago by Paddle', '2026-11-25T05:00:00Z', '2026-11-25T04:59:30Z', '2026-11-25T03:59:30Z', 'closed'],
    ['this server 30 s ahead, made 59:59 ago by Paddle', '2026-11-25T05:00:00Z', '2026-11-25T04:59:30Z', '2026-11-25T03:59:31Z', 'young'],
    ['this server exactly 60 s ahead, made 60:30 ago by this server', '2026-11-25T05:00:00Z', '2026-11-25T04:59:00Z', '2026-11-25T03:59:30Z', 'young'],
    ['this server exactly 60 s ahead, made 60:00 ago by Paddle', '2026-11-25T05:00:00Z', '2026-11-25T04:59:00Z', '2026-11-25T03:59:00Z', 'closed'],
    ['this server 30 s behind, made 59:45 ago by this server and 60:15 by Paddle (late, never early)', '2026-11-25T04:59:45Z', '2026-11-25T05:00:15Z', '2026-11-25T04:00:00Z', 'young'],
    ['this server 30 s behind, made 60:00 ago by this server', '2026-11-25T05:00:00Z', '2026-11-25T05:00:30Z', '2026-11-25T04:00:00Z', 'closed'],
    ['the two clocks the same', '2026-11-25T05:00:00Z', '2026-11-25T05:00:00Z', '2026-11-25T04:00:00Z', 'closed'],
    ['this server 5 minutes ahead, made 55 minutes ago by Paddle (the case found in review)', '2026-11-25T05:00:00Z', '2026-11-25T04:55:00Z', '2026-11-25T04:00:00Z', 'clock'],
    ['this server 61 s ahead', '2026-11-25T05:00:00Z', '2026-11-25T04:58:59Z', '2026-11-25T03:00:00Z', 'clock'],
    ['this server 61 s behind', '2026-11-25T05:00:00Z', '2026-11-25T05:01:01Z', '2026-11-25T03:00:00Z', 'clock'],
    ['this server a day behind', '2026-11-25T05:00:00Z', '2026-11-26T05:00:00Z', '2026-11-25T03:00:00Z', 'clock'],
  ]) {
    const one = txn({ created_at: created });
    paddleStub([one], { ignoreFilters: true, list: dated(paddleTime) });
    const r = await run({ now: at(server) });
    if (want === 'clock') {
      check('E5 ' + name + ': the run stops as "clock", a fault, with no read and no cancel',
        r.status === 502 && r.json.error === 'paddle' && r.json.stopped === 'clock' && r.json.closed === 0 && calls.length === 1 && one.status === 'draft' &&
        r.said === 'Could not close checkouts: this server\'s clock and Paddle\'s differ by more than a minute, so the run stopped. ' + eLine({ stopped: 'clock' }), r.said);
    } else {
      check('E5 ' + name + ': ' + (want === 'closed' ? 'cancelled' : 'left alone as too young'),
        r.status === 200 && r.json.closed === (want === 'closed' ? 1 : 0) && r.json.young === (want === 'closed' ? 0 : 1) && one.status === (want === 'closed' ? 'canceled' : 'draft'), r.json);
    }
  }
  {
    /* The second read is judged on Paddle's time as well. */
    const one = txn({ created_at: '2026-11-25T03:59:30Z' });
    paddleStub([one], { ignoreFilters: true, list: dated('2026-11-25T04:59:30Z'), get: (_c, _n, _usual, t) => reply(200, { data: { ...t, created_at: '2026-11-25T03:59:31Z' } }) });
    const r = await run();
    check('E5 this server 30 s ahead, and the second read gives a created_at one second later: no cancel', r.json.closed === 0 && r.json.changed === 1 && ePatched().length === 0, r.json);
  }
  for (const [name, value] of [['that is not a date', 'soon'], ['that is empty', '']]) {
    const one = txn({ created_at: '2026-11-25T04:00:00Z' });
    paddleStub([one], { ignoreFilters: true, list: (_c, _n, body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', Date: value } }) });
    const r = await run();
    check('E5 a Date header ' + name + ': judged on this server\'s clock alone, as an answer with no Date header is', r.status === 200 && r.json.closed === 1, r.json);
  }
  check('E5 the clocks may differ by a minute and no more, and only a clock that is ahead moves the age',
    /const MAX_CLOCK_GAP_MS = 60 \* 1000;/.test(EXPIRE_CODE) && /if \(Math\.abs\(gap\) > MAX_CLOCK_GAP_MS\) \{/.test(EXPIRE_CODE) && /ahead = Math\.max\(0, gap\);/.test(EXPIRE_CODE));
  check('E5 the hour is 60 minutes, and the test is "at least"',
    /const MAX_AGE_MS = 60 \* 60 \* 1000;/.test(EXPIRE_CODE) && /if \(now - created < MAX_AGE_MS\) return "young";/.test(EXPIRE_CODE));
}

{
  /* E6. Pages, and the cap of 20 cancels a run. */
  const notOurs = () => txn({ custom_data: { user_id: USER_ID } });

  /* 30 that are not ours fill page one; 5 of ours are on page two. */
  {
    const store = [...Array.from({ length: 30 }, notOurs), ...Array.from({ length: 5 }, () => txn())];
    paddleStub(store, { ignoreFilters: true });
    const r = await run();
    const lists = eLists();
    const first = new URL(lists[0].url).searchParams;
    const second = lists[1] ? new URL(lists[1].url).searchParams : new URLSearchParams();
    check('E6 a second page is asked for with after=<the last id on page one> and the same other parameters',
      lists.length === 2 && second.get('after') === store[29].id && !first.has('after') &&
      lists[1].url === lists[0].url + '&after=' + store[29].id, lists.map((c) => c.url));
    check('E6 ...the 5 on page two are cancelled, and the address Paddle gave for the next page is never fetched',
      r.status === 200 && r.json.closed === 5 && r.json.listed === 35 && r.json.notOurs === 30 && r.json.more === false && r.json.stopped === null &&
      calls.every((c) => c.host === 'api.paddle.com') && !/meta\.pagination\.next|pagination\.next/.test(EXPIRE_CODE), r.json);
  }

  /* 65 of ours. Twenty a run, the oldest first. */
  {
    const store = Array.from({ length: 65 }, () => txn());
    const ids = store.map((t) => t.id);
    paddleStub(store);
    const cancelled = () => store.filter((t) => t.status === 'canceled').map((t) => t.id);
    const r1 = await run();
    check('E6 65 waiting: the first run cancels the 20 oldest and stops at the cap, saying more are waiting',
      r1.status === 200 && r1.json.closed === 20 && r1.json.stopped === 'cap' && r1.json.more === true && same(cancelled(), ids.slice(0, 20)) &&
      same(ePatched(), ids.slice(0, 20)) && eLists().length === 1 && calls.length === 41, r1.json);
    check('E6 ...and its line says so', r1.said === 'checkouts closed: ' + eLine({ closed: 20, listed: 30, old: 20, more: true, stopped: 'cap' }), r1.said);
    const r2 = await run();
    check('E6 the second run cancels the next 20', r2.json.closed === 20 && r2.json.stopped === 'cap' && same(cancelled(), ids.slice(0, 40)), r2.json);
    const r3 = await run();
    check('E6 the third run the next 20', r3.json.closed === 20 && r3.json.more === true && same(cancelled(), ids.slice(0, 60)), r3.json);
    const r4 = await run();
    check('E6 the fourth run the last 5, with no more waiting',
      r4.status === 200 && r4.json.closed === 5 && r4.json.more === false && r4.json.stopped === null && cancelled().length === 65, r4.json);
  }

  /* Exactly 20 of ours is not "more waiting". */
  {
    const store = Array.from({ length: 20 }, () => txn());
    paddleStub(store);
    const r = await run();
    check('E6 exactly 20 waiting: all cancelled, and the run does not claim more are waiting', r.json.closed === 20 && r.json.more === false && r.json.stopped === null, r.json);
  }

  /* 150 that are listed and are not ours. */
  {
    const store = Array.from({ length: 150 }, notOurs);
    paddleStub(store);
    const r = await run();
    check('E6 150 on the list that are not ours: four list calls and no more, stopped at "pages", nothing read or cancelled',
      eLists().length === 4 && calls.length === 4 && r.json.listed === 120 && r.json.notOurs === 120 &&
      r.json.stopped === 'pages' && r.json.more === true && store.every((t) => t.status === 'draft'), r.json);
    /* Changed on 25 Nov 2026 (review): this run answered 200 with the
       healthy line, so 120 that cannot be cancelled could hide the ones
       behind them for good with nothing to search for. */
    check('E6 ...and that run is a fault, not a healthy line: more are waiting and none was cancelled',
      r.status === 502 && r.json.error === 'left_open' &&
      r.said === 'Could not close checkouts: more are waiting and this run cancelled none. ' + eLine({ listed: 120, notOurs: 120, more: true, stopped: 'pages' }), r.said);
    /* The same with one of ours in front: something was cancelled, so
       the run is a healthy one that says more are waiting. */
    const mixed = [txn(), ...Array.from({ length: 150 }, notOurs)];
    paddleStub(mixed);
    const m = await run();
    check('E6 one of ours in front of 150 that are not: cancelled, 200, stopped "pages" with more waiting',
      m.status === 200 && m.json.closed === 1 && m.json.stopped === 'pages' && m.json.more === true && mixed[0].status === 'canceled', m.json);
    const exact = Array.from({ length: 120 }, notOurs);
    paddleStub(exact);
    const e = await run();
    check('E6 exactly 120 on the list: four list calls, and no claim that more are waiting', eLists().length === 4 && e.json.stopped === null && e.json.more === false, e.json);
  }

  /* What ends the paging. */
  for (const [name, spoil] of Object.entries({
    'has_more missing': (p) => { delete p.has_more; },
    'has_more as the text "true"': (p) => { p.has_more = 'true'; },
    'has_more 1': (p) => { p.has_more = 1; },
  })) {
    const store = Array.from({ length: 40 }, notOurs);
    paddleStub(store, { list: (_c, _n, body) => { spoil(body.meta.pagination); } });
    const r = await run();
    check('E6 ' + name + ': treated as the last page', r.status === 200 && eLists().length === 1 && r.json.stopped === null && r.json.listed === 30, r.json);
  }
  for (const [name, spoil] of Object.entries({
    'an empty page that says there is more': (body) => { body.data = []; body.meta.pagination.has_more = true; },
    'a page whose last id is not the shape of an id, with more to come': (body) => { body.data = [...body.data.slice(0, 29), { ...body.data[29], id: 'page/2' }]; },
    'a page whose last entry has no id, with more to come': (body) => { body.data = [...body.data.slice(0, 29), null]; },
  })) {
    const store = Array.from({ length: 40 }, notOurs);
    paddleStub(store, { list: (_c, _n, body) => { spoil(body); } });
    const r = await run();
    check('E6 ' + name + ': the run stops as list_failed, 502, with one list call',
      r.status === 502 && r.json.stopped === 'list_failed' && eLists().length === 1 && /^Could not close checkouts: the list could not be paged\. /.test(r.said), r.json);
  }
  {
    /* Paddle ignores `after` and hands back page one again. */
    const store = Array.from({ length: 40 }, notOurs);
    let pageOne = null;
    paddleStub(store, { list: (_c, n, body) => { if (n === 1) pageOne = JSON.stringify(body); else return reply(200, pageOne); } });
    const r = await run();
    check('E6 a second page that ends on the same id as the cursor: stopped as list_failed, two list calls and no third',
      r.status === 502 && r.json.stopped === 'list_failed' && eLists().length === 2, r.json);
  }
  for (const [name, spoil] of Object.entries({
    'no meta': (body) => { delete body.meta; },
    'pagination null': (body) => { body.meta.pagination = null; },
    'data that is not a list': (body) => { body.data = { 0: txn() }; },
  })) {
    const good = txn();
    paddleStub([good], { list: (_c, _n, body) => { spoil(body); } });
    const r = await run();
    check('E6 a list answer with ' + name + ': nothing is read or cancelled, 502',
      r.status === 502 && r.json.stopped === 'list_failed' && calls.length === 1 && good.status === 'draft' &&
      /^Could not close checkouts: the list answered 200, or could not be read\. /.test(r.said), r.said);
  }
  check('E6 the limits are the ones the notes give: 30 a page, 4 pages, 40 second reads, 20 cancels sent, 3 failures in a row',
    /const PER_PAGE = 30;/.test(EXPIRE_CODE) && /const MAX_PAGES = 4;/.test(EXPIRE_CODE) && /const MAX_READS = 40;/.test(EXPIRE_CODE) &&
    /const MAX_CANCELS = 20;/.test(EXPIRE_CODE) && /const MAX_FAILS_IN_ROW = 3;/.test(EXPIRE_CODE) &&
    /if \(sent >= MAX_CANCELS\) \{/.test(EXPIRE_CODE) && /if \(reads >= MAX_READS\) \{/.test(EXPIRE_CODE) && !/closed >= MAX/.test(EXPIRE_CODE));

  /* The limits count requests MADE, not requests that went well. Found
     in review on 25 Nov 2026: with only successes counted, 125 waiting
     and every cancel refused or failing made 244 requests in one run,
     over the 240 a minute Paddle allows one address. Every case here is
     150 old ones of ours. */
  for (const [name, opts, want] of [
    ['every cancel answers 409', { patch: () => reply(409, { error: { code: 'transaction_not_cancelable' } }) },
      { lists: 1, reads: 20, patches: 20, stopped: 'cap', refused: 20 }],
    ['every cancel answers 422', { patch: () => reply(422, { error: { code: 'validation' } }) },
      { lists: 1, reads: 20, patches: 20, stopped: 'cap', refused: 20 }],
    ['every second read says somebody is paying', { get: (_c, _n, _usual, t) => reply(200, { data: { ...t, payments: [{ status: 'authorized' }] } }) },
      { lists: 2, reads: 40, patches: 0, stopped: 'reads', paying: 40 }],
    ['every second read leaves out the payments', { get: (_c, _n, _usual, t) => { const { payments: _p, ...rest } = t; return reply(200, { data: rest }); } },
      { lists: 2, reads: 40, patches: 0, stopped: 'reads', changed: 40 }],
    ['every second read answers 404', { get: () => reply(404, { error: { code: 'not_found' } }) },
      { lists: 2, reads: 40, patches: 0, stopped: 'reads', refused: 40 }],
  ]) {
    const store = Array.from({ length: 150 }, () => txn());
    paddleStub(store, opts);
    const r = await run();
    check('E6 150 waiting and ' + name + ': the run stops at "' + want.stopped + '" after ' + want.reads + ' reads and ' + want.patches + ' cancels, never more than 64 requests',
      eLists().length === want.lists && eReads().length === want.reads && ePatched().length === want.patches && calls.length <= 64 &&
      r.json.stopped === want.stopped && r.json.more === true && r.json.closed === 0 &&
      (r.json.refused === (want.refused ?? 0)) && (r.json.paying === (want.paying ?? 0)) && (r.json.changed === (want.changed ?? 0)), [calls.length, r.json]);
    check('E6 ...and that run (' + name + ') is a fault with one line to search for, never the healthy line',
      r.status === 502 && r.json.ok === false && r.said.startsWith('Could not close checkouts: ') && store.every((t) => t.status === 'draft'), r.said);
  }
  {
    /* Every cancel answers 500 while every read is good: three in a row
       stop the run. Before, the good read between two cancels wiped the
       count and the run went on to 120 of each. */
    const store = Array.from({ length: 150 }, () => txn());
    paddleStub(store, { patch: () => reply(500, {}) });
    const r = await run();
    check('E6 150 waiting and every cancel answers 500: stopped as paddle_failing after 3 reads and 3 cancels',
      r.status === 502 && r.json.stopped === 'paddle_failing' && r.json.failed === 3 && eReads().length === 3 && ePatched().length === 3 && calls.length === 7, [calls.length, r.json]);
  }
  {
    /* The most a run can ask of Paddle: cancels that fail two at a
       time with a good one between, so nothing stops the run but the
       limits. */
    const store = Array.from({ length: 150 }, () => txn());
    paddleStub(store, { patch: (_c, n, usual) => (n % 3 === 0 ? usual() : reply(503, {})) });
    const r = await run();
    check('E6 cancels failing two at a time with a good one between: the run stops at 20 cancels sent, successes or not',
      calls.length <= 64 && ePatched().length === 20 && eReads().length === 20 && r.json.stopped === 'cap' && r.json.closed === 6 && r.json.failed === 14, [calls.length, r.json]);
  }
}

{
  /* E7. Paddle failing part of the way through. One failure does not
     throw the rest of the run away. */
  const five = () => Array.from({ length: 5 }, () => txn());
  const statuses = (store) => store.map((t) => t.status).join();
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual, t) => (n === 2 ? reply(500, { error: { code: 'internal_error', detail: 'could not cancel ' + t.id } }) : usual()) });
    const r = await run();
    check('E7 the cancel for the 2nd answers 500: the other four are cancelled, failed 1, 502',
      r.status === 502 && r.json.error === 'paddle' && r.json.closed === 4 && r.json.failed === 1 && r.json.stopped === null &&
      statuses(store) === 'canceled,draft,canceled,canceled,canceled', r.json);
    check('E7 ...and one line to search for, counts only',
      r.said === 'Could not close checkouts: some reads or cancels failed. ' + eLine({ closed: 4, listed: 5, old: 5, failed: 1 }), r.said);
  }
  {
    const store = five();
    paddleStub(store, { get: (_c, n, usual) => { if (n === 2) throw new Error('network down for ' + store[1].id); return usual(); } });
    const r = await run();
    check('E7 the read for the 2nd cannot be reached: the same, and that one gets no cancel',
      r.status === 502 && r.json.closed === 4 && r.json.failed === 1 && statuses(store) === 'canceled,draft,canceled,canceled,canceled' && !ePatched().includes(store[1].id), r.json);
  }
  {
    const store = five();
    paddleStub(store, { get: (_c, n, usual) => (n >= 2 && n <= 4 ? reply(503, 'Service Unavailable') : usual()) });
    const r = await run();
    check('E7 three failures in a row: the run stops as paddle_failing and the 5th is never asked for',
      r.status === 502 && r.json.stopped === 'paddle_failing' && r.json.closed === 1 && r.json.failed === 3 && !eTouched(store[4].id) &&
      statuses(store) === 'canceled,draft,draft,draft,draft' && /^Could not close checkouts: Paddle failed 3 times in a row, so the run stopped\. /.test(r.said), r.json);
  }
  {
    const store = five();
    paddleStub(store, { get: (_c, n, usual) => (n === 2 || n === 4 || n === 5 ? reply(500, {}) : usual()) });
    const r = await run();
    check('E7 three failures that are not in a row do not stop the run', r.status === 502 && r.json.stopped === null && r.json.closed === 2 && r.json.failed === 3 && eReads().length === 5, r.json);
  }
  {
    const store = five();
    paddleStub(store, {
      patch: (_c, n, usual, t) => (n === 2
        ? reply(409, { error: { type: 'request_error', code: 'transaction_not_cancelable', detail: `Transaction ${t.id} of ${USER_EMAIL} (${USER_ID}, ctm_01test) cannot be canceled` } })
        : usual()),
    });
    const r = await run();
    check('E7 the cancel for the 2nd is refused with 409 and a body that quotes the transaction and an email: refused 1, the rest cancelled',
      r.json.closed === 4 && r.json.refused === 1 && r.json.failed === 0 && r.json.stopped === null && statuses(store) === 'canceled,draft,canceled,canceled,canceled', r.json);
    /* Changed on 25 Nov 2026 (review): a refusal answered 200 with the
       healthy line and Paddle's status and code were thrown away, so
       cancelling could stop for good with nothing to search for. */
    check('E7 ...and a refusal is a fault: 502 left_open, with the status and Paddle\'s short code and nothing else Paddle said',
      r.status === 502 && r.json.error === 'left_open' && namesNobody(r) && !/cannot be|request_error|Transaction/.test(r.text + r.said) &&
      r.said === 'Could not close checkouts: Paddle refused 1, and last a cancel answered 409 (transaction_not_cancelable). ' + eLine({ closed: 4, listed: 5, old: 5, refused: 1 }), r.said);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual) => (n === 2 ? reply(400, { error: { code: 'txn_01e000001 for ' + USER_EMAIL } }) : usual()) });
    const r = await run();
    check('E7 a refusal whose error code is not the shape of one: the status alone is logged',
      r.status === 502 && r.said.startsWith('Could not close checkouts: Paddle refused 1, and last a cancel answered 400. ') && namesNobody(r), r.said);
  }
  {
    /* Three failing CANCELS in a row, each after a good read. Found in
       review on 25 Nov 2026: the good read wiped the count, so this
       never stopped. */
    const store = five();
    paddleStub(store, { patch: (_c, n, usual) => (n >= 2 && n <= 4 ? reply(500, { error: { code: 'internal_error' } }) : usual()) });
    const r = await run();
    check('E7 three failing cancels in a row, each after a good read: the run stops as paddle_failing and the 5th is never asked for',
      r.status === 502 && r.json.stopped === 'paddle_failing' && r.json.closed === 1 && r.json.failed === 3 && !eTouched(store[4].id) &&
      statuses(store) === 'canceled,draft,draft,draft,draft' && /^Could not close checkouts: Paddle failed 3 times in a row, so the run stopped\. /.test(r.said), r.json);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual) => { if (n >= 2 && n <= 4) throw new Error('timed out for ' + store[n - 1].id); return usual(); } });
    const r = await run();
    check('E7 three cancels in a row that cannot be reached: the same', r.status === 502 && r.json.stopped === 'paddle_failing' && r.json.failed === 3 && !eTouched(store[4].id), r.json);
  }
  {
    const store = five();
    paddleStub(store, {
      get: (_c, n, usual) => (n === 3 ? reply(503, {}) : usual()),
      patch: (_c, n, usual) => (n === 2 ? reply(500, {}) : n === 3 ? reply(200, { data: { id: 'txn_01e999999', status: 'draft' } }) : usual()),
    });
    const r = await run();
    check('E7 a failed cancel, then a failed read, then a cancel answered 200 without a cancelled copy: three in a row, stopped',
      r.status === 502 && r.json.stopped === 'paddle_failing' && r.json.closed === 1 && r.json.failed === 3 && !eTouched(store[4].id), r.json);
  }
  {
    /* A transaction dealt with from start to finish ends the run of
       failures: fail, fail, good, fail, fail does not stop. */
    const store = Array.from({ length: 6 }, () => txn());
    paddleStub(store, { patch: (_c, n, usual) => (n === 3 || n === 6 ? usual() : reply(500, {})) });
    const r = await run();
    check('E7 two failing cancels, a good one, two more failing, a good one: the run goes on to the end',
      r.status === 502 && r.json.stopped === null && r.json.closed === 2 && r.json.failed === 4 && ePatched().length === 6, r.json);
  }
  {
    /* ...and so does one that turned out to need no cancel. */
    const store = five();
    paddleStub(store, {
      get: (_c, n, usual, t) => (n === 3 ? reply(200, { data: { ...t, status: 'completed' } }) : usual()),
      patch: (_c, n, usual) => (n <= 3 ? reply(500, {}) : usual()),
    });
    const r = await run();
    check('E7 two failing cancels, one paid in between, a third failing cancel: not three in a row',
      r.json.stopped === null && r.json.failed === 3 && r.json.changed === 1 && r.json.closed === 1 && eReads().length === 5, r.json);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual, t) => (n === 2 ? reply(200, { data: { ...t } }) : usual()) });
    const r = await run();
    check('E7 the cancel answers 200 but the copy is not cancelled: counted as failed, not as closed', r.status === 502 && r.json.closed === 4 && r.json.failed === 1, r.json);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual, t) => (n === 2 ? reply(200, { data: { ...t, id: store[0].id, status: 'canceled' } }) : usual()) });
    const r = await run();
    check('E7 the cancel answers 200 with another transaction\'s copy: counted as failed', r.status === 502 && r.json.closed === 4 && r.json.failed === 1, r.json);
  }
  for (const [name, list, line] of [
    ['answers 500', () => reply(500, { error: { code: 'internal_error', detail: 'txn_01secret' } }), 'the list answered 500 (internal_error), or could not be read'],
    ['answers 500 with an error code that is not the shape of one', () => reply(500, { error: { code: 'txn_01e000001 for ' + USER_EMAIL } }), 'the list answered 500, or could not be read'],
    ['answers 400', () => reply(400, { error: { code: 'bad_request' } }), 'the list answered 400 (bad_request), or could not be read'],
    ['cannot be reached', () => { throw new Error('connect failed'); }, 'the list could not be reached'],
    ['answers 200 with a body that is not JSON', () => reply(200, '<html>txn_01e000001</html>'), 'the list answered 200, or could not be read'],
  ]) {
    const store = five();
    paddleStub(store, { list });
    const r = await run();
    check('E7 the first list ' + name + ': no read, no cancel, 502',
      r.status === 502 && r.json.stopped === 'list_failed' && calls.length === 1 && statuses(store) === 'draft,draft,draft,draft,draft' &&
      r.said === 'Could not close checkouts: ' + line + '. ' + eLine({ stopped: 'list_failed' }), r.said);
  }
  {
    /* Something nobody planned for: the clock itself throws. */
    paddleStub(five());
    const r = await run({ now: () => { throw new TypeError('no clock for txn_01e000001'); } });
    check('E7 an unplanned fault: 500, one line with the kind of error and none of its text',
      r.status === 500 && r.json?.error === 'error' && r.said === 'Could not close checkouts: an unexpected fault (TypeError).', r.said);
  }
  {
    /* A run that takes too long stops starting new work. The clock
       moves three seconds every time it is read. */
    const store = Array.from({ length: 30 }, () => txn());
    paddleStub(store);
    let t = E_NOW;
    const r = await run({ now: () => (t += 3000) });
    check('E7 a run past its 18 seconds stops as "time" with more waiting, and what it cancelled stands',
      r.status === 200 && r.json.stopped === 'time' && r.json.more === true && r.json.closed >= 1 && r.json.closed < 20 &&
      store.filter((x) => x.status === 'canceled').length === r.json.closed, r.json);
  }
  {
    /* The time is looked at before a new page is asked for as well. The
       first pass counts how often the clock is read before the second
       list; the second pass moves the clock on at exactly that reading,
       which is the look at the top of page two. */
    const build = () => [txn(), ...Array.from({ length: 29 }, () => txn({ custom_data: { user_id: USER_ID } })), ...Array.from({ length: 5 }, () => txn())];
    let readings = 0;
    let atSecondList = 0;
    paddleStub(build(), { ignoreFilters: true, list: (_c, n) => { if (n === 2) atSecondList = readings; } });
    await run({ now: () => { readings++; return E_NOW; } });
    const store = build();
    paddleStub(store, { ignoreFilters: true });
    let reading = 0;
    const r = await run({ now: () => (++reading >= atSecondList ? E_NOW + 18001 : E_NOW) });
    check('E7 a run already past its 18 seconds when page two is due: one list and no second, stopped "time", what it cancelled stands',
      atSecondList > 30 && r.status === 200 && eLists().length === 1 && r.json.stopped === 'time' && r.json.more === true && r.json.closed === 1 &&
      r.json.listed === 30 && store[0].status === 'canceled' && store.slice(30).every((t) => t.status === 'draft'), [atSecondList, r.json]);
    const onTime = build();
    paddleStub(onTime, { ignoreFilters: true });
    let tick = 0;
    const ok = await run({ now: () => (++tick >= atSecondList ? E_NOW + 18000 : E_NOW) });
    check('E7 ...and at exactly 18 seconds page two is still asked for', eLists().length === 2 && ok.json.listed === 35, ok.json);
  }
}

{
  /* E8. A 429 stops the run at once: Paddle blocks the address for 60
     seconds, and create-checkout shares it. Nothing is retried. */
  const five = () => Array.from({ length: 5 }, () => txn());
  {
    const store = five();
    paddleStub(store, { list: () => reply(429, { error: { code: 'too_many_requests' } }) });
    const r = await run();
    check('E8 429 on the list: no further request, stopped rate_limited, 502',
      r.status === 502 && r.json.stopped === 'rate_limited' && calls.length === 1 && /^Could not close checkouts: the list answered 429: too many requests, so the run stopped\. /.test(r.said), r.said);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual) => (n === 3 ? reply(429, { error: { code: 'too_many_requests' } }) : usual()) });
    const r = await run();
    const last = calls[calls.length - 1];
    check('E8 429 on the 3rd cancel: the first two stand, and there is no request of any kind after the 429',
      r.status === 502 && r.json.stopped === 'rate_limited' && r.json.closed === 2 && calls.length === 7 && last.method === 'PATCH' && last.path === '/transactions/' + store[2].id &&
      store.map((t) => t.status).join() === 'canceled,canceled,draft,draft,draft', r.json);
  }
  {
    const store = five();
    paddleStub(store, { get: (_c, n, usual) => (n === 2 ? reply(429, {}) : usual()) });
    const r = await run();
    check('E8 429 on the 2nd read: the first stands, nothing after', r.status === 502 && r.json.stopped === 'rate_limited' && r.json.closed === 1 && calls.length === 4 && calls[3].method === 'GET', r.json);
  }
  for (const status of [401, 403]) {
    const store = five();
    paddleStub(store, { list: () => reply(status, { error: { code: 'forbidden', detail: 'key apikey_01secret' } }) });
    const r = await run();
    check('E8 ' + status + ' on the list: stopped paddle_auth, one line saying the key may not read transactions',
      r.status === 502 && r.json.stopped === 'paddle_auth' && calls.length === 1 &&
      r.said === `Could not close checkouts: the list answered ${status}: the key may not read transactions. ` + eLine({ stopped: 'paddle_auth' }), r.said);
  }
  {
    const store = five();
    paddleStub(store, { patch: () => reply(403, { error: { code: 'forbidden' } }) });
    const r = await run();
    check('E8 403 on the first cancel: the run stops, saying the key may not write transactions',
      r.status === 502 && r.json.stopped === 'paddle_auth' && r.json.closed === 0 && calls.length === 3 && /a cancel answered 403: the key may not write transactions\. /.test(r.said), r.said);
  }
  for (const status of [401, 403]) {
    const store = five();
    paddleStub(store, { get: (_c, n, usual) => (n === 2 ? reply(status, { error: { code: 'forbidden', detail: 'key apikey_01secret' } }) : usual()) });
    const r = await run();
    check('E8 ' + status + ' on the 2nd read: the run stops as paddle_auth, the first stands, and nothing is asked after',
      r.status === 502 && r.json.error === 'paddle' && r.json.stopped === 'paddle_auth' && r.json.closed === 1 && r.json.refused === 0 && calls.length === 4 &&
      r.said === `Could not close checkouts: a read answered ${status}: the key may not read transactions. ` + eLine({ closed: 1, listed: 5, old: 2, stopped: 'paddle_auth' }), r.said);
  }
  {
    const store = five();
    paddleStub(store, { patch: (_c, n, usual) => (n === 2 ? reply(401, { error: { code: 'authentication_malformed' } }) : usual()) });
    const r = await run();
    check('E8 401 on the 2nd cancel: the run stops as paddle_auth, saying the key may not write transactions',
      r.status === 502 && r.json.stopped === 'paddle_auth' && r.json.closed === 1 && r.json.refused === 0 && calls.length === 5 &&
      r.said === 'Could not close checkouts: a cancel answered 401: the key may not write transactions. ' + eLine({ closed: 1, listed: 5, old: 2, stopped: 'paddle_auth' }), r.said);
  }
  check('E8 nothing in the function waits or tries again', !/setTimeout|sleep|Retry-After|retry/i.test(EXPIRE_CODE));
}

{
  /* E9. The second look, straight before the cancel. The list is a
     moment old: somebody may have paid since. */
  /* The third entry says whether the run is a fault. Paid, billed or
     cancelled since the list is as it should be. Still unpaid and not
     passing is a prepared purchase left open for a reason nobody
     planned, and is a fault (changed on 25 Nov 2026, review). */
  const SECOND = {
    'completed (paid in between)': [(t) => ({ ...t, status: 'completed' }), 'changed'],
    'paid': [(t) => ({ ...t, status: 'paid' }), 'changed'],
    'billed': [(t) => ({ ...t, status: 'billed', billed_at: '2026-11-25T04:59:59Z' }), 'changed'],
    'already canceled': [(t) => ({ ...t, status: 'canceled' }), 'changed'],
    'origin web': [(t) => ({ ...t, origin: 'web' }), 'changed', true],
    'a subscription id': [(t) => ({ ...t, subscription_id: 'sub_01test' }), 'changed', true],
    'made_by gone, and no price to know the transaction by': [(t) => ({ ...t, custom_data: { user_id: USER_ID } }), 'changed', true],
    'no payments field': [(t) => { const { payments: _p, ...rest } = t; return rest; }, 'changed', true],
    'payments null': [(t) => ({ ...t, payments: null }), 'changed', true],
    'payments that is not a list': [(t) => ({ ...t, payments: {} }), 'changed', true],
    'a different id': [(t) => ({ ...t, id: 'txn_01e999999' }), 'changed', true],
    'a different id that is paid': [(t) => ({ ...t, id: 'txn_01e999999', status: 'paid' }), 'changed', true],
    'no data': [() => null, 'changed', true],
    'a payment with status captured': [(t) => ({ ...t, payments: [{ status: 'captured' }] }), 'paying'],
    'a payment with status authorized': [(t) => ({ ...t, payments: [{ status: 'authorized' }] }), 'paying'],
    'a payment with status authorized_flagged': [(t) => ({ ...t, payments: [{ status: 'authorized_flagged' }] }), 'paying'],
    'a payment with status action_required': [(t) => ({ ...t, payments: [{ status: 'action_required' }] }), 'paying'],
    'a payment with status pending_no_action_required': [(t) => ({ ...t, payments: [{ status: 'pending_no_action_required' }] }), 'paying'],
    'a payment with status created': [(t) => ({ ...t, payments: [{ status: 'created' }] }), 'paying'],
    'a payment with status unknown': [(t) => ({ ...t, payments: [{ status: 'unknown' }] }), 'paying'],
    'a payment with a status nobody has seen': [(t) => ({ ...t, payments: [{ status: 'settling' }] }), 'paying'],
    'a payment with no status': [(t) => ({ ...t, payments: [{}] }), 'paying'],
    'a payment entry that is null': [(t) => ({ ...t, payments: [null] }), 'paying'],
    'one failed payment and one captured': [(t) => ({ ...t, payments: [{ status: 'error' }, { status: 'captured' }] }), 'paying'],
  };
  for (const [name, [fresh, counted, fault]] of Object.entries(SECOND)) {
    const one = txn();
    const good = txn();
    paddleStub([one, good], { get: (_c, n, usual, t) => (n === 1 ? reply(200, { data: fresh(t) }) : usual()) });
    const r = await run();
    check('E9 the list says draft and the second read says ' + name + ': no cancel, counted as ' + counted + ', and the next one is still cancelled',
      r.json.closed === 1 && r.json[counted] === 1 && one.status === 'draft' && good.status === 'canceled' && same(ePatched(), [good.id]), r.json);
    check('E9 ...' + name + ': ' + (fault ? 'a fault, 502 left_open, with a line that says one still unpaid did not pass' : 'not a fault, 200'),
      fault
        ? r.status === 502 && r.json.error === 'left_open' &&
          r.said === 'Could not close checkouts: 1 still unpaid did not pass the second read. ' + eLine({ closed: 1, listed: 2, old: 2, changed: 1 })
        : r.status === 200 && r.said === 'checkouts closed: ' + eLine({ closed: 1, listed: 2, old: 2, [counted]: 1 }), r.said);
  }
  {
    /* Every one that was due turned out to be paid: nothing to cancel,
       and nothing wrong. */
    const store = [txn(), txn()];
    paddleStub(store, { get: (_c, _n, _usual, t) => reply(200, { data: { ...t, status: 'completed' } }) });
    const r = await run();
    check('E9 both were paid between the list and the second read: 200, closed 0, changed 2, no cancel', r.status === 200 && r.json.closed === 0 && r.json.changed === 2 && ePatched().length === 0, r.json);
  }
  for (const status of ['error', 'canceled', 'dropped']) {
    const one = txn({ payments: [{ status }, { status }] });
    paddleStub([one]);
    const r = await run();
    check('E9 payment attempts that all ended as "' + status + '": nobody is paying, so cancelled', r.json.closed === 1 && one.status === 'canceled', r.json);
  }
  {
    const one = txn();
    paddleStub([one], { get: () => reply(404, { error: { code: 'not_found', detail: one.id } }) });
    const r = await run();
    check('E9 the second read answers 404: no cancel, refused 1, and a fault that gives the status and the short code',
      r.status === 502 && r.json.error === 'left_open' && r.json.refused === 1 && r.json.closed === 0 && ePatched().length === 0 &&
      r.said === 'Could not close checkouts: Paddle refused 1, and last a read answered 404 (not_found). ' + eLine({ listed: 1, old: 1, refused: 1 }), r.said);
  }
  {
    /* The list leaves payments out (it may: not read either way); the
       single read carries them. */
    const one = txn();
    paddleStub([one], { list: (_c, _n, body) => { body.data = body.data.map(({ payments: _p, ...rest }) => rest); } });
    const r = await run();
    check('E9 a list entry with no payments field is still read a second time, and cancelled when that read lists none', r.json.closed === 1 && one.status === 'canceled', r.json);
  }
  {
    const price = { items: [{ quantity: 1, price: { description: 'Premium yearly, first payment after 30 days (create-checkout)', trial_period: { interval: 'day', frequency: 30 } } }] };
    const one = txn(price);
    paddleStub([one], { get: (_c, _n, _usual, t) => reply(200, { data: { ...t, custom_data: { note: 'test' } } }) });
    const r = await run();
    check('E9 made_by on the list and gone on the second read, with the one-off price still there: cancelled', r.status === 200 && r.json.closed === 1 && one.status === 'canceled', r.json);
    const two = txn({ custom_data: { note: 'test' }, ...price });
    paddleStub([two], { get: (_c, _n, _usual, t) => reply(200, { data: { ...t, items: [] } }) });
    const r2 = await run();
    check('E9 known by the price on the list, and neither mark on the second read: no cancel, and a fault',
      r2.status === 502 && r2.json.error === 'left_open' && r2.json.changed === 1 && r2.json.closed === 0 && two.status === 'draft' && ePatched().length === 0, r2.json);
  }
  check('E9 the second read is tested with the same function as the list entry, and must list its payments',
    /const first = ours\(item, Date\.now\(\) - ahead, false\);/.test(EXPIRE_CODE) && /const second = same \? ours\(fresh, Date\.now\(\) - ahead, true\) : "not_ours";/.test(EXPIRE_CODE) &&
    /const FAILED_PAYMENT = \["error", "canceled", "dropped"\];/.test(EXPIRE_CODE));
}

{
  /* E10. Only the one body, only two kinds of request, only Paddle.
     run() looked at every call of every case above. */
  check('E10 across every run in part E: only GET and PATCH, only to Paddle, no GET with a body, every PATCH body exactly {"status":"canceled"}, ' +
    'and every PATCH for an id that run listed and read straight before', eBroken.length === 0 && eRuns >= 150 && ePatches >= 250, [eRuns, ePatches, ...eBroken.slice(0, 5)]);
  check('E10 the body is a constant written once, and is the only thing ever sent',
    (EXPIRE_SOURCE.split(CANCEL_TEXT).length - 1) === 1 && EXPIRE_CODE.includes("const CANCEL_BODY = '" + CANCEL_TEXT + "';") &&
    !/JSON\.stringify\([^)]*status/.test(EXPIRE_CODE) && (EXPIRE_CODE.match(/CANCEL_BODY/g) || []).length === 2);
  check('E10 three kinds of call to Paddle and no more: the list, one read, one cancel. Never a POST, never a DELETE',
    (EXPIRE_CODE.match(/await paddle\(/g) || []).length === 3 && /paddle\(\s*"GET",\s*`\/transactions\?status=draft,ready&/.test(EXPIRE_CODE) &&
    /paddle\("GET", `\/transactions\/\$\{id\}`\)/.test(EXPIRE_CODE) && /paddle\("PATCH", `\/transactions\/\$\{id\}`, CANCEL_BODY\)/.test(EXPIRE_CODE) &&
    !/DELETE|PUT/.test(EXPIRE_CODE) && (EXPIRE_CODE.match(/"POST"/g) || []).length === 1 && /request\.method !== "POST"/.test(EXPIRE_CODE) &&
    (EXPIRE_CODE.match(/\bfetch\(/g) || []).length === 1);
  check('E10 it holds no export and no import, and reads nothing from Supabase',
    !/^\s*export\b/m.test(EXPIRE_CODE) && !/^\s*import\b/m.test(EXPIRE_CODE) && !/SUPABASE|SERVICE_ROLE|ANON_KEY/.test(EXPIRE_CODE));
  check('E10 it uses the same sandbox switch as create-checkout, not a host written in',
    /Deno\.env\.get\("PADDLE_ENVIRONMENT"\) \?\? "production"\) === "sandbox"/.test(EXPIRE_CODE) && EXPIRE_CODE.includes('https://sandbox-api.paddle.com') && EXPIRE_CODE.includes('https://api.paddle.com'));
  const madeByThere = (CHECKOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').match(/made_by: "([^"]+)"/) || [])[1];
  const madeByHere = (EXPIRE_CODE.match(/const MADE_BY = "([^"]+)";/) || [])[1];
  check('E10 MADE_BY is the text create-checkout writes as made_by', Boolean(madeByThere) && madeByHere === madeByThere && madeByHere === 'create-checkout', { madeByHere, madeByThere });
  /* The second mark: the end of the description create-checkout writes
     on its one-off price, beside the trial that carries the free days. */
  const checkoutCode = CHECKOUT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
  const described = (checkoutCode.match(/description: `([^`]+)`/) || [])[1] || '';
  const priceMark = (EXPIRE_CODE.match(/const PRICE_MARK = "([^"]+)";/) || [])[1];
  check('E10 PRICE_MARK is how the description create-checkout writes on its one-off price ends, and that price carries the trial in days',
    priceMark === ' (create-checkout)' && described.endsWith(priceMark) && (checkoutCode.match(/description: `/g) || []).length === 1 &&
    /trial_period: \{ interval: "day", frequency: days \},/.test(checkoutCode) && /price\.description\.endsWith\(PRICE_MARK\)/.test(EXPIRE_CODE) &&
    /if \(!markedByData\(txn\.custom_data\) && !markedByPrice\(txn\.items\)\) return "not_ours";/.test(EXPIRE_CODE), { priceMark, described });
  check('E10 the id that reaches a Paddle address is tested for its shape first, and origin is an allow list of one',
    /const TXN_ID = \/\^txn_\[a-z0-9\]\+\$\/;/.test(EXPIRE_CODE) && /!TXN_ID\.test\(txn\.id\)\) return "not_ours";/.test(EXPIRE_CODE) &&
    /if \(txn\.origin !== "api"\) return "not_ours";/.test(EXPIRE_CODE) && /if \(!\(txn\.status === "draft" \|\| txn\.status === "ready"\)\) return "not_ours";/.test(EXPIRE_CODE));
  check('E10 each request to Paddle has a time limit', /signal: AbortSignal\.timeout\(REQUEST_LIMIT_MS\)/.test(EXPIRE_CODE) && /const REQUEST_LIMIT_MS = 3000;/.test(EXPIRE_CODE) && /const RUN_BUDGET_MS = 18000;/.test(EXPIRE_CODE));
  /* The job hangs up after 25 seconds. A run starts no new transaction
     after RUN_BUDGET_MS, and one transaction is at most two requests,
     so the longest run must still fit (review, 25 Nov 2026: at 20
     seconds and 8 a request a run could last 36). */
  check('E10 the longest a run can last is under the 25 seconds the job waits', 18000 + 2 * 3000 < 25000 &&
    /timeout_milliseconds := 25000/.test(read('supabase/cron.sql')));
}

{
  /* E11. Nothing names an account. run() also looked, for every case,
     that there was exactly one log line and that the answer held the
     documented keys and nothing else. */
  check('E11 across every run in part E: one log line, and neither the answer nor the log holds an account id, an email, a transaction id or a customer id',
    eBroken.every((b) => !b.wrong.some((w) => /names|log lines|answer/.test(w))) && eBroken.length === 0, eBroken.slice(0, 5));
  /* A body sent to the function is never read. */
  const young = txn({ created_at: '2026-11-25T04:30:00Z' });
  const paid = txn({ status: 'completed' });
  const store = [young, paid];
  for (const ignoreFilters of [false, true]) {
    paddleStub(store, { ignoreFilters });
    const r = await run({ body: JSON.stringify({ id: young.id, transaction_id: paid.id, ids: [young.id, paid.id], status: 'draft', max_age_minutes: 0, after: paid.id }) });
    check('E11 a request body naming transactions is never read' + (ignoreFilters ? ' (the list ignores its filters)' : '') + ': nothing changes and no request to Paddle carries those ids',
      r.status === 200 && r.json.closed === 0 && young.status === 'draft' && paid.status === 'completed' && calls.length === 1 &&
      !calls.some((c) => c.url.includes(young.id) || c.url.includes(paid.id)), r.json);
  }
  check('E11 the function reads nothing of the request but its method and the secret header',
    !/request\.(json|text|body|url|formData|arrayBuffer|blob)\b/.test(EXPIRE_CODE) &&
    same((EXPIRE_CODE.match(/request\.[a-zA-Z]+/g) || []).sort(), ['request.headers', 'request.method']), EXPIRE_CODE.match(/request\.[a-zA-Z]+/g));
  check('E11 no log line is given an id, Paddle\'s words or an error\'s text',
    [...EXPIRE_CODE.matchAll(/console\.(log|warn|error)\(([^;]*)\);/g)].every((m) => !/\bid\b|\.text|\.data|\.message|String\(error\)|\berror\)/.test(m[2])) &&
    (EXPIRE_CODE.match(/console\.(log|warn|error)\(/g) || []).length === 5, EXPIRE_CODE.match(/console\.(log|warn|error)\([^;]*\);/g));
}

{
  /* E12. supabase/schema-expire-checkouts.sql, read as text. STATIC
     ONLY: nothing here runs SQL, and the file has never been run
     anywhere. Its first run is the owner's paste. */
  const raw = read('supabase/schema-expire-checkouts.sql');
  const sql = raw.split('\n').map((line) => line.replace(/^\s*--.*$/, '')).join('\n');
  check('E12 the new job is a copy of countdown-milestones with the function\'s path swapped, and nothing else is typed',
    sql.includes("source_job     constant text := 'countdown-milestones';") && sql.includes("new_job        constant text := 'countdown-expire-checkouts';") &&
    sql.includes("old_path       constant text := '/functions/v1/notify-milestones';") && sql.includes("new_path       constant text := '/functions/v1/expire-checkouts';") &&
    sql.includes('new_command := replace(source_command, old_path, new_path);'));
  check('E12 every ten minutes, off the minutes the other jobs use', sql.includes("perform cron.schedule(new_job, '3,13,23,33,43,53 * * * *', new_command);"));
  check('E12 exactly one cron.schedule and one cron.unschedule, inside one DO block, the unschedule only when the job exists',
    (sql.match(/cron\.schedule\(/g) || []).length === 1 && (sql.match(/cron\.unschedule\(/g) || []).length === 1 &&
    (sql.match(/do \$do\$/g) || []).length === 1 && sql.indexOf('do $do$') < sql.indexOf('cron.unschedule(') && sql.indexOf('cron.schedule(') < sql.lastIndexOf('$do$;') &&
    /if exists \(select 1 from cron\.job where jobname = new_job\) then\s+perform cron\.unschedule\(new_job\);\s+end if;/.test(sql));
  check('E12 it stops, changing nothing, when the source job is missing, is not the shape cron.sql gives, or still holds a placeholder',
    /if found_count <> 1 or source_command is null then\s+raise exception 'Nothing was changed\./.test(sql) &&
    (sql.match(/raise exception 'Nothing was changed\. /g) || []).length === 5 &&
    sql.indexOf('raise exception', sql.indexOf('new_command := replace(')) < sql.indexOf('cron.unschedule(') &&
    ["position('<CRON_SECRET>' in source_command) > 0", "position('<PROJECT_REF>' in source_command) > 0", "position('<ANON_KEY>' in source_command) > 0",
      "position('net.http_post' in source_command) = 0", "position('x-cron-secret' in source_command) = 0"].every((t) => sql.includes(t)));
  check('E12 no secret is typed in: the placeholders appear only inside those tests',
    (raw.match(/<CRON_SECRET>/g) || []).length === 1 && (raw.match(/<ANON_KEY>/g) || []).length === 1 && (raw.match(/<PROJECT_REF>/g) || []).length === 1 &&
    !/x-cron-secret'\s*,\s*'[^'\s]/.test(sql.replace("'''x-cron-secret'',\\s*''[^'']+'''", '')) && !/Bearer/.test(sql));
  /* The command holds the secret, so nothing may put one on the screen. */
  const statements = sql.split(';');
  check('E12 no statement returns a job\'s command: it is read once, into a variable, and the check query only tests it',
    (sql.match(/min\(command\)\s+into found_count, source_command/g) || []).length === 1 &&
    statements.filter((s) => /\bselect\b[\s\S]*\bcommand\b[\s\S]*from cron\.job/i.test(s)).length === 2 &&
    !/select\s+(\*|command|j\.command|m\.command)\s*(,|from)/i.test(sql) && !/,\s*(j\.|m\.)?command\s*(,|from)/i.test(sql) && !/select \*/i.test(sql) && !/raise notice/i.test(sql));
  const raises = sql.split('\n').filter((line) => /\braise\b/i.test(line));
  check('E12 no RAISE prints a command, and none holds a percent sign', raises.length === 5 && raises.every((line) => !/source_command|new_command|%/.test(line)), raises);
  const tail = raw.slice(raw.lastIndexOf('-- The check.'));
  check('E12 it ends with the check query, and the comment gives the one row to expect',
    raw.includes('-- The check. Expect exactly one row:\n--   countdown-expire-checkouts | 3,13,23,33,43,53 * * * * | true | true | true | true\n') &&
    /^-- The check\.[^\n]*\n--[^\n]*\nselect j\.jobname,\s+j\.schedule,\s+j\.active,/.test(tail) && tail.trimEnd().endsWith("where j.jobname = 'countdown-expire-checkouts';") &&
    raw.indexOf('-- The check.') > raw.lastIndexOf('$do$;'));
  check('E12 it says: one paste, safe to run again, after cron.sql and after the deploy with its flag',
    raw.includes('One paste, nothing to edit, safe to run again.') && raw.includes('supabase functions deploy expire-checkouts --no-verify-jwt') &&
    raw.includes('Run AFTER cron.sql has been run for this project'));
  /* What it copies really is the shape cron.sql gives. */
  const cron = read('supabase/cron.sql');
  /* The function plans a run to end inside the 25 seconds the copied
     job waits, so the SQL refuses a source job that waits any other
     time (review, 25 Nov 2026). The same pattern is tried here on
     cron.sql's own text; the SQL itself has never been run. */
  const waits = /timeout_milliseconds\s*:=\s*25000[^0-9]/;
  check('E12 it stops, changing nothing, when the source job does not wait 25 seconds for an answer',
    sql.includes("if source_command !~ 'timeout_milliseconds\\s*:=\\s*25000[^0-9]' then") &&
    sql.indexOf("if source_command !~ 'timeout_milliseconds") < sql.indexOf('new_command := replace(') &&
    waits.test((cron.match(/select cron\.schedule\(\s*'countdown-milestones',[\s\S]*?\$\$([\s\S]*?)\$\$/) || [])[1] || '') &&
    !waits.test('timeout_milliseconds := 250000\n') && !waits.test('timeout_milliseconds := 5000\n') && !waits.test('body := \'{}\'::jsonb\n'));
  /* cron.sql's own "Useful checks" told the reader to run select * on
     cron.job and cron.job_run_details. Both have a command column, and
     three commands hold the cron secret (review, 25 Nov 2026). */
  check('E12 cron.sql no longer suggests a query that would put a job\'s command on the screen',
    !/select\s+\*\s+from/i.test(cron) && !/select[^;\n]*\bcommand\b[^;\n]*from cron\./i.test(cron) &&
    cron.includes('--   select jobname, schedule, active from cron.job order by jobname;') &&
    /cron\.job_run_details both have a command column/.test(cron) && !/select\s+\*\s+from/i.test(raw));
  const block = (cron.match(/select cron\.schedule\(\s*'countdown-milestones',[\s\S]*?\$\$([\s\S]*?)\$\$/) || [])[1] || '';
  check('E12 cron.sql still gives countdown-milestones the shape this file looks for: one net.http_post to notify-milestones with an x-cron-secret header',
    block.includes('net.http_post') && block.split('/functions/v1/notify-milestones').length === 2 && block.split('notify-milestones').length === 2 &&
    /'https:\/\/<PROJECT_REF>\.supabase\.co\/functions\/v1\/notify-milestones'/.test(block) && /'x-cron-secret',\s*'[^']+'/.test(block) && !block.includes('expire-checkouts'), block);
  check('E12 cron.sql points at this file, as a comment only',
    /^-- is made by schema-expire-checkouts\.sql, which copies the countdown-milestones$/m.test(cron) && !cron.split('\n').some((line) => !/^\s*--/.test(line) && /expire-checkouts/.test(line)));
}

/* ───────────────── Part 2: schema-foundation.sql, read as text ───────────────── */

const SQL_RAW = read('supabase/schema-foundation.sql');
const SQL = SQL_RAW.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const SQL_FLAT = squash(SQL).toLowerCase();

function functionBody(name) {
  const start = SQL.indexOf('create or replace function public.' + name + '(');
  if (start < 0) return '';
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return open < 0 || close < 0 ? '' : SQL.slice(open + 2, close);
}
const CLAIM_BODY = functionBody('claim_foundation_place');
const STATUS_BODY = functionBody('foundation_status');

check('S1 place must be 1 to 100', /check \(place between 1 and 100\)/.test(SQL_FLAT));
check('S1 place is unique', /place smallint constraint \w+ unique/.test(SQL_FLAT));
check('S1 an account has one row', /user_id uuid unique/.test(SQL_FLAT));

check('S2 row-level security is on', SQL_FLAT.includes('alter table public.foundation_claims enable row level security'));
check('S2 all three API roles lose every right on the table',
  SQL_FLAT.includes('revoke all on table public.foundation_claims from anon, authenticated, service_role'));

for (const banned of ['create policy', 'create view', 'drop table', 'truncate', 'delete from']) {
  check('S3 no "' + banned + '"', !SQL_FLAT.includes(banned));
}

{
  const grantsFound = (SQL.match(/(^|\n)\s*grant\b[^;]*;/gi) || []).map((g) => squash(g).toLowerCase());
  check('S4 exactly two grants', grantsFound.length === 2, grantsFound);
  check('S4 claiming is for the service role only',
    grantsFound.includes('grant execute on function public.claim_foundation_place(uuid, text, timestamptz, text) to service_role;'), grantsFound);
  check('S4 the status is for the public',
    grantsFound.includes('grant execute on function public.foundation_status() to anon, authenticated;'), grantsFound);
  check('S4 nothing else is granted to anon', grantsFound.filter((g) => /\banon\b/.test(g)).length === 1, grantsFound);
  check('S4 the claim function is revoked from everyone else first',
    SQL_FLAT.includes('revoke all on function public.claim_foundation_place(uuid, text, timestamptz, text) from public, anon, authenticated'));
}

{
  const lock = CLAIM_BODY.indexOf('lock table public.foundation_claims in share row exclusive mode');
  const firstSelect = CLAIM_BODY.search(/\bselect\b/);
  check('S5 the claim takes the table lock before it reads anything', lock >= 0 && firstSelect > lock, { lock, firstSelect });
  check('S5 the status function takes no lock', STATUS_BODY !== '' && !/\block\b/.test(STATUS_BODY));
  check('S5 a stuck lock gives up', /set lock_timeout = '5s'/.test(SQL));
}

{
  /* A member's later subscription does not carry the place: the claim
     function and the owner's list query give the same answer. */
  const flat = squash(CLAIM_BODY);
  check('S10 a place answers only for the subscription that earned it',
    /if v_row\.place is not null then if v_row\.paddle_subscription_id is distinct from p_subscription_id then return jsonb_build_object\('member', false, 'already', true, 'reason', 'lock_lost'\); end if; return jsonb_build_object\('member', true/.test(flat), flat.slice(0, 600));
  check('S10 ...the list query for the owner says the same', SQL_RAW.includes("'lock lost: a different subscription'"));
  check('S10 ...and the rehearsal covers it', /'rehearsal_a_again'[\s\S]*r->>'reason' = 'lock_lost'/.test(read('supabase/test-foundation.sql')));
}

{
  const creates = SQL.match(/\bcreate\b[^\n]*/gi) || [];
  check('S6 every create is safe to run again',
    creates.length === 3 && creates.every((c) => /^create table if not exists /i.test(c) || /^create or replace function /i.test(c)), creates);
}

const uncommentedPage = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stamps = (text) => [...text.matchAll(/timestamptz '([^']+)'/g)].map((m) => at(m[1].replace(' ', 'T')));
{
  const inClaim = stamps(CLAIM_BODY);
  const inStatus = stamps(STATUS_BODY);
  check('S7 the claim function opens and closes on the settled instants',
    inClaim.length === 2 && inClaim.includes(OPENS) && inClaim.includes(CLOSES), inClaim);
  check('S7 the status function uses the same two', inStatus.length === 2 && inStatus.includes(OPENS) && inStatus.includes(CLOSES), inStatus);
  check('S7 the claim is open from its first instant and shut at its last',
    /p_subscribed_at < c_opens or p_subscribed_at >= c_closes/.test(CLAIM_BODY));

  /* Foundation closes at the end of 31 December 2026 in the last time
     zone, the instant 2027-01-01T12:00Z, written out here so it is not
     only compared with this file's own constant. */
  check('S7 the closing instant is 2027-01-01T12:00Z, 22.5 hours after Adelaide midnight',
    CLOSES === Date.UTC(2027, 0, 1, 12, 0) && CLOSES - ADELAIDE_CLOSE === 22.5 * 3600000 && CLOSES - OPENS === 40 * 86400000 + 22.5 * 3600000);
  check('S7 the claim function is written with that instant',
    CLAIM_BODY.includes("c_closes constant timestamptz := timestamptz '2027-01-01 12:00:00+00:00';"));
  check('S7 ...and so is the status function', STATUS_BODY.includes("now() <  timestamptz '2027-01-01 12:00:00+00:00'"));
  check('S7 the Adelaide-midnight close is nowhere in the SQL file',
    !stamps(SQL_RAW).includes(ADELAIDE_CLOSE) && !/2027-01-01 00:00:00\+10:30/.test(SQL_RAW));
  check('S7 the old close, the end of 5 December, is nowhere in the SQL file as a date',
    !/2026-12-0[56]/.test(SQL_RAW) && !stamps(SQL_RAW).includes(OLD_CLOSE), stamps(SQL_RAW).map((t) => new Date(t).toISOString()));
  const everyStamp = stamps(SQL_RAW);
  check('S7 every instant in the file, comments and queries included, is the opening or the closing one',
    everyStamp.length >= 6 && everyStamp.every((t) => t === OPENS || t === CLOSES), everyStamp.map((t) => new Date(t).toISOString()));
  /* The closing instant lives only in the two function bodies, both
     "create or replace" (S6), so running the file again is what moves a
     database that still has the old close. Nothing stores it. */
  const beforeFunctions = SQL.slice(0, SQL.indexOf('create or replace function'));
  check('S7 no instant is stored: outside the two function bodies the file writes no date',
    beforeFunctions.includes('create table if not exists public.foundation_claims') && !/timestamptz '/.test(beforeFunctions) &&
    stamps(SQL).length === 4 && stamps(CLAIM_BODY).length + stamps(STATUS_BODY).length === 4, stamps(SQL).length);

  /* paddle-webhook holds no closing date of its own any more. The
     first payment has no cut-off, and the Foundation window is judged
     in SQL on the instant the function passes on. */
  const webhookCode = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const webhookDates = [...webhookCode.matchAll(/Date\.parse\("([^"]+)"\)/g)].map((m) => m[1]);
  check('S7 paddle-webhook has no LAUNCH_OFFER_END and no cut-off date', !WEBHOOK_SOURCE.includes('LAUNCH_OFFER_END') && !/2026-12-0[56]|2027-01-01T00:00/.test(WEBHOOK_SOURCE));
  check('S7 ...the only date written into it is LAUNCH_FIRST_CHARGE',
    webhookDates.length === 1 && webhookDates[0] === '2027-01-01T12:00:00Z' && !/\b20\d\d-\d\d-\d\d/.test(webhookCode.replace('2027-01-01T12:00:00Z', '')), webhookDates);
  /* The rule is given the account's date, the plan and Paddle's own
     date, and no "now" and no offer date. The purchase time reaches it
     in one way only: as a stand-in for Paddle's own date when the
     payload does not state one (W18). */
  check('S7 ...and the first-payment rule takes the account, the plan and Paddle\'s own date, nothing else',
    /function firstChargeAt\(\s*createdAt: string, plan: string \| null, \w+: string \| null,\s*\): Date \| null \{/.test(WEBHOOK_SOURCE) &&
    /await deferFirstCharge\(\s*userId, String\(data\.id\), [^;]+, status, row\.plan,\s*\);/.test(WEBHOOK_SOURCE));
  /* Changed on 23 Nov 2026: this said "two places only". A third reads
     it now, ownTrialAtPurchase (W29), which asks whether the account's
     own trial was running when the subscription was bought. That feeds
     one log line and no date, so what this check guards still holds: the
     purchase time reaches the RULE only as the stand-in. */
  check('S7 ...the purchase time is read in three places only: the Foundation claim, the stand-in for Paddle\'s date, and one log line',
    (webhookCode.match(/\bpurchasedAt\(/g) || []).length === 4 &&
    /function paddleFirstPaymentAt\([^)]*\)[^{]*\{[\s\S]*?purchasedAt\(data, event\)[\s\S]*?\n\}/.test(webhookCode) &&
    /const subscribedAt = isCreation \? purchasedAt\(data, event\) : null;/.test(webhookCode) &&
    /\? await ownTrialAtPurchase\(userId, String\(data\.id\), purchasedAt\(data, event\)\)/.test(webhookCode));
  check('S7 ...and what that third reading gives goes to the log line and nowhere else',
    (webhookCode.match(/\bownTrial\b/g) || []).length === 4 &&
    /noteFirstCharge\(data, status, shown, movedTo, deferError !== null, ownTrial\);/.test(webhookCode) &&
    /if \(ownTrial === false\) \{\s*console\.warn\("free period on an account whose own free trial was not running"\);\s*\}/.test(webhookCode),
    (webhookCode.match(/\bownTrial\b/g) || []).length);
  check('S7 ...and Paddle\'s own next_billed_at is tried first, as the stated date, then the period end, as a stand-in',
    /if \(readable\(data\?\.next_billed_at\)\) return \{ at: data\.next_billed_at, stated: true \};\s*const periodEnd = data\?\.current_billing_period\?\.ends_at;\s*if \(readable\(periodEnd\)\) return \{ at: periodEnd, stated: false \};/.test(webhookCode));
}

{
  const code = WEBHOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('S8 paddle-webhook holds no Foundation opening date', !WEBHOOK_SOURCE.includes('2026-11-22'));
  check('S8 ...and no count of places', !/\b100\b/.test(code));
}

{
  // The rehearsal must never be able to save anything.
  const rehearsal = read('supabase/test-foundation.sql');
  check('S9 the rehearsal ends by raising, which undoes it',
    /raise exception 'REHEARSAL FINISHED\. Nothing was saved\. %', v_out;\s*end \$\$;\s*$/.test(rehearsal));
  check('S9 ...and is one block with no commit', (rehearsal.match(/^do \$\$/gm) || []).length === 1 && !/\bcommit\b/i.test(rehearsal));
  // ...and it rehearses the close that is now in force.
  check('S9 the rehearsal refuses a subscription at the closing instant, 2027-01-01T12:00Z',
    /'rehearsal_late', timestamptz '2027-01-01 12:00:00\+00:00'/.test(rehearsal));
  check('S9 ...gives the last place one second before it, at the end of 31 December 2026 in the last time zone',
    (rehearsal.match(/'rehearsal_a', timestamptz '2027-01-01 11:59:59\+00:00'/g) || []).length === 2 &&
    at('2027-01-01T11:59:59Z') === CLOSES - 1000 && at('2027-01-01T11:59:59Z') > ADELAIDE_CLOSE);
  check('S9 ...and has no trace of the old close', !/2026-12-0[56]/.test(rehearsal));
}

/* ─────────────────────────── Part 3: the pages ─────────────────────────── */

const PRICING = read('app/pricing.html');
const FOUNDATION = read('app/foundation.html');
const PAGES = { 'pricing.html': PRICING, 'foundation.html': FOUNDATION };

/* The shared block, whole lines from the one carrying the begin marker
   to the one carrying the end marker. */
function block(html) {
  const lines = html.split('\n');
  const from = lines.findIndex((l) => l.includes('foundation-status:begin'));
  const to = lines.findIndex((l) => l.includes('foundation-status:end'));
  return from < 0 || to < from ? '' : lines.slice(from, to + 1).map((l) => l.replace(/^\s+/, '')).join('\n');
}
const BLOCK = block(PRICING);

check('P1 both pages carry the status block', BLOCK !== '' && block(FOUNDATION) !== '');
check('P1 ...and it is the same text in both', BLOCK === block(FOUNDATION));

/* Runs the block in a sandbox. `answer` plays Supabase: a function
   returning {status, body}, or one that throws or never settles. */
function sandbox(answer, config) {
  const seen = [];
  const ctx = {
    CT: { config: config || { isConfigured: true, supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'publishable-test-key' } },
    AbortController,
    // The wait is shortened, never removed: a timeout case really aborts.
    setTimeout: (fn) => setTimeout(fn, 5),
    clearTimeout: (t) => clearTimeout(t),
    fetch: (url, init) => {
      seen.push({ url, init });
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        let a;
        try { a = answer(); } catch (e) { reject(e); return; }
        if (a === 'hang') return;
        resolve({
          ok: a.status >= 200 && a.status < 300,
          status: a.status,
          json: () => new Promise((res) => res(JSON.parse(a.body))),
        });
      });
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx, { filename: 'foundation-status-block.js' });
  return { ctx, seen };
}

async function stateFor(answer, now, config) {
  const { ctx, seen } = sandbox(answer, config);
  const s = await ctx.readFoundation();
  return { state: ctx.foundationState(s, now), s, seen };
}

const json = (value) => () => ({ status: 200, body: JSON.stringify(value) });
const BEFORE = CLOSES - 86400000;
const AFTER = CLOSES + 1000;

{
  const a = await stateFor(json({ open: true, places_left: 63 }), BEFORE);
  check('P2 open with 63 left is open, and the number is 63', a.state === 'open' && a.s.left === 63, a.s);
  check('P2 open with 1 left is open', (await stateFor(json({ open: true, places_left: 1 }), BEFORE)).state === 'open');
  check('P2 not open with 0 left is full', (await stateFor(json({ open: false, places_left: 0 }), BEFORE)).state === 'full');
  check('P2 "open" with 0 left is still full', (await stateFor(json({ open: true, places_left: 0 }), BEFORE)).state === 'full');
  check('P2 not open with 40 left is closed', (await stateFor(json({ open: false, places_left: 40 }), BEFORE)).state === 'closed');
  check('P2 extra fields in the answer are ignored', (await stateFor(json({ open: true, places_left: 9, email: 'x' }), BEFORE)).s.email === undefined);

  const unreadable = {
    'a rejected request': () => { throw new Error('offline'); },
    'a request that never answers': () => 'hang',
    'HTTP 500': () => ({ status: 500, body: '{"open":true,"places_left":63}' }),
    'HTTP 404': () => ({ status: 404, body: '{"open":true,"places_left":63}' }),
    'a body that is not JSON': () => ({ status: 200, body: '<html>' }),
    'null': json(null),
    'a number written as text': json({ open: true, places_left: '63' }),
    '101 left': json({ open: true, places_left: 101 }),
    'a negative number': json({ open: true, places_left: -1 }),
    'a fraction': json({ open: true, places_left: 2.5 }),
    'open written as text': json({ open: 'yes', places_left: 63 }),
    'no open field': json({ places_left: 63 }),
    'no places_left field': json({ open: true }),
    'an array': json([{ open: true, places_left: 63 }]),
  };
  for (const [name, answer] of Object.entries(unreadable)) {
    const r = await stateFor(answer, BEFORE);
    check('P2 ' + name + ' is unknown, with no number', r.state === 'unknown' && r.s === null, r.s);
    const late = await stateFor(answer, AFTER);
    check('P3 ' + name + ', after the closing instant, is closed', late.state === 'closed' && late.s === null, late.s);
  }

  check('P3 an "open" answer after the closing instant is closed', (await stateFor(json({ open: true, places_left: 63 }), AFTER)).state === 'closed');
  check('P3 ...and at the closing instant itself', (await stateFor(json({ open: true, places_left: 63 }), CLOSES)).state === 'closed');
  check('P3 one millisecond before, it is still open', (await stateFor(json({ open: true, places_left: 63 }), CLOSES - 1)).state === 'open');
  check('P3 zero left after the closing instant is still full', (await stateFor(json({ open: true, places_left: 0 }), AFTER)).state === 'full');
}

{
  const { seen } = await stateFor(json({ open: true, places_left: 63 }), BEFORE);
  const sent = seen[0] || { init: { headers: {} } };
  check('P4 one request, to the status function', seen.length === 1 && sent.url === 'https://proj.supabase.co/rest/v1/rpc/foundation_status', seen.map((s) => s.url));
  check('P4 a POST with an empty body, never cached', sent.init.method === 'POST' && sent.init.body === '{}' && sent.init.cache === 'no-store', sent.init);
  check('P4 carrying only the publishable key',
    sent.init.headers.apikey === 'publishable-test-key' && sent.init.headers.Authorization === 'Bearer publishable-test-key' &&
    Object.keys(sent.init.headers).sort().join() === 'Authorization,Content-Type,apikey', sent.init.headers);
  check('P4 the block reads no storage, cookie or session',
    !/localStorage|sessionStorage|CT\.auth|document\.cookie|credentials/.test(BLOCK));
}

{
  const off = await stateFor(json({ open: true, places_left: 63 }), BEFORE, { isConfigured: false, supabaseUrl: '', supabaseAnonKey: '' });
  check('P5 with no project configured, nothing is asked and nothing is known', off.seen.length === 0 && off.state === 'unknown');
}

{
  const { ctx } = sandbox(json(null));
  check('P6 OFFER_CLOSES for the header button (identity-bridge.js) is written as the same instant as FOUNDATION_CLOSES',
    (fs.readFileSync(path.join(ROOT, 'app', 'identity-bridge.js'), 'utf8')
      .match(/var OFFER_CLOSES = Date\.UTC\(([^)]*)\);/g) || []).join('|') === 'var OFFER_CLOSES = Date.UTC(2027, 0, 1, 12, 0);');
  check('P6 FOUNDATION_CLOSES is the end of 31 December 2026 in the last time zone, 2027-01-01T12:00Z',
    ctx.FOUNDATION_CLOSES === CLOSES && ctx.FOUNDATION_CLOSES === at('2027-01-01T12:00:00Z'), ctx.FOUNDATION_CLOSES);
  for (const [name, html] of Object.entries(PAGES)) {
    const written = (html.match(/var FOUNDATION_CLOSES = Date\.UTC\(([^)]*)\);/g) || []);
    check('P6 ' + name + ' writes that instant once, as Date.UTC(2027, 0, 1, 12, 0)',
      written.length === 1 && written[0] === 'var FOUNDATION_CLOSES = Date.UTC(2027, 0, 1, 12, 0);' &&
      Date.UTC(2027, 0, 1, 12, 0) === CLOSES, written);
    check('P6 ' + name + ' has no script date on the Adelaide-midnight close',
      !/Date\.UTC\(2026, 11, 31, 13, 30\)/.test(html) && Date.UTC(2026, 11, 31, 13, 30) === ADELAIDE_CLOSE);
    check('P6 ' + name + ' has no script date on the old close, 6 Dec 2026 00:00 +10:30',
      !/Date\.UTC\(2026, 11, 5, 13, 30\)/.test(html) && Date.UTC(2026, 11, 5, 13, 30) === OLD_CLOSE);
  }
  check('P6 the offer panel on pricing.html comes down on the same instant',
    /function renderOfferDates\(\) \{\s*var dates = \$\('offerDates'\);\s*if \(dates\) dates\.hidden = Date\.now\(\) >= FOUNDATION_CLOSES;\s*\/\/[^\n]*\n\s*var sentence = \$\('offerSentence'\);\s*if \(sentence\) sentence\.hidden = Date\.now\(\) >= FOUNDATION_CLOSES;\s*\}/.test(PRICING));
}

{
  /* P6b. The pie on foundation.html, run for real with the clock held.
     It empties across the offer, the start of 22 November to the end of
     31 December 2026 in the last time zone, and the hook and its
     condition come down when the offer is over. */
  const pieScript = [...FOUNDATION.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((js) => js.includes("getElementById('launchPie')")) || '';
  const pieAt = (now) => {
    const el = () => ({ hidden: false, textContent: '', d: null, setAttribute(k, v) { this[k] = v; } });
    const els = { launchPie: el(), launchCaption: el(), launchHook: el(), launchTerms: el() };
    const ctx = {
      document: { getElementById: (id) => els[id] || null },
      setInterval: () => 0,
      Date: { now: () => now, UTC: Date.UTC },
    };
    vm.createContext(ctx);
    vm.runInContext(pieScript, ctx, { filename: 'foundation-pie.js' });
    return { caption: els.launchCaption.textContent, d: els.launchPie.d, hook: !els.launchHook.hidden, terms: !els.launchTerms.hidden };
  };
  check('P6b foundation.html has the pie script', pieScript !== '');
  const starts = (pieScript.match(/var START = Date\.UTC\(([^)]*)\);/) || [])[1];
  const ends = (pieScript.match(/var END = Date\.UTC\(([^)]*)\);/) || [])[1];
  check('P6b the pie runs from 22 Nov 2026 00:00 +10:30', starts === '2026, 10, 21, 13, 30' && Date.UTC(2026, 10, 21, 13, 30) === OPENS, starts);
  check('P6b ...to 1 Jan 2027 12:00 UTC, the end of 31 December in the last time zone', ends === '2027, 0, 1, 12, 0' && Date.UTC(2027, 0, 1, 12, 0) === CLOSES, ends);

  const first = pieAt(OPENS);
  check('P6b at the start: a full pie and 41 days left (40 days and 22.5 hours)', first.caption === '41 days left in the offer.' && /^M 0 -37 A 37 37 0 1 1 0 37 A/.test(first.d) && first.hook && first.terms, first);
  const half = pieAt((OPENS + CLOSES) / 2);
  check('P6b halfway: half a pie and 21 days left', half.caption === '21 days left in the offer.' && half.d === 'M 0 0 L 0.000 37.000 A 37 37 0 0 1 0 -37 Z', half);
  const oldClose = pieAt(OLD_CLOSE);
  check('P6b at the old close, the start of 6 December, the offer is still running: 27 days left, hook showing',
    oldClose.caption === '27 days left in the offer.' && oldClose.hook && oldClose.terms && oldClose.d !== '', oldClose);
  const adelaideMidnight = pieAt(ADELAIDE_CLOSE);
  check('P6b at Adelaide midnight on New Year the offer is still running, on its last day',
    adelaideMidnight.caption === 'Last day of the offer.' && adelaideMidnight.hook && adelaideMidnight.terms && adelaideMidnight.d !== '', adelaideMidnight);
  const lastDay = pieAt(CLOSES - 3600000);
  check('P6b on 31 December: the last day, hook still showing', lastDay.caption === 'Last day of the offer.' && lastDay.hook && lastDay.terms, lastDay);
  const over = pieAt(CLOSES);
  check('P6b at the closing instant: no pie, the hook and its condition come down',
    over.caption === 'The offer is over. It ran to the end of 31 December 2026.' && over.d === '' && !over.hook && !over.terms, over);
  check('P6b before the start it says when it starts', pieAt(OPENS - 1000).caption === 'The offer starts on 22 November 2026.');
}

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const uncommented = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const [name, html] of Object.entries(PAGES)) {
  const head = scripts(html)[0] || '';
  const flag = head.indexOf('window.CT.inPlayApp = true;');
  const bounce = head.indexOf("location.replace('index.html#in-app')");
  check('P7 ' + name + ': the head script marks a Play visit before sending it back', flag >= 0 && bounce > flag, { flag, bounce });
  check('P7 ' + name + ': the head script comes before anything is drawn', html.indexOf('<script>') < html.indexOf('<body'));

  const carrier = scripts(html).find((js) => js.includes('foundation-status:begin')) || '';
  const guard = name === 'pricing.html' ? 'if (CT.inPlayApp) return;' : 'if (window.CT && window.CT.inPlayApp) return;';
  const iGuard = carrier.indexOf(guard);
  check('P7 ' + name + ': the Play check comes before the status block', iGuard >= 0 && iGuard < carrier.indexOf('foundation-status:begin'));
  check('P7 ' + name + ': nothing is fetched before the Play check', iGuard >= 0 && !/fetch\(/.test(uncommented(carrier.slice(0, iGuard))));

  check('P9 ' + name + ' can say Foundation is full', html.includes('Foundation is full.'));
  check('P9 ' + name + ' can say Foundation has closed', html.includes('Foundation has closed.'));
  check('P9 ' + name + ' never builds markup from a string', !html.includes('innerHTML') && !html.includes('insertAdjacentHTML') && !html.includes('document.write'));
  check('P9 ' + name + ': no dash punctuation in what the script says', carrier !== '' && !/[–—]/.test(uncommented(carrier)));

  // Default-deny: the number is only ever written in the open branch.
  const outside = uncommented(carrier.slice(carrier.indexOf('foundation-status:end')));
  const uses = outside.split('\n').filter((l) => l.includes('s.left'));
  check('P11 ' + name + ': the count is written in one place, the open branch', uses.length === 1, uses);
  const openAt = outside.indexOf("if (state === 'open') {");
  const fullAt = outside.indexOf("} else if (state === 'full') {");
  const usedAt = outside.indexOf('s.left');
  check('P11 ' + name + ': ...and nowhere else', openAt >= 0 && usedAt > openAt && usedAt < fullAt, { openAt, usedAt, fullAt });

  check('P12 ' + name + ': no promise of a place and no request for a rating',
    !/guaranteed|reserve your place|your place is reserved|rate us|leave a review|5 stars|five stars/i.test(html));
}

{
  const firstFoundationScript = uncommented(scripts(FOUNDATION).find((js) => js.includes('foundation-status:begin')) || '');
  check('P7 foundation.html: the status script begins with the Play check',
    /^\s*\(function \(\) \{\s*if \(window\.CT && window\.CT\.inPlayApp\) return;/.test(firstFoundationScript));
}

for (const file of ['app/index.html', 'app/app.js', 'app/billing.js']) {
  check('P8 ' + file + ' never asks for the Foundation count', !read(file).includes('foundation_status'));
}

{
  const assigned = PRICING.match(/^.*\.disabled\s*=.*$/gm) || [];
  check('P10 no Foundation state disables a plan button',
    assigned.length === 2 &&
    assigned.some((l) => l.trim() === "$('buyAnnual').disabled = !billingOn;") &&
    assigned.some((l) => l.trim() === "$('buyMonthly').disabled = !billingOn;") &&
    !/setAttribute\('disabled'/.test(PRICING), assigned);
}

/* The wording rules. "Pay nothing until 2027" is only true with its
   condition, so wherever a page says it, the condition follows in the
   same sentence or the next. Tags and line breaks are taken out first. */
const visible = (html) => squash(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
for (const [name, html] of Object.entries(PAGES)) {
  const text = visible(html);
  const hooks = [...text.matchAll(/pay nothing until 2027/gi)];
  check('P13 ' + name + ' carries the hook', hooks.length >= 1);
  check('P13 ' + name + ': the hook is always followed by its condition',
    hooks.every((m) => /^\W{0,3}subscribe while your free trial is running and your first payment is taken from 1 January 2027\./i.test(text.slice(m.index + m[0].length))),
    hooks.map((m) => text.slice(m.index, m.index + 120)));
  check('P13 ' + name + ' names the offer', text.includes('Black Friday Launch Offer'));
  const metas = [...html.matchAll(/<meta name="description" content="([^"]*)"/g)].map((m) => m[1]);
  /* Nothing can take a description down when the offer ends, so it
     carries no offer and no date (P21). The hook is not in it. */
  check('P13 ' + name + ': there is one description, and the hook is not in it',
    metas.length === 1 && metas.every((m) => m.length > 40 && !/pay nothing/i.test(m)), metas);
  check('P13 ' + name + ': the first payment is "from" 1 January 2027, never "on"',
    !/\bon 1 January 2027/i.test(text) && metas.every((m) => !/\bon 1 January 2027/i.test(m)));
}

/* What a reader sees, with the tags inside a sentence taken out first so
   a bolded phrase does not leave a space before the full stop. */
const reading = (html) => visible(html.replace(/<\/?(?:strong|em|b|span|a)\b[^>]*>/g, ''));
const TERMS = read('app/terms.html');
const OFFER_PAGES = { 'pricing.html': PRICING, 'foundation.html': FOUNDATION, 'terms.html': TERMS };

/* P17. The hook has no subscribe-by date any more (Mal, 22 Nov 2026).
   "Subscribe by 5 December" must not come back on any page, in the
   text, the description or anything a script writes. */
for (const [name, html] of Object.entries(OFFER_PAGES)) {
  const everything = squash(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/&nbsp;/g, ' ').replace(/<\/?(?:strong|em|b|span|a)\b[^>]*>/g, '')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  check('P17 ' + name + ': the words "subscribe by 5 December" are nowhere', !/subscribe\s+by\s+(the\s+end\s+of\s+)?5\s+Dec/i.test(everything));
  check('P17 ' + name + ': nothing is conditional on subscribing by, before or after 5 December',
    !/(subscrib\w*|buy\w*|sign\w* up) (by|before|until|after|on or before) (the end of )?5 Dec/i.test(everything) && !/after 5 December/i.test(everything));
  const text = reading(html);
  for (const m of text.matchAll(/pay nothing until 2027/gi)) {
    const next = text.slice(m.index, m.index + 260);
    check('P17 ' + name + ': no 5 December beside the hook', !/5 December/.test(next), next);
  }
  check('P17 ' + name + ': the offer and Foundation never close on 5 December',
    !/(offer|Foundation)[^.]{0,80}(clos\w+|runs?|ran|ends?)[^.]{0,60}5 December/i.test(everything), everything.match(/(offer|Foundation)[^.]{0,80}(clos\w+|runs?|ran|ends?)[^.]{0,60}5 December/i));
}

/* P18. The one thing that still ends at the end of 5 December: the free
   trial of an account made before 22 November. Said once on each offer
   page, as a statement about that trial and nothing else. */
const OLDER_ACCOUNTS = /If you made your account before 22 November 2026, your free trial runs to the end of 5 December 2026, even if an earlier trial had (already )?ended./;
for (const [name, html] of Object.entries(PAGES)) {
  const text = reading(html);
  check('P18 ' + name + ' keeps the sentence about older accounts\' trials', OLDER_ACCOUNTS.test(text));
  check('P18 ' + name + ': that sentence is the only place 5 December appears', (text.match(/5 December/g) || []).length === 1, text.match(/.{60}5 December.{30}/g));
  const said = scripts(html).map(uncommented).join('\n');
  check('P18 ' + name + ': no script says 5 December', !/5 Dec/.test(said));
}
check('P18 terms.html does not mention 5 December at all', !/5 Dec/.test(reading(TERMS)));

/* P19a. The owner, 22 Nov 2026: the offer's dates carry no time zone.
   They are true on every customer's own calendar because each instant
   is the end of that day in the last time zone on Earth. */
for (const [name, html] of Object.entries({ 'pricing.html': PRICING, 'foundation.html': FOUNDATION, 'terms.html': TERMS })) {
  check('P19a ' + name + ': no offer date says "Adelaide time", in the text or the scripts',
    !/\(Adelaide time\)|Adelaide time\)/.test(uncommentedPage(html)), (uncommentedPage(html).match(/.{50}Adelaide time.{10}/g)));
}
/* P19. The free-time rule, in the owner's words, on both offer pages. */
/* The owner's sentence (Mal, 22 Nov 2026), kept whole so the date can
   never be read without its condition: it is for someone who subscribes
   while their free trial is running, and for nobody else. */
const OWNER_SENTENCE = 'During the Black Friday Launch Offer, first payments will not be charged before 1 January 2027 if you subscribe while your free 14-day trial is running.';
const FREE_TIME = 'Every new account starts with a 14-day free trial. Subscribe while the free trial is running and you get more free time before your first payment: on a yearly plan you will get your first 30 days free from the day you started your AibhlínnAI account, or 21 days for a monthly plan. ' + OWNER_SENTENCE;
const AFTER_TRIAL = 'If you subscribe after your trial has ended, you pay on the day you subscribe.';
/* The paragraph the owner rejected on 22 Nov 2026 ("I don't like this
   at all, just make sure we get the date right"). It told customers
   that checkout might show an earlier first-payment date and that we
   would move it afterwards. Checkout now shows the right day itself
   (create-checkout, part C), so the paragraph is off all three pages
   and nothing replaces it. None of its three sentences may come back,
   in the text or in anything a script writes. */
const REJECTED = /Checkout may show|We move it to the right one|write to us before paying/i;
const FOUNDATION_CLOSING = 'Foundation closes at the end of 31 December 2026, or sooner if all 100 places are taken.';
for (const [name, html] of Object.entries(PAGES)) {
  const text = reading(html);
  check('P19 ' + name + ' states the free-time rule', text.includes(FREE_TIME), text.match(/Every new account.{0,300}/));
  check('P19 ' + name + ': ...and straight after it, what happens once the trial has ended', text.includes(FREE_TIME + ' ' + AFTER_TRIAL));
  check('P19 ' + name + ': the rejected paragraph about checkout showing an earlier date is gone, from the text and the scripts',
    !REJECTED.test(text) && !REJECTED.test(squash(uncommentedPage(html))), text.match(/.{0,60}(Checkout may show|We move it|write to us before).{0,60}/i));
  check('P19 ' + name + ': nothing has taken its place: no page says a date is moved, corrected or may look wrong',
    !/first-payment date|date (is|will be) (moved|corrected|changed|adjusted)|looks wrong|shortly after you subscribe/i.test(text), text.match(/.{0,60}(first-payment date|looks wrong|shortly after you subscribe).{0,60}/i));
  check('P19 ' + name + ': the old "a different first-payment date" wording is gone', !/a different first-payment date|We set it to the right one/i.test(text));
  check('P19 ' + name + ' says when Foundation closes', text.includes(FOUNDATION_CLOSING));
  check('P19 ' + name + ': the old rule is gone', !/30 days after (you|the day you) (made|signed)|whichever plan you pick|Premium stays free until 31 December/i.test(text));
  const carrier = scripts(html).find((js) => js.includes('foundation-status:begin')) || '';
  check('P19 ' + name + ': what the script says about the close is the end of 31 December 2026',
    uncommented(carrier).includes('Foundation has closed. It ran to the end of 31 December 2026.'));
}
check('P19 pricing.html: what happens after the trial is followed directly by "The trial needs no card"',
  reading(PRICING).includes(AFTER_TRIAL + ' The trial needs no card, and nothing is charged until you choose a plan above. If you made your account before 22 November 2026,'));
check('P19 foundation.html: the section about the first payment ends on the older accounts\' sentence, with no paragraph after it',
  /even if an earlier trial had already\s+ended\.<\/p>\s*<h2>Everything else<\/h2>/.test(FOUNDATION));
check('P19 app/README.md does not carry the rejected wording either, and says checkout shows the day itself',
  !REJECTED.test(squash(read('app/README.md'))) && !/moved to the right one/i.test(squash(read('app/README.md'))) &&
  squash(read('app/README.md')).includes('Checkout is given the right number of free days for the account (`create-checkout`), so it shows the first-payment day itself'));
check('P19 pricing.html: the line it writes when the count cannot be read says the same close',
  PRICING.includes("setFoundationLine('Foundation has 100 places. " + FOUNDATION_CLOSING + ' We could not check how many places are left just now.\');'));
check('P19 pricing.html: the open line asks for a subscription by the end of 31 December 2026',
  PRICING.includes("' of 100 places left. Subscribe by the end of 31 December 2026 while a place is left and you keep the price you subscribe at."));
check('P19 foundation.html: who can join is the first 100 subscribers before the end of 31 December 2026',
  reading(FOUNDATION).includes("AibhlínnAI's first 100 subscribers before the end of 31 December 2026."));
check('P19 foundation.html: the card says how long the offer runs',
  /<p class="launch-caption" id="launchCaption">The offer runs to the end of 31 December 2026\.<\/p>/.test(FOUNDATION));
check('P19 pricing.html: the panel says how long the offer runs',
  reading(PRICING).includes('Pay nothing until 2027 Subscribe while your free trial is running and your first payment is taken from 1 January 2027. The offer runs to the end of 31 December 2026.'));

{
  const line = (PRICING.match(/<p class="hint" id="foundationLine"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
  check('P14 pricing.html: the Foundation line is a status region', /id="foundationLine" role="status" aria-live="polite"/.test(PRICING));
  check('P14 ...its fallback text states the rule and offers nothing', line.includes('Foundation has 100 places') && !/places left|Pay nothing/i.test(line), line);
  const carrier = scripts(PRICING).find((js) => js.includes('foundation-status:begin')) || '';
  const said = uncommented(carrier).split('\n').filter((l) => l.includes("setFoundationLine('")).join('\n');
  check('P14 ...no price figure goes in it, by markup or by script', !/A\$|\$\d/.test(line) && said !== '' && !/A\$|\$\d/.test(said));
  check('P14 ...and the hook stays outside it', !/Pay nothing/i.test(said));

  check('P15 foundation.html: the places line starts hidden and is a status region',
    /<p id="foundationState" role="status" aria-live="polite" hidden><\/p>/.test(FOUNDATION));
  check('P15 foundation.html is no longer kept out of search', !/name="robots"/.test(FOUNDATION));
  check('P15 foundation.html no longer calls itself an unlinked draft', !/not linked from any page/i.test(FOUNDATION) && /Not yet reviewed by a lawyer/.test(FOUNDATION));
  const terms = read('app/terms.html');
  /* terms.html has no date check, so this sentence dates itself: it
     opens with the day the offer ends and stays true after it. Nobody
     has to take it out on 1 January 2027. */
  check('P16 terms.html names the offer in a sentence that dates itself, with its condition, hidden in the Play app',
    /<span data-hide-in-play>Until the end of 31 December 2026 the Black Friday Launch Offer applies: subscribe while your free trial is running and your first payment is taken from <strong>1 January 2027<\/strong>\.<\/span>/.test(squash(terms)));
  check('P16 ...and never as "the offer running now"', !/offer running now|running now|on now\b/i.test(reading(terms)));
  const termsText = reading(terms);
  check('P16 terms.html says the offer sets a date no first payment is taken before, not one date for everyone',
    termsText.includes('During a launch or promotional period, if you subscribe while your trial is running, no first payment is taken before a date announced with that offer. If your own 30 or 21 days end later than that date, they still apply.') &&
    !/may instead fall|the same date for everyone/i.test(termsText));
  check('P16 ...and that subscribing during the trial never shortens the trial\'s own free time',
    termsText.includes('Either way, subscribing during your trial never shortens the free time your trial gave you.') &&
    !/subscribing early never costs/i.test(termsText));
  check('P19 terms.html: the rejected paragraph about checkout showing an earlier date is gone, from the text and the scripts',
    !REJECTED.test(termsText) && !REJECTED.test(squash(uncommentedPage(terms))) &&
    !/We move that date back|earlier first-payment date than|a different first-payment date|We set it to the right one|first-payment date|looks wrong/i.test(termsText),
    termsText.match(/.{0,60}(Checkout may show|We move it|write to us before|first-payment date).{0,60}/i));
  /* Section 5 had two parts hidden in the Play app: the dated offer
     sentence and that paragraph. Only the sentence is left. */
  const sectionFive = (terms.match(/<h2>5\. [\s\S]*?(?=<h2>)/) || [''])[0].replace(/<!--[\s\S]*?-->/g, '');
  const hiddenInPlay = sectionFive.match(/<\w+ data-hide-in-play>/g) || [];
  check('P19 terms.html section 5 hides one thing in the Play app now, the dated offer sentence',
    sectionFive !== '' && hiddenInPlay.length === 1 && hiddenInPlay[0] === '<span data-hide-in-play>' &&
    /<span data-hide-in-play>Until the end of 31 December 2026/.test(squash(sectionFive)), hiddenInPlay);
  check('P19 terms.html: the paragraph after the offer sentence is the one about who the purchase is made from',
    /you pay on the day you\s+subscribe\.<\/p>\s*<p><strong>Purchases are made from Paddle, not from us\.<\/strong>/.test(terms.replace(/<!--[\s\S]*?-->\s*/g, '')));
  check('P16 terms.html states the standing rule: 30 days yearly, 21 days monthly, from the day the account was made',
    termsText.includes('If you subscribe while your trial is still running, your first payment is not taken on the day you subscribe. As standard the charge falls 30 days after the day you made your account on a yearly plan, or 21 days on a monthly plan.'));
  check('P16 ...and that a subscription made after the trial has ended is paid on the day',
    termsText.includes('If you subscribe after your trial has ended, you pay on the day you subscribe.'));
  /* What a Play reader is left with once the marked parts are hidden:
     the terms, and no dated invitation to subscribe. */
  const inPlay = reading(terms.replace(/<(span|p) data-hide-in-play>[\s\S]*?<\/\1>/g, ' '));
  check('P16 ...the rule stays visible in the Play app, the offer and its date do not',
    inPlay.includes('or 21 days on a monthly plan.') && inPlay.includes('you pay on the day you subscribe.') &&
    !/2027|Black Friday|Launch Offer|Pay nothing/i.test(inPlay), inPlay.match(/.{40}(2027|Black Friday|Launch Offer).{40}/));
}

/* P20. The owner's sentence, whole, on every page that used to say "No
   first payment is taken before 1 January 2027." on its own. That
   sentence read as a promise to everyone. The rule is only for someone
   who subscribes while their free trial is running: someone whose trial
   has ended pays on the day they subscribe, before 2027 or after it. */
const sentences = (text) => text.split(/(?<=[.!?])\s+/);
for (const [name, html] of Object.entries(PAGES)) {
  const text = reading(html);
  check('P20 ' + name + ' carries the owner\'s sentence whole', text.includes(OWNER_SENTENCE), text.match(/.{0,80}1 January 2027.{0,80}/g));
  check('P20 ' + name + ': and straight after it, that a lapsed trial pays on the day', text.includes(OWNER_SENTENCE + ' ' + AFTER_TRIAL));
}
for (const [name, html] of Object.entries(OFFER_PAGES)) {
  const text = reading(html);
  const everything = squash(html.replace(/&nbsp;/g, ' ').replace(/<\/?(?:strong|em|b|span|a)\b[^>]*>/g, ''));
  check('P20 ' + name + ': the standalone sentence is gone, from the text, the description and the scripts',
    !/No first payment is taken before 1 January 2027/i.test(everything));
  const about2027 = sentences(text).filter((t) => /before 1 January 2027|before 2027/i.test(t));
  check('P20 ' + name + ': every sentence that says "before 1 January 2027" carries its condition in the same sentence',
    about2027.every((t) => t.endsWith('not be charged before 1 January 2027 if you subscribe while your free 14-day trial is running.')), about2027);
  /* The same promise with no date in it ("before a date announced with
     that offer") must carry its condition too, or it reads as a promise
     to everyone. */
  const notBefore = sentences(text).filter((t) => /no first payment is taken before/i.test(t));
  check('P20 ' + name + ': any sentence that says "no first payment is taken before" says "while your trial" in the same sentence',
    notBefore.every((t) => /while your (free )?(14-day )?trial/i.test(t)), notBefore);
  check('P20 ' + name + ' says a subscription made after the trial has ended is paid on the day', text.includes(AFTER_TRIAL));
  check('P20 ' + name + ': and puts no date on that', !/From 1 January 2027, if you subscribe|until 2027, if you subscribe after/i.test(everything) &&
    sentences(text).filter((t) => /after your trial has ended/i.test(t)).every((t) => !/20\d\d/.test(t)), sentences(text).filter((t) => /after your trial has ended/i.test(t)));
}

/* P21. Nothing on these pages needs a person on 1 January 2027 (Mal,
   22 Nov 2026: "I'm not sure how available I will be"). Every mention
   of the offer is either inside something a script takes down at the
   closing instant, or is written so it stays true after it. */
for (const [name, html] of Object.entries(OFFER_PAGES)) {
  /* A description, a title or a link preview cannot be taken down by a
     script, so none of them carries the offer or a date. */
  const head = html.slice(0, html.indexOf('</head>'));
  const metaContent = [...head.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"/g)].map((m) => m[1]);
  const title = (head.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  check('P21 ' + name + ': the description and the title carry no offer, no hook and no date',
    title !== '' && [title, ...metaContent].every((t) => !/Black Friday|Launch Offer|pay nothing|20\d\d|31 December|1 January|places/i.test(t)), [title, ...metaContent]);
  check('P21 ' + name + ': nothing is described as on "now"', !/\b(running now|on now|right now|currently|this month|ends soon|closing soon|today only|last chance)\b/i.test(reading(html)));
  /* Every sentence a reader can see that names the offer, the hook or a
     closing says which day it ends, or sits right beside one that does. */
  /* The owner's sentence in #offerSentence names the offer without its
     closing day. Each page's script hides that span at the close (checked
     below), so it is left out here. */
  const text = reading(html.replace(/<span id="offerSentence">[\s\S]*?<\/span>/, ' '));
  for (const m of text.matchAll(/Black Friday Launch Offer|Pay nothing until 2027|Foundation closes/g)) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + 330);
    check('P21 ' + name + ': "' + m[0] + '" is dated to 31 December 2026 where it stands', /31 December 2026/.test(around), around);
  }
}
{
  /* pricing.html: the offer's name, hook and condition are all inside
     #offerDates, which renderOfferDates() hides at FOUNDATION_CLOSES (P6). */
  const panel = PRICING.match(/<div class="offer-dates" id="offerDates">[\s\S]*?<\/div>/);
  const without = panel ? reading(PRICING.replace(panel[0], ' ').replace(/<span id="offerSentence">[\s\S]*?<\/span>/, ' ')) : '';
  check('P21 pricing.html: the owner\'s sentence sits in #offerSentence, which the same script hides at the close',
    /<span id="offerSentence">[\s\S]*?<\/span>/.test(PRICING) && reading((PRICING.match(/<span id="offerSentence">[\s\S]*?<\/span>/) || [''])[0]) === OWNER_SENTENCE);
  check('P21 pricing.html: outside the part its script takes down, nothing names the offer or the hook',
    Boolean(panel) && /Black Friday Launch Offer/.test(panel[0]) && /Pay nothing until 2027/.test(panel[0]) &&
    !/Black Friday|Launch Offer|Pay nothing/i.test(without), without.match(/.{40}(Black Friday|Launch Offer|Pay nothing).{40}/i));
  check('P21 pricing.html: ...and what is left about the first payment is the standing rule', without.includes('or 21 days for a monthly plan. ' + AFTER_TRIAL), without.match(/.{60}If you subscribe after.{40}/));

  /* foundation.html: the pie script hides the hook and its condition at
     END and rewrites the caption to say the offer is over (P6b). The
     card keeps its name, with that caption under it. */
  const stripped = FOUNDATION.replace(/<p class="launch-hook" id="launchHook">[\s\S]*?<\/p>/, ' ').replace(/<p class="launch-terms" id="launchTerms">[\s\S]*?<\/p>/, ' ').replace(/<span id="offerSentence">[\s\S]*?<\/span>/, ' ');
  check('P21 foundation.html: the owner\'s sentence sits in #offerSentence, which the pie script hides at END',
    reading((FOUNDATION.match(/<span id="offerSentence">[\s\S]*?<\/span>/) || [''])[0]) === OWNER_SENTENCE &&
    /var sentence = document\.getElementById\('offerSentence'\);\s*if \(sentence\) sentence\.hidden = now >= END;/.test(FOUNDATION));
  const left = reading(stripped);
  check('P21 foundation.html: outside the two lines its script takes down, the hook is nowhere',
    stripped !== FOUNDATION && !/Pay nothing/i.test(left), left.match(/.{40}Pay nothing.{40}/i));
  check('P21 foundation.html: the offer is named once more, as the card\'s name, straight above the caption the script rewrites',
    (left.match(/Black Friday Launch Offer/g) || []).length === 1 &&
    /<h2 class="launch-name">Black Friday Launch Offer<\/h2>[\s\S]*?<p class="launch-caption" id="launchCaption">The offer runs to the end of 31 December 2026\.<\/p>\s*<\/div>/.test(FOUNDATION));

  /* terms.html: no script, so the one sentence dates itself (P16). */
  const termsLeft = reading(TERMS);
  check('P21 terms.html names the offer once, in the sentence that opens with its closing day',
    (termsLeft.match(/Black Friday|Launch Offer/g) || []).length === 2 &&
    termsLeft.includes('Until the end of 31 December 2026 the Black Friday Launch Offer applies: subscribe while your free trial is running and your first payment is taken from 1 January 2027.'));
  check('P21 terms.html has no script that would need a date, and none is needed',
    !/Date\.(UTC|now|parse)/.test(scripts(TERMS).join('\n')));

  const claude = read('CLAUDE.md');
  check('P21 CLAUDE.md lists nothing to take out by hand on 1 January 2027',
    !/come out by hand|Take that span out|remove[^.]{0,60}by hand on 1 January 2027/i.test(squash(claude)) &&
    squash(claude).includes('Nothing in this repo has to be taken down by hand on 1 January 2027'));
}

{
  /* P22. How checkout opens, with billing.js and config.js run for real
     in a sandbox, and Paddle's script, the entitlement lookup and the
     create-checkout function all stubbed.

     There are two paths and only two. An account whose OWN free trial is
     running asks create-checkout for a transaction and opens Paddle with
     its id: the free period was decided on the server, so nothing the
     browser holds can lengthen it. Any other account that may buy opens
     the plain catalogue price and pays on the day, in December 2026 as
     at any other time: billing.js holds no date at all. Neither retired
     catalogue trial price is ever opened.

     When create-checkout fails, checkout does not open. It never falls
     back to a catalogue price: the old trial price would bring back a
     checkout that shows one date and bills on another, and the plain
     price would charge today someone who owes nothing yet. */
  const billingSource = read('app/billing.js');
  const configSource = read('app/config.js');
  const CHECKOUT_TXN = 'txn_01test0from0create0checkout';
  const goodAnswer = () => ({ status: 200, body: JSON.stringify({ ok: true, transactionId: CHECKOUT_TXN, trialDays: 38, firstPaymentFrom: '2027-01-01T12:00:00.000Z' }) });
  const says = (status, error) => () => ({ status, body: JSON.stringify({ ok: false, error }) });
  const everythingOpened = [];
  /* One press of Buy. `o.answer` plays create-checkout: a function
     returning {status, body}, 'hang' for a request that never answers,
     or one that throws. Answers what was asked of create-checkout, what
     Paddle was told to open, and what the page was told. */
  async function buy(row, cadence, o = {}) {
    const opened = [];
    const asked = [];
    const initialized = [];
    let lookups = 0;
    const ctx = {
      console: { warn() {}, log() {}, error() {} },
      /* The 15-second wait is shortened, never removed, so the case
         with a request that never answers really is stopped. Paddle's
         two re-reads after a purchase are left unscheduled. */
      setTimeout: (fn, ms) => (ms === 15000 ? setTimeout(fn, 5) : 0),
      clearTimeout: (t) => clearTimeout(t),
      AbortController: o.noAbortController ? undefined : AbortController,
      navigator: { userAgent: o.userAgent || 'Mozilla/5.0' },
      location: { hash: o.hash || '' },
      sessionStorage: { getItem: () => o.stored || null },
      document: {
        referrer: o.referrer || '',
        createElement: () => ({}),
        getElementById: () => null,
        head: { appendChild(tag) {
          if (o.paddleWillNotLoad) { tag.onerror(); return; }
          ctx.Paddle = { Environment: { set() {} }, Initialize: (i) => initialized.push(i), Checkout: { open: (x) => opened.push(x) } };
          tag.onload();
        } },
      },
      fetch: (url, init) => {
        asked.push({ url, init });
        return new Promise((resolve, reject) => {
          if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          let a;
          try { a = (o.answer || goodAnswer)(init); } catch (e) { reject(e); return; }
          if (a === 'hang') return;
          resolve({
            ok: a.status >= 200 && a.status < 300,
            status: a.status,
            json: () => new Promise((res) => res(JSON.parse(a.body))),
          });
        });
      },
    };
    if (o.digitalGoods) ctx.getDigitalGoodsService = () => {};
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(configSource, ctx, { filename: 'config.js' });
    if (o.inPlayApp) ctx.CT.inPlayApp = true;
    ctx.CT.auth = {
      isSignedIn: () => true,
      getUser: () => ({ id: USER_ID, email: USER_EMAIL }),
      validToken: o.validToken || (async () => 'the-users-own-session-token'),
    };
    ctx.CT.db = { getEntitlement: async () => { lookups++; return row; } };
    vm.runInContext(billingSource, ctx, { filename: 'billing.js' });
    let refused = null;
    try { await ctx.CT.billing.openCheckout(cadence, o.code === undefined ? '' : o.code); } catch (error) { refused = String(error && error.message); }
    everythingOpened.push(...opened);
    return {
      opened, asked, initialized, lookups, refused,
      priceId: opened.length === 1 && opened[0].items ? opened[0].items[0].priceId : null,
      paddle: ctx.CT.config.paddle, supabaseUrl: ctx.CT.config.supabaseUrl, anonKey: ctx.CT.config.supabaseAnonKey,
    };
  }
  const IN_TRIAL = { entitled: true, plan: 'trial', status: 'trialing' };
  const TRY_AGAIN = 'Could not open checkout. Please try again.';
  const NOT_CHECKED = 'We could not check your account just now. Please try again.';
  const SIGN_IN = 'Please sign in first.';
  const NO_SUCH_CODE = 'Discount code not recognised.';

  const probe = await buy(IN_TRIAL, 'annual');
  const P = probe.paddle;
  check('P22 config.js has four different price ids: two plain ones in use, two retired ones kept for an older cached billing.js',
    new Set([P.annualPriceId, P.monthlyPriceId, P.annualTrialPriceId, P.monthlyTrialPriceId].filter(Boolean)).size === 4);

  /* A free trial that is running: the server makes the transaction. */
  for (const cadence of ['monthly', 'annual']) {
    const T = 'P22 a trial that is running, choosing ' + cadence + ': ';
    const got = await buy(IN_TRIAL, cadence);
    const sent = got.asked[0] || { init: { headers: {} } };
    check(T + 'one request, to create-checkout', got.asked.length === 1 && sent.url === got.supabaseUrl + '/functions/v1/create-checkout' && sent.init.method === 'POST', got.asked.map((x) => x.url));
    check(T + 'carrying the publishable key and the user\'s own session token, and nothing else',
      same(sent.init.headers, { apikey: got.anonKey, Authorization: 'Bearer the-users-own-session-token', 'Content-Type': 'application/json' }), sent.init.headers);
    check(T + 'the body names the plan and nothing else: no account, no price, no date, no day count',
      sent.init.body === JSON.stringify({ cadence }), sent.init.body);
    check(T + 'Paddle is then opened on the transaction the server made, with the email to fill in',
      got.refused === null && got.opened.length === 1 && same(got.opened[0], { transactionId: CHECKOUT_TXN, customer: { email: USER_EMAIL } }), got.opened);
    check(T + 'with NO items, NO customData, NO discountCode and no settings of its own',
      got.opened.length === 1 && Object.keys(got.opened[0]).sort().join() === 'customer,transactionId', got.opened.map((x) => Object.keys(x)));
    check(T + 'the entitlement is read afresh first, once', got.lookups === 1, got.lookups);
    check(T + 'the request can be stopped: it carries an abort signal', Boolean(sent.init.signal), Object.keys(sent.init));
  }
  {
    const typed = await buy(IN_TRIAL, 'monthly', { code: '  EARLY10 ' });
    check('P22 a trial that is running, with a discount code typed: the code goes to the server with the plan, trimmed',
      typed.asked.length === 1 && typed.asked[0].init.body === JSON.stringify({ cadence: 'monthly', discountCode: 'EARLY10' }), typed.asked.map((x) => x.init.body));
    check('P22 ...and is NOT passed to Paddle beside the transaction: the server has already set it',
      typed.opened.length === 1 && same(typed.opened[0], { transactionId: CHECKOUT_TXN, customer: { email: USER_EMAIL } }), typed.opened);
    const blank = await buy(IN_TRIAL, 'monthly', { code: '   ' });
    check('P22 a code of nothing but spaces is no code', blank.asked[0].init.body === JSON.stringify({ cadence: 'monthly' }), blank.asked[0].init.body);
    const old = await buy(IN_TRIAL, 'monthly', { noAbortController: true });
    check('P22 a browser with no AbortController still asks and still opens', old.asked.length === 1 && !old.asked[0].init.signal && old.opened.length === 1, old);
  }
  check('P22 Paddle is set up with the look of the overlay, since a checkout opened on a transaction carries no settings of its own',
    probe.initialized.length === 1 && same(probe.initialized[0].checkout, { settings: { displayMode: 'overlay', theme: 'light' } }) &&
    probe.initialized[0].token === P.clientToken, probe.initialized.map((i) => Object.keys(i)));

  /* create-checkout fails. Checkout does not open at all, on any price. */
  const failures = {
    'answering 500': [says(500, 'error'), TRY_AGAIN],
    'answering 502, Paddle refused': [says(502, 'paddle'), TRY_AGAIN],
    'answering 503, the account could not be read': [says(503, 'account_unreadable'), TRY_AGAIN],
    'answering 503, not configured': [says(503, 'not_configured'), TRY_AGAIN],
    'answering 404, not deployed': [() => ({ status: 404, body: JSON.stringify({ message: 'Function not found' }) }), TRY_AGAIN],
    'answering 400': [says(400, 'bad_request'), TRY_AGAIN],
    'out of reach': [() => { throw new TypeError('Failed to fetch'); }, TRY_AGAIN],
    'never answering': [() => 'hang', TRY_AGAIN],
    'answering something that is not JSON': [() => ({ status: 200, body: '<html>gateway</html>' }), TRY_AGAIN],
    'answering 200 with ok false': [() => ({ status: 200, body: JSON.stringify({ ok: false, transactionId: CHECKOUT_TXN }) }), TRY_AGAIN],
    'answering 200 with no transaction id': [() => ({ status: 200, body: JSON.stringify({ ok: true, trialDays: 38 }) }), TRY_AGAIN],
    'answering 200 with an id that is not a transaction id': [() => ({ status: 200, body: JSON.stringify({ ok: true, transactionId: 'pri_01abc' }) }), TRY_AGAIN],
    'answering 200 with an id that has something after it': [() => ({ status: 200, body: JSON.stringify({ ok: true, transactionId: 'txn_01abc&x=1' }) }), TRY_AGAIN],
    'answering 200 with an id that is a number': [() => ({ status: 200, body: JSON.stringify({ ok: true, transactionId: 12345 }) }), TRY_AGAIN],
    'answering 200 with null': [() => ({ status: 200, body: 'null' }), TRY_AGAIN],
    'answering 201 with an id': [() => ({ status: 201, body: JSON.stringify({ ok: true, transactionId: CHECKOUT_TXN }) }), TRY_AGAIN],
    'answering 409 with a reason it does not know': [says(409, 'something_else'), TRY_AGAIN],
    'answering 409, the trial is not running': [says(409, 'not_in_trial'), NOT_CHECKED],
    'answering 409, already subscribed': [says(409, 'already_subscribed'), "You're already on AibhlínnAI Premium. Manage or cancel from the app's Settings."],
    'answering 422, the discount code was not found': [says(422, 'discount_not_found'), NO_SUCH_CODE],
    'answering 401': [says(401, 'not_signed_in'), SIGN_IN],
    'answering 401 from the gateway, not from the function': [() => ({ status: 401, body: JSON.stringify({ code: 401, message: 'Invalid JWT' }) }), SIGN_IN],
  };
  for (const [name, [answer, message]] of Object.entries(failures)) {
    for (const cadence of ['monthly', 'annual']) {
      const got = await buy(IN_TRIAL, cadence, { answer, code: 'EARLY10' });
      check('P22 a trial that is running, create-checkout ' + name + ' (' + cadence + '): checkout does not open at all, on any price',
        got.opened.length === 0 && got.asked.length === 1, got);
      check('P22 ...' + name + ' (' + cadence + '): the page says "' + message + '"', got.refused === message, got.refused);
    }
  }
  {
    const signedOut = await buy(IN_TRIAL, 'monthly', { validToken: async () => null });
    check('P22 a session that has ended: nothing is asked, nothing opens, and the page says to sign in',
      signedOut.asked.length === 0 && signedOut.opened.length === 0 && signedOut.refused === SIGN_IN, signedOut);
    const unreadable = await buy(IN_TRIAL, 'monthly', { validToken: async () => { throw new Error('offline'); } });
    check('P22 a session that cannot be read: nothing is asked, nothing opens, and the page says to try again',
      unreadable.asked.length === 0 && unreadable.opened.length === 0 && unreadable.refused === TRY_AGAIN, unreadable);
    /* Paddle's script first, so a script that will not load never
       leaves a transaction behind that nobody can open. */
    const noScript = await buy(IN_TRIAL, 'monthly', { paddleWillNotLoad: true });
    check('P22 Paddle\'s script will not load: create-checkout is not asked at all, and the page says to try again',
      noScript.asked.length === 0 && noScript.opened.length === 0 && noScript.refused === TRY_AGAIN, noScript);
    const noScriptLapsed = await buy({ entitled: false, plan: 'trial', status: 'trialing' }, 'monthly', { paddleWillNotLoad: true });
    check('P22 ...and the same for an account whose trial has ended', noScriptLapsed.opened.length === 0 && noScriptLapsed.refused === TRY_AGAIN, noScriptLapsed);
  }

  /* Anyone else who may buy: the plain catalogue price, paid on the
     day, opened by the page with no call to create-checkout. */
  const plainOpen = (priceId) => ({
    items: [{ priceId, quantity: 1 }],
    customer: { email: USER_EMAIL },
    customData: { user_id: USER_ID },
    settings: { displayMode: 'overlay', theme: 'light' },
  });
  const lapsedRows = {
    'a trial that has ended': { entitled: false, plan: 'trial', status: 'trialing' },
    'a trial marked expired': { entitled: false, plan: 'trial', status: 'expired' },
    'no plan at all': { entitled: false, plan: null, status: 'none' },
    'a cancelled subscription that has finished': { entitled: false, plan: 'monthly', status: 'canceled' },
    /* One already set to end will not bill again, so a new plan is how
       they come back, even while Paddle still calls the old one
       'trialing'. Complimentary access is not a Paddle subscription. */
    'a subscription set to end': { entitled: true, plan: 'monthly', status: 'active', cancel_at_period_end: true },
    'a subscription set to end before its first payment': { entitled: true, plan: 'monthly', status: 'trialing', cancel_at_period_end: true },
    'complimentary access': { entitled: true, plan: 'complimentary', status: 'active', complimentary: true },
  };
  for (const [name, row] of Object.entries(lapsedRows)) {
    const yearly = await buy(row, 'annual');
    const monthly = await buy(row, 'monthly');
    check('P22 ' + name + ': the plain prices, paid on the day, never a free period',
      yearly.priceId === P.annualPriceId && monthly.priceId === P.monthlyPriceId, { yearly: yearly.priceId, monthly: monthly.priceId });
    check('P22 ' + name + ': opened by the page as before, with the email, the account id for the webhook and the overlay settings',
      same(yearly.opened[0], plainOpen(P.annualPriceId)) && same(monthly.opened[0], plainOpen(P.monthlyPriceId)), monthly.opened);
    check('P22 ' + name + ': create-checkout is NOT asked', yearly.asked.length === 0 && monthly.asked.length === 0, monthly.asked.map((x) => x.url));
    const typed = await buy(row, 'monthly', { code: ' EARLY10 ' });
    check('P22 ' + name + ': a typed discount code is passed to Paddle, which checks it in the overlay',
      same(typed.opened[0], { ...plainOpen(P.monthlyPriceId), discountCode: 'EARLY10' }) && typed.asked.length === 0, typed.opened);
  }
  /* Someone who has ALREADY subscribed. Paddle keeps a subscription
     made with a free period at status 'trialing' until its first
     payment, which under the launch offer is weeks. That is a
     subscriber, not a free trial: checkout is refused, so there is never
     a second subscription billing beside the first, and no second free
     period. */
  const subscribedRows = {
    'subscribed on monthly, waiting for the first payment': { entitled: true, plan: 'monthly', status: 'trialing', current_period_end: '2027-01-01T12:00:00Z' },
    'subscribed on yearly, waiting for the first payment': { entitled: true, plan: 'annual', status: 'trialing', current_period_end: '2027-01-01T12:00:00Z' },
    'a paying subscriber': { entitled: true, plan: 'annual', status: 'active' },
    'a subscriber whose payment is overdue': { entitled: true, plan: 'monthly', status: 'past_due' },
  };
  for (const [name, row] of Object.entries(subscribedRows)) {
    for (const cadence of ['annual', 'monthly']) {
      const got = await buy(row, cadence);
      check('P22 ' + name + ', choosing ' + cadence + ': checkout does not open, the server is not asked, and the page says why',
        got.opened.length === 0 && got.asked.length === 0 && /already on AibhlínnAI Premium/.test(got.refused || ''), got);
    }
  }
  /* The entitlement lookup failed (supabase.js answers status 'unknown',
     with no plan). Opening checkout on that would be the plain price,
     paid today, for someone whose trial may be running. It stops. */
  for (const cadence of ['annual', 'monthly']) {
    const got = await buy({ entitled: true, plan: null, status: 'unknown' }, cadence);
    check('P22 a lookup that failed, choosing ' + cadence + ': checkout does not open, the server is not asked, and the page asks them to try again',
      got.opened.length === 0 && got.asked.length === 0 && got.refused === NOT_CHECKED, got);
  }
  check('P22 supabase.js still answers a failed lookup with status "unknown", which is what billing.js stops on',
    /status: 'unknown'/.test(uncommented(read('app/supabase.js'))) && /entitlement\.status === 'unknown'/.test(uncommented(billingSource)));

  /* The Google Play app. Billing is hidden there and refused here,
     before anything is read or asked: not the entitlement, not
     create-checkout, not Paddle's script. */
  const playSignals = {
    'the flag app.js sets': { inPlayApp: true },
    'getDigitalGoodsService': { digitalGoods: true },
    'the Play app\'s referrer': { referrer: 'android-app://ai.aibhlinn.pietimers/' },
    'the WebView\'s user agent': { userAgent: 'Mozilla/5.0 (Linux; Android 16) PieTimersAndroid/1.0.6' },
    'the #in-app address': { hash: '#in-app' },
    'the stored marker': { stored: '1' },
  };
  for (const [name, signal] of Object.entries(playSignals)) {
    for (const [what, row] of Object.entries({ 'in its trial': IN_TRIAL, 'whose trial has ended': { entitled: false, plan: 'trial', status: 'trialing' } })) {
      const got = await buy(row, 'monthly', signal);
      check('P22 in the Play app (' + name + '), an account ' + what + ': refused before anything is read, asked or opened',
        got.refused === 'That is not available in the Android app.' && got.lookups === 0 && got.asked.length === 0 && got.opened.length === 0 && got.initialized.length === 0, got);
    }
  }

  check('P22 across every case above, neither retired catalogue trial price was ever opened',
    everythingOpened.length > 20 && !everythingOpened.some((x) => JSON.stringify(x).includes(P.annualTrialPriceId) || JSON.stringify(x).includes(P.monthlyTrialPriceId)));
  check('P22 ...and every checkout that opened was either the server\'s transaction or a plain price, never both and never neither',
    everythingOpened.every((x) => (typeof x.transactionId === 'string') !== Array.isArray(x.items)) &&
    everythingOpened.filter((x) => x.items).every((x) => [P.annualPriceId, P.monthlyPriceId].includes(x.items[0].priceId)));
  /* The app, the header chip and the pricing page tell a free trial
     from a subscriber the same way billing.js does: by plan 'trial'. */
  const sameTest = {
    'app.js': /function isTrial\(ent\) \{\s*return ent\.plan === 'trial';\s*\}/,
    'identity-bridge.js': /var trialing = ent\.plan === 'trial' && ent\.entitled;/,
    'pricing.html': /var trialing = ent\.plan === 'trial' && ent\.entitled;/,
  };
  for (const [file, pattern] of Object.entries(sameTest)) {
    const code = uncommented(read('app/' + file));
    check('P22 ' + file + ' counts only plan "trial" as a free trial, never status "trialing" alone',
      pattern.test(code) && !/status === 'trialing' \|\|/.test(code));
  }
  check('P22 app.js names a subscriber waiting for their first payment as that, not as a free trial',
    /if \(ent\.status === 'trialing' && ent\.currentPeriodEnd\) \{\s*return name \+ ', first payment from '/.test(uncommented(read('app/app.js'))));
  {
    /* The Account tab's own label, run for real: the three functions
       are lifted out of app.js as they stand. */
    const appSource = read('app/app.js');
    const from = appSource.indexOf('  function daysLeft(ent) {');
    const to = appSource.indexOf('  function renderPlan() {');
    const sandbox = { CT: { billing: { enabled: () => true } }, LOCALE: 'en-AU', Date, Math };
    vm.createContext(sandbox);
    vm.runInContext(appSource.slice(from, to) + '\nthis.planLabel = planLabel; this.isTrial = isTrial;', sandbox, { filename: 'app.js (plan label)' });
    const ahead = new Date(Date.now() + 20 * 86400000).toISOString();
    const waiting = { entitled: true, plan: 'monthly', status: 'trialing', currentPeriodEnd: ahead };
    const label = from > 0 && to > from ? sandbox.planLabel(waiting) : '';
    check('P22 the Account tab calls a subscriber waiting for their first payment "Monthly, first payment from <date>", never a free trial',
      /^Monthly, first payment from \d/.test(label) && !/trial/i.test(label) && sandbox.isTrial(waiting) === false, label);
    const yearlyLabel = sandbox.planLabel({ entitled: true, plan: 'annual', status: 'trialing', currentPeriodEnd: ahead });
    check('P22 ...and the same on a yearly plan', /^Annual, first payment from \d/.test(yearlyLabel), yearlyLabel);
    const trialLabel = sandbox.planLabel({ entitled: true, plan: 'trial', status: 'trialing', currentPeriodEnd: ahead });
    check('P22 ...while an account in its own free trial still reads "Free trial: 20 days left"', trialLabel === 'Free trial: 20 days left', trialLabel);
    check('P22 ...a trial that has ended still reads as ended, and a paying subscriber as renewing',
      sandbox.planLabel({ entitled: false, plan: 'trial', status: 'trialing', currentPeriodEnd: '2026-01-01T00:00:00Z' }) === 'Free: your trial has ended' &&
      /^Annual, renews \d/.test(sandbox.planLabel({ entitled: true, plan: 'annual', status: 'active', currentPeriodEnd: ahead })) &&
      /^Monthly, ends \d/.test(sandbox.planLabel({ entitled: true, plan: 'monthly', status: 'trialing', currentPeriodEnd: ahead, cancelAtPeriodEnd: true })));
  }
  for (const file of ['pricing.html', 'index.html']) {
    check('P22 ' + file + ': the Monthly card does not say "Try before you pay" to someone who would pay on the day',
      !/Try before you pay/i.test(read('app/' + file)) && /<span class="plan-note">Cancel any time<\/span>/.test(read('app/' + file)));
  }

  const billingCode = uncommented(billingSource);
  const configCode = uncommented(configSource);
  check('P22 billing.js chooses on the account\'s own trial and nothing else: it reads no clock and holds no date',
    /var inTrial = entitlement\.plan === 'trial' && entitlement\.entitled;/.test(billingCode) &&
    /if \(state\.inTrial\) \{\s*return requestTrialCheckout\(cadence, code\)\.then\(function \(transactionId\) \{/.test(billingCode) &&
    !/\bDate\b|\b20\d\d\b/.test(billingCode), billingCode.match(/.{30}(\bDate\b|\b20\d\d\b).{30}/));
  check('P22 billing.js no longer reads either catalogue trial price', !/TrialPriceId/.test(billingCode) && /function plainPriceFor\(cadence\) \{\s*var p = cfg\.paddle;\s*return cadence === 'monthly' \? p\.monthlyPriceId : p\.annualPriceId;\s*\}/.test(billingCode));
  check('P22 ...and config.js keeps both, for an older cached billing.js that falls back to the plain price without them',
    /annualTrialPriceId: 'pri_[a-z0-9]+'/.test(configCode) && /monthlyTrialPriceId: 'pri_[a-z0-9]+'/.test(configCode));
  check('P22 Paddle\'s script is asked for before create-checkout is, on both paths, and no step of a Buy press waits without a limit',
    /var WAIT_MS = 10000;/.test(billingCode) &&
    /return within\(refresh\(\), WAIT_MS\)\.then\(function \(\) \{\s*return true;\s*\}, function \(\) \{\s*return false;\s*\}\)\.then\(function \(answered\) \{\s*if \(!answered \|\| entitlement\.status === 'unknown'\) throw new Error\(ACCOUNT_UNCHECKED\);/.test(billingCode) &&
    /return within\(CT\.auth\.validToken\(\), WAIT_MS\)\.catch\(/.test(billingCode) &&
    /function openCheckout\(cadence, discountCode\) \{\s*if \(opening\) return opening;/.test(billingCode) &&
    /return within\(initPaddle\(\), WAIT_MS\)\.catch\(function \(\) \{\s*if \(!window\.Paddle\) \{\s*paddleReady = null;\s*forgetScript\(PADDLE_SCRIPT\);\s*\}\s*return false;\s*\}\)\.then\(function \(ok\) \{\s*return \{ ok: ok, inTrial: inTrial, priceId: priceId \};\s*\}\);\s*\}\)\.then\(function \(state\) \{\s*if \(!state\.ok\) throw new Error\(CHECKOUT_FAILED\);/.test(billingCode));
  /* What the customer is told, on every path. No sentence is negative
     about time passing and none pushes. */
  const told = [...billingCode.matchAll(/'((?:[^'\\\n]|\\.)*\s(?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*\s(?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] || m[2]).filter((t) => /^[A-Z]/.test(t));
  check('P22 the sentences billing.js can show include the new one about a discount code, worded as written',
    told.includes(NO_SUCH_CODE) && told.includes(TRY_AGAIN) && told.includes(NOT_CHECKED) && told.includes(SIGN_IN), told);
  check('P22 ...and none is negative about time or pushes: no "runs out", "expire", "hurry", "last chance" or "soon"',
    told.length >= 6 && told.every((t) => !/runs? out|ran out|expir|hurry|last chance|\bsoon\b|shrink|before it is too late|don't miss/i.test(t)), told);
  /* pricing.html must take the same billing.js the app does. Asked for
     by its plain name, the service worker would store whatever copy the
     browser's own cache handed it, which just after a release can be the
     OLD file: an old checkout on a new page. */
  const versionIn = (file) => (read('app/' + file).match(/<script src="billing\.js(\?v=\d+)?"><\/script>/) || [])[1];
  check('P22 pricing.html loads billing.js with the same ?v= as index.html, the one sw.js precaches',
    Boolean(versionIn('index.html')) && versionIn('pricing.html') === versionIn('index.html') &&
    read('app/sw.js').includes("'billing.js" + versionIn('index.html') + "'"), { pricing: versionIn('pricing.html'), index: versionIn('index.html') });
  check('P22 ...and no page loads billing.js by its plain name',
    fs.readdirSync(path.join(ROOT, 'app')).filter((f) => f.endsWith('.html')).every((f) => !/<script src="billing\.js"/.test(read('app/' + f))));
  check('P22 config.js holds no date and no setting that gives everyone the trial price',
    !/\bDate\b|\b20\d\d\b/.test(configCode) && Object.keys(P).every((k) => !/until|launch|offer|everyone|always/i.test(k)), Object.keys(P));
}

{
  /* D1. The release notes the owner works from. DEPLOY.md no longer
     asks for a 7-day trial on a price in Paddle; it deploys the three
     functions, each with the right flag, before the test purchase; and
     Test A says what checkout itself must show. It still says a failed
     move is answered 500 and retried, not just logged. */
  const deploy = squash(read('DEPLOY.md'));
  check('D1 DEPLOY.md no longer has the 7-day tick', !deploy.includes('trial period to **7 days**') && !/- \[ \] In Paddle, set the monthly trial price/.test(deploy));
  /* Changed on 23 Nov 2026: the sentence ended "nobody is charged early
     either way." That is only true while the net's move succeeds: with 7
     days on the monthly trial price, a stuck move bills a week sooner
     than with 14. The sentence now says so, and every "14 days" about a
     stuck move carries the 7. */
  check('D1 ...and says that step is retired, and to leave it if it has been done, as long as the net\'s move succeeds',
    /That step is retired/.test(deploy) && /If it has already been done, leave it: nobody is charged early either way, as long as the net's move succeeds/.test(deploy));
  check('D1 ...and no "14 days" about a stuck move is left without the 7 it becomes if that change was made',
    !/exactly 14 days after it was made/.test(deploy) &&
    (deploy.match(/14 days after subscribing \(7 on the monthly plan, if the retired 7-day change was made/g) || []).length === 2 &&
    /before about 18 Dec 2026 \(before about 25 Dec on the monthly plan, if that price carries the retired 7-day change\)/.test(deploy) &&
    /none a next payment earlier than the rule's date for its own account and plan \(8\.4\)/.test(deploy) &&
    /Your separate steps page may still carry the 7-day tick/.test(deploy));
  check('D1 ...and nowhere tells the owner that a monthly checkout should show 7 days', !/7 days out|7-day trial on the price|7 days on the monthly/.test(deploy), deploy.match(/.{40}(7 days out|7-day trial on the price|7 days on the monthly).{40}/));

  const five3 = deploy.slice(deploy.indexOf('### 5.3 '), deploy.indexOf('### 5.4 '));
  check('D1 5.3 names ten functions, create-checkout and expire-checkouts among them',
    /Deploy the ten edge functions/.test(five3) &&
    ['signin', 'delete-account', 'paddle-webhook', 'manage-subscription', 'create-checkout', 'expire-checkouts', 'notify-milestones', 'calendar-sync', 'google-connect', 'review-signin']
      .every((name) => five3.includes(name)) &&
    fs.readdirSync(path.join(ROOT, 'supabase', 'functions'), { withFileTypes: true }).filter((e) => e.isDirectory()).length === 10, five3);
  check('D1 ...with create-checkout beside manage-subscription as deployed without --no-verify-jwt',
    /each with `--no-verify-jwt` except `manage-subscription` and `create-checkout`/.test(five3), five3);

  const five6 = deploy.slice(deploy.indexOf('### 5.6 '), deploy.indexOf('## 6. '));
  const iHook = five6.indexOf('- [ ] Deploy the webhook: `supabase functions deploy paddle-webhook --no-verify-jwt`.');
  const iCheckout = five6.indexOf('- [ ] Deploy the checkout function: `supabase functions deploy create-checkout`.');
  const iExpire = five6.indexOf('- [ ] Deploy the function that closes unpaid checkouts: `supabase functions deploy expire-checkouts --no-verify-jwt`.');
  const iList = five6.indexOf('- [ ] `supabase functions list` shows all three');
  const iSchedule = five6.indexOf('- [ ] Schedule it: paste the whole of `supabase/schema-expire-checkouts.sql` into the SQL editor and run it.');
  const iTestA = five6.indexOf('- [ ] Run Test A in 8.4');
  const iMerge = five6.indexOf('- [ ] Merge, which publishes the pages and `billing.js`.');
  check('D1 5.6 deploys paddle-webhook WITH --no-verify-jwt (Paddle sends a signature, not a Supabase token)', iHook > 0, iHook);
  check('D1 ...then create-checkout, with no flag on that line', iCheckout > iHook && !/supabase functions deploy create-checkout`? ?--/.test(deploy) && !/deploy create-checkout --no-verify-jwt/.test(deploy), { iHook, iCheckout });
  check('D1 ...no deploy line for paddle-webhook is left without the flag',
    (deploy.match(/supabase functions deploy paddle-webhook/g) || []).length === (deploy.match(/supabase functions deploy paddle-webhook --no-verify-jwt/g) || []).length);
  check('D1 ...both before Test A, and Test A before the merge that sends out billing.js', iList > iCheckout && iTestA > iList && iMerge > iTestA, { iList, iTestA, iMerge });
  /* Added on 25 Nov 2026 with expire-checkouts. It takes the flag: the
     scheduled job sends the publishable key, not a session token. */
  check('D1 5.6 deploys expire-checkouts WITH --no-verify-jwt, after create-checkout and before the list of all three',
    iExpire > iCheckout && iList > iExpire && !five6.includes('shows both') &&
    (deploy.match(/supabase functions deploy expire-checkouts/g) || []).length === (deploy.match(/supabase functions deploy expire-checkouts --no-verify-jwt/g) || []).length &&
    /The function is closed by `CRON_SECRET` instead/.test(five6), { iCheckout, iExpire, iList });
  check('D1 ...then the one paste that schedules it, with the row to expect and what to do with a red message, before Test A',
    iSchedule > iList && iTestA > iSchedule &&
    /Expect one row: `countdown-expire-checkouts`, then `3,13,23,33,43,53 \* \* \* \*`, then `true` four times\./.test(five6) &&
    /If a red message says nothing was changed, stop and bring the message back: nothing is scheduled\./.test(five6) &&
    /Nobody types the cron secret/.test(five6) && /Never paste or print a job's command/.test(five6) &&
    /has never been run\. Your paste is its first run\./.test(five6), { iSchedule, iTestA });
  check('D1 5.6 says why that order is safe',
    /`expire-checkouts` is closed and idle until its job exists/.test(five6) && /would only collect 404s/.test(five6) &&
    /From its first run the job cancels every unpaid transaction `create-checkout` has made that is over an hour old/.test(five6));
  check('D1 5.6 has a tick for what the Paddle API key may do, marked as not read from Paddle',
    /Check what the key behind `PADDLE_API_KEY` may do\. `create-checkout` needs it to read prices, read discounts and write transactions\./.test(five6) &&
    /`expire-checkouts` needs it to read transactions and write transactions\./.test(five6) &&
    /\[check label: Paddle's key permissions screen was not read/.test(five6));
  check('D1 5.6 says what to search each log for',
    ['"Could not defer first charge"', '"first charge moved after checkout"', '"trial subscription on a catalogue price"', '"Could not make checkout"'].every((line) => five6.includes(line)) &&
    /Search the `create-checkout` function log for "Could not make checkout"/.test(five6));
  check('D1 ...and says plainly that a create-checkout fault charges nobody, and that nobody is told',
    /A fault in `create-checkout` charges nobody\./.test(five6) && /Nobody is told unless a customer writes in/.test(five6));
  check('D1 ...and the same for expire-checkouts: a fault charges nobody and cancels nothing, and leaves unpaid prepared purchases open',
    /\*\*A fault in `expire-checkouts` charges nobody and cancels nothing\.\*\*/.test(five6) &&
    /leaves unpaid prepared purchases open, which is how things stood before 25 Nov 2026/.test(five6));
  check('D1 5.6 says what to search the expire-checkouts log for, and that a gap in its ten-minute line means the job has stopped',
    /Search the `expire-checkouts` function log for "Could not close checkouts"\./.test(five6) && five6.includes('"checkouts closed:"') &&
    /a gap in those lines means the job has stopped, and the made versus paid gap is open again/.test(five6) &&
    EXPIRE_CODE.includes('console.log(`checkouts closed: ${tail}`);') && EXPIRE_CODE.includes('`Could not close checkouts: ${'));
  check('D1 5.6 says what "21 days" becomes: the first whole day at or after it, never before',
    /between 21 and 22 days after the account was made \(30 and 31 yearly\), and never before it/.test(five6) &&
    /between `2027-01-01T12:00Z` and `2027-01-02T12:00Z`/.test(five6));

  const eight1 = deploy.slice(deploy.indexOf('### 8.1 '), deploy.indexOf('### 8.2 '));
  check('D1 8.1: two plain prices in use, the two trial prices retired and kept in config.js for now',
    /its two prices/.test(eight1) && /They are retired: nothing in `billing\.js` opens them\./.test(eight1) && /Their ids stay in `config\.js` for now/.test(eight1), eight1);

  const eight4 = deploy.slice(deploy.indexOf('### 8.4 '), deploy.indexOf('### 8.5 '));
  check('D1 8.4 Test A is run from the console before the merge, with what the new billing.js sends',
    eight4.includes("CT.config.supabaseUrl + '/functions/v1/create-checkout'") && eight4.includes("body: JSON.stringify({ cadence: 'monthly' })") &&
    eight4.includes("Paddle.Checkout.open({ transactionId: d.transactionId, customer: { email: CT.auth.getUser().email } });") &&
    eight4.includes("checkout: { settings: { displayMode: 'overlay', theme: 'light' } }"));
  check('D1 8.4 Test A says to note, before paying, the day checkout shows',
    /\*\*Before paying\*\*, write down what the overlay shows: the first-payment day or the count of free days, the price, the currency, whether tax is included, and whether your email is filled in\./.test(eight4));
  check('D1 ...and that next_billed_at must be that day, at or after the rule\'s date and under 24 hours after it',
    /`next_billed_at` must be that day: the purchase time plus `trialDays` days, the same day the overlay showed, at or after the rule's date and under 24 hours after it\./.test(eight4));
  check('D1 ...and to change the country, and stop if the price does not follow',
    /Change the country in the overlay to one outside Australia/.test(eight4) && /\*\*stop and do not merge\*\*/.test(eight4));
  check('D1 ...and what each function log must show',
    eight4.includes('"checkout made: monthly, N days, first payment from ..."') && eight4.includes('It has "first charge: checkout\'s date stands".') &&
    /It has none of "first charge moved after checkout", "Could not defer first charge" and "trial subscription on a catalogue price"\./.test(eight4));
  /* Changed on 23 Nov 2026: this pinned "is now exercised only against
     stubs". That left the net's move, and the key's permission to make
     it, unseen against Paddle before the merge, while an old cached page
     can still need it afterwards. Test C now runs it once, on the old
     Buy button, so the sentence says where the move IS exercised. */
  check('D1 ...and that Test A does not exercise the date move or prove the key may change a subscription, and that Test C does',
    /`paddle-webhook` moves nothing in Test A/.test(eight4) && /is not exercised by it/.test(eight4) && /but not that it may change a subscription/.test(eight4) &&
    /Test C, below, is where the move meets Paddle: run it before the merge\./.test(eight4) && !/is now exercised only against stubs/.test(eight4));
  const testC = eight4.slice(eight4.indexOf('Test C — the net.'), eight4.indexOf('Test D: the hour.'));
  const testD = eight4.slice(eight4.indexOf('Test D: the hour.'), eight4.indexOf('After the merge — the real button.'));
  check('D1 8.4 has Test C: the old Buy button before the merge, which opens a catalogue trial price and makes the net move the date',
    eight4.indexOf('Test C — the net.') > eight4.indexOf('Test B — the money path.') && testC.length > 0 &&
    /can only be run this way before the merge/.test(testC) && /press the live Buy button/.test(testC) && /another throwaway account that is still in its free trial/.test(testC));
  check('D1 ...Test C says what the log and Paddle must then show, to the second, and to stop if the move failed',
    testC.includes('"trial subscription on a catalogue price"') && testC.includes('"first charge moved after checkout: checkout showed ..., rule gives ..."') &&
    /It has no "Could not defer first charge"\./.test(testC) && /exactly the rule's instant, to the second, not rounded to a whole day: `2027-01-01T12:00:00Z`/.test(testC) &&
    /\*\*stop and do not merge\.\*\*/.test(testC) && /cancel this subscription in Paddle/.test(testC));
  const iTestB = five6.indexOf('- [ ] Run Test B in 8.4.');
  const iTestC = five6.indexOf('- [ ] Run Test C in 8.4');
  const iTestD = five6.indexOf('- [ ] Run Test D in 8.4, at least 75 minutes after Test A\'s spare was made.');
  const iBeforeMerge = five6.indexOf('- [ ] Straight before the merge: `supabase functions list` shows `paddle-webhook`, `create-checkout` and `expire-checkouts` all updated in this sitting');
  check('D1 5.6 runs Test C after Test B, Test D after Test C, and both before the merge, in the ticks and in the numbered order',
    iTestB > iTestA && iTestC > iTestB && iTestD > iTestC && iMerge > iTestD &&
    /5\. `supabase functions deploy expire-checkouts --no-verify-jwt`; 6\. `supabase functions list` shows all three; 7\. paste `supabase\/schema-expire-checkouts\.sql`[^;]*; 8\. Test A in 8\.4[^;]*; 9\. Test B in 8\.4; 10\. Test C in 8\.4[^;]*; 11\. Test D in 8\.4[^;]*; 12\. the merge to `main`/.test(five6),
    { iTestB, iTestC, iTestD, iMerge });
  check('D1 5.6 has a tick straight before the merge: all three functions updated, and the new webhook\'s own log line seen',
    iBeforeMerge > iTestD && iMerge > iBeforeMerge &&
    /"first charge: checkout's date stands" was seen in the `paddle-webhook` log in Test A\. Only the new `paddle-webhook` writes that line\. Without it, do not merge/.test(five6), iBeforeMerge);
  check('D1 5.6 names the dangerous wrong order: the merge over an older paddle-webhook, which can move a date earlier',
    /\*\*The merge before the new `paddle-webhook` is the dangerous order\.\*\*/.test(five6) && /a charge earlier than the customer was shown/.test(five6) &&
    /The merge before `create-checkout` is deployed only stops sales/.test(five6) && !/is deployed is the one to avoid/.test(five6));
  /* The line the webhook writes, the one the notes tell the owner to
     search for, and the one the tests look for are the same words. */
  const OUTSIDE_LINE = 'free period on an account whose own free trial was not running';
  check('D1 5.6 says what to do with the two lines a transaction paid late leaves in the log, and no longer says "nothing to do" for both',
    WEBHOOK_SOURCE.includes('console.warn("' + OUTSIDE_LINE + '");') &&
    five6.includes('Search it for "' + OUTSIDE_LINE + '".') && eight4.includes('"' + OUTSIDE_LINE + '"') &&
    /Search it for "First payment later than the rule: by N hours"/.test(five6) && /is a transaction made on one day and paid on a later one/.test(five6) &&
    /Paddle does allow that: found on 25 Nov 2026\. `expire-checkouts` now cancels such a transaction about an hour after it was made/.test(five6) &&
    !/is what Test B's spare transaction finds out/.test(five6) &&
    !/or a trial extended by hand: nothing to do/.test(five6) && /What to do with that subscription[^.]*is your call\./.test(five6));
  check('D1 5.6 says create-checkout has no limit on calls, and what a run of 429s in its log is',
    /Many lines saying "answered 429"/.test(five6) && /has no limit on how often one signed-in account may call it/.test(five6));
  /* Changed on 25 Nov 2026. The spare was looked at after Test B, to
     find out whether a transaction can be opened later. It can. The
     owner decided what to do, so the passage is now what was found and
     how the gap is closed, and the spare is looked at in Test D. */
  check('D1 8.4 makes a spare transaction in Test A, and looks at it in Test D without paying',
    /First, a spare\./.test(eight4) && eight4.includes("console.log('spare', r.status, await r.json());") &&
    !eight4.includes('Last, the spare from Test A.') && !/\*\*It opens and still offers the free days\.\*\*/.test(eight4) &&
    !/is your decision to make before the merge\. Nothing has been built for it\./.test(eight4) &&
    testD.includes("Paddle.Checkout.open({ transactionId: '<the spare transactionId>' });") && /\*\*Do not pay\.\*\* Write down exactly what the overlay does/.test(testD) &&
    /whether a transaction made earlier can still be opened later, and from which day its free days are then counted/.test(eight4));
  const found = eight4.slice(eight4.indexOf('What the spare found.'), eight4.indexOf('Test C — the net.'));
  check('D1 ...and says what was found on 25 Nov 2026, the owner\'s decision, and what was declined',
    found.length > 0 && eight4.indexOf('What the spare found.') > eight4.indexOf('Test B — the money path.') &&
    /\*\*Found on 25 Nov 2026\.\*\* A prepared purchase left unpaid could still be opened a day later, after the account's own trial had ended, and still offered the full free period, counted from the day of payment\./.test(found) &&
    /Unpaid prepared purchases are now cancelled about an hour after they are made\./.test(found) &&
    /Cancelling a subscription after payment was offered and declined, and is not built\./.test(found) &&
    /between 60 and about 70 minutes/.test(found), found.slice(0, 300));
  check('D1 ...and what is left: the hour itself, a payment that never settles, more than 120 an hour, and any stretch when it is not running',
    /someone whose trial ends inside the hour can still pay and start the free period/.test(found) &&
    /A transaction carrying a payment attempt that never settles is left alone\./.test(found) && /More than 120 an hour wait for later runs\./.test(found) &&
    /none of this is true until the function is deployed AND the job is scheduled/.test(found) && found.includes('"' + OUTSIDE_LINE + '"') &&
    /Test D, below, is where it meets Paddle\./.test(found));
  check('D1 8.4 has Test D after Test C and before the look at the real button: the first spare is cancelled, a second one made just now is not',
    eight4.indexOf('Test D: the hour.') > eight4.indexOf('Test C — the net.') && testD.length > 0 && /Takes no money\./.test(testD) &&
    /at least 75 minutes after the spares in Test A were made/.test(testD) &&
    /The first spare reads Canceled\. The opened spare reads Canceled\. The fresh spare is still Draft\./.test(testD) &&
    testD.includes('"checkouts closed: closed 1, ..."') && /There is no line starting "Could not close checkouts"\./.test(testD) &&
    /The test passes when no purchase is offered\./.test(testD));
  check('D1 ...Test D says when to stop, how to read the counts, and leaves the open-overlay look as the owner\'s call',
    /still Draft or Ready after 80 minutes, or still opens and offers a purchase: \*\*stop and do not merge\.\*\*/.test(testD) &&
    ['"not ours 1"', '"changed 1"', '"refused 1"', '"failed 1"', '"listed 0"'].every((t) => testD.includes(t)) &&
    /Optional, and your call\./.test(testD) && /leave the overlay open past 75 minutes without paying/.test(testD));
  /* Changed on 25 Nov 2026 (review). Test D only ever looked at a spare
     that was never opened, while every prepared purchase a customer
     leaves behind is an opened one, and what Paddle changes on a
     transaction once a checkout has been opened on it has not been
     seen. One spare is now opened in Test A, with an email, and must
     read Canceled too. */
  check('D1 8.4 Test A makes a second spare and opens it with an email, without paying, and Test D needs both cancelled before the merge',
    /Then a second spare, opened and left\./.test(eight4) && eight4.indexOf('Then a second spare, opened and left.') < eight4.indexOf('Then the test itself.') &&
    eight4.includes("Paddle.Checkout.open({ transactionId: '<the opened spare transactionId>', customer: { email: CT.auth.getUser().email } });") &&
    /Wait until the price shows and your email is filled in\. \*\*Do not pay\.\*\* Close the overlay\./.test(eight4) &&
    /Then do the same with the opened spare's id\./.test(testD) && /If only the opened spare is left, opening a checkout changes something the function tests/.test(testD) &&
    /Do not merge until both spares from Test A read Canceled in Paddle and neither offers a purchase/.test(five6) &&
    !/Do not merge until the spare reads Canceled/.test(five6));
  check('D1 ...Test D no longer says a changed origin shows as "not ours": the list asks for origin api, so that shows as "listed 0"',
    /"listed 0" means Paddle's list did not return the spare\. The list asks for origin `api` only/.test(testD) && /and never as "not ours"/.test(testD) &&
    !/"not ours 1" means the function did not recognise the spare: most likely Paddle reports its origin/.test(testD) &&
    /origin=api&/.test(EXPIRE_CODE));
  check('D1 ...and the theory about custom data has a tick of its own, marked as the owner\'s call and as never tried',
    /Your call, about two minutes: a third spare, for a theory\./.test(eight4) && /Read in Paddle's documentation on 25 Nov 2026 and never tried/.test(eight4) &&
    /If you made the changed spare in Test A/.test(testD) && /Custom data without `made_by` and still Draft after 80 minutes/.test(testD));
  /* The words Test D and "Reading an answer" tell the owner to look for
     are the words the function writes. */
  const fromExpire = eight4.slice(eight4.indexOf('Reading an answer from `expire-checkouts` (in'), eight4.indexOf('Reading a failure from `create-checkout`'));
  check('D1 8.4 reads an answer from expire-checkouts, status by status, with every stop word the function has and no other',
    fromExpire.length > 0 && ['**403**', '**405**', '**503**', '**502**', '**200**', '**500**'].every((t) => fromExpire.includes(t)) &&
    same([...new Set([...EXPIRE_CODE.matchAll(/stopped = "([a-z_]+)"/g)].map((m) => m[1]))].sort(), ['cap', 'clock', 'list_failed', 'paddle_auth', 'paddle_failing', 'pages', 'rate_limited', 'reads', 'time']) &&
    ['rate_limited', 'paddle_auth', 'list_failed', 'paddle_failing', 'clock', 'cap', 'reads', 'pages', 'time'].every((word) => new RegExp('"(stopped )?' + word + '"').test(fromExpire)) &&
    fromExpire.includes('"not_configured"') && EXPIRE_CODE.includes('error: "not_configured"') &&
    ['not ours ${notOurs}', 'changed ${changed}', 'refused ${refused}', 'failed ${failed}', 'listed ${listed}', 'more waiting ${'].every((t) => EXPIRE_CODE.includes(t)), fromExpire.slice(0, 200));
  /* Changed on 25 Nov 2026 (review): a run that cancelled nothing while
     old ones were due answered 200 with the healthy line, and the notes
     told the owner that no fault line plus a healthy line every ten
     minutes meant all was well. Such a run is now a fault, and the
     notes read each kind. */
  check('D1 8.4 reads the "left_open" fault and each of its three reasons, in the words the function writes',
    fromExpire.includes('error "left_open"') && EXPIRE_CODE.includes('"left_open"') &&
    fromExpire.includes('"Paddle refused N, and last a cancel answered 409 (...)"') && EXPIRE_CODE.includes('`Paddle refused ${refused}, and last ${lastRefusal}`') &&
    EXPIRE_CODE.includes('lastRefusal = `a cancel answered ${cancel.status}${errorCode(cancel.data)}`;') &&
    fromExpire.includes('"N still unpaid did not pass the second read"') && EXPIRE_CODE.includes('`${unpaidChanged} still unpaid did not pass the second read`') &&
    fromExpire.includes('"more are waiting and this run cancelled none"') && EXPIRE_CODE.includes('"more are waiting and this run cancelled none"'));
  check('D1 ...and gives the run\'s real limits, what the 200 counts mean, and a row that timed out',
    /its limit of 20 cancels sent, 40 second reads, 120 listed or 18 seconds/.test(fromExpire) &&
    /"being paid" above 0 on every run is a payment attempt that never settled/.test(fromExpire) &&
    /"more waiting yes" on several runs in a row means the hour is not being kept/.test(fromExpire) &&
    /A row in `net\._http_response` with no status and a time-out message/.test(fromExpire) && /"paddle_failing" is three failures in a row, of reads or of cancels/.test(fromExpire) &&
    !/120 or more old unpaid transactions that are not `create-checkout`'s are in front of the ones that are/.test(fromExpire));
  check('D1 5.6 tells the owner to read the newest healthy line, not only that one is there, and what a run of "more waiting yes" means',
    /Then read the newest of those lines, not only that one is there\./.test(five6) &&
    /"more waiting yes" on several runs in a row means more are being made than the 120 an hour the function cancels, so the hour is not being kept for anyone/.test(five6) &&
    /because one account can make that many by itself/.test(five6) &&
    /A run that leaves old unpaid ones open for any reason other than somebody paying writes that same line/.test(five6));
  /* The rewrite of "What the spare found" dropped the catalogue trial
     price route and so overstated what is closed (review, 25 Nov 2026). */
  check('D1 8.4 says the retired catalogue trial prices are a separate route that is still open, and that one account can flood the hour',
    /\*\*A separate route, still open\.\*\* `expire-checkouts` only ever touches transactions that `create-checkout` made\./.test(found) &&
    /This route stays open until those two prices are archived, and 8\.1 says when\./.test(found) &&
    /one account can make more than 120 an hour by itself, on purpose\. The hour is not a ceiling against that/.test(found) &&
    /a retired catalogue trial price opened by hand/.test(five6));
  const keyRow = deploy.slice(deploy.indexOf('| Paddle API key (server'), deploy.indexOf('## 1. Create the repo'));
  check('D1 the keys table says four functions use the Paddle API key, and that expire-checkouts needs it to read transactions',
    /calls Paddle's API from four functions/.test(keyRow) && !/from three functions/.test(deploy) &&
    /`expire-checkouts` uses it to list unpaid transactions and cancel the ones `create-checkout` made/.test(keyRow) &&
    /so the key must be allowed to read transactions as well/.test(keyRow) && /With a key that may not read transactions/.test(keyRow));
  const five1 = deploy.slice(deploy.indexOf('### 5.1 '), deploy.indexOf('### 5.2 '));
  check('D1 5.1 lists schema-expire-checkouts.sql after cron.sql, with a pointer to 5.6',
    five1.indexOf('- [ ] `schema-expire-checkouts.sql`, last: after `cron.sql`') > five1.indexOf('- [ ] `cron.sql`') && five1.indexOf('- [ ] `cron.sql`') > 0 &&
    /5\.6 has the tick, the row to expect and what to do with a red message\./.test(five1) && !/`cron\.sql` — last/.test(five1));
  check('D1 the rule against printing a job\'s command names cron.job_run_details too, in all three places',
    /no `select \* from cron\.job_run_details`, which repeats the command for every run/.test(five6) &&
    /`select \*` on `cron\.job` or on `cron\.job_run_details`, which has a command column too/.test(squash(read('CLAUDE.md'))) &&
    /Never run `select \* from cron\.job` or `select \* from cron\.job_run_details`/.test(squash(read('supabase/README.md'))));
  check('D1 8.4 has a branch for an overlay that shows neither a day nor a count, and the tick says to note which of the three',
    /\*\*The overlay shows neither a first-payment day nor a count of free days\.\*\* Do not merge until you have decided what to do\./.test(eight4) &&
    /Write down which of the three it is: a first-payment day, a count of free days, or neither\./.test(eight4));
  check('D1 8.1 and 8.4 say how a discount must be kept, and what to try in Test A',
    /Discount codes: keep each one to the \*\*product\*\*, or to nothing\. Never keep one to a price\./.test(eight1) &&
    /try a code that has reached its end date, or one kept to a price: the console must print `422` and `discount_not_found`/.test(eight4) &&
    /it has reached its end date, it has been used as often as it allows, or it is kept to other products or to a price/.test(eight4));
  check('D1 8.4 lists what only the real purchase can show, and what to do if it fails',
    /What only this test can show/.test(eight4) && /If Test A fails:/.test(eight4) && /`custom_data` is missing from `subscription\.created`\.\*\* Do not merge\./.test(eight4));
  check('D1 8.4 has the look at the real button after the merge', /After the merge — the real button\./.test(eight4) && /press the real Buy button/.test(eight4));
  check('D1 8.4 reads a failure from create-checkout, code by code',
    ['401 `not_signed_in`', '409 `already_subscribed`', '409 `not_in_trial`', '422 `discount_not_found`', '502 `paddle`', '503 `not_configured`', '503 `account_unreadable`'].every((code) => eight4.includes('**' + code + '**')), eight4.match(/\*\*\d{3} `[a-z_]+`\*\*/g));
  /* Every code the function can answer with is in that list, and the
     list names no code the function does not have. */
  const answered = [...new Set([...CHECKOUT_SOURCE.matchAll(/refuse\((\d{3}), "([a-z_]+)"/g)].map((m) => m[1] + ' `' + m[2] + '`'))];
  const fromCheckout = eight4.slice(eight4.indexOf('Reading a failure from `create-checkout`'));
  const documented = (fromCheckout.match(/\*\*(\d{3} `[a-z_]+`)\*\*/g) || []).map((t) => t.slice(2, -2));
  check('D1 ...and every one of those is a code the function really answers with', documented.length >= 7 && documented.every((code) => answered.includes(code)), { documented, answered });

  check('D1 DEPLOY.md still says a failed move is answered 500 and retried, not just logged',
    /answers 500[^.]*Paddle (sends|retries)/i.test(deploy) && !/only logs it/.test(deploy) && !/so Paddle does not retry and the customer is billed/.test(deploy));

  const claude = squash(read('CLAUDE.md'));
  const datesList = claude.slice(claude.indexOf('**The launch dates live in several places.**'), claude.indexOf('`DEPLOY.md` was missing from this list'));
  check('D1 CLAUDE.md\'s list of where the dates live names create-checkout beside paddle-webhook',
    datesList.includes('`supabase/functions/paddle-webhook/index.ts`') && datesList.includes('`supabase/functions/create-checkout/index.ts`'), datesList.slice(0, 300));
  check('D1 CLAUDE.md no longer says billing.js chooses a trial price, or that a 7-day trial is the fix',
    !/`billing\.js` \(`priceFor`\)/.test(claude) && !/offers the trial price only while/.test(claude) && !/The fix is a \*\*7-day trial/.test(claude) &&
    /`billing\.js` asks `create-checkout` only while the account's own trial is running/.test(claude) && /Never give a lapsed account a free period\./.test(claude));
  check('D1 ...says what "21 days" becomes, and that the count is never rounded down',
    /rounded UP, never down/.test(claude) && /between 21 and 22 days \(30 and 31\), never before/.test(claude));
  check('D1 ...keeps "Never say nothing needs a person on 1 January"', claude.includes('Never say "nothing needs a person on 1 January"'));
  check('D1 ...and says pricing.html\'s billing.js ?v= moves with index.html\'s', /`billing\.js` carries the same `\?v=` in `app\/pricing\.html` as in `app\/index\.html`/.test(claude));

  check('D1 CLAUDE.md says the free days are fixed when a transaction is made and counted from when it is paid, and what must not be claimed',
    /fixed when the transaction is MADE and counted from when it is PAID, and nothing ties the two together/.test(claude) &&
    /never say "nobody can get a free period after their trial has ended"/.test(claude) &&
    claude.includes('"free period on an account whose own free trial was not running"') &&
    /has no limit on how often one account may call it/.test(claude));
  /* Added on 25 Nov 2026: what was found, what was decided, and what
     must not be built or claimed. */
  check('D1 CLAUDE.md says what was found on 25 Nov 2026, and no longer that it has not been tried',
    /Found for real on 25 Nov 2026: a transaction left unpaid could still be opened a day later/.test(claude) &&
    !/has not been tried \(the spare transaction/.test(claude) && !/Mal's call; nothing is built for it\./.test(claude) &&
    /which narrows this to that hour for transactions `create-checkout` made, and does not end it/.test(claude) &&
    /One of the two retired catalogue trial prices opened by hand is a separate route to the same free period: nothing cancels that/.test(claude));
  check('D1 CLAUDE.md has the rule: unpaid prepared purchases are cancelled about an hour after they are made, by which function and job',
    claude.includes('**Unpaid prepared purchases are cancelled about an hour after they are made (Mal, 25 Nov 2026).**') &&
    claude.includes('`expire-checkouts`') && claude.includes('`countdown-expire-checkouts`') && claude.includes('`supabase/schema-expire-checkouts.sql`') &&
    /Cancelling a subscription AFTER payment was offered to Mal and declined: do not build it\./.test(claude));
  check('D1 ...what is left, that it is only true once deployed AND scheduled, that it has not met Paddle, and never to print a job\'s command',
    /someone whose trial ends inside the hour can still pay and start the free period/.test(claude) &&
    /Only true once the function is deployed AND the job is scheduled: check `supabase functions list` and `select jobname from cron\.job` before saying so\./.test(claude) &&
    /It first meets Paddle in `DEPLOY\.md` 8\.4 Test D\./.test(claude) && /the SQL has never been run/.test(claude) &&
    /Never print a cron job's command/.test(claude) && !/which is now only possible within about an hour/.test(claude) &&
    /which `expire-checkouts` is built to limit to about an hour \(the bullet on unpaid prepared purchases says when that is true and what is left\)/.test(claude));
  check('D1 ...and the two marks, the flood, and that a run that leaves old ones open is a fault',
    /It knows `create-checkout`'s transactions by either of two marks/.test(claude) && /in theory read from Paddle's documentation and never tried/.test(claude) &&
    /one account can make that many by itself because `create-checkout` has no limit, so the hour is not a ceiling against a flood/.test(claude) &&
    /is logged as that fault and never as a healthy "checkouts closed:" line/.test(claude));
  check('D1 ...and that the merge must not go out over an older paddle-webhook, and that Test C is the one time the move meets Paddle',
    /\*\*The merge must not go out over an older `paddle-webhook`\.\*\*/.test(claude) && /`DEPLOY\.md` 8\.4 Test C \(the old Buy button, before the merge\) is the one time it meets Paddle/.test(claude));
  check('D1 ...and does not state as fact that checkout shows the date, which nobody has seen',
    !/\*\*Checkout shows the right first-payment day itself/.test(claude) && !/\*\*Checkout shows the right first-payment day itself/.test(deploy) &&
    /has not been seen: never say "checkout shows the date" as fact until `DEPLOY\.md` 8\.4 Test A has been run/.test(claude));
  /* create-checkout's own header made the claim the finding was about. */
  const checkoutHeader = squash(CHECKOUT_SOURCE.slice(0, CHECKOUT_SOURCE.indexOf('const SUPABASE_URL')).replace(/^\s+/gm, ''));
  check('D1 create-checkout\'s header no longer says nobody can get a longer free period or one after their trial, and says what it cannot do',
    !/So nobody can ask for a longer free period/.test(checkoutHeader) && !/neither would change what anybody is charged/.test(checkoutHeader) &&
    /What it cannot do: tie the transaction to the moment it is paid\./.test(checkoutHeader) &&
    /No limit on how often\./.test(checkoutHeader) && /It is not built\./.test(checkoutHeader), checkoutHeader.slice(0, 200));
  check('D1 ...and says what was found on 25 Nov 2026, that expire-checkouts now cancels what is left unpaid, and that made_by must not be renamed alone',
    /Found for real on 25 Nov 2026: Paddle still opened a transaction a day after it was made/.test(checkoutHeader) &&
    !/has not been tried \(DEPLOY\.md 8\.4 has the ticks that find out\)/.test(checkoutHeader) &&
    /Do not rename that text without changing MADE_BY in expire-checkouts/.test(checkoutHeader) && /What remains is the hour/.test(checkoutHeader) &&
    /A draft left behind is now cancelled after about an hour by expire-checkouts; the one-off price stays\./.test(checkoutHeader) &&
    /It also knows them by the end of the one-off price's description, "\(create-checkout\)", which is PRICE_MARK there/.test(checkoutHeader) &&
    /expire-checkouts never touches a checkout opened that way/.test(checkoutHeader));
  /* expire-checkouts' own header, and the wording rules for everything
     new the owner reads: no dash punctuation, and nothing "expires" or
     "runs out": a prepared purchase is cancelled or closed. The word
     appears only inside the function's own name. */
  const expireHeader = squash(EXPIRE_SOURCE.slice(0, EXPIRE_SOURCE.indexOf('const CRON_SECRET')).replace(/^\s+/gm, ''));
  check('D1 expire-checkouts\' header says whose decision it is, what was declined, what "about an hour" means, and that it has not met Paddle',
    /The owner decided the same day: unpaid prepared purchases are cancelled about an hour after they are made\./.test(expireHeader) &&
    /He was offered cancelling a subscription after payment instead and declined\./.test(expireHeader) &&
    /"About an hour" means between 60 and about 70 minutes/.test(expireHeader) && /What it cannot do\./.test(expireHeader) &&
    /Nothing here has met Paddle until DEPLOY\.md 8\.4 Test D\./.test(expireHeader) && /Deployed WITH --no-verify-jwt/.test(expireHeader) &&
    /A fault here charges nobody and cancels nothing/.test(expireHeader) && /stores nothing/.test(expireHeader));
  check('D1 ...and the two marks as theory, the clock, the flood, the catalogue route, what counts as a fault, and the real limits of a run',
    /The mark\. THEORY, never tried:/.test(expireHeader) && /The clock\./.test(expireHeader) && /Keep the hour against a flood\./.test(expireHeader) &&
    /Touch a checkout opened on one of the two retired catalogue trial prices\./.test(expireHeader) && /What counts as a fault\./.test(expireHeader) &&
    /At most 4 lists, 40 second reads and 20 cancels sent, whatever Paddle answers: 64 requests/.test(expireHeader) &&
    /A good read does not wipe out a failed cancel/.test(expireHeader) && !/44 requests/.test(EXPIRE_SOURCE) &&
    /\(Test D opens one spare for this reason\)/.test(expireHeader));
  const newText = { 'expire-checkouts/index.ts': EXPIRE_SOURCE, 'schema-expire-checkouts.sql': read('supabase/schema-expire-checkouts.sql'), 'DEPLOY.md Test D': testD,
    'DEPLOY.md "What the spare found"': found, 'DEPLOY.md "Reading an answer from expire-checkouts"': fromExpire };
  for (const [name, text] of Object.entries(newText)) {
    check('D1 ' + name + ': no dash punctuation, and nothing "expires", "runs out" or "shrinks" (the word is only in the function\'s own name)',
      text.length > 0 && !/[–—]/.test(text) && !/expir|runs? out|ran out|shrink/i.test(text.replace(/expire[-_]checkouts/g, '')), text.match(/.{30}([–—]|expir(?!e-checkouts)|runs? out|shrink).{30}/i));
  }

  const supaReadme = squash(read('supabase/README.md'));
  check('D1 supabase/README.md lists schema-expire-checkouts.sql as step 12, nothing to edit, and its job among those to expect',
    supaReadme.includes('| 12 | `schema-expire-checkouts.sql` | the 10-minute job that cancels unpaid prepared purchases | After `cron.sql`, and after deploying `expire-checkouts`. Nothing to edit. |') &&
    /Steps 1–10 and step 12 are plain copy-paste with nothing to edit\./.test(supaReadme) &&
    /Expect `countdown-calendar-sync`, `countdown-expire-checkouts`, `countdown-milestones`,/.test(supaReadme));
  /* The healthy answer the README shows is the answer the function gives. */
  const healthy = '{"ok":true,"closed":0,"listed":0,"old":0,"young":0,"notOurs":0,"paying":0,"changed":0,"refused":0,"failed":0,"more":false,"stopped":null}';
  paddleStub([]);
  const quiet = await run();
  check('D1 ...and shows the healthy answer exactly as the function gives it, and says never to select a job\'s command',
    supaReadme.includes('`' + healthy + '`') && quiet.text === healthy &&
    /never select a job's `command` onto the screen/.test(supaReadme) && /Never run `select \* from cron\.job`/.test(supaReadme));

  const appReadme = squash(read('app/README.md'));
  check('D1 app/README.md says who judges a discount code on each path, and to keep a discount to the product, never to a price',
    /\*\*Keep a discount to the product, or to nothing\. Never to a price\.\*\*/.test(appReadme) &&
    /looks the code up in Paddle on the server before any checkout opens/.test(appReadme) &&
    !/entered in the field above the plan cards\. Paddle validates the code and shows the result in its own overlay, so a mistyped or expired code fails gracefully\./.test(appReadme) &&
    appReadme.includes(read('app/billing.js').match(/var DISCOUNT_NOT_FOUND = '([^']+)';/)[1]));
  check('D1 app/README.md and config.js say the overlay\'s own display is first seen in Test A',
    /is first seen in `DEPLOY\.md` 8\.4 Test A/.test(appReadme) && /so that checkout can show the first-payment day itself \(first seen in `DEPLOY\.md` 8\.4 Test A\)/.test(appReadme) &&
    /first seen in DEPLOY\.md 8\.4 Test A/.test(squash(read('app/config.js').replace(/^\s+/gm, ''))) && !/Checkout then shows that first-payment day itself/.test(squash(read('app/config.js'))));
  check('D1 app/README.md deploys expire-checkouts with the flag, says four functions use the key, and points at the SQL that schedules it',
    /supabase functions deploy expire-checkouts --no-verify-jwt/.test(appReadme) && !/supabase functions deploy expire-checkouts(?! --no-verify-jwt)/.test(appReadme) &&
    /The API key is used by four functions\./.test(appReadme) && !/used by three functions/.test(appReadme) &&
    /`expire-checkouts` uses it to list unpaid transactions and cancel the ones `create-checkout` made that nobody paid within about an hour/.test(appReadme) &&
    /Then run `supabase\/schema-expire-checkouts\.sql` in the SQL editor, after `cron\.sql`/.test(appReadme));
  const rawAppReadme = read('app/README.md');
  check('D1 app/README.md\'s list of files names the function, the SQL that schedules it, and create-checkout',
    rawAppReadme.includes('  functions/expire-checkouts/\n    index.ts            cancels those left unpaid for about an hour\n') &&
    rawAppReadme.includes('  functions/create-checkout/\n') && rawAppReadme.includes('  schema-expire-checkouts.sql\n'));
  check('D1 app/README.md deploys create-checkout with no flag, and says which two functions go without it',
    /supabase functions deploy create-checkout(?! --)/.test(appReadme) && !/deploy create-checkout --no-verify-jwt/.test(appReadme) &&
    appReadme.replace(/ > /g, ' ').includes('`--no-verify-jwt` on every function here except `manage-subscription` and `create-checkout`.'));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
