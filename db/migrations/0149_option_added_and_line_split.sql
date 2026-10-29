-- 0149_option_added_and_line_split.sql — a product counted by size alone is given its colours later (the owner of
-- Kids Corner, 2026-10-29: "we have x product quantity 10, then they will say 3 is blue 7 is red").
--
-- variant_option_add(tenant, item, name, value): a product that has lines gains an option, and every line of it
-- takes the one value given (EasyPay in Claude gives Mixed: "10" becomes "10 / Mixed"). Until now a product with
-- lines kept its number of options (variants_generate refuses). The lines keep their ids, barcodes, stock and
-- history; deleted lines take the value too, so one brought back fits. Refused: 'unknown-item'; 'no-lines' (a
-- product with none is given its options by Make every combination); 'bad-options' (no name or value, one over 30
-- characters, a name it has already, or three options already).
--
-- variant_option_drop(tenant, item, option): the other way, for Restore: refused 'values-differ' unless every
-- live line has the same value at that option, and 'bad-options' for its only option.
--
-- variant_split(tenant, from, option, parts, store, employee, drop_empty): a line's pieces at a branch said by the
-- values of one option: parts is [{value, qty (thousandths), barcode, sku, price (cents)}]. Each part's line (the
-- from line's values with that option's value replaced) is the one the product has, or is made by variant_add (its
-- spelling, its barcode guard, the product's 1000 lines), at the from line's price and cost unless given its own.
-- The pieces move as a pair of stock moves (adjust: "Split into", "Split from"), so the history says where they
-- went. With drop_empty, a from line left holding nothing at any branch is deleted. Refused: 'unknown-variant';
-- 'bad-options' (no such option, a value empty or over 30 characters, or the from line's own); 'bad-parts' (none,
-- or one value twice); 'bad-number' (a quantity below zero); 'not-enough' (the parts add up to more than the from
-- line holds at the branch; the detail says how much it holds). Nothing moves when one is refused.
-- Never edit after merge.

create or replace function variant_option_add(p_tenant uuid, p_item uuid, p_name text, p_value text) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_item items%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_value text := btrim(coalesce(p_value, ''));
begin
  select * into v_item from items where tenant_id = p_tenant and id = p_item and deleted_at is null for update;
  if not found then raise exception 'unknown-item'; end if;
  if not exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null) then
    raise exception 'no-lines';
  end if;
  if v_name = '' or length(v_name) > 30 or v_value = '' or length(v_value) > 30
     or coalesce(array_length(v_item.option_names, 1), 0) >= 3
     or exists (select 1 from unnest(coalesce(v_item.option_names, '{}')) o where lower(o) = lower(v_name)) then
    raise exception 'bad-options';
  end if;
  update items set option_names = coalesce(option_names, '{}') || v_name where tenant_id = p_tenant and id = p_item;
  update item_variants set option_values = coalesce(option_values, '{}') || v_value,
                           name = array_to_string(coalesce(option_values, '{}') || v_value, ' / ')
   where tenant_id = p_tenant and item_id = p_item;
  return (select count(*)::int from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null);
end $fn$;

create or replace function variant_option_drop(p_tenant uuid, p_item uuid, p_option integer) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_item items%rowtype;
  v_n int;
begin
  select * into v_item from items where tenant_id = p_tenant and id = p_item and deleted_at is null for update;
  if not found then raise exception 'unknown-item'; end if;
  v_n := coalesce(array_length(v_item.option_names, 1), 0);
  if p_option is null or p_option < 1 or p_option > v_n or v_n < 2 then raise exception 'bad-options'; end if;
  if (select count(distinct lower(option_values[p_option])) from item_variants
       where tenant_id = p_tenant and item_id = p_item and deleted_at is null) > 1 then
    raise exception 'values-differ';
  end if;
  update items set option_names = option_names[1:p_option - 1] || option_names[p_option + 1:] where tenant_id = p_tenant and id = p_item;
  update item_variants set option_values = option_values[1:p_option - 1] || option_values[p_option + 1:],
                           name = array_to_string(option_values[1:p_option - 1] || option_values[p_option + 1:], ' / ')
   where tenant_id = p_tenant and item_id = p_item;
  return (select count(*)::int from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null);
