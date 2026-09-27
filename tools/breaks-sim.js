#!/usr/bin/env node
/* ============================================================
   Breaks simulation — the app side of multiple breaks.

   Written with the multiple-breaks release (CACHE v113). It runs the
   REAL app/app.js, never a copy of its logic, in two ways:

   1. Sliced, the way tools/shift-alerts-sim.js does it: the break
      functions are cut out of app.js and driven with a fake clock.
      - normaliseBreaks() on hostile input: it must never throw, never
        prune a break for where it falls, and give the same answer twice;
      - the break pie's phase at chosen instants: before, during, between
        and after breaks, no length, overlapping, and past midnight on a
        night shift;
      - every alert over whole days, at 1 s and 60 s ticks, against an
        oracle built from the spec's alert table alone (keys, words,
        titles, tags and timing), and nothing else;
      - one lunch with no length: the same alerts as the app before this
        release (the baseline, below), alert for alert.

   2. Whole, in a stubbed DOM: app.js as a page would run it, booted
      from localStorage, with sync.js and supabase.js against a fake
      PostgREST where sync is being tested.
      - BEFORE/AFTER: for people with one lunch and no extra breaks,
        every element the old app.js touches, the tab title, the focus
        view and every notification are compared, tick by tick, with
        the baseline's app.js. They must be identical.
      - the break card, day strip, week table, focus view and screen
        reader words for a day with several breaks;
      - storage and sync: breaks never in STORE_KEY, the breaks key
        written only on a break change and before STORE_KEY, nothing
        written or pushed at load, stray keys removed (and a key beside
        an unreadable STORE_KEY kept), the push payload with and without
        the column known, a column check that answers neither yes nor no,
        breaksMark and breaks an older copy may have left behind (never
        sent; the row's taken instead), a row in a newer format,
        replaceState with a breaks object, null and no key, a pull with
        nothing new rebuilding nothing, other tabs' saves and deletions,
        import, export, copy a day, restore defaults, seven breaks on a
        day, a time typed into the Breaks box, and account deletion; a
        held push whose pull took the row sending nothing more, and a
        newer-format row dropping breaksMark;
      - edits: no alert for a time or length nobody chose (another tab's
        typing, the arrow keys on a Length list, the table's Lunch cell,
        Add a break), other breaks' alerts left alone, no second heads-up
        or start after a new length; the Lunch cell's blur only after
        this focus emptied it, never on a glance at another tab, and with
        no rows rebuilt; focus kept in the box; Set breaks on a night
        shift; the notes as descriptions; the headings at midnight and
        "Last updated" after a pull.

   The baseline is 2ab9044, the last commit on main before breaks: the
   app as every existing user knows it. Not HEAD, because once breaks are
   committed HEAD is this app, and the before/after checks would compare
   it with itself and pass whatever changed.

   Run:  node tools/breaks-sim.js
         node tools/breaks-sim.js --verbose
         node tools/breaks-sim.js --baseline <git ref>   (default 2ab9044)
         node tools/breaks-sim.js --only alerts --only compare
   Sections: normalise, phases, alerts, box, compare, dashboard, storage, edits.
   Exit code 1 if anything fails. Takes a minute or two, mostly the
   whole-app before/after comparison.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

process.env.TZ = 'Australia/Adelaide';   // set at runtime: Windows can ignore it at startup

const ROOT = path.join(__dirname, '..');
const APP = 'app/app.js';
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : []));
// The last commit on main before breaks: see the header.
const PRE_BREAKS = '2ab9044';
const BASELINE = (() => { const i = args.indexOf('--baseline'); return i >= 0 ? args[i + 1] : PRE_BREAKS; })();

/* ─────────────────────────── Reporting ─────────────────────────── */

let passed = 0;
let failed = 0;
let section = '';
function heading(name) { section = name; console.log('\n=== ' + name + ' ==='); }
function check(name, ok, detail) {
  if (ok) {
    passed++;
    if (VERBOSE) console.log('  pass  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n        ' + String(detail).split('\n').join('\n        ') : ''));
  }
  return ok;
}
function same(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  return check(name, a === b, 'got  ' + a + '\nwant ' + b);
}
function note(text) { console.log('  ' + text); }

/* ─────────────────────────── Slicing the real code ─────────────────────────── */

