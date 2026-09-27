#!/usr/bin/env node
/* ============================================================
   Shift alerts simulation — does "Time reached" fire exactly once,
   at the right moment, for every kind of shift?

   Written after a 1pm to 9pm shift lost its "Time reached": the old
   midnight wrap in computeTimer read that shift as still running at
   00:00, marked the new day's "done" flag, and the real alerts at 5pm
   and 9pm never came. notify-milestones had the same line, and pushed
   a bogus "Time reached" at midnight instead.

   It slices the REAL functions out of app/app.js and
   supabase/functions/notify-milestones/index.ts, drives them with a
   fake clock across whole days, and compares every alert with what the
   schedule alone says should happen. The oracle below never calls the
   app's code: a shift's target is its start day plus the target time,
   read on the local wall clock, and the alert is due the first moment
   that wall clock shows it (the first pass when clocks go back, the end
   of the gap when they go forward).

   Checked, for every scenario:
   - the app at 1 s ticks, and at 60 s ticks (a background tab) landing
     on :30 and on :59 of each minute;
   - the edge function at one cron run a minute, at :05 and at :55;
   - each "Time reached" and each 30/15/10/5 minute alert: once, at the
     right moment, tagged with the day the shift STARTED, and nothing
     else;
   - at chosen instants, what the pies show (not started, running, done)
     and which day's shift they are counting.

   Run:  node tools/shift-alerts-sim.js
         node tools/shift-alerts-sim.js --baseline robustness --baseline main
         node tools/shift-alerts-sim.js --only afternoon --verbose
   A baseline is any git ref; its failures are printed but do not fail
   the run. Exit code 1 if the working tree fails anything.

   TZ is set at runtime, per scenario (Node on Windows can ignore it at
   startup). Takes about a minute: mostly the 1 s ticks.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = 'app/app.js';
const SERVER = 'supabase/functions/notify-milestones/index.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const VERBOSE = flag('--verbose');
const ONLY = values('--only');

/* ─────────────────────────── Slicing the real code ─────────────────────────── */

/* Index just past the bracket that closes the one at `open`, skipping
   strings and comments so a brace inside either can't end it early. */
function matchClose(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (--depth === 0) return i + 1; }
  }
  throw new Error('unbalanced from ' + open);
}

function fn(src, name, optional) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) { if (optional) return ''; throw new Error('missing function ' + name); }
  return src.slice(at, matchClose(src, src.indexOf('{', src.indexOf(')', at))));
}

function varDecl(src, name, optional) {
  const m = new RegExp('var ' + name + ' = ').exec(src);
  if (!m) { if (optional) return ''; throw new Error('missing var ' + name); }
  const valueAt = m.index + m[0].length;
  const end = '{['.includes(src[valueAt]) ? matchClose(src, valueAt) : src.indexOf(';', valueAt);
  return src.slice(m.index, end) + ';';
}

function block(src, head) {
  const at = src.indexOf(head);
  if (at < 0) throw new Error('missing block ' + head);
  return src.slice(at, matchClose(src, at + head.length - 1));
}

function readVersion(ref, file) {
  const raw = ref
    ? execFileSync('git', ['show', ref + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    : fs.readFileSync(path.join(ROOT, file), 'utf8');
  return raw.split('\r\n').join('\n');
}

/* The fake clock. Date.now() and a bare new Date() read CLOCK.real; the
   wall clock is whatever that instant is in process.env.TZ. */
const RealDate = Date;
const CLOCK = { real: 0 };
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(CLOCK.real); else super(...a); }
  static now() { return CLOCK.real; }
}

/* The app's timer and alert code, as one tab. render()'s alert lines
   are copied here, and checked against render() itself, so if render()
   changes shape this refuses to run rather than test something else. */
