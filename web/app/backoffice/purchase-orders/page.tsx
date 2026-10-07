import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { onlyFor, requirePerm } from "@/lib/tenant";
import { readTenant, withTenant } from "@/lib/db";
import { text, UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { ORDER_STATUS, ORDER_TONE, orderProblem, type OrderStatus } from "@/lib/orders";
import { units } from "@/lib/stock";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";
import { Submit, Wait } from "../busy";

const PATH = "/backoffice/purchase-orders";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A new order starts as an empty draft for one supplier, and opens on its own
// page, where its products are added. (Not through act(): where it goes next
// is only known once the order has its id.)
async function newOrder(f: FormData) {
  "use server";
  let to = PATH;
  try {
    const ctx = await requirePerm("stock.receive");
    const supplier = String(f.get("supplier") ?? "");
    if (!UUID.test(supplier)) throw new Error("pick-supplier");
    const day = String(f.get("expected") ?? "");
    const made = await withTenant(ctx.tenantId, async (c) =>
      (await c.query(`select po_save($1, $2, null, first_store($1), $3, $4, $5, '[]'::jsonb) as r`, [
        ctx.tenantId, ctx.employeeId, supplier, DAY.test(day) ? day : null, text(f, "note", 200) || null,
      ])).rows[0].r as { id: string },
    );
    to = `${PATH}/${made.id}`;
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    const why = said === "pick-supplier"
      ? "Pick the supplier the order is for."
      : said.startsWith("Forbidden")
        ? "Your role cannot order from suppliers."
        : said.includes("suspended")
          ? said
          : (orderProblem(said) ?? "The order could not be made. Nothing was saved.");
    redirect(`${PATH}?err=${encodeURIComponent(why)}`);
  }
  redirect(to);
}

type Order = { id: string; number: string; status: OrderStatus; expected: string | null; supplier: string | null; made: string; units: number; got: number; total: string };
type Delivery = { id: string; number: string; day: string; supplier: string | null; order_id: string | null; order_number: string | null; invoice_no: string | null; units: number; total: string };

// What the shop has on order, and what has arrived.
export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const show = one(sp.show) === "done" ? "done" : "open";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, orders, deliveries, suppliers, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.receive') as receive, has_perm($1, 'costs.view') as costs`, [ctx.employeeId]),
      c.query(
        `select o.id, o.number, o.status, o.expected_on::text as expected, s.name as supplier, o.created_at::date::text as made,
                coalesce(l.units, 0)::int as units, coalesce(l.total, 0)::bigint as total, coalesce(g.got, 0)::int as got
           from purchase_orders o
           left join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
           left join lateral (select sum(qty) as units, sum(round(qty::numeric * unit_cost / 1000)) as total
                                from purchase_order_lines where tenant_id = o.tenant_id and order_id = o.id) l on true
           left join lateral (select sum(dl.qty) as got from deliveries dv
                                join delivery_lines dl on dl.tenant_id = dv.tenant_id and dl.delivery_id = dv.id
                               where dv.tenant_id = o.tenant_id and dv.order_id = o.id and dl.order_line_id is not null) g on true
          where o.tenant_id = $1 and o.deleted_at is null and o.store_id = first_store($1)
            and case when $2 = 'done' then o.status in ('received', 'closed', 'cancelled') else o.status in ('draft', 'sent', 'part') end
          order by o.created_at desc limit 300`,
        [ctx.tenantId, show],
      ),
      c.query(
        `select dv.id, dv.number, dv.arrived_on::text as day, s.name as supplier, dv.order_id, o.number as order_number, dv.invoice_no,
                coalesce(l.units, 0)::int as units, coalesce(l.total, 0)::bigint as total
           from deliveries dv
           left join suppliers s on s.tenant_id = dv.tenant_id and s.id = dv.supplier_id
           left join purchase_orders o on o.tenant_id = dv.tenant_id and o.id = dv.order_id
           left join lateral (select sum(qty) as units, sum(round(qty::numeric * unit_cost / 1000)) as total
                                from delivery_lines where tenant_id = dv.tenant_id and delivery_id = dv.id) l on true
          where dv.tenant_id = $1 and dv.store_id = first_store($1)
          order by dv.created_at desc limit 20`,
        [ctx.tenantId],
      ),
      c.query(`select id, name from suppliers where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
      loadSettings(c, ctx.tenantId),
    ]);
    return {
      may: may.rows[0] as { view: boolean; receive: boolean; costs: boolean },
      orders: orders.rows as Order[],
      deliveries: deliveries.rows as Delivery[],
      suppliers: suppliers.rows as { id: string; name: string }[],
      decimals: settings.decimals,
    };
  });
  const head = (
    <PageHead
      title="Purchase orders"
      lede="What the shop has ordered from its suppliers, and what has arrived. Receiving a delivery adds it to stock at the cost on the supplier's invoice."
    >
      {d.may.view && d.may.receive && (
        <Link href={`${PATH}/receive`} className="btn btn-quiet">Receive without an order</Link>
      )}
    </PageHead>
  );
  if (!d.may.view) {
    return (
      <div>
        {head}
        <Empty icon={ClipboardList} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const rs = (cents: string | number) => money(Number(cents), d.decimals);
  // what an order or a delivery cost is for those who order and receive, and for anyone who may see cost
  const showCost = d.may.receive || d.may.costs;
  return (
    <div>
      {head}
      <Flash sp={sp} />
      {d.may.receive &&
        (d.suppliers.length === 0 ? (
          <p className="note warn">
            An order is placed with a supplier. Add the first one under <Link href="/backoffice/suppliers">Suppliers</Link>.
          </p>
        ) : (
          <Card title="New order">
            <form action={newOrder} className="bo-toolbar" style={{ margin: 0 }}>
              <select name="supplier" required defaultValue="" aria-label="Supplier">
                <option value="" disabled>Supplier</option>
                {d.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Expected on <input type="date" name="expected" />
              </label>
              <input name="note" placeholder="Note for the supplier" maxLength={200} style={{ flex: "1 1 220px" }} />
              <Submit>Start the order</Submit>
            </form>
          </Card>
        ))}
      <div className="tabs">
        <Link href={PATH} className={show === "open" ? "on" : undefined}>Open<Wait /></Link>
        <Link href={`${PATH}?show=done`} className={show === "done" ? "on" : undefined}>Arrived, closed and cancelled<Wait /></Link>
      </div>
      {d.orders.length === 0 ? (
        <Empty icon={ClipboardList} title={show === "done" ? "Nothing here yet" : "No open orders"}>
          {show === "done" ? "An order moves here once it has arrived in full, or was closed or cancelled." : "Start one above, or receive a delivery that was never ordered."}
        </Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th>Expected</th>
                  <th className="num">Ordered</th>
                  <th className="num">Arrived</th>
                  {showCost && <th className="num">Total</th>}
                </tr>
              </thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="strong">
                      <Link href={`${PATH}/${o.id}`}>{o.number}</Link>
                    </td>
                    <td>{o.supplier ?? <span className="muted">Removed</span>}</td>
                    <td>
                      <span className={ORDER_TONE[o.status]}>{ORDER_STATUS[o.status]}</span>
                    </td>
                    <td>{o.expected ?? <span className="muted">Not set</span>}</td>
                    <td className="num">{units(o.units)}</td>
                    <td className="num">{o.got > 0 ? units(o.got) : <span className="muted">None</span>}</td>
                    {showCost && <td className="num">{rs(o.total)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {d.deliveries.length > 0 && (
        <Card title="Latest deliveries" flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Arrived</th>
                  <th>Supplier</th>
                  <th>Order</th>
                  <th>Invoice</th>
                  <th className="num">Units</th>
                  {showCost && <th className="num">Total</th>}
                </tr>
              </thead>
              <tbody>
                {d.deliveries.map((v) => (
                  <tr key={v.id}>
                    <td className="strong">{v.number}</td>
                    <td>{v.day}</td>
                    <td>{v.supplier ?? <span className="muted">Not said</span>}</td>
                    <td>{v.order_id ? <Link href={`${PATH}/${v.order_id}`}>{v.order_number}</Link> : <span className="muted">No order</span>}</td>
                    <td>{v.invoice_no ?? ""}</td>
                    <td className="num">{units(v.units)}</td>
                    {showCost && <td className="num">{rs(v.total)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
