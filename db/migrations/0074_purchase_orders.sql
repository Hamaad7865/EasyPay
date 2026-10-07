-- 0074: purchase orders and deliveries.
--
-- A shop orders from a supplier and receives what arrives, in one delivery
-- or several, or receives a delivery nobody ordered.
--
--   - doc_counters, next_doc_number(): each tenant numbers its own orders
--     (PO-0001) and deliveries (D-0001); the next number is taken and the
--     counter moved in one statement, so two people are never handed the same.
--   - purchase_orders, purchase_order_lines: an order is a draft until it is
--     sent; from then on its lines are what was ordered, and no statement can
--     add, change or remove them (Kids Corner's migration 030).
--   - deliveries, delivery_lines: written once and never changed, like
--     receipts: block_update on both, and the tenant role has no right to
--     update or delete them (0065). Goods sent back afterwards leave by an
--     adjustment, "returned to supplier".
--   - delivery_receive(): the only way a delivery is written. Each line goes
--     through the stock engine with the delivery as its document, so a
--     delivery counts once however often it is sent, and the average cost of
--     what is on the shelf follows. The cost typed on a delivery also becomes
--     the product's cost (the variant's, for a variant): the next order
--     starts from what was last paid.
--   - Two lines for one product, on an order or on a delivery, are added
--     together (doc_lines): the engine moves a product once per document, so
--     a second line would otherwise be lost.
--   - "Delete all transactions" (purge_transactions) also removes a tenant's
--     orders and deliveries, and their numbers start again.
-- Source: stock_adjust is 0073's with its checks of a line moved into
-- stock_line_ok; purge_transactions is its live definition (0056,
-- pg_get_functiondef) with the four tables and the counters added.
-- Nothing here is pulled by a till. Never edit after merge.

-- ---- 1. numbers ----
create table if not exists doc_counters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  kind text not null check (kind in ('po', 'delivery', 'count')),
  next_no integer not null default 1 check (next_no >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, kind)
);
alter table doc_counters enable row level security;
alter table doc_counters force row level security;
drop policy if exists tenant_isolation on doc_counters;
create policy tenant_isolation on doc_counters
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on doc_counters;
create trigger trg_touch before insert or update on doc_counters
  for each row execute function touch_row();
create index if not exists idx_doc_counters_tenant_seq on doc_counters (tenant_id, server_seq);

create or replace function next_doc_number(p_tenant uuid, p_kind text) returns text
language plpgsql set search_path = public as $fn$
declare v_n integer;
begin
  insert into doc_counters (tenant_id, kind, next_no) values (p_tenant, p_kind, 2)
    on conflict (tenant_id, kind) do update set next_no = doc_counters.next_no + 1
    returning next_no - 1 into v_n;
  return (case p_kind when 'po' then 'PO-' when 'delivery' then 'D-' else 'C-' end)
    || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
end $fn$;

-- ---- 2. orders ----
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  number text not null,
  supplier_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'part', 'received', 'closed', 'cancelled')),
  expected_on date,
  note text,
  created_by uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number)
);
alter table purchase_orders enable row level security;
alter table purchase_orders force row level security;
drop policy if exists tenant_isolation on purchase_orders;
create policy tenant_isolation on purchase_orders
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on purchase_orders;
create trigger trg_touch before insert or update on purchase_orders
  for each row execute function touch_row();
create index if not exists idx_purchase_orders_tenant_seq on purchase_orders (tenant_id, server_seq);
create index if not exists idx_purchase_orders_supplier on purchase_orders (tenant_id, supplier_id);

