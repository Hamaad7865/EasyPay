import { revalidatePath } from "next/cache";
import Link from "next/link";
import { Receipt } from "lucide-react";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";
import { act, Refused, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { clock, lists } from "@/lib/report";
import { Empty, Flash, PageHead, type Search } from "../ui";

type Review = {
  reason: string;
  detail: Record<string, unknown>;
  resolved_at: string | null;
  resolution: string | null;
};

type ReceiptRow = {
  id: string;
  number: string;
  type: string;
  total: string;
  needs_review: boolean;
  device_time: string | null;
  at: string;
  cashier: string | null;
  reviews: Review[];
  payments: { type: string; name: string | null; was: string | null; amount: number }[];
};

type DriftItem = { kind?: string; name?: string; till?: number | null; catalog?: number | null };

const rs = (v: unknown) => fmtRs(Number(v ?? 0));

// One plain sentence per reason, with the figures the server recorded.
function describe(v: Review): string {
  const d = v.detail ?? {};
  switch (v.reason) {
    case "double-pay":
      return `Ticket was already paid (${rs(d.already_paid)}); another ${rs(d.received)} was taken`;
    case "underpaid":
      return `Short payment: ${rs(d.received)} taken for a total of ${rs(d.total)}`;
    case "overpaid":
      return `Overpayment: ${rs(d.received)} taken for a total of ${rs(d.total)}`;
    case "number-collision":
      return `Number ${String(d.requested)} was already used; stored as ${String(d.stored)}`;
    case "price-drift": {
      const items = (Array.isArray(d.items) ? d.items : []) as DriftItem[];
      return items
        .map((i) =>
          i.kind === "unavailable"
            ? `item sold at ${rs(i.till)} is no longer available`
            : i.kind === "modifier-unlinked"
              ? `a modifier (${rs(i.till)}) that this item does not offer`
            : `${i.kind === "discount" ? `discount ${i.name ?? ""}`.trim() : (i.kind ?? "item")} charged ${rs(i.till)}, catalog ${rs(i.catalog)}`,
        )
        .join("; ");
    }
    default:
      return v.reason;
  }
}

// Signing off a money discrepancy takes the same authority as refunding one.
async function resolveReceipt(formData: FormData) {
  "use server";
  const ctx = await requirePerm("sale.refund");
  const receiptId = String(formData.get("receipt") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!receiptId || !note) return;
  await withTenant(ctx.tenantId, (c) =>
    c.query(
      `update receipt_reviews set resolved_at = now(), resolved_by = $1, resolution = $2
        where receipt_id = $3 and tenant_id = $4 and resolved_at is null and deleted_at is null`,
      [ctx.employeeId, note, receiptId, ctx.tenantId],
    ),
  );
  revalidatePath("/backoffice/receipts");
  revalidatePath("/backoffice");
}

// A bill rung up under the wrong payment type is corrected, not edited: the
// payment stays as it was recorded and the correction is kept with who made
// it and when. The amount never changes.
async function correctPayment(f: FormData) {
  "use server";
  await act("payment.correct", "/backoffice/receipts", async (c, ctx) => {
    const payload = { id: crypto.randomUUID(), receipt_id: uuid(f, "receipt"), from_payment_type_id: uuid(f, "from"), to_payment_type_id: uuid(f, "to") };
    if (payload.from_payment_type_id === payload.to_payment_type_id) throw new Refused("Pick a different payment type.");
    try {
      await c.query(`select push_payment_correct($1, $2, $3::jsonb)`, [ctx.tenantId, ctx.employeeId, JSON.stringify(payload)]);
    } catch (e) {
      throw new Refused(e instanceof Error && e.message === "forbidden" ? "Your role does not include correcting a payment type." : "That payment could not be corrected. Reload the page and try again.");
    }
    return "Payment type corrected. The reports use the new type; the receipt keeps a note of the change.";
  });
}

export default async function ReceiptsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
    l: await lists(c, ctx.tenantId),
    s: await loadSettings(c, ctx.tenantId),
    types: (await c.query(`select id, name from payment_types where tenant_id = $1 and deleted_at is null and is_active order by sort_order, name`, [ctx.tenantId])).rows as { id: string; name: string }[],
    may: (await c.query(`select has_perm($1, 'payment.correct') as ok`, [ctx.employeeId])).rows[0].ok as boolean,
    rows: (
      await c.query(
        `select r.id, r.number, r.type, r.total, r.needs_review, r.device_time, coalesce(r.device_time, r.created_at) as at, e.name as cashier,
                coalesce((select jsonb_agg(jsonb_build_object('reason', v.reason, 'detail', v.detail,
                            'resolved_at', v.resolved_at, 'resolution', v.resolution) order by v.reason)
                   from receipt_reviews v
                  where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null), '[]'::jsonb) as reviews,
                coalesce((select jsonb_agg(jsonb_build_object('type', q.type, 'name', q.name, 'was', q.was, 'amount', q.amount))
                   from (select p.payment_type_id as type, pt.name, sum(p.amount) as amount,
                                max(case when p.payment_type_id <> p.original_payment_type_id then old.name end) as was
                           from receipt_payments_effective p
                           left join payment_types pt on pt.tenant_id = p.tenant_id and pt.id = p.payment_type_id
                           left join payment_types old on old.tenant_id = p.tenant_id and old.id = p.original_payment_type_id
                          where p.tenant_id = r.tenant_id and p.receipt_id = r.id group by p.payment_type_id, pt.name) q), '[]'::jsonb) as payments
           from receipts r left join employees e on e.tenant_id = r.tenant_id and e.id = r.employee_id
          where r.deleted_at is null and r.tenant_id = $1
          order by coalesce(r.device_time, r.created_at) desc limit 100`,
        [ctx.tenantId],
      )
    ).rows as ReceiptRow[],
  }));
  const rows = d.rows;
  const at = clock(d.l.tz);
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const isOpen = (r: ReceiptRow) => r.needs_review && (r.reviews.length === 0 || r.reviews.some((v) => !v.resolved_at));
  const open = rows.filter(isOpen).length;
  return (
    <div>
      <PageHead title="Receipts" lede="The latest 100 receipts and refunds. Correct a payment type that was rung up wrong, and sign off the ones the system flagged.">
        <Link href="/backoffice/reports/orders" className="btn-quiet">Order details report</Link>
      </PageHead>
      <Flash sp={sp} />
      {open > 0 && <div className="note warn"><strong>{open} {open === 1 ? "receipt needs" : "receipts need"} a look</strong>The till took the money and kept selling; the reason is in the last column.</div>}
      {rows.length === 0 ? (
        <Empty icon={Receipt} title="No receipts yet">Make a sale on the tablet and it shows here within a minute.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Type</th>
              <th>Time</th>
              <th>By</th>
              <th className="num">Total</th>
              <th>Paid by</th>
              <th>To check</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.number}</td>
                <td><span className={"badge " + (r.type === "refund" ? "red" : "green")}>{r.type === "refund" ? "Refund" : "Sale"}</span></td>
                <td>{at(r.at)}</td>
                <td>{r.cashier ?? <span className="muted">Not recorded</span>}</td>
                <td className="num strong">{r.type === "refund" ? "-" : ""}{m(r.total)}</td>
                <td>
                  {r.payments.length === 0 && <span className="muted">No payment</span>}
                  {r.payments.map((p) => (
                    <div key={p.type} style={{ marginBottom: 4 }}>
                      {p.name ?? "Unknown"} {r.payments.length > 1 && <span className="muted">{m(p.amount)}</span>}
                      {p.was && <span className="sub">corrected from {p.was}</span>}
                      {d.may && (
                        <details>
                          <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Change</summary>
                          <form action={correctPayment} className="inline" style={{ marginTop: 6 }}>
                            <input type="hidden" name="receipt" value={r.id} />
                            <input type="hidden" name="from" value={p.type} />
                            <select name="to" defaultValue="" required aria-label="New payment type">
                              <option value="" disabled>Paid by…</option>
                              {d.types.filter((t) => t.id !== p.type).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <button type="submit" className="btn-quiet btn-sm">Correct</button>
                          </form>
                        </details>
                      )}
                    </div>
                  ))}
                </td>
                <td>
                  {r.needs_review && r.reviews.length === 0 && <span className="badge amber">Flagged, reason not recorded</span>}
                  {r.reviews.map((v) => (
                    <div key={v.reason} className={v.resolved_at ? "muted" : undefined}>
                      {describe(v)}
                      {v.resolved_at && ` (signed off: ${v.resolution ?? ""})`}
                    </div>
                  ))}
                  {r.reviews.some((v) => !v.resolved_at) && (
                    <form action={resolveReceipt} className="inline" style={{ marginTop: 6 }}>
                      <input type="hidden" name="receipt" value={r.id} />
                      <input name="note" placeholder="What was done" required />
                      <button type="submit" className="btn-quiet btn-sm">Sign off</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
