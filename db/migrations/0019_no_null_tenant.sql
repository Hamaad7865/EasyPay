-- 0019_no_null_tenant.sql — composite FKs must never SET NULL tenant_id.
-- Found by db/tests cleanup: deleting a role nulled employees.tenant_id via
-- the composite FK (tenant_id, role_id) ON DELETE SET NULL, tripping
-- touch_row and breaking RLS. Same flaw on every composite SET NULL
-- (categories, items, lines, receipts...). Rule: composite FKs are RESTRICT;
-- removals are soft deletes (deleted_at). Re-adds every public composite
-- SET NULL constraint with the same name as RESTRICT. Never edit after merge.

do $$
declare
  r record;
  cols text; fcols text;
begin
  for r in
    select c.oid, n.nspname as sch, cl.relname as tbl, c.conname,
      fr.relname as ftable
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_class fr on fr.oid = c.confrelid
    where c.contype = 'f' and c.confdeltype = 'n' and n.nspname = 'public'
  loop
    select string_agg(quote_ident(a.attname), ', ' order by u.ord) into cols
      from unnest((select c2.conkey from pg_constraint c2 where c2.oid = r.oid)) with ordinality as u(attnum, ord)
      join pg_attribute a on a.attrelid = (select c3.conrelid from pg_constraint c3 where c3.oid = r.oid)
        and a.attnum = u.attnum;
    select string_agg(quote_ident(a.attname), ', ' order by u.ord) into fcols
      from unnest((select c2.confkey from pg_constraint c2 where c2.oid = r.oid)) with ordinality as u(attnum, ord)
      join pg_attribute a on a.attrelid = (select c3.confrelid from pg_constraint c3 where c3.oid = r.oid)
        and a.attnum = u.attnum;
    raise notice 'converting %.% (%) -> % (%)', r.sch, r.tbl, r.conname, r.ftable, fcols;
    execute format('alter table %I.%I drop constraint %I', r.sch, r.tbl, r.conname);
    execute format('alter table %I.%I add constraint %I foreign key (%s) references %I.%I (%s) on delete restrict',
      r.sch, r.tbl, r.conname, cols, r.sch, r.ftable, fcols);
  end loop;
end $$;
