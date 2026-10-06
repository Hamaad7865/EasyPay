import Link from "next/link";
import { redirect } from "next/navigation";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, on, Refused, text, UUID } from "@/lib/action";
import { parseRs } from "@/lib/money";
import { loadSettings, money } from "@/lib/settings";
import { clock } from "@/lib/report";
import { Card, Flash, one, PageHead, type Search } from "../../ui";

// One item: what it is called, what it costs, which tax it carries, which
// add-on groups the till offers with it.
async function save(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  const editing = UUID.test(id);
  await act("items.edit", editing && f.get("remove") !== "1" ? `/backoffice/items/edit?id=${id}` : "/backoffice/items", async (c, ctx) => {
    if (editing && f.get("remove") === "1") {
      await c.query(`update items set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Item removed. Receipts that sold it keep its name.";
    }
    const name = text(f, "name", 80);
    const price = parseRs(String(f.get("price") ?? ""));
    const category = String(f.get("category") ?? "");
    const tax = String(f.get("tax") ?? "");
    if (!name) throw new Refused("Give the item a name.");
    if (price === null) throw new Refused("The price is not a number.");
    if (!UUID.test(tax)) throw new Refused("Pick the tax this item carries.");
    const groups = f.getAll("group").map(String).filter((g) => UUID.test(g));
    // what a scanner reads off the packet; two items with the same one would leave the till guessing
    const barcode = text(f, "barcode", 64).replace(/\s+/g, "") || null;
    if (barcode) {
      const taken = await c.query(`select name from items where tenant_id = $1 and barcode = $2 and deleted_at is null and ($3::uuid is null or id <> $3::uuid) limit 1`, [
        ctx.tenantId,
        barcode,
        editing ? id : null,
      ]);
      if (taken.rowCount) throw new Refused(`${taken.rows[0].name} already has that barcode.`);
    }
    let item = id;
    if (editing) {
      await c.query(
        `update items set name = $3, price = $4, category_id = $5, is_available = $6, track_stock = $7, barcode = $8
          where tenant_id = $1 and id = $2 and deleted_at is null`,
        [ctx.tenantId, id, name, price, UUID.test(category) ? category : null, on(f, "available"), on(f, "track_stock"), barcode],
      );
    } else {
      const r = await c.query(
        `insert into items (tenant_id, category_id, name, price, is_available, track_stock, barcode) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ctx.tenantId, UUID.test(category) ? category : null, name, price, on(f, "available"), on(f, "track_stock"), barcode],
      );
      item = r.rows[0].id as string;
    }
    // one tax per item: the others are taken off, the chosen one put (back) on
    await c.query(`update item_taxes set deleted_at = now() where tenant_id = $1 and item_id = $2 and tax_id <> $3 and deleted_at is null`, [ctx.tenantId, item, tax]);
    await c.query(
      `insert into item_taxes (tenant_id, item_id, tax_id)
         select $1, $2, t.id from taxes t where t.tenant_id = $1 and t.id = $3 and t.deleted_at is null
       on conflict (item_id, tax_id) do update set deleted_at = null`,
      [ctx.tenantId, item, tax],
    );
    await c.query(`update item_modifier_groups set deleted_at = now() where tenant_id = $1 and item_id = $2 and not (group_id = any($3::uuid[])) and deleted_at is null`, [ctx.tenantId, item, groups]);
    await c.query(
      `insert into item_modifier_groups (tenant_id, item_id, group_id)
         select $1, $2, g.id from modifier_groups g where g.tenant_id = $1 and g.deleted_at is null and g.id = any($3::uuid[])
       on conflict (item_id, group_id) do update set deleted_at = null`,
      [ctx.tenantId, item, groups],
    );
    return `${name} saved.`;
  });
}

