import { Truck } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, Refused, text, uuid } from "@/lib/action";
import { Card, Empty, Flash, PageHead, type Search, startKey, startOf } from "../ui";
import { type Supplier, SuppliersTable } from "./table";
import { Submit } from "../busy";

const PATH = "/backoffice/suppliers";

function fields(f: FormData) {
  const name = text(f, "name", 120);
  if (!name) throw new Refused("A supplier needs a name.");
  return [name, text(f, "contact", 120) || null, text(f, "phone", 40) || null, text(f, "email", 120) || null, text(f, "address", 200) || null, text(f, "note", 200) || null] as const;
}

async function addSupplier(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const [name, contact, phone, email, address, note] = fields(f);
    await c.query(`insert into suppliers (tenant_id, name, contact, phone, email, address, note) values ($1, $2, $3, $4, $5, $6, $7)`, [
      ctx.tenantId, name, contact, phone, email, address, note,
    ]);
    return `${name} added. Choose them on a product under Stock.`;
  });
}

async function saveSupplier(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
    const [name, contact, phone, email, address, note] = fields(f);
    await c.query(
      `update suppliers set name = $3, contact = $4, phone = $5, email = $6, address = $7, note = $8
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, uuid(f, "id"), name, contact, phone, email, address, note],
    );
    return `${name} saved.`;
  });
}

// A supplier who is removed stays on the products that name them, shown as
// "no supplier" until another is chosen: nothing of a product is lost.
async function removeSupplier(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
    await c.query(`update suppliers set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, uuid(f, "id")]);
    return "Supplier removed. Their products are kept.";
  });
}

type Row = { id: string; name: string; contact: string | null; phone: string | null; email: string | null; address: string | null; note: string | null; products: number };

export default async function SuppliersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const d = await readTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select s.id, s.name, s.contact, s.phone, s.email, s.address, s.note,
                (select count(*)::int from items i where i.tenant_id = s.tenant_id and i.supplier_id = s.id and i.deleted_at is null) as products
           from suppliers s
          where s.tenant_id = $1 and s.deleted_at is null
          order by lower(s.name)`,
        [ctx.tenantId],
      )
    ).rows as Row[],
  }));
  const clean = (v: string | null) => v?.trim() || null;
  const rows: Supplier[] = d.rows.map((r) => ({ ...r, contact: clean(r.contact), phone: clean(r.phone), email: clean(r.email), address: clean(r.address), note: clean(r.note) }));
  const start = startOf(sp, "q", "sort", "open");
  return (
    <div>
      <PageHead title="Suppliers" lede="Who the shop buys from. A product names its supplier, with the code that supplier knows it by, so an order to them can be put together from what is running low." />
      <Flash sp={sp} />
      <Card title="Add a supplier">
        <form action={addSupplier} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={120} />
          <input name="contact" placeholder="Contact person" maxLength={120} />
          <input name="phone" placeholder="Phone" maxLength={40} inputMode="tel" />
          <input name="email" placeholder="Email" maxLength={120} inputMode="email" />
          <Submit>Add</Submit>
        </form>
      </Card>
      {rows.length === 0 ? (
        <Empty icon={Truck} title="No suppliers yet">Add the first one above. A product can then be given its supplier.</Empty>
      ) : (
        <SuppliersTable key={startKey(sp, start)} rows={rows} start={start} save={saveSupplier} remove={removeSupplier} />
      )}
    </div>
  );
}
