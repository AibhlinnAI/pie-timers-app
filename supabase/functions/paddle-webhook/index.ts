/* ============================================================
   paddle-webhook — keeps public.subscriptions in step with Paddle.

   Two things make this safe:
   1. The Paddle-Signature header is verified before anything is
      read from the body. An unsigned request is never trusted.
   2. An event id is recorded only once everything it triggers has
      actually succeeded -- not before. Paddle retries on failure, so
      a genuine duplicate must be a no-op, but a *partial* failure
      must NOT look like one: recording the id first (an earlier
      version of this function did exactly that) makes a retry after
      a mid-processing failure see the id already logged and report
      "already processed" without redoing the part that failed. See
      wasAlreadyProcessed()/recordEvent() below.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET")!;

// Paddle calls this server-to-server, so it is never subject to CORS --
// these headers exist only so a browser (diagnostics.html's own health
// check) gets a real response instead of a blocked preflight.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, paddle-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* Paddle sends: Paddle-Signature: ts=1700000000;h1=<hex hmac> */
async function signatureValid(header: string | null, rawBody: string) {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(";").map((p) => p.split("=") as [string, string]),
  );
  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) return false;

  // Reject anything older than five minutes to blunt replay attempts.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}:${rawBody}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare so a timing side channel cannot leak the digest.
  if (expected.length !== h1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ h1.charCodeAt(i);
  return diff === 0;
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
  return response;
}

/* Read-only duplicate check. Does NOT record anything -- recording
   happens only via recordEvent() below, once this event's work has
   actually finished, which is what makes a retry after a partial
   failure reprocess instead of silently no-op-ing. */
async function wasAlreadyProcessed(eventId: string): Promise<boolean> {
  const response = await rest(
    `/billing_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`,
  );
  if (!response.ok) {
    throw new Error(`duplicate check failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

/* Records an event as fully processed. Call this LAST, only after
   every write the event triggers has actually succeeded -- see the
   file header for why the ordering is the whole point. */
async function recordEvent(eventId: string, eventType: string, userId: string | null, payload: unknown) {
  const response = await rest("/billing_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      event_id: eventId,
      event_type: eventType,
      user_id: userId,
      payload,
    }),
  });
  // A 409 here means a concurrent duplicate delivery finished its own
  // (idempotent) processing microseconds before this one and logged
  // the event first -- the work was done twice safely, so losing the
  // race to log it is not a failure.
  if (!response.ok && response.status !== 409) {
    throw new Error(`record failed: ${response.status} ${await response.text()}`);
  }
}

/* Map a Paddle billing cycle onto our two plan names. */
function planFromInterval(interval: string | undefined) {
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  return null;
}

/* Grants (or refreshes) one identity-schema capability for an account.
   Requires the `identity` schema to be added under Project Settings →
   Data API → Exposed schemas (see identity-schema.sql's own note) --
   until that's done, every call here fails, every time, not just
   transiently. */
async function grantCapability(
  accountId: string,
  productId: string,
  capability: string,
  expiresAt: string | null,
) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/grant_capability`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "identity",
    },
    body: JSON.stringify({
      p_account_id: accountId,
      p_product_id: productId,
      p_capability: capability,
      p_source: "subscription",
      p_expires_at: expiresAt,
    }),
  });
  if (!response.ok) {
    throw new Error(`grant_capability(${capability}) failed: ${response.status} ${await response.text()}`);
  }
}

/* Mirrors this event's outcome into identity.product_entitlements, so
   the suite-wide capability check (identity/entitlements.js --
   currently the Windows screen saver's *only* gate) agrees with
   public.subscriptions without Pie Timers' own gating having migrated
   onto the identity schema yet (see identity-schema.sql's header
   note -- still deliberately not done).

   Deliberately time-bounded (expiresAt, never null-forever): a
   subscription's access is only ever as good as its current period.
   Granting once and leaving it to expire on its own -- rather than
   requiring an explicit revoke on cancellation -- is what stops
   access surviving a cancellation forever. Nothing calls this for a
   status this function decides is NOT currently entitled, which is
   what makes the omission double as the revocation: no fresh grant
   call means the previous expiry (already in the database) is left to
   lapse on its own, exactly the mechanism schema-hardship.sql already
   uses for its own grants.

   Throws on failure, so a transient fault here (a timeout, Supabase
   hiccuping, or -- see grantCapability's own note -- the identity
   schema not yet exposed under Project Settings → Data API) makes
   Paddle retry the whole event, same as a public.subscriptions
   failure does. That only works because recordEvent() is no longer
   called until every write this function makes has succeeded -- an
   earlier version of this function swallowed its own errors here
   specifically because throwing couldn't have triggered a real retry
   under the old claim-first ordering. The screen saver has no
   fallback onto public.subscriptions (ARCHITECTURE.md §2), so a
   silent, permanent miss here is worse than a loud, retried one. */
