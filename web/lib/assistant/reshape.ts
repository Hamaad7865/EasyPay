import type { PoolClient } from "pg";
import type { Who } from "./oauth";
import { branches, lines, pieces, product, rs, sheetOf, spellings, stock, tileOf, type Line, type Product } from "./catalog";
import { groups, key, read, thousandths, titled, cents } from "./words";
import type { Reading, Sheet, StockMove, Tile, Warning } from "./types";
import { skusForNewLines } from "@/lib/saves";

// Release 1b of EasyPay in Claude (spec Q15, Q16, Q32, Q33, Q46 to Q55): the
// changes that reshape a catalog. A tidy of one option's spellings, a split of
// one product into several, a move of lines into another product, an option
// renamed, "tidy the stock" (one plan of such steps, one Confirm), and a file
// read by Claude imported. Each is a Kind, run the same way as the others
// (lib/assistant/changes.ts): planned, run and read back, undone, kept,
// confirmed.

export class Ask extends Error {}
export class No extends Error {}
type Params = Record<string, unknown>;
type C = { c: PoolClient; w: Who; t: string };
export type Planned = { params: Params; readings: Reading[]; title: string; touched: Record<string, string> };
export type Ran = { summary: string; lines: string[]; fix?: Params; undo?: unknown; item?: string; picked?: string[] };
export type Viewed = { tile: Tile | null; sheet: Sheet | null; stock: StockMove[]; warnings: Warning[]; danger: boolean; confirm: string; typeName: string | null; lines?: string[] };
export type ReKind = { perm: string; plan(x: C, input: Params): Promise<Planned>; run(x: C, p: Params): Promise<Ran>; view(x: C, p: Params, ran: Ran, before: Planned): Promise<Viewed> };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());
const BIG = 50;
// more pieces of one line than a shop of this kind holds: likely a typo (thousandths)
export const TYPO = 100_000;

async function productOf(x: C, id: unknown): Promise<Product> {
  const s = str(id);
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new Ask("Which product? Find it first (the find tool gives each product's id).");
  const p = await product(x.c, x.t, s);
  if (!p) throw new No("That product is not there any more.");
  return p;
}
function optionOf(p: Product, said: unknown): number {
  const i = p.options.findIndex((o) => o.toLowerCase() === str(said).toLowerCase());
  if (i < 0) throw new Ask(`Which option of ${p.name}? It has ${p.options.join(", ")}.`);
  return i;
}
// what each line holds at every branch together
async function held(x: C, item: string): Promise<Map<string, number>> {
  const r = await x.c.query(`select coalesce(variant_id::text, '') as v, sum(qty)::float8 as q from stock_levels where tenant_id = $1 and item_id = $2 and deleted_at is null group by 1`, [x.t, item]);
  return new Map(r.rows.map((y) => [y.v as string, Number(y.q)]));
}
async function categoryPath(x: C, said: string): Promise<{ id: string; path: string }> {
  const [a, b] = said.split(/\s*[›>]\s*/);
  const r = await x.c.query(
    `select k.id, case when p.id is null then k.name else p.name || ' › ' || k.name end as path, k.name, p.name as parent
       from categories k left join categories p on p.id = k.parent_id where k.tenant_id = $1 and k.deleted_at is null`,
    [x.t],
  );
  const hit = b
    ? r.rows.find((k) => (k.parent ?? "").toLowerCase() === a.toLowerCase() && k.name.toLowerCase() === b.toLowerCase())
    : r.rows.find((k) => !k.parent && k.name.toLowerCase() === a.toLowerCase());
  if (!hit) throw new Ask(`There's no category ${said}. Make it first.`);
  return { id: hit.id, path: hit.path };
}

// ------------------------------------------------------------------- tidy

