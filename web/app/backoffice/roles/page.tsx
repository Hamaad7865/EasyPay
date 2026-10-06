import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { Card, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/roles";

// Every permission the tills and the back office check, in the words of what
// it lets someone do.
const GROUPS: { title: string; perms: [string, string][] }[] = [
  {
    title: "Selling",
    perms: [
      ["sale.create", "Take orders"],
      ["payment.take", "Take payment"],
      ["sale.apply_discount", "Give a discount"],
      ["sale.apply_restricted_discount", "Give a discount that needs a manager"],
      ["sale.void_line", "Delete an item before it is sent to the kitchen"],
      ["sale.void_sent_line", "Void an item after it was sent"],
      ["sale.refund", "Refund a receipt"],
      ["payment.correct", "Correct the payment type on a paid bill"],
    ],
  },
  {
    title: "Orders and tables",
    perms: [
      ["ticket.view_all", "See everyone's orders"],
      ["ticket.reassign", "Change the waiter on an order"],
      ["ticket.split_merge", "Transfer an order to another table"],
      ["items.availability", "Mark an item sold out or back on sale on the till"],
    ],
  },
  {
    title: "Cash",
    perms: [
      ["drawer.open_no_sale", "Open the cash drawer without a sale"],
      ["cash.pay_in_out", "Put cash in and take cash out"],
      ["shift.open_close", "Open and close a sales period, count the drawer, close the day"],
      ["shift.view_report", "See the sales period and day figures on the till"],
    ],
  },
  {
    title: "Receipts",
    perms: [
      ["receipts.view_all", "See all receipts and the day’s payments"],
      ["receipts.reprint", "Reprint receipts, bills and kitchen orders"],
    ],
  },
  {
    title: "Back office",
    perms: [
      ["backoffice.access", "Sign in to the back office"],
      ["reports.view", "See reports"],
      ["items.edit", "Edit the menu, taxes and stock"],
      ["employees.edit", "Manage staff and roles"],
      ["settings.device", "Change settings, printers and tables; change how a till is set up and sign it out"],
    ],
  },
];
const KNOWN = new Set(GROUPS.flatMap((g) => g.perms.map(([k]) => k)));

async function addRole(f: FormData) {
  "use server";
  await act("employees.edit", PATH, async (c, ctx) => {
    const name = text(f, "name", 30);
    if (!name) throw new Refused("Give the role a name.");
    await c.query(`insert into roles (tenant_id, name, permissions) values ($1, $2, '["sale.create"]'::jsonb)`, [ctx.tenantId, name]);
    return `${name} added. Tick what it may do.`;
  });
}

async function saveRole(f: FormData) {
  "use server";
  await act("employees.edit", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    const row = await c.query(`select name, permissions from roles where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
    if (row.rowCount !== 1) throw new Refused("That role no longer exists.");
    if ((row.rows[0].permissions as string[]).includes("*")) throw new Refused("The owner's role can do everything and cannot be changed.");
    if (f.get("remove") === "1") {
      const used = await c.query(`select count(*)::int as n from employees where tenant_id = $1 and role_id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      if (used.rows[0].n > 0) throw new Refused(`${used.rows[0].n} member(s) of staff still have this role. Give them another role first.`);
      await c.query(`update roles set deleted_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      return "Role removed.";
    }
    const name = text(f, "name", 30);
    if (!name) throw new Refused("A role needs a name.");
    const perms = f.getAll("perm").map(String).filter((p) => KNOWN.has(p));
    // permissions this page does not list stay as they were
    const kept = (row.rows[0].permissions as string[]).filter((p) => !KNOWN.has(p));
    await c.query(`update roles set name = $3, permissions = $4::jsonb where tenant_id = $1 and id = $2`, [ctx.tenantId, id, name, JSON.stringify([...kept, ...perms])]);
    return `${name} saved. It applies on the tills from their next sync.`;
  });
}

type Role = { id: string; name: string; permissions: string[]; staff: number };

export default async function RolesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const roles = await readTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select r.id, r.name, r.permissions,
                (select count(*)::int from employees e where e.tenant_id = r.tenant_id and e.role_id = r.id and e.deleted_at is null) as staff
           from roles r where r.tenant_id = $1 and r.deleted_at is null order by r.created_at, r.name`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as Role[]),
  );
  return (
    <div>
      <PageHead title="Roles and permissions" lede="What each role may do on the tills and here. A member of staff gets a role on the Staff page.">
        <Link href="/backoffice/staff" className="btn-quiet">Staff</Link>
      </PageHead>
      <Flash sp={sp} />
      <Card title="Add a role">
        <form action={addRole} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name, for example Supervisor" required maxLength={30} style={{ minWidth: 260 }} />
          <button type="submit">Add role</button>
        </form>
      </Card>
      {roles.map((r) => {
        const all = r.permissions.includes("*");
        return (
          <details key={r.id} className="card flush" open={roles.length <= 2}>
            <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
              <div>
                <h2>{r.name}</h2>
                <p>{all ? "Can do everything" : `${r.permissions.filter((p) => KNOWN.has(p)).length} of ${KNOWN.size} permissions`}</p>
              </div>
              <span className="badge">{r.staff} {r.staff === 1 ? "person" : "people"}</span>
            </summary>
            {all ? (
              <div className="card-body muted">The owner&apos;s role can do everything, including what is added later. It cannot be changed.</div>
            ) : (
              <form action={saveRole}>
                <input type="hidden" name="id" value={r.id} />
                <div className="card-body">
                  <label className="field">
                    Role name
                    <input name="name" defaultValue={r.name} required maxLength={30} />
                  </label>
                  <div className="grid-3">
                    {GROUPS.map((g) => (
                      <div key={g.title}>
                        <h3>{g.title}</h3>
                        {g.perms.map(([k, label]) => (
                          <label key={k} className="check">
                            <input type="checkbox" name="perm" value={k} defaultChecked={r.permissions.includes(k)} />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card-foot">
                  <button type="submit" name="remove" value="1" className="btn-danger" formNoValidate>Remove role</button>
                  <button type="submit">Save role</button>
                </div>
              </form>
            )}
          </details>
        );
      })}
    </div>
  );
}
