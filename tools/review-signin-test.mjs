#!/usr/bin/env node
/* ============================================================
   Store-review sign-in tests -- the review-signin edge function,
   the one line it needed in signin, and the browser fallback that
   reaches it.

   Written after Google Play turned the review account down on
   9 Oct 2026: the reviewer reached the emailed-code box and had no
   inbox to read. The fix gives that one account a fixed code. What
   matters most here is the other direction -- that nobody ELSE's
   sign-in changes, and that the code cannot be turned into anything
   more than one sign-in to one account -- so most of these checks are
   about paths that are not the reviewer's.

   Both functions run for real under Node's type stripping, with Deno
   and fetch stubbed, the way tools/calendar-sync-test.mjs does it --
   except that each is evaluated afresh rather than imported, because
   these functions read their secrets once at load and some checks need
   several configurations. Node caches an imported .ts file by its path,
   query string or not, so a second import would quietly test the first
   configuration again.

   The browser half loads the real scripts in index.html order into a
   vm sandbox, the way tools/smoke.js does, with fetch answered
   in-process. Nothing here touches the network or a real project.

   The address and code below are test values. The real ones are
   Supabase secrets and are never in this repository.

   Run: node --experimental-strip-types tools/review-signin-test.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

const REVIEW_EMAIL = 'reviewer@example.test';
const REVIEW_CODE = '4815162342';
const USER_ID = '0b5ad7c1-3f42-4d4e-9a51-6f1e2c3d4b5a';
const OLD_ID = '9e1f0c2d-7a6b-4c5d-8e9f-0a1b2c3d4e5f';
const SESSION = {
  access_token: 'review-access', token_type: 'bearer', expires_in: 3600,
  expires_at: 1, refresh_token: 'review-refresh', user: { id: USER_ID, email: REVIEW_EMAIL },
};
const BASE_ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
};

/* ─────────────────────── Edge function harness ─────────────────────── */

const ENV = {};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

const quiet = { log() {}, warn() {}, error() {} };

let calls = [];
let route = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const call = { url, path: new URL(url).pathname, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body };
  calls.push(call);
  const answer = route && await route(call);
  if (!answer) throw new Error('unexpected fetch: ' + call.method + ' ' + url);
  return answer;
};

const reply = (status, body) => new Response(
  status === 204 || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  { status, headers: { 'Content-Type': 'application/json' } },
);

/* Module-level constants read the environment at load, so each
   configuration gets its own evaluation of the file. The functions'
   console goes nowhere, so a passing run prints one line. */
function load(fn, env) {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, BASE_ENV, env);
  handler = null;
  const file = path.join(ROOT, 'supabase', 'functions', fn, 'index.ts');
  const js = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  vm.runInThisContext('(function (console) {\n' + js + '\n})', { filename: file })(quiet);
  if (typeof handler !== 'function') throw new Error(fn + ' did not register a handler');
  return handler;
}

