-- 0120: goods collected from a deposit are sold, for slow movers and promotions.
--
-- A deposit (0113) takes its goods off the shelf the day it is taken (a
-- 'deposit' movement); the sale is written when they are collected, as an
-- ordinary receipt whose lines name their deposit line and move no stock.
-- Slow movers and promotions that no longer sell (0110) read the last sale
-- off the 'sale' movements, so a product sold only by deposits never sold
-- for them: it was offered for a markdown, and its promotion for a further
-- one, while it was selling. The tablet's own lists read a sale's receipt,
-- which a collection is, so they and the back office disagreed.
--
-- deposit_collected_at says when goods of one line were last collected; the
-- two functions, and the back office's Not selling report
-- (web/lib/stock-reports.ts, UNSOLD_SQL), take the later of it and the last
-- sale. A deposit still open, or cancelled, is not a sale, as on the tablet.
-- The goods' cost in the item sales report is the deposit's movement (in
-- web/lib/stock-reports.ts, itemSalesSql); nothing of that is here.
--
-- Source: slow_movers and stale_promotions are their live definitions on dev
-- on 2026-10-18 (db/scripts/dump-function.cjs; as 0110 left them), with only
-- the last sale changed. Never edit after merge.

-- When goods of one line were last sold by collecting them from a deposit:
-- such a sale moves no stock, so no 'sale' movement says when. A collection
-- is found by its order's lines, which name their deposit line (a few in a
-- shop, under their own index), and dated by its order's sale. p_store null:
-- in any store.
create or replace function deposit_collected_at(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid)
returns timestamptz
language sql stable set search_path = public as $fn$
  select max(r.created_at)
    from ticket_lines tl
    join receipts r on r.tenant_id = tl.tenant_id and r.ticket_id = tl.ticket_id
   where tl.tenant_id = p_tenant and tl.deposit_line_id is not null and tl.paid and tl.deleted_at is null
     and tl.item_id = p_item and tl.variant_id is not distinct from p_variant
     and r.type = 'sale' and r.deleted_at is null and (p_store is null or r.store_id = p_store)
$fn$;

CREATE OR REPLACE FUNCTION public.slow_movers(p_tenant uuid, p_days integer)
 RETURNS TABLE(item_id uuid, variant_id uuid, name text, variant text, category text, qty integer, price bigint, cost bigint, last_sold timestamp with time zone, idle_since timestamp with time zone, days_idle integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select x.item_id, x.variant_id, x.name, x.variant, x.category, x.qty, x.price, x.cost, x.last_sold,
         greatest(x.made, x.last_sold) as idle_since,
         extract(day from now() - greatest(x.made, x.last_sold))::int as days_idle
    from (
      select i.id as item_id, v.id as variant_id, i.name, v.name as variant, c.name as category,
             coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id
                         and l.variant_id is not distinct from v.id and l.deleted_at is null), 0)::integer as qty,
             coalesce(v.price, i.price) as price, coalesce(v.cost, i.cost) as cost, coalesce(v.created_at, i.created_at) as made,
             -- the last sale, or the last collection from a deposit (0120)
             greatest((select max(m.created_at) from stock_movements m
                        where m.tenant_id = i.tenant_id and m.item_id = i.id and m.variant_id is not distinct from v.id
                          and m.reason = 'sale' and m.deleted_at is null),
                      deposit_collected_at(i.tenant_id, null, i.id, v.id)) as last_sold
        from items i
        left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
        left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
       where i.tenant_id = p_tenant and i.deleted_at is null and i.is_available and not i.open_price
         and not exists (select 1 from promotions pr where pr.tenant_id = i.tenant_id and pr.item_id = i.id
                           and pr.variant_id is not distinct from v.id and pr.status = 'active' and pr.deleted_at is null)
    ) x
   where x.qty > 0 and greatest(x.made, x.last_sold) <= now() - make_interval(days => greatest(p_days, 1))
   order by greatest(x.made, x.last_sold), x.name, x.variant
$function$;

CREATE OR REPLACE FUNCTION public.stale_promotions(p_tenant uuid, p_days integer)
 RETURNS TABLE(promotion_id uuid, item_id uuid, variant_id uuid, name text, variant text, category text, qty integer, original_price bigint, promo_price bigint, cost bigint, applied_at timestamp with time zone, days_idle integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select pr.id, pr.item_id, pr.variant_id, i.name, v.name, c.name,
         coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = pr.tenant_id and l.item_id = pr.item_id
                     and l.variant_id is not distinct from pr.variant_id and l.deleted_at is null), 0)::integer,
         pr.original_price, pr.promo_price, coalesce(v.cost, i.cost), pr.applied_at,
         extract(day from now() - greatest(pr.applied_at, coalesce(x.last_sold, pr.applied_at)))::int
    from promotions pr
    join items i on i.tenant_id = pr.tenant_id and i.id = pr.item_id
    left join item_variants v on v.tenant_id = pr.tenant_id and v.id = pr.variant_id
    left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
    left join lateral (
      -- the last sale, or the last collection from a deposit (0120)
      select greatest(max(m.created_at), deposit_collected_at(pr.tenant_id, null, pr.item_id, pr.variant_id)) as last_sold
        from stock_movements m
       where m.tenant_id = pr.tenant_id and m.item_id = pr.item_id and m.variant_id is not distinct from pr.variant_id
         and m.reason = 'sale' and m.deleted_at is null) x on true
   where pr.tenant_id = p_tenant and pr.status = 'active' and pr.deleted_at is null
     and greatest(pr.applied_at, coalesce(x.last_sold, pr.applied_at)) <= now() - make_interval(days => greatest(p_days, 1))
     and coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = pr.tenant_id and l.item_id = pr.item_id
                     and l.variant_id is not distinct from pr.variant_id and l.deleted_at is null), 0) > 0
   order by pr.applied_at
$function$;
