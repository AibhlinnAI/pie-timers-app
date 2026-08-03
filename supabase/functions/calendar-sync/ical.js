/* ============================================================
   Minimal iCalendar (RFC 5545) reader.

   Scope is deliberately narrow: expand the occurrences falling
   inside a short window, well enough for real Google / Outlook /
   iCloud feeds. It is not a general iCalendar library.

   Supported: VEVENT, DTSTART/DTEND/DURATION, all-day events,
   TZID via the IANA database, RRULE (FREQ, INTERVAL, COUNT,
   UNTIL, BYDAY incl. ordinals, BYMONTHDAY, BYMONTH), EXDATE,
   RECURRENCE-ID overrides, STATUS:CANCELLED.

   Not supported: BYSETPOS, BYYEARDAY, BYWEEKNO, BYHOUR/BYMINUTE,
   WKST-sensitive weekly maths, VTIMEZONE blocks for zones outside
   the IANA database, VALARM, per-attendee status.

   Written as .js rather than .ts on purpose: it lets the exact
   shipping file be unit-tested in a plain JS engine instead of a
   hand-copied approximation of it.
   ============================================================ */

/**
 * @typedef {Object} CalEvent
 * @property {string} uid
 * @property {string} title
 * @property {Date} startsAt
 * @property {Date|null} endsAt
 * @property {boolean} allDay
 * @property {string|null} location
 */

/* ─────────────────────────── Lexing ─────────────────────────── */

/* RFC 5545 folds long lines with CRLF followed by a space or tab. */
function unfold(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter(function (line) { return line.trim() !== ''; });
}

/* Parameter values may be quoted and contain ; or : — respect that. */
function indexOfUnquoted(text, needle) {
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (!quoted && text[i] === needle) return i;
  }
  return -1;
}

function splitUnquoted(text, needle) {
  var out = [];
  var current = '';
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (ch === '"') { quoted = !quoted; current += ch; }
    else if (!quoted && ch === needle) { out.push(current); current = ''; }
    else current += ch;
  }
  out.push(current);
  return out;
}

function parseLine(line) {
  var colon = indexOfUnquoted(line, ':');
  if (colon === -1) return null;

  var left = line.slice(0, colon);
  var value = line.slice(colon + 1);
  var bits = splitUnquoted(left, ';');
  var name = bits[0].toUpperCase();

  var params = {};
  for (var i = 1; i < bits.length; i++) {
    var eq = bits[i].indexOf('=');
    if (eq === -1) continue;
    params[bits[i].slice(0, eq).toUpperCase()] = bits[i].slice(eq + 1).replace(/^"|"$/g, '');
  }

  return { name: name, params: params, value: value };
}

function unescapeText(value) {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/* ─────────────────────────── Timezones ───────────────────────────
   Rather than parsing VTIMEZONE blocks, ask the runtime what the
   offset actually is for that instant in that zone. That gets DST
   right for any zone the IANA database knows. */

function zoneOffsetMs(utcMs, timeZone) {
  var parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));

  var get = function (type) {
    var found = parts.find(function (p) { return p.type === type; });
    return found ? Number(found.value) : 0;
  };

  var hour = get('hour');
  if (hour === 24) hour = 0; // some runtimes report midnight as 24

  var asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - utcMs;
}

/* Wall-clock time in a named zone → the UTC instant it refers to.
   Two passes settle the DST boundary cases. */
function wallTimeToUtc(y, mo, d, h, mi, s, timeZone) {
  var naive = Date.UTC(y, mo - 1, d, h, mi, s);
  var guess = naive;
  for (var i = 0; i < 2; i++) {
    guess = naive - zoneOffsetMs(guess, timeZone);
  }
  return guess;
}

function isKnownZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone });
    return true;
  } catch (e) {
    return false;
  }
}

/* ─────────────────────────── Dates ─────────────────────────── */

