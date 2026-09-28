#!/usr/bin/env node
/* ============================================================
   calendar-sync tests -- the parser, the scheduled run's
   orchestration, and the edge function's entry point itself.

   Written after every scheduled sync failed for at least six hours on
   27-28 Sep 2026 with HTTP 546 (WORKER_RESOURCE_LIMIT). One invocation
   synced every feed in a loop and ran out of CPU partway. The fix gives
   each feed its own invocation and makes the parser cheaper; this file
   holds both to account without deploying anything.

   index.ts is run for real under Node's type stripping, with Deno and
   fetch stubbed: the Supabase REST API, the calendar servers and the
   function's calls to itself are all answered in-process, and one feed's
   worker answers 546 the way the platform does.

   Run: node --experimental-strip-types tools/calendar-sync-test.mjs
   ============================================================ */

import { parseCalendar } from '../supabase/functions/calendar-sync/ical.js';
import { fanOut, pickFeeds } from '../supabase/functions/calendar-sync/schedule.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failed++;
  console.error('FAIL ' + name + (detail === undefined ? '' : '\n     ' + JSON.stringify(detail)));
}

const DAY = 864e5;
const cal = (...events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const iso = (e) => e.startsAt.toISOString();

/* ─────────────────────────── Parser ─────────────────────────── */

// 20:00 UTC is 06:30 the next morning in Adelaide, which is what makes
// the far-edge case below possible.
const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);
const WS = NOW - DAY;
const WE = NOW + 21 * DAY;
const parse = (text, max) => parseCalendar(text, WS, WE, max === undefined ? 400 : max);

{
  // A weekly series from 2019 with one in-window occurrence moved out of
  // the window, and one ancient occurrence moved into it.
  const text = cal(
    vevent('UID:weekly', 'DTSTART;TZID=Australia/Adelaide:20190101T090000',
      'DTEND;TZID=Australia/Adelaide:20190101T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Standup'),
    vevent('UID:weekly', 'RECURRENCE-ID;TZID=Australia/Adelaide:20261006T090000',
      'DTSTART;TZID=Australia/Adelaide:20261215T090000', 'SUMMARY:Moved away'),
    vevent('UID:weekly', 'RECURRENCE-ID;TZID=Australia/Adelaide:20200107T090000',
      'DTSTART;TZID=Australia/Adelaide:20261008T140000', 'SUMMARY:Moved here'),
  );
  const out = parse(text);
  const titles = out.map((e) => e.title + ' ' + iso(e));
  check('series: three Tuesdays in the window, less the one moved away', out.filter((e) => e.title === 'Standup').length === 2, titles);
  check('series: the moved-away occurrence is gone', !out.some((e) => iso(e) === '2026-10-05T22:30:00.000Z'), titles);
  check('series: an ancient occurrence moved into the window appears', out.some((e) => e.title === 'Moved here' && iso(e) === '2026-10-08T03:30:00.000Z'), titles);
  check('series: the moved-away override is not emitted', !out.some((e) => e.title === 'Moved away'), titles);
}

{
  // Years of weekly overrides that change nothing in the window must not
  // change the result. This is what a Google calendar looks like.
  const base = vevent('UID:w', 'DTSTART;TZID=Australia/Adelaide:20180102T090000',
    'DTEND;TZID=Australia/Adelaide:20180102T093000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Planning');
  const overrides = [];
  for (let k = 0; k < 400; k++) {
    const d = new Date(Date.UTC(2018, 0, 2) + k * 7 * DAY);
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
    overrides.push(vevent('UID:w', 'RECURRENCE-ID;TZID=Australia/Adelaide:' + ymd + 'T090000',
      'DTSTART;TZID=Australia/Adelaide:' + ymd + 'T110000', 'SUMMARY:Planning (late)'));
  }
  const plain = parse(cal(base)).map(iso);
  const withHistory = parse(cal(base, ...overrides)).map(iso);
  check('overrides: 400 old overrides leave the window unchanged', JSON.stringify(plain) === JSON.stringify(withHistory), { plain, withHistory });
  check('overrides: the window still has its three Tuesdays', plain.length === 3, plain);
}

{
  // 06:00 in Adelaide on the morning after the window's UTC end date is
  // still inside the window. The old keep-filter compared the bare date
  // with no slack and dropped it.
  const out = parse(cal(vevent('UID:edge', 'DTSTART;TZID=Australia/Adelaide:20261020T060000', 'SUMMARY:Early')));
  check('far edge: an early event east of UTC on the last morning is kept', out.length === 1 && iso(out[0]) === '2026-10-19T19:30:00.000Z', out.map(iso));
}

