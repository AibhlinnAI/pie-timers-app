/* ============================================================
   paddle-webhook — keeps public.subscriptions in step with Paddle.

   Two things make this safe:
   1. The Paddle-Signature header is verified before anything is
      read from the body. An unsigned request is never trusted.
   2. An event id is recorded only once every write the event triggers has
      actually succeeded -- not before. Paddle retries on failure, so
      a genuine duplicate must be a no-op, but a *partial* failure
      must NOT look like one: recording the id first (an earlier
      version of this function did exactly that) makes a retry after
      a mid-processing failure see the id already logged and report
      "already processed" without redoing the part that failed. See
      wasAlreadyProcessed()/recordEvent() below.
   3. A Foundation place is claimed only after the signature has passed
      and the public.subscriptions row is written, through one database
      function that decides each account once. A failed claim is thrown
      before the event is recorded, so Paddle retries. Never swallow it.
   4. The same goes for the first-payment date. Checkout is given the
      right date to begin with (the create-checkout function), so this
      function is the net under it and should have nothing to move. When
      the rule does ask for a later date than Paddle holds and the move
      does not happen, the failure is held until every other write is
      done and then thrown before the event is recorded, so Paddle
      retries. Never swallow it: a move that silently did not happen is
      a customer charged on a date earlier than the pages promised.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET")!;

// Paddle calls this server-to-server, so CORS never applies --
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

/* ─────────────────── When the first payment is taken ───────────────────
   Someone who subscribes while their 14-day free trial is running gets
   more free time before the first payment. The rule (Mal, 22 Nov 2026)
   is the LATEST of three instants:

   1. the account's creation plus 30 days on a yearly plan, or plus 21
      days on a monthly plan (the trial and one extra week). A plan this
      function cannot read gets 30 days, the later and safer of the two;
   2. LAUNCH_FIRST_CHARGE, so nothing is taken before 2027 ("Pay nothing
      until 2027");
   3. Paddle's own next_billed_at, the date its checkout showed the
      customer. A first payment is never moved to a date EARLIER than
      the customer was shown. Later is always fine. This is a safety
      net, and it holds whatever trial Paddle's prices carry: this
      function never assumes a trial length when Paddle states the
      date.
      When the payload's next_billed_at is missing or unreadable, the
      next best statement of the same date stands in for it
      (paddleFirstPaymentAt). With no such date at all, nothing is
      moved: a move with nothing to check it against could be a move
      earlier.

   Checkout shows the right date itself, and this function is the net
   (the owner, 22 Nov 2026: "just make sure we get the date right").
   The create-checkout function makes the transaction for anyone who
   subscribes while their free trial is running, and puts on it the
   number of whole free days that lands the first payment at or after
   instants 1 and 2. A Paddle trial is whole days counted from the
   purchase, so that count is rounded UP: Paddle's own date is the time
   of day the customer subscribed, on the first such moment at or after
   the rule's date, and less than 24 hours past it. It arrives here as
   next_billed_at, already at or after the other two instants, so the
   latest of the three IS Paddle's date and nothing is sent to Paddle.

   Consistency (Mal, 22 Nov 2026: "consistency is critical when offering
   value for early loyalty"). Two people who made their accounts at the
   same moment get first payments within 24 hours of each other, set by
   the time of day each subscribed and never by which day of the trial
   they subscribed on. (The plan before this was a 7-day trial on
   Paddle's monthly trial price, with the date moved here for every
   monthly subscriber. That is retired: nothing in Paddle has to be set
   to a particular trial length any more.)

   What the net still catches is a subscription that did not come
   through create-checkout: an older cached page that opens one of the
   two retired catalogue trial prices, or one of those prices opened by
   hand. Paddle counts that price's own trial from the purchase, which
   can land short of the rule, and the date is then moved LATER here,
   to exactly the rule's instant. It also catches a date a few seconds
   short. next_billed_at is moved with proration_billing_mode
   do_not_bill, so moving the date does not itself raise an invoice.

   This is the standing rule and it has no cut-off date. Once
   LAUNCH_FIRST_CHARGE is behind us it is simply 30 days yearly, 21 days
   monthly, or Paddle's own date when that is later.
   (History: until 22 Nov 2026 it was 30 days for every plan, and
   1 January 2027 only for a purchase made by the end of 5 December.)

   Applies ONLY to a subscription that arrived with a free period,
   which the payload states outright as status trialing. Someone whose
   trial had already ended pays the full price on the day, and moving
   their next payment would hand them less than the period they paid
   for. Ask the payload; never infer it from a date. Refunding a lapsed
   trial into the offer is a support decision, not one this function
   makes.

   The pages (pricing.html, foundation.html, terms.html) state the same
   rule and the same 1 January 2027, and create-checkout repeats the
   three constants below (tools/foundation-test.mjs pins them equal).
   If one moves, move all of them. This function holds no Foundation
   date: the Foundation window is judged in SQL
   (supabase/schema-foundation.sql).

   PADDLE_API_KEY is needed only when a date has to be moved. A purchase
   that came through create-checkout needs no move, so it is answered
   200 with or without the key. When a move IS needed and does not
   succeed (the key is missing, Paddle refuses or cannot be reached, the
   account's creation date cannot be read), that is a first payment
   left on a date earlier than the pages say, so this function answers
   500 and Paddle sends the event again. Premium is never held back by
   it: the subscriptions row, the identity grants and the Foundation
   claim are all written first, and the failure is thrown only
   afterwards, before the event is recorded. A retry is safe: the
   target depends only on the account, the plan and the date in the
   payload, so it is the same date every time, and moving a date to
   where it already sits changes nothing. (Until 22 Nov 2026 these
   failures were logged and answered 200.)

   Nothing here is true of the live service until both functions have
   been deployed. Run against stubs only (tools/foundation-test.mjs). */
