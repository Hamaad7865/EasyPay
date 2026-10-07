import Link from "next/link";
import { notFound } from "next/navigation";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text, UUID, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { isOpen, lineNote, ORDER_STATUS, ORDER_TONE, type OrderStatus } from "@/lib/orders";
import { units } from "@/lib/stock";
import { Card, Flash, PageHead, type Search } from "../../ui";
import { Submit } from "../../busy";
import { PrintButton } from "../../reports/print-button";
import { type LineOption, LinesEditor, type TypedLine } from "../lines-editor";
import { linesOf, ruled } from "../lines";
import { type OrderLine, ReceiveForm } from "./receive-form";

const PATH = "/backoffice/purchase-orders";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A draft, saved: its supplier, day, note and lines. The button pressed says
// what follows the save: nothing, filling it from what is low, or sending it.
async function saveOrder(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.receive", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That order is no longer there.");
    const supplier = String(f.get("supplier") ?? "");
    if (!UUID.test(supplier)) throw new Refused("Pick the supplier the order is for.");
    const day = String(f.get("expected") ?? "");
    const then = String(f.get("then") ?? "");
    const lines = linesOf(f);
    return ruled(async () => {
      await c.query(`select po_save($1, $2, $3, null, $4, $5, $6, $7::jsonb)`, [
        ctx.tenantId, ctx.employeeId, id, supplier, DAY.test(day) ? day : null, text(f, "note", 200) || null, JSON.stringify(lines),
      ]);
      if (then === "low") {
        const n = (await c.query(`select po_fill_low($1, $2) as n`, [ctx.tenantId, id])).rows[0].n as number;
        return n === 0 ? "Saved. Nothing of this supplier's is at or below its reorder level." : `Saved, and ${n} ${n === 1 ? "line" : "lines"} added from what is low. Check the quantities.`;
      }
      if (then === "send") {
        await c.query(`select po_send($1, $2)`, [ctx.tenantId, id]);
        return "Order sent. Print it, or save it as a PDF, for the supplier. Receive it here when it arrives.";
      }
      return "Order saved.";
    });
  });
}

// What arrived for this order (delivery_receive, migration 0074).
async function receive(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.receive", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That order is no longer there.");
    const delivery = uuid(f, "delivery");
    const day = String(f.get("arrived") ?? "");
    if (!DAY.test(day)) throw new Refused("Pick the day it arrived.");
    const lines = linesOf(f);
    return ruled(async () => {
      const r = (
        await c.query(`select delivery_receive($1, $2, $3, null, $4, null, $5, $6, $7, $8::jsonb) as r`, [
          ctx.tenantId, ctx.employeeId, delivery, id, day, text(f, "invoice", 60) || null, text(f, "note", 200) || null, JSON.stringify(lines),
        ])
      ).rows[0].r as { number: string; units: number; already: boolean; order_status: string | null };
      if (r.already) return `${r.number} was already received: nothing was added twice.`;
      return `${r.number} received: ${units(r.units)} ${r.units === 1000 ? "unit is" : "units are"} in stock. ${r.order_status === "received" ? "The order has arrived in full." : "The order stays open for what is still to come."}`;
    });
  });
}

async function closeOrder(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.receive", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That order is no longer there.");
    await ruled(() => c.query(`select po_close($1, $2)`, [ctx.tenantId, id]));
    return "Order closed: the rest is no longer expected. What arrived stays in stock.";
  });
}

async function cancelOrder(f: FormData) {
  "use server";
  const id = String(f.get("id") ?? "");
  await act("stock.receive", `${PATH}/${id}`, async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("That order is no longer there.");
    await ruled(() => c.query(`select po_cancel($1, $2)`, [ctx.tenantId, id]));
    return "Order cancelled.";
  });
}

type OrderRow = {
  id: string; number: string; status: OrderStatus; store_id: string; supplier_id: string; supplier: string | null;
  expected: string | null; note: string | null; sent_on: string | null; made_on: string; by: string | null; today: string;
};
type LineRow = { id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; qty: number; unit_cost: string; got: number };
type DeliveryRow = {
  id: string; number: string; day: string; invoice_no: string | null; note: string | null; by: string | null;
  lines: { name: string; variant: string | null; qty: number; unit_cost: number; extra: boolean }[];
};
type StockLine = { item_id: string; variant_id: string | null; name: string; variant: string | null; sku: string | null; barcode: string | null; supplier_id: string | null; avg_cost: string };

const said = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(day + "T00:00:00Z"));
const plain = (q: number) => (q / 1000).toString();
const STEPS: [OrderStatus, string][] = [["draft", "Draft"], ["sent", "Sent"], ["part", "Receiving"], ["received", "Received"]];