{
  // The back edge, from the other side of the world: 08:30 on the 27th at
  // UTC-12 is 20:30Z, half an hour inside the window, but its bare date
  // is twenty hours before the window opens. Slack of under a day would
  // drop it.
  const out = parse(cal(vevent('UID:back', 'DTSTART;TZID=Etc/GMT+12:20260927T083000', 'SUMMARY:Late')));
  check('back edge: an event at UTC-12 just inside the window is kept', out.length === 1 && iso(out[0]) === '2026-09-27T20:30:00.000Z', out.map(iso));
}

{
  // Zone names come from the feed. Ones that match Object's own property
  // names must look unknown and fall back to UTC, not fail the feed.
  const out = parse(cal(
    vevent('UID:p1', 'DTSTART;TZID=constructor:20261001T090000', 'SUMMARY:A'),
    vevent('UID:p2', 'DTSTART;TZID=__proto__:20261002T090000', 'SUMMARY:B'),
    vevent('UID:p3', 'DTSTART;TZID=toString:20261003T090000', 'SUMMARY:C'),
  ).replace('VERSION:2.0', 'VERSION:2.0\r\nX-WR-TIMEZONE:hasOwnProperty'));
  check('zones: property-shaped names fall back to UTC', out.map(iso).join() === '2026-10-01T09:00:00.000Z,2026-10-02T09:00:00.000Z,2026-10-03T09:00:00.000Z', out.map(iso));
}

{
  // What the CPU goes on, counted rather than timed, so a slow machine
  // cannot hide a regression. Each zone is used by nothing else in this
  // file, so its caches start cold.
  const RealDTF = Intl.DateTimeFormat;
  const realParts = RealDTF.prototype.formatToParts;
  let built = 0, conversions = 0;
  Intl.DateTimeFormat = new Proxy(RealDTF, { construct(target, args) { built++; return new target(...args); } });
  RealDTF.prototype.formatToParts = function () { conversions++; return realParts.apply(this, arguments); };
  const counted = (fn) => { built = 0; conversions = 0; fn(); return { built, conversions }; };

  try {
    // 300 one-off events in the window's zone, plus the same meeting
    // moved every week for six years.
    const lines = [];
    for (let k = 0; k < 300; k++) {
      const d = new Date(NOW + (k % 20) * DAY).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(...vevent('UID:k' + k, 'DTSTART;TZID=Asia/Kathmandu:' + d + 'T0' + (k % 10) + '0000', 'SUMMARY:K'));
    }
    const zoneCost = counted(() => parse(cal(lines)));
    check('cost: one formatter per zone, not one per date (' + zoneCost.built + ' built)', zoneCost.built <= 2, zoneCost);

    const series = cal(vevent('UID:old', 'DTSTART;TZID=America/St_Johns:20100104T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Since 2010'),
      ...Array.from({ length: 300 }, (_, k) => {
        const d = new Date(Date.UTC(2010, 0, 4) + k * 7 * DAY).toISOString().slice(0, 10).replace(/-/g, '');
        return vevent('UID:old', 'RECURRENCE-ID;TZID=America/St_Johns:' + d + 'T090000', 'DTSTART;TZID=America/St_Johns:' + d + 'T110000', 'SUMMARY:Moved');
      }));
    const seriesCost = counted(() => parse(series));
    check('cost: a weekly series since 2010 converts only near the window (' + seriesCost.conversions + ' conversions)', seriesCost.conversions < 60, seriesCost);
    const mondays = parse(series).map(iso).join();
    check('cost: and still produces its four Mondays in the window', mondays === '2026-09-28T11:30:00.000Z,2026-10-05T11:30:00.000Z,2026-10-12T11:30:00.000Z,2026-10-19T11:30:00.000Z', mondays);
  } finally {
    Intl.DateTimeFormat = RealDTF;
    RealDTF.prototype.formatToParts = realParts;
  }
}