// One option of one product, its spellings made one (Q15). Lines that become
// the same are merged first (Q16): the one holding more is kept.
export const tidy: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const i = optionOf(p, input.option);
    const ls = await lines(x.c, x.t, p.id);
    const names = (input.names ?? {}) as Record<string, string>;
    const gs = groups(spellings(p.options, ls)[i]).map((g) => ({ ...g, to: titled(str(names[g.to]) || g.to).slice(0, 30) }));
    const target = new Map<string, string>();
    for (const g of gs) for (const f of g.from) target.set(f.value, g.to);
    const renames = gs.flatMap((g) => g.from.filter((f) => f.value !== g.to).map((f) => ({ from: f.value, to: g.to, lines: f.lines })));
    if (renames.length === 0) throw new No(`${p.name}'s ${p.options[i]} is already tidy: one spelling for each.`);
    // lines that would become one
    const h = await held(x, p.id);
    const sold = new Map(
      (await x.c.query(`select variant_id::text as v, count(*)::int as n from ticket_lines where tenant_id = $1 and variant_id = any($2::uuid[]) group by 1`, [x.t, ls.map((l) => l.id)])).rows.map((r) => [r.v, r.n]),
    );
    const by = new Map<string, Line[]>();
    for (const l of ls) {
      const k = l.values.map((v, j) => (j === i ? target.get(v) ?? v : v).toLowerCase()).join("\u0001");
      by.set(k, [...(by.get(k) ?? []), l]);
    }
    const merges = [...by.values()]
      .filter((g) => g.length > 1)
      .flatMap((g) => {
        const sorted = [...g].sort((a, b) => (h.get(b.id) ?? 0) - (h.get(a.id) ?? 0) || (sold.get(b.id) ?? 0) - (sold.get(a.id) ?? 0));
        return sorted.slice(1).map((d) => ({ keep: sorted[0].id, drop: d.id, keepName: sorted[0].name, dropName: d.name, barcode: d.barcode }));
      });
    const readings: Reading[] = [{ said: "product", is: p.name, note: `${p.options[i]}: ${gs.reduce((a, g) => a + g.from.length, 0)} spellings → ${gs.length}`, isNew: false }];
    for (const g of gs.filter((g) => g.from.some((f) => f.value !== g.to))) {
      readings.push({ said: g.from.map((f) => `${f.value} ${f.lines}`).join(", "), is: g.to, note: `${g.lines} lines`, isNew: false });
    }
    return {
      params: { item: p.id, option: i + 1, renames: renames.map(({ from, to }) => ({ from, to })), merges, touched: renames.reduce((a, r) => a + r.lines, 0) },
      readings,
      title: `Tidy ${p.options[i]} of ${p.name}`,
      touched: { [`items:${p.id}`]: p.updated_at, ...Object.fromEntries(merges.flatMap((m) => ls.filter((l) => l.id === m.keep || l.id === m.drop).map((l) => [`item_variants:${l.id}`, l.updated_at]))) },
    };
  },
  async run(x, p) {
    for (const m of p.merges as { keep: string; drop: string }[]) await x.c.query(`select variant_merge($1,$2,$3,$4)`, [x.t, m.keep, m.drop, x.w.employeeId]);
    for (const r of p.renames as { from: string; to: string }[]) {
      // a spelling only its case away from the one taken is renamed with it, by the first call
      const left = await x.c.query(`select 1 from item_variants where tenant_id = $1 and item_id = $2 and deleted_at is null and option_values[$3] = $4 limit 1`, [x.t, p.item, p.option, r.from]);
      if (left.rowCount) await x.c.query(`select variant_value_rename($1,$2,$3,$4,$5,false)`, [x.t, p.item, p.option, r.from, r.to]);
    }
    return { summary: "tidied", lines: [], item: p.item as string };
  },
  async view(x, p, _ran, before) {
    const prod = (await product(x.c, x.t, p.item as string))!;
    const ls = await lines(x.c, x.t, prod.id);
    const store = (await branches(x.c, x.t))[0];
    const h = store ? await stock(x.c, x.t, prod.id, store.id) : new Map<string, number>();
    const merges = p.merges as { keepName: string; dropName: string; barcode: string | null }[];
    const warnings: Warning[] = merges.map((m) => ({ tone: "amber", text: `${m.dropName} merges into ${m.keepName}, with its stock.${m.barcode ? ` Its barcode ${m.barcode} stops scanning: reprint its labels.` : ""}` }));
    return {
      tile: tileOf(prod, ls, h),
      sheet: null,
      stock: [],
      warnings,
      danger: false,
      confirm: "Tidy",
      typeName: (p.touched as number) > BIG ? x.w.tenantName : null,
      lines: before.readings.slice(1).map((r) => `${r.said} → ${r.is}`),
    };
  },
};

// ------------------------------------------------------------ rename option

export const renameOption: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const i = optionOf(p, input.option);
    const to = titled(str(input.to)).slice(0, 30);
    if (!to) throw new Ask(`What should ${p.options[i]} be called?`);
    if (p.options.some((o, j) => j !== i && o.toLowerCase() === to.toLowerCase())) throw new No(`${p.name} already has an option called ${to}.`);
    return { params: { item: p.id, option: i + 1, to }, readings: [{ said: p.options[i], is: to, note: `an option of ${p.name}`, isNew: false }], title: `Rename ${p.options[i]} to ${to} on ${p.name}`, touched: { [`items:${p.id}`]: p.updated_at } };
  },
  async run(x, p) {
    await x.c.query(`update items set option_names[$3] = $4 where tenant_id = $1 and id = $2`, [x.t, p.item, p.option, p.to]);
    return { summary: "option renamed", lines: [], item: p.item as string };
  },
  async view() {
    return { tile: null, sheet: null, stock: [], warnings: [], danger: false, confirm: "Rename", typeName: null };
  },
};

// ------------------------------------------------------------- split, move

type Part = { name: string; values: string[]; lines: string[]; price: number; existing?: string };

