-- rls_coverage.sql — fails if any tenant table lacks RLS/force/policy/touch trigger.
-- Infra tables (no tenant_id by design) excluded: schema_migrations, sync_epoch.
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
    or (select count(*) from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not tr.tgisinternal and n.nspname = 'public' and c.relname = t.tablename
        and tr.tgname = 'trg_touch') < 1
  );
