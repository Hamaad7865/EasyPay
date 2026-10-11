import Link from "next/link";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { TABLE_ORDERING_LIVE } from "@/lib/plan";
import { Wait } from "../busy";
import { FloorDesigner } from "./designer";
import type { FloorElement, FloorTable } from "./actions";

// The floor plan of a store, an area at a time: the areas across the top, the
// plan of the one that is open under them. An area is the name its tables
// share (tables.area), so one named here is kept once a table is saved in it.
export default async function FloorPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ store?: string; floor?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await onlyFor("restaurant");
  const asked = (sp.floor ?? "").trim().slice(0, 30);
  const data = await readTenant(ctx.tenantId, async (c) => {
    const stores = await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]);
    const list = stores.rows as { id: string; name: string }[];
    const store = list.find((s) => s.id === sp.store) ?? list[0] ?? null;
    if (!store) return { stores: list, store: null };
    const rows = await c.query(
      `select id, name, area, seats, shape, x, y, w, h, rotation from tables
        where tenant_id = $1 and store_id = $2 and deleted_at is null order by sort_order, name`,
      [ctx.tenantId, store.id],
    );
    const all = rows.rows as FloorTable[];
    const floors = [...new Set(all.map((t) => t.area))].sort((a, b) => a.localeCompare(b));
    // the area that was asked for, as the store spells it; or the first; or a first one to draw
    const floor = floors.find((f) => f.toLowerCase() === asked.toLowerCase()) ?? (asked || floors[0] || "Main");
    const occupied = await c.query(
      `select distinct table_id from tickets
        where tenant_id = $1 and store_id = $2 and status = 'open' and deleted_at is null and table_id is not null`,
      [ctx.tenantId, store.id],
    );
    // what stands in the area beside its tables: walls, doors, windows, a bar (0102)
    const standing = await c.query(
      `select id, kind, x, y, w, h, rotation from floor_elements
        where tenant_id = $1 and store_id = $2 and area = $3 and deleted_at is null order by sort_order, id`,
      [ctx.tenantId, store.id, floor],
    );
    const may = await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId]);
    return {
      stores: list,
      store,
      floors,
      floor,
      elements: standing.rows as FloorElement[],
      tables: all.filter((t) => t.area === floor),
      // a table's number is its own in the whole store
      elsewhere: all.filter((t) => t.area !== floor).map((t) => t.name),
      occupied: occupied.rows.map((r) => r.table_id as string),
      may: Boolean(may.rows[0]?.ok) && ctx.status === "active",
    };
  });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Floor plan</h1>
          <p className="lede">Put the tables where they stand, and the walls round them, area by area. The tablets seat guests on this plan.</p>
        </div>
        {/* the cards guests scan to order from their table: a page of the premium tier */}
        {TABLE_ORDERING_LIVE && data.store && ctx.premium && (
          <Link className="btn-quiet" href={`/backoffice/tables/cards?store=${data.store.id}`}>
            Table cards
            <Wait />
          </Link>
        )}
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
      {data.store ? (
        // another area is another plan: the designer starts afresh
        <FloorDesigner
          key={data.store.id + "/" + data.floor}
          storeId={data.store.id}
          floor={data.floor}
          floors={data.floors}
          initial={data.tables}
          initialElements={data.elements}
          namesElsewhere={data.elsewhere}
          occupied={data.occupied}
          canEdit={data.may}
          saved={data.floors.includes(data.floor)}
        />
      ) : (
        <p className="muted">This restaurant has no store yet.</p>
      )}
    </div>
  );
}
