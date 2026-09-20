# Message Board

Where Claude sessions working on AibhlínnAI leave notes for each other. Mal
reads it too, but it is written for the next session, not for him.

It exists because sessions do not share memory. A scheduled reminder, a Code
session and a chat session can each be confidently wrong about the same fact,
and the only way the next one finds out is if the last one wrote it down.

**How to use it**

- Read the board before starting work on anything AibhlínnAI.
- Add an entry when you finish a task, or when you learn something that would
  have changed how you started.
- Newest entry at the top, under the rule.
- Head each entry with the date, the session it came from, and a one-line
  summary. Then what changed, and anything still open.
- Correct wrong entries in place and say what was wrong. This is a working
  record, not a log to preserve.
- Do not put secrets here. No keys, no tokens, no customer names.

---

## 2026-09-20 — scheduled task `pie-timers-close-trial-window` — fired as a
## test run, 28 days before its real date

**Read this if you are the 18 October run of this task.** The prompt inside
`pie-timers-close-trial-window` opens "As of today, 18 October 2026, the
boundary has passed". On this run it was **20 September 2026**. The schedule
itself is correct — `nextRunAt` is 2026-10-17T18:30Z and the task is enabled —
so this was a manual "Run now", not a misfire. Nothing to fix in the schedule.

The trap: the prompt's success criterion is "`select public.trial_length()`
returns `14 days`". On 20 September that answer would have been **wrong** — the
18 Oct boundary had not been crossed, so the correct answer was an interval
counting down to 1 Nov, about 41 days. A session that took the prompt's date at
face value would have told Mal a correct system was broken, or worse, told him
a broken one was fine. Check the actual date against the boundary before
reading the result.

## The database was wrong, and is now fixed

**`trial_length()` had never been redeployed.** The entry below, written earlier
the same day, says the SQL "has not been run" — and it still had not been. Mal
ran `select public.trial_length()` and got **`30 days`**: the *previous*
deployed version, the one with the 19 Oct boundary. So every account created
between the offer changing and this run was getting 30 days from signup instead
of the 1 Nov finish line.

He pasted the `create or replace function public.trial_length()` block from
`schema-access-codes.sql` (lines 39-65) into the SQL editor and re-checked. It
now returns **`41 days 07:39:23`** — exactly the distance to 1 Nov 00:00 +10:30,
which also confirms the offset is being applied properly. **Deployed function
and repo file now agree.**

*If you ever need to redeploy it:* give him that function block on its own. Do
**not** tell him to run the whole file — it ends with a backfill `insert` and a
large amount of unrelated table DDL.

## The 18 stranded testers, also fixed

Replacing the function only helps new signups, so the existing cohort was
checked: **18 trialing accounts, all expiring between 8 Oct and 19 Oct
Adelaide** — every one before 1 Nov. Working back from signup + 30 days they
registered **7–19 September**, i.e. the run-up to the ADHD conference and the
day itself. That is the recruited closed-test cohort, entire. Left alone they
would all have lost Premium during launch month and before Foundation closed.

Backfilled onto the finish line with:

```sql
update public.subscriptions
   set current_period_end = timestamptz '2026-11-01 00:00:00+10:30',
       updated_at = now()
 where status = 'trialing' and plan = 'trial'
   and current_period_end < timestamptz '2026-11-01 00:00:00+10:30';
```

Re-running the count afterwards returned **0**. Confirmed done.

Three things worth keeping about that `update`:

- **It was a correction, not a giveaway.** The decided offer gives any account
  created before 18 Oct a trial to 1 Nov. These accounts qualified; they missed
  out only because the function was stale.
- **It is idempotent and safe to re-run at any date.** It matches only rows
  below 1 Nov, and every correctly-granted trial falls outside that — pre-18-Oct
  lands exactly on 1 Nov, post-18-Oct gets 14 days and lands later.
- **The Supabase editor reports `Success. No rows returned` for it**, because
  there is no `returning` clause. That is not "zero rows changed" — it means no
  result set. Always confirm a write with a follow-up `select`, and do not tell
  Mal to expect a row count.

## Committed and deployed

Everything above was uncommitted at the start of this run. Committed as
**`efb4d4f`** and pushed to `main`, which triggers
`.github/workflows/deploy.yml` → GitHub Pages → https://pietimers.aibhlinn.ai.

Eight files: `app/foundation.html`, `app/pricing.html`, `app/terms.html`,
`app/sw.js` (v98), `supabase/README.md`, `supabase/schema-access-codes.sql`,
`supabase/functions/paddle-webhook/index.ts`, and `DEPLOY.md`.

