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

- **The launch offer was reset on 22 Nov 2026 and runs to the end of
  5 Dec 2026.** It first ran in October 2026 ("Launch Month": 18 Oct, 1 Nov,
  1 Dec), before the app was public; Mal reset it the day Pie Timers went
  public on Google Play. `app/foundation.html` is the product-facing source
  of truth for the dates. The offer: accounts made before **22 Nov 2026
  00:00 +10:30** get Premium free to the end of **5 Dec** (the instant is
  6 Dec 00:00 +10:30; a fixed finish line, not a rolling window); from
  22 Nov the standard 14 days from signup applies, which for a 22 Nov signup
  is the same instant. Subscribe by **5 Dec** and the first charge falls
  **1 Jan 2027**; after that, 30 days from signup. Foundation closes at the
  end of 5 Dec or when 100 places go, and its 100 places count from 22 Nov
  (nobody had subscribed before then). Accounts that already existed were
  moved to the new finish line by `supabase/relaunch-2026-11.sql`, which is
  only true once Mal has run it: check before saying so. Since 22 Nov 2026
  the offer is called the **Black Friday Launch Offer** and its hook is
  **"Pay nothing until 2027"**. The hook is only true with its condition, so
  it always sits right beside "subscribe by 5 December 2026 (Adelaide time)
  while your free trial is running" wording. The closing instant is
  Adelaide midnight, which is earlier on 5 December everywhere to the west,
  so the date always carries "(Adelaide time)". The first charge is the
  other way round: `LAUNCH_FIRST_CHARGE` is `2027-01-01T12:00:00Z`, not
  Adelaide midnight. That is Mal's rule: the moment the last time zone on
  Earth (UTC-12) reaches midnight on New Year's Eve, so it is already 2027
  on every customer's calendar. In Adelaide it is 10:30 pm on 1 January. The 100 places are enforced by
  `supabase/schema-foundation.sql` and `paddle-webhook`, which is only true
  once Mal has run the SQL and deployed the function: check before saying so
  (`select public.foundation_status();`). Until then nothing stops
  subscriber 101.
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
- **The launch dates live in several places.** `public.trial_length()` in
  `supabase/schema-access-codes.sql`; `LAUNCH_OFFER_END` and
  `LAUNCH_FIRST_CHARGE` in `supabase/functions/paddle-webhook/index.ts`;
  `claim_foundation_place()` and `foundation_status()` in
  `supabase/schema-foundation.sql`; `FOUNDATION_CLOSES` in the status block
  on `app/pricing.html` and `app/foundation.html`; the copy on
  `app/pricing.html`, `app/foundation.html` and `app/terms.html`; and
  sections 5.6, 8.4 and 8.5 of `DEPLOY.md`. Outside this repo, the aibhlinn.ai
  site repo's `index.html` now quotes the launch price and the closing date
  in its Pie Timers advert, and must move with the rest. That page has no
  script, so its offer lines come out by hand when the offer closes. If one
  moves, move all of them, and bump `CACHE` in `app/sw.js`. `DEPLOY.md` was
  missing from this list until 20 Sep 2026, which is exactly why it went
  stale.
- **Foundation is a price lock, not a trial.** A$2.90/month or A$19/year, 100
  places, closing at the end of 5 December 2026 (Adelaide) or when full.
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
  first real test of the SQL. A full Foundation does not end the 1 January
  first-payment date, which depends only on when someone subscribes.
- **Before reusing an event page for a new event, port the live-mode fixes.**
  The branch `live-clock-port-draft` holds an early draft of the live-clock
  work (23 Sep 2026, built on `ee3e91d`). Most of it reached `main` another
  way, but these did not, as read against `main` on 20 Nov 2026 (not run in a
  browser): on `/ndexpo26`, `/nsw26` and `/nwc26` the notice strip stays amber
  when live, where the draft makes it neutral; on `/nwc26` under `?live=1`
  the footer still says the clock is simulated and to press Pause, a button
  that is hidden; on `/nwc26` a preview left running never loops back and
  ends on "Already over."; and `/nwc26` lacks some small accessibility items
  (focus-ring contrast, the slider spoken as a clock time). The draft also
  keeps the day tabs when live and pins a day, where `main` hides them on
  purpose: that is a design choice to make, not a fault. `/nls26` was not
  checked. Port by hand against `main`; never merge that branch. Its commit
  message lists every item.

## Working with Mal

Follow the `mal-collaboration-style` skill: headings with emoji for each
topic, a `---` rule between them, reasoning in dot points, all questions
gathered at the end, one question at a time. Manual tasks as numbered steps
with tick boxes and both a ✅ and an ❌ branch.
