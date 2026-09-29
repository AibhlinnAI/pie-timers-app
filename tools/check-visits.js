#!/usr/bin/env node
/* ============================================================
   First-open count checks: does app/visits.js send, and does
   supabase/schema-visit-counts.sql keep, exactly what privacy.html
   section 9 says, and nothing more?

   The behaviour cases run visits.js in a vm sandbox with fake timers,
   a spy on fetch and localStorage backed by a Map, then play the part
   of what loads after it (sync.js's device key, app.js's CT.app and
   CT.inPlayApp). The static cases read the SQL, index.html, sw.js,
   config.js, privacy.html and every other page, so a new column, a new
   grant, a load-order change or a counted kiosk page fails the build
   before it ships.

   Nothing here touches the network or the database.

   Run: node tools/check-visits.js   (PT_ROOT=<dir> checks another copy)
   Runs in smoke.yml on every pull request, and in deploy.yml's guard.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.PT_ROOT || path.join(__dirname, '..');
const FILE = path.join(ROOT, 'app', 'visits.js');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const FLAG = 'countdown-timers/first-open/v1';

function run(opts) {
  const o = Object.assign({
    url: 'https://pietimers.aibhlinn.ai/', storage: {}, nav: {}, config: {},
    inPlayApp: false, app: true, readyState: 'loading', visibility: 'visible',
    storageThrows: false, fetchRejects: false, fetchThrows: false, afterLoad: null,
    prerendering: false, store: null, manual: false,
  }, opts);
  const u = new URL(o.url);
  const loc = { hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash };
  // A shared Map plays two tabs of one browser.
  const store = o.store || new Map(Object.entries(o.storage));
  const writes = [];
  const storage = {
    getItem(k) { if (o.storageThrows) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (o.storageThrows) throw new Error('blocked'); writes.push(k); store.set(k, String(v)); },
  };
  const fetches = [];
  const timers = [];
  const winL = {}, docL = {};
  const on = (m) => (t, f) => { (m[t] = m[t] || []).push(f); };
  const off = (m) => (t, f) => { m[t] = (m[t] || []).filter((g) => g !== f); };
  const doc = { readyState: o.readyState, visibilityState: o.visibility, prerendering: o.prerendering,
    addEventListener: on(docL), removeEventListener: off(docL) };
  const win = {
    CT: { config: Object.assign({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'sb_publishable_TEST',
      isConfigured: true, countFirstOpens: true }, o.config) },
    document: doc, localStorage: storage, location: loc,
    history: { replaceState(s, t, url) { const n = new URL(url, 'https://h'); loc.pathname = n.pathname; loc.search = n.search; loc.hash = n.hash; } },
    navigator: Object.assign({ onLine: true, userAgent: 'Mozilla/5.0 Chrome/140' }, o.nav),
    fetch(url, init) { fetches.push({ url, init }); if (o.fetchThrows) throw new TypeError("no fetch"); return o.fetchRejects ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: true, status: 204 }); },
    setTimeout(f, ms) { timers.push(f); return timers.length; },
    addEventListener: on(winL), removeEventListener: off(winL),
    URLSearchParams, JSON, String, Promise,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SOURCE, win, { filename: FILE });
  // app.js runs after: sets these
  win.CT.inPlayApp = o.inPlayApp;
  if (o.app) win.CT.app = {};
  if (!store.has('countdown-timers/device/v1')) { try { store.set('countdown-timers/device/v1', 'dev_x'); } catch (e) {} }
  const result = () => ({ fetches, store, writes, loc, state: win.CT.visits && win.CT.visits.state, address: loc.pathname + loc.search + loc.hash });
  const finish = () => {
    (winL.load || []).forEach((f) => f());
    while (timers.length) timers.shift()();
    if (o.afterLoad) { o.afterLoad(doc, docL); while (timers.length) timers.shift()(); }
    return result();
  };
  // manual: stop once the scripts have run, before the page's load event.
  if (o.manual) return { finish, result };
  return finish();
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok    ' + name);
  else { failures++; console.error('FAIL  ' + name + (detail ? ' -- ' + JSON.stringify(detail) : '')); }
}
const body = (r) => JSON.parse(r.fetches[0].init.body);

// 1 first open, fragment tag
let r = run({ url: 'https://pietimers.aibhlinn.ai/#src=NLS26' });
check('1 one fetch', r.fetches.length === 1, r);
check('1 url has no query', r.fetches.length && !r.fetches[0].url.includes('?'));
check('1 POST, omit, no-referrer', r.fetches.length && r.fetches[0].init.method === 'POST' && r.fetches[0].init.credentials === 'omit' && r.fetches[0].init.referrerPolicy === 'no-referrer');
check('1 body keys exact', r.fetches.length && JSON.stringify(Object.keys(body(r)).sort()) === '["p_platform","p_source"]');
check('1 body values', r.fetches.length && body(r).p_source === 'nls26' && body(r).p_platform === 'web', r.fetches[0] && body(r));
check('1 header keys', r.fetches.length && Object.keys(r.fetches[0].init.headers).every((k) => ['apikey', 'Authorization', 'Content-Type'].includes(k)));
check('1 address stripped', r.address === '/', r.address);
check('1 flag is 1', r.store.get(FLAG) === '1');
check('1 only flag written', r.writes.every((k) => k === FLAG), r.writes);

// 2 query tag, other params kept
r = run({ url: 'https://pietimers.aibhlinn.ai/?focus=1&src=ndexpo26#x' });
check('2 query tag sent', r.fetches.length === 1 && body(r).p_source === 'ndexpo26');
check('2 other params kept', r.address === '/?focus=1#x', r.address);

// 3 GPC
r = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26', nav: { globalPrivacyControl: true } });
check('3 GPC no fetch', r.fetches.length === 0);
check('3 GPC no write', r.writes.length === 0, r.writes);
check('3 GPC still stripped', r.address === '/', r.address);
check('3 GPC state declined', r.state === 'declined');

// 4 DNT
r = run({ nav: { doNotTrack: '1' } });
check('4 DNT no fetch', r.fetches.length === 0);

// 5 returning: flag present
r = run({ storage: { [FLAG]: '1' } });
check('5 flagged no fetch', r.fetches.length === 0 && r.state === 'counted');

// 6 backfill: each history key
['countdown-timers/device/v1', 'countdown-timers/v1', 'countdown-timers/breaks/v1', 'countdown-timers/synced-account/v1', 'aibhlinn/session/v1'].forEach((k) => {
  r = run({ storage: { [k]: 'x' } });
  check('6 backfill ' + k, r.fetches.length === 0 && r.store.get(FLAG) === '1');
});

// 7 storage throws
r = run({ storageThrows: true });
check('7 no storage no fetch', r.fetches.length === 0 && r.state === 'no-storage');

// 8 offline: stays pending, next open sends with original source
r = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26', nav: { onLine: false } });
check('8 offline no fetch', r.fetches.length === 0);
check('8 offline stays pending', r.store.get(FLAG) === 'pending:nls26', r.store.get(FLAG));
const pendingStore = Object.fromEntries(r.store);
r = run({ url: 'https://pietimers.aibhlinn.ai/#src=other2', storage: pendingStore });
check('8 next open sends original source', r.fetches.length === 1 && body(r).p_source === 'nls26');

// 9 malformed tags
['%3Cx%3E', 'Foo%20Bar', 'a'.repeat(40), '-x'].forEach((t) => {
  r = run({ url: 'https://pietimers.aibhlinn.ai/?src=' + t });
  check('9 malformed ' + t.slice(0, 10) + ' -> other', r.fetches.length === 1 && body(r).p_source === 'other', r.fetches[0] && body(r));
});
r = run({});
check('9 untagged -> empty', r.fetches.length === 1 && body(r).p_source === '');

// 10 Play
r = run({ inPlayApp: true });
check('10 play', r.fetches.length === 1 && body(r).p_platform === 'play');

// 11 host gate
r = run({ url: 'http://localhost:8080/#src=nls26' });
check('11 localhost no fetch, no write', r.fetches.length === 0 && r.writes.length === 0 && r.state === 'elsewhere');
check('11 localhost still stripped', r.address === '/', r.address);

// 12 switch off
r = run({ config: { countFirstOpens: false } });
check('12 switch off no fetch no write', r.fetches.length === 0 && r.writes.length === 0);

// 13 count=off
r = run({ url: 'https://pietimers.aibhlinn.ai/#count=off' });
check('13 count=off marks, no fetch', r.fetches.length === 0 && r.store.get(FLAG) === '1' && r.address === '/');

// 14 automation
r = run({ nav: { webdriver: true } });
check('14 webdriver no fetch, marked', r.fetches.length === 0 && r.store.get(FLAG) === '1');
r = run({ nav: { userAgent: 'Mozilla/5.0 HeadlessChrome/140' } });
check('14 headless UA no fetch', r.fetches.length === 0);

// 15 hidden until visible
r = run({ visibility: 'hidden', afterLoad(doc, docL) { doc.visibilityState = 'visible'; (docL.visibilitychange || []).slice().forEach((f) => f()); } });
check('15 hidden then visible sends once', r.fetches.length === 1);
r = run({ visibility: 'hidden' });
check('15 never visible stays pending', r.fetches.length === 0 && /^pending:/.test(r.store.get(FLAG)));

// 16 app never started
r = run({ app: false });
check('16 no CT.app no fetch', r.fetches.length === 0 && /^pending:/.test(r.store.get(FLAG)));

// 17 sentinel values never in body
r = run({ storage: {}, url: 'https://pietimers.aibhlinn.ai/#src=nls26' });
check('17 body has no device id', r.fetches.length === 1 && !r.fetches[0].init.body.includes('dev_x'));

// 18 fetch rejects silently
r = run({ fetchRejects: true });
check('18 rejected fetch: flag still 1', r.store.get(FLAG) === '1');

// 19 non-src hash untouched
r = run({ url: 'https://pietimers.aibhlinn.ai/#in-app' });
check('19 #in-app kept', r.address === '/#in-app', r.address);

// 20 once per browser, ever: later opens the same day, the next day, from
// another tagged code or in the Play app send nothing
r = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26' });
check('20 first open sends', r.fetches.length === 1);
const afterFirst = Object.fromEntries(r.store);
['https://pietimers.aibhlinn.ai/', 'https://pietimers.aibhlinn.ai/#src=nwc26',
 'https://pietimers.aibhlinn.ai/?src=ndexpo26', 'https://pietimers.aibhlinn.ai/#in-app'].forEach((url) => {
  r = run({ url, storage: afterFirst });
  check('20 returning open sends nothing: ' + url.slice(29), r.fetches.length === 0 && r.state === 'counted' && r.writes.length === 0, r.state);
});
r = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26', storage: afterFirst, inPlayApp: true });
check('20 same browser later in the Play app sends nothing', r.fetches.length === 0);

// 21 two tabs of a new browser opened together: counted once
{
  const shared = new Map();
  const a = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26', store: shared, manual: true });
  const b = run({ url: 'https://pietimers.aibhlinn.ai/#src=nls26', store: shared, manual: true });
  const ra = a.finish(), rb = b.finish();
  check('21 two tabs: one fetch between them', ra.fetches.length + rb.fetches.length === 1, [ra.fetches.length, rb.fetches.length]);
  check('21 two tabs: flag ends at 1', shared.get(FLAG) === '1');
}

// 22 a first open closed before the send goes out is sent on the next
// open, although sync.js has made the device key by then
{
  const shared = new Map();
  const first = run({ url: 'https://pietimers.aibhlinn.ai/#src=ndexpo26', store: shared, manual: true });
  check('22 closed at once: nothing sent yet, still pending',
    first.result().fetches.length === 0 && shared.get(FLAG) === 'pending:ndexpo26', shared.get(FLAG));
  shared.set('countdown-timers/device/v1', 'dev_x');
  r = run({ url: 'https://pietimers.aibhlinn.ai/', store: shared });
  check('22 next open sends the original tag', r.fetches.length === 1 && body(r).p_source === 'ndexpo26');
}

// 23 the other Do Not Track spellings; GPC false / DNT 0 are not refusals
r = run({ nav: { msDoNotTrack: '1' } });
check('23 msDoNotTrack no fetch', r.fetches.length === 0 && r.state === 'declined');
r = run({ nav: { globalPrivacyControl: false, doNotTrack: '0' } });
check('23 GPC false and DNT 0 still count', r.fetches.length === 1);

// 24 no backend configured: nothing
r = run({ config: { isConfigured: false } });
check('24 unconfigured: no fetch, no write', r.fetches.length === 0 && r.writes.length === 0);

// 25 a prerendered page is sent only once it is shown
r = run({ prerendering: true });
check('25 prerendered, never shown: stays pending', r.fetches.length === 0 && /^pending:/.test(r.store.get(FLAG)));
r = run({ prerendering: true, afterLoad(doc, docL) { doc.prerendering = false; (docL.prerenderingchange || []).slice().forEach((f) => f()); } });
check('25 prerendered, then shown: sends once', r.fetches.length === 1);

// 26 nothing is sent before load plus the delay: start-up is never held up
{
  const t = run({ manual: true });
  check('26 nothing sent while the page is still loading', t.result().fetches.length === 0);
  check('26 sent after load', t.finish().fetches.length === 1);
}

// 27 fetch throwing synchronously never escapes, and still counts as sent
{
  let threw = false;
  try { r = run({ fetchThrows: true }); } catch (e) { threw = true; }
  check("27 a throwing fetch never reaches the app", !threw && r.store.get(FLAG) === "1");
}

// ── Static checks: what the server keeps, and the load order ──
const sqlRaw = fs.readFileSync(path.join(ROOT, 'supabase', 'schema-visit-counts.sql'), 'utf8');
// Comments may name what the code must not use, so they are dropped first.
const sql = sqlRaw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const table = /create table if not exists public\.visit_counts \(([\s\S]*?)\n\);/i.exec(sql);
const cols = table ? table[1].split('\n').map((l) => l.trim())
  .filter((l) => l && !/^primary key/i.test(l)).map((l) => l.split(/\s+/)[0]) : [];
check('S1 visit_counts columns are exactly day, kind, source, platform, n',
  cols.join(',') === 'day,kind,source,platform,n', cols);
['request.headers', 'request.jwt', 'inet_client_addr', 'auth.uid', 'x-forwarded',
 'cf-connecting', 'create trigger', 'timestamptz'].forEach((bad) => {
  check('S2 SQL never uses ' + bad, !sql.toLowerCase().includes(bad));
});
const anonGrants = sql.match(/grant [^;]* to anon[^;]*;/gi) || [];
check('S3 the only grant to anon is execute on count_first_open', anonGrants.length === 1 &&
  /^grant execute on function public\.count_first_open\(text, text\) to anon;$/i.test(anonGrants[0]), anonGrants);
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const tag = /<script src="visits\.js\?v=(\d+)"><\/script>/.exec(html);
const at = (s) => html.indexOf('<script src="' + s);
check('S4 index.html loads visits.js after config.js, before identity-bridge.js and sync.js',
  tag && at('config.js') < tag.index && tag.index < at('identity-bridge.js') && tag.index < at('sync.js'));
const sw = fs.readFileSync(path.join(ROOT, 'app', 'sw.js'), 'utf8');
check('S5 sw.js precaches the same visits.js?v= that index.html asks for',
  tag && sw.includes("'visits.js?v=" + tag[1] + "'"));
const conf = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
check('S6 config.js has the countFirstOpens switch', /countFirstOpens:\s*(true|false)/.test(conf));

// Only the app itself counts: kiosk and event pages, pricing, terms and
// the privacy policy never load visits.js.
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
}(path.join(ROOT, 'app')));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const counting = pages.filter((p) => /<script[^>]*visits\.js/i.test(read(p)));
check('S7 only app/index.html loads visits.js', counting.length === 1 && counting[0] === 'app/index.html', counting);
const kiosks = pages.filter((p) => /^app\/[^/]+\/index\.html$/.test(p));
check('S7 kiosk and event pages load no shared scripts, so never count (' + kiosks.length + ' checked)',
  kiosks.length > 0 && kiosks.every((p) => !/<script[^>]*\ssrc=/i.test(read(p))),
  kiosks.filter((p) => /<script[^>]*\ssrc=/i.test(read(p))));

const policy = read('app/privacy.html');
check('S8 privacy.html section 9 discloses the first-open count',
  /<h2 id="counting">9\./.test(policy) && /<strong>First opens\.<\/strong>/.test(policy) &&
  policy.includes('<a href="visits.js">') && policy.includes('#count=off'));

// The deploy guard's vendor pattern is a case-insensitive substring
// match, so an innocent identifier in visits.js could trip it.
const guard = /pattern='([^']+)'/.exec(read('.github/workflows/deploy.yml'));
check('S9 visits.js passes the deploy guard pattern', guard && !new RegExp(guard[1], 'i').test(SOURCE));

process.on('exit', () => {
  if (failures) { console.error(failures + ' check(s) failed.'); process.exitCode = 1; }
  else console.log('All visit-count checks passed.');
});