// One product into several, by an option or by groups of its values (Q32):
// each line moves with its barcode, stock and history; the option leaves the
// new products and goes into their names.
export const split: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const i = optionOf(p, input.by);
    const ls = await lines(x.c, x.t, p.id);
    const spelled = spellings(p.options, ls)[i];
    const twice = groups(spelled).filter((g) => g.from.length > 1);
    if (twice.length) throw new No(`${p.options[i]} has several spellings of one thing (${twice[0].from.map((f) => f.value).join(", ")}). Tidy it first, or the split would make one product for each spelling.`);
    const asked = (input.groups ?? null) as Record<string, string[]> | null;
    const named = (input.names ?? {}) as Record<string, string>;
    const parts: Part[] = asked
      ? Object.entries(asked).map(([name, vals]) => ({ name: str(name), values: vals.map(str), lines: [], price: 0 }))
      : spelled.map((s) => ({ name: str(named[s.value]) || `${p.name.replace(/\s+/g, " ")} ${s.value}`, values: [s.value], lines: [], price: 0 }));
    for (const part of parts) {
      const mine = ls.filter((l) => part.values.some((v) => v.toLowerCase() === (l.values[i] ?? "").toLowerCase()));
      if (!mine.length) throw new No(`No line of ${p.name} has ${part.values.join(" or ")}.`);
      part.lines = mine.map((l) => l.id);
      const count = new Map<number, number>();
      for (const l of mine) count.set(l.price, (count.get(l.price) ?? 0) + 1);
      part.price = [...count].sort((a, b) => b[1] - a[1])[0][0];
      // lines of one new product that would be the same once the option is gone
      const seen = new Set<string>();
      for (const l of mine) {
        const k = l.values.filter((_, j) => j !== i).join(" / ").toLowerCase();
        if (seen.has(k)) throw new No(`In ${part.name}, two lines would both be ${l.values.filter((_, j) => j !== i).join(" / ")} once ${p.options[i]} is gone. Keep those values apart, or tidy first.`);
        seen.add(k);
      }
      const there = (await x.c.query(`select id from items where tenant_id = $1 and deleted_at is null and lower(name) = lower($2) and id <> $3`, [x.t, part.name, p.id])).rows[0];
      if (there) throw new No(`${part.name} is already a product. To put lines into it, move them instead.`);
    }
    const left = ls.length - parts.reduce((a, q) => a + q.lines.length, 0);
    const cat = str(input.category) ? await categoryPath(x, str(input.category)) : null;
    const readings: Reading[] = [
      { said: "product", is: p.name, note: `${ls.length} lines, split by ${p.options[i]}`, isNew: false },
      ...parts.map((q) => ({ said: q.values.join(", "), is: q.name, note: `${q.lines.length} lines, ${rs(q.price)}`, isNew: true })),
    ];
    if (cat) readings.push({ said: "category", is: cat.path, note: "the new products go in it", isNew: false });
    if (left) readings.push({ said: "left behind", is: `${left} lines`, note: `stay in ${p.name}`, isNew: false });
    return {
      // the category by its path, found again when it is made: a plan may make it in a step before
      params: { item: p.id, option: i + 1, parts, category: cat?.path ?? null, lines: ls.length },
      readings,
      title: `Split ${p.name} by ${p.options[i]} into ${parts.length} products`,
      touched: { [`items:${p.id}`]: p.updated_at },
    };
  },
  async run(x, p) {
    const from = (await product(x.c, x.t, p.item as string))!;
    const old = await lines(x.c, x.t, from.id);
    const opt = p.option as number;
    const category = p.category ? (await categoryPath(x, p.category as string)).id : from.category_id;
    const made: string[] = [];
    for (const part of p.parts as Part[]) {
      const id = (
        await x.c.query(
          `insert into items (tenant_id, name, category_id, brand, price, option_names, track_stock, is_available, sold_by, supplier_id, picture_id)
           select tenant_id, $3, $4, brand, $5, $6, track_stock, is_available, sold_by, supplier_id, picture_id from items where tenant_id = $1 and id = $2 returning id`,
          [x.t, from.id, part.name, category, part.price, from.options.filter((_, j) => j !== opt - 1)],
        )
      ).rows[0].id as string;
      await x.c.query(`insert into item_taxes (tenant_id, item_id, tax_id) select tenant_id, $3, tax_id from item_taxes where tenant_id = $1 and item_id = $2 and deleted_at is null`, [x.t, from.id, id]);
      await x.c.query(`select variants_move($1,$2,$3,$4)`, [x.t, part.lines, id, opt]);
      made.push(id);
    }
    const empty = !(await x.c.query(`select 1 from item_variants where tenant_id = $1 and item_id = $2 and deleted_at is null limit 1`, [x.t, from.id])).rowCount;
    if (empty) await x.c.query(`update items set deleted_at = now() where tenant_id = $1 and id = $2`, [x.t, from.id]);
    return {
      summary: "split",
      lines: [],
      item: made[0],
      undo: { moves: old.map((l) => ({ line: l.id, item: from.id, values: l.values })), made, revive: empty ? [from.id] : [] },
      fix: { made },
    };
  },
  async view(x, p, ran) {
    const made = (ran.fix as { made: string[] }).made;
    const out: string[] = [];
    let first: Tile | null = null;
    for (const id of made) {
      const q = (await product(x.c, x.t, id))!;
      const ls = await lines(x.c, x.t, id);
      const h = await held(x, id);
      out.push(`${q.path ? `${q.path} › ` : ""}${q.name}: ${ls.length} lines, ${pieces(ls.reduce((a, l) => a + (h.get(l.id) ?? 0), 0))} pieces, ${q.options.join(", ")}`);
      if (!first) first = tileOf(q, ls, h);
    }
    return {
      tile: first,
      sheet: null,
      stock: [],
      warnings: [{ tone: "amber", text: "Each line moves with its barcode, stock and history, so printed labels still scan. Receipts keep the name they printed." }],
      danger: false,
      confirm: "Split",
      typeName: (p.lines as number) > BIG ? x.w.tenantName : null,
      lines: out,
    };
  },
};

