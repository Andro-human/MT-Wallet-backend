-- Layer 1 dedup: one transaction per bank reference per user PER DIRECTION.
--
-- direction is part of the key because some banks reuse the same UPI Ref for
-- the original debit and its reversal (credit); both are legitimate rows.
--
-- Existing rows may already duplicate (user_id, reference_id, direction)
-- (e.g. same txn ingested via SMS and email before cross-channel dedup).
-- Clean those up, then add the index.

-- Prefer keeping phone ingest over email; tie-break on earliest transacted_at.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, reference_id, direction
      order by
        case source
          when 'ios_shortcut' then 1
          when 'sms' then 2
          when 'email' then 3
          when 'axio' then 4
          when 'manual' then 5
          else 6
        end,
        transacted_at asc nulls last,
        created_at asc nulls last
    ) as rn
  from public.transactions
  where reference_id is not null
),
to_delete as (
  select id from ranked where rn > 1
)
delete from public.duplicate_links
where primary_transaction_id in (select id from to_delete)
   or duplicate_transaction_id in (select id from to_delete);

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, reference_id, direction
      order by
        case source
          when 'ios_shortcut' then 1
          when 'sms' then 2
          when 'email' then 3
          when 'axio' then 4
          when 'manual' then 5
          else 6
        end,
        transacted_at asc nulls last,
        created_at asc nulls last
    ) as rn
  from public.transactions
  where reference_id is not null
)
delete from public.transactions
where id in (select id from ranked where rn > 1);

create unique index if not exists transactions_user_reference_id_unique
  on public.transactions (user_id, reference_id, direction)
  where reference_id is not null;
