/* ============================================================
   expire-checkouts: cancels the prepared purchases that
   create-checkout made and nobody paid for within about an hour.

   Why this exists. create-checkout fixes the free days on a Paddle
   transaction when the transaction is MADE, and Paddle counts them
   from when it is PAID. Found for real on 25 Nov 2026: a transaction
   left unpaid could still be opened a day later, after the account's
   own free trial had ended, and still offered the full free period
   counted from the day of payment. The terms give that person no free
   period. The owner decided the same day: unpaid prepared purchases
   are cancelled about an hour after they are made. He was offered
   cancelling a subscription after payment instead and declined. That
   is not built here or anywhere, and must not be added.

   What a run does. pg_cron calls this every ten minutes (the job
   countdown-expire-checkouts, which the file
   supabase/schema-expire-checkouts.sql makes, with no secret typed
   by anyone). A run asks Paddle for unpaid transactions, oldest
   first, reads each one that passes the test below a second time
   straight before acting, and then tells Paddle to cancel that one
   transaction. Nothing else is ever sent to Paddle: two kinds of GET
   and one PATCH whose body is the status and nothing more.

   The test, line by line. A transaction is cancelled only when every
   line holds, on the list AND on the second read:
   - its id is the shape of a transaction id, so nothing else can ever
     reach a Paddle address;
   - its status is "draft" or "ready". Never billed, paid, completed,
     past_due or anything this file has not heard of. Paddle itself
     would allow a cancel of billed and past_due, so this line is the
     only thing keeping those safe;
   - its origin is exactly "api". A subscription's own transactions
     (renewals, charges, updates) and a checkout that Paddle.js opened
     on a catalogue price have other origins;
   - it belongs to no subscription;
   - it is collected automatically. An invoice made in the dashboard
     is collected manually;
   - it has no invoice number and no billed date;
   - it carries create-checkout's mark, in one of two places. Either
     its custom_data says made_by "create-checkout", with an account
     id that is text and a whole number of trial days. Or its one item
     is a price whose description ends "(create-checkout)" and whose
     trial is a whole number of days: the one-off price only
     create-checkout writes. MADE_BY and PRICE_MARK below must stay
     the same text as in create-checkout (tools/foundation-test.mjs
     pins both). Why two places: see "The mark" below;
   - Paddle's own created_at for it is at least 60 minutes behind the
     clock, rounded so a cancel is never early. The clock is this
     server's, or Paddle's when Paddle's is behind (see "The clock"
     below). A created_at that is missing, unreadable or ahead of the
     clock means the transaction is left alone;
   - on the second read, Paddle lists its payment attempts and every
     one of them has plainly failed. Any attempt that might still be
     in progress means somebody may be paying, so the transaction is
     left alone.
   The filters on the list request only save work. The test above is
   the rule, and holds if Paddle ignores every filter.

   The mark. THEORY, never tried: read in Paddle's documentation on
   25 Nov 2026, Paddle.js lets the page that holds a checkout replace
   the custom data kept on that checkout's transaction
   (Paddle.Checkout.updateCheckout). The documentation does not say
   whether that works on a transaction made through the API. If it
   does, the person the hour is aimed at could take made_by off their
   own prepared purchase from the browser's console. So the test does
   not rest on custom_data alone. The one-off price is what carries
   the free days, and a browser that swaps the price loses them, so
   the price's own description is the second mark. Not known: whether
   Paddle's list hands back each item's price with its description
   (create-checkout reads the price back from Paddle's answer when it
   makes a transaction, so the single read very likely does). If the
   list does not, a transaction with made_by taken off is still left
   open, and shows as "not ours". DEPLOY.md 8.4 Test D has a tick
   that tries the replace on a spare.

   The clock. The 60 minutes are measured from Paddle's created_at to
   a clock here. Each list answer carries Paddle's own time in its
   Date header. When this server's clock is ahead of that by up to a
   minute, the age is worked out on Paddle's time, so a cancel is
   late by a second or two and never early. When the two differ by
   more than a minute, either way, the run stops as a fault ("stopped
   clock") and cancels nothing more. An answer with no Date header is
   judged on this server's clock alone.

   "About an hour" means between 60 and about 70 minutes, because the
   job runs every ten minutes. Longer if a run fails: the next run is
   the retry. Nothing sleeps or retries inside a run.

   What it cannot do.
   - Close the gap inside the hour. Someone whose trial ends inside
     that hour can still pay and start the free period.
   - Touch a checkout opened on one of the two retired catalogue trial
     prices. That is not an API-made transaction. That route to a free
     period after a trial has ended is separate, and stays open until
     those two prices are archived (DEPLOY.md 8.1 says when).
   - Cancel a transaction that carries a payment attempt that never
     settles. That one is left alone for good, and shows as "being
     paid" on every run.
   - Keep the hour against a flood. A run sends at most 20 cancels,
     120 an hour, oldest first. create-checkout has no limit on how
     often one account may call it, so one account can make more than
     120 an hour by itself, on purpose, and every unpaid one then
     waits longer than the hour, other people's included. The log
     line says "more waiting yes" run after run when that happens. A
     limit for each account on create-checkout is the real answer and
     is the owner's decision. It is not built.
   - See past 120 on the list. A run reads at most 120, oldest first.
     If 120 or more old ones that it cannot cancel sit in front (ones
     being paid, or ones with neither mark), the ones behind are never
     reached. Nothing is stored between runs, so a run cannot skip
     them. Such a run is logged as a fault.
   - Anything at all while this function is not deployed, the job is
     not scheduled, CRON_SECRET or PADDLE_API_KEY is not set, or Paddle
     is refusing. A fault here charges nobody and cancels nothing: it
     leaves unpaid prepared purchases open, which is how things stood
     before 25 Nov 2026.
   - Tell a customer. Someone who leaves Paddle's checkout open for
     over an hour without paying has that checkout cancelled. What
     Paddle's overlay shows then has not been seen.

   What counts as a fault. A fault writes a line starting "Could not
   close checkouts" and answers 502. A fault is any of: Paddle could
   not be reached, failed or turned the run away; Paddle refused a
   read or a cancel (the line gives the last refusal's status and
   short code); a transaction that is still unpaid did not pass the
   second read; the clocks differ; or more are waiting and the run
   cancelled none. So a run that leaves old ones of ours open, for a
   reason other than somebody paying, is never logged as a healthy
   run. One that was paid between the list and the second read counts
   as "changed" and is not a fault.

   Limits in one run. At most 4 lists, 40 second reads and 20 cancels
   sent, whatever Paddle answers: 64 requests, against the 240 a
   minute Paddle allows one address, which create-checkout may share.
   Three failures in a row (a read or a cancel that cannot be reached,
   answers 5xx, or answers 200 without a cancelled copy) stop the run.
   A good read does not wipe out a failed cancel: only a transaction
   dealt with from start to finish without a failure does.

   The log. One line a run: counts, a stop word, and for a fault a
   status number and Paddle's short error code. No transaction id, no
   account id, no email and no customer id, even for a transaction
   that was cancelled. A transaction id is the handle that opens a
   checkout, and in Paddle it leads to the account. The owner does not
   need it from here: Paddle's own Transactions list shows the
   cancelled ones by status and time. The answer follows the same rule,
   because pg_net keeps answers for about six hours. Nothing Paddle
   says in words is ever logged or returned.

   Facts and what has not been tried. Read in Paddle's documentation
   on 25 Nov 2026: the list's filters and paging, that draft, ready,
   billed and past_due transactions can be cancelled, that a cancel
   sends the status alone, that transactions Paddle made for a
   subscription cannot be cancelled this way, and the limit of 240
   requests a minute from one address. Run against stubs only
   (tools/foundation-test.mjs, part E). Nothing here has met Paddle
   until DEPLOY.md 8.4 Test D. Not known until then: whether a
   transaction keeps origin "api" and its mark once a checkout has
   been opened on it (Test D opens one spare for this reason),
   whether an unpaid one lists its payments as an empty list, and
   what Paddle answers to the cancel. If the origin changes, the list
   never returns that transaction and the line reads "listed 0". If
   the payments are not listed, the line is a fault that says so. A
   "not ours" count means the list returned an API-made unpaid
   transaction with neither mark on it.

   Deployed WITH --no-verify-jwt: pg_cron sends the publishable key,
   which is not a session token. Closed by CRON_SECRET instead, the
   same secret notify-milestones and calendar-sync use, and closed
   when that secret is not set.

   Needs PADDLE_API_KEY, the key create-checkout uses. Here it reads
   transactions and writes transactions. PADDLE_ENVIRONMENT is the same
   switch create-checkout reads. No new secret. It reads nothing from
   Supabase, stores nothing, and never reads the request's body.
   ============================================================ */

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const PADDLE_API_KEY = Deno.env.get("PADDLE_API_KEY") ?? "";

