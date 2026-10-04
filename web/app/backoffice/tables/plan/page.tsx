import Link from "next/link";
import { redirect } from "next/navigation";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { FloorEditor } from "../floor-editor";
import type { FloorTable } from "../actions";

// One floor's plan: its tables, where they stand, and a way to add more.
export default async function FloorPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; floor?: string; add?: string }>;
}) {
  const sp = await searchParams;
  const floor = (sp.floor ?? "").trim().slice(0, 30);
  if (!floor) redirect("/backoffice/tables");
  const ctx = await tenantContext();
  const data = await withTenant(ctx.tenantId, async (c) => {
    const stores = await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]);
    const list = stores.rows as { id: string; name: string }[];
    const store = list.find((s) => s.id === sp.store) ?? list[0] ?? null;
    if (!store) return null;
    const tables = await c.query(
      `select id, name, area, seats, shape, x, y, w, h from tables
        where tenant_id = $1 and store_id = $2 and area = $3 and deleted_at is null order by sort_order, name`,
      [ctx.tenantId, store.id, floor],
    );
    // names taken on the store's other floors: a table name is unique in a store
    const elsewhere = await c.query(
      `select name from tables where tenant_id = $1 and store_id = $2 and area <> $3 and deleted_at is null`,
      [ctx.tenantId, store.id, floor],
    );
    const occupied = await c.query(
      `select distinct table_id from tickets
        where tenant_id = $1 and store_id = $2 and status = 'open' and deleted_at is null and table_id is not null`,
      [ctx.tenantId, store.id],
    );
    const may = await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId]);
    return {
      store,
      tables: tables.rows as FloorTable[],
      elsewhere: elsewhere.rows.map((r) => r.name as string),
      occupied: occupied.rows.map((r) => r.table_id as string),
      may: Boolean(may.rows[0]?.ok) && ctx.status === "active",
    };
  });
  if (!data) redirect("/backoffice/tables");
  return (
    <div>
      <p className="crumb">
        <Link href={`/backoffice/tables?store=${data.store.id}`}>Floor plan</Link> ›
      </p>
      {/* another floor is another plan: start the editor afresh */}
      <FloorEditor
        key={data.store.id + floor}
        storeId={data.store.id}
        floor={floor}
        initial={data.tables}
        namesElsewhere={data.elsewhere}
        occupied={data.occupied}
        canEdit={data.may}
        openAdd={sp.add === "1" && data.tables.length === 0}
      />
    </div>
  );
}
