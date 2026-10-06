import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";

// A backup the owner can keep: everything the restaurant has in EasyPay, as
// one JSON file. PINs are left out (they are stored hashed and are of no use
// outside the system).
const TABLES = [
  "categories", "items", "item_taxes", "modifier_groups", "modifiers", "item_modifier_groups", "taxes", "discounts",
  "dining_options", "payment_types", "stores", "pos_devices", "roles", "tables", "printers", "pos_settings",
  "tickets", "ticket_lines", "ticket_line_modifiers", "receipts", "receipt_lines", "receipt_line_modifiers",
  "receipt_line_taxes", "receipt_payments", "receipt_discounts", "payment_corrections", "shifts",
  "timeclock_punches", "cash_movements", "drawer_counts", "day_closes", "approvals", "bookings", "stock_movements",
];

export async function GET() {
  let ctx;
  try {
    ctx = await requirePerm("settings.device");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // a redirect to the sign-in page
    return new Response("You are not allowed to download a backup.", { status: 403 });
  }
  const out = await readTenant(ctx.tenantId, async (c) => {
    const data: Record<string, unknown> = {};
    for (const t of TABLES) {
      const r = await c.query(`select coalesce(json_agg(x), '[]'::json) as rows from (select * from ${t} where tenant_id = $1) x`, [ctx.tenantId]);
      data[t] = r.rows[0].rows;
    }
    const staff = await c.query(
      `select coalesce(json_agg(x), '[]'::json) as rows from (select id, name, role_id, is_active, created_at, deleted_at from employees where tenant_id = $1) x`,
      [ctx.tenantId],
    );
    data.employees = staff.rows[0].rows;
    const t = await c.query(`select name, brn, vat_number, country, currency from tenants where id = $1`, [ctx.tenantId]);
    return { restaurant: t.rows[0], exported_at: new Date().toISOString(), format: 1, data };
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(out), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="restopos-backup-${day}.json"`,
      "cache-control": "no-store",
    },
  });
}