async function mirrorToIdentitySchema(
  accountId: string,
  status: string,
  currentPeriodEnd: string | null,
) {
  const stillWithinPeriod = !currentPeriodEnd || new Date(currentPeriodEnd).getTime() > Date.now();
  const isActiveish = ["active", "trialing", "past_due"].includes(status);
  if (!isActiveish || !stillWithinPeriod) return; // let the existing grant lapse; nothing to write

  const capabilities = ["can_sync", "can_use_calendar", "can_use_screensaver"];
  const results = await Promise.allSettled(
    capabilities.map((cap) => grantCapability(accountId, "pie-timers", cap, currentPeriodEnd)),
  );

  const failed = results
    .map((r, i) => (r.status === "rejected" ? capabilities[i] : null))
    .filter((c): c is string => c !== null);

  if (failed.length > 0) {
    console.error(
      `identity-schema grant failed for ${accountId}, capabilities [${failed.join(", ")}]: ` +
      `check Project Settings → Data API → Exposed schemas includes 'identity'.`,
    );
    throw new Error(`identity-schema grant failed for capabilities [${failed.join(", ")}]`);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const rawBody = await request.text();

  if (!await signatureValid(request.headers.get("Paddle-Signature"), rawBody)) {
    // Deliberately terse: do not help an attacker probe the difference.
    return new Response("Invalid signature", { status: 401, headers: corsHeaders });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Malformed JSON", { status: 400, headers: corsHeaders });
  }

  const eventId = String(event.event_id ?? "");
  const eventType = String(event.event_type ?? "");
  // deno-lint-ignore no-explicit-any
  const data = (event.data ?? {}) as any;

  // user_id is passed as custom_data when the checkout is opened.
  const userId: string | null = data?.custom_data?.user_id ?? null;

  if (!eventId) return new Response("Missing event id", { status: 400, headers: corsHeaders });

  try {
    if (await wasAlreadyProcessed(eventId)) {
      return Response.json({ ok: true, duplicate: true }, { headers: corsHeaders });
    }

    if (!eventType.startsWith("subscription.")) {
      // Nothing to do for this event type -- recorded so a retry of
      // the same delivery doesn't repeat this check for no reason.
      await recordEvent(eventId, eventType, userId, event);
      return Response.json({ ok: true, ignored: eventType }, { headers: corsHeaders });
    }

    if (!userId) {
      // Nothing we can attribute this to, and retrying won't add a
      // user_id that isn't in the payload -- recorded so this specific
      // unusable event doesn't need re-diagnosing on every retry.
      console.error(`No user_id in custom_data for ${eventType} (${eventId})`);
      await recordEvent(eventId, eventType, userId, event);
      return Response.json({ ok: true, unattributed: true }, { headers: corsHeaders });
    }

    const interval = data?.billing_cycle?.interval;
    const status = eventType === "subscription.canceled"
      ? "canceled"
      : String(data?.status ?? "active");

    const row = {
      user_id: userId,
      status,
      plan: planFromInterval(interval),
      paddle_customer_id: data?.customer_id ?? null,
      paddle_subscription_id: data?.id ?? null,
      current_period_end: data?.current_billing_period?.ends_at ?? null,
      cancel_at_period_end: data?.scheduled_change?.action === "cancel",
      updated_at: new Date().toISOString(),
    };

    const upsert = await rest("/subscriptions", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });

    if (!upsert.ok) {
      throw new Error(`upsert failed: ${upsert.status} ${await upsert.text()}`);
    }

    // public.subscriptions (above) is the authoritative write; this
    // mirrors the same outcome into the identity schema for the screen
    // saver and any future suite app. Also throws on failure now -- see
    // its own comment for why that's safe (and necessary) here.
    await mirrorToIdentitySchema(userId, status, row.current_period_end);

    // Recorded only now that every write above has actually succeeded.
    // See the file header and recordEvent()'s own comment: this used to
    // run first, which quietly defeated Paddle's retry on any failure
    // between here and there.
    await recordEvent(eventId, eventType, userId, event);

    return Response.json({ ok: true, status, plan: row.plan }, { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    // A 500 makes Paddle retry. Nothing on this path was recorded, so
    // the retry actually redoes whatever failed instead of the
    // duplicate check silently absorbing it.
    return Response.json({ ok: false, error: String(error) }, { status: 500, headers: corsHeaders });
  }
});
