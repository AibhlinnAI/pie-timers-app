#!/usr/bin/env node
/* ============================================================
   Widget simulation: what the page hands the Android home screen
   widget, checked against the Dashboard's own functions.

   The widget holds no timer maths. app/app.js works out the next seven
   days (widgetSnapshot) and the Android app only draws "how far between
   two instants are we" (android/.../PieWidget.java). So everything that
   can go wrong is in the snapshot, and this file checks it the way
   tools/breaks-sim.js checks breaks: the REAL functions are cut out of
   app.js and run with a fake clock.

   For each schedule below, at an instant in every quarter hour of the
   seven days (never on the minute, which is where the snapshot was
   sampled), the pie the widget would draw must be the pie the Dashboard
   functions give at that instant: the same label, the same time left to
   the second, the same fraction of the pie, and no pie where there is
   none.

   Run:  node tools/widget-sim.js
   Exit code 1 if anything fails.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.TZ = 'Australia/Adelaide';   // set at runtime: Windows can ignore it at startup

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8').split('\r\n').join('\n');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failed++;
  if (failed <= 25) console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  return false;
}

/* Index just past the bracket that closes the one at `open`, skipping
   strings and comments (as in tools/breaks-sim.js). */
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
function fn(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('app.js has no function ' + name);
  return SRC.slice(at, matchClose(SRC, SRC.indexOf('{', SRC.indexOf(')', at))));
}
function constant(name) {
  const m = SRC.match(new RegExp('\\n  var ' + name + ' = ([^;]+);'));
  if (!m) throw new Error('app.js has no var ' + name);
  return 'var ' + name + ' = ' + m[1] + ';';
}

const FUNCTIONS = [
  'pad', 'isoDate', 'isMinute', 'emptyBreakDay', 'dayNameOf', 'secondsSinceMidnight',
  'dayConfig', 'hasAgenda', 'lunchLabel', 'endLabel',
  'computeTimer', 'currentShift', 'worksOn', 'shiftLengthSec', 'workPies',
  'breakKey', 'relMinute', 'dayBreaks', 'breakReachable', 'breakPhase', 'breakTitle',
  'appointmentDate', 'nextAppointment', 'computeAppointmentTimer',
  'widgetInstant', 'widgetLabel', 'widgetWorkPies', 'widgetAppointments', 'widgetSnapshot'
];
const CONSTANTS = ['DAYS', 'NIGHT_SHIFT_HOLD_SEC', 'WIDGET_DAYS', 'WIDGET_LABEL_MAX'];

/* One world: the sliced code, a state, and a clock that widgetSnapshot's
   own `new Date()` reads. Every other Date call names its instant. */
function world(state, breaks, startMs) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(startMs); }
    static now() { return startMs; }
  }
  const sandbox = { Date: FakeDate, state, breaks, AGENDA: { id: 'none', date: '1999-01-01' } };
  vm.createContext(sandbox);
  vm.runInContext(CONSTANTS.map(constant).join('\n') + '\n' + FUNCTIONS.map(fn).join('\n') + `
    this.api = { widgetSnapshot, workPies, dayBreaks, breakPhase, breakTitle, lunchLabel,
                 endLabel, nextAppointment, computeAppointmentTimer };`, sandbox);
  return { api: sandbox.api, D: FakeDate };
}

function day(start, lunch, end, extra) {
  return Object.assign({ working: true, start, lunch, end, lunchHeadHome: false, endHeadHome: false }, extra || {});
}
const OFF = { working: false, start: 540, lunch: 750, end: 1020 };
function week(d, weekend) {
  const out = {};
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].forEach(n => { out[n] = d; });
  out.Saturday = weekend || OFF;
  out.Sunday = weekend || OFF;
  return out;
}
function noBreaks() {
  const days = {};
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .forEach(n => { days[n] = { lunchMinutes: null, extras: [] }; });
  return { v: 1, days };
}
function withBreaks(lunchMinutes, extras) {
  const b = noBreaks();
  Object.keys(b.days).forEach(n => { b.days[n] = { lunchMinutes, extras }; });
  return b;
}
function settings(extra) {
  return Object.assign({ lunchLabel: 'Lunch', urgentMinutes: 15 }, extra || {});
}

const START = new Date(2026, 10, 26, 10, 7, 23).getTime();   // Thursday 26 Nov 2026, 10:07:23
const HOUR = 3600000;

const CASES = [
  { name: 'office week, one lunch',
    state: { schedule: week(day(540, 750, 1020)), settings: settings(), appointments: [], calendarEvents: [] },
    breaks: noBreaks() },
  { name: 'Head Home, renamed lunch, no end',
    state: { schedule: week(day(480, 720, null, { lunchHeadHome: true })), settings: settings({ lunchLabel: 'Dinner' }),
             appointments: [], calendarEvents: [] },
    breaks: noBreaks() },
  { name: 'several breaks with lengths',
    state: { schedule: week(day(540, 750, 1020)), settings: settings(), appointments: [], calendarEvents: [] },
    breaks: withBreaks(30, [
      { id: 'a', start: 630, minutes: 15, name: 'Morning tea', headHome: false },
      { id: 'b', start: 900, minutes: null, name: 'School run', headHome: true }
    ]) },
  { name: 'night shift, seven days',
    state: { schedule: week(day(1320, 120, 360), day(1320, 120, 360)), settings: settings(), appointments: [], calendarEvents: [] },
    breaks: withBreaks(null, [{ id: 'n', start: 240, minutes: 20, name: 'Smoko', headHome: false }]) },
  { name: 'appointments near and far, manual and synced',
    state: { schedule: week(day(540, 750, 1020)), settings: settings(),
             appointments: [
               { id: 'm1', title: 'Dentist', date: '2026-11-26', time: 660 },
               { id: 'm2', title: '', date: '2026-11-29', time: 600 },
               { id: 'm3', title: 'A very long appointment title that will not fit on a widget at all', date: '2026-12-20', time: 600 }
             ],
             calendarEvents: [
               { uid: 'c1', title: 'Stand-up', at: START + 20 * 60000, allDay: false },
               { uid: 'c2', title: 'All day', at: START + HOUR, allDay: true },
               { uid: 'c3', title: 'Review', at: START + 30 * HOUR + 17000, allDay: false }
             ] },
    breaks: noBreaks() },
  { name: 'nothing at all',
    state: { schedule: week(OFF, OFF), settings: settings({ urgentMinutes: 0 }), appointments: [], calendarEvents: [] },
    breaks: noBreaks() }
];

