-- 0013_sync_pull_transactions.sql — sync_pull adds tickets/receipts (Phase 2).
-- New file replacing the 0008 definition (create or replace); 0008 untouched.
-- Receipts scope: this store, last 30 days (spec 5.5) so refunds work from any
-- device without syncing the whole history. Never edit after merge.
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
  -- Receipts: this store, last 30 days (refunds from any device, bounded history).
  -- Receipts: this store, last 30 days (refunds from any device, bounded history).
  -- Join path differs per table; store + recency always come from receipts.
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
  return jsonb_build_object('changes', changes, 'next_cursor', max_seq, 'has_more', more);
end $fn$;
