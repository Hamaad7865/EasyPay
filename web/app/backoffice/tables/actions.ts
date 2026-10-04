"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requirePerm, type TenantContext } from "@/lib/tenant";
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

type Result = { ok: true } | { error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
const floorName = (v: unknown) => String(v ?? "").trim().slice(0, 30);

// Owners and managers lay out floors (settings.device).
async function allowed(): Promise<{ ctx: TenantContext; error?: undefined } | { ctx?: undefined; error: string }> {
  try {
    return { ctx: await requirePerm("settings.device") };
  } catch (e) {
    unstable_rethrow(e);
    return { error: e instanceof Error ? e.message : "Not allowed." };
  }
}

// Saves the tables given (one floor's, as they are on the screen) and removes
// the ones that were taken off, in one transaction.
export async function saveFloor(storeId: string, tables: FloorTable[], removed: string[]): Promise<Result> {
  const who = await allowed();
  if (!who.ctx) return { error: who.error };
  const ctx = who.ctx;
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
      area: floorName(t.area) || "Main",
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
    if (code === "23505") return { error: "Another table in this store already has one of these names (it may be on another floor)." };
    if (e instanceof Error && e.message === "unknown-store") return { error: "Unknown store." };
    return { error: "The plan could not be saved. Nothing was changed." };
  }
  revalidatePath("/backoffice/tables");
  return { ok: true };
}

// A floor is the name its tables share, so renaming it renames it on all of them.
export async function renameFloor(storeId: string, from: string, to: string): Promise<Result> {
  const who = await allowed();
  if (!who.ctx) return { error: who.error };
  const ctx = who.ctx;
  const next = floorName(to);
  if (!UUID.test(storeId) || !next) return { error: "Give the floor a name." };
  if (next === from) return { ok: true };
  const outcome = await withTenant(ctx.tenantId, async (c) => {
    const clash = await c.query(
      `select 1 from tables where tenant_id = $1 and store_id = $2 and lower(area) = lower($3) and area <> $4 and deleted_at is null limit 1`,
      [ctx.tenantId, storeId, next, from],
    );
    if (clash.rowCount) return "clash";
    await c.query(`update tables set area = $4 where tenant_id = $1 and store_id = $2 and area = $3 and deleted_at is null`, [
      ctx.tenantId,
      storeId,
      from,
      next,
    ]);
    return "ok";
  });
  if (outcome === "clash") return { error: `There is already a floor called "${next}".` };
  revalidatePath("/backoffice/tables");
  return { ok: true };
}

// Removes a floor: every table on it. An order open on one of them stays open
// on the tills, under Orders, without a table.
export async function deleteFloor(storeId: string, floor: string): Promise<Result> {
  const who = await allowed();
  if (!who.ctx) return { error: who.error };
  const ctx = who.ctx;
  if (!UUID.test(storeId)) return { error: "Unknown store." };
  await withTenant(ctx.tenantId, (c) =>
    c.query(`update tables set deleted_at = now() where tenant_id = $1 and store_id = $2 and area = $3 and deleted_at is null`, [
      ctx.tenantId,
      storeId,
      floor,
    ]),
  );
  revalidatePath("/backoffice/tables");
  return { ok: true };
}