function readVersion(ref, file) {
  const raw = ref
    ? execFileSync('git', ['show', ref + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    : fs.readFileSync(path.join(ROOT, file), 'utf8');
  return raw.split('\r\n').join('\n');
}

/* Index just past the bracket that closes the one at `open`, skipping
   strings and comments so a bracket inside either cannot end it early. */
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

function fn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  return src.slice(at, matchClose(src, src.indexOf('{', src.indexOf(')', at))));
}

function varDecl(src, name) {
  const m = new RegExp('var ' + name + ' = ').exec(src);
  if (!m) throw new Error('app.js has no var ' + name);
  const valueAt = m.index + m[0].length;
  const end = '{['.includes(src[valueAt]) ? matchClose(src, valueAt) : src.indexOf(';', valueAt);
  return src.slice(m.index, end) + ';';
}

function block(src, head) {
  const at = src.indexOf(head);
  if (at < 0) throw new Error('app.js has no block ' + head);
  return src.slice(at, matchClose(src, at + head.length - 1));
}

/* The fake clock. Date.now() and a bare new Date() read CLOCK.real; the
   wall clock is that instant in Adelaide. */
const RealDate = Date;
const CLOCK = { real: 0 };
/* toLocale*String() builds a fresh Intl formatter on every call, which
   was most of the cost of a render here. The same formatter, kept, gives
   the same text. */
const formatters = new Map();
function localeFormat(kind, date, locale, options) {
  const key = kind + '|' + locale + '|' + JSON.stringify(options || null);
  if (!formatters.has(key)) {
    const defaults = kind === 'date' ? { year: 'numeric', month: 'numeric', day: 'numeric' }
      : kind === 'time' ? { hour: 'numeric', minute: 'numeric', second: 'numeric' }
      : { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
    const own = options && Object.keys(options).some((k) => !['timeZone', 'hour12', 'hourCycle'].includes(k));
    formatters.set(key, new Intl.DateTimeFormat(locale, own ? options : Object.assign({}, defaults, options || {})));
  }
  return formatters.get(key).format(date);
}
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(CLOCK.real); else super(...a); }
  static now() { return CLOCK.real; }
  toLocaleDateString(locale, options) { return localeFormat('date', this, locale, options); }
  toLocaleTimeString(locale, options) { return localeFormat('time', this, locale, options); }
  toLocaleString(locale, options) { return localeFormat('both', this, locale, options); }
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const at = (text) => {   // '2026-09-28 10:30[:15]' on the Adelaide wall clock
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/.exec(text);
  return new RealDate(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
};
const hm = (text) => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
const show = (real) => {
  const d = new RealDate(real);
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[(d.getDay() + 6) % 7].slice(0, 3)} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function week(start, lunch, end, extra) {
  const out = {};
  DAYS.forEach((day) => {
    out[day] = Object.assign({ working: true, start: hm(start), lunch: lunch === null ? null : hm(lunch),
      end: end === null ? null : hm(end), lunchHeadHome: false, endHeadHome: false }, extra || {});
  });
  return out;
}

function breaksFor(days) {   // { Monday: { lunchMinutes, extras } } on every day not named -> empty
  const out = { v: 1, days: {} };
  DAYS.forEach((day) => { out.days[day] = days[day] || days['*'] || { lunchMinutes: null, extras: [] }; });
  return JSON.parse(JSON.stringify(out));
}
const extra = (id, start, minutes, name, headHome) =>
  ({ id: id, start: hm(start), minutes: minutes, name: name || '', headHome: !!headHome });

/* The breaks code and the alert half of render(), cut out of app.js.
   render()'s own lines are checked to still be there, so if render()
   changes shape this refuses to run rather than test something else. */
function loadSliced(ref) {
  const src = readVersion(ref, APP);
  const render = fn(src, 'render');
  const lines = [
    'var pies = workPies(now);', 'var shift = pies.shift;', 'var lunchTimer = pies.lunch;', 'var endTimer = pies.end;',
    'var shiftBreaks = pies.working ? dayBreaks(shift.cfg, shift.day) : [];',
    "checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);",
    "checkAlerts('end', endTimer, endLabel(shift.day), shift.key);",
    'checkBreakAlerts(shift, shiftBreaks);',
    'breakCard = paintBreakCard(pies, shiftBreaks);',
  ];
  lines.forEach((line) => {
    if (!render.includes(line)) {
      throw new Error('render() no longer contains\n    ' + line + '\n  Update loadSliced() in this harness to match render().');
    }
  });
  const reset = block(src, 'if (todayKey !== lastDayKey) {');
  const doneBody = block(src, 'shiftBreaks.forEach(function (brk) {') + ');';
  if (!render.includes(doneBody.slice(0, -2))) throw new Error('render(): the lunch doneBody block moved');

  const names = ['isRecord', 'isMinute', 'pad', 'hhmmToMinutes', 'minutesToHHMM', 'isoDate',
    'secondsSinceMidnight', 'dayNameOf', 'dayConfig', 'hasAgenda', 'computeTimer', 'currentShift', 'worksOn',
    'shiftLengthSec', 'workPies', 'checkAlerts', 'tagFor', 'lunchLabel', 'endLabel', 'formatClock',
    'emptyBreakDay', 'emptyBreaks', 'breakStart', 'breakLength', 'normaliseBreaks', 'breakKey', 'relMinute',
    'dayBreaks', 'breakReachable', 'breakPhase', 'breakFinish', 'breakTitle', 'checkBreakAlerts',
    'announceReached', 'suggestBreakStart', 'breakNotes'];
  const code = [
    ...['DAYS', 'MILESTONES', 'AGENDA', 'DONE_ALERT_WINDOW_SEC', 'NIGHT_SHIFT_HOLD_SEC', 'MAX_BREAKS',
        'BREAK_MIN_MINUTES', 'BREAK_MAX_MINUTES'].map((n) => varDecl(src, n)),
    ...names.map((n) => fn(src, n)),
    `var state = STATE;
     var breaks = BREAKS;
     var firedAlerts = {}, lastSeenRunning = {}, lastDayKey = null;
     function notify(title, body, tag) { LOG.push({ real: Date.now(), title: title, body: body, tag: tag }); }
     function applyLunchLabel() {}      // render()'s new-day block; there is no page here
     return {
       tick: function () {
         var now = new Date();
         var todayKey = now.toDateString();
         var pies = workPies(now);
         var shift = pies.shift;
         ${reset}
         var lunchTimer = pies.lunch;
         var endTimer = pies.end;
         var shiftBreaks = pies.working ? dayBreaks(shift.cfg, shift.day) : [];
         ${doneBody}
         checkAlerts('lunch', lunchTimer, lunchLabel(shift.day), shift.key);
         checkAlerts('end', endTimer, endLabel(shift.day), shift.key);
         checkBreakAlerts(shift, shiftBreaks);
         return { phase: breakPhase(pies, shiftBreaks), shift: shift };
       },
       normaliseBreaks: normaliseBreaks,
       dayBreaks: dayBreaks,
       suggestBreakStart: suggestBreakStart,
       breakNotes: breakNotes
     };`,
  ].join('\n');
  return (stateObj, breaksObj, log) => new Function('Date', 'STATE', 'BREAKS', 'LOG', code)(FakeDate, stateObj, breaksObj, log || []);
}

/* The same alert half of render(), from the app before breaks existed. */
function loadSlicedBaseline(ref) {
  const src = readVersion(ref, APP);
  const reset = block(src, 'if (todayKey !== lastDayKey) {');
  const code = [
    ...['DAYS', 'MILESTONES', 'AGENDA', 'DONE_ALERT_WINDOW_SEC', 'NIGHT_SHIFT_HOLD_SEC'].map((n) => varDecl(src, n)),
    ...['pad', 'isMinute', 'isoDate', 'secondsSinceMidnight', 'dayNameOf', 'dayConfig', 'hasAgenda', 'computeTimer',
        'checkAlerts', 'tagFor', 'lunchLabel', 'endLabel', 'currentShift', 'worksOn', 'shiftLengthSec', 'workPies']
      .map((n) => fn(src, n)),
    `var state = STATE; var firedAlerts = {}, lastSeenRunning = {}, lastDayKey = null;
     function notify(title, body, tag) { LOG.push({ real: Date.now(), title: title, body: body, tag: tag }); }
     function applyLunchLabel() {}      // render()'s new-day block; there is no page here
     return { tick: function () {
       var now = new Date(); var todayKey = now.toDateString();
       var pies = workPies(now); var shift = pies.shift;
       ${reset}
       checkAlerts('lunch', pies.lunch, lunchLabel(shift.day), shift.key);
       checkAlerts('end', pies.end, endLabel(shift.day), shift.key);
     } };`,
  ].join('\n');
  return (stateObj, log) => new Function('Date', 'STATE', 'LOG', code)(FakeDate, stateObj, log);
}

/* ─────────────────────────── 1a. normaliseBreaks ─────────────────────────── */

function checkNormalise(app) {
  heading('normaliseBreaks: hostile input, never throws, never prunes');
  const { normaliseBreaks } = app;

  const validShape = (r) => {
    if (!r || r.v !== 1 || !r.days) return 'no v/days';
    const keys = Object.keys(r.days);
    if (keys.join() !== DAYS.join()) return 'days ' + keys.join();
    const ids = new Set();
    for (const day of DAYS) {
      const d = r.days[day];
      if (Object.keys(d).join() !== 'lunchMinutes,extras') return day + ' keys ' + Object.keys(d).join();
      if (!(d.lunchMinutes === null || (Number.isInteger(d.lunchMinutes) && d.lunchMinutes >= 5 && d.lunchMinutes <= 180))) return day + ' lunchMinutes ' + d.lunchMinutes;
      if (!Array.isArray(d.extras) || d.extras.length > 6) return day + ' extras';
      for (const e of d.extras) {
        if (Object.keys(e).join() !== 'id,start,minutes,name,headHome') return day + ' extra keys ' + Object.keys(e).join();
        if (typeof e.id !== 'string' || !e.id || ids.has(e.id)) return day + ' id ' + e.id;
        ids.add(e.id);
        if (!Number.isInteger(e.start) || e.start < 0 || e.start > 1439) return day + ' start ' + e.start;
        if (!(e.minutes === null || (Number.isInteger(e.minutes) && e.minutes >= 5 && e.minutes <= 180))) return day + ' minutes ' + e.minutes;
        if (typeof e.name !== 'string' || e.name.length > 30) return day + ' name';
        if (typeof e.headHome !== 'boolean') return day + ' headHome';
      }
    }
    return '';
  };
  const empty = (r) => DAYS.every((d) => r.days[d].lunchMinutes === null && r.days[d].extras.length === 0);

  const throwing = new Proxy({}, { get() { throw new Error('hostile getter'); }, has() { throw new Error('hostile has'); }, ownKeys() { throw new Error('hostile keys'); } });
  const getterDays = {};
  Object.defineProperty(getterDays, 'Monday', { get() { throw new Error('getter'); }, enumerable: true });
  const cyclic = { v: 1, days: { Monday: { extras: [] } } };
  cyclic.days.Monday.self = cyclic;
  cyclic.days.Monday.extras.push({ start: 600, minutes: 15, loop: cyclic });

  const hostile = [
    ['null', null], ['undefined', undefined], ['[]', []], ['{}', {}], ['string', 'breaks'], ['number', 42],
    ['true', true], ['function', () => 1], ['v:2', { v: 2, days: {} }], ['missing v', { days: { Monday: { extras: [{ start: 600 }] } } }],
    ['v as string', { v: '1', days: {} }], ['days null', { v: 1, days: null }], ['days array', { v: 1, days: [1, 2] }],
    ['day null', { v: 1, days: { Monday: null } }], ['extras string', { v: 1, days: { Monday: { extras: 'x' } } }],
    ['extras of junk', { v: 1, days: { Monday: { extras: [null, 1, 'a', [], true, {}, { start: 'x' }, { start: NaN }, { start: Infinity }, { start: -5 }, { start: 1440 }, { start: 1e12 }, { start: '25:99' }] } } }],
    ['Proxy that throws', throwing], ['days Proxy', { v: 1, days: throwing }], ['getter that throws', { v: 1, days: getterDays }],
    ['cyclic', cyclic], ['__proto__ from JSON', JSON.parse('{"v":1,"days":{"__proto__":{"extras":[{"start":1}]},"Monday":{"extras":[{"id":"__proto__","start":600}]}}}')],
    ['huge', { v: 1, days: { Monday: { lunchMinutes: 1e308, extras: Array.from({ length: 5000 }, (_, i) => ({ start: i % 1440, minutes: i, name: 'x'.repeat(i % 100), id: 'dup' })) } } }],
  ];
  for (const [name, input] of hostile) {
    let out;
    let threw = null;
    try { out = normaliseBreaks(input); } catch (e) { threw = e; }
    check(`never throws: ${name}`, !threw, threw && threw.message);
    if (!threw) check(`valid shape: ${name}`, validShape(out) === '', validShape(out));
  }
  const junk = normaliseBreaks(hostile.find((h) => h[0] === 'extras of junk')[1]);
  same('junk extras: only the readable start survives, repaired',
    junk.days.Monday.extras.map((e) => e.start), []);
  check('missing v is empty', empty(normaliseBreaks({ days: { Monday: { extras: [{ start: 600 }] } } })));
  check('v:2 is empty (not a record this app can read)', empty(normaliseBreaks({ v: 2, days: { Monday: { extras: [{ start: 600 }] } } })));

  // Repair, not drop.
  const repaired = normaliseBreaks({ v: 1, days: { Monday: { lunchMinutes: 999, extras: [
    { start: '10:30', minutes: 3, name: '  Coffee with a name far longer than thirty characters  ', headHome: 'yes' },
    { start: 900.7, minutes: 200, id: 7 },
    { start: 60, minutes: 0 },
    { start: 120, minutes: -4, id: '' },
    { start: 180, minutes: '15', id: 'x'.repeat(65) },
  ] } } });
  const mon = repaired.days.Monday;
  same('lunchMinutes clamped to 180', mon.lunchMinutes, 180);
  same('starts repaired', mon.extras.map((e) => e.start), [630, 900, 60, 120, 180]);
  same('minutes clamped or null', mon.extras.map((e) => e.minutes), [5, 180, null, null, null]);
  same('name trimmed to 30', mon.extras[0].name, 'Coffee with a name far longer '.trim());
  same('headHome strictly true', mon.extras[0].headHome, false);
  same('deterministic ids for unusable ones', mon.extras.map((e) => e.id),
    ['b_Monday6300', 'b_Monday9001', 'b_Monday602', 'b_Monday1203', 'b_Monday1804']);
  same('the same ids on a second load', normaliseBreaks(repaired).days.Monday.extras.map((e) => e.id), mon.extras.map((e) => e.id));

  // Duplicate ids: the first keeps it, the rest are made.
  const dup = normaliseBreaks({ v: 1, days: { Monday: { extras: [{ id: 'a', start: 600 }, { id: 'a', start: 610 }] }, Tuesday: { extras: [{ id: 'a', start: 620 }] } } });
  same('duplicate ids repaired', [dup.days.Monday.extras.map((e) => e.id), dup.days.Tuesday.extras.map((e) => e.id)],
    [['a', 'b_Monday6101'], ['b_Tuesday6200']]);

  // Never prunes for where a break falls (R4).
  const kept = normaliseBreaks({ v: 1, days: { Monday: { extras: [{ id: 'early', start: 300 }, { id: 'late', start: 1400 }, { id: 'atLunch', start: 750 }] } } });
  same('before Start, after End, at lunch: all kept', kept.days.Monday.extras.map((e) => e.id), ['early', 'late', 'atLunch']);

  /* The cap: six extras a day, dropping only the excess, in stored order.
     Lunch never counts against it here. An older copy can set lunch on a
     day that already has six others, and that must not cost a break; the
     Breaks box holds lunch + extras to six by turning Add a break off. */
  const seven = { v: 1, days: { Monday: { extras: Array.from({ length: 7 }, (_, i) => ({ id: 'e' + i, start: 600 + i })) } } };
  const sixIds = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
  same('seven extras: the first six kept', normaliseBreaks(seven).days.Monday.extras.map((e) => e.id), sixIds);
  const six = { v: 1, days: { Monday: { extras: seven.days.Monday.extras.slice(0, 6) } } };
  // Handed a week with lunch, as the app before this fix took one.
  same('six extras on a day with lunch: all six kept (lunch never costs a break)',
    normaliseBreaks(six, week('09:00', '12:30', '17:00')).days.Monday.extras.map((e) => e.id), sixIds);
  check('normaliseBreaks takes no schedule: nothing it does depends on lunch', normaliseBreaks.length === 1, normaliseBreaks.length);

  // Idempotent, and a fuzz run over random structures.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const junkValue = (depth) => {
    const kinds = ['num', 'str', 'null', 'bool', 'arr', 'obj', 'time', 'undef', 'nan', 'big'];
    const k = depth > 3 ? pick(['num', 'str', 'null']) : pick(kinds);
    if (k === 'num') return Math.floor(rand() * 3000) - 500;
    if (k === 'str') return pick(['', 'Lunch', '10:30', '99:99', 'x'.repeat(40), '__proto__']);
    if (k === 'null') return null;
    if (k === 'bool') return rand() < 0.5;
    if (k === 'arr') return Array.from({ length: Math.floor(rand() * 9) }, () => junkValue(depth + 1));
    if (k === 'time') return pick(['08:15', '23:59', '0:05']);
    if (k === 'undef') return undefined;
    if (k === 'nan') return NaN;
    if (k === 'big') return 1e300;
    const o = {};
    for (const key of ['v', 'days', 'lunchMinutes', 'extras', 'start', 'minutes', 'name', 'id', 'headHome', ...DAYS]) {
      if (rand() < 0.4) o[key] = key === 'v' && rand() < 0.7 ? 1 : junkValue(depth + 1);
    }
    return o;
  };
  let fuzzFail = '';
  for (let i = 0; i < 3000 && !fuzzFail; i++) {
    const input = rand() < 0.5 ? { v: 1, days: Object.fromEntries(DAYS.map((d) => [d, junkValue(1)])) } : junkValue(0);
    try {
      const once = normaliseBreaks(input);
      const shape = validShape(once);
      if (shape) fuzzFail = 'shape ' + shape + ' for ' + JSON.stringify(input);
      else if (JSON.stringify(normaliseBreaks(once)) !== JSON.stringify(once)) fuzzFail = 'not idempotent for ' + JSON.stringify(input);
    } catch (e) {
      fuzzFail = 'threw ' + e.message + ' for ' + JSON.stringify(input);
    }
  }
  check('3000 random structures: never throws, always valid, idempotent', !fuzzFail, fuzzFail);
}

/* ─────────────────────────── 1b. The break pie's phases ─────────────────────────── */

function makeState(schedule, settings) {
  return {
    schedule: schedule,
    settings: Object.assign({ alerts: true, lunchLabel: 'Lunch', clock24: false, showSeconds: true }, settings || {}),
    appointments: [],
  };
}

function checkPhases(load) {
  heading('Break pie phases (sliced breakPhase, driven through a day)');

  const probe = (name, schedule, brks, points, settings) => {
    const app = load(makeState(schedule, settings), brks);
    for (const [when, want] of points) {
      CLOCK.real = at(when);
      const { phase, shift } = app.tick();
      const got = { mode: phase.mode };
      if (phase.brk) got.brk = phase.brk.name;
      if (phase.timer) {
        got.left = phase.timer.done ? 'done' : phase.timer.notStarted ? 'not started' : Math.round(phase.timer.remainingSec / 60) + 'm';
        got.of = Math.round(phase.timer.totalSec / 60) + 'm';
      }
      if (want.day) got.day = shift.day;
      const w = Object.assign({}, want);
      same(`${name} @ ${when}`, got, w);
    }
  };

  const day = week('09:00', '12:30', '17:00');
  const three = breaksFor({ '*': { lunchMinutes: 30, extras: [extra('c', '10:30', 15, 'Coffee'), extra('b', '15:00', 10, '', true)] } });
  probe('three breaks', day, three, [
    ['2026-09-28 08:00', { mode: 'before', brk: 'Coffee', left: 'not started', of: '90m' }],
    ['2026-09-28 10:00', { mode: 'before', brk: 'Coffee', left: '30m', of: '90m' }],
    ['2026-09-28 10:30', { mode: 'during', brk: 'Coffee', left: '15m', of: '15m' }],
    ['2026-09-28 10:35', { mode: 'during', brk: 'Coffee', left: '10m', of: '15m' }],
    ['2026-09-28 10:45', { mode: 'before', brk: 'Lunch', left: '105m', of: '105m' }],
    ['2026-09-28 11:00', { mode: 'before', brk: 'Lunch', left: '90m', of: '105m' }],
    ['2026-09-28 12:40', { mode: 'during', brk: 'Lunch', left: '20m', of: '30m' }],
    ['2026-09-28 13:30', { mode: 'before', brk: 'Break', left: '90m', of: '120m' }],
    ['2026-09-28 15:05', { mode: 'during', brk: 'Break', left: '5m', of: '10m' }],
    ['2026-09-28 15:10', { mode: 'done', brk: 'Break' }],
    ['2026-09-28 23:59', { mode: 'done', brk: 'Break' }],
  ]);

  probe('no length: an extra, then lunch', day, breaksFor({ '*': { lunchMinutes: null, extras: [extra('s', '10:00', null, 'Stretch')] } }), [
    ['2026-09-28 09:30', { mode: 'before', brk: 'Stretch', left: '30m', of: '60m' }],
    ['2026-09-28 10:00', { mode: 'before', brk: 'Lunch', left: '150m', of: '150m' }],
    ['2026-09-28 11:00', { mode: 'before', brk: 'Lunch', left: '90m', of: '150m' }],
    ['2026-09-28 13:00', { mode: 'reached', brk: 'Lunch', left: 'done', of: '150m' }],
  ]);

  probe('overlapping: cut short at the next start, last has no length', week('09:00', null, '17:00'),
    breaksFor({ '*': { lunchMinutes: null, extras: [extra('d', '14:00', 60, 'D'), extra('e', '14:30', null, 'E')] } }), [
      ['2026-09-28 13:00', { mode: 'before', brk: 'D', left: '60m', of: '300m' }],
      ['2026-09-28 14:10', { mode: 'during', brk: 'D', left: '50m', of: '60m' }],
      ['2026-09-28 14:29', { mode: 'during', brk: 'D', left: '31m', of: '60m' }],
      ['2026-09-28 14:30', { mode: 'reached', brk: 'E', left: 'done', of: '330m' }],
      ['2026-09-28 16:00', { mode: 'reached', brk: 'E', left: 'done', of: '330m' }],
    ]);

  const night = week('22:00', '02:00', '06:00');
  probe('night shift, breaks either side of midnight', night,
    breaksFor({ '*': { lunchMinutes: 30, extras: [extra('t', '00:00', 15, 'Tea'), extra('f', '04:00', 10, 'Four')] } }), [
      ['2026-09-28 21:00', { mode: 'before', brk: 'Tea', left: 'not started', of: '120m', day: 'Monday' }],
      ['2026-09-28 23:00', { mode: 'before', brk: 'Tea', left: '60m', of: '120m', day: 'Monday' }],
      ['2026-09-29 00:05', { mode: 'during', brk: 'Tea', left: '10m', of: '15m', day: 'Monday' }],
      ['2026-09-29 01:00', { mode: 'before', brk: 'Lunch', left: '60m', of: '105m', day: 'Monday' }],
      ['2026-09-29 02:10', { mode: 'during', brk: 'Lunch', left: '20m', of: '30m', day: 'Monday' }],
      ['2026-09-29 03:00', { mode: 'before', brk: 'Four', left: '60m', of: '90m', day: 'Monday' }],
      ['2026-09-29 04:05', { mode: 'during', brk: 'Four', left: '5m', of: '10m', day: 'Monday' }],
      ['2026-09-29 05:00', { mode: 'done', brk: 'Four', day: 'Monday' }],
      ['2026-09-29 09:59', { mode: 'done', brk: 'Four', day: 'Monday' }],
      ['2026-09-29 10:00', { mode: 'before', brk: 'Tea', left: 'not started', of: '120m', day: 'Tuesday' }],
    ]);

  probe('one lunch, no length', day, breaksFor({}), [
    ['2026-09-28 08:00', { mode: 'classic' }], ['2026-09-28 12:00', { mode: 'classic' }], ['2026-09-28 18:00', { mode: 'classic' }],
  ]);
  probe('one lunch with a length', day, breaksFor({ '*': { lunchMinutes: 45, extras: [] } }), [
    ['2026-09-28 12:00', { mode: 'before', brk: 'Lunch', left: '30m', of: '210m' }],
    ['2026-09-28 13:00', { mode: 'during', brk: 'Lunch', left: '15m', of: '45m' }],
    ['2026-09-28 13:15', { mode: 'done', brk: 'Lunch' }],
  ]);
  probe('an extra the shift never reaches (before Start) leaves plain lunch', day,
    breaksFor({ '*': { lunchMinutes: null, extras: [extra('early', '08:00', 15, 'Early')] } }), [
      ['2026-09-28 10:00', { mode: 'classic' }], ['2026-09-28 18:00', { mode: 'classic' }],
    ]);
  // One at exactly Start has nothing to count from, so it is left out the same way.
  probe('an extra at exactly Start leaves plain lunch too', day,
    breaksFor({ '*': { lunchMinutes: null, extras: [extra('k', '09:00', 15, 'Kickoff')] } }), [
      ['2026-09-28 09:05', { mode: 'classic' }], ['2026-09-28 10:00', { mode: 'classic' }],
    ]);
  const allDay = week('07:00', '12:00', '07:00');
  DAYS.slice(1).forEach((d) => { allDay[d].working = false; });
  probe('24-hour shift, an extra at Start: never shown running, then or a day later', allDay,
    breaksFor({ Monday: { lunchMinutes: null, extras: [extra('k', '07:00', 15, 'Kickoff')] } }), [
      ['2026-09-28 07:05', { mode: 'classic' }], ['2026-09-29 07:00', { mode: 'classic' }], ['2026-09-29 07:05', { mode: 'classic' }],
    ]);
  probe('...and with a second extra, the pie counts to that one', allDay,
    breaksFor({ Monday: { lunchMinutes: null, extras: [extra('k', '07:00', 15, 'Kickoff'), extra('t', '10:00', 15, 'Tea')] } }), [
      ['2026-09-28 07:05', { mode: 'before', brk: 'Tea', left: '175m', of: '180m' }],
    ]);
  // A lone lunch at Start keeps the timer it has always had.
  probe('one lunch, no length, at exactly Start', week('09:00', '09:00', '17:00'), breaksFor({}), [
    ['2026-09-28 09:05', { mode: 'classic' }],
  ]);
  probe('working day, no breaks', week('09:00', null, '17:00'), breaksFor({}), [['2026-09-28 10:00', { mode: 'none' }]]);
  const off = week('09:00', '12:30', '17:00');
  off.Monday.working = false;
  probe('day off', off, three, [['2026-09-28 10:00', { mode: 'off' }]]);
}

/* ─────────────────────────── 1c. Alerts against the spec's table ─────────────────────────── */

/* Every alert the spec's table says is due in [t0, t1), from the
   schedule and breaks alone: none of the app's code is called. */
function expectedAlerts(schedule, brks, settings, t0, t1) {
  const out = [];
  const fmt = (min) => {
    const h = Math.floor(min / 60) % 24;
    const m = String(min % 60).padStart(2, '0');
    return settings.clock24 ? String(h).padStart(2, '0') + ':' + m : (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  };
  const first = new RealDate(t0);
  for (let offset = -1; offset < 40; offset++) {
    const dayStart = new RealDate(first.getFullYear(), first.getMonth(), first.getDate() + offset).getTime();
    if (dayStart >= t1) break;
    const date = new RealDate(dayStart);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dayName = DAYS[(date.getDay() + 6) % 7];
    const cfg = schedule[dayName];
    if (!cfg || !cfg.working) continue;
    const entry = brks.days[dayName];
    const rel = (t) => (t - cfg.start + 1440) % 1440;
    const relW = (t) => rel(t) || 1440;                              // a timer to its own start is a whole day
    const lengths = [cfg.lunch, cfg.end].filter((t) => typeof t === 'number').map(relW);
    const length = lengths.length ? Math.max(...lengths) : 0;
    const limit = cfg.start + length >= 1440 ? length + 240 : 1440 - cfg.start;  // while the shift is on the pies
    const due = (relMin, key, milestone, title, body, slack) => {
      if (relMin >= limit) return;
      const real = dayStart + (cfg.start + relMin) * 60000;
      if (real < t0 || real >= t1) return;
      out.push({ due: real, slack, tag: `${iso}|${key}|${milestone}`, title, body });
    };
    const ladder = (target, key, title, doneBody) => {
      const total = relW(target);
      for (const mark of [30, 15, 10, 5]) if (total >= mark) due(total - mark, key, String(mark), title, mark + ' minutes remaining.', 60000);
      due(total, key, 'done', title, doneBody, 0);
    };
    // End of Day at Start is a 24-hour day, ending at the next Start.
    const endAt = typeof cfg.end === 'number' ? relW(cfg.end) : null;

    const list = [];
    if (typeof cfg.lunch === 'number') {
      list.push({ key: 'lunch', start: cfg.lunch, minutes: entry.lunchMinutes, name: settings.lunchLabel, headHome: cfg.lunchHeadHome, lunch: true });
    }
    for (const e of entry.extras) {
      list.push({ key: 'brk' + e.start + (e.minutes ? '-' + (e.start + e.minutes) % 1440 : ''), start: e.start,
        minutes: e.minutes, name: e.name || 'Break', headHome: e.headHome });
    }
    list.sort((a, b) => rel(a.start) - rel(b.start) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    list.forEach((b, i) => {
      const title = b.name + (b.headHome ? ' | Head Home' : '');
      const finish = b.minutes ? (b.start + b.minutes) % 1440 : null;
      const startBody = b.minutes ? `Break time. Back at ${fmt(finish)}.` : (b.lunch ? 'Time reached.' : 'Break time.');
      if (b.lunch) {
        ladder(b.start, 'lunch', title, startBody);
      } else if (rel(b.start) > 0) {
        // One at exactly Start is never counted to: nothing, not even a day later.
        const prev = list[i - 1];
        const prevFinish = prev ? rel((prev.start + (prev.minutes || 0)) % 1440) : null;
        if (relW(b.start) >= 5 && (prevFinish === null || rel(b.start) - 5 > prevFinish)) {
          due(relW(b.start) - 5, b.key, '5', title, 'Starts in 5 minutes.', 60000);
        }
        due(relW(b.start), b.key, 'start', title, startBody, 0);
      }
      /* No "Break over" for a break the day never counted to: one at
         Start itself, or one before Start that runs past it. */
      const neverCounted = rel(b.start) === 0 || rel(b.start) + (b.minutes || 0) >= 1440;
      if (b.minutes && !neverCounted && !(endAt !== null && rel(finish) >= endAt)) {
        due(relW(finish), b.key, 'finish', b.name, 'Break over. Ease back in.', 0);
      }
    });
    if (typeof cfg.end === 'number') ladder(cfg.end, 'end', 'End of Day' + (cfg.endHeadHome ? ' | Head Home' : ''), 'Time reached.');
  }
  return out;
}

function compareAlerts(expected, actual, step) {
  const problems = [];
  const left = actual.slice();
  for (const e of expected) {
    const until = e.due + Math.max(e.slack, step);
    const i = left.findIndex((a) => a.tag === e.tag && a.title === e.title && a.body === e.body && a.real >= e.due && a.real < until);
    if (i < 0) {
      const near = left.filter((a) => a.tag === e.tag);
      problems.push(`missing [${e.tag}] "${e.title}" "${e.body}" due ${show(e.due)}` +
        (near.length ? `; got ${near.map((a) => `"${a.title}" "${a.body}" at ${show(a.real)}`).join(', ')}` : ''));
    } else {
      left.splice(i, 1);
    }
  }
  left.forEach((a) => problems.push(`UNEXPECTED [${a.tag}] "${a.title}" "${a.body}" at ${show(a.real)}`));
  return problems;
}

function checkAlertTable(load, loadBaseline) {
  heading('Alerts per break: keys, words, titles, tags, timing (sliced, vs the spec table)');

  const scenarios = [
    {
      name: 'three breaks, lengths, Head Home on one',
      schedule: week('09:00', '12:30', '17:00'),
      breaks: breaksFor({ '*': { lunchMinutes: 30, extras: [extra('c', '10:30', 15, 'Coffee'), extra('b', '15:00', 10, '', true)] } }),
      from: '2026-09-28 06:00', to: '2026-09-29 06:00',
      spot: ['2026-09-28|brk630-645|5', '2026-09-28|brk630-645|start', '2026-09-28|brk630-645|finish', '2026-09-28|lunch|done',
        '2026-09-28|lunch|finish', '2026-09-28|brk900-910|5', '2026-09-28|brk900-910|start', '2026-09-28|brk900-910|finish'],
    },
    {
      name: 'heads-up skipped at or before the previous finish',
      schedule: week('09:00', '12:30', '17:00'),
      breaks: breaksFor({ '*': { lunchMinutes: null, extras: [extra('a', '10:30', 15, 'A'), extra('b', '10:50', null, 'B'), extra('c', '11:00', null, 'C')] } }),
      from: '2026-09-28 06:00', to: '2026-09-28 20:00',
      absent: ['2026-09-28|brk650|5'], present: ['2026-09-28|brk660|5'],
    },
    {
      name: 'overlap, and finishes at or after End of Day skipped',
      schedule: week('09:00', null, '17:00'),
      breaks: breaksFor({ '*': { lunchMinutes: null, extras: [extra('d', '14:00', 60, 'D'), extra('e', '14:30', null, 'E'),
        extra('g', '16:40', 20, 'G'), extra('f', '16:50', 15, 'F')] } }),
      from: '2026-09-28 06:00', to: '2026-09-28 20:00',
      absent: ['2026-09-28|brk870|5', '2026-09-28|brk1000-1020|finish', '2026-09-28|brk1010-1025|finish'],
      present: ['2026-09-28|brk840-900|finish', '2026-09-28|brk870|start'],
    },
    {
      name: 'night shift: breaks after midnight tagged with the day it started',
      schedule: week('22:00', '02:00', '06:00'),
      breaks: breaksFor({ '*': { lunchMinutes: 30, extras: [extra('t', '00:00', 15, 'Tea'), extra('f', '04:00', 10, 'Four')] } }),
      from: '2026-09-28 12:00', to: '2026-09-30 12:00',
      present: ['2026-09-28|brk0-15|start', '2026-09-28|lunch|finish', '2026-09-28|brk240-250|finish', '2026-09-29|brk0-15|5'],
    },
    {
      name: '24-hour clock in "Back at", custom lunch name, Head Home lunch',
      schedule: week('07:30', '11:45', '15:15', { lunchHeadHome: true }),
      breaks: breaksFor({ '*': { lunchMinutes: 20, extras: [extra('x', '13:00', 45, 'Walk', true)] } }),
      settings: { clock24: true, lunchLabel: 'Crib' },
      from: '2026-09-28 05:00', to: '2026-09-28 20:00',
    },
    {
      name: 'before Start: never reached; after End of Day: starts, no finish',
      schedule: week('09:00', '12:30', '17:00'),
      breaks: breaksFor({ '*': { lunchMinutes: null, extras: [extra('e', '08:00', 15, 'Early'), extra('l', '23:30', 15, 'Late')] } }),
      from: '2026-09-28 06:00', to: '2026-09-29 12:00',
      absent: ['2026-09-28|brk480-495|start', '2026-09-29|brk480-495|start', '2026-09-28|brk1410-1425|finish'],
      present: ['2026-09-28|brk1410-1425|start'],
    },
    {
      name: '24-hour shift (Start == End of Day): every "Break over" still comes',
      schedule: (() => { const s = week('07:00', '12:00', '07:00'); DAYS.slice(1).forEach((d) => { s[d].working = false; }); return s; })(),
      breaks: breaksFor({ Monday: { lunchMinutes: 30, extras: [extra('t', '10:00', 15, 'Tea'), extra('d', '20:00', 30, 'Dinner'),
        extra('n', '02:00', 20, 'Night tea')] } }),
      from: '2026-09-28 05:00', to: '2026-09-29 09:00',
      present: ['2026-09-28|brk600-615|finish', '2026-09-28|lunch|finish', '2026-09-28|brk1200-1230|finish', '2026-09-28|brk120-140|finish'],
    },
    {
      name: 'a break at exactly Start, and one straddling it: never counted to, so no "Break over"',
      schedule: week('09:00', '12:30', '17:00'),
      breaks: breaksFor({ '*': { lunchMinutes: null, extras: [extra('s', '09:00', 15, 'At start'), extra('e', '08:50', 20, 'Early')] } }),
      from: '2026-09-28 06:00', to: '2026-09-28 20:00',
      absent: ['2026-09-28|brk540-555|finish', '2026-09-28|brk540-555|start', '2026-09-28|brk530-550|finish'],
    },
    {
      name: '24-hour shift, a break at exactly Start: no heads-up, start or finish, not even a day later',
      schedule: (() => { const s = week('07:00', '12:00', '07:00'); DAYS.slice(1).forEach((d) => { s[d].working = false; }); return s; })(),
      breaks: breaksFor({ Monday: { lunchMinutes: null, extras: [extra('k', '07:00', 15, 'Kickoff')] } }),
      from: '2026-09-28 05:00', to: '2026-09-29 14:00',
      absent: ['2026-09-28|brk420-435|5', '2026-09-28|brk420-435|start', '2026-09-28|brk420-435|finish'],
    },
    {
      name: 'one lunch, no length (today\'s app)',
      schedule: week('09:00', '12:30', '17:00'),
      breaks: breaksFor({}),
      from: '2026-09-28 06:00', to: '2026-09-30 06:00',
      baseline: true,
    },
  ];

  for (const sc of scenarios) {
    const settings = Object.assign({ alerts: true, lunchLabel: 'Lunch', clock24: false }, sc.settings || {});
    const t0 = at(sc.from);
    const t1 = at(sc.to);
    const expected = expectedAlerts(sc.schedule, sc.breaks, settings, t0, t1);
    let problems = [];
    let oneSecond = [];
    for (const [label, step, phase] of [['1s', 1000, 0], ['60s@:30', 60000, 30000], ['60s@:59', 60000, 59000]]) {
      const log = [];
      const app = load(makeState(sc.schedule, sc.settings), sc.breaks, log);
      for (let t = t0 + phase; t < t1; t += step) { CLOCK.real = t; app.tick(); }
      compareAlerts(expected, log, step).forEach((p) => problems.push(label + ': ' + p));
      if (step === 1000) oneSecond = log;
    }
    const tags = new Set(oneSecond.map((a) => a.tag));
    (sc.spot || []).concat(sc.present || []).forEach((tag) => { if (!tags.has(tag)) problems.push('missing tag ' + tag); });
    (sc.absent || []).forEach((tag) => { if (tags.has(tag)) problems.push('should not fire ' + tag); });
    if (sc.baseline) {
      const base = [];
      const old = loadBaseline(makeState(sc.schedule, sc.settings), base);
      for (let t = t0; t < t1; t += 1000) { CLOCK.real = t; old.tick(); }
      const a = JSON.stringify(oneSecond);
      const b = JSON.stringify(base);
      if (a !== b) problems.push(`differs from ${BASELINE}:\n  now  ${a.slice(0, 400)}\n  then ${b.slice(0, 400)}`);
      else note(`  (${oneSecond.length} alerts, identical to ${BASELINE}'s app.js, alert for alert)`);
    }
    check(`${sc.name}: ${expected.length} alerts, each once, on time, nothing else`, !problems.length,
      problems.slice(0, VERBOSE ? 99 : 8).join('\n') + (problems.length > 8 && !VERBOSE ? `\n... and ${problems.length - 8} more` : ''));
    if (VERBOSE) oneSecond.forEach((a) => console.log(`        ${show(a.real)}  [${a.tag}]  ${a.title} — ${a.body}`));
  }

  /* Lunch moved later after its finish has passed: the second "Break
     over" gets a tag of its own, as checkAlerts() gives a second "Time
     reached". Under the first one's tag the phone swaps it in silently. */
  const movedState = makeState(week('09:00', '12:00', '17:00'));
  const movedLog = [];
  const moved = load(movedState, breaksFor({ '*': { lunchMinutes: 30, extras: [] } }), movedLog);
  for (let t = at('2026-09-28 11:00'); t < at('2026-09-28 14:00'); t += 1000) {
    if (t === at('2026-09-28 12:40')) movedState.schedule.Monday.lunch = hm('13:00');
    CLOCK.real = t;
    moved.tick();
  }
  same('lunch moved after its finish: the second "Break over" has a tag of its own',
    movedLog.filter((a) => a.tag.indexOf('|lunch|finish') > 0).map((a) => [show(a.real).slice(15, 20), a.tag]),
    [['12:30', '2026-09-28|lunch|finish'], ['13:30', '2026-09-28|lunch|finish|810']]);
}

/* ─────────────────────────── 1d. Schedule tab helpers ─────────────────────────── */

function checkBoxHelpers(load) {
  heading('Breaks box helpers (sliced): Add a break, orange notes');
  const app = load(makeState(week('09:00', '12:30', '17:00')), breaksFor({}));
  const cfg = week('09:00', '12:30', '17:00').Monday;
  same('Add a break on the defaults: middle of the longest gap (12:30 to 5:00), 2:45 PM',
    app.suggestBreakStart(cfg, app.dayBreaks(cfg, 'Monday')), hm('14:45'));

  const noEnd = week('09:00', '12:30', null).Monday;
  const withLunch = load(makeState(week('09:00', '12:30', null)), breaksFor({ '*': { lunchMinutes: 30, extras: [] } }));
  same('no End of Day: an hour after the last break ends (1:00 PM + 1 hour)',
    withLunch.suggestBreakStart(noEnd, withLunch.dayBreaks(noEnd, 'Monday')), hm('14:00'));

  const crowded = load(makeState(week('09:00', '12:30', '17:00')), breaksFor({ '*': { lunchMinutes: 60, extras: [
    extra('a', '12:00', 45, 'A'), extra('b', '12:30', null, 'B'), extra('c', '08:00', 15, 'C'), extra('d', '17:30', 15, 'D')] } }));
  const rows = crowded.dayBreaks(cfg, 'Monday');
  const notes = {};
  rows.forEach((b) => { notes[b.name] = crowded.breakNotes(cfg, rows, b); });
  same('notes', notes, {
    A: ['Runs into the 12:30 PM break.'],
    B: ['Same time as another break.'],        // brk750 sorts before lunch at the same time
    Lunch: ['Same time as another break.'],
    D: ['Starts after End of Day.'],
    C: ["Before Start, so it won't count down."],
  });

  const atStart = load(makeState(week('09:00', '12:30', '17:00')), breaksFor({ '*': { lunchMinutes: null, extras: [extra('s', '09:00', 15, 'At start')] } }));
  const startRows = atStart.dayBreaks(cfg, 'Monday');
  same('a break at Start says it will not count down', atStart.breakNotes(cfg, startRows, startRows[0]),
    ["Same time as Start, so it won't count down."]);
  // A lone lunch with no length there is the lunch timer it always was, and does count down.
  const lunchCfg = week('09:00', '09:00', '17:00').Monday;
  const lunchAtStart = load(makeState(week('09:00', '09:00', '17:00')), breaksFor({}));
  const lunchRows = lunchAtStart.dayBreaks(lunchCfg, 'Monday');
  same('a lone lunch at Start: no note', lunchAtStart.breakNotes(lunchCfg, lunchRows, lunchRows[0]), []);
  const lunchPlus = load(makeState(week('09:00', '09:00', '17:00')), breaksFor({ '*': { lunchMinutes: null, extras: [extra('t', '10:30', 15, 'Tea')] } }));
  const plusRows = lunchPlus.dayBreaks(lunchCfg, 'Monday');
  same('lunch at Start beside another break: it will not count down', lunchPlus.breakNotes(lunchCfg, plusRows, plusRows[0]),
    ["Same time as Start, so it won't count down."]);

  /* A length left behind on a day whose schedule has no lunch (an older
     copy took lunch away) reads as no length, even where the day's hours
     give it a lunch, as the conference programme does. */
  const leftover = load(makeState(week('09:00', null, '17:00')), breaksFor({ '*': { lunchMinutes: 30, extras: [] } }));
  same('a lunch length on a day the schedule gives no lunch reads as none',
    leftover.dayBreaks(Object.assign({}, week('09:00', '12:30', '17:00').Monday), 'Monday').map((b) => [b.key, b.minutes]), [['lunch', null]]);
}

/* ─────────────────────────── 2. The whole app in a stubbed DOM ─────────────────────────── */

/* Just enough DOM for app.js to run as it does in a page: elements by
   id, created elements with children, classes, attributes, dataset and
   listeners, and simple selectors. Elements from index.html that this
   never parsed are made on first use, so every element app.js touches is
   recorded, and that set is what the before/after comparison reads. */
function makeDom() {
  const byId = new Map();
  let active = null;
  /* Chrome and Edge, as a keystroke finishes the hour of a time input and
     moves on to the minutes: the change event fires while
     document.activeElement reads <body>, though focus never left the
     field, and its list still matches :focus-within. */
  let midTyping = false;
  /* Another tab or window in front: the page has lost focus, though the
     field it left keeps it within the page. */
  let windowFocused = true;

  class ClassList {
    constructor() { this.set = new Set(); }
    add(...n) { n.forEach((c) => this.set.add(c)); }
    remove(...n) { n.forEach((c) => this.set.delete(c)); }
    toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; }
    contains(c) { return this.set.has(c); }
  }
  class TextNode { constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentNode = null; } }

  const matchers = new Map();
  function compound(text) {
    const m = /^([a-z]+)?(?:#([\w-]+))?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(text);
    if (!m) throw new Error('fake DOM cannot match ' + text);
    const classes = m[3] ? m[3].slice(1).split('.') : [];
    const attrs = [...(m[4] || '').matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((a) => [a[1], a[2]]);
    return (el) => el.nodeType === 1 &&
      (!m[1] || el.tagName === m[1].toUpperCase()) &&
      (!m[2] || el.id === m[2]) &&
      classes.every((c) => el.classList.contains(c)) &&
      attrs.every(([k, v]) => { const got = el.attrValue(k); return got !== null && (v === undefined || got === v); });
  }
  function matcher(sel) {
    if (matchers.has(sel)) return matchers.get(sel);
    const alternatives = sel.split(',').map((part) => part.trim().split(/\s+/).map(compound));
    const test = (el) => alternatives.some((chain) => {
      if (!chain[chain.length - 1](el)) return false;
      let i = chain.length - 2;
      for (let p = el.parentNode; p && i >= 0; p = p.parentNode) if (chain[i](p)) i--;
      return i < 0;
    });
    matchers.set(sel, test);
    return test;
  }

  class El {
    constructor(tag, id, markup) {
      this.nodeType = 1; this.tagName = tag.toUpperCase(); this.id = id || ''; this.markup = !!markup;
      this.childNodes = []; this.parentNode = null; this.text = '';
      this.attrs = {}; this.dataset = {}; this.style = {}; this.classList = new ClassList();
      this.listeners = {}; this.stubs = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.checked = false;
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get className() { return [...this.classList.set].join(' '); }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get textContent() { return this.childNodes.length ? this.childNodes.map((n) => n.textContent).join('') : this.text; }
    set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; this.text = v == null ? '' : String(v); }
    get innerHTML() { return this.textContent; }
    set innerHTML(v) { this.textContent = v; }
    get offsetParent() { return this.hidden ? null : {}; }
    // In the page: the markup's own elements, and whatever hangs from them.
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.markup; }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, ref) {
      if (node.parentNode) node.parentNode.removeChild(node);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
      node.parentNode = this;
      this.text = '';
      return node;
    }
    removeChild(node) { const i = this.childNodes.indexOf(node); if (i >= 0) this.childNodes.splice(i, 1); node.parentNode = null; return node; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    attrValue(k) {
      if (Object.prototype.hasOwnProperty.call(this.attrs, k)) return this.attrs[k];
      if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return key in this.dataset ? String(this.dataset[key]) : null;
      }
      return k === 'type' && this.type !== undefined ? String(this.type) : null;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, f) { (this.listeners[type] = this.listeners[type] || []).push(f); }
    removeEventListener() {}
    dispatch(type, props) {
      const event = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, props || {});
      (this.listeners[type] || []).slice().forEach((f) => f.call(this, event));
      return event;
    }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { if (!this.disabled) active = this; }
    blur() { if (active === this) active = null; }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    matches(sel) { return sel === ':focus-within' ? this.contains(active) : matcher(sel)(this); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matcher(sel)(n)) return n; return null; }
    scrollIntoView() {}
    descendants() { const out = []; const walk = (el) => el.children.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; }
    querySelectorAll(sel) { return this.descendants().filter(matcher(sel)); }
    querySelector(sel) {
      const found = this.querySelectorAll(sel)[0];
      if (found || !this.markup) return found || null;
      // Markup this fake never parsed: one stable stand-in per selector.
      if (!this.stubs[sel]) {
        const tag = (/^([a-z]+)/.exec(sel) || [0, 'div'])[1];
        this.stubs[sel] = new El(tag, '', true);
      }
      return this.stubs[sel];
    }
  }

  const doc = {
    title: 'Pie Timers', referrer: '', hidden: false, readyState: 'complete', fullscreenElement: null,
    documentElement: new El('html', '', true), body: new El('body', '', true), head: new El('head', '', true),
    listeners: {},
    get activeElement() { return (!midTyping && active) || doc.body; },
    hasFocus() { return windowFocused; },
    getElementById(id) { if (!byId.has(id)) byId.set(id, new El('div', id, true)); return byId.get(id); },
    createElement(tag) { return new El(tag); },
    createElementNS(ns, tag) { return new El(tag); },
    createTextNode(t) { return new TextNode(t); },
    everything() { const out = []; byId.forEach((el) => { out.push(el); out.push(...el.descendants()); }); return out; },
    querySelectorAll(sel) { return doc.everything().filter(matcher(sel)); },
    querySelector(sel) { return doc.querySelectorAll(sel)[0] || null; },
    addEventListener(type, f) { (doc.listeners[type] = doc.listeners[type] || []).push(f); },
    removeEventListener() {},
    execCommand() {},
  };
  return { doc, byId, El, midTyping: (on) => { midTyping = on; }, windowFocused: (on) => { windowFocused = on; } };
}

