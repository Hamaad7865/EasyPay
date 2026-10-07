"use server";

import { unstable_rethrow } from "next/navigation";
import { requirePerm } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { countProblem } from "@/lib/counts";

// What the counting box asks for, one line at a time, without drawing the
// page again: a scan (one more of what was scanned) or a quantity typed for a
// line. Both go through count_add (migration 0075), which holds the count's
// row, so a count cannot be completed under a scan.

export type Counted = { ok: true; label: string; counted: number } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function counting(run: (tenantId: string, employeeId: string) => Promise<Counted>): Promise<Counted> {
  try {
    const ctx = await requirePerm("stock.count");
    if (ctx.mode !== "retail") return { ok: false, message: "Counting stock is for shops." };
    return await run(ctx.tenantId, ctx.employeeId);
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    return {
      ok: false,
      message: said.startsWith("Forbidden")
        ? "Your role cannot run stock counts."
        : said.includes("suspended")
          ? said
          : (countProblem(said) ?? "That could not be counted. Try again."),
    };
  }
}

// A scanned code: the barcode or the SKU of a product, or of one variant.
// The product does not have to be in the count's scope: it is on the shelf.
export async function countScan(countId: string, code: string): Promise<Counted> {
  const typed = String(code ?? "").trim().slice(0, 80);
  if (!UUID.test(String(countId)) || typed === "") return { ok: false, message: "Scan a barcode, or pick a product." };
  return counting((tenantId, employeeId) =>
    withTenant(tenantId, async (c) => {
      const found = await c.query(
        `select i.id as item, v.id as variant, i.name, v.name as vname
           from items i
           left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
          where i.tenant_id = $1 and i.deleted_at is null
            and (lower(case when v.id is null then i.barcode else v.barcode end) = lower($2)
              or lower(case when v.id is null then i.sku else v.sku end) = lower($2))
          limit 2`,
        [tenantId, typed],
      );
      if (found.rowCount === 0) return { ok: false, message: `No product has the code ${typed}.` };
      if (found.rowCount !== 1) return { ok: false, message: `Two products share the code ${typed}. Pick the product by its name.` };
      const p = found.rows[0] as { item: string; variant: string | null; name: string; vname: string | null };
      const n = (await c.query(`select count_add($1, $2, $3, $4, 1000, 'add', $5) as n`, [tenantId, countId, p.item, p.variant, employeeId])).rows[0].n as number;
      return { ok: true, label: p.name + (p.vname ? ", " + p.vname : ""), counted: n };
    }),
  );
}

// A quantity typed for a line (thousandths): it replaces what the line was counted at.
export async function countSet(countId: string, item: string, variant: string | null, units: number, label: string): Promise<Counted> {
  if (!UUID.test(String(countId)) || !UUID.test(String(item)) || (variant !== null && !UUID.test(String(variant))) || !Number.isInteger(units) || units < 0) {
    return { ok: false, message: "Type how many, as a number of zero or more." };
  }
  return counting((tenantId, employeeId) =>
    withTenant(tenantId, async (c) => {
      const n = (await c.query(`select count_add($1, $2, $3, $4, $5, 'set', $6) as n`, [tenantId, countId, item, variant, units, employeeId])).rows[0].n as number;
      return { ok: true, label: String(label).slice(0, 160), counted: n };
    }),
  );
}
