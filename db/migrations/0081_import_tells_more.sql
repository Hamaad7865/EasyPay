-- 0081_import_tells_more.sql
-- The catalog import (catalog_import, 0071 and 0072) says more before it
-- saves anything, and checks a large file in a second instead of eighteen.
--
-- A file that names a category or a supplier the shop does not have makes
-- one. That is wanted for a new range, and not for a spelling mistake: a
-- file with "Clothng" in one cell left the shop with a second category, and
-- the check before the import said nothing of it. The answer now carries:
--
--   new_categories       names of the categories the file would add
--   revived_categories   names of removed categories it would bring back
--   new_suppliers        names of the suppliers it would add
--
-- in the check and in the import alike, worked out the way the import makes
-- them (from the first row of each product that is going in).
--
-- problems holds every row with a problem, not the first 300: the import
-- screen makes a file of them to be corrected and imported again, and a file
-- of the first 300 sent its reader round once for every 300 mistakes.
--
-- The rows of the file sit in a work table for the length of the call, and
-- the checks compare each row with the others of its product and with the
-- rows that carry its barcode or its SKU. The table now has indexes for
-- those three questions. Measured on dev with a file of 5,000 rows (1,250
-- products of four lines): the check went from 17.8 s to 1.0 s, and the
-- import itself from 39.2 s to 19.4 s (what is left is the making of the
-- 5,000 lines and their opening stock, one at a time).
--
-- catalog_import as it is, with those changes. Nothing else of it is touched:
-- products are still found by their name.

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
  update _imp set why = 'price-missing' where why is null and (price is null or price < 0);
  update _imp set why = 'bad-number' where why is null
     and (cost < 0 or reorder < 0 or order_qty < 0 or stock < 0);
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
       + coalesce((select count(*) from item_variants v where v.tenant_id = p_tenant and v.item_id = i.item_id and v.deleted_at is null), 0) > 200;

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
           item_id, names, coalesce(array_length(vals, 1), 0) > 0 as has_lines
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
      insert into items (tenant_id, name, price, cost, category_id, brand, supplier_id, supplier_code, track_stock, is_available, sku, barcode)
        values (p_tenant, p.name, p.price, p.cost, v_cat, p.brand, v_sup, p.supplier_code, true, true,
                case when p.has_lines then null else p.sku end, case when p.has_lines then null else p.barcode end)
        returning id into v_item;
    else
      -- a product with lines keeps its own price and cost: the file prices its lines, and a line
      -- the file does not name must not follow whichever row happened to come first
      update items set price = case when p.has_lines then price else p.price end,
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
        if exists (select 1 from stock_movements m where m.tenant_id = p_tenant and m.item_id = v_item
                     and coalesce(m.variant_id, v_zero) = coalesce(v_var, v_zero))
           or exists (select 1 from stock_levels l where l.tenant_id = p_tenant and l.item_id = v_item
                        and coalesce(l.variant_id, v_zero) = coalesce(v_var, v_zero) and l.qty <> 0)
           or (v_var is null and exists (select 1 from items x where x.tenant_id = p_tenant and x.id = v_item and coalesce(x.stock_qty, 0) <> 0)) then
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
end $function$
;