// Lines, or every line of a product, into another product (Q33).
export const move: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const from = await productOf(x, input.product);
    const to = await productOf(x, input.into);
    if (from.id === to.id) throw new No("That is the same product.");
    const ls = await lines(x.c, x.t, from.id);
    const ids = Array.isArray(input.lines) && input.lines.length ? input.lines.map(str) : ls.map((l) => l.id);
    const moving = ls.filter((l) => ids.includes(l.id));
    if (!moving.length) throw new Ask(`Which lines of ${from.name}?`);
    const drop = str(input.drop) ? optionOf(from, input.drop) + 1 : null;
    const left = from.options.filter((_, j) => j !== (drop ?? 0) - 1);
    if (left.length !== to.options.length) throw new Ask(`${to.name} has ${to.options.join(", ") || "no options"}; ${from.name}'s lines have ${from.options.join(", ")}. Which option do they lose on the way?`);
    const map = left.map((o, j) => (o.toLowerCase() === to.options[j].toLowerCase() ? o : `${o} → ${to.options[j]}`));
    return {
      params: { item: from.id, into: to.id, lines: moving.map((l) => l.id), drop, all: moving.length === ls.length },
      readings: [
        { said: "from", is: from.name, note: `${moving.length} of its ${ls.length} lines`, isNew: false },
        { said: "into", is: to.name, note: map.join(", "), isNew: false },
      ],
      title: `Move ${moving.length} ${moving.length === 1 ? "line" : "lines"} from ${from.name} into ${to.name}`,
      touched: { [`items:${from.id}`]: from.updated_at, [`items:${to.id}`]: to.updated_at },
    };
  },
  async run(x, p) {
    const old = (await lines(x.c, x.t, p.item as string)).filter((l) => (p.lines as string[]).includes(l.id));
    await x.c.query(`select variants_move($1,$2,$3,$4)`, [x.t, p.lines, p.into, p.drop]);
    const empty = !(await x.c.query(`select 1 from item_variants where tenant_id = $1 and item_id = $2 and deleted_at is null limit 1`, [x.t, p.item])).rowCount;
    if (empty) await x.c.query(`update items set deleted_at = now() where tenant_id = $1 and id = $2`, [x.t, p.item]);
    return { summary: "moved", lines: [], item: p.into as string, undo: { moves: old.map((l) => ({ line: l.id, item: p.item, values: l.values })), made: [], revive: empty ? [p.item] : [] } };
  },
  async view(x, p) {
    const q = (await product(x.c, x.t, p.into as string))!;
    const ls = await lines(x.c, x.t, q.id);
    const h = await held(x, q.id);
    return { tile: tileOf(q, ls, h), sheet: null, stock: [], warnings: [{ tone: "amber", text: "The lines keep their barcodes, stock and history." }], danger: false, confirm: "Move", typeName: (p.lines as string[]).length > BIG ? x.w.tenantName : null };
  },
};

// ------------------------------------------------------ colours said later

