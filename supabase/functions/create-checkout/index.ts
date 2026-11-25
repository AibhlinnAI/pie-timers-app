/* ============================================================
   create-checkout — makes the Paddle transaction for someone who
   subscribes while their own free trial is running, with the right
   number of free days already on it, so Paddle's checkout shows the
   right first-payment day itself.

   Why this exists (the owner, 22 Nov 2026: "just make sure we get the
   date right"). A trial length lives on a Paddle catalogue price and is
   the same for everyone who buys it, so a checkout opened on a
   catalogue price showed the purchase plus that one trial, and
   paddle-webhook then MOVED the date to the rule's one afterwards. The
   pages had to warn that checkout "may show an earlier first-payment
   date". This function removes the move. It works out, for THIS
   account, how many whole days of free time put the first payment at
   or after the rule's date, and makes a transaction whose price is a
   copy of the plain catalogue price with that many days as its trial.
   billing.js opens Paddle with the transaction's id. Paddle counts the
   days from the purchase, so the date it shows and the date it bills
   on are the same date, and nothing is moved afterwards.

   Used ONLY while the account's own free trial is running (plan
   'trial', and entitled). Someone whose trial has ended pays on the
   day, on the plain catalogue price, opened by billing.js with no call
   here. This function never makes a pay-today transaction and never
   makes one for a lapsed, cancelled, complimentary or subscribed
   account.

   What it trusts. The caller's own access token is checked first and
   the account id is taken from that token, never from the request
   body, as manage-subscription and delete-account do. The body is read
   for two things only: which plan (monthly or annual) and a discount
   code if one was typed. The free period is decided here, from the
   account's own row and this server's clock. So nothing a browser
   sends can make the free period longer, get a transaction made once
   the account's trial has ended, get one made for an account that is
   already subscribed, or get one made for someone else's account.
   (Two tabs racing can still both pay, as they could before.)

   What it cannot do: tie the transaction to the moment it is paid.
   The free days are fixed on the transaction when it is MADE, and
   Paddle counts them from when it is PAID. The transaction's id goes
   back to the signed-in account's own browser, and whoever holds an
   id can open it again later. Found for real on 25 Nov 2026: Paddle
   still opened a transaction a day after it was made, after the
   account's own trial had ended, and still offered the full free
   period counted from the day of payment. That is a free period the
   terms do not give, at the amount copied when it was made. The
   owner decided the same day that unpaid prepared purchases are
   cancelled about an hour after they are made, and the
   expire-checkouts function does that: every ten minutes it cancels
   each unpaid transaction this function made that is 60 minutes old
   or more. It knows them by made_by on custom_data, below. Do not
   rename that text without changing MADE_BY in expire-checkouts (a
   test pins them equal), or nothing is cancelled any more. It also
   knows them by the end of the one-off price's description,
   "(create-checkout)", which is PRICE_MARK there and pinned the same
   way. That second mark is there because, in theory read from
   Paddle's documentation and never tried, the page holding a checkout
   can replace a transaction's custom data. What
   remains is the hour: a transaction made in the last hour of a
   trial can still be paid just after the trial has ended, and one
   paid 50 minutes after it was made counts its free days from then.
   It also remains for any stretch when expire-checkouts or its job
   is not running. So the claim
   here is only about what this function MAKES, not about when a
   transaction it made is paid. paddle-webhook cannot undo it, because
   it never moves a date earlier than checkout showed, but it says so
   in its log: "free period on an account whose own free trial was not
   running", and "First payment later than the rule". For proportion:
   the same person can do the same today by opening one of the two
   retired catalogue trial prices by hand, and expire-checkouts
   never touches a checkout opened that way. This would be the route
   left once those two are archived.

   No limit on how often. Nothing is stored about a request and there
   is no rate limit, so an account in its free trial can call this as
   often as it likes. That charges nobody wrongly. But each call makes
   two requests to Paddle (three with a discount code), leaves a draft
   transaction and a one-off price in the Paddle account, and is one
   more id of the kind above. A draft left behind is now cancelled
   after about an hour by expire-checkouts; the one-off price stays.
   Paddle's documentation allows 240
   requests a minute from one address and then answers 429 for 60
   seconds (read 23 Nov 2026). If Supabase's functions reach Paddle
   from a shared address, which is not known, one account calling in a
   loop would stop checkout opening for everyone in their trial for as
   long as it ran, and the log would fill with "answered 429". A cap
   for each account needs a table to count in, which is a new stored
   record about an account and so the owner's decision. It is not
   built.

   What it checks before handing the transaction out. Paddle's answer
   must carry the trial that was asked for, the same billing cycle, the
   same amount and the same account. A transaction that came back
   without its trial would be a charge today, so one that does not
   match is never opened: the customer sees "try again" instead.

   Whole days. A Paddle trial is a whole number of days counted from
   the moment of purchase, and the rule's date is an exact instant, so
   the day count is rounded UP. The first payment is then never before
   the rule's date and less than 24 hours after it: it falls at the
   time of day the customer subscribed, on the first such moment at or
   after day 21 (monthly) or day 30 (yearly) from the account being
   made, and never before LAUNCH_FIRST_CHARGE. Rounding down would put
   it before the date the pages promise, which must never happen.

   paddle-webhook keeps the same rule as a net. A date that lands short
   of it (an old cached page on a catalogue trial price, say) is still
   moved later there. The three rule constants below are repeated from
   paddle-webhook, and tools/foundation-test.mjs pins them equal: if one
   moves, move both.

   Deployed WITHOUT --no-verify-jwt, like manage-subscription: it is
   called with the user's own session token. It also checks that token
   itself, so it stays safe whichever way the flag is set.

   Needs PADDLE_API_KEY, the same server key paddle-webhook and
   manage-subscription use. Here it reads a price, reads discounts and
   writes a transaction. PADDLE_ENVIRONMENT is the same switch
   paddle-webhook reads. No new secret.

   Nothing here is true of the live service until this function has
   been deployed. Read against Paddle's documentation and run against
   stubs (tools/foundation-test.mjs, part C); DEPLOY.md 8.4 Test A is
   the first real purchase through it.
   ============================================================ */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PADDLE_API_KEY = Deno.env.get("PADDLE_API_KEY") ?? "";