/* What PieWidget.java does with a slot at an instant: the piece showing,
   then how much of its pie is left. Kept this small on purpose. */
function widgetAt(snapshot, slot, t) {
  const seg = snapshot.slots[slot].find(s => s.a <= t && t < s.b);
  if (!seg) return null;
  const left = Math.max(seg.e - t, 0);
  return { label: seg.l, leftMs: left, fraction: Math.min(left / (seg.e - seg.s), 1), quiet: seg.q };
}

/* What the Dashboard functions say at the same instant. */
function dashboardAt(api, D, t) {
  const now = new D(t);
  const out = [null, null, null];
  const pies = api.workPies(now);
  function from(timer, label, quiet) {
    if (!timer || !timer.available) return null;
    /* Before the pie starts the Dashboard holds it full; the time left
       to its end is the time to its start plus its length. */
    return { label, timer, quiet: quiet ? 1 : 0 };
  }
  if (pies.working) {
    const phase = api.breakPhase(pies, api.dayBreaks(pies.shift.cfg, pies.shift.day));
    if (phase.mode === 'classic') out[0] = from(pies.lunch, api.lunchLabel(pies.shift.day));
    else if (phase.mode === 'before' || phase.mode === 'reached') out[0] = from(phase.timer, api.breakTitle(phase.brk, pies.shift.day));
    else if (phase.mode === 'during') out[0] = from(phase.timer, phase.brk.name, true);
    out[1] = from(pies.end, api.endLabel(pies.shift.day));
  }
  const appointment = api.nextAppointment(now);
  const appt = api.computeAppointmentTimer(now, appointment);
  if (appt.available) {
    out[2] = { label: appointment.title || 'Next appointment', quiet: 0,
               timer: { remainingSec: appt.remainingSec, progress: appt.progress, notStarted: false } };
  }
  return out;
}

function clip(text) { return text.length <= 40 ? text : text.slice(0, 39) + '…'; }

CASES.forEach(c => {
  console.log('\n=== ' + c.name + ' ===');
  const before = failed;
  const { api, D } = world(c.state, c.breaks, START);
  const t0 = Date.now();
  const snap = api.widgetSnapshot();
  const took = Date.now() - t0;
  const bytes = JSON.stringify(snap).length;

  check('covers seven days from the minute', snap.until === Math.floor(START / 60000) * 60000 + 7 * 24 * HOUR,
        'until ' + snap.until);
  check('three slots', Array.isArray(snap.slots) && snap.slots.length === 3);
  check('small enough to hand over', bytes < 100000, bytes + ' characters');
  snap.slots.forEach((segs, k) => {
    let last = -Infinity;
    segs.forEach(s => {
      check('slot ' + k + ' pieces in order, none empty or overlapping', s.a >= last && s.b > s.a && s.e > s.s,
            JSON.stringify(s));
      last = s.b;
    });
  });

  let compared = 0;
  for (let q = 0; q < 7 * 96; q++) {
    // 15 minutes apart, plus a drift so every second of the minute is met.
    const t = Math.floor(START / 60000) * 60000 + q * 900000 + ((q * 37) % 900) * 1000 + 500;
    if (t >= snap.until) break;
    const want = dashboardAt(api, D, t);
    for (let k = 0; k < 3; k++) {
      const got = widgetAt(snap, k, t);
      const w = want[k];
      const when = new Date(t).toString().slice(0, 24) + ' slot ' + k;
      if (!w) { check('no pie where the Dashboard has none: ' + when, got === null, JSON.stringify(got)); continue; }
      if (!check('a pie where the Dashboard has one: ' + when, got !== null, 'want ' + w.label)) continue;
      compared++;
      check('label: ' + when, got.label === clip(w.label), got.label + ' / ' + w.label);
      check('urgent rule: ' + when, got.quiet === w.quiet);
      if (w.timer.notStarted) {
        check('held full before it starts: ' + when, got.fraction === 1, String(got.fraction));
      } else {
        // Within the second: the Dashboard counts whole seconds.
        check('time left: ' + when, Math.abs(got.leftMs / 1000 - w.timer.remainingSec) <= 1.01,
              got.leftMs / 1000 + ' / ' + w.timer.remainingSec);
        check('pie fraction: ' + when, Math.abs(got.fraction - (1 - w.timer.progress)) < 0.002,
              got.fraction + ' / ' + (1 - w.timer.progress));
      }
    }
  }
  console.log('  ' + (failed === before ? 'ok' : 'FAILED') + ': ' + compared + ' pies compared, ' +
              snap.slots.map(s => s.length).join('/') + ' pieces, ' + bytes + ' characters, ' + took + ' ms');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
