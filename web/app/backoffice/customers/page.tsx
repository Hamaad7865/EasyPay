import { Contact } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";

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
  await act("backoffice.access", PATH, async (c, ctx) => {
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
  await act("backoffice.access", PATH, async (c, ctx) => {
    await c.query(`update customers set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, uuid(f, "id")]);
    return "Customer removed. Their past orders are kept.";
  });
}

type Row = { id: string; name: string; phone: string | null; email: string | null; note: string | null; orders: number; spent: string };

export default async function CustomersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").trim().slice(0, 60);
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
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
            and ($2 = '' or cu.name ilike '%' || $2 || '%' or cu.phone ilike '%' || $2 || '%' or cu.email ilike '%' || $2 || '%')
          order by lower(cu.name) limit 500`,
        [ctx.tenantId, q],
      )
    ).rows as Row[],
  }));
  return (
    <div>
      <PageHead
        title="Customers"
        lede="The people the restaurant knows by name. A cashier puts one on an order with Assign customer; their name then prints on the bill and the receipt. They can be added here or on the till."
      />
      <Flash sp={sp} />
      <form className="filters" action={PATH}>
        <input name="q" defaultValue={q} placeholder="Search by name, phone or email" aria-label="Search" />
        <button type="submit" className="btn-quiet">Search</button>
      </form>
      {d.rows.length === 0 ? (
        <Empty icon={Contact} title={q ? "No customer matches that" : "No customers yet"}>Add the first one below, or from the till.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Note</th>
              <th className="num">Orders</th>
              <th className="num">Spent</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td><input form={"c" + r.id} name="name" defaultValue={r.name} required maxLength={120} aria-label="Name" /></td>
                <td><input form={"c" + r.id} name="phone" defaultValue={r.phone ?? ""} maxLength={40} aria-label="Phone" /></td>
                <td><input form={"c" + r.id} name="email" defaultValue={r.email ?? ""} maxLength={120} aria-label="Email" /></td>
                <td><input form={"c" + r.id} name="note" defaultValue={r.note ?? ""} maxLength={200} aria-label="Note" /></td>
                <td className="num">{r.orders}</td>
                <td className="num strong">{money(Number(r.spent), d.s.decimals)}</td>
                <td>
                  <span className="row-actions">
                    <form id={"c" + r.id} action={saveCustomer}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="btn-quiet btn-sm">Save</button>
                    </form>
                    <form action={removeCustomer}>
                      <input type="hidden" name="id" value={r.id} />
                      <button type="submit" className="btn-quiet btn-sm">Remove</button>
                    </form>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Card title="Add a customer">
        <form action={addCustomer} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name" required maxLength={120} />
          <input name="phone" placeholder="Phone" maxLength={40} />
          <input name="email" placeholder="Email" maxLength={120} />
          <input name="note" placeholder="Note (allergies, what they like)" maxLength={200} />
          <button type="submit">Add</button>
        </form>
      </Card>
    </div>
  );
}