const PADDLE_API_KEY = Deno.env.get("PADDLE_API_KEY") ?? "";
const PADDLE_API_BASE = (Deno.env.get("PADDLE_ENVIRONMENT") ?? "production") === "sandbox"
  ? "https://sandbox-api.paddle.com"
  : "https://api.paddle.com";

const FREE_DAYS_YEARLY = 30;
const FREE_DAYS_MONTHLY = 21;
/* A stand-in, used ONLY when the payload states no date of Paddle's own
   to work from (paddleFirstPaymentAt). It is never part of the rule:
   when Paddle states next_billed_at, that date is used as it is and no
   trial length is assumed.

   It is the LAST stand-in, and the least any of them may be: the trial
   on the two retired catalogue trial prices (app/config.js), 14 days.
   A transaction made by create-checkout carries a longer one, up to 41
   days for a standard account, and the payload says how long: the
   trial's own end date on the item, or failing that the trial length
   on the item's price. Those are read first (paddleFirstPaymentAt), so
   14 days is used only when the payload states none of them, and never
   in place of a longer trial it does state.

   Larger is the safe direction. The stand-in is the date no move may
   fall short of, so guessing too long can only leave a first payment
   LATER than it needed to be, which costs the customer nothing.
   Guessing too short could move a payment to a date EARLIER than
   checkout showed, which is the one thing that must never happen. If
   a catalogue trial price is ever given a longer trial than this,
   raise it. */
const PADDLE_TRIAL_DAYS = 14;
const DAY_MS = 86400000;

/* LAUNCH_FIRST_CHARGE is deliberately NOT Adelaide midnight. The promise
   is "Pay nothing until 2027", and the app is public, so it has to be
   2027 on the customer's own calendar. Midnight on 1 January in Adelaide
   is still 31 December 2026 everywhere to the west: 9:30 pm in Perth,
   1:30 pm in London, 8:30 am in New York. Mal's rule (22 Nov 2026): the
   first charge falls when the last time zone on Earth reaches midnight
   on New Year's Eve. That is UTC-12, so 12:00 UTC on 1 January 2027:
   10:30 pm on 1 January in Adelaide, and already 2027 everywhere, from
   midnight on 1 January at UTC-12 to 2 am on 2 January at UTC+14. That
   is early on 2 January in New Zealand, which is why the pages say
   "from 1 January 2027", never "on". */