export default async function ItemEditPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const id = one(sp.id);
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const item = UUID.test(id)
      ? ((await c.query(`select id, name, price, category_id, is_available, track_stock, barcode from items where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id])).rows[0] as
          | { id: string; name: string; price: string; category_id: string | null; is_available: boolean; track_stock: boolean; barcode: string | null }
          | undefined)
      : undefined;
    return {
      item,
      cats: (await c.query(`select id, name, is_stock from categories where tenant_id = $1 and deleted_at is null order by sort_order, name`, [ctx.tenantId])).rows as { id: string; name: string; is_stock: boolean }[],
      taxes: (await c.query(`select id, name, rate_bp, type, is_default from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, rate_bp desc, name`, [ctx.tenantId])).rows as { id: string; name: string; rate_bp: number; type: string; is_default: boolean }[],
      groups: (await c.query(`select id, name, (select count(*)::int from modifiers m where m.tenant_id = g.tenant_id and m.group_id = g.id and m.deleted_at is null) as n from modifier_groups g where g.tenant_id = $1 and g.deleted_at is null order by g.name`, [ctx.tenantId])).rows as { id: string; name: string; n: number }[],
      itemTax: item ? ((await c.query(`select tax_id from item_taxes where tenant_id = $1 and item_id = $2 and deleted_at is null limit 1`, [ctx.tenantId, item.id])).rows[0]?.tax_id as string | undefined) : undefined,
      itemGroups: item ? (await c.query(`select group_id from item_modifier_groups where tenant_id = $1 and item_id = $2 and deleted_at is null`, [ctx.tenantId, item.id])).rows.map((r) => r.group_id as string) : [],
      // every change of this item's price, here or on a till, newest first
      prices: item
        ? ((
            await c.query(
              `select pc.old_price, pc.new_price, pc.created_at, pc.source, e.name as who, a.name as approver
                 from item_price_changes pc
                 left join employees e on e.tenant_id = pc.tenant_id and e.id = pc.changed_by
                 left join employees a on a.tenant_id = pc.tenant_id and a.id = pc.approved_by
                where pc.tenant_id = $1 and pc.item_id = $2 and pc.deleted_at is null
                order by pc.created_at desc limit 12`,
              [ctx.tenantId, item.id],
            )
          ).rows as { old_price: string; new_price: string; created_at: string; source: string; who: string | null; approver: string | null }[])
        : [],
      settings: await loadSettings(c, ctx.tenantId),
      tz: ((await c.query(`select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [ctx.tenantId])).rows[0]?.timezone as string | undefined) ?? "Indian/Mauritius",
    };
  });
  if (UUID.test(id) && !d.item) redirect("/backoffice/items");
  const it = d.item;
  const tax = d.itemTax ?? d.taxes.find((t) => t.is_default)?.id ?? d.taxes[0]?.id;
  return (
    <div>
      <p className="crumb"><Link href="/backoffice/items">Items</Link> ›</p>
      <PageHead title={it ? it.name : "New item"} />
      <Flash sp={sp} />
      <form action={save}>
        {it && <input type="hidden" name="id" value={it.id} />}
        <div className="grid-2">
          <Card title="Item">
            <label className="field">
              Name
              <input name="name" defaultValue={it?.name} required maxLength={80} autoFocus={!it} />
            </label>
            <div className="form-row">
              <label className="field">
                Price (Rs)
                <input name="price" defaultValue={it ? (Number(it.price) / 100).toString() : ""} required inputMode="decimal" />
              </label>
              <label className="field">
                Category
                <select name="category" defaultValue={it?.category_id ?? one(sp.category)}>
                  <option value="">No category</option>
                  {d.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            </div>
            <label className="field">
              Barcode
              <input name="barcode" defaultValue={it?.barcode ?? ""} maxLength={64} placeholder="Scan it here, or leave empty" autoComplete="off" />
              <span className="help">For bottled drinks and packets. With a scanner plugged into the tablet, scanning it on the till adds the item to the order.</span>
            </label>
            <label className="check">
              <input type="checkbox" name="available" defaultChecked={it?.is_available ?? true} />
              <span>
                On sale
                <small>Untick when it is sold out: the till greys it and will not sell it.</small>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" name="track_stock" defaultChecked={it?.track_stock ?? false} />
              <span>
                Count its stock
                <small>Every item of a counted category is counted anyway; tick this to count this one alone.</small>
              </span>
            </label>
          </Card>
          <div>
            <Card title="Tax" lede="Whether the price already includes the tax is set on the tax itself.">
              {d.taxes.map((t) => (
                <label key={t.id} className="check">
                  <input type="radio" name="tax" value={t.id} defaultChecked={t.id === tax} required />
                  <span>
                    {t.name} {t.rate_bp > 0 ? `${t.rate_bp / 100}%` : "0%"}
                    <small>{t.rate_bp === 0 ? "No tax is charged." : t.type === "included" ? "Included in the price." : "Added on top of the price."}</small>
                  </span>
                </label>
              ))}
              {d.taxes.length === 0 && <p className="muted">No taxes are set up. Add them under <Link href="/backoffice/taxes">Taxes</Link>.</p>}
            </Card>
            <Card title="Add-ons" lede="The groups of extras the till offers when this item is tapped.">
              {d.groups.map((g) => (
                <label key={g.id} className="check">
                  <input type="checkbox" name="group" value={g.id} defaultChecked={d.itemGroups.includes(g.id)} />
                  <span>
                    {g.name}
                    <small>{g.n} {g.n === 1 ? "choice" : "choices"}</small>
                  </span>
                </label>
              ))}
              {d.groups.length === 0 && <p className="muted">No add-on groups yet. Create them under <Link href="/backoffice/addons">Add-ons</Link>.</p>}
            </Card>
          </div>
        </div>
        <div className="bo-toolbar">
          <button type="submit">{it ? "Save item" : "Add item"}</button>
          <Link href="/backoffice/items" className="btn-quiet">Cancel</Link>
          <span className="spacer" />
          {it && <button type="submit" name="remove" value="1" className="btn-danger" formNoValidate>Remove item</button>}
        </div>
      </form>
      {d.prices.length > 0 && (
        <Card title="Price changes" lede="Every time this item's price was changed, here or on a till. Receipts keep the price they were sold at." flush>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th className="num">From</th>
                <th className="num">To</th>
                <th>Where</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {d.prices.map((c, i) => (
                <tr key={i}>
                  <td>{clock(d.tz)(c.created_at)}</td>
                  <td className="num">{money(Number(c.old_price), d.settings.decimals)}</td>
                  <td className="num strong">{money(Number(c.new_price), d.settings.decimals)}</td>
                  <td>{c.source === "till" ? "On a till" : "Back office"}</td>
                  <td>
                    {c.who ?? <span className="muted">Not recorded</span>}
                    {c.approver && <span className="muted"> · approved by {c.approver}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
