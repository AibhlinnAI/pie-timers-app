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
      written either way.
   2. The SQL file still has the constraints, the lock, the revokes
      and the two grants, and its dates match the function's and the
      pages'.
   3. The pages show a number or say "open" only after a fresh,
      well-formed answer, say nothing they cannot know, and do none of
      it inside the Google Play app.

   index.ts runs for real under Node's type stripping, with Deno and
   fetch stubbed, the way tools/review-signin-test.mjs does it. The
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
const SUB_ID = 'sub_test_1';
const WEBHOOK_SECRET = 'test-webhook-secret';
const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PADDLE_API_KEY: 'test-paddle-key',
};

const at = (iso) => Date.parse(iso);
/* Foundation, and the Black Friday Launch Offer as a whole, run from the
   start of 22 Nov 2026 to the end of 31 Dec 2026, Adelaide time. (The
   close was first the end of 5 Dec; Mal moved it on 22 Nov 2026.) */
const CLOSES = at('2027-01-01T00:00:00+10:30');
const OPENS = at('2026-11-22T00:00:00+10:30');
/* The one thing that still ends at the end of 5 Dec 2026: the free
   trial of an account made before 22 Nov. Nothing in this file may
   treat it as the offer's close. */
const OLD_CLOSE = at('2026-12-06T00:00:00+10:30');

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

