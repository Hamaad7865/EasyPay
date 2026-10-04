"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requirePerm } from "@/lib/tenant";
import { withTenant } from "@/lib/db";

// A table on the plan. Positions and sizes are grid units on a 100 x 60 plan
// (migration 0048), so a till can scale the plan to its own screen.
export type FloorTable = {
  id: string;
  name: string;
  area: string;
  seats: number;
  shape: "square" | "round";
  x: number;
  y: number;
  w: number;
  h: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

// Saves the whole plan of one store in one transaction: every table as it is
// on the screen, and the ones that were removed.
export async function saveFloor(
  storeId: string,
  tables: FloorTable[],
  removed: string[],
): Promise<{ ok: true } | { error: string }> {
  let ctx;
  try {
    ctx = await requirePerm("settings.device");
  } catch (e) {
    unstable_rethrow(e);
    return { error: e instanceof Error ? e.message : "Not allowed." };
  }
  if (!UUID.test(storeId)) return { error: "Unknown store." };
  if (!Array.isArray(tables) || tables.length > 300) return { error: "Too many tables." };
  const clean: FloorTable[] = [];
  const names = new Set<string>();
  for (const t of tables) {
    const name = String(t.name ?? "").trim().slice(0, 30);
    if (!UUID.test(String(t.id)) || !name) return { error: "Every table needs a name." };
    if (names.has(name.toLowerCase())) return { error: `Two tables are called "${name}". Give each its own name.` };
    names.add(name.toLowerCase());
    const w = int(t.w, 4, 100);
    const h = int(t.h, 4, 60);
    clean.push({
      id: String(t.id),
      name,
      area: String(t.area ?? "").trim().slice(0, 30) || "Main",
      seats: int(t.seats, 1, 99),
      shape: t.shape === "round" ? "round" : "square",
      w,
      h,
      x: int(t.x, 0, 100 - w),
      y: int(t.y, 0, 60 - h),
    });
  }
  const gone = (Array.isArray(removed) ? removed : []).filter((id) => UUID.test(String(id)));
  try {
    await withTenant(ctx.tenantId, async (c) => {
      const store = await c.query(`select 1 from stores where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, storeId]);
      if (store.rowCount !== 1) throw new Error("unknown-store");
      if (gone.length > 0) {
        await c.query(
          `update tables set deleted_at = now() where tenant_id = $1 and store_id = $2 and id = any($3::uuid[]) and deleted_at is null`,
          [ctx.tenantId, storeId, gone],
        );
      }
      // Names are unique within a store. Two tables swapping names would trip
      // that halfway through, so existing rows first get a placeholder.
      await c.query(
        `update tables set name = '~' || id::text where tenant_id = $1 and store_id = $2 and id = any($3::uuid[]) and deleted_at is null`,
        [ctx.tenantId, storeId, clean.map((t) => t.id)],
      );
      for (const [i, t] of clean.entries()) {
        await c.query(
          `insert into tables (id, tenant_id, store_id, name, area, seats, shape, x, y, w, h, sort_order)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (id) do update set name = excluded.name, area = excluded.area, seats = excluded.seats,
             shape = excluded.shape, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
             sort_order = excluded.sort_order
           where tables.tenant_id = excluded.tenant_id and tables.store_id = excluded.store_id and tables.deleted_at is null`,
          [t.id, ctx.tenantId, storeId, t.name, t.area, t.seats, t.shape, t.x, t.y, t.w, t.h, i],
        );
      }
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return { error: "Two tables in this store have the same name." };
    if (e instanceof Error && e.message === "unknown-store") return { error: "Unknown store." };
    return { error: "The plan could not be saved. Nothing was changed." };
  }
  revalidatePath("/backoffice/tables");
  return { ok: true };
}
