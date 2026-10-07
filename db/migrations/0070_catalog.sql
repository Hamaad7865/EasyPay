-- 0070: a shop's catalog.
-- Source for stock_level_for: 0067, with one change (see 8).
--
-- What a shop needs of its products that a restaurant did not: who supplies
-- them, what they cost, sizes and colours, and codes that can be trusted.
--
--  1. suppliers.
--  2. items gain brand, supplier, the supplier's code and the names of their
--     options ("Size", "Colour"); a variant gains the values it stands for
--     and a cost of its own.
--  3. a barcode, and a SKU whatever its case, belongs to one live product or
--     variant of a tenant. Until now that was a select in the back office;
--     two tables cannot share one unique index, so it is a trigger, under the
--     tenant's lock.
--  4. a change of a product's price or cost reaches the variants that had it.
--  5. EasyPay's own barcodes: EAN-13 from a prefix and a counter per tenant.
--     The counter only goes up, so a number once printed is never given out
--     again.
--  6. variants_generate: every missing combination of the option values.
--  7. variant_archive: not while it holds stock.
--  8. stock_level_for: a variant's first level starts at the variant's cost.
--  9. stock_set_reorder: the reorder level, on every line of a product.
--
-- Nothing new is pulled by a till. A till on the present APK reads named
-- fields of items and has no branch for item_variants, so it ignores all of
-- this: a product with variants is one item to it until the sell screen.

-- 1. suppliers
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  contact text,
  phone text,
  email text,
  address text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
create unique index if not exists uq_suppliers_name on suppliers (tenant_id, lower(name)) where deleted_at is null;
alter table suppliers enable row level security;
alter table suppliers force row level security;
drop policy if exists tenant_isolation on suppliers;
create policy tenant_isolation on suppliers
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on suppliers;
create trigger trg_touch before insert or update on suppliers
  for each row execute function touch_row();
create index if not exists idx_suppliers_tenant_seq on suppliers (tenant_id, server_seq);

-- 2. what a product and a variant can now say
alter table items add column if not exists brand text;
alter table items add column if not exists supplier_id uuid;
alter table items add column if not exists supplier_code text;
alter table items add column if not exists option_names text[] not null default '{}';
alter table item_variants add column if not exists option_values text[] not null default '{}';
alter table item_variants add column if not exists cost bigint;

-- 3. one barcode, one SKU
create index if not exists idx_items_barcode on items (tenant_id, barcode) where barcode is not null and deleted_at is null;
create index if not exists idx_items_sku on items (tenant_id, lower(sku)) where sku is not null and deleted_at is null;
create index if not exists idx_item_variants_barcode on item_variants (tenant_id, barcode) where barcode is not null and deleted_at is null;
create index if not exists idx_item_variants_sku on item_variants (tenant_id, lower(sku)) where sku is not null and deleted_at is null;

create or replace function catalog_code_guard() returns trigger
language plpgsql set search_path = public as $fn$
begin
  new.barcode := nullif(btrim(coalesce(new.barcode, '')), '');
  new.sku := nullif(btrim(coalesce(new.sku, '')), '');
  -- a row being removed frees its codes; a row with none has nothing to check
  if new.deleted_at is not null or (new.barcode is null and new.sku is null) then return new; end if;
  -- the tenant's own lock (the one touch_row takes): two people saving the
  -- same code at the same moment wait their turn, and the second is refused
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0));
  if new.barcode is not null and (
       exists (select 1 from items i
                where i.tenant_id = new.tenant_id and i.barcode = new.barcode and i.deleted_at is null and i.id <> new.id)
    or exists (select 1 from item_variants v join items p on p.tenant_id = v.tenant_id and p.id = v.item_id
                where v.tenant_id = new.tenant_id and v.barcode = new.barcode and v.deleted_at is null
                  and p.deleted_at is null and v.id <> new.id)) then
    raise exception 'barcode-taken';
  end if;
  if new.sku is not null and (
       exists (select 1 from items i
                where i.tenant_id = new.tenant_id and lower(i.sku) = lower(new.sku) and i.deleted_at is null and i.id <> new.id)
    or exists (select 1 from item_variants v join items p on p.tenant_id = v.tenant_id and p.id = v.item_id
                where v.tenant_id = new.tenant_id and lower(v.sku) = lower(new.sku) and v.deleted_at is null
                  and p.deleted_at is null and v.id <> new.id)) then
    raise exception 'sku-taken';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_code_guard on items;
