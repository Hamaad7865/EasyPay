-- 0092: a shop's stock tools on its till.
--
-- The owner sells an offline edition whose tablet does the shop's stock work
-- itself (docs/superpowers/specs/2026-10-10-till-stock-tools-design.md). These
-- screens are built before the tablet can stand alone, so they land first on
-- tills that are linked to the server: each save is a change that waits for
-- its answer, as a product saved from a till does (0084, 0087), and each wraps
-- a rule the back office already uses.
--
--   supplier.save, supplier.remove   what the back office's Suppliers page does
--   po.save                          po_save, under the id the tablet made
--   po.send, po.cancel, po.close     po_send, po_cancel, po_close
--   delivery.receive                 delivery_receive
--   count.complete                   count_from_till: a count the tablet kept,
--                                    sent whole and completed at once
--
-- Sent twice, written once. The till gives every try a new change id, so the
-- "already applied" of sync_push does not cover a second tap after an answer
-- that was lost, nor one that arrives while the first is still being written.
-- So every function here that saves under an id the tablet made first takes a
-- lock on that id (as delivery_receive does) and then looks for its row; and a
-- change of state that finds the order already there answers done.
--
-- A count from a till is exactly the lines the tablet sends: the server does
-- not work the scope out again, so "set the uncounted to nothing" cannot zero
-- a product the person never saw. A line left out is not checked, and one
-- whose product is gone is not written: leaving a line out is the way past a
-- product removed while the shop was being counted.
--
-- Whose clock: a line's "when it was counted" is the tablet's. That is the
-- clock its sales are stamped with, and the wrong one for deliveries and
-- corrections, which the server stamps. stock_counts.clock_ahead_ms is how far
-- the tablet's clock was ahead of the server's; count_complete sets the moment
-- right for what the server stamped (stock_moved_since_at). A back office
-- count has 0 there and is completed exactly as before.
--
-- The pull: a shop's till (pos_settings.data.businessType = 'retail') is also
-- sent suppliers, this store's orders and deliveries (each row with its lines
-- inside it: po_save deletes a draft's lines outright, which a pull by
-- sequence would never tell a till), this store's counts, the lines of those
-- that are finished, and thirty days of movements. A restaurant's pull is as
-- it was. A till that does not know these tables reads past them.
--
-- po_fill_low now also touches the order's row, so that a till is sent the
-- draft again when the back office fills it.
--
-- Refusals a till may be answered with, new here: unknown-supplier,
-- unknown-store, unknown-order, not-draft, no-lines, already-received,
-- not-open, not-part, bad-delivery, nothing-received, unknown-line, bad-scope,
-- nothing-to-count, bad-uncounted, bad-quantity.
--
-- Source: sync_push, sync_pull, count_complete and po_fill_low are their live
-- definitions on dev on 2026-10-10 (pg_get_functiondef, as 0091, 0075 and 0074
-- left them) with the lines described above added. Everything else is new.
-- Never edit after merge.

alter table stock_counts add column if not exists clock_ahead_ms integer not null default 0;

-- What moved on one line of stock after a moment, when the moment was read off
-- a tablet: a sale or a refund is set against the tablet's own moment
-- (p_since), everything the server stamped against that moment by the
-- server's clock (p_since_server). With the two equal this is stock_moved_since.
create or replace function stock_moved_since_at(
  p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_since timestamptz, p_since_server timestamptz
) returns integer
language sql stable set search_path = public as $fn$
  select coalesce(sum(m.qty), 0)::integer
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
   where m.tenant_id = p_tenant and m.store_id = p_store and m.item_id = p_item
     and m.variant_id is not distinct from p_variant and m.deleted_at is null
     and (case when m.reason in ('sale', 'refund') and r.device_time is not null then r.device_time > p_since
               else m.created_at > p_since_server end)
$fn$;

-- ---- an order under the id the tablet made ----
-- No order of this client with that id: a new draft, as po_save makes one.
-- Otherwise po_save on it (which refuses what is no longer a draft).
create or replace function po_save_as(
  p_tenant uuid, p_emp uuid, p_id uuid, p_store uuid, p_supplier uuid, p_expected date, p_note text, p_lines jsonb
) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_number text;
  r record;
