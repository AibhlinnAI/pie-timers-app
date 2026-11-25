/* ============================================================
   Which sites may call signin and create-checkout.

   Run: node tools/origin-test.mjs

   Both functions take a list of allowed sites (ALLOWED_ORIGINS, with
   the older single ALLOWED_ORIGIN still counted). This file runs each
   index.ts for real, under Node's type stripping with Deno and fetch
   replaced, once per setting, and checks:

     - the answer echoes the caller's Origin only when that origin is
       on the list, and says "Vary: Origin";
     - the old single setting alone still works, so the existing
       checkout cannot break while the new setting is being put in;
     - signin accepts a Turnstile token minted for either site;
     - signin uses the page's redirect address only when that address
       is on an allowed site, judged on the whole origin.

   Nothing here touches the network.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIE = 'https://pietimers.aibhlinn.ai';
const PREMIUM = 'https://premium.aibhlinn.ai';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.log('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

/* Loads one function with the given settings and answers its handler.
   `net` stands in for fetch and records what was asked. */
function load(name, env, net) {
  const file = path.join(ROOT, 'supabase', 'functions', name, 'index.ts');
  const code = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
  let handler = null;
  const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon', ...env };
  const context = vm.createContext({
    Deno: { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } },
    fetch: net || (async () => new Response('{}', { status: 500 })),
    console: { log() {}, warn() {}, error() {} },
    Request, Response, Headers, URL, FormData, TextEncoder, crypto, Date, JSON, Set, Object, Promise,
  });
  vm.runInContext(code, context, { filename: name + '/index.ts' });
  return handler;
}

async function call(handler, { method = 'OPTIONS', origin, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin !== undefined) headers.Origin = origin;
  const response = await handler(new Request('https://proj.supabase.co/functions/v1/x', {
    method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  }));
  return {
    status: response.status,
    allow: response.headers.get('Access-Control-Allow-Origin'),
    vary: response.headers.get('Vary'),
    methods: response.headers.get('Access-Control-Allow-Methods'),
    text: await response.text(),
  };
}

const SETTINGS = [
  ['neither setting', {}],
  ['the old single setting alone', { ALLOWED_ORIGIN: PIE }],
  ['the new list alone', { ALLOWED_ORIGINS: PIE + ',' + PREMIUM }],
  ['the new list beside the old setting', { ALLOWED_ORIGINS: PIE + ',' + PREMIUM, ALLOWED_ORIGIN: PIE }],
  ['a new list that leaves the old site out, beside the old setting', { ALLOWED_ORIGINS: PREMIUM, ALLOWED_ORIGIN: PIE }],
  ['a list with spaces, a trailing slash and an empty entry', { ALLOWED_ORIGINS: ' ' + PIE + '/ , ,' + PREMIUM + ' ' }],
  ['a list with a stray "*" beside real sites', { ALLOWED_ORIGINS: PIE + ',*,' + PREMIUM, ALLOWED_ORIGIN: '*' }],
];

for (const fn of ['create-checkout', 'signin']) {
  for (const [label, env] of SETTINGS) {
    const handler = load(fn, env);
    const T = fn + ', ' + label + ': ';
    const any = Object.keys(env).length === 0;
    const premiumAllowed = any || /premium/.test(env.ALLOWED_ORIGINS || '');

    const pie = await call(handler, { origin: PIE });
    check(T + 'the existing site is answered', pie.status === 204 && pie.allow === (any ? '*' : PIE), pie);
    check(T + 'Vary: Origin is said whenever a list is in force', pie.vary === (any ? null : 'Origin'), pie);
    check(T + 'the allowed methods are still named', pie.methods === 'POST, OPTIONS', pie);

    const premium = await call(handler, { origin: PREMIUM });
    check(T + 'the Premium site is answered only when listed',
      premium.allow === (any ? '*' : premiumAllowed ? PREMIUM : null), premium);

    for (const stranger of ['https://evil.example', PIE + '.evil.example', 'http://pietimers.aibhlinn.ai', PIE + ':8443', 'null', '']) {
      const r = await call(handler, { origin: stranger });
      check(T + 'a site not on the list gets no origin header: ' + JSON.stringify(stranger), r.allow === (any ? '*' : null) && r.status === 204, r);
    }
    const none = await call(handler, {});
    check(T + 'a request with no Origin gets no origin header', none.allow === (any ? '*' : null), none);

    const post = await call(handler, { method: 'GET', origin: PIE });
    check(T + 'an answer that is not a preflight carries the same headers', post.status === 405 && post.allow === (any ? '*' : PIE), post);
  }
}

/* ───────────── signin: Turnstile hostname and the redirect ───────────── */

function signinNet(seen, hostname) {
  return async (url, init) => {
    url = String(url);
    if (url.includes('siteverify')) return new Response(JSON.stringify({ success: true, action: 'signin', hostname }), { status: 200 });
    if (url.includes('/rest/v1/signin_attempts') && (!init || init.method !== 'POST')) return new Response('[]', { status: 200 });
    if (url.includes('/rest/v1/signin_attempts')) return new Response('', { status: 201 });
    if (url.includes('/auth/v1/otp')) { seen.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 500 });
  };
}

