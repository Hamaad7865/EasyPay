-- 0067: one stock engine.
--
-- Until now a sale and a refund each wrote stock_movements and items.stock_qty
-- themselves, and the back office Stock page did the same a third time. Stock
-- was one number per item: no shop, no variant, no cost.
--
--   - stock_levels: one row per shop and per product (an item, or one variant
--     of it): the quantity on hand and its average cost. Like stock_movements
--     it has no foreign key to items, stores or item_variants: those tables
--     are rewritten together by the truncate path and the purge.
--   - stock_movements gains the shop, the variant, the cost at that moment
--     and the document the movement came from (ref_type, ref_id). A document
--     moves one product in one shop once: that is what makes a receipt that
--     arrives twice, or a button pressed twice, count once.
--   - stock_move(): the only code that writes a movement and changes a level.
--     It keeps items.stock_qty as the item's total, so the tills and pages
--     that read that number go on working.
--   - stock_count_item(): the shelf was counted; the difference is worked out
--     under the level's lock.
--   - the reasons a movement can have are widened for what is coming
--     (deliveries, counts, losses); nothing is renamed.
-- Nothing here is pulled by a till. This migration changes no behaviour by
-- itself: 0068 moves the sale and the refund onto the engine.

create table if not exists stock_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  qty integer not null default 0,
  avg_cost numeric(18,4) not null default 0,
  reorder_point integer,
  reorder_qty integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
create unique index if not exists uq_stock_levels_product on stock_levels
  (tenant_id, store_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table stock_levels enable row level security;
alter table stock_levels force row level security;
drop policy if exists tenant_isolation on stock_levels;
create policy tenant_isolation on stock_levels
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_levels;
create trigger trg_touch before insert or update on stock_levels
  for each row execute function touch_row();
create index if not exists idx_stock_levels_tenant_seq on stock_levels (tenant_id, server_seq);
create index if not exists idx_stock_levels_item on stock_levels (tenant_id, item_id);

alter table stock_movements add column if not exists store_id uuid;
alter table stock_movements add column if not exists variant_id uuid;
alter table stock_movements add column if not exists unit_cost numeric(18,4);
alter table stock_movements add column if not exists ref_type text;
alter table stock_movements add column if not exists ref_id uuid;
alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check check (reason in (
  'sale', 'refund', 'adjust', 'count',
  'receive', 'supplier_return', 'opening', 'damaged', 'expired', 'lost', 'internal', 'found'));
create unique index if not exists uq_stock_movements_ref on stock_movements
  (tenant_id, ref_type, ref_id, store_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where ref_id is not null;

-- The shop a tenant started with: where stock that belongs to no named shop is kept.
create or replace function first_store(p_tenant uuid) returns uuid
language sql stable set search_path = public as $fn$
  select id from stores where tenant_id = p_tenant and deleted_at is null order by created_at, id limit 1
$fn$;

-- The level of one product in one shop: made on first use, and locked until
-- this transaction ends, so two changes to one product wait their turn. The
-- first level ever made for an item starts from the quantity the item already
-- carried, so nothing counted before the engine existed is lost; any later
-- one starts from nothing.
-- Everything that changes stock takes this lock first and the item's row
-- second. Nothing may lock the item's row and then ask for a level: a sale
-- and that caller would each hold what the other waits for.
create or replace function stock_level_for(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid)
returns stock_levels
language plpgsql set search_path = public as $fn$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_level stock_levels%rowtype;
begin
  if p_store is null or p_item is null then raise exception 'bad-stock-move'; end if;
  insert into stock_levels (tenant_id, store_id, item_id, variant_id, qty, avg_cost)
    select p_tenant, p_store, p_item, p_variant,
           case when exists (select 1 from stock_levels x where x.tenant_id = p_tenant and x.item_id = p_item)
                then 0 else coalesce(i.stock_qty, 0) end,
           coalesce(i.cost, 0)
      from items i where i.tenant_id = p_tenant and i.id = p_item
    on conflict do nothing;
  select * into v_level from stock_levels
   where tenant_id = p_tenant and store_id = p_store and item_id = p_item
     and coalesce(variant_id, v_zero) = coalesce(p_variant, v_zero)
   for update;
  if not found then raise exception 'unknown-item'; end if;
  return v_level;
end $fn$;

create or replace function stock_move(
  p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_qty integer, p_reason text,
  p_unit_cost numeric, p_ref_type text, p_ref_id uuid, p_emp uuid, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_level stock_levels%rowtype;
  v_cost numeric;
  v_avg numeric;
  v_id uuid;
begin
  if p_qty is null or p_qty = 0 then return null; end if;
  v_level := stock_level_for(p_tenant, p_store, p_item, p_variant);

  -- a document moves a product in a shop once
  if p_ref_id is not null and exists (select 1 from stock_movements m
       where m.tenant_id = p_tenant and m.ref_type = p_ref_type and m.ref_id = p_ref_id
         and m.store_id = p_store and m.item_id = p_item
         and coalesce(m.variant_id, v_zero) = coalesce(p_variant, v_zero)) then
    return null;
  end if;

  if p_qty > 0 and p_unit_cost is not null then
    -- stock coming in at a known cost moves the average
    v_cost := p_unit_cost;
    v_avg := case when v_level.qty <= 0 then p_unit_cost
                  else round((v_level.qty * v_level.avg_cost + p_qty * p_unit_cost) / (v_level.qty + p_qty), 4) end;
  else
    -- everything else moves at the average of this moment
    v_cost := v_level.avg_cost;
    v_avg := v_level.avg_cost;
  end if;

  insert into stock_movements (tenant_id, store_id, item_id, variant_id, qty, reason, unit_cost,
      ref_type, ref_id, receipt_id, employee_id, note)
    values (p_tenant, p_store, p_item, p_variant, p_qty, p_reason, v_cost,
      p_ref_type, p_ref_id, case when p_ref_type = 'receipt' then p_ref_id end, p_emp, p_note)
    returning id into v_id;
  update stock_levels set qty = v_level.qty + p_qty, avg_cost = v_avg where id = v_level.id;
  update items set stock_qty = coalesce(stock_qty, 0) + p_qty where tenant_id = p_tenant and id = p_item;
  return v_id;
end $fn$;

-- The shelf was counted: an item's total becomes what was counted. The
-- difference is worked out only after the item's level is locked, so two
-- people counting the same item at the same moment build on each other's
-- figure instead of the second overwriting the first (the fault Kids Corner
-- fixed in its migration 045). Returns the difference that was written.
create or replace function stock_count_item(
  p_tenant uuid, p_store uuid, p_item uuid, p_counted integer, p_emp uuid, p_note text
) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_total integer;
  v_delta integer;
begin
  if p_counted is null or p_counted < 0 then raise exception 'bad-count'; end if;
  perform stock_level_for(p_tenant, p_store, p_item, null);
  select coalesce(stock_qty, 0) into v_total from items where tenant_id = p_tenant and id = p_item;
  v_delta := p_counted - v_total;
  perform stock_move(p_tenant, p_store, p_item, null, v_delta, 'count', null, null, null, p_emp, p_note);
  return v_delta;
end $fn$;
