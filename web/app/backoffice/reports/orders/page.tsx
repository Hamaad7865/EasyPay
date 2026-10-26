import { ClipboardList } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { money } from "@/lib/settings";
import { args, clock, filters, RECEIPTS, reportStart } from "@/lib/report";
import { Empty, PageHead, type Search } from "../../ui";
import { ReportFilters, Stat } from "../parts";
import { ReceiptCard, type ReceiptHead, receiptParts } from "../../receipt-card";

const LIMIT = 300;

export default async function OrderDetails({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const f = filters(sp, l.tz);
    if (!ok) return { l, f, ok: false as const };
    const heads = (
      await c.query(
        `with r as (${RECEIPTS})
         select r.id, r.number, r.type, r.at, r.subtotal, r.discount_total, r.tax_total, r.rounding, r.total, r.needs_review,
                r.order_name, r.covers, r.note, e.name as cashier, w.name as waiter, o.name as dining, tb.name as table_name,
                (select x.number from receipts x where x.tenant_id = $1 and x.id = r.refund_of) as refund_number
           from r
           left join employees e on e.tenant_id = $1 and e.id = r.employee_id
           left join employees w on w.tenant_id = $1 and w.id = r.opened_by
           left join dining_options o on o.tenant_id = $1 and o.id = r.dining_option_id
           left join tables tb on tb.tenant_id = $1 and tb.id = r.table_id
          where ($7::uuid is null or exists (select 1 from receipt_payments_effective p
                   where p.tenant_id = $1 and p.receipt_id = r.id and p.payment_type_id = $7::uuid))
          order by r.at desc limit ${LIMIT + 1}`,
        [...args(ctx.tenantId, f), f.payment],
      )
    ).rows as ReceiptHead[];
    return { l, f, ok: true as const, s, heads, parts: await receiptParts(c, ctx.tenantId, heads.slice(0, LIMIT).map((h) => h.id)) };
  });
  const head = <PageHead title="Orders" lede="Every receipt in full: what was ordered, by whom, the discounts, the tax and how it was paid. Open a line to see it all." />;
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const at = clock(d.l.tz);
  const shown = d.heads.slice(0, LIMIT);
  const total = shown.reduce((a, h) => a + (h.type === "refund" ? -1 : 1) * Number(h.total), 0);
  return (
    <div>
      {head}
      <ReportFilters path="/backoffice/reports/orders" f={d.f} l={d.l} show={["employee", "payment", "kind"]} />
      {shown.length === 0 ? (
        <Empty icon={ClipboardList} title="No receipts in these days">Pick other dates, or clear the filters.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Receipts shown" value={String(shown.length)} note={d.heads.length > LIMIT ? `the latest ${LIMIT}; narrow the dates to see the rest` : undefined} />
            <Stat label="Sales" value={String(shown.filter((h) => h.type === "sale").length)} />
            <Stat label="Refunds" value={String(shown.filter((h) => h.type === "refund").length)} />
            <Stat label="Total" value={m(total)} />
          </div>
          {shown.map((h) => <ReceiptCard key={h.id} h={h} parts={d.parts} m={m} at={at} />)}
        </>
      )}
    </div>
  );
}
