-- Allow source = 'email' on transactions and sync_runs.
--
-- Existing check constraints didn't include 'email'; the Gmail Pub/Sub
-- ingestion path needed it. Kept every previous value so old rows and
-- in-flight writes (ios_shortcut, etc.) keep working.

alter table public.transactions drop constraint transactions_source_check;
alter table public.transactions add constraint transactions_source_check
  check (source = any (array['sms'::text, 'ios_shortcut'::text, 'manual'::text, 'axio'::text, 'email'::text]));

alter table public.sync_runs drop constraint sync_runs_source_check;
alter table public.sync_runs add constraint sync_runs_source_check
  check (source = any (array['sms_sync'::text, 'ios_shortcut'::text, 'manual'::text, 'axio'::text, 'email'::text]));