// A product counted by size alone, its colours said later (the owner of Kids
// Corner, 2026-10-29: "quantity 10, then 3 is blue 7 is red"). The option is
// added first when the product hasn't it, every line taking the placeholder
// (Mixed); then each line said gives its pieces to a line of each value, made
// when missing, as a pair of stock moves (variant_split, 0149). A placeholder
// line left with nothing goes, unless asked to stay.
type Into = { value: string; qty: number; barcode: string | null; sku: string | null; price: number | null; isNew: boolean; before: number };
type Splitting = { from: string; name: string; values: string[]; held: number; barcode: string | null; into: Into[] };
export const splitColours: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const said = titled(str(input.option) || "Colour").slice(0, 30);
    const placeholder = titled(str(input.placeholder) || "Mixed").slice(0, 30);
    let i = p.options.findIndex((o) => o.toLowerCase() === said.toLowerCase());
    const adding = i < 0;
    if (adding) {
      if (!p.options.length) throw new No(`${p.name} has no lines to say the ${said.toLowerCase()} of. Make its lines first.`);
      if (p.options.length >= 3) throw new No(`${p.name} already has three options (${p.options.join(", ")}), the most a product has.`);
      i = p.options.length;
    }
    const options = adding ? [...p.options, said] : p.options;
    const ls = (await lines(x.c, x.t, p.id)).map((l) => (adding ? { ...l, values: [...l.values, placeholder] } : l));
    const all = await branches(x.c, x.t);
    const b = str(input.branch).toLowerCase();
    const store = (b ? all.find((y) => y.name.toLowerCase() === b) ?? all.find((y) => y.name.toLowerCase().includes(b)) : all.length === 1 ? all[0] : undefined);
    if (!store) throw new Ask(`At which branch are those pieces? ${all.map((y) => y.name).join(", ")}.`);
    const h = await stock(x.c, x.t, p.id, store.id);
    const known = adding ? [] : spellings(p.options, ls)[i];
    const asked = Array.isArray(input.lines) ? (input.lines as { where?: Record<string, unknown>; into?: Record<string, unknown>[] }[]) : [];
    const others = options.filter((_, j) => j !== i);
    if (!asked.length) throw new Ask(`Which ${others.join(" and ").toLowerCase()}, and how many of each ${said.toLowerCase()}?`);
    const splits: Splitting[] = [];
    for (const a of asked) {
      const where = a.where ?? {};
      const want = options.map((o, j) => {
        const k = Object.keys(where).find((w) => w.toLowerCase() === o.toLowerCase());
        return k ? str(where[k]) : j === i ? placeholder : null;
      });
      const hits = ls.filter((l) => want.every((v, j) => v === null || key(v) === key(l.values[j] ?? "")));
      const named = want.map((v, j) => (v === null ? null : `${options[j]} ${v}`)).filter(Boolean).join(", ");
      if (!hits.length) throw new Ask(`${p.name} has no line with ${named}. Its lines are ${ls.slice(0, 12).map((l) => l.values.join(" / ")).join(", ")}${ls.length > 12 ? "…" : ""}.`);
      if (hits.length > 1) throw new Ask(`${named} is ${hits.length} lines of ${p.name}: ${hits.slice(0, 8).map((l) => l.values.join(" / ")).join(", ")}. Which one?`);
      const from = hits[0];
      if (splits.some((s) => s.from === from.id)) throw new No(`${from.values.join(" / ")} is said twice. Say all its ${said.toLowerCase()}s once.`);
      const held = h.get(from.id) ?? 0;
      const into: Into[] = [];
      for (const part of a.into ?? []) {
        const v = str(part.value);
        if (!v) throw new Ask(`Which ${said.toLowerCase()}?`);
        const hit = read(v, known);
        const value = hit ? hit.value : titled(v).slice(0, 30);
        if (into.some((q) => q.value.toLowerCase() === value.toLowerCase())) throw new No(`${value} is said twice for ${from.values.join(" / ")}.`);
        if (value.toLowerCase() === (from.values[i] ?? "").toLowerCase()) throw new No(`The pieces are already ${value}. Say the ${said.toLowerCase()}s they are.`);
        const n = typeof part.qty === "number" ? part.qty : Number(str(part.qty));
        if (!Number.isFinite(n) || n < 0) throw new Ask(`How many ${value} in ${from.values.join(" / ")}?`);
        const values = from.values.map((y, j) => (j === i ? value : y));
        const there = ls.find((l) => l.values.every((y, j) => y.toLowerCase() === values[j].toLowerCase()));
        const barcode = str(part.barcode) || null;
        if (barcode) {
          const taken = (await x.c.query(
            `select v.name, i.name as product from item_variants v join items i on i.id = v.item_id and i.deleted_at is null
              where v.tenant_id = $1 and v.deleted_at is null and v.barcode = $2
             union all select null, name from items where tenant_id = $1 and deleted_at is null and barcode = $2 limit 1`,
            [x.t, barcode],
          )).rows[0];
          if (taken && !(there && there.barcode === barcode)) throw new No(`Barcode ${barcode} is already on ${taken.product}${taken.name ? `, ${taken.name}` : ""}.`);
        }
        const price = part.price === undefined || part.price === null || str(part.price) === "" ? null : cents(Number(part.price));
        into.push({ value, qty: thousandths(n), barcode: there ? null : barcode, sku: there ? null : str(part.sku) || null, price: there ? null : price, isNew: !hit && !adding, before: there ? h.get(there.id) ?? 0 : 0 });
      }
      if (!into.length) throw new Ask(`How many of each ${said.toLowerCase()} in ${from.values.join(" / ")}?`);
      const total = into.reduce((s, q) => s + q.qty, 0);
      if (total > held) throw new No(`${p.name} ${from.values.join(" / ")} holds ${pieces(held)} at ${store.name}; the ${said.toLowerCase()}s said add up to ${pieces(total)}. Count again, or say fewer.`);
      splits.push({ from: from.id, name: from.values.join(" / "), values: from.values, held, barcode: from.barcode, into });
    }
    const readings: Reading[] = [{ said: "product", is: p.name, note: adding ? `gets the option ${said}: its lines are ${placeholder} until said` : `${said}: ${known.length} values`, isNew: false }];
    for (const s of splits) {
      const left = s.held - s.into.reduce((a, q) => a + q.qty, 0);
      readings.push({ said: s.name, is: s.into.map((q) => `${q.value} ${pieces(q.qty)}`).join(", "), note: left ? `${pieces(left)} ${left === 1000 ? "stays" : "stay"} in ${s.name}` : null, isNew: s.into.some((q) => q.isNew) });
    }
    const one = splits.length === 1 ? splits[0] : null;
    const bare = (s: Splitting) => s.values.filter((_, j) => j !== i).join(" / ");
    return {
      params: { item: p.id, add: adding ? { name: said, value: placeholder } : null, option: i + 1, store: store.id, branch: store.name, splits, keep: input.keep_mixed === true, placeholder, lines: ls.length },
      readings,
      title: one ? `${p.name} ${bare(one)}: ${one.into.map((q) => `${pieces(q.qty)} ${q.value}`).join(", ")}` : `${p.name}: ${splits.map(bare).join(", ")} said by ${said.toLowerCase()}`,
      touched: { [`items:${p.id}`]: p.updated_at, ...Object.fromEntries(splits.map((s) => [`item_variants:${s.from}`, ls.find((l) => l.id === s.from)!.updated_at])) },
    };
  },
  async run(x, p) {
    const add = p.add as { name: string; value: string } | null;
    if (add) await x.c.query(`select variant_option_add($1,$2,$3,$4)`, [x.t, p.item, add.name, add.value]);
    const moves: { store: string; item: string; from: string; to: string; qty: number; created: boolean }[] = [];
    const dropped: string[] = [];
    for (const s of p.splits as Splitting[]) {
      const parts = s.into.map((q) => ({ value: q.value, qty: q.qty, barcode: q.barcode, sku: q.sku, price: q.price }));
      const r = (await x.c.query(`select variant_split($1,$2,$3,$4::jsonb,$5,$6,$7) as r`, [x.t, s.from, p.option, JSON.stringify(parts), p.store, x.w.employeeId, !p.keep])).rows[0].r as {
        lines: { line: string; created: boolean; qty: number }[]; dropped: boolean;
      };
      for (const l of r.lines) moves.push({ store: p.store as string, item: p.item as string, from: s.from, to: l.line, qty: l.qty, created: l.created });
      if (r.dropped) dropped.push(s.from);
    }
    const first = (p.splits as Splitting[])[0];
    return {
      summary: "split by " + String(add?.name ?? "option").toLowerCase(),
      lines: [],
      item: p.item as string,
      picked: first.values.map((v, j) => (j === (p.option as number) - 1 ? first.into[0].value : v)),
      undo: { colours: { item: p.item, option: p.option, added: Boolean(add), moves, dropped } },
    };
  },
  async view(x, p, ran) {
    const prod = (await product(x.c, x.t, p.item as string))!;
    const ls = await lines(x.c, x.t, prod.id);
    const h = await stock(x.c, x.t, prod.id, p.store as string);
    const i = (p.option as number) - 1;
    const splits = p.splits as Splitting[];
    const warnings: Warning[] = [];
    const add = p.add as { name: string; value: string } | null;
    const waiting = ls.filter((l) => (l.values[i] ?? "").toLowerCase() === String(p.placeholder).toLowerCase()).length;
    if (add) warnings.push({ tone: "amber", text: `${prod.name} gets the option ${add.name}. The tablet asks ${prod.options.join(", then ")}. Its lines not said yet are ${add.value} (${waiting} now), until their ${add.name.toLowerCase()}s are said.` });
    const stockMoves: StockMove[] = [];
    const out: string[] = [];
    for (const s of splits) {
      const moved = s.into.reduce((a, q) => a + q.qty, 0);
      const left = s.held - moved;
      out.push(`${s.name} → ${s.into.map((q) => `${s.values.map((v, j) => (j === i ? q.value : v)).join(" / ")} ${pieces(q.qty)}`).join(", ")}`);
      stockMoves.push({ branch: String(p.branch), line: s.name, before: pieces(s.held), after: left ? pieces(left) : p.keep ? "0" : "0, and the line goes" });
      for (const q of s.into) stockMoves.push({ branch: String(p.branch), line: s.values.map((v, j) => (j === i ? q.value : v)).join(" / "), before: pieces(q.before), after: pieces(q.before + q.qty) });
      if (left) warnings.push({ tone: "amber", text: `${pieces(left)} ${left === 1000 ? "stays" : "stay"} in ${s.name}: the ${(add?.name ?? prod.options[i]).toLowerCase()}s said add up to ${pieces(moved)} of its ${pieces(s.held)}.` });
      else if (!p.keep && s.barcode) warnings.push({ tone: "amber", text: `${s.name} goes once empty, and its barcode ${s.barcode} stops scanning.` });
      if (s.into.some((q) => q.qty > TYPO)) warnings.push({ tone: "amber", text: `More than ${pieces(TYPO)} pieces of one line. Check it isn't a typo.` });
    }
    const fresh = splits.flatMap((s) => s.into.filter((q) => q.isNew).map((q) => q.value));
    if (fresh.length) warnings.push({ tone: "amber", text: `New ${prod.options[i].toLowerCase()}: ${[...new Set(fresh)].join(", ")}. Check none is a typo of one the shop has.` });
    return {
      tile: tileOf(prod, ls, h),
      sheet: sheetOf(prod, ls, h, ran.picked ?? [], new Set(fresh.map((v) => `${i}:${v}`))),
      stock: stockMoves,
      warnings,
      danger: false,
      confirm: "Split",
      typeName: null,
      lines: out,
    };
  },
};