function parseDate(prop, fallbackZone) {
  var raw = prop.value.trim();
  var isDateOnly = prop.params['VALUE'] === 'DATE' || /^\d{8}$/.test(raw);

  var m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;

  var y = +m[1], mo = +m[2], d = +m[3];
  var h = +(m[4] || 0), mi = +(m[5] || 0), s = +(m[6] || 0);
  var isUtc = m[7] === 'Z';

  var zone = isUtc ? 'UTC' : (prop.params['TZID'] || fallbackZone || 'UTC');
  if (!isKnownZone(zone)) zone = 'UTC';

  var ms = isDateOnly
    ? wallTimeToUtc(y, mo, d, 0, 0, 0, zone)
    : wallTimeToUtc(y, mo, d, h, mi, s, zone);

  return { ms: ms, allDay: isDateOnly, y: y, mo: mo, d: d, h: h, mi: mi, s: s, zone: zone };
}

/* ISO 8601 duration, the subset iCalendar actually uses. */
function parseDuration(value) {
  var m = value.trim().match(
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!m) return null;
  var sign = m[1] === '-' ? -1 : 1;
  var ms =
    (+(m[2] || 0)) * 604800000 +
    (+(m[3] || 0)) * 86400000 +
    (+(m[4] || 0)) * 3600000 +
    (+(m[5] || 0)) * 60000 +
    (+(m[6] || 0)) * 1000;
  return sign * ms;
}

/* ─────────────────────────── Recurrence ─────────────────────────── */

var WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRule(value) {
  var parts = {};
  value.split(';').forEach(function (piece) {
    var eq = piece.indexOf('=');
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  });

  var freq = (parts['FREQ'] || '').toUpperCase();
  if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].indexOf(freq) === -1) return null;

  var untilMs = null;
  if (parts['UNTIL']) {
    var parsed = parseDate({ name: 'UNTIL', params: {}, value: parts['UNTIL'] }, 'UTC');
    untilMs = parsed ? parsed.ms : null;
  }

  var byDay = (parts['BYDAY'] || '')
    .split(',')
    .filter(Boolean)
    .map(function (token) {
      var m = token.trim().toUpperCase().match(/^([+-]?\d+)?([A-Z]{2})$/);
      if (!m) return null;
      var weekday = WEEKDAYS.indexOf(m[2]);
      if (weekday === -1) return null;
      return { ordinal: m[1] ? parseInt(m[1], 10) : null, weekday: weekday };
    })
    .filter(function (x) { return x !== null; });

  var numbers = function (key) {
    return (parts[key] || '').split(',').filter(Boolean)
      .map(Number).filter(function (n) { return isFinite(n); });
  };

  return {
    freq: freq,
    interval: Math.max(1, parseInt(parts['INTERVAL'] || '1', 10) || 1),
    count: parts['COUNT'] ? parseInt(parts['COUNT'], 10) : null,
    untilMs: untilMs,
    byDay: byDay,
    byMonthDay: numbers('BYMONTHDAY'),
    byMonth: numbers('BYMONTH')
  };
}

/* Nth weekday of a month. Negative ordinals count back from the end. */
function nthWeekdayOfMonth(y, mo, weekday, ordinal) {
  var daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();

  if (ordinal > 0) {
    var firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    var day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
    return day <= daysInMonth ? day : null;
  }

  var lastDow = new Date(Date.UTC(y, mo - 1, daysInMonth)).getUTCDay();
  var back = daysInMonth - ((lastDow - weekday + 7) % 7) + (ordinal + 1) * 7;
  return back >= 1 ? back : null;
}

/* Expand a rule into wall-clock dates. Iterating from DTSTART is what
   makes COUNT correct — it counts every occurrence, not just those
   inside our window. The cap stops a malformed rule spinning forever. */
