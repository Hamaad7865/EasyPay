import type { PoolClient } from "pg";
import type { Doc, Input, Line, Money, Without } from "@/lib/journal";

// The database half of the sales journal (lib/journal.ts): one period's sales
// and refunds, the money that came in on them, and the money paid in the
// period on sales made before it (customer accounts, 0114). Days are the
// store's; a receipt counts as a report counts it (receipt_revenue: a double
// payment does not).

// the built-in kinds: no money taken at the counter
const WITHOUT = ["exchange", "credit_note", "deposit", "account"];

const DOCS = `
  select v.id, v.number, v.type, v.total, v.tax_total, v.refund_of,
         (coalesce(v.device_time, v.created_at) at time zone st.timezone)::date::text as day,
         (extract(hour from coalesce(v.device_time, v.created_at) at time zone st.timezone) * 60
          + extract(minute from coalesce(v.device_time, v.created_at) at time zone st.timezone))::int as minute,
         pd.name as device, e.name as employee, t.customer_id, o.name as method
    from receipt_revenue v
    join stores st on st.tenant_id = v.tenant_id and st.id = v.store_id
    left join tickets t on t.tenant_id = v.tenant_id and t.id = v.ticket_id
    left join pos_devices pd on pd.tenant_id = v.tenant_id and pd.id = v.device_id
    left join employees e on e.tenant_id = v.tenant_id and e.id = v.employee_id
    left join lateral (select d.name from dining_options d where d.tenant_id = v.tenant_id
                        and d.id = coalesce(t.dining_option_id, (select x.id from dining_options x where x.tenant_id = v.tenant_id and x.is_default and x.deleted_at is null limit 1))) o on true
   where v.tenant_id = $1 and v.counts_as_sale`;

type DocRow = { id: string; number: string; type: "sale" | "refund"; total: string; tax_total: string; refund_of: string | null; day: string; minute: number; device: string | null; employee: string | null; customer_id: string | null; method: string | null };

export type JournalData = Omit<Input, "filters" | "shopLabel"> & {
  // account payments in the period on a sale the server does not hold: money, left out of every figure, and said
  unplaced: number;
  // a shop's deposits (0113): money too, but not a sale until the goods are collected
  deposits: { taken: number; back: number };
  facets: { devices: string[]; users: string[]; items: string[] };
};

