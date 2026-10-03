import { revalidatePath } from "next/cache";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";

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
  reviews: Review[];
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

export default async function ReceiptsPage() {
  const ctx = await tenantContext();
  const rows = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select r.id, r.number, r.type, r.total, r.needs_review, r.device_time,
                coalesce((select jsonb_agg(jsonb_build_object('reason', v.reason, 'detail', v.detail,
                            'resolved_at', v.resolved_at, 'resolution', v.resolution) order by v.reason)
                   from receipt_reviews v
                  where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null), '[]'::jsonb) as reviews
           from receipts r where r.deleted_at is null and r.tenant_id = $1
           order by r.device_time desc nulls last, r.created_at desc limit 100`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as ReceiptRow[]),
  );
  const isOpen = (r: ReceiptRow) => r.needs_review && (r.reviews.length === 0 || r.reviews.some((v) => !v.resolved_at));
  const open = rows.filter(isOpen).length;
  return (
    <div>
      <h1>Receipts</h1>
      {open > 0 && <p style={{ color: "red" }}>{open} need review</p>}
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Type</th>
            <th>Total</th>
            <th>Time</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td>
              <td>{r.type}</td>
              <td>{fmtRs(Number(r.total))}</td>
              <td>{r.device_time ? new Date(r.device_time).toLocaleString() : "—"}</td>
              <td>
                {r.needs_review && r.reviews.length === 0 && "needs review (reason not recorded)"}
                {r.reviews.map((v) => (
                  <div key={v.reason}>
                    {describe(v)}
                    {v.resolved_at && ` — resolved: ${v.resolution ?? ""}`}
                  </div>
                ))}
                {r.reviews.some((v) => !v.resolved_at) && (
                  <form action={resolveReceipt}>
                    <input type="hidden" name="receipt" value={r.id} />
                    <input name="note" placeholder="What was done" required size={24} />{" "}
                    <button type="submit">Mark reviewed</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p>No receipts yet. Make a sale on the tablet.</p>}
    </div>
  );
}
