import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";

type ReceiptRow = {
  id: string;
  number: string;
  type: string;
  total: string;
  needs_review: boolean;
  device_time: string | null;
};

export default async function ReceiptsPage() {
  const ctx = await tenantContext();
  const rows = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select id, number, type, total, needs_review, device_time
           from receipts where deleted_at is null
           order by device_time desc nulls last, created_at desc limit 100`,
      )
      .then((r) => r.rows as ReceiptRow[]),
  );
  const flagged = rows.filter((r) => r.needs_review).length;
  return (
    <div>
      <h1>Receipts</h1>
      {flagged > 0 && <p style={{ color: "red" }}>{flagged} need review (sync conflicts)</p>}
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Type</th>
            <th>Total</th>
            <th>Time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td>
              <td>{r.type}</td>
              <td>{fmtRs(Number(r.total))}</td>
              <td>{r.device_time ? new Date(r.device_time).toLocaleString() : "—"}</td>
              <td>{r.needs_review ? "needs review" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p>No receipts yet. Make a sale on the tablet.</p>}
    </div>
  );
}
