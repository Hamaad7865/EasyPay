import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";

export default async function BackofficeHome() {
  const ctx = await tenantContext();
  const stats = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select (select count(*)::int from receipts where deleted_at is null) as receipts,
                (select count(*)::int from receipts where needs_review and deleted_at is null) as flagged,
                (select count(*)::int from items where deleted_at is null) as items,
                (select name from tenants limit 1) as tenant`,
      )
      .then((r) => r.rows[0] as { receipts: number; flagged: number; items: number; tenant: string }),
  );
  return (
    <div>
      <h1>{stats.tenant}</h1>
      <p>
        {stats.receipts} receipts · {stats.items} items
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