/* One element, everything about it a person could see, as text. */
function snap(node) {
  if (!node) return 'null';
  if (node.nodeType === 3) return '"' + node.textContent + '"';
  const sorted = (keys) => (keys.length > 1 ? keys.sort() : keys);
  let out = '<' + node.tagName + ' class="' + sorted([...node.classList.set]).join(' ') + '"';
  for (const k of sorted(Object.keys(node.attrs))) out += ' ' + k + '="' + node.attrs[k] + '"';
  for (const k of sorted(Object.keys(node.dataset))) out += ' data-' + k + '="' + node.dataset[k] + '"';
  if (node.hidden) out += ' hidden';
  if (node.disabled) out += ' disabled';
  if (node.checked) out += ' checked';
  if (node.value) out += ' value="' + node.value + '"';
  if (node.title) out += ' title="' + node.title + '"';
  if (node.style.width !== undefined) out += ' width=' + node.style.width;
  out += '>';
  if (node.childNodes.length) for (const child of node.childNodes) out += snap(child);
  else out += '"' + node.text + '"';
  return out + '</>';
}

/* A fake PostgREST for timer_profiles, as supabase.js talks to it. */
function makeServer(opts) {
  // probeStatus: an HTTP status the column check answers with once, e.g. a rate limit's 429.
  // holdGets, holdPosts: how many of the next row reads or writes to hold back, in server.held.
  // A held read takes the row as it is asked, and answer() delivers that later (answerNow(): the
  // row as it is by then, as if the request reached the database last). A held write
  // lands only when land() is called; fail() drops it as a network error, unlanded.
  const server = Object.assign({ columnExists: true, row: null, probeFails: false, probeStatus: null, calls: [],
    holdGets: 0, holdPosts: 0, held: [] }, opts || {});
  server.fetch = (url, options) => {
    const method = (options && options.method) || 'GET';
    const u = new URL(url);
    const call = { method, path: u.pathname, query: u.search, body: options && options.body ? JSON.parse(options.body) : null };
    server.calls.push(call);
    const reply = (status, body) => Promise.resolve({
      ok: status >= 200 && status < 300, status,
      text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
      json: () => Promise.resolve(body),
    });
    if (u.pathname !== '/rest/v1/timer_profiles') return reply(404, { message: 'not faked' });
    if (method === 'GET' && u.searchParams.get('select') === 'breaks') {
      if (server.probeFails) return Promise.reject(new TypeError('Failed to fetch'));
      if (server.probeStatus) {
        const status = server.probeStatus;
        server.probeStatus = null;
        return reply(status, { message: 'answered ' + status });
      }
      return server.columnExists ? reply(200, [])
        : reply(400, { code: '42703', message: 'column timer_profiles.breaks does not exist' });
    }
    if (method === 'GET') {
      let answer = reply(200, []);
      if (server.row) {
        const row = JSON.parse(JSON.stringify(server.row));
        if (!server.columnExists) delete row.breaks;
        answer = reply(200, [row]);
      }
      if (server.holdGets > 0) {
        server.holdGets--;
        return new Promise((resolve) => server.held.push({ call, answer: () => resolve(answer),
          answerNow: () => { const held = server.holdGets; server.holdGets = 0; resolve(server.fetch(url, options)); server.holdGets = held; } }));
      }
      return answer;
    }
    if (method === 'POST') {
      if ('breaks' in call.body && !server.columnExists) {
        return reply(400, { code: 'PGRST204', message: "Could not find the 'breaks' column of 'timer_profiles' in the schema cache" });
      }
      const land = () => {
        server.row = Object.assign({}, server.row || {}, call.body);
        return reply(201, [server.row]);
      };
      if (server.holdPosts > 0) {
        server.holdPosts--;
        return new Promise((resolve, reject) => server.held.push({ call, land: () => resolve(land()),
          fail: () => reject(new TypeError('Failed to fetch')) }));
      }
      return land();
    }
    return reply(405, {});
  };
  server.posts = () => server.calls.filter((c) => c.method === 'POST');
  server.probes = () => server.calls.filter((c) => c.method === 'GET' && /select=breaks/.test(c.query));
  return server;
}

const STORE_KEY = 'countdown-timers/v1';
const BREAKS_KEY = 'countdown-timers/breaks/v1';
const SYNCED_KEY = 'countdown-timers/synced-account/v1';
const USER = { id: 'user-1', email: 'tester@example.com' };

