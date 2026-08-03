/* ============================================================
   google-connect — stores (and revokes) a Google Calendar grant.

   The browser receives a provider_refresh_token in the OAuth
   redirect fragment. That token is a long-lived key to the user's
   calendar, so it is handed straight here and never kept client
   side, never written to localStorage, and never returned again.

   Two actions:
     { action: 'connect', refreshToken, email }
     { action: 'disconnect' }
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

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
  const result = await rest("/rpc/has_active_plan", {
    method: "POST",
    body: JSON.stringify({ uid: userId }),
  });
  return result === true;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const header = request.headers.get("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return json({ error: "Not signed in." }, 401);

  const user = await userFromToken(token);
  if (!user) return json({ error: "Not signed in." }, 401);

  let body: { action?: string; refreshToken?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  /* ── Disconnect ── */
  if (body.action === "disconnect") {
    const rows = await rest(
      `/calendar_feeds?select=id,google_refresh_token&user_id=eq.${user.id}&kind=eq.google`,
    );

    // Revoke at Google too. Deleting our row alone would leave the grant
    // live in the user's Google account, which is not what "disconnect" means.
    for (const row of rows ?? []) {
      if (row.google_refresh_token) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: row.google_refresh_token }),
        }).catch(() => {/* revoke is best effort; deletion still proceeds */});
      }
    }

    await rest(`/calendar_feeds?user_id=eq.${user.id}&kind=eq.google`, { method: "DELETE" });
    return json({ ok: true, disconnected: true });
  }

  /* ── Connect ── */
  if (!await isEntitled(user.id)) {
    return json({ error: "Calendar sync is included with a plan." }, 402);
  }

  const refreshToken = (body.refreshToken ?? "").trim();
  if (!refreshToken) {
    return json({
      error:
        "Google did not return a long-lived token. Disconnect the app in your " +
        "Google account settings and try connecting again.",
    }, 400);
  }

  // Reconnecting is an update, not a second row. The partial unique index
  // cannot be used for ON CONFLICT inference, so branch explicitly rather
  // than relying on an upsert that would fail in a hard-to-read way.
  const existing = await rest(
    `/calendar_feeds?select=id&user_id=eq.${user.id}&kind=eq.google`,
  );

  const fields = {
    google_refresh_token: refreshToken,
    google_account_email: body.email ?? user.email ?? null,
    google_calendar_id: "primary",
    active: true,
    last_error: null,
  };

  if (existing && existing.length) {
    await rest(`/calendar_feeds?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(fields),
    });
    return json({ ok: true, reconnected: true });
  }

  await rest("/calendar_feeds", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(Object.assign({
      user_id: user.id,
      kind: "google",
      label: "Google Calendar",
    }, fields)),
  });

  return json({ ok: true });
});
