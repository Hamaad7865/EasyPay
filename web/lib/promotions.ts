import type { PoolClient } from "pg";

// A promotion on chosen lines (0110), worked out before anything moves: the
// Promotions page and EasyPay in Claude both promote this way (the owner of
// Kids Corner, 2026-10-29: a promotion price on certain products). Never below
// cost, so a line with no cost can't be promoted. A percent is off the price
// before any promotion. A line already promoted takes the new price: reduced
// again when lower, put back and promoted afresh when higher. A line that can't
// take it is left out, and said with why.

export type PromoItem = { id: string; name: string; options: string[]; updated_at: string };
export type PromoTarget = {
  item: string; line: string | null; name: string; values: string[]; price: number; cost: number | null; open: boolean; updated_at: string;
  live: { id: string; original: number; promo: number } | null;
};
export type PromoStep = { item: string; line: string | null; name: string; from: number; at: number; now: number; how: "apply" | "reduce" | "again"; promo: string | null };
export type PromoLeft = { why: "no-cost" | "below-cost" | "not-lower" | "already" | "open-price"; name: string; cost: number | null; now: number };

// The lines of some products, each with the promotion it has: a product's
// lines, or the product itself when it has none. Named "Product / line".
export async function promoTargets(c: PoolClient, t: string, ids: string[]): Promise<{ items: PromoItem[]; targets: PromoTarget[] }> {
  const items = (
    await c.query(
      `select id, name, price::float8 as price, cost::float8 as cost, open_price, coalesce(option_names, '{}') as options, updated_at::text
         from items where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null order by name`,
      [t, ids],
    )
  ).rows as (PromoItem & { price: number; cost: number | null; open_price: boolean })[];
  const vs = (
    await c.query(
      `select id, item_id, name, coalesce(option_values, '{}') as values, price::float8 as price, cost::float8 as cost, updated_at::text
         from item_variants where tenant_id = $1 and item_id = any($2::uuid[]) and deleted_at is null order by created_at, name`,
      [t, ids],
    )
  ).rows as { id: string; item_id: string; name: string; values: string[]; price: number; cost: number | null; updated_at: string }[];
  const on = (
    await c.query(
      `select id, item_id, variant_id, original_price::float8 as original, promo_price::float8 as promo
         from promotions where tenant_id = $1 and item_id = any($2::uuid[]) and status = 'active' and deleted_at is null`,
      [t, ids],
    )
  ).rows as { id: string; item_id: string; variant_id: string | null; original: number; promo: number }[];
  const targets: PromoTarget[] = [];
  for (const i of items) {
    const own = vs.filter((v) => v.item_id === i.id);
    const live = (line: string | null) => on.find((o) => o.item_id === i.id && o.variant_id === line) ?? null;
    if (!own.length) targets.push({ item: i.id, line: null, name: i.name, values: [], price: i.price, cost: i.cost, open: i.open_price, updated_at: i.updated_at, live: live(null) });
    for (const v of own) targets.push({ item: i.id, line: v.id, name: `${i.name} / ${v.name}`, values: v.values, price: v.price, cost: v.cost, open: i.open_price, updated_at: v.updated_at, live: live(v.id) });
  }
  return { items: items.map(({ id, name, options, updated_at }) => ({ id, name, options, updated_at })), targets };
}

// What each line becomes at a price (in cents) or a percent off. A percent
// comes out at the shop's smallest money (`unit` cents: 100 when it shows no
// cents), rounded up rather than below cost.
export function planPromotion(targets: PromoTarget[], price: number | null, off: number | null, unit: number): { plan: PromoStep[]; left: PromoLeft[] } {
  const plan: PromoStep[] = [], left: PromoLeft[] = [];
  for (const t of targets) {
    const from = t.live ? t.live.original : t.price;
    const exact = price !== null ? price : (from * (100 - (off as number))) / 100;
    let now = price !== null ? exact : Math.round(exact / unit) * unit;
    if (price === null && t.cost !== null && now < t.cost) now = Math.ceil(exact / unit) * unit;
    // what the line sells at once the promotion it has is put back (a price changed by hand since stays)
    const base = t.live && t.price === t.live.promo ? t.live.original : t.price;
    const out = (why: PromoLeft["why"]) => left.push({ why, name: t.name, cost: t.cost, now });
    const step = (how: PromoStep["how"]) => plan.push({ item: t.item, line: t.line, name: t.name, from, at: t.price, now, how, promo: t.live?.id ?? null });
    if (t.open) out("open-price");
    else if (t.cost === null) out("no-cost");
    else if (now < t.cost) out("below-cost");
    else if (t.live && now < t.live.promo) step("reduce");
    else if (t.live && now === t.live.promo) out("already");
    else if (now >= base) out("not-lower");
    else step(t.live ? "again" : "apply");
  }
  return { plan, left };
}

export async function runPromotion(c: PoolClient, t: string, emp: string, plan: PromoStep[], note: string | null): Promise<void> {
  for (const l of plan) {
    if (l.how === "reduce") await c.query(`select promotion_reduce($1,$2,$3,$4,$5,$6)`, [t, emp, l.item, l.line, l.now, note]);
    else {
      if (l.how === "again") await c.query(`select promotion_lift($1,$2,$3)`, [t, emp, l.promo]);
      await c.query(`select promotion_apply($1,$2,$3,$4,$5,$6)`, [t, emp, l.item, l.line, l.now, note]);
    }
  }
}

// a promotion function's refusals (0110), in the owner's words
export const PROMO_SAID: Record<string, string> = {
  "below-cost": "That is below what it cost: a promotion can never sell at a loss.",
  "not-lower": "A promotion price must be lower than the current price (or than the promotion's, when reducing again).",
  "no-cost": "Set a cost for it first: its cost is not known, and a promotion can never go below cost.",
  "on-promotion": "It is already on promotion. Reduce it again, or lift it first.",
  "not-active": "That promotion is not running any more. Reload the page.",
  "pick-variant": "A product with variants is put on promotion by the variant.",
  forbidden: "Your role does not include changing prices.",
};

export const someOf =(names: string[]) => names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");

// the lines left out, in words, by why; `said` is the promotion ("20% off"), costs only for whom may see them
export function leftWords(left: PromoLeft[], said: string, mayCost: boolean, money: (cents: number) => string): string[] {
  const of = (why: PromoLeft["why"]) => left.filter((l) => l.why === why);
  const n = (ls: PromoLeft[]) => `${ls.length} ${ls.length === 1 ? "line" : "lines"}`;
  const out: string[] = [];
  const none = of("no-cost"), below = of("below-cost"), high = of("not-lower"), same = of("already"), open = of("open-price");
  if (none.length) out.push(`${n(none)} left out: no cost is known, and a promotion never goes below cost (${someOf(none.map((l) => l.name))}). Set the cost first.`);
  if (below.length) out.push(`${n(below)} left out: ${said} would go below cost (${someOf(below.map((l) => (mayCost ? `${l.name}: cost ${money(l.cost as number)}, ${money(l.now)}` : l.name)))}).`);
  if (high.length) out.push(`${n(high)} left out: ${said} isn't lower than the price ${high.length === 1 ? "it sells" : "they sell"} at now (${someOf(high.map((l) => l.name))}).`);
  if (same.length) out.push(`${n(same)} already on promotion at that price (${someOf(same.map((l) => l.name))}).`);
  if (open.length) out.push(`${n(open)} left out: open price, said at the till (${someOf(open.map((l) => l.name))}).`);
  return out;
}