async function signin(env, { hostname, origin, redirectTo }) {
  const seen = [];
  const handler = load('signin', { TURNSTILE_SECRET_KEY: 'secret', ...env }, signinNet(seen, hostname));
  const body = { email: 'someone@example.com', turnstileToken: 'token' };
  if (redirectTo !== undefined) body.redirectTo = redirectTo;
  const r = await call(handler, { method: 'POST', origin, body });
  return { status: r.status, allow: r.allow, sentTo: seen.length ? seen[0].options.email_redirect_to : null };
}

const BOTH = { ALLOWED_ORIGINS: PIE + ',' + PREMIUM, ALLOWED_ORIGIN: PIE };
const OLD = { ALLOWED_ORIGIN: PIE };

for (const [label, env, hostname, want] of [
  ['both sites listed, token minted on the existing site', BOTH, 'pietimers.aibhlinn.ai', 200],
  ['both sites listed, token minted on the Premium site', BOTH, 'premium.aibhlinn.ai', 200],
  ['both sites listed, token minted somewhere else', BOTH, 'evil.example', 403],
  ['both sites listed, token minted on a look-alike host', BOTH, 'premium.aibhlinn.ai.evil.example', 403],
  ['old setting alone, token minted on the existing site', OLD, 'pietimers.aibhlinn.ai', 200],
  ['old setting alone, token minted on the Premium site', OLD, 'premium.aibhlinn.ai', 403],
  ['neither setting, any hostname (cannot be judged, as before)', {}, 'anything.example', 200],
]) {
  const r = await signin(env, { hostname, origin: PIE, redirectTo: PIE + '/index.html' });
  check('signin Turnstile, ' + label, r.status === want, r);
}

for (const [label, env, origin, redirectTo, want] of [
  ['an address on the existing site is used', BOTH, PIE, PIE + '/index.html', PIE + '/index.html'],
  ['an address on the Premium site is used', BOTH, PREMIUM, PREMIUM + '/?plan=monthly#buy', PREMIUM + '/?plan=monthly#buy'],
  ['an address on the Premium site is used even when the existing site asks', BOTH, PIE, PREMIUM + '/', PREMIUM + '/'],
  ['an address on another site falls back to the site that asked', BOTH, PREMIUM, 'https://evil.example/steal', PREMIUM],
  ['an address that only STARTS like an allowed site falls back', BOTH, PIE, PIE + '.evil.example/x', PIE],
  ['an allowed site smuggled in as a user name falls back', BOTH, PIE, PIE + '@evil.example/x', PIE],
  ['the wrong scheme falls back', BOTH, PIE, 'http://pietimers.aibhlinn.ai/', PIE],
  ['a javascript: address falls back', BOTH, PIE, 'javascript:alert(1)', PIE],
  ['a blob: address that reports an allowed origin falls back', BOTH, PIE, 'blob:' + PIE + '/x', PIE],
  ['an address with a user name on an allowed site is used (same site)', BOTH, PIE, 'https://x@pietimers.aibhlinn.ai/', 'https://x@pietimers.aibhlinn.ai/'],
  ['text that is not an address falls back', BOTH, PIE, 'not an address', PIE],
  ['a value that is not text falls back', BOTH, PIE, { a: 1 }, PIE],
  ['no address at all falls back to the site that asked', BOTH, PREMIUM, undefined, PREMIUM],
  ['no address and a stranger asking falls back to the first site listed', BOTH, 'https://evil.example', undefined, PIE],
  ['a bad address and no Origin falls back to the first site listed', BOTH, undefined, 'https://evil.example/', PIE],
  ['old setting alone: an address on the existing site is used', OLD, PIE, PIE + '/pricing.html', PIE + '/pricing.html'],
  ['old setting alone: no address falls back to that site, as before', OLD, PIE, undefined, PIE],
  ['old setting alone: an address on the Premium site is not used yet', OLD, PIE, PREMIUM + '/', PIE],
  ['neither setting: the address goes through as before', {}, PIE, 'https://anything.example/x', 'https://anything.example/x'],
  ['neither setting: no address sends "*", as before', {}, PIE, undefined, '*'],
]) {
  const hostname = new URL(origin && origin.startsWith('https://p') ? origin : PIE).hostname;
  const r = await signin(env, { hostname, origin, redirectTo });
  check('signin redirect, ' + label, r.status === 200 && r.sentTo === want, r);
}

/* The two functions carry the same block. */
{
  const block = (name) => {
    const code = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
    return code.slice(code.indexOf('const ALLOWED_ORIGINS: string[] = ['), code.indexOf('\n}\n', code.indexOf('async function answered(')) + 3);
  };
  check('signin and create-checkout carry the same origin block', block('signin').length > 800 && block('signin') === block('create-checkout'));
  for (const name of ['signin', 'create-checkout']) {
    const code = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', name, 'index.ts'), 'utf8');
    check(name + ' has no fixed origin header left', !/corsHeaders|"Access-Control-Allow-Origin": ALLOWED_ORIGIN\b/.test(code));
    check(name + ' sends every answer through answered()', /Deno\.serve\(\(request\) => answered\(request, handle\)\);/.test(code));
  }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
