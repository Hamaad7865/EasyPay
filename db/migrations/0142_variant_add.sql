-- 0142_variant_add.sql — one line added to a product that has variants (the back office's product page,
-- docs/superpowers/specs/2026-10-28-add-variant-and-pictures-design.md, part 1).
--
-- variants_generate makes every combination of the values it is given that the product lacks: a shop's
-- dress with 40 colours, 21 ages and 10 styles given one new colour makes 210 lines and is refused over
-- 200. This makes the one line asked for, at the product's price and cost unless given its own, with its
-- SKU and barcode (the catalog's guard refuses one taken), and an opening stock at a branch when a
-- quantity is given.
--
-- A value typed that is one of the option's values already, but for its case, takes the spelling the
-- product uses (plain becomes Plain), so the list of values does not fill with doubles.
--
-- Refused: 'unknown-item'; 'bad-options' for a product with no options, or values that are not one per
-- option, or one empty or over 30 characters (the product page's limit); 'variant-exists' when a line
-- has those values, case aside; 'too-many-variants' past 200 lines; 'stock-not-counted' for a quantity
-- on a product that counts no stock; 'bad-number' for a quantity or a price below zero.

create or replace function variant_add(p_tenant uuid, p_item uuid, p_values text[], p_price bigint, p_cost bigint,
                                       p_sku text, p_barcode text, p_store uuid, p_qty integer, p_emp uuid)
returns uuid
language plpgsql set search_path = public as $fn$
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
  if (select count(*) from item_variants x where x.tenant_id = p_tenant and x.item_id = p_item and x.deleted_at is null) >= 200 then
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
end $fn$;
