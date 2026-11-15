-- Birikim: fetches the prices every ten minutes (the fetch-prices Edge Function).
--
-- Needs two secrets in the Vault, put there once by hand (never in this file):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<the same value as the function secret CRON_SECRET>', 'cron_secret');
-- See supabase/README.md. Until they exist the job runs and does nothing.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'fetch-prices') then perform cron.unschedule('fetch-prices'); end if;
end $$;

select cron.schedule('fetch-prices', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/fetch-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
    and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret');
$job$);