// ----------------------------------------------------- tidy the stock (plan)

export const STEPS: Record<string, ReKind> = {};

// "Tidy the stock" (Q46 to Q50): one plan, a list of steps of the other
// changes, run in order in one transaction, each step worked out on what the
// steps before it made. EasyPay checks the whole (Q48): every line still in
// one product, the pieces at each branch the same, every barcode kept but
// those the card names.
export const plan: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const steps = Array.isArray(input.steps) ? (input.steps as { tool: string; args: Params }[]) : [];
    if (!steps.length) throw new Ask("What should the plan do? Give its steps.");
    const unknown = steps.find((s) => !STEPS[s.tool]);
    if (unknown) throw new No(`A plan's steps are ${Object.keys(STEPS).join(", ")}; not ${unknown.tool}.`);
    // each step planned on what the ones before it made; all undone after
    await x.c.query("savepoint plan_steps");
    const done: { tool: string; params: Params; title: string; readings: Reading[] }[] = [];
    try {
      for (const s of steps) {
        const k = STEPS[s.tool];
        const pl = await k.plan(x, s.args ?? {});
        const ran = await k.run(x, pl.params);
        done.push({ tool: s.tool, params: { ...pl.params, ...(ran.fix ?? {}) }, title: pl.title, readings: pl.readings });
      }
    } finally {
      await x.c.query("rollback to savepoint plan_steps");
    }
    return { params: { steps: done }, readings: done.map((d) => ({ said: d.tool.replace("_", " "), is: d.title, note: null, isNew: false })), title: "Tidy the stock: the plan", touched: {} };
  },
  async run(x, p) {
    const before = await census(x);
    const undo: unknown[] = [];
    for (const s of p.steps as { tool: string; params: Params }[]) {
      const ran = await STEPS[s.tool].run(x, s.params);
      if (ran.undo) undo.push(ran.undo);
    }
    const after = await census(x);
    const lost = [...before.barcodes].filter((b) => !after.barcodes.has(b));
    const merged = new Set((p.steps as { tool: string; params: Params }[]).flatMap((s) => ((s.params.merges as { barcode: string | null }[] | undefined) ?? []).map((m) => m.barcode)).filter(Boolean));
    for (const [b, q] of before.pieces) if ((after.pieces.get(b) ?? 0) !== q) throw new No("The plan would change how many pieces a branch holds. Nothing was changed.");
    if (lost.some((b) => !merged.has(b))) throw new No("The plan would lose a barcode that isn't in a merge. Nothing was changed.");
    return { summary: "plan", lines: [], undo: undo.length ? { steps: undo } : undefined, fix: { census: { lines: [before.lines, after.lines], pieces: [...after.pieces.values()].reduce((a, q) => a + q, 0), lost: lost.length } } };
  },
  async view(x, p, ran) {
    const c = (ran.fix as { census: { lines: [number, number]; pieces: number; lost: number } }).census;
    const tree = (
      await x.c.query(
        `select coalesce(pc.name || ' › ', '') || coalesce(k.name, 'No category') as path, i.name, i.option_names,
                (select count(*)::int from item_variants v where v.item_id = i.id and v.deleted_at is null) as n,
                (select coalesce(sum(l.qty), 0)::float8 from stock_levels l where l.item_id = i.id and l.deleted_at is null) as q
           from items i left join categories k on k.id = i.category_id left join categories pc on pc.id = k.parent_id
          where i.tenant_id = $1 and i.deleted_at is null order by 1, 2 limit 200`,
        [x.t],
      )
    ).rows.map((r) => `${r.path} › ${r.name}: ${r.n} lines, ${pieces(r.q)} pieces${r.option_names?.length ? ` (${r.option_names.join(", ")})` : ""}`);
    const steps = (p.steps as { title: string }[]).map((s) => s.title);
    return {
      tile: null,
      sheet: null,
      stock: [],
      warnings: [
        { tone: "amber", text: `All accounted for: ${c.lines[0]} lines before, ${c.lines[1]} after${c.lines[0] !== c.lines[1] ? " (merged)" : ""}; ${pieces(c.pieces)} pieces before and after; ${c.lost ? `${c.lost} barcode lost in merges` : "every barcode kept"}.` },
      ],
      danger: false,
      confirm: "Confirm the plan",
      typeName: x.w.tenantName,
      lines: [...steps.map((s, n) => `${n + 1}. ${s}`), "After:", ...tree],
    };
  },
};