create table if not exists purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  order_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  qty integer not null check (qty > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, order_id) references purchase_orders (tenant_id, id) on delete cascade
);
create unique index if not exists uq_purchase_order_lines_product on purchase_order_lines
  (order_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table purchase_order_lines enable row level security;
alter table purchase_order_lines force row level security;
drop policy if exists tenant_isolation on purchase_order_lines;
create policy tenant_isolation on purchase_order_lines
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on purchase_order_lines;
create trigger trg_touch before insert or update on purchase_order_lines
  for each row execute function touch_row();
create index if not exists idx_purchase_order_lines_tenant_seq on purchase_order_lines (tenant_id, server_seq);

-- An order's lines are open while it is a draft. Once it is sent they are
-- what was ordered, and what deliveries are measured against.
create or replace function po_lines_draft_only() returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
  v_order uuid := coalesce(new.order_id, old.order_id);
  v_status text;
begin
  -- the one way out, as in block_update: purge_transactions(), which runs as
  -- the owner of the tables and names the tenant it is emptying
  if TG_OP = 'DELETE' and current_user <> 'app_user'
      and v_tenant::text = current_setting('app.purge_tenant', true) then
    return old;
  end if;
  select status into v_status from purchase_orders where tenant_id = v_tenant and id = v_order;
  -- an order that is gone takes its lines with it
  if not found then return coalesce(new, old); end if;
  if v_status <> 'draft' then raise exception 'order-not-draft'; end if;
  return coalesce(new, old);
end $fn$;
drop trigger if exists trg_draft_only on purchase_order_lines;
create trigger trg_draft_only before insert or update or delete on purchase_order_lines
  for each row execute function po_lines_draft_only();

-- ---- 3. deliveries ----
create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  number text not null,
  order_id uuid,
  supplier_id uuid,
  arrived_on date not null,
  invoice_no text,
  note text,
  received_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, order_id) references purchase_orders (tenant_id, id)
);
alter table deliveries enable row level security;
alter table deliveries force row level security;
drop policy if exists tenant_isolation on deliveries;
create policy tenant_isolation on deliveries
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on deliveries;
create trigger trg_touch before insert or update on deliveries
  for each row execute function touch_row();
create index if not exists idx_deliveries_tenant_seq on deliveries (tenant_id, server_seq);
create index if not exists idx_deliveries_order on deliveries (tenant_id, order_id);

