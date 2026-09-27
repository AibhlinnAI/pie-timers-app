/* ============================================================
   notify-milestones — runs every minute from pg_cron.

   For each user who has alerts switched on, works out where each
   of today's timers sits in their own timezone and pushes the
   milestones that have just come due. The notification_log table
   is the idempotency guard: a milestone is written before
   sending, and the primary key stops a second run repeating one.
   ============================================================ */

import { sendPush, type PushSubscription } from "./webpush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

// pg_cron calls this server-to-server, so CORS never applies --
// these headers exist only so a browser (diagnostics.html's own health
// check) gets a real response instead of a blocked preflight.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MILESTONES = [30, 15, 10, 5];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DONE_ALERT_WINDOW_SEC = 120;        // DONE_ALERT_WINDOW_SEC in app.js
const NIGHT_SHIFT_HOLD_MIN = 4 * 60;      // NIGHT_SHIFT_HOLD_SEC in app.js

/* ─────────────────────────── Supabase REST ─────────────────────────── */

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${await response.text()}`);
  }
  /* An empty body is a success, not a value. PostgREST answers a
     Prefer: return=minimal write with 200 and an empty body, not 204,
     so parsing unconditionally threw "Unexpected end of JSON input"
     after the write had already succeeded. Fixed in calendar-sync on
     7 Sep 2026; these two carried the same line. */
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

/* ─────────────────────────── Timezone-aware clock ─────────────────────────── */

/* Read the wall clock in an arbitrary IANA timezone at `at` without
   pulling in a date library. Falls back to UTC if the zone is not
   recognised. */
function localNow(timezone: string, at: Date): LocalNow {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
  } catch {
    return localNow("UTC", at);
  }

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);

  return {
    today: calendarDay(year, month, day),
    yesterday: calendarDay(year, month, day - 1),
    minutes: hour * 60 + minute,
  };
}

interface LocalNow {
  today: { dayName: string; isoDate: string };
  yesterday: { dayName: string; isoDate: string };
  minutes: number;
}

/* A date's weekday and ISO form. Date.UTC rolls day 0 back into the
   month before, and UTC has no daylight saving to move the day. */
function calendarDay(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return {
    dayName: DAYS[(date.getUTCDay() + 6) % 7],
    isoDate: date.toISOString().slice(0, 10),
  };
}

/* ─────────────────────────── Timer maths ───────────────────────────
   Deliberately mirrors computeTimer() and currentShift() in app.js. If
   one changes, the other must change to match, or the app and the push
   will disagree. */

// deno-lint-ignore no-explicit-any
type Day = Record<string, any>;

function worksOn(day: Day | undefined): day is Day {
  if (!day) return false;
  return !!day.working && isMinute(day.start);
}

/* Start to whichever target comes last. */
function shiftLengthMin(day: Day) {
  let longest = 0;
  for (const target of [day.lunch, day.end]) {
    if (!isMinute(target)) continue;
    let length = target - day.start;
    if (length <= 0) length += 1440;
    longest = Math.max(longest, length);
  }
  return longest;
}

/* Which day's hours count now: today's, unless yesterday's shift ran
   past midnight and today's has not started. Then yesterday's keeps them
   while it runs and for NIGHT_SHIFT_HOLD_MIN after it ends. `minutes`
   counts from midnight on the day the shift started, and `isoDate` is
   that day, so a night shift's alerts after midnight are claimed and
   tagged under the day it began, as the app files them.

   This replaces "more than 12 hours before start means still counting
   last night", which also caught a 1pm to 9pm day at midnight: it read
   as done, "Time reached" was pushed at 00:00 and claimed, and the real
   one that afternoon was refused as a duplicate. */
function currentShift(schedule: Record<string, Day> | undefined, now: LocalNow) {
  const today = schedule?.[now.today.dayName];
  const prev = schedule?.[now.yesterday.dayName];
  const startedToday = worksOn(today) && now.minutes >= today.start;

  if (!startedToday && worksOn(prev)) {
    const pastMidnight = prev.start + shiftLengthMin(prev) - 1440;
    if (pastMidnight >= 0 && now.minutes < pastMidnight + NIGHT_SHIFT_HOLD_MIN) {
      return { day: prev, dayName: now.yesterday.dayName, isoDate: now.yesterday.isoDate, minutes: now.minutes + 1440 };
    }
  }
  return worksOn(today)
    ? { day: today, dayName: now.today.dayName, isoDate: now.today.isoDate, minutes: now.minutes }
    : null;
}

function remainingMinutes(nowMin: number, startMin: number, targetMin: number) {
  let total = targetMin - startMin;
  if (total <= 0) total += 1440;

  const sinceStart = nowMin - startMin;

  if (sinceStart < 0) return null;               // shift has not begun
  const elapsed = Math.min(sinceStart, total);
  return total - elapsed;
}

function isMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1440;
}

const TIMERS = [
  { key: "lunch", label: "Lunch | Head Home", field: "lunch" },
  { key: "end", label: "End of Day", field: "end" },
];

interface DueAlert {
  key: string;
  label: string;
  isoDate: string;
  milestone: string;
  body: string;
}

/* ─────────────────────────── Breaks ───────────────────────────
   The twin of normaliseBreaks() and the day's break list in app.js, for
   the same reason as the timer maths above: if one changes and the other
   does not, a push and the in-page alert for the same break disagree.

   Lunch stays where it always was, schedule[day].lunch, and keeps its
   key "lunch". Its length and every other break live in the profile's
   `breaks` column, never inside schedule or settings:
   { v: 1, days: { Monday: { lunchMinutes, extras: [{ id, start,
   minutes, name, headHome }] }, ... } }. */

const MAX_BREAKS = 6;              // extras a stored day keeps; lunch is not counted
const BREAK_MIN_MINUTES = 5;
const BREAK_MAX_MINUTES = 180;
const BREAK_NAME_MAX = 30;
const HEADS_UP_MIN = 5;            // an extra break's only warning

// deno-lint-ignore no-explicit-any
type Settings = Record<string, any>;

interface ExtraBreak {
  id: string;
  start: number;
  minutes: number | null;
  name: string;
  headHome: boolean;
}

interface DayBreaks {
  lunchMinutes: number | null;
  extras: ExtraBreak[];
}

interface Break {
  key: string;
  start: number;
  minutes: number | null;
  name: string;
  headHome: boolean;
  isLunch: boolean;
}

// deno-lint-ignore no-explicit-any
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyBreaks() {
  const days: Record<string, DayBreaks> = {};
  for (const dayName of DAYS) days[dayName] = { lunchMinutes: null, extras: [] };
  return { v: 1, days };
}

/* Never throws, and reads anything it cannot use as "no breaks", so a
   null, empty or mangled column pushes exactly what it did before breaks
   existed. A readable record is repaired rather than pruned: a length is
   clamped into range, a name trimmed, cut to size and trimmed again, a
   missing or repeated id made up. The made-up id is built from the day,
   the time and the place in the list, never at random, so the same row
   reads the same way on every run. Where a break sits (before Start,
   after End of Day, on a day off) never removes it; the app keeps those
   breaks, and a push must not quietly lose one the page still has. The
   only extras dropped are one with no readable start, which has no time
   to alert at, and those past the day's MAX_BREAKS. Lunch never counts
   against that: an older copy can set lunch on a day that already has
   six others, and a break must not vanish for it (until 27 Sep it did
   count, here and in the app). Every rule here is the rule in
   normaliseBreaks() in app.js. */
function normaliseBreaks(x: unknown) {
  try {
    const out = emptyBreaks();
    if (!isRecord(x) || x.v !== 1 || !isRecord(x.days)) return out;
    const used = new Set<string>();
    for (const dayName of DAYS) {
      const entry = isRecord(x.days[dayName]) ? x.days[dayName] : {};
      let extras: ExtraBreak[] = [];
      for (const item of Array.isArray(entry.extras) ? entry.extras : []) {
        if (!isRecord(item)) continue;
        const start = breakStart(item.start);
        if (start === null) continue;
        extras.push({
          id: item.id,
          start,
          minutes: breakLength(item.minutes),
          // Trimmed again after the cut, so a name is never left ending in a space.
          name: typeof item.name === "string" ? item.name.trim().slice(0, BREAK_NAME_MAX).trim() : "",
          headHome: item.headHome === true,
        });
      }
      extras = extras.slice(0, MAX_BREAKS);
      extras.forEach((extra, index) => {
        let id = typeof extra.id === "string" ? extra.id : "";
        if (!id || id.length > 64 || used.has(id)) {
          id = "b_" + dayName + extra.start + index;
          while (used.has(id)) id += "_";
        }
        used.add(id);
        extra.id = id;
      });
      out.days[dayName] = { lunchMinutes: breakLength(entry.lunchMinutes), extras };
    }
    return out;
  } catch {
    return emptyBreaks();
  }
}

/* A break's start in whole minutes past midnight, or null when there is
   no way to read one. "10:30" is accepted, as the app accepts it, since
   that is what a time input holds. */
function breakStart(value: unknown) {
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(":");
    value = parseInt(h, 10) * 60 + parseInt(m, 10);
  }
  return isMinute(value) ? Math.floor(value) : null;
}

/* A break's length: null means "No set length". Anything that is not a
   positive number reads as no length; anything else is clamped into the
   5 minutes to 3 hours the app offers. */
function breakLength(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const minutes = Math.round(value);
  if (minutes <= 0) return null;
  return Math.min(BREAK_MAX_MINUTES, Math.max(BREAK_MIN_MINUTES, minutes));
}

/* An extra break's key is made from its times, not its id, so the app
   and this function name the same break the same way, and a break moved
   to another time is claimed afresh, as a moved finish time is. */
function breakKey(e: { start: number; minutes: number | null }) {
  return "brk" + e.start + (e.minutes ? "-" + ((e.start + e.minutes) % 1440) : "");
}

/* Minutes after the day's Start, wrapping past midnight, so a night
   shift's breaks after midnight come after its evening ones. */
function relMinute(day: Day, minute: number) {
  return (minute - day.start + 1440) % 1440;
}

/* Lunch's name, read exactly as the app's normalise() reads
   settings.lunchLabel: a string, trimmed and cut to 30 characters, or
   "Lunch" when it is anything else. A user writes their own settings, so
   the column can hold any JSON, and String() on an object with its own
   toString throws: one such row stopped every user's pushes (found
   27 Sep). */
function lunchName(settings: Settings | null | undefined) {
  const label = settings?.lunchLabel;
  return typeof label === "string" && label.trim() ? label.trim().slice(0, 30) : "Lunch";
}

/* The shift day's breaks in the order they come. Ties go by key, so the
   app and this function put two breaks at the same time in the same
   order, and agree on which one is "the break before". */
function dayBreaks(day: Day, entry: DayBreaks, settings: Settings | null | undefined): Break[] {
  const list: Break[] = [];
  if (isMinute(day.lunch)) {
    list.push({
      key: "lunch",
      start: day.lunch,
      minutes: entry.lunchMinutes,
      name: lunchName(settings),
      headHome: !!day.lunchHeadHome,
      isLunch: true,
    });
  }
  for (const e of entry.extras) {
    list.push({
      key: breakKey(e),
      start: e.start,
      minutes: e.minutes,
      name: e.name || "Break",
      headHome: e.headHome,
      isLunch: false,
    });
  }
  return list.sort((a, b) =>
    relMinute(day, a.start) - relMinute(day, b.start) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/* The app's formatClock(), so "Back at" reads the same in a push as on
   the page. */
function formatClock(minutes: number, clock24: boolean) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  if (clock24) return pad(h) + ":" + pad(m);
  return (h % 12 === 0 ? 12 : h % 12) + ":" + pad(m) + " " + (h >= 12 ? "PM" : "AM");
}

/* The pushes one user is due at `at`. No I/O, so it can be tested on its
   own; claim() still decides whether each one has already gone. Settings
   and breaks are optional: without them, or with a breaks column that is
   null or unreadable, the pushes are exactly the ones from before breaks
   existed. */
function dueAlerts(
  schedule: Record<string, Day> | undefined,
  timezone: string,
  at: Date,
  settings?: Settings | null,
  breaks?: unknown,
): DueAlert[] {
  const shift = currentShift(schedule, localNow(timezone, at));
  if (!shift) return [];

  const breaksToday = dayBreaks(shift.day, normaliseBreaks(breaks).days[shift.dayName], settings);
  const lunchMinutes = breaksToday.find((b) => b.isLunch)?.minutes ?? null;
  const clock = (minute: number) => formatClock(minute, !!settings?.clock24);

  const due: DueAlert[] = [];
  for (const timer of TIMERS) {
    const target = shift.day[timer.field];
    if (!isMinute(target)) continue;

    const remaining = remainingMinutes(shift.minutes, shift.day.start, target);
    if (remaining === null) continue;

    if (remaining === 0) {
      if (!justReached(schedule, timezone, at, shift.isoDate, target)) continue;
      /* A lunch with a set length is a break beginning, so it says when
         it ends. Without one it reads exactly as it always has. */
      const body = timer.key === "lunch" && lunchMinutes
        ? `Break time. Back at ${clock((target + lunchMinutes) % 1440)}.`
        : "Time reached.";
      due.push({ ...timer, isoDate: shift.isoDate, milestone: "done", body });
    } else {
      const hit = MILESTONES.find((m) => m === remaining);
      if (hit === undefined) continue;
      due.push({ ...timer, isoDate: shift.isoDate, milestone: String(hit), body: `${hit} minutes remaining.` });
    }
  }

  /* Each break's own alerts. Lunch's ladder and start are the TIMERS
     loop above, untouched, so here lunch only adds the finish of a set
     length; an extra break gets a heads-up, a start and that finish.
     Every one is timed from the day's Start, like the pies, and a start
     or finish is only announced as it happens, like "Time reached".
     End of Day at Start is a 24-hour shift, as the pies and the Schedule
     tab's notes read it, so End of Day is at +24 h there, not at +0: read
     as 0, it skipped every finish on such a shift (found 27 Sep). */
  const endAt = isMinute(shift.day.end) ? (relMinute(shift.day, shift.day.end) || 1440) : null;
  let previous: Break | undefined;
  for (const brk of breaksToday) {
    const title = brk.name + (brk.headHome ? " | Head Home" : "");
    /* A break at exactly Start counts a whole day away, as a lunch at
       Start does, and nobody was ever counted to it, so it gets none of
       its three alerts. Its heads-up and start were once left to "never
       come while the shift is on the pies", but a shift still on them a
       day later (a 24-hour shift, or a long one before a day off) got
       both then, on the wrong day (found 27 Sep). It is still the break
       before the next one, for that one's heads-up, as in the app. */
    const afterStart = relMinute(shift.day, brk.start) > 0;

    if (!brk.isLunch && afterStart) {
      const remaining = remainingMinutes(shift.minutes, shift.day.start, brk.start);
      /* "Starts in 5 minutes" is noise while the break before is still
         on, or before it has even begun, so a heads-up landing at or
         before that break's finish is skipped. */
      const clear = !previous ||
        relMinute(shift.day, brk.start) - HEADS_UP_MIN >
          relMinute(shift.day, (previous.start + (previous.minutes ?? 0)) % 1440);
      if (remaining === HEADS_UP_MIN && clear) {
        due.push({
          key: brk.key, label: title, isoDate: shift.isoDate,
          milestone: String(HEADS_UP_MIN), body: `Starts in ${HEADS_UP_MIN} minutes.`,
        });
      } else if (remaining === 0 && justReached(schedule, timezone, at, shift.isoDate, brk.start)) {
        due.push({
          key: brk.key, label: title, isoDate: shift.isoDate, milestone: "start",
          body: brk.minutes ? `Break time. Back at ${clock((brk.start + brk.minutes) % 1440)}.` : "Break time.",
        });
      }
    }

    /* A break that ends at or after End of Day needs no "Break over":
       End of Day's own alert is the one that matters then. Nor does one
       that starts before the day's Start and runs past it, or one at
       exactly Start (above): neither was ever counted to, so its end is
       not news. All three rules match the app's checkBreakAlerts. */
    const finish = brk.minutes ? (brk.start + brk.minutes) % 1440 : null;
    if (
      finish !== null &&
      (endAt === null || relMinute(shift.day, finish) < endAt) &&
      relMinute(shift.day, brk.start) + (brk.minutes as number) < 1440 &&
      afterStart &&
      remainingMinutes(shift.minutes, shift.day.start, finish) === 0 &&
      justReached(schedule, timezone, at, shift.isoDate, finish)
    ) {
      due.push({
        key: brk.key, label: brk.name, isoDate: shift.isoDate,
        milestone: "finish", body: "Break over. Ease back in.",
      });
    }
    previous = brk;
  }
  return due;
}

/* "Time reached" is news only when it happens: the same shift's timer
   was still running DONE_ALERT_WINDOW_SEC ago by the real clock. Without
   this, every run after the target re-tried it, so switching alerts on
   at 7pm pushed a 5pm "Time reached". Real time rather than the wall
   clock, so a 2:30am target still gets its push at 3:00 on the night the
   clocks go forward. A window of two runs, in case one is missed.
   `target` is a minute of the day rather than a schedule field, so a
   break's start and finish use the same rule; within one shift day it is
   the same minute before and now, as a field of the same day was. */
function justReached(
  schedule: Record<string, Day> | undefined,
  timezone: string,
  at: Date,
  isoDate: string,
  target: number,
) {
  const before = currentShift(schedule, localNow(timezone, new Date(at.getTime() - DONE_ALERT_WINDOW_SEC * 1000)));
  if (!before || before.isoDate !== isoDate) return true;
  return remainingMinutes(before.minutes, before.day.start, target) !== 0;
}

/* ─────────────────────────── Main ─────────────────────────── */

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  timezone: string;
}

interface ProfileRow {
  user_id: string;
  // deno-lint-ignore no-explicit-any
  schedule: Record<string, any>;
  // deno-lint-ignore no-explicit-any
  settings: Record<string, any>;
  // Extra breaks and break lengths; null until a copy of the app sends one.
  breaks: unknown;
}

async function run() {
  const subscriptions: SubscriptionRow[] = await rest("/push_subscriptions?select=*");
  if (!subscriptions.length) return { checked: 0, sent: 0 };

  const userIds = [...new Set(subscriptions.map((s) => s.user_id))];
  /* Selecting a column the table does not have fails the whole request,
     and every user's pushes with it, so `breaks` must exist in the
     database before this version is deployed. */
  const profiles: ProfileRow[] = await rest(
    `/timer_profiles?select=user_id,schedule,settings,breaks&user_id=in.(${userIds.join(",")})`,
  );
  const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));

  let sent = 0;

  for (const sub of subscriptions) {
    /* One subscription at a time, each on its own. A user writes their
       own profile row, so it can hold anything, and a throw while working
       out, claiming or sending one user's alerts used to end the whole
       run: every user after them lost their pushes, every minute, for as
       long as the row stayed (found 27 Sep). Now it costs that user this
       run's alerts, and the log says whose. */
    try {
      const profile = profileByUser.get(sub.user_id);
      if (!profile || !profile.settings?.alerts) continue;

      for (const alert of dueAlerts(profile.schedule, sub.timezone || "UTC", new Date(), profile.settings, profile.breaks)) {
        // Claim the milestone first. A duplicate key means another run
        // already holds one, so this run must not send.
        const claimed = await claim(sub.user_id, alert.isoDate, alert.key, alert.milestone);
        if (!claimed) continue;

        const result = await sendPush(
          { endpoint: sub.endpoint, keys: sub.keys } as PushSubscription,
          {
            title: alert.label,
            body: alert.body,
            // Same tag scheme as the in-page alert, so the two collapse
            // into a single notification rather than stacking.
            tag: `${alert.isoDate}|${alert.key}|${alert.milestone}`,
          },
          { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: VAPID_SUBJECT },
        ).catch((err) => {
          console.error(`push failed for ${sub.endpoint}: ${err.message}`);
          return { ok: false, status: 0, gone: false };
        });

        if (result.gone) {
          await rest(`/push_subscriptions?id=eq.${sub.id}`, { method: "DELETE" })
            .catch(() => {/* retried on the next run */});
        } else if (result.ok) {
          sent++;
        }
      }
    } catch (error) {
      console.error("alerts failed for subscription", sub.id, "of user", sub.user_id, error);
    }
  }

  return { checked: subscriptions.length, sent };
}

/* Returns false when this milestone was already claimed today. */
async function claim(userId: string, day: string, timerKey: string, milestone: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/notification_log`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ user_id: userId, day, timer_key: timerKey, milestone }),
  });

  if (response.status === 409) return false; // primary key conflict — already sent
  if (!response.ok) {
    console.error(`claim failed: ${response.status} ${await response.text()}`);
    return false;
  }
  return true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // pg_cron passes the shared secret; without one this endpoint is closed.
  // Deliberately fail-closed: `if (CRON_SECRET)` here would skip this
  // check entirely -- and let anyone trigger a real push send -- for as
  // long as the secret happens to be unset, which is exactly backwards
  // for a guard whose own comment says "without one this endpoint is
  // closed." calendar-sync's identical guard already gets this right;
  // this one did not match until now.
  if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  try {
    const summary = await run();
    return Response.json({ ok: true, ...summary }, { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return Response.json({ ok: false, error: String(error) }, { status: 500, headers: corsHeaders });
  }
});
