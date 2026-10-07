import { Contact } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { Card, Empty, Flash, PageHead, type Search, startKey, startOf } from "../ui";
import { type Customer, CustomersTable } from "./table";
import { Submit } from "../busy";

const PATH = "/backoffice/customers";

function fields(f: FormData) {
  const name = text(f, "name", 120);
  if (!name) throw new Refused("A customer needs a name.");
  return [name, text(f, "phone", 40) || null, text(f, "email", 120) || null, text(f, "note", 200) || null] as const;
}

async function addCustomer(f: FormData) {
  "use server";
  await act("backoffice.access", PATH, async (c, ctx) => {
    const [name, phone, email, note] = fields(f);
    await c.query(`insert into customers (tenant_id, name, phone, email, note) values ($1, $2, $3, $4, $5)`, [ctx.tenantId, name, phone, email, note]);
    return `${name} added. The tills have them after their next sync.`;
  });
}

async function saveCustomer(f: FormData) {
  "use server";
  await act("backoffice.access", backTo(f, PATH), async (c, ctx) => {
    const [name, phone, email, note] = fields(f);
    await c.query(`update customers set name = $3, phone = $4, email = $5, note = $6 where tenant_id = $1 and id = $2 and deleted_at is null`, [
      ctx.tenantId, uuid(f, "id"), name, phone, email, note,
    ]);
    return `${name} saved.`;
  });
}

// A customer who is removed stays on the orders and receipts they were on.
async function removeCustomer(f: FormData) {
  "use server";
  await act("backoffice.access", backTo(f, PATH), async (c, ctx) => {
    await c.query(`update customers set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, uuid(f, "id")]);
    return "Customer removed. Their past orders are kept.";
  });
}

type Row = { id: string; name: string; phone: string | null; email: string | null; note: string | null; orders: number; spent: string };
// Every customer comes down once and the table finds among them as you type.
// A list longer than this is cut, and the table says so.
const MOST = 5000;

export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => ({
    s: await loadSettings(c, ctx.tenantId),
    rows: (
      await c.query(
        `select cu.id, cu.name, cu.phone, cu.email, cu.note,
                (select count(*)::int from tickets t where t.tenant_id = cu.tenant_id and t.customer_id = cu.id and t.deleted_at is null) as orders,
                (select coalesce(sum(case when r.type = 'refund' then -r.total else r.total end), 0)
                   from receipts r join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id
                  where r.tenant_id = cu.tenant_id and t.customer_id = cu.id and r.deleted_at is null) as spent
           from customers cu
          where cu.tenant_id = $1 and cu.deleted_at is null
          order by lower(cu.name) limit ${MOST + 1}`,
        [ctx.tenantId],
      )
    ).rows as Row[],
  }));
  const rows: Customer[] = d.rows.slice(0, MOST).map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone?.trim() || null,
    email: r.email?.trim() || null,
    note: r.note?.trim() || null,
    orders: r.orders,
    spent: Number(r.spent),
    spent_shown: money(Number(r.spent), d.s.decimals),
  }));
  const start = startOf(sp, "q", "seen", "sort", "open");
  return (
    <div>
      <PageHead
        title="Customers"
        lede="The people the restaurant knows by name. A cashier puts one on an order with Assign customer; their name then prints on the bill and the receipt. They can be added here or on the till."
      />
      <Flash sp={sp} />
      <Card title="Add a customer">
        <form action={addCustomer} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={120} />
          <input name="phone" placeholder="Phone" maxLength={40} />
          <input name="email" placeholder="Email" maxLength={120} />
          <input name="note" placeholder="Note (allergies, what they like)" maxLength={200} />
          <Submit>Add</Submit>
        </form>
      </Card>
      {d.rows.length === 0 ? (
        <Empty icon={Contact} title="No customers yet">Add the first one above, or from the till.</Empty>
      ) : (
        <CustomersTable key={startKey(sp, start)} rows={rows} capped={d.rows.length > MOST} start={start} save={saveCustomer} remove={removeCustomer} />
      )}
    </div>
  );
}
