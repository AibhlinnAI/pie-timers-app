/* ============================================================
   review-signin — a reusable sign-in for Google Play's reviewers.

   Every real sign-in here is an emailed one-time code, and a store
   reviewer cannot read an inbox. Google Play turned the review account
   down on 9 Oct 2026 for exactly that: the details given must not send
   a reviewer to an external account, an inbox or a phone for a code.
   They asked for reusable credentials, or a bypass that works on its own.

   So one account, and only one, also accepts a fixed code. Both halves
   are Supabase secrets, never this public repository:

     REVIEW_EMAIL   the review account's address. Used for nothing else:
                    this function replaces any account there it did not
                    make itself (step 1 below).
     REVIEW_CODE    exactly ten digits, given to Play as the password

   Ten digits because that is what the code box takes: a numeric keypad
   and at most ten characters (app/index.html, identity/identity-ui.js).
   A code the reviewer could not type is no code at all, so anything else
   switches this function off rather than half-working. Ten is also never
   the length of a code Supabase emails (eight here), so Supabase always
   refuses it first, and the browser only sends a ten-digit code here.

   For any other address it answers 401 at once, touching nothing.

   On a match it:
     1. makes sure the account at that address is one this function made,
        marked in app_metadata, which only the service role can write.
        Reviewers may test Delete account, and the address is then free
        for anyone to register, with a password of their own, until the
        next review sign-in. Anything found there without the mark is
        deleted and made again, which ends whatever password or sessions
        came with it. The account that existed before this function did
        is replaced the same way, once.
     2. makes sure it has Premium with no end date, which is what the
        reviewer is there to look at. Reviewers cannot use trials.
     3. gives it a fresh password nobody knows. The app never uses one,
        but Supabase will keep one if asked, and a code holder could set
        one from their session that would outlive a change of code.
     4. mints an ordinary session the way an emailed code would: a
        one-time code from the admin API, verified on the spot. The
        browser adopts the answer exactly as it adopts any verified code.

   Changing the code: delete the review account in Supabase
   (Authentication > Users) as well as changing REVIEW_CODE. Deleting
   it ends every session already handed out; the next sign-in makes it
   again.

   Attempts on the review address are throttled per IP, storing only
   hashes, in the same table the `signin` function uses. Unlike `signin`,
   this throttle fails closed: it is the only thing standing between a
   fixed code and a guess, and failing closed costs one reviewer a retry.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const REVIEW_EMAIL = (Deno.env.get("REVIEW_EMAIL") ?? "").trim().toLowerCase();
const REVIEW_CODE = (Deno.env.get("REVIEW_CODE") ?? "").replace(/[\s-]+/g, "");

const ENABLED = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(REVIEW_EMAIL) && /^\d{10}$/.test(REVIEW_CODE);
if (!ENABLED) {
  console.warn("review-signin is off: REVIEW_EMAIL or REVIEW_CODE is unset, or the code is not ten digits.");
}

/* A reviewer who mistypes a few times is fine. Ten tries an hour per IP
   against ten random digits is not a code anyone guesses. The address is
   not counted on to stay secret: `signin` and this function both answer
   differently for it, so anyone can confirm a guess at it. */
const MAX_ATTEMPTS_PER_IP_PER_HOUR = 10;

/* The mark in app_metadata that says this function made the account. */
const MARK = "review_account";

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

/* The answer for every address but one, and for a wrong code. The browser
   treats it as "not mine" and shows Supabase's own refusal instead. */
function notThisAccount() {
  return json({ error: "That code is not valid." }, 401);
}

/* Failures that only the review account can reach. `review: true` is how
   the browser knows this message is meant for the person at the screen,
   rather than a platform error from a function that never started. */
function reviewError(message: string, status: number) {
  return json({ error: message, review: true }, status);
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Compares every digit whatever the answer, so the time taken says
   nothing about how much of a guess was right. */
function sameCode(given: string, expected: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function serviceHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/* ── The throttle ─────────────────────────────────────────────────
   Attempts sit in signin_attempts under their own markers. The prefix
   on the IP hash keeps them out of `signin`'s per-IP count, and no real
   address hashes to the marker, so neither function's numbers move the
   other's.

   Each attempt is written down BEFORE its code is looked at, then the
   hour is counted, own row included. Attempts racing in parallel cannot
   all squeeze under the limit that way, and a database that will not
   take the write stops the guessing instead of the counting. A right
   code takes its own row back out, so only failures count. */
let attemptMarker: string | null = null;
async function marker() {
  return attemptMarker ??= await hash("review-signin");
}

async function claimAttempt(ipHash: string): Promise<string | null> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/signin_attempts?select=id`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ email_hash: await marker(), ip_hash: ipHash }),
  });
  if (!response.ok) {
    console.error(`review-signin: throttle write failed: ${response.status}`);
    return null;
  }
  const rows: Array<{ id?: unknown }> = await response.json();
  return rows?.[0]?.id != null ? String(rows[0].id) : null;
}

async function attemptsThisHour(ipHash: string): Promise<number | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/signin_attempts?select=id` +
      `&email_hash=eq.${await marker()}&ip_hash=eq.${ipHash}&attempted_at=gte.${since}`,
    { headers: serviceHeaders() },
  );
  if (!response.ok) {
    console.error(`review-signin: throttle read failed: ${response.status}`);
    return null;
  }
  const rows: unknown[] = await response.json();
  return rows.length;
}

