-- Track per-model AI token usage on every sync run so we can compare cost
-- before/after prompt or model changes.
--
-- Shape:
--   {
--     "<model_id>": { "input": <int>, "output": <int> },
--     ...
--   }
-- Example after a two-pass ingest:
--   {
--     "gemini-2.5-flash-lite": { "input": 2750, "output": 1500 },
--     "gemini-2.5-flash":      { "input": 750,  "output": 800 }
--   }
--
-- Nullable so pre-existing rows render as "no data" in the UI.

alter table public.sync_runs
  add column if not exists usage jsonb;
