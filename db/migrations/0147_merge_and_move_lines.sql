-- 0147_merge_and_move_lines.sql — EasyPay in Claude, release 1b (spec 2026-10-29, Q16, Q32, Q33): two
-- lines that a tidy makes the same become one, and lines move from one product to another.
--
-- variant_merge(tenant, keep, drop, employee): two lines of one product. What the dropped one holds at
-- each branch goes to the kept one, as a pair of movements (adjust: "merged into", "merged from"), and
-- the dropped line is deleted. Its barcode stops scanning (the card says so before Confirm). Refused:
-- 'unknown-variant', 'not-same-product'.
--
-- variants_move(tenant, lines, to_item, drop_option): lines go to another product and stay themselves:
-- the same ids, so each keeps its barcode, SKU, price, cost, picture, its stock at every branch and its
-- movements (they follow it: item_id is the new product's on each). drop_option (1 to 3, or null) is
-- an option the lines lose on the way, as when Chemise Long Sleeve is split by Style into Long Sleeve
-- Stripe, which has only Colour and Age. Receipts keep the name they printed. Refused: 'unknown-item',
-- 'unknown-variant' (a line not of this business, or deleted), 'options-differ' (the lines' values, the
-- option dropped, don't fit the product's options), 'value-taken' (a moved line would have the values of
-- a line the product has, or of another moved line; the detail names it), 'too-many-variants' (1000).
-- Nothing moves when one is refused.

create or replace function variant_merge(p_tenant uuid, p_keep uuid, p_drop uuid, p_emp uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  k item_variants%rowtype; d item_variants%rowtype; l record; v_moved int := 0;
begin
  select * into k from item_variants where tenant_id = p_tenant and id = p_keep and deleted_at is null;
  select * into d from item_variants where tenant_id = p_tenant and id = p_drop and deleted_at is null;
  if k.id is null or d.id is null or k.id = d.id then raise exception 'unknown-variant'; end if;
  if k.item_id <> d.item_id then raise exception 'not-same-product'; end if;
  for l in select store_id, qty from stock_levels where tenant_id = p_tenant and variant_id = p_drop and deleted_at is null and qty <> 0 loop
    perform stock_move(p_tenant, l.store_id, d.item_id, d.id, -l.qty, 'adjust', null, null, null, p_emp, left('Merged into ' || k.name, 200));
    perform stock_move(p_tenant, l.store_id, k.item_id, k.id, l.qty, 'adjust', null, null, null, p_emp, left('Merged from ' || d.name, 200));
    v_moved := v_moved + l.qty;
  end loop;
  update item_variants set deleted_at = now() where tenant_id = p_tenant and id = p_drop;
  return jsonb_build_object('moved', v_moved, 'barcode_lost', d.barcode);
end $fn$;

create or replace function variants_move(p_tenant uuid, p_lines uuid[], p_to uuid, p_drop_option integer) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_names text[]; v_n int; v_clash text;
begin
  select coalesce(option_names, '{}') into v_names from items where tenant_id = p_tenant and id = p_to and deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if p_drop_option is not null and p_drop_option not between 1 and 3 then raise exception 'bad-options'; end if;
  if (select count(*) from item_variants where tenant_id = p_tenant and id = any(p_lines) and deleted_at is null) <> coalesce(array_length(p_lines, 1), 0) then
    raise exception 'unknown-variant';
  end if;
  drop table if exists _mv;
  create temp table _mv on commit drop as
    select v.id, v.item_id as was,
           case when p_drop_option is null then v.option_values
                else v.option_values[1:p_drop_option - 1] || v.option_values[p_drop_option + 1:] end as vals
      from item_variants v where v.tenant_id = p_tenant and v.id = any(p_lines);
  if exists (select 1 from _mv where coalesce(array_length(vals, 1), 0) <> coalesce(array_length(v_names, 1), 0)) then
    raise exception 'options-differ';
  end if;
  select array_to_string(m.vals, ' / ') into v_clash from _mv m
   where exists (select 1 from item_variants o where o.tenant_id = p_tenant and o.item_id = p_to and o.deleted_at is null
                   and o.id <> m.id and lower(o.option_values::text) = lower(m.vals::text))
      or (select count(*) from _mv x where lower(x.vals::text) = lower(m.vals::text)) > 1
   limit 1;
  if v_clash is not null then raise exception using message = 'value-taken', detail = v_clash; end if;
  select count(*) into v_n from item_variants where tenant_id = p_tenant and item_id = p_to and deleted_at is null and not (id = any(p_lines));
  if v_n + coalesce(array_length(p_lines, 1), 0) > 1000 then raise exception 'too-many-variants'; end if;
  update item_variants v set item_id = p_to, option_values = m.vals, name = array_to_string(m.vals, ' / ')
    from _mv m where v.tenant_id = p_tenant and v.id = m.id;
  update stock_levels l set item_id = p_to from _mv m where l.tenant_id = p_tenant and l.variant_id = m.id;
  update stock_movements s set item_id = p_to from _mv m where s.tenant_id = p_tenant and s.variant_id = m.id;
  return coalesce(array_length(p_lines, 1), 0);
end $fn$;
