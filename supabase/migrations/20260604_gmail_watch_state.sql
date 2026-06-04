-- Gmail Push (Pub/Sub) ingestion state, single-user mode.
--
-- gmail_last_history_id   - cursor for users.history.list() incremental fetches.
--                           Updated after each successful Pub/Sub-driven ingest.
-- gmail_watch_expires_at  - when the current users.watch() lease expires
--                           (max 7 days from issue). The renewal cron uses this
--                           to decide when to call watch() again.
--
-- Both nullable so existing rows render as "Gmail not configured".

alter table public.profiles
  add column if not exists gmail_last_history_id text,
  add column if not exists gmail_watch_expires_at timestamptz;
