import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { MOVE_LABEL } from "@/lib/stock";
import { type Move, moveFilters, moveParams, MOVES_SQL } from "../moves";

// The movements the page shows, all of them, as a spreadsheet: the same
// question with the same filters. The cost column is only there for someone
// who may see cost.

export const dynamic = "force-dynamic";

const MOST = 50000;
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requirePerm("stock.view");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // a redirect to the sign-in page
    return new Response("You are not allowed to download the stock movements.", { status: 403 });
  }
  if (ctx.mode !== "retail") return new Response("Not found", { status: 404 });
  const asked = new URL(req.url).searchParams;
  const f = moveFilters((k) => asked.get(k) ?? "");
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [costs, moves, shop] = await Promise.all([
      c.query(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId]),
      c.query(MOVES_SQL, moveParams(ctx.tenantId, f, MOST)),
      c.query(`select timezone from stores where tenant_id = $1 and id = first_store($1)`, [ctx.tenantId]),
    ]);
    return { costs: costs.rows[0].ok as boolean, moves: moves.rows as Move[], tz: (shop.rows[0]?.timezone as string) ?? "Indian/Mauritius" };
  });
  // the shop's own clock, written so a spreadsheet reads it as a date and time
  const when = new Intl.DateTimeFormat("sv-SE", { timeZone: d.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const head = ["When", "Product", "Variant", "What", "Quantity", ...(d.costs ? ["Unit cost"] : []), "By", "Note", "Receipt"];
  const lines = [head.map(cell).join(",")];
  for (const m of d.moves) {
    lines.push(
      [
        when.format(new Date(m.at)), m.item, m.variant, MOVE_LABEL[m.reason] ?? m.reason, String(m.qty / 1000),
        ...(d.costs ? [m.unit_cost === null ? "" : (Number(m.unit_cost) / 100).toFixed(2)] : []),
        m.who ?? "Till", m.note, m.receipt,
      ]
        .map(cell)
        .join(","),
    );
  }
  // the mark at the start tells a spreadsheet the file is UTF-8, so accents survive
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="stock-movements.csv"`,
      "cache-control": "no-store",
    },
  });
}
