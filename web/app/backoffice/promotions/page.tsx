import Link from "next/link";
import { notFound } from "next/navigation";
import { TicketPercent } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { parseRs } from "@/lib/money";
import { clock, lists } from "@/lib/report";
import { promoTargets, PROMO_SAID, type PromoTarget } from "@/lib/promotions";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";
import { promoteChosen } from "./actions";

// A shop's promotions (migration 0110): any product put on promotion, found
// by its name (a shop just imported has no slow movers yet); products that
// have stopped selling, marked down to shift them, never below cost; the
// promotions running now; the ones that still do not sell, reduced again. A
// promotion is a real change to the selling price, so the tills show it on
// their next sync; lifting puts the price back. The same rules hold on the
// tablet, under Products & stock, Promotions.

const PATH = "/backoffice/promotions";
const FOUND = 12;

type Slow = { item_id: string; variant_id: string | null; name: string; variant: string | null; category: string | null; qty: number; price: string; cost: string | null; days_idle: number };
type Active = { id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; original_price: string; promo_price: string; applied_at: string; applied_by: string | null; qty: number; cost: string | null };
type Stale = { promotion_id: string; item_id: string; variant_id: string | null; name: string; variant: string | null; original_price: string; promo_price: string; cost: string | null; days_idle: number };

const refused = (e: unknown) => new Refused((e instanceof Error && PROMO_SAID[e.message]) || "That could not be done. Nothing was changed.");

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
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 80);
  const d = await readTenant(ctx.tenantId, async (c) => {
    const s = await loadSettings(c, ctx.tenantId);
    // the products found to promote: by name, category, SKU or barcode (a line's too), each with its lines and stock
    const hits = q
      ? ((
          await c.query(
            `select i.id, case when k.id is null then null when pk.id is null then k.name else pk.name || ' › ' || k.name end as path
               from items i
               left join categories k on k.tenant_id = i.tenant_id and k.id = i.category_id
               left join categories pk on pk.tenant_id = k.tenant_id and pk.id = k.parent_id
              where i.tenant_id = $1 and i.deleted_at is null
                and (i.name ilike $2 or k.name ilike $2 or pk.name ilike $2 or i.sku = $3 or i.barcode = $3
                     or exists (select 1 from item_variants v where v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null and (v.sku = $3 or v.barcode = $3)))
              order by i.name limit ${FOUND + 1}`,
            [ctx.tenantId, `%${q.replace(/[\\%_]/g, "\\$&")}%`, q],
          )
        ).rows as { id: string; path: string | null }[])
      : [];
    const found = hits.length ? await promoTargets(c, ctx.tenantId, hits.slice(0, FOUND).map((h) => h.id)) : { items: [], targets: [] as PromoTarget[] };
    const held = hits.length
      ? new Map(
          (
            await c.query(
              `select item_id::text || ':' || coalesce(variant_id::text, '') as k, coalesce(sum(qty), 0)::int as qty from stock_levels
                where tenant_id = $1 and item_id = any($2::uuid[]) and deleted_at is null group by 1`,
              [ctx.tenantId, found.items.map((i) => i.id)],
            )
          ).rows.map((r) => [r.k as string, r.qty as number]),
        )
      : new Map<string, number>();
    return {
      found: found.items.map((i) => ({ ...i, path: hits.find((h) => h.id === i.id)?.path ?? null, lines: found.targets.filter((t) => t.item === i.id) })),
      more: hits.length > FOUND,
      held,
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
      <PageHead title="Promotions" lede="Put any product on promotion, see the ones that have stopped selling, and the promotions running now. A promotion lowers the price, never below cost, so it can never sell at a loss. It changes the real selling price: the tills show it on their next sync, and lifting it puts the price back.">
        <Link href="/backoffice/settings" className="btn-quiet">The two thresholds</Link>
      </PageHead>
      <Flash sp={sp} />

      {d.may.ok && (
        <Card title="Promote a product" lede="Any product, selling or not. Type a price (500) or a percent off (20%), for one line or every line at once. A percent is off the price before any promotion. A line with no cost, or that would go below it, is left out." flush={d.found.length > 0}>
          <form method="get" className="inline" style={d.found.length ? { padding: 16 } : undefined}>
            <input name="q" defaultValue={q} placeholder="Product, category or barcode" aria-label="Find a product to promote" />
            <Submit className="btn-quiet btn-sm">Find</Submit>
          </form>
          {q && d.found.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No product matches &ldquo;{q}&rdquo;.</p>}
          {d.found.length > 0 && (
            <table>
              <thead><tr><th>Product</th><th className="num">Stock</th><th className="num">Price</th><th>Set promotion</th></tr></thead>
              <tbody>
                {d.found.flatMap((p) => {
                  const form = (t: PromoTarget | null, every: boolean) => (
                    <form action={promoteChosen} className="inline">
                      <input type="hidden" name="item" value={p.id} />
                      {t?.line && <input type="hidden" name="variant" value={t.line} />}
                      <input type="hidden" name="back" value={`${PATH}?q=${encodeURIComponent(q)}`} />
                      <input name="amount" required placeholder="500 or 20%" className="narrow" aria-label={every ? `Promotion of every line of ${p.name}` : `Promotion price of ${t?.name ?? p.name}`} />
                      <Submit className="btn-quiet btn-sm">{every ? "Every line" : "Apply"}</Submit>
                    </form>
                  );
                  const price = (t: PromoTarget) => (t.live ? <><s className="muted">{m(t.live.original)}</s> {m(t.price)}</> : m(t.price));
                  const qty = (t: PromoTarget) => Math.round((d.held.get(`${p.id}:${t.line ?? ""}`) ?? 0) / 1000);
                  const sub = <>{p.path && <span className="sub">{p.path}</span>}</>;
                  const cost = (t: PromoTarget) => { const n = costNote(t.cost === null ? null : String(t.cost)); return n && <span className="sub">{n}</span>; };
                  const own = p.lines[0];
                  if (own && !own.line)
                    return [
                      <tr key={p.id}>
                        <td className="strong"><Link href={`/backoffice/items/${p.id}`}>{p.name}</Link>{own.live && <span className="badge amber" style={{ marginLeft: 8 }}>on promotion</span>}{sub}{cost(own)}</td>
                        <td className="num">{qty(own)}</td>
                        <td className="num">{price(own)}</td>
                        <td>{form(own, false)}</td>
                      </tr>,
                    ];
                  return [
                    <tr key={p.id}>
                      <td className="strong"><Link href={`/backoffice/items/${p.id}`}>{p.name}</Link>{sub}</td>
                      <td className="num">{p.lines.reduce((n, t) => n + qty(t), 0)}</td>
                      <td className="num muted">{p.lines.length} {p.lines.length === 1 ? "line" : "lines"}</td>
                      <td>{form(null, true)}</td>
                    </tr>,
                    ...p.lines.map((t) => (
                      <tr key={t.line ?? p.id}>
                        <td style={{ paddingLeft: 32 }}>{t.name.slice(p.name.length + 3)}{t.live && <span className="badge amber" style={{ marginLeft: 8 }}>on promotion</span>}{cost(t)}</td>
                        <td className="num">{qty(t)}</td>
                        <td className="num">{price(t)}</td>
                        <td>{form(t, false)}</td>
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          )}
          {d.more && <p className="muted" style={{ padding: "0 16px 16px", margin: 0 }}>Showing the first {FOUND}. Type more of the name to find the one you want.</p>}
        </Card>
      )}
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
          <Empty icon={TicketPercent} title="No promotions are running">Put a product on promotion with Promote a product, or from the slow movers above.</Empty>
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