const LAUNCH_FIRST_CHARGE = Date.parse("2027-01-01T12:00:00Z");

/* The latest of the three instants above. `plan` is "annual",
   "monthly" or null (planFromInterval); only "monthly" gets the shorter
   run. `shownAt` is Paddle's own first-payment date
   (paddleFirstPaymentAt). Answers null when the account's creation date
   or Paddle's own date cannot be read, so nothing is moved on a guess
   and nothing is ever moved without a date to hold it at or after. */
function firstChargeAt(
  createdAt: string, plan: string | null, shownAt: string | null,
): Date | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  const shown = shownAt ? Date.parse(shownAt) : NaN;
  if (!Number.isFinite(shown)) return null;
  const days = plan === "monthly" ? FREE_DAYS_MONTHLY : FREE_DAYS_YEARLY;
  return new Date(Math.max(LAUNCH_FIRST_CHARGE, created + days * DAY_MS, shown));
}

/* Paddle's own first-payment date, the one its checkout showed the
   customer: the third instant, and the one no move may fall short of.
   `stated` is true only when the payload's next_billed_at says it
   outright. When that is missing or does not parse, a stand-in is used,
   the first of these the payload can give:

   - the end of the current billing period (on a trialing subscription
     that period is the trial);
   - the latest trial end date written on any item (trial_dates);
   - the purchase instant plus the trial length written on the item's
     price, in days, or plus PADDLE_TRIAL_DAYS when that is longer or
     when no price states a trial in days.

   The last used to be the purchase plus 14 days and nothing else. A
   transaction made by create-checkout can carry a 40-day trial, and 14
   days would then be EARLIER than checkout showed, so the move that
   follows a stand-in could have been a move earlier. Reading the trial
   the payload itself states closes that.

   Every one of these is Paddle's own field, inside the signed payload.
   custom_data is deliberately not read here, though create-checkout
   writes the day count there too: on a checkout opened by the browser,
   custom_data is whatever the browser sent.

   A stand-in is the same date or a later one, and later is always
   fine, but it is a floor and not a reading of what Paddle holds
   (deferFirstCharge treats the two differently). Null when none can be
   read. */
type ShownDate = { at: string; stated: boolean };
// deno-lint-ignore no-explicit-any
function paddleFirstPaymentAt(data: any, event: Record<string, unknown>): ShownDate | null {
  const readable = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  if (readable(data?.next_billed_at)) return { at: data.next_billed_at, stated: true };
  const periodEnd = data?.current_billing_period?.ends_at;
  if (readable(periodEnd)) return { at: periodEnd, stated: false };

  // deno-lint-ignore no-explicit-any
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  let trialEnds = NaN;
  let trialDays = 0;
  for (const item of items) {
    const ends = item?.trial_dates?.ends_at;
    if (readable(ends) && !(Date.parse(ends) <= trialEnds)) trialEnds = Date.parse(ends);
    /* A trial length counts only when it is plainly a number of days:
       a whole number from 1 to 999, which is what Paddle allows. Anything
       else (a week, a zero, text) is not guessed at, and the 14-day
       floor below stands. */
    const trial = item?.price?.trial_period;
    if (trial?.interval === "day" && Number.isInteger(trial.frequency) &&
        trial.frequency >= 1 && trial.frequency <= 999 && trial.frequency > trialDays) {
      trialDays = trial.frequency;
    }
  }
  if (Number.isFinite(trialEnds)) return { at: new Date(trialEnds).toISOString(), stated: false };

  const bought = purchasedAt(data, event);
  return bought
    ? { at: new Date(Date.parse(bought) + Math.max(PADDLE_TRIAL_DAYS, trialDays) * DAY_MS).toISOString(), stated: false }
    : null;
}

/* A move the rule may have asked for did not happen. Writes the log
   line somebody can search for ("Could not defer first charge") and
   throws, so the handler can answer 500 and Paddle sends the event
   again. `why` and `short` carry no account id and no subscription id:
   the short form goes back to Paddle in the answer. */
