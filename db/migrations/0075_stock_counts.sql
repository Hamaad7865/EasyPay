-- 0075: stock counts.
--
-- A shop counts its shelves: all of them, or one category, supplier or brand.
-- It does not close for it.
--
--   - stock_counts, stock_count_lines: a count is of one shop and has a line
--     for each line of stock in its scope (a counted product, or one variant
--     of it). A line holds what was counted and when it was last counted.
--     Scans add up, whoever scans; typing sets the figure. Once a count is
--     completed or cancelled no statement can change its lines.
--   - stock_moved_since(): what moved on a line of stock after a moment. This
--     is the one place that says which clock counts. A sale or a refund is
--     judged by when it was rung up on the till (the receipt's own time), not
--     by when it reached the server: a till that was offline sends its sales
--     late, and a sale made before the shelf was counted is already missing
--     from the shelf. Everything else (a delivery, an adjustment) is made in
--     the back office and is judged by when it was saved.
--   - count_complete(): each counted line of stock becomes what was counted
--     plus what moved after it was counted, by one `count` movement through
--     the engine with the count as its document, under the line's lock. The
--     count keeps, for every line, what was expected, the difference and the
--     cost, and is a record from then on. Lines that were not counted are
--     left as they are or set to nothing, as asked.
--   - This is a count per line and per shop. stock_count_item (0067), which
--     sets an item's total, is unchanged: a restaurant's Stock page uses it.
--   - "Delete all transactions" also removes a tenant's counts.
-- Source: purge_transactions is 0074's with the two tables added.
-- Nothing here is pulled by a till. Never edit after merge.

create table if not exists stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  number text not null,
  scope_kind text not null check (scope_kind in ('all', 'category', 'supplier', 'brand')),
  scope_id uuid,
  scope_text text,
  title text not null,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  uncounted text check (uncounted in ('leave', 'zero')),
  started_by uuid,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number)
);
alter table stock_counts enable row level security;
alter table stock_counts force row level security;
drop policy if exists tenant_isolation on stock_counts;
create policy tenant_isolation on stock_counts
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_counts;
create trigger trg_touch before insert or update on stock_counts
  for each row execute function touch_row();
create index if not exists idx_stock_counts_tenant_seq on stock_counts (tenant_id, server_seq);

