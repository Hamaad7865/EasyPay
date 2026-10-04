import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { FloorEditor } from "./floor-editor";
import type { FloorTable } from "./actions";

export default async function TablesPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const data = await withTenant(ctx.tenantId, async (c) => {
    const stores = await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]);
    const list = stores.rows as { id: string; name: string }[];
    const store = list.find((s) => s.id === sp.store) ?? list[0] ?? null;
    if (!store) return { stores: list, store: null, tables: [] as FloorTable[], occupied: [] as string[], may: false };
    const tables = await c.query(
      `select id, name, area, seats, shape, x, y, w, h from tables
        where tenant_id = $1 and store_id = $2 and deleted_at is null order by sort_order, name`,
      [ctx.tenantId, store.id],
    );
    const occupied = await c.query(
      `select distinct table_id from tickets
        where tenant_id = $1 and store_id = $2 and status = 'open' and deleted_at is null and table_id is not null`,
      [ctx.tenantId, store.id],
    );
    const may = await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId]);
    return {
      stores: list,
      store,
      tables: tables.rows as FloorTable[],
      occupied: occupied.rows.map((r) => r.table_id as string),
      may: Boolean(may.rows[0]?.ok) && ctx.status === "active",
    };
  });
  return (
    <div>
      <h1>Tables</h1>
      {data.stores.length > 1 && (
        <p className="bo-chips">
          {data.stores.map((s) => (
            <a key={s.id} href={`/backoffice/tables?store=${s.id}`} className={s.id === data.store?.id ? "on" : undefined}>
              {s.name}
            </a>
          ))}
        </p>
      )}
      {data.store ? (
        // a different store is a different plan: start the editor afresh
        <FloorEditor key={data.store.id} storeId={data.store.id} initial={data.tables} occupied={data.occupied} canEdit={data.may} />
      ) : (
        <p className="muted">This restaurant has no store yet.</p>
      )}
    </div>
  );
}