create trigger trg_code_guard before insert or update of sku, barcode, deleted_at on items
  for each row execute function catalog_code_guard();
drop trigger if exists trg_code_guard on item_variants;
create trigger trg_code_guard before insert or update of sku, barcode, deleted_at on item_variants
  for each row execute function catalog_code_guard();

-- 4. a variant that was at the product's price, or cost, stays at it
create or replace function variants_follow_price() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.price is distinct from old.price then
    update item_variants set price = new.price
     where tenant_id = new.tenant_id and item_id = new.id and price = old.price and deleted_at is null;
  end if;
  if new.cost is distinct from old.cost then
    update item_variants set cost = new.cost
     where tenant_id = new.tenant_id and item_id = new.id and cost is not distinct from old.cost and deleted_at is null;
  end if;
  return null;
end $fn$;
drop trigger if exists trg_variants_follow on items;
create trigger trg_variants_follow after update of price, cost on items
  for each row execute function variants_follow_price();

-- 5. EasyPay's own barcodes
create table if not exists barcode_counters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- 20 to 29 is the range for codes that never leave the shop. It is the
  -- tenant's own so that a shop whose scale prints labels starting the same
  -- way can be given another.
  prefix text not null default '200' check (prefix ~ '^[0-9]{2,7}$'),
  next_serial bigint not null default 1 check (next_serial >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
create unique index if not exists uq_barcode_counters_tenant on barcode_counters (tenant_id);
alter table barcode_counters enable row level security;
alter table barcode_counters force row level security;
drop policy if exists tenant_isolation on barcode_counters;
create policy tenant_isolation on barcode_counters
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on barcode_counters;
create trigger trg_touch before insert or update on barcode_counters
  for each row execute function touch_row();
create index if not exists idx_barcode_counters_tenant_seq on barcode_counters (tenant_id, server_seq);

-- Twelve digits (the prefix, then the serial filled out with zeros) and their
-- check digit: weights 1,3,1,3... from the left, and the digit that takes the
-- sum to the next ten. Refuses a serial that has outgrown the room the prefix
-- leaves it, rather than cutting it short into a number already printed.
create or replace function ean13(p_prefix text, p_serial bigint) returns text
language plpgsql immutable as $fn$
declare
  v_width int;
  v_payload text;
  v_sum int := 0;
  i int;
begin
  if p_prefix is null or p_prefix !~ '^[0-9]{1,11}$' or p_serial is null or p_serial < 0 then
    raise exception 'bad-barcode-serial';
  end if;
  v_width := 12 - length(p_prefix);
  if length(p_serial::text) > v_width then raise exception 'bad-barcode-serial'; end if;
  v_payload := p_prefix || lpad(p_serial::text, v_width, '0');
  for i in 1..12 loop
    v_sum := v_sum + substr(v_payload, i, 1)::int * (case when i % 2 = 1 then 1 else 3 end);
  end loop;
  return v_payload || ((10 - v_sum % 10) % 10)::text;
end $fn$;

-- Gives every line of a product that has no barcode one of EasyPay's: its
-- variants, or the product itself when it has none. Returns how many it gave.
create or replace function assign_barcodes(p_tenant uuid, p_item uuid) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_prefix text;
  v_next bigint;
  v_code text;
  v_n int := 0;
  v_has_variants boolean;
  r record;
begin
  if not exists (select 1 from items where tenant_id = p_tenant and id = p_item and deleted_at is null) then
    raise exception 'unknown-item';
  end if;
  insert into barcode_counters (tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  -- held to the end: two people making barcodes at once take their numbers in turn
  select prefix, next_serial into v_prefix, v_next from barcode_counters where tenant_id = p_tenant for update;
  v_has_variants := exists (select 1 from item_variants
    where tenant_id = p_tenant and item_id = p_item and deleted_at is null);
  for r in
    select 'variant' as kind, v.id, v.name from item_variants v
     where v.tenant_id = p_tenant and v.item_id = p_item and v.deleted_at is null and v.barcode is null
    union all
    select 'item', i.id, i.name from items i
     where i.tenant_id = p_tenant and i.id = p_item and i.barcode is null and not v_has_variants
    order by 3, 2
  loop
    loop
      v_code := ean13(v_prefix, v_next);
      v_next := v_next + 1;
      exit when not exists (select 1 from items i
                             where i.tenant_id = p_tenant and i.barcode = v_code and i.deleted_at is null)
            and not exists (select 1 from item_variants v
                             where v.tenant_id = p_tenant and v.barcode = v_code and v.deleted_at is null);
    end loop;
    if r.kind = 'variant' then
      update item_variants set barcode = v_code where tenant_id = p_tenant and id = r.id;
    else
      update items set barcode = v_code where tenant_id = p_tenant and id = r.id;
    end if;
    v_n := v_n + 1;
  end loop;
  update barcode_counters set next_serial = v_next where tenant_id = p_tenant;
  return v_n;
end $fn$;

-- 6. Variants from options. p_names is up to three option names; p_values is
-- an array of arrays, the values of each option in order. Every combination
-- the product does not have yet is made, at the product's price and cost.
-- Run again after adding a value, it makes only the new lines: that is how it
-- is meant to be used. Returns {created, existing}.
create or replace function variants_generate(p_tenant uuid, p_item uuid, p_names text[], p_values jsonb)
returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_item items%rowtype;
  v_n int := coalesce(array_length(p_names, 1), 0);
  v_names text[] := '{}';
  v_name text;
  v_vals text[];
  v1 text[]; v2 text[]; v3 text[];
  v_live int;
  v_total int;
  v_created int;
  i int;
begin
  select * into v_item from items where tenant_id = p_tenant and id = p_item and deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if v_n < 1 or v_n > 3 or p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) <> v_n then
    raise exception 'bad-options';
  end if;
  select count(*) into v_live from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null;
  -- a product that has variants keeps its number of options: a line cannot
  -- stand for two values beside lines that stand for three
  if v_live > 0 and coalesce(array_length(v_item.option_names, 1), 0) <> v_n then raise exception 'bad-options'; end if;

  for i in 1..v_n loop
    v_name := btrim(coalesce(p_names[i], ''));
    if v_name = '' or exists (select 1 from unnest(v_names) x where lower(x) = lower(v_name)) then
      raise exception 'bad-options';
    end if;
    v_names := v_names || v_name;
    if jsonb_typeof(p_values->(i - 1)) <> 'array' then raise exception 'bad-options'; end if;
    select array_agg(btrim(x) order by ord) into v_vals
      from jsonb_array_elements_text(p_values->(i - 1)) with ordinality as t(x, ord);
    if v_vals is null
       or exists (select 1 from unnest(v_vals) x where x = '')
       or (select count(distinct lower(x)) from unnest(v_vals) x) <> array_length(v_vals, 1) then
      raise exception 'bad-options';
    end if;
    if i = 1 then v1 := v_vals; elsif i = 2 then v2 := v_vals; else v3 := v_vals; end if;
  end loop;

  v_total := array_length(v1, 1) * coalesce(array_length(v2, 1), 1) * coalesce(array_length(v3, 1), 1);
  if v_total > 200 then raise exception 'too-many-variants'; end if;
  -- stock held by the product itself would belong to no line once it has lines
  if v_live = 0 and (coalesce(v_item.stock_qty, 0) <> 0
      or exists (select 1 from stock_levels where tenant_id = p_tenant and item_id = p_item and qty <> 0)) then
    raise exception 'has-stock';
  end if;

  update items set option_names = v_names where tenant_id = p_tenant and id = p_item;
  with combos as (
    select array_remove(array[a, b, c], null) as vals
      from unnest(v1) as o1(a)
      cross join unnest(coalesce(v2, array[null::text])) as o2(b)
      cross join unnest(coalesce(v3, array[null::text])) as o3(c)
  ), missing as (
    select k.vals,
           case when v_item.sku is null then null
                else v_item.sku || '-' || upper(regexp_replace(array_to_string(k.vals, '-'), '[^A-Za-z0-9-]', '', 'g')) end as sku
      from combos k
     where not exists (select 1 from item_variants v
                        where v.tenant_id = p_tenant and v.item_id = p_item and v.deleted_at is null and v.option_values = k.vals)
  )
  insert into item_variants (tenant_id, item_id, name, price, cost, option_values, sku)
    select p_tenant, p_item, array_to_string(m.vals, ' / '), v_item.price, v_item.cost, m.vals,
           -- a SKU of its own when that SKU is free and no other new line would take the same one
           case when m.sku is not null
                 and count(*) over (partition by lower(m.sku)) = 1
                 and not exists (select 1 from items i where i.tenant_id = p_tenant and lower(i.sku) = lower(m.sku) and i.deleted_at is null)
                 and not exists (select 1 from item_variants v where v.tenant_id = p_tenant and lower(v.sku) = lower(m.sku) and v.deleted_at is null)
                then m.sku end
      from missing m;
  get diagnostics v_created = row_count;
  if v_live + v_created > 200 then raise exception 'too-many-variants'; end if;
  return jsonb_build_object('created', v_created, 'existing', v_total - v_created);
end $fn$;

-- 7. A variant is removed only when it holds no stock: otherwise what is on
-- the shelf would drop out of the stock value without a word. With its last
-- variant gone, a product is a simple one again.
create or replace function variant_archive(p_tenant uuid, p_variant uuid) returns void
language plpgsql set search_path = public as $fn$
declare
  v_item uuid;
begin
  select item_id into v_item from item_variants where tenant_id = p_tenant and id = p_variant and deleted_at is null;
  if not found then raise exception 'unknown-variant'; end if;
  if exists (select 1 from stock_levels where tenant_id = p_tenant and variant_id = p_variant and qty <> 0) then
    raise exception 'has-stock';
  end if;
  update item_variants set deleted_at = now() where tenant_id = p_tenant and id = p_variant;
  if not exists (select 1 from item_variants where tenant_id = p_tenant and item_id = v_item and deleted_at is null) then
    update items set option_names = '{}' where tenant_id = p_tenant and id = v_item;
  end if;
end $fn$;

-- 8. The level of one product in one shop (0067), with one change: a
-- variant's first level starts at the variant's own cost when it has one.
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
           coalesce((select v.cost from item_variants v where v.tenant_id = p_tenant and v.id = p_variant), i.cost, 0)
      from items i where i.tenant_id = p_tenant and i.id = p_item
    on conflict do nothing;
  select * into v_level from stock_levels
   where tenant_id = p_tenant and store_id = p_store and item_id = p_item
     and coalesce(variant_id, v_zero) = coalesce(p_variant, v_zero)
   for update;
  if not found then raise exception 'unknown-item'; end if;
  return v_level;
end $fn$;

-- 9. The reorder level and the usual order quantity of a product, put on
-- every line of it in one shop (its variants, or itself when it has none).
-- A line that has never moved gets its level now, at zero. Returns the number
-- of lines.
create or replace function stock_set_reorder(p_tenant uuid, p_store uuid, p_item uuid, p_point integer, p_qty integer)
returns integer
language plpgsql set search_path = public as $fn$
declare
  v_level stock_levels%rowtype;
  v_has_variants boolean;
  v_n int := 0;
  r record;
begin
  if (p_point is not null and p_point < 0) or (p_qty is not null and p_qty < 0) then raise exception 'bad-reorder'; end if;
  v_has_variants := exists (select 1 from item_variants
    where tenant_id = p_tenant and item_id = p_item and deleted_at is null);
  for r in
    select v.id as variant from item_variants v
     where v.tenant_id = p_tenant and v.item_id = p_item and v.deleted_at is null
    union all
    select null::uuid where not v_has_variants
    order by 1
  loop
    v_level := stock_level_for(p_tenant, p_store, p_item, r.variant);
    update stock_levels set reorder_point = p_point, reorder_qty = p_qty where id = v_level.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $fn$;