// Paddle's API is environment-specific: a sandbox key against
// api.paddle.com (or the reverse) fails every call.
const PADDLE_API_BASE = (Deno.env.get("PADDLE_ENVIRONMENT") ?? "production") === "sandbox"
  ? "https://sandbox-api.paddle.com"
  : "https://api.paddle.com";

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

/* The first-payment rule, repeated from paddle-webhook (see its long
   note for where each number comes from). LAUNCH_FIRST_CHARGE is the
   moment the last time zone on Earth reaches midnight on New Year's
   Eve, not Adelaide midnight. */
const LAUNCH_FIRST_CHARGE = Date.parse("2027-01-01T12:00:00Z");
const FREE_DAYS_YEARLY = 30;
const FREE_DAYS_MONTHLY = 21;
const DAY_MS = 86400000;

/* A stop, not part of the rule. The longest free period the rule gives
   a standard account is 41 days. A count past a year means a date on
   the row is wrong, and a wrong date must not become a year of free
   time. */
const MAX_TRIAL_DAYS = 366;

/* The two plain catalogue prices, the ones paid on the day
   (annualPriceId and monthlyPriceId in app/config.js; the test pins
   them equal). They are public ids. Only the id is written here: the
   amount, the currency, the tax setting and the per-country prices are
   read from Paddle each time, so a price changed in Paddle is the price
   charged, with nothing to keep in step by hand. */
