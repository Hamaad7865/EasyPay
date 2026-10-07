-- 0065_insert_only_grants.sql — a second lock on the insert-only tables.
-- Source: 0003 granted app_user update and delete on every table in public,
-- the insert-only ones included. What stopped a change to a receipt was the
-- trigger (block_update) and RLS alone: a trigger dropped or disabled by
-- mistake would have opened them.
--
-- What changes:
--   - app_user loses update and delete on the seven insert-only tables. It
--     keeps select and insert, which is all it ever used there: no function
--     that runs as app_user, nor the API, nor the back office, updates,
--     deletes or locks rows of these tables (the live definitions were read
--     for it). A direct attempt is now "permission denied" before the trigger
--     is reached.
--   - purge_transactions is untouched: it runs as its owner (security
--     definer), and block_update still lets through only what it names.
--   - 0003's default privileges still give every NEW table all four rights:
--     a new insert-only table needs its own revoke beside its trigger.
-- Never edit after merge.

revoke update, delete on
  receipts, receipt_lines, receipt_line_modifiers, receipt_line_taxes,
  receipt_payments, receipt_discounts, sync_ops_applied
from app_user;
