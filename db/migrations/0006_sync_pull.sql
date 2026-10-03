-- 0006_sync_pull.sql — sync_pull(p_store_id, p_cursor, p_lim): catalog + org snapshot.
-- SECURITY INVOKER: caller must SET ROLE app_user + SET LOCAL app.tenant_id
-- (the API does this per request after JWT verify). Rows ordered by server_seq;
-- soft-deleted rows included so clients mirror deletes. Tickets/shifts/receipts
-- join in Phase 2/3/4. Limit is per table; next_cursor is the max seen.
-- Never edit after merge.

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
  -- store must belong to the caller's tenant (blocks cross-store fishing)
  if not exists (select 1 from stores where id = p_store_id) then
    raise exception 'unknown store';
  end if;
  foreach tbl in array array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items']
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
  return jsonb_build_object('changes', changes, 'next_cursor', max_seq, 'has_more', more);
end $fn$;
