import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, on, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { Card, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/discounts";

// A discount is a percentage of the bill or an amount off it. The till works
// a percentage out in whole percents, so that is what is kept; an amount is
// kept in cents like every other amount.
function value(f: FormData, type: string): number {
  const v = Number(String(f.get("value") ?? "").replace(",", "."));
  if (!Number.isFinite(v) || v <= 0) throw new Refused("Say how much the discount takes off.");
  if (type === "percent") {
    if (!Number.isInteger(v) || v > 100) throw new Refused("A percentage is a whole number from 1 to 100.");
    return v;
  }
  if (v > 1_000_000) throw new Refused("That amount is too large.");
  return Math.round(v * 100);
}
const kind = (f: FormData) => (f.get("type") === "amount" ? "amount" : "percent");

async function addDiscount(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const name = text(f, "name", 40);
    if (!name) throw new Refused("Give the discount a name: it is what prints on the receipt.");
    const type = kind(f);
    await c.query(`insert into discounts (tenant_id, name, type, value, requires_approval) values ($1, $2, $3, $4, $5)`, [
      ctx.tenantId,
      name,
      type,
      value(f, type),
      on(f, "requires_approval"),
    ]);
    return `${name} added. It is on the tills once they have synced.`;
  });
}

// Removing one takes it off the tills. Receipts it was given on keep its name
// and what it took off, so the row stays; its name is freed for a new one.
async function saveDiscount(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      const gone = await c.query(
        `update discounts set deleted_at = now(), name = left(name, 40) || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')'
          where tenant_id = $1 and id = $2 and deleted_at is null returning name`,
        [ctx.tenantId, id],
      );
      if (gone.rowCount !== 1) throw new Refused("That discount was already removed.");
      return "Discount removed. Receipts it was given on keep it.";
    }
    const name = text(f, "name", 40);
    if (!name) throw new Refused("A discount needs a name.");
    const type = kind(f);
    const saved = await c.query(
      `update discounts set name = $3, type = $4, value = $5, requires_approval = $6 where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id, name, type, value(f, type), on(f, "requires_approval")],
    );
    if (saved.rowCount !== 1) throw new Refused("That discount no longer exists. Reload the page.");
    return `${name} saved. Receipts already issued keep what they were given.`;
  });
}

type Row = { id: string; name: string; type: string; value: string; requires_approval: boolean; used: number; taken: string };

export default async function DiscountsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
    s: await loadSettings(c, ctx.tenantId),
    rows: (
      await c.query(
        `select d.id, d.name, d.type, d.value, d.requires_approval,
                (select count(*)::int from receipt_discounts rd where rd.tenant_id = d.tenant_id and rd.discount_id = d.id and rd.deleted_at is null) as used,
                (select coalesce(sum(rd.amount), 0) from receipt_discounts rd where rd.tenant_id = d.tenant_id and rd.discount_id = d.id and rd.deleted_at is null) as taken
           from discounts d where d.tenant_id = $1 and d.deleted_at is null order by d.name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
  }));
  return (
    <div>
      <PageHead
        title="Discounts"
        lede="What the till offers under More, Discount. A discount comes off the whole bill at payment and prints on the receipt under its name. One marked as needing a manager can only be given by someone whose role allows it, or with their PIN."
      />
      <Flash sp={sp} />
      {d.rows.length === 0 ? (
        <div className="note">No discounts yet. The till can still take a percentage or an amount typed in at the time.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Discount</th>
              <th>Takes off</th>
              <th>How much</th>
              <th>Who may give it</th>
              <th className="num">Given</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td><input form={"d" + r.id} name="name" defaultValue={r.name} required maxLength={40} aria-label="Name" /></td>
                <td>
                  <select form={"d" + r.id} name="type" defaultValue={r.type} aria-label="Takes off">
                    <option value="percent">A percentage</option>
                    <option value="amount">An amount (Rs)</option>
                  </select>
                </td>
                <td>
                  <input
                    form={"d" + r.id}
                    name="value"
                    defaultValue={r.type === "percent" ? String(r.value) : (Number(r.value) / 100).toString()}
                    className="narrow"
                    inputMode="decimal"
                    required
                    aria-label="How much"
                  />
                </td>
                <td>
                  <label className="check" style={{ margin: 0 }}>
                    <input form={"d" + r.id} type="checkbox" name="requires_approval" defaultChecked={r.requires_approval} />
                    Needs a manager
                  </label>
                </td>
                <td className="num">{r.used === 0 ? <span className="muted">Never</span> : `${r.used} × · ${money(Number(r.taken), d.s.decimals)}`}</td>
                <td>
                  <form id={"d" + r.id} action={saveDiscount} className="row-actions">
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="btn-quiet btn-sm">Save</button>
                    <button type="submit" name="remove" value="1" className="btn-link danger" formNoValidate>Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Card title="Add a discount" lede="A percentage is a whole number (10 for 10%). An amount is in rupees.">
        <form action={addDiscount} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name, e.g. Happy hour" required maxLength={40} />
          <select name="type" defaultValue="percent" aria-label="Takes off">
            <option value="percent">A percentage</option>
            <option value="amount">An amount (Rs)</option>
          </select>
          <input name="value" placeholder="How much" required className="narrow" inputMode="decimal" />
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" name="requires_approval" />
            Needs a manager
          </label>
          <button type="submit">Add</button>
        </form>
      </Card>
      <p className="muted">
        Who counts as a manager is set under Roles and permissions: &quot;Give a discount&quot; and &quot;Give a discount that needs a manager&quot;.
      </p>
    </div>
  );
}
