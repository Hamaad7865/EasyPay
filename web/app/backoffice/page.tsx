import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { fmtRs } from "@/lib/money";

export default async function BackofficeHome() {
  const ctx = await tenantContext();
  const stats = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        // sales come from receipt_revenue: refunds subtract, and a double payment
        // (money for goods already sold) is not counted as a sale.
        // flagged = still open: no recorded reason yet, or a reason not resolved.
        `select (select count(*)::int from receipts where deleted_at is null and tenant_id = $1) as receipts,
                (select count(*)::int from receipts r
                  where r.deleted_at is null and r.tenant_id = $1 and r.needs_review
                    and (not exists (select 1 from receipt_reviews v
                                      where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)
                      or exists (select 1 from receipt_reviews v
                                  where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null
                                    and v.resolved_at is null))) as flagged,
                (select coalesce(sum(signed_total) filter (where counts_as_sale), 0)::text
                   from receipt_revenue where tenant_id = $1) as sales,
                (select count(*)::int from items where deleted_at is null and tenant_id = $1) as items,
                (select name from tenants where id = $1) as tenant`,
        [ctx.tenantId],
      )
      .then((r) => r.rows[0] as { receipts: number; flagged: number; sales: string; items: number; tenant: string }),
  );
  return (
    <div>
      <h1>{stats.tenant}</h1>
      <p>
        {fmtRs(Number(stats.sales))} sales · {stats.receipts} receipts · {stats.items} items
        {stats.flagged > 0 && <strong style={{ color: "red" }}> · {stats.flagged} need review</strong>}
      </p>
      <ul>
        <li>
          <Link href="/backoffice/categories">Categories</Link>
        </li>
        <li>
          <Link href="/backoffice/items">Items</Link>
        </li>
        <li>
          <Link href="/backoffice/receipts">Receipts</Link>
        </li>
      </ul>
    </div>
  );
}