create table if not exists stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  count_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  counted integer check (counted >= 0),
  counted_at timestamptz,
  counted_by uuid,
  left_out boolean not null default false,
  -- written when the count is completed: what the line was expected to hold
  -- when it was counted, the difference that was applied, the cost it was at
  expected integer,
  diff integer,
  unit_cost numeric(18,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, count_id) references stock_counts (tenant_id, id) on delete cascade
);
create unique index if not exists uq_stock_count_lines_product on stock_count_lines
  (count_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table stock_count_lines enable row level security;
alter table stock_count_lines force row level security;
drop policy if exists tenant_isolation on stock_count_lines;
create policy tenant_isolation on stock_count_lines
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_count_lines;
create trigger trg_touch before insert or update on stock_count_lines
  for each row execute function touch_row();
create index if not exists idx_stock_count_lines_tenant_seq on stock_count_lines (tenant_id, server_seq);

-- A count's lines change while it is open. Completed or cancelled, it is a record.
create or replace function count_lines_open_only() returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
  v_count uuid := coalesce(new.count_id, old.count_id);
  v_status text;
begin
  -- the one way out, as in block_update: purge_transactions()
  if TG_OP = 'DELETE' and current_user <> 'app_user'
      and v_tenant::text = current_setting('app.purge_tenant', true) then
    return old;
  end if;
  select status into v_status from stock_counts where tenant_id = v_tenant and id = v_count;
  -- a count that is gone takes its lines with it
  if not found then return coalesce(new, old); end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  return coalesce(new, old);
end $fn$;
drop trigger if exists trg_open_only on stock_count_lines;
create trigger trg_open_only before insert or update or delete on stock_count_lines
  for each row execute function count_lines_open_only();

-- What moved on one line of stock after a moment (see the head of this file
-- for which clock is used).
create or replace function stock_moved_since(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_since timestamptz)
returns integer
language sql stable set search_path = public as $fn$
  select coalesce(sum(m.qty), 0)::integer
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
   where m.tenant_id = p_tenant and m.store_id = p_store and m.item_id = p_item
     and m.variant_id is not distinct from p_variant and m.deleted_at is null
     and (case when m.reason in ('sale', 'refund') then coalesce(r.device_time, m.created_at) else m.created_at end) > p_since
$fn$;

-- A new count: the whole shop ('all'), or the lines of one category, one
-- supplier (p_scope) or one brand (p_brand, whatever its capitals).
create or replace function count_start(p_tenant uuid, p_emp uuid, p_store uuid, p_kind text, p_scope uuid, p_brand text)
returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_id uuid := gen_random_uuid();
  v_title text;
  v_number text;
  v_brand text := lower(btrim(coalesce(p_brand, '')));
  v_n integer;
begin
  if p_kind is null or p_kind not in ('all', 'category', 'supplier', 'brand') then raise exception 'bad-scope'; end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  v_title := case p_kind
    when 'all' then 'The whole shop'
    when 'category' then (select name from categories where tenant_id = p_tenant and id = p_scope)
    when 'supplier' then (select name from suppliers where tenant_id = p_tenant and id = p_scope)
    else (select btrim(brand) from items where tenant_id = p_tenant and deleted_at is null and lower(btrim(brand)) = v_brand order by brand limit 1)
  end;
  select count(*)::int into v_n
    from stock_on_hand(p_tenant, p_store) s join items i on i.tenant_id = p_tenant and i.id = s.item_id
   where p_kind = 'all'
      or (p_kind = 'category' and s.category_id = p_scope)
      or (p_kind = 'supplier' and s.supplier_id = p_scope)
      or (p_kind = 'brand' and v_brand <> '' and lower(btrim(i.brand)) = v_brand);
  if v_n = 0 or v_title is null then raise exception 'nothing-to-count'; end if;

  v_number := next_doc_number(p_tenant, 'count');
  insert into stock_counts (id, tenant_id, store_id, number, scope_kind, scope_id, scope_text, title, started_by)
    values (v_id, p_tenant, p_store, v_number, p_kind, case when p_kind in ('category', 'supplier') then p_scope end,
      case when p_kind = 'brand' then v_title end, v_title, p_emp);
  insert into stock_count_lines (tenant_id, count_id, item_id, variant_id)
    select p_tenant, v_id, s.item_id, s.variant_id
      from stock_on_hand(p_tenant, p_store) s join items i on i.tenant_id = p_tenant and i.id = s.item_id
     where p_kind = 'all'
        or (p_kind = 'category' and s.category_id = p_scope)
        or (p_kind = 'supplier' and s.supplier_id = p_scope)
        or (p_kind = 'brand' and v_brand <> '' and lower(btrim(i.brand)) = v_brand);
  return jsonb_build_object('id', v_id, 'number', v_number, 'lines', v_n);
end $fn$;

-- One line counted: a scan adds to it ('add'), typing sets it ('set'). A
-- product that is not in the count yet is added to it: it is on the shelf.
-- The count's row is held while this runs, so a count cannot be completed
-- under a scan. Returns what the line is counted at now.
create or replace function count_add(
  p_tenant uuid, p_count uuid, p_item uuid, p_variant uuid, p_units integer, p_mode text, p_emp uuid
) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_status text;
  v_now integer;
begin
  select status into v_status from stock_counts where tenant_id = p_tenant and id = p_count and deleted_at is null for share;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  if p_units is null or p_mode is null or p_mode not in ('add', 'set')
     or (p_mode = 'add' and p_units <= 0) or (p_mode = 'set' and p_units < 0) then
    raise exception 'bad-quantity';
  end if;
  perform stock_line_ok(p_tenant, p_item, p_variant);
  insert into stock_count_lines (tenant_id, count_id, item_id, variant_id, counted, counted_at, counted_by)
    values (p_tenant, p_count, p_item, p_variant, p_units, clock_timestamp(), p_emp)
    on conflict (count_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    do update set counted = case when p_mode = 'add' then coalesce(stock_count_lines.counted, 0) + p_units else p_units end,
                  counted_at = clock_timestamp(), counted_by = p_emp
    returning counted into v_now;
  return v_now;
end $fn$;

-- A line counted again from nothing ('recount'), left out of the count
-- ('leave') or put back ('back').
create or replace function count_line(p_tenant uuid, p_count uuid, p_line uuid, p_what text) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from stock_counts where tenant_id = p_tenant and id = p_count and deleted_at is null for share;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  if p_what = 'recount' then
    update stock_count_lines set counted = null, counted_at = null, counted_by = null where tenant_id = p_tenant and count_id = p_count and id = p_line;
  elsif p_what in ('leave', 'back') then
    update stock_count_lines set left_out = (p_what = 'leave') where tenant_id = p_tenant and count_id = p_count and id = p_line;
  else
    raise exception 'bad-request';
  end if;
  if not found then raise exception 'unknown-line'; end if;
end $fn$;

-- The lines of a count as its page reviews them. While the count is open:
-- what each line was expected to hold when it was counted (what the books
-- hold now, less what moved since), the difference, what it is worth at the
-- line's average cost, and what the line of stock would become (target).
-- Once completed: what was written then.
create or replace function count_review(p_tenant uuid, p_count uuid)
returns table (
  line_id uuid, item_id uuid, variant_id uuid, name text, variant text, sku text, barcode text,
  counted integer, counted_at timestamptz, left_out boolean,
  expected integer, moved integer, target integer, diff integer, value numeric, avg_cost numeric, state text)
language sql stable set search_path = public as $fn$
  with c as (select id, store_id, status from stock_counts where tenant_id = p_tenant and id = p_count and deleted_at is null),
  l as (
    select sl.id, sl.item_id, sl.variant_id, i.name, v.name as variant,
           case when v.id is null then i.sku else v.sku end as sku,
           case when v.id is null then i.barcode else v.barcode end as barcode,
           sl.counted, sl.counted_at, sl.left_out, c.status,
           sl.expected as kept_expected, sl.diff as kept_diff, sl.unit_cost as kept_cost,
           coalesce(lv.qty, 0) as on_hand, coalesce(lv.avg_cost, v.cost, i.cost, 0)::numeric as cost_now,
           case when c.status = 'open' and sl.counted_at is not null
                then stock_moved_since(p_tenant, c.store_id, sl.item_id, sl.variant_id, sl.counted_at) else 0 end as moved
      from c
      join stock_count_lines sl on sl.tenant_id = p_tenant and sl.count_id = c.id
      join items i on i.tenant_id = sl.tenant_id and i.id = sl.item_id
      left join item_variants v on v.tenant_id = sl.tenant_id and v.id = sl.variant_id
      left join stock_levels lv on lv.tenant_id = sl.tenant_id and lv.store_id = c.store_id and lv.item_id = sl.item_id
                               and lv.variant_id is not distinct from sl.variant_id and lv.deleted_at is null),
  x as (
    select l.*,
           case when status = 'completed' then kept_expected else on_hand - moved end as x_expected,
           case when status = 'completed' then kept_diff
                when counted is null then null else counted - (on_hand - moved) end as x_diff,
           case when status = 'completed' then coalesce(kept_cost, cost_now) else cost_now end as x_cost
      from l)
  select id, item_id, variant_id, name, variant, sku, barcode, counted, counted_at, left_out,
         x_expected, moved, case when status = 'open' and counted is not null then counted + moved end,
         x_diff, case when x_diff is null then null else round(x_diff * x_cost / 1000, 2) end, x_cost,
         case when counted is null then 'uncounted' when x_diff = 0 then 'matching' else 'different' end
    from x
$fn$;

-- The count is applied. p_uncounted says what happens to the lines nobody
-- counted: 'leave' them as they are, or set them to 'zero'. Lines left out
-- are not touched. Returns how many lines of stock changed, by how many
-- units in all, and what that is worth at cost.
create or replace function count_complete(p_tenant uuid, p_emp uuid, p_count uuid, p_uncounted text) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_status text; v_store uuid;
  v_level stock_levels%rowtype;
  v_counted integer; v_moved integer; v_delta integer;
  v_lines integer := 0; v_units integer := 0; v_value numeric := 0;
  r record;
begin
  if p_uncounted is null or p_uncounted not in ('leave', 'zero') then raise exception 'bad-uncounted'; end if;
  select status, store_id into v_status, v_store from stock_counts
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
      v_moved := stock_moved_since(p_tenant, v_store, r.item_id, r.variant_id, r.counted_at);
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
end $fn$;

create or replace function count_cancel(p_tenant uuid, p_count uuid) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  select status into v_status from stock_counts where tenant_id = p_tenant and id = p_count and deleted_at is null for update;
  if not found then raise exception 'unknown-count'; end if;
  if v_status <> 'open' then raise exception 'count-closed'; end if;
  update stock_counts set status = 'cancelled' where tenant_id = p_tenant and id = p_count;
end $fn$;

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
    'stock_count_lines','stock_counts',
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
  -- orders, deliveries and counts number from 1 again, as bills do
  delete from doc_counters where tenant_id = p_tenant;
  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;