export async function journalData(c: PoolClient, tenantId: string, from: string, to: string, shop: boolean): Promise<JournalData> {
  const toDoc = (r: DocRow, inPeriod: boolean): Doc => ({
    id: r.id, number: r.number, type: r.type, total: Number(r.total), tax: Number(r.tax_total), day: r.day, minute: r.minute,
    device: r.device, employee: r.employee, customer: r.customer_id, method: shop ? null : (r.method ?? "Not set"), inPeriod,
  });
  const own = (await c.query(`${DOCS} and (coalesce(v.device_time, v.created_at) at time zone st.timezone)::date between $2::date and $3::date`, [tenantId, from, to])).rows as DocRow[];
  const ids = own.map((r) => r.id);
  const refundOf = new Map(own.filter((r) => r.refund_of).map((r) => [r.id, r.refund_of as string]));

  // money paid in the period on accounts: a line per sale it went on
  const lines = (
    await c.query(
      `select l.bill_id, l.amount, pt.name as method, e.name as by
         from account_payment_lines l
         join account_payments q on q.tenant_id = l.tenant_id and q.id = l.account_payment_id
         join stores st on st.tenant_id = q.tenant_id and st.id = q.store_id
         left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
         left join employees e on e.tenant_id = q.tenant_id and e.id = q.employee_id
        where l.tenant_id = $1 and (q.device_time at time zone st.timezone)::date between $2::date and $3::date`,
      [tenantId, from, to],
    )
  ).rows as { bill_id: string; amount: string; method: string | null; by: string | null }[];
  const inPeriod = new Set(ids);
  const strangerIds = [...new Set(lines.map((l) => l.bill_id).filter((b) => !inPeriod.has(b)))];
  const strangers = strangerIds.length ? ((await c.query(`${DOCS} and v.id = any($2::uuid[]) and v.type = 'sale'`, [tenantId, strangerIds])).rows as DocRow[]) : [];
  const docs = [...own.map((r) => toDoc(r, true)), ...strangers.map((r) => toDoc(r, false))];
  const held = new Set(docs.map((d) => d.id));
  const allIds = docs.map((d) => d.id);

  const signOf = new Map(own.map((r) => [r.id, r.type === "refund" ? -1 : 1]));
  const pays = ids.length
    ? ((
        await c.query(
          `select p.receipt_id as doc, pt.kind, pt.name, sum(p.amount) as amount, r.type, e.name as by
             from receipt_payments_effective p
             join receipts r on r.tenant_id = p.tenant_id and r.id = p.receipt_id
             left join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id
             left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
            where p.tenant_id = $1 and p.receipt_id = any($2::uuid[])
            group by p.receipt_id, pt.kind, pt.name, r.type, e.name`,
          [tenantId, ids],
        )
      ).rows as { doc: string; kind: string | null; name: string | null; amount: string; type: string; by: string | null }[])
    : [];
  const money: Money[] = [];
  const without: Without[] = [];
  for (const p of pays) {
    const amount = Number(p.amount);
    if (p.kind && WITHOUT.includes(p.kind)) {
      without.push({ doc: p.doc, kind: p.kind as Without["kind"], amount, bill: p.kind === "account" && p.type === "refund" ? (refundOf.get(p.doc) ?? null) : undefined });
    } else {
      money.push({ doc: p.doc, method: p.name ?? "Unknown", amount: (signOf.get(p.doc) ?? 1) * amount, by: p.by, account: false });
    }
  }
  let unplaced = 0;
  for (const l of lines) {
    if (!held.has(l.bill_id)) {
      unplaced += Number(l.amount);
      continue;
    }
    money.push({ doc: l.bill_id, method: l.method ?? "Unknown", amount: Number(l.amount), by: l.by, account: true });
  }

  // each sale's lines, with its share of the sale's discount, and the VAT on it: weights for the split
  const rows = allIds.length
    ? ((
        await c.query(
          `select rl.receipt_id as doc, rl.name_snapshot as name, cat.name as category, rl.qty, x.net,
                  coalesce((select json_agg(json_build_object('name', t.name_snapshot, 'rate', t.rate_bp, 'type', t.type) order by t.name_snapshot)
                              from receipt_line_taxes t where t.tenant_id = rl.tenant_id and t.receipt_line_id = rl.id), '[]'::json) as taxes
             from receipt_lines rl
             join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id
             left join ticket_lines tl on tl.tenant_id = rl.tenant_id and tl.id = rl.ticket_line_id
             left join items it on it.tenant_id = rl.tenant_id and it.id = tl.item_id
             left join categories cat on cat.tenant_id = rl.tenant_id and cat.id = it.category_id
             cross join lateral (select (line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
                                           where m.tenant_id = rl.tenant_id and m.receipt_line_id = rl.id), 0))::bigint as base) b
             cross join lateral (select b.base - case when r.subtotal > 0 then r.discount_total * b.base / r.subtotal else 0 end as net) x
            where rl.tenant_id = $1 and rl.receipt_id = any($2::uuid[])
            order by rl.receipt_id, rl.id`,
          [tenantId, allIds],
        )
      ).rows as { doc: string; name: string; category: string | null; qty: number; net: string; taxes: { name: string; rate: number; type: string }[] }[])
    : [];
  const out: Line[] = rows.map((r) => {
    const net = Math.max(0, Number(r.net));
    let added = 0, inside = 0;
    for (const t of r.taxes) {
      if (t.type === "added") added += Math.round((net * t.rate) / 10000);
      else inside += Math.round((net * t.rate) / (10000 + t.rate));
    }
    const rate = r.taxes.length ? r.taxes.map((t) => `${t.name} ${t.rate / 100}%`).join(" + ") : "No tax";
    return { doc: r.doc, name: r.name, category: r.category, qty: Number(r.qty), excl: net - inside, tax: added + inside, rate };
  });

  const customerIds = [...new Set(docs.map((d) => d.customer).filter((x): x is string => !!x))];
  const customers = new Map<string, string>(
    customerIds.length ? (await c.query(`select id, name from customers where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, customerIds])).rows.map((r) => [r.id as string, r.name as string]) : [],
  );
  const dep = shop
    ? ((
        await c.query(
          `select coalesce(sum(q.amount) filter (where q.kind = 'in'), 0) as taken, coalesce(-sum(q.amount) filter (where q.kind = 'back'), 0) as back
             from deposit_payments q join deposits d on d.tenant_id = q.tenant_id and d.id = q.deposit_id
             join stores st on st.tenant_id = d.tenant_id and st.id = d.store_id
            where q.tenant_id = $1 and (q.device_time at time zone st.timezone)::date between $2::date and $3::date`,
          [tenantId, from, to],
        )
      ).rows[0] as { taken: string; back: string })
    : { taken: "0", back: "0" };
  // the choices of the filters: from the period's own sales, whatever is picked
  const sorted = (s: Iterable<string>) => [...new Set(s)].sort((a, b) => a.localeCompare(b));
  const facets = {
    devices: sorted(own.map((r) => r.device).filter((x): x is string => !!x)),
    users: sorted(own.map((r) => r.employee ?? "Not recorded")),
    items: sorted(out.filter((l) => inPeriod.has(l.doc)).map((l) => l.name)),
  };
  return { from, to, docs, lines: out, money, without, customers, unplaced, deposits: { taken: Number(dep.taken), back: Number(dep.back) }, facets };
}