function expandRule(start, rule, windowEndMs) {
  var out = [];
  var CAP = 20000;

  var emitted = 0;
  var iterations = 0;
  var cursorY = start.y, cursorMo = start.mo, cursorD = start.d;

  function push(y, mo, d) {
    if (rule.byMonth.length && rule.byMonth.indexOf(mo) === -1) return true;

    /* Skip dates that do not exist in this month rather than letting them
       roll forward. RFC 5545 says 29 February yearly happens in leap years
       only — it must not silently become 1 March. */
    var daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d < 1 || d > daysInMonth) return true;

    var ms = wallTimeToUtc(y, mo, d, start.h, start.mi, start.s, start.zone);
    if (ms < start.ms) return true;                       // before the series began
    if (rule.untilMs !== null && ms > rule.untilMs) return false;
    if (ms > windowEndMs) return false;
    out.push({ y: y, mo: mo, d: d });
    emitted++;
    return rule.count === null || emitted < rule.count;
  }

  while (iterations++ < CAP) {
    var keepGoing = true;
    var next;

    if (rule.freq === 'DAILY') {
      keepGoing = push(cursorY, cursorMo, cursorD);
      next = new Date(Date.UTC(cursorY, cursorMo - 1, cursorD + rule.interval));
      cursorY = next.getUTCFullYear(); cursorMo = next.getUTCMonth() + 1; cursorD = next.getUTCDate();

    } else if (rule.freq === 'WEEKLY') {
      var weekdays = rule.byDay.length
        ? rule.byDay.map(function (b) { return b.weekday; })
        : [new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay()];

      var cursorDow = new Date(Date.UTC(cursorY, cursorMo - 1, cursorD)).getUTCDay();
      var sorted = weekdays.slice().sort(function (a, b) { return a - b; });

      for (var wi = 0; wi < sorted.length; wi++) {
        var delta = sorted[wi] - cursorDow;
        var day = new Date(Date.UTC(cursorY, cursorMo - 1, cursorD + delta));
        if (!push(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) {
          keepGoing = false;
          break;
        }
      }
      next = new Date(Date.UTC(cursorY, cursorMo - 1, cursorD + 7 * rule.interval));
      cursorY = next.getUTCFullYear(); cursorMo = next.getUTCMonth() + 1; cursorD = next.getUTCDate();

    } else if (rule.freq === 'MONTHLY') {
      var days = [];
      var inMonth = new Date(Date.UTC(cursorY, cursorMo, 0)).getUTCDate();

      if (rule.byDay.length) {
        for (var bi = 0; bi < rule.byDay.length; bi++) {
          var b = rule.byDay[bi];
          if (b.ordinal === null) {
            for (var dd = 1; dd <= inMonth; dd++) {
              if (new Date(Date.UTC(cursorY, cursorMo - 1, dd)).getUTCDay() === b.weekday) days.push(dd);
            }
          } else {
            var nth = nthWeekdayOfMonth(cursorY, cursorMo, b.weekday, b.ordinal);
            if (nth) days.push(nth);
          }
        }
      } else if (rule.byMonthDay.length) {
        for (var mi2 = 0; mi2 < rule.byMonthDay.length; mi2++) {
          var raw = rule.byMonthDay[mi2];
          var dv = raw > 0 ? raw : inMonth + raw + 1;
          if (dv >= 1 && dv <= inMonth) days.push(dv);
        }
      } else {
        // Skip months with no such day — the 31st does not exist in February.
        if (start.d <= inMonth) days.push(start.d);
      }

      days.sort(function (a, b) { return a - b; });
      for (var di = 0; di < days.length; di++) {
        if (!push(cursorY, cursorMo, days[di])) { keepGoing = false; break; }
      }

      var nextMonth = cursorMo + rule.interval;
      cursorY += Math.floor((nextMonth - 1) / 12);
      cursorMo = ((nextMonth - 1) % 12) + 1;

    } else { // YEARLY
      var ymo = rule.byMonth.length ? rule.byMonth[0] : start.mo;
      var yd = rule.byMonthDay.length ? rule.byMonthDay[0] : start.d;
      keepGoing = push(cursorY, ymo, yd);
      cursorY += rule.interval;
    }

    if (!keepGoing) break;
    if (rule.count !== null && emitted >= rule.count) break;

    /* Probe the earliest instant the NEXT period could produce, to decide
       whether to stop. It must not use the cursor day directly: a cursor
       sitting on the 31st rolls into the following month when that month
       is shorter, which would end the loop a period early. */
    var probeY = cursorY, probeMo = cursorMo, probeD = cursorD;
    if (rule.freq === 'MONTHLY') { probeD = 1; }
    else if (rule.freq === 'YEARLY') { probeMo = 1; probeD = 1; }
    else if (rule.freq === 'WEEKLY') { probeD = cursorD - 6; }  // BYDAY can precede the cursor

    var probe = wallTimeToUtc(probeY, probeMo, probeD, start.h, start.mi, start.s, start.zone);
    if (probe > windowEndMs) break;
    if (rule.untilMs !== null && probe > rule.untilMs) break;
  }

  return out;
}

/* ─────────────────────────── Main ─────────────────────────── */

