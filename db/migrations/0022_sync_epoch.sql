-- 0022_sync_epoch.sql — per-table epochs for truncated history (replaces the
-- 0013 sync_pull definition; 0013 untouched).
-- A cursor can pass rows when history is rewritten (TRUNCATE + reseeded rows
-- with lower server_seq, dump restores). sync_truncate(text[]) is the ONLY
-- disciplined truncate path: single multi-table TRUNCATE (FK-safe among the
-- listed tables) + an epoch bump per table. Every sync_pull response carries
-- epochs; clients store the map and reset to cursor 0 on any mismatch, then
-- refetch. Raw TRUNCATE bypasses the bump (event triggers need superuser,
-- unavailable on Neon) — never truncate outside this function.
-- Never edit after merge.

create table if not exists sync_epoch (
  table_name text primary key,
  epoch bigint not null default 1
);

insert into sync_epoch (table_name)
  select unnest(array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes',
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts'])
  on conflict (table_name) do nothing;

create or replace function sync_truncate(p_tables text[]) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  allowed text[] := array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes',
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts'];
  t text;
  idents text := '';
begin
  if p_tables is null or array_length(p_tables, 1) is null then
    raise exception 'bad-payload';
  end if;
  foreach t in array p_tables loop
    if not (t = any (allowed)) then raise exception 'bad-table'; end if;
    idents := idents || quote_ident(t) || ', ';
  end loop;
  idents := left(idents, length(idents) - 2);
  execute 'truncate ' || idents;
  insert into sync_epoch (table_name, epoch)
    select unnest(p_tables), 2
    on conflict (table_name) do update set epoch = sync_epoch.epoch + 1;
end $fn$;

create or replace function sync_pull(p_store_id uuid, p_cursor bigint, p_lim int)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  tbl text;
  r jsonb; m bigint; c int;
  lim int := greatest(least(coalesce(p_lim, 200), 1000), 1);
  max_seq bigint := coalesce(p_cursor, 0);
  more boolean := false;
  changes jsonb := '{}'::jsonb;
begin
  if current_tenant_id() is null then
    raise exception 'app.tenant_id must be set';
  end if;
  if not exists (select 1 from stores where id = p_store_id) then
    raise exception 'unknown store';
  end if;
  foreach tbl in array array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from ' ||
      '(select * from %I where server_seq > %L order by server_seq limit %s) t',
      max_seq, tbl, coalesce(p_cursor, 0), lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if m is not null and m > max_seq then max_seq := m; end if;
    if c >= lim then more := true; end if;
  end loop;
  foreach tbl in array array[
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and r.store_id = %L ' ||
      'and r.created_at > now() - interval ''30 days'' order by x.server_seq limit %s) t',
      max_seq, tbl,
      case tbl
        when 'receipts' then
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.id'
        when 'receipt_line_modifiers' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        when 'receipt_line_taxes' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        else
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id'
      end,
      coalesce(p_cursor, 0), p_store_id, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if m is not null and m > max_seq then max_seq := m; end if;
    if c >= lim then more := true; end if;
  end loop;
  return jsonb_build_object(
    'changes', changes, 'next_cursor', max_seq, 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $fn$;