**`DEPLOY.md` was stale and is now fixed.** Sections 8.4 and 8.5 still described
the removed 19 Oct / 60-day / `FREE_DAYS_LAUNCH` shape, so the manual Paddle
test told you to check for the wrong `next_billed_at`. It now says 1 Dec before
`LAUNCH_OFFER_END` and day 30 after, and states that the branch keys on the
**moment of purchase**, not account creation. `DEPLOY.md` is not on CLAUDE.md's
list of places the launch dates live. **It should be** — add it.

Checked before pushing, since the repo is public and `app/` + `identity/` are
served: `app/` carries no stale launch dates (the surviving "30 days" hits are
the refund window, the privacy response time and the correct new copy; the
"60 days" in `terms.html:142` is the service wind-down promise). The
`supabase/` diff carries nothing secret-shaped.

**This file and `CLAUDE.md` are now in the repo**, as commit **`8f809b8`** —
Mal's decision, asked and answered. Before that they existed only in the Drive
folder, so a fresh clone had no board at all. Consequence worth knowing: **the
board is now a tracked file.** Editing it leaves the repo dirty, so commit it
when you finish, the same as any other change. It is not served to the site —
the deploy publishes only `app/` and `identity/`, and
`https://pietimers.aibhlinn.ai/MESSAGE-BOARD.md` returns 404. Verified.

The same commit corrected two things in `CLAUDE.md`: `DEPLOY.md` added to the
list of places the launch dates live, and the "not the deployed state" note
widened from SQL to cover edge functions, with the verifying command for each.

**Still deliberately uncommitted — Mal's call, not a session's.**
`docs/Tester-Tour-WhatsApp.md`, `docs/conference/`, `docs/play-listing/`, and
three images in `identity/`. Two reasons to think before adding them: the repo
is **public**, so the tester tour and the Play listing pack become readable by
anyone; and the deploy copies **all** of `identity/` onto the live site, so
`Feature Graphic_Pie Timers.jpg` and `Letterhead_Pie Timers.jpg` would be
publicly served. No tester personal data was found in any of them — only
`support@aibhlinn.ai` — so this is a disclosure-of-strategy question, not a
privacy one.

## `paddle-webhook` was stale too, and is now redeployed

The webhook had been **edited on 20 Sep and never deployed**. The Edge Functions
list showed it last updated ≈13 Sep at 11 deployments, so production was still
running `FREE_DAYS_LAUNCH` / `freeDaysFor()`, keyed on account creation date.

That briefly contradicted a published promise: commit `efb4d4f` had just put
"your first payment is taken on 1 December" and "we move it to the right date
shortly after you subscribe" onto the live terms and pricing pages, while the
function performing that move would have set `created_at + 60 days` — 14 Nov for
a 15 Sep account. Nobody subscribed in the gap, so no customer was affected.

Redeployed with `supabase functions deploy paddle-webhook`. Confirmed **version
11 → 12, status ACTIVE**, timestamp current. The Supabase CLI (2.117.0) is on
Mal's PATH and `supabase/.temp/linked-project.json` is already linked to the
project, so `--project-ref` is not needed.

*Note for whoever hands Mal a command next:* he pasted this one into the
Supabase **SQL editor** and got `syntax error at or near "supabase"`. Every
other instruction that day had been SQL for that same editor. Say explicitly
which window a command belongs in — terminal or SQL editor — rather than relying
on the code fence to imply it.

## Still open — pick these up

1. **The stale comment at `schema-access-codes.sql:41`** is still there, per the
   entry two below. Unchanged.
2. **Add `DEPLOY.md` to the list of places the launch dates live** in
   `CLAUDE.md`. It was missed, and that is why it went stale.
3. **Decide on the remaining untracked files** — the tester tour, the
   conference QR, the Play listing pack and the three `identity/` images. See
   "Committed and deployed" above for why they were not added.

**Lesson for the next session, stated plainly:** the entry below flagged the SQL
as unrun, and the flag was all that happened — a board note saying something is
undeployed is not a record that it is handled. Worse, the *same* session that
flagged the SQL also edited `paddle-webhook` and did not flag that one, so it
sat stale and unnoticed (see below). When you read that a change is pending,
check whether it is still pending **first**, and check every artefact the change
touched, not only the one someone thought to mention.

---

## 2026-09-20 — chat session — the launch offer changed shape

Mal reset the offer. The trial is no longer a longer *interval* for the launch
cohort; it is a **fixed finish line**. Implemented across code and copy,
uncommitted, and **the SQL has not been run** — see the end of this entry.

**The offer as it now stands**

- Make an account **before 18 Oct 2026 00:00 +10:30** → Premium free until
  **1 Nov 2026 00:00 +10:30**, however early you joined.
- From **18 Oct** → the standard 14 days from signup. Chosen so the two rules
  meet without a step: 18 Oct + 14 days is 1 Nov, exactly where the finish
  line already sits. Nobody gains or loses a day at the boundary.
- **Subscribe before 1 Nov** while still in trial → Premium free to 30 Nov,
  first charge **1 Dec 2026**.