async function census(x: C) {
  const lines = (await x.c.query(`select count(*)::int as n from item_variants where tenant_id = $1 and deleted_at is null`, [x.t])).rows[0].n as number;
  const pieces = new Map(
    (await x.c.query(`select l.store_id::text as s, sum(l.qty)::float8 as q from stock_levels l join items i on i.id = l.item_id and i.deleted_at is null
        left join item_variants v on v.id = l.variant_id where l.tenant_id = $1 and l.deleted_at is null and (l.variant_id is null or v.deleted_at is null) group by 1`, [x.t])).rows.map((r) => [r.s as string, Number(r.q)]),
  );
  const barcodes = new Set(
    (await x.c.query(`select barcode from item_variants where tenant_id = $1 and deleted_at is null and barcode is not null`, [x.t])).rows.map((r) => r.barcode as string),
  );
  return { lines, pieces, barcodes };
}

// ------------------------------------------------------------------ import

// Rows Claude read from a file the owner gave it (Q52 to Q55), in the
// import's own columns, through catalog_import. A product's values take the
// spellings it already has (Q5). Lines that already hold stock have their
// file quantity added (received) or set (count), as the owner says once.
export const importRows: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const rows = Array.isArray(input.rows) ? (input.rows as Params[]) : [];
    if (!rows.length) throw new Ask("Which rows? Read the file and send its rows.");
    if (rows.length > 3000) throw new No("A file of more than 3000 rows goes in through the back office's import.");
    const store = (await branches(x.c, x.t))[0];
    // the import's rows: money in cents, quantities in thousandths, a product's spellings kept
    const known = new Map<string, { p: Product; spelled: ReturnType<typeof spellings> }>();
    const rules: string[] = [];
    const out = [] as Params[];
    for (const [n, r] of rows.entries()) {
      const name = str(r.name);
      const row: Params = { n: Number(r.n ?? n + 2), name, category: str(r.category) || undefined, sub_category: str(r.sub_category) || undefined, brand: str(r.brand) || undefined, sku: str(r.sku) || undefined, barcode: str(r.barcode) || undefined };
      if (typeof r.price === "number") row.price = cents(r.price);
      if (typeof r.cost === "number") row.cost = cents(r.cost);
      if (typeof r.stock === "number") row.stock = thousandths(r.stock);
      const opts = (r.options ?? {}) as Record<string, string>;
      const pairs = Object.entries(opts).slice(0, 4);
      if (pairs.length > 3) row.bad = "bad-options";
      if (!known.has(name.toLowerCase())) {
        const found = (await x.c.query(`select id from items where tenant_id = $1 and deleted_at is null and lower(name) = lower($2) limit 1`, [x.t, name])).rows[0];
        if (found) {
          const p = (await product(x.c, x.t, found.id))!;
          known.set(name.toLowerCase(), { p, spelled: spellings(p.options, await lines(x.c, x.t, p.id)) });
        }
      }
      const k = known.get(name.toLowerCase());
      pairs.slice(0, 3).forEach(([o, v], j) => {
        let value = titled(str(v));
        if (k) {
          const at = k.p.options.findIndex((po) => po.toLowerCase() === o.toLowerCase());
          const hit = at >= 0 ? read(str(v), k.spelled[at]) : null;
          if (hit && hit.value !== str(v)) rules.push(`${str(v)} → ${hit.value}`);
          if (hit) value = hit.value;
        }
        row[`o${j + 1}`] = titled(o);
        row[`v${j + 1}`] = value;
      });
      out.push(row);
    }
    const dry = (await x.c.query(`select catalog_import($1,$2,$3,$4::jsonb,true) as r`, [x.t, store.id, x.w.employeeId, JSON.stringify(out)])).rows[0].r;
    // lines that already hold stock: their file quantity is a stock change, as the owner says (Q55)
    const holding = [] as { item: string; line: string | null; qty: number; now: number; name: string }[];
    for (const r of out) {
      if (!r.stock) continue;
      const k = known.get(String(r.name).toLowerCase());
      if (!k) continue;
      const vals = [r.v1, r.v2, r.v3].filter(Boolean) as string[];
      const l = vals.length ? (await lines(x.c, x.t, k.p.id)).find((y) => y.values.join("\u0001").toLowerCase() === vals.join("\u0001").toLowerCase()) : null;
      const now = (await stock(x.c, x.t, k.p.id, store.id)).get(l ? l.id : "") ?? 0;
      const moved = (await x.c.query(`select 1 from stock_movements where tenant_id = $1 and item_id = $2 and variant_id is not distinct from $3 limit 1`, [x.t, k.p.id, l?.id ?? null])).rowCount;
      if (now !== 0 || moved) holding.push({ item: k.p.id, line: l?.id ?? null, qty: r.stock as number, now, name: l ? `${k.p.name} ${l.name}` : k.p.name });
    }
    const mode = str(input.existing);
    if (holding.length && mode !== "add" && mode !== "set") {
      throw new Ask(`${holding.length} rows are lines that already hold stock (for example ${holding[0].name}, ${pieces(holding[0].now)}). Add the file's quantities to theirs (received), or do the file's counts replace them?`);
    }
    const readings: Reading[] = [
      { said: "file", is: `${rows.length} rows`, note: `${dry.good} go in, ${dry.problems.length} with a problem`, isNew: false },
      { said: "products", is: `${dry.new_products} new, ${dry.products - dry.new_products} updated`, note: `${dry.new_lines} new lines`, isNew: dry.new_products > 0 },
      ...(dry.new_categories.length ? [{ said: "categories", is: dry.new_categories.join(", "), note: "new", isNew: true }] : []),
      ...[...new Set(rules)].slice(0, 12).map((r) => ({ said: "spelling", is: r, note: "as the product already writes it", isNew: false })),
      ...(holding.length ? [{ said: "already in stock", is: `${holding.length} lines`, note: mode === "add" ? "the file's quantities are added (received)" : "the file's counts replace theirs", isNew: false }] : []),
    ];
    return {
      params: { rows: out, store: store.id, holding, mode, dry: { good: dry.good, problems: dry.problems, new_products: dry.new_products, new_lines: dry.new_lines } },
      readings,
      title: `Import ${rows.length} rows`,
      touched: {},
    };
  },
  async run(x, p) {
    const ids = async (sql: string) => new Set((await x.c.query(sql, [x.t])).rows.map((y) => y.id as string));
    const had = {
      items: await ids(`select id from items where tenant_id = $1 and deleted_at is null`),
      lines: await ids(`select id from item_variants where tenant_id = $1 and deleted_at is null`),
      categories: await ids(`select id from categories where tenant_id = $1 and deleted_at is null`),
    };
    const r = (await x.c.query(`select catalog_import($1,$2,$3,$4::jsonb,false) as r`, [x.t, p.store, x.w.employeeId, JSON.stringify(p.rows)])).rows[0].r;
    // the lines it added with no SKU get one made from the name and the values, as the back office's import does (0150)
    const skus = await skusForNewLines(x.c, x.t);
    const fresh = async (sql: string, before: Set<string>) => [...(await ids(sql))].filter((id) => !before.has(id));
    const undo = {
      hide: {
        items: await fresh(`select id from items where tenant_id = $1 and deleted_at is null`, had.items),
        lines: await fresh(`select id from item_variants where tenant_id = $1 and deleted_at is null`, had.lines),
        categories: await fresh(`select id from categories where tenant_id = $1 and deleted_at is null`, had.categories),
      },
      reverse: [] as { store: string; item: string; line: string | null; qty: number }[],
    };
    for (const h of p.holding as { item: string; line: string | null; qty: number; now: number }[]) {
      const move = p.mode === "set" ? h.qty - h.now : h.qty;
      if (move !== 0) {
        await x.c.query(`select stock_move($1,$2,$3,$4,$5,$6,null,null,null,$7,'Imported through Claude')`, [x.t, p.store, h.item, h.line, move, p.mode === "set" ? "count" : "receive", x.w.employeeId]);
        undo.reverse.push({ store: p.store as string, item: h.item, line: h.line, qty: move });
      }
    }
    return { summary: `imported ${r.good} rows`, lines: [`${r.new_products} new products, ${r.new_lines} new lines, ${r.stock_set} opening stocks${skus ? `, ${skus} SKUs made` : ""}`], undo };
  },
  async view(_x, p, ran) {
    const dry = p.dry as { problems: { n: number; name: string; why: string }[] };
    const WHY: Record<string, string> = {
      "duplicate-line": "the same line twice", "product-has-problems": "another row of the product has a problem", "options-differ": "its options aren't the product's",
      "too-many-variants": "over 1000 lines", "barcode-taken": "its barcode is another line's", "sku-taken": "its SKU is another line's", "price-missing": "no price",
      "name-missing": "no name", "bad-options": "more than three options", "sub-without-category": "a sub category with no category",
    };
    return {
      tile: null,
      sheet: null,
      stock: [],
      warnings: [
        ...((p.rows as { stock?: number; name: string }[]).filter((r) => (r.stock ?? 0) > TYPO).length
          ? [{ tone: "amber" as const, text: `${(p.rows as { stock?: number }[]).filter((r) => (r.stock ?? 0) > TYPO).length} rows have more than 100 pieces of one line. Check they aren't typos.` }]
          : []),
        ...(dry.problems.length ? [{ tone: "amber" as const, text: `${dry.problems.length} rows stay out: ${dry.problems.slice(0, 6).map((q) => `row ${q.n} ${q.name} (${WHY[q.why] ?? q.why})`).join("; ")}${dry.problems.length > 6 ? "…" : ""}` }] : []),
      ],
      danger: false,
      confirm: "Import",
      typeName: null,
      lines: ran.lines,
    };
  },
};

Object.assign(STEPS, { tidy, rename_option: renameOption, split, move });
export const RESHAPE: Record<string, ReKind> = { tidy, rename_option: renameOption, split, move, plan, import: importRows, split_colours: splitColours };
