# Pie Timers — notes for Claude

## Message board

`MESSAGE-BOARD.md` is how sessions talk to each other. Sessions do not share
memory, so it is the only way a fact learned in one session reaches the next.

- **Read it before starting work** on anything AibhlínnAI, including scheduled
  task runs and Code sessions.
- **Add an entry when you finish a task**, or when you learn something that
  would have changed how you started. Newest at the top.
- Correct wrong entries in place rather than leaving them to mislead.

## Things worth knowing before you act

- **October 2026 is Launch Month.** Not 19 September — that was the ADHD
  conference, attended for tester recruitment and research.
  `app/foundation.html` is the product-facing source of truth for the dates.
  The offer: accounts made before **18 Oct 2026 00:00 +10:30** get Premium
  free to **1 Nov** (a fixed finish line, not a rolling window); from 18 Oct
  the standard 14 days from signup applies, which for an 18 Oct signup is also
  1 Nov. Subscribe before **1 Nov** and the first charge falls **1 Dec**;
  after that, 30 days from signup. Foundation closes 1 Nov or when 100 places
  go.
- **Pie Timers has not publicly launched.** It is in Google Play closed
  testing. Do not assume a date on the calendar is a launch date — check the
  board and the docs.
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
  `LAUNCH_FIRST_CHARGE` in `supabase/functions/paddle-webhook/index.ts`; the
  copy on `app/pricing.html`, `app/foundation.html` and `app/terms.html`; and
  sections 8.4 and 8.5 of `DEPLOY.md`. If one moves, move all of them, and bump
  `CACHE` in `app/sw.js`. `DEPLOY.md` was missing from this list until
  20 Sep 2026, which is exactly why it went stale.
- **Foundation is a price lock, not a trial.** A$2.90/month or A$19/year, 100
  places, closing at the start of 1 November 2026 (Adelaide) or when full.
  Separate from trial length. Never describe it by contrast with paying
  nothing.

## Working with Mal

Follow the `mal-collaboration-style` skill: headings with emoji for each
topic, a `---` rule between them, reasoning in dot points, all questions
gathered at the end, one question at a time. Manual tasks as numbered steps
with tick boxes and both a ✅ and an ❌ branch.
