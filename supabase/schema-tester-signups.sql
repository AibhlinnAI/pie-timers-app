-- ============================================================
-- Tester sign-ups
-- ------------------------------------------------------------
-- Collected from the "Become a tester" prompt shown to first-time
-- Android visitors (app/app.js: renderTesterInvite / app/index.html:
-- #testerInvite). This is the funnel behind the QR code printed on
-- physical t-shirts, pointing at the fixed pietimers.aibhlinn.ai root.
--
-- Write-only from the browser, on purpose: the anon key can insert a
-- row here and nothing else. There is no select policy for anon or
-- authenticated, so this table cannot be used to read back anyone
-- else's email -- reading it is a manual step in the Supabase
-- dashboard's Table Editor (Table Editor -> tester_signups), which is
-- also how new sign-ups get pasted into the Play Console tester email
-- list -- the Play Developer API's edits.testers resource does not
-- support individual email lists (only Google Groups), so that paste
-- is the actual mechanism, not a missing feature.
--
-- Idempotent: safe to re-run.
-- ============================================================

create table if not exists public.tester_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Always 'android' today -- the prompt only ever shows on Android,
  -- since Play closed testing is the only thing on offer. Kept as a
  -- column rather than assumed, in case a second platform's testing
  -- programme (TestFlight, say) ever reuses this same table.
  platform text not null default 'android',
  created_at timestamptz not null default now(),
  -- Set by hand once the address has actually been added to the Play
  -- Console tester list and sent the opt-in link -- lets a query
  -- answer "who's still waiting" without a second spreadsheet.
  actioned_at timestamptz
);

alter table public.tester_signups enable row level security;

drop policy if exists "anyone can register as a tester" on public.tester_signups;
create policy "anyone can register as a tester"
  on public.tester_signups for insert
  to anon
  with check (true);

-- No select, update or delete policy for anon or authenticated:
-- deliberately one-way. Only the service role -- the Supabase
-- dashboard, signed in as the project owner -- can read or edit it.
