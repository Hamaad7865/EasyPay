-- 0152_lines_take_their_total.sql — a line moved to another product takes its share of the product's stock
-- total and its promotion with it (docs/superpowers/reviews/2026-11-03-bug-sweep.md, finding 1).
--
-- items.stock_qty is the item's total over every branch (0067, 0137: stock_move keeps it so). variants_move
-- (0147: a split, or a move, through Claude) re-pointed a line's stock_levels and stock_movements to the new
-- product and left both items' totals as they were: Chemise split by Style into three products kept its 30
-- pieces in its own total, and the three showed 0 on the products list, the dashboard's low stock and Stock
-- with All branches; Restore made the same error the other way. A promotion of a line (promotions.variant_id)
-- kept the old product's item_id, which is how promoTargets and promotion_apply look it up: the moved line
-- looked unpromoted, a second promotion could be put over the first with the promoted price as its
-- "original", and Lift never gave the real price back.
--
-- stock_rehome(tenant, lines, to_item): what a line holds goes with it. For each product the lines leave,
-- its total loses what they hold at every branch, and to_item's gains it; their levels, movements and
-- promotions then name to_item. Lines already in to_item are left alone. variants_move calls it, and so
-- does Restore of a split or a move (web/lib/assistant/changes.ts undo), so both directions agree.
--
-- Source: variants_move, the live definition on dev (db/scripts/dump-function.cjs, 2026-11-03), the same as
-- 0147's, with one edit: its two updates of stock_levels and stock_movements are now stock_rehome. Totals
-- already wrong from a split or a move made before this are not corrected here: stock_move would put
-- them right only for what moves next. Earlier migrations untouched.
-- Never edit after merge.

create or replace function stock_rehome(p_tenant uuid, p_lines uuid[], p_to uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  update items i set stock_qty = coalesce(i.stock_qty, 0) - s.q
    from (select item_id, sum(qty) as q from stock_levels
           where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to group by item_id) s
   where i.tenant_id = p_tenant and i.id = s.item_id;
  update items set stock_qty = coalesce(stock_qty, 0) + (
      select coalesce(sum(qty), 0) from stock_levels
       where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to)
   where tenant_id = p_tenant and id = p_to
     and exists (select 1 from stock_levels where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to);
  update stock_levels set item_id = p_to where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to;
  update stock_movements set item_id = p_to where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to;
  update promotions set item_id = p_to where tenant_id = p_tenant and variant_id = any(p_lines) and item_id <> p_to;
end $fn$;

CREATE OR REPLACE FUNCTION public.variants_move(p_tenant uuid, p_lines uuid[], p_to uuid, p_drop_option integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  perform stock_rehome(p_tenant, p_lines, p_to);
  return coalesce(array_length(p_lines, 1), 0);
end $function$
;
