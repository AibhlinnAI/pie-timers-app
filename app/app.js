/* ============================================================
   Pie Timers
   Live replacement for the "Countdown Timers.xlsx" workbook.
   All state lives in localStorage; nothing leaves the device.
   ============================================================ */
(function () {
  'use strict';

  var CT = window.CT = window.CT || {};

  var STORE_KEY = 'countdown-timers/v1';
  /* Dial geometry — must match the cx/cy/r in the SVG markup. */
  var DIAL_CX = 80, DIAL_CY = 80, DIAL_R = 70;

  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  /* Defaults carried across from the workbook's weekly schedule.
     Excel stored these as day fractions; converted here to minutes past midnight. */
  /* Deliberately round, obviously-generic hours. These began as one
     person's real timetable, which meant every new user opened the app to
     a stranger's working week and no clue it was not theirs. Round numbers
     read as placeholders; 9:15 and 15:10 read as somebody's actual life. */
  var DEFAULT_SCHEDULE = {
    Monday:    { working: true,  start: 540, lunch: 750, end: 1020 }, // 9:00 / 12:30 / 17:00
    Tuesday:   { working: true,  start: 540, lunch: 750, end: 1020 },
    Wednesday: { working: true,  start: 540, lunch: 750, end: 1020 },
    Thursday:  { working: true,  start: 540, lunch: 750, end: 1020 },
    Friday:    { working: true,  start: 540, lunch: 750, end: 1020 },
    Saturday:  { working: false, start: 540, lunch: 750, end: 1020 },
    Sunday:    { working: false, start: 540, lunch: 750, end: 1020 }
  };

  var DEFAULT_SETTINGS = {
    clock24: false,
    showSeconds: true,
    alerts: false,
    sound: false,
    push: false,
    calcTarget: '13:00',
    calcRollover: false,
    /* What the midday timer is called. "Head Home" is opt-in because it
       is a prompt to stop, which not everyone wants or needs. */
    lunchLabel: 'Lunch',
    /* 'dark' | 'light' | 'system'. Dark is the default. */
    theme: 'dark',
    /* Minutes remaining at which a timer turns crimson. 0 turns it off —
     one control rather than a switch plus a number, because two controls
     for one idea is exactly the load this app is meant to remove. */
    urgentMinutes: 15,
    /* False until the welcome panel is dismissed or the schedule is edited. */
    onboarded: false
  };

  var THEMES = ['dark', 'light', 'system'];
  var URGENT_CHOICES = [0, 5, 10, 15, 30, 60];

  /* A day off is not a gap in the data — it is the point. "N/A | WFH" read
     like a spreadsheet error; this reads like the thing it describes.
     Each weekday keeps its own word so the table is learnable rather than
     random, and Saoirse leads because Aibhlínn is Irish.
     Roman alphabet only, as asked. */
  var FREEDOM = {
    Monday: {
      start: { word: 'Saoirse',    lang: 'Irish' },
      lunch: { word: 'Frelsi',     lang: 'Icelandic' },
      end:   { word: 'Vapaus',     lang: 'Finnish' }
    },
    Tuesday: {
      start: { word: 'Libertà',    lang: 'Italian' },
      lunch: { word: 'Vryheid',    lang: 'Afrikaans' },
      end:   { word: 'Szabadság',  lang: 'Hungarian' }
    },
    Wednesday: {
      start: { word: 'Vrijheid',   lang: 'Dutch' },
      lunch: { word: 'Svoboda',    lang: 'Czech' },
      end:   { word: 'Ominira',    lang: 'Yoruba' }
    },
    Thursday: {
      start: { word: 'Frihet',     lang: 'Swedish' },
      lunch: { word: 'Rhyddid',    lang: 'Welsh' },
      end:   { word: 'Kalayaan',   lang: 'Filipino' }
    },
    Friday: {
      start: { word: 'Liberté',    lang: 'French' },
      lunch: { word: 'Libertas',   lang: 'Latin' },
      end:   { word: 'Askatasuna', lang: 'Basque' }
    },
    Saturday: {
      start: { word: 'Libertad',   lang: 'Spanish' },
      lunch: { word: 'Liberdade',  lang: 'Portuguese' },
      end:   { word: 'Vabadus',    lang: 'Estonian' }
    },
    Sunday: {
      start: { word: 'Uhuru',      lang: 'Swahili' },
      lunch: { word: 'Freiheit',   lang: 'German' },
      end:   { word: 'Inkululeko', lang: 'Zulu' }
    }
  };

  var FREEDOM_COLUMNS = ['start', 'lunch', 'end'];

  function freedomEntry(day, column) {
    var row = FREEDOM[day] || FREEDOM.Sunday;
    return row[column] || row.start;
  }

  function freedomFor(day, column) {
    return freedomEntry(day, column || 'start').word;
  }

  function freedomTitle(day, column) {
    var f = freedomEntry(day, column || 'start');
    return f.word + ' — freedom in ' + f.lang;
  }

  var MILESTONES = [30, 15, 10, 5]; // minutes remaining

  var state = load();
  var firedAlerts = {}; // key -> true, reset each day

  /* ─────────────────────────── Storage ─────────────────────────── */

  function load() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      saved = {};
    }
    return normalise(saved);
  }

  /* Validate anything arriving from storage or the server before trusting it. */
  function normalise(saved) {
    saved = saved || {};
    var schedule = {};
    DAYS.forEach(function (day) {
      var base = DEFAULT_SCHEDULE[day];
      var got = (saved.schedule || {})[day] || {};
      /* "Head Home" is per day AND per slot: some days the hard part is
         stopping for lunch, other days it is leaving at all. A single
         global switch could not express that. */
      // Coerced: the bare && yields undefined on a fresh install, which then
      // serialises as a missing key rather than an explicit false.
      var legacy = !!(saved.settings && saved.settings.includeHeadHome === true);

      schedule[day] = {
        working: typeof got.working === 'boolean' ? got.working : base.working,
        start: isMinute(got.start) ? got.start : base.start,
        lunch: got.lunch === null || isMinute(got.lunch) ? got.lunch : base.lunch,
        end: got.end === null || isMinute(got.end) ? got.end : base.end,
        lunchHeadHome: typeof got.lunchHeadHome === 'boolean' ? got.lunchHeadHome : legacy,
        endHeadHome: typeof got.endHeadHome === 'boolean' ? got.endHeadHome : legacy
      };
    });
    var settings = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      settings[k] = saved.settings && k in saved.settings ? saved.settings[k] : DEFAULT_SETTINGS[k];
    });
    if (THEMES.indexOf(settings.theme) === -1) settings.theme = DEFAULT_SETTINGS.theme;
    if (URGENT_CHOICES.indexOf(settings.urgentMinutes) === -1) {
      settings.urgentMinutes = DEFAULT_SETTINGS.urgentMinutes;
    }

    if (typeof settings.lunchLabel !== 'string' || !settings.lunchLabel.trim()) {
      settings.lunchLabel = DEFAULT_SETTINGS.lunchLabel;
    }
    settings.lunchLabel = settings.lunchLabel.trim().slice(0, 30);

    return {
      schedule: schedule,
      settings: settings,
      appointments: normaliseAppointments(saved.appointments),
      /* Derived from the server, cached locally so the countdown survives
         going offline. Never pushed back up — the feed is the source. */
      calendarEvents: normaliseCalendarEvents(saved.calendarEvents),
      updatedAt: typeof saved.updatedAt === 'number' ? saved.updatedAt : 0
    };
  }

  function normaliseCalendarEvents(list) {
    if (!Array.isArray(list)) return [];
    var floor = Date.now() - 86400000;

    return list.filter(function (event) {
      return event &&
        typeof event.title === 'string' &&
        typeof event.at === 'number' &&
        isFinite(event.at) &&
        event.at > floor;
    }).map(function (event) {
      return {
        uid: typeof event.uid === 'string' ? event.uid : 'cal',
        title: event.title.slice(0, 200),
        at: event.at,
        allDay: Boolean(event.allDay)
      };
    }).sort(function (a, b) { return a.at - b.at; }).slice(0, 300);
  }

  /* Appointments arrive from storage or another device, so nothing here is
     trusted. Anything malformed is dropped rather than allowed to break a
     render loop that runs every second. */
  function normaliseAppointments(list) {
    if (!Array.isArray(list)) return [];

    var cutoff = isoDate(new Date(Date.now() - 7 * 86400000));

    return list.filter(function (item) {
      return item &&
        typeof item.title === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        isMinute(item.time) &&
        item.date >= cutoff;              // quietly forget the distant past
    }).map(function (item) {
      return {
        id: typeof item.id === 'string' ? item.id : makeId(),
        title: item.title.slice(0, 80),
        date: item.date,
        time: item.time
      };
    }).sort(function (a, b) {
      return (a.date + a.time) < (b.date + b.time) ? -1 : 1;
    }).slice(0, 200);                     // a sane upper bound
  }

  function makeId() {
    return 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function isoDate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save — device storage is unavailable.');
    }
  }

  /* Every local edit stamps updatedAt and queues a sync push.
     Changes arriving from the server pass { fromSync: true } so they
     are stored without being echoed straight back up. */
  function save(options) {
    options = options || {};
    if (!options.fromSync) state.updatedAt = Date.now();
    persist();
    if (!options.fromSync && CT.sync) CT.sync.notifyLocalChange();
    if (CT.notify) CT.notify.syncScheduleToWorker(state);
  }

  function isMinute(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 && v < 1440;
  }

  /* ─────────────────────────── Time helpers ─────────────────────────── */

  function minutesToHHMM(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return pad(h) + ':' + pad(m);
  }

  function hhmmToMinutes(str) {
    var parts = String(str).split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (!isFinite(h) || !isFinite(m)) return null;
    return h * 60 + m;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* Format minutes-past-midnight for display, honouring the 12/24h setting. */
  function formatClock(mins) {
    if (mins === null || mins === undefined) return '—';
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    if (state.settings.clock24) return pad(h) + ':' + pad(m);
    var suffix = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + pad(m) + ' ' + suffix;
  }

  /* Seconds are simply on or off, everywhere. Moving them between surfaces
     was clever and confusing — the setting should mean what it says. */
  function formatNowTime(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var seconds = state.settings.showSeconds ? ':' + pad(date.getSeconds()) : '';

    if (state.settings.clock24) return pad(h) + ':' + pad(m) + seconds;
    var suffix = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + pad(m) + seconds + ' ' + suffix;
  }

  /* ─────────────────────────── Onboarding ───────────────────────────
     One panel, dismissible, never a wizard. A multi-step setup flow is
     friction at exactly the moment someone is deciding whether this is
     worth the effort. */

  function renderWelcome() {
    var panel = $('welcome');
    if (panel) panel.hidden = !!state.settings.onboarded;
  }

  function completeOnboarding() {
    if (state.settings.onboarded) return;
    state.settings.onboarded = true;
    save();
    renderWelcome();
  }

  $('welcomeDismiss').addEventListener('click', completeOnboarding);
  $('welcomeSetup').addEventListener('click', completeOnboarding);

  /* ─────────────────────── Screen reader announcements ───────────────────
     The dials update every second, but a live region that fired every
     second would make the app unusable with a screen reader. This speaks
     only when the minute changes. */

  var lastAnnounced = '';

  function announceRemaining() {
    var region = $('srClock');
    if (!region) return;

    var parts = [];
    [['lunch', lunchLabel()], ['end', endLabel()], ['appt', 'Next appointment']]
      .forEach(function (pair) {
        var big = $(pair[0] + 'Big');
        var card = $(pair[0] === 'lunch' ? 'cardLunch' : pair[0] === 'end' ? 'cardEnd' : 'cardAppt');
        if (!big || !card || card.classList.contains('is-off')) return;
        if (pair[0] === 'appt' && !$('apptEmpty').hidden) return;
        parts.push(pair[1] + ': ' + big.textContent + ' remaining');
      });

    var message = parts.join('. ');
    if (message && message !== lastAnnounced) {
      lastAnnounced = message;
      region.textContent = message;
    }
  }

  /* ─────────────────────────── Theme ───────────────────────────
     The stylesheet treats "not light" as dark, so light is the only value
     that needs setting. That way the page is already dark before any of
     this runs, and there is no white flash on load. */

  var systemLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function applyTheme() {
    var choice = state.settings.theme;
    var light = choice === 'light' || (choice === 'system' && systemLight && systemLight.matches);

    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');

    // Keep the browser chrome in step with the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#32493C' : '#1C1024');
  }

  if (systemLight && systemLight.addEventListener) {
    systemLight.addEventListener('change', function () {
      if (state.settings.theme === 'system') applyTheme();
    });
  }

  /* Display names. "Head Home" is appended per day and per slot, so the
     label follows whichever day is actually being shown. */
  function lunchLabel(day) {
    var base = state.settings.lunchLabel || 'Lunch';
    var cfg = state.schedule[day || dayNameOf(new Date())];
    return (cfg && cfg.lunchHeadHome) ? base + ' | Head Home' : base;
  }

  function endLabel(day) {
    var cfg = state.schedule[day || dayNameOf(new Date())];
    return (cfg && cfg.endHeadHome) ? 'End of Day | Head Home' : 'End of Day';
  }

  /* Two flavours of label. The composed one carries today's "Head Home"
     and belongs on the dashboard. Table headings use the plain name,
     because "Head Home" now has a column of its own and varies by day. */
  function applyLunchLabel() {
    var base = state.settings.lunchLabel || 'Lunch';
    $$('[data-lunch-label]').forEach(function (el) { el.textContent = lunchLabel(); });
    $$('[data-end-label]').forEach(function (el) { el.textContent = endLabel(); });
    $$('[data-lunch-name]').forEach(function (el) { el.textContent = base; });
    $$('[data-end-name]').forEach(function (el) { el.textContent = 'End of Day'; });
  }

  /* Day before month, spelled out: "Saturday, 1 August 2026". Left to the
     browser's own locale this became "August 1, 2026" on a US-defaulted
     machine, which is a small daily friction for no reason. */
  var LOCALE = 'en-AU';

  /* Composed rather than formatted: en-AU renders "Saturday 1 August 2026"
     with no comma, and the pause after the weekday makes it easier to scan. */
  function formatLongDate(date) {
    var weekday = date.toLocaleDateString(LOCALE, { weekday: 'long' });
    var rest = date.toLocaleDateString(LOCALE, {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    return weekday + ', ' + rest;
  }

  /* Human phrasing that mirrors the workbook: "2 hours 23 minutes". */
  function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return '0 minutes';
    var withSeconds = state.settings.showSeconds;
    var totalMinutes = withSeconds
      ? Math.floor(totalSeconds / 60)
      : Math.ceil(totalSeconds / 60);
    var h = Math.floor(totalMinutes / 60);
    var m = totalMinutes % 60;
    var s = totalSeconds % 60;

    var bits = [];
    if (h > 0) bits.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m > 0 || h > 0) bits.push(m + (m === 1 ? ' minute' : ' minutes'));
    if (withSeconds && h === 0) bits.push(s + (s === 1 ? ' second' : ' seconds'));
    if (!bits.length) bits.push('0 minutes');
    return bits.join(' ');
  }

  /* Compact readout for the dial centre: 2:23:04 or 2:23. */
  function formatCompact(totalSeconds) {
    if (totalSeconds <= 0) return '0:00';
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor(totalSeconds / 60) % 60;
    var s = totalSeconds % 60;
    if (state.settings.showSeconds) {
      return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }
    var mUp = Math.ceil(totalSeconds / 60);
    return Math.floor(mUp / 60) + ':' + pad(mUp % 60);
  }

  function dayNameOf(date) {
    return DAYS[(date.getDay() + 6) % 7]; // JS Sunday=0 → our Monday-first list
  }

  function secondsSinceMidnight(date) {
    return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  }

  /* ─────────────────────────── Timer maths ───────────────────────────
     Mirrors the workbook: total = target − start (wrapping past midnight),
     elapsed is clamped into [0, total], remaining is the difference.       */

  function computeTimer(now, startMin, targetMin) {
    if (!isMinute(startMin) || !isMinute(targetMin)) {
      return { available: false };
    }
    var startSec = startMin * 60;
    var targetSec = targetMin * 60;
    var totalSec = targetSec - startSec;
    if (totalSec <= 0) totalSec += 86400; // wraps past midnight

    var nowSec = secondsSinceMidnight(now);
    var sinceStart = nowSec - startSec;
    if (sinceStart < -43200) sinceStart += 86400; // late-night shift still counting

    var elapsedSec = Math.min(Math.max(sinceStart, 0), totalSec);
    var remainingSec = totalSec - elapsedSec;

    return {
      available: true,
      totalSec: totalSec,
      elapsedSec: elapsedSec,
      remainingSec: remainingSec,
      notStarted: sinceStart < 0,
      done: remainingSec <= 0,
      progress: totalSec > 0 ? elapsedSec / totalSec : 1
    };
  }

  /* ─────────────────────────── Appointments ───────────────────────────

     The pie needs a meaningful "full". A meeting has no natural start the
     way a work day does, so it uses a fixed focus window instead: the pie
     sits full while the appointment is further away than the window, then
     drains through it. That keeps a full pie meaning the same thing every
     time, which is the whole point of reading it spatially. */

  function appointmentDate(appointment) {
    var parts = appointment.date.split('-');
    return new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
      Math.floor(appointment.time / 60),
      appointment.time % 60,
      0, 0
    );
  }

  /* The soonest thing ahead of us, from either source. Manual entries and
     synced calendar events are treated identically once here — the pie
     does not care where a commitment came from.

     All-day events are excluded on purpose: "counting down to today" is
     not a useful countdown, and they would otherwise crowd out real
     meetings for the whole day. */
  function nextAppointment(now) {
    var soonest = null;
    var soonestAt = Infinity;
    var nowMs = now.getTime();

    function consider(title, at, source, id) {
      if (at > nowMs && at < soonestAt) {
        soonest = { title: title, at: at, source: source, id: id };
        soonestAt = at;
      }
    }

    state.appointments.forEach(function (appointment) {
      consider(appointment.title, appointmentDate(appointment).getTime(),
               'manual', appointment.id);
    });

    state.calendarEvents.forEach(function (event) {
      if (event.allDay) return;
      consider(event.title, event.at, 'calendar', event.uid);
    });

    return soonest;
  }

  /* The appointment pie rescales as it approaches, rather than sitting
     uselessly full for days. Three tiers, each starting a fresh pie:

       more than a day away  → the pie is N whole days, one notch per day
       within 24 hours       → the pie restarts as 24 hours
       within the last hour  → the pie restarts as 60 minutes

     So a full pie always means "a whole unit to go", and the unit is
     named underneath rather than left to be guessed. */
  function computeAppointmentTimer(now, appointment) {
    if (!appointment) return { available: false };

    var remainingSec = Math.round((appointment.at - now.getTime()) / 1000);
    if (remainingSec <= 0) return { available: false };

    var remainingMin = remainingSec / 60;
    var scaleMin, tier, forcedInterval;

    if (remainingMin > 1440) {
      scaleMin = Math.ceil(remainingMin / 1440) * 1440;
      tier = 'days';
      forcedInterval = 1440;                 // one notch per day
    } else if (remainingMin > 60) {
      scaleMin = 1440;
      tier = 'hours';
      forcedInterval = null;
    } else {
      scaleMin = 60;
      tier = 'minutes';
      forcedInterval = null;
    }

    return {
      available: true,
      remainingSec: remainingSec,
      scaleMin: scaleMin,
      tier: tier,
      forcedInterval: forcedInterval,
      progress: 1 - (remainingMin / scaleMin),
      done: false
    };
  }

  /* Zero means the warning is switched off entirely, so a timer never
     escalates no matter how little is left. */
  function isUrgent(remainingSec) {
    var minutes = state.settings.urgentMinutes;
    return minutes > 0 && remainingSec <= minutes * 60;
  }

  function tierCaption(timer) {
    if (timer.tier === 'days') {
      var days = Math.round(timer.scaleMin / 1440);
      return days === 1 ? 'over 1 day' : 'over ' + days + ' days';
    }
    return timer.tier === 'hours' ? 'over 24 hours' : 'within the hour';
  }

  function renderAppointment(now, todayKey) {
    var appointment = nextAppointment(now);
    var timer = computeAppointmentTimer(now, appointment);
    var card = $('cardAppt');

    $('apptBody').hidden = !timer.available;
    $('apptEmpty').hidden = timer.available;

    if (!timer.available) {
      $('apptChip').textContent = 'None';
      $('apptPie').setAttribute('d', '');
      renderNotchPair('appt', 0);
      card.classList.remove('is-urgent');
      return;
    }

    var when = new Date(appointment.at);
    var sameDay = isoDate(when) === isoDate(now);

    $('apptChip').textContent = formatClock(when.getHours() * 60 + when.getMinutes());
    $('apptPie').setAttribute('d', wedgePath(1 - timer.progress));
    renderNotchPair('appt', timer.scaleMin, timer.forcedInterval);
    $('apptBig').textContent = formatCompact(timer.remainingSec);
    $('apptSmall').textContent = (sameDay
      ? 'until ' + appointment.title
      : when.toLocaleDateString(LOCALE, { weekday: 'long' }) + ' — ' + appointment.title)
      + ' · ' + tierCaption(timer);

    $('apptStatus').textContent = appointment.title + ' | ' +
      formatDuration(timer.remainingSec) + ' away';

    card.classList.toggle('is-urgent', isUrgent(timer.remainingSec));

    checkAppointmentAlerts(appointment, timer, todayKey);
  }

  /* Same milestone ladder as the work-day timers, keyed per appointment
     so two meetings on the same day cannot share a fired flag. */
  function checkAppointmentAlerts(appointment, timer, todayKey) {
    if (!state.settings.alerts) return;

    var remainingMin = Math.ceil(timer.remainingSec / 60);

    MILESTONES.forEach(function (mark) {
      var key = todayKey + '|appt|' + appointment.id + '|' + mark;
      if (firedAlerts[key]) return;
      if (remainingMin <= mark && remainingMin > mark - 1) {
        firedAlerts[key] = true;
        notify(appointment.title, mark + ' minutes away.',
               tagFor(todayKey, 'appt-' + appointment.id, mark));
      }
    });
  }

  /* One pattern for every "not switched on yet" message: first what the
     person can see and do, then the owner's setup step, marked as such.
     A developer instruction should never be the first thing a user reads,
     because it looks like an error they have no way to act on. */
  function setUnavailable(el, plain, setup) {
    if (!el) return;
    el.textContent = '';

    var line = document.createElement('span');
    line.textContent = plain;
    el.appendChild(line);

    if (setup) {
      var note = document.createElement('span');
      note.className = 'setup-note';
      note.textContent = setup;
      el.appendChild(note);
    }
  }

  /* ─────────────────────────── DOM shortcuts ─────────────────────────── */

  function $(id) { return document.getElementById(id); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ─────────────────────────── Tabs ─────────────────────────── */

  function showView(name, moveFocus) {
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.id === 'view-' + name); });

    $$('.tab').forEach(function (t) {
      var on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      /* Roving tabindex: only the selected tab is in the tab order, so Tab
         moves past the whole bar rather than through every tab. */
      t.setAttribute('tabindex', on ? '0' : '-1');
      if (on && moveFocus) t.focus();
    });
  }

  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () { showView(t.dataset.view); });
  });

  /* Arrow keys along the bar, Home/End to the ends — the keyboard contract
     a tablist promises the moment it claims that role. */
  $('tabList').addEventListener('keydown', function (event) {
    var keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (keys.indexOf(event.key) === -1) return;

    var tabs = $$('.tab');
    var current = tabs.indexOf(document.activeElement);
    if (current === -1) return;

    var next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else next = (current - 1 + tabs.length) % tabs.length;

    event.preventDefault();
    showView(tabs[next].dataset.view, true);
  });
  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.goto); });
  });

  /* ─────────────────────────── Schedule editor ─────────────────────────── */

  function buildScheduleEditor() {
    var body = $('scheduleBody');
    body.innerHTML = '';

    DAYS.forEach(function (day) {
      var cfg = state.schedule[day];
      var tr = document.createElement('tr');

      var tdWork = document.createElement('td');
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = cfg.working;
      chk.setAttribute('aria-label', 'Working on ' + day);
      tdWork.appendChild(chk);

      var tdDay = document.createElement('td');
      tdDay.className = 'day-name';
      tdDay.textContent = day;

      var inputs = {};
      var homeBoxes = {};
      var HOME_FLAG = { lunch: 'lunchHeadHome', end: 'endHeadHome' };

      ['start', 'lunch', 'end'].forEach(function (field) {
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'time';
        input.value = isMinute(cfg[field]) ? minutesToHHMM(cfg[field]) : '';
        input.disabled = !cfg.working;
        input.setAttribute('aria-label', day + ' ' + field + ' time');
        input.addEventListener('change', function () {
          state.schedule[day][field] = input.value ? hhmmToMinutes(input.value) : null;
          save();
          completeOnboarding();
          render();
          flashSaved();
        });
        inputs[field] = input;
        td.appendChild(input);

        tr.appendChild(td);

        /* Each stopping point gets a "Head Home" column of its own — the day
           you struggle to break for lunch is not always the day you struggle
           to leave. The column heading carries the words, so the cell needs
           only the box. */
        if (HOME_FLAG[field]) {
          var flag = HOME_FLAG[field];
          var homeTd = document.createElement('td');
          homeTd.className = 'home-cell';

          var box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = !!cfg[flag];
          box.disabled = !cfg.working;
          box.setAttribute('aria-label',
            'Add Head Home to ' + day + ' ' + (field === 'lunch' ? 'lunch' : 'end of day'));
          box.addEventListener('change', function () {
            state.schedule[day][flag] = box.checked;
            save();
            applyLunchLabel();
            render();
            flashSaved();
          });

          homeTd.appendChild(box);
          tr.appendChild(homeTd);
          homeBoxes[field] = box;
        }
      });

      chk.addEventListener('change', function () {
        state.schedule[day].working = chk.checked;
        completeOnboarding();
        Object.keys(inputs).forEach(function (k) { inputs[k].disabled = !chk.checked; });
        Object.keys(homeBoxes).forEach(function (k) { homeBoxes[k].disabled = !chk.checked; });
        save();
        applyLunchLabel();
        render();
        flashSaved();
      });

      tr.insertBefore(tdDay, tr.firstChild);
      tr.insertBefore(tdWork, tr.firstChild);
      body.appendChild(tr);
    });
  }

  var savedTimer;
  function flashSaved() {
    var el = $('scheduleSaved');
    el.textContent = 'Saved.';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { el.textContent = 'Changes save automatically.'; }, 1800);
  }

  $('resetSchedule').addEventListener('click', function () {
    DAYS.forEach(function (day) {
      state.schedule[day] = Object.assign({}, DEFAULT_SCHEDULE[day]);
    });
    save();
    buildScheduleEditor();
    render();
    toast('Weekly schedule restored to defaults.');
  });

  /* ─────────────────────────── Appointments editor ─────────────────────────── */

  function buildAppointmentList() {
    var list = $('apptList');
    var now = new Date();
    var today = isoDate(now);

    // Manual entries and synced events in one list, ordered by when they
    // happen — that is how the day is actually experienced.
    var upcoming = state.appointments.filter(function (appointment) {
      return appointmentDate(appointment).getTime() > now.getTime();
    }).map(function (appointment) {
      return {
        at: appointmentDate(appointment).getTime(),
        title: appointment.title,
        source: 'manual',
        id: appointment.id
      };
    });

    state.calendarEvents.forEach(function (event) {
      if (event.at <= now.getTime()) return;
      upcoming.push({
        at: event.at, title: event.title, source: 'calendar',
        id: event.uid, allDay: event.allDay
      });
    });

    upcoming.sort(function (a, b) { return a.at - b.at; });

    list.innerHTML = '';
    $('apptEmptyNote').hidden = upcoming.length > 0;

    upcoming.forEach(function (item) {
      var when = new Date(item.at);
      var li = document.createElement('li');
      li.className = 'appt-item';

      var text = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = item.title;
      if (item.source === 'calendar') {
        var tag = document.createElement('em');
        tag.className = 'appt-tag';
        tag.textContent = item.allDay ? 'all day' : 'calendar';
        title.appendChild(tag);
      }

      var meta = document.createElement('span');
      meta.textContent = (isoDate(when) === today
        ? 'Today'
        : when.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" })
      ) + (item.allDay ? '' : ' at ' + formatClock(when.getHours() * 60 + when.getMinutes()));

      text.appendChild(title);
      text.appendChild(meta);
      li.appendChild(text);

      // Synced events belong to the calendar, so they are read-only here.
      if (item.source === 'manual') {
        var remove = document.createElement('button');
        remove.className = 'btn btn-quiet';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + item.title);
        remove.addEventListener('click', function () {
          state.appointments = state.appointments.filter(function (a) {
            return a.id !== item.id;
          });
          save();
          buildAppointmentList();
          render();
        });
        li.appendChild(remove);
      }

      list.appendChild(li);
    });
  }

  $('apptForm').addEventListener('submit', function (event) {
    event.preventDefault();

    var title = $('apptTitle').value.trim();
    var date = $('apptDate').value;
    var time = hhmmToMinutes($('apptTime').value);
    var error = $('apptError');

    if (!title) { error.textContent = 'Give it a name so you know what is coming.'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { error.textContent = 'Pick a date.'; return; }
    if (!isMinute(time)) { error.textContent = 'Pick a time.'; return; }

    var appointment = { id: makeId(), title: title, date: date, time: time };

    if (appointmentDate(appointment).getTime() <= Date.now()) {
      error.textContent = 'That time has already passed.';
      return;
    }

    error.textContent = '';
    state.appointments = normaliseAppointments(state.appointments.concat([appointment]));
    save();

    $('apptTitle').value = '';
    $('apptTitle').focus();

    buildAppointmentList();
    render();
    toast('Added — counting down on the Dashboard.');
  });

  /* Default the form to today so adding something takes two fields, not three. */
  function primeAppointmentForm() {
    var now = new Date();
    if (!$('apptDate').value) $('apptDate').value = isoDate(now);
  }

  /* ─────────────────────────── Calendar sync ─────────────────────────── */

  var calendarFeeds = [];

  function calendarMessage(text, isError) {
    var el = $('calendarMessage');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  /* Decide which of the four states the panel is in and show only that. */
  function renderCalendarPanel() {
    var unavailable = $('calendarUnavailable');
    var form = $('calendarForm');
    var connected = $('calendarConnected');
    var planChip = $('calendarPlanChip');
    var help = $('calendarHelp');

    var reason = null;
    var setupNote = null;
    if (!CT.config.isConfigured) {
      reason = 'Calendar sync is not switched on yet. Everything else on this ' +
               'page works as normal, and you can still add appointments by hand.';
      setupNote = 'Setup: add your Supabase project details to config.js. See the README.';
    } else if (!CT.auth.isSignedIn()) {
      reason = 'Sign in on the Account tab to connect a calendar.';
    } else if (!CT.billing.isEntitled()) {
      reason = 'Calendar sync is included with a plan. Manual appointments above ' +
               'stay free.';
    }

    planChip.hidden = !CT.billing.enabled();
    unavailable.hidden = !reason;
    if (reason) setUnavailable(unavailable, reason, setupNote);

    form.hidden = Boolean(reason);
    help.hidden = Boolean(reason);
    connected.hidden = Boolean(reason) || calendarFeeds.length === 0;

    // Offer the one-click path only when no live Google connection exists.
    var hasLiveGoogle = calendarFeeds.some(function (feed) {
      return feed.kind === 'google' && feed.has_google;
    });
    $('googleConnect').hidden = Boolean(reason) || hasLiveGoogle;

    if (!reason) renderCalendarFeeds();
  }

  /* ── Google one-click ── */

  function connectGoogleCalendar() {
    calendarMessage('Redirecting to Google…');
    CT.auth.connectGoogleCalendar();
  }

  /* Runs once on the return leg from Google's consent screen. */
  function finishGoogleConnect() {
    var redirect = CT.pendingRedirect;
    if (!CT.auth.wasConnectingGoogle()) return;

    var token = redirect && redirect.providerRefreshToken;
    if (!token) {
      calendarMessage(
        'Google did not hand back a long-lived token. Remove Pie Timers ' +
        'from your Google account permissions, then try connecting again.', true);
      showView('schedule');
      return;
    }

    calendarMessage('Connecting your calendar…');
    showView('schedule');

    var user = CT.auth.getUser();
    CT.db.connectGoogle(token, user && user.email).then(function () {
      return loadCalendar();
    }).then(function () {
      var google = calendarFeeds.filter(function (f) { return f.kind === 'google'; })[0];
      if (!google) { calendarMessage('Connected.'); return null; }
      calendarMessage('Connected. Fetching your events…');
      return CT.db.syncCalendarFeed(google.id).then(function (result) {
        if (result && result.ok === false) calendarMessage(result.error, true);
        else calendarMessage('Google Calendar connected.');
        return loadCalendar();
      });
    }).catch(function (err) {
      calendarMessage(err.message, true);
    });
  }

  function renderCalendarFeeds() {
    var host = $('calendarFeedRows');
    host.innerHTML = '';

    calendarFeeds.forEach(function (feed) {
      var row = document.createElement('div');
      row.className = 'sync-row';

      var text = document.createElement('div');
      var name = document.createElement('strong');
      name.textContent = feed.label;

      if (feed.kind === 'google' && feed.google_account_email) {
        var account = document.createElement('em');
        account.className = 'appt-tag';
        account.textContent = 'Google';
        name.appendChild(account);
      }

      var meta = document.createElement('span');
      if (feed.kind === 'google' && !feed.has_google) {
        // The grant died; syncing is off until they reconnect.
        meta.textContent = feed.last_error ||
          'Google access has expired. Reconnect to restore it.';
        meta.className = 'is-error';
      } else if (feed.last_error) {
        meta.textContent = feed.last_error;
        meta.className = 'is-error';
      } else if (feed.last_synced) {
        meta.textContent = feed.event_count + ' event' +
          (feed.event_count === 1 ? '' : 's') + ' — updated ' +
          new Date(feed.last_synced).toLocaleTimeString(LOCALE);
      } else {
        meta.textContent = 'Not synced yet.';
      }

      text.appendChild(name);
      text.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'row-actions';

      var needsReconnect = feed.kind === 'google' && !feed.has_google;

      var refresh = document.createElement('button');
      refresh.className = 'btn btn-quiet';
      refresh.type = 'button';
      refresh.textContent = needsReconnect ? 'Reconnect' : 'Refresh';

      // Decide the behaviour before attaching, so only one handler exists.
      refresh.addEventListener('click', needsReconnect ? connectGoogleCalendar : function () {
        refresh.disabled = true;
        refresh.textContent = 'Syncing…';
        CT.db.syncCalendarFeed(feed.id).then(function (result) {
          if (result && result.ok === false) calendarMessage(result.error, true);
          else calendarMessage('');
          return loadCalendar();
        }).catch(function (err) {
          calendarMessage(err.message, true);
        }).then(function () {
          refresh.disabled = false;
          refresh.textContent = 'Refresh';
        });
      });

      var remove = document.createElement('button');
      remove.className = 'btn btn-quiet';
      remove.type = 'button';
      remove.textContent = 'Disconnect';
      remove.addEventListener('click', function () {
        // For Google this also revokes the grant at Google's end, which is
        // what "disconnect" ought to mean.
        var action = feed.kind === 'google'
          ? CT.db.disconnectGoogle()
          : CT.db.removeCalendarFeed(feed.id);

        action.then(function () {
          calendarMessage('Calendar disconnected.');
          state.calendarEvents = [];
          save({ fromSync: true });
          return loadCalendar();
        }).then(function () {
          buildAppointmentList();
          render();
        }).catch(function (err) { calendarMessage(err.message, true); });
      });

      actions.appendChild(refresh);
      actions.appendChild(remove);
      row.appendChild(text);
      row.appendChild(actions);
      host.appendChild(row);
    });
  }

  /* Pull both the feed list and the expanded events the server holds. */
  function loadCalendar() {
    if (!CT.config.isConfigured || !CT.auth.isSignedIn() || !CT.billing.isEntitled()) {
      return Promise.resolve(false);
    }

    return CT.db.listCalendarFeeds().then(function (feeds) {
      calendarFeeds = feeds || [];
      return calendarFeeds.length ? CT.db.listCalendarEvents() : [];
    }).then(function (events) {
      state.calendarEvents = normaliseCalendarEvents((events || []).map(function (row) {
        return {
          uid: row.uid,
          title: row.title,
          at: Date.parse(row.starts_at),
          allDay: row.all_day
        };
      }));
      save({ fromSync: true });     // cache only; not synced state
      renderCalendarPanel();
      buildAppointmentList();
      render();
      return true;
    }).catch(function (err) {
      calendarMessage(err.message, true);
      return false;
    });
  }

  $('googleCalendarBtn').addEventListener('click', connectGoogleCalendar);

  $('calendarForm').addEventListener('submit', function (event) {
    event.preventDefault();

    var url = $('calendarUrl').value.trim();
    var label = $('calendarLabel').value.trim() || 'My calendar';
    var button = $('calendarAdd');

    if (!url) { calendarMessage('Paste your calendar address first.', true); return; }
    if (!/^(https?:\/\/|webcal:\/\/)/i.test(url)) {
      calendarMessage('That should start with https:// or webcal://', true);
      return;
    }

    button.disabled = true;
    calendarMessage('Connecting…');

    CT.db.addCalendarFeed(label, url).then(function (feed) {
      $('calendarUrl').value = '';
      $('calendarLabel').value = '';
      calendarMessage('Connected. Fetching your events…');
      return CT.db.syncCalendarFeed(feed.id);
    }).then(function (result) {
      if (result && result.ok === false) calendarMessage(result.error, true);
      else calendarMessage('Calendar connected.');
      return loadCalendar();
    }).catch(function (err) {
      calendarMessage(err.message, true);
    }).then(function () {
      button.disabled = false;
    });
  });

  /* ─────────────────────────── Weekly preview table ─────────────────────────── */

  function renderWeekPreview(today) {
    var body = $('weekPreview').querySelector('tbody');
    body.innerHTML = '';

    DAYS.forEach(function (day) {
      var cfg = state.schedule[day];
      var tr = document.createElement('tr');
      if (day === today) tr.className = 'is-today';
      else if (!cfg.working) tr.className = 'is-off';

      var cells = cfg.working
        ? [day, formatClock(cfg.start), formatClock(cfg.lunch), formatClock(cfg.end)]
        : [day, freedomFor(day, 'start'), freedomFor(day, 'lunch'), freedomFor(day, 'end')];

      cells.forEach(function (text, i) {
        var td = document.createElement('td');
        if (i === 0) td.className = 'day-name';
        else if (!cfg.working) {
          td.className = 'is-freedom';
          td.title = freedomTitle(day, FREEDOM_COLUMNS[i - 1]);   // names the language
        }
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  /* ─────────────────────────── Dial rendering ───────────────────────────
     A solid reducing pie, not a ring. The whole point is that the filled
     *area* shrinks, so remaining time can be judged at a glance without
     reading any numbers — the Time Timer principle. An arc-length ring
     only thins at the rim and loses that. */

  /* Point on the dial rim, measured clockwise from 12 o'clock. */
  function pointOnDial(fraction) {
    var angle = fraction * 2 * Math.PI;
    return {
      x: DIAL_CX + DIAL_R * Math.sin(angle),
      y: DIAL_CY - DIAL_R * Math.cos(angle)
    };
  }

  /* The wedge of time still LEFT.

     It empties clockwise: the gap opens at 12 o'clock and grows round to
     the right, so the surviving wedge runs from the elapsed boundary all
     the way back to 12. Zero therefore always sits at 12 o'clock, which
     is what makes the notches below mean something fixed. */
  function wedgePath(remainingFraction) {
    if (remainingFraction <= 0) return '';

    // A single arc cannot express 360°, so a full pie is drawn as two halves.
    if (remainingFraction >= 0.99999) {
      return 'M ' + DIAL_CX + ' ' + (DIAL_CY - DIAL_R) +
             ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 1 1 ' + DIAL_CX + ' ' + (DIAL_CY + DIAL_R) +
             ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 1 1 ' + DIAL_CX + ' ' + (DIAL_CY - DIAL_R) + ' Z';
    }

    var start = pointOnDial(1 - remainingFraction);   // the eaten boundary
    var largeArc = remainingFraction > 0.5 ? 1 : 0;

    return 'M ' + DIAL_CX + ' ' + DIAL_CY +
           ' L ' + start.x.toFixed(3) + ' ' + start.y.toFixed(3) +
           ' A ' + DIAL_R + ' ' + DIAL_R + ' 0 ' + largeArc + ' 1 ' +
           DIAL_CX + ' ' + (DIAL_CY - DIAL_R) + ' Z';
  }

  /* ── Notches ──
     The rim marks are the timer's own units, not decoration. A 3h30
     timer becomes seven 30-minute pieces; every second notch away from
     zero — the hour marks — is drawn heavier. Counting is anchored at
     zero (12 o'clock) so "two big notches to go" always means two hours,
     whatever the total length. */

  /* Bands rather than "smallest that fits", because the unit has to be one
     a person already thinks in. A 90-minute timer wants quarter-hours, not
     the ten-minute pieces an arithmetic rule would choose. */
  var NOTCH_BANDS = [
    { upTo: 20,   interval: 2 },
    { upTo: 75,   interval: 5 },
    { upTo: 180,  interval: 15 },
    { upTo: 360,  interval: 30 },
    { upTo: 720,  interval: 60 },
    { upTo: 1440, interval: 120 }
  ];

  function notchInterval(totalMinutes) {
    for (var i = 0; i < NOTCH_BANDS.length; i++) {
      if (totalMinutes <= NOTCH_BANDS[i].upTo) return NOTCH_BANDS[i].interval;
    }
    return 1440;   // days
  }

  /* Two layers per dial: one beneath the wedge and one above it. A single
     layer can only be readable against one of the two backgrounds, and the
     notches you most need to count are the ones still inside the pie. */
  function renderNotchPair(prefix, totalMinutes, forcedInterval) {
    renderNotches($(prefix + 'Ticks'), totalMinutes, forcedInterval);
    renderNotches($(prefix + 'TicksOver'), totalMinutes, forcedInterval);
  }

  /* Rebuilt only when the duration actually changes — this runs every second. */
  function renderNotches(group, totalMinutes, forcedInterval) {
    if (!group) return;

    if (!isFinite(totalMinutes) || totalMinutes <= 0) {
      if (group.dataset.sig !== 'none') { group.textContent = ''; group.dataset.sig = 'none'; }
      return;
    }

    var interval = forcedInterval || notchInterval(totalMinutes);
    var signature = totalMinutes + '/' + interval;
    if (group.dataset.sig === signature) return;

    group.textContent = '';
    group.dataset.sig = signature;

    var count = Math.floor(totalMinutes / interval);
    for (var k = 1; k <= count; k++) {
      var minutesToGo = k * interval;
      if (minutesToGo >= totalMinutes) break;      // the rim itself is zero

      var fraction = 1 - (minutesToGo / totalMinutes);
      var major = k % 2 === 0;                     // every second one, away from zero
      var outer = pointOnDial(fraction);
      var innerR = DIAL_R - (major ? 11 : 6);
      var angle = fraction * 2 * Math.PI;

      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', outer.x.toFixed(2));
      line.setAttribute('y1', outer.y.toFixed(2));
      line.setAttribute('x2', (DIAL_CX + innerR * Math.sin(angle)).toFixed(2));
      line.setAttribute('y2', (DIAL_CY - innerR * Math.cos(angle)).toFixed(2));
      if (major) line.setAttribute('class', 'is-major');
      group.appendChild(line);
    }
  }


  function paintTimer(prefix, timer, targetMin, label) {
    var card = $(prefix === 'lunch' ? 'cardLunch' : 'cardEnd');
    var pie = $(prefix + 'Pie');
    var big = $(prefix + 'Big');
    var small = $(prefix + 'Small');
    var bar = $(prefix + 'Bar');
    var chip = $(prefix + 'Target');
    var status = $(prefix + 'Status');

    if (!timer.available) {
      pie.setAttribute('d', '');
      big.textContent = freedomFor(dayNameOf(new Date()), prefix);
      small.textContent = 'today is free';
      bar.style.width = '0%';
      chip.textContent = freedomFor(dayNameOf(new Date()), prefix);
      status.textContent = 'Nothing scheduled today.';
      $(prefix + 'Elapsed').textContent = '0';
      $(prefix + 'Remaining').textContent = '0';
      card.classList.remove('is-urgent', 'is-done');
      // Nothing is running: the whole card, plate included, goes neutral.
      card.classList.add('is-off');
      return;
    }

    card.classList.remove('is-off');

    var remainingMin = Math.ceil(timer.remainingSec / 60);
    var elapsedMin = Math.floor(timer.elapsedSec / 60);

    // The filled wedge is the time *left*, so the pie shrinks as the day runs on.
    pie.setAttribute('d', wedgePath(1 - timer.progress));
    renderNotchPair(prefix, Math.round(timer.totalSec / 60));

    big.textContent = timer.done ? '0:00' : formatCompact(timer.remainingSec);
    small.textContent = timer.done
      ? 'time reached'
      : (timer.notStarted ? 'starts at ' + formatClock(todayStartMinute()) : 'remaining');

    bar.style.width = (timer.progress * 100).toFixed(1) + '%';
    chip.textContent = formatClock(targetMin);

    $(prefix + 'Elapsed').textContent = elapsedMin;
    $(prefix + 'Remaining').textContent = remainingMin;

    status.textContent = timer.done
      ? label + ' | time reached'
      : label + ' | ' + formatDuration(timer.remainingSec) + ' remaining';

    card.classList.toggle('is-urgent', !timer.done && isUrgent(timer.remainingSec));
    card.classList.toggle('is-done', timer.done);
  }

  /* Both dials share today's single start time. */
  function todayStartMinute() {
    var cfg = state.schedule[dayNameOf(new Date())];
    return cfg ? cfg.start : null;
  }

  /* ─────────────────────────── Milestone alerts ─────────────────────────── */

  function checkAlerts(prefix, timer, label, todayKey) {
    if (!state.settings.alerts || !timer.available || timer.notStarted) return;

    var remainingMin = Math.ceil(timer.remainingSec / 60);

    MILESTONES.forEach(function (mark) {
      var key = todayKey + '|' + prefix + '|' + mark;
      if (firedAlerts[key]) return;
      if (remainingMin <= mark && remainingMin > mark - 1) {
        firedAlerts[key] = true;
        notify(label, mark + ' minutes remaining.', tagFor(todayKey, prefix, mark));
      }
    });

    var doneKey = todayKey + '|' + prefix + '|done';
    if (timer.done && !firedAlerts[doneKey]) {
      firedAlerts[doneKey] = true;
      notify(label, 'Time reached.', tagFor(todayKey, prefix, 'done'));
    }
  }

  /* Must match the tag the edge function sends, so an in-app alert and a
     background push for the same milestone collapse into one notification. */
  function tagFor(todayKey, prefix, milestone) {
    var d = new Date(todayKey);
    var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return iso + '|' + prefix + '|' + milestone;
  }

  function notify(title, body, tag) {
    toast(title + ' — ' + body);
    if (state.settings.sound) chime();
    if (CT.notify) CT.notify.show(title, body, tag);
  }

  var audioCtx;
  function chime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) { /* audio unavailable */ }
  }

  /* ─────────────────────────── Calculator ─────────────────────────── */

  function renderCalculator(now) {
    var targetMin = hhmmToMinutes(state.settings.calcTarget);
    if (targetMin === null) return;

    var nowSec = secondsSinceMidnight(now);
    var targetSec = targetMin * 60;
    var diff = targetSec - nowSec;

    if (diff <= 0) {
      if (state.settings.calcRollover) diff += 86400;
      else diff = 0;
    }

    var h = Math.floor(diff / 3600);
    var m = Math.floor(diff / 60) % 60;
    var s = diff % 60;

    $('calcBig').textContent = diff > 0 ? formatDuration(diff) : 'Time reached';
    $('calcSub').textContent = diff > 0
      ? 'until ' + formatClock(targetMin)
      : formatClock(targetMin) + ' has passed';
    $('calcHours').textContent = h;
    $('calcMins').textContent = m;
    $('calcSecs').textContent = s;
    $('calcTargetOut').textContent = formatClock(targetMin);
  }

  $('calcTarget').addEventListener('input', function () {
    state.settings.calcTarget = this.value || '13:00';
    save();
    renderCalculator(new Date());
  });

  $('calcRollover').addEventListener('change', function () {
    state.settings.calcRollover = this.value === '1';
    save();
    renderCalculator(new Date());
  });

  $$('[data-quick]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var add = parseInt(btn.dataset.quick, 10);
      var now = new Date();
      var target = (secondsSinceMidnight(now) / 60 + add) % 1440;
      state.settings.calcTarget = minutesToHHMM(Math.round(target));
      $('calcTarget').value = state.settings.calcTarget;
      save();
      renderCalculator(now);
    });
  });

  /* ─────────────────────────── Settings ─────────────────────────── */

  var SETTING_INPUTS = {
    opt24h: 'clock24',
    optSeconds: 'showSeconds',
    optAlerts: 'alerts',
    optSound: 'sound',
    optPush: 'push'
  };

  Object.keys(SETTING_INPUTS).forEach(function (id) {
    var key = SETTING_INPUTS[id];
    var el = $(id);
    el.checked = !!state.settings[key];
    el.addEventListener('change', function () {
      state.settings[key] = el.checked;
      save();

      if ((key === 'alerts' || key === 'push') && el.checked) {
        CT.notify.requestPermission().then(function (result) {
          if (result !== 'granted') {
            // Permission refused — don't leave a switch claiming it will work.
            state.settings[key] = false;
            el.checked = false;
            save();
            toast('Notifications were not allowed by the browser.');
          } else if (key === 'push') {
            CT.notify.refreshSubscription().then(function (sub) {
              toast(sub ? 'Background alerts are on.' : 'Background alerts need an account.');
            });
          }
          updateNotificationNotices();
        });
      }

      if (key === 'push' && !el.checked) CT.notify.unsubscribe();
      if (key === 'sound' && el.checked) chime();

      updateNotificationNotices();
      buildScheduleEditor();
      render();
    });
  });

  /* Keep the settings panel honest about what will actually be delivered. */
  function updateNotificationNotices() {
    var perm = CT.notify.permission();
    $('permissionNotice').hidden = perm !== 'denied';
    $('insecureNotice').hidden = CT.notify.supported;

    var pushBox = $('optPush');
    var hint = $('pushHint');

    if (!CT.notify.pushSupported) {
      pushBox.disabled = true;
      setUnavailable(hint, 'Not available in this browser, or the app is not served over HTTPS.');
    } else if (!CT.config.pushConfigured) {
      pushBox.disabled = true;
      setUnavailable(hint,
        'Not switched on yet. Alerts inside the app still work as normal.',
        'Setup: add a Supabase project and a VAPID key to config.js. See the README.');
    } else if (!CT.auth || !CT.auth.isSignedIn()) {
      pushBox.disabled = true;
      setUnavailable(hint, 'Sign in on the Settings tab to get alerts when the app is closed.');
    } else if (!CT.billing.isEntitled()) {
      pushBox.disabled = true;
      setUnavailable(hint, 'Included with a plan. In-app alerts stay free.');
    } else {
      pushBox.disabled = false;
      setUnavailable(hint, 'Deliver milestone alerts even when the app is closed.');
    }
  }

  $('testNotification').addEventListener('click', function () {
    CT.notify.requestPermission().then(function (result) {
      updateNotificationNotices();
      if (result !== 'granted') {
        toast('Notifications are not allowed by the browser.');
        return;
      }
      notify('Pie Timers', 'Test notification — alerts are working.', 'test');
    });
  });

  $('exportData').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'countdown-timers-settings.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Settings exported.');
  });

  $('importData').addEventListener('click', function () { $('importFile').click(); });

  $('importFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        localStorage.setItem(STORE_KEY, JSON.stringify(incoming));
        state = load();
        syncSettingInputs();
        buildScheduleEditor();
        render();
        toast('Settings imported.');
      } catch (e) {
        toast('That file could not be read.');
      }
    };
    reader.readAsText(file);
    this.value = '';
  });

  function syncSettingInputs() {
    Object.keys(SETTING_INPUTS).forEach(function (id) {
      $(id).checked = !!state.settings[SETTING_INPUTS[id]];
    });
    $('calcTarget').value = state.settings.calcTarget;
    $('calcRollover').value = state.settings.calcRollover ? '1' : '0';
    $('lunchLabelInput').value = state.settings.lunchLabel;
      $('optTheme').value = state.settings.theme;
    $('optUrgent').value = String(state.settings.urgentMinutes);
    applyLunchLabel();
    applyTheme();
  }

  $('optUrgent').addEventListener('change', function () {
    var value = parseInt(this.value, 10);
    if (URGENT_CHOICES.indexOf(value) === -1) return;
    state.settings.urgentMinutes = value;
    save();
    render();
  });

  $('optTheme').addEventListener('change', function () {
    if (THEMES.indexOf(this.value) === -1) return;
    state.settings.theme = this.value;
    save();
    applyTheme();
  });

  $('lunchLabelInput').addEventListener('input', function () {
    // Blank falls back to the default rather than leaving a nameless timer.
    state.settings.lunchLabel = this.value.trim().slice(0, 30) || 'Lunch';
    save();
    applyLunchLabel();
    render();
  });


  /* ─────────────────────────── Toast ─────────────────────────── */

  var toastTimer;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 3200);
  }

  /* ─────────────────────────── Focus view ───────────────────────────
     One pie in its own window, meant to sit snapped beside real work.

     Which pie is not a setting: it is whichever milestone is nearest,
     so the view is always showing the thing that is about to happen.
     Choosing is the cognitive load this app exists to remove. */

  /* Hash as well as query: some launchers and shortcut handlers drop a
     query string, and a focus window that silently opens as the full
     app is a confusing thing to hand someone. */
  var FOCUS = /(^|[?&])focus(=|&|$)/.test(location.search) ||
              /^#focus$/.test(location.hash);

  function pickFocusTimer(now) {
    var today = dayNameOf(now);
    var cfg = state.schedule[today];
    var working = cfg && cfg.working;
    var candidates = [];

    if (working) {
      var lunch = computeTimer(now, cfg.start, cfg.lunch);
      if (lunch.available && !lunch.done && !lunch.notStarted) {
        candidates.push({ timer: lunch, label: lunchLabel(today),
                          totalMin: Math.round(lunch.totalSec / 60), forced: null });
      }
      var end = computeTimer(now, cfg.start, cfg.end);
      if (end.available && !end.done && !end.notStarted) {
        candidates.push({ timer: end, label: endLabel(today),
                          totalMin: Math.round(end.totalSec / 60), forced: null });
      }
    }

    var appointment = nextAppointment(now);
    var appt = computeAppointmentTimer(now, appointment);
    if (appt.available) {
      candidates.push({ timer: appt, label: appointment.title || 'Next appointment',
                        totalMin: appt.scaleMin, forced: appt.forcedInterval });
    }

    if (!candidates.length) return null;

    candidates.sort(function (a, b) {
      return a.timer.remainingSec - b.timer.remainingSec;
    });
    return candidates[0];
  }

  function renderFocus(now) {
    var view = $('focusView');
    var pie = $('focusPie');
    var pick = pickFocusTimer(now);

    if (!pick) {
      pie.setAttribute('d', '');
      renderNotchPair('focus', 0);
      $('focusTime').textContent = freedomFor(dayNameOf(now), 'end');
      $('focusLabel').textContent = 'Nothing running right now.';
      view.classList.remove('is-urgent');
      view.classList.add('is-off');
      document.title = 'Pie Timers';
      return;
    }

    view.classList.remove('is-off');
    pie.setAttribute('d', wedgePath(1 - pick.timer.progress));
    renderNotchPair('focus', pick.totalMin, pick.forced);

    $('focusTime').textContent = formatCompact(pick.timer.remainingSec);
    $('focusLabel').textContent = pick.label;

    view.classList.toggle('is-urgent', isUrgent(pick.timer.remainingSec));

    // The window is often snapped narrow enough that the title bar is
    // all you can read, so put the countdown there too.
    document.title = formatCompact(pick.timer.remainingSec) + ' · ' + pick.label;
  }

  if (FOCUS) {
    document.body.classList.add('is-focus');
    $('focusView').hidden = false;

    $('focusFullscreen').addEventListener('click', function () {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function () {
          // Refused (permissions, or an embedded context). Nothing to
          // recover: the view is already filling the window.
        });
      }
    });

    document.addEventListener('fullscreenchange', function () {
      $('focusFullscreen').textContent =
        document.fullscreenElement ? 'Leave full screen' : 'Full screen';
    });
  }

  var openFocusBtn = $('openFocus');
  if (openFocusBtn) {
    openFocusBtn.addEventListener('click', function () {
      // Tall and narrow by default, which is the shape it ends up in
      // when snapped down the side of a screen.
      var opened = window.open('index.html?focus=1', 'pieTimersFocus',
                               'width=360,height=560');
      if (!opened) toast('Your browser blocked the pop-up. Allow pop-ups for this site.');
    });
  }

  /* ─────────────────────────── Main render loop ─────────────────────────── */

  var lastDayKey = null;

  function render() {
    var now = new Date();
    var today = dayNameOf(now);
    var cfg = state.schedule[today];
    var todayKey = now.toDateString();

    // New day → clear fired milestone alerts.
    if (todayKey !== lastDayKey) {
      firedAlerts = {};
      lastDayKey = todayKey;
    }

    $('nowTime').textContent = formatNowTime(now);
    $('nowDate').textContent = formatLongDate(now);

    var working = cfg && cfg.working;

    $('stripDay').textContent = today;
    $('stripStart').textContent = working ? formatClock(cfg.start) : freedomFor(today, 'start');
    $('stripLunch').textContent = working && isMinute(cfg.lunch) ? formatClock(cfg.lunch) : freedomFor(today, 'lunch');
    $('stripEnd').textContent = working && isMinute(cfg.end) ? formatClock(cfg.end) : freedomFor(today, 'end');

    // A day off reads as one quiet colour across the strip, not as green
    // times that look like they are still running.
    ['stripStart', 'stripLunch', 'stripEnd'].forEach(function (id) {
      $(id).classList.toggle('is-off', !working);
    });
    $('stripDay').classList.toggle('is-off', !working);

    var lunchTimer = working ? computeTimer(now, cfg.start, cfg.lunch) : { available: false };
    var endTimer = working ? computeTimer(now, cfg.start, cfg.end) : { available: false };

    paintTimer('lunch', lunchTimer, working ? cfg.lunch : null, lunchLabel(today));
    paintTimer('end', endTimer, working ? cfg.end : null, endLabel(today));

    checkAlerts('lunch', lunchTimer, lunchLabel(today), todayKey);
    checkAlerts('end', endTimer, endLabel(today), todayKey);

    renderAppointment(now, todayKey);
    renderWeekPreview(today);
    renderCalculator(now);

    // Speak only on the minute, not on every tick.
    if (now.getSeconds() === 0 || lastAnnounced === '') announceRemaining();

    document.title = working && lunchTimer.available && !lunchTimer.done
      ? formatCompact(lunchTimer.remainingSec) + ' · Pie Timers'
      : 'Pie Timers';

    /* Last, so its title wins. The rest of the render still runs in a
       focus window: the elements are hidden, not absent, and it keeps
       milestone alerts firing when the focus window is the only one
       open — which is exactly when someone is relying on it. */
    if (FOCUS) renderFocus(now);
  }

  /* Align the tick to the top of each second so the clock never visibly stalls. */
  function startLoop() {
    render();
    var drift = 1000 - (Date.now() % 1000);
    setTimeout(function () {
      render();
      setInterval(render, 1000);
    }, drift);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) render();
  });

  /* ─────────────────────────── Account tab ─────────────────────────── */

  var SYNC_LABELS = {
    'local':      'Local',
    'signed-out': 'Not signed in',
    'free':       'Free plan',
    'syncing':    'Syncing…',
    'synced':     'Synced',
    'offline':    'Offline',
    'error':      'Sync error'
  };

  /* Whole days left, rounded up — "1 day left" should mean today counts. */
  function daysLeft(ent) {
    if (!ent.currentPeriodEnd) return null;
    var ms = new Date(ent.currentPeriodEnd).getTime() - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
  }

  function isTrial(ent) {
    return ent.status === 'trialing' || ent.plan === 'trial';
  }

  function planLabel(ent) {
    if (!CT.billing.enabled()) return 'All features enabled';
    if (ent.complimentary) return 'Complimentary access — thank you for being here';

    if (isTrial(ent) && ent.entitled) {
      var left = daysLeft(ent);
      return 'Free trial — ' + left + (left === 1 ? ' day left' : ' days left');
    }

    if (!ent.entitled) {
      return isTrial(ent)
        ? 'Free — your trial has ended'
        : 'Free — everything on this device';
    }

    var name = ent.plan === 'monthly' ? 'Monthly' : 'Annual';
    if (ent.cancelAtPeriodEnd && ent.currentPeriodEnd) {
      return name + ' — ends ' + new Date(ent.currentPeriodEnd).toLocaleDateString(LOCALE);
    }
    if (ent.currentPeriodEnd) {
      return name + ' — renews ' + new Date(ent.currentPeriodEnd).toLocaleDateString(LOCALE);
    }
    return name;
  }

  function renderPlan() {
    var ent = CT.billing.get();
    var el = $('planDetail');
    if (el) el.textContent = planLabel(ent);

    var trialing = isTrial(ent) && ent.entitled;
    var left = daysLeft(ent);

    /* During a trial, stay out of the way until it is nearly over — the
       point of two months is that people get to live with it first. */
    var nudging = trialing && left !== null && left <= 14;

    var panel = $('upgradePanel');
    if (panel) {
      panel.hidden = !CT.billing.enabled() ||
                     !CT.auth.isSignedIn() ||
                     (CT.billing.isEntitled() && !nudging);
    }

    var heading = $('upgradeHeading');
    if (heading) {
      heading.textContent = nudging
        ? 'Keep sync and background alerts'
        : 'Unlock sync and background alerts';
    }

    var trialNotice = $('trialNotice');
    if (trialNotice) {
      trialNotice.hidden = !trialing || nudging;
      if (trialing && !nudging) {
        trialNotice.textContent =
          'You have ' + left + (left === 1 ? ' day' : ' days') +
          ' left of your free trial. Everything is switched on — no card needed, ' +
          'and nothing happens automatically when it ends.';
      }
    }

    // Prices come from config so they can be tuned without touching markup.
    // These are labels only — Paddle's checkout shows the real localised,
    // tax-inclusive price, which is the one that counts.
    var pricing = CT.config.paddle;
    var priceFields = {
      annualPrice: pricing.annualPrice,
      annualPeriod: pricing.annualPeriod,
      annualNote: pricing.annualNote,
      monthlyPrice: pricing.monthlyPrice,
      monthlyPeriod: pricing.monthlyPeriod
    };
    Object.keys(priceFields).forEach(function (id) {
      var el = $(id);
      if (el && priceFields[id]) el.textContent = priceFields[id];
    });

    var saving = $('annualSaving');
    if (saving) {
      saving.textContent = pricing.annualSaving || '';
      saving.hidden = !pricing.annualSaving;
    }

    var monthlyBtn = $('buyMonthly');
    if (monthlyBtn) monthlyBtn.hidden = !CT.config.paddle.monthlyPriceId;

    var manage = $('managePlan');
    if (manage) manage.hidden = !CT.billing.enabled() || !CT.billing.isEntitled();

  }

  function renderAccount() {
    var configured = CT.config.isConfigured;
    var signedIn = configured && CT.auth.isSignedIn();

    $('accountUnconfigured').hidden = configured;
    $('accountSignedOut').hidden = !configured || signedIn;
    $('accountSignedIn').hidden = !signedIn;

    if (signedIn) {
      var user = CT.auth.getUser();
      $('accountEmail').textContent = (user && user.email) || 'your account';
      $('deviceLabel').textContent = CT.sync.deviceId;
      $('lastUpdated').textContent = state.updatedAt
        ? new Date(state.updatedAt).toLocaleString(LOCALE)
        : 'Never';
    }

    if (!signedIn && CT.config.turnstileEnabled) CT.turnstile.mount();

    renderPlan();
    renderCalendarPanel();
    updateNotificationNotices();
  }

  /* Support address and legal URLs live in config.js so there is exactly one
     place to change them. Runs once at load — none of it varies afterwards. */
  (function applyConfigLinks() {
    var email = CT.config.supportEmail || '';
    var mailtos = document.querySelectorAll('[data-support-mailto]');
    for (var i = 0; i < mailtos.length; i++) {
      var link = mailtos[i];
      if (!email) { link.hidden = true; continue; }
      var subject = link.getAttribute('data-support-subject');
      link.href = 'mailto:' + email +
        (subject ? '?subject=' + encodeURIComponent(subject) : '');
    }

    var legal = document.querySelectorAll('[data-legal-link]');
    for (var j = 0; j < legal.length; j++) {
      var which = legal[j].getAttribute('data-legal-link');
      var url = which === 'terms' ? CT.config.termsUrl : CT.config.privacyUrl;
      if (url) legal[j].href = url;
    }
  }());

  function authMessage(text, isError) {
    var el = $('authMessage');
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  if (CT.config.isConfigured) {
    $('magicForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var email = $('magicEmail').value.trim();
      if (!email) return;

      var button = $('magicSubmit');
      var token = CT.turnstile.token();

      if (CT.config.turnstileEnabled && !token) {
        CT.turnstile.mount();
        authMessage('Just a moment — completing the security check.', true);
        return;
      }

      button.disabled = true;
      authMessage('Sending…');

      CT.auth.signInWithEmail(email, token).then(function () {
        authMessage('Check ' + email + ' for your sign-in link.');
      }).catch(function (err) {
        authMessage(err.message, true);
      }).then(function () {
        button.disabled = false;
        CT.turnstile.reset();   // tokens are single-use
      });
    });

    /* ── Checkout ─────────────────────────────────────────────────── */

    function startCheckout(cadence) {
      var code = ($('discountCode').value || '').trim();
      CT.billing.openCheckout(cadence, code).catch(function (err) {
        toast(err.message);
      });
    }

    /* Access codes are personal, single-use and bound to one address, so
       the failure messages stay vague on purpose — a precise answer would
       let someone probe for which codes exist. */
    var REDEEM_ERRORS = {
      unknown: 'That code was not recognised, or is not for this account.',
      expired: 'That code has expired.',
      exhausted: 'That code has already been used.',
      too_many_attempts: 'Too many attempts. Please try again in an hour.',
      not_signed_in: 'Please sign in first.'
    };

    $('accessCodeForm').addEventListener('submit', function (event) {
      event.preventDefault();

      var input = $('accessCode');
      var message = $('accessCodeMessage');
      var code = input.value.trim();
      if (!code) return;

      var button = $('redeemCode');
      button.disabled = true;
      message.classList.remove('is-error');
      message.textContent = 'Checking…';

      CT.db.redeemAccessCode(code).then(function (result) {
        if (result && result.ok) {
          input.value = '';
          message.textContent = result.already
            ? 'That code is already applied to your account.'
            : 'Access unlocked. Thank you.';
          return CT.billing.refresh();
        }
        message.textContent = REDEEM_ERRORS[result && result.error] || REDEEM_ERRORS.unknown;
        message.classList.add('is-error');
      }).catch(function () {
        message.textContent = 'Could not check that code just now. Please try again.';
        message.classList.add('is-error');
      }).then(function () {
        button.disabled = false;
      });
    });

    $('buyAnnual').addEventListener('click', function () { startCheckout('annual'); });
    $('buyMonthly').addEventListener('click', function () { startCheckout('monthly'); });

    $('managePlan').addEventListener('click', function () {
      CT.billing.refresh().then(function () {
        renderPlan();
        toast('Plan refreshed.');
      });
    });

    CT.billing.onChange(function () {
      renderPlan();
      updateNotificationNotices();
      renderCalendarPanel();
      // Entitlement just arrived — pull whatever calendar data exists.
      if (CT.billing.isEntitled() && CT.auth.isSignedIn()) loadCalendar();
    });

    $('googleSignIn').addEventListener('click', function () {
      authMessage('Redirecting to Google…');
      CT.auth.signInWithGoogle();
    });

    $('signOutBtn').addEventListener('click', function () {
      CT.notify.unsubscribe();
      CT.auth.signOut().then(function () {
        toast('Signed out. Your data stays on this device.');
        renderAccount();
      });
    });

    /* ── Account deletion ────────────────────────────────────────────
       Irreversible, so it is gated behind a typed confirmation rather
       than a single click that could be hit by accident. */

    var deleteDialog = $('deleteDialog');
    var deleteInput = $('deleteConfirmInput');
    var deleteConfirm = $('deleteConfirm');

    function closeDeleteDialog() {
      deleteInput.value = '';
      deleteConfirm.disabled = true;
      $('deleteError').textContent = '';
      if (deleteDialog.open) deleteDialog.close();
    }

    $('deleteAccountBtn').addEventListener('click', function () {
      closeDeleteDialog();
      if (deleteDialog.showModal) deleteDialog.showModal();
      else deleteDialog.setAttribute('open', '');   // very old browsers
      deleteInput.focus();
    });

    deleteInput.addEventListener('input', function () {
      deleteConfirm.disabled = deleteInput.value.trim().toUpperCase() !== 'DELETE';
    });

    $('deleteCancel').addEventListener('click', closeDeleteDialog);
    deleteDialog.addEventListener('cancel', closeDeleteDialog);

    deleteConfirm.addEventListener('click', function () {
      if (deleteInput.value.trim().toUpperCase() !== 'DELETE') return;

      deleteConfirm.disabled = true;
      deleteConfirm.textContent = 'Deleting…';
      $('deleteError').textContent = '';

      // Release this device's push endpoint before the account disappears.
      CT.notify.unsubscribe().then(function () {
        return CT.auth.deleteAccount();
      }).then(function () {
        // Local data would otherwise be re-uploaded on the next sign-in.
        try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ }
        state = normalise({});
        save({ fromSync: true });

        closeDeleteDialog();
        syncSettingInputs();
        buildScheduleEditor();
        renderAccount();
        render();
        showView('dashboard');
        toast('Your account has been deleted.');
      }).catch(function (err) {
        $('deleteError').textContent = err.message || 'Could not delete the account.';
        $('deleteError').classList.add('is-error');
      }).then(function () {
        deleteConfirm.textContent = 'Delete permanently';
        deleteConfirm.disabled = deleteInput.value.trim().toUpperCase() !== 'DELETE';
      });
    });

    $('syncNow').addEventListener('click', function () {
      // Manual pull: allowed on the free plan so nobody is ever locked
      // out of retrieving their own schedule.
      CT.sync.pull(true).then(function (ok) {
        toast(ok ? 'Sync complete.' : 'Could not sync right now.');
      });
    });

    CT.auth.onChange(function () { renderAccount(); });

    CT.sync.onStatus(function (status, detail) {
      var pill = $('syncPill');
      pill.dataset.status = status;
      $('syncPillText').textContent = SYNC_LABELS[status] || status;
      pill.hidden = status === 'local';

      var el = $('syncDetail');
      if (el) {
        el.textContent = status === 'error'
          ? (detail || 'Something went wrong.')
          : (SYNC_LABELS[status] || status);
      }
    });
  } else {
    $('syncPill').hidden = true;
  }

  /* Re-subscribe if the browser rotates our push endpoint. */
  if (CT.notify.supported) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'resubscribe') CT.notify.refreshSubscription();
    });
  }

  /* ─────────────────────────── Bridge for the sync engine ─────────────────────────── */

  CT.app = {
    getState: function () { return state; },

    /* Adopt a copy from the server and rebuild everything that reads it. */
    replaceState: function (incoming, options) {
      var next = normalise(incoming);
      next.updatedAt = incoming.updatedAt || Date.now();
      // Calendar events are local cache, not synced state — a pull must
      // not blank them just because the server row has no such field.
      if (!incoming.calendarEvents) next.calendarEvents = state.calendarEvents;
      state = next;
      save({ fromSync: true });
      syncSettingInputs();
      buildScheduleEditor();
      buildAppointmentList();
      renderAccount();
      render();
    },

    render: render
  };

  /* ─────────────────────────── Boot ─────────────────────────── */

  syncSettingInputs();
  buildScheduleEditor();
  primeAppointmentForm();
  buildAppointmentList();
  renderAccount();
  renderCalendarPanel();
  renderWelcome();
  startLoop();

  CT.notify.register().then(function () {
    CT.notify.syncScheduleToWorker(state);
    updateNotificationNotices();
  });

  CT.sync.init();

  // sync.init() consumes the URL fragment, so this must follow it.
  finishGoogleConnect();
})();