// Paddle's API is environment-specific: a sandbox key against
// api.paddle.com (or the reverse) fails every call.
const PADDLE_API_BASE = (Deno.env.get("PADDLE_ENVIRONMENT") ?? "production") === "sandbox"
  ? "https://sandbox-api.paddle.com"
  : "https://api.paddle.com";

/* The text create-checkout writes as custom_data.made_by. Rename one
   and the other must follow, or nothing is ever cancelled. */
const MADE_BY = "create-checkout";

/* How the description create-checkout writes on its one-off price
   ends. The same rule: change one and the other must follow. */
const PRICE_MARK = " (create-checkout)";

const MAX_AGE_MS = 60 * 60 * 1000;

/* Paddle gives at most 30 transactions a page. Four pages, forty
   second reads and twenty cancels SENT keep a run to 64 requests at
   most, whatever Paddle answers, under the 240 a minute that
   create-checkout may share. Both counts are of requests made, not of
   requests that went well. */
const PER_PAGE = 30;
const MAX_PAGES = 4;
const MAX_READS = 40;
const MAX_CANCELS = 20;

/* The job's own request waits 25 seconds (the command is a copy of the
   countdown-milestones one, and the SQL that makes the job refuses a
   copy that waits any other time). A run starts no new transaction
   after 18 seconds, and one transaction is at most a read and a
   cancel of 3 seconds each, so a run ends inside 24. */
