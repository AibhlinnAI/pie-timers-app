/* ============================================================
   delete-account — permanently removes the calling user.

   Deleting an auth user needs the service-role key, which must
   never reach the browser, so it happens here instead. The
   caller's own access token is validated first and the user id
   is taken from that token — never from the request body — so
   one user cannot delete another.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

/* Set ALLOWED_ORIGIN to your site URL in production. */
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

async function deleteRows(table: string, userId: string) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?user_id=eq.${userId}`,
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "return=minimal",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Failed clearing ${table}: ${response.status} ${await response.text()}`);
  }
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
    // The foreign keys cascade, but clearing these explicitly keeps the
    // intent obvious and survives anyone later altering the constraints.
    await deleteRows("push_subscriptions", user.id);
    await deleteRows("timer_profiles", user.id);
    await deleteRows("notification_log", user.id);

    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });

    if (!response.ok) {
      return json({ error: `Could not delete the account: ${await response.text()}` }, 500);
    }

    return json({ ok: true, deleted: user.id });
  } catch (error) {
    console.error(error);
    return json({ error: String(error instanceof Error ? error.message : error) }, 500);
  }
});
