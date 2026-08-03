/* ============================================================
   signin — Turnstile-gated proxy for magic-link requests.

   The browser used to call /auth/v1/otp directly, which left no
   place to put a bot check or a throttle. Routing through here
   adds three layers before an email can be sent:

     1. Cloudflare Turnstile must pass.
     2. Per-email and per-IP throttles in Postgres.
     3. Supabase's own auth rate limits, still active behind us.

   Without this, the sign-in form is an open relay for emailing
   strangers — it burns the sending quota and the domain's
   reputation along with it.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

/* Throttles. Deliberately generous — a real person hitting these is
   already having a bad time, and the bot check does the heavy lifting. */
const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 15;

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

/* Hash before storing: throttle counters do not need raw emails or IPs. */
async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value.toLowerCase().trim()),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, ip: string) {
  if (!TURNSTILE_SECRET) return true; // not configured yet — fail open, see README
  if (!token) return false;

  const body = new FormData();
  body.append("secret", TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true;
}

async function rest(path: string, init: RequestInit = {}) {
  return await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/* Returns true when the caller is under both limits. */
async function withinLimits(emailHash: string, ipHash: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const response = await rest(
    `/signin_attempts?select=email_hash,ip_hash&attempted_at=gte.${since}` +
    `&or=(email_hash.eq.${emailHash},ip_hash.eq.${ipHash})`,
  );
  if (!response.ok) {
    console.error(`throttle read failed: ${await response.text()}`);
    return true; // never lock people out because our own bookkeeping broke
  }

  const rows: Array<{ email_hash: string; ip_hash: string }> = await response.json();
  const byEmail = rows.filter((r) => r.email_hash === emailHash).length;
  const byIp = rows.filter((r) => r.ip_hash === ipHash).length;

  return byEmail < MAX_PER_EMAIL_PER_HOUR && byIp < MAX_PER_IP_PER_HOUR;
}

async function recordAttempt(emailHash: string, ipHash: string) {
  await rest("/signin_attempts", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ email_hash: emailHash, ip_hash: ipHash }),
  }).catch(() => {/* best effort */});
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: { email?: string; turnstileToken?: string; redirectTo?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") ??
             request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";

  if (!await verifyTurnstile(body.turnstileToken ?? "", ip)) {
    return json({ error: "Could not verify you are human. Please try again." }, 403);
  }

  const emailHash = await hash(email);
  const ipHash = await hash(ip || "unknown");

  if (!await withinLimits(emailHash, ipHash)) {
    return json(
      { error: "Too many sign-in emails requested. Please try again in an hour." },
      429,
    );
  }

  await recordAttempt(emailHash, ipHash);

  const otp = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      create_user: true,
      options: { email_redirect_to: body.redirectTo || ALLOWED_ORIGIN },
    }),
  });

  if (!otp.ok) {
    const detail = await otp.text();
    console.error(`otp failed: ${otp.status} ${detail}`);
    return json({ error: "Could not send the sign-in email. Please try again shortly." }, 502);
  }

  // Always the same response shape, so this cannot be used to test
  // whether a given address has an account.
  return json({ ok: true });
});
