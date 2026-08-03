/* ============================================================
   calendar-sync — fetches iCalendar feeds and stores the next
   couple of weeks of occurrences.

   This runs server-side for three reasons: browsers cannot fetch
   calendar URLs cross-origin, the feed URL is a secret that must
   never reach the client again once saved, and expanding
   recurrence once per user beats doing it on every device.

   Two entry points:
     { feedId }  — one feed, authorised by the caller's own token
     { all:true} — every active feed, authorised by CRON_SECRET
   ============================================================ */

import { parseCalendar } from "./ical.js";
import { fetchGoogleEvents, GrantExpiredError } from "./google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const WINDOW_BACK_MS = 24 * 60 * 60 * 1000;        // keep today's earlier events
const WINDOW_FORWARD_MS = 21 * 24 * 60 * 60 * 1000; // three weeks ahead
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const MAX_EVENTS_PER_FEED = 400;

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─────────────────────────── SSRF guard ───────────────────────────
   The feed URL comes from a user, and this server fetches it. Without
   a check that is a request-forgery hole pointed at the internal
   network and the cloud metadata endpoint. */

function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    // webcal:// is just https:// wearing a hat.
    url = new URL(raw.trim().replace(/^webcal:\/\//i, "https://"));
  } catch {
    throw new Error("That does not look like a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Calendar links must start with https:// or webcal://");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost") ||
    host.endsWith(".internal") || host.endsWith(".local")
  ) {
    throw new Error("That address is not reachable.");
  }

  // Literal private / link-local / loopback addresses.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 127 || a === 10 || a === 0 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||          // cloud metadata lives here
      a >= 224
    ) throw new Error("That address is not reachable.");
  }

  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    throw new Error("That address is not reachable.");
  }

  return url;
}

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

async function userFromToken(token: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? user : null;
}

async function isEntitled(userId: string): Promise<boolean> {
  const rows = await rest(`/rpc/has_active_plan`, {
    method: "POST",
    body: JSON.stringify({ uid: userId }),
  });
  return rows === true;
}

/* ─────────────────────────── Fetching ─────────────────────────── */

async function fetchFeed(rawUrl: string): Promise<string> {
  const url = assertSafeUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8" },
    });

    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "The calendar link was not found. Check it has not been reset."
          : `The calendar server replied ${response.status}.`,
      );
    }

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("That calendar is too large to sync.");

    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error("That calendar is too large to sync.");
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new Error("That link did not return a calendar. Copy the iCal/ICS address, not the web page.");
    }
    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The calendar server took too long to respond.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── Sync one feed ─────────────────────────── */

interface FeedRow {
  id: string;
  user_id: string;
  feed_url: string | null;
  label: string;
  kind?: string;
  google_refresh_token?: string | null;
  google_calendar_id?: string | null;
}

const FEED_COLUMNS =
  "id,user_id,feed_url,label,kind,google_refresh_token,google_calendar_id";

async function syncFeed(feed: FeedRow) {
  const now = Date.now();

  try {
    /* Both kinds converge on the same shape here, so everything below —
       storage, the client, the pie — is identical either way. */
    const events = feed.kind === "google"
      ? await fetchGoogleEvents(
          feed.google_refresh_token ?? "",
          feed.google_calendar_id ?? "primary",
          now - WINDOW_BACK_MS,
          now + WINDOW_FORWARD_MS,
        )
      : parseCalendar(
          await fetchFeed(feed.feed_url ?? ""),
          now - WINDOW_BACK_MS,
          now + WINDOW_FORWARD_MS,
          MAX_EVENTS_PER_FEED,
        );

    // Replace wholesale: events get moved, renamed and deleted upstream,
    // and reconciling that is more error-prone than starting clean.
    await rest(`/calendar_events?feed_id=eq.${feed.id}`, { method: "DELETE" });

    if (events.length) {
      const rows = events.map((event) => ({
        user_id: feed.user_id,
        feed_id: feed.id,
        uid: event.uid,
        title: event.title.slice(0, 200),
        starts_at: event.startsAt.toISOString(),
        ends_at: event.endsAt ? event.endsAt.toISOString() : null,
        all_day: event.allDay,
        location: event.location ? event.location.slice(0, 200) : null,
      }));

      // Chunked so one oversized request cannot fail the whole sync.
      for (let i = 0; i < rows.length; i += 100) {
        await rest("/calendar_events", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 100)),
        });
      }
    }

    await rest(`/calendar_feeds?id=eq.${feed.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        last_synced: new Date().toISOString(),
        last_error: null,
        event_count: events.length,
      }),
    });

    return { ok: true, feedId: feed.id, events: events.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const patch: Record<string, unknown> = {
      last_synced: new Date().toISOString(),
      // The message is shown to the user, so keep it human and bounded.
      last_error: message.slice(0, 300),
    };

    // A dead Google grant will never recover on its own. Stop retrying it
    // every 15 minutes and clear the useless token, so the UI can prompt
    // for a reconnect instead of showing the same error forever.
    if (error instanceof GrantExpiredError) {
      patch.active = false;
      patch.google_refresh_token = null;
    }

    await rest(`/calendar_feeds?id=eq.${feed.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    }).catch(() => {/* the error itself is the important part */});

    return { ok: false, feedId: feed.id, error: message };
  }
}

/* ─────────────────────────── Entry ─────────────────────────── */

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: { feedId?: string; all?: boolean };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  /* ── Scheduled run: every active feed ── */
  if (body.all) {
    if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {
      return json({ error: "Forbidden" }, 403);
    }

    const feeds: FeedRow[] = await rest(
      `/calendar_feeds?select=${FEED_COLUMNS}&active=is.true`,
    );

    const results = [];
    for (const feed of feeds) {
      // Only keep syncing for accounts that are actually entitled.
      if (!await isEntitled(feed.user_id)) continue;
      results.push(await syncFeed(feed));
    }

    return json({
      ok: true,
      synced: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  }

  /* ── User-triggered run: one of their own feeds ── */
  const header = request.headers.get("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await userFromToken(token);
  if (!user) return json({ error: "Not signed in." }, 401);

  if (!await isEntitled(user.id)) {
    return json({ error: "Calendar sync is included with a plan." }, 402);
  }

  if (!body.feedId) return json({ error: "No calendar specified." }, 400);

  // Scope by user_id as well as id, so one account cannot sync another's feed.
  const feeds: FeedRow[] = await rest(
    `/calendar_feeds?select=${FEED_COLUMNS}` +
    `&id=eq.${body.feedId}&user_id=eq.${user.id}`,
  );
  if (!feeds.length) return json({ error: "Calendar not found." }, 404);

  const result = await syncFeed(feeds[0]);
  return json(result, result.ok ? 200 : 200); // the error travels in the body
});
