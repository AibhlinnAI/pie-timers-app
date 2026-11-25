/* ============================================================
   signin — Turnstile-gated proxy for magic-link requests.

   The browser used to call /auth/v1/otp directly, which left no
   place to put a bot check or a throttle. Routing through here
   adds three layers before an email can be sent:

     1. Cloudflare Turnstile must pass.
     2. Per-email and per-IP throttles in Postgres.
     3. Supabase's own auth rate limits, still active behind us.

   Without this, the sign-in form is an open relay for emailing
   strangers — and burns the sending quota and the domain's
   reputation along the way.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";

/* The one account that is never emailed: see the check in the handler. */
const REVIEW_EMAIL = (Deno.env.get("REVIEW_EMAIL") ?? "").trim().toLowerCase();

/* Throttles. Deliberately generous — a real person hitting these is
   already having a bad time, and the bot check does the heavy lifting. */
const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 15;

/* Which sites may call this function from a browser.

   ALLOWED_ORIGINS is a comma-separated list, for example
   "https://pietimers.aibhlinn.ai,https://premium.aibhlinn.ai".
   ALLOWED_ORIGIN, the older single setting, still counts: the two are
   read together, so the site named there keeps working whatever the
   new setting holds. With neither set, every site is allowed ("*"),
   as before. A "*" beside real sites is ignored, so one stray entry
   cannot open a list that names its sites.

   A browser accepts one origin in Access-Control-Allow-Origin, never a
   list. So the answer echoes the caller's own Origin when that origin
   is on the list and carries no such header when not, and
   "Vary: Origin" tells any cache the answer depends on who asked.

   The same block is in signin and in create-checkout. Keep the two in
   step. */
const ALLOWED_ORIGINS: string[] = [
  ...new Set(
    `${Deno.env.get("ALLOWED_ORIGINS") ?? ""},${Deno.env.get("ALLOWED_ORIGIN") ?? ""}`
      .split(",")
      .map((entry) => entry.trim().replace(/\/+$/, ""))
      .filter((entry) => entry !== "" && entry !== "*"),
  ),
];
const ANY_ORIGIN = ALLOWED_ORIGINS.length === 0;

function corsFor(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (ANY_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  headers["Vary"] = "Origin";
  const origin = request.headers.get("origin") ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/* Every answer leaves through here, so no path can forget the headers. */
async function answered(request: Request, handle: (request: Request) => Promise<Response>) {
  const cors = corsFor(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const response = await handle(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

/* The action and hostname a token must have been minted for. A
   siteverify success only says "Cloudflare issued this token for this
   sitekey" -- without naming which page or which form. Without
   these two checks a token harvested from any other widget on the same
   sitekey is accepted here, which is most of the point of having one. */
const TURNSTILE_ACTION = "signin";
const TURNSTILE_HOSTNAMES: string[] = ANY_ORIGIN ? [] : ALLOWED_ORIGINS.flatMap((origin) => {
  try {
    return [new URL(origin).hostname];
  } catch {
    return [];
  }
});

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
  if (result.success !== true) return false;

  // Both checks are skipped rather than failed when the token carries
  // no such field: older widgets omit action entirely, and a hostname
  // cannot be compared when every site is allowed ("*"). Failing there
  // would lock out sign-in on a misconfiguration, which is worse than
  // the check not running -- but say so in the logs either way.
  if (result.action && result.action !== TURNSTILE_ACTION) {
    console.warn(`Turnstile action mismatch: ${result.action}`);
    return false;
  }
  if (TURNSTILE_HOSTNAMES.length > 0 && result.hostname && !TURNSTILE_HOSTNAMES.includes(result.hostname)) {
    console.warn(`Turnstile hostname mismatch: ${result.hostname}`);
    return false;
  }
  return true;
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

/* Where the link in the email sends the person afterwards.

   The page asks for an address (redirectTo). That address is used only
   when the address is on one of the allowed sites, judged on the whole
   origin and never on how the text starts: "https://site.example.evil"
   starts with "https://site.example" and is a different site. Anything
   else falls back to the site that asked, when that site is allowed,
   and otherwise to the first site on the list. With every site allowed
   ("*") nothing can be judged here, and the address goes through as
   before; Supabase's own list of redirect addresses still applies. */
function redirectFor(request: Request, asked: unknown): string {
  if (ANY_ORIGIN) return (typeof asked === "string" && asked) || "*";
  if (typeof asked === "string" && asked !== "") {
    try {
      /* The scheme is checked as well as the origin: "blob:https://site/x"
         reports the site's origin and is not a page anyone can open. */
      const address = new URL(asked);
      const web = address.protocol === "https:" || address.protocol === "http:";
      if (web && ALLOWED_ORIGINS.includes(address.origin)) return asked;
    } catch { /* not an address at all */ }
  }
  const origin = request.headers.get("origin") ?? "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

Deno.serve((request) => answered(request, handle));

async function handle(request: Request): Promise<Response> {
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

  /* The store review account signs in with a fixed code instead (see
     review-signin), so nothing is ever emailed to it. Sending anyway
     would be worse than useless: minting that account's session starts
     Supabase's 60-second resend wait, so a reviewer who signed out and
     straight back in would get an error here and never see the code box.
     Answered before the bot check and the throttle, neither of which has
     anything to protect when nothing is sent. That also tells anyone who
     asks that this one address is special, which is why nothing about the
     review account depends on the address staying secret. The header
     panel relies on this order when Turnstile will not finish
     (identity-bridge.js). */
  if (REVIEW_EMAIL && email === REVIEW_EMAIL) return json({ ok: true });

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
      options: { email_redirect_to: redirectFor(request, body.redirectTo) },
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
}