function post(h, body, headers = {}) {
  calls = [];
  return h(new Request('https://proj.supabase.co/functions/v1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

const marked = (id = USER_ID) => ({ id, email: REVIEW_EMAIL, app_metadata: { provider: 'email', review_account: true } });

/* Answers every call review-signin makes when all is well. Each part
   can be swapped out per test. `earlier` is how many attempts this IP
   already has in the hour, not counting the one being made. */
function reviewRoute(over = {}) {
  const state = { minted: 0, verified: 0, upserts: [], claimed: [], released: [], created: [], removed: [], passwords: [], nextId: 100 };
  route = async (c) => {
    if (c.path === '/rest/v1/signin_attempts' && c.method === 'POST') {
      if (over.claim) return over.claim(c);
      const row = { id: state.nextId++, ...JSON.parse(c.body) };
      state.claimed.push(row);
      return reply(201, [row]);
    }
    if (c.path === '/rest/v1/signin_attempts' && c.method === 'GET') {
      if (over.count) return over.count(c);
      return reply(200, Array.from({ length: (over.earlier || 0) + state.claimed.length - state.released.length }, (_, i) => ({ id: i })));
    }
    if (c.path === '/rest/v1/signin_attempts' && c.method === 'DELETE') {
      state.released.push(c.url);
      return reply(204);
    }
    if (c.path === '/auth/v1/admin/users' && c.method === 'POST') {
      state.created.push(JSON.parse(c.body));
      return over.create ? over.create(c, state) : reply(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
    }
    if (c.path.startsWith('/auth/v1/admin/users/') && c.method === 'DELETE') {
      state.removed.push(c.path.split('/').pop());
      return over.remove ? over.remove(c) : reply(200, {});
    }
    if (c.path.startsWith('/auth/v1/admin/users/') && c.method === 'PUT') {
      state.passwords.push({ id: c.path.split('/').pop(), body: JSON.parse(c.body) });
      return over.password ? over.password(c) : reply(200, marked());
    }
    if (c.path === '/auth/v1/admin/generate_link' && c.method === 'POST') {
      state.minted++;
      const user = over.user ? over.user(state) : marked();
      return over.generate ? over.generate(c, state) : reply(200, {
        ...user, action_link: 'https://x', hashed_token: 'h',
        email_otp: '9000000' + state.minted, verification_type: 'magiclink', redirect_to: 'https://x',
      });
    }
    if (c.path === '/rest/v1/subscriptions' && c.method === 'POST') {
      state.upserts.push({ url: c.url, headers: c.headers, body: JSON.parse(c.body) });
      return over.upsert ? over.upsert(c) : reply(201, '');
    }
    if (c.path === '/auth/v1/verify' && c.method === 'POST') {
      state.verified++;
      return over.verify ? over.verify(c, state) : reply(200, SESSION);
    }
    return undefined;
  };
  return state;
}

const paths = () => calls.map((c) => c.method + ' ' + c.path);
const authPaths = () => paths().filter((p) => p.includes('/auth/') || p.includes('/subscriptions'));

/* ─────────────────────────── review-signin ─────────────────────────── */

const review = load('review-signin', { REVIEW_EMAIL: '  Reviewer@Example.test ', REVIEW_CODE: REVIEW_CODE });

{
  route = null;
  calls = [];
  const pre = await review(new Request('https://x/', { method: 'OPTIONS' }));
  check('review: OPTIONS answers 204 with CORS', pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === '*');
  const get = await review(new Request('https://x/', { method: 'GET' }));
  check('review: GET is refused', get.status === 405);
  const bad = await post(review, '{not json');
  check('review: malformed JSON is a 400', bad.status === 400);
  check('review: none of those touched anything', calls.length === 0, paths());
}

{
  // Another address, whatever the code: refused before any I/O.
  reviewRoute();
  const r = await post(review, { email: 'someone@gmail.com', code: '1234567890' });
  check('review: any other address is a plain 401', r.status === 401);
  const body = await r.json();
  check('review: ...not marked as a review answer, so the browser keeps Supabase\'s message', body.review === undefined, body);
  check('review: ...and nothing is read, written or minted for it', calls.length === 0, paths());
  reviewRoute();
  const s = await post(review, { email: 'someone@gmail.com', code: REVIEW_CODE });
  check('review: the review code on another address is refused the same way', s.status === 401 && calls.length === 0, paths());
}

{
  const state = reviewRoute();
  const r = await post(review, { email: REVIEW_EMAIL, code: '1111111111' });
  check('review: a wrong code for the review address is a 401', r.status === 401);
  check('review: ...that mints nothing', authPaths().length === 0, paths());
  check('review: ...counted before the code was looked at, and left counted', state.claimed.length === 1 && state.released.length === 0, state);
  const row = state.claimed[0] || {};
  check('review: ...under hashes, never the raw IP', !JSON.stringify(row).includes('203.0.113.7') && /^[0-9a-f]{64}$/.test(row.ip_hash || '') && /^[0-9a-f]{64}$/.test(row.email_hash || ''), row);
  const claim = calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/signin_attempts') || { headers: {} };
  check('review: ...written so its id comes back', /return=representation/.test(claim.headers.Prefer || ''), claim.headers);
}

{
  // The per-IP hash must not be signin's plain hash of the IP, or a
  // reviewer's typos would spend that IP's sign-in email budget.
  const state = reviewRoute();
  await post(review, { email: REVIEW_EMAIL, code: '1111111111' });
  const plain = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('203.0.113.7')))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const row = state.claimed[0] || {};
  check('review: attempts do not count against signin\'s per-IP limit', row.ip_hash && row.ip_hash !== plain, row);
  const count = calls.find((c) => c.method === 'GET' && c.path === '/rest/v1/signin_attempts');
  check('review: the throttle counts only this IP\'s review attempts', count && row.ip_hash && count.url.includes('email_hash=eq.' + row.email_hash) && count.url.includes('ip_hash=eq.' + row.ip_hash), count && count.url);
  const order = paths().filter((p) => p.includes('signin_attempts'));
  check('review: written first, counted second', order.join(' | ') === 'POST /rest/v1/signin_attempts | GET /rest/v1/signin_attempts', order);
}

{
  reviewRoute({ earlier: 10 });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  const body = await r.json();
  check('review: ten attempts already this hour from one IP is a 429, even with the right code', r.status === 429 && body.review === true, body);
  check('review: ...and mints nothing', authPaths().length === 0, paths());
}

{
  reviewRoute({ earlier: 9 });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: nine earlier failures still lets the right code in', r.status === 200);
}

{
  reviewRoute({ count: () => reply(500, { message: 'down' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  const body = await r.json();
  check('review: a throttle that cannot count fails closed, with a message for the reviewer', r.status === 503 && body.review === true, body);
  check('review: ...and mints nothing', authPaths().length === 0, paths());
}

{
  reviewRoute({ claim: () => reply(500, { message: 'read-only' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a throttle that cannot write fails closed before the code is checked', r.status === 503 && authPaths().length === 0, paths());
  reviewRoute({ claim: () => reply(500, { message: 'read-only' }) });
  const w = await post(review, { email: REVIEW_EMAIL, code: '1111111111' });
  check('review: ...so a right and a wrong guess get the same answer', w.status === 503);
}

{
  const state = reviewRoute();
  const r = await post(review, { email: '  REVIEWER@example.TEST ', code: ' 48151-62342 ' }, { 'user-agent': 'ReviewerPhone/1.0' });
  const body = await r.json();
  check('review: the right code signs in, whatever the case, spaces or hyphen', r.status === 200, body);
  check('review: ...returning the session the browser adopts', body.access_token === 'review-access' && body.refresh_token === 'review-refresh' && body.expires_in === 3600 && body.user && body.user.id === USER_ID, body);
  check('review: ...and nothing else from Supabase\'s answer', Object.keys(body).sort().join() === 'access_token,expires_in,refresh_token,token_type,user', Object.keys(body));
  check('review: a right code takes its attempt back out', state.released.length === 1 && state.released[0].endsWith('id=eq.' + state.claimed[0].id), state.released);
  check('review: steps run in order: account, code, Premium, password, session',
    authPaths().join(' | ') ===
      'POST /auth/v1/admin/users | POST /auth/v1/admin/generate_link | POST /rest/v1/subscriptions | PUT /auth/v1/admin/users/' + USER_ID + ' | POST /auth/v1/verify', authPaths());

  const made = state.created[0] || {};
  check('review: the account is made confirmed and marked, for the configured address only', made.email === REVIEW_EMAIL && made.email_confirm === true && made.app_metadata && made.app_metadata.review_account === true, made);
  check('review: a marked account is kept', state.removed.length === 0, state.removed);
  for (const c of calls.filter((x) => x.path.startsWith('/auth/v1/admin') || x.path.startsWith('/rest/'))) {
    check('review: service key on ' + c.method + ' ' + c.path, c.headers.apikey === 'service-key' && c.headers.Authorization === 'Bearer service-key', c.headers);
  }
  const mint = calls.find((c) => c.path === '/auth/v1/admin/generate_link') || { body: '{}' };
  check('review: a magic-link code is minted for the review address', JSON.parse(mint.body).type === 'magiclink' && JSON.parse(mint.body).email === REVIEW_EMAIL, mint.body);

  const up = state.upserts[0] || { url: '', headers: {}, body: {} };
  check('review: Premium is an upsert on user_id that overwrites a trial row', up.url.endsWith('/rest/v1/subscriptions?on_conflict=user_id') && /resolution=merge-duplicates/.test(up.headers.Prefer), up);
  check('review: ...complimentary, active, and never ending', up.body.user_id === USER_ID && up.body.status === 'active' && up.body.plan === 'complimentary' && up.body.complimentary === true && up.body.current_period_end === null, up.body);

  const pw = state.passwords[0] || { body: {} };
  check('review: the password is replaced, on this account only, with a long random one', pw.id === USER_ID && typeof pw.body.password === 'string' && pw.body.password.length >= 40 && Object.keys(pw.body).join() === 'password', pw);
  check('review: ...that never leaves the function', !JSON.stringify(body).includes(pw.body.password || '~none~'));

  const verify = calls.find((c) => c.path === '/auth/v1/verify') || { headers: {}, body: '{}' };
  const vb = JSON.parse(verify.body);
  check('review: the session comes from the same /verify call the browser makes', vb.type === 'email' && vb.email === REVIEW_EMAIL && vb.token === '90000001', vb);
  check('review: ...with the public key, not the service key', verify.headers.apikey === 'anon-key' && !verify.headers.Authorization, verify.headers);
  check('review: ...naming the reviewer\'s device', verify.headers['User-Agent'] === 'ReviewerPhone/1.0', verify.headers);
  check('review: the code is never sent anywhere', !calls.some((c) => (c.body || '').includes(REVIEW_CODE) || c.url.includes(REVIEW_CODE)), paths());
}

{
  const state = reviewRoute();
  await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a different password every sign-in', state.passwords.length === 2 && state.passwords[0].body.password !== state.passwords[1].body.password);
}

{
  // A reviewer tested Delete account. The next sign-in makes it again.
  const state = reviewRoute({ create: () => reply(200, marked()) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a deleted review account is recreated and signed in', r.status === 200 && state.removed.length === 0, state.removed);
}

{
  // Someone registered the address, with a password of their own, while a
  // reviewer's deletion left it free. Or it is the account from before
  // this function existed. Either way it has no mark.
  const state = reviewRoute({ user: (s) => (s.minted === 1 ? { id: OLD_ID, email: REVIEW_EMAIL, app_metadata: { provider: 'email' } } : marked()) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: an account this function did not make is replaced before anything is handed out', r.status === 200 && state.removed.length === 1 && state.removed[0] === OLD_ID, state.removed);
  check('review: ...then made again, marked, and minted afresh',
    authPaths().slice(0, 5).join(' | ') === 'POST /auth/v1/admin/users | POST /auth/v1/admin/generate_link | DELETE /auth/v1/admin/users/' + OLD_ID + ' | POST /auth/v1/admin/users | POST /auth/v1/admin/generate_link', authPaths());
  check('review: ...and the old account is never given Premium, a password or a session',
    state.upserts.every((u) => u.body.user_id === USER_ID) && state.passwords.every((p) => p.id === USER_ID) && JSON.parse(calls.find((c) => c.path === '/auth/v1/verify').body).token === '90000002', state);
}

{
  const state = reviewRoute({ user: () => ({ id: OLD_ID, email: REVIEW_EMAIL, app_metadata: {} }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: if the replacement still has no mark, nothing is handed out', r.status === 502 && state.verified === 0 && state.upserts.length === 0, state);
}

{
  const state = reviewRoute({ user: () => ({ id: OLD_ID, email: REVIEW_EMAIL }), remove: () => reply(500, { msg: 'nope' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: if the old account cannot be removed, nothing is handed out', r.status === 502 && state.verified === 0, state);
}

{
  reviewRoute({ create: () => reply(500, { msg: 'Database error creating new user' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  const body = await r.json();
  check('review: a failed create is a 502 the browser will show', r.status === 502 && body.review === true && /review account/.test(body.error), body);
  check('review: ...and stops there', !paths().includes('POST /auth/v1/admin/generate_link'), paths());
}

{
  reviewRoute({ generate: () => reply(200, { id: USER_ID, app_metadata: { review_account: true } }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a mint answer with no code in it is a 502', r.status === 502);
}

{
  // supabase-js reshapes this answer; the raw API does not. Accept both.
  reviewRoute({ generate: () => reply(200, { user: { id: USER_ID, app_metadata: { review_account: true } }, properties: { email_otp: '77777777' } }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  const v = calls.find((c) => c.path === '/auth/v1/verify');
  check('review: the nested answer shape is read too', r.status === 200 && v && JSON.parse(v.body).token === '77777777');
}

{
  const state = reviewRoute({ upsert: () => reply(400, { message: 'bad column' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: if Premium cannot be written, no session is handed out', r.status === 502 && state.verified === 0);
}

{
  const state = reviewRoute({ password: () => reply(422, { msg: 'weak_password' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: if the password cannot be replaced, no session is handed out', r.status === 502 && state.verified === 0);
}

{
  // Two reviewers at once: the second mint replaces the first code.
  const state = reviewRoute({
    verify: (c, s) => (s.verified === 1 ? reply(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' }) : reply(200, SESSION)),
  });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a code replaced by a second reviewer is minted again once', r.status === 200 && state.minted === 2 && state.verified === 2, state);
  check('review: ...writing Premium and the password only once', state.upserts.length === 1 && state.passwords.length === 1);
  const second = calls.filter((c) => c.path === '/auth/v1/verify')[1];
  check('review: ...and verifying the newer code', second && JSON.parse(second.body).token === '90000002');
}

{
  const state = reviewRoute({ verify: () => reply(403, { error_code: 'otp_expired' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: refused twice gives up with a 502', r.status === 502 && state.minted === 2 && state.verified === 2, state);
}

{
  reviewRoute({ verify: () => reply(200, { user: {} }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a verify answer without a session is a 502', r.status === 502);
}

{
  reviewRoute({ verify: () => reply(429, { msg: 'rate limit' }) });
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE });
  check('review: a rate-limited verify is a 502, not a retry loop', r.status === 502 && calls.filter((c) => c.path === '/auth/v1/verify').length === 1);
}

{
  reviewRoute();
  const r = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE + '0' });
  const s = await post(review, { email: REVIEW_EMAIL, code: REVIEW_CODE.slice(0, 9) });
  const t = await post(review, { email: REVIEW_EMAIL });
  const u = await post(review, { email: REVIEW_EMAIL, code: 4815162342 });
  check('review: longer, shorter, missing and non-string codes are all refused', [r, s, t, u].every((x) => x.status === 401), [r.status, s.status, t.status, u.status]);
}

/* Configurations that must switch the function off entirely. */
for (const [label, env] of [
  ['no code set', { REVIEW_EMAIL }],
  ['no address set', { REVIEW_CODE }],
  ['an eight-digit code', { REVIEW_EMAIL, REVIEW_CODE: '48151623' }],
  ['a code with letters', { REVIEW_EMAIL, REVIEW_CODE: '48151623ab' }],
  ['an address that is not one', { REVIEW_EMAIL: 'reviewer', REVIEW_CODE }],
]) {
  const h = load('review-signin', env);
  reviewRoute();
  const r = await post(h, { email: env.REVIEW_EMAIL || REVIEW_EMAIL, code: env.REVIEW_CODE || REVIEW_CODE });
  check('review: off with ' + label, r.status === 401 && calls.length === 0, [r.status, paths()]);
}

/* ─────────────────────────────── signin ─────────────────────────────── */

function signinRoute() {
  const seen = { otp: 0, siteverify: 0 };
  route = async (c) => {
    if (c.url.startsWith('https://challenges.cloudflare.com/')) { seen.siteverify++; return reply(200, { success: true, action: 'signin' }); }
    if (c.path === '/rest/v1/signin_attempts' && c.method === 'GET') return reply(200, []);
    if (c.path === '/rest/v1/signin_attempts' && c.method === 'POST') return reply(201, '');
    if (c.path === '/auth/v1/otp') { seen.otp++; return reply(200, {}); }
    return undefined;
  };
  return seen;
}

const signin = load('signin', { TURNSTILE_SECRET_KEY: 'ts-secret', REVIEW_EMAIL });

{
  signinRoute();
  const r = await post(signin, { email: ' Reviewer@Example.test', turnstileToken: '' });
  const body = await r.json();
  check('signin: the review address gets the usual answer', r.status === 200 && body.ok === true && Object.keys(body).join() === 'ok', body);
  check('signin: ...and nothing is emailed, checked or counted', calls.length === 0, paths());
}

{
  const seen = signinRoute();
  const r = await post(signin, { email: 'someone@gmail.com', turnstileToken: 'tok' });
  check('signin: everyone else still gets the bot check, the throttle and a real email', r.status === 200 && seen.siteverify === 1 && seen.otp === 1 &&
    paths().includes('GET /rest/v1/signin_attempts') && paths().includes('POST /rest/v1/signin_attempts'), paths());
}

{
  signinRoute();
  const r = await post(signin, { email: 'someone@gmail.com', turnstileToken: '' });
  check('signin: everyone else without a bot-check token is still refused', r.status === 403 && !paths().includes('POST /auth/v1/otp'), paths());
}

{
  const plain = load('signin', { TURNSTILE_SECRET_KEY: 'ts-secret' });
  const seen = signinRoute();
  const r = await post(plain, { email: REVIEW_EMAIL, turnstileToken: 'tok' });
  check('signin: with no review address set, that address is just an address', r.status === 200 && seen.otp === 1, paths());
}

/* ─────────────────────────── The browser half ─────────────────────────── */

/* index.html's order, up to the file that supplies the fallback. */
const CLIENT = [
  'identity/identity.js', 'identity/email-typos.js', 'identity/entitlements.js',
  'identity/identity-ui.js', 'app/config.js', 'app/identity-bridge.js', 'app/supabase.js',
];

function element() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, setAttribute() {},
    getAttribute: () => null, querySelector: () => element(), querySelectorAll: () => [],
  };
}

/* A clock that runs a second per look, so the bridge's few seconds of
   waiting for a bot-check token pass in no time at all. */
function fastDate() {
  let now = Date.UTC(2026, 9, 10);
  return class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return (now += 1000); }
  };
}

/* answer(url, init) returns {status, body} or throws, standing in for the network. */
function browser(answer, files = CLIENT) {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const seen = [];
  const win = {
    document: { addEventListener() {}, createElement: () => element(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: element(), documentElement: element() },
    localStorage: storage, sessionStorage: storage,
    location: { origin: 'https://pietimers.aibhlinn.ai', pathname: '/', search: '', hash: '', assign() {} },
    history: { replaceState() {} },
    navigator: { userAgent: 'test' },
    fetch: (url, init = {}) => {
      seen.push({ url: String(url), init });
      return Promise.resolve().then(() => answer(String(url), init) || { status: 599, body: 'unexpected request' }).then((a) => ({
        ok: a.status >= 200 && a.status < 300,
        status: a.status,
        text: () => Promise.resolve(a.body === undefined ? '' : (typeof a.body === 'string' ? a.body : JSON.stringify(a.body))),
      }));
    },
    /* Short waits (the bot-check polling) run at once; long ones (the
       session refresh, an hour out) never run at all. */
    setTimeout: (fn, ms) => (ms > 1000 ? 0 : setTimeout(fn, 0)), clearTimeout: (t) => (t ? clearTimeout(t) : undefined),
    console: quiet, Promise, URLSearchParams, Date: fastDate(), Math, JSON, Object, Array, String, Number, Error, RegExp,
    addEventListener() {},
  };
  win.window = win;
  vm.createContext(win);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  return { win, seen, identity: win.Aibhlinn.identity };
}

const REFUSED = { status: 403, body: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' } };
const isVerify = (u) => u.endsWith('/auth/v1/verify');
const isReview = (u) => u.endsWith('/functions/v1/review-signin');
const isSignin = (u) => u.endsWith('/functions/v1/signin');
const isOtp = (u) => u.endsWith('/auth/v1/otp');

async function outcome(promise) {
  try { return { ok: true, value: await promise }; } catch (err) { return { ok: false, err }; }
}

{
  const b = browser((u) => (isVerify(u) ? { status: 200, body: { access_token: 'real', refresh_token: 'r', expires_in: 3600, user: { id: 'u1' } } } : null));
  const o = await outcome(b.identity.verifyEmailOtp('person@gmail.com', '1234 5678'));
  check('browser: a right emailed code signs in as before', o.ok && b.identity.isSignedIn() && b.identity.getSession().access_token === 'real');
  check('browser: ...and makes no other request', b.seen.length === 1, b.seen.map((s) => s.url));
}

{
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 200, body: SESSION }));
  const o = await outcome(b.identity.verifyEmailOtp('person@gmail.com', '1234 5679'));
  check('browser: a wrong emailed code says what Supabase said', !o.ok && o.err.message === 'Token has expired or is invalid', o.err && o.err.message);
  check('browser: ...stays signed out', !b.identity.isSignedIn());
  check('browser: ...and never leaves for the review function, being eight digits', !b.seen.some((s) => isReview(s.url)), b.seen.map((s) => s.url));
}

{
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 200, body: SESSION }));
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, '48151623'));
  check('browser: even on the review address, a code that is not ten digits stops at Supabase', !o.ok && !b.seen.some((s) => isReview(s.url)));
}

{
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 401, body: { error: 'That code is not valid.' } }));
  const o = await outcome(b.identity.verifyEmailOtp('person@gmail.com', '1234567890'));
  check('browser: a ten-digit code on another address is asked about, then Supabase\'s message stands', !o.ok && o.err.message === 'Token has expired or is invalid' && b.seen.some((s) => isReview(s.url)), o.err && o.err.message);
}

for (const [label, ans] of [
  ['not deployed (404)', { status: 404, body: { code: 'NOT_FOUND', message: 'Requested function was not found' } }],
  ['failing to start (503, not JSON)', { status: 503, body: 'BOOT_ERROR' }],
  ['a platform 546', { status: 546, body: { code: 'WORKER_RESOURCE_LIMIT' } }],
  ['a 500 without the review mark', { status: 500, body: { error: 'Internal' } }],
]) {
  const b = browser((u) => (isVerify(u) ? REFUSED : ans));
  const o = await outcome(b.identity.verifyEmailOtp('person@gmail.com', '1234567890'));
  check('browser: review function ' + label + ' leaves Supabase\'s message alone', !o.ok && o.err.message === 'Token has expired or is invalid', o.err && o.err.message);
}

{
  const b = browser((u) => {
    if (isVerify(u)) throw new TypeError('Failed to fetch');
    return { status: 200, body: SESSION };
  });
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('browser: offline, the code goes nowhere else', !o.ok && o.err.message === 'Failed to fetch' && !b.seen.some((s) => isReview(s.url)), b.seen.map((s) => s.url));
}

{
  const b = browser((u) => (isVerify(u) ? { status: 500, body: { msg: 'oops' } } : { status: 200, body: SESSION }));
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('browser: a Supabase outage (5xx) does not fall through', !o.ok && !b.seen.some((s) => isReview(s.url)) && !b.identity.isSignedIn());
}

{
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 200, body: SESSION }));
  const o = await outcome(b.identity.verifyEmailOtp(`  ${REVIEW_EMAIL} `, ' 48151 62342 '));
  check('browser: the reviewer is signed in by the fallback', o.ok && b.identity.isSignedIn() && b.identity.getSession().access_token === 'review-access', o.err && o.err.message);
  check('browser: ...with the user kept, which sync needs for its first push', b.identity.getUser() && b.identity.getUser().id === USER_ID);
  const call = b.seen.find((s) => isReview(s.url));
  const sent = call && JSON.parse(call.init.body);
  check('browser: ...sending the trimmed address and the code without spaces', sent && sent.email === REVIEW_EMAIL && sent.code === REVIEW_CODE, sent);
  check('browser: ...with the public key and no session', call && call.init.headers.apikey && !call.init.headers.Authorization, call && call.init.headers);
  check('browser: ...to this project', call && call.url === b.win.CT.config.supabaseUrl + '/functions/v1/review-signin', call && call.url);
  check('browser: ...after Supabase first', b.seen.findIndex((s) => isVerify(s.url)) < b.seen.findIndex((s) => isReview(s.url)));
  check('browser: ...and the session is stored', /review-access/.test(b.win.localStorage.getItem('aibhlinn/session/v1') || ''));
}

{
  const b = browser((u) => (isVerify(u) ? { status: 429, body: { msg: 'Too many requests' } } : { status: 200, body: SESSION }));
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('browser: Supabase rate-limiting the reviewer still reaches the fallback', o.ok && b.identity.isSignedIn());
}

for (const [label, ans] of [
  ['throttled', { status: 429, body: { error: 'Too many wrong codes. Please try again in an hour.', review: true } }],
  ['unable to count', { status: 503, body: { error: 'Could not sign in to the review account. Please try again in a minute.', review: true } }],
  ['broken', { status: 502, body: { error: 'Could not sign in to the review account. Please try again in a minute.', review: true } }],
]) {
  const b = browser((u) => (isVerify(u) ? REFUSED : ans));
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('browser: a ' + label + ' review sign-in shows the function\'s own message', !o.ok && o.err.message === ans.body.error, o.err && o.err.message);
}

{
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 200, body: { user: {} } }));
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('browser: a fallback answer with no session does not half sign in', !o.ok && !b.identity.isSignedIn());
}

/* The header panel's send, when the bot check never produces a token. */
function noToken(b) {
  b.win.CT.turnstile = { mount: () => Promise.resolve(true), token: () => '', reset() {} };
  return b;
}

{
  const b = noToken(browser((u) => (isSignin(u) ? { status: 200, body: { ok: true } } : { status: 200, body: {} })));
  const o = await outcome(b.identity.signInWithEmail(REVIEW_EMAIL, {}));
  check('browser: no bot-check token, review address: signin answers and nothing is emailed', o.ok && b.seen.some((s) => isSignin(s.url)) && !b.seen.some((s) => isOtp(s.url)), b.seen.map((s) => s.url));
  const sent = JSON.parse((b.seen.find((s) => isSignin(s.url)) || { init: { body: '{}' } }).init.body);
  check('browser: ...asked with an empty token', sent.turnstileToken === '' && sent.email === REVIEW_EMAIL, sent);
}

{
  const b = noToken(browser((u) => (isSignin(u) ? { status: 403, body: { error: 'Could not verify you are human. Please try again.' } } : { status: 200, body: {} })));
  const o = await outcome(b.identity.signInWithEmail('person@gmail.com', {}));
  check('browser: no bot-check token, anyone else: refused by signin, then sent the old way', o.ok && b.seen.findIndex((s) => isSignin(s.url)) < b.seen.findIndex((s) => isOtp(s.url)), b.seen.map((s) => s.url));
}

{
  const b = noToken(browser((u) => (isSignin(u) ? { status: 429, body: { error: 'Too many sign-in emails requested. Please try again in an hour.' } } : { status: 200, body: {} })));
  const o = await outcome(b.identity.signInWithEmail('person@gmail.com', {}));
  check('browser: no bot-check token, and signin says no for another reason: that answer stands', !o.ok && /Too many/.test(o.err.message) && !b.seen.some((s) => isOtp(s.url)), o.err && o.err.message);
}

{
  const b = browser((u) => (isSignin(u) ? { status: 200, body: { ok: true } } : { status: 200, body: {} }));
  b.win.CT.turnstile = { mount: () => Promise.resolve(true), token: () => 'tok', reset() {} };
  const o = await outcome(b.identity.signInWithEmail('person@gmail.com', {}));
  const sent = JSON.parse((b.seen.find((s) => isSignin(s.url)) || { init: { body: '{}' } }).init.body);
  check('browser: with a token, the send is exactly as before', o.ok && b.seen.length === 1 && sent.turnstileToken === 'tok', b.seen.map((s) => s.url));
}

{
  // identity/ on its own, as a second app would use it: no fallback at all.
  const b = browser((u) => (isVerify(u) ? REFUSED : { status: 200, body: SESSION }), ['identity/identity.js']);
  b.identity.init({ supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' });
  const o = await outcome(b.identity.verifyEmailOtp(REVIEW_EMAIL, REVIEW_CODE));
  check('identity: with no verifyCode supplied, a refusal is final', !o.ok && o.err.message === 'Token has expired or is invalid' && b.seen.length === 1, b.seen.map((s) => s.url));
}

{
  const b = browser(() => REFUSED, ['identity/identity.js']);
  b.identity.init({ supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon', verifyCode: () => { throw new Error('delegate blew up'); } });
  const o = await outcome(b.identity.verifyEmailOtp('a@b.co', '1'));
  check('identity: a delegate that throws rejects rather than hanging', !o.ok && o.err.message === 'delegate blew up');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
