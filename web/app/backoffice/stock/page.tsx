import Link from "next/link";
import { Boxes } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, Refused, text, uuid } from "@/lib/action";
import { Card, Empty, Flash, PageHead, type Search, startKey, startOf } from "../ui";
import { type StockRow, StockTable } from "./table";
import { OnHand } from "./on-hand";

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
// Both go through the one stock engine (migration 0067), which writes the
// movement and keeps the shop's level and the item's total in step.
async function change(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
    const id = uuid(f, "id");
    const mode = f.get("mode") === "add" ? "add" : "set";
    const qty = amount(f, "qty");
    if (mode === "set" && qty < 0) throw new Refused("A count cannot be less than zero.");
    // The item's row is read, not locked: the engine locks the item's level
    // first and its row second, and a lock taken here the other way round
    // could leave a sale and this change each waiting on the other.
    const cur = await c.query(
      `select name, first_store(tenant_id) as store from items where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id],
    );
    if (cur.rowCount !== 1) throw new Refused("That item no longer exists.");
    const args = [ctx.tenantId, cur.rows[0].store, id, qty, ctx.employeeId, text(f, "note", 120) || null];
    let moved: boolean;
    if (mode === "add") {
      moved = qty !== 0;
      if (moved) await c.query(`select stock_move($1, $2, $3, null, $4, 'adjust', null, null, null, $5, $6) as id`, args);
    } else {
      // the difference is worked out inside, under the level's lock: two
      // people counting the same item at once build on each other
      const r = await c.query(`select stock_count_item($1, $2, $3, $4, $5, $6) as d`, args);
      moved = Number(r.rows[0].d) !== 0;
    }
    if (!moved) return "Nothing changed.";
    const now = await c.query(`select coalesce(stock_qty, 0) as q from items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    return `${cur.rows[0].name}: ${units(Number(now.rows[0].q))} in stock.`;
  });
}

type Row = { id: string; name: string; cat: string | null; cat_order: number | null; q: number | null; sold7: number };
type Move = { at: string; item: string; qty: number; reason: string; who: string | null; note: string | null };

export default async function StockPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  // a shop's stock is a page of its own (Stock on hand); what follows is a restaurant's
  if (ctx.mode === "retail") return <OnHand sp={sp} ctx={ctx} />;
  const d = await readTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select i.id, i.name, c.name as cat, c.sort_order as cat_order, i.stock_qty as q,
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
  const rows: StockRow[] = d.rows.map((r) => ({
    id: r.id,
    name: r.name,
    cat: r.cat,
    cat_order: r.cat_order ?? Number.MAX_SAFE_INTEGER,
    q: q(r),
    q_shown: units(q(r)),
    sold7: r.sold7,
    sold7_shown: units(r.sold7),
  }));
  const start = startOf(sp, "q", "show", "sort", "open");
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
          <StockTable key={startKey(sp, start)} rows={rows} start={start} change={change} />
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
