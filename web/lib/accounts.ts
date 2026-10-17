import type { PoolClient } from "pg";

// A shop's customer accounts (migration 0114). A bill is the part of a sale
// paid "On account" (account_bills, its id the sale receipt's); what it owes
// is amount - paid - returned (account_owed), below nothing it is paid over.
// Money paid later on an account is an account_payments row, put on bills by
// its lines; it is never a sale, so it is in no "sales" figure, only in the
// money taken. One rule everywhere here: the sale is revenue the day it is
// made, whatever paid it; money paid on it later is money in, not a sale.

// ---- the figures of a till's period (Day closing) ----

export type AccountFigures = { sold: string; returned: string; taken: { name: string | null; amount: string; n: number }[] };

export const NO_ACCOUNTS: AccountFigures = { sold: "0", returned: "0", taken: [] };

export const anyAccounts = (a: AccountFigures | null | undefined) =>
  !!a && (a.taken.length > 0 || Number(a.sold) !== 0 || Number(a.returned) !== 0);

// One till between two moments, as a json value of a select. tenant, device:
// sql naming them; after (excluded) and upto (included): timestamps;
// receipts: the where of the receipts of that window (alias r).
export const accountsJson = (tenant: string, device: string, after: string, upto: string, receipts: string) => `
         (select json_build_object(
            'sold', (select coalesce(sum(p.amount), 0) from receipts r
                       join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                       join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'account'
                      where ${receipts} and r.type = 'sale'),
            'returned', (select coalesce(sum(p.amount), 0) from receipts r
                       join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
                       join payment_types pt on pt.tenant_id = r.tenant_id and pt.id = p.payment_type_id and pt.kind = 'account'
                      where ${receipts} and r.type = 'refund'),
            'taken', coalesce((select json_agg(json_build_object('name', x.name, 'amount', x.amount, 'n', x.n) order by x.amount desc)
                                 from (select pt.name, sum(q.amount) as amount, count(*) as n
                                         from account_payments q left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
                                        where q.tenant_id = ${tenant} and q.device_id = ${device}
                                          and q.device_time > ${after} and q.device_time <= ${upto} group by pt.name) x), '[]'::json)))`;

// ---- a customer's account ----

// How old a bill is, in the store's days.
export const ageSql = (b: string) => `(deposit_today(${b}.tenant_id, ${b}.store_id) - ${b}.day)`;

// The ageing columns of the pages and the statement, by a bill's age in days.
export const BUCKETS = [
  { key: "b0", label: "0–30 days", from: 0, to: 30 },
  { key: "b1", label: "31–60 days", from: 31, to: 60 },
  { key: "b2", label: "61–90 days", from: 61, to: 90 },
  { key: "b3", label: "Over 90 days", from: 91, to: 100000 },
] as const;

export type Bill = {
  id: string;
  number: string;
  day: string;
  amount: string;
  paid: string;
  returned: string;
  owed: string;
  age: number;
  customer_id: string | null;
  flags: { why: string }[];
};

// What each bucket comes to, for the bills that owe (paid over ones are not aged).
export function aged(bills: Pick<Bill, "owed" | "age">[]): number[] {
  const out = BUCKETS.map(() => 0);
  for (const b of bills) {
    const o = Number(b.owed);
    if (o <= 0) continue;
    const i = BUCKETS.findIndex((k) => b.age >= k.from && b.age <= k.to);
    out[i < 0 ? 0 : i] += o;
  }
  return out;
}

export type LedgerLine = {
  at: string; // the moment, for the order
  day: string; // yyyy-mm-dd, the store's day
  kind: "bill" | "payment" | "return";
  ref: string; // the sale's number, the payment's, the refund's
  detail: string;
  debit: number;
  credit: number;
  balance: number;
  id: string; // the receipt or payment it is
};

// A customer's whole account as lines with a running balance: each bill
// (debit, on the day of its sale), each payment's part on this customer's
// bills (credit), each return taken off a bill (credit). Its last balance is
// what the bills owe, to the cent: the same rows the bills add up from.
export async function ledger(c: PoolClient, tenantId: string, customerId: string): Promise<LedgerLine[]> {
  const rows = (
    await c.query(
      `select * from (
         select coalesce(r.device_time, r.created_at, b.created_at) as at, b.day::text as day, 'bill' as kind, b.number as ref, 'Sale on account' as detail,
                b.amount as debit, 0::bigint as credit, b.id::text as id
           from account_bills b
           left join receipts r on r.tenant_id = b.tenant_id and r.id = b.id
          where b.tenant_id = $1 and b.customer_id = $2 and b.deleted_at is null and b.amount > 0
         union all
         select q.device_time, (q.device_time at time zone s.timezone)::date::text, 'payment', q.number,
                coalesce(pt.name, 'Payment') || coalesce(' · ' || q.reference, ''), 0, sum(l.amount), q.id::text
           from account_payments q
           join account_payment_lines l on l.tenant_id = q.tenant_id and l.account_payment_id = q.id
           join account_bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id and b.customer_id = $2 and b.deleted_at is null
           join stores s on s.tenant_id = q.tenant_id and s.id = q.store_id
           left join payment_types pt on pt.tenant_id = q.tenant_id and pt.id = q.payment_type_id
          where q.tenant_id = $1
          group by q.id, q.device_time, s.timezone, q.number, pt.name, q.reference
         union all
         select coalesce(r.device_time, r.created_at), (coalesce(r.device_time, r.created_at) at time zone s.timezone)::date::text, 'return', r.number,
                'Goods returned from ' || b.number, 0, sum(p.amount), r.id::text
           from receipts r
           join account_bills b on b.tenant_id = r.tenant_id and b.id = r.refund_of and b.customer_id = $2 and b.deleted_at is null
           join receipt_payments_effective p on p.tenant_id = r.tenant_id and p.receipt_id = r.id
           join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id and pt.kind = 'account'
           join stores s on s.tenant_id = r.tenant_id and s.id = r.store_id
          where r.tenant_id = $1 and r.type = 'refund' and r.deleted_at is null
          group by r.id, r.device_time, r.created_at, s.timezone, r.number, b.number
       ) x order by x.at, case x.kind when 'bill' then 0 else 1 end, x.ref`,
      [tenantId, customerId],
    )
  ).rows as { at: string; day: string; kind: LedgerLine["kind"]; ref: string; detail: string; debit: string; credit: string; id: string }[];
  let run = 0;
  return rows.map((r) => {
    run += Number(r.debit) - Number(r.credit);
    return { ...r, debit: Number(r.debit), credit: Number(r.credit), balance: run };
  });
}

// What a flag on a bill or a payment says, for the owner.
export const FLAG: Record<string, string> = {
  "no-customer": "Sold on account with no customer named",
  "not-entitled": "Sold on account before the shop had customer accounts",
  "not-allowed": "Sold on account by someone not allowed to",
  "double-pay": "A second receipt for a sale already paid: not billed",
  "over-paid": "Paid more than it owed (two tills took the same bill)",
  "other-customer": "Paid by a payment of another customer",
  "over-returned": "A return took off more than it owed",
  "money-before-paid": "Money was given back on a return before it was paid",
  "bill-unknown": "Put on a bill the server does not know",
};
