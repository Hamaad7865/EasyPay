-- rls_coverage.sql — fails if any tenant table lacks RLS/force/policy, or a
-- table the tills pull lacks its touch trigger.
-- Infra tables (no tenant_id by design) excluded: schema_migrations, sync_epoch.
-- The touch trigger (touch_row) moves a row's server_seq so the pull sends it
-- again; it is asked of every table that has a server_seq. A table without
-- one is not pulled on its own and could not take the trigger (touch_row sets
-- server_seq): a deposit's lines and payments travel inside the deposit's row
-- (0113), an account payment and its lines stay on the server (0114). Every
-- table, those included, still needs RLS forced and its policy.
-- Run: psql/pg client, expect zero rows. Any row = FAIL.

select t.tablename as table_name,
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.tablename) as rls_enabled,
  (select relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.tablename) as rls_forced,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename) as policy_count,
  (select count(*) from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not tr.tgisinternal and n.nspname = 'public' and c.relname = t.tablename
      and tr.tgname = 'trg_touch') as touch_count
from pg_tables t
where t.schemaname = 'public'
  and t.tablename not in ('schema_migrations', 'sync_epoch')
  and (
    (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t.tablename) is distinct from true
    or (select relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t.tablename) is distinct from true
    or (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename) < 1
    or (exists (select 1 from information_schema.columns col
                 where col.table_schema = 'public' and col.table_name = t.tablename and col.column_name = 'server_seq')
        and (select count(*) from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where not tr.tgisinternal and n.nspname = 'public' and c.relname = t.tablename
            and tr.tgname = 'trg_touch') < 1)
  );
