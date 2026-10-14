import Link from "next/link";
import { notFound } from "next/navigation";
import { TicketPercent } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { parseRs } from "@/lib/money";
import { clock, lists } from "@/lib/report";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

// A shop's promotions (migration 0110): products that have stopped selling,
// marked down to shift them, never below cost; the promotions running now;
// the ones that still do not sell, reduced again. A promotion is a real
// change to the selling price, so the tills show it on their next sync;
// lifting puts the price back. The same rules hold on the tablet, under
// Products & stock, Promotions.

const PATH = "/backoffice/promotions";

type Slow = { item_id: string; variant_id: string | null; name: string; variant: string | null; category: string | null; qty: number; price: string; cost: string | null; days_idle: number };
type Active = { id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; original_price: string; promo_price: string; applied_at: string; applied_by: string | null; qty: number; cost: string | null };
type Stale = { promotion_id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; original_price: string; promo_price: string; cost: string | null; days_idle: number };

const said: Record<string, string> = {
  "below-cost": "That is below what it cost: a promotion can never sell at a loss.",
  "not-lower": "A promotion price must be lower than the current price (or than the promotion's, when reducing again).",
  "no-cost": "Set a cost for it first: its cost is not known, and a promotion can never go below cost.",
  "on-promotion": "It is already on promotion. Reduce it again, or lift it first.",
  "not-active": "That promotion is not running any more. Reload the page.",
  "pick-variant": "A product with variants is put on promotion by the variant.",
  forbidden: "Your role does not include changing prices.",
};
const refused = (e: unknown) => new Refused((e instanceof Error && said[e.message]) || "That could not be done. Nothing was changed.");

async function applyPromotion(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const item = uuid(f, "item");
    const variant = String(f.get("variant") ?? "") || null;
    const price = parseRs(String(f.get("price") ?? ""));
    if (price === null || price < 0) throw new Refused("The promotion price is not a number.");
    try {
      await c.query(`select promotion_apply($1, $2, $3, $4, $5, $6)`, [ctx.tenantId, ctx.employeeId, item, variant, price, text(f, "note", 120) || null]);
    } catch (e) { throw refused(e); }
    return "On promotion. The tills show the new price on their next sync.";
  });
}

async function reducePromotion(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    const item = uuid(f, "item");
    const variant = String(f.get("variant") ?? "") || null;
    const price = parseRs(String(f.get("price") ?? ""));
    if (price === null || price < 0) throw new Refused("The new price is not a number.");
    try {
      await c.query(`select promotion_reduce($1, $2, $3, $4, $5, $6)`, [ctx.tenantId, ctx.employeeId, item, variant, price, text(f, "note", 120) || null]);
    } catch (e) { throw refused(e); }
    return "Reduced again. The original price is still remembered.";
  });
}

async function liftPromotion(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (c, ctx) => {
    let restored = true;
    try {
      restored = (await c.query(`select promotion_lift($1, $2, $3) as r`, [ctx.tenantId, ctx.employeeId, uuid(f, "id")])).rows[0].r as boolean;
    } catch (e) { throw refused(e); }
    return restored ? "Lifted. The price is back to what it was." : "Lifted. The price had been changed by hand since, so it is left as it stands.";
  });
}

