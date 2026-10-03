-- 0033_fk_setnull.sql — composite FK delete rules v2 (replaces 0019's RESTRICT).
-- SET NULL on a composite key used to null tenant_id too; plain RESTRICT then
-- blocked every legitimate hard delete. Rules now (review item 6):
--   insert-only child tables -> NO ACTION (the trigger blocks writes anyway);
--   nullable FK column       -> ON DELETE SET NULL (named column only);
--   not-null FK column       -> RESTRICT stays (association is mandatory).
-- SET NULL (column) needs Postgres 15+; guarded below (we run 18).
-- The four line-modifier/tax join tables get a surrogate id PK (their pair
-- PK made the modifier/tax column non-nullable, and duplicates on one line
-- are now allowed). Also hardens seed_demo_catalog's search_path.
-- Rewrites constraints in place (same names); 0019 untouched.
-- Never edit after merge.

do $$
declare
  vnum int;
begin
  select current_setting('server_version_num')::int into vnum;
  if vnum < 150000 then raise exception 'needs-postgres-15 (set-null-column)'; end if;
end $$;

do $$
declare
  r record;
  action text;
begin
  for r in
    select n.nspname as sch, cl.relname as tbl, c.conname, fr.relname as ftable,
      (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
       from unnest((select c2.conkey from pg_constraint c2 where c2.oid = c.oid)) with ordinality as u(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) as cols,
      (select string_agg(quote_ident(a.attname), ', ' order by u.ord)
       from unnest((select c2.confkey from pg_constraint c2 where c2.oid = c.oid)) with ordinality as u(attnum, ord)
       join pg_attribute a on a.attrelid = c.confrelid and a.attnum = u.attnum) as fcols,
      (select string_agg(quote_ident(a.attname), ', ')
       from unnest((select c2.conkey from pg_constraint c2 where c2.oid = c.oid)) with ordinality as u(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
       where a.attname <> 'tenant_id') as nondep,
      (select bool_and(not a.attnotnull)
       from unnest((select c2.conkey from pg_constraint c2 where c2.oid = c.oid)) with ordinality as u(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum
       where a.attname <> 'tenant_id') as kids_nullable,
      cl.relname in ('receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
        'receipt_payments','receipt_discounts','sync_ops_applied') as is_insert_only
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_class fr on fr.oid = c.confrelid
    where c.contype = 'f' and n.nspname = 'public'
      and array_length(c.conkey, 1) > 1
  loop
    if r.is_insert_only then
      action := 'no action';
    elsif r.kids_nullable then
      action := 'set null';
    else
      action := 'restrict';
    end if;
    raise notice 'fk %.%: % -> % (%)', r.sch, r.tbl, r.conname, r.ftable, action;
    execute format('alter table %I.%I drop constraint %I', r.sch, r.tbl, r.conname);
    if action = 'set null' then
      -- named-column form: only the non-tenant column nulls (PG15+)
      execute format(
        'alter table %I.%I add constraint %I foreign key (%s) references %I.%I (%s) on delete set null (%s)',
        r.sch, r.tbl, r.conname, r.cols, r.sch, r.ftable, r.fcols, r.nondep);
    else
      execute format('alter table %I.%I add constraint %I foreign key (%s) references %I.%I (%s) on delete %s',
        r.sch, r.tbl, r.conname, r.cols, r.sch, r.ftable, r.fcols, action);
    end if;
  end loop;
end $$;

-- The four line-modifier/tax join tables: the pair PK made the modifier/tax
-- column non-nullable and forbade repeats. Surrogate id PK instead; the pair
-- stays unconstrained so the same modifier can appear twice on one line.
do $$
declare t text; pk text; col text;
begin
  foreach t in array array['ticket_line_modifiers','ticket_line_taxes','receipt_line_modifiers','receipt_line_taxes'] loop
    col := case when t like '%modifiers' then 'modifier_id' else 'tax_id' end;
    select c.conname into pk from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where c.contype = 'p' and n.nspname = 'public' and cl.relname = t;
    execute format('alter table public.%I drop constraint %I', t, pk);
    execute format('alter table public.%I alter column %I drop not null', t, col);
    execute format('alter table public.%I add column id uuid default gen_random_uuid() primary key', t);
  end loop;
end $$;

-- Seeder runs definer-owned; lock its resolution path too.
alter function seed_demo_catalog(uuid) set search_path = public, pg_temp;