function loadApp(ref) {
  const src = readVersion(ref, APP);
  const byShift = src.includes('function currentShift(');
  const render = fn(src, 'render');

  const lines = byShift
    ? ['var pies = workPies(now);', 'var shift = pies.shift;', 'var lunchTimer = pies.lunch;',
       'var endTimer = pies.end;',
       "checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);",
       "checkAlerts('end', endTimer, endLabel(shift.day), shift.key);"]
    : ['var cfg = dayConfig(now);', 'var todayKey = now.toDateString();',
       "var lunchTimer = working ? computeTimer(now, cfg.start, cfg.lunch) : { available: false };",
       "var endTimer = working ? computeTimer(now, cfg.start, cfg.end) : { available: false };",
       "checkAlerts('lunch', lunchTimer, lunchLabel(today), todayKey);",
       "checkAlerts('end', endTimer, endLabel(today), todayKey);"];
  lines.forEach((line) => {
    if (!render.includes(line)) {
      throw new Error((ref || 'working tree') + ': render() no longer contains\n    ' + line +
                      '\n  Update loadApp() in this harness to match render().');
    }
  });
  const reset = block(src, 'if (todayKey !== lastDayKey) {');

  const tick = byShift ? `
      var now = new Date();
      var todayKey = now.toDateString();
      var pies = workPies(now);
      var shift = pies.shift;
      ${reset}
      var lunchTimer = pies.lunch;
      var endTimer = pies.end;
      checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);
      checkAlerts('end', endTimer, endLabel(shift.day), shift.key);
      return { lunch: lunchTimer, end: endTimer, key: shift.key };` : `
      var now = new Date();
      var today = dayNameOf(now);
      var cfg = dayConfig(now);
      var todayKey = now.toDateString();
      ${reset}
      var working = cfg && cfg.working;
      var lunchTimer = working ? computeTimer(now, cfg.start, cfg.lunch) : { available: false };
      var endTimer = working ? computeTimer(now, cfg.start, cfg.end) : { available: false };
      checkAlerts('lunch', lunchTimer, lunchLabel(today), todayKey);
      checkAlerts('end', endTimer, endLabel(today), todayKey);
      return { lunch: lunchTimer, end: endTimer, key: todayKey };`;

  const code = [
    varDecl(src, 'DAYS'), varDecl(src, 'MILESTONES'), varDecl(src, 'AGENDA'),
    varDecl(src, 'DONE_ALERT_WINDOW_SEC', true), varDecl(src, 'NIGHT_SHIFT_HOLD_SEC', true),
    ...['pad', 'isMinute', 'isoDate', 'secondsSinceMidnight', 'dayNameOf', 'dayConfig', 'hasAgenda',
        'computeTimer', 'checkAlerts', 'tagFor', 'lunchLabel', 'endLabel'].map((n) => fn(src, n)),
    ...['currentShift', 'worksOn', 'shiftLengthSec', 'workPies'].map((n) => fn(src, n, true)),
    `var state = { settings: { alerts: true, lunchLabel: 'Lunch' }, schedule: SCHEDULE, appointments: [] };
     var firedAlerts = {}, lastSeenRunning = {}, lastDayKey = null;
     function notify(title, body, tag) { LOG.push({ real: Date.now(), title: title, body: body, tag: tag }); }
     return function tick() { ${tick} };`,
  ].join('\n');

  // A fresh tab: new state, nothing fired, nothing seen.
  return (schedule, log) => new Function('Date', 'SCHEDULE', 'LOG', code)(FakeDate, schedule, log);
}

/* The edge function's decision code, from the constants to the Main
   banner. Types are stripped with Node's own stripper. A version from
   before dueAlerts() existed gets its old loop replayed by hand. */
