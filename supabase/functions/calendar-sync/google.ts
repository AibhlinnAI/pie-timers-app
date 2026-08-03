/* ============================================================
   Google Calendar reader.

   Much simpler than the iCalendar path because Google expands
   recurrence for us: singleEvents=true returns individual
   occurrences with real start times, already in the right
   timezone. None of ical.js is involved.
   ============================================================ */

const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const MAX_PAGES = 5;
const PAGE_SIZE = 250;

export interface GoogleEvent {
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  location: string | null;
}

/* Thrown when the grant is gone for good — revoked by the user, or
   expired because the OAuth app is still in Google's testing mode. */
export class GrantExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantExpiredError";
  }
}

async function accessTokenFrom(refreshToken: string): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Google Calendar is not configured on the server.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // invalid_grant is the one users actually hit, and the message needs
    // to tell them what to do rather than quote an OAuth error code.
    if (payload?.error === "invalid_grant") {
      throw new GrantExpiredError(
        "Google access has expired. Reconnect your calendar to restore it.",
      );
    }
    throw new Error(`Google refused the token (${payload?.error ?? response.status}).`);
  }

  if (!payload.access_token) throw new Error("Google did not return an access token.");
  return payload.access_token as string;
}

export async function fetchGoogleEvents(
  refreshToken: string,
  calendarId: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<GoogleEvent[]> {
  const accessToken = await accessTokenFrom(refreshToken);
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      singleEvents: "true",              // expand recurrence server-side
      orderBy: "startTime",
      timeMin: new Date(windowStartMs).toISOString(),
      timeMax: new Date(windowEndMs).toISOString(),
      maxResults: String(PAGE_SIZE),
      showDeleted: "false",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/calendar/v3/calendars/` +
      `${encodeURIComponent(calendarId || "primary")}/events?${params}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401 || response.status === 403) {
      throw new GrantExpiredError(
        "Google denied access to that calendar. Reconnect to restore it.",
      );
    }
    if (!response.ok) {
      throw new Error(`Google Calendar replied ${response.status}.`);
    }

    const payload = await response.json();

    for (const item of payload.items ?? []) {
      if (item.status === "cancelled") continue;

      const startRaw = item.start?.dateTime ?? item.start?.date;
      if (!startRaw) continue;

      // A `date` (rather than `dateTime`) means an all-day entry.
      const allDay = !item.start?.dateTime;
      const startsAt = new Date(startRaw);
      if (isNaN(startsAt.getTime())) continue;

      const endRaw = item.end?.dateTime ?? item.end?.date;
      const endsAt = endRaw ? new Date(endRaw) : null;

      events.push({
        uid: String(item.id ?? crypto.randomUUID()),
        title: String(item.summary ?? "(no title)").slice(0, 200),
        startsAt,
        endsAt: endsAt && !isNaN(endsAt.getTime()) ? endsAt : null,
        allDay,
        location: item.location ? String(item.location).slice(0, 200) : null,
      });
    }

    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  return events;
}
