import Link from "next/link";
import { Boxes } from "lucide-react";
import type { TenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, backTo, Refused, text, UUID, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { adjustProblem, lineValue, type StockStatus, stockStatus, stockTotals, units } from "@/lib/stock";
import { branches, formBranch, pickedOf, workingBranch } from "@/lib/branch";
import { BranchPicker } from "../branch-picker";
import { Empty, Flash, PageHead, startKey, startOf } from "../ui";
import { type OnHandRow, OnHandTable } from "./on-hand-table";

const PATH = "/backoffice/stock";

// A quantity as typed, in thousandths: "3", "1.5" or "1,5", above zero.
function amount(f: FormData, k: string): number {
  const m = /^(\d{1,7})(?:[.,](\d{1,3}))?$/.exec(String(f.get(k) ?? "").trim());
  const n = m ? Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0")) : 0;
  if (n <= 0) throw new Refused("Type how many, as a number above zero.");
  return n;
}

// Stock taken out, or put back, by hand. The reason decides the direction and
// the database holds the floor (stock_adjust, migration 0073): taking out more
// than the line holds is refused there, under the line's lock.
async function adjust(f: FormData) {
  "use server";
  await act("stock.adjust", backTo(f, PATH), async (c, ctx) => {
    const item = uuid(f, "item");
    const variant = UUID.test(String(f.get("variant") ?? "")) ? String(f.get("variant")) : null;
    const qty = amount(f, "qty");
    // the branch whose shelf this is (multi-branch): the one picked, or the account's only one
    const store = await formBranch(c, ctx.tenantId, f.get("store"));
    if (!store) throw new Refused("Pick the branch at the top first: stock is adjusted branch by branch.");
    const line = await c.query(
      `select i.name, v.name as variant, s.id as store, coalesce(l.qty, 0) as qty
         from items i
         cross join lateral (select $4::uuid as id) s
         left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.id = $3
         left join stock_levels l on l.tenant_id = i.tenant_id and l.store_id = s.id and l.item_id = i.id and l.variant_id is not distinct from $3
        where i.tenant_id = $1 and i.id = $2 and i.deleted_at is null`,
      [ctx.tenantId, item, variant, store],
    );
    if (line.rowCount !== 1) throw new Refused("That product is no longer there. Reload the page.");
    const was = line.rows[0] as { name: string; variant: string | null; store: string; qty: number };
    try {
      await c.query(`select stock_adjust($1, $2, $3, $4, $5, $6, $7, $8)`, [
        ctx.tenantId, was.store, item, variant, qty, String(f.get("reason") ?? ""), ctx.employeeId, text(f, "note", 120) || null,
      ]);
    } catch (e) {
      const said = adjustProblem(e instanceof Error ? e.message : "", units(Number(was.qty)));
      if (said) throw new Refused(said);
      throw e;
    }
    const now = await c.query(
      `select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`,
      [ctx.tenantId, was.store, item, variant],
    );
    return `${was.name}${was.variant ? ", " + was.variant : ""}: ${units(Number(now.rows[0]?.qty ?? 0))} on hand.`;
  });
}

type Line = {
  item_id: string; variant_id: string | null; name: string; variant: string | null; sku: string | null; barcode: string | null;
  category: string | null; supplier_id: string | null; supplier: string | null;
  price: string; qty: number; avg_cost: string; reorder_point: number | null; sold30: number;
};

// What a shop holds, line by line, at the branch picked (or its only one); with All branches of several, each
// line's total and every branch beside it, judged low at each branch against its own reorder point.
// Drawn after the approved "Stock on hand" board.
export async function OnHand({ sp, ctx }: { sp: Record<string, string | string[] | undefined>; ctx: TenantContext }) {
  const d = await readTenant(ctx.tenantId, async (c) => {
    const all = await branches(c, ctx.tenantId);
    const picked = await pickedOf(all);
    const working = workingBranch(all, picked);
    const [may, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.adjust') as adjust, has_perm($1, 'costs.view') as costs, has_perm($1, 'stock.receive') as receive, has_perm($1, 'stock.count') as count`, [ctx.employeeId]),
      loadSettings(c, ctx.tenantId),
    ]);
    // one branch's lines, or every branch's, each with its branch
    const per: { store: string; lines: Line[] }[] = [];
    for (const b of working ? [working] : all) per.push({ store: b.id, lines: (await c.query(`select * from stock_on_hand($1, $2)`, [ctx.tenantId, b.id])).rows as Line[] });
    return { may: may.rows[0] as { view: boolean; adjust: boolean; costs: boolean; receive: boolean; count: boolean }, all, picked, working, per, decimals: settings.decimals };
  });
  // All branches of several: a line is the sum of its branches, and each is shown beside it
  const side = d.working ? [] : d.all;
  const key = (l: Line) => l.item_id + (l.variant_id ? ":" + l.variant_id : "");
  const merged = new Map<string, Line & { at: Record<string, number>; value: number; lowAt: string[]; worst: StockStatus }>();
  const RANK: Record<StockStatus, number> = { ok: 0, low: 1, out: 2, negative: 3 };
  for (const { store, lines } of d.per) {
    for (const l of lines) {
      const was = merged.get(key(l));
      const st = stockStatus(l.qty, l.reorder_point);
      const name = d.all.find((b) => b.id === store)?.name ?? "";
      if (!was) {
        merged.set(key(l), { ...l, at: { [store]: l.qty }, value: lineValue(l.qty, Number(l.avg_cost)), lowAt: st === "ok" ? [] : [name], worst: st });
      } else {
        was.qty += l.qty;
        was.sold30 += l.sold30;
        was.at[store] = l.qty;
        was.value += lineValue(l.qty, Number(l.avg_cost));
        if (st !== "ok") was.lowAt.push(name);
        if (RANK[st] > RANK[was.worst]) was.worst = st;
      }
    }
  }
  const lines = [...merged.values()];
  const head = (
    <PageHead title="Stock on hand" lede="What the shop holds now. A sale takes from it, a delivery adds to it, and every change is kept under Movements.">
      <BranchPicker all={d.all} picked={d.picked?.id ?? null} />
      {d.may.view && d.may.count && <Link href="/backoffice/stock-counts" className="btn btn-quiet">New count</Link>}
      {d.may.view && d.may.receive && <Link href="/backoffice/purchase-orders" className="btn">Receive a delivery</Link>}
    </PageHead>
  );
  if (!d.may.view) {
    return (
      <div>
        {head}
        <Empty icon={Boxes} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const rs = (cents: number) => money(cents, d.decimals);
  // over every branch's lines: a line low at two branches is two lines to reorder
  const figures = stockTotals(d.per.flatMap((p) => p.lines).map((l) => ({ qty: l.qty, avgCost: Number(l.avg_cost), price: Number(l.price), reorderPoint: l.reorder_point })));
  // cost and value leave the server only for someone who may see cost
  const rows: OnHandRow[] = lines.map((l) => {
    const value = side.length ? l.value : lineValue(l.qty, Number(l.avg_cost));
    return {
      id: l.item_id + (l.variant_id ? ":" + l.variant_id : ""),
      item: l.item_id,
      variant_id: l.variant_id,
      name: l.name,
      variant: l.variant,
      sku: l.sku,
      barcode: l.barcode,
      category: l.category,
      supplier_id: l.supplier_id,
      supplier: l.supplier,
      qty: l.qty,
      qty_shown: units(l.qty),
      status: side.length ? l.worst : stockStatus(l.qty, l.reorder_point),
      // a reorder point is a branch's: with all of them side by side there is none to show
      reorder: side.length ? null : l.reorder_point,
      reorder_shown: side.length || l.reorder_point === null ? null : units(l.reorder_point),
      sold30: l.sold30,
      sold_shown: units(l.sold30),
      cost_shown: d.may.costs ? rs(Math.round(side.length ? (l.qty > 0 ? l.value / (l.qty / 1000) : 0) : Number(l.avg_cost))) : null,
      value: d.may.costs ? value : null,
      value_shown: d.may.costs ? rs(value) : null,
      ...(side.length ? { at: Object.fromEntries(side.map((b) => [b.id, units(l.at[b.id] ?? 0)])), lowAt: l.lowAt } : {}),
    };
  });
  const suppliers = [...new Map(lines.filter((l) => l.supplier_id).map((l) => [l.supplier_id!, l.supplier ?? ""])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const start = startOf(sp, "q", "show", "supplier", "sort", "open");
  return (
    <div>
      {head}
      <Flash sp={sp} />
      {lines.length === 0 ? (
        <Empty icon={Boxes} title="Nothing is counted yet">
          A product is counted when Counted in stock is ticked on its page. Add the first ones under <Link href="/backoffice/items">Products</Link>.
        </Empty>
      ) : (
        <>
          <div className="stats">
            {d.may.costs && (
              <div className="stat"><div className="stat-label">Stock value at cost</div><div className="stat-value">{rs(figures.atCost)}</div></div>
            )}
            <div className="stat"><div className="stat-label">At selling price</div><div className="stat-value">{rs(figures.atPrice)}</div></div>
            <div className="stat"><div className="stat-label">Low, time to reorder</div><div className="stat-value" style={figures.low ? { color: "var(--amber)" } : undefined}>{figures.low}</div></div>
            <div className="stat"><div className="stat-label">Out of stock</div><div className="stat-value" style={figures.out ? { color: "var(--red)" } : undefined}>{figures.out}</div></div>
            <div className="stat"><div className="stat-label">Below zero, needs a look</div><div className="stat-value" style={figures.negative ? { color: "var(--red)" } : undefined}>{figures.negative}</div></div>
          </div>
          <OnHandTable key={startKey(sp, start)} rows={rows} suppliers={suppliers} start={start} adjust={adjust} mayAdjust={d.may.adjust} showCost={d.may.costs} side={side} store={d.working?.id ?? null} />
        </>
      )}
    </div>
  );
}