function loadServer(ref) {
  let src = readVersion(ref, SERVER);
  const from = src.indexOf('const MILESTONES');
  const to = src.indexOf('/* ─────────────────────────── Main');
  if (from < 0 || to < 0) throw new Error('notify-milestones: markers moved');
  const quiet = process.emitWarning;
  process.emitWarning = () => {};  // stripTypeScriptTypes is flagged experimental
  const js = require('node:module').stripTypeScriptTypes(src.slice(from, to));
  process.emitWarning = quiet;

  if (js.includes('function dueAlerts(')) {
    return new Function('Date', js + '\nreturn dueAlerts;')(FakeDate);
  }
  const old = new Function('Date', js + '\nreturn { localNow, remainingMinutes, isMinute, MILESTONES };')(FakeDate);
  return function dueAlerts(schedule, timezone, at) {
    CLOCK.real = at.getTime();
    const now = old.localNow(timezone);
    const day = schedule && schedule[now.dayName];
    if (!day || !day.working || !old.isMinute(day.start)) return [];
    const due = [];
    for (const [key, target] of [['lunch', day.lunch], ['end', day.end]]) {
      if (!old.isMinute(target)) continue;
      const remaining = old.remainingMinutes(now.minutes, day.start, target);
      if (remaining === null) continue;
      if (remaining === 0) { due.push({ key, isoDate: now.isoDate, milestone: 'done', body: 'Time reached.' }); continue; }
      const hit = old.MILESTONES.find((m) => m === remaining);
      if (hit !== undefined) due.push({ key, isoDate: now.isoDate, milestone: String(hit), body: hit + ' minutes remaining.' });
    }
    return due;
  };
}

/* ─────────────────────────── The oracle: wall-clock arithmetic ─────────────────────────── */

const DAYNAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MILESTONE_MARKS = [30, 15, 10, 5];
const DONE_WINDOW_MS = 120 * 1000;