begin
  if p_id is null then raise exception 'bad-payload'; end if;
  -- two sends of one order wait their turn here, so the second sees the first
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  if exists (select 1 from purchase_orders where tenant_id = p_tenant and id = p_id and deleted_at is null) then
    return po_save(p_tenant, p_emp, p_id, p_store, p_supplier, p_expected, p_note, p_lines);
  end if;
  if not exists (select 1 from suppliers where tenant_id = p_tenant and id = p_supplier and deleted_at is null) then
    raise exception 'unknown-supplier';
  end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  v_number := next_doc_number(p_tenant, 'po');
  -- an id that is another client's order stops here on the primary key, and is answered 'conflict'
  insert into purchase_orders (id, tenant_id, store_id, number, supplier_id, expected_on, note, created_by)
    values (p_id, p_tenant, p_store, v_number, p_supplier, p_expected, nullif(btrim(coalesce(p_note, '')), ''), p_emp);
  for r in select * from doc_lines(coalesce(p_lines, '[]'::jsonb), false) loop
    perform stock_line_ok(p_tenant, r.item_id, r.variant_id);
    insert into purchase_order_lines (tenant_id, order_id, item_id, variant_id, qty, unit_cost)
      values (p_tenant, p_id, r.item_id, r.variant_id, r.qty, r.unit_cost);
  end loop;
  return jsonb_build_object('id', p_id, 'number', v_number);
end $fn$;

