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
      return { day: prev, isoDate: now.yesterday.isoDate, minutes: now.minutes + 1440 };
    }
  }
  return worksOn(today) ? { day: today, isoDate: now.today.isoDate, minutes: now.minutes } : null;
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

/* The pushes one user is due at `at`. No I/O, so it can be tested on its
   own; claim() still decides whether each one has already gone. */
function dueAlerts(schedule: Record<string, Day> | undefined, timezone: string, at: Date): DueAlert[] {
  const shift = currentShift(schedule, localNow(timezone, at));
  if (!shift) return [];

  const due: DueAlert[] = [];
  for (const timer of TIMERS) {
    const target = shift.day[timer.field];
    if (!isMinute(target)) continue;

    const remaining = remainingMinutes(shift.minutes, shift.day.start, target);
    if (remaining === null) continue;

    if (remaining === 0) {
      if (!justReached(schedule, timezone, at, shift.isoDate, timer.field)) continue;
      due.push({ ...timer, isoDate: shift.isoDate, milestone: "done", body: "Time reached." });
    } else {
      const hit = MILESTONES.find((m) => m === remaining);
      if (hit === undefined) continue;
      due.push({ ...timer, isoDate: shift.isoDate, milestone: String(hit), body: `${hit} minutes remaining.` });
    }
  }
  return due;
}

/* "Time reached" is news only when it happens: the same shift's timer
   was still running DONE_ALERT_WINDOW_SEC ago by the real clock. Without
   this, every run after the target re-tried it, so switching alerts on
   at 7pm pushed a 5pm "Time reached". Real time rather than the wall
   clock, so a 2:30am target still gets its push at 3:00 on the night the
   clocks go forward. A window of two runs, in case one is missed. */
function justReached(
  schedule: Record<string, Day> | undefined,
  timezone: string,
  at: Date,
  isoDate: string,
  field: string,
) {
  const before = currentShift(schedule, localNow(timezone, new Date(at.getTime() - DONE_ALERT_WINDOW_SEC * 1000)));
  if (!before || before.isoDate !== isoDate) return true;
  return remainingMinutes(before.minutes, before.day.start, before.day[field]) !== 0;
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
}

async function run() {
  const subscriptions: SubscriptionRow[] = await rest("/push_subscriptions?select=*");
  if (!subscriptions.length) return { checked: 0, sent: 0 };

  const userIds = [...new Set(subscriptions.map((s) => s.user_id))];
  const profiles: ProfileRow[] = await rest(
    `/timer_profiles?select=user_id,schedule,settings&user_id=in.(${userIds.join(",")})`,
  );
  const profileByUser = new Map(profiles.map((p) => [p.user_id, p]));

  let sent = 0;

  for (const sub of subscriptions) {
    const profile = profileByUser.get(sub.user_id);
    if (!profile || !profile.settings?.alerts) continue;

    for (const alert of dueAlerts(profile.schedule, sub.timezone || "UTC", new Date())) {
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