create table if not exists delivery_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  delivery_id uuid not null,
  order_line_id uuid,
  item_id uuid not null,
  variant_id uuid,
  qty integer not null check (qty > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, delivery_id) references deliveries (tenant_id, id),
  foreign key (tenant_id, order_line_id) references purchase_order_lines (tenant_id, id)
);
create unique index if not exists uq_delivery_lines_product on delivery_lines
  (delivery_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table delivery_lines enable row level security;
alter table delivery_lines force row level security;
drop policy if exists tenant_isolation on delivery_lines;
create policy tenant_isolation on delivery_lines
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on delivery_lines;
create trigger trg_touch before insert or update on delivery_lines
  for each row execute function touch_row();
create index if not exists idx_delivery_lines_tenant_seq on delivery_lines (tenant_id, server_seq);
create index if not exists idx_delivery_lines_order_line on delivery_lines (tenant_id, order_line_id);

-- a delivery is a record: insert-only, by trigger and by right (0065's note)
drop trigger if exists trg_no_update on deliveries;
create trigger trg_no_update before update or delete on deliveries
  for each row execute function block_update();
drop trigger if exists trg_no_update on delivery_lines;
create trigger trg_no_update before update or delete on delivery_lines
  for each row execute function block_update();
revoke update, delete on deliveries, delivery_lines from app_user;

-- ---- 4. a line of stock, checked ----
-- Is this a line stock can be kept on? A counted product, and for a product
-- with variants one of its live variants (it holds its stock on them, never
-- on itself). Read, not locked: the engine locks the line first and the
-- item's row second.
create or replace function stock_line_ok(p_tenant uuid, p_item uuid, p_variant uuid) returns void
language plpgsql stable set search_path = public as $fn$
declare v_counted boolean;
begin
  select (i.track_stock or coalesce(c.is_stock, false)) into v_counted
    from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
   where i.tenant_id = p_tenant and i.id = p_item and i.deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if not v_counted then raise exception 'not-counted'; end if;
  if p_variant is null then
    if exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null) then
      raise exception 'pick-variant';
    end if;
  elsif not exists (select 1 from item_variants
                     where tenant_id = p_tenant and item_id = p_item and id = p_variant and deleted_at is null) then
    raise exception 'unknown-line';
  end if;
end $fn$;

create or replace function stock_adjust(
  p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_units integer, p_reason text, p_emp uuid, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_out boolean;
  v_level stock_levels%rowtype;
begin
  if p_units is null or p_units <= 0 then raise exception 'bad-quantity'; end if;
  if p_reason in ('damaged', 'expired', 'lost', 'internal', 'supplier_return') then v_out := true;
  elsif p_reason = 'found' then v_out := false;
  else raise exception 'bad-reason';
  end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  perform stock_line_ok(p_tenant, p_item, p_variant);
  -- the line is locked from here: what it holds cannot change under the check
  v_level := stock_level_for(p_tenant, p_store, p_item, p_variant);
  if v_out and v_level.qty < p_units then raise exception 'not-enough-stock'; end if;
  return stock_move(p_tenant, p_store, p_item, p_variant, case when v_out then -p_units else p_units end,
    p_reason, null, null, null, p_emp, nullif(btrim(coalesce(p_note, '')), ''));
end $fn$;

-- The lines of an order or a delivery as a form sends them
-- ([{item_id, variant_id, qty, unit_cost}], thousandths and cents), with two
-- lines for one product added together: quantities summed, cost averaged by
-- quantity. A quantity below zero, or a cost that is missing or below zero,
-- is refused. A line of nothing is refused on an order and left out of a
-- delivery (p_skip_zero), where the form lists every line of the order.
create or replace function doc_lines(p_lines jsonb, p_skip_zero boolean)
returns table (item_id uuid, variant_id uuid, qty integer, unit_cost bigint)
language plpgsql stable set search_path = public as $fn$
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'bad-line'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) x
     where (x->>'item_id') is null or (x->>'qty') is null
        or (x->>'qty')::numeric < 0
        or ((x->>'qty')::numeric = 0 and not p_skip_zero)
        or ((x->>'qty')::numeric > 0 and ((x->>'unit_cost') is null or (x->>'unit_cost')::numeric < 0))) then
    raise exception 'bad-line';
  end if;
  return query
    select (x->>'item_id')::uuid, nullif(x->>'variant_id', '')::uuid,
           sum((x->>'qty')::integer)::integer,
           round(sum((x->>'qty')::numeric * (x->>'unit_cost')::numeric) / sum((x->>'qty')::numeric))::bigint
      from jsonb_array_elements(p_lines) x
     where (x->>'qty')::integer > 0
     group by 1, 2
     order by 1, 2;
end $fn$;

-- ---- 5. what a shop does with an order ----
-- A new draft (p_order null) or a draft saved again: its header, and its
-- lines replaced by the ones given.
create or replace function po_save(
  p_tenant uuid, p_emp uuid, p_order uuid, p_store uuid, p_supplier uuid, p_expected date, p_note text, p_lines jsonb
) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_id uuid := p_order;
  v_number text;
  v_status text;
  r record;
begin
  if not exists (select 1 from suppliers where tenant_id = p_tenant and id = p_supplier and deleted_at is null) then
    raise exception 'unknown-supplier';
  end if;
  if v_id is null then
    if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
      raise exception 'unknown-store';
    end if;
    v_number := next_doc_number(p_tenant, 'po');
    insert into purchase_orders (tenant_id, store_id, number, supplier_id, expected_on, note, created_by)
      values (p_tenant, p_store, v_number, p_supplier, p_expected, nullif(btrim(coalesce(p_note, '')), ''), p_emp)
      returning id into v_id;
  else
    select status, number into v_status, v_number from purchase_orders
     where tenant_id = p_tenant and id = v_id and deleted_at is null for update;
    if not found then raise exception 'unknown-order'; end if;
    if v_status <> 'draft' then raise exception 'not-draft'; end if;
    update purchase_orders set supplier_id = p_supplier, expected_on = p_expected,
           note = nullif(btrim(coalesce(p_note, '')), '')
     where tenant_id = p_tenant and id = v_id;
    delete from purchase_order_lines where tenant_id = p_tenant and order_id = v_id;
  end if;
  for r in select * from doc_lines(coalesce(p_lines, '[]'::jsonb), false) loop
    perform stock_line_ok(p_tenant, r.item_id, r.variant_id);
    insert into purchase_order_lines (tenant_id, order_id, item_id, variant_id, qty, unit_cost)
      values (p_tenant, v_id, r.item_id, r.variant_id, r.qty, r.unit_cost);
  end loop;
  return jsonb_build_object('id', v_id, 'number', v_number);