end $fn$;

create or replace function variant_split(p_tenant uuid, p_from uuid, p_option integer, p_parts jsonb, p_store uuid, p_emp uuid,
                                         p_drop_empty boolean) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  f item_variants%rowtype;
  part jsonb;
  v_value text;
  v_vals text[];
  v_to uuid;
  v_to_name text;
  v_qty int;
  v_held numeric;
  v_left numeric;
  v_made jsonb := '[]'::jsonb;
  v_created boolean;
  v_dropped boolean := false;
begin
  select * into f from item_variants where tenant_id = p_tenant and id = p_from and deleted_at is null for update;
  if not found then raise exception 'unknown-variant'; end if;
  if p_option is null or p_option < 1 or p_option > coalesce(array_length(f.option_values, 1), 0) then raise exception 'bad-options'; end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0
     or (select count(distinct lower(btrim(x->>'value'))) from jsonb_array_elements(p_parts) x) <> jsonb_array_length(p_parts) then
    raise exception 'bad-parts';
  end if;
  if exists (select 1 from jsonb_array_elements(p_parts) x
              where btrim(coalesce(x->>'value', '')) = '' or length(btrim(x->>'value')) > 30
                 or lower(btrim(x->>'value')) = lower(f.option_values[p_option])) then
    raise exception 'bad-options';
  end if;
  if exists (select 1 from jsonb_array_elements(p_parts) x where coalesce((x->>'qty')::int, 0) < 0) then raise exception 'bad-number'; end if;
  select coalesce(sum(qty), 0) into v_held from stock_levels
   where tenant_id = p_tenant and variant_id = p_from and store_id = p_store and deleted_at is null;
  if (select coalesce(sum((x->>'qty')::int), 0) from jsonb_array_elements(p_parts) x) > v_held then
    raise exception using message = 'not-enough', detail = v_held::text;
  end if;

  for part in select x from jsonb_array_elements(p_parts) x loop
    v_value := btrim(part->>'value');
    v_vals := f.option_values;
    v_vals[p_option] := v_value;
    select id into v_to from item_variants
     where tenant_id = p_tenant and item_id = f.item_id and deleted_at is null and lower(option_values::text) = lower(v_vals::text);
    v_created := v_to is null;
    if v_created then
      v_to := variant_add(p_tenant, f.item_id, v_vals, coalesce((part->>'price')::bigint, f.price), f.cost,
                          part->>'sku', part->>'barcode', null, null, p_emp);
    end if;
    select name into v_to_name from item_variants where id = v_to;
    v_qty := coalesce((part->>'qty')::int, 0);
    if v_qty > 0 then
      perform stock_move(p_tenant, p_store, f.item_id, f.id, -v_qty, 'adjust', null, null, null, p_emp, left('Split into ' || v_to_name, 200));
      perform stock_move(p_tenant, p_store, f.item_id, v_to, v_qty, 'adjust', null, null, null, p_emp, left('Split from ' || f.name, 200));
    end if;
    v_made := v_made || jsonb_build_object('line', v_to, 'name', v_to_name, 'created', v_created, 'qty', v_qty);
  end loop;

  select coalesce(sum(qty), 0) into v_left from stock_levels where tenant_id = p_tenant and variant_id = p_from and deleted_at is null;
  if p_drop_empty and not exists (select 1 from stock_levels where tenant_id = p_tenant and variant_id = p_from and deleted_at is null and qty <> 0) then
    update item_variants set deleted_at = now() where tenant_id = p_tenant and id = p_from;
    v_dropped := true;
  end if;
  return jsonb_build_object('lines', v_made, 'left', v_left, 'dropped', v_dropped, 'barcode', f.barcode);
end $fn$;
