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
const CLOSES = at('2026-12-06T00:00:00+10:30');
const OPENS = at('2026-11-22T00:00:00+10:30');

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
      if (key === 'GET /rest/v1/subscriptions') return reply(200, [{ created_at: over.accountCreatedAt || '2026-11-20T10:00:00+10:30' }]);
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
     Foundation and the offer closed, for a purchase made one minute
     before. Both are judged as of the purchase. */
  const late = at('2026-12-06T00:05:00+10:30');
  webhookRoute({ accountCreatedAt: '2026-11-20T10:00:00+10:30' });
  await deliver(createdEvent({
    event_id: 'evt_test_late', occurred_at: '2026-12-05T23:59:01+10:30',
    data: { created_at: '2026-12-05T23:59:00+10:30', next_billed_at: '2026-12-19T23:59:00+10:30' },
  }), { now: late });
  const sent = claims()[0] ? JSON.parse(claims()[0].body) : {};
  check('W13 a late delivery sends the purchase instant, not the arrival', sent.p_subscribed_at === '2026-12-05T23:59:00+10:30', sent);
  const moved = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 ...and its first charge is still 1 January 2027', moved.next_billed_at === FIRST_CHARGE && moved.proration_billing_mode === 'do_not_bill', moved);

  webhookRoute({ accountCreatedAt: '2026-11-20T10:00:00+10:30' });
  await deliver(createdEvent({
    event_id: 'evt_test_after', occurred_at: '2026-12-06T00:01:01+10:30',
    data: { created_at: '2026-12-06T00:01:00+10:30', next_billed_at: '2026-12-20T00:01:00+10:30' },
  }), { now: late });
  const after = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 a purchase made after the close is charged 30 days after the account was made',
    after.next_billed_at === new Date(at('2026-11-20T10:00:00+10:30') + 30 * 86400000).toISOString(), after);

  /* The other direction: a purchase inside the window, delivered inside
     the window, is unchanged by this work. */
  webhookRoute();
  await deliver(createdEvent({ event_id: 'evt_test_inside' }));
  const inside = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W13 a purchase inside the window still gets 1 January 2027', inside.next_billed_at === FIRST_CHARGE, inside);
}

{
  /* The offer never gives less than the standard 30 days. An account
     made in the offer's last three days would reach 1 January with fewer
     than 30 days behind it, so inside the window the first charge is the
     later of the two dates. */
  const buy = (accountCreatedAt, purchasedAt, id) => {
    webhookRoute({ accountCreatedAt });
    return deliver(createdEvent({
      event_id: id, occurred_at: purchasedAt,
      data: { created_at: purchasedAt, next_billed_at: new Date(at(purchasedAt) + 14 * 86400000).toISOString() },
    }), { now: at(purchasedAt) + 5000 });
  };
  const thirty = (iso) => new Date(at(iso) + 30 * 86400000).toISOString();

  await buy('2026-12-04T09:00:00+10:30', '2026-12-05T10:00:00+10:30', 'evt_test_w17_late_account');
  const lateAccount = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W17 an account made on 4 Dec that buys on 5 Dec is charged 30 days after it was made, not on 1 January',
    lateAccount.next_billed_at === thirty('2026-12-04T09:00:00+10:30') && at(lateAccount.next_billed_at) > at(FIRST_CHARGE), lateAccount);

  await buy('2026-12-02T22:00:00+10:30', '2026-12-03T10:00:00+10:30', 'evt_test_w17_just_before');
  const justBefore = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W17 an account made just before the two dates cross still gets 1 January 2027',
    justBefore.next_billed_at === FIRST_CHARGE, justBefore);

  await buy('2026-12-02T23:00:00+10:30', '2026-12-03T10:00:00+10:30', 'evt_test_w17_just_after');
  const justAfter = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W17 ...and one made just after gets its full 30 days',
    justAfter.next_billed_at === thirty('2026-12-02T23:00:00+10:30'), justAfter);

  await buy('2026-11-22T08:00:00+10:30', '2026-11-22T09:00:00+10:30', 'evt_test_w17_first_day');
  const firstDay = patches()[0] ? JSON.parse(patches()[0].body) : {};
  check('W17 an account made on the first day still gets 1 January 2027', firstDay.next_billed_at === FIRST_CHARGE, firstDay);

  const cases = ['2026-09-07T10:00:00+10:30', '2026-11-22T00:00:00+10:30', '2026-12-01T12:00:00+10:30', '2026-12-05T23:00:00+10:30'];
  let neverEarlier = true;
  for (let i = 0; i < cases.length; i++) {
    const bought = at(cases[i]) > at('2026-11-22T00:00:00+10:30') ? new Date(at(cases[i]) + 60000).toISOString() : '2026-11-23T10:00:00+10:30';
    await buy(cases[i], bought, 'evt_test_w17_sweep_' + i);
    const p = patches()[0] ? JSON.parse(patches()[0].body) : {};
    if (!(at(p.next_billed_at) >= at(FIRST_CHARGE) && at(p.next_billed_at) >= at(cases[i]) + 30 * 86400000)) neverEarlier = false;
  }
  check('W17 inside the window nobody is charged before 1 January 2027 or before their 30 days', neverEarlier);
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
const WEBHOOK_END = (WEBHOOK_SOURCE.match(/const LAUNCH_OFFER_END = Date\.parse\("([^"]+)"\)/) || [])[1];
{
  const inClaim = stamps(CLAIM_BODY);
  const inStatus = stamps(STATUS_BODY);
  check('S7 the claim function opens and closes on the settled instants',
    inClaim.length === 2 && inClaim.includes(OPENS) && inClaim.includes(CLOSES), inClaim);
  check('S7 the status function uses the same two', inStatus.length === 2 && inStatus.includes(OPENS) && inStatus.includes(CLOSES), inStatus);
  check('S7 paddle-webhook\'s LAUNCH_OFFER_END is the same closing instant', at(WEBHOOK_END) === CLOSES, WEBHOOK_END);
  check('S7 the claim is open from its first instant and shut at its last',
    /p_subscribed_at < c_opens or p_subscribed_at >= c_closes/.test(CLAIM_BODY));
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
  check('P6 FOUNDATION_CLOSES is the end of 5 December 2026 in Adelaide', ctx.FOUNDATION_CLOSES === CLOSES, ctx.FOUNDATION_CLOSES);
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
    hooks.every((m) => /^\W{0,3}subscribe by 5 December 2026 \(Adelaide time\) while your free trial is running and your first payment is taken from 1 January 2027\./i.test(text.slice(m.index + m[0].length))),
    hooks.map((m) => text.slice(m.index, m.index + 120)));
  check('P13 ' + name + ' names the offer', text.includes('Black Friday Launch Offer'));
  const metas = [...html.matchAll(/<meta name="description" content="([^"]*)"/g)].map((m) => m[1]);
  check('P13 ' + name + ': the description gives the hook with its date too',
    metas.every((m) => !/pay nothing until 2027/i.test(m) || /pay nothing until 2027\W{1,3}subscribe by 5 December 2026 \(Adelaide time\) while your free trial is running and your first payment is taken from 1 January 2027\./i.test(m)), metas);
}

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
  check('P16 terms.html names the offer and keeps its two dates and its condition, hidden in the Play app',
    /<span data-hide-in-play>The offer running now is the Black Friday Launch Offer: subscribe by <strong>5 December 2026<\/strong> \(Adelaide time\) while your free trial is running and your first payment is taken from <strong>1 January 2027<\/strong>\.<\/span>/.test(squash(terms)));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
