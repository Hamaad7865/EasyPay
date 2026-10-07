import { Download } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text } from "@/lib/action";
import { Card, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

const PATH = "/backoffice/data";

// Both deletions are the owner's alone, and both ask for the restaurant's
// name to be typed: they cannot be undone from here.
async function deleteTransactions(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const t = await c.query(`select name from tenants where id = $1`, [ctx.tenantId]);
    if (text(f, "confirm", 80).toLowerCase() !== String(t.rows[0].name).trim().toLowerCase()) {
      throw new Refused("The name you typed does not match the restaurant's name. Nothing was deleted.");
    }
    let out;
    try {
      out = await c.query(`select purge_transactions($1, $2) as r`, [ctx.tenantId, ctx.employeeId]);
    } catch (e) {
      if (e instanceof Error && e.message === "forbidden") throw new Refused("Only the owner can delete all transactions.");
      throw e;
    }
    const r = out.rows[0].r as { receipts: number; orders: number };
    return `Deleted ${r.receipts} receipts and ${r.orders} orders. Sign each till out and in again before selling.`;
  });
}

async function deleteMenu(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const owner = await c.query(
      `select 1 from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id where e.id = $1 and r.permissions ? '*'`,
      [ctx.employeeId],
    );
    if (owner.rowCount !== 1) throw new Refused("Only the owner can delete the menu.");
    const t = await c.query(`select name from tenants where id = $1`, [ctx.tenantId]);
    if (text(f, "confirm", 80).toLowerCase() !== String(t.rows[0].name).trim().toLowerCase()) {
      throw new Refused("The name you typed does not match the restaurant's name. Nothing was deleted.");
    }
    const n = await c.query(`update items set deleted_at = now() where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
    await c.query(`update item_modifier_groups set deleted_at = now() where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
    await c.query(`update modifiers set deleted_at = now() where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
    await c.query(
      `update modifier_groups set deleted_at = now(), name = name || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')' where tenant_id = $1 and deleted_at is null`,
      [ctx.tenantId],
    );
    await c.query(`update categories set deleted_at = now() where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
    return `The menu is empty: ${n.rowCount} items removed. Receipts already issued keep the names of what was sold.`;
  });
}

export default async function DataPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => ({
    name: (await c.query(`select name from tenants where id = $1`, [ctx.tenantId])).rows[0].name as string,
    counts: (
      await c.query(
        `select (select count(*) from receipts where tenant_id = $1)::int as receipts,
                (select count(*) from tickets where tenant_id = $1)::int as orders,
                (select count(*) from items where tenant_id = $1 and deleted_at is null)::int as items`,
        [ctx.tenantId],
      )
    ).rows[0] as { receipts: number; orders: number; items: number },
    owner: (await c.query(`select has_perm($1, '*') as ok`, [ctx.employeeId])).rows[0].ok as boolean,
  }));
  return (
    <div>
      <PageHead title="Backup and data" lede="Your data is stored in the cloud, not on the tablets. A tablet that breaks or is lost takes nothing with it once it has synced." />
      <Flash sp={sp} />
      <div className="grid-2">
        <Card title="Automatic backup">
          <p>
            The database keeps a continuous history of recent changes. If something is deleted or changed by mistake, contact
            EasyPay support as soon as you can: the sooner you ask, the more can be recovered.
          </p>
          <p className="muted">Nothing to switch on: it is always running. For a copy that is yours to keep, use the manual backup.</p>
        </Card>
        <Card title="Manual backup">
          <p>Download everything this restaurant has in EasyPay as one file: the menu, staff, orders, receipts, the days' opening and closing counts, and stock.</p>
          <a href="/backoffice/data/export" className="btn" download>
            <Download aria-hidden="true" />
            Download a backup
          </a>
          <p className="muted" style={{ marginTop: 10 }}>Keep the file somewhere safe. It contains your sales.</p>
        </Card>
      </div>

      <h2 style={{ marginTop: 12 }}>Delete data</h2>
      <p className="lede">For a restaurant that has finished trying the system out. Only the owner can do this, and it cannot be undone from here. Download a backup first.</p>
      {!d.owner && <div className="note warn">You are not signed in as the owner, so the two actions below are switched off.</div>}
      <div className="grid-2">
        <Card title="Delete all transactions" lede={`${d.counts.receipts} receipts and ${d.counts.orders} orders today.`}>
          <p>Removes every order, receipt, refund, clock-in, cash movement and day (its opening, its counts and its closing). The menu, staff, tables, printers and settings stay. A till carries on from its own last bill number unless it is signed out and set up again.</p>
          <p className="flag">Receipts are tax records. Do not delete them once the restaurant is trading for real.</p>
          <form action={deleteTransactions}>
            <label className="field">
              Type the restaurant&apos;s name to confirm
              <input name="confirm" placeholder={d.name} required autoComplete="off" disabled={!d.owner} />
            </label>
            <Submit className="btn-danger" disabled={!d.owner}>Delete all transactions</Submit>
          </form>
        </Card>
        <Card title="Delete the menu" lede={`${d.counts.items} items today.`}>
          <p>Removes every category, item and add-on, so the menu can be built again from nothing. Receipts already issued keep the names and prices of what was sold.</p>
          <form action={deleteMenu}>
            <label className="field">
              Type the restaurant&apos;s name to confirm
              <input name="confirm" placeholder={d.name} required autoComplete="off" disabled={!d.owner} />
            </label>
            <Submit className="btn-danger" disabled={!d.owner}>Delete the menu</Submit>
          </form>
        </Card>
      </div>
    </div>
  );
}
