"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requirePerm } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { barcodesForNewLines, skusForNewLines } from "@/lib/saves";
import { branches, pickedOf, workingBranch } from "@/lib/branch";
import type { CatalogRow } from "@/lib/catalog-rows";

// One line of the file as the database takes it: see lib/catalog-rows.
export type ImportRow = CatalogRow;
export type ImportResult = {
  dry: boolean; rows: number; good: number; products: number; new_products: number; lines: number; new_lines: number;
  stock_set?: number; stock_skipped?: number;
  // barcodes made for the lines the file added with none (a shop that has them made automatically)
  barcodes?: number;
  // SKUs made from the names for the lines the file added with none (migration 0150)
  skus?: number;
  // what the file adds besides products (migration 0081): categories, removed categories brought back, suppliers
  new_categories?: string[]; revived_categories?: string[]; new_suppliers?: string[];
  problems: { n: number; name: string | null; why: string }[];
};

// A dry run (nothing saved, every problem named) or the real one. Called by
// the import screen itself, twice: once to show what would happen, once to do it.
export async function importCatalog(rows: ImportRow[], dry: boolean): Promise<{ ok: true; result: ImportResult } | { ok: false; message: string }> {
  try {
    const ctx = await requirePerm("items.edit");
    // a file writes costs: it is for someone who may see them
    await requirePerm("costs.view");
    if (ctx.mode !== "retail") return { ok: false, message: "Importing a catalog is for shops." };
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: "The file has no rows." };
    if (rows.length > 5000) return { ok: false, message: "A file can hold 5,000 rows at most. Split it in two." };
    const result = await withTenant(ctx.tenantId, async (c) => {
      // opening stock and reorder levels are a branch's (multi-branch): the one picked at the top, or the only one.
      // Products alone are the whole account's, and need no branch.
      const all = await branches(c, ctx.tenantId);
      const store = workingBranch(all, await pickedOf(all))?.id ?? null;
      if (!store && rows.some((x) => (x.stock ?? 0) > 0 || x.reorder != null || x.order_qty != null)) throw new Error("pick-branch");
      const r = await c.query(`select catalog_import($1, $2, $3, $4::jsonb, $5) as r`, [ctx.tenantId, store ?? all[0].id, ctx.employeeId, JSON.stringify(rows), dry]);
      const out = r.rows[0].r as ImportResult;
      if (dry) return out;
      // a shop that has its barcodes made automatically: the lines this file added with none get theirs;
      // and every shop's get a SKU made from the name and the values
      return { ...out, barcodes: await barcodesForNewLines(c, ctx.tenantId), skus: await skusForNewLines(c, ctx.tenantId) };
    });
    if (!dry) revalidatePath("/backoffice/items");
    return { ok: true, result };
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    return {
      ok: false,
      message: said.startsWith("Forbidden")
        ? "You are not allowed to change the catalog."
        : said.includes("suspended")
          ? said
          : said === "pick-branch"
            ? "The file has stock or reorder levels: pick the branch they are for at the top of the page, then import it again."
            : "The file could not be read into the catalog. Nothing was changed.",
    };
  }
}