/* Boots app.js (and, for sync, supabase.js and sync.js) as a page would.
   opts: ref (git ref for app.js, or null for the working tree), storage
   (localStorage contents), search ('?focus=1'), server (makeServer()),
   signedIn. With a server, the app is configured and signed in. */
function bootApp(opts) {
  const dom = makeDom();
  const store = new Map(Object.entries(opts.storage || {}));
  const writes = [];
  const timers = [];
  let timerId = 0;
  const shown = [];
  const winListeners = {};
  let lastBlob = null;
  const configured = !!opts.server;

  class FakeBlob { constructor(parts) { this.text = parts.join(''); lastBlob = this; } }
  class FakeReader { readAsText(file) { this.result = file.content; this.onload(); } }
  class FakeURL extends URL { static createObjectURL() { return 'blob:fake'; } static revokeObjectURL() {} }

  const win = {
    document: dom.doc,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { writes.push('-' + k); store.delete(k); },
    },
    sessionStorage: (() => { const s = new Map(); return { getItem: (k) => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: (k) => s.delete(k) }; })(),
    location: { origin: 'https://pietimers.aibhlinn.ai', pathname: '/', search: opts.search || '', hash: '', href: 'https://pietimers.aibhlinn.ai/' + (opts.search || '') },
    history: { replaceState() {} },
    navigator: { onLine: true, userAgent: 'node' },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    setTimeout: (f, ms) => { const id = ++timerId; timers.push({ id, f, ms: ms || 0 }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => ++timerId, clearInterval() {},
    URL: FakeURL, URLSearchParams, Blob: FakeBlob, FileReader: FakeReader, Promise, console, Date: FakeDate,
    addEventListener: (type, f) => { (winListeners[type] = winListeners[type] || []).push(f); },
    removeEventListener() {},
    open: () => null,
    qrcode: () => ({ addData() {}, make() {}, createSvgTag: () => '<svg></svg>' }),
    fetch: opts.server ? opts.server.fetch : () => Promise.reject(new Error('no network in this run')),
  };
  win.window = win; win.self = win; win.globalThis = win;
  const signedIn = configured && opts.signedIn !== false;
  win.CT = {
    config: {
      isConfigured: configured, supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon',
      supportEmail: '', privacyUrl: '', termsUrl: '', playTestingUrl: '', paddle: {},
      googleCalendarEnabled: false, pushConfigured: false, turnstileEnabled: false, billingEnabled: false,
    },
    billing: {
      isEntitled: () => true, enabled: () => false, get: () => ({}), onChange() {}, hasPaidPlan: () => false,
      refresh: () => Promise.resolve(),
    },
    notify: {
      supported: false, pushSupported: false, register: () => Promise.resolve(), syncScheduleToWorker() {},
      show: (title, body, tag) => shown.push({ real: CLOCK.real, title, body, tag }),
      permission: () => 'default', requestPermission: () => Promise.resolve('default'),
      refreshSubscription: () => Promise.resolve(null), unsubscribe: () => Promise.resolve(),
    },
    turnstile: { token: () => '', mount() {}, reset() {} },
    emailTypos: { suggest: () => null },
  };
  const identity = {
    validToken: () => Promise.resolve(signedIn ? 'token' : null), getUser: () => (signedIn ? USER : null),
    isSignedIn: () => signedIn, onChange: () => () => {}, loadUser: () => Promise.resolve(signedIn ? USER : null),
    signOut: () => Promise.resolve(), deleteAccount: () => Promise.resolve(), verifyEmailOtp: () => Promise.resolve(),
    signInWithGoogle() {}, getSession: () => (signedIn ? {} : null),
  };
  win.Aibhlinn = { identity };
  vm.createContext(win);

  if (opts.server) {
    vm.runInContext(readVersion(null, 'app/supabase.js'), win, { filename: 'supabase.js' });
    vm.runInContext(readVersion(null, 'app/sync.js'), win, { filename: 'sync.js' });
  } else {
    win.CT.auth = { isSignedIn: () => false, getUser: () => null, onChange() {}, wasConnectingGoogle: () => false };
    win.CT.db = {};
    win.CT.sync = { init() {}, notifyLocalChange() {}, deviceId: 'dev_test', onStatus() {}, pull: () => Promise.resolve(true), forgetAccount() {} };
  }
  vm.runInContext(readVersion(opts.ref === undefined ? null : opts.ref, APP), win, { filename: 'app.js' });

  const $ = (id) => dom.doc.getElementById(id);
  return {
    win, dom, store, writes, timers, shown, $,
    CT: win.CT,
    render: () => win.CT.app.render(),
    at: (real) => { CLOCK.real = real; win.CT.app.render(); },
    runTimers: (maxMs) => {
      const due = timers.filter((t) => t.ms <= maxMs);
      due.forEach((t) => { timers.splice(timers.indexOf(t), 1); t.f(); });
    },
    storage: (type, key, newValue) => (winListeners[type] || []).forEach((f) => f({ key, newValue })),
    lastBlob: () => lastBlob,
    breaks: () => { const raw = store.get(BREAKS_KEY); return raw === undefined ? undefined : JSON.parse(raw); },
    saved: () => JSON.parse(store.get(STORE_KEY)),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve)).then(() => new Promise((resolve) => setImmediate(resolve)));
async function settleAll() { for (let i = 0; i < 8; i++) await settle(); }

/* STORE_KEY as the app saves it, onboarded, alerts on, last edited a week ago. */
function savedState(schedule, settings, more) {
  return JSON.stringify(Object.assign({
    schedule, settings: Object.assign({ onboarded: true, testerInviteDone: true, alerts: true }, settings || {}),
    appointments: [], calendarEvents: [], updatedAt: at('2026-09-20 12:00'),
  }, more || {}));
}

/* ─────────────────────────── 2a. Before and after ─────────────────────────── */

function checkBeforeAfter() {
  heading(`One lunch, no extra breaks: the whole app, tick by tick, against ${BASELINE}'s app.js`);
  const nightly = week('22:00', '02:00', '06:00');
  const custom = week('07:30', '11:45', '15:15', { lunchHeadHome: true, endHeadHome: true });
  custom.Saturday.working = false; custom.Sunday.working = false;
  const defaults = {
    Monday: { working: true, start: 540, lunch: 750, end: 1020 }, Tuesday: { working: true, start: 540, lunch: 750, end: 1020 },
    Wednesday: { working: true, start: 540, lunch: 750, end: 1020 }, Thursday: { working: true, start: 540, lunch: 750, end: 1020 },
    Friday: { working: true, start: 540, lunch: 750, end: 1020 }, Saturday: { working: true, start: 540, lunch: 750, end: 1020 },
    Sunday: { working: false, start: 540, lunch: 750, end: 1020 },
  };
  const tomorrowAppt = [{ id: 'ap_1', title: 'Dentist', date: '2026-09-29', time: 600 }];
  const scenarios = [
    { name: 'the defaults, Saturday then a Sunday off', schedule: defaults, storage: { [STORE_KEY]: savedState(defaults) },
      from: '2026-09-26 00:00', to: '2026-09-28 00:00' },
    { name: '24-hour clock, no seconds, Head Home, "Crib", urgent at 30, weekend off', schedule: custom,
      storage: { [STORE_KEY]: savedState(custom, { clock24: true, showSeconds: false, lunchLabel: 'Crib', urgentMinutes: 30, theme: 'light' }) },
      from: '2026-09-26 05:00', to: '2026-09-29 05:00' },
    { name: 'night shift 22:00 / 02:00 / 06:00', schedule: nightly, storage: { [STORE_KEY]: savedState(nightly) },
      from: '2026-09-28 12:00', to: '2026-09-30 12:00' },
    { name: 'focus view (?focus=1), with an appointment', search: '?focus=1', schedule: defaults,
      storage: { [STORE_KEY]: savedState(defaults, {}, { appointments: tomorrowAppt }) },
      from: '2026-09-28 06:00', to: '2026-09-29 12:00' },
    { name: 'an empty breaks record and a garbage one already stored', schedule: defaults,
      storage: { [STORE_KEY]: savedState(defaults), [BREAKS_KEY]: JSON.stringify({ v: 1, days: { Monday: { lunchMinutes: null, extras: 'junk' } }, savedAt: 5 }) },
      from: '2026-09-28 06:00', to: '2026-09-28 20:00' },
    { name: 'alerts off', schedule: defaults, storage: { [STORE_KEY]: savedState(defaults, { alerts: false }) },
      from: '2026-09-28 06:00', to: '2026-09-28 20:00' },
  ];

  /* Every second for two minutes either side of each start, milestone,
     target and midnight, where the words and alerts change; every minute
     in between, on an odd second. */
  const ticksFor = (sc) => {
    const t0 = at(sc.from);
    const t1 = at(sc.to);
    const set = new Set();
    for (let t = t0 + 7000; t < t1; t += 60000) set.add(t);
    for (let day = new RealDate(t0); day.getTime() < t1; day = new RealDate(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
      const midnight = new RealDate(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
      const cfg = sc.schedule[DAYS[(day.getDay() + 6) % 7]];
      const marks = [0];
      [cfg.start, cfg.lunch, cfg.end].forEach((target) => {
        if (typeof target !== 'number') return;
        [0, 5, 10, 15, 30].forEach((m) => marks.push(target - m));
      });
      marks.forEach((minute) => {
        const centre = midnight + minute * 60000;
        for (let t = centre - 125000; t <= centre + 125000; t += 1000) if (t >= t0 && t < t1) set.add(t);
      });
    }
    return [...set].sort((a, b) => a - b);
  };
  /* Compared on every tick; everything else app.js touches is compared
     on every sixtieth and at the end, and the week table on every tenth. */
  const LIVE = /^(lunch|end|strip|cardLunch|cardEnd|focus|srClock|toast)/;

  for (const sc of scenarios) {
    CLOCK.real = at(sc.from);
    const started = RealDate.now();
    const oldApp = bootApp({ ref: BASELINE, storage: sc.storage, search: sc.search });
    const newApp = bootApp({ ref: null, storage: sc.storage, search: sc.search });
    let ids = [];
    const view = (app, all, table) => ids.filter((id) => all || LIVE.test(id)).map((id) => id + '=' + snap(app.$(id))).join('\n') +
      '\ntitle=' + app.dom.doc.title + (all || table ? '\ntbody=' + snap(app.$('weekPreview').querySelector('tbody')) : '');
    let diffs = [];
    let ticks = 0;
    const compare = (when, all, table) => {
      if (all) ids = [...oldApp.dom.byId.keys()].sort();
      const a = view(oldApp, all, table);
      const b = view(newApp, all, table);
      if (a !== b && diffs.length < 3) {
        const la = a.split('\n');
        const lb = b.split('\n');
        const i = la.findIndex((line, k) => line !== lb[k]);
        diffs.push(`${show(when)}\n  then ${la[i]}\n  now  ${lb[i]}`);
      }
    };
    compare(CLOCK.real, true);
    for (const t of ticksFor(sc)) {
      oldApp.at(t);
      newApp.at(t);
      ticks++;
      compare(t, ticks % 60 === 0, ticks % 10 === 0);
    }
    compare(CLOCK.real, true);
    const newOnly = [...newApp.dom.byId.keys()].filter((id) => !oldApp.dom.byId.has(id)).sort();
    check(`${sc.name}: ${ticks} ticks, ${ids.length} elements + title identical`, !diffs.length, diffs.join('\n'));
    same(`${sc.name}: every notification identical (${oldApp.shown.length})`, newApp.shown, oldApp.shown);
    check(`${sc.name}: new elements stay as shipped (Set breaks hidden, heading untouched, no is-break)`,
      newApp.$('breaksSet').hidden === true && newApp.$('lunchHeading').textContent === '' &&
      !newApp.$('cardLunch').classList.contains('is-break'),
      JSON.stringify({ breaksSet: newApp.$('breaksSet').hidden, heading: newApp.$('lunchHeading').textContent }));
    check(`${sc.name}: nothing new written at load or on the way (no breaks key written)`,
      !newApp.writes.includes(BREAKS_KEY), newApp.writes.join(', '));
    if (VERBOSE) note(`  new-only elements: ${newOnly.join(', ')} (${((RealDate.now() - started) / 1000).toFixed(1)} s)`);
  }
}

/* ─────────────────────────── 2b. A day with several breaks ─────────────────────────── */

function checkDashboard() {
  heading('Dashboard with several breaks (whole app): card, strip, week table, focus, tab title');
  const schedule = week('09:00', '12:30', '17:00');
  schedule.Sunday.working = false;
  schedule.Tuesday.lunch = null;
  const brks = breaksFor({
    Monday: { lunchMinutes: 30, extras: [extra('c', '10:30', 15, 'Coffee'), extra('b', '15:00', 10, '', true)] },
  });
  brks.days.Wednesday = { lunchMinutes: null, extras: [] };
  // Thursday's only extra is before Start: it never counts down, so it is never listed.
  brks.days.Thursday = { lunchMinutes: null, extras: [extra('e', '08:00', 15, 'Early')] };
  const storage = { [STORE_KEY]: savedState(schedule), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') }, brks)) };
  CLOCK.real = at('2026-09-28 06:00');
  const app = bootApp({ storage });
  const focus = bootApp({ storage, search: '?focus=1' });
  const $ = app.$;
  const card = () => ({
    heading: $('lunchHeading').textContent, chip: $('lunchTarget').textContent, big: $('lunchBig').textContent,
    small: $('lunchSmall').textContent, status: $('lunchStatus').textContent,
    classes: ['is-break', 'is-urgent', 'is-off', 'is-done'].filter((c) => $('cardLunch').classList.contains(c)).join(' '),
    setBreaks: $('breaksSet').hidden ? 'hidden' : 'shown', title: app.dom.doc.title,
  });
  const expectCard = (when, want) => { app.at(at(when)); same(`break card @ ${when}`, card(), want); };

  expectCard('2026-09-28 08:00', { heading: 'Coffee', chip: '10:30 AM', big: '1:30:00', small: 'starts at 9:00 AM',
    status: 'Coffee | 1 hour 30 minutes remaining', classes: '', setBreaks: 'hidden', title: '1:30:00 · Pie Timers' });
  expectCard('2026-09-28 10:00', { heading: 'Coffee', chip: '10:30 AM', big: '30:00', small: 'remaining',
    status: 'Coffee | 30 minutes 0 seconds remaining', classes: '', setBreaks: 'hidden', title: '30:00 · Pie Timers' });
  expectCard('2026-09-28 10:35', { heading: 'Coffee', chip: 'Back at 10:45 AM', big: '10:00', small: 'left of your break',
    status: 'Coffee | 10 minutes 0 seconds left, back at 10:45 AM', classes: 'is-break', setBreaks: 'hidden',
    title: 'Back in 10:00 · Pie Timers' });
  same('during: the pie refills and counts the break down (two thirds left)',
    $('lunchPie').getAttribute('d').startsWith('M 80 80 L 140.622 115.000'), true);
  expectCard('2026-09-28 11:00', { heading: 'Lunch', chip: '12:30 PM', big: '1:30:00', small: 'remaining',
    status: 'Lunch | 1 hour 30 minutes remaining', classes: '', setBreaks: 'hidden', title: '1:30:00 · Pie Timers' });
  expectCard('2026-09-28 12:40', { heading: 'Lunch', chip: 'Back at 1:00 PM', big: '20:00', small: 'left of your break',
    status: 'Lunch | 20 minutes 0 seconds left, back at 1:00 PM', classes: 'is-break', setBreaks: 'hidden',
    title: 'Back in 20:00 · Pie Timers' });
  expectCard('2026-09-28 14:50', { heading: 'Break | Head Home', chip: '3:00 PM', big: '10:00', small: 'remaining',
    status: 'Break | Head Home | 10 minutes 0 seconds remaining', classes: 'is-urgent', setBreaks: 'hidden', title: '10:00 · Pie Timers' });
  expectCard('2026-09-28 15:05', { heading: 'Break | Head Home', chip: 'Back at 3:10 PM', big: '5:00', small: 'left of your break',
    status: 'Break | 5 minutes 0 seconds left, back at 3:10 PM', classes: 'is-break', setBreaks: 'hidden', title: 'Back in 5:00 · Pie Timers' });

  // What the card's pie is called to a screen reader.
  const dialLabel = () => $('lunchDialLabel').textContent;
  app.at(at('2026-09-28 08:00'));
  same('dial label before a break names it', dialLabel(), 'Proportion of time remaining until Coffee');
  app.at(at('2026-09-28 10:35'));
  same('dial label during a break', dialLabel(), 'Proportion of your break left');

  app.at(at('2026-09-28 12:40'));
  const strip = () => $('stripLunch').childNodes.map((n) => n.nodeType === 3 ? n.textContent : (n.className === 'is-past' ? '(' + n.textContent + ')' : n.textContent)).join('');
  same('strip at 12:40: 10:30 is over, lunch is on', strip(), '(10:30 AM) · 12:30 PM · 3:00 PM');
  same('strip heading over the list reads Breaks, as the week table\'s does', $('stripLunchKey').textContent, 'Breaks');
  app.at(at('2026-09-28 15:30'));
  same('strip at 3:30: all over', strip(), '(10:30 AM) · (12:30 PM) · (3:00 PM)');
  expectCard('2026-09-28 15:30', { heading: 'Breaks', chip: '—', big: 'Done', small: 'no more breaks today',
    status: 'No more breaks today', classes: 'is-off', setBreaks: 'hidden', title: 'Pie Timers' });
  same('dial label once the breaks are over', dialLabel(), 'No more breaks today');

  const rows = () => $('weekPreview').querySelector('tbody').children.map((tr) => tr.children.map((td) => td.textContent + (td.className === 'breaks-cell' ? '*' : '')).join(' | '));
  same('week table: Monday stacks its breaks; Tuesday (no lunch), Wednesday, and Thursday (its extra is before Start) stay as ever',
    rows().slice(0, 4), ['Monday | 9:00 AM | 10:30 AM\n12:30 PM\n3:00 PM* | 5:00 PM', 'Tuesday | 9:00 AM | — | 5:00 PM',
      'Wednesday | 9:00 AM | 12:30 PM | 5:00 PM', 'Thursday | 9:00 AM | 12:30 PM | 5:00 PM']);
  same('week table heading reads Breaks once any day has extras', $('weekPreview').querySelector('[data-lunch-name]').textContent, 'Breaks');

  app.at(at('2026-09-29 10:00'));
  same('Tuesday, working with no breaks', card(), { heading: 'Breaks', chip: '—', big: 'None', small: 'no breaks today',
    status: 'No breaks today', classes: 'is-off', setBreaks: 'shown', title: 'Pie Timers' });
  same('Tuesday strip keeps the freedom word as ever', $('stripLunch').textContent, 'Vryheid');
  same('dial label with no breaks today', dialLabel(), 'No breaks today');
  app.at(at('2026-09-30 10:00'));
  same('Wednesday, plain lunch: the heading is handed back', [$('lunchHeading').textContent, $('lunchSmall').textContent, $('breaksSet').hidden], ['Lunch', 'remaining', true]);
  // This stub DOM never parsed index.html, so the page's own words are the empty text it started with.
  same('...and so are the strip heading and the dial label', [$('stripLunchKey').textContent, dialLabel()], ['Lunch', '']);
  app.at(at('2026-10-01 10:00'));
  same('Thursday: a break before Start is left off the strip, which shows lunch as ever', [$('stripLunch').textContent, $('stripLunchKey').textContent],
    ['12:30 PM', 'Lunch']);

  app.at(at('2026-09-28 10:35:00'));
  app.win.CT.app.render();
  same('screen reader line during a break', $('srClock').textContent.split('. ')[0], 'Coffee: 10:00 left of your break');

  focus.at(at('2026-09-28 10:35'));
  same('focus view during a break', [focus.$('focusLabel').textContent, focus.dom.doc.title, focus.$('focusView').classList.contains('is-break'),
    focus.$('focusView').classList.contains('is-urgent')], ['Coffee · back at 10:45 AM', 'Back in 10:00 · Coffee', true, false]);
  focus.at(at('2026-09-28 10:20'));
  same('focus view before a break (nearest wins)', [focus.$('focusLabel').textContent, focus.dom.doc.title], ['Coffee', '10:00 · Coffee']);

  // A week whose only extra is before Start lists nothing but lunch, so the heading stays the lunch's.
  const early = breaksFor({ Thursday: { lunchMinutes: null, extras: [extra('e', '08:00', 15, 'Early')] } });
  const earlyApp = bootApp({ storage: { [STORE_KEY]: savedState(schedule), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') }, early)) } });
  earlyApp.at(at('2026-09-28 10:00'));
  same('only extra before Start: the week table keeps the Lunch heading', earlyApp.$('weekPreview').querySelector('[data-lunch-name]').textContent, 'Lunch');
}

/* ─────────────────────────── 3. Storage and sync ─────────────────────────── */

async function checkStorageAndSync() {
  heading('Storage rules (whole app)');
  const schedule = week('09:00', '12:30', '17:00');
  CLOCK.real = at('2026-09-28 08:00');

  // Loading writes nothing, stamps nothing (R7, R8).
  let app = bootApp({ storage: { [STORE_KEY]: savedState(schedule) } });
  const loadedAt = app.saved().updatedAt;
  check('boot writes no breaks key and no STORE_KEY', !app.writes.length, app.writes.join(', '));

  // A break edit: stamped, breaks key first, then STORE_KEY; never inside STORE_KEY (R6).
  CLOCK.real = at('2026-09-28 08:01');
  app.$('breaksAdd').click();
  const afterAdd = app.saved();
  const stored = app.breaks();
  check('STORE_KEY never holds breaks', !('breaks' in afterAdd) && !/"extras"|lunchMinutes/.test(app.store.get(STORE_KEY)), app.store.get(STORE_KEY).slice(0, 200));
  same('Add a break: 15 minutes at 2:45 PM on Monday', stored.days.Monday.extras.map((e) => [e.start, e.minutes, e.name]), [[hm('14:45'), 15, '']]);
  check('savedAt is the updatedAt just stamped', stored.savedAt === afterAdd.updatedAt && afterAdd.updatedAt === at('2026-09-28 08:01'), JSON.stringify([stored.savedAt, afterAdd.updatedAt]));
  same('breaks key written before STORE_KEY', app.writes.slice(-2), [BREAKS_KEY, STORE_KEY]);
  check('focus lands on the new time input', app.dom.doc.activeElement.type === 'time' &&
    app.dom.doc.activeElement.value === '14:45', app.dom.doc.activeElement.tagName);
  check('the new id is made once, "b_" + base36 time + random', /^b_[0-9a-z]+$/.test(stored.days.Monday.extras[0].id) && stored.days.Monday.extras[0].id.length > 10);

  // An unrelated edit does not touch the breaks key (R8).
  const rawBreaks = app.store.get(BREAKS_KEY);
  CLOCK.real = at('2026-09-28 08:02');
  app.$('calcTarget').value = '15:00';
  app.$('calcTarget').dispatch('input');
  check('an unrelated save leaves the breaks key alone', app.store.get(BREAKS_KEY) === rawBreaks && app.writes[app.writes.length - 1] === STORE_KEY);
  check('...while STORE_KEY is stamped', app.saved().updatedAt === at('2026-09-28 08:02'));
  /* breaksMark: STORE_KEY says its breaks key is as current as it is. An
     older copy's save drops it (its normalise() keeps only what it knows). */
  check('...and carries breaksMark, the updatedAt it was saved with', app.saved().breaksMark === at('2026-09-28 08:02'));
  check('...which an older copy\'s normalise() drops', (() => {
    const old = bootApp({ ref: BASELINE, storage: { [STORE_KEY]: app.store.get(STORE_KEY) } });
    old.$('calcTarget').value = '16:00';
    old.$('calcTarget').dispatch('input');
    return !('breaksMark' in old.saved()) && old.saved().schedule.Monday.start === 540;
  })());

  // Rename, length, and the orange notes, in place.
  const rows = () => app.$('breaksList').children.map((li) => li.dataset.breakId);
  same('rows in time order: lunch, then the new break', rows()[0], 'lunch');
  const extraRow = app.$('breaksList').children[1];
  extraRow.querySelector('.break-name-input').value = '  Walk ';
  extraRow.querySelector('.break-name-input').dispatch('input');
  extraRow.querySelector('select').value = '180';
  extraRow.querySelector('select').dispatch('change');
  same('rename and length saved', [app.breaks().days.Monday.extras[0].name, app.breaks().days.Monday.extras[0].minutes], ['Walk', 180]);
  same('"Back at" updates in place, and no note is needed',
    [extraRow.querySelector('.break-back').textContent, extraRow.querySelector('.break-notes').textContent], ['Back at 5:45 PM', '']);
  const timeInput = extraRow.querySelector('input[type="time"]');
  timeInput.focus();
  timeInput.value = '17:30';
  timeInput.dispatch('change');
  check('a new time with the field still focused: the row stays, its note updates in place (R21)',
    app.$('breaksList').children[1] === extraRow && extraRow.querySelector('.break-notes').textContent === 'Starts after End of Day.' &&
    extraRow.querySelector('.break-back').textContent === 'Back at 8:30 PM', extraRow.querySelector('.break-notes').textContent);
  /* Mid-typing, a part-typed or cleared time reads as empty. Nothing is
     written for it, and the field is left alone for the typing to go on;
     left empty, it gets its time back. */
  timeInput.value = '';
  timeInput.dispatch('change');
  same('a time cleared mid-typing writes nothing and is left to the typing', [timeInput.value, app.breaks().days.Monday.extras[0].start], ['', hm('17:30')]);
  timeInput.dispatch('blur');
  same('...and left empty, it gets its time back', timeInput.value, '17:30');
  /* Chrome's change event as the hour is finished: activeElement reads
     <body>. The row must still not be rebuilt under the typing. */
  app.dom.midTyping(true);
  timeInput.value = '10:45';
  timeInput.dispatch('change');
  const attachedDuring = app.$('breaksList').children.includes(extraRow);
  app.dom.midTyping(false);
  check('a change while Chrome says <body> has focus: the row is not rebuilt, the time is saved',
    attachedDuring && app.breaks().days.Monday.extras[0].start === hm('10:45'),
    JSON.stringify({ attached: attachedDuring, start: app.breaks().days.Monday.extras[0].start }));
  app.runTimers(0);
  check('...nor once the event is over, while the field still has focus',
    app.$('breaksList').children.indexOf(extraRow) === 1 && app.dom.doc.activeElement === timeInput);
  timeInput.value = '14:45';
  timeInput.dispatch('change');
  timeInput.blur();
  app.$('breaksList').dispatch('focusout', { relatedTarget: null });
  app.runTimers(0);
  check('focus gone: the rows are rebuilt in time order', !app.$('breaksList').children.includes(extraRow) &&
    app.$('breaksList').children[1].querySelector('input[type="time"]').value === '14:45');

  // Remove, then Undo (status set after flashSaved clears it).
  extraRow.querySelector('button').click();
  same('Remove works at once, with a status and Undo', [app.breaks().days.Monday.extras.length, app.$('breaksStatus').textContent, app.$('breaksUndo').hidden],
    [0, 'Removed the 2:45 PM break.', false]);
  app.$('breaksUndo').click();
  same('Undo puts it back, same id', [app.breaks().days.Monday.extras.map((e) => e.name), app.$('breaksStatus').textContent], [['Walk'], 'Put the 2:45 PM break back.']);

  // Removing lunch empties the slot and its length (R3).
  app.$('breaksList').children[0].querySelector('select').value = '30';
  app.$('breaksList').children[0].querySelector('select').dispatch('change');
  app.$('breaksList').children[0].querySelector('button').click();
  same('Remove lunch: schedule lunch null, length null', [app.saved().schedule.Monday.lunch, app.breaks().days.Monday.lunchMinutes], [null, null]);
  app.$('breaksUndo').click();
  same('Undo lunch: both back', [app.saved().schedule.Monday.lunch, app.breaks().days.Monday.lunchMinutes], [750, 30]);

  // Copy a day copies breaks with fresh ids; Undo restores the targets' own.
  app.$('copyFrom').value = 'Monday';
  app.$('copyTo').children.find((chip) => chip.dataset.day === 'Tuesday').click();
  app.$('copyApply').click();
  const monIds = app.breaks().days.Monday.extras.map((e) => e.id);
  const tueIds = app.breaks().days.Tuesday.extras.map((e) => e.id);
  same('Copy a day: Tuesday gets the breaks and lengths', [app.breaks().days.Tuesday.lunchMinutes, app.breaks().days.Tuesday.extras.map((e) => e.name)], [30, ['Walk']]);
  check('...with fresh ids', tueIds.length === 1 && tueIds[0] !== monIds[0]);
  app.$('copyUndo').click();
  same('Copy Undo restores Tuesday\'s breaks', app.breaks().days.Tuesday, { lunchMinutes: null, extras: [] });

  // The Lunch column in the table: taking lunch away takes its length (R3).
  const lunchInput = app.$('scheduleBody').children[0].children[3].children[0];
  lunchInput.value = '';
  lunchInput.dispatch('change');
  same('table: clearing Monday lunch clears its length', [app.saved().schedule.Monday.lunch, app.breaks().days.Monday.lunchMinutes], [null, null]);

  // Export writes breaks beside schedule and settings (R15); import adopts or clears.
  app.$('exportData').click();
  const exported = JSON.parse(app.lastBlob().text);
  check('export: breaks is a top-level sibling of schedule and settings', exported.breaks && exported.breaks.v === 1 &&
    exported.breaks.days.Monday.extras.length === 1 && exported.schedule && exported.settings);
  const importFile = (content) => { app.$('importFile').files = [{ content: JSON.stringify(content) }]; app.$('importFile').dispatch('change'); };
  importFile({ schedule: exported.schedule, settings: exported.settings });
  same('import without breaks clears them', JSON.stringify(app.breaks().days).includes('"extras":[{'), false);
  importFile(exported);
  same('import with breaks adopts them', app.breaks().days.Monday.extras.map((e) => e.name), ['Walk']);

  // Restore defaults resets the record (R16).
  app.$('resetSchedule').click();
  same('Restore defaults resets breaks', JSON.stringify(app.breaks().days).includes('"extras":[{') || JSON.stringify(app.breaks().days).includes('"lunchMinutes":3'), false);

  // Another tab's newer save is adopted; an older one is not (R9).
  const theirs = breaksFor({ Monday: { lunchMinutes: 20, extras: [extra('t', '10:00', 10, 'Tab')] } });
  app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: 1 }, theirs)));
  check('an older save from another tab is ignored', !app.$('breaksList').descendants().some((n) => n.value === 'Tab'));
  app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at('2027-01-01 00:00') }, theirs)));
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  check('a newer save from another tab is adopted and shown', app.$('breaksList').descendants().some((n) => n.value === 'Tab'));
  app.storage('storage', STORE_KEY, 'whatever');
  check('other keys are not listened to (no throw)', true);

  // The box is never rebuilt under a focused field (R21).
  const name = app.$('breaksList').descendants().find((n) => n.value === 'Tab');
  name.focus();
  const before = app.$('breaksList').children[0];
  app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at('2027-01-02 00:00') },
    breaksFor({ Monday: { lunchMinutes: 20, extras: [extra('t', '10:00', 10, 'Tab'), extra('u', '09:30', 10, 'Earlier')] } }))));
  check('while a field has focus, rows are not rebuilt', app.$('breaksList').children[0] === before);
  app.$('breaksList').dispatch('focusout', { relatedTarget: null });
  name.blur();
  app.runTimers(0);
  check('...and are rebuilt, re-sorted, once focus leaves', app.$('breaksList').children[0] !== before &&
    app.$('breaksList').children[0].querySelector('.break-name-input').value === 'Earlier');

  // Copy a day's Undo would put back the breaks from before another tab's save, so it goes.
  app.$('copyFrom').value = 'Monday';
  app.$('copyTo').children.find((chip) => chip.dataset.day === 'Wednesday').click();
  app.$('copyApply').click();
  const undoOffered = !app.$('copyUndo').hidden;
  app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at('2027-01-03 00:00') },
    breaksFor({ Wednesday: { lunchMinutes: null, extras: [extra('w', '11:00', 10, 'Theirs')] } }))));
  check('another tab\'s breaks adopted: Copy a day\'s Undo is withdrawn', undoOffered && app.$('copyUndo').hidden);

  // Delete account in another tab takes the key away: this tab forgets its breaks too, writing nothing.
  const writesBeforeRemoval = app.writes.length;
  app.storage('storage', BREAKS_KEY, null);
  check('breaks key removed by another tab: breaks empty here, nothing written',
    !JSON.stringify(app.CT.app.getBreaks().days).includes('"extras":[{') && app.writes.length === writesBeforeRemoval);
  CLOCK.real = at('2027-01-04 00:00');
  app.$('breaksAdd').click();
  same('...so an edit here afterwards writes only its own break, not the deleted ones',
    app.breaks().days.Wednesday.extras.map((e) => e.name).concat(app.breaks().days.Monday.extras.map((e) => e.name)), ['']);

  /* Seven breaks: an older copy set lunch on a day that had six others.
     All seven are kept, the box shows them, and Add a break is off, faded
     and says why. The new app's own table edit does the same. */
  const noLunch = week('09:00', null, '17:00');
  const sixExtras = [0, 1, 2, 3, 4, 5].map((i) => extra('s' + i, (10 + i) + ':00', 10, 'S' + i));
  app = bootApp({ storage: { [STORE_KEY]: savedState(noLunch), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: null, extras: sixExtras } }))) } });
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  same('six breaks: Add a break is off, and says why beside it',
    [app.$('breaksAdd').disabled, app.$('breaksFull').hidden, app.$('breaksFull').textContent, app.$('breaksAdd').getAttribute('aria-describedby')],
    [true, false, "That's 6, the most a day can hold.", 'breaksFull']);
  CLOCK.real = at('2026-09-28 08:10');
  const mondayLunch = app.$('scheduleBody').children[0].children[3].children[0];
  mondayLunch.value = '12:30';
  mondayLunch.dispatch('change');
  same('lunch typed into the table on that day: every break is kept', app.breaks().days.Monday.extras.map((e) => e.id), sixExtras.map((e) => e.id));
  same('...all seven shown, Add a break still off, and why',
    [app.$('breaksList').children.length, app.$('breaksAdd').disabled, app.$('breaksFull').textContent],
    [7, true, "That's 7, more than the 6 a day can hold."]);
  app.$('breaksDay').value = 'Tuesday';
  app.$('breaksDay').dispatch('change');
  same('a day with room: Add a break is on, and nothing is said', [app.$('breaksAdd').disabled, app.$('breaksFull').hidden,
    app.$('breaksAdd').getAttribute('aria-describedby')], [false, true, null]);

  /* A lunch length left by an older copy that took lunch away reads as
     none, and a lunch put back in the table starts with no set length. */
  app = bootApp({ storage: { [STORE_KEY]: savedState(noLunch), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: 30, extras: [] } }))) } });
  app.$('scheduleBody').children[0].children[3].children[0].value = '12:30';
  app.$('scheduleBody').children[0].children[3].children[0].dispatch('change');
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  same('lunch put back on a day whose length was left behind: no set length',
    [app.breaks().days.Monday.lunchMinutes, app.$('breaksList').children[0].querySelector('select').value], [null, '']);

  /* The table's Lunch cell while it has focus. A part-typed time reads as
     empty, and so does one cleared with Backspace on the way to another,
     and Chrome commits both. Lunch is emptied as it always was, but its
     length waits: typed back, the lunch keeps it; left empty, it goes. */
  const withLength = (more) => bootApp({ storage: Object.assign({ [STORE_KEY]: savedState(schedule), [BREAKS_KEY]: JSON.stringify(Object.assign(
    { savedAt: at('2026-09-20 12:00') }, breaksFor({ Monday: { lunchMinutes: 30, extras: [extra('tea', '10:00', 15, 'Tea')] } }))) }, more || {}) });
  app = withLength();
  const cell = app.$('scheduleBody').children[0].children[3].children[0];
  const lunchNow = () => [app.saved().schedule.Monday.lunch, app.CT.app.getBreaks().days.Monday.lunchMinutes];
  cell.focus();
  cell.dispatch('focus');
  cell.value = '';
  cell.dispatch('change');
  const typingLunch = lunchNow();
  cell.value = '12:45';
  cell.dispatch('change');
  same('table Lunch cell, focused: cleared on the way to a new time, then typed, the lunch keeps its length',
    [typingLunch, lunchNow()], [[null, 30], [hm('12:45'), 30]]);
  cell.value = '';
  cell.dispatch('change');
  cell.blur();
  cell.dispatch('blur');
  same('...left empty, the length goes with the lunch, in the record too', [lunchNow(), app.breaks().days.Monday.lunchMinutes], [[null, null], null]);
  app = bootApp({ storage: { [STORE_KEY]: savedState(noLunch), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: 30, extras: [] } }))) } });
  const emptyCell = app.$('scheduleBody').children[0].children[3].children[0];
  emptyCell.focus();
  emptyCell.dispatch('focus');
  emptyCell.value = '12:30';
  emptyCell.dispatch('change');
  same('...a lunch typed into a focused cell on a day that had none still starts with no set length',
    app.CT.app.getBreaks().days.Monday.lunchMinutes, null);

  /* Typing a new time into a break's field passes through times nobody
     chose ("3 0" into 1:00 PM's minutes is 1:03, then 1:30), and each is
     saved. None of them may announce anything; the time it ends up at
     still gets its own alerts. */
  CLOCK.real = at('2026-09-28 12:58');
  app = bootApp({ storage: { [STORE_KEY]: savedState(schedule), [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: null, extras: [extra('tea', '13:00', 15, 'Tea')] } }))) } });
  app.at(at('2026-09-28 12:58'));
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  const teaTime = app.$('breaksList').children.find((li) => li.dataset.breakId === 'tea').querySelector('input[type="time"]');
  teaTime.focus();
  const shownBefore = app.shown.length;
  teaTime.value = '13:03';
  teaTime.dispatch('change');
  teaTime.value = '13:30';
  teaTime.dispatch('change');
  app.at(at('2026-09-28 12:58') + 1000);
  check('a break\'s time typed in the box: the times passed through announce nothing', app.shown.length === shownBefore,
    JSON.stringify(app.shown.slice(shownBefore)));
  app.at(at('2026-09-28 13:25'));
  same('...and the time it ends up at still gets its heads-up', app.shown.slice(shownBefore).map((n) => n.title + ': ' + n.body + ' ' + n.tag),
    ['Tea: Starts in 5 minutes. 2026-09-28|brk810-825|5']);

  /* The row being typed in keeps its names while it has focus, since a
     screen reader speaks a focused control's new name on every key. They
     catch up as focus leaves. */
  CLOCK.real = at('2026-09-28 08:00');
  app = withLength();
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  const teaRow = () => app.$('breaksList').children.find((li) => li.dataset.breakId === 'tea');
  const teaField = teaRow().querySelector('input[type="time"]');
  teaField.focus();
  teaField.value = '10:45';
  teaField.dispatch('change');
  const namesTyping = [teaField.getAttribute('aria-label'), teaRow().querySelector('button').getAttribute('aria-label')];
  teaField.blur();
  app.$('breaksList').dispatch('focusout', { relatedTarget: null });
  same('names of the row being typed in wait for focus to leave, then say its new time',
    [namesTyping, [teaField.getAttribute('aria-label'), teaRow().querySelector('button').getAttribute('aria-label')]],
    [['Start of the 10:00 AM break', 'Remove the 10:00 AM break'], ['Start of the 10:45 AM break', 'Remove the 10:45 AM break']]);
  app.runTimers(0);

  /* A rebuild from outside (another tab, a sync) while a Remove button has
     focus: the button goes with its row, and focus is given back to the
     same control in the new row, or kept in the box if the row went. */
  const teaRemove = teaRow().querySelector('button');
  teaRemove.focus();
  const outside = (extras, savedAt) => app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at(savedAt) },
    breaksFor({ Monday: { lunchMinutes: 30, extras: extras } }))));
  outside([extra('tea', '10:45', 15, 'Tea'), extra('w', '15:00', 10, 'Walk')], '2026-09-28 09:00');
  const refocused = app.dom.doc.activeElement;
  check('an outside rebuild with Remove focused: focus back on that row\'s Remove',
    refocused !== teaRemove && refocused.tagName === 'BUTTON' && refocused.parentNode.parentNode.dataset.breakId === 'tea' &&
    app.$('breaksList').children.includes(refocused.parentNode.parentNode), refocused.tagName + ' ' + refocused.id);
  outside([extra('w', '15:00', 10, 'Walk')], '2026-09-28 09:05');
  check('...and if that row went, focus stays in the box, on Add a break', app.dom.doc.activeElement === app.$('breaksAdd'),
    app.dom.doc.activeElement.tagName + ' ' + app.dom.doc.activeElement.id);
  app.$('breaksList').children.find((li) => li.dataset.breakId === 'w').querySelector('button').click();
  check('its own Remove puts focus on Undo', app.dom.doc.activeElement === app.$('breaksUndo'));

  // index.html ships Copy a day's words from before breaks, for an older app.js; this one says breaks go too.
  same('Copy a day says it copies breaks', app.$('copyHint').textContent,
    'Copies the whole day: its times, its breaks and their lengths, its Head Home ticks, and whether it\'s a working day.');

  // Stray keys (R18): first run, and a copy reset to nothing.
  const stray = JSON.stringify(Object.assign({ savedAt: 9 }, breaksFor({ '*': { lunchMinutes: 30, extras: [extra('s', '10:00', 10, 'Stray')] } })));
  app = bootApp({ storage: { [BREAKS_KEY]: stray } });
  check('first run: a stray breaks key is removed', !app.store.has(BREAKS_KEY) && app.writes.includes('-' + BREAKS_KEY));
  app = bootApp({ storage: { [STORE_KEY]: savedState(schedule, {}, { updatedAt: 0 }), [BREAKS_KEY]: stray } });
  check('updatedAt 0: a stray breaks key is removed', !app.store.has(BREAKS_KEY));
  // Not a first run, and it may still hold someone's week: nothing is removed.
  app = bootApp({ storage: { [STORE_KEY]: '{"schedule":{"Monday":', [BREAKS_KEY]: stray } });
  check('a STORE_KEY that cannot be read: the breaks key is left alone', app.store.get(BREAKS_KEY) === stray && !app.writes.length,
    app.writes.join(', '));
  app = bootApp({ storage: { [STORE_KEY]: savedState(schedule), [BREAKS_KEY]: '{"v":1,"days":{"Monday":{"extras":[{"start":"10:30","minutes":999}]}},"savedAt":3}' } });
  check('a repaired record is not written back at load (R7)', app.store.get(BREAKS_KEY).includes('999') && !app.writes.length);
  same('...but is what the box shows', app.$('breaksList').children.map((li) => li.querySelector('select').value), ['180', '']);

  heading('Sync rules (whole app + real sync.js and supabase.js against a fake PostgREST)');
  const signedInStorage = (more) => Object.assign({ [STORE_KEY]: savedState(schedule), [SYNCED_KEY]: USER.id }, more || {});
  const localBreaks = JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: 30, extras: [extra('l', '10:30', 15, 'Local')] } })));

  // No row yet, column there: the probe answers 200 and the seed carries the full record.
  let server = makeServer({ columnExists: true, row: null });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  let posts = server.posts();
  check('no row yet: probed with select=breaks&limit=0', server.probes().length === 1 && /limit=0/.test(server.probes()[0].query));
  check('first-device seed carries the whole breaks record', posts.length === 1 && posts[0].body.breaks &&
    posts[0].body.breaks.v === 1 && Object.keys(posts[0].body.breaks.days).length === 7 &&
    posts[0].body.breaks.days.Monday.extras[0].name === 'Local' && !('savedAt' in posts[0].body.breaks), JSON.stringify(posts[0] && posts[0].body.breaks));

  // No row yet, no column: the probe says no, and nothing names the column.
  server = makeServer({ columnExists: false, row: null });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  posts = server.posts();
  check('no column: payload never names breaks, and the upsert is accepted', posts.length === 1 && !('breaks' in posts[0].body) &&
    server.row && server.row.schedule, JSON.stringify(posts.map((p) => Object.keys(p.body))));

  // Probe fails on the network: the push fails too, rather than going without.
  server = makeServer({ columnExists: true, row: null, probeFails: true });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  check('probe fails: nothing is pushed, and it is left to retry', server.posts().length === 0 &&
    app.CT.sync.getStatus().status === 'error', JSON.stringify(app.CT.sync.getStatus()));

  /* A blank record, empty and never saved on this device, as on every
     device with one lunch and no length: nothing is asked and nothing is
     sent, exactly the requests the app made before breaks, and no key. */
  server = makeServer({ columnExists: true, row: null, probeFails: true });
  app = bootApp({ server, storage: signedInStorage() });
  await settleAll();
  posts = server.posts();
  check('blank record, no row yet: no probe, and the seed leaves breaks out',
    server.probes().length === 0 && posts.length === 1 && !('breaks' in posts[0].body) &&
    app.CT.sync.getStatus().status === 'synced' && !app.store.has(BREAKS_KEY) && !('breaksMark' in app.saved()),
    JSON.stringify({ probes: server.probes().length, posts: posts.map((p) => Object.keys(p.body)), mark: app.saved().breaksMark }));
  server = makeServer({ row: Object.assign({ user_id: USER.id, schedule, settings: {}, appointments: [], breaks: null,
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() }) });
  app = bootApp({ server, storage: Object.assign(signedInStorage(), { [STORE_KEY]: savedState(schedule, {}, { updatedAt: at('2026-09-28 07:00') }) }) });
  await settleAll();
  posts = server.posts();
  check('blank record, local week newer: pushed without breaks, nothing written for them',
    posts.length === 1 && !('breaks' in posts[0].body) && !app.store.has(BREAKS_KEY) &&
    app.writes.filter((k) => k === STORE_KEY || k === BREAKS_KEY).length === 0,
    JSON.stringify({ posts: posts.map((p) => Object.keys(p.body)), writes: app.writes }));
  CLOCK.real = at('2026-09-28 08:10');
  app.$('resetSchedule').click();
  await app.CT.sync.push(true);
  posts = server.posts();
  check('...but Restore defaults is the person\'s word on the breaks, and is sent',
    posts.length === 2 && posts[1].body.breaks && posts[1].body.breaks.v === 1, JSON.stringify(posts.map((p) => Object.keys(p.body))));
  // A blank device takes a row's breaks as soon as it sees them, even with its week newer.
  const theirBreaks = breaksFor({ Monday: { lunchMinutes: null, extras: [extra('y', '15:00', 10, 'Theirs')] } });
  server = makeServer({ row: Object.assign({ user_id: USER.id, schedule, settings: {}, appointments: [], breaks: theirBreaks,
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() }) });
  app = bootApp({ server, storage: Object.assign(signedInStorage(), {
    [STORE_KEY]: savedState(schedule, {}, { updatedAt: at('2026-09-28 07:00'), breaksMark: at('2026-09-28 07:00') }) }) });
  await settleAll();
  posts = server.posts();
  same('blank record, confirmed, local week newer: the row\'s breaks are taken and go back up with the week',
    [app.breaks() && app.breaks().days.Monday.extras.map((e) => e.name), posts.length, posts[0] && posts[0].body.breaks && posts[0].body.breaks.days.Monday.extras.map((e) => e.name)],
    [['Theirs'], 1, ['Theirs']]);

  /* Any other answer but 200 or "no such column" says nothing about the
     column: a rate limit's 429 fails the push too, and is not kept. */
  server = makeServer({ columnExists: true, row: null, probeStatus: 429 });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  check('probe answers 429: nothing is pushed, and it is left to retry', server.posts().length === 0 &&
    app.CT.sync.getStatus().status === 'error', JSON.stringify(app.CT.sync.getStatus()));
  await app.CT.sync.pull();
  await settleAll();
  posts = server.posts();
  check('...the retry asks again, and the seed carries the breaks', server.probes().length === 2 && posts.length === 1 &&
    posts[0].body.breaks && posts[0].body.breaks.days.Monday.extras[0].name === 'Local', JSON.stringify(posts.map((p) => Object.keys(p.body))));

  /* Breaks an older copy may have left behind. STORE_KEY has no breaksMark
     (an older copy saved it last) and is newer than the row, and the
     breaks key has no edits a push has not carried. They are not sent;
     the row's are taken first and go back up with the week. */
  const rowBreaks = breaksFor({ Monday: { lunchMinutes: 20, extras: [extra('y', '15:00', 10, 'Theirs')] } });
  const staleKey = JSON.stringify(Object.assign({ savedAt: at('2026-09-20 12:00'), pushedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: null, extras: [extra('o', '10:30', 15, 'Old')] } })));
  const newerWeek = { [STORE_KEY]: savedState(schedule, {}, { updatedAt: at('2026-09-28 07:00') }), [SYNCED_KEY]: USER.id, [BREAKS_KEY]: staleKey };
  const rowWith = (brks) => ({ user_id: USER.id, schedule, settings: {}, appointments: [], breaks: brks,
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() });
  server = makeServer({ row: rowWith(rowBreaks) });
  app = bootApp({ server, storage: newerWeek });
  await settleAll();
  posts = server.posts();
  same('unconfirmed breaks, local week newer: the row\'s breaks are taken, and pushed back with the week',
    [app.breaks().days.Monday.extras.map((e) => e.name), posts.length, posts[0] && posts[0].body.breaks && posts[0].body.breaks.days.Monday.extras.map((e) => e.name)],
    [['Theirs'], 1, ['Theirs']]);
  check('...and STORE_KEY now carries breaksMark', app.saved().breaksMark === app.saved().updatedAt);

  server = makeServer({ row: rowWith(rowBreaks) });
  app = bootApp({ server, storage: newerWeek });
  app.win.navigator.onLine = false;
  await settleAll();
  CLOCK.real = at('2026-09-28 08:40');
  app.$('calcTarget').value = '15:00';
  app.$('calcTarget').dispatch('input');
  app.runTimers(1500);
  app.win.navigator.onLine = true;
  app.storage('online');                       // the 'online' handler pushes without pulling
  await settleAll();
  posts = server.posts();
  check('unconfirmed breaks, pushed without a pull: the payload leaves breaks out and the row keeps its own',
    posts.length === 1 && !('breaks' in posts[0].body) && server.row.breaks.days.Monday.extras[0].name === 'Theirs',
    JSON.stringify(posts.map((p) => Object.keys(p.body))));
  await app.CT.sync.pull();
  await settleAll();
  same('...and the next pull brings them', app.breaks().days.Monday.extras.map((e) => e.name), ['Theirs']);

  /* Unconfirmed, but holding edits of this device's own that no push has
     carried (savedAt after pushedAt). An older copy may have taken in
     another device's newer breaks meanwhile, so they are not sent until a
     pull has compared them with the row: the push after reconnecting pulls
     first. Saved after the row was written, they are kept and sent. */
  const unsentKey = (savedAt) => JSON.stringify(Object.assign({ savedAt: at(savedAt), pushedAt: at('2026-09-20 12:00') },
    breaksFor({ Monday: { lunchMinutes: null, extras: [extra('m', '14:45', 15, 'Mine')] } })));
  const ownUnsent = { [STORE_KEY]: savedState(schedule, {}, { updatedAt: at('2026-09-28 07:00') }), [SYNCED_KEY]: USER.id,
    [BREAKS_KEY]: unsentKey('2026-09-28 06:00') };
  const offlineEditThenReconnect = async (a) => {
    a.win.navigator.onLine = false;
    await settleAll();
    const before = a.CT.app.breaksToPush();
    CLOCK.real = at('2026-09-28 08:40');
    a.$('calcTarget').value = '15:00';
    a.$('calcTarget').dispatch('input');
    a.runTimers(1500);
    a.win.navigator.onLine = true;
    a.storage('online');
    await settleAll();
    return before;
  };
  server = makeServer({ row: rowWith(rowBreaks) });
  app = bootApp({ server, storage: ownUnsent });
  const unsentBefore = await offlineEditThenReconnect(app);
  posts = server.posts();
  same('own unsent edits, no mark: not sent until compared; the reconnect pulls first, then sends them (newer than the row)',
    [unsentBefore, server.calls.map((c) => c.method), posts[0] && posts[0].body.breaks && posts[0].body.breaks.days.Monday.extras.map((e) => e.name)],
    [null, ['GET', 'POST'], ['Mine']]);
  check('...and STORE_KEY carries breaksMark again', app.saved().breaksMark === app.saved().updatedAt);
  // Another device saved breaks after these: the row's are newer, and taken.
  server = makeServer({ row: Object.assign(rowWith(rowBreaks), { updated_at: new RealDate(at('2026-09-28 06:30')).toISOString() }) });
  app = bootApp({ server, storage: ownUnsent });
  await offlineEditThenReconnect(app);
  posts = server.posts();
  same('own unsent edits older than the row: the row\'s breaks are taken and go back up with the week',
    [app.breaks().days.Monday.extras.map((e) => e.name), posts.length, posts[0] && posts[0].body.breaks && posts[0].body.breaks.days.Monday.extras.map((e) => e.name)],
    [['Theirs'], 1, ['Theirs']]);
  // A first sign-in: the account's breaks replace the device's, unsent or not.
  server = makeServer({ row: Object.assign(rowWith(null), { updated_at: new RealDate(at('2026-09-01 12:00')).toISOString() }) });
  app = bootApp({ server, storage: Object.assign({}, ownUnsent, { [SYNCED_KEY]: '' }) });
  await settleAll();
  same('first sign-in: unsent breaks of the device\'s own still give way to the account\'s', app.breaks().days.Monday.extras, []);

  /* Another tab saved breaks and its week in one save, a Copy a day say,
     and its push has not gone: the tab was closed, or it is still open and
     offline, or its one push failed. This tab took the breaks in from the
     storage event, but never the week, so its own is the row's older one.
     Its next pull finds the row no newer than that week, and the breaks it
     took in newer than the row: they are kept, and sent with the week they
     were saved with, read back from storage, under that save's stamp. Sent
     with the row's week instead, under that stamp, they took the other
     tab's hours away for good: the row's stamp tied the other tab's, so it
     took the row's week too. */
  const rowT0 = at('2026-09-27 12:00');
  const tabAt = at('2026-09-28 08:10');
  const tabWeek = week('07:00', '11:00', '15:00');
  const tabRecord = breaksFor({ Monday: { lunchMinutes: 20, extras: [extra('y', '15:00', 10, 'Theirs'), extra('m', '10:00', 10, 'Mine')] } });
  const otherTabSaves = (a, mark) => {
    a.store.set(BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: tabAt, pushedAt: rowT0 }, tabRecord)));
    a.store.set(STORE_KEY, savedState(tabWeek, {}, Object.assign({ updatedAt: tabAt }, mark ? { breaksMark: tabAt } : {})));
    a.storage('storage', BREAKS_KEY, a.store.get(BREAKS_KEY));
  };
  const bootInStep = () => {
    server = makeServer({ row: rowWith(rowBreaks) });
    app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0, breaksMark: rowT0 }),
      [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: rowT0, pushedAt: rowT0 }, rowBreaks)) }) });
  };
  bootInStep();
  await settleAll();
  otherTabSaves(app, true);
  CLOCK.real = at('2026-09-28 08:11');
  await app.CT.sync.pull();
  await settleAll();
  posts = server.posts();
  same('breaks taken from another tab whose push has not gone: the next pull sends them with that tab\'s week, under its stamp',
    [app.CT.app.getBreaks().days.Monday.extras.map((e) => e.name), posts.length, posts[0] && posts[0].body.breaks.days.Monday.extras.map((e) => e.name),
      posts[0] && posts[0].body.updated_at, posts[0] && posts[0].body.schedule.Tuesday.end, app.CT.app.getState().schedule.Tuesday.end],
    [['Theirs', 'Mine'], 1, ['Theirs', 'Mine'], new RealDate(tabAt).toISOString(), hm('15:00'), hm('15:00')]);
  /* An older copy saved STORE_KEY since (no breaksMark), so the week saved
     with these breaks is no longer there to send them with. They are kept
     here, not sent: the tab that saved them sends them with its week, or
     this copy's next edit does. */
  bootInStep();
  await settleAll();
  otherTabSaves(app, false);
  CLOCK.real = at('2026-09-28 08:11');
  await app.CT.sync.pull();
  await settleAll();
  same('...but with that week gone from storage: kept, and nothing sent',
    [app.CT.app.getBreaks().days.Monday.extras.map((e) => e.name), server.posts().length, app.CT.app.getState().schedule.Tuesday.end],
    [['Theirs', 'Mine'], 0, hm('17:00')]);
  /* ...unless the save changed only breaks: the week they were saved with
     is then the row's own, which the breaks key's fingerprint of it says,
     so they go up with it under their stamp. A tab that saved a break and
     closed before its push, with a tab of an older version still open
     (which rewrites STORE_KEY on every pull), otherwise strands them until
     the next edit here, and another device's next save drops them. */
  const inStepRow = () => Object.assign(rowWith(rowBreaks), { settings: JSON.parse(savedState(schedule)).settings });
  const saverServer = makeServer({ row: inStepRow() });
  const saver = bootApp({ server: saverServer, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0, breaksMark: rowT0 }),
    [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: rowT0, pushedAt: rowT0 }, rowBreaks)) }) });
  await settleAll();
  saver.$('breaksDay').value = 'Monday';
  saver.$('breaksDay').dispatch('change');
  CLOCK.real = tabAt;
  saver.$('breaksAdd').click();
  const savedByTab = saver.store.get(BREAKS_KEY);
  server = makeServer({ row: inStepRow() });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0, breaksMark: rowT0 }),
    [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: rowT0, pushedAt: rowT0 }, rowBreaks)) }) });
  await settleAll();
  app.store.set(BREAKS_KEY, savedByTab);
  app.store.set(STORE_KEY, savedState(schedule, {}, { updatedAt: rowT0 }));   // an older copy's pull, no breaksMark
  app.storage('storage', BREAKS_KEY, savedByTab);
  CLOCK.real = at('2026-09-28 08:11');
  await app.CT.sync.pull();
  await settleAll();
  posts = server.posts();
  same('...unless that save changed only breaks: they go up with the row\'s week, which is the one they were saved with, under their stamp',
    [saverServer.posts().length, posts.length, posts[0] && posts[0].body.breaks.days.Monday.extras.length, posts[0] && posts[0].body.updated_at,
      posts[0] && posts[0].body.schedule.Tuesday.end],
    [0, 1, 2, new RealDate(tabAt).toISOString(), hm('17:00')]);

  /* Two pulls in flight at once, answered out of order. This copy has
     never held a break. Another device adds one, and a poll reads the row
     with it but is slow to answer; the other device removes it, and a
     second pull (coming back to the tab) reads and answers first. The
     late answer is older than a row already taken in, and is dropped: it
     used to give this copy the removed break, and send it back to every
     device. */
  const noBreaks = breaksFor({});
  const teaBreaks = breaksFor({ Monday: { lunchMinutes: null, extras: [extra('tea', '10:30', 15, 'Tea')] } });
  const rowAtTime = (brks, time) => Object.assign(rowWith(brks), { updated_at: new RealDate(at(time)).toISOString() });
  CLOCK.real = at('2026-09-28 08:00');
  server = makeServer({ row: rowAtTime(null, '2026-09-27 12:00') });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0 }) }) });
  await settleAll();
  server.row = rowAtTime(teaBreaks, '2026-09-28 08:01');
  server.holdGets = 1;
  CLOCK.real = at('2026-09-28 08:02');
  const slowPull = app.CT.sync.pull();
  await settleAll();
  server.row = rowAtTime(noBreaks, '2026-09-28 08:02:20');
  CLOCK.real = at('2026-09-28 08:02:30');
  await app.CT.sync.pull();
  await settleAll();
  server.held.shift().answer();
  await slowPull;
  await settleAll();
  same('an older answer landing after a newer one is dropped: the removed break stays removed, here and on the row',
    [app.CT.app.getBreaks().days.Monday.extras.length, server.posts().length, server.row.breaks.days.Monday.extras.length, app.CT.sync.getStatus().status],
    [0, 0, 0, 'synced']);

  /* A push that fails after a pull has taken in a newer row. The pull
     cleared what was waiting to go up; the failure must not put it back,
     or the next 'online' sends this copy, stamp and all, over whatever
     another device sends meanwhile. The reconnect pulls instead. */
  CLOCK.real = at('2026-09-28 08:04');
  server = makeServer({ row: rowAtTime(null, '2026-09-27 12:00') });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0 }) }) });
  await settleAll();
  CLOCK.real = at('2026-09-28 08:05');
  server.holdPosts = 1;
  app.$('calcTarget').value = '15:00';
  app.$('calcTarget').dispatch('input');
  app.runTimers(1500);
  await settleAll();
  const tuesday = JSON.parse(JSON.stringify(schedule));
  tuesday.Tuesday.end = hm('18:00');
  server.row = Object.assign(rowAtTime(null, '2026-09-28 08:06'), { schedule: tuesday });
  CLOCK.real = at('2026-09-28 08:07');
  await app.CT.sync.pull();
  await settleAll();
  server.held.shift().fail();
  await settleAll();
  const wednesday = JSON.parse(JSON.stringify(tuesday));
  wednesday.Wednesday.end = hm('18:30');
  server.row = Object.assign(rowAtTime(null, '2026-09-28 08:10'), { schedule: wednesday });
  CLOCK.real = at('2026-09-28 08:11');
  const postsBefore = server.posts().length;
  app.storage('online');
  await settleAll();
  same('a push failing after a pull took in a newer row: the next reconnect pulls, and sends nothing over the row',
    [server.posts().length - postsBefore, server.row.updated_at, app.CT.app.getState().schedule.Wednesday.end],
    [0, new RealDate(at('2026-09-28 08:10')).toISOString(), hm('18:30')]);
  /* ...nor does an edit's push still waiting out its debounce when a pull
     takes in a newer row: the row has won that edit, and the timer would
     only send the copy just taken in back up, blind. */
  CLOCK.real = at('2026-09-28 08:20');
  server = makeServer({ row: rowAtTime(null, '2026-09-27 12:00') });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0 }) }) });
  await settleAll();
  CLOCK.real = at('2026-09-28 08:21');
  app.$('calcTarget').value = '15:00';
  app.$('calcTarget').dispatch('input');
  server.row = Object.assign(rowAtTime(null, '2026-09-28 08:21:01'), { schedule: tuesday });
  await app.CT.sync.pull();
  await settleAll();
  const beforeTimer = server.posts().length;
  app.runTimers(1500);
  await settleAll();
  same('...nor an edit\'s push waiting out its debounce when a pull takes in a newer row',
    [server.posts().length - beforeTimer, app.CT.app.getState().schedule.Tuesday.end], [0, hm('18:00')]);

  /* An answer to an earlier pull that lands after a later one's is still
     taken when its row is newer: its request reached the database last. */
  CLOCK.real = at('2026-09-28 08:30');
  server = makeServer({ row: rowAtTime(null, '2026-09-27 12:00') });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0 }) }) });
  await settleAll();
  server.holdGets = 1;
  const lateRead = app.CT.sync.pull();
  await settleAll();
  CLOCK.real = at('2026-09-28 08:30:10');
  await app.CT.sync.pull();
  await settleAll();
  server.row = Object.assign(rowAtTime(null, '2026-09-28 08:30:20'), { schedule: tuesday });
  server.held.shift().answerNow();
  await lateRead;
  await settleAll();
  same('an earlier pull\'s answer landing last, with a newer row: taken',
    [app.CT.app.getState().schedule.Tuesday.end, server.posts().length], [hm('18:00'), 0]);

  /* A confirmed copy that saved breaks offline, while another device saved
     newer ones: its push after reconnecting pulls first, and the newer
     row wins, as it would for the week. Without that, the push went
     straight up and put the older breaks over the newer ones. */
  server = makeServer({ row: rowWith(rowBreaks) });
  app = bootApp({ server, storage: signedInStorage({ [STORE_KEY]: savedState(schedule, {}, { updatedAt: rowT0, breaksMark: rowT0 }),
    [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: rowT0, pushedAt: rowT0 }, rowBreaks)) }) });
  await settleAll();
  app.win.navigator.onLine = false;
  CLOCK.real = at('2026-09-28 08:20');
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  app.$('breaksAdd').click();
  app.runTimers(1500);
  await settleAll();
  const newer = breaksFor({ Monday: { lunchMinutes: null, extras: [extra('n', '11:00', 10, 'Newer')] } });
  server.row = Object.assign(rowWith(newer), { updated_at: new RealDate(at('2026-09-28 08:30')).toISOString() });
  CLOCK.real = at('2026-09-28 08:40');
  app.win.navigator.onLine = true;
  app.storage('online');
  await settleAll();
  same('offline break edit, then a newer row from another device: the reconnect pulls first, and the newer breaks stay',
    [server.calls.slice(-1)[0].method, server.row.breaks.days.Monday.extras.map((e) => e.name), app.CT.app.getBreaks().days.Monday.extras.map((e) => e.name)],
    ['GET', ['Newer'], ['Newer']]);

  // A row whose breaks are in a newer format than this app's: kept here as they are, and never sent over.
  const future = { v: 2, days: { Monday: { extras: [{ id: 'z', start: 630, repeat: 'weekly' }] } } };
  server = makeServer({ row: rowWith(future) });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  same('a row with breaks v2: this copy keeps its own', app.breaks().days.Monday.extras.map((e) => e.name), ['Local']);
  CLOCK.real = at('2026-09-28 08:50');
  app.$('breaksAdd').click();
  await app.CT.sync.push(true);
  posts = server.posts();
  check('...and its pushes leave breaks out, even after a break edit, so the v2 record stays',
    posts.length === 1 && !('breaks' in posts[0].body) && server.row.breaks.v === 2, JSON.stringify(posts.map((p) => Object.keys(p.body))));

  // A newer row with a breaks object: adopted exactly (R11).
  const remoteBreaks = breaksFor({ Monday: { lunchMinutes: 45, extras: [extra('r', '15:00', 10, 'Remote')] } });
  server = makeServer({ row: { user_id: USER.id, schedule, settings: {}, appointments: [], breaks: remoteBreaks,
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() } });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  same('pull: a breaks object is adopted', app.breaks().days.Monday, remoteBreaks.days.Monday);
  same('...and the breaks key carries the row\'s time', app.breaks().savedAt, at('2026-09-27 12:00'));
  check('no probe needed: the row said the column exists', server.probes().length === 0);

  // An edit queues the usual debounced push, which carries the breaks now the row has shown the column.
  CLOCK.real = at('2026-09-28 08:30');
  app.$('breaksAdd').click();
  check('a break edit queues a push (R6)', app.timers.some((t) => t.ms === 1500));
  await app.CT.sync.push(true);
  posts = server.posts();
  check('after a pull, pushes carry breaks', posts.length === 1 && posts[0].body.breaks.days.Monday.extras.length === 2);

  // A newer row with breaks null: the account has none, so this copy has none.
  server = makeServer({ row: { user_id: USER.id, schedule, settings: {}, appointments: [], breaks: null,
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() } });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  same('pull: breaks null empties them', app.breaks().days.Monday, { lunchMinutes: null, extras: [] });

  // A newer row without the key (no column on that server): local ones kept.
  server = makeServer({ columnExists: false, row: { user_id: USER.id, schedule, settings: { lunchLabel: 'Crib' }, appointments: [],
    updated_at: new RealDate(at('2026-09-27 12:00')).toISOString() } });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  same('pull: no breaks key keeps the local breaks', app.breaks().days.Monday.extras.map((e) => e.name), ['Local']);
  same('...while the rest of the row is adopted', app.saved().settings.lunchLabel, 'Crib');
  CLOCK.real = at('2026-09-28 09:00');
  app.$('breaksAdd').click();
  await app.CT.sync.push(true);
  check('...and pushes then leave breaks out', server.posts().length === 1 && !('breaks' in server.posts()[0].body));

  // First sign-in on this device: the account's breaks replace the device's.
  server = makeServer({ row: { user_id: USER.id, schedule, settings: {}, appointments: [], breaks: null,
    updated_at: new RealDate(at('2026-09-01 12:00')).toISOString() } });
  app = bootApp({ server, storage: signedInStorage({ [SYNCED_KEY]: '', [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  same('first sign-in: the account\'s (none) replace the device\'s', app.breaks().days.Monday.extras, []);

  // A pull that brings nothing new rebuilds nothing (R21).
  server = makeServer({ row: null });
  app = bootApp({ server, storage: signedInStorage({ [BREAKS_KEY]: localBreaks }) });
  await settleAll();
  app.$('copyFrom').value = 'Monday';
  app.$('copyTo').children.find((chip) => chip.dataset.day === 'Friday').click();
  app.$('copyApply').click();
  await app.CT.sync.push(true);
  const tableRow = app.$('scheduleBody').children[0];
  const writesBefore = app.writes.length;
  await app.CT.sync.pull(true);
  // sync.js re-records the account it is in step with after every pull; that is its own key.
  const appWrites = app.writes.slice(writesBefore).filter((k) => k === STORE_KEY || k === BREAKS_KEY);
  check('a pull of this copy\'s own row rebuilds nothing: table rows, Undo and the app\'s keys untouched',
    app.$('scheduleBody').children[0] === tableRow && !app.$('copyUndo').hidden && !appWrites.length,
    JSON.stringify({ same: app.$('scheduleBody').children[0] === tableRow, undo: !app.$('copyUndo').hidden, writes: appWrites }));
  check('...and it really was a pull of the same row', server.calls[server.calls.length - 1].method === 'GET' &&
    Date.parse(server.row.updated_at) === app.saved().updatedAt);

  // Delete account removes the breaks key (R18).
  app.$('deleteConfirmInput').value = 'DELETE';
  app.$('deleteConfirmInput').dispatch('input');
  app.$('deleteConfirm').click();
  await settleAll();
  check('delete account: breaks key gone, breaks empty', !app.store.has(BREAKS_KEY) &&
    !app.$('breaksList').descendants().some((n) => n.className === 'break-name-input'));

  /* A push held back offline, then sent by push() to pull first, where the
     row was newer and was taken: this copy is the row now, and nothing is
     left to send. A wifi blip later, with nothing edited here, must not
     send this copy, stamp and all, over another device's newer edit. The
     same held for a push that failed, then a pull that took the row. */
  const heldRow = (at_, tuesdayEnd, wednesdayEnd, names) => {
    const sc = JSON.parse(JSON.stringify(schedule));
    sc.Tuesday.end = tuesdayEnd;
    sc.Wednesday.end = wednesdayEnd;
    return { user_id: USER.id, schedule: sc, settings: {}, appointments: [],
      breaks: breaksFor({ Tuesday: { lunchMinutes: null, extras: names.map((n, i) => extra('y' + i, (14 + i) + ':00', 10, n)) } }),
      updated_at: new RealDate(at(at_)).toISOString() };
  };
  CLOCK.real = at('2026-09-28 08:00');
  server = makeServer({ row: heldRow('2026-09-27 12:00', hm('17:00'), hm('17:00'), []) });
  app = bootApp({ server, storage: signedInStorage() });
  await settleAll();
  CLOCK.real = at('2026-09-28 08:05');
  app.win.navigator.onLine = false;
  app.$('breaksDay').value = 'Monday';
  app.$('breaksDay').dispatch('change');
  app.$('breaksAdd').click();                  // held back: offline
  await settleAll();
  server.row = heldRow('2026-09-28 08:10', hm('16:10'), hm('17:00'), ['y1']);
  CLOCK.real = at('2026-09-28 08:15');
  app.win.navigator.onLine = true;
  app.storage('online');                       // pulls first, and takes the newer row
  await settleAll();
  const postsAfterReconnect = server.posts().length;
  server.row = heldRow('2026-09-28 08:20', hm('16:10'), hm('16:20'), ['y1', 'y2']);
  CLOCK.real = at('2026-09-28 08:21');
  app.win.navigator.onLine = false;
  app.storage('offline');
  app.win.navigator.onLine = true;
  app.storage('online');                       // a wifi blip, nothing edited here
  await settleAll();
  same('a held push that pulled and took the row: a later blip sends nothing, and the other device\'s edit stays',
    [postsAfterReconnect, server.posts().length, server.row.schedule.Wednesday.end, server.row.breaks.days.Tuesday.extras.map((e) => e.name),
      app.saved().schedule.Wednesday.end],
    [0, 0, hm('16:20'), ['y1', 'y2'], hm('16:20')]);

  /* A row whose breaks are in a newer format, met here for the first
     time: STORE_KEY is written again without its breaksMark, so after a
     reload these breaks load unconfirmed and are not sent over it before
     a pull has seen the row again. Both ways a pull meets it: a row older
     than this copy (pulledBreaks()), and one no different from it
     (replaceState()'s early return). */
  const confirmedAt = at('2026-09-28 07:00');
  const confirmedCopy = () => signedInStorage({
    [STORE_KEY]: savedState(schedule, {}, { updatedAt: confirmedAt, breaksMark: confirmedAt }),
    [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: confirmedAt, pushedAt: confirmedAt }, JSON.parse(localBreaks))) });
  CLOCK.real = at('2026-09-28 08:30');
  server = makeServer({ row: rowWith(future) });
  app = bootApp({ server, storage: confirmedCopy() });
  await settleAll();
  let reloaded = bootApp({ server: makeServer({ row: null }), storage: Object.fromEntries(app.store) });
  check('a v2 row older than this copy: breaksMark dropped, and after a reload the breaks are held back',
    !('breaksMark' in app.saved()) && reloaded.CT.app.breaksToPush() === null && server.row.breaks.v === 2,
    JSON.stringify({ mark: app.saved().breaksMark, held: reloaded.CT.app.breaksToPush() === null }));
  const sameRow = Object.assign({ user_id: USER.id, appointments: [], breaks: future, updated_at: new RealDate(confirmedAt).toISOString() },
    { schedule: JSON.parse(savedState(schedule)).schedule, settings: JSON.parse(savedState(schedule)).settings });
  server = makeServer({ row: sameRow });
  app = bootApp({ server, storage: confirmedCopy() });
  await settleAll();
  reloaded = bootApp({ server: makeServer({ row: null }), storage: Object.fromEntries(app.store) });
  check('...and a v2 row no different from this copy: the same',
    !('breaksMark' in app.saved()) && reloaded.CT.app.breaksToPush() === null && app.saved().updatedAt === confirmedAt,
    JSON.stringify({ mark: app.saved().breaksMark, held: reloaded.CT.app.breaksToPush() === null, at: app.saved().updatedAt }));
}

/* ─────────────────────────── 2d. Edits, alerts and focus ─────────────────────────── */

/* The alerts an edit must not set off, and those it must leave alone;
   the Lunch cell's blur; focus when a control goes; the day's labels. */
async function checkEditsAndFocus() {
  heading('Edits: alerts nobody chose, the Lunch cell, focus and labels (whole app)');
  const schedule = week('09:00', '12:30', '17:00');
  const T0 = at('2026-09-20 12:00');
  const bootWith = (sched, days, clock) => {
    CLOCK.real = at(clock);
    return bootApp({ storage: {
      [STORE_KEY]: savedState(sched, {}, { breaksMark: T0 }),
      [BREAKS_KEY]: JSON.stringify(Object.assign({ savedAt: T0, pushedAt: T0 }, breaksFor(days))) } });
  };
  const showDay = (app, day) => { app.$('breaksDay').value = day; app.$('breaksDay').dispatch('change'); };
  const rowOf = (app, id) => app.$('breaksList').children.find((li) => li.dataset.breakId === id);
  const said = (app, from) => app.shown.slice(from).map((n) => n.title + ': ' + n.body + ' ' + n.tag);
  const lunchCell = (app) => app.$('scheduleBody').children[0].children[3].children[0];
  const otherTab = (a, extras, savedAt, lunchMinutes) => a.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at(savedAt) },
    breaksFor({ Monday: { lunchMinutes: lunchMinutes === undefined ? null : lunchMinutes, extras } }))));

  /* Another tab typing a break's time saves every time passed through,
     and this tab takes each in. None of them may be announced here; the
     time it ends up at still is. */
  let app = bootWith(schedule, { Monday: { lunchMinutes: null, extras: [extra('tea', '13:00', 15, 'Tea')] } }, '2026-09-28 12:58:05');
  let from = app.shown.length;
  otherTab(app, [extra('tea', '13:03', 15, 'Tea')], '2026-09-28 12:58:05');
  otherTab(app, [extra('tea', '13:30', 15, 'Tea')], '2026-09-28 12:58:06');
  app.at(at('2026-09-28 12:58:06'));
  same('another tab types a break\'s time: the times passed through announce nothing here', said(app, from), []);
  app.at(at('2026-09-28 13:25'));
  same('...and the time it ends up at gets its heads-up', said(app, from), ['Tea: Starts in 5 minutes. 2026-09-28|brk810-825|5']);

  /* The arrow keys on a closed Length list: every length on the way is a
     change. One whose finish has just passed must not say "Break over"
     while the break is still on; the length it ends up at still does. */
  app = bootWith(schedule, { Monday: { lunchMinutes: null, extras: [extra('tea', '13:00', null, 'Tea')] } }, '2026-09-28 13:10:30');
  showDay(app, 'Monday');
  from = app.shown.length;
  let length = rowOf(app, 'tea').querySelector('select');
  length.focus();
  ['5', '10', '15', '20', '30'].forEach((v) => { length.value = v; length.dispatch('change'); });
  app.at(at('2026-09-28 13:10:31'));
  same('arrow keys through a break\'s lengths: nothing is announced for the lengths passed through', said(app, from), []);
  app.at(at('2026-09-28 13:30'));
  same('...and the length it ends up at still gets its "Break over"', said(app, from), ['Tea: Break over. Ease back in. 2026-09-28|brk780-810|finish']);
  app = bootWith(schedule, {}, '2026-09-28 12:40:30');
  showDay(app, 'Monday');
  from = app.shown.length;
  length = rowOf(app, 'lunch').querySelector('select');
  length.focus();
  ['5', '10', '15', '20'].forEach((v) => { length.value = v; length.dispatch('change'); });
  app.at(at('2026-09-28 12:40:31'));
  same('...lunch\'s row too', said(app, from), []);
  app.at(at('2026-09-28 12:50'));
  same('...whose finish then comes at the length chosen', said(app, from), ['Lunch: Break over. Ease back in. 2026-09-28|lunch|finish']);

  /* Hushing is for the break edited. Another break's alert, due at the
     moment of the edit and not yet announced (the tick had not run),
     is announced as it would have been. */
  app = bootWith(schedule, { Monday: { lunchMinutes: null, extras: [extra('walk', '12:50', 15, 'Walk'),
    extra('kettle', '13:05', 10, 'Kettle'), extra('tea', '15:00', 15, 'Tea')] } }, '2026-09-28 13:04:59');
  showDay(app, 'Monday');
  from = app.shown.length;
  CLOCK.real = at('2026-09-28 13:05') + 150;
  const teaTime = rowOf(app, 'tea').querySelector('input[type="time"]');
  teaTime.focus();
  teaTime.value = '15:30';
  teaTime.dispatch('change');
  app.at(at('2026-09-28 13:05:01'));
  same('an edit to Tea just as Walk ends and Kettle starts: theirs are still announced',
    said(app, from), ['Walk: Break over. Ease back in. 2026-09-28|brk770-785|finish', 'Kettle: Break time. Back at 1:15 PM. 2026-09-28|brk785-795|start']);

  /* The table's Lunch cell passes through times as the Breaks box does
     ("1 5" into 12:00's minutes is 12:01, then 12:15), and a lunch with a
     length has a finish for each. */
  app = bootWith(week('09:00', '12:00', '17:00'), { Monday: { lunchMinutes: 60, extras: [] } }, '2026-09-28 13:02:10');
  from = app.shown.length;
  let cell = lunchCell(app);
  cell.focus();
  cell.dispatch('focus');
  ['12:01', '12:15'].forEach((v) => { cell.value = v; cell.dispatch('change'); });
  app.at(at('2026-09-28 13:02:11'));
  same('a lunch with a length typed into the table: the finishes passed through announce nothing', said(app, from), []);
  app.at(at('2026-09-28 13:15'));
  same('...and the lunch it ends up at still ends with "Break over", under the plain tag', said(app, from), ['Lunch: Break over. Ease back in. 2026-09-28|lunch|finish']);

  // Add a break's time is a suggestion, there to be typed over.
  app = bootWith(schedule, {}, '2026-09-28 14:40:30');
  showDay(app, 'Monday');
  from = app.shown.length;
  app.$('breaksAdd').click();
  app.at(at('2026-09-28 14:40:31'));
  same('Add a break 5 minutes before its suggested time: no heads-up for it', said(app, from), []);
  app.at(at('2026-09-28 14:45'));
  same('...left there, it still gets its start', said(app, from), ['Break: Break time. Back at 3:00 PM. 2026-09-28|brk885-900|start']);

  /* A new length gives a break a new key. Its heads-up and its start are
     the same moments, and are not sent again; its finish is at the new
     time, and is. */
  app = bootWith(schedule, { Tuesday: { lunchMinutes: null, extras: [extra('tea', '10:30', 15, 'Tea')] } }, '2026-09-29 10:24:50');
  showDay(app, 'Tuesday');
  from = app.shown.length;
  app.at(at('2026-09-29 10:25'));
  length = rowOf(app, 'tea').querySelector('select');
  CLOCK.real = at('2026-09-29 10:25:30');
  length.value = '30';
  length.dispatch('change');
  app.at(at('2026-09-29 10:30'));
  CLOCK.real = at('2026-09-29 10:31');
  length.value = '20';
  length.dispatch('change');
  app.at(at('2026-09-29 10:31:01'));
  app.at(at('2026-09-29 10:50'));
  same('a new length in the heads-up minute, then on the break: one heads-up, one "Break time", "Break over" at the new time',
    said(app, from), ['Tea: Starts in 5 minutes. 2026-09-29|brk630-645|5', 'Tea: Break time. Back at 11:00 AM. 2026-09-29|brk630-660|start',
      'Tea: Break over. Ease back in. 2026-09-29|brk630-650|finish']);

  /* The Lunch cell's blur acts only when this focus took the lunch away.
     Tabbing through a cell already empty, with a length left behind in
     the record, writes, stamps and sends nothing. */
  const noLunch = week('09:00', null, '17:00');
  app = bootWith(noLunch, { Monday: { lunchMinutes: 30, extras: [] } }, '2026-09-28 08:00');
  let writes = app.writes.length;
  cell = lunchCell(app);
  CLOCK.real = at('2026-09-28 08:01');
  cell.focus();
  cell.dispatch('focus');
  cell.blur();
  cell.dispatch('blur');
  same('tabbing through an empty Lunch cell: nothing written or stamped',
    [app.writes.length - writes, app.saved().updatedAt, app.CT.app.getBreaks().days.Monday.lunchMinutes], [0, T0, 30]);
  // A cell the table's rebuild threw away, blurred on the way out, as Chrome does.
  app = bootWith(schedule, { Monday: { lunchMinutes: 30, extras: [] } }, '2026-09-28 08:00');
  cell = lunchCell(app);
  cell.focus();
  cell.dispatch('focus');
  const rowAt = at('2026-09-28 07:30');
  const pulled = JSON.parse(JSON.stringify(schedule));
  pulled.Monday.lunch = null;
  app.CT.app.replaceState({ schedule: pulled, settings: app.saved().settings, appointments: [], updatedAt: rowAt,
    breaks: breaksFor({ Monday: { lunchMinutes: 30, extras: [] } }) }, { fromSync: true, rowAt });
  writes = app.writes.length;
  cell.dispatch('blur');
  same('...nor a Lunch cell a pull\'s rebuild has thrown away', [app.writes.length - writes, app.saved().updatedAt], [0, rowAt]);

  /* A glance at another tab mid-edit: the cell never lost focus in the
     page. The length waits, and is kept when a time is typed back. */
  app = bootWith(schedule, { Monday: { lunchMinutes: 45, extras: [] } }, '2026-09-28 08:00');
  cell = lunchCell(app);
  const lunchNow = () => [app.saved().schedule.Monday.lunch, app.CT.app.getBreaks().days.Monday.lunchMinutes];
  cell.focus();
  cell.dispatch('focus');
  cell.value = '';
  cell.dispatch('change');
  app.dom.windowFocused(false);
  cell.dispatch('blur');
  const whileAway = lunchNow();
  app.dom.windowFocused(true);
  cell.dispatch('focus');
  cell.value = '12:45';
  cell.dispatch('change');
  cell.blur();
  cell.dispatch('blur');
  same('Lunch cell emptied, another tab glanced at, a time typed back: the length is kept', [whileAway, lunchNow()], [[null, 45], [hm('12:45'), 45]]);
  /* The blur that takes a lunch's length rebuilds no rows: a click on one
     of them is landing as it runs, and a row rebuilt under it would
     swallow the click. */
  app = bootWith(schedule, { Monday: { lunchMinutes: 30, extras: [extra('tea', '10:00', 15, 'Tea')] } }, '2026-09-28 08:00');
  showDay(app, 'Monday');
  cell = lunchCell(app);
  cell.focus();
  cell.dispatch('focus');
  cell.value = '';
  cell.dispatch('change');
  const rowsThen = app.$('breaksList').children.slice();
  cell.blur();
  cell.dispatch('blur');
  check('the Lunch cell left empty takes the length, and no row is rebuilt under a click',
    app.CT.app.getBreaks().days.Monday.lunchMinutes === null && rowsThen.length === 1 &&
    app.$('breaksList').children.every((li, i) => li === rowsThen[i]), JSON.stringify(lunchNow()));

  /* Focus on Undo, or on Add a break, when another tab's save hides Undo
     or turns Add off: it moves within the box, never to the page. */
  app = bootWith(schedule, { Monday: { lunchMinutes: 30, extras: [extra('tea', '10:00', 15, 'Tea')] } }, '2026-09-28 08:00');
  showDay(app, 'Monday');
  rowOf(app, 'tea').querySelector('button').click();
  const onUndo = app.dom.doc.activeElement === app.$('breaksUndo');
  otherTab(app, [extra('w', '15:00', 10, 'Walk')], '2026-09-28 08:01', 30);
  check('Undo focused when another tab\'s save hides it: focus moves to Add a break',
    onUndo && app.$('breaksUndo').hidden && app.dom.doc.activeElement === app.$('breaksAdd'), app.dom.doc.activeElement.id);
  const four = [0, 1, 2, 3].map((i) => extra('e' + i, (10 + i) + ':00', 10, 'E' + i));
  app = bootWith(schedule, { Monday: { lunchMinutes: null, extras: four } }, '2026-09-28 08:00');
  showDay(app, 'Monday');
  app.$('breaksAdd').focus();
  otherTab(app, four.concat([extra('e9', '16:00', 10, 'E9')]), '2026-09-28 08:01');
  check('Add a break focused when another tab adds the sixth: focus moves to the day list',
    app.$('breaksAdd').disabled && app.dom.doc.activeElement === app.$('breaksDay'), app.dom.doc.activeElement.id);

  /* "Set breaks" opens the day of the shift on the pies: after midnight
     on a night shift, the day before, not a day off. */
  const nights = week('22:00', null, '06:00');
  nights.Tuesday.working = false;
  app = bootWith(nights, {}, '2026-09-29 01:00');
  app.$('breaksSet').click();
  same('Set breaks at 1 AM on a night shift: Monday\'s breaks, focus on Add a break',
    [app.$('breaksDay').value, app.dom.doc.activeElement === app.$('breaksAdd')], ['Monday', true]);

  // The orange notes and "Back at" are the time's and the length's description.
  app = bootWith(schedule, { Monday: { lunchMinutes: null, extras: [extra('tea', '12:20', 15, 'Tea'), extra('pm', '15:00', null, 'PM')] } }, '2026-09-28 08:00');
  showDay(app, 'Monday');
  const tea = rowOf(app, 'tea');
  const both = tea.querySelector('.break-back').id + ' ' + tea.querySelector('.break-notes').id;
  same('a row\'s notes and "Back at" describe its time and length; a row with neither has no description',
    [[tea.querySelector('input[type="time"]'), tea.querySelector('select')].map((c) => c.getAttribute('aria-describedby')),
      tea.querySelector('.break-notes').textContent, rowOf(app, 'pm').querySelector('input[type="time"]').getAttribute('aria-describedby')],
    [[both, both], 'Runs into the 12:30 PM break.', null]);
  check('...with ids of their own', /^breakBack\d+$/.test(tea.querySelector('.break-back').id) &&
    /^breakNotes\d+$/.test(tea.querySelector('.break-notes').id), both);

  /* The headings carry the day's own "Head Home". Nothing rewrote them at
     midnight: a pull that brought nothing new left them, and signed out
     there was no pull at all. */
  const homeMonday = week('09:00', '12:30', '17:00');
  homeMonday.Monday.lunchHeadHome = true;
  homeMonday.Monday.endHeadHome = true;
  app = bootWith(homeMonday, {}, '2026-09-28 23:50');
  const key = app.$('stripLunchKey');
  const endKey = app.$('probeEndLabel');
  key.setAttribute('data-lunch-label', '');
  endKey.setAttribute('data-end-label', '');
  key.textContent = 'Lunch | Head Home';
  endKey.textContent = 'End of Day | Head Home';
  app.at(at('2026-09-28 23:55'));
  app.at(at('2026-09-29 00:01'));
  same('past midnight, signed out: the headings drop Monday\'s "Head Home"', [key.textContent, endKey.textContent], ['Lunch', 'End of Day']);

  /* The night shift still on the pies past midnight keeps its own day's
     "Head Home" on the cards, as its alerts do; the strip lists today's
     hours, and takes today's. When the shift leaves the pies, the cards
     take today's too. */
  const nightWeek = week('22:00', '02:00', '06:00');
  nightWeek.Tuesday.lunchHeadHome = true;
  nightWeek.Tuesday.endHeadHome = true;
  app = bootWith(nightWeek, {}, '2026-09-28 23:59:40');
  const onCard = (cardId, el) => { app.$(cardId).classList.add('timer-card'); app.$(cardId).appendChild(el); return el; };
  const cardLunch = onCard('cardLunch', app.$('lunchHeading'));
  const cardEnd = onCard('cardEnd', app.dom.doc.createElement('h2'));
  const stripLunch = app.$('stripLunchKey');
  [cardLunch, stripLunch].forEach((el) => el.setAttribute('data-lunch-label', ''));
  cardEnd.setAttribute('data-end-label', '');
  app.at(at('2026-09-28 23:59:50'));
  app.at(at('2026-09-29 00:00:05'));
  const nightLabels = () => [cardLunch.textContent, cardEnd.textContent, stripLunch.textContent];
  same('past midnight on Monday\'s night shift: the cards keep Monday\'s labels, the strip takes Tuesday\'s', nightLabels(),
    ['Lunch', 'End of Day', 'Lunch | Head Home']);
  app.at(at('2026-09-29 10:00:05'));
  same('...and once the shift leaves the pies, the cards take Tuesday\'s', nightLabels(),
    ['Lunch | Head Home', 'End of Day | Head Home', 'Lunch | Head Home']);
  // The break card hands the heading back mid-shift (another tab removes the extra it showed).
  app = bootWith(nightWeek, { Monday: { lunchMinutes: null, extras: [extra('tea', '01:00', 15, 'Tea')] } }, '2026-09-28 23:59:40');
  const handedBack = onCard('cardLunch', app.$('lunchHeading'));
  handedBack.setAttribute('data-lunch-label', '');
  app.at(at('2026-09-28 23:59:50'));
  app.at(at('2026-09-29 00:00:05'));
  CLOCK.real = at('2026-09-29 00:00:10');
  app.storage('storage', BREAKS_KEY, JSON.stringify(Object.assign({ savedAt: at('2026-09-29 00:00:10') }, breaksFor({}))));
  app.at(at('2026-09-29 01:00'));
  same('...as does the break card handing its heading back mid-shift, and the screen-reader line',
    [handedBack.textContent, /^Lunch: /.test(app.$('srClock').textContent)], ['Lunch', true]);

  /* Copy a day, an import or a pull puts a day's breaks in whole. A break
     on the pies that starts where it did, with a new length, has a new
     key: its heads-up and its start are the moments already announced,
     and are not said again. Its finish is at the new time, and is. */
  const teaFor = (minutes) => ({ lunchMinutes: null, extras: [extra('tea', '10:30', minutes, 'Tea')] });
  const copyOnto = (a, source, target) => {
    a.$('copyFrom').value = source;
    a.$('copyTo').children.find((chip) => chip.dataset.day === target).click();
    a.$('copyApply').click();
  };
  const importOnto = (a, brks) => {
    a.$('importFile').files = [{ content: JSON.stringify({ schedule, settings: a.saved().settings, breaks: brks }) }];
    a.$('importFile').dispatch('change');
  };
  const pullOnto = (a, brks) => {
    const rowAt = CLOCK.real - 1000;
    a.CT.app.replaceState({ schedule, settings: a.saved().settings, appointments: [], updatedAt: rowAt, breaks: brks }, { fromSync: true, rowAt });
  };
  const onTheBreak = ['Tea: Starts in 5 minutes. 2026-09-29|brk630-645|5', 'Tea: Break time. Back at 10:45 AM. 2026-09-29|brk630-645|start',
    'Tea: Break over. Ease back in. 2026-09-29|brk630-660|finish'];
  const inTheHeadsUp = ['Tea: Starts in 5 minutes. 2026-09-29|brk630-645|5', 'Tea: Break time. Back at 11:00 AM. 2026-09-29|brk630-660|start',
    'Tea: Break over. Ease back in. 2026-09-29|brk630-660|finish'];
  const replacements = [
    ['Copy a day', (a) => copyOnto(a, 'Wednesday', 'Tuesday')],
    ['an import', (a) => importOnto(a, breaksFor({ Tuesday: teaFor(30), Wednesday: teaFor(30) }))],
    ['a pull', (a) => pullOnto(a, breaksFor({ Tuesday: teaFor(30), Wednesday: teaFor(30) }))],
  ];
  for (const [what, replace] of replacements) {
    for (const [when, expected] of [['10:30:20', onTheBreak], ['10:25:20', inTheHeadsUp]]) {
      app = bootWith(schedule, { Tuesday: teaFor(15), Wednesday: teaFor(30) }, '2026-09-29 10:24:50');
      from = app.shown.length;
      app.at(at('2026-09-29 10:25'));
      if (when === '10:30:20') app.at(at('2026-09-29 10:30'));
      CLOCK.real = at('2026-09-29 ' + when);
      replace(app);
      app.at(at('2026-09-29 ' + when) + 20000);
      app.at(at('2026-09-29 10:30'));
      app.at(at('2026-09-29 11:00'));
      same(what + ' gives the break ' + (when === '10:30:20' ? 'on now' : 'due in 5 minutes') + ' a new length: one heads-up, one "Break time", "Break over" at the new time',
        said(app, from), expected);
    }
  }

  /* Only the same break carries: same start and same id, or same name,
     since Copy a day and an import make new ids. A different break put in
     at that time is news, and its "Break time" is still said. */
  app = bootWith(schedule, { Tuesday: teaFor(15) }, '2026-09-29 10:29:50');
  from = app.shown.length;
  app.at(at('2026-09-29 10:30'));
  CLOCK.real = at('2026-09-29 10:30:20');
  pullOnto(app, breaksFor({ Tuesday: { lunchMinutes: null, extras: [extra('walk', '10:30', 30, 'Walk')] } }));
  app.at(at('2026-09-29 10:30:40'));
  same('a pull puts a different break in at the same time: its "Break time" is still said', said(app, from),
    ['Tea: Break time. Back at 10:45 AM. 2026-09-29|brk630-645|start', 'Walk: Break time. Back at 11:00 AM. 2026-09-29|brk630-660|start']);

  /* Signed in, a pull of this copy's own row, after an edit whose push has
     gone: "Last updated" says when, as every pull always has. */
  CLOCK.real = at('2026-09-28 09:00');
  const server = makeServer({ row: null });
  app = bootApp({ server, storage: { [STORE_KEY]: savedState(schedule), [SYNCED_KEY]: USER.id } });
  await settleAll();
  CLOCK.real = at('2026-09-28 09:05');
  app.$('calcTarget').value = '15:00';
  app.$('calcTarget').dispatch('input');
  app.runTimers(1500);
  await settleAll();
  CLOCK.real = at('2026-09-28 09:06');
  await app.CT.sync.pull();
  await settleAll();
  same('a pull that brings nothing new still brings "Last updated" up to date',
    [app.$('lastUpdated').textContent, server.posts().length], [new FakeDate(at('2026-09-28 09:05')).toLocaleString('en-AU'), 2]);
}

/* ─────────────────────────── Main ─────────────────────────── */

(async function main() {
  const started = RealDate.now();
  const load = loadSliced(null);
  const loadBaseline = loadSlicedBaseline(BASELINE);
  const sections = [
    ['normalise', () => checkNormalise(load(makeState(week('09:00', '12:30', '17:00')), breaksFor({})))],
    ['phases', () => checkPhases(load)],
    ['alerts', () => checkAlertTable(load, loadBaseline)],
    ['box', () => checkBoxHelpers(load)],
    ['compare', () => checkBeforeAfter()],
    ['dashboard', () => checkDashboard()],
    ['storage', () => checkStorageAndSync()],
    ['edits', () => checkEditsAndFocus()],
  ];
  for (const [name, run] of sections) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const t = RealDate.now();
    await run();
    if (VERBOSE) note(`(${name}: ${((RealDate.now() - t) / 1000).toFixed(1)} s)`);
  }
  console.log(`\n${failed ? failed + ' FAILED, ' : ''}${passed} passed, ${((RealDate.now() - started) / 1000).toFixed(0)} s`);
  if (failed) process.exitCode = 1;
}()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
