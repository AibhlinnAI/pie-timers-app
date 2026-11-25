# Pie Timers — notes for Claude

## Message board

`MESSAGE-BOARD.md` is how sessions talk to each other. Sessions do not share
memory, so it is the only way a fact learned in one session reaches the next.

- **Read it before starting work** on anything AibhlínnAI, including scheduled
  task runs and Code sessions.
- **Add an entry when you finish a task**, or when you learn something that
  would have changed how you started. Newest at the top.
- Correct wrong entries in place rather than leaving them to mislead.
- **It is deliberately gitignored and must stay that way.** It was tracked for
  a few hours on 20 Sep 2026 and untracked the same day. This repo is public,
  and the board is where sessions write the awkward things — on 20 Sep an
  audit session recorded an employer, a classification level and a family
  detail in it, correctly, in order to warn about them. Never `git add` it,
  never suggest tracking it "so it survives", and if you find it untracked,
  that is not an oversight to fix.
- **If you are in a clone and there is no board, that is expected.** It exists
  only in Mal's Drive folder at `H:\My Drive\Professional\AibhlínnAI\repo\Pie
  Timers` — **the repo moved under `repo\` on 24 September 2026**, so any
  older path you have seen is stale. Do not create a fresh one in a clone — a
  second board that nobody else reads is worse than none, because it looks
  authoritative. Ask Mal for the contents, or work without it and tell him
  what you could not check.
- **The repo is one folder inside a private Drive folder, and the boundary
  matters.** `AibhlínnAI\repo\` holds code repos; `AibhlínnAI\events\` holds
  per-event working material — invoices, organisers' photos, draft emails —
  none of which belongs in a public repo. Two near-misses on 24 Sep 2026 put
  an organiser's programme and a conference invoice inside the working tree;
  neither was committed. `!! PUBLIC REPO STARTS HERE !!.md` at the repo root
  and `!! FOLDER MAP !!.md` one level up exist to make that boundary visible.

## The inbox agent's run log

The Mailman reads AibhlínnAI email every morning and writes what it found to
`fleet/runs/the-mailman.md`, in the AibhlínnAI folder above this repo. It
never writes to the board, so the board alone does not tell you what has
arrived.

- **Read its newest entry before saying anything about email**: what has
  arrived, what hasn't, or what a sender asked for.
- It covers mail up to its own run time only. For anything later, read Gmail
  yourself.
- On 17 Nov 2026 a session reported as news an email The Mailman had sorted
  two hours earlier, and told Mal a declaration was outstanding that he had
  completed a week before.

## Things worth knowing before you act

- **The Black Friday Launch Offer runs from 22 Nov 2026 to the end of
  31 Dec 2026.** It first ran in October 2026 ("Launch
  Month": 18 Oct, 1 Nov, 1 Dec), before the app was public. Mal reset it on
  22 Nov 2026, the day Pie Timers went public on Google Play, and revised
  its terms the same day. `app/foundation.html` is the product-facing
  source of truth. The hook is **"Pay nothing until 2027"**. It is only
  true with its condition, so it always sits right beside "Subscribe while
  your free trial is running and your first payment is taken from
  1 January 2027." The hook has **no subscribe-by date**. It had one for a
  few hours ("subscribe by 5 December") and Mal took it off: do not bring
  it back. The one place the hook stands alone is the Get Premium button
  at the top of the app (`app/identity-bridge.js`, Mal, 25 Nov 2026). The
  button carries the hook only for an account whose own trial is running,
  before `OFFER_CLOSES` in that file, and links to the Premium site
  (`CT.premiumSiteUrl`; `pricing.html` only when that is emptied), where
  the condition is written. `OFFER_CLOSES` is a copy of
  `FOUNDATION_CLOSES` and moves with the other launch dates;
  `tools/foundation-test.mjs` (P6) fails if the two differ.
- **Two dates end two different things. Do not mix them up.**
  - **The end of 31 Dec 2026** (the instant `2027-01-01T12:00Z`) ends
    the offer. Foundation closes then, or sooner if all 100 places go. The
    hook comes off the pages then, and the aibhlinn.ai advert comes down.
    Both happen without anyone doing anything (see "Nothing in this repo
    has to be taken down by hand" below).
    **The offer's dates carry no time zone (Mal, 22 Nov 2026: "thought we
    went away from Adelaide time").** Each instant is noon UTC on the day
    after, which is midnight in the last time zone on Earth (UTC-12), so
    "the end of 31 December 2026" is true on every customer's own
    calendar. It is the same instant as the first payment, 10:30 pm on
    1 Jan in Adelaide. Never write "(Adelaide time)" beside an offer date,
    and never move an instant back to Adelaide midnight: the words and the
    instants go together.
  - **The end of 5 Dec 2026** (the instant `2026-12-06T12:00Z`) ends
    one thing only: the free trial of an account made **before 22 Nov 2026**
    (before `2026-11-22T12:00Z`, counted the same way). Those accounts were given Premium free to that fixed
    finish line, even if an earlier trial had ended (`trial_length()`,
    and `supabase/relaunch-2026-11.sql` for the accounts that already
    existed, which is only true once Mal has run it: check before saying
    so). It is not the offer's close, not Foundation's close and not a
    subscribe-by date. From 22 Nov every new account gets the standard
    14 days from signup, for ever.
- **The first-payment rule is permanent and has no cut-off date.**
  Subscribe while the free trial is running and the first payment is taken
  at the LATEST of three instants: the day the account was made plus
  **30 days on a yearly plan or 21 days on a monthly plan** (30 if the plan
  cannot be read); `LAUNCH_FIRST_CHARGE`; and Paddle's own
  `next_billed_at`, the date its checkout showed the customer, so a date
  is never moved earlier than the customer was shown. If the payload
  does not state that date, a stand-in is used, the first the payload can
  give: the end of its billing period; the latest trial end date on an
  item; then the purchase time plus the trial length on the item's price
  in days, or plus 14 days (`PADDLE_TRIAL_DAYS`) when that is longer or
  no length is stated, because too long only ever means later. A stand-in
  is always sent to Paddle, and with none of them nothing is moved. After
  1 January 2027 it is simply 30 days yearly, 21 monthly.
- **Checkout is given the right first-payment day, so nothing is moved
  afterwards (Mal, 22 Nov 2026: "just make sure we get the date
  right").** What Paddle's overlay then shows the customer (a date, a
  count of free days, or neither) has not been seen: never say "checkout
  shows the date" as fact until `DEPLOY.md` 8.4 Test A has been run, and
  if it shows neither, that is Mal's decision before the merge. While an account's own free
  trial is running, `billing.js` asks the `create-checkout` edge function
  for a Paddle transaction. The function works out on the server, from
  the account's own row, how many WHOLE days of free time put the first
  payment at or after the rule's date, makes the transaction on a copy of
  the plain catalogue price with that many days as its trial, checks
  Paddle's answer, and returns the transaction's id; `billing.js` opens
  checkout with it. Nothing is moved afterwards, and `paddle-webhook`
  keeps the rule as a net. The paragraph that began "Checkout may show an
  earlier first-payment date" is off all three pages: do not bring it
  back. Nothing the browser sends decides the free period. Only true once
  `create-checkout` is deployed and the branch is merged; read from
  Paddle's documentation and run against stubs (part C of
  `tools/foundation-test.mjs`), and `DEPLOY.md` 8.4 Test A is the first
  real purchase through it.
- **The free days are fixed when the transaction is MADE and counted from
  when it is PAID, and nothing ties the two together.** Found for real
  on 25 Nov 2026: a transaction left unpaid could still be opened a day
  later, after the account's own trial had ended, and still offered the
  full free period counted from the day of payment. Paddle's
  documentation says nothing either way. So a signed-in person who saves
  transaction ids during their trial could start a free period after the
  trial has ended, or push their first payment out by up to the length
  of the trial. Unpaid transactions are now cancelled about an hour
  after they are made (the next bullet), which narrows this to that
  hour for transactions `create-checkout` made, and does not end it.
  One of the two retired catalogue trial prices opened by hand is a
  separate route to the same free period: nothing cancels that, and it
  stays open until those two prices are archived (`DEPLOY.md` 8.1). So
  never say "nobody can get a free period after their
  trial has ended": what is true is that `create-checkout` never MAKES a
  transaction for such an account. `paddle-webhook` cannot undo it (it
  never moves a date earlier than checkout showed). It reads the
  account's row before writing over it and logs "free period on an
  account whose own free trial was not running", and "First payment
  later than the rule: by N hours" for a date well past the rule. What
  to do about such a subscription once it is paid is Mal's call; the
  next bullet is what is built for the late-payment route.
  `create-checkout` also has no limit on how often one account may
  call it; a cap needs a table, which is a new stored record about an
  account and so Mal's decision too.
- **Unpaid prepared purchases are cancelled about an hour after they are
  made (Mal, 25 Nov 2026).** The `expire-checkouts` edge function does
  it, run every ten minutes by the `countdown-expire-checkouts` job that
  `supabase/schema-expire-checkouts.sql` makes. So a prepared purchase
  stays open for between 60 and about 70 minutes, longer if a run
  fails. It cancels only a transaction that is unpaid (status `draft` or
  `ready`), was made through the API by `create-checkout`, belongs to no
  subscription, and is 60 minutes old or more
  by Paddle's own `created_at`. It knows `create-checkout`'s
  transactions by either of two marks: `made_by` on `custom_data`, or
  the one-off price whose description ends "(create-checkout)". Do not
  rename either text in one file without the other (tests pin both).
  Two marks because, in theory read from Paddle's documentation and
  never tried, the page holding a checkout can replace a transaction's
  custom data. It will never cancel one that is billed,
  paid, completed or past due, one made any other way (a dashboard
  invoice, a checkout opened on a catalogue price), one with a payment
  attempt that might still be in progress, or one younger than 60
  minutes. Cancelling a subscription AFTER payment was offered to Mal
  and declined: do not build it. What is left: the hour itself (someone
  whose trial ends inside the hour can still pay and start the free
  period); a transaction carrying a payment attempt that never settles;
  more than 120 an hour, which wait for later runs, and one account can
  make that many by itself because `create-checkout` has no limit, so
  the hour is not a ceiling against a flood; the two retired catalogue
  trial prices opened by hand, which this never touches; and any
  stretch when the function or the job is not running. A fault charges
  nobody and cancels nothing: it leaves them open, and logs "Could not
  close checkouts". A run that leaves old unpaid ones open for a reason
  other than somebody paying (Paddle refusing a cancel, a still unpaid
  one not passing the second read, more waiting and none cancelled) is
  logged as that fault and never as a healthy "checkouts closed:" line. A customer who leaves Paddle's checkout open for over an
  hour without paying has it cancelled, and what the overlay shows then
  has not been seen. Only true once the function is deployed AND the job
  is scheduled: check `supabase functions list` and `select jobname from
  cron.job` before saying so. Read against Paddle's documentation on
  25 Nov 2026 and run against stubs (part E of
  `tools/foundation-test.mjs`); the SQL has never been run. It first
  meets Paddle in `DEPLOY.md` 8.4 Test D. Never print a cron job's
  command (`select command from cron.job`, or `select *` on `cron.job`
  or on `cron.job_run_details`, which has a command column too): it
  holds the cron secret, and Mal must never be asked to paste that
  secret.
- **A discount code typed by someone in their trial is checked on the
  server.** Paddle lists a discount as "active" until it is archived, so
  `create-checkout` also reads its end date, its limit of uses and what
  it is kept to, and answers "not recognised" with no transaction when
  the code cannot be used. A discount kept to a PRICE id never applies
  on this path, because the price bought is a copy: keep discounts to
  the product or to nothing (`DEPLOY.md` 8.1). What Paddle does with a
  discount set on such a transaction has not been seen.
- **What "21 days" and "30 days" become.** A Paddle trial is whole days
  from the purchase, so the count is rounded UP, never down. The first
  payment is taken at the time of day the customer subscribed, on the
  first such moment at or after day 21 (monthly) or day 30 (yearly) from
  the account being made: between 21 and 22 days (30 and 31), never
  before. During the offer it is between `2027-01-01T12:00Z` and
  `2027-01-02T12:00Z`, which for most Australian subscribers shows as
  2 January 2027. "From 1 January 2027" stays true. Never round down and
  never add a safety margin without Mal: down is a payment before the
  promised date.
- **The rule is only for someone who subscribes while their free trial is
  running.** Mal's sentence (22 Nov 2026): "Initial payments will not be
  charged before 1 January 2027 if you sign on while in your free 14-day
  trial period." On the pages it is always written whole: "First payments
  are not charged before 1 January 2027 if you subscribe while your free
  14-day trial is running." Never shorten it to "No first payment is taken
  before 1 January 2027", which reads as a promise to everyone. Subscribe
  after the trial has ended and you pay on the day, before 2027 or after
  it. `billing.js` asks `create-checkout` only while the account's own
  trial is running and holds no date; a lapsed account takes the plain
  price and pays on the day. Never give a lapsed account a free period.
  (An instruction to do that was drafted on 22 Nov 2026 and withdrawn by
  Mal minutes later.) A failed call to `create-checkout` stops with "try
  again": it never falls back to a catalogue price, because the old trial
  price shows a wrong date and the plain price charges today.
- **A free trial is plan `trial`. Status `trialing` alone is not one.**
  Paddle keeps a subscription made with a free period at status `trialing`
  until its first payment, which under the launch offer is weeks, so every
  launch subscriber has status `trialing` and plan `monthly` or `annual`
  until 1 January 2027. That is a subscriber with a card on file. From
  22 Nov 2026 `app.js` (`isTrial`), `billing.js` (the `inTrial` test in
  `openCheckout`), `identity-bridge.js` (the header chip) and
  `pricing.html` all test `plan === 'trial'`, and `create-checkout` makes
  the same test on the server; before that they also accepted the status,
  so a subscriber was told "Free trial, no card is needed", shown the
  plans again and could open checkout on the trial price a second time.
  `billing.js` now refuses checkout to an account with a running Paddle
  subscription that is not set to end, and stops when the entitlement
  lookup fails (status `unknown`) rather than opening the plain price.
  The Account tab shows such a subscriber as "Monthly, first payment from
  <date>". Read from the code and run against stubs (P22), not in a
  browser, and that Paddle holds `trialing` to the first-payment date is
  `DEPLOY.md` Test A's statement, not something observed.
- **Subscribers with the same account day get the same date, to within
  24 hours, whichever day of the trial they subscribe on.** Checkout
  shows the date itself (above), so the difference is only the time of
  day each subscribed, never the day of the trial (Mal: "consistency is
  critical when offering value for early loyalty"). The earlier plan, a
  7-day trial on the monthly trial price in Paddle, is retired: nothing
  in Paddle's catalogue has to be set for this, and `DEPLOY.md` 5.6 no
  longer asks for it. Only true once `create-checkout` is deployed: check
  before saying so. It is true of a checkout opened and paid in one go,
  which is what the Buy button does. A transaction made at one time and
  paid later, which `expire-checkouts` is built to limit to about an
  hour (the bullet on unpaid prepared purchases says when that is true
  and what is left), counts its days from the moment it was paid (the
  bullet on MADE and PAID, above). The
  never-earlier rule stays in `paddle-webhook` as a safety net.
- **The two catalogue trial price ids stay in `app/config.js` for now,
  and nothing opens them.** `pricing.html` and `index.html` can be paired
  with an OLDER cached `billing.js`, which falls back to the plain price
  when the trial ids are missing and so charges a trialling customer
  today. Take them out only in a later release, after both prices are
  archived in Paddle (`DEPLOY.md` 8.1). `PLAIN_PRICE` in `create-checkout`
  repeats the two plain ids; a test pins them equal.
- **A first-payment move that fails is answered 500, not logged and
  forgotten.** A purchase made through `create-checkout` needs no move,
  so this is now only for a subscription that did not come through it (an
  old cached page on a catalogue trial price, or a date a few seconds
  short). When a move is needed and does not happen (no `PADDLE_API_KEY`,
  Paddle refuses or cannot be reached, the account's creation date cannot
  be read), `paddle-webhook` writes the row, the grants and the
  Foundation claim first, then answers 500 without recording the event,
  so Paddle retries. Premium is on from the first attempt. Search the
  `paddle-webhook` log for "Could not defer first charge", and for "first
  charge moved after checkout" and "trial subscription on a catalogue
  price", which are the net at work. That move has only ever run against
  stubs: `DEPLOY.md` 8.4 Test C (the old Buy button, before the merge) is
  the one time it meets Paddle, and it also shows the API key may change
  a subscription, which Test A does not. A fault in `create-checkout` charges
  nobody: checkout does not open for an account in its trial, the page
  says to try again, and the function logs "Could not make checkout".
  Nobody is told unless a customer writes in. Only true once the
  functions are deployed.
- **The merge must not go out over an older `paddle-webhook`.** The one on
  `main` before this release moves a first payment to the account's
  creation plus 30 days in either direction, so under the new pages it
  would pull a date checkout showed as January back into December.
  `DEPLOY.md` 5.6 has the tick straight before the merge: `supabase
  functions list`, and "first charge: checkout's date stands" seen in
  the log, a line only the new function writes. The merge before
  `create-checkout` is deployed only stops sales.
- **`LAUNCH_FIRST_CHARGE` is `2027-01-01T12:00:00Z`, not Adelaide
  midnight.** That is Mal's rule: the
  moment the last time zone on Earth (UTC-12) reaches midnight on New
  Year's Eve, so it is already 2027 on every customer's calendar. In
  Adelaide it is 10:30 pm on 1 January. Because that moment is early on
  2 January in New Zealand and a few Pacific islands, customer-facing
  wording says the first payment is taken **"from 1 January 2027"**, never
  "on" (Mal, 22 Nov 2026). The rule lives in `paddle-webhook`, which is
  only true once it is deployed: check before saying so.
- **The 100 places are enforced by `supabase/schema-foundation.sql` and
  `paddle-webhook`**, which is only true once Mal has run the SQL and
  deployed the function: check before saying so
  (`select public.foundation_status();`). Until then nothing stops
  subscriber 101. The closing instant is written into the SQL functions,
  so a database that ran the file while it still said 5 December closes
  Foundation on 5 December until the file is run again. Step 5 of
  `supabase/test-foundation.sql` fails on the old close.
- **Pie Timers is public on Google Play, since 22 Nov 2026** (release 7,
  1.0.6). Closed testing came before it. Older notes that say it has not
  launched, or that its Play page is a 404, are out of date.
- **Nothing under `supabase/` is the deployed state.** Those files describe
  what *should* be running. SQL only changes when it is executed in the
  Supabase SQL editor (project `tgapmpbcqqnpsldehuqa`); an edge function only
  changes when `supabase functions deploy <name>` is run. Editing either one
  changes nothing by itself. Verify before reporting that something is in
  effect — `select public.trial_length();` for the SQL, `supabase functions
  list` for the functions. On 20 Sep 2026 both had been edited and neither had
  been deployed, and the gap was invisible from the repo.
- **The launch dates live in several places.** If one moves, move all of
  them, and bump `CACHE` in `app/sw.js`.
  - The 31 Dec close (`2027-01-01T12:00Z`): `claim_foundation_place()`
    and `foundation_status()` in `supabase/schema-foundation.sql`, and the
    rehearsal in `supabase/test-foundation.sql`; `FOUNDATION_CLOSES` in the
    status block on `app/pricing.html` and `app/foundation.html`, which
    also takes the offer panel down on `pricing.html`; `END` in the pie
    script on `app/foundation.html`; and the copy on those two pages.
  - The first-payment rule: `LAUNCH_FIRST_CHARGE`, `FREE_DAYS_YEARLY` and
    `FREE_DAYS_MONTHLY` in `supabase/functions/paddle-webhook/index.ts`
    (it holds no closing date any more: `LAUNCH_OFFER_END` is gone), and
    the same three again in
    `supabase/functions/create-checkout/index.ts`, which is what decides
    the date checkout shows; the copy on `app/pricing.html`,
    `app/foundation.html` and `app/terms.html`; and `app/README.md`.
  - The 5 Dec trial finish line for accounts made before 22 Nov:
    `public.trial_length()` in `supabase/schema-access-codes.sql`,
    `supabase/relaunch-2026-11.sql`, and one sentence each on
    `app/pricing.html` and `app/foundation.html`.
  - All three: sections 5.6, 8.4 and 8.5 of `DEPLOY.md`, and
    `tools/foundation-test.mjs`, which pins them.
  - Outside this repo, the aibhlinn.ai site repo's `index.html` quotes the
    launch price, the hook with its condition and the 31 Dec close in its
    Pie Timers advert, and must move with the rest. That page has no
    script. Its advert is taken down by a scheduled GitHub Actions
    workflow in that repo, `.github/workflows/retire-offer.yml`, which
    holds the closing instant as `2026-12-31T13:30:00Z`: if the close
    moves, move it there too.
  - Also outside this repo, AibhlínnAI Premium is sold on a site of its
    own, https://premium.aibhlinn.ai (repo `AibhlinnAI/premium.aibhlinn.ai`,
    Mal, 25 Nov 2026; Paddle would not approve checkout on aibhlinn.ai,
    which also describes consulting). Its `index.html` and `premium.js`
    carry the offer's wording and an `OFFER_CLOSES` of their own, and
    must move with the rest. That site calls this repo's `signin` and
    `create-checkout` functions, which is why both read a list of
    allowed sites (`ALLOWED_ORIGINS`, with the older `ALLOWED_ORIGIN`
    still counted; `tools/origin-test.mjs` pins the behaviour).
- **The checkout on pietimers.aibhlinn.ai is hidden, not deleted** (Mal,
  25 Nov 2026). Premium is bought on https://premium.aibhlinn.ai. Every
  offer in the web app links there: the header button, both Premium
  Feature buttons, the footer and page links named Pricing, and one
  "Get AibhlínnAI Premium" link in Settings, which stands in for the plan
  cards, the price hint and the discount code. `app/pricing.html` asks
  search engines to leave the page out and sends a visit to the Premium
  site, with a plain link at the top as the fallback. `pricing.html`,
  `billing.js` and the Settings checkout are all still there and still
  tested. To bring them back: empty `CT.premiumSiteUrl` in
  `app/identity-bridge.js`, set `PREMIUM_SITE` to `''` in the head of
  `app/pricing.html`, take out the robots line and the notice there, and
  point the static links back at `pricing.html`. **The Play app links to
  no place of sale, the Premium site included**: every one of those
  links is either never drawn there or carries `data-hide-in-play`, and
  the Play gate at the top of `pricing.html` runs before the redirect.
  Its one plain line names the site in words only.

  `DEPLOY.md` was missing from this list until 20 Sep 2026, which is
  exactly why it went stale.
- **`billing.js` carries the same `?v=` in `app/pricing.html` as in
  `app/index.html`.** When `billing.js`'s `?v=` is bumped (in
  `index.html` and in `SHELL` in `app/sw.js`), bump it in `pricing.html`
  too. Asked for by its plain name, the service worker stores whatever
  copy the browser's own cache hands it, which just after a release can
  be the old file, and an old `billing.js` is an old checkout.
- **Nothing in this repo has to be taken down by hand on 1 January 2027.**
  Mal may not be available that day (22 Nov 2026), so nothing may depend
  on him or on a session being run. Keep it that way: anything a script
  cannot take down must be written so it never needs taking down.
  That is about takedowns only. A 500 from `paddle-webhook` still needs a
  person, that day as any other: `DEPLOY.md` 5.6 has the ticks for before
  he goes away. Never say "nothing needs a person on 1 January".
  - `app/pricing.html`: the offer's name, hook and condition sit in
    `#offerDates`, which `renderOfferDates()` hides at `FOUNDATION_CLOSES`.
  - `app/foundation.html`: the pie script hides the hook and its condition
    at `END` and the caption becomes "The offer is over. It ran to the end
    of 31 December 2026." Both pages also hide `#offerSentence` then: the
    owner's sentence "During the Black Friday Launch Offer, first payments
    will not be charged before 1 January 2027 if you subscribe while your
    free 14-day trial is running."
  - The `<meta name="description">` of both pages carries no offer, no
    hook and no date. A description cannot be taken down by a script, so
    do not put an offer back in one.
  - `app/terms.html` has no date check. Its one offer sentence dates
    itself: "Until the end of 31 December 2026 the Black
    Friday Launch Offer applies: ...". It stays true after that day and
    can stay where it is. Never reword it to "the offer running now".
  - Foundation closes in the database, and the first-payment rule has no
    cut-off.
  - `tools/foundation-test.mjs` pins all of this (P20, P21). The pages can
    be tidied whenever someone next works on them; no date forces it.
  - The aibhlinn.ai advert retires itself too, in its own repo (above).
    That only works once the workflow file is on that repo's `main`, and
    GitHub switches scheduled workflows off in a repo with no commits for
    60 days: check before saying it will run.
