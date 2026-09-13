#!/usr/bin/env node
/* ============================================================
   Who is locked out of their own account, and does not know?

   Sign-in is an emailed code, so the email IS the login. Resend
   suppresses an address permanently after one hard bounce or one
   spam complaint, and every later send to that address is dropped
   before delivery is attempted. Nothing surfaces anywhere:

     - the customer sees "check your email" every time, forever
     - the app cannot tell, because Resend accepts the API call and
       drops the message afterwards, so Supabase sees a success
     - no bounce reaches anyone, because the send never happened

   A full mailbox for one afternoon, or a corporate server that
   hard-rejects an unknown sender, is enough. The address is then
   suppressed long after the original cause has gone, and the person
   can never sign in again.

   This is the only way to see that list. Run in launch week, and
   on any report of "the code never arrives".

   Deliberately a local script, not part of diagnostics.html: that
   page is public, and this output is customer email addresses. The
   privacy policy promises those are never published, and a health
   check that leaks the very thing being checked is worse than none.

   Needs a Resend key with permission to read suppressions. The
   sending key in Supabase SMTP is restricted to sending on
   aibhlinn.ai and will return an error here -- that restriction is
   correct and worth keeping, so make a second, read-only key rather
   than widening the one that sends.

   Run:
     RESEND_API_KEY=re_xxx node tools/check-suppressions.js
     RESEND_API_KEY=re_xxx node tools/check-suppressions.js someone@example.com

   Exit code is 1 when anything is suppressed, so a launch checklist
   or a scheduled job can gate on the result rather than on someone
   remembering to read the output.
   ============================================================ */
'use strict';

const KEY = process.env.RESEND_API_KEY;
const ONE = (process.argv[2] || '').trim().toLowerCase();

if (!KEY) {
  console.error('RESEND_API_KEY is not set.\n');
  console.error('  RESEND_API_KEY=re_xxx node tools/check-suppressions.js');
  process.exit(2);
}

/* Resend pages at 100. Anything beyond a few pages means something
   systemic rather than a handful of unlucky mailboxes, so the loop is
   bounded: stop at 1000 and say so, rather than paging forever against
   a rate limit. */
async function fetchAll() {
  const rows = [];
  let after = null;

  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.resend.com/suppressions');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = await response.json();
    const batch = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...batch);

    if (!payload.has_more || batch.length === 0) return { rows, truncated: false };
    after = batch[batch.length - 1].id;
  }

  return { rows, truncated: true };
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor(ms / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, Math.floor(ms / 60000))}m ago`;
}

/* bounce and complaint are the dangerous ones: nobody chose them and
   nobody was told. A manual suppression was a decision someone made,
   so the two are counted separately and only the first kind sets the
   exit code. */
function summarise(rows) {
  const counts = { bounce: 0, complaint: 0, manual: 0 };
  for (const row of rows) {
    if (counts[row.origin] === undefined) counts[row.origin] = 0;
    counts[row.origin]++;
  }
  return counts;
}

(async () => {
  let rows, truncated;
  try {
    ({ rows, truncated } = await fetchAll());
  } catch (error) {
    console.error(String(error.message || error));
    console.error('\nA 400, 401 or 422 means the key cannot read suppressions.');
    console.error('The SMTP sending key is scoped to sending only; create a separate read key.');
    process.exitCode = 2;
    return;
  }

  if (ONE) {
    const hit = rows.find((r) => String(r.email).toLowerCase() === ONE);
    if (!hit) {
      console.log(`${ONE} is NOT suppressed. If codes still do not arrive, the cause is elsewhere:`);
      console.log('  Resend → Emails for the delivery status, then Cloudflare Email Routing rules.');
      return;
    }
    console.log(`${ONE} IS suppressed.`);
    console.log(`  reason     ${hit.origin}`);
    console.log(`  since      ${hit.created_at}  (${ago(hit.created_at)})`);
    console.log(`  id         ${hit.id}`);
    console.log('\nThis person cannot sign in, and sees "check your email" every time.');
    console.log('Remove at Resend → Settings → Suppressions, then ask them to try again.');
    console.log('Read the original bounce first: an unfixed cause suppresses the address again.');
    process.exitCode = 1;
    return;
  }

  const counts = summarise(rows);
  const lockedOut = (counts.bounce || 0) + (counts.complaint || 0);

  if (rows.length === 0) {
    console.log('Nothing suppressed. Nobody is locked out by email.');
    return;
  }

  const width = Math.min(44, Math.max(16, ...rows.map((r) => String(r.email).length)));
  console.log('email'.padEnd(width), 'reason'.padEnd(11), 'since');
  console.log('-'.repeat(width), '-'.repeat(11), '-'.repeat(18));
  for (const row of rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    console.log(
      String(row.email).padEnd(width),
      String(row.origin).padEnd(11),
      `${String(row.created_at).slice(0, 10)}  ${ago(row.created_at)}`,
    );
  }

  console.log();
  console.log(`${rows.length} suppressed — bounce ${counts.bounce || 0}, complaint ${counts.complaint || 0}, manual ${counts.manual || 0}`);
  if (truncated) console.log('More than 1000 exist; the list above is the first 1000.');

  if (lockedOut > 0) {
    console.log();
    console.log(`${lockedOut} of these cannot sign in and have not been told.`);
    console.log('Each one is a person seeing "check your email" with nothing arriving.');
    console.log('Resend → Settings → Suppressions to remove, after reading why each bounced.');
  }

  /* exitCode rather than exit(): the fetch socket may still be closing,
     and a hard exit here trips a libuv assertion on Windows. Setting the
     code lets the process end on its own with the same result. */
  process.exitCode = lockedOut > 0 ? 1 : 0;
})();
