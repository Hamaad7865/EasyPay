import type { PoolClient } from "pg";
import { money } from "@/lib/settings";
import { key, type Spelling } from "./words";
import type { Grid, Sheet, SheetKey, Tile, Tone } from "./types";

// What the assistant reads of a shop's catalog and stock, as the business
// (inside its own transaction: RLS keeps every question to it). The cards are
// built from these, and so are the previews: a change is run, these read what
// it made, and the change is undone.

export type Branch = { id: string; name: string };
export type Product = {
  id: string; name: string; price: number; cost: number | null; brand: string | null; sku: string | null; barcode: string | null;
  category_id: string | null; path: string | null; options: string[]; picture: string | null; counted: boolean; updated_at: string;
};
export type Line = {
  id: string; name: string; values: string[]; price: number; cost: number | null; sku: string | null; barcode: string | null;
  picture: string | null; updated_at: string;
};

export const pieces = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
export const tone = (q: number): Tone => (q < 0 ? "below" : q === 0 ? "none" : q <= 2000 ? "few" : "plenty");
export const rs = (cents: number) => money(cents, 2);

export async function branches(c: PoolClient, t: string): Promise<Branch[]> {
  return (await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by name`, [t])).rows;
}

const PRODUCT = `select i.id, i.name, i.price::float8 as price, i.cost::float8 as cost, i.brand, i.sku, i.barcode, i.category_id,
         case when k.id is null then null when p.id is null then k.name else p.name || ' › ' || k.name end as path,
         coalesce(i.option_names, '{}') as options, i.picture_id as picture, i.track_stock as counted, i.updated_at::text
    from items i
    left join categories k on k.tenant_id = i.tenant_id and k.id = i.category_id
    left join categories p on p.tenant_id = k.tenant_id and p.id = k.parent_id`;

export async function product(c: PoolClient, t: string, id: string): Promise<Product | null> {
  return (await c.query(`${PRODUCT} where i.tenant_id = $1 and i.id = $2 and i.deleted_at is null`, [t, id])).rows[0] ?? null;
}

export async function lines(c: PoolClient, t: string, item: string): Promise<Line[]> {
  return (
    await c.query(
      `select id, name, coalesce(option_values, '{}') as values, price::float8 as price, cost::float8 as cost, sku, barcode, picture_id as picture, updated_at::text
         from item_variants where tenant_id = $1 and item_id = $2 and deleted_at is null order by created_at, name`,
      [t, item],
    )
  ).rows;
}

// what each line holds at a branch ("" is the product itself, when it has no lines)
export async function stock(c: PoolClient, t: string, item: string, store: string): Promise<Map<string, number>> {
  const r = await c.query(`select coalesce(variant_id::text, '') as v, qty from stock_levels where tenant_id = $1 and item_id = $2 and store_id = $3 and deleted_at is null`, [t, item, store]);
  return new Map(r.rows.map((x) => [x.v as string, Number(x.qty)]));
}

// the spellings each option has, with how many lines say each (spec Q5)
export function spellings(options: string[], ls: Line[]): Spelling[][] {
  return options.map((_, i) => {
    const n = new Map<string, number>();
    for (const l of ls) if (l.values[i]) n.set(l.values[i], (n.get(l.values[i]) ?? 0) + 1);
    return [...n].map(([value, count]) => ({ value, lines: count })).sort((a, b) => b.lines - a.lines || a.value.localeCompare(b.value));
  });
}

// Products by the owner's words: every word found in the name, the category
// path or the brand, compared as words.ts compares them. Best first.
export async function find(c: PoolClient, t: string, words: string, limit = 12) {
  const all = (await c.query(`${PRODUCT} where i.tenant_id = $1 and i.deleted_at is null`, [t])).rows as Product[];
  const asked = words.split(/\s+/).map(key).filter(Boolean);
  const scored = all
    .map((p) => {
      const hay = `${p.name} ${p.path ?? ""} ${p.brand ?? ""}`.split(/[\s›/-]+/).map(key).filter(Boolean);
      const hits = asked.filter((w) => hay.some((h) => h === w || h.startsWith(w) || w.startsWith(h))).length;
      const exact = key(p.name) === key(words) ? 1 : 0;
      return { p, score: exact * 100 + hits };
    })
    .filter((x) => asked.length === 0 || x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map((x) => ({ ...x.p, exact: x.score >= 100, matched: x.score % 100, asked: asked.length }));
}

export function tileOf(p: Product, ls: Line[], held: Map<string, number>, price?: number): Tile {
  const total = ls.length ? ls.reduce((a, l) => a + (held.get(l.id) ?? 0), 0) : held.get("") ?? 0;
  return {
    name: p.name,
    price: rs(price ?? p.price),
    category: p.path,
    // a picture is behind the back office's sign-in, which a card in Claude doesn't have: initials for now
    picture: null,
    lines: ls.length,
    pieces: p.counted ? pieces(total) : null,
  };
}

// The sheet the tablet shows for a product with variants, with `picked` lit:
// each option's values in the order the lines first have them, the picked
// ones first when there are many (the tablet scrolls; a card shows twelve).
export function sheetOf(p: Product, ls: Line[], held: Map<string, number>, picked: string[], fresh: Set<string> = new Set()): Sheet | null {
  if (p.options.length === 0 || ls.length === 0) return null;
  const SHOWN = 12;
  const last = p.options.length - 1;
  const options = p.options.map((name, i) => {
    const values = [...new Set(ls.map((l) => l.values[i]).filter(Boolean))];
    const first = picked[i] && values.includes(picked[i]) ? [picked[i], ...values.filter((v) => v !== picked[i])] : values;
    const keys: SheetKey[] = first.slice(0, SHOWN).map((value) => {
      let left: string | null = null;
      let t: Tone | null = null;
      if (i === last && p.counted) {
        const want = [...picked.slice(0, last), value];
        const exact = ls.find((l) => l.values.length === want.length && l.values.every((v, j) => v === want[j]));
        left = exact ? `${pieces(held.get(exact.id) ?? 0)} left` : "None";
        t = exact ? tone(held.get(exact.id) ?? 0) : "none";
      }
      return { value, on: picked[i] === value, left, tone: t, isNew: fresh.has(`${i}:${value}`) };
    });
    return { name, keys, more: Math.max(0, first.length - SHOWN) };
  });
  const line = ls.find((l) => l.values.length === picked.length && l.values.every((v, j) => v === picked[j]));
  return { options, add: `Add ${line ? line.name : picked.join(" / ")}` };
}

// A product's stock as grids (spec Q28): one per value of the third option,
// the first option down and the second across; one grid for two options;
// none for fewer (the card lists those lines).
export function gridsOf(p: Product, ls: Line[], held: Map<string, number>): Grid[] {
  if (p.options.length < 2) return [];
  const third = p.options.length >= 3 ? [...new Set(ls.map((l) => l.values[2]))] : [null];
  return third.map((s) => {
    const mine = ls.filter((l) => s === null || l.values[2] === s);
    const rows = [...new Set(mine.map((l) => l.values[0]))];
    const cols = [...new Set(mine.map((l) => l.values[1]))].sort((a, b) => sizeOrder(a) - sizeOrder(b) || a.localeCompare(b));
    const cells = rows.map((r) =>
      cols.map((col) => {
        const l = mine.find((x) => x.values[0] === r && x.values[1] === col);
        if (!l) return null;
        const q = held.get(l.id) ?? 0;
        return { qty: pieces(q), tone: tone(q), line: l.id };
      }),
    );
    return { title: s === null ? null : `${p.options[2]}: ${s}`, rows, cols, cells };
  });
}

// sizes in the order a child grows: months first (3-6m, 6-9m, 24m), then years
function sizeOrder(v: string): number {
  const m = /^(\d+)\s*(?:-\s*\d+)?\s*m$/i.exec(v.trim());
  if (m) return Number(m[1]) / 100;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 1000;
}
