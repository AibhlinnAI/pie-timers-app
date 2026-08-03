/* ============================================================
   notify-milestones — runs every minute from pg_cron.

   For each user who has alerts switched on, works out where each
   of today's timers sits in their own timezone and pushes the
   milestones that have just come due. The notification_log table
   is the idempotency guard: a milestone is written before it is
   sent, and the primary key stops a second run repeating it.
   ============================================================ */

import { sendPush, type PushSubscription } from "./webpush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const MILESTONES = [30, 15, 10, 5];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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
  return response.status === 204 ? null : await response.json();
}

/* ─────────────────────────── Timezone-aware clock ─────────────────────────── */

/* Read the wall clock in an arbitrary IANA timezone without pulling in
   a date library. Falls back to UTC if the zone is not recognised. */
function localNow(timezone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  } catch {
    return localNow("UTC");
  }

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);

  return {
    dayName: get("weekday"),
    isoDate: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + minute,
  };
}

/* ─────────────────────────── Timer maths ───────────────────────────
   Deliberately mirrors computeTimer() in app.js. If one changes, the
   other must change with it, or the app and the push will disagree. */

function remainingMinutes(nowMin: number, startMin: number, targetMin: number) {
  let total = targetMin - startMin;
  if (total <= 0) total += 1440;

  let sinceStart = nowMin - startMin;
  if (sinceStart < -720) sinceStart += 1440;

  if (sinceStart < 0) return null;               // shift has not begun
  const elapsed = Math.min(sinceStart, total);
  return total - elapsed;
}

function isMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1440;
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

    const now = localNow(sub.timezone || "UTC");
    const day = profile.schedule?.[now.dayName];
    if (!day?.working || !isMinute(day.start)) continue;

    const timers: Array<{ key: string; label: string; target: unknown }> = [
      { key: "lunch", label: "Lunch | Head Home", target: day.lunch },
      { key: "end", label: "End of Day", target: day.end },
    ];

    for (const timer of timers) {
      if (!isMinute(timer.target)) continue;

      const remaining = remainingMinutes(now.minutes, day.start, timer.target);
      if (remaining === null) continue;

      let milestone: string | null = null;
      let body: string;

      if (remaining === 0) {
        milestone = "done";
        body = "Time reached.";
      } else {
        const hit = MILESTONES.find((m) => m === remaining);
        if (hit === undefined) continue;
        milestone = String(hit);
        body = `${hit} minutes remaining.`;
      }

      // Claim the milestone first. A duplicate key means another run
      // already has it, so this run must not send.
      const claimed = await claim(sub.user_id, now.isoDate, timer.key, milestone);
      if (!claimed) continue;

      const result = await sendPush(
        { endpoint: sub.endpoint, keys: sub.keys } as PushSubscription,
        {
          title: timer.label,
          body,
          // Same tag scheme as the in-page alert, so the two collapse
          // into a single notification rather than stacking.
          tag: `${now.isoDate}|${timer.key}|${milestone}`,
        },
        { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: VAPID_SUBJECT },
      ).catch((err) => {
        console.error(`push failed for ${sub.endpoint}: ${err.message}`);
        return { ok: false, status: 0, gone: false };
      });

      if (result.gone) {
        await rest(`/push_subscriptions?id=eq.${sub.id}`, { method: "DELETE" })
          .catch(() => {/* it will be retried next run */});
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
  // pg_cron passes the shared secret; without it this endpoint is closed.
  if (CRON_SECRET) {
    const provided = request.headers.get("x-cron-secret");
    if (provided !== CRON_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  try {
    const summary = await run();
    return Response.json({ ok: true, ...summary });
  } catch (error) {
    console.error(error);
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});
