-- 0144_variants_up_to_1000.sql — a product may have 1000 lines, not 200 (the owner, 2026-10-28: "Raise it to 1000").
--
-- A shop's shirt in many colours, ages and styles comes near 200 lines, and a file that takes it past them
-- is refused whole: "That would make more than 200 lines for one product." The same limit is raised in
-- each place that makes lines: the import (catalog_import), Make every combination
-- (variants_generate), a till making them (push_variants_make), a till saving a product's lines
-- (push_variants_save: as many in one send) and Add a variant (variant_add). Nothing
-- else changes.
--
-- Source: each is its live definition on dev on 2026-10-28 (pg_get_functiondef), with only the lines of the
-- limit changed. Never edit after merge.

CREATE OR REPLACE FUNCTION public.catalog_import(p_tenant uuid, p_store uuid, p_emp uuid, p_rows jsonb, p_dry boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_batch uuid := gen_random_uuid();
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_item uuid; v_cat uuid; v_sup uuid; v_var uuid; v_tax uuid;
  v_rows int; v_good int;
  v_products int := 0; v_lines int := 0; v_new_products int := 0; v_new_lines int := 0;
  v_stock_set int := 0; v_stock_skipped int := 0;
  v_problems jsonb;
  v_new_cats jsonb; v_back_cats jsonb; v_new_sups jsonb;
  p record; r record;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'bad-rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too-many-rows'; end if;

  drop table if exists _imp;
  create temp table _imp on commit drop as
    select coalesce((x.r->>'n')::int, x.ord::int) as n,
           x.ord::int as ord,
           nullif(btrim(x.r->>'name'), '') as name,
           nullif(btrim(x.r->>'category'), '') as category,
           nullif(btrim(x.r->>'brand'), '') as brand,
           nullif(btrim(x.r->>'supplier'), '') as supplier,
           nullif(btrim(x.r->>'supplier_code'), '') as supplier_code,
           nullif(btrim(x.r->>'sku'), '') as sku,
           nullif(regexp_replace(coalesce(x.r->>'barcode', ''), '\s', '', 'g'), '') as barcode,
           nullif(btrim(x.r->>'tax'), '') as tax,
           nullif(btrim(x.r->>'o1'), '') as o1, nullif(btrim(x.r->>'v1'), '') as v1,
           nullif(btrim(x.r->>'o2'), '') as o2, nullif(btrim(x.r->>'v2'), '') as v2,
           nullif(btrim(x.r->>'o3'), '') as o3, nullif(btrim(x.r->>'v3'), '') as v3,
           (x.r->>'price')::bigint as price,
           (x.r->>'cost')::bigint as cost,
           (x.r->>'reorder')::int as reorder,
           (x.r->>'order_qty')::int as order_qty,
           (x.r->>'stock')::int as stock,
           -- how it is sold and whether it counts stock (0131); not said: as before
           nullif(lower(btrim(x.r->>'sold_by')), '') as sold_by,
           case when jsonb_typeof(x.r->'count_stock') = 'boolean' then (x.r->>'count_stock')::boolean end as count_stock,
           x.r ? 'count_stock' and jsonb_typeof(x.r->'count_stock') not in ('boolean', 'null') as count_bad,
           nullif(btrim(x.r->>'bad'), '') as why,
           null::text[] as names, null::text[] as vals,
           null::uuid as item_id, null::uuid as variant_id, null::uuid as tax_id
      from jsonb_array_elements(p_rows) with ordinality as x(r, ord);
  update _imp set names = array_remove(array[o1, o2, o3], null), vals = array_remove(array[v1, v2, v3], null);
  -- The checks below look, for every row, at the other rows of its product and
  -- at the rows with its barcode or its SKU. Without these that is every row
  -- against every row: 18 seconds for a file of 5,000 (0081).
  create index on _imp (lower(name));
  create index on _imp (barcode);
  create index on _imp (lower(sku));
  analyze _imp;

  -- the row on its own
  update _imp set why = 'name-missing' where why is null and name is null;
  update _imp set why = 'bad-options' where why is null and (
       (o1 is null) <> (v1 is null) or (o2 is null) <> (v2 is null) or (o3 is null) <> (v3 is null)
    or (o1 is null and (o2 is not null or o3 is not null)) or (o2 is null and o3 is not null)
    or (select count(distinct lower(x)) from unnest(names) x) <> coalesce(array_length(names, 1), 0));
  update _imp set why = 'bad-sold-by' where why is null and sold_by is not null and sold_by not in ('each', 'weight', 'open');
  update _imp set why = 'bad-count-stock' where why is null and count_bad;
  -- one whose price is typed at the sale needs none in the file (0131)
  update _imp set why = 'price-missing' where why is null and ((price is null and sold_by is distinct from 'open') or price < 0);
  update _imp set why = 'bad-number' where why is null
     and (cost < 0 or reorder < 0 or order_qty < 0 or stock < 0);
  -- an opening stock for a product that counts none
  update _imp set why = 'stock-not-counted' where why is null and coalesce(stock, 0) > 0 and (sold_by = 'open' or count_stock = false);
  -- a price typed at the sale is not for a product with variants
  update _imp set why = 'open-price-not-here' where why is null and sold_by = 'open' and coalesce(array_length(vals, 1), 0) > 0;
  update _imp i set tax_id = (select t.id from taxes t where t.tenant_id = p_tenant and t.deleted_at is null and lower(t.name) = lower(i.tax) limit 1)
   where i.tax is not null;
  update _imp set why = 'tax-unknown' where why is null and tax is not null and tax_id is null;

  -- the rows of one product, against each other
  update _imp i set why = 'options-differ' where why is null and exists (
    select 1 from _imp o where lower(o.name) = lower(i.name) and o.ord <> i.ord
       and lower(o.names::text) <> lower(i.names::text));
  update _imp i set why = 'duplicate-line' where why is null and exists (
    select 1 from _imp o where lower(o.name) = lower(i.name) and o.ord <> i.ord
       and lower(o.vals::text) = lower(i.vals::text));

  -- against what the shop already has
  update _imp i set item_id = (select x.id from items x
     where x.tenant_id = p_tenant and x.deleted_at is null and lower(x.name) = lower(i.name) order by x.created_at limit 1)
   where i.name is not null;
  update _imp i set variant_id = (select v.id from item_variants v
     where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null
       and lower(v.option_values::text) = lower(i.vals::text) limit 1)
   where i.item_id is not null and coalesce(array_length(i.vals, 1), 0) > 0;
  -- a product that has variants keeps their number of options; a simple one is not given lines by a file while it holds stock
  update _imp i set why = 'options-differ' where why is null and i.item_id is not null and exists (
    select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null)
    and coalesce(array_length(i.names, 1), 0) <> (select coalesce(array_length(x.option_names, 1), 0) from items x where x.id = i.item_id);
  update _imp i set why = 'has-stock' where why is null and i.item_id is not null and coalesce(array_length(i.vals, 1), 0) > 0
    and not exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null)
    and (exists (select 1 from items x where x.id = i.item_id and coalesce(x.stock_qty, 0) <> 0)
      or exists (select 1 from stock_levels l where l.tenant_id = p_tenant and l.item_id = i.item_id and l.qty <> 0));

  -- how an existing product is sold (0131): at the sale is not for one with variants, and
  -- a kilo is not a piece while it counts stock and holds some
  update _imp i set why = 'open-price-not-here' where why is null and i.item_id is not null and i.sold_by = 'open'
    and exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null);
  update _imp i set why = 'unit-has-stock' where why is null and i.item_id is not null and i.sold_by in ('each', 'weight')
    and exists (select 1 from items x where x.id = i.item_id and x.sold_by <> i.sold_by and coalesce(i.count_stock, x.track_stock))
    and item_holds_stock(p_tenant, i.item_id);

  -- codes: one line each, in the file and in the shop
  update _imp i set why = 'barcode-twice' where why is null and barcode is not null
     and (select count(*) from _imp o where o.barcode = i.barcode) > 1;
  update _imp i set why = 'sku-twice' where why is null and sku is not null
     and (select count(*) from _imp o where lower(o.sku) = lower(i.sku)) > 1;
  update _imp i set why = 'barcode-taken' where why is null and barcode is not null and (
       exists (select 1 from items x where x.tenant_id = p_tenant and x.deleted_at is null and x.barcode = i.barcode
                 and not (i.variant_id is null and coalesce(array_length(i.vals, 1), 0) = 0 and x.id = coalesce(i.item_id, v_zero)))
    or exists (select 1 from item_variants v join items x on x.id = v.item_id and x.deleted_at is null
                where v.tenant_id = p_tenant and v.deleted_at is null and v.barcode = i.barcode and v.id <> coalesce(i.variant_id, v_zero)));
  update _imp i set why = 'sku-taken' where why is null and sku is not null and (
       exists (select 1 from items x where x.tenant_id = p_tenant and x.deleted_at is null and lower(x.sku) = lower(i.sku)
                 and not (i.variant_id is null and coalesce(array_length(i.vals, 1), 0) = 0 and x.id = coalesce(i.item_id, v_zero)))
    or exists (select 1 from item_variants v join items x on x.id = v.item_id and x.deleted_at is null
                where v.tenant_id = p_tenant and v.deleted_at is null and lower(v.sku) = lower(i.sku) and v.id <> coalesce(i.variant_id, v_zero)));
  update _imp i set why = 'too-many-variants' where why is null and coalesce(array_length(i.vals, 1), 0) > 0
     and (select count(*) from _imp o where lower(o.name) = lower(i.name) and o.variant_id is null)
       + coalesce((select count(*) from item_variants v where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null), 0) > 1000;

  -- a product arrives whole or not at all
  update _imp i set why = 'product-has-problems' where why is null and exists (
    select 1 from _imp o where lower(o.name) = lower(i.name) and o.why is not null);

  select count(*), count(*) filter (where why is null) into v_rows, v_good from _imp;
  select coalesce(jsonb_agg(jsonb_build_object('n', q.n, 'name', q.name, 'why', q.why) order by q.ord), '[]'::jsonb) into v_problems
    from (select n, ord, name, why from _imp where why is not null order by ord) q;
  select count(distinct lower(name)), count(distinct lower(name)) filter (where item_id is null),
         count(*), count(*) filter (where (coalesce(array_length(vals, 1), 0) > 0 and variant_id is null) or (coalesce(array_length(vals, 1), 0) = 0 and item_id is null))
    into v_products, v_new_products, v_lines, v_new_lines
    from _imp where why is null;

  -- What the file would add besides products (0081): the categories and the
  -- suppliers it names that the shop does not have, and the categories it
  -- would bring back (a category that was removed keeps its name, so a file
  -- that names it gets it back). Worked out as the import below makes them:
  -- from the first row of each product that is going in, names compared
  -- without regard to case, each written the way the first product to name it
  -- writes it.
  with firsts as (
    select distinct on (lower(name)) lower(name) as key, category, supplier from _imp where why is null order by lower(name), ord
  ), cats as (
    select distinct on (lower(category)) category as name from firsts where category is not null order by lower(category), key
  ), sups as (
    select distinct on (lower(supplier)) supplier as name from firsts where supplier is not null order by lower(supplier), key
  )
  select coalesce((select jsonb_agg(x.name order by lower(x.name)) from cats x
            where not exists (select 1 from categories k where k.tenant_id = p_tenant and lower(k.name) = lower(x.name))), '[]'::jsonb),
         coalesce((select jsonb_agg(x.name order by lower(x.name)) from cats x
            where exists (select 1 from categories k where k.tenant_id = p_tenant and lower(k.name) = lower(x.name))
              and not exists (select 1 from categories k where k.tenant_id = p_tenant and lower(k.name) = lower(x.name) and k.deleted_at is null)), '[]'::jsonb),
         coalesce((select jsonb_agg(x.name order by lower(x.name)) from sups x
            where not exists (select 1 from suppliers s where s.tenant_id = p_tenant and lower(s.name) = lower(x.name) and s.deleted_at is null)), '[]'::jsonb)
    into v_new_cats, v_back_cats, v_new_sups;

  if p_dry then
    return jsonb_build_object('dry', true, 'rows', v_rows, 'good', v_good, 'products', v_products, 'new_products', v_new_products,
      'lines', v_lines, 'new_lines', v_new_lines, 'problems', v_problems,
      'new_categories', v_new_cats, 'revived_categories', v_back_cats, 'new_suppliers', v_new_sups);
  end if;

  -- the products, each from its first row
  for p in
    select distinct on (lower(name)) lower(name) as key, name, category, brand, supplier, supplier_code, tax_id, price, cost, sku, barcode,
           item_id, names, coalesce(array_length(vals, 1), 0) > 0 as has_lines, sold_by, count_stock
      from _imp where why is null order by lower(name), ord
  loop
    v_cat := null; v_sup := null;
    if p.category is not null then
      select id into v_cat from categories where tenant_id = p_tenant and lower(name) = lower(p.category) order by deleted_at nulls first limit 1;
      if v_cat is null then
        insert into categories (tenant_id, name, sort_order)
          values (p_tenant, p.category, (select coalesce(max(sort_order), -1) + 1 from categories where tenant_id = p_tenant))
          returning id into v_cat;
      else
        update categories set deleted_at = null where id = v_cat and deleted_at is not null;
      end if;
    end if;
    if p.supplier is not null then
      select id into v_sup from suppliers where tenant_id = p_tenant and lower(name) = lower(p.supplier) and deleted_at is null limit 1;
      if v_sup is null then
        insert into suppliers (tenant_id, name) values (p_tenant, p.supplier) returning id into v_sup;
      end if;
    end if;

    v_item := p.item_id;
    if v_item is null then
      insert into items (tenant_id, name, price, cost, category_id, brand, supplier_id, supplier_code, track_stock, is_available, sku, barcode,
                         sold_by, open_price)
        values (p_tenant, p.name, case when p.sold_by = 'open' then 0 else p.price end, p.cost, v_cat, p.brand, v_sup, p.supplier_code,
                case when p.sold_by = 'open' then false else coalesce(p.count_stock, true) end, true,
                case when p.has_lines then null else p.sku end, case when p.has_lines then null else p.barcode end,
                case when p.sold_by = 'weight' then 'weight' else 'each' end, p.sold_by is not distinct from 'open')
        returning id into v_item;
    else
      -- a product with lines keeps its own price and cost: the file prices its lines, and a line
      -- the file does not name must not follow whichever row happened to come first
      update items set price = case when p.has_lines then price when p.sold_by = 'open' then 0 else p.price end,
             -- how it is sold and whether it counts stock: only when the file says (0131)
             sold_by = case when p.sold_by is null then sold_by when p.sold_by = 'weight' then 'weight' else 'each' end,
             open_price = case when p.sold_by is null then open_price else p.sold_by = 'open' end,
             track_stock = case when p.sold_by = 'open' then false when p.count_stock is not null then p.count_stock else track_stock end,
             cost = case when p.has_lines then cost else coalesce(p.cost, cost) end, category_id = coalesce(v_cat, category_id),
             brand = coalesce(p.brand, brand), supplier_id = coalesce(v_sup, supplier_id), supplier_code = coalesce(p.supplier_code, supplier_code)
       where tenant_id = p_tenant and id = v_item;
      if not p.has_lines then
        update items set sku = coalesce(p.sku, sku), barcode = coalesce(p.barcode, barcode) where tenant_id = p_tenant and id = v_item;
      end if;
    end if;
    -- its one tax: the one the file names, or for a new product the shop's usual one
    v_tax := coalesce(p.tax_id, case when p.item_id is null then
      (select id from taxes where tenant_id = p_tenant and deleted_at is null order by is_default desc, rate_bp desc, name limit 1) end);
    if v_tax is not null then
      update item_taxes set deleted_at = now() where tenant_id = p_tenant and item_id = v_item and tax_id <> v_tax and deleted_at is null;
      insert into item_taxes (tenant_id, item_id, tax_id) values (p_tenant, v_item, v_tax)
        on conflict (item_id, tax_id) do update set deleted_at = null;
    end if;
    if p.has_lines then
      update items set option_names = p.names where tenant_id = p_tenant and id = v_item and coalesce(array_length(option_names, 1), 0) = 0;
    end if;

    -- its lines
    for r in select * from _imp where why is null and lower(name) = p.key order by ord loop
      v_var := r.variant_id;
      if p.has_lines then
        if v_var is null then
          insert into item_variants (tenant_id, item_id, name, price, cost, option_values, sku, barcode)
            values (p_tenant, v_item, array_to_string(r.vals, ' / '), r.price, r.cost, r.vals, r.sku, r.barcode)
            returning id into v_var;
        else
          update item_variants set price = r.price, cost = coalesce(r.cost, cost), sku = coalesce(r.sku, sku), barcode = coalesce(r.barcode, barcode)
           where tenant_id = p_tenant and id = v_var;
        end if;
      end if;
      if coalesce(r.stock, 0) > 0 then
        -- opening stock is for a line that holds nothing and has never moved. Movements alone do
        -- not say so: deleting all transactions removes them and leaves the quantities.
        -- at the branch the file is for (0137): another branch's stock is no reason to skip it. An item's
        -- total with no level anywhere is stock from before the engine, which no branch holds yet.
        if exists (select 1 from stock_movements m where m.tenant_id = p_tenant and m.item_id = v_item and m.store_id = p_store
                     and coalesce(m.variant_id, v_zero) = coalesce(v_var, v_zero))
           or exists (select 1 from stock_levels l where l.tenant_id = p_tenant and l.item_id = v_item and l.store_id = p_store
                        and coalesce(l.variant_id, v_zero) = coalesce(v_var, v_zero) and l.qty <> 0)
           or (v_var is null and not exists (select 1 from stock_levels l where l.tenant_id = p_tenant and l.item_id = v_item)
               and exists (select 1 from items x where x.tenant_id = p_tenant and x.id = v_item and coalesce(x.stock_qty, 0) <> 0)) then
          v_stock_skipped := v_stock_skipped + 1;
        else
          perform stock_move(p_tenant, p_store, v_item, v_var, r.stock, 'opening', r.cost, 'import', v_batch, p_emp, 'Imported');
          v_stock_set := v_stock_set + 1;
        end if;
      end if;
    end loop;

    -- the reorder level, on every line of it, when the file gives one
    select max(reorder) as point, max(order_qty) as qty into r from _imp where why is null and lower(name) = p.key;
    if r.point is not null or r.qty is not null then
      perform stock_set_reorder(p_tenant, p_store, v_item, r.point, r.qty);
    end if;
  end loop;

  return jsonb_build_object('dry', false, 'rows', v_rows, 'good', v_good, 'products', v_products, 'new_products', v_new_products,
    'lines', v_lines, 'new_lines', v_new_lines, 'stock_set', v_stock_set, 'stock_skipped', v_stock_skipped, 'problems', v_problems,
    'new_categories', v_new_cats, 'revived_categories', v_back_cats, 'new_suppliers', v_new_sups);
