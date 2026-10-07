// The questions a shop's stock reports ask, as SQL. Kept apart from the pages
// (and free of imports) so db/tests/stock-reports.test.cjs can ask them as
// the tenant's own connection: the pages cannot drift from what was tested.
// The sums on top of them are in ./stock.ts. Quantities are thousandths,
// money is cents.
//
// Cost comes from the stock movements: every movement keeps the average cost
// of its moment (stock_move, migration 0067), so what a sale or a loss cost
// does not change when the product's cost does. A movement written before
// that, or for a line that was never given a cost, has none: its cost is
// not known, and it is in no rupee figure.

// What was damaged, expired or lost in a shop, by reason and by product.
// $1 tenant, $2 shop, $3 from day, $4 to day (the shop's own days)
export const LOSSES_SQL = `
  select m.reason, i.name, v.name as variant, c.name as category,
         (-sum(m.qty))::int as qty, count(*)::int as times,
         sum(case when m.unit_cost > 0 then round(-m.qty * m.unit_cost / 1000) end)::bigint as value
    from stock_movements m
    join stores s on s.tenant_id = m.tenant_id and s.id = m.store_id
    join items i on i.tenant_id = m.tenant_id and i.id = m.item_id
    left join item_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
    left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
   where m.tenant_id = $1 and m.store_id = $2 and m.deleted_at is null
     and m.reason in ('damaged', 'expired', 'lost')
     and (m.created_at at time zone s.timezone)::date between $3::date and $4::date
   group by m.reason, i.id, i.name, v.id, v.name, c.name
   order by m.reason, 7 desc nulls last, i.name, v.name`;

// What stock counts corrected in the same days: said beside the losses, not
// added to them (a count finds goods as well as missing ones).
// $1 tenant, $2 shop, $3 from day, $4 to day
export const COUNTED_SQL = `
  select coalesce(sum(m.qty), 0)::int as qty, count(distinct m.ref_id)::int as counts,
         coalesce(sum(case when m.unit_cost > 0 then round(m.qty * m.unit_cost / 1000) end), 0)::bigint as value
    from stock_movements m
    join stores s on s.tenant_id = m.tenant_id and s.id = m.store_id
   where m.tenant_id = $1 and m.store_id = $2 and m.deleted_at is null and m.reason = 'count' and m.ref_type = 'count'
     and (m.created_at at time zone s.timezone)::date between $3::date and $4::date`;

// The lines of a shop's stock that hold something and have not been sold in
// the last $3 days, each with when it last sold (never: null) and when stock
// last came in, so last week's delivery is not read as dead stock. A refund
// is not a sale. $1 tenant, $2 shop, $3 days
export const UNSOLD_SQL = `
  select s.item_id, s.variant_id, s.name, s.variant, s.category, s.supplier, s.qty, s.avg_cost, s.price,
         to_char(x.last_sold at time zone st.timezone, 'FMDD FMMonth YYYY') as last_sold,
         extract(day from now() - x.last_sold)::int as days_quiet,
         to_char(x.last_in at time zone st.timezone, 'FMDD FMMonth YYYY') as last_in,
         extract(day from now() - x.last_in)::int as days_in
    from stock_on_hand($1, $2) s
    join stores st on st.tenant_id = $1 and st.id = $2
    left join lateral (
      select max(m.created_at) filter (where m.reason = 'sale') as last_sold,
             max(m.created_at) filter (where m.qty > 0 and m.reason in ('receive', 'opening')) as last_in
        from stock_movements m
       where m.tenant_id = $1 and m.store_id = $2 and m.item_id = s.item_id
         and m.variant_id is not distinct from s.variant_id and m.deleted_at is null) x on true
   where s.qty > 0 and (x.last_sold is null or x.last_sold <= now() - make_interval(days => $3::int))
   order by s.qty * s.avg_cost desc, s.name, s.variant`;

// Item sales, ranked by what they brought in: by item, or by category.
// `receipts` is RECEIPTS of ./report.ts and takes its six parameters.
// Without cost, this is the report as every business has it. With it (a
// shop, for whoever may see costs), each row also has:
//   ex_vat  its sales without VAT, after each line's share of the bill's
//           discount (the sums of the Tax report)
//   cost    what the goods cost when they were sold, where that is known
//   costed  the part of ex_vat that has a cost: profit is costed - cost
// A receipt moves a product once, whatever its lines, so each line takes the
// movement's cost per unit, not its total.
export function itemSalesSql(receipts: string, byCategory: boolean, withCost: boolean): string {
  const by = byCategory ? `coalesce(c.name, 'No category')` : `rl.name_snapshot`;
  const cat = byCategory ? "null::text" : "max(c.name)";
  const amount = `(line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
                   where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0))`;
  if (!withCost) {
    return `with r as (${receipts})
         select ${by} as name, ${cat} as cat,
                sum(r.sign * rl.qty)::int as qty,
                sum(r.sign * ${amount})::bigint as amount
           from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
           left join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
           left join items i on i.tenant_id = $1 and i.id = tl.item_id
           left join categories c on c.tenant_id = $1 and c.id = i.category_id
          group by 1 order by 4 desc, 1`;
  }
  return `with r as (${receipts}),
       l as (
         select r.id as receipt_id, r.sign, r.subtotal, r.discount_total, rl.id as line_id, rl.qty, rl.name_snapshot,
                tl.item_id, tl.variant_id, ${amount}::bigint as base
           from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
           left join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
       ),
       x as (select l.*, l.base - case when l.subtotal > 0 then l.discount_total * l.base / l.subtotal else 0 end as net from l),
       y as (
         select x.*,
                x.net - coalesce((select sum(case when t.type = 'added' then 0
                                        else (x.net * t.rate_bp + (10000 + t.rate_bp) / 2) / (10000 + t.rate_bp) end)
                                    from receipt_line_taxes t where t.tenant_id = $1 and t.receipt_line_id = x.line_id), 0) as ex_vat,
                (select m.unit_cost from stock_movements m
                  where m.tenant_id = $1 and m.receipt_id = x.receipt_id and m.item_id = x.item_id
                    and m.variant_id is not distinct from x.variant_id and m.reason in ('sale', 'refund') and m.deleted_at is null
                  limit 1) as unit_cost
           from x
       )
       select ${by.replace("rl.", "y.")} as name, ${cat} as cat,
              sum(y.sign * y.qty)::int as qty,
              sum(y.sign * y.base)::bigint as amount,
              sum(y.sign * y.ex_vat)::bigint as ex_vat,
              coalesce(sum(case when y.unit_cost > 0 then y.sign * y.ex_vat end), 0)::bigint as costed,
              sum(case when y.unit_cost > 0 then y.sign * round(y.qty * y.unit_cost / 1000) end)::bigint as cost
         from y
         left join items i on i.tenant_id = $1 and i.id = y.item_id
         left join categories c on c.tenant_id = $1 and c.id = i.category_id
        group by 1 order by 4 desc, 1`;
}
