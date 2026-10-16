// A shop's deposits (migration 0113) on the reports: money taken on them by
// payment method, what collections used, what was given back, put on credit
// notes or kept by the shop. None of it is a sale: a sale is written when the
// goods are collected. Cash taken or given back is also among the drawer's
// cash in and out, where the drawer's count needs it.

export type DepositFigures = { taken: { name: string | null; amount: string; n: number }[]; used: string; back: string; noted: string; kept: string };

export const NO_DEPOSITS: DepositFigures = { taken: [], used: "0", back: "0", noted: "0", kept: "0" };

export const anyDeposits = (d: DepositFigures | null | undefined) =>
  !!d && (d.taken.length > 0 || [d.used, d.back, d.noted, d.kept].some((v) => Number(v) !== 0));

// The figures of one till between two moments, as a json value of a select.
// tenant, device: sql naming them; after (excluded) and upto (included):
// timestamps; receipts: the where of the receipts of that window (alias r).
export const depositsJson = (tenant: string, device: string, after: string, upto: string, receipts: string) => `
         (select json_build_object(
            'taken', coalesce((select json_agg(json_build_object('name', x.name, 'amount', x.amount, 'n', x.n) order by x.amount desc)
                                 from (select pt.name, sum(q.amount) as amount, count(*) as n
                                         from deposit_payments q left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
                                        where q.tenant_id = ${tenant} and q.device_id = ${device} and q.kind = 'in'
                                          and q.device_time > ${after} and q.device_time <= ${upto} group by pt.name) x), '[]'::json),
            'back', (select coalesce(-sum(q.amount), 0) from deposit_payments q
                      where q.tenant_id = ${tenant} and q.device_id = ${device} and q.kind = 'back' and q.device_time > ${after} and q.device_time <= ${upto}),
            'used', (select coalesce(sum(p.amount), 0) from receipts r
                       join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                       join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'deposit'
                      where ${receipts} and r.type = 'sale'),
            'noted', (select coalesce(sum(d.noted), 0) from deposits d
                       where d.tenant_id = ${tenant} and d.device_id = ${device} and d.cancelled_at > ${after} and d.cancelled_at <= ${upto}),
            'kept', (select coalesce(sum(d.kept), 0) from deposits d
                      where d.tenant_id = ${tenant} and d.device_id = ${device} and d.cancelled_at > ${after} and d.cancelled_at <= ${upto})))`;

// What a deposit (alias x) still has to be paid: what the goods not collected
// yet come to, less the money paid on it and not used yet (the till's
// DepositRules.toPay). Nothing once it is closed.
export const toPaySql = (x: string) => `
  (select greatest(0, case when ${x}.status <> 'open' or coalesce(sum(line_amount(l.unit_price, l.qty)), 0) = 0 then 0
                          else round(${x}.total::numeric * sum(line_amount(l.unit_price, greatest(l.qty - l.qty_collected, 0))) / sum(line_amount(l.unit_price, l.qty))) end
                     - greatest(deposit_free(${x}), 0))::bigint
     from deposit_lines l where l.tenant_id = ${x}.tenant_id and l.deposit_id = ${x}.id)`;

// A deposit that is still the shop's business: open, money owed back, or collected with money paid over.
export const stillOpen = (x: string) => `(${x}.status = 'open' or ${x}.owed > 0 or (${x}.status = 'collected' and deposit_free(${x}) > 0))`;