const WEBHOOK_FILE = path.join(ROOT, 'supabase', 'functions', 'paddle-webhook', 'index.ts');
const WEBHOOK_SOURCE = read('supabase/functions/paddle-webhook/index.ts');
vm.runInThisContext('(function (console) {\n' + stripTypeScriptTypes(WEBHOOK_SOURCE) + '\n})', { filename: WEBHOOK_FILE })(captured);
if (typeof handler !== 'function') throw new Error('paddle-webhook did not register a handler');
const webhook = handler;

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
    const response = await webhook(new Request('https://proj.supabase.co/functions/v1/paddle-webhook', {
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

/* One purchase on a trial price. Paddle's own first-payment date, the
   one its checkout showed, is 14 days after the purchase unless a case
   says otherwise. Answers what the customer ends up with: the date sent
   to Paddle when one was sent, Paddle's own date when it was left.

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
async function purchase({ account, bought, interval, shown, periodEnds }) {
  const real = typeof shown === 'string' && Number.isFinite(at(shown)) ? shown : iso(at(bought) + 14 * DAY);
  const paddleDate = shown === undefined ? real : shown;
  const period = periodEnds === undefined ? real : periodEnds;
  webhookRoute({ accountCreatedAt: account });
  const r = await deliver(createdEvent({
    event_id: 'evt_test_rule_' + (++purchaseCount), occurred_at: bought,
    data: {
      created_at: bought,
      next_billed_at: paddleDate === null ? undefined : paddleDate,
      current_billing_period: period === null ? undefined : { ends_at: period },
      billing_cycle: interval === null ? undefined : { interval },
    },
  }), { now: at(bought) + 5000 });
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
  /* W18. The first payment is never moved EARLIER than the date
     Paddle's checkout showed the customer. Paddle's trial price runs 14
     days from the purchase, so a monthly customer who subscribes on day
     10 was shown day 24, and day 21 would be earlier than that. */
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
     date checkout showed is still there, 14 days after the purchase, and
     the first payment must not land before it. The function falls back
     on the end of the billing period, then on the purchase plus 14 days,
     and with neither it moves nothing. */
  const day10bought = '2027-02-11T09:00:00+10:30';
  const day24 = at(day10bought) + 14 * DAY;
  const noDate = await purchase({ account, bought: day10bought, interval: 'month', shown: null });
  check('W18 monthly on day 10 with no next_billed_at in the payload: not moved earlier than purchase + 14 days',
    noDate.r.status === 200 && noDate.sent.length === 0 && noDate.firstPayment >= day24, noDate.sent);
  const junkMonthly = await purchase({ account, bought: day10bought, interval: 'month', shown: 'soon' });
  check('W18 ...and the same for one that does not parse', junkMonthly.sent.length === 0 && junkMonthly.firstPayment >= day24, junkMonthly.sent);
  const bare = await purchase({ account, bought: day10bought, interval: 'month', shown: null, periodEnds: null });
  check('W18 ...and with no billing period either, the purchase plus 14 days holds it',
    bare.r.status === 200 && bare.sent.length === 0 && bare.firstPayment >= day24, bare.sent);
  const bareJunk = await purchase({ account, bought: day10bought, interval: 'month', shown: 'soon', periodEnds: 'later' });
  check('W18 ...and with both unreadable', bareJunk.sent.length === 0 && bareJunk.firstPayment >= day24, bareJunk.sent);
  const inOfferBare = await purchase({ account: '2026-12-12T09:00:00+10:30', bought: '2026-12-26T08:59:00+10:30', interval: 'month', shown: null, periodEnds: null });
  check('W18 ...and during the offer: bought on day 14 with no date, never pulled back to day 21',
    inOfferBare.sent.length === 0 && inOfferBare.firstPayment === at('2027-01-09T08:59:00+10:30'), inOfferBare.sent);

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
  /* W21. The account's creation date could not be read. The first
     payment stays on Paddle's own date, which may be earlier than the
     rule gives, so it must never happen silently: the log says so, with
     no account id and no subscription id. (Whether this should answer
     500 instead, so Paddle retries, is Mal's call: DEPLOY.md 5.6.) */
  const cases = {
    'a lookup answering 500': { over: { account: () => reply(500, { message: 'no' }) }, says: 'answered 500' },
    'a lookup answering 404': { over: { account: () => reply(404, { message: 'no' }) }, says: 'answered 404' },
    'no row for the account': { over: { account: () => reply(200, []) }, says: 'no creation date on record' },
    'a row with no created_at': { over: { account: () => reply(200, [{ created_at: null }]) }, says: 'no creation date on record' },
    'a created_at that does not parse': { over: { accountCreatedAt: 'last week' }, says: 'does not parse' },
  };
  let n = 0;
  for (const [name, c] of Object.entries(cases)) {
    webhookRoute(c.over);
    const r = await deliver(createdEvent({ event_id: 'evt_test_nodate_' + (++n) }));
    const said = logs.join('\n');
    check('W21 ' + name + ': nothing is sent to Paddle and the row is not rewritten', patches().length === 0 && extensions().length === 0, keys());
    check('W21 ' + name + ': it is logged as "Could not defer first charge"', said.includes('Could not defer first charge') && said.includes(c.says), logs);
    check('W21 ' + name + ': ...without the account id or the subscription id', !said.includes(USER_ID) && !said.includes(SUB_ID), logs);
    check('W21 ' + name + ': Premium and the Foundation claim are untouched by it',
      r.status === 200 && upserts().length === 1 && claims().length === 1 && grants().length === 3 && recorded().length === 1, { r, keys: keys() });
  }

  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_nodate_ok' }));
  check('W21 a move that goes ahead logs no such line', patches().length === 1 && !logs.join('\n').includes('Could not defer first charge'), logs);
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
  const audit = async (account, bought, interval) => {
    for (const payload of PAYLOADS) await auditOne(account, bought, interval, payload);
  };
  const auditOne = async (account, bought, interval, payload) => {
    const p = await purchase({ account, bought, interval, ...payload });
    tried++;
    const days = interval === 'month' ? 21 : 30;
    const ok = p.r.status === 200 && p.sent.length <= 1 &&
      p.firstPayment >= at(FIRST_CHARGE) &&
      p.firstPayment >= at(account) + days * DAY &&
      p.firstPayment >= p.shown &&
      // Exactly the latest of the three, so nobody is held longer either.
      p.firstPayment === Math.max(at(FIRST_CHARGE), at(account) + days * DAY, p.shown) &&
      (p.movedTo === null || (p.extendedTo === p.movedTo && p.sent[0].proration_billing_mode === 'do_not_bill'));
    if (!ok) bad.push({ account, bought, interval, payload, movedTo: p.movedTo, shown: iso(p.shown) });
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
    bad.length === 0 && tried > 2700, bad.slice(0, 5));
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
  check('W15 a move Paddle refuses changes nothing on the row',
    refused.status === 200 && extensions().length === 0 && grants().length === 3 && recorded().length === 1, keys());

  webhookRoute({ extend: () => reply(500, { message: 'no' }) });
  const failed = await deliver(createdEvent({ event_id: 'evt_test_extend_fail' }));
  check('W15 a failed write of the moved date is a 500, unrecorded, so Paddle retries', failed.status === 500 && recorded().length === 0, keys());

  webhookRoute();
  const paid = await deliver(createdEvent({ event_id: 'evt_test_paid', data: { status: 'active' } }));
  check('W15 a subscription that paid on the day is not moved and not extended',
    paid.status === 200 && patches().length === 0 && extensions().length === 0, keys());
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

const stamps = (text) => [...text.matchAll(/timestamptz '([^']+)'/g)].map((m) => at(m[1].replace(' ', 'T')));
{
  const inClaim = stamps(CLAIM_BODY);
  const inStatus = stamps(STATUS_BODY);
  check('S7 the claim function opens and closes on the settled instants',
    inClaim.length === 2 && inClaim.includes(OPENS) && inClaim.includes(CLOSES), inClaim);
  check('S7 the status function uses the same two', inStatus.length === 2 && inStatus.includes(OPENS) && inStatus.includes(CLOSES), inStatus);
  check('S7 the claim is open from its first instant and shut at its last',
    /p_subscribed_at < c_opens or p_subscribed_at >= c_closes/.test(CLAIM_BODY));

  /* Foundation closes at the end of 31 December 2026 in Adelaide, the
     instant 2027-01-01T00:00+10:30, written out here so it is not only
     compared with this file's own constant. */
  check('S7 the closing instant is 2027-01-01T00:00+10:30, 40 days after opening',
    CLOSES === Date.UTC(2026, 11, 31, 13, 30) && CLOSES - OPENS === 40 * 86400000);
  check('S7 the claim function is written with that instant',
    CLAIM_BODY.includes("c_closes constant timestamptz := timestamptz '2027-01-01 00:00:00+10:30';"));
  check('S7 ...and so is the status function', STATUS_BODY.includes("now() <  timestamptz '2027-01-01 00:00:00+10:30'"));
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
  check('S7 ...the purchase time is read in two places only: the Foundation claim and the stand-in for Paddle\'s date',
    (webhookCode.match(/\bpurchasedAt\(/g) || []).length === 3 &&
    /function paddleFirstPaymentAt\([^)]*\)[^{]*\{[\s\S]*?purchasedAt\(data, event\)[\s\S]*?\n\}/.test(webhookCode) &&
    /const subscribedAt = isCreation \? purchasedAt\(data, event\) : null;/.test(webhookCode));
  check('S7 ...and Paddle\'s own next_billed_at is tried first, then the period end',
    /for \(const value of \[data\?\.next_billed_at, data\?\.current_billing_period\?\.ends_at\]\)/.test(webhookCode));
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
  check('S9 the rehearsal refuses a subscription at the closing instant, 2027-01-01T00:00+10:30',
    /'rehearsal_late', timestamptz '2027-01-01 00:00:00\+10:30'/.test(rehearsal));
  check('S9 ...gives the last place one second before it, at the end of 31 December 2026',
    (rehearsal.match(/'rehearsal_a', timestamptz '2026-12-31 23:59:59\+10:30'/g) || []).length === 2 &&
    at('2026-12-31T23:59:59+10:30') === CLOSES - 1000);
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
  check('P6 FOUNDATION_CLOSES is the end of 31 December 2026 in Adelaide, 2027-01-01T00:00+10:30',
    ctx.FOUNDATION_CLOSES === CLOSES && ctx.FOUNDATION_CLOSES === at('2027-01-01T00:00:00+10:30'), ctx.FOUNDATION_CLOSES);
  for (const [name, html] of Object.entries(PAGES)) {
    const written = (html.match(/var FOUNDATION_CLOSES = Date\.UTC\(([^)]*)\);/g) || []);
    check('P6 ' + name + ' writes that instant once, as Date.UTC(2026, 11, 31, 13, 30)',
      written.length === 1 && written[0] === 'var FOUNDATION_CLOSES = Date.UTC(2026, 11, 31, 13, 30);' &&
      Date.UTC(2026, 11, 31, 13, 30) === CLOSES, written);
    check('P6 ' + name + ' has no script date on the old close, 6 Dec 2026 00:00 +10:30',
      !/Date\.UTC\(2026, 11, 5, 13, 30\)/.test(html) && Date.UTC(2026, 11, 5, 13, 30) === OLD_CLOSE);
  }
  check('P6 the offer panel on pricing.html comes down on the same instant',
    /function renderOfferDates\(\) \{\s*var dates = \$\('offerDates'\);\s*if \(dates\) dates\.hidden = Date\.now\(\) >= FOUNDATION_CLOSES;\s*\}/.test(PRICING));
}

{
  /* P6b. The pie on foundation.html, run for real with the clock held.
     It empties across the offer, the start of 22 November to the end of
     31 December 2026 in Adelaide, 40 days, and the hook and its
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
  check('P6b ...to 1 Jan 2027 00:00 +10:30, which is 40 days', ends === '2026, 11, 31, 13, 30' && Date.UTC(2026, 11, 31, 13, 30) === CLOSES && (CLOSES - OPENS) / 86400000 === 40, ends);

  const first = pieAt(OPENS);
  check('P6b at the start: a full pie and 40 days left', first.caption === '40 days left in the offer.' && /^M 0 -37 A 37 37 0 1 1 0 37 A/.test(first.d) && first.hook && first.terms, first);
  const half = pieAt(OPENS + 20 * 86400000);
  check('P6b halfway, on 12 December: half a pie and 20 days left', half.caption === '20 days left in the offer.' && half.d === 'M 0 0 L 0.000 37.000 A 37 37 0 0 1 0 -37 Z', half);
  const oldClose = pieAt(OLD_CLOSE);
  check('P6b at the old close, the start of 6 December, the offer is still running: 26 days left, hook showing',
    oldClose.caption === '26 days left in the offer.' && oldClose.hook && oldClose.terms && oldClose.d !== '', oldClose);
  const lastDay = pieAt(CLOSES - 3600000);
  check('P6b on 31 December: the last day, hook still showing', lastDay.caption === 'Last day of the offer.' && lastDay.hook && lastDay.terms, lastDay);
  const over = pieAt(CLOSES);
  check('P6b at the closing instant: no pie, the hook and its condition come down',
    over.caption === 'The offer is over. It ran to the end of 31 December 2026 (Adelaide time).' && over.d === '' && !over.hook && !over.terms, over);
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
  check('P13 ' + name + ': the description gives the hook with its condition too',
    metas.length === 1 && metas.every((m) => !/pay nothing until 2027/i.test(m) || /pay nothing until 2027\W{1,3}subscribe while your free trial is running and your first payment is taken from 1 January 2027\./i.test(m)), metas);
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
const OLDER_ACCOUNTS = /If you made your account before 22 November 2026 \(Adelaide time\), your free trial runs to the end of 5 December 2026 \(Adelaide time\), even if an earlier trial had (already )?run out\./;
for (const [name, html] of Object.entries(PAGES)) {
  const text = reading(html);
  check('P18 ' + name + ' keeps the sentence about older accounts\' trials', OLDER_ACCOUNTS.test(text));
  check('P18 ' + name + ': that sentence is the only place 5 December appears', (text.match(/5 December/g) || []).length === 1, text.match(/.{60}5 December.{30}/g));
  const said = scripts(html).map(uncommented).join('\n');
  check('P18 ' + name + ': no script says 5 December', !/5 Dec/.test(said));
}
check('P18 terms.html does not mention 5 December at all', !/5 Dec/.test(reading(TERMS)));

/* P19. The free-time rule, in the owner's words, on both offer pages. */
const FREE_TIME = 'Every new account starts with a 14-day free trial. Subscribe while it is running and you get more free time before your first payment: 30 days from the day you made your account on a yearly plan, or 21 days on a monthly plan. No first payment is taken before 1 January 2027.';
const AFTER_TRIAL = 'If you subscribe after your trial has ended, you pay on the day you subscribe.';
const CHECKOUT_DATE = 'Checkout may show a different first-payment date. We set it to the right one shortly after you subscribe, and never to a date earlier than checkout showed you.';
const FOUNDATION_CLOSING = 'Foundation closes at the end of 31 December 2026 (Adelaide time), or sooner if all 100 places are taken.';
for (const [name, html] of Object.entries(PAGES)) {
  const text = reading(html);
  check('P19 ' + name + ' states the free-time rule', text.includes(FREE_TIME), text.match(/Every new account.{0,300}/));
  check('P19 ' + name + ': ...and straight after it, what happens once the trial has ended', text.includes(FREE_TIME + ' ' + AFTER_TRIAL));
  check('P19 ' + name + ' says checkout may show a different date, never moved earlier', text.includes(CHECKOUT_DATE));
  check('P19 ' + name + ' says when Foundation closes', text.includes(FOUNDATION_CLOSING));
  check('P19 ' + name + ': the old rule is gone', !/30 days after (you|the day you) (made|signed)|whichever plan you pick|Premium stays free until 31 December/i.test(text));
  const carrier = scripts(html).find((js) => js.includes('foundation-status:begin')) || '';
  check('P19 ' + name + ': what the script says about the close is the end of 31 December 2026 (Adelaide time)',
    uncommented(carrier).includes('Foundation has closed. It ran to the end of 31 December 2026 (Adelaide time).'));
}
check('P19 pricing.html: the line it writes when the count cannot be read says the same close',
  PRICING.includes("setFoundationLine('Foundation has 100 places. " + FOUNDATION_CLOSING + ' We could not check how many places are left just now.\');'));
check('P19 pricing.html: the open line asks for a subscription by the end of 31 December 2026 (Adelaide time)',
  PRICING.includes("' of 100 places left. Subscribe by the end of 31 December 2026 (Adelaide time) while a place is left and you keep the price you subscribe at."));
check('P19 foundation.html: who can join is the first 100 by the end of 31 December 2026 (Adelaide time)',
  reading(FOUNDATION).includes('The first 100 people to subscribe by the end of 31 December 2026 (Adelaide time).'));
check('P19 foundation.html: the card says how long the offer runs',
  /<p class="launch-caption" id="launchCaption">The offer runs to the end of 31 December 2026 \(Adelaide time\)\.<\/p>/.test(FOUNDATION));
check('P19 pricing.html: the panel says how long the offer runs',
  reading(PRICING).includes('Pay nothing until 2027 Subscribe while your free trial is running and your first payment is taken from 1 January 2027. The offer runs to the end of 31 December 2026 (Adelaide time).'));

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
  check('P16 terms.html names the offer and keeps its date and its condition, hidden in the Play app',
    /<span data-hide-in-play>The offer running now is the Black Friday Launch Offer: subscribe while your free trial is running and your first payment is taken from <strong>1 January 2027<\/strong>\. The offer runs to the end of 31 December 2026 \(Adelaide time\)\.<\/span>/.test(squash(terms)));
  const termsText = reading(terms);
  check('P16 terms.html says the offer sets a date no first payment is taken before, not one date for everyone',
    termsText.includes('During a launch or promotional period, no first payment is taken before a date announced with that offer. If your own 30 or 21 days end later than that date, they still apply.') &&
    !/may instead fall|the same date for everyone/i.test(termsText));
  check('P16 ...and that subscribing during the trial never shortens the trial\'s own free time',
    termsText.includes('Either way, subscribing during your trial never shortens the free time your trial gave you.') &&
    !/subscribing early never costs/i.test(termsText));
  check('P19 terms.html says checkout may show a different date, never moved earlier, hidden in the Play app',
    termsText.includes(CHECKOUT_DATE) && /<p data-hide-in-play>Checkout may show a different first-payment date\./.test(squash(terms)) &&
    !/We move that date back|earlier first-payment date than/i.test(termsText));
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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
