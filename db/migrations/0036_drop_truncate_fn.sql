-- 0036_drop_truncate_fn.sql — sync_truncate leaves the migrations (review item 3).
-- A SECURITY DEFINER truncate-all is too dangerous as a deployed artifact
-- (PUBLIC could execute it). Epoch discipline for real truncates is an ops
-- runbook matter; tests carry their own copy (see truncate.test.cjs).
-- Never edit after merge.

drop function if exists sync_truncate(text[]);
