/* ============================================================
   paddle-webhook — keeps public.subscriptions in step with Paddle.

   Two things make this safe:
   1. The Paddle-Signature header is verified before anything is
      read from the body. An unsigned request is never trusted.
   2. Every event id is recorded first. Paddle retries on failure,
      so a duplicate must be a no-op rather than a second grant.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET")!;

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

/* Record the event id. Returns false if we have already handled it. */
async function claimEvent(eventId: string, eventType: string, userId: string | null, payload: unknown) {
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
  if (response.status === 409) return false; // already processed
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
  return true;
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
   uses for its own grants. */
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
    // Logged, not thrown: claimEvent() above has already marked this
    // event processed, so a Paddle retry (which a 500 here would
    // trigger) would hit that claim and short-circuit to "duplicate"
    // without actually retrying this step -- returning 500 would
    // promise a safety net that does not exist. public.subscriptions
    // (this account's real, authoritative entitlement today) is
    // already correct by the time this runs; this only affects the
    // identity-schema mirror the screen saver depends on. Surfaced
    // here so it is visible in the function's logs, not silently lost.
    console.error(
      `identity-schema grant failed for ${accountId}, capabilities [${failed.join(", ")}]: ` +
      `check Project Settings → Data API → Exposed schemas includes 'identity'.`,
    );
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await request.text();

  if (!await signatureValid(request.headers.get("Paddle-Signature"), rawBody)) {
    // Deliberately terse: do not help an attacker probe the difference.
    return new Response("Invalid signature", { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Malformed JSON", { status: 400 });
  }

  const eventId = String(event.event_id ?? "");
  const eventType = String(event.event_type ?? "");
  // deno-lint-ignore no-explicit-any
  const data = (event.data ?? {}) as any;

  // user_id is passed as custom_data when the checkout is opened.
  const userId: string | null = data?.custom_data?.user_id ?? null;

  if (!eventId) return new Response("Missing event id", { status: 400 });

  try {
    const fresh = await claimEvent(eventId, eventType, userId, event);
    if (!fresh) return Response.json({ ok: true, duplicate: true });

    if (!eventType.startsWith("subscription.")) {
      return Response.json({ ok: true, ignored: eventType });
    }

    if (!userId) {
      // Nothing we can attribute this to. Logged above for manual repair.
      console.error(`No user_id in custom_data for ${eventType} (${eventId})`);
      return Response.json({ ok: true, unattributed: true });
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

    // public.subscriptions (above) stays the authoritative write and can
    // still trigger a Paddle retry via the throw/500 path above it. This
    // one can't safely do the same -- see mirrorToIdentitySchema's own
    // comment -- so it runs after, and failures there are logged, not
    // thrown.
    await mirrorToIdentitySchema(userId, status, row.current_period_end);

    return Response.json({ ok: true, status, plan: row.plan });
  } catch (error) {
    console.error(error);
    // A 500 makes Paddle retry, which is what we want for a transient fault.
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});