export default async function PromotionsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail") notFound();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const s = await loadSettings(c, ctx.tenantId);
    return {
      l: await lists(c, ctx.tenantId),
      s,
      may: (await c.query(`select has_perm($1, 'items.edit') as ok, has_perm($1, 'costs.view') as cost`, [ctx.employeeId])).rows[0] as { ok: boolean; cost: boolean },
      slow: (await c.query(`select * from slow_movers($1, $2)`, [ctx.tenantId, s.slowMoverDays])).rows as Slow[],
      active: (
        await c.query(
          `select p.id, p.item_id, p.variant_id, i.name, v.name as variant, p.original_price, p.promo_price, p.applied_at, e.name as applied_by,
                  coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = p.tenant_id and l.item_id = p.item_id and l.variant_id is not distinct from p.variant_id and l.deleted_at is null), 0)::int as qty,
                  coalesce(v.cost, i.cost) as cost
             from promotions p
             join items i on i.tenant_id = p.tenant_id and i.id = p.item_id
             left join item_variants v on v.tenant_id = p.tenant_id and v.id = p.variant_id
             left join employees e on e.tenant_id = p.tenant_id and e.id = p.applied_by
            where p.tenant_id = $1 and p.status = 'active' and p.deleted_at is null
            order by p.applied_at desc`,
          [ctx.tenantId],
        )
      ).rows as Active[],
      stale: (await c.query(`select * from stale_promotions($1, $2)`, [ctx.tenantId, s.promoStillDays])).rows as Stale[],
    };
  });
  const at = clock(d.l.tz);
  const m = (v: string | number | null) => money(Number(v ?? 0), d.s.decimals);
  const label = (name: string, variant: string | null) => (variant ? `${name}, ${variant}` : name);
  const costNote = (cost: string | null) => (d.may.cost ? (cost === null ? "no cost known" : `cost ${m(cost)}`) : null);
  const staleIds = new Set(d.stale.map((x) => x.promotion_id));
  return (
    <div>
      <PageHead title="Promotions" lede="Products that have stopped selling, and the promotions running now. A promotion lowers the price to shift stock, never below cost, so it can never sell at a loss. It changes the real selling price: the tills show it on their next sync, and lifting it puts the price back.">
        <Link href="/backoffice/settings" className="btn-quiet">The two thresholds</Link>
      </PageHead>
      <Flash sp={sp} />
      <p className="muted">
        Flag a product with no sale in the last <strong>{d.s.slowMoverDays} days</strong>; flag a promotion still unsold after <strong>{d.s.promoStillDays} days</strong> on promotion.
        Both are set on POS settings. A product with variants is marked down by the variant: each has its own cost.
      </p>

      <Card title={`Slow movers${d.slow.length ? ` (${d.slow.length})` : ""}`} flush>
        {d.slow.length === 0 ? (
          <p className="muted" style={{ padding: 16, margin: 0 }}>Nothing has gone quiet: every product with stock has sold within the last {d.s.slowMoverDays} days.</p>
        ) : (
          <table>
            <thead><tr><th>Product</th><th>Category</th><th className="num">Idle</th><th className="num">Stock</th><th className="num">Price</th>{d.may.ok && <th>Set promotion</th>}</tr></thead>
            <tbody>
              {d.slow.map((r) => (
                <tr key={r.item_id + (r.variant_id ?? "")}>
                  <td className="strong"><Link href={`/backoffice/items/${r.item_id}`}>{label(r.name, r.variant)}</Link>{costNote(r.cost) && <span className="sub">{costNote(r.cost)}</span>}</td>
                  <td>{r.category ?? <span className="muted">No category</span>}</td>
                  <td className="num">{r.days_idle} {r.days_idle === 1 ? "day" : "days"}</td>
                  <td className="num">{Math.round(r.qty / 1000)}</td>
                  <td className="num">{m(r.price)}</td>
                  {d.may.ok && (
                    <td>
                      <form action={applyPromotion} className="inline">
                        <input type="hidden" name="item" value={r.item_id} />
                        <input type="hidden" name="variant" value={r.variant_id ?? ""} />
                        <input name="price" required inputMode="decimal" placeholder="New price" className="narrow" aria-label={`Promotion price of ${label(r.name, r.variant)}`} />
                        <Submit className="btn-quiet btn-sm">Apply</Submit>
                      </form>
                      {r.cost === null && <span className="sub">Set a cost first: a promotion never goes below cost.</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`On promotion${d.active.length ? ` (${d.active.length})` : ""}`} flush>
        {d.active.length === 0 ? (
          <Empty icon={TicketPercent} title="No promotions are running">Put a product on promotion from the slow movers above.</Empty>
        ) : (
          <table>
            <thead><tr><th>Item</th><th className="num">Was</th><th className="num">Now</th><th className="num">Off</th><th className="num">Stock</th><th>Applied</th>{d.may.ok && <th />}</tr></thead>
            <tbody>
              {d.active.map((p) => (
                <tr key={p.id}>
                  <td className="strong"><Link href={`/backoffice/items/${p.item_id}`}>{label(p.name, p.variant)}</Link>{staleIds.has(p.id) && <span className="badge amber" style={{ marginLeft: 8 }}>still not selling</span>}</td>
                  <td className="num muted"><s>{m(p.original_price)}</s></td>
                  <td className="num strong">{m(p.promo_price)}</td>
                  <td className="num">{m(Number(p.original_price) - Number(p.promo_price))}</td>
                  <td className="num">{Math.round(p.qty / 1000)}</td>
                  <td>{at(p.applied_at)}{p.applied_by && <span className="sub">{p.applied_by}</span>}</td>
                  {d.may.ok && (
                    <td>
                      <form action={liftPromotion} className="inline">
                        <input type="hidden" name="id" value={p.id} />
                        <Submit className="btn-quiet btn-sm">Lift</Submit>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {d.may.ok && d.stale.length > 0 && (
        <Card title={`Still not selling (${d.stale.length})`} lede={`On promotion with no sale in the last ${d.s.promoStillDays} days. Reduce the price again: the original price is remembered, so lifting later still puts it all back.`} flush>
          <table>
            <thead><tr><th>Item</th><th className="num">Was</th><th className="num">Now</th><th className="num">Idle</th><th>Reduce again</th></tr></thead>
            <tbody>
              {d.stale.map((p) => (
                <tr key={p.promotion_id}>
                  <td className="strong">{label(p.name, p.variant)}{costNote(p.cost) && <span className="sub">{costNote(p.cost)}</span>}</td>
                  <td className="num muted"><s>{m(p.original_price)}</s></td>
                  <td className="num strong">{m(p.promo_price)}</td>
                  <td className="num">{p.days_idle} days</td>
                  <td>
                    <form action={reducePromotion} className="inline">
                      <input type="hidden" name="item" value={p.item_id} />
                      <input type="hidden" name="variant" value={p.variant_id ?? ""} />
                      <input name="price" required inputMode="decimal" placeholder="Lower price" className="narrow" aria-label={`New promotion price of ${label(p.name, p.variant)}`} />
                      <Submit className="btn-quiet btn-sm">Reduce</Submit>
                    </form>
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
