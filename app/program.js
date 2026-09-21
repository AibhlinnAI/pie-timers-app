/* ============================================================
   Programme viewer — one event preset, two ways of reading it.

   Delegate mode is a phone in a lanyard: what am I in, how much of it
   is left, what is next. Display mode is a screen in the foyer: the
   same answers at ten metres, cycling the day by itself with nobody
   touching it.

   Both read the same JSON from app/presets/. Neither knows the name of
   any conference — swapping the event is swapping ?e=.

   Nothing here talks to Supabase, sign-in, billing or the service
   worker, and nothing is written to storage except the theme it reads.
   A delegate can open this on a borrowed phone and leave no trace.
   ============================================================ */
(function () {
  'use strict';

  /* Dial geometry — must match the cx/cy/r in program.html, which in turn
     match app/index.html so the pies are recognisably the same object. */
  var DIAL_CX = 80, DIAL_CY = 80, DIAL_R = 70;

  /* How often the display pans the day list when it is taller than the
     screen, and how far. Slow on purpose: a foyer screen that scrolls at
     reading speed is a screen nobody can read, because it moves while
     you are looking at it. */
  var PAN_INTERVAL_MS = 7000;

  var MIN = 60000;
  var DAY_MIN = 1440;

  var $ = function (id) { return document.getElementById(id); };

  /* ─────────────────────────── Query ─────────────────────────── */

  var params = new URLSearchParams(location.search);

  /* Both spellings work. ?e= is what goes on a QR code and a slide;
     ?preset= is what the main app uses, and a link copied from one
     into the other should not silently show nothing. */
  var presetId = params.get('e') || params.get('preset') || '';

  /* A path segment built from a query string is an obvious way to fetch
     something that was never meant to be fetched. Nothing but an id shape
     gets through, and the fetch stays inside presets/ either way. */
  var VALID_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

  var isDisplay = params.get('display') === '1' || params.get('mode') === 'display';
  var demoOn = params.get('demo') === '1';

  /* ─────────────────────────── Clock ───────────────────────────
     Every time in a preset is the venue's wall clock, because that is what
     the printed programme says and what the person in the room is reading.

     A delegate standing in the venue is already on that clock, so for them
     this is all a no-op. It exists for the other reader: an organiser in
     Adelaide checking the programme a week out, who would otherwise watch
     Gold Coast sessions start half an hour early.

     utcOffsetMinutes is a fixed number, which is normally wrong for a time
     zone. app/presets/README.md sets out why it is allowed for these two
     events and what to check before trusting it for a third. */

  var offsetMinutes = 0;          // set from the preset once it loads

  /* Demo clock. `anchor` is the venue-local instant the preview is sitting
     at, `scale` how many programme seconds pass per real second, and
     `running` whether it is moving. With demo off, none of it is consulted. */
  var demo = { anchor: 0, scale: 120, running: true, lastTick: 0 };

  /* The venue's wall clock as a Date whose UTC fields are the venue's local
     ones. Read it with getUTC*; never with getHours, which would reapply the
     viewer's own zone on top. */
  function venueNow() {
    var ms = demoOn ? demo.anchor : Date.now() + offsetMinutes * MIN;
    return new Date(ms);
  }

  function venueDate(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /* Minutes past venue midnight, fractional so the pie moves smoothly
     rather than stepping once a minute. */
  function venueMinutes(d) {
    return d.getUTCHours() * 60 + d.getUTCMinutes() +
           d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
  }

  /* The venue-local instant for a date string and a minute offset. */
  function instantOf(dateStr, minutes) {
    return Date.parse(dateStr + 'T00:00:00Z') + minutes * MIN;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* ─────────────────────────── State ─────────────────────────── */

  var preset = null;
  var days = [];              // normalised, with end times resolved
  var viewDate = null;        // the day being shown; null means "follow the clock"
  var panTimer = null;
  var panIndex = 0;

  /* ─────────────────────────── Load ─────────────────────────── */

  function fail(message, detail) {
    $('evName').textContent = message;
    $('evVenue').textContent = detail || '';
    $('nowTitle').textContent = '—';
    $('timeline').innerHTML = '';
  }

  function load() {
    if (!VALID_ID.test(presetId)) {
      fail('No programme asked for.',
           'Add ?e= and an event id — for example ?e=nwc26.');
      return;
    }

    fetch('presets/' + presetId + '.json', { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(start)
      .catch(function () {
        fail('That programme is not here.',
             'No preset called "' + presetId + '". Check the link, or ask the organiser for a new one.');
      });
  }

  function start(data) {
    preset = normalisePreset(data);
    if (!preset) {
      fail('That programme could not be read.',
           'The preset file is there but not in a shape this page understands.');
      return;
    }

    offsetMinutes = preset.utcOffsetMinutes;
    days = preset.days;

    /* ?day= pins a date. Anything else follows the clock, which is what a
       delegate wants and the only thing that makes sense on a foyer screen. */
    var asked = params.get('day');
    if (asked && days.some(function (d) { return d.date === asked; })) viewDate = asked;

    setupDemo();
    paintChrome();
    buildDayTabs();
    tick();
    setInterval(tick, 200);

    if (isDisplay) enterDisplay();
  }

  /* ─────────────────────────── Normalising ───────────────────────────
     Everything below trusts these fields, so nothing above them may be
     trusted. A preset is a file on our own origin, but it is also the
     thing a future session edits at speed the night before an event. */

  function normalisePreset(data) {
    if (!data || typeof data !== 'object') return null;
    if (!Array.isArray(data.days) || !data.days.length) return null;

    var out = {
      id: str(data.id, 40) || presetId,
      name: str(data.name, 120) || 'Programme',
      shortName: str(data.shortName, 40) || '',
      venue: str(data.venue, 120) || '',
      timeZone: str(data.timeZone, 60) || '',
      utcOffsetMinutes: isNum(data.utcOffsetMinutes) ? data.utcOffsetMinutes : 0,
      official: data.official === true,
      disclaimer: str(data.disclaimer, 400) || '',
      source: data.source && typeof data.source === 'object' ? {
        label: str(data.source.label, 80),
        /* https only, and only when it parses. A programme file is not a
           place to accept a javascript: URL from. */
        url: safeUrl(data.source.url)
      } : null,
      days: []
    };

    data.days.forEach(function (day) {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return;
      if (!Array.isArray(day.items) || !day.items.length) return;

      var items = day.items.filter(function (it) {
        return it && isMinute(it.time) && typeof it.title === 'string' && it.title.trim();
      }).map(function (it, i) {
        return {
          n: isNum(it.n) && it.n > 0 ? Math.floor(it.n) : i + 1,
          time: it.time,
          /* Explicit finishes only. Inference happens below, once the
             items are in order, because it needs the next one. */
          end: isMinute(it.end) && it.end > it.time ? it.end : null,
          open: it.open === true,
          moment: it.moment === true,
          kind: KINDS[it.kind] ? it.kind : 'session',
          title: it.title.trim().slice(0, 80)
        };
      }).sort(function (a, b) { return a.time - b.time; });

      if (!items.length) return;

      var dayEnd = isMinute(day.end) ? day.end : null;

      /* A printed programme gives one time per row and expects you to read
         the next row for the finish. Do that, and only that — a session with
         nothing after it gets no invented length. */
      items.forEach(function (it, i) {
        if (it.moment) { it.end = null; return; }
        if (it.end !== null) return;
        if (it.open) { it.end = null; return; }

        var next = items[i + 1];
        if (next) { it.end = next.time; return; }

        if (dayEnd !== null && dayEnd > it.time) { it.end = dayEnd; return; }
        it.open = true;                       // published start, no published finish
      });

      out.days.push({
        date: day.date,
        label: str(day.label, 40) || '',
        start: isMinute(day.start) ? day.start : items[0].time,
        lunch: isMinute(day.lunch) ? day.lunch : null,
        end: dayEnd !== null ? dayEnd : (items[items.length - 1].end || items[items.length - 1].time),
        items: items
      });
    });

    out.days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out.days.length ? out : null;
  }

  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isMinute(v) { return isNum(v) && v >= 0 && v < DAY_MIN; }

  function safeUrl(v) {
    if (typeof v !== 'string' || !v) return '';
    try {
      var u = new URL(v, location.href);
      return u.protocol === 'https:' ? u.href : '';
    } catch (e) { return ''; }
  }

  /* Colour is the only thing kind decides. The tokens are the app's own,
     so a break here is the same orange as an appointment there. */
  var KINDS = {
    keynote:  { accent: 'var(--purple)',     fill: 'var(--purple)',     word: 'Keynote' },
    session:  { accent: 'var(--forest)',     fill: 'var(--forest)',     word: 'Session' },
    workshop: { accent: 'var(--forest)',     fill: 'var(--forest)',     word: 'Workshop' },
    break:    { accent: 'var(--appt)',       fill: 'var(--appt-fill)',  word: 'Break' },
    meal:     { accent: 'var(--appt)',       fill: 'var(--appt-fill)',  word: 'Break' },
    social:   { accent: 'var(--purple-lift)',fill: 'var(--purple-lift)',word: 'Social' },
    close:    { accent: 'var(--orange)',     fill: 'var(--orange)',     word: 'Close' }
  };

  /* ─────────────────────────── Chrome ─────────────────────────── */

  function paintChrome() {
    document.title = (preset.shortName || preset.name) + ' — Pie Timers';
    $('evName').textContent = preset.name;
    $('evVenue').textContent = preset.venue;
    $('clockZone').textContent = preset.timeZone ? venueZoneLabel() : '';

    $('disclaimer').textContent = preset.disclaimer;

    if (preset.source && preset.source.url && preset.source.label) {
      var a = $('sourceLink');
      a.href = preset.source.url;
      a.textContent = preset.source.label;
      $('sourceWrap').hidden = false;
    }

    /* The two cross-links keep whatever else is on the URL — a pinned day,
       a running preview — so switching view does not throw the reader back
       to the top of the event. */
    $('addBtn').href = 'index.html?preset=' + encodeURIComponent(preset.id);
    $('displayBtn').href = withParams({ display: '1' });
    $('delegateBtn').href = withParams({ display: null, mode: null });
  }

  function venueZoneLabel() {
    var sign = preset.utcOffsetMinutes < 0 ? '-' : '+';
    var abs = Math.abs(preset.utcOffsetMinutes);
    var mins = abs % 60;
    return preset.timeZone.split('/').pop().replace(/_/g, ' ') +
           ' · UTC' + sign + Math.floor(abs / 60) + (mins ? ':' + pad(mins) : '');
  }

  function withParams(changes) {
    var next = new URLSearchParams(location.search);
    Object.keys(changes).forEach(function (k) {
      if (changes[k] === null) next.delete(k);
      else next.set(k, changes[k]);
    });
    var q = next.toString();
    return location.pathname + (q ? '?' + q : '');
  }

  function buildDayTabs() {
    var wrap = $('dayTabs');
    wrap.innerHTML = '';

    days.forEach(function (day) {
      var a = document.createElement('a');
      a.className = 'pg-day';
      a.href = withParams({ day: day.date });
      a.dataset.date = day.date;
      var d = new Date(Date.parse(day.date + 'T00:00:00Z'));
      a.innerHTML = '<span class="pg-day-dow">' +
        d.toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'UTC' }) +
        '</span><span class="pg-day-num">' +
        d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }) +
        '</span>' + (day.label ? '<span class="pg-day-label">' + esc(day.label) + '</span>' : '');
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        viewDate = viewDate === day.date ? null : day.date;
        history.replaceState(null, '', viewDate ? withParams({ day: viewDate })
                                                : withParams({ day: null }));
        syncScrubRange();
        tick(true);
      });
      wrap.appendChild(a);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ─────────────────────────── The tick ───────────────────────────
     One pass, four times a second: advance the preview clock if there is
     one, work out where we are in the programme, and paint. Everything
     below is derived — nothing is remembered between ticks except which
     day is on screen and where the display has panned to. */

  var lastKey = '';

  function tick(force) {
    advanceDemo();

    var now = venueNow();
    var today = venueDate(now);
    var mins = venueMinutes(now);

    paintClock(now);

    var day = pickDay(today);
    var state = day ? locate(day, today, mins) : null;

    markDayTabs(day, today);
    paintNow(day, today, mins, state);

    /* The list is the expensive part and changes far less often than the
       numbers do, so rebuild it only when something in it would look
       different. */
    var key = (day ? day.date : '-') + '|' + (state ? state.phase + state.index : '-');
    if (force || key !== lastKey) {
      lastKey = key;
      buildTimeline(day, state);
      if (isDisplay) resetPan();
    }
  }

  /* Which day to show. A pinned day wins. Otherwise: today if the event is
     on today, else the next day that has not happened, else the last one —
     so the screen never goes blank, it just says what it is showing. */
  function pickDay(today) {
    if (viewDate) return byDate(viewDate);
    var onToday = byDate(today);
    if (onToday) return onToday;
    for (var i = 0; i < days.length; i++) if (days[i].date > today) return days[i];
    return days[days.length - 1] || null;
  }

  function byDate(date) {
    for (var i = 0; i < days.length; i++) if (days[i].date === date) return days[i];
    return null;
  }

  /* Where the clock is against one day's items.

     phase: 'before' the day, 'in' an item, 'gap' between two of them,
     'after' the last one, or 'other' when the day on screen is not the
     day the clock is on at all.

     currentIndex / pastThrough / nextIndex exist so the list below can
     colour itself without re-deriving any of this, and so that "past"
     means the same thing in both places. */
  function locate(day, today, mins) {
    var items = day.items;

    function at(phase, index, next) {
      return {
        phase: phase,
        index: index,
        item: index >= 0 ? items[index] : null,
        next: next === undefined ? null : next,
        currentIndex: phase === 'in' ? index : -1,
        pastThrough: phase === 'in' ? index - 1 : phase === 'before' ? -1 : index,
        nextIndex: next ? items.indexOf(next) : -1
      };
    }

    if (day.date !== today) return at('other', -1, null);

    if (mins < items[0].time) return at('before', -1, items[0]);

    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (mins < it.time) continue;
      var next = items[i + 1] || null;

      /* A moment is current for a courtesy minute, so the screen does not
         blink past the close of the conference in a single frame. */
      if (it.moment) return at(mins < it.time + 1 ? 'in' : 'after', i, next);

      /* An open item has no published finish, so it stays current until
         the next thing starts — and the last one simply keeps running,
         which is what "onwards" means. */
      if (it.end === null || mins < it.end) return at('in', i, next);

      return at(next ? 'gap' : 'after', i, next);
    }

    return at('before', -1, items[0]);
  }

  /* ─────────────────────────── Painting ─────────────────────────── */

  function paintClock(now) {
    $('clockTime').textContent = clock(venueMinutes(now));
    $('clockDate').textContent = now.toLocaleDateString('en-AU',
      { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  function markDayTabs(day, today) {
    Array.prototype.forEach.call($('dayTabs').children, function (el) {
      el.classList.toggle('is-current', !!day && el.dataset.date === day.date);
      el.classList.toggle('is-today', el.dataset.date === today);
    });
  }

  function paintNow(day, today, mins, state) {
    var card = $('nowCard');
    var kicker = $('nowKicker'), title = $('nowTitle');
    var window_ = $('nowWindow'), left = $('nowLeft'), next = $('nowNext');
    var banner = $('banner');

    /* Inline custom properties beat the class rules that set them, so a
       card that has been live has to have them taken off again before an
       idle class can win. */
    function accent(kind) {
      if (!kind) {
        card.style.removeProperty('--accent');
        card.style.removeProperty('--accent-fill');
        return;
      }
      card.style.setProperty('--accent', kind.accent);
      card.style.setProperty('--accent-fill', kind.fill);
    }

    if (!day) {
      card.className = 'pg-now is-idle';
      accent(null);
      kicker.textContent = '';
      title.textContent = 'Nothing scheduled.';
      window_.textContent = left.textContent = next.textContent = '';
      setPie(null, 0);
      return;
    }

    /* The banner carries the one thing a reader could otherwise get wrong:
       that this is a preview, or that the day on screen is not today. */
    var notes = [];
    if (demoOn) notes.push('Preview — the clock on this page is simulated, not the real time.');
    if (state && state.phase === 'other') {
      notes.push(dayWord(day) + ' is ' + (day.date > today ? 'still to come' : 'over') +
                 '. Showing its programme, not a live countdown.');
    }
    banner.textContent = notes.join(' ');
    banner.hidden = !notes.length;

    if (!state || state.phase === 'other') {
      card.className = 'pg-now is-idle';
      accent(null);
      kicker.textContent = dayWord(day);
      title.textContent = day.items[0].title;
      window_.textContent = 'Starts ' + clock(day.items[0].time) + ' · ' +
                            day.items.length + (day.items.length === 1 ? ' item' : ' items') +
                            ' · runs to ' + clock(day.end);
      left.textContent = '';
      next.textContent = '';
      setPie(null, 0);
      return;
    }

    if (state.phase === 'before') {
      var until = state.next.time - mins;
      /* The last hour before the doors, not the whole night. A pie that has
         been sitting full since 3am is not a countdown, it is a picture. */
      var runUp = Math.min(60, state.next.time);
      card.className = 'pg-now is-waiting';
      accent(KINDS[state.next.kind]);
      kicker.textContent = 'Starting soon';
      title.textContent = state.next.title;
      window_.textContent = clock(state.next.time) + ' · ' + KINDS[state.next.kind].word;
      left.textContent = words(until) + ' until it starts';
      next.textContent = '';
      setPie(KINDS[state.next.kind], clamp01(until / runUp), runUp);
      return;
    }

    if (state.phase === 'in') {
      var it = state.item;
      card.className = 'pg-now is-live';
      accent(KINDS[it.kind]);
      kicker.textContent = 'On now · ' + KINDS[it.kind].word;
      title.textContent = it.title;

      if (it.moment) {
        window_.textContent = clock(it.time);
        left.textContent = '';
        setPie(KINDS[it.kind], 0);
      } else if (it.end === null) {
        window_.textContent = clock(it.time) + ' onwards';
        left.textContent = 'No finish time published.';
        setPie(null, 0);
      } else {
        var remaining = it.end - mins;
        var total = it.end - it.time;
        window_.textContent = clock(it.time) + ' – ' + clock(it.end) +
                              ' · ' + words(total) + ' long';
        left.textContent = words(remaining) + ' left';
        card.classList.toggle('is-urgent', remaining <= 5);
        setPie(KINDS[it.kind], clamp01(remaining / total), total);
      }

      next.textContent = state.next ? 'Then ' + clock(state.next.time) + ' · ' + state.next.title
                                    : 'Last item of the day.';
      return;
    }

    if (state.phase === 'gap' && state.next) {
      var wait = state.next.time - mins;
      var gap = Math.max(1, state.next.time - (state.item.end !== null ? state.item.end : state.item.time));
      card.className = 'pg-now is-waiting';
      accent(KINDS[state.next.kind]);
      kicker.textContent = 'Next up · ' + KINDS[state.next.kind].word;
      title.textContent = state.next.title;
      window_.textContent = clock(state.next.time) +
        (state.next.end !== null ? ' – ' + clock(state.next.end) : ' onwards');
      left.textContent = words(wait) + ' to go';
      next.textContent = 'Between sessions.';
      setPie(KINDS[state.next.kind], clamp01(wait / gap), gap);
      return;
    }

    card.className = 'pg-now is-done';
    accent(null);
    kicker.textContent = dayWord(day);
    title.textContent = 'That is the day.';
    window_.textContent = 'Ran ' + clock(day.start) + ' to ' + clock(day.end) + '.';
    left.textContent = '';
    next.textContent = nextDayLine(day);
    setPie(null, 0);
  }

  function nextDayLine(day) {
    for (var i = 0; i < days.length; i++) {
      if (days[i].date > day.date) {
        var d = new Date(Date.parse(days[i].date + 'T00:00:00Z'));
        return 'Back ' + d.toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' }) +
               ' at ' + clock(days[i].items[0].time) + '.';
      }
    }
    return 'That is the whole programme. Safe travels.';
  }

  function dayWord(day) {
    var d = new Date(Date.parse(day.date + 'T00:00:00Z'));
    return d.toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' }) +
           (day.label ? ' · ' + day.label : '');
  }

  /* ─────────────────────────── Timeline ─────────────────────────── */

  function buildTimeline(day, state) {
    var list = $('timeline');
    list.innerHTML = '';
    if (!day) return;

    $('listHeading').textContent = dayWord(day);

    day.items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = 'pg-item pg-item--' + it.kind;
      li.style.setProperty('--accent', KINDS[it.kind].accent);

      if (state && state.phase !== 'other') {
        if (i === state.currentIndex) li.classList.add('is-now');
        else if (i <= state.pastThrough) li.classList.add('is-past');
        else if (i === state.nextIndex) li.classList.add('is-next');
      }

      var when;
      if (it.moment || it.end === null) when = clock(it.time) + (it.moment ? '' : ' →');
      else when = clock(it.time) + ' – ' + clock(it.end);

      li.innerHTML =
        '<span class="pg-item-time">' + esc(when) + '</span>' +
        '<span class="pg-item-body">' +
          '<span class="pg-item-title">' + esc(it.title) + '</span>' +
          '<span class="pg-item-kind">' + esc(KINDS[it.kind].word) +
            (it.end !== null && !it.moment ? ' · ' + words(it.end - it.time) : '') +
          '</span>' +
        '</span>';

      list.appendChild(li);
    });
  }

  /* ─────────────────────────── The pie ───────────────────────────
     Copied, not shared, from app/app.js. This page deliberately loads none
     of the app's modules — no sign-in, no sync, no service worker — and one
     duplicated wedge is a cheaper price than a shared module that drags
     the rest of the app onto a screen in a foyer. If the geometry changes
     in app.js it must change here too; there is nothing to catch that but
     this comment. */

  function pointOnDial(fraction) {
    var angle = fraction * 2 * Math.PI;
    return {
      x: DIAL_CX + DIAL_R * Math.sin(angle),
      y: DIAL_CY - DIAL_R * Math.cos(angle)
    };
  }

  function wedgePath(remainingFraction) {
    if (remainingFraction <= 0) return '';

    if (remainingFraction >= 0.99999) {
      return 'M ' + DIAL_CX + ' ' + (DIAL_CY - DIAL_R) +
             ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 1 1 ' + DIAL_CX + ' ' + (DIAL_CY + DIAL_R) +
             ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 1 1 ' + DIAL_CX + ' ' + (DIAL_CY - DIAL_R) + ' Z';
    }

    var start = pointOnDial(1 - remainingFraction);
    var largeArc = remainingFraction > 0.5 ? 1 : 0;

    return 'M ' + DIAL_CX + ' ' + DIAL_CY +
           ' L ' + start.x.toFixed(3) + ' ' + start.y.toFixed(3) +
           ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 ' + largeArc + ' 1 ' +
           DIAL_CX + ' ' + (DIAL_CY - DIAL_R) + ' Z';
  }

  function setPie(kind, remaining, totalMinutes) {
    $('nowPie').setAttribute('d', kind ? wedgePath(remaining) : '');
    drawTicks(totalMinutes || 0, remaining);
  }

  /* Notches in the timer's own units, so "two big notches" means something
     a person can count. Bands rather than an arithmetic rule, for the same
     reason app.js uses them: 90 minutes wants quarter-hours, not the
     ten-minute pieces division would pick. */
  function tickStep(total) {
    if (total <= 20) return 5;
    if (total <= 45) return 10;
    if (total <= 150) return 15;
    if (total <= 300) return 30;
    return 60;
  }

  function drawTicks(total, remaining) {
    var under = $('nowTicks'), over = $('nowTicksOver');
    under.innerHTML = ''; over.innerHTML = '';
    if (!total || total <= 0) return;

    var step = tickStep(total);
    var eaten = 1 - remaining;

    for (var m = step; m < total; m += step) {
      var fraction = m / total;
      var major = (m % (step * 2)) === 0;
      var outer = pointOnDial(fraction);
      var innerR = DIAL_R - (major ? 11 : 6);
      var angle = fraction * 2 * Math.PI;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', (DIAL_CX + innerR * Math.sin(angle)).toFixed(2));
      line.setAttribute('y1', (DIAL_CY - innerR * Math.cos(angle)).toFixed(2));
      line.setAttribute('x2', outer.x.toFixed(2));
      line.setAttribute('y2', outer.y.toFixed(2));
      if (major) line.setAttribute('class', 'is-major');
      /* Notches over the eaten plate need the light stroke; notches still
         inside the wedge need the dark one. Same split as the app. */
      (fraction < eaten ? under : over).appendChild(line);
    }
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* ─────────────────────────── Words and clocks ─────────────────────────── */

  function clock(mins) {
    var m = Math.floor(mins);
    var h = Math.floor(m / 60) % 24;
    var mm = m % 60;
    var suffix = h < 12 ? 'am' : 'pm';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (mm ? ':' + pad(mm) : '') + suffix;
  }

  /* Round up, never down. "1 min left" with fifty seconds on the clock is
     a small lie in the reader's favour; "0 min left" with fifty seconds
     still to run is the kind that gets someone out of their seat early. */
  function words(mins) {
    var m = Math.max(0, Math.ceil(mins));
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
    var h = Math.floor(m / 60), r = m % 60;
    return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
  }

  /* ─────────────────────────── Display mode ───────────────────────────
     A screen nobody is standing at. Keep it awake if the browser allows,
     and pan the day list when it is longer than the screen, so a delegate
     glancing up at 2pm still sees the afternoon and not just the morning. */

  function enterDisplay() {
    document.body.classList.add('pg-display');
    $('displayBtn').hidden = true;
    $('delegateBtn').hidden = false;
    keepAwake();
    resetPan();
  }

  function keepAwake() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    var held = null;
    var ask = function () {
      navigator.wakeLock.request('screen').then(function (lock) {
        held = lock;
        /* Some browsers drop the lock when the tab is backgrounded and never
           give it back on their own. */
        lock.addEventListener('release', function () { held = null; });
      }).catch(function () { /* refused, or not over https — nothing to do */ });
    };
    ask();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !held) ask();
    });
  }

  function resetPan() {
    clearInterval(panTimer);
    panIndex = 0;
    var list = $('timeline');
    if (!isDisplay || !list) return;

    /* Someone who has asked their system for less movement gets a list that
       jumps rather than glides. The panning itself stays either way — it is
       information, not decoration, and a screen that stops panning stops
       showing the afternoon. */
    var glide = 'smooth';
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) glide = 'auto';
    } catch (e) { /* assume motion is fine */ }

    panTimer = setInterval(function () {
      if (list.scrollHeight - list.clientHeight <= 8) { list.scrollTop = 0; return; }
      var pages = Math.ceil(list.scrollHeight / list.clientHeight);
      panIndex = (panIndex + 1) % pages;
      list.scrollTo({ top: panIndex * list.clientHeight, behavior: glide });
    }, PAN_INTERVAL_MS);
  }

  /* ─────────────────────────── Preview clock ───────────────────────────
     Only reachable with ?demo=1. The conference is in the future when this
     link is first sent, so an organiser opening it without this sees a
     correct but motionless screen and learns nothing about whether the
     thing works. This is what lets them watch a day run in four minutes. */

  /* ?at=2026-09-28T11:15 — an instant on the venue's own clock. No zone
     suffix is wanted or expected; one that arrives anyway is honoured
     rather than mangled. */
  function parseAt(v) {
    if (!v) return NaN;
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z');
  }

  function setupDemo() {
    var pinned = parseAt(params.get('at'));

    /* ?at= on its own is a preview too — a still one. It has to say so for
       the same reason the moving clock does: what is on screen is not the
       time, and only the page knows that. */
    if (!demoOn && isFinite(pinned)) { demoOn = true; demo.running = false; }
    if (!demoOn) return;

    if (isFinite(pinned)) {
      demo.anchor = pinned;
    } else {
      /* Ten minutes before the busiest day starts, so the first thing an
         organiser sees is the countdown to the kickoff rather than an
         empty morning. */
      var day = days[days.length > 1 ? 1 : 0];
      demo.anchor = instantOf(day.date, Math.max(0, day.items[0].time - 10));
    }

    var speed = parseFloat(params.get('speed'));
    if (isFinite(speed) && speed > 0 && speed <= 3600) demo.scale = speed;

    demo.lastTick = Date.now();

    var box = $('controls');
    box.hidden = false;
    document.body.classList.add('pg-demo');

    var sel = $('speedSel');
    if (!Array.prototype.some.call(sel.options, function (o) { return +o.value === demo.scale; })) {
      var extra = document.createElement('option');
      extra.value = String(demo.scale);
      extra.textContent = demo.scale + '×';
      sel.appendChild(extra);
    }
    sel.value = String(demo.scale);
    sel.addEventListener('change', function () { demo.scale = parseFloat(sel.value) || 1; });

    var play = $('playBtn');
    play.textContent = demo.running ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(demo.running));
    play.addEventListener('click', function () {
      demo.running = !demo.running;
      demo.lastTick = Date.now();
      play.textContent = demo.running ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', String(demo.running));
    });

    $('scrub').addEventListener('input', function () {
      var day = pickDay(venueDate(venueNow())) || days[0];
      demo.running = false;
      $('playBtn').textContent = 'Play';
      $('playBtn').setAttribute('aria-pressed', 'false');
      demo.anchor = instantOf(day.date, parseInt($('scrub').value, 10) || 0);
      tick(true);
    });

    $('liveBtn').addEventListener('click', function () {
      /* Leaving the preview means leaving the URL that created it, or a
         reload quietly puts it back. */
      location.href = withParams({ demo: null, at: null, speed: null });
    });

    syncScrubRange();
  }

  /* The slider covers the day on screen, not the whole 24 hours — dragging
     through seven empty hours to reach the morning tea is not a control. */
  function syncScrubRange() {
    if (!demoOn || !days.length) return;
    var day = pickDay(venueDate(venueNow())) || days[0];
    var lo = Math.max(0, day.items[0].time - 15);
    var hi = Math.min(DAY_MIN - 1, day.end + 15);
    var s = $('scrub');
    s.min = String(lo);
    s.max = String(hi);
    s.value = String(Math.min(hi, Math.max(lo, Math.round(venueMinutes(venueNow())))));
  }

  function advanceDemo() {
    if (!demoOn) return;
    var real = Date.now();
    if (demo.running) demo.anchor += (real - demo.lastTick) * demo.scale;
    demo.lastTick = real;

    var now = venueNow();
    $('scrubOut').textContent = clock(venueMinutes(now));
    if (demo.running) {
      var s = $('scrub');
      var v = Math.round(venueMinutes(now));
      if (v >= +s.min && v <= +s.max) s.value = String(v);
    }
  }

  load();
})();
