"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requirePerm } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import type { CatalogRow } from "@/lib/catalog-rows";

// One line of the file as the database takes it: see lib/catalog-rows.
export type ImportRow = CatalogRow;
export type ImportResult = {
  dry: boolean; rows: number; good: number; products: number; new_products: number; lines: number; new_lines: number;
  stock_set?: number; stock_skipped?: number;
  problems: { n: number; name: string | null; why: string }[];
};

// A dry run (nothing saved, every problem named) or the real one. Called by
// the import screen itself, twice: once to show what would happen, once to do it.
export async function importCatalog(rows: ImportRow[], dry: boolean): Promise<{ ok: true; result: ImportResult } | { ok: false; message: string }> {
  try {
    const ctx = await requirePerm("items.edit");
    if (ctx.mode !== "retail") return { ok: false, message: "Importing a catalog is for shops." };
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: "The file has no rows." };
    if (rows.length > 5000) return { ok: false, message: "A file can hold 5,000 rows at most. Split it in two." };
    const r = await withTenant(ctx.tenantId, (c) =>
      c.query(`select catalog_import($1, first_store($1), $2, $3::jsonb, $4) as r`, [ctx.tenantId, ctx.employeeId, JSON.stringify(rows), dry]),
    );
    if (!dry) revalidatePath("/backoffice/items");
    return { ok: true, result: r.rows[0].r as ImportResult };
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    return {
      ok: false,
      message: said.startsWith("Forbidden")
        ? "You are not allowed to change the catalog."
        : said.includes("suspended")
          ? said
          : "The file could not be read into the catalog. Nothing was changed.",
    };
  }
}
