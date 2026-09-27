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

   The "breaks:" scenarios add a breaks record (the profile's `breaks`
   column, the app's BREAKS_KEY) and settings, and check every break
   alert as well: an extra break's heads-up, start and finish, lunch's
   finish and its "Break time. Back at ..." start, by tag, words AND
   title, on both sides. The oracle reads the record as the spec lays it
   out and never calls normaliseBreaks(): a scenario whose record is
   mangled says what it should read as, in `expect`. The app runs the
   lines render() runs for breaks (BREAK_LINES below); if app/app.js has
   no break alerts yet, those scenarios fail on the app side and still
   test the server.

   Run:  node tools/shift-alerts-sim.js
         node tools/shift-alerts-sim.js --baseline robustness --baseline main
         node tools/shift-alerts-sim.js --only afternoon --verbose
         node tools/shift-alerts-sim.js --only breaks:
   A baseline is any git ref; its failures are printed but do not fail
   the run, and a baseline from before breaks skips the breaks
   scenarios. Exit code 1 if the working tree fails anything.

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

/* render()'s break lines, in render()'s order around the two
   checkAlerts() calls: the shift day's breaks, lunch's start words when
   it has a length, and the break alerts. Compared with render() with
   comments and spacing set aside, since the second one spans lines. */
const BREAK_LINES = [
  'var shiftBreaks = pies.working ? dayBreaks(shift.cfg, shift.day) : [];',
  "shiftBreaks.forEach(function (brk) { if (brk.isLunch && brk.minutes) { " +
    "lunchTimer.doneBody = 'Break time. Back at ' + formatClock(breakFinish(brk)) + '.'; } });",
  "checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);",
  "checkAlerts('end', endTimer, endLabel(shift.day), shift.key);",
  'checkBreakAlerts(shift, shiftBreaks);',
];
const squash = (code) => code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ');

/* What the break lines need beyond the classic tab, sliced as they are. */
const BREAK_VARS = ['MAX_BREAKS', 'BREAK_MIN_MINUTES', 'BREAK_MAX_MINUTES'];
const BREAK_FNS = ['isRecord', 'hhmmToMinutes', 'formatClock', 'emptyBreakDay', 'emptyBreaks', 'breakStart',
                   'breakLength', 'normaliseBreaks', 'breakKey', 'relMinute', 'dayBreaks', 'breakFinish',
                   'checkBreakAlerts', 'announceReached'];

/* The app's timer and alert code, as one tab. render()'s alert lines
   are copied here, and checked against render() itself, so if render()
   changes shape this refuses to run rather than test something else.

   Returns the classic tab, lunch and End of Day only, which every
   scenario without breaks runs exactly as before. Its `withBreaks` is
   the tab with render()'s break lines too, or null with the reason in
   `breakProblem` when this version of the app has none to run. */
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

  const shared = [
    varDecl(src, 'DAYS'), varDecl(src, 'MILESTONES'), varDecl(src, 'AGENDA'),
    varDecl(src, 'DONE_ALERT_WINDOW_SEC', true), varDecl(src, 'NIGHT_SHIFT_HOLD_SEC', true),
    ...['pad', 'isMinute', 'isoDate', 'secondsSinceMidnight', 'dayNameOf', 'dayConfig', 'hasAgenda',
        'computeTimer', 'checkAlerts', 'tagFor', 'lunchLabel', 'endLabel'].map((n) => fn(src, n)),
    ...['currentShift', 'worksOn', 'shiftLengthSec', 'workPies'].map((n) => fn(src, n, true)),
    // SETTINGS is undefined for a scenario without breaks: exactly the old tab.
    `var state = { settings: Object.assign({ alerts: true, lunchLabel: 'Lunch' }, SETTINGS), schedule: SCHEDULE, appointments: [] };
     var firedAlerts = {}, lastSeenRunning = {}, lastDayKey = null;
     function notify(title, body, tag) { LOG.push({ real: Date.now(), title: title, body: body, tag: tag }); }
     // render()'s new-day block puts the day's labels back on the page, which a tab here does not have.
     function applyLunchLabel() {}`,
  ];
  const code = [...shared, `return function tick() { ${tick} };`].join('\n');

  // A fresh tab: new state, nothing fired, nothing seen.
  const tab = (body) => (sc, log) =>
    new Function('Date', 'SCHEDULE', 'LOG', 'SETTINGS', 'BREAKS', body)(FakeDate, sc.schedule, log, sc.settings, sc.breaks);
  const classic = tab(code);

  /* The same tab with render()'s break lines. The record goes through
     the app's own normaliseBreaks(), as loadBreaks() and a pull put it. */
  const flat = squash(render);
  let at = -1;
  const lost = BREAK_LINES.filter((line) => {
    const i = flat.indexOf(squash(line), at + 1);
    if (i < 0) return true;
    at = i;
    return false;
  });
  if (!byShift || !src.includes('function checkBreakAlerts(')) {
    classic.breakProblem = 'app/app.js has no break alerts yet (no checkBreakAlerts())';
  } else if (lost.length) {
    classic.breakProblem = 'render() no longer contains, in this order,\n          ' + lost.join('\n          ') +
                           '\n        Update BREAK_LINES in this harness to match render().';
  }
  if (classic.breakProblem) {
    classic.withBreaks = null;
    return classic;
  }
  const breakTick = tick.replace(
    "checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);",
    BREAK_LINES[0] + '\n      ' + BREAK_LINES[1] + '\n      ' + BREAK_LINES[2]
  ).replace(
    "checkAlerts('end', endTimer, endLabel(shift.day), shift.key);",
    BREAK_LINES[3] + '\n      ' + BREAK_LINES[4]
  );
  classic.withBreaks = tab([
    ...shared,
    ...BREAK_VARS.map((n) => varDecl(src, n)),
    ...BREAK_FNS.map((n) => fn(src, n)),
    'var breaks = normaliseBreaks(BREAKS, SCHEDULE);',
    `return function tick() { ${breakTick} };`,
  ].join('\n'));
  return classic;
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
    const dueAlerts = new Function('Date', js + '\nreturn dueAlerts;')(FakeDate);
    // dueAlerts(schedule, timezone, at, settings, breaks) from breaks on.
    dueAlerts.withBreaks = js.includes('function normaliseBreaks(');
    return dueAlerts;
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
const HEADS_UP = 5;                 // an extra break's one warning, in minutes
const HOLD_MIN = 4 * 60;            // how long a finished night shift stays on the pies

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

/* The app's 12 or 24 hour clock, "10:45 AM" or "10:45", written out
   again so the oracle does not borrow formatClock(). */
function clockText(minute, clock24) {
  const h = Math.floor(minute / 60) % 24;
  const mm = String(minute % 60).padStart(2, '0');
  return clock24 ? `${String(h).padStart(2, '0')}:${mm}` : `${(h + 11) % 12 + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/* One day's breaks as the spec lists them: lunch from the schedule,
   the others from the record, in the order the day meets them counting
   from its start, and by key when two start together. */
function breaksOn(cfg, entry, settings) {
  const after = (t) => (t - cfg.start + 1440) % 1440;
  const list = [];
  if (typeof cfg.lunch === 'number') {
    list.push({ key: 'lunch', start: cfg.lunch, minutes: entry.lunchMinutes || null,
                name: settings.lunchLabel || 'Lunch', headHome: !!cfg.lunchHeadHome, lunch: true });
  }
  for (const e of entry.extras || []) {
    list.push({ key: 'brk' + e.start + (e.minutes ? '-' + (e.start + e.minutes) % 1440 : ''),
                start: e.start, minutes: e.minutes || null, name: e.name || 'Break', headHome: !!e.headHome });
  }
  return list.sort((a, b) => after(a.start) - after(b.start) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* Whether the shift that starts on `day` is still the one on the pies
   `rel` minutes after it starts: until midnight; past midnight only when
   its lunch or End of Day runs past it, and then until four hours after
   the later one, but never once the next day's own shift has started.
   A lunch or End of Day falls inside its own shift, bar one case: on
   back-to-back 24-hour shifts, End of Day is the very minute the next
   day's shift starts and takes the pies, so its "Time reached" never
   comes, in the app or the push. That was so before breaks existed too
   (checked against HEAD, 27 Sep): pinned here as found, not as chosen.
   A break before Start sits outside the shift, so its heads-up and
   start never come (its finish can: see the End of Day scenario). */
function onPies(schedule, day, cfg, rel) {
  const t = cfg.start + rel;
  if (t < 1440) return true;
  const spans = ['lunch', 'end'].filter((k) => typeof cfg[k] === 'number')
    .map((k) => (cfg[k] - cfg.start + 1440) % 1440 || 1440);
  const pastMidnight = cfg.start + Math.max(0, ...spans) - 1440;
  const next = schedule[weekday(addMinutes(day, 1440))];
  if (next && next.working && t - 1440 >= next.start) return false;
  return pastMidnight >= 0 && t - 1440 < pastMidnight + HOLD_MIN;
}

/* Every alert the schedule says is due in [t0, t1), from the schedule
   alone. A shift belongs to the day it starts; its targets fall on that
   day, or the next when they are at or before the start.

   With a breaks record (and the settings that name lunch and pick the
   clock), each break's alerts are added from the spec's table. Titles
   are expected for those only: lunch's and End of Day's titles were never
   the same in a push and in the page, and are not this harness's to pin. */
function expectedAlerts(schedule, tz, t0, t1, breaks, settings) {
  const out = [];
  const first = wall(t0, tz);
  settings = settings || {};

  /* A start or finish is due the moment the wall clock shows it. A tab
     opened after it says nothing, unless it opened within two minutes of
     it (checkAlerts' rule for a fresh open). */
  const reached = (day, minutes, tag, body, title) => {
    const r = firstRealAt(addMinutes(day, minutes), tz);
    if (r < t1 && r >= t0 - DONE_WINDOW_MS) out.push({ tag, title, body, due: r, slack: 0 });
  };
  /* A countdown mark is due in the minute it names, and not at all when
     that minute is inside a spring-forward gap. */
  const counted = (day, minutes, tag, body, title) => {
    const w = addMinutes(day, minutes);
    if (!wallExists(w, tz)) return;
    const r = firstRealAt(w, tz);
    if (r + 60000 <= t0 || r >= t1) return;
    out.push({ tag, title, body, due: r, slack: 60000 });
  };

  for (let offset = -1; ; offset++) {
    const day = addMinutes({ y: first.y, mo: first.mo, d: first.d }, offset * 1440);
    if (firstRealAt(day, tz) >= t1) break;
    const cfg = schedule[weekday(day)];
    if (!cfg || !cfg.working) continue;
    const entry = (breaks && breaks.days && breaks.days[weekday(day)]) || { lunchMinutes: null, extras: [] };
    for (const prefix of ['lunch', 'end']) {
      const target = cfg[prefix];
      if (typeof target !== 'number') continue;
      let total = target - cfg.start;
      if (total <= 0) total += 1440;
      /* A lunch with a set length is a break starting, so it says when
         it ends. */
      const body = prefix === 'lunch' && entry.lunchMinutes
        ? `Break time. Back at ${clockText((target + entry.lunchMinutes) % 1440, settings.clock24)}.`
        : 'Time reached.';
      if (onPies(schedule, day, cfg, total)) reached(day, cfg.start + total, `${iso(day)}|${prefix}|done`, body);
      for (const mark of MILESTONE_MARKS) {
        if (total < mark || !onPies(schedule, day, cfg, total - mark)) continue;
        counted(day, cfg.start + total - mark, `${iso(day)}|${prefix}|${mark}`, `${mark} minutes remaining.`);
      }
    }
    if (!breaks) continue;

    /* The breaks, from the spec's table. Every target counts from the
       day's start, like lunch, so a break at Start itself would be a
       whole day away, as a lunch at Start is; it gets no alerts at all
       (below). End of Day at Start is a
       24-hour shift, as the pies and the Schedule tab's notes read it, so
       End of Day is at +24 h there, not at +0. */
    const after = (t) => (t - cfg.start + 1440) % 1440;
    const endAt = typeof cfg.end === 'number' ? after(cfg.end) || 1440 : null;
    const list = breaksOn(cfg, entry, settings);
    list.forEach((b, i) => {
      const tag = (milestone) => `${iso(day)}|${b.key}|${milestone}`;
      /* A break at exactly Start was never counted to, so none of its
         alerts is due. Its heads-up and start were once left to "never
         come while the shift is on the pies", but a shift still on them
         a day later (a 24-hour shift, or a long one before a day off)
         had both then, on the wrong day (found 27 Sep). It is still the
         break before the next one, for that one's heads-up. */
      const at = after(b.start);
      if (at === 0) return;
      if (!b.lunch) {
        const title = b.name + (b.headHome ? ' | Head Home' : '');
        /* No heads-up landing at or before the previous break's finish
           (its start, when it has no length). */
        const prev = list[i - 1];
        const prevFinish = prev ? after((prev.start + (prev.minutes || 0)) % 1440) : null;
        if (at >= HEADS_UP && (prevFinish === null || after(b.start) - HEADS_UP > prevFinish) &&
            onPies(schedule, day, cfg, at - HEADS_UP)) {
          counted(day, cfg.start + at - HEADS_UP, tag(HEADS_UP), `Starts in ${HEADS_UP} minutes.`, title);
        }
        if (onPies(schedule, day, cfg, at)) {
          reached(day, cfg.start + at, tag('start'), b.minutes
            ? `Break time. Back at ${clockText((b.start + b.minutes) % 1440, settings.clock24)}.`
            : 'Break time.', title);
        }
      }
      /* No "Break over" at or after End of Day: End of Day's own alert
         covers it. rel(finish) >= rel(end), as the spec has it, with a
         24-hour shift's End of Day at +24 h (read literally, rel(end) was 0
         and every finish on one was skipped; fixed 27 Sep). Nor for a
         break that starts before Start and runs past it: like one at
         exactly Start, it was never counted to, so its end is not news
         (decided 27 Sep, after this oracle first pinned the alert). */
      if (b.minutes) {
        const finish = (b.start + b.minutes) % 1440;
        const finishAt = after(finish) || 1440;
        if ((endAt === null || after(finish) < endAt) && at + b.minutes < 1440 &&
            onPies(schedule, day, cfg, finishAt)) {
          reached(day, cfg.start + finishAt, tag('finish'), 'Break over. Ease back in.', b.name);
        }
      }
    });
  }
  return out;
}

/* ─────────────────────────── Running ─────────────────────────── */

function runApp(makeTab, sc, t0, t1, step, phase, probes) {
  const log = [];
  const tick = makeTab(sc, log);
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

/* Settings and breaks are passed as run() passes the profile's; both are
   undefined for a scenario without breaks, which is how dueAlerts() was
   called before breaks existed. */
function runServer(dueAlerts, sc, tz, t0, t1, second) {
  const claimed = new Set();
  const log = [];
  for (let t = Math.ceil(t0 / 60000) * 60000 + second * 1000; t < t1; t += 60000) {
    for (const a of dueAlerts(sc.schedule, tz, new RealDate(t), sc.settings, sc.breaks)) {
      const tag = `${a.isoDate}|${a.key}|${a.milestone}`;
      if (claimed.has(tag)) continue;              // claim(): the primary key refuses a repeat
      claimed.add(tag);
      log.push({ real: t, title: a.label, body: a.body, tag });
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
   [due, due + slack], with slack at least the tick. A break alert's
   title must match too. A baseline is compared with the date left out
   of the tag, because filing a night shift's alerts under the day it
   started is itself part of this fix; what is left is the timing:
   alerts missing, extra or late. */
function compare(expected, actual, t0, step, tz, loose) {
  const problems = [];
  const left = actual.slice();
  const undated = (tag) => tag.replace(/^[\d-]+\|/, '');
  const titled = (a, e) => e.title === undefined || a.title === e.title;
  const same = loose
    ? (a, e) => undated(a.tag) === undated(e.tag) && a.body === e.body && titled(a, e)
    : (a, e) => a.tag === e.tag && a.body === e.body && titled(a, e);
  const named = (x) => (x.title === undefined ? '' : `"${x.title}": `);
  for (const e of expected) {
    const from = Math.max(e.due, t0);
    const until = Math.max(e.due + e.slack, from + step);
    const i = left.findIndex((a) => same(a, e) && a.real >= from && a.real < until);
    if (i < 0) {
      const near = left.filter((a) => same(a, e));
      problems.push(`missing ${named(e)}${e.body} [${e.tag}] due ${show(e.due, tz)}` +
                    (near.length ? `, got it at ${near.map((a) => show(a.real, tz)).join(', ')}` : ''));
    } else {
      left.splice(i, 1);
    }
  }
  left.forEach((a) => problems.push(`UNEXPECTED ${named(a)}${a.body} [${a.tag}] at ${show(a.real, tz)}`));
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

/* ─────────────────────────── Breaks scenarios ───────────────────────────
   Each carries `breaks`, the record as the column or BREAKS_KEY holds
   it, and `settings`. 28 September 2026 is a Monday. */

const extra = (start, minutes, name, headHome) =>
  ({ id: `b_sim_${start}_${name || ''}`, start: hm(start), minutes: minutes || null, name: name || '', headHome: !!headHome });
const breaksEvery = (lunchMinutes, extras) =>
  ({ v: 1, days: Object.fromEntries(DAYNAMES.map((d) => [d, { lunchMinutes, extras }])) });
const dayShift = shift('09:00', '12:30', '17:00');
const officeBreaks = breaksEvery(null, [extra('10:30', 15, 'Morning tea'), extra('15:00', null, '', true), extra('16:00', 20, 'Stretch')]);
const nightBreaks = breaksEvery(30, [extra('23:50', 20, 'Tea'), extra('04:00', 15)]);

const BREAK_SCENARIOS = [
  {
    name: 'breaks: extras with and without lengths, 12-hour clock',
    tz: 'Australia/Adelaide', schedule: dayShift, settings: { clock24: false }, breaks: officeBreaks,
    from: '2026-09-28 06:00', to: '2026-09-29 12:00',
  },
  {
    /* Alerts switched on, or the app first opened, at 3:01pm: the 3:00
       break, a minute old, is still news; the 10:30 one is not. */
    name: 'breaks: switched on mid-afternoon',
    tz: 'Australia/Adelaide', schedule: dayShift, settings: { clock24: false }, breaks: officeBreaks,
    from: '2026-09-28 15:01', to: '2026-09-28 23:00',
  },
  {
    name: 'breaks: lunch with a length and Head Home, 24-hour clock',
    tz: 'Australia/Adelaide',
    schedule: Object.fromEntries(DAYNAMES.map((d) =>
      [d, { working: true, start: hm('07:00'), lunch: hm('11:30'), end: hm('15:30'), lunchHeadHome: true }])),
    settings: { clock24: true, lunchLabel: 'Crib' },
    breaks: breaksEvery(30, [extra('09:15', 10, 'Smoko', true), extra('13:45', 90, 'Long break')]),
    from: '2026-09-28 05:00', to: '2026-09-29 12:00',
  },
  {
    // Tea finishes at 12:10 AM, after midnight, and is filed under Monday.
    name: 'breaks: night shift, breaks either side of midnight',
    tz: 'Australia/Adelaide', schedule: shift('22:00', '02:00', '06:00'), settings: { clock24: false },
    breaks: nightBreaks,
    from: '2026-09-28 12:00', to: '2026-09-29 12:00',
  },
  {
    // Opened at 12:11 AM: Tea's finish, a minute old, is news; its start is not.
    name: 'breaks: night shift, opened just after midnight',
    tz: 'Australia/Adelaide', schedule: shift('22:00', '02:00', '06:00'), settings: { clock24: false },
    breaks: nightBreaks,
    from: '2026-09-29 00:11', to: '2026-09-29 12:00',
  },
  {
    /* Monday: Wind down ends at End of Day and After hours after it, so
       neither says "Break over"; After hours still starts, since the spec
       skips only finishes. Early is before Start and runs past it: never
       counted to, so its 9:10 finish sends nothing either (decided
       27 Sep; the app, the server and the oracle above all skip it).
       Tuesday: lunch runs past End of Day, and Pack up's heads-up falls
       inside lunch. */
    name: 'breaks: finishing at or after End of Day, and one before Start',
    tz: 'Australia/Adelaide',
    schedule: { ...dayShift, Tuesday: { working: true, start: hm('09:00'), lunch: hm('16:40'), end: hm('17:00') } },
    settings: { clock24: false },
    breaks: { v: 1, days: {
      Monday: { lunchMinutes: null, extras: [extra('16:30', 30, 'Wind down'), extra('18:00', 15, 'After hours'), extra('08:50', 20, 'Early')] },
      Tuesday: { lunchMinutes: 45, extras: [extra('16:50', 10, 'Pack up')] },
    } },
    from: '2026-09-28 06:00', to: '2026-09-29 23:00',
  },
  {
    /* Monday: Walk's heads-up lands exactly on lunch's finish (skipped),
       Stretch's one minute after Tea's (sent), Water's inside Call, which
       has no length, so its finish is its start (skipped). Tuesday: A and
       B both start at 10:00; stored B first, but A's key sorts first, so
       B's heads-up is the one skipped. C's lands on a lunch with no
       length (skipped). */
    name: 'breaks: heads-up inside the break before, and two at once',
    tz: 'Australia/Adelaide', schedule: shift('09:00', '12:00', '17:00'), settings: { clock24: false },
    breaks: { v: 1, days: {
      Monday: { lunchMinutes: 30, extras: [extra('12:35', 10, 'Walk'), extra('14:00', 15, 'Tea'),
        extra('14:21', 10, 'Stretch'), extra('15:00', null, 'Call'), extra('15:03', 5, 'Water')] },
      Tuesday: { lunchMinutes: null, extras: [extra('10:00', 10, 'B'), extra('10:00', null, 'A'), extra('12:03', 15, 'C')] },
    } },
    from: '2026-09-28 06:00', to: '2026-09-29 18:00',
  },
  {
    /* Repaired, not dropped: lengths clamped (2 to 5, 500 to 180; 0 and
       -5 are no length), a long name cut to 30 and trimmed again when the
       cut leaves it ending in spaces, entries with no start dropped, and
       the day capped at six extras, keeping the first stored. Lunch does
       not count against the six: an older copy can set lunch on a day
       that already has six, and a break must not vanish for it (changed
       27 Sep; the day had been capped at six counting lunch). `expect` is
       that record written out by hand. */
    name: 'breaks: a mangled record is repaired, not dropped',
    tz: 'Australia/Adelaide', schedule: dayShift, settings: { clock24: false },
    breaks: { v: 1, days: { Monday: { lunchMinutes: 2, extras: [
      null, 'x', { start: 'nope', minutes: 15 },
      { id: 7, start: hm('10:00'), minutes: 500, name: 'A very long name that goes past thirty characters' },
      { start: hm('14:00'), minutes: 0, name: 'Zero' },
      { start: hm('14:30'), minutes: -5, headHome: true },
      { start: hm('15:00'), minutes: 15, name: '  Stretch' + ' '.repeat(23) + 'x' },
      { start: hm('15:30'), minutes: 15 }, { start: hm('16:00'), minutes: 15 }, { start: hm('16:30'), minutes: 15 },
    ] } } },
    expect: { v: 1, days: { Monday: { lunchMinutes: 5, extras: [
      { start: hm('10:00'), minutes: 180, name: 'A very long name that goes pas' },
      { start: hm('14:00'), minutes: null, name: 'Zero' },
      { start: hm('14:30'), minutes: null, headHome: true },
      { start: hm('15:00'), minutes: 15, name: 'Stretch' },
      { start: hm('15:30'), minutes: 15 }, { start: hm('16:00'), minutes: 15 },
    ] } } },
    from: '2026-09-28 06:00', to: '2026-09-29 06:00',
  },
  {
    /* Snack's finish, lunch, and all of Tea fall in the hour that does
       not exist: Tea's heads-up is lost with it, and the rest are
       announced at 3:00. */
    name: 'breaks: night shift as the clocks go forward',
    tz: 'Australia/Adelaide', dst: true, schedule: shift('22:00', '02:00', '06:00'), settings: { clock24: false },
    breaks: breaksEvery(null, [extra('01:50', 20, 'Snack'), extra('02:25', 15, 'Tea')]),
    from: '2026-10-03 12:00', to: '2026-10-05 12:00',
  },
  {
    // The hour from 2:00 comes twice. Each alert is due once, on the first pass.
    name: 'breaks: night shift as the clocks go back',
    tz: 'Australia/Adelaide', dst: true, schedule: shift('22:00', '02:00', '06:00'), settings: { clock24: true },
    breaks: breaksEvery(15, [extra('02:25', 30, 'Tea'), extra('01:00', 10, 'Snack')]),
    from: '2027-04-03 12:00', to: '2027-04-05 12:00',
  },
  {
    /* Start and End of Day both 7:00 is a 24-hour shift: End of Day comes
       at 7:00 AM Tuesday, so every finish before then says "Break over",
       Night's after midnight too. Last ends exactly at End of Day, so it
       does not. Read literally, rel(end) was 0 and both sides skipped
       every finish (found 27 Sep). */
    name: 'breaks: 24-hour shift, Start and End of Day both 07:00',
    tz: 'Australia/Adelaide',
    schedule: Object.fromEntries(DAYNAMES.map((d) =>
      [d, { working: d === 'Monday', start: hm('07:00'), lunch: hm('12:00'), end: hm('07:00') }])),
    settings: { clock24: false },
    breaks: { v: 1, days: { Monday: { lunchMinutes: 30, extras: [extra('10:00', 15, 'Morning'),
      extra('20:00', 30, 'Dinner'), extra('02:00', 20, 'Night'), extra('06:40', 20, 'Last')] } } },
    from: '2026-09-28 05:00', to: '2026-09-29 12:00',
  },
  {
    /* A break at exactly Start was never counted to, so it gets no
       alerts: no heads-up, no start, and no finish, as a break straddling
       Start gets none: "Break over" for a break nobody was told about
       reads as a mistake (decided 27 Sep). It is still the break before
       Inside, so Inside's 9:07 heads-up, which lands inside it, is
       skipped. Tea shows the day's other breaks are untouched. */
    name: 'breaks: a break at exactly Start',
    tz: 'Australia/Adelaide', schedule: dayShift, settings: { clock24: false },
    breaks: breaksEvery(null, [extra('09:00', 15, 'At start'), extra('09:12', 10, 'Inside'), extra('10:30', 15, 'Tea')]),
    from: '2026-09-28 06:00', to: '2026-09-29 12:00',
  },
  {
    /* A 24-hour shift is still on the pies a whole day after Start, and
       the day after is off, so the break at Start once had its heads-up
       at 6:55 AM Tuesday and "Break time" at 7:00 AM, on the day off,
       beside End of Day's "Time reached" (found 27 Sep). */
    name: 'breaks: a break at exactly Start on a 24-hour shift before a day off',
    tz: 'Australia/Adelaide',
    schedule: Object.fromEntries(DAYNAMES.map((d) =>
      [d, { working: d === 'Monday', start: hm('07:00'), lunch: hm('12:00'), end: hm('07:00') }])),
    settings: { clock24: false },
    breaks: { v: 1, days: { Monday: { lunchMinutes: null, extras: [extra('07:00', 15, 'Kickoff')] } } },
    from: '2026-09-28 05:00', to: '2026-09-29 12:00',
  },
  {
    /* The same shift every day: yesterday's shift is still on the pies at
       6:55 AM, so the break at Start once had an orphan "Starts in 5
       minutes" every morning, and no "Break time" after it, since today's
       shift takes the pies at 7:00 (found 27 Sep). End of Day's "Time
       reached" falls at that same minute and never comes: see onPies(). */
    name: 'breaks: a break at exactly Start on back-to-back 24-hour shifts',
    tz: 'Australia/Adelaide',
    schedule: Object.fromEntries(DAYNAMES.map((d) =>
      [d, { working: true, start: hm('07:00'), lunch: hm('12:00'), end: hm('07:00') }])),
    settings: { clock24: false },
    breaks: breaksEvery(null, [extra('07:00', 15, 'Kickoff'), extra('10:00', 10, 'Tea')]),
    from: '2026-09-28 05:00', to: '2026-09-30 05:00',
  },
];

/* A column that is null, missing or unreadable must push exactly what it
   did before breaks existed: the oracle reads each as no breaks at all. */
const readable = { Monday: { lunchMinutes: 30, extras: [extra('10:30', 15, 'Tea')] } };
for (const [what, breaks] of [
  ['null', null], ['a string', 'breaks'], ['an array', []], ['an empty object', {}],
  ['no version', { days: readable }], ['a newer version', { v: 2, days: readable }],
  ['days that are not an object', { v: 1, days: [] }],
  ['days of the wrong shape', { v: 1, days: { Monday: 'x', Tuesday: { lunchMinutes: '30', extras: 'x' } } }],
]) {
  BREAK_SCENARIOS.push({
    name: `breaks: a column of ${what} reads as none`,
    tz: 'Australia/Adelaide', schedule: dayShift, settings: { clock24: true },
    breaks, expect: null,
    from: '2026-09-28 06:00', to: '2026-09-29 18:00',
  });
}

BREAK_SCENARIOS.forEach((sc) => SCENARIOS.push({ ...sc, withBreaks: true }));

/* ─────────────────────────── Main ─────────────────────────── */

const APP_TICKS = [['1s', 1000, 0], ['60s@:30', 60000, 30000], ['60s@:59', 60000, 59000]];
const CRON = [['cron@:05', 5], ['cron@:55', 55]];

/* One version's app and server. Either failing to load is reported, and
   fails the run for the working tree, but never stops the other being
   tested: the server's checks must not wait on the app's, or the reverse. */
function load(ref) {
  const where = ref ? `baseline ${ref}` : 'working tree';
  const attempt = (file, loader) => {
    try {
      return loader(ref);
    } catch (e) {
      console.log(`\n${where}: ${file} NOT TESTED: ${e.message}`);
      if (!ref) process.exitCode = 1;
      return null;
    }
  };
  return [attempt(APP, loadApp), attempt(SERVER, loadServer)];
}

const threw = (e) => `threw ${e.name}: ${e.message}`;

function runAll(label, app, dueAlerts, strict) {
  let failed = 0;
  let checks = 0;
  let skipped = 0;
  const started = RealDate.now();
  console.log(`\n=== ${label}${strict ? '' : ' (timing only: tag dates not compared)'} ===`);
  const byZone = {};
  for (const sc of SCENARIOS) {
    if (ONLY.length && !ONLY.some((o) => (sc.name + ' ' + sc.tz).toLowerCase().includes(o.toLowerCase()))) continue;
    // A baseline from before breaks has nothing to test in these.
    if (sc.withBreaks && !strict && !(dueAlerts && dueAlerts.withBreaks)) { skipped++; continue; }
    process.env.TZ = sc.tz;
    const t0 = firstRealAt(parseWall(sc.from), sc.tz);
    const t1 = firstRealAt(parseWall(sc.to), sc.tz);
    const expected = expectedAlerts(sc.schedule, sc.tz, t0, t1, 'expect' in sc ? sc.expect : sc.breaks, sc.settings);
    const probes = (sc.probes || []).map(([at, lunch, end, key]) => ({ at, real: firstRealAt(parseWall(at), sc.tz), lunch, end, key }));
    const problems = [];

    if (sc.dst) {
      const tr = transitions(sc.tz, t0, t1);
      if (!tr.length) problems.push('no clock change inside the window: this scenario tests nothing');
      const zoneKey = sc.tz + ' ' + sc.from.slice(0, 10);
      if (!byZone[zoneKey]) { byZone[zoneKey] = true; console.log(`  -- ${sc.tz}: ${tr.join('; ') || 'NO TRANSITION'}`); }
    }

    const makeTab = app && (sc.withBreaks ? app.withBreaks : app);
    if (!app) problems.push('app: not tested, see above');
    else if (!makeTab) problems.push(`app: ${app.breakProblem}`);
    for (const [mode, step, phase] of makeTab ? APP_TICKS : []) {
      let run;
      try {
        run = runApp(makeTab, sc, t0, t1, step, phase, step === 1000 ? probes : []);
      } catch (e) {
        problems.push(`app ${mode}: ${threw(e)}`);
        continue;
      }
      const { log, seen } = run;
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
    if (!dueAlerts) problems.push('push: not tested, see above');
    for (const [mode, second] of dueAlerts ? CRON : []) {
      let log;
      try {
        log = runServer(dueAlerts, sc, sc.tz, t0, t1, second);
      } catch (e) {
        problems.push(`push ${mode}: ${threw(e)}`);
        continue;
      }
      compare(expected, log, t0, 60000, sc.tz, !strict).forEach((p) => problems.push(`push ${mode}: ${p}`));
      checks += expected.length;
      if (VERBOSE && sc.withBreaks && second === CRON[0][1]) {
        log.forEach((a) => console.log(`      ${show(a.real, sc.tz)}  ${a.title}: ${a.body}  [${a.tag}]`));
      }
    }

    const reached = expected.filter((e) => e.body === 'Time reached.').length;
    const name = `${sc.tz.split('/').pop()}: ${sc.name}`;
    if (problems.length) {
      failed++;
      console.log(`  FAIL  ${name}`);
      const shown = VERBOSE ? problems : problems.slice(0, 8);
      shown.forEach((p) => console.log('        ' + p));
      if (shown.length < problems.length) console.log(`        ... and ${problems.length - shown.length} more (--verbose)`);
    } else if (sc.withBreaks) {
      const breakAlerts = expected.filter((e) => e.title !== undefined).length;
      console.log(`  pass  ${name}  (${expected.length} alerts, ${breakAlerts} of them for breaks, 5 clocks)`);
    } else {
      console.log(`  pass  ${name}  (${reached} "Time reached", ${expected.length - reached} milestones, 5 clocks)`);
    }
  }
  const secs = ((RealDate.now() - started) / 1000).toFixed(0);
  const skip = skipped ? `, ${skipped} breaks scenario(s) skipped: this version predates breaks` : '';
  console.log(`  ${label}: ${failed ? failed + ' scenario(s) FAILED' : 'all passed'}, ${checks} checks${skip}, ${secs}s`);
  if (strict && failed) process.exitCode = 1;
  return failed;
}

runAll('working tree', ...load(null), true);
for (const ref of values('--baseline')) runAll(`baseline ${ref}`, ...load(ref), false);