- After 1 Nov → the standing rule, first charge 30 days after signup.
- Foundation is unchanged: price lock, 100 places, closes 1 Nov or when full.

**What changed in the repo**

- `public.trial_length()` now returns `'2026-11-01 00:00+10:30' - now()`
  before the boundary, and `interval '14 days'` after. `grant_trial()` adds it
  to `now()`, so the whole cohort lands on the same instant. The boundary
  constant still has its null guard: set it null and everyone gets the
  fortnight.
- `paddle-webhook/index.ts`: `FREE_DAYS_LAUNCH` and `freeDaysFor()` are gone,
  replaced by `LAUNCH_OFFER_END` (1 Nov), `LAUNCH_FIRST_CHARGE` (1 Dec) and
  `firstChargeAt()`. **It is now keyed on the moment of purchase, not the
  account's creation date.** That reversal is safe only because the answer is
  identical for everyone inside the window — there is no click to time.
- Copy: `app/pricing.html`, `app/foundation.html`, `app/terms.html` (clause 5
  now describes a fixed promotional date in general terms, with the current
  offer named), `supabase/README.md`. Policy dates moved to 20 Sep 2026 and
  the service worker cache went to v98.

**The one case the offer does not reach.** `deferFirstCharge` still returns
early unless the payload says `status: "trialing"`. Someone whose trial has
already lapsed — a closed tester from September, say — who subscribes in
October is charged on the day, because the money has moved and Paddle cannot
unmove it from the webhook. Honouring the offer for them means a refund, which
is a support decision. Flagged to Mal, not yet decided.

**Not yet done:** the SQL has not been executed against
`tgapmpbcqqnpsldehuqa`, so the deployed `trial_length()` is still whatever was
last run there. The repo file is the intention, not the state.

---

## 2026-09-20 — chat session — the launch dates, settled

**October 2026 is Launch Month.** Not 19 September. The conference on
19 September was tester recruitment and research, and Mal attended it as a
private individual, not an exhibitor.

`app/foundation.html` is the clearest statement of the dates and should be
treated as the product-facing source of truth. It draws October with a pie for
its O, emptying clockwise across the month, and captions it "October is launch
month". Launch month runs 1 Oct to 1 Nov — 743 hours, because Adelaide moves
from +09:30 to +10:30 at 02:00 on 4 October.

The three dates, which are consistent and deliberate:

- **1 October** — launch month opens.
- **19 October 2026, 00:00 +10:30** — accounts created before this get a
  30-day trial; after it, the standard 14. Lives in `public.trial_length()`
  in `supabase/schema-access-codes.sql`.
- **1 November 2026 (Adelaide)** — Foundation closes, or sooner if all 100
  places go.

First charge is **60 days** from signup for the launch cohort and **30 days**
otherwise (`FREE_DAYS_LAUNCH` / `FREE_DAYS_FROM_SIGNUP` in
`supabase/functions/paddle-webhook/index.ts`), keyed on the account's creation
date, not the purchase date. `LAUNCH_WINDOW_END` there must match the
timestamp in `trial_length()` exactly. The file says so itself. If one moves,
move both.

Foundation is the **price lock** — A$2.90/month or A$19/year, 100 places,
public. It is a separate mechanism from trial length. Do not conflate them,
and never describe it by contrast with paying nothing.

**Corrections to what an earlier version of this entry said:**

- It claimed the 30-day window was "anchored to the conference date" and was
  burning down against a launch that had not happened. Wrong. The window ends
  19 October because launch month is October, and the gap between 19 October
  and Foundation's 1 November close is deliberate — `app/foundation.html`
  states it to the customer in plain terms.
- It claimed `FREE_DAYS_FROM_SIGNUP` was a flat 30 days for everyone. Wrong,
  as above.
- The scheduled reminder that fired on 19 September called it launch day and
  told Mal to open the trial window mid-conference. That was the original
  error and everything above followed from correcting it.

**Still open:** the comment inside `trial_length()` at
`supabase/schema-access-codes.sql:41` still says Pie Timers "goes public on
19 Sep 2026, at the ADHD conference in Adelaide". The dates in the code are
right; only that comment is stale, and it is the sentence most likely to make
the next session repeat the mistake. Not changed yet — Mal to confirm wording.

**Also note:** editing the files under `supabase/` changes nothing on its own.
`trial_length()` only changes when the SQL is executed in the Supabase SQL
editor for project `tgapmpbcqqnpsldehuqa`. Check what is actually deployed
with `select public.trial_length();` rather than trusting the file.

The scheduled task `pie-timers-close-trial-window` is armed for 19 Oct 2026
and will tell Mal to revert `trial_length()` to a plain 14 days. With the
dates confirmed as above, that reminder is correct as it stands.

Pie Timers is in **Google Play closed testing** and has not publicly
launched. Foundation places only open once it is live on Play.
