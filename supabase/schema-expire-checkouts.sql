-- ============================================================
-- Schedule expire-checkouts: every 10 minutes, cancel prepared
-- purchases that create-checkout made and nobody paid for within
-- about an hour (the owner's decision, 25 Nov 2026).
--
-- Run AFTER cron.sql has been run for this project, and after
--   supabase functions deploy expire-checkouts --no-verify-jwt
-- One paste, nothing to edit, safe to run again.
--
-- Nobody types the cron secret here. The new job is a copy of the
-- job cron.sql made for notify-milestones (countdown-milestones),
-- with the function's name swapped. So the project address, the
-- publishable key and the secret are carried over inside the
-- database. If that job is missing, or is not the shape cron.sql
-- gives, this file stops with a message and changes nothing.
--
-- This file never prints a job's command, because the command holds
-- the secret. Do not add "select command from cron.job" to it, and
-- never run "select *" on cron.job or on cron.job_run_details: both
-- tables have a command column.
--
-- If CRON_SECRET is ever changed and cron.sql is run again, run this
-- file again afterwards so this job carries the new value too.
--
-- Written against cron.sql as it stands in this repo. Never run
-- before the owner's first paste.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
declare
  source_job     constant text := 'countdown-milestones';
  new_job        constant text := 'countdown-expire-checkouts';
  old_path       constant text := '/functions/v1/notify-milestones';
  new_path       constant text := '/functions/v1/expire-checkouts';
  found_count    integer;
  source_command text;
  new_command    text;
begin
  select count(*), min(command)
    into found_count, source_command
    from cron.job
   where jobname = source_job;

  if found_count <> 1 or source_command is null then
    raise exception 'Nothing was changed. Expected exactly one job named countdown-milestones and found a different number. Run cron.sql first.';
  end if;

  if position('net.http_post' in source_command) = 0
     or position('x-cron-secret' in source_command) = 0
     or (length(source_command) - length(replace(source_command, old_path, ''))) / length(old_path) <> 1
     or (length(source_command) - length(replace(source_command, 'notify-milestones', ''))) / length('notify-milestones') <> 1
     or source_command !~ '''https://[a-z0-9]+\.supabase\.co/functions/v1/notify-milestones'''
     or source_command !~ '''x-cron-secret'',\s*''[^'']+'''
     or position('expire-checkouts' in source_command) > 0 then
    raise exception 'Nothing was changed. The countdown-milestones job is not the shape cron.sql gives, so a copy of that job cannot be trusted.';
  end if;

  if position('<CRON_SECRET>' in source_command) > 0
     or position('<PROJECT_REF>' in source_command) > 0
     or position('<ANON_KEY>' in source_command) > 0 then
    raise exception 'Nothing was changed. The countdown-milestones job still holds a placeholder from cron.sql.';
  end if;

  -- expire-checkouts plans each run to end inside the 25 seconds the
  -- milestones job waits for an answer. A copy that waits any other
  -- time is refused, so a run is never cut off part of the way through.
  if source_command !~ 'timeout_milliseconds\s*:=\s*25000[^0-9]' then
    raise exception 'Nothing was changed. The countdown-milestones job does not wait 25 seconds for an answer, as cron.sql sets, and expire-checkouts counts on that.';
  end if;

  new_command := replace(source_command, old_path, new_path);

  if position('notify-milestones' in new_command) > 0
     or (length(new_command) - length(replace(new_command, new_path, ''))) / length(new_path) <> 1
     or length(new_command) <> length(source_command) + length(new_path) - length(old_path) then
    raise exception 'Nothing was changed. The copied command did not come out as expected.';
  end if;

  if exists (select 1 from cron.job where jobname = new_job) then
    perform cron.unschedule(new_job);
  end if;

  perform cron.schedule(new_job, '3,13,23,33,43,53 * * * *', new_command);
end
$do$;

-- The check. Expect exactly one row:
--   countdown-expire-checkouts | 3,13,23,33,43,53 * * * * | true | true | true | true
select j.jobname,
       j.schedule,
       j.active,
       (position('/functions/v1/expire-checkouts' in j.command) > 0
         and position('notify-milestones' in j.command) = 0)          as calls_expire_checkouts,
       position('x-cron-secret' in j.command) > 0                      as carries_the_secret_header,
       (select count(*) = 1 from cron.job m
         where m.jobname = 'countdown-milestones'
           and position('/functions/v1/notify-milestones' in m.command) > 0) as milestones_job_untouched
  from cron.job j
 where j.jobname = 'countdown-expire-checkouts';