-- ---- a count the tablet kept, sent whole ----
-- p: {id, store_id, scope_kind, scope_id, scope_text, clock_ahead_ms, uncounted,
--     lines: [{item_id, variant_id, counted, counted_at, left_out}]}
-- The same count sent again is answered with what was written.
create or replace function count_from_till(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_id uuid; v_store uuid; v_scope uuid; v_ahead integer;
  v_kind text; v_text text; v_uncounted text; v_title text; v_number text;
  v_item uuid; v_variant uuid; v_out boolean; v_counted integer; v_at timestamptz;
  v_n integer := 0;
  v_done jsonb;
  k record;
  l jsonb;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_scope := nullif(p->>'scope_id', '')::uuid;
    v_ahead := coalesce((p->>'clock_ahead_ms')::integer, 0);
  exception when others then
    raise exception 'bad-payload';
  end;
  -- a clock more than a day out is not a clock to set anything right by
  if v_id is null or v_store is null or abs(v_ahead) > 86400000 then raise exception 'bad-payload'; end if;
  -- two sends of one count wait their turn here, so the second sees the first
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select number, status into k from stock_counts where tenant_id = p_tenant and id = v_id;
  if found then
    return jsonb_build_object('id', v_id, 'number', k.number, 'status', k.status, 'already', true);
  end if;

  v_kind := p->>'scope_kind';
  if v_kind is null or v_kind not in ('all', 'category', 'supplier', 'brand') then raise exception 'bad-scope'; end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = v_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  v_uncounted := p->>'uncounted';
  if v_uncounted is null or v_uncounted not in ('leave', 'zero') then raise exception 'bad-uncounted'; end if;
  v_text := nullif(left(btrim(coalesce(p->>'scope_text', '')), 120), '');
  v_title := case v_kind
    when 'all' then 'The whole shop'
    when 'category' then (select name from categories where tenant_id = p_tenant and id = v_scope)
    when 'supplier' then (select name from suppliers where tenant_id = p_tenant and id = v_scope)
    else v_text
  end;
  if v_title is null then raise exception 'bad-scope'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'nothing-to-count';
  end if;

  v_number := next_doc_number(p_tenant, 'count');
  -- an id that is another client's count stops here on the primary key, and is answered 'conflict'
  insert into stock_counts (id, tenant_id, store_id, number, scope_kind, scope_id, scope_text, title, started_by, clock_ahead_ms)
    values (v_id, p_tenant, v_store, v_number, v_kind, case when v_kind in ('category', 'supplier') then v_scope end,
      case when v_kind = 'brand' then v_title end, v_title, p_emp, v_ahead);
  -- exactly the lines given: the scope is not worked out again here
  for l in select x from jsonb_array_elements(p->'lines') x loop
    begin
      v_item := (l->>'item_id')::uuid;
      v_variant := nullif(l->>'variant_id', '')::uuid;
      v_out := coalesce((l->>'left_out')::boolean, false);
      v_counted := (l->>'counted')::integer;
      v_at := (l->>'counted_at')::timestamptz;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_item is null then raise exception 'bad-payload'; end if;
    if v_counted is not null and (v_counted < 0 or v_at is null) then raise exception 'bad-quantity'; end if;
    if v_out then
      -- left out: not checked, and a product or a variant that is gone is not written at all
      if not exists (select 1 from items where tenant_id = p_tenant and id = v_item and deleted_at is null)
         or (v_variant is not null and not exists (select 1 from item_variants
               where tenant_id = p_tenant and item_id = v_item and id = v_variant and deleted_at is null)) then
        continue;
      end if;
    else
      perform stock_line_ok(p_tenant, v_item, v_variant);
    end if;
    insert into stock_count_lines (tenant_id, count_id, item_id, variant_id, counted, counted_at, counted_by, left_out)
      values (p_tenant, v_id, v_item, v_variant, v_counted, case when v_counted is null then null else v_at end,
        case when v_counted is null then null else p_emp end, v_out)
      on conflict (count_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      do update set counted = excluded.counted, counted_at = excluded.counted_at, counted_by = excluded.counted_by, left_out = excluded.left_out;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'nothing-to-count'; end if;
  v_done := count_complete(p_tenant, p_emp, v_id, v_uncounted);
  return v_done || jsonb_build_object('id', v_id, 'number', v_number, 'already', false);
end $fn$;

-- ---- what a till asks ----
-- Each reads its payload, asks whether the person or whoever gave their word
-- may (0054's may), and hands on to the rule.

create or replace function push_supplier_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_name text; v_con text;
  v_contact text := nullif(left(btrim(coalesce(p->>'contact', '')), 120), '');
  v_phone text := nullif(left(btrim(coalesce(p->>'phone', '')), 40), '');
  v_email text := nullif(left(btrim(coalesce(p->>'email', '')), 120), '');
  v_address text := nullif(left(btrim(coalesce(p->>'address', '')), 200), '');
  v_note text := nullif(left(btrim(coalesce(p->>'note', '')), 200), '');
begin
  begin
    v_id := (p->>'id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 120);
  if v_name = '' then raise exception 'name-required'; end if;
  if not may(p_emp, p, 'suppliers.edit') then raise exception 'forbidden'; end if;
  -- two sends of one supplier wait their turn here, so the second sees the first
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  begin
    update suppliers set name = v_name, contact = v_contact, phone = v_phone, email = v_email, address = v_address, note = v_note
     where tenant_id = p_tenant and id = v_id and deleted_at is null;
    if found then return jsonb_build_object('supplier_id', v_id, 'created', false); end if;
    -- one that was removed is not brought back by a save that arrives late
    if exists (select 1 from suppliers where tenant_id = p_tenant and id = v_id) then raise exception 'unknown-supplier'; end if;
    -- an id that is another client's supplier stops here on the primary key, and is answered 'conflict'
    insert into suppliers (id, tenant_id, name, contact, phone, email, address, note)
      values (v_id, p_tenant, v_name, v_contact, v_phone, v_email, v_address, v_note);
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'uq_suppliers_name' then raise exception 'name-taken'; end if;
    raise;
  end;
  return jsonb_build_object('supplier_id', v_id, 'created', true);
end $fn$;

-- Marked removed, as the back office does: it stays on its old orders.
create or replace function push_supplier_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid;
begin
  begin
    v_id := (p->>'id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'suppliers.edit') then raise exception 'forbidden'; end if;
  update suppliers set deleted_at = now() where tenant_id = p_tenant and id = v_id and deleted_at is null;
  return jsonb_build_object('supplier_id', v_id);
end $fn$;

create or replace function push_po_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_supplier uuid; v_expected date;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_supplier := (p->>'supplier_id')::uuid;
    v_expected := nullif(p->>'expected_on', '')::date;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or v_store is null or v_supplier is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'stock.receive') then raise exception 'forbidden'; end if;
  return po_save_as(p_tenant, p_emp, v_id, v_store, v_supplier, v_expected, p->>'note', coalesce(p->'lines', '[]'::jsonb));
end $fn$;

-- p_what: send, cancel or close. An order already in the state asked for
-- answers done: the till asked once, and the answer was lost on the way.
create or replace function push_po_state(p_tenant uuid, p_emp uuid, p jsonb, p_what text)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_status text; v_done boolean;
begin
  begin
    v_id := (p->>'id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'stock.receive') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select status into v_status from purchase_orders where tenant_id = p_tenant and id = v_id and deleted_at is null;
  if not found then raise exception 'unknown-order'; end if;
  v_done := case p_what
    when 'send' then v_status in ('sent', 'part', 'received')
    when 'cancel' then v_status = 'cancelled'
    when 'close' then v_status = 'closed'
    else null end;
  if v_done is null then raise exception 'bad-payload'; end if;
  if not v_done then
    if p_what = 'send' then perform po_send(p_tenant, v_id);
    elsif p_what = 'cancel' then perform po_cancel(p_tenant, v_id);
    else perform po_close(p_tenant, v_id);
    end if;
    select status into v_status from purchase_orders where tenant_id = p_tenant and id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'status', v_status, 'already', v_done);
end $fn$;

create or replace function push_delivery_receive(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_order uuid; v_supplier uuid; v_arrived date;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_order := nullif(p->>'order_id', '')::uuid;
    v_supplier := nullif(p->>'supplier_id', '')::uuid;
    v_arrived := nullif(p->>'arrived_on', '')::date;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or v_store is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'stock.receive') then raise exception 'forbidden'; end if;
  return delivery_receive(p_tenant, p_emp, v_id, v_store, v_order, v_supplier, v_arrived,
    p->>'invoice_no', p->>'note', coalesce(p->'lines', '[]'::jsonb));
end $fn$;

create or replace function push_count_complete(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
begin
  if not may(p_emp, p, 'stock.count') then raise exception 'forbidden'; end if;
  return count_from_till(p_tenant, p_emp, p);
end $fn$;

-- ---- as they were on dev, with the lines this migration adds ----

CREATE OR REPLACE FUNCTION public.count_complete(p_tenant uuid, p_emp uuid, p_count uuid, p_uncounted text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_status text; v_store uuid; v_ahead integer;
  v_level stock_levels%rowtype;
  v_counted integer; v_moved integer; v_delta integer;
  v_lines integer := 0; v_units integer := 0; v_value numeric := 0;
  r record;
begin
  if p_uncounted is null or p_uncounted not in ('leave', 'zero') then raise exception 'bad-uncounted'; end if;
  select status, store_id, clock_ahead_ms into v_status, v_store, v_ahead from stock_counts
   where tenant_id = p_tenant and id = p_count and deleted_at is null for update;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  -- always in the same order (by product), so two counts of the same goods wait on each other the same way round
  for r in
    select id, item_id, variant_id, counted, counted_at from stock_count_lines
     where tenant_id = p_tenant and count_id = p_count and not left_out
     order by item_id, variant_id nulls first
  loop
    -- the line of stock is locked from here: what it holds cannot change under the sum
    v_level := stock_level_for(p_tenant, v_store, r.item_id, r.variant_id);
    if r.counted is null and p_uncounted = 'leave' then
      update stock_count_lines set expected = v_level.qty, unit_cost = v_level.avg_cost where id = r.id;
      continue;
    end if;
    if r.counted is null then
      v_counted := 0; v_moved := 0;
    else
      v_counted := r.counted;
      -- a tablet's moment for its sales, the same moment by the server's clock for the rest (0092)
      v_moved := stock_moved_since_at(p_tenant, v_store, r.item_id, r.variant_id, r.counted_at,
        r.counted_at - make_interval(secs => v_ahead / 1000.0));
    end if;
    v_delta := v_counted + v_moved - v_level.qty;
    update stock_count_lines
       set counted = v_counted, counted_at = coalesce(counted_at, clock_timestamp()),
           expected = v_level.qty - v_moved, diff = v_delta, unit_cost = v_level.avg_cost
     where id = r.id;
    if v_delta <> 0 then
      perform stock_move(p_tenant, v_store, r.item_id, r.variant_id, v_delta, 'count', null, 'count', p_count, p_emp, null);
      v_lines := v_lines + 1;
      v_units := v_units + v_delta;
      v_value := v_value + v_delta * v_level.avg_cost / 1000;
    end if;
  end loop;
  update stock_counts set status = 'completed', uncounted = p_uncounted, completed_by = p_emp, completed_at = now()
   where tenant_id = p_tenant and id = p_count;
  return jsonb_build_object('lines', v_lines, 'units', v_units, 'value', round(v_value, 2));
end $function$
;

CREATE OR REPLACE FUNCTION public.po_fill_low(p_tenant uuid, p_order uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_status text; v_store uuid; v_supplier uuid; v_n integer;
begin
  select status, store_id, supplier_id into v_status, v_store, v_supplier from purchase_orders
   where tenant_id = p_tenant and id = p_order and deleted_at is null for update;
  if not found then raise exception 'unknown-order'; end if;
  if v_status <> 'draft' then raise exception 'not-draft'; end if;
  insert into purchase_order_lines (tenant_id, order_id, item_id, variant_id, qty, unit_cost)
    select p_tenant, p_order, s.item_id, s.variant_id,
           coalesce(nullif(s.reorder_qty, 0), greatest(s.reorder_point - s.qty, 1000)),
           greatest(round(s.avg_cost), 0)::bigint
      from stock_on_hand(p_tenant, v_store) s
     where s.supplier_id = v_supplier and s.reorder_point is not null and s.qty <= s.reorder_point
       and not exists (select 1 from purchase_order_lines l
                        where l.tenant_id = p_tenant and l.order_id = p_order and l.item_id = s.item_id
                          and l.variant_id is not distinct from s.variant_id);
  get diagnostics v_n = row_count;
  -- its lines changed: the order's row is stamped again, so a till is sent the draft with them (0092)
  if v_n > 0 then update purchase_orders set updated_at = now() where tenant_id = p_tenant and id = p_order; end if;
  return v_n;
end $function$
;

CREATE OR REPLACE FUNCTION public.sync_pull(p_store_id uuid, p_cursor bigint, p_lim integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  tbl text;
  cols text;
  r jsonb; m bigint; c int;
  lim int := greatest(least(coalesce(p_lim, 200), 1000), 1);
  cur bigint := coalesce(p_cursor, 0);
  low_cut bigint := null;
  high bigint := null;
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
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'printers','pos_settings','customers']
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
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tickets + children: this store only; open ones, and ones that changed in
  -- the last 30 days (a ticket changes when it closes, so the close arrives)
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
          format('join stores s on s.tenant_id = x.tenant_id and s.id = x.store_id and s.id = %L ' ||
            'and (x.status = ''open'' or x.updated_at > now() - interval ''30 days'')', p_store_id)
        when 'ticket_lines' then
          format('join tickets t on t.tenant_id = x.tenant_id and t.id = x.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
        else
          format('join ticket_lines tl on tl.tenant_id = x.tenant_id and tl.id = x.line_id ' ||
            'join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
      end,
      cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
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
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tables, sales periods and clock punches: this store. A till needs the
  -- open period and who is clocked in, not the history, so a week is enough.
  -- and what the shop holds of each product (0077): a till that does not know
  -- the table reads past it. And what the back office asked of the store's
  -- tills (0091): each till acts on its own, and one too old to reads past it
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts','bookings','stock_levels','till_requests']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'tables' then 'true'
        when 'stock_levels' then 'true'
        when 'shifts' then 'x.closed_at is null or x.created_at > now() - interval ''7 days'''
        when 'day_closes' then 'x.created_at > now() - interval ''30 days'''
        when 'bookings' then 'x.booked_for > now() - interval ''7 days'''
        else 'x.created_at > now() - interval ''7 days'''
      end,
      lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- A shop's stock papers (0092): its suppliers, and this store's orders,
  -- deliveries, counts and movements. An order and a delivery arrive with
  -- their lines inside the row, as they stand when the pull runs: a draft's
  -- lines are deleted outright when it is saved again, which rows sent by
  -- sequence would never tell a till. A restaurant is sent none of this, and
  -- a till that does not know these tables reads past them.
  if exists (select 1 from pos_settings where tenant_id = current_tenant_id() and data->>'businessType' = 'retail') then
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from suppliers x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('suppliers', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost,
                             'received', (select coalesce(sum(d.qty), 0)::integer from delivery_lines d where d.tenant_id = l.tenant_id and d.order_line_id = l.id))
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from purchase_order_lines l where l.tenant_id = x.tenant_id and l.order_id = x.id and l.deleted_at is null) as lines
              from purchase_orders x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status in ('draft', 'sent', 'part') or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('purchase_orders', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost)
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from delivery_lines l where l.tenant_id = x.tenant_id and l.delivery_id = x.id) as lines
              from deliveries x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('deliveries', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_counts x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status = 'open' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_counts', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_count_lines x
              join stock_counts k on k.tenant_id = x.tenant_id and k.id = x.count_id and k.store_id = p_store_id
               and k.status <> 'open' and k.updated_at > now() - interval '30 days'
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_count_lines', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_movements x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_movements', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end if;

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low_cut, high, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $function$
;

CREATE OR REPLACE FUNCTION public.sync_push(p_employee_id uuid, p_ops jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  tenant uuid;
  n int;
  i int;
  j int;
  op jsonb;
  rop jsonb;
  v_op_id uuid;
  v_type text;
  v_logtype text;
  v_stored jsonb;
  v_data jsonb;
  v_code text;
  v_envelope jsonb;
  v_emp uuid;
  v_payload jsonb;
  v_appr uuid;
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    'bad-rounding','approval-required','paid-line',
    'unknown-item','unknown-variant',
    'bad-employee','bad-shift','shift-closed',
    -- an item made or changed from a till (0084)
    'name-required','bad-category','barcode-taken','sku-taken','open-price-not-here',
    -- a premium feature asked of a restaurant whose plan does not carry it (0085)
    'not-premium',
    -- a category, and stock, changed from a till (0087)
    'has-items','bad-reason','not-counted','pick-variant','not-enough-stock',
    -- a tablet's first-run set-up (0089)
    'too-many','room-exists','name-taken','bad-address','bad-printer','bad-role','bad-pin','unknown-staff',
    -- a till's answer to what the back office asked of it (0091)
    'bad-request',
    -- a shop's stock tools on its till (0092)
    'unknown-supplier','unknown-store','unknown-order','not-draft','no-lines','already-received','not-open','not-part',
    'bad-delivery','nothing-received','unknown-line','bad-scope','nothing-to-count','bad-uncounted','bad-quantity'];
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if not exists (select 1 from employees where id = p_employee_id and deleted_at is null and is_active) then
    raise exception 'unknown-employee';
  end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad-batch'; end if;
  -- Whether the login pushing may vouch for staff: it may set up tills, so
  -- its word is taken for who did each thing and who approved it. The
  -- functions that store a refund and a bill ask this (0082): a refund or a
  -- discount the roles do not allow is stored and flagged when it comes from
  -- such a login, and refused, as it always was, from any other.
  perform set_config('app.till_vouched', case when has_perm(p_employee_id, 'settings.device') then '1' else '' end, true);

  n := jsonb_array_length(p_ops);
  for i in 0..n - 1 loop
    op := p_ops->i;
    begin
      begin
        v_op_id := (op->>'op_id')::uuid;
      exception when others then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end;
      if v_op_id is null then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end if;
      v_type := op->>'type';
      v_logtype := coalesce(v_type, 'unknown');

      select result into v_stored from sync_ops_applied where op_id = v_op_id;
      if found then
        res := res || (v_stored || jsonb_build_object('replayed', true));
        continue;
      end if;

      begin
        -- Who did it. The op names the member of staff who was signed in at
        -- the till with their PIN. An op that names nobody (a till with no
        -- staff PINs, or an older build) is the signed-in login's own.
        -- The login vouches for its staff only if it is allowed to set up
        -- tills; otherwise the op stays the login's own, so a lesser login
        -- cannot borrow someone else's permissions. Nothing is rejected for
        -- that: a sale must not be lost over who rang it up.
        v_emp := p_employee_id;
        if op->>'employee_id' is not null and has_perm(p_employee_id, 'settings.device') then
          begin
            v_emp := (op->>'employee_id')::uuid;
          exception when others then
            raise exception 'bad-employee';
          end;
          -- switched off or removed since is fine (the sale happened); an id
          -- that was never this restaurant's is not
          if not exists (select 1 from employees where id = v_emp and tenant_id = tenant) then
            raise exception 'bad-employee';
          end if;
        end if;
        -- Who approved it. When the person at the till may not do something,
        -- someone who may enters their own PIN there, and the op names them
        -- in its payload as approved_by. The same rule as for employee_id:
        -- it counts only from a login allowed to set up tills. From any other
        -- login it is dropped, and the op stands or falls on who sent it.
        v_payload := op->'payload';
        v_appr := null;
        if v_payload ? 'approved_by' then
          if has_perm(p_employee_id, 'settings.device') then
            begin
              v_appr := nullif(v_payload->>'approved_by', '')::uuid;
            exception when others then
              raise exception 'bad-employee';
            end;
            if v_appr is not null and not exists (select 1 from employees where id = v_appr and tenant_id = tenant) then
              raise exception 'bad-employee';
            end if;
          else
            v_payload := v_payload - 'approved_by';
          end if;
        end if;
        -- A discount that needs a manager names who approved it inside the
        -- discount itself. The same rule holds there (0082): from a login
        -- that may not set up tills it is dropped, and the discount stands
        -- or falls on who sent it.
        if jsonb_typeof(v_payload->'discounts') = 'array' and not has_perm(p_employee_id, 'settings.device') then
          v_payload := jsonb_set(v_payload, '{discounts}', (
            select coalesce(jsonb_agg(case when jsonb_typeof(x.d) = 'object' then x.d - 'approved_by' else x.d end order by x.n), '[]'::jsonb)
              from jsonb_array_elements(v_payload->'discounts') with ordinality as x(d, n)));
        end if;
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, v_payload);
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, v_payload);
          when 'ticket.edit_line' then v_data := push_ticket_edit_line(tenant, v_emp, v_payload);
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, v_emp, v_payload);
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, v_emp, v_payload);
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, v_emp, v_payload);
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, v_emp, v_payload);
          when 'receipt.create' then v_data := push_receipt_create(tenant, v_emp, v_payload);
          when 'refund.create' then v_data := push_refund_create(tenant, v_emp, v_payload);
          when 'shift.open' then v_data := push_shift_open(tenant, v_emp, v_payload);
          when 'shift.close' then v_data := push_shift_close(tenant, v_emp, v_payload);
          when 'timeclock.punch' then v_data := push_timeclock_punch(tenant, v_emp, v_payload);
          when 'ticket.send' then v_data := push_ticket_send(tenant, v_emp, v_payload);
          when 'ticket.split_line' then v_data := push_ticket_split_line(tenant, v_emp, v_payload);
          when 'ticket.place_lines' then v_data := push_ticket_place_lines(tenant, v_emp, v_payload);
          when 'customer.upsert' then v_data := push_customer_upsert(tenant, v_emp, v_payload);
          when 'ticket.stage' then v_data := push_ticket_stage(tenant, v_emp, v_payload);
          when 'ticket.cancel' then v_data := push_ticket_cancel(tenant, v_emp, v_payload);
          when 'kitchen.mark' then v_data := push_kitchen_mark(tenant, v_emp, v_payload);
          when 'booking.upsert' then v_data := push_booking_upsert(tenant, v_emp, v_payload);
          when 'item.set_available' then v_data := push_item_set_available(tenant, v_emp, v_payload);
          when 'item.set_price' then v_data := push_item_set_price(tenant, v_emp, v_payload);
          when 'item.save' then v_data := push_item_save(tenant, v_emp, v_payload);
          when 'item.remove' then v_data := push_item_remove(tenant, v_emp, v_payload);
          when 'category.save' then v_data := push_category_save(tenant, v_emp, v_payload);
          when 'category.remove' then v_data := push_category_remove(tenant, v_emp, v_payload);
          when 'stock.adjust' then v_data := push_stock_adjust(tenant, v_emp, v_payload);
          when 'tables.add' then v_data := push_tables_add(tenant, v_emp, v_payload);
          when 'printer.save' then v_data := push_printer_save(tenant, v_emp, v_payload);
          when 'company.save' then v_data := push_company_save(tenant, v_emp, v_payload);
          when 'staff.save' then v_data := push_staff_save(tenant, v_emp, v_payload);
          when 'staff.set_pin' then v_data := push_staff_set_pin(tenant, v_emp, v_payload);
          when 'setup.finish' then v_data := push_setup_finish(tenant, v_emp, v_payload);
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, v_payload);
          when 'drawer.count' then v_data := push_drawer_count(tenant, v_emp, v_payload);
          when 'day.close' then v_data := push_day_close(tenant, v_emp, v_payload);
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, v_payload);
          when 'request.answer' then v_data := push_request_answer(tenant, v_emp, v_payload);
          when 'supplier.save' then v_data := push_supplier_save(tenant, v_emp, v_payload);
          when 'supplier.remove' then v_data := push_supplier_remove(tenant, v_emp, v_payload);
          when 'po.save' then v_data := push_po_save(tenant, v_emp, v_payload);
          when 'po.send' then v_data := push_po_state(tenant, v_emp, v_payload, 'send');
          when 'po.cancel' then v_data := push_po_state(tenant, v_emp, v_payload, 'cancel');
          when 'po.close' then v_data := push_po_state(tenant, v_emp, v_payload, 'close');
          when 'delivery.receive' then v_data := push_delivery_receive(tenant, v_emp, v_payload);
          when 'count.complete' then v_data := push_count_complete(tenant, v_emp, v_payload);
          else raise exception 'unknown-op';
        end case;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, v_envelope);
        if v_appr is not null then
          insert into approvals (tenant_id, op_id, op_type, employee_id, approved_by)
            values (tenant, v_op_id, v_logtype, v_emp, v_appr);
        end if;
        res := res || v_envelope;
      exception when others then
        if sqlstate = '23505' then
          select result into v_stored from sync_ops_applied where op_id = v_op_id;
          if found then
            res := res || (v_stored || jsonb_build_object('replayed', true));
          else
            v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', 'conflict');
            insert into sync_ops_applied (op_id, tenant_id, type, result)
              values (v_op_id, tenant, v_logtype, v_envelope);
            res := res || v_envelope;
          end if;
        elsif sqlstate like '40%' or sqlstate like '53%' or sqlstate in ('55P03', '57014') then
          -- transient: stop here; this op and every later one retries.
          -- earlier ops keep their stored results.
          for j in i..n - 1 loop
            rop := p_ops->j;
            res := res || jsonb_build_object('op_id', rop->>'op_id', 'status', 'retry', 'code', 'transient');
          end loop;
          return res;
        else
          v_code := case when sqlerrm ~ '^[a-z0-9-]+$' then sqlerrm else 'error' end;
          if not (v_code = any (codes)) then
            raise warning 'sync_push unexpected op %: %', v_op_id, sqlerrm;
            v_code := 'error';
          end if;
          v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', v_code);
          insert into sync_ops_applied (op_id, tenant_id, type, result)
            values (v_op_id, tenant, v_logtype, v_envelope);
          res := res || v_envelope;
        end if;
      end;
    end;
  end loop;
  return res;
end $function$
;
