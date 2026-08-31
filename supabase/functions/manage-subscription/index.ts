/* ============================================================
   manage-subscription — hands the signed-in user a link to
   Paddle's own hosted customer portal (update payment method,
   view invoices, cancel).

   The caller's own access token is validated first and the user
   id is taken from that token, never from the request body — the
   same rule delete-account follows, for the same reason: one user
   must never be able to ask for another's billing portal.

   Needs PADDLE_API_KEY, a *server* key from Paddle → Developer
   Tools → Authentication -- unrelated to PADDLE_WEBHOOK_SECRET
   (that one only verifies inbound webhooks; this one calls out to
   Paddle's own API) and unrelated to the client-side Paddle
   token in config.js (that one can only open a checkout, nothing
   account-specific).
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PADDLE_API_KEY = Deno.env.get("PADDLE_API_KEY")!;

// Paddle's API is environment-specific, same as the client token in
// config.js -- a sandbox key against api.paddle.com (or the reverse)
// fails every call, not just some of them.
const PADDLE_API_BASE = "https://api.paddle.com";

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

/* Resolve the bearer token to a user, or null if it is not valid. */
async function userFromToken(token: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? user : null;
}

/* This account's Paddle identifiers, or null if it has never
   actually checked out (hardship / complimentary access, or a free
   account that's never upgraded -- both real, both have nothing for
   Paddle to show a portal for). */
async function paddleIdsFor(userId: string) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=paddle_customer_id,paddle_subscription_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!response.ok) {
    throw new Error(`subscription lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.paddle_customer_id) return null;
  return {
    customerId: row.paddle_customer_id as string,
    subscriptionId: row.paddle_subscription_id as string | null,
  };
}

/* Asks Paddle for a portal session. Passing subscription_ids, when we
   have one, gets back deep links (cancel, update payment method) for
   that specific subscription in addition to the general overview URL
   -- we only surface the general one today, but the deep links are
   there in the response if a future version of the button wants them. */
async function createPortalSession(customerId: string, subscriptionId: string | null) {
  const response = await fetch(`${PADDLE_API_BASE}/customers/${customerId}/portal-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PADDLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {}),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Paddle portal-sessions failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  const url = payload?.data?.urls?.general?.overview;
  if (!url) throw new Error("Paddle did not return a portal URL.");
  return url as string;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const header = request.headers.get("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return json({ error: "Missing access token." }, 401);

  const user = await userFromToken(token);
  if (!user) return json({ error: "Not signed in." }, 401);

  try {
    const ids = await paddleIdsFor(user.id);
    if (!ids) {
      return json(
        { error: "No billing account found. This is expected for free, hardship or complimentary access." },
        404,
      );
    }

    const url = await createPortalSession(ids.customerId, ids.subscriptionId);
    return json({ ok: true, url });
  } catch (error) {
    console.error(error);
    return json({ error: String(error instanceof Error ? error.message : error) }, 500);
  }
});