- **Foundation is a price lock, not a trial.** A$2.90/month or A$19/year, 100
  places, closing at the end of 31 December 2026 or when full.
  Separate from trial length. Never describe it by contrast with paying
  nothing.
- **Foundation's 100 is held by the database.**
  `foundation_claims.place` is unique and must be 1 to 100
  (`supabase/schema-foundation.sql`), so a 101st place cannot be stored. A
  place is claimed by `paddle-webhook` on `subscription.created`, judged on
  the instant Paddle says the subscription was made. Cancelling never frees
  a place, and the lock belongs to the subscription that earned it: a member
  who cancels and subscribes again is answered `lock_lost` and takes no new
  place. Subscriber 101 still subscribes at the same price, without the
  lock: nothing blocks a purchase. Complimentary accounts take no place.
  Paid testing-service accounts do not qualify either, but nothing marks
  them in the database: Mal withholds each one by hand with the statement in
  the SQL file (`DEPLOY.md` 5.6), which is only true once he has run it.
  `tools/foundation-test.mjs` holds the wiring; it runs no SQL, so
  `supabase/test-foundation.sql` (run by Mal, rolls itself back) is the
  first real test of the SQL. A full Foundation does not take the hook
  down or change the first-payment rule, which has nothing to do with
  places.
- **Before reusing an event page for a new event, port the live-mode fixes.**
  The branch `live-clock-port-draft` holds an early draft of the live-clock
  work (23 Sep 2026, built on `ee3e91d`). Most of it reached `main` another
  way, but these did not, as read against `main` on 20 Nov 2026 (not run in a
  browser): on `/ndexpo26`, `/nsw26` and `/nwc26` the notice strip stays amber
  when live, where the draft makes it neutral; on `/nwc26` under `?live=1`
  the footer still says the clock is simulated and to press Pause, a button
  that is hidden; on `/nwc26` a preview left running never loops back and
  ends on "Finished." (it read "Already over." until 22 Nov 2026); and `/nwc26` lacks some small accessibility items
  (focus-ring contrast, the slider spoken as a clock time). The draft also
  keeps the day tabs when live and pins a day, where `main` hides them on
  purpose: that is a design choice to make, not a fault. `/nls26` was not
  checked. Port by hand against `main`; never merge that branch. Its commit
  message lists every item.