end $fn$;

create or replace function po_send(p_tenant uuid, p_order uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from purchase_orders where tenant_id = p_tenant and id = p_order and deleted_at is null for update;
  if not found then raise exception 'unknown-order'; end if;
  if v_status <> 'draft' then raise exception 'not-draft'; end if;
  if not exists (select 1 from purchase_order_lines where tenant_id = p_tenant and order_id = p_order) then
    raise exception 'no-lines';
  end if;
  update purchase_orders set status = 'sent', sent_at = now() where tenant_id = p_tenant and id = p_order;
end $fn$;

-- Cancelled while nothing has arrived. After a delivery the order is closed
-- instead (po_close): what arrived stays arrived.
create or replace function po_cancel(p_tenant uuid, p_order uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from purchase_orders where tenant_id = p_tenant and id = p_order and deleted_at is null for update;
  if not found then raise exception 'unknown-order'; end if;
  if exists (select 1 from deliveries where tenant_id = p_tenant and order_id = p_order) then raise exception 'already-received'; end if;
  if v_status not in ('draft', 'sent') then raise exception 'not-open'; end if;
  update purchase_orders set status = 'cancelled' where tenant_id = p_tenant and id = p_order;
end $fn$;

-- The rest of a part-received order will not come.
create or replace function po_close(p_tenant uuid, p_order uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from purchase_orders where tenant_id = p_tenant and id = p_order and deleted_at is null for update;
  if not found then raise exception 'unknown-order'; end if;
  if v_status <> 'part' then raise exception 'not-part'; end if;
  update purchase_orders set status = 'closed' where tenant_id = p_tenant and id = p_order;
end $fn$;

-- "Add what is low": the supplier's lines at or below their reorder level
-- that are not on the draft yet, each with its order quantity (or what brings
-- it back to its level when none is set), at its cost. Returns how many.
create or replace function po_fill_low(p_tenant uuid, p_order uuid) returns integer
language plpgsql set search_path = public as $fn$
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
  return v_n;
end $fn$;

-- What arrived. p_delivery is the delivery's id, made by whoever sends it:
-- the same delivery sent again (a button pressed twice) is already written,
-- and is answered with what was written. With an order (sent, or part
-- received), the shop and the supplier are the order's; without one they are
-- the ones given, and the supplier may be left out.
create or replace function delivery_receive(
  p_tenant uuid, p_emp uuid, p_delivery uuid, p_store uuid, p_order uuid, p_supplier uuid,
  p_arrived date, p_invoice text, p_note text, p_lines jsonb
) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_store uuid := p_store;
  v_supplier uuid := p_supplier;
  v_status text;
  v_number text;
  v_units integer := 0;
  v_done boolean;
  d record;
  r record;
begin
  if p_delivery is null then raise exception 'bad-delivery'; end if;
  -- two sends of one delivery wait their turn here, so the second sees the first
  perform pg_advisory_xact_lock(hashtextextended(p_delivery::text, 0));
  select number, order_id into d from deliveries where tenant_id = p_tenant and id = p_delivery;
  if found then
    return jsonb_build_object('id', p_delivery, 'number', d.number, 'already', true,
      'units', (select coalesce(sum(qty), 0)::integer from delivery_lines where tenant_id = p_tenant and delivery_id = p_delivery),
      'order_status', (select status from purchase_orders where tenant_id = p_tenant and id = d.order_id));
  end if;
  if p_order is not null then
    select status, store_id, supplier_id into v_status, v_store, v_supplier from purchase_orders
     where tenant_id = p_tenant and id = p_order and deleted_at is null for update;
    if not found then raise exception 'unknown-order'; end if;
    if v_status not in ('sent', 'part') then raise exception 'not-open'; end if;
  else
    if not exists (select 1 from stores where tenant_id = p_tenant and id = v_store and deleted_at is null) then
      raise exception 'unknown-store';
    end if;
    if v_supplier is not null and not exists (select 1 from suppliers where tenant_id = p_tenant and id = v_supplier and deleted_at is null) then
      raise exception 'unknown-supplier';
    end if;
  end if;
  if not exists (select 1 from doc_lines(p_lines, true)) then raise exception 'nothing-received'; end if;

  v_number := next_doc_number(p_tenant, 'delivery');
  insert into deliveries (id, tenant_id, store_id, number, order_id, supplier_id, arrived_on, invoice_no, note, received_by)
    values (p_delivery, p_tenant, v_store, v_number, p_order, v_supplier, coalesce(p_arrived, current_date),
      nullif(btrim(coalesce(p_invoice, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_emp);
  -- always in the same order (by product), so two deliveries of the same goods wait on each other the same way round
  for r in select * from doc_lines(p_lines, true) loop
    perform stock_line_ok(p_tenant, r.item_id, r.variant_id);
    insert into delivery_lines (tenant_id, delivery_id, order_line_id, item_id, variant_id, qty, unit_cost)
      values (p_tenant, p_delivery,
        (select l.id from purchase_order_lines l
          where l.tenant_id = p_tenant and l.order_id = p_order and l.item_id = r.item_id
            and l.variant_id is not distinct from r.variant_id),
        r.item_id, r.variant_id, r.qty, r.unit_cost);
    perform stock_move(p_tenant, v_store, r.item_id, r.variant_id, r.qty, 'receive', r.unit_cost, 'delivery', p_delivery, p_emp, null);
    -- what was last paid is what the product costs (after the engine: the line first, the item's row second)
    if r.variant_id is null then
      update items set cost = r.unit_cost where tenant_id = p_tenant and id = r.item_id and cost is distinct from r.unit_cost;
    else
      update item_variants set cost = r.unit_cost where tenant_id = p_tenant and id = r.variant_id and cost is distinct from r.unit_cost;
    end if;
    v_units := v_units + r.qty;
  end loop;

  if p_order is not null then
    select coalesce(bool_and(coalesce(g.got, 0) >= l.qty), false) into v_done
      from purchase_order_lines l
      left join (select order_line_id, sum(qty) as got from delivery_lines
                  where tenant_id = p_tenant and order_line_id is not null group by 1) g on g.order_line_id = l.id
     where l.tenant_id = p_tenant and l.order_id = p_order;
    v_status := case when v_done then 'received' else 'part' end;
    update purchase_orders set status = v_status where tenant_id = p_tenant and id = p_order;
  end if;
  return jsonb_build_object('id', p_delivery, 'number', v_number, 'already', false, 'units', v_units,
    'order_status', case when p_order is null then null else v_status end);
end $fn$;

-- ---- 6. delete all transactions ----
CREATE OR REPLACE FUNCTION public.purge_transactions(p_tenant uuid, p_emp uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_auth uuid; v_receipts bigint; v_tickets bigint; t text;
begin
  -- the caller is working in this restaurant, and is its owner
  if p_tenant is null or current_tenant_id() is distinct from p_tenant then raise exception 'forbidden'; end if;
  select e.auth_user_id into v_auth from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
    where e.id = p_emp and e.tenant_id = p_tenant and e.deleted_at is null and e.is_active and r.permissions ? '*';
  if not found then raise exception 'forbidden'; end if;
  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_tickets from tickets where tenant_id = p_tenant;
  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach t in array array[
    'delivery_lines','deliveries','purchase_order_lines','purchase_orders',
    'bookings','approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant;
  -- orders and deliveries number from 1 again, as bills do
  delete from doc_counters where tenant_id = p_tenant;
  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;