const RUN_BUDGET_MS = 18000;
const REQUEST_LIMIT_MS = 3000;
const MAX_FAILS_IN_ROW = 3;

/* How far this server's clock and Paddle's may differ before a run
   stops as a fault. */
const MAX_CLOCK_GAP_MS = 60 * 1000;

/* The one body this function ever sends. A constant, never built. */
const CANCEL_BODY = '{"status":"canceled"}';

const TXN_ID = /^txn_[a-z0-9]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* One call to Paddle. Null when Paddle cannot be reached or takes too
   long; otherwise the status, the body as JSON when it is JSON, and
   the time in the answer's Date header (NaN when there is none).
   The body's text is never kept. */
// deno-lint-ignore no-explicit-any
async function paddle(method: "GET" | "PATCH", path: string, bodyText?: string): Promise<{ status: number; data: any; date: number } | null> {
  let response: Response;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${PADDLE_API_KEY}` };
    if (bodyText !== undefined) headers["Content-Type"] = "application/json";
    response = await fetch(`${PADDLE_API_BASE}${path}`, {
      method,
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
    });
  } catch (_error) {
    return null;
  }
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(await response.text());
  } catch (_error) {
    // Left null: every caller treats an answer it cannot read as no answer.
  }
  const stamp = response.headers.get("date");
  return { status: response.status, data, date: stamp ? Date.parse(stamp) : NaN };
}

/* Paddle's short error code, such as "transaction_not_found", when the
   answer has one of that shape. Never Paddle's message: that can quote
   an id or an email back. */
// deno-lint-ignore no-explicit-any
function errorCode(data: any): string {
  const code = data?.error?.code;
  return typeof code === "string" && /^[a-z_]{1,60}$/.test(code) ? ` (${code})` : "";
}

/* Paddle's created_at as milliseconds, rounded UP to the whole second.
   Paddle writes microseconds ("2024-04-12T10:33:52.610609Z"). Rounding
   up means a cancel is never early and at most one second late. NaN
   for anything that is not that exact shape. */
function createdMs(text: unknown): number {
  if (typeof text !== "string") return NaN;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(text);
  if (!parts) return NaN;
  const whole = Date.parse(parts[1] + "Z");
  if (!Number.isFinite(whole)) return NaN;
  return parts[2] !== undefined && !/^0+$/.test(parts[2]) ? whole + 1000 : whole;
}

const absent = (value: unknown) => value === null || value === undefined;

/* A payment attempt that has plainly finished without paying. */
const FAILED_PAYMENT = ["error", "canceled", "dropped"];

/* create-checkout's mark on the transaction's own custom_data. The
   page that holds a checkout may be able to replace this (the long
   note at the top, "The mark"), so it is not the only mark. */
// deno-lint-ignore no-explicit-any
function markedByData(custom: any): boolean {
  return Boolean(custom) && typeof custom === "object" && custom.made_by === MADE_BY &&
    typeof custom.user_id === "string" && custom.user_id !== "" && Number.isInteger(custom.trial_days);
}

/* create-checkout's mark on the one-off price: exactly one item, whose
   price has the description create-checkout writes and a trial of a
   whole number of days. The price is what carries the free days. */
// deno-lint-ignore no-explicit-any
function markedByPrice(items: any): boolean {
  if (!Array.isArray(items) || items.length !== 1) return false;
  const price = items[0]?.price;
  if (!price || typeof price !== "object") return false;
  return typeof price.description === "string" && price.description.endsWith(PRICE_MARK) &&
    price.trial_period?.interval === "day" &&
    Number.isInteger(price.trial_period.frequency) && price.trial_period.frequency >= 1;
}

/* The test (the long note at the top says why each line is there).
   "close" only when every line holds. `needPayments` is true for the
   second read, where a missing list of payment attempts means no. */
// deno-lint-ignore no-explicit-any
function ours(txn: any, now: number, needPayments: boolean): "close" | "young" | "not_ours" | "paying" {
  if (!txn || typeof txn !== "object" || typeof txn.id !== "string" || !TXN_ID.test(txn.id)) return "not_ours";
  if (!(txn.status === "draft" || txn.status === "ready")) return "not_ours";
  if (txn.origin !== "api") return "not_ours";
  if (!absent(txn.subscription_id)) return "not_ours";
  if (txn.collection_mode !== "automatic") return "not_ours";
  if (!absent(txn.invoice_number) || !absent(txn.billed_at)) return "not_ours";
  if (!markedByData(txn.custom_data) && !markedByPrice(txn.items)) return "not_ours";
  const created = createdMs(txn.created_at);
  if (!Number.isFinite(created) || created > now) return "not_ours";
  if (now - created < MAX_AGE_MS) return "young";
  if (absent(txn.payments)) {
    if (needPayments) return "not_ours";
  } else {
    if (!Array.isArray(txn.payments)) return "not_ours";
    // deno-lint-ignore no-explicit-any
    if (!txn.payments.every((p: any) => p && typeof p === "object" && FAILED_PAYMENT.includes(p.status))) return "paying";
  }
  return "close";
}

Deno.serve(async (request) => {
  // pg_cron passes the shared secret; without one this endpoint is
  // closed, and closed too when the secret itself is not set.
  if (!CRON_SECRET || request.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") {
    console.warn("Could not close checkouts: the request was not a POST.");
    return json({ ok: false, error: "method" }, 405);
  }
  if (!PADDLE_API_KEY) {
    console.error("Could not close checkouts: PADDLE_API_KEY not set.");
    return json({ ok: false, error: "not_configured" }, 503);
  }

  try {
    const started = Date.now();
    let listed = 0, old = 0, closed = 0, young = 0, notOurs = 0, paying = 0, changed = 0, refused = 0, failed = 0;
    /* Requests made this run, whatever came back, and the second reads
       of a transaction that is still unpaid and did not pass. */
    let reads = 0, sent = 0, unpaidChanged = 0;
    let lastRefusal = "";
    let more = false;
    let stopped: string | null = null;
    let why = "";
    let failsInRow = 0;
    let after = "";
    /* How far this server's clock is ahead of Paddle's, never under 0. */
    let ahead = 0;

    /* The list's cutoff, in whole seconds as Paddle's own examples
       write a time. Only a saving: each transaction is judged again on
       its own created_at. */
    const cutoff = new Date(Math.floor((started - MAX_AGE_MS) / 1000) * 1000).toISOString().replace(".000Z", "Z");

    run:
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > RUN_BUDGET_MS) {
        stopped = "time";
        more = true;
        break;
      }

      /* Written out as text, so the square brackets and the comma go
         as Paddle's own examples show them. The next page is asked for
         by building this again with the last id seen. The address
         Paddle hands back for the next page is never fetched. */
      const list = await paddle(
        "GET",
        `/transactions?status=draft,ready&origin=api&collection_mode=automatic&created_at[LTE]=${cutoff}&order_by=id[ASC]&per_page=${PER_PAGE}` +
          (after ? `&after=${after}` : ""),
      );
      if (!list) {
        stopped = "list_failed";
        why = "the list could not be reached";
        break;
      }
      if (list.status === 429) {
        stopped = "rate_limited";
        why = "the list answered 429: too many requests, so the run stopped";
        break;
      }
      if (list.status === 401 || list.status === 403) {
        stopped = "paddle_auth";
        why = `the list answered ${list.status}: the key may not read transactions`;
        break;
      }
      const pagination = list.data?.meta?.pagination;
      if (list.status !== 200 || !Array.isArray(list.data?.data) || !pagination || typeof pagination !== "object") {
        stopped = "list_failed";
        why = `the list answered ${list.status}${errorCode(list.data)}, or could not be read`;
        break;
      }

      /* Paddle's own clock, from the answer just read. */
      if (Number.isFinite(list.date)) {
        const gap = Date.now() - list.date;
        if (Math.abs(gap) > MAX_CLOCK_GAP_MS) {
          stopped = "clock";
          why = "this server's clock and Paddle's differ by more than a minute, so the run stopped";
          break;
        }
        ahead = Math.max(0, gap);
      }

      // deno-lint-ignore no-explicit-any
      const items: any[] = list.data.data;
      listed += items.length;

      for (const item of items) {
        if (Date.now() - started > RUN_BUDGET_MS) {
          stopped = "time";
          more = true;
          break run;
        }

        const first = ours(item, Date.now() - ahead, false);
        if (first === "young") { young++; continue; }
        if (first === "not_ours") { notOurs++; continue; }
        if (first === "paying") { paying++; continue; }

        /* Both limits count requests made, so a run of refusals or
           failures cannot go past them. */
        if (sent >= MAX_CANCELS) {
          stopped = "cap";
          more = true;
          break run;
        }
        if (reads >= MAX_READS) {
          stopped = "reads";
          more = true;
          break run;
        }
        old++;
        const id: string = item.id;

        /* The second read, straight before the cancel. Somebody may
           have paid since the list was made. */
        reads++;
        const read = await paddle("GET", `/transactions/${id}`);
        if (!read || read.status >= 500) {
          failed++;
          failsInRow++;
          if (failsInRow >= MAX_FAILS_IN_ROW) {
            stopped = "paddle_failing";
            why = `Paddle failed ${MAX_FAILS_IN_ROW} times in a row, so the run stopped`;
            break run;
          }
          continue;
        }
        if (read.status === 429) {
          stopped = "rate_limited";
          why = "a read answered 429: too many requests, so the run stopped";
          break run;
        }
        if (read.status === 401 || read.status === 403) {
          stopped = "paddle_auth";
          why = `a read answered ${read.status}: the key may not read transactions`;
          break run;
        }
        if (read.status !== 200) {
          refused++;
          lastRefusal = `a read answered ${read.status}${errorCode(read.data)}`;
          failsInRow = 0;
          continue;
        }
        const fresh = read.data?.data;
        const same = Boolean(fresh) && fresh.id === id;
        const second = same ? ours(fresh, Date.now() - ahead, true) : "not_ours";
        if (second !== "close") {
          /* Paddle answered and there is nothing to cancel: this
             transaction is dealt with, so the run of failures ends. */
          failsInRow = 0;
          if (second === "paying") {
            paying++;
          } else {
            changed++;
            /* Paid, billed or cancelled since the list is as it should
               be. Still unpaid and not passing is not. */
            if (!same || fresh.status === "draft" || fresh.status === "ready") unpaidChanged++;
          }
          continue;
        }

        sent++;
        const cancel = await paddle("PATCH", `/transactions/${id}`, CANCEL_BODY);
        if (cancel && cancel.status === 429) {
          stopped = "rate_limited";
          why = "a cancel answered 429: too many requests, so the run stopped";
          break run;
        }
        if (cancel && (cancel.status === 401 || cancel.status === 403)) {
          stopped = "paddle_auth";
          why = `a cancel answered ${cancel.status}: the key may not write transactions`;
          break run;
        }
        /* Paddle said yes only when the answer is a cancelled copy of
           this same transaction. */
        if (cancel && cancel.status === 200 && cancel.data?.data?.id === id && cancel.data.data.status === "canceled") {
          closed++;
          failsInRow = 0;
          continue;
        }
        if (!cancel || cancel.status >= 500 || cancel.status === 200) {
          /* Not reached, a 5xx, or a 200 that is not a cancelled copy.
             The good read before this does not wipe the count. */
          failed++;
          failsInRow++;
          if (failsInRow >= MAX_FAILS_IN_ROW) {
            stopped = "paddle_failing";
            why = `Paddle failed ${MAX_FAILS_IN_ROW} times in a row, so the run stopped`;
            break run;
          }
          continue;
        }
        // Paddle said no: paid in the last instant, for example.
        refused++;
        lastRefusal = `a cancel answered ${cancel.status}${errorCode(cancel.data)}`;
        failsInRow = 0;
      }

      if (pagination.has_more !== true) break;
      const last = items.length > 0 ? items[items.length - 1]?.id : undefined;
      if (typeof last !== "string" || !TXN_ID.test(last) || last === after) {
        stopped = "list_failed";
        why = "the list could not be paged";
        break;
      }
      after = last;
      if (page === MAX_PAGES) {
        stopped = "pages";
        more = true;
      }
    }

    const counts = { closed, listed, old, young, notOurs, paying, changed, refused, failed, more, stopped };
    const tail = `closed ${closed}, listed ${listed}, old enough and ours ${old}, too young ${young}, ` +
      `not ours ${notOurs}, being paid ${paying}, changed ${changed}, refused ${refused}, failed ${failed}, ` +
      `more waiting ${more ? "yes" : "no"}, stopped ${stopped ?? "no"}`;

    /* What makes a run a fault (the long note at the top, "What counts
       as a fault"). A run that left old ones open for a reason other
       than somebody paying is never written as a healthy line. */
    const paddleFault = failed > 0 ||
      (stopped !== null && ["list_failed", "rate_limited", "paddle_auth", "paddle_failing", "clock"].includes(stopped));
    const noneClosed = more && closed === 0;
    if (paddleFault || refused > 0 || unpaidChanged > 0 || noneClosed) {
      const reasons: string[] = [];
      if (why) reasons.push(why);
      else if (failed > 0) reasons.push("some reads or cancels failed");
      if (refused > 0) reasons.push(`Paddle refused ${refused}, and last ${lastRefusal}`);
      if (unpaidChanged > 0) reasons.push(`${unpaidChanged} still unpaid did not pass the second read`);
      if (noneClosed && !paddleFault) reasons.push("more are waiting and this run cancelled none");
      console.error(`Could not close checkouts: ${reasons.join("; ")}. ${tail}`);
      return json({ ok: false, error: paddleFault ? "paddle" : "left_open", ...counts }, 502);
    }
    // Counts only. No account and no transaction id.
    console.log(`checkouts closed: ${tail}`);
    return json({ ok: true, ...counts });
  } catch (error) {
    /* Something nobody planned for. The error's own text is not logged:
       it can carry an address with a transaction id in it. */
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`Could not close checkouts: an unexpected fault (${kind}).`);
    return json({ ok: false, error: "error" }, 500);
  }
});