- **Before the next event page goes live, decide the offline fallback.** The
  branch `sw-offline-event-pages` (`da6fe3b`, 26 Sep 2026) holds a fix that
  never reached `main`. As read against `main` on 24 Nov 2026 (not run): the
  app's service worker also controls the event folders, and when a page
  request fails offline with no saved copy it answers with the app's
  `index.html` for any address. At an event address that page's relative
  styles and scripts would miss. Saved pages are also keyed by the full
  address, so `/nsw26/` saved online is not found offline as
  `/nsw26/?live=1`. The branch limits the fallback to the app's own two
  addresses and drops the query from the key. Its third change, not letting
  an error page replace a good copy, is already on `main`. The diff no longer
  applies: port about 15 lines by hand using `fromCache()`, not
  `caches.match()`, with a fresh `CACHE` number. Test B10 in
  `tools/check-sw.js` asserts today's behaviour, so choose first: fallback
  only for the app's own addresses, as the branch does, or keep it for
  root-level pages such as `pricing.html` and refuse it only in sub-folders.
  Not known: whether this shows on a real device, or whether the Play app
  uses this worker. Never merge that branch; its commit message has the
  diagnosis and a test recipe.
- **An event program as data, not a hand-built page, exists on a branch.**
  `worktree-nwc26` (`0596a51`, 22 Sep 2026, 1,957 lines) adds a
  `?preset=<id>` link that loads `app/presets/<id>.json` into the app as
  appointments, one viewer page (`program.html`) for any event, a written
  preset format, and removes the dead `AGENDA` seed from `app/app.js`. `main`
  went the other way, with one hand-built page per event, and those pages are
  now ahead of the branch's viewer in places (the real-clock live mode). It
  is kept as a reference for the day copying a page per event stops scaling.
  A port is medium work by hand: every `app/app.js` hunk has moved,
  `tools/breaks-sim.js` and `tools/shift-alerts-sim.js` pull `AGENDA` and
  `hasAgenda` out of `app/app.js` by name, the wording predates the "program"
  spelling and the no-em-dash rule, and its README repeats the "leave nothing
  behind" claim that `main` removed. Never merge that branch.
- **Theory, not a confirmed fault: Copy a day's Undo after Restore defaults.**
  From reading `main` on 24 Nov 2026, not run. `replaceState` in `app/app.js`
  skips the rebuild when a pull brings nothing new (R21), comparing the
  pulled copy with `state` as it stands. Restore defaults writes
  `DEFAULT_SCHEDULE` days, which lack the `lunchHeadHome` and `endHeadHome`
  keys that `normalise()` always adds. So a signed-in person who taps Restore
  defaults and then Copy a day before the next pull, about a minute, may see
  Undo disappear once. Confirm it in a browser before changing anything. If
  real, the likely fix is small: have Restore defaults write normalised days,
  or compare against `normalise(state)`.

## Working with Mal

Follow the `mal-collaboration-style` skill: headings with emoji for each
topic, a `---` rule between them, reasoning in dot points, all questions
gathered at the end, one question at a time. Manual tasks as numbered steps
with tick boxes and both a ✅ and an ❌ branch.
