-- ============================================================
-- Schedule the milestone push job.
-- Run after deploying the notify-milestones edge function.
--
-- Replace the three placeholders below before running:
--   <PROJECT_REF>   your Supabase project ref (the subdomain)
--   <CRON_SECRET>   the same value set on the edge function
--   <SERVICE_KEY>   Project Settings → API → service_role key
--
-- Keep this file out of public source control once filled in.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous version of the job before re-creating it.
select cron.unschedule('countdown-milestones')
where exists (select 1 from cron.job where jobname = 'countdown-milestones');

select cron.schedule(
  'countdown-milestones',
  '* * * * *',                 -- every minute; milestones are minute-precise
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/notify-milestones',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer <SERVICE_KEY>',
      'x-cron-secret',  '<CRON_SECRET>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);

-- Refresh every connected calendar every 15 minutes.
-- Skip this block if you are not using calendar sync.
select cron.unschedule('countdown-calendar-sync')
where exists (select 1 from cron.job where jobname = 'countdown-calendar-sync');

select cron.schedule(
  'countdown-calendar-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/calendar-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_KEY>',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body    := '{"all": true}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Trim the delivery log nightly so it does not grow without bound.
select cron.unschedule('countdown-prune-log')
where exists (select 1 from cron.job where jobname = 'countdown-prune-log');

select cron.schedule(
  'countdown-prune-log',
  '17 3 * * *',
  $$ select public.prune_notification_log(); $$
);

-- Useful checks:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