/**
 * @param {string} text raw .ics contents
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @param {number} [maxEvents]
 * @returns {CalEvent[]}
 */
export function parseCalendar(text, windowStartMs, windowEndMs, maxEvents) {
  if (maxEvents === undefined) maxEvents = 500;

  var lines = unfold(text);
  var i;

  var calendarZone = 'UTC';
  for (i = 0; i < lines.length; i++) {
    var head = parseLine(lines[i]);
    if (head && head.name === 'X-WR-TIMEZONE' && isKnownZone(head.value.trim())) {
      calendarZone = head.value.trim();
      break;
    }
  }

  var blocks = [];
  var current = null;
  for (i = 0; i < lines.length; i++) {
    var prop = parseLine(lines[i]);
    if (!prop) continue;
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') current = [];
    else if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      if (current) blocks.push(current);
      current = null;
    } else if (current) current.push(prop);
  }

  var results = [];
  var overridden = {};   // "uid|instant" for occurrences replaced by an override

  function finder(block) {
    return function (name) {
      for (var k = 0; k < block.length; k++) if (block[k].name === name) return block[k];
      return null;
    };
  }

  // Overrides first, so the base series knows which instances to skip.
  for (i = 0; i < blocks.length; i++) {
    var g0 = finder(blocks[i]);
    var recurrenceId = g0('RECURRENCE-ID');
    if (!recurrenceId) continue;
    var uid0 = g0('UID') ? g0('UID').value : '';
    var parsed0 = parseDate(recurrenceId, calendarZone);
    if (uid0 && parsed0) overridden[uid0 + '|' + parsed0.ms] = true;
  }

  for (i = 0; i < blocks.length; i++) {
    if (results.length >= maxEvents) break;

    var block = blocks[i];
    var get = finder(block);

    var statusProp = get('STATUS');
    if (statusProp && statusProp.value.toUpperCase() === 'CANCELLED') continue;

    var dtstartProp = get('DTSTART');
    if (!dtstartProp) continue;
    var start = parseDate(dtstartProp, calendarZone);
    if (!start) continue;

    var uid = get('UID') ? get('UID').value : ('gen-' + i);
    var title = unescapeText(get('SUMMARY') ? get('SUMMARY').value : '(no title)');
    var location = get('LOCATION') ? unescapeText(get('LOCATION').value) : null;

    // Duration, so each occurrence carries a sensible end.
    var durationMs = null;
    var dtend = get('DTEND');
    var duration = get('DURATION');
    if (dtend) {
      var end = parseDate(dtend, calendarZone);
      if (end) durationMs = end.ms - start.ms;
    } else if (duration) {
      durationMs = parseDuration(duration.value);
    }

    var exdates = {};
    for (var e = 0; e < block.length; e++) {
      if (block[e].name !== 'EXDATE') continue;
      var pieces = block[e].value.split(',');
      for (var pi = 0; pi < pieces.length; pi++) {
        var ex = parseDate({ name: 'EXDATE', params: block[e].params, value: pieces[pi] }, calendarZone);
        if (ex) exdates[ex.ms] = true;
      }
    }

    var rruleProp = get('RRULE');
    var rule = rruleProp ? parseRule(rruleProp.value) : null;

    var instants = [];
    if (rule) {
      var occurrences = expandRule(start, rule, windowEndMs);
      for (var oi = 0; oi < occurrences.length; oi++) {
        instants.push(wallTimeToUtc(
          occurrences[oi].y, occurrences[oi].mo, occurrences[oi].d,
          start.h, start.mi, start.s, start.zone
        ));
      }
    } else {
      instants.push(start.ms);
    }

    var isOverride = Boolean(get('RECURRENCE-ID'));

    for (var ii = 0; ii < instants.length; ii++) {
      if (results.length >= maxEvents) break;
      var ms = instants[ii];
      if (ms < windowStartMs || ms > windowEndMs) continue;
      if (exdates[ms]) continue;
      if (!isOverride && overridden[uid + '|' + ms]) continue;

      results.push({
        uid: uid,
        title: title,
        startsAt: new Date(ms),
        endsAt: durationMs !== null ? new Date(ms + durationMs) : null,
        allDay: start.allDay,
        location: location
      });
    }
  }

  results.sort(function (a, b) { return a.startsAt.getTime() - b.startsAt.getTime(); });
  return results;
}
