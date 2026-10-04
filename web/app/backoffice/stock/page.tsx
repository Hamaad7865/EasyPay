import Link from "next/link";
import { Boxes } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";

const PATH = "/backoffice/stock";
const LOW = 5000; // five or fewer left is "low" (quantities are thousandths)
const units = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

function amount(f: FormData, k: string): number {
  const v = Number(String(f.get(k) ?? "").replace(",", "."));
  if (!Number.isFinite(v) || Math.abs(v) > 1_000_000) throw new Refused("That quantity is not a number.");
  return Math.round(v * 1000);
}

// "Set to" is a count: the shelf was counted and this is what is there.
// "Add" is a delivery (or, with a minus, something thrown away).
async function change(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    const mode = f.get("mode") === "add" ? "add" : "set";
    const qty = amount(f, "qty");
    const cur = await c.query(`select name, coalesce(stock_qty, 0) as q from items where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, id]);
    if (cur.rowCount !== 1) throw new Refused("That item no longer exists.");
    const before = Number(cur.rows[0].q);
    const delta = mode === "add" ? qty : qty - before;
    if (mode === "set" && qty < 0) throw new Refused("A count cannot be less than zero.");
    if (delta === 0) return "Nothing changed.";
    await c.query(`insert into stock_movements (tenant_id, item_id, qty, reason, employee_id, note) values ($1, $2, $3, $4, $5, $6)`, [
      ctx.tenantId,
      id,
      delta,
      mode === "add" ? "adjust" : "count",
      ctx.employeeId,
      text(f, "note", 120) || null,
    ]);
    await c.query(`update items set stock_qty = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, before + delta]);
    return `${cur.rows[0].name}: ${units(before + delta)} in stock.`;
  });
}

type Row = { id: string; name: string; cat: string | null; q: number | null; sold7: number };
type Move = { at: string; item: string; qty: number; reason: string; who: string | null; note: string | null };

export default async function StockPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const only = one(sp.show);
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select i.id, i.name, c.name as cat, i.stock_qty as q,
                coalesce((select -sum(m.qty) from stock_movements m where m.tenant_id = i.tenant_id and m.item_id = i.id
                   and m.reason = 'sale' and m.created_at > now() - interval '7 days'), 0)::int as sold7
           from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
          where i.tenant_id = $1 and i.deleted_at is null and (i.track_stock or coalesce(c.is_stock, false))
          order by c.sort_order nulls last, i.name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
    moves: (
      await c.query(
        `select m.created_at as at, i.name as item, m.qty, m.reason, e.name as who, m.note
           from stock_movements m join items i on i.tenant_id = m.tenant_id and i.id = m.item_id
           left join employees e on e.tenant_id = m.tenant_id and e.id = m.employee_id
          where m.tenant_id = $1 and m.deleted_at is null order by m.created_at desc limit 40`,
        [ctx.tenantId],
      )
    ).rows as Move[],
    tz: ((await c.query(`select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [ctx.tenantId])).rows[0]?.timezone as string) ?? "Indian/Mauritius",
  }));
  const q = (r: Row) => Number(r.q ?? 0);
  const out = d.rows.filter((r) => q(r) <= 0).length;
  const low = d.rows.filter((r) => q(r) > 0 && q(r) <= LOW).length;
  const shown = only === "low" ? d.rows.filter((r) => q(r) <= LOW) : d.rows;
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: d.tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const REASON: Record<string, string> = { sale: "Sold", refund: "Refunded", adjust: "Added", count: "Counted" };
  return (
    <div>
      <PageHead title="Stock" lede="What is left of the items you count. A sale takes from the quantity, a refund puts it back. Set a quantity after counting the shelf, or add a delivery." />
      <Flash sp={sp} />
      {d.rows.length === 0 ? (
        <Empty icon={Boxes} title="Nothing is counted yet">
          Tick Counted on a category under <Link href="/backoffice/categories">Categories</Link> (drinks and bottles are the usual ones), and its items appear here.
        </Empty>
      ) : (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-label">Items counted</div><div className="stat-value">{d.rows.length}</div></div>
            <div className="stat"><div className="stat-label">Out of stock</div><div className="stat-value" style={out ? { color: "var(--red)" } : undefined}>{out}</div></div>
            <div className="stat"><div className="stat-label">Low (5 or fewer)</div><div className="stat-value" style={low ? { color: "var(--amber)" } : undefined}>{low}</div></div>
            <div className="stat"><div className="stat-label">Sold in 7 days</div><div className="stat-value">{units(d.rows.reduce((a, r) => a + r.sold7, 0))}</div></div>
          </div>
          <p className="bo-chips">
            <Link href={PATH} className={only === "low" ? undefined : "on"}>All</Link>
            <Link href={PATH + "?show=low"} className={only === "low" ? "on" : undefined}>Low and out</Link>
          </p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th className="num">In stock</th>
                <th>Status</th>
                <th className="num">Sold in 7 days</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="strong">{r.name}</td>
                  <td>{r.cat ?? <span className="muted">None</span>}</td>
                  <td className="num strong">{r.q === null ? <span className="muted">Not counted</span> : units(q(r))}</td>
                  <td>{q(r) <= 0 ? <span className="badge red">Out</span> : q(r) <= LOW ? <span className="badge amber">Low</span> : <span className="badge green">In stock</span>}</td>
                  <td className="num">{units(r.sold7)}</td>
                  <td>
                    <form action={change} className="inline">
                      <input type="hidden" name="id" value={r.id} />
                      <select name="mode" defaultValue="add" aria-label="How">
                        <option value="add">Add</option>
                        <option value="set">Set to</option>
                      </select>
                      <input name="qty" required className="narrow" inputMode="decimal" placeholder="0" aria-label={`Quantity for ${r.name}`} />
                      <button type="submit" className="btn-quiet btn-sm">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Card title="Latest movements" flush>
            <table>
              <thead>
                <tr><th>When</th><th>Item</th><th>What</th><th className="num">Quantity</th><th>By</th></tr>
              </thead>
              <tbody>
                {d.moves.map((m, i) => (
                  <tr key={i}>
                    <td>{when.format(new Date(m.at))}</td>
                    <td>{m.item}</td>
                    <td>{REASON[m.reason] ?? m.reason}</td>
                    <td className="num">{m.qty > 0 ? "+" : ""}{units(m.qty)}</td>
                    <td>{m.who ?? <span className="muted">Till</span>}</td>
                  </tr>
                ))}
                {d.moves.length === 0 && <tr><td colSpan={5} className="muted">Nothing has moved yet.</td></tr>}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