const PLAIN_PRICE: Record<string, string> = {
  monthly: "pri_01m1efkevnwpn0rj7g2kzjne0j",
  annual: "pri_01m1effmxgfb45pmtyfz1dnh77",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* Every refusal goes through here: one log line somebody can search
   for ("Could not make checkout"), and an answer that carries a short
   code and nothing else. `why` never holds an account id, an email or
   a transaction id, and the answer never holds anything Paddle said. */
function refuse(status: number, code: string, why: string) {
  const line = `Could not make checkout: ${why}`;
  if (status >= 500) console.error(line);
  else console.warn(line);
  return json({ ok: false, error: code }, status);
}

/* Resolve the bearer token to a user, or null when it is not accepted.
   Throws when the check itself cannot be reached. */
async function userFromToken(token: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === "string" && user.id ? user : null;
}

/* How many whole days of free time, and the instant they must reach.

   The target is the LATEST of: the account's creation plus 30 days
   (yearly) or 21 days (monthly); LAUNCH_FIRST_CHARGE; and the end of
   the account's own free trial when the row states one. The third
   never decides for a standard account (a 14-day trial ends before day
   21, and a trial given to an account made before 22 Nov 2026 ends on
   6 Dec 2026, before LAUNCH_FIRST_CHARGE). It is there for a trial
   extended by hand, so the first payment cannot fall inside the free
   trial the customer already has: terms.html says subscribing during
   the trial never shortens it.

   Rounded UP, with no margin. Paddle counts the days from the moment
   checkout completes, which is at or after `now`, so the first payment
   is at or after the target and under 24 hours past it (plus however
   long the overlay sat open). Never 0: a target already behind us
   still gets one day, because this path is for someone who owes
   nothing today. */
function freePeriod(created: number, trialEnd: number | null, cadence: string, now: number) {
  const freeDays = cadence === "monthly" ? FREE_DAYS_MONTHLY : FREE_DAYS_YEARLY;
  let target = Math.max(created + freeDays * DAY_MS, LAUNCH_FIRST_CHARGE);
  if (trialEnd !== null) target = Math.max(target, trialEnd);
  const days = Math.max(1, Math.ceil((target - now) / DAY_MS));
  return { target, days };
}

/* One call to Paddle. Null when Paddle cannot be reached; otherwise the
   status, the body as JSON when it is JSON, and the body as text. */
// deno-lint-ignore no-explicit-any
async function paddle(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; text: string } | null> {
  let response: Response;
  try {
    response = await fetch(`${PADDLE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_error) {
    return null;
  }
  const text = await response.text().catch(() => "");
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    // Left null: every caller treats an answer it cannot read as a refusal.
  }
  return { status: response.status, data, text };
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

Deno.serve((request) => answered(request, handle));

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return refuse(405, "method", "the request was not a POST.");
  }

  try {
    /* Who is asking. Their id comes from this answer and from nowhere
       else. */
    const header = request.headers.get("Authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return refuse(401, "not_signed_in", "no access token was sent.");

    // deno-lint-ignore no-explicit-any
    let user: any;
    try {
      user = await userFromToken(token);
    } catch (_error) {
      return refuse(503, "account_unreadable", "the sign-in check could not be reached.");
    }
    if (!user) return refuse(401, "not_signed_in", "the access token was not accepted.");
    const userId: string = user.id;

    /* What they asked for. The plan and a discount code, nothing else:
       an account id, a price, a date or a day count in the body is
       never read. */
    // deno-lint-ignore no-explicit-any
    let asked: any;
    try {
      asked = await request.json();
    } catch (_error) {
      return refuse(400, "bad_request", "the request body could not be read.");
    }
    const cadence = asked?.cadence;
    if (cadence !== "monthly" && cadence !== "annual") {
      return refuse(400, "bad_request", "the request did not name a plan.");
    }
    let discountCode = "";
    if (asked.discountCode !== undefined) {
      if (typeof asked.discountCode !== "string") {
        return refuse(400, "bad_request", "the discount code was not text.");
      }
      discountCode = asked.discountCode.trim();
      /* The shape of a code, checked before it goes anywhere near a
         URL. One that cannot be a code is answered as not found, with
         no call to Paddle. */
      if (discountCode && !/^[A-Za-z0-9_-]{1,64}$/.test(discountCode)) {
        return refuse(422, "discount_not_found", "the discount code typed is not the shape of a code.");
      }
    }

    /* The account's own row, read with the service key. public.
       subscriptions is written by the grant_trial trigger the moment
       the account exists and its created_at is never rewritten, so it
       dates the account. */
    // deno-lint-ignore no-explicit-any
    let row: any = null;
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
          "&select=created_at,plan,status,current_period_end,cancel_at_period_end,complimentary",
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (response.status !== 200) {
        return refuse(503, "account_unreadable", `reading the account's row answered ${response.status}.`);
      }
      const rows = await response.json();
      row = Array.isArray(rows) ? rows[0] ?? null : null;
    } catch (_error) {
      return refuse(503, "account_unreadable", "the account's row could not be reached or read.");
    }
    if (!row || typeof row !== "object") {
      return refuse(503, "account_unreadable", "the account has no row.");
    }

    const now = Date.now();
    const trialEnd = row.current_period_end === null || row.current_period_end === undefined
      ? null
      : Date.parse(String(row.current_period_end));
    if (trialEnd !== null && !Number.isFinite(trialEnd)) {
      return refuse(503, "account_unreadable", "the end date on the account's row does not parse.");
    }

    /* The same test as has_active_plan() in schema-billing.sql, which is
       where the browser's `entitled` comes from, so the page and this
       function cannot disagree except in the second a trial ends. */
    const entitled = row.complimentary === true ||
      (["active", "trialing", "past_due"].includes(row.status) && (trialEnd === null || trialEnd > now));

    /* A subscription that is running and will bill. A second purchase
       would make a second subscription that bills as well. One already
       set to end is not refused here, but it is not in a free trial
       either, so the next test turns it away: billing.js sends it to
       the plain price. */
    const paidPlan = row.plan === "monthly" || row.plan === "annual";
    if (paidPlan && row.complimentary !== true && entitled && row.cancel_at_period_end !== true) {
      return refuse(409, "already_subscribed", "the account already has a subscription that is running.");
    }

    /* The account's own free trial, still running. Plan 'trial' is the
       test and never status 'trialing' alone: Paddle reports 'trialing'
       too for someone who has ALREADY subscribed and is waiting for
       their first payment. Anything else gets no free period from
       here. */
    if (!(row.plan === "trial" && entitled)) {
      return refuse(409, "not_in_trial", "the account's own free trial is not running.");
    }

    const created = Date.parse(String(row.created_at ?? ""));
    if (!Number.isFinite(created)) {
      return refuse(503, "account_unreadable", "the account's creation date does not parse.");
    }
    const { target, days } = freePeriod(created, trialEnd, cadence, now);
    if (days > MAX_TRIAL_DAYS) {
      return refuse(503, "account_unreadable", "the free period is out of range.");
    }
    const firstPaymentFrom = new Date(target).toISOString();

    if (!PADDLE_API_KEY) {
      return refuse(503, "not_configured", "PADDLE_API_KEY not set.");
    }

    /* The plain catalogue price, read fresh. Everything about what the
       customer pays is copied from it. If it is not exactly the price
       this function expects (active, the right billing cycle, no trial
       of its own), nothing is made: a half-configured catalogue stops
       here rather than charging something nobody set. */
    const priceId = PLAIN_PRICE[cadence];
    const interval = cadence === "monthly" ? "month" : "year";
    const priceAnswer = await paddle("GET", `/prices/${priceId}`);
    if (!priceAnswer) return refuse(502, "paddle", "the catalogue price could not be reached.");
    if (priceAnswer.status !== 200) {
      return refuse(502, "paddle", `reading the catalogue price answered ${priceAnswer.status}.`);
    }
    const plain = priceAnswer.data?.data;
    const plainOk = plain && plain.id === priceId && plain.status === "active" &&
      plain.billing_cycle?.interval === interval && plain.billing_cycle?.frequency === 1 &&
      (plain.trial_period === null || plain.trial_period === undefined) &&
      typeof plain.product_id === "string" && plain.product_id.startsWith("pro_") &&
      typeof plain.unit_price?.amount === "string" && /^\d+$/.test(plain.unit_price.amount) &&
      isText(plain.unit_price?.currency_code);
    if (!plainOk) {
      return refuse(502, "paddle", "the catalogue price is not as expected: not active, the wrong billing cycle, a trial of its own, or no product or amount.");
    }

    /* A typed discount code is turned into Paddle's own id for it here,
       and Paddle's answer must then carry that id (below). The function
       never carries on without a code the customer typed: they would
       pay a price they were not expecting.

       Paddle's list calls a discount "active" for as long as it is not
       archived (read on its list-discounts page, 23 Nov 2026). Whether
       it can still be used is three more fields, and each is read here:
       expires_at (its end date), usage_limit against times_used, and
       restrict_to (the product or price ids it is kept to). A code that
       has ended, is used up, or is kept to something other than this
       product is answered as not found, with no transaction made. When
       a checkout was opened on a catalogue price, Paddle's own overlay
       said so; here nothing would, and the customer would see either
       "try again" for ever or the full price with no word about the
       code.

       restrict_to holding a PRICE id never matches here, even the plain
       price's own id: the price on this transaction is a copy, a
       different price in Paddle. A discount meant for this path is kept
       to the product, or to nothing (DEPLOY.md 8.1). */
    let discountId = "";
    if (discountCode) {
      const found = await paddle("GET", `/discounts?code=${encodeURIComponent(discountCode)}&status=active`);
      if (!found) return refuse(502, "paddle", "the discount lookup could not be reached.");
      if (found.status !== 200 || !Array.isArray(found.data?.data)) {
        return refuse(502, "paddle", `the discount lookup answered ${found.status}, or with a list that could not be read.`);
      }
      // deno-lint-ignore no-explicit-any
      const matches = found.data.data.filter((d: any) =>
        typeof d?.code === "string" && d.code.toLowerCase() === discountCode.toLowerCase() &&
        d.status === "active" && d.enabled_for_checkout === true
      );
      if (matches.length === 0) {
        return refuse(422, "discount_not_found", "no active discount open to checkout has the code that was typed.");
      }
      if (matches.length > 1 || typeof matches[0].id !== "string" || !matches[0].id.startsWith("dsc_")) {
        return refuse(502, "paddle", "the discount lookup gave more than one match, or one with no id.");
      }
      const discount = matches[0];
      if (discount.expires_at !== null && discount.expires_at !== undefined) {
        const ends = Date.parse(String(discount.expires_at));
        if (!Number.isFinite(ends)) {
          return refuse(502, "paddle", "the discount lookup gave an end date that does not parse.");
        }
        if (ends <= now) {
          return refuse(422, "discount_not_found", "the discount with the code that was typed has ended.");
        }
      }
      if (Number.isInteger(discount.usage_limit) && Number.isInteger(discount.times_used) &&
          discount.times_used >= discount.usage_limit) {
        return refuse(422, "discount_not_found", "the discount with the code that was typed has been used as many times as it allows.");
      }
      if (Array.isArray(discount.restrict_to) && discount.restrict_to.length > 0 &&
          !discount.restrict_to.includes(plain.product_id)) {
        return refuse(422, "discount_not_found", "the discount with the code that was typed is kept to other products or prices, not this product.");
      }
      discountId = discount.id;
    }

    /* The transaction. Its one item is a price made for this
       transaction alone: the plain catalogue price, plus the free days.
       No customer, no address and no currency are set, so it is a draft
       that checkout completes, as a checkout opened on a catalogue price
       is (read in Paddle's documentation, first seen for real in
       DEPLOY.md 8.4 Test A). custom_data is what paddle-webhook reads to
       know whose account to credit, and here the server writes it. */
    /* The end of the description, "(create-checkout)", is one of the
       two marks expire-checkouts knows this transaction by. Do not
       change it here alone. */
    const price: Record<string, unknown> = {
      product_id: plain.product_id,
      description: `Premium ${cadence === "monthly" ? "monthly" : "yearly"}, first payment after ${days} days (create-checkout)`,
      billing_cycle: { interval, frequency: 1 },
      trial_period: { interval: "day", frequency: days },
      unit_price: { amount: plain.unit_price.amount, currency_code: plain.unit_price.currency_code },
      unit_price_overrides: Array.isArray(plain.unit_price_overrides) ? plain.unit_price_overrides : [],
      quantity: { minimum: 1, maximum: 1 },
    };
    if (isText(plain.name)) price.name = plain.name;
    if (isText(plain.tax_mode)) price.tax_mode = plain.tax_mode;

    const order: Record<string, unknown> = {
      items: [{ quantity: 1, price }],
      collection_mode: "automatic",
      custom_data: {
        user_id: userId,
        trial_days: days,
        first_payment_from: firstPaymentFrom,
        made_by: "create-checkout",
      },
    };
    if (discountId) order.discount_id = discountId;

    const made = await paddle("POST", "/transactions", order);
    if (!made) return refuse(502, "paddle", "Paddle could not be reached to make the transaction.");
    if (made.status < 200 || made.status > 299) {
      /* Paddle's own words, cut short, so a refusal can be understood
         from the log. The account id is taken out first in case Paddle
         quotes the request back, and so is the email address the token
         belongs to, though this function never sends it. */
      let said = made.text.split(userId).join("[account]");
      if (isText(user.email)) said = said.split(user.email).join("[email]");
      said = said.slice(0, 300);
      return refuse(502, "paddle", `Paddle refused the transaction with ${made.status}: ${said}`);
    }

    /* Paddle's answer is checked before anything is handed out. A
       transaction that lost its trial would charge today; one with a
       different amount, cycle or account is not the one asked for. None
       of them is ever opened. */
    const txn = made.data?.data;
    const item = Array.isArray(txn?.items) && txn.items.length === 1 ? txn.items[0] : null;
    const got = item?.price;
    const matches = typeof txn?.id === "string" && /^txn_[a-z0-9]+$/.test(txn.id) &&
      txn.custom_data?.user_id === userId &&
      item !== null && item.quantity === 1 &&
      got?.trial_period?.interval === "day" && got.trial_period.frequency === days &&
      got.trial_period.requires_payment_method !== false &&
      got.billing_cycle?.interval === interval && got.billing_cycle?.frequency === 1 &&
      got.product_id === plain.product_id &&
      got.unit_price?.amount === plain.unit_price.amount &&
      got.unit_price?.currency_code === plain.unit_price.currency_code &&
      (txn.collection_mode === undefined || txn.collection_mode === null || txn.collection_mode === "automatic") &&
      (!discountId || txn.discount_id === discountId);
    if (!matches) {
      return refuse(502, "paddle", "Paddle's answer did not match what was asked for.");
    }

    // The plan, the days and the date. No account and no transaction id.
    console.log(`checkout made: ${cadence === "monthly" ? "monthly" : "yearly"}, ${days} days, first payment from ${firstPaymentFrom}`);
    return json({ ok: true, transactionId: txn.id, trialDays: days, firstPaymentFrom });
  } catch (error) {
    /* Something nobody planned for. The error's own text is not logged:
       it can carry a URL with the account id in it. */
    const kind = error instanceof Error ? error.name : "unknown";
    return refuse(500, "error", `an unexpected fault (${kind}).`);
  }
}