function deferFailed(why: string, short: string): never {
  console.error(`Could not defer first charge: ${why} Answering 500 so Paddle sends this event again.`);
  throw new Error(`first charge not deferred: ${short}`);
}

/* Throws (deferFailed) when the date cannot be read. No account id in
   the log. */
async function accountCreatedAt(userId: string): Promise<string> {
  /* public.subscriptions is created by the grant_trial trigger the
     moment the account exists, and its created_at is never rewritten,
     so that column dates the account without needing the auth schema exposed. */
  /* A lookup that cannot be reached, or answers with something that is
     not JSON, is the same failed move as one that answers an error, so
     it gets the same searchable log line rather than a bare exception. */
  let response: Response;
  try {
    response = await rest(`/subscriptions?user_id=eq.${userId}&select=created_at`);
  } catch (_error) {
    deferFailed("the account lookup could not be reached.", "the account lookup could not be reached");
  }
  if (!response.ok) {
    deferFailed(
      `reading the account's creation date answered ${response.status}.`,
      `the account lookup answered ${response.status}`,
    );
  }
  // deno-lint-ignore no-explicit-any
  let rows: any;
  try {
    rows = await response.json();
  } catch (_error) {
    deferFailed("the account lookup's answer could not be read.", "the account lookup's answer could not be read");
  }
  const createdAt = rows?.[0]?.created_at ?? null;
  if (!createdAt) {
    deferFailed("the account has no creation date on record.", "no creation date on record");
  }
  return createdAt;
}

/* One log line, when the first payment Paddle states is more than 36
   hours after the rule's own date (the later of LAUNCH_FIRST_CHARGE and
   the account's 30 or 21 days). create-checkout rounds up to whole
   days, so its dates sit under 24 hours past the rule; 36 hours leaves
   room for a checkout that stayed open a while. Past that it is worth a
   look: a checkout left open for a day or more, a free trial extended
   by hand (the first payment never falls inside it), or a transaction
   that create-checkout made on one day and that was paid on a later
   one, which carries its free days from the day it was paid (see
   ownTrialAtPurchase). The hours say which: a day or two is an open
   checkout, and many days with no trial extended by hand is a
   transaction paid late. It only says so. It never changes a date, the
   customer is never worse off for a later one, and it cannot throw. No
   account id and no subscription id. */
function noteIfLaterThanRule(createdAt: string, plan: string | null, shownAt: string) {
  const days = plan === "monthly" ? FREE_DAYS_MONTHLY : FREE_DAYS_YEARLY;
  const rule = Math.max(LAUNCH_FIRST_CHARGE, Date.parse(createdAt) + days * DAY_MS);
  const later = Date.parse(shownAt) - rule;
  if (Number.isFinite(later) && later > 36 * 3600000) {
    console.warn(`First payment later than the rule: by ${Math.round(later / 3600000)} hours.`);
  }
}

/* Whether the account's own free trial was running at the moment this
   subscription was bought, read from the account's row BEFORE this
   event is written over it. It feeds one log line (noteFirstCharge)
   and nothing else.

   Why. A free period before the first payment is for someone who
   subscribes while their own free trial is running. create-checkout
   makes that test when it MAKES the transaction, but Paddle counts the
   free days from when the transaction is PAID, and nothing ties the two
   moments together. A transaction made during the trial and paid after
   it has ended (if Paddle still opens one that old, which is not
   known), or one of the retired catalogue trial prices opened by hand,
   starts a free period the terms do not give. This function cannot
   undo that: it never moves a date earlier than checkout showed. It
   can say that it happened, so it is found by reading the log and not
   by guessing.

   true:  the row was plan 'trial' and entitled at the purchase instant,
          the same test create-checkout and has_active_plan() make.
   false: the row was read, and it was plainly something else.
   null:  it cannot be told, and nothing is logged. No purchase time,
          the lookup failed, no row, an answer with no plan column in
          it, an end date that does not parse, or a row that already
          carries THIS
          subscription, which is a retried delivery reading what the
          first attempt wrote.

   Never throws and never writes. A fault in here must not be what
   turns a good delivery into a 500. */