const formatters = {};
function wall(real, tz) {
  const f = formatters[tz] || (formatters[tz] = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const part of f.formatToParts(new RealDate(real))) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const wallNum = (w) => ((w.y * 100 + w.mo) * 100 + w.d) * 1e6 + w.h * 1e4 + w.mi * 100 + (w.s || 0);
const iso = (w) => `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/* Calendar day plus minutes, as pure calendar arithmetic (UTC has no DST). */
function addMinutes(day, minutes) {
  const u = new RealDate(RealDate.UTC(day.y, day.mo - 1, day.d, 0, minutes));
  return { y: u.getUTCFullYear(), mo: u.getUTCMonth() + 1, d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: 0 };
}
const weekday = (day) => DAYNAMES[(new RealDate(RealDate.UTC(day.y, day.mo - 1, day.d)).getUTCDay() + 6) % 7];

/* The first real instant whose local wall clock reads `w` or later. */
function firstRealAt(w, tz) {
  const want = wallNum(w);
  let t = RealDate.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s || 0) - 15 * 3600e3;
  for (let i = 0; i < 31 * 60; i++, t += 60000) if (wallNum(wall(t, tz)) >= want) return t;
  throw new Error('no instant for ' + JSON.stringify(w) + ' in ' + tz);
}
const wallExists = (w, tz) => wallNum(wall(firstRealAt(w, tz), tz)) === wallNum(w);

function parseWall(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/.exec(text);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
}

/* Every alert the schedule says is due in [t0, t1), from the schedule
   alone. A shift belongs to the day it starts; its targets fall on that
   day, or the next when they are at or before the start. */
function expectedAlerts(schedule, tz, t0, t1) {
  const out = [];
  const first = wall(t0, tz);
  for (let offset = -1; ; offset++) {
    const day = addMinutes({ y: first.y, mo: first.mo, d: first.d }, offset * 1440);
    if (firstRealAt(day, tz) >= t1) break;
    const cfg = schedule[weekday(day)];
    if (!cfg || !cfg.working) continue;
    for (const prefix of ['lunch', 'end']) {
      const target = cfg[prefix];
      if (typeof target !== 'number') continue;
      let total = target - cfg.start;
      if (total <= 0) total += 1440;
      const at = addMinutes(day, cfg.start + total);
      const reached = firstRealAt(at, tz);
      /* A tab opened after the target says nothing, unless it opened
         within two minutes of it (checkAlerts' rule for a fresh open). */
      if (reached < t1 && reached >= t0 - DONE_WINDOW_MS) {
        out.push({ tag: `${iso(day)}|${prefix}|done`, body: 'Time reached.', due: reached, slack: 0 });
      }
      for (const mark of MILESTONE_MARKS) {
        if (total < mark) continue;
        const w = addMinutes(day, cfg.start + total - mark);
        if (!wallExists(w, tz)) continue;          // inside a spring-forward gap
        const r = firstRealAt(w, tz);
        if (r + 60000 <= t0 || r >= t1) continue;
        out.push({ tag: `${iso(day)}|${prefix}|${mark}`, body: `${mark} minutes remaining.`, due: r, slack: 60000 });
      }
    }
  }
  return out;
}

/* ─────────────────────────── Running ─────────────────────────── */

function runApp(makeTab, schedule, t0, t1, step, phase, probes) {
  const log = [];
  const tick = makeTab(schedule, log);
  const seen = [];
  const pending = probes.slice().sort((a, b) => a.real - b.real);
  for (let t = t0 + phase; t < t1; t += step) {
    CLOCK.real = t;
    const out = tick();
    while (pending.length && pending[0].real <= t) {
      const p = pending.shift();
      if (p.real === t) seen.push({ probe: p, out });
    }
  }
  return { log, seen };
}

function runServer(dueAlerts, schedule, tz, t0, t1, second) {
  const claimed = new Set();
  const log = [];
  for (let t = Math.ceil(t0 / 60000) * 60000 + second * 1000; t < t1; t += 60000) {
    for (const a of dueAlerts(schedule, tz, new RealDate(t))) {
      const tag = `${a.isoDate}|${a.key}|${a.milestone}`;
      if (claimed.has(tag)) continue;              // claim(): the primary key refuses a repeat
      claimed.add(tag);
      log.push({ real: t, body: a.body, tag });
    }
  }
  return log;
}

function stateOf(timer) {
  if (!timer.available) return 'off';
  if (timer.notStarted) return 'not started';
  return timer.done ? 'done' : 'running';
}

/* Match each actual alert to an expected one: same tag and text, inside
   [due, due + slack], with slack at least the tick. A baseline is
   compared with the date left out of the tag, because filing a night
   shift's alerts under the day it started is itself part of this fix;
   what is left is the timing: alerts missing, extra or late. */
function compare(expected, actual, t0, step, tz, loose) {
  const problems = [];
  const left = actual.slice();
  const undated = (tag) => tag.replace(/^[\d-]+\|/, '');
  const same = loose
    ? (a, e) => undated(a.tag) === undated(e.tag) && a.body === e.body
    : (a, e) => a.tag === e.tag && a.body === e.body;
  for (const e of expected) {
    const from = Math.max(e.due, t0);
    const until = Math.max(e.due + e.slack, from + step);
    const i = left.findIndex((a) => same(a, e) && a.real >= from && a.real < until);
    if (i < 0) {
      const near = left.filter((a) => same(a, e));
      problems.push(`missing ${e.body} [${e.tag}] due ${show(e.due, tz)}` +
                    (near.length ? `, got it at ${near.map((a) => show(a.real, tz)).join(', ')}` : ''));
    } else {
      left.splice(i, 1);
    }
  }
  left.forEach((a) => problems.push(`UNEXPECTED ${a.body} [${a.tag}] at ${show(a.real, tz)}`));
  return problems;
}

function show(real, tz) {
  const w = wall(real, tz);
  return `${DAYNAMES[(new RealDate(RealDate.UTC(w.y, w.mo - 1, w.d)).getUTCDay() + 6) % 7].slice(0, 3)} ${iso(w)} ` +
         `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}:${String(w.s).padStart(2, '0')}`;
}

/* Offset changes in the window, so a DST scenario proves it crossed one. */
function transitions(tz, t0, t1) {
  const found = [];
  const offset = (t) => { const w = wall(t, tz); return (RealDate.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60000) * 60000) / 60000; };
  for (let t = t0, prev = offset(t0); t < t1; t += 60000) {
    const now = offset(t);
    if (now !== prev) found.push(`${show(t - 60000, tz).slice(4)} -> ${show(t, tz).slice(15)}`);
    prev = now;
  }
  return found;
}

/* ─────────────────────────── Scenarios ─────────────────────────── */

const every = (start, lunch, end) =>
  Object.fromEntries(DAYNAMES.map((d) => [d, { working: true, start, lunch, end }]));
const hm = (text) => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
const shift = (s, l, e) => every(hm(s), hm(l), hm(e));

const SCENARIOS = [
  {
    name: 'afternoon shift 13:00 / 17:00 / 21:00 (the reported bug)',
    tz: 'Australia/Adelaide', schedule: shift('13:00', '17:00', '21:00'),
    from: '2026-09-27 12:00', to: '2026-09-30 00:00',
    probes: [
      ['2026-09-28 00:00:00', 'not started', 'not started', '2026-09-28'],
      ['2026-09-28 00:59:59', 'not started', 'not started', '2026-09-28'],
      ['2026-09-28 12:59:59', 'not started', 'not started', '2026-09-28'],
      ['2026-09-28 13:00:00', 'running', 'running', '2026-09-28'],
      ['2026-09-28 17:00:00', 'done', 'running', '2026-09-28'],
      ['2026-09-28 23:59:59', 'done', 'done', '2026-09-28'],
    ],
  },
  {
    name: 'afternoon shift, tab first opened at 00:30',
    tz: 'Australia/Adelaide', schedule: shift('13:00', '17:00', '21:00'),
    from: '2026-09-28 00:30', to: '2026-09-29 00:00',
  },
  {
    name: 'evening shift 20:00 / 23:00 / 04:00, lunch before midnight',
    tz: 'Australia/Adelaide', schedule: shift('20:00', '23:00', '04:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [
      ['2026-09-29 01:00:00', 'done', 'running', '2026-09-28'],
      ['2026-09-29 04:00:00', 'done', 'done', '2026-09-28'],
      ['2026-09-29 07:59:59', 'done', 'done', '2026-09-28'],
      ['2026-09-29 08:00:00', 'not started', 'not started', '2026-09-29'],
    ],
  },
  {
    name: 'evening shift, tab first opened at 01:00',
    tz: 'Australia/Adelaide', schedule: shift('20:00', '23:00', '04:00'),
    from: '2026-09-29 01:00', to: '2026-09-29 12:00',
    probes: [['2026-09-29 01:00:00', 'done', 'running', '2026-09-28']],
  },
  {
    name: 'night shift 22:00 / 02:00 / 06:00, lunch after midnight',
    tz: 'Australia/Adelaide', schedule: shift('22:00', '02:00', '06:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [
      ['2026-09-29 01:00:00', 'running', 'running', '2026-09-28'],
      ['2026-09-29 09:59:59', 'done', 'done', '2026-09-28'],
      ['2026-09-29 10:00:00', 'not started', 'not started', '2026-09-29'],
    ],
  },
  {
    name: 'night shift, tab first opened at 06:01 (fresh open just after)',
    tz: 'Australia/Adelaide', schedule: shift('22:00', '02:00', '06:00'),
    from: '2026-09-29 06:01', to: '2026-09-29 12:00',
  },
  {
    name: 'finishing at exactly midnight 16:00 / 20:00 / 00:00',
    tz: 'Australia/Adelaide', schedule: shift('16:00', '20:00', '00:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [
      ['2026-09-29 00:00:00', 'done', 'done', '2026-09-28'],
      ['2026-09-29 03:59:59', 'done', 'done', '2026-09-28'],
      ['2026-09-29 04:00:00', 'not started', 'not started', '2026-09-29'],
    ],
  },
  {
    name: 'finishing one minute before midnight 16:00 / 20:00 / 23:59',
    tz: 'Australia/Adelaide', schedule: shift('16:00', '20:00', '23:59'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [['2026-09-29 00:00:00', 'not started', 'not started', '2026-09-29']],
  },
  {
    name: 'night shift with lunch at 23:59 (no repeat at midnight)',
    tz: 'Australia/Adelaide', schedule: shift('20:00', '23:59', '04:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
  },
  {
    name: '12-hour night shift 19:00 / 01:00 / 07:00',
    tz: 'Australia/Adelaide', schedule: shift('19:00', '01:00', '07:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [['2026-09-29 07:00:00', 'done', 'done', '2026-09-28']],
  },
  {
    name: '14-hour night shift 20:00 / 03:00 / 10:00',
    tz: 'Australia/Adelaide', schedule: shift('20:00', '03:00', '10:00'),
    from: '2026-09-28 12:00', to: '2026-09-30 12:00',
    probes: [['2026-09-29 09:00:00', 'done', 'running', '2026-09-28']],
  },
  {
    name: 'rotating roster: nights, an afternoon, days off',
    tz: 'Australia/Adelaide',
    schedule: {
      Monday:    { working: true,  start: hm('22:00'), lunch: hm('02:00'), end: hm('06:00') },
      Tuesday:   { working: true,  start: hm('13:00'), lunch: hm('17:00'), end: hm('21:00') },
      Wednesday: { working: false, start: hm('22:00'), lunch: hm('02:00'), end: hm('06:00') },
      Thursday:  { working: true,  start: hm('22:00'), lunch: hm('02:00'), end: hm('06:00') },
      Friday:    { working: false, start: hm('09:00'), lunch: hm('12:30'), end: hm('17:00') },
      Saturday:  { working: true,  start: hm('09:00'), lunch: hm('12:30'), end: hm('17:00') },
      Sunday:    { working: false, start: hm('09:00'), lunch: hm('12:30'), end: hm('17:00') },
    },
    from: '2026-09-28 12:00', to: '2026-10-03 20:00',
    probes: [
      ['2026-09-29 01:00:00', 'running', 'running', '2026-09-28'],   // Monday night, on Tuesday
      ['2026-10-01 01:00:00', 'not started', 'not started', '2026-10-01'], // Wednesday was off
      ['2026-10-02 01:00:00', 'running', 'running', '2026-10-01'],   // Friday is off; Thursday night runs on
      ['2026-10-02 10:00:00', 'off', 'off', '2026-10-02'],
    ],
  },
];

/* The same shapes of shift across every daylight saving change that
   broke something while PR #23 was built, including the zones where
   the clocks change at midnight. Each runs from noon the day before to
   noon the day after. */
const DST = [
  ['Australia/Adelaide', '2026-10-04'], ['Australia/Adelaide', '2027-04-04'],
  ['America/New_York', '2027-03-14'], ['America/New_York', '2026-11-01'],
  ['Europe/Berlin', '2027-03-28'], ['America/Havana', '2027-03-14'],
  ['America/Santiago', '2027-09-05'], ['America/Santiago', '2027-04-04'],
  ['Asia/Beirut', '2027-03-28'], ['Atlantic/Azores', '2027-03-28'],
];
const DST_SHIFTS = [
  ['13:00', '17:00', '21:00'], ['22:00', '02:00', '06:00'], ['22:00', '02:30', '06:00'],
  ['21:00', '02:00', '03:00'], ['20:00', '23:00', '04:00'], ['16:00', '20:00', '00:00'],
  ['22:00', '00:30', '06:00'], ['22:00', '23:30', '06:00'], ['23:00', '01:30', '07:00'],
];
for (const [tz, date] of DST) {
  const day = parseWall(date + ' 00:00');
  const before = addMinutes(day, -720);
  const after = addMinutes(day, 2160);
  for (const [s, l, e] of DST_SHIFTS) {
    SCENARIOS.push({
      name: `DST ${s} / ${l} / ${e}`, tz, dst: true, schedule: shift(s, l, e),
      from: `${iso(before)} 12:00`, to: `${iso(after)} 12:00`,
    });
  }
}

/* ─────────────────────────── Main ─────────────────────────── */

const APP_TICKS = [['1s', 1000, 0], ['60s@:30', 60000, 30000], ['60s@:59', 60000, 59000]];
const CRON = [['cron@:05', 5], ['cron@:55', 55]];

function runAll(label, makeTab, dueAlerts, strict) {
  let failed = 0;
  let checks = 0;
  const started = RealDate.now();
  console.log(`\n=== ${label}${strict ? '' : ' (timing only: tag dates not compared)'} ===`);
  const byZone = {};
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.some((o) => (sc.name + ' ' + sc.tz).toLowerCase().includes(o.toLowerCase()))) continue;
    process.env.TZ = sc.tz;
    const t0 = firstRealAt(parseWall(sc.from), sc.tz);
    const t1 = firstRealAt(parseWall(sc.to), sc.tz);
    const expected = expectedAlerts(sc.schedule, sc.tz, t0, t1);
    const probes = (sc.probes || []).map(([at, lunch, end, key]) => ({ at, real: firstRealAt(parseWall(at), sc.tz), lunch, end, key }));
    const problems = [];

    if (sc.dst) {
      const tr = transitions(sc.tz, t0, t1);
      if (!tr.length) problems.push('no clock change inside the window: this scenario tests nothing');
      const zoneKey = sc.tz + ' ' + sc.from.slice(0, 10);
      if (!byZone[zoneKey]) { byZone[zoneKey] = true; console.log(`  -- ${sc.tz}: ${tr.join('; ') || 'NO TRANSITION'}`); }
    }

    for (const [mode, step, phase] of APP_TICKS) {
      const { log, seen } = runApp(makeTab, sc.schedule, t0, t1, step, phase, step === 1000 ? probes : []);
      compare(expected, log, t0, step, sc.tz, !strict).forEach((p) => problems.push(`app ${mode}: ${p}`));
      checks += expected.length;
      if (step === 1000) {
        for (const p of probes) {
          const hit = seen.find((s) => s.probe === p);
          if (!hit) { problems.push(`probe ${p.at}: no tick landed on it`); continue; }
          const got = [stateOf(hit.out.lunch), stateOf(hit.out.end), iso(wall(new RealDate(hit.out.key).getTime(), sc.tz))];
          const want = [p.lunch, p.end, p.key];
          if (!strict) { got.pop(); want.pop(); }  // older code has no shift day of its own
          checks++;
          if (got.join() !== want.join()) {
            problems.push(`probe ${p.at}: lunch ${got[0]}, end ${got[1]}, shift of ${got[2]}; wanted ${want[0]}, ${want[1]}, ${want[2]}`);
          }
        }
        if (VERBOSE) {
          log.filter((a) => a.body === 'Time reached.').forEach((a) => console.log(`      ${show(a.real, sc.tz)}  Time reached  [${a.tag}]`));
        }
      }
    }
    for (const [mode, second] of CRON) {
      const log = runServer(dueAlerts, sc.schedule, sc.tz, t0, t1, second);
      compare(expected, log, t0, 60000, sc.tz, !strict).forEach((p) => problems.push(`push ${mode}: ${p}`));
      checks += expected.length;
    }

    const reached = expected.filter((e) => e.body === 'Time reached.').length;
    const name = `${sc.tz.split('/').pop()}: ${sc.name}`;
    if (problems.length) {
      failed++;
      console.log(`  FAIL  ${name}`);
      const shown = VERBOSE ? problems : problems.slice(0, 8);
      shown.forEach((p) => console.log('        ' + p));
      if (shown.length < problems.length) console.log(`        ... and ${problems.length - shown.length} more (--verbose)`);
    } else {
      console.log(`  pass  ${name}  (${reached} "Time reached", ${expected.length - reached} milestones, 5 clocks)`);
    }
  }
  const secs = ((RealDate.now() - started) / 1000).toFixed(0);
  console.log(`  ${label}: ${failed ? failed + ' scenario(s) FAILED' : 'all passed'}, ${checks} checks, ${secs}s`);
  if (strict && failed) process.exitCode = 1;
  return failed;
}

runAll('working tree', loadApp(null), loadServer(null), true);
for (const ref of values('--baseline')) runAll(`baseline ${ref}`, loadApp(ref), loadServer(ref), false);