{
  const out = parse(cal(
    vevent('UID:done', 'DTSTART:20150105T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=20', 'SUMMARY:Finished course'),
    vevent('UID:until', 'DTSTART:20260101T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20261001T000000Z', 'SUMMARY:Until'),
    vevent('UID:ex', 'DTSTART;TZID=UTC:20260105T080000', 'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=UTC:20261005T080000', 'SUMMARY:Ex'),
    vevent('UID:old', 'DTSTART:20260301T090000Z', 'SUMMARY:Months ago'),
    vevent('UID:tz', 'DTSTART;TZID=Not/AZone:20261001T090000', 'SUMMARY:Unknown zone'),
    vevent('UID:day', 'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'SUMMARY:All day'),
    vevent('UID:gone', 'DTSTART:20261003T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled'),
  ));
  const by = (t) => out.filter((e) => e.title === t);
  check('COUNT: a series that finished in 2015 produces nothing', by('Finished course').length === 0);
  check('UNTIL: stops at its end', by('Until').map(iso).join() === '2026-09-28T09:00:00.000Z,2026-09-29T09:00:00.000Z,2026-09-30T09:00:00.000Z', by('Until').map(iso));
  check('EXDATE: the excluded Monday is skipped, the other three kept', by('Ex').map(iso).join() === '2026-09-28T08:00:00.000Z,2026-10-12T08:00:00.000Z,2026-10-19T08:00:00.000Z', by('Ex').map(iso));
  check('one-off: an event from months ago is not emitted', by('Months ago').length === 0);
  check('zones: an unknown TZID falls back to UTC', by('Unknown zone').length === 1 && iso(by('Unknown zone')[0]) === '2026-10-01T09:00:00.000Z');
  check('all-day: kept as all-day', by('All day').length === 1 && by('All day')[0].allDay === true);
  check('cancelled: skipped', by('Cancelled').length === 0);
  check('output: sorted by start', out.every((e, k) => k === 0 || out[k - 1].startsAt <= e.startsAt));
}

{
  // Cost guard. A Google basic.ics is the whole history of the calendar:
  // here, eight years of events, twelve a week, and forty weekly series
  // each moved twenty times. About 1.7 MB. This took ~840 ms of CPU
  // before the fix and 120-220 ms after, on the machine it was written
  // on. The bound is loose so a slow CI runner does not fail it, and the
  // old parser still fails it by nearly half.
  const lines = [];
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00'; };
  const from = NOW - 8 * 365 * DAY;
  let n = 0;
  for (let t = from; t < NOW + 60 * DAY; t += 7 * DAY / 12) {
    lines.push(...vevent('UID:e' + n++, 'DTSTART;TZID=Australia/Adelaide:' + stamp(t), 'DTEND;TZID=Australia/Adelaide:' + stamp(t + 36e5),
      'DESCRIPTION:Lorem ipsum dolor sit amet\\, consectetur adipiscing elit sed do eiusmod tempor.', 'LOCATION:Somewhere', 'SUMMARY:Event ' + n,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM'));
  }
  for (let s = 0; s < 40; s++) {
    const t = from + s * 30 * DAY;
    lines.push(...vevent('UID:s' + s, 'DTSTART;TZID=Australia/Adelaide:' + stamp(t), 'DTEND;TZID=Australia/Adelaide:' + stamp(t + 36e5),
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', 'SUMMARY:Series ' + s));
    for (let o = 0; o < 20; o++) {
      const r = t + o * 7 * DAY;
      lines.push(...vevent('UID:s' + s, 'RECURRENCE-ID;TZID=Australia/Adelaide:' + stamp(r), 'DTSTART;TZID=Australia/Adelaide:' + stamp(r + 36e5), 'SUMMARY:Moved'));
    }
  }
  const text = cal(lines);
  parse(text);                                  // warm up, as a live worker would be
  const before = process.cpuUsage();
  const out = parse(text);
  const used = process.cpuUsage(before);
  const ms = (used.user + used.system) / 1000;
  console.log('cost: ' + (text.length / 1048576).toFixed(1) + ' MB calendar, ' + Math.round(ms) + ' ms of CPU');
  check('cost: an eight-year calendar parses in under 450 ms of CPU', ms < 450, ms);
  check('cost: and still fills the event cap', out.length === 400, out.length);
}

/* ─────────────────────────── Scheduled run ─────────────────────────── */

{
  const feeds = [
    { id: 'a', user_id: 'u1' }, { id: 'b', user_id: 'u2' }, { id: 'c', user_id: 'u1' },
    { id: 'd', user_id: 'u3' }, { id: 'e', user_id: 'u2' },
  ];
  const asked = [];
  const picked = await pickFeeds(feeds, async (u) => { asked.push(u); return u !== 'u2'; }, 10);
  check('pickFeeds: keeps order and drops unentitled owners', picked.join() === 'a,c,d', picked);
  check('pickFeeds: asks once per owner', asked.join() === 'u1,u2,u3', asked);
  const capped = await pickFeeds(feeds, async (u) => u !== 'u2', 2);
  check('pickFeeds: the cap counts entitled feeds only', capped.join() === 'a,c', capped);
}

{
  let inFlight = 0, peak = 0;
  const ids = Array.from({ length: 20 }, (_, k) => 'f' + k);
  const counts = await fanOut(ids, async (id) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (id === 'f3') throw new Error('boom');
    if (id === 'f4') return 'died';
    if (id === 'f5') return 'failed';
    if (id === 'f6') return 'something else';
    if (id === 'f7') return 'deferred';
    return 'synced';
  }, { parallel: 6, budgetMs: 60000 });
  check('fanOut: never more than six at once', peak === 6, peak);
  check('fanOut: counts each outcome, a throw or nonsense as died', JSON.stringify(counts) === JSON.stringify({ synced: 15, failed: 1, died: 3, deferred: 1 }), counts);
}

{
  let clock = 0;
  const started = [];
  const counts = await fanOut(['a', 'b', 'c', 'd', 'e'], async (id) => { started.push(id); clock += 40; return 'synced'; },
    { parallel: 1, budgetMs: 100, now: () => clock });
  check('fanOut: stops starting feeds once the budget is spent, and says how many wait', started.join() === 'a,b,c' && counts.deferred === 2, { started, counts });
}

/* ─────────────────────────── index.ts, end to end ─────────────────────────── */

{
  const ENV = {
    SUPABASE_URL: 'https://proj.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SUPABASE_ANON_KEY: 'anon-key',
    CRON_SECRET: 'cron-secret',
  };
  let handler = null;
  class RateLimitError extends Error {}
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; }, errors: { RateLimitError } };

  const uuid = (k) => '00000000-0000-4000-8000-' + String(k).padStart(12, '0');
  /* Eight feeds, as on 28 Sep, each owned by user-(k % 3) except feed 3,
     whose owner has no plan. What happens to each one's worker:
       0, 1  synced
       2     deleted between the list and its sync: our own 404
       4     the gateway answers 404 (say the function was renamed)
       5     the gateway answers 429
       6     killed by the platform: 546
       7     the call is refused with RateLimitError */
  const FEEDS = Array.from({ length: 8 }, (_, k) => ({ id: uuid(k), user_id: 'user-' + (k === 3 ? 'lapsed' : k % 3), feed_url: 'https://cal.test/' + k + '.ics', label: 'x', kind: 'ical' }));
  const GONE = uuid(2), MISSING = uuid(4), BUSY = uuid(5), KILLED = uuid(6), REFUSED = uuid(7);

  const patches = {};
  const patchFilters = {};
  const events = {};
  const selfCalls = [];
  let inFlight = 0, peak = 0;

  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);

    if (url.origin === 'https://cal.test') {
      const k = url.pathname.match(/\d+/)[0];
      return new Response(cal(vevent('UID:k' + k, 'DTSTART:' + new Date(Date.now() + DAY).toISOString().replace(/[-:]|\.\d+/g, ''), 'SUMMARY:Feed ' + k)));
    }

    if (url.href === ENV.SUPABASE_URL + '/functions/v1/calendar-sync') {
      const body = JSON.parse(init.body);
      selfCalls.push({ body, secret: headers.get('x-cron-secret'), auth: headers.get('authorization') });
      if (body.feedId === REFUSED) throw new RateLimitError('too many nested calls');
      if (body.feedId === BUSY) return reply(429, { message: 'Too many requests' });
      if (body.feedId === MISSING) return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
      if (body.feedId === KILLED) {
        return reply(546, { code: 'WORKER_RESOURCE_LIMIT', message: 'Function failed due to not having enough compute resources (please check logs)' });
      }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await handler(new Request(url.href, { method: 'POST', headers, body: init.body }));
      } finally { inFlight--; }
    }

    if (url.pathname === '/auth/v1/user') {
      return headers.get('authorization') === 'Bearer user-token' ? reply(200, { id: 'user-0' }) : reply(401, {});
    }

    check('REST calls carry the service key', headers.get('apikey') === 'service-key');
    const path = url.pathname.replace('/rest/v1', '');
    const q = url.searchParams;

    if (path === '/rpc/has_active_plan') return reply(200, JSON.parse(init.body).uid !== 'user-lapsed');
    if (path === '/calendar_feeds' && method === 'GET' && q.get('select') === 'id,user_id') {
      check('the run asks for active feeds, stalest first', q.get('active') === 'is.true' && q.get('order') === 'last_synced.asc.nullsfirst', q.toString());
      return reply(200, FEEDS.map(({ id, user_id }) => ({ id, user_id })));
    }
    if (path === '/calendar_feeds' && method === 'GET') {
      const id = q.get('id').slice(3);
      const owner = q.get('user_id');
      if (!owner) check('a scheduled feed is read only while active', q.get('active') === 'is.true', q.toString());
      if (id === GONE) return reply(200, []);
      return reply(200, FEEDS.filter((f) => f.id === id && (!owner || 'eq.' + f.user_id === owner)));
    }
    if (path === '/calendar_feeds' && method === 'PATCH') {
      const id = q.get('id').slice(3);
      patches[id] = JSON.parse(init.body);
      patchFilters[id] = q.get('or');
      return reply(200);
    }
    if (path === '/calendar_events' && method === 'DELETE') return reply(200);
    if (path === '/calendar_events' && method === 'POST') {
      for (const row of JSON.parse(init.body)) (events[row.feed_id] ||= []).push(row);
      return reply(200);
    }
    throw new Error('unexpected fetch ' + method + ' ' + url.href);
  };

  await import('../supabase/functions/calendar-sync/index.ts');
  check('index.ts registers a handler', typeof handler === 'function');

  const call = (body, headers = {}) => handler(new Request('https://proj.supabase.test/functions/v1/calendar-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
  const cron = { 'x-cron-secret': 'cron-secret' };

  check('the run refuses a missing secret', (await call({ all: true })).status === 403);
  check('the run refuses a wrong secret', (await call({ all: true }, { 'x-cron-secret': 'nope' })).status === 403);
  check('a scheduled feed refuses a missing secret', (await call({ scheduled: true, feedId: uuid(1) })).status === 403);
  check('a scheduled feed refuses a malformed id', (await call({ scheduled: true, feedId: uuid(1) + '&user_id=eq.x' }, cron)).status === 400);
  check('a scheduled feed answers 404 for an unknown id', (await call({ scheduled: true, feedId: uuid(99) }, cron)).status === 404);
  check('the user path still wants a token', (await call({ feedId: uuid(1) })).status === 401);

  for (const k of Object.keys(patches)) delete patches[k];
  selfCalls.length = 0;

  const response = await call({ all: true }, cron);
  const summary = await response.json();
  check('the run answers 200 with counts', response.status === 200 && JSON.stringify(summary) === JSON.stringify({ ok: true, due: 7, synced: 2, failed: 1, died: 2, deferred: 2 }), summary);
  check('each due feed got its own invocation, carrying the secret', selfCalls.length === 7 && selfCalls.every((c) => c.body.scheduled === true && c.secret === 'cron-secret' && c.auth === 'Bearer anon-key'), selfCalls);
  check('the lapsed account was not synced', !selfCalls.some((c) => c.body.feedId === uuid(3)) && !patches[uuid(3)]);
  check('workers ran in parallel', peak > 1, peak);

  check('synced feeds cleared their error and stored their event', [uuid(0), uuid(1)].every((id) => patches[id] && patches[id].last_error === null && patches[id].event_count === 1 && events[id] && events[id].length === 1), patches);
  for (const [name, id] of [['killed', KILLED], ['missing-function', MISSING]]) {
    check('the ' + name + ' feed now says so, instead of nothing', patches[id] && /did not finish/.test(patches[id].last_error) && typeof patches[id].last_synced === 'string', patches[id]);
    check('the ' + name + ' feed is stamped only if its worker wrote nothing since it started', /^\(last_synced\.is\.null,last_synced\.lt\."\d{4}-\d\d-\d\dT[\d:.]+Z"\)$/.test(patchFilters[id] || ''), patchFilters[id]);
    check('the ' + name + ' feed stored nothing', !events[id]);
  }
  check('a feed deleted mid-run is counted as failed and left alone', !patches[GONE] && !events[GONE]);
  check('refused calls are not blamed on the feed: no error, no timestamp', !patches[BUSY] && !patches[REFUSED], { busy: patches[BUSY], refused: patches[REFUSED] });

  // The user path: user-0 owns feeds 0 and 6; feed 1 is user-1's.
  for (const k of Object.keys(patches)) delete patches[k];
  const user = { Authorization: 'Bearer user-token' };
  const own = await call({ feedId: uuid(0) }, user);
  check('a user can sync their own feed', own.status === 200 && (await own.json()).ok === true && Boolean(patches[uuid(0)]));
  check('a user cannot sync a feed that is not theirs', (await call({ feedId: uuid(1) }, user)).status === 404 && !patches[uuid(1)]);
  const trick = await call({ feedId: uuid(1) + '#' }, user);
  check('nor by pushing the owner filter into a URL fragment', trick.status === 400 && !patches[uuid(1)], trick.status);
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