async function ownTrialAtPurchase(
  userId: string, subscriptionId: string, boughtAt: string | null,
): Promise<boolean | null> {
  try {
    const bought = boughtAt ? Date.parse(boughtAt) : NaN;
    if (!Number.isFinite(bought)) return null;
    const response = await rest(
      `/subscriptions?user_id=eq.${userId}&select=plan,status,current_period_end,complimentary,paddle_subscription_id`,
    );
    if (!response.ok) return null;
    const rows = await response.json();
    const before = Array.isArray(rows) ? rows[0] : null;
    // A plan of null is a real answer (no plan). No plan column at all is not a row this can read.
    if (!before || typeof before !== "object" || before.plan === undefined) return null;
    if (before.paddle_subscription_id === subscriptionId) return null;
    const ends = before.current_period_end === null || before.current_period_end === undefined
      ? null
      : Date.parse(String(before.current_period_end));
    if (ends !== null && !Number.isFinite(ends)) return null;
    const entitled = before.complimentary === true ||
      (["active", "trialing", "past_due"].includes(before.status) && (ends === null || ends > bought));
    return before.plan === "trial" && entitled;
  } catch (_error) {
    return null;
  }
}

/* Answers with the instant the first charge now sits on when Paddle
   accepted a move, and null when there was nothing to move (not a
   trial-price subscription, a date already past, or Paddle's own stated
   date already the right one).

   THROWS in every case where the rule may have asked for a later date
   and the move did not happen: no date to work from, the account's
   creation date unreadable, the key missing, Paddle refusing or out of
   reach. Each writes a log line starting "Could not defer first
   charge". The handler holds the error until every other write is done
   and throws it before the event is recorded, so the delivery is
   answered 500 and Paddle retries. It must never be swallowed: left
   alone, the customer is charged on the date Paddle holds, which may
   be earlier than the pages say.

   A purchase that came through create-checkout leaves here at the
   "stated and equal" line below, before the key is asked for: its date
   is already the latest of the three.
   `shown` is Paddle's own first-payment date (paddleFirstPaymentAt). */
