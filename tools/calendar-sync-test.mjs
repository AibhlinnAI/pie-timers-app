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
  // Eight feeds, as on 28 Sep. Feed 3 belongs to someone without a plan;
  // feed 6's worker is killed by the platform; feed 7's call is refused
  // by Supabase's limit on function-to-function calls.
  const FEEDS = Array.from({ length: 8 }, (_, k) => ({ id: uuid(k), user_id: 'user-' + (k === 3 ? 'lapsed' : k % 3), feed_url: 'https://cal.test/' + k + '.ics', label: 'x', kind: 'ical' }));
  const KILLED = uuid(6);
  const REFUSED = uuid(7);

  const patches = {};
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
      if (body.feedId === KILLED) {
        return reply(546, { code: 'WORKER_RESOURCE_LIMIT', message: 'Function failed due to not having enough compute resources (please check logs)' });
      }
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await handler(new Request(url.href, { method: 'POST', headers, body: init.body }));
      } finally { inFlight--; }
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
      return reply(200, FEEDS.filter((f) => f.id === id));
    }
    if (path === '/calendar_feeds' && method === 'PATCH') {
      patches[q.get('id').slice(3)] = JSON.parse(init.body);
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

  const call = (body, secret) => handler(new Request('https://proj.supabase.test/functions/v1/calendar-sync', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  check('the run refuses a missing secret', (await call({ all: true })).status === 403);
  check('the run refuses a wrong secret', (await call({ all: true }, 'nope')).status === 403);
  check('a scheduled feed refuses a missing secret', (await call({ scheduled: true, feedId: uuid(1) })).status === 403);
  check('a scheduled feed refuses a malformed id', (await call({ scheduled: true, feedId: uuid(1) + '&user_id=eq.x' }, 'cron-secret')).status === 400);
  check('a scheduled feed answers 404 for an unknown id', (await call({ scheduled: true, feedId: uuid(99) }, 'cron-secret')).status === 404);
  check('the user path still wants a token', (await call({ feedId: uuid(1) })).status === 401);

  for (const k of Object.keys(patches)) delete patches[k];
  selfCalls.length = 0;

  const response = await call({ all: true }, 'cron-secret');
  const summary = await response.json();
  check('the run answers 200 with counts', response.status === 200 && JSON.stringify(summary) === JSON.stringify({ ok: true, due: 7, synced: 5, failed: 0, died: 1, deferred: 1 }), summary);
  check('each due feed got its own invocation, carrying the secret', selfCalls.length === 7 && selfCalls.every((c) => c.body.scheduled === true && c.secret === 'cron-secret' && c.auth === 'Bearer anon-key'), selfCalls);
  check('the lapsed account was not synced', !selfCalls.some((c) => c.body.feedId === uuid(3)) && !patches[uuid(3)]);
  check('workers ran in parallel, at most six', peak > 1 && peak <= 6, peak);

  const synced = FEEDS.filter((f) => f.id !== KILLED && f.id !== REFUSED && f.id !== uuid(3));
  check('every other feed synced and cleared its error', synced.every((f) => patches[f.id] && patches[f.id].last_error === null && patches[f.id].event_count === 1), patches);
  check('every other feed stored its event', synced.every((f) => events[f.id] && events[f.id].length === 1));
  check('the killed feed now says so, instead of nothing', patches[KILLED] && /did not finish/.test(patches[KILLED].last_error) && typeof patches[KILLED].last_synced === 'string', patches[KILLED]);
  check('the killed feed stored nothing', !events[KILLED]);
  check('a refused call is not blamed on the feed: no error, no timestamp', !patches[REFUSED] && !events[REFUSED], patches[REFUSED]);
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
