import Link from "next/link";
import { PackagePlus } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text, UUID, uuid } from "@/lib/action";
import { units } from "@/lib/stock";
import { Card, Empty, Flash, PageHead, type Search } from "../../ui";
import { Submit } from "../../busy";
import { type LineOption, LinesEditor } from "../lines-editor";
import { linesOf, ruled } from "../lines";

const LIST = "/backoffice/purchase-orders";
const PATH = `${LIST}/receive`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A delivery nobody ordered: what arrived, in one step. It is written and
// counted the way an order's delivery is (delivery_receive, migration 0074).
async function receive(f: FormData) {
  "use server";
  await act(
    "stock.receive",
    LIST,
    async (c, ctx) => {
      const delivery = uuid(f, "delivery");
      const supplier = String(f.get("supplier") ?? "");
      const day = String(f.get("arrived") ?? "");
      if (!DAY.test(day)) throw new Refused("Pick the day it arrived.");
      const lines = linesOf(f);
      return ruled(async () => {
        const r = (
          await c.query(`select delivery_receive($1, $2, $3, first_store($1), null, $4, $5, $6, $7, $8::jsonb) as r`, [
            ctx.tenantId, ctx.employeeId, delivery, UUID.test(supplier) ? supplier : null, day, text(f, "invoice", 60) || null, text(f, "note", 200) || null, JSON.stringify(lines),
          ])
        ).rows[0].r as { number: string; units: number; already: boolean };
        if (r.already) return `${r.number} was already received: nothing was added twice.`;
        return `${r.number} received: ${units(r.units)} ${r.units === 1000 ? "unit is" : "units are"} in stock.`;
      });
    },
    // refused, the form is shown again (what was typed has to be typed again)
    PATH,
  );
}

type StockLine = { item_id: string; variant_id: string | null; name: string; variant: string | null; sku: string | null; barcode: string | null; avg_cost: string };

export default async function ReceivePage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, stock, suppliers, shop] = await Promise.all([
      c.query(`select has_perm($1, 'stock.receive') as receive`, [ctx.employeeId]),
      c.query(`select * from stock_on_hand($1, first_store($1))`, [ctx.tenantId]),
      c.query(`select id, name from suppliers where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
      c.query(`select to_char(now() at time zone timezone, 'YYYY-MM-DD') as today from stores where tenant_id = $1 and id = first_store($1)`, [ctx.tenantId]),
    ]);
    return {
      receive: may.rows[0].receive as boolean,
      stock: stock.rows as StockLine[],
      suppliers: suppliers.rows as { id: string; name: string }[],
      today: (shop.rows[0]?.today as string) ?? "",
    };
  });
  const head = (
    <PageHead title="Receive without an order" lede="For a delivery that was never ordered here: what arrived, and what it cost. It goes into stock at once. A delivery for an order is received on the order's own page.">
      <Link href={LIST} className="btn btn-quiet">All orders</Link>
    </PageHead>
  );
  if (!d.receive) {
    return (
      <div>
        {head}
        <Empty icon={PackagePlus} title="Your role cannot receive deliveries">Ask the owner to tick Order from suppliers and receive deliveries on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const options: LineOption[] = d.stock.map((s) => ({
    key: s.item_id + (s.variant_id ? ":" + s.variant_id : ""), item: s.item_id, variant: s.variant_id, label: s.name + (s.variant ? ", " + s.variant : ""),
    sku: s.sku, barcode: s.barcode, cost: Math.max(0, Math.round(Number(s.avg_cost))), mine: false,
  }));
  return (
    <div>
      {head}
      <Flash sp={sp} />
      {options.length === 0 ? (
        <Empty icon={PackagePlus} title="Nothing is counted yet">
          A delivery is received onto products that are counted in stock. Add the first ones under <Link href="/backoffice/items">Products</Link>.
        </Empty>
      ) : (
        <form action={receive}>
          {/* this delivery's id, made when the page was drawn: pressed twice, it is written once */}
          <input type="hidden" name="delivery" value={crypto.randomUUID()} />
          <Card title="This delivery">
            <div className="grid-3" style={{ gap: "0 20px" }}>
              <label className="field">
                Supplier
                <select name="supplier" defaultValue="">
                  <option value="">Not said</option>
                  {d.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Arrived on
                <input type="date" name="arrived" defaultValue={d.today} required />
              </label>
              <label className="field">
                Supplier&apos;s invoice number
                <input name="invoice" maxLength={60} autoComplete="off" />
              </label>
            </div>
            <label className="field">
              Note
              <input name="note" maxLength={200} placeholder="For example, bought at the cash and carry" />
            </label>
          </Card>
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>What arrived</h2>
                <p>Find each product, type how many arrived and what one cost.</p>
              </div>
            </div>
            <LinesEditor options={options} start={[]} what="delivery" />
            <div className="card-foot">
              <Submit>Receive into stock</Submit>
            </div>
          </section>
          <p className="note warn">
            <strong>Receiving cannot be undone</strong>
            Goods sent back afterwards go out as Returned to supplier, under Stock on hand. The cost typed here becomes the product&apos;s cost.
          </p>
        </form>
      )}
    </div>
  );
}