// One order: edited while a draft, received once it was sent, and from then
// on a record of what was ordered and what arrived.
export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  if (!UUID.test(id)) notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, order, lines, deliveries, suppliers, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.receive') as receive, has_perm($1, 'costs.view') as costs`, [ctx.employeeId]),
      c.query(
        `select o.id, o.number, o.status, o.store_id, o.supplier_id, s.name as supplier, o.expected_on::text as expected, o.note,
                (o.sent_at at time zone st.timezone)::date::text as sent_on, (o.created_at at time zone st.timezone)::date::text as made_on,
                e.name as by, to_char(now() at time zone st.timezone, 'YYYY-MM-DD') as today
           from purchase_orders o
           join stores st on st.tenant_id = o.tenant_id and st.id = o.store_id
           left join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
           left join employees e on e.tenant_id = o.tenant_id and e.id = o.created_by
          where o.tenant_id = $1 and o.id = $2 and o.deleted_at is null`,
        [ctx.tenantId, id],
      ),
      c.query(
        `select l.id, l.item_id, l.variant_id, i.name, v.name as variant, l.qty, l.unit_cost,
                coalesce((select sum(dl.qty) from delivery_lines dl where dl.tenant_id = l.tenant_id and dl.order_line_id = l.id), 0)::int as got
           from purchase_order_lines l
           join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
           left join item_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
          where l.tenant_id = $1 and l.order_id = $2
          order by lower(i.name), v.name`,
        [ctx.tenantId, id],
      ),
      c.query(
        `select dv.id, dv.number, dv.arrived_on::text as day, dv.invoice_no, dv.note, e.name as by,
                (select coalesce(json_agg(json_build_object('name', i.name, 'variant', v.name, 'qty', dl.qty, 'unit_cost', dl.unit_cost,
                                                            'extra', dl.order_line_id is null) order by lower(i.name), v.name), '[]'::json)
                   from delivery_lines dl
                   join items i on i.tenant_id = dl.tenant_id and i.id = dl.item_id
                   left join item_variants v on v.tenant_id = dl.tenant_id and v.id = dl.variant_id
                  where dl.tenant_id = dv.tenant_id and dl.delivery_id = dv.id) as lines
           from deliveries dv left join employees e on e.tenant_id = dv.tenant_id and e.id = dv.received_by
          where dv.tenant_id = $1 and dv.order_id = $2
          order by dv.created_at`,
        [ctx.tenantId, id],
      ),
      c.query(`select id, name from suppliers where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
      loadSettings(c, ctx.tenantId),
    ]);
    const o = (order.rows[0] as OrderRow | undefined) ?? null;
    // the products a draft can take: every line of stock of the order's shop
    const stock = o && o.status === "draft" ? ((await c.query(`select * from stock_on_hand($1, $2)`, [ctx.tenantId, o.store_id])).rows as StockLine[]) : [];
    return {
      may: may.rows[0] as { view: boolean; receive: boolean; costs: boolean },
      order: o,
      lines: lines.rows as LineRow[],
      deliveries: deliveries.rows as DeliveryRow[],
      suppliers: suppliers.rows as { id: string; name: string }[],
      stock,
      decimals: settings.decimals,
    };
  });
  if (!d.order || !d.may.view) notFound();
  const o = d.order;
  const rs = (cents: number) => money(cents, d.decimals);
  // what an order costs is for those who order and receive, and for anyone who may see cost
  const showCost = d.may.receive || d.may.costs;
  const total = d.lines.reduce((a, l) => a + Math.round((l.qty * Number(l.unit_cost)) / 1000), 0);
  const anyArrived = d.deliveries.length > 0;
  const label = (name: string, variant: string | null) => name + (variant ? ", " + variant : "");
  const options: LineOption[] = d.stock.map((s) => ({
    key: s.item_id + (s.variant_id ? ":" + s.variant_id : ""), item: s.item_id, variant: s.variant_id, label: label(s.name, s.variant),
    sku: s.sku, barcode: s.barcode, cost: Math.max(0, Math.round(Number(s.avg_cost))), mine: s.supplier_id === o.supplier_id,
  }));
  const typed: TypedLine[] = d.lines.map((l) => ({
    key: l.item_id + (l.variant_id ? ":" + l.variant_id : ""), item: l.item_id, variant: l.variant_id, label: label(l.name, l.variant),
    qty: plain(l.qty), cost: (Number(l.unit_cost) / 100).toFixed(2),
  }));
  const toReceive: OrderLine[] = d.lines.map((l) => ({ key: l.id, item: l.item_id, variant: l.variant_id, label: label(l.name, l.variant), ordered: l.qty, got: l.got, cost: Number(l.unit_cost) }));
  const at = STEPS.findIndex(([s]) => s === o.status);
  const dates = [o.sent_on ? `Sent ${said(o.sent_on)}` : `Started ${said(o.made_on)}`, o.expected ? `expected ${said(o.expected)}` : null].filter(Boolean).join(", ");
  return (
    <div>
      <PageHead title={`Order ${o.number}`} lede={`${o.supplier ?? "A supplier that was removed"}. ${dates}.${o.note ? " " + o.note : ""}`}>
        <Link href={PATH} className="btn btn-quiet no-print">All orders</Link>
        {o.status !== "draft" && <PrintButton />}
      </PageHead>
      <Flash sp={sp} />
      <div className="bo-toolbar no-print">
        {at >= 0 ? (
          STEPS.map(([s, name], i) => (
            <span key={s} className={i === at ? "badge blue" : i < at ? "badge green" : "badge"}>
              {name}
            </span>
          ))
        ) : (
          <span className={ORDER_TONE[o.status]}>{ORDER_STATUS[o.status]}</span>
        )}
        <span className="muted">An order can arrive in several deliveries.</span>
        <span className="spacer" />
        {d.may.receive && o.status === "part" && (
          <form action={closeOrder}>
            <input type="hidden" name="id" value={o.id} />
            <Submit className="btn-quiet btn-sm">Close: the rest will not come</Submit>
          </form>
        )}
        {d.may.receive && (o.status === "draft" || o.status === "sent") && !anyArrived && (
          <form action={cancelOrder}>
            <input type="hidden" name="id" value={o.id} />
            <Submit className="btn-link danger">Cancel the order</Submit>
          </form>
        )}
      </div>

      {o.status === "draft" && d.may.receive && (
        <form action={saveOrder}>
          <input type="hidden" name="id" value={o.id} />
          <Card title="The order">
            <div className="grid-3" style={{ gap: "0 20px" }}>
              <label className="field">
                Supplier
                <select name="supplier" defaultValue={o.supplier_id} required>
                  {!d.suppliers.some((s) => s.id === o.supplier_id) && <option value="">Pick a supplier</option>}
                  {d.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Expected on
                <input type="date" name="expected" defaultValue={o.expected ?? ""} />
              </label>
              <label className="field">
                Note for the supplier
                <input name="note" defaultValue={o.note ?? ""} maxLength={200} />
              </label>
            </div>
          </Card>
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>What to order</h2>
                <p>Find each product, or add everything of this supplier&apos;s that is at or below its reorder level.</p>
              </div>
              <Submit name="then" value="low" className="btn-quiet btn-sm" formNoValidate>Add what is low</Submit>
            </div>
            <LinesEditor options={options} start={typed} what="order" />
            <div className="card-foot">
              <Submit name="then" value="save" className="btn-quiet">Save the draft</Submit>
              <Submit name="then" value="send">Save and send</Submit>
            </div>
          </section>
          <p className="muted">Sending fixes the order&apos;s lines: from then on it is received, closed or cancelled, not edited. Nothing is sent to the supplier from here: print the order or save it as a PDF.</p>
        </form>
      )}

      {isOpen(o.status) && d.may.receive && <ReceiveForm order={o.id} delivery={crypto.randomUUID()} today={o.today} lines={toReceive} action={receive} />}

      {(o.status !== "draft" || !d.may.receive) && (
        <Card title="What was ordered" flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Ordered</th>
                  <th className="num">Arrived</th>
                  <th />
                  {showCost && <th className="num">Unit cost</th>}
                  {showCost && <th className="num">Line total</th>}
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="strong">{label(l.name, l.variant)}</td>
                    <td className="num">{units(l.qty)}</td>
                    <td className="num">{units(l.got)}</td>
                    <td className="muted">{o.status === "sent" && l.got === 0 ? "" : lineNote(l.qty, l.got)}</td>
                    {showCost && <td className="num">{rs(Number(l.unit_cost))}</td>}
                    {showCost && <td className="num strong">{rs(Math.round((l.qty * Number(l.unit_cost)) / 1000))}</td>}
                  </tr>
                ))}
                {d.lines.length === 0 && (
                  <tr>
                    <td colSpan={showCost ? 6 : 4} className="muted">No products on this order.</td>
                  </tr>
                )}
              </tbody>
              {showCost && d.lines.length > 0 && (
                <tfoot>
                  <tr>
                    <td className="strong" colSpan={5}>Order total</td>
                    <td className="num strong">{rs(total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}

      {d.deliveries.map((v) => {
        const sum = v.lines.reduce((a, l) => a + Math.round((l.qty * Number(l.unit_cost)) / 1000), 0);
        return (
          <Card
            key={v.id}
            title={`Delivery ${v.number}, ${said(v.day)}`}
            lede={[v.invoice_no ? `Invoice ${v.invoice_no}` : null, v.by ? `received by ${v.by}` : null, v.note].filter(Boolean).join(". ") || undefined}
            flush
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Arrived</th>
                    {showCost && <th className="num">Unit cost</th>}
                    {showCost && <th className="num">Line total</th>}
                  </tr>
                </thead>
                <tbody>
                  {v.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="strong">
                        {label(l.name, l.variant)}
                        {l.extra && <small className="cell-sub">Was not on the order</small>}
                      </td>
                      <td className="num">{units(l.qty)}</td>
                      {showCost && <td className="num">{rs(Number(l.unit_cost))}</td>}
                      {showCost && <td className="num strong">{rs(Math.round((l.qty * Number(l.unit_cost)) / 1000))}</td>}
                    </tr>
                  ))}
                </tbody>
                {showCost && (
                  <tfoot>
                    <tr>
                      <td className="strong" colSpan={3}>Delivery total</td>
                      <td className="num strong">{rs(sum)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
