import Link from "next/link";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { Wait } from "../busy";
import { NewFloor } from "./new-floor";

type Floor = { name: string; tables: number; covers: number };

// The floors of a store, each with how many tables and covers it has. A floor
// is the name its tables share (tables.area); its plan is drawn on the next page.
export default async function FloorPlansPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const sp = await searchParams;
  const ctx = await onlyFor("restaurant");
  const data = await readTenant(ctx.tenantId, async (c) => {
    const stores = await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]);
    const list = stores.rows as { id: string; name: string }[];
    const store = list.find((s) => s.id === sp.store) ?? list[0] ?? null;
    if (!store) return { stores: list, store: null, floors: [] as Floor[], may: false };
    const floors = await c.query(
      `select area as name, count(*)::int as tables, coalesce(sum(seats), 0)::int as covers
         from tables where tenant_id = $1 and store_id = $2 and deleted_at is null
        group by area order by area`,
      [ctx.tenantId, store.id],
    );
    const may = await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId]);
    return { stores: list, store, floors: floors.rows as Floor[], may: Boolean(may.rows[0]?.ok) && ctx.status === "active" };
  });
  const plan = (floor: string) => `/backoffice/tables/plan?store=${data.store?.id}&floor=${encodeURIComponent(floor)}`;
  return (
    <div>
      <div className="page-head">
        <h1>Floor plan</h1>
        {data.store && data.may && <NewFloor storeId={data.store.id} existing={data.floors.map((f) => f.name)} />}
      </div>
      {data.stores.length > 1 && (
        <p className="bo-chips">
          {data.stores.map((s) => (
            <Link key={s.id} href={`/backoffice/tables?store=${s.id}`} className={s.id === data.store?.id ? "on" : undefined}>
              {s.name}
              <Wait />
            </Link>
          ))}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Floor name</th>
            <th>Tables</th>
            <th>Covers</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.floors.map((f) => (
            <tr key={f.name}>
              <td>
                <Link href={plan(f.name)}>{f.name}</Link>
              </td>
              <td>{f.tables}</td>
              <td>{f.covers}</td>
              <td>
                <Link className="btn-quiet" href={plan(f.name)}>
                  {data.may ? "Edit" : "View"}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.floors.length === 0 && (
        <p className="muted">
          {data.store ? "No floor plan yet. Add one, then add its tables; the tablets show it under Tables." : "This restaurant has no store yet."}
        </p>
      )}
    </div>
  );
}