end $function$;

CREATE OR REPLACE FUNCTION public.variants_generate(p_tenant uuid, p_item uuid, p_names text[], p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  if v_total > 1000 then raise exception 'too-many-variants'; end if;
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
  if v_live + v_created > 1000 then raise exception 'too-many-variants'; end if;
  return jsonb_build_object('created', v_created, 'existing', v_total - v_created);
end $function$;

CREATE OR REPLACE FUNCTION public.push_variants_make(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item items%rowtype; v_id uuid; v_n int; v_names text[] := '{}'; v_name text;
  v_live int; v_created int := 0; v_existing int := 0;
  l jsonb; v_vid uuid; v_vals text[]; v_seen text[] := '{}'; v_key text; i int;
begin
  begin
    v_id := (p->>'item_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'names') is distinct from 'array' or jsonb_typeof(p->'lines') is distinct from 'array' then
    raise exception 'bad-payload';
  end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- two sends for one product wait their turn here
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select * into v_item from items where tenant_id = p_tenant and id = v_id and deleted_at is null for update;
  if not found then raise exception 'unknown-item'; end if;
  v_n := jsonb_array_length(p->'names');
  if v_n < 1 or v_n > 3 or jsonb_array_length(p->'lines') < 1 then raise exception 'bad-options'; end if;
  for i in 0..v_n - 1 loop
    v_name := btrim(coalesce(p->'names'->>i, ''));
    if v_name = '' or length(v_name) > 30 or exists (select 1 from unnest(v_names) x where lower(x) = lower(v_name)) then
      raise exception 'bad-options';
    end if;
    v_names := v_names || v_name;
  end loop;
  select count(*) into v_live from item_variants where tenant_id = p_tenant and item_id = v_id and deleted_at is null;
  -- a product that has variants keeps its number of options
  if v_live > 0 and coalesce(array_length(v_item.option_names, 1), 0) <> v_n then raise exception 'bad-options'; end if;
  -- stock held by the product itself would belong to no line once it has lines
  if v_live = 0 and (coalesce(v_item.stock_qty, 0) <> 0
      or exists (select 1 from stock_levels where tenant_id = p_tenant and item_id = v_id and qty <> 0)) then
    raise exception 'has-stock';
  end if;
  update items set option_names = v_names where tenant_id = p_tenant and id = v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    begin
      v_vid := (l->>'id')::uuid;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_vid is null or jsonb_typeof(l->'values') is distinct from 'array' or jsonb_array_length(l->'values') <> v_n then
      raise exception 'bad-options';
    end if;
    select array_agg(btrim(x) order by ord) into v_vals from jsonb_array_elements_text(l->'values') with ordinality as t(x, ord);
    if exists (select 1 from unnest(v_vals) x where x = '' or length(x) > 30) then raise exception 'bad-options'; end if;
    v_key := lower(array_to_string(v_vals, chr(31)));
    -- the same line twice in one send
    if v_key = any (v_seen) then raise exception 'bad-options'; end if;
    v_seen := v_seen || v_key;
    -- a line the product has already, by its values or by this id, is left as it is
    if exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = v_id and v.deleted_at is null
                and lower(array_to_string(v.option_values, chr(31))) = v_key)
       or exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.id = v_vid) then
      v_existing := v_existing + 1;
      continue;
    end if;
    insert into item_variants (id, tenant_id, item_id, name, price, cost, option_values)
      values (v_vid, p_tenant, v_id, array_to_string(v_vals, ' / '), v_item.price, v_item.cost, v_vals);
    v_created := v_created + 1;
  end loop;
  if v_live + v_created > 1000 then raise exception 'too-many-variants'; end if;
  -- a shop that has its barcodes made automatically: the new lines get theirs (0080; nothing otherwise)
  perform barcodes_auto(p_tenant, v_id);
  return jsonb_build_object('created', v_created, 'existing', v_existing);
end $function$;

CREATE OR REPLACE FUNCTION public.variant_add(p_tenant uuid, p_item uuid, p_values text[], p_price bigint, p_cost bigint, p_sku text, p_barcode text, p_store uuid, p_qty integer, p_emp uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_item items%rowtype;
  v_n int;
  v_vals text[] := '{}';
  v_val text;
  v_id uuid;
  i int;
begin
  select * into v_item from items where tenant_id = p_tenant and id = p_item and deleted_at is null for update;
  if not found then raise exception 'unknown-item'; end if;
  v_n := coalesce(array_length(v_item.option_names, 1), 0);
  if v_n = 0 or coalesce(array_length(p_values, 1), 0) <> v_n then raise exception 'bad-options'; end if;
  if coalesce(p_price, 0) < 0 or coalesce(p_cost, 0) < 0 or coalesce(p_qty, 0) < 0 then raise exception 'bad-number'; end if;
  if coalesce(p_qty, 0) > 0 and not v_item.track_stock then raise exception 'stock-not-counted'; end if;

  for i in 1..v_n loop
    v_val := btrim(coalesce(p_values[i], ''));
    if v_val = '' or length(v_val) > 30 then raise exception 'bad-options'; end if;
    -- the spelling the product already uses for it
    select x.option_values[i] into v_val from item_variants x
     where x.tenant_id = p_tenant and x.item_id = p_item and x.deleted_at is null and lower(x.option_values[i]) = lower(v_val)
     order by x.created_at limit 1;
    if not found then v_val := btrim(p_values[i]); end if;
    v_vals := v_vals || v_val;
  end loop;

  if exists (select 1 from item_variants x where x.tenant_id = p_tenant and x.item_id = p_item and x.deleted_at is null
               and lower(x.option_values::text) = lower(v_vals::text)) then
    raise exception 'variant-exists';
  end if;
  if (select count(*) from item_variants x where x.tenant_id = p_tenant and x.item_id = p_item and x.deleted_at is null) >= 1000 then
    raise exception 'too-many-variants';
  end if;

  insert into item_variants (tenant_id, item_id, name, price, cost, option_values, sku, barcode)
    values (p_tenant, p_item, array_to_string(v_vals, ' / '), coalesce(p_price, v_item.price), coalesce(p_cost, v_item.cost), v_vals,
            nullif(btrim(coalesce(p_sku, '')), ''), nullif(btrim(coalesce(p_barcode, '')), ''))
    returning id into v_id;
  if coalesce(p_qty, 0) > 0 and p_store is not null then
    perform stock_move(p_tenant, p_store, p_item, v_id, p_qty, 'opening', coalesce(p_cost, v_item.cost), null, null, p_emp, 'Added with the variant');
  end if;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.push_variants_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; l jsonb; v_vid uuid; v_cost bigint; v_may boolean; v_n int := 0;
begin
  begin
    v_id := (p->>'item_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') > 1000 then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- a cost is written only for someone who may see cost, or with the word of someone who may
  v_may := may(p_emp, p, 'costs.view');
  for l in select * from jsonb_array_elements(p->'lines') loop
    begin
      v_vid := (l->>'id')::uuid;
      v_cost := (l->>'cost')::bigint;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_vid is null or v_cost < 0 or v_cost > 100000000 or length(coalesce(l->>'barcode', '')) > 64 then raise exception 'bad-payload'; end if;
    update item_variants v set
        barcode = case when l ? 'barcode' then nullif(regexp_replace(coalesce(l->>'barcode', ''), '\s+', '', 'g'), '') else v.barcode end,
        sku = case when l ? 'sku' then nullif(left(btrim(coalesce(l->>'sku', '')), 60), '') else v.sku end,
        cost = case when l ? 'cost' and v_may then v_cost else v.cost end
     where v.tenant_id = p_tenant and v.item_id = v_id and v.id = v_vid and v.deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('saved', v_n);
end $function$;