async function deferFirstCharge(
  userId: string, subscriptionId: string, shown: ShownDate | null,
  status: string, plan: string | null,
): Promise<string | null> {
  /* Only a subscription that arrived with a free period. Anyone else has
     paid today and their anniversary is Paddle's business, not ours.
     See the note above: the payload says so, and it is never inferred
     from a date. No key is needed for them, so none is asked for. */
  if (status !== "trialing") return null;

  /* No date from Paddle and no purchase time to work one out from: a
     move now would have nothing to be held at or after, so it could be
     a move earlier than checkout showed. Nothing is sent. */
  if (!shown) {
    deferFailed(
      "the payload gives neither Paddle's own first-payment date nor a purchase time.",
      "no first-payment date and no purchase time in the payload",
    );
  }

  const createdAt = await accountCreatedAt(userId);

  /* The date depends only on the account, the plan and Paddle's own
     date, never on when this delivery arrived, so a retried delivery
     gets the same answer as the first attempt. The real clock is only
     asked whether that date is still ahead. */
  const now = Date.now();
  const target = firstChargeAt(createdAt, plan, shown.at);
  if (!target) {
    deferFailed("the account's creation date does not parse.", "the creation date does not parse");
  }
  /* Already past: nothing to defer to. */
  if (target.getTime() <= now) return null;

  /* Said, never acted on: Paddle's stated date is well past the rule's.
     See noteIfLaterThanRule(). */
  if (shown.stated) noteIfLaterThanRule(createdAt, plan, shown.at);

  /* Paddle's own date is one of the three instants the target is the
     latest of, so the target is never earlier than it. When Paddle
     STATED its date and the target is that date, there is nothing to
     move, and nothing is sent. Exactly equal, not "within a minute": a
     date a few seconds short of LAUNCH_FIRST_CHARGE is still moved.
     This is where every purchase made through create-checkout leaves.

     A stand-in is different. It is a floor worked out here, not what
     Paddle holds, and Paddle's real date may be earlier (a price with a
     shorter trial than the stand-in assumed). Skipping the move because
     the target equals the stand-in would leave that earlier date in
     place, which can be earlier than the pages promise. So with a
     stand-in the date is always sent. At worst that sets the date to
     where it already is. */
  if (shown.stated && Date.parse(shown.at) === target.getTime()) return null;

  if (!PADDLE_API_KEY) {
    deferFailed("PADDLE_API_KEY not set.", "PADDLE_API_KEY not set");
  }

  let response: Response;
  try {
    response = await fetch(`${PADDLE_API_BASE}/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        next_billed_at: target.toISOString(),
        proration_billing_mode: "do_not_bill",
      }),
    });
  } catch (_error) {
    deferFailed("Paddle could not be reached.", "Paddle could not be reached");
  }

  if (!response.ok) {
    /* The one line that names the subscription, so it can be found in
       Paddle. The error that travels back in the answer does not. */
    console.error(`Could not defer first charge for ${subscriptionId}: ${response.status} ${await response.text()} Answering 500 so Paddle sends this event again.`);
    throw new Error(`first charge not deferred: Paddle answered ${response.status}`);
  }
  return target.toISOString();
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
  // race to log the same id is not a failure.
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

/* ─────────────────────────── Foundation ───────────────────────────
   Foundation is a price lock with 100 places, for the first 100 people
   to subscribe from 22 Nov 2026 to the end of 31 Dec 2026 (noon UTC on 1 Jan 2027).
   The database decides who gets one (supabase/schema-foundation.sql):
   the table cannot hold a 101st place, and an account is decided once,
   so a replay or a retry gets the same answer and never a second place.

   This file holds no Foundation date and no count. It passes on the
   instant Paddle says the subscription was made, and the database
   judges the closing date against that, never against the time the
   webhook happened to arrive. */

/* The instant the subscription was made, from Paddle's signed payload.
   Only called for subscription.created, where occurred_at is a fair
   last resort. Null when nothing usable was sent. */
// deno-lint-ignore no-explicit-any
function purchasedAt(data: any, event: Record<string, unknown>): string | null {
  for (const value of [data?.created_at, data?.started_at, event.occurred_at]) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

/* Throws on any failure, including the 404 PostgREST gives when the SQL
   has not been run. A claim that silently did not happen is a
   subscriber who silently lost a place. */
async function claimFoundationPlace(
  userId: string, subscriptionId: string, subscribedAt: string, plan: string | null,
) {
  const response = await rest("/rpc/claim_foundation_place", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: userId,
      p_subscription_id: subscriptionId,
      p_subscribed_at: subscribedAt,
      p_plan: plan,
    }),
  });
  if (!response.ok) {
    throw new Error(`claim_foundation_place failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
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
   Granting once and leaving the grant to expire on its own -- rather than
   requiring an explicit revoke on cancellation -- is what stops
   access surviving a cancellation forever. Nothing calls this for a
   status this function decides is NOT currently entitled, which is
   what makes the omission double as the revocation: no fresh grant
   call means the previous expiry (already in the database) is left to
   lapse on its own -- the same mechanism a complimentary grant relies
   on, except that one is written with no expiry at all.

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

/* Once Paddle has accepted the new first-charge date, the free period
   runs to that date, so the row and the identity grants are written to
   match, here and now. Paddle says the same in the subscription.updated
   its own date change produces, but this function cannot lean on when
   that arrives. If this delivery fails after the move (a Foundation
   claim that could not be made, say) Paddle sends it again, and the
   upsert at the top of the handler takes whatever the event says: the
   retry would put the payload's original period end back over the newer
   one, and the account would lose Premium at the trial price's own end,
   before the date it was promised. Writing the moved date after every
   accepted move makes the end state the same whichever order the events
   are handled in.

   Only the row for this subscription. Throws on failure, like every
   other entitlement write, so Paddle retries. */
async function extendFreePeriod(
  userId: string, subscriptionId: string, status: string, periodEnd: string,
) {
  const response = await rest(
    `/subscriptions?user_id=eq.${userId}&paddle_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ current_period_end: periodEnd, updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) {
    throw new Error(`period end update failed: ${response.status} ${await response.text()}`);
  }
  await mirrorToIdentitySchema(userId, status, periodEnd);
}

/* What happened to the first payment of a new subscription that has
   not paid yet, in lines somebody can search the function log for.
   None carries an account id or a subscription id, none changes
   anything, and a fault in here is swallowed: a log line must never be
   what turns a good delivery into a 500.

   "first charge: checkout's date stands" is the normal line. Checkout
   showed a date, it is the right one, and nothing was sent to Paddle.

   "first charge moved after checkout" means the net was needed: Paddle
   held a date short of the rule and it was moved later. The customer
   was shown one date and is billed on a later one. Nobody is charged
   early, but it should not happen to a purchase made through
   create-checkout, so it is a warning.

   "trial subscription on a catalogue price" says why that happens. A
   transaction made by create-checkout carries a price made for it
   alone, which Paddle marks as type "custom" in the signed payload. A
   free period on anything else is a checkout that did not come through
   create-checkout: an older cached page on one of the two retired
   catalogue trial prices, or one of them opened by hand. Once those two
   prices are archived in Paddle this line should never appear.

   "free period on an account whose own free trial was not running" is
   the one to act on. The subscription arrived with a free period, and
   when it was bought the account was not in its own free trial: the
   trial had ended, or the account already had a subscription. The
   terms give such a person no free period (they pay on the day). It is
   a transaction made earlier and paid later, or a catalogue trial
   price opened by hand; once in a while it is someone whose trial
   ended in the minutes their checkout was open. Nothing is changed
   here, because a date is never moved earlier than checkout showed.
   What to do about that subscription is the owner's call (DEPLOY.md
   5.6). `ownTrial` comes from ownTrialAtPurchase(). */
// deno-lint-ignore no-explicit-any
function noteFirstCharge(data: any, status: string, shown: ShownDate | null, movedTo: string | null, failed: boolean, ownTrial: boolean | null) {
  try {
    if (status !== "trialing") return;
    // deno-lint-ignore no-explicit-any
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    if (!items.some((item) => item?.price?.type === "custom")) {
      console.warn("trial subscription on a catalogue price");
    }
    if (ownTrial === false) {
      console.warn("free period on an account whose own free trial was not running");
    }
    if (movedTo) {
      const rule = new Date(Date.parse(movedTo)).toISOString();
      const from = shown ? new Date(Date.parse(shown.at)).toISOString() : "nothing";
      console.warn(
        shown && shown.stated
          ? `first charge moved after checkout: checkout showed ${from}, rule gives ${rule}`
          : `first charge moved after checkout: the payload did not state checkout's date (it is no later than ${from}), rule gives ${rule}`,
      );
    } else if (!failed && shown && shown.stated) {
      console.log("first charge: checkout's date stands");
    }
  } catch (_error) {
    // Only a log line was lost.
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

  // user_id travels as custom_data: written on the transaction by
  // create-checkout for someone subscribing during their free trial, and
  // passed by billing.js when it opens the plain price for anyone else.
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

    /* Read now, before the row below is written over: was the account in
       its own free trial when this was bought? Only for a new
       subscription that arrived with a free period, only for a log
       line, and it cannot fail the delivery (ownTrialAtPurchase). */
    const ownTrial = eventType === "subscription.created" && Boolean(data?.id) && status === "trialing"
      ? await ownTrialAtPurchase(userId, String(data.id), purchasedAt(data, event))
      : null;

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

    /* Foundation, on creation only. Tried here, straight after the
       authoritative write, so a slow or failing step further down cannot
       push someone back in the queue for the last places. A failure is
       held, not thrown yet: entitlement and the billing date below must
       never wait on Foundation. It is thrown before the event is
       recorded, so Paddle retries and the claim is made then. Not on
       subscription.updated or .canceled: renewals and this function's
       own date change produce those, and a cancellation writes nothing
       to Foundation. */
    const isCreation = eventType === "subscription.created" && Boolean(data?.id);
    const subscribedAt = isCreation ? purchasedAt(data, event) : null;
    let foundation: unknown = null;
    let foundationError: unknown = null;
    if (isCreation) {
      try {
        if (!subscribedAt) throw new Error("subscription.created carries no usable created_at");
        foundation = await claimFoundationPlace(userId, String(data.id), subscribedAt, row.plan);
        // A place number or a reason. Never an account id.
        console.log(`foundation: ${JSON.stringify(foundation)}`);
      } catch (error) {
        foundationError = error;
      }
    }

    // public.subscriptions (above) is the authoritative write; this
    // mirrors the same outcome into the identity schema for the screen
    // saver and any future suite app. Also throws on failure now -- see
    // its own comment for why that's safe (and necessary) here.
    await mirrorToIdentitySchema(userId, status, row.current_period_end);

    /* Only on creation, and only after the writes above have stuck:
       the billing date must not be what decides whether someone is
       entitled. A move that was needed and did not happen is held, like
       a failed Foundation claim, and thrown below before the event is
       recorded, so this delivery is answered 500 and Paddle sends it
       again. The retry replays the whole event, which is safe: every
       write above is idempotent, and the date is worked out from the
       account, the plan and the payload, so it is the same date and
       never earlier than Paddle's own. */
    let deferError: unknown = null;
    if (isCreation) {
      // Paddle's own first-payment date, read once and used three times below.
      const shown = paddleFirstPaymentAt(data, event);
      let movedTo: string | null = null;
      try {
        movedTo = await deferFirstCharge(
          userId, String(data.id), shown, status, row.plan,
        );
      } catch (error) {
        deferError = error;
      }
      noteFirstCharge(data, status, shown, movedTo, deferError !== null, ownTrial);
      /* Paddle accepted the move, so the free period ends on that date.
         Written before a held Foundation error is thrown, so a retry of
         this event always ends with the moved date, not the payload's
         original one. See extendFreePeriod(). */
      if (movedTo) await extendFreePeriod(userId, String(data.id), status, movedTo);

      /* Nothing was moved because checkout's date already stands, which
         is every purchase made through create-checkout. Premium must
         still run to the first payment. The row above took its period
         end from the payload's billing period, and that being the same
         instant as next_billed_at on a trialing subscription is
         expected, not seen. (Before create-checkout nearly every
         purchase was moved, and the line above wrote the date.) So when
         the two differ, or the period is missing, the row and the
         grants are written to the stated date here. When they are the
         same instant nothing is written. Only for a date Paddle stated
         outright and that is still ahead. A failure throws, like every
         entitlement write, so the delivery is answered 500 and Paddle
         retries. */
      const standsAt = !movedTo && !deferError && status === "trialing" && shown !== null && shown.stated
        ? Date.parse(shown.at)
        : NaN;
      if (standsAt > Date.now() && Date.parse(String(row.current_period_end ?? "")) !== standsAt) {
        await extendFreePeriod(userId, String(data.id), status, shown!.at);
      }
    }

    // Held until entitlement and the billing date were written. See above.
    if (foundationError) throw foundationError;
    // Held until the row, the grants and the Foundation claim were written.
    if (deferError) throw deferError;

    // Recorded only now that every write above has actually succeeded.
    // See the file header and recordEvent()'s own comment: this used to
    // run first, which quietly defeated Paddle's retry on any failure
    // between here and there.
    await recordEvent(eventId, eventType, userId, event);

    return Response.json({ ok: true, status, plan: row.plan, foundation }, { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    // A 500 makes Paddle retry. Nothing on this path was recorded, so
    // the retry actually redoes whatever failed instead of the
    // duplicate check silently absorbing the failure.
    return Response.json({ ok: false, error: String(error) }, { status: 500, headers: corsHeaders });
  }
});