async function releaseAttempt(id: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/signin_attempts?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: serviceHeaders({ Prefer: "return=minimal" }),
  }).catch(() => {/* best effort: at worst a right code counts once */});
}

/* ── The account ──────────────────────────────────────────────── */

/* Makes the account, marked, unless something is already registered at
   the address. That is the normal case and not an error; step 1's check
   of the mark decides whether it can stay. */
async function createAccount() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ email: REVIEW_EMAIL, email_confirm: true, app_metadata: { [MARK]: true } }),
  });
  if (response.ok || response.status === 422) return;
  throw new Error(`create user: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

async function removeAccount(userId: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete user: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

/* A one-time code, minted without sending anything. The answer also
   carries the account's id and app_metadata. */
async function mintOneTimeCode() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ type: "magiclink", email: REVIEW_EMAIL }),
  });
  if (!response.ok) {
    throw new Error(`generate_link: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const link = await response.json();
  const userId = link?.id ?? link?.user?.id;
  const otp = link?.email_otp ?? link?.properties?.email_otp;
  if (!userId || !otp) throw new Error("generate_link: no user id or one-time code in the answer");
  const meta = link?.app_metadata ?? link?.user?.app_metadata ?? {};
  return { userId: String(userId), otp: String(otp), marked: meta[MARK] === true };
}

/* Step 1: the account at the review address, replaced if this function
   did not make it. */
async function reviewAccount() {
  await createAccount();
  let link = await mintOneTimeCode();
  if (link.marked) return link;

  console.warn("review-signin: replacing an account at the review address that this function did not make");
  await removeAccount(link.userId);
  await createAccount();
  link = await mintOneTimeCode();
  if (!link.marked) throw new Error("the account at the review address could not be replaced");
  return link;
}

/* Step 2. Premium with no end date, written the way schema-billing.sql's
   complimentary recipe writes it. Every sign-in re-asserts it, so a
   recreated account (whose sign-up trigger starts a trial) ends up the
   same as the original.

   The identity-schema grants in that recipe are left out on purpose.
   They gate only the Windows screen saver, which a Play reviewer never
   runs, and the app itself reads public.subscriptions alone. */
async function ensurePremium(userId: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({
      user_id: userId,
      status: "active",
      plan: "complimentary",
      complimentary: true,
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`subscription: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

/* Step 3. Random, long, and every character class, so no password
   policy can refuse it. Never stored or shown anywhere. */
async function forgetPassword(userId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  const password = btoa(String.fromCharCode(...bytes)) + "aA1!";
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: serviceHeaders(),
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`reset password: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

/* Step 4. The same verification the browser makes for an emailed code.
   The reviewer's own User-Agent is passed on, so the session Supabase
   records names their device rather than this function's runtime.

   Returns null when Supabase calls the code expired. That only happens
   when a second reviewer's sign-in minted a newer code in between, which
   replaces the older one, and the caller simply goes round once more. */
async function exchange(otp: string, userAgent: string | null) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      ...(userAgent ? { "User-Agent": userAgent } : {}),
    },
    body: JSON.stringify({ type: "email", email: REVIEW_EMAIL, token: otp }),
  });
  if (response.status === 403) {
    console.warn(`review-signin: verify said ${(await response.text()).slice(0, 120)}`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`verify: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const session = await response.json();
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error("verify: the answer had no session in it");
  }
  return session;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: { email?: unknown; code?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.replace(/[\s-]+/g, "") : "";

  if (!ENABLED || email !== REVIEW_EMAIL) return notThisAccount();

  const ip = request.headers.get("cf-connecting-ip") ??
             request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
  const ipHash = await hash("review-signin:" + (ip || "unknown"));

  const attempt = await claimAttempt(ipHash).catch(() => null);
  const tries = attempt ? await attemptsThisHour(ipHash).catch(() => null) : null;
  if (tries === null) {
    return reviewError("Could not sign in to the review account. Please try again in a minute.", 503);
  }
  if (tries > MAX_ATTEMPTS_PER_IP_PER_HOUR) {
    return reviewError("Too many wrong codes. Please try again in an hour.", 429);
  }
  if (!sameCode(code, REVIEW_CODE)) return notThisAccount();
  await releaseAttempt(attempt!);

  try {
    const userAgent = request.headers.get("user-agent");
    let link = await reviewAccount();
    // Before the session exists, so the app's first look at the
    // account already finds Premium, and no older password survives it.
    await ensurePremium(link.userId);
    await forgetPassword(link.userId);
    let session = await exchange(link.otp, userAgent);
    if (!session) {
      link = await mintOneTimeCode();
      session = await exchange(link.otp, userAgent);
    }
    if (!session) throw new Error("verify: the one-time code was refused twice");
    return json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      token_type: session.token_type,
      user: session.user,
    });
  } catch (err) {
    console.error(`review-signin: ${err instanceof Error ? err.message : String(err)}`);
    return reviewError("Could not sign in to the review account. Please try again in a minute.", 502);
  }
});
