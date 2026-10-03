-- 0031_pull_pages.sql — sync_pull paging + snapshot + scope fixes (item 5).
-- Paging: next_cursor is now the MINIMUM of per-table maximums (was the
-- global max), so a table truncated at the limit is never skipped when
-- another table holds newer rows. Clients page until has_more is false;
-- duplicate rows across rounds are idempotent upserts.
-- Snapshot: the tenant advisory lock is taken in SHARED mode up front;
-- touch_row takes it exclusively, so concurrent writes wait for the pull
-- instead of interleaving between its table reads. touch_row itself is
-- unchanged (exclusive keeps the 5.3 commit-order guarantee).
-- Every dynamic query carries an explicit tenant_id predicate (RLS stays).
-- employees uses an explicit column list that KEEPS pin_hash: offline PIN
-- login verifies locally against the synced hash (owner decision); devices
-- are trusted merchant hardware and rows are tenant-scoped.
-- Tickets and their child rows are scoped to the requested store (they were
-- tenant-wide). Epochs + 30-day receipts scope unchanged.
-- Replaces the 0022 definition; 0022 untouched. Never edit after merge.

create or replace function sync_pull(p_store_id uuid, p_cursor bigint, p_lim int)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  tbl text;
  cols text;
  r jsonb; m bigint; c int;
  lim int := greatest(least(coalesce(p_lim, 200), 1000), 1);
  cur bigint := coalesce(p_cursor, 0);
  low bigint := null;
  more boolean := false;
  changes jsonb := '{}'::jsonb;
begin
  if current_tenant_id() is null then
    raise exception 'app.tenant_id must be set';
  end if;
  if not exists (select 1 from stores where id = p_store_id) then
    raise exception 'unknown store';
  end if;
  -- one point in the sequence: writers holding touch_row's exclusive lock
  -- finish first, and new writers wait until this txn commits
  perform pg_advisory_xact_lock_shared(hashtextextended(current_tenant_id()::text, 0));

  foreach tbl in array array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices']
  loop
    cols := case tbl when 'employees' then
        'id, tenant_id, name, pin_hash, role_id, auth_user_id, is_active, ' ||
        'created_at, updated_at, deleted_at, server_seq'
      else '*' end;
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from ' ||
      '(select %s from %I where server_seq > %L and tenant_id = current_tenant_id() ' ||
      'order by server_seq limit %s) t',
      cur, cols, tbl, cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 and (low is null or m < low) then low := m; end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tickets + children: this store only
  foreach tbl in array array[
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() ' ||
      'order by x.server_seq limit %s) t',
      cur, tbl,
      case tbl
        when 'tickets' then
          format('join stores s on s.tenant_id = x.tenant_id and s.id = x.store_id and s.id = %L', p_store_id)
        when 'ticket_lines' then
          format('join tickets t on t.tenant_id = x.tenant_id and t.id = x.ticket_id and t.store_id = %L', p_store_id)
        else
          format('join ticket_lines tl on tl.tenant_id = x.tenant_id and tl.id = x.line_id ' ||
            'join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id and t.store_id = %L', p_store_id)
      end,
      cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 and (low is null or m < low) then low := m; end if;
    if c >= lim then more := true; end if;
  end loop;

  -- receipts: this store, last 30 days
  foreach tbl in array array[
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and r.store_id = %L ' ||
      'and r.created_at > now() - interval ''30 days'' order by x.server_seq limit %s) t',
      cur, tbl,
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
      cur, p_store_id, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 and (low is null or m < low) then low := m; end if;
    if c >= lim then more := true; end if;
  end loop;

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $fn$;
