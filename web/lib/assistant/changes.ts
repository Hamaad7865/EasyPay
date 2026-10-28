import type { PoolClient } from "pg";
import { withTenant } from "@/lib/db";
import { saveVariantLines } from "@/lib/saves";
import { random, sha256, type Who } from "./oauth";
import { branches, lines, pieces, product, rs, sheetOf, spellings, stock, tileOf, type Branch, type Line, type Product } from "./catalog";
import { read, thousandths, cents, titled } from "./words";
import type { DoneCard, PreviewCard, Reading, Sheet, StockMove, Tile, Warning } from "./types";

// A change through Claude (spec, The preview is the real change, undone):
//   1. plan: what the AI sent, read against the shop's own rows into exact
//      parameters ("I read this as"); a question back when something is not
//      clear (Ask), a refusal when it cannot be done (No);
//   2. run inside a savepoint, read what it made, roll back: the card;
//   3. the proposal is kept (15 minutes) with a one-time code only the card
//      holds;
//   4. Confirm runs the STORED parameters, checks nothing it touched moved,
//      and logs it.
// Every value the database fills in on the way (a barcode made by the shop's
// setting) is read back at the preview and stored, so Confirm makes the same.

export class Ask extends Error {}
export class No extends Error {}

type Params = Record<string, unknown>;
type Planned = { params: Params; readings: Reading[]; title: string; touched: Record<string, string> };
type Ran = { summary: string; lines: string[]; fix?: Params; undo?: unknown; item?: string; picked?: string[]; fresh?: Set<string> };
type Viewed = { tile: Tile | null; sheet: Sheet | null; stock: StockMove[]; warnings: Warning[]; danger: boolean; confirm: string; typeName: string | null; lines?: string[] };
type C = { c: PoolClient; w: Who; t: string };

export type Kind = {
  perm: string;
  plan(x: C, input: Params): Promise<Planned>;
  run(x: C, p: Params): Promise<Ran>;
  view(x: C, p: Params, ran: Ran, before: Planned): Promise<Viewed>;
};

const may = async (x: C, perm: string) => Boolean((await x.c.query(`select has_perm($1, $2) as ok`, [x.w.employeeId, perm])).rows[0]?.ok);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ----------------------------------------------------------- the shared reads

export async function branchOf(x: C, said: unknown): Promise<Branch> {
  const all = await branches(x.c, x.t);
  if (all.length === 0) throw new No("This business has no branch to hold stock.");
  const s = str(said).toLowerCase();
  if (!s && all.length === 1) return all[0];
  const hit = all.find((b) => b.name.toLowerCase() === s) ?? all.find((b) => s && b.name.toLowerCase().includes(s));
  if (hit) return hit;
  throw new Ask(`Which branch? ${all.map((b) => b.name).join(", ")}.`);
}

export async function productOf(x: C, id: unknown): Promise<Product> {
  const s = str(id);
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new Ask("Which product? Find it first (the find tool gives each product's id).");
  const p = await product(x.c, x.t, s);
  if (!p) throw new No("That product is not there any more.");
  return p;
}

// The values said for each option, by the option's name or in order, read
// against the spellings the product already has (spec Q5).
function valuesOf(p: Product, ls: Line[], said: unknown): { values: string[]; readings: Reading[]; fresh: Set<string> } {
  const spelled = spellings(p.options, ls);
  const byName = (said && typeof said === "object" && !Array.isArray(said) ? (said as Record<string, unknown>) : null);
  const list = Array.isArray(said) ? said.map(str) : null;
  const readings: Reading[] = [];
  const fresh = new Set<string>();
  const values = p.options.map((o, i) => {
    const word = list ? list[i] ?? "" : str(byName && Object.entries(byName).find(([k]) => k.trim().toLowerCase() === o.toLowerCase())?.[1]);
    if (!word) throw new Ask(`What ${o.toLowerCase()} is it? ${p.name} has ${spelled[i].slice(0, 8).map((s) => s.value).join(", ")}${spelled[i].length > 8 ? "…" : ""}.`);
    const r = read(word, spelled[i]);
    if (r) {
      const also = r.also.length ? `; also ${r.also.map((a) => `${a.value} ${a.lines}`).join(", ")}` : "";
      readings.push({ said: `${o}: ${word}`, is: r.value, note: `${r.lines} ${r.lines === 1 ? "line" : "lines"}${also}`, isNew: false });
      return r.value;
    }
    const v = titled(word).slice(0, 30);
    readings.push({ said: `${o}: ${word}`, is: v, note: `no line of ${p.name} says it yet`, isNew: true });
    fresh.add(`${i}:${v}`);
    return v;
  });
  if (byName) {
    const unknown = Object.keys(byName).filter((k) => !p.options.some((o) => o.toLowerCase() === k.trim().toLowerCase()));
    if (unknown.length) throw new Ask(`${p.name}'s options are ${p.options.join(", ")}. Which one is ${unknown.join(" and ")}?`);
  }
  return { values, readings, fresh };
}

const sameValues = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v.toLowerCase() === b[i].toLowerCase());

// --------------------------------------------------------------------- kinds

const addLine: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    if (p.options.length === 0) throw new No(`${p.name} has no options, so it has no lines. Change its stock instead.`);
    const ls = await lines(x.c, x.t, p.id);
    const { values, readings } = valuesOf(p, ls, input.values);
    const there = ls.find((l) => sameValues(l.values, values));
    if (there) throw new No(`${p.name} already has ${there.name}. To add to its stock, change its stock instead.`);
    const branch = await branchOf(x, input.branch);
    const qty = num(input.qty) ?? 0;
    if (qty < 0) throw new No("A quantity can't be below zero.");
    // the price: said, the one every line has, or asked (spec Q7)
    let price = num(input.price);
    let priceNote = "said";
    if (price === null) {
      const prices = [...new Set(ls.map((l) => l.price))];
      if (prices.length <= 1) {
        price = (prices[0] ?? p.price) / 100;
        priceNote = prices.length ? "the price every line has" : "the product's price";
      } else {
        const near = ls.filter((l) => l.values.slice(1).some((v, j) => v === values[j + 1]));
        const hint = near.length ? ` The lines with the same ${p.options.slice(1).join(" or ").toLowerCase()} are ${[...new Set(near.map((l) => rs(l.price)))].join(" or ")}.` : "";
        throw new Ask(`What price? ${p.name}'s lines go from ${rs(Math.min(...prices))} to ${rs(Math.max(...prices))}.${hint}`);
      }
    }
    readings.unshift({ said: "product", is: p.name, note: p.path, isNew: false });
    readings.push({ said: "price", is: rs(cents(price)), note: priceNote, isNew: false });
    if (qty > 0) readings.push({ said: "quantity", is: `${pieces(thousandths(qty))} in stock`, note: `opening stock at ${branch.name}`, isNew: false });
    const cost = num(input.cost);
    return {
      params: { item: p.id, values, price: cents(price), cost: cost === null ? null : cents(cost), sku: str(input.sku) || null, barcode: str(input.barcode) || null, store: branch.id, qty: thousandths(qty) },
      readings,
      title: `New line: ${p.name}, ${values.join(" / ")}`,
      touched: { [`items:${p.id}`]: p.updated_at },
    };
  },
  async run(x, p) {
    const id = (
      await x.c.query(`select variant_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v`, [
        x.t, p.item, p.values, p.price, p.cost, p.sku, p.barcode, (p.qty as number) > 0 ? p.store : null, (p.qty as number) > 0 ? p.qty : null, x.w.employeeId,
      ])
    ).rows[0].v as string;
    if (!p.barcode) await x.c.query(`select barcodes_auto($1, $2)`, [x.t, p.item]);
    const made = (await x.c.query(`select name, barcode from item_variants where id = $1`, [id])).rows[0];
    return { summary: `${made.name} added`, lines: [`${made.name}${made.barcode ? `, barcode ${made.barcode}` : ""}`], fix: { barcode: made.barcode ?? null }, item: p.item as string, picked: p.values as string[] };
  },
  async view(x, p, ran, before) {
    const prod = (await product(x.c, x.t, p.item as string))!;
    const ls = await lines(x.c, x.t, prod.id);
    const held = await stock(x.c, x.t, prod.id, p.store as string);
    const store = (await branches(x.c, x.t)).find((b) => b.id === p.store)!;
    const fresh = new Set(before.readings.filter((r) => r.isNew).map((r) => `${prod.options.findIndex((o) => r.said.startsWith(o + ":"))}:${r.is}`));
    const warnings: Warning[] = [];
    if (fresh.size) warnings.push({ tone: "amber", text: `New spelling: ${before.readings.filter((r) => r.isNew).map((r) => r.is).join(", ")}. Check it isn't a typo of one the shop has.` });
    if (p.cost !== null && (p.price as number) < (p.cost as number)) warnings.push({ tone: "amber", text: "The price is below its cost." });
    return {
      tile: tileOf(prod, ls, held),
      sheet: sheetOf(prod, ls, held, p.values as string[], fresh),
      stock: (p.qty as number) > 0 ? [{ branch: store.name, line: (p.values as string[]).join(" / "), before: "0", after: pieces(p.qty as number) }] : [],
      warnings,
      danger: false,
      confirm: "Confirm",
      typeName: null,
      lines: ran.lines,
    };
  },
};

const REASONS: Record<string, { out: boolean; reason: string; label: string }> = {
  received: { out: false, reason: "receive", label: "received" },
  found: { out: false, reason: "found", label: "found" },
  damaged: { out: true, reason: "damaged", label: "damaged" },
  lost: { out: true, reason: "lost", label: "lost" },
};

const changeStock: Kind = {
  perm: "stock.adjust",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const ls = await lines(x.c, x.t, p.id);
    if (!p.counted) throw new No(`${p.name} doesn't count its stock. Turn on Count its stock for it first.`);
    let line: Line | null = null;
    let readings: Reading[] = [];
    if (ls.length) {
      const v = valuesOf(p, ls, input.values);
      readings = v.readings;
      line = ls.find((l) => sameValues(l.values, v.values)) ?? null;
      if (!line) throw new No(`${p.name} has no line ${v.values.join(" / ")}. Add it as a new line, with its opening stock.`);
    }
    const branch = await branchOf(x, input.branch);
    const mode = str(input.mode) === "set" ? "set" : "add";
    const qty = num(input.qty);
    if (qty === null || qty < 0) throw new Ask("How many?");
    const reason = mode === "set" ? "count" : str(input.reason).toLowerCase();
    if (mode === "add" && !REASONS[reason]) throw new Ask("Why does the stock change: received, found, damaged or lost?");
    const held = await stock(x.c, x.t, p.id, branch.id);
    const now = held.get(line ? line.id : "") ?? 0;
    const move = mode === "set" ? thousandths(qty) - now : REASONS[reason].out ? -thousandths(qty) : thousandths(qty);
    if (move === 0) throw new No(`${line ? line.name : p.name} already holds ${pieces(now)} at ${branch.name}.`);
    readings.unshift({ said: "product", is: p.name, note: p.path, isNew: false });
    readings.push({ said: mode === "set" ? "count" : reason, is: mode === "set" ? `there are ${qty}` : `${REASONS[reason].out ? "−" : "+"}${qty}`, note: branch.name, isNew: false });
    return {
      params: { item: p.id, line: line?.id ?? null, store: branch.id, move, reason, now },
      readings,
      title: `Stock: ${p.name}${line ? `, ${line.name}` : ""}`,
      touched: { [`levels:${p.id}:${line?.id ?? ""}:${branch.id}`]: String(now) },
    };
  },
  async run(x, p) {
    const move = p.move as number;
    if (p.reason === "damaged" || p.reason === "lost" || p.reason === "found") {
      await x.c.query(`select stock_adjust($1,$2,$3,$4,$5,$6,$7,$8)`, [x.t, p.store, p.item, p.line, Math.abs(move), p.reason, x.w.employeeId, "Through Claude"]);
    } else {
      await x.c.query(`select stock_move($1,$2,$3,$4,$5,$6,null,null,null,$7,$8)`, [x.t, p.store, p.item, p.line, move, p.reason, x.w.employeeId, "Through Claude"]);
    }
    return { summary: `stock ${move > 0 ? "+" : ""}${pieces(move)}`, lines: [], item: p.item as string };
  },
  async view(x, p) {
    const prod = (await product(x.c, x.t, p.item as string))!;
    const ls = await lines(x.c, x.t, prod.id);
    const held = await stock(x.c, x.t, prod.id, p.store as string);
    const store = (await branches(x.c, x.t)).find((b) => b.id === p.store)!;
    const line = ls.find((l) => l.id === p.line);
    const after = held.get((p.line as string | null) ?? "") ?? 0;
    const warnings: Warning[] = after < 0 ? [{ tone: "amber", text: `${line ? line.name : prod.name} goes below zero.` }] : [];
    return {
      tile: tileOf(prod, ls, held),
      sheet: line ? sheetOf(prod, ls, held, line.values) : null,
      stock: [{ branch: store.name, line: line ? line.name : prod.name, before: pieces(p.now as number), after: pieces(after) }],
      warnings,
      danger: false,
      confirm: "Confirm",
      typeName: null,
    };
  },
};

const editLines: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await productOf(x, input.product);
    const ls = await lines(x.c, x.t, p.id);
    const set = (input.set ?? {}) as Params;
    const ids = Array.isArray(input.lines) ? input.lines.map(str) : [];
    const chosen = ids.length ? ls.filter((l) => ids.includes(l.id)) : input.all === true ? ls : [];
    if (chosen.length === 0) throw new Ask(`Which lines of ${p.name}? Give their ids, or say all.`);
    const readings: Reading[] = [{ said: "product", is: p.name, note: `${chosen.length} of its ${ls.length} lines`, isNew: false }];
    const mayCost = await may(x, "costs.view");
    const price = num(set.price), cost = num(set.cost);
    if (cost !== null && !mayCost) throw new No("Your role doesn't include seeing cost, so it can't set one.");
    let values: string[] | null = null;
    if (set.values !== undefined) {
      if (chosen.length !== 1) throw new No("A line's values are changed one line at a time.");
      const v = valuesOf(p, ls.filter((l) => l.id !== chosen[0].id), set.values);
      values = v.values;
      readings.push(...v.readings);
      const clash = ls.find((l) => l.id !== chosen[0].id && sameValues(l.values, values!));
      if (clash) throw new No(`${p.name} already has ${clash.name}. Two lines can't be the same; merging comes with the tidy.`);
    }
    if (price !== null) readings.push({ said: "price", is: rs(cents(price)), note: "said", isNew: false });
    if (cost !== null) readings.push({ said: "cost", is: rs(cents(cost)), note: "said", isNew: false });
    for (const k of ["sku", "barcode"]) if (set[k] !== undefined) readings.push({ said: k.toUpperCase() === "SKU" ? "SKU" : "barcode", is: str(set[k]) || "none", note: "said", isNew: false });
    return {
      params: {
        item: p.id,
        lines: chosen.map((l) => ({
          id: l.id,
          price: price === null ? l.price : cents(price),
          cost: cost === null ? l.cost : cents(cost),
          sku: set.sku === undefined ? l.sku : str(set.sku) || null,
          barcode: set.barcode === undefined ? l.barcode : str(set.barcode) || null,
        })),
        values,
        mayCost,
      },
      readings,
      title: `Edit ${chosen.length === 1 ? chosen[0].name : `${chosen.length} lines`} of ${p.name}`,
      touched: Object.fromEntries(chosen.map((l) => [`item_variants:${l.id}`, l.updated_at])),
    };
  },
  async run(x, p) {
    const ls = p.lines as { id: string; price: number; cost: number | null; sku: string | null; barcode: string | null }[];
    await saveVariantLines(x.c, x.t, p.item as string, ls, p.mayCost as boolean);
    if (p.values) {
      await x.c.query(`update item_variants set option_values = $3, name = array_to_string($3::text[], ' / ') where tenant_id = $1 and id = $2`, [x.t, ls[0].id, p.values]);
    }
    return { summary: `${ls.length} ${ls.length === 1 ? "line" : "lines"} edited`, lines: [], item: p.item as string };
  },
  async view(x, p) {
    const prod = (await product(x.c, x.t, p.item as string))!;
    const ls = await lines(x.c, x.t, prod.id);
    const store = (await branches(x.c, x.t))[0];
    const held = store ? await stock(x.c, x.t, prod.id, store.id) : new Map();
    const one = (p.lines as { id: string }[]).length === 1 ? ls.find((l) => l.id === (p.lines as { id: string }[])[0].id) : null;
    const changed = (p.lines as { id: string; price: number; cost: number | null }[]).map((n) => {
      const l = ls.find((y) => y.id === n.id)!;
      return `${l.name}: ${rs(n.price)}${n.cost !== null ? `, cost ${rs(n.cost)}` : ""}${l.barcode ? `, ${l.barcode}` : ""}`;
    });
    const warnings: Warning[] = [];
    if ((p.lines as { price: number; cost: number | null }[]).some((n) => n.cost !== null && n.price < n.cost)) warnings.push({ tone: "amber", text: "A price is below its cost." });
    const sold = (await x.c.query(`select count(*)::int as n from ticket_lines where tenant_id = $1 and variant_id = any($2::uuid[])`, [x.t, (p.lines as { id: string }[]).map((l) => l.id)])).rows[0].n;
    if (sold > 0 && p.values) warnings.push({ tone: "amber", text: "This line has sold before. Its receipts keep the name they printed." });
    return { tile: tileOf(prod, ls, held), sheet: one ? sheetOf(prod, ls, held, one.values) : null, stock: [], warnings, danger: false, confirm: "Confirm", typeName: null, lines: changed };
  },
};

// A category, a sub category under one, a rename or a move (spec Q43).
const editCategory: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const verb = str(input.verb) || "new";
    const name = titled(str(input.name)).slice(0, 40);
    const all = (await x.c.query(`select id, name, parent_id, updated_at::text from categories where tenant_id = $1 and deleted_at is null`, [x.t])).rows as { id: string; name: string; parent_id: string | null; updated_at: string }[];
    const named = (s: string) => all.find((k) => k.name.toLowerCase() === s.toLowerCase() && !k.parent_id) ?? all.find((k) => k.name.toLowerCase() === s.toLowerCase());
    const under = str(input.under) ? named(str(input.under)) : null;
    if (str(input.under) && !under) throw new Ask(`There's no category called ${str(input.under)}. Make it first, or say which one.`);
    if (under && under.parent_id) throw new No(`${under.name} is itself a sub category, and a sub category can't hold others.`);
    if (verb === "new") {
      if (!name) throw new Ask("What is the category called?");
      if (all.some((k) => k.name.toLowerCase() === name.toLowerCase() && (k.parent_id ?? null) === (under?.id ?? null))) throw new No(`${under ? `${under.name} › ` : ""}${name} is already there.`);
      return { params: { verb, name, under: under?.id ?? null }, readings: [{ said: "category", is: under ? `${under.name} › ${name}` : name, note: "new", isNew: true }], title: `New ${under ? "sub " : ""}category: ${under ? `${under.name} › ` : ""}${name}`, touched: {} };
    }
    const it = all.find((k) => k.id === str(input.category)) ?? named(str(input.category));
    if (!it) throw new Ask("Which category?");
    if (verb === "rename") {
      if (!name) throw new Ask("What should it be called?");
      return { params: { verb, id: it.id, name }, readings: [{ said: it.name, is: name, note: "renamed", isNew: false }], title: `Rename ${it.name} to ${name}`, touched: { [`categories:${it.id}`]: it.updated_at } };
    }
    if (verb === "move") {
      return { params: { verb, id: it.id, under: under?.id ?? null }, readings: [{ said: it.name, is: under ? `${under.name} › ${it.name}` : `${it.name}, on its own`, note: "moved", isNew: false }], title: `Move ${it.name}`, touched: { [`categories:${it.id}`]: it.updated_at } };
    }
    throw new No("A category is made, renamed or moved here. Deleting one is the delete tool's.");
  },
  async run(x, p) {
    const fix = (e: unknown): never => {
      const m = e instanceof Error ? e.message : "";
      throw new No(m === "too-deep" ? "That would be two levels deep: a sub category can't hold others." : m === "bad-parent" ? "That category can't hold sub categories." : m);
    };
    if (p.verb === "new") {
      await x.c
        .query(`insert into categories (tenant_id, name, parent_id, sort_order) values ($1,$2,$3,(select coalesce(max(sort_order), -1) + 1 from categories where tenant_id = $1 and parent_id is not distinct from $3))`, [x.t, p.name, p.under])
        .catch(fix);
      return { summary: `${p.name} made`, lines: [] };
    }
    if (p.verb === "rename") await x.c.query(`update categories set name = $3 where tenant_id = $1 and id = $2`, [x.t, p.id, p.name]);
    else await x.c.query(`update categories set parent_id = $3, follows_parent = true where tenant_id = $1 and id = $2`, [x.t, p.id, p.under]).catch(fix);
    return { summary: "category saved", lines: [] };
  },
  async view(x) {
    const rows = (await x.c.query(
      `select case when p.id is null then k.name else p.name || ' › ' || k.name end as path from categories k left join categories p on p.id = k.parent_id
        where k.tenant_id = $1 and k.deleted_at is null order by coalesce(p.sort_order, k.sort_order), coalesce(p.name, k.name), k.parent_id nulls first, k.name`, [x.t])).rows;
    return { tile: null, sheet: null, stock: [], warnings: [], danger: false, confirm: "Confirm", typeName: null, lines: rows.map((r) => r.path) };
  },
};

// A product made through Claude: with its options, or with none and its
// opening stock (the owner's first example: "import 6 shirt with category
// shirt, opening stock 6"). Or one edited: name, category, brand, price.
const editProduct: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const verb = str(input.verb) || "edit";
    const cats = (await x.c.query(`select k.id, k.name, p.name as parent from categories k left join categories p on p.id = k.parent_id where k.tenant_id = $1 and k.deleted_at is null`, [x.t])).rows as { id: string; name: string; parent: string | null }[];
    const pathOf = (s: string) => {
      const [a, b] = s.split(/\s*[›>]\s*/);
      const hit = b ? cats.find((k) => k.parent?.toLowerCase() === a.toLowerCase() && k.name.toLowerCase() === b.toLowerCase()) : cats.find((k) => !k.parent && k.name.toLowerCase() === a.toLowerCase()) ?? cats.find((k) => k.name.toLowerCase() === a.toLowerCase());
      if (!hit) throw new Ask(`There's no category ${s}. Make it first (with its sub category, if it has one).`);
      return hit;
    };
    const cat = str(input.category) ? pathOf(str(input.category)) : null;
    const price = num(input.price), cost = num(input.cost);
    if (verb === "new") {
      const name = str(input.name).slice(0, 120);
      if (!name) throw new Ask("What is the product called?");
      if ((await x.c.query(`select 1 from items where tenant_id = $1 and deleted_at is null and lower(name) = lower($2)`, [x.t, name])).rowCount) throw new No(`${name} is already there.`);
      if (price === null) throw new Ask(`What does ${name} sell for?`);
      const qty = num(input.qty) ?? 0;
      const options = Array.isArray(input.options) ? input.options.map((o) => titled(str(o))).filter(Boolean).slice(0, 3) : [];
      const branch = qty > 0 ? await branchOf(x, input.branch) : null;
      const readings: Reading[] = [
        { said: "product", is: name, note: "new", isNew: true },
        { said: "category", is: cat ? (cat.parent ? `${cat.parent} › ${cat.name}` : cat.name) : "none", note: null, isNew: false },
        { said: "price", is: rs(cents(price)), note: "said", isNew: false },
      ];
      if (options.length) readings.push({ said: "options", is: options.join(", "), note: "its lines are added next", isNew: false });
      if (qty > 0) readings.push({ said: "opening stock", is: `${qty}`, note: branch!.name, isNew: false });
      if (options.length && qty > 0) throw new No("A product with options holds its stock on its lines: make it, then add each line with its stock.");
      return { params: { verb, name, category: cat?.id ?? null, brand: str(input.brand) || null, price: cents(price), cost: cost === null ? null : cents(cost), options, qty: thousandths(qty), store: branch?.id ?? null }, readings, title: `New product: ${name}`, touched: {} };
    }
    const p = await productOf(x, input.product);
    const name = str(input.name);
    const readings: Reading[] = [{ said: "product", is: p.name, note: p.path, isNew: false }];
    if (name) readings.push({ said: "name", is: name, note: "renamed", isNew: false });
    if (cat) readings.push({ said: "category", is: cat.parent ? `${cat.parent} › ${cat.name}` : cat.name, note: "moved", isNew: false });
    if (price !== null) readings.push({ said: "price", is: rs(cents(price)), note: "said", isNew: false });
    return { params: { verb, item: p.id, name: name || null, category: cat?.id ?? null, brand: input.brand === undefined ? undefined : str(input.brand) || null, price: price === null ? null : cents(price) }, readings, title: `Edit ${p.name}`, touched: { [`items:${p.id}`]: p.updated_at } };
  },
  async run(x, p) {
    if (p.verb === "new") {
      const id = (await x.c.query(
        `insert into items (tenant_id, name, category_id, brand, price, cost, option_names, track_stock, is_available) values ($1,$2,$3,$4,$5,$6,$7,true,true) returning id`,
        [x.t, p.name, p.category, p.brand, p.price, p.cost, p.options])).rows[0].id as string;
      await x.c.query(`insert into item_taxes (tenant_id, item_id, tax_id) select $1, $2, id from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, rate_bp desc, name limit 1`, [x.t, id]);
      if ((p.qty as number) > 0) await x.c.query(`select stock_move($1,$2,$3,null,$4,'opening',$5,null,null,$6,'Through Claude')`, [x.t, p.store, id, p.qty, p.cost, x.w.employeeId]);
      return { summary: `${p.name} made`, lines: [], item: id };
    }
    await x.c.query(
      `update items set name = coalesce($3, name), category_id = coalesce($4, category_id), price = coalesce($5, price),
              brand = case when $6::boolean then $7 else brand end
        where tenant_id = $1 and id = $2`,
      [x.t, p.item, p.name, p.category, p.price, p.brand !== undefined, p.brand ?? null],
    );
    return { summary: "product saved", lines: [], item: p.item as string };
  },
  async view(x, p, ran) {
    const prod = (await product(x.c, x.t, ran.item!))!;
    const ls = await lines(x.c, x.t, prod.id);
    const store = p.store ? (p.store as string) : (await branches(x.c, x.t))[0]?.id;
    const held = store ? await stock(x.c, x.t, prod.id, store) : new Map();
    const name = (await branches(x.c, x.t)).find((b) => b.id === store)?.name ?? "";
    return {
      tile: tileOf(prod, ls, held),
      sheet: null,
      stock: (p.qty as number) > 0 ? [{ branch: name, line: prod.name, before: "0", after: pieces(p.qty as number) }] : [],
      warnings: p.cost !== null && p.price !== null && (p.price as number) < (p.cost as number) ? [{ tone: "amber", text: "The price is below its cost." }] : [],
      danger: false,
      confirm: "Confirm",
      typeName: null,
    };
  },
};

// Deleting lines, a product or a category (spec Q10, Q14). Its stock is
// written off first (internal use), so the books stay whole; Restore brings
// the rows and the stock back for 30 days.
const remove: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const what = str(input.what);
    const ids = (Array.isArray(input.ids) ? input.ids : [input.ids]).map(str).filter(Boolean);
    if (what === "category") {
      const k = (await x.c.query(`select id, name, updated_at::text, (select count(*)::int from items i where i.category_id = c.id and i.deleted_at is null) as items,
                (select count(*)::int from categories s where s.parent_id = c.id and s.deleted_at is null) as subs from categories c where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [x.t, ids])).rows[0];
      if (!k) throw new Ask("Which category?");
      if (k.items || k.subs) throw new No(`${k.name} still has ${k.items ? `${k.items} products` : ""}${k.items && k.subs ? " and " : ""}${k.subs ? `${k.subs} sub categories` : ""}. Move or delete them first.`);
      return { params: { what, categories: [k.id], items: [], lines: [] }, readings: [{ said: "category", is: k.name, note: "deleted", isNew: false }], title: `Delete ${k.name}`, touched: { [`categories:${k.id}`]: k.updated_at } };
    }
    if (what === "lines") {
      const p = await productOf(x, input.product);
      const ls = (await lines(x.c, x.t, p.id)).filter((l) => ids.includes(l.id));
      if (!ls.length) throw new Ask(`Which lines of ${p.name}?`);
      return { params: { what, item: p.id, items: [], lines: ls.map((l) => l.id), categories: [] }, readings: [{ said: "product", is: p.name, note: `${ls.length} lines deleted`, isNew: false }], title: `Delete ${ls.length} ${ls.length === 1 ? "line" : "lines"} of ${p.name}`, touched: Object.fromEntries(ls.map((l) => [`item_variants:${l.id}`, l.updated_at])) };
    }
    const ps = (await Promise.all(ids.map((id) => product(x.c, x.t, id)))).filter((p): p is Product => Boolean(p));
    if (!ps.length) throw new Ask("Which product?");
    const ls = (await Promise.all(ps.map((p) => lines(x.c, x.t, p.id)))).flat();
    return { params: { what: "products", items: ps.map((p) => p.id), lines: ls.map((l) => l.id), categories: [] }, readings: ps.map((p) => ({ said: "product", is: p.name, note: p.path, isNew: false })), title: `Delete ${ps.length === 1 ? ps[0].name : `${ps.length} products`}`, touched: Object.fromEntries(ps.map((p) => [`items:${p.id}`, p.updated_at])) };
  },
  async run(x, p) {
    const items = p.items as string[], ls = p.lines as string[], cats = p.categories as string[];
    // the stock they hold, written off, and kept to put back
    const held = (await x.c.query(
      `select store_id, item_id, variant_id, qty from stock_levels where tenant_id = $1 and deleted_at is null and qty <> 0
          and (item_id = any($2::uuid[]) or variant_id = any($3::uuid[]))`, [x.t, items, ls])).rows;
    for (const h of held) {
      await x.c.query(`select stock_move($1,$2,$3,$4,$5,$6,null,null,null,$7,'Deleted through Claude')`, [x.t, h.store_id, h.item_id, h.variant_id, -Number(h.qty), Number(h.qty) > 0 ? "internal" : "found", x.w.employeeId]);
    }
    // a product whose last lines go loses its options; Restore gives them back
    const options = p.what === "lines" ? (await x.c.query(`select option_names from items where tenant_id = $1 and id = $2`, [x.t, p.item])).rows[0]?.option_names ?? [] : [];
    await x.c.query(`update item_variants set deleted_at = now() where tenant_id = $1 and deleted_at is null and (id = any($2::uuid[]) or item_id = any($3::uuid[]))`, [x.t, ls, items]);
    await x.c.query(`update items set deleted_at = now() where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`, [x.t, items]);
    if (p.what === "lines") {
      await x.c.query(`update items set option_names = '{}' where tenant_id = $1 and id = $2 and not exists (select 1 from item_variants v where v.item_id = $2 and v.deleted_at is null)`, [x.t, p.item]);
    }
    await x.c.query(`update categories set deleted_at = now() where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`, [x.t, cats]);
    const total = held.reduce((a, h) => a + Number(h.qty), 0);
    return {
      summary: `deleted`,
      lines: [],
      undo: { items, lines: ls, categories: cats, stock: held.map((h) => ({ ...h, qty: Number(h.qty) })), options: p.what === "lines" ? { item: p.item, names: options } : null },
      fix: { pieces: total },
    };
  },
  async view(x, p, ran, before) {
    const undo = ran.undo as { stock: { qty: number }[] };
    const total = undo.stock.reduce((a, h) => a + h.qty, 0);
    const value = (await x.c.query(
      `select coalesce(sum(round(l.qty * coalesce(v.cost, i.cost, 0) / 1000)), 0)::float8 as v from stock_levels l join items i on i.id = l.item_id left join item_variants v on v.id = l.variant_id
        where l.tenant_id = $1 and (l.item_id = any($2::uuid[]) or l.variant_id = any($3::uuid[]))`, [x.t, p.items, p.lines])).rows[0].v;
    const mayCost = await may(x, "costs.view");
    const ls = (p.lines as string[]).length, items = (p.items as string[]).length;
    const lines = [
      ...(items ? [`${items} ${items === 1 ? "product" : "products"}`] : []),
      ...(ls ? [`${ls} ${ls === 1 ? "line" : "lines"}`] : []),
      ...((p.categories as string[]).length ? [`${(p.categories as string[]).length} category`] : []),
      ...(total ? [`${pieces(total)} pieces written off${mayCost && value ? `, worth ${rs(value)} at cost` : ""}`] : []),
    ];
    const big = ls > 50 || items > 0 || p.what === "category";
    return {
      tile: null,
      sheet: null,
      stock: [],
      warnings: [{ tone: "red", text: `This deletes ${lines.join(", ")}. Tablets drop it at their next sync. Past sales keep it. Restore can bring it back for 30 days.` }],
      danger: true,
      confirm: `Delete ${lines.slice(0, 2).join(", ")}`,
      typeName: big ? x.w.tenantName : null,
      lines: before.readings.map((r) => r.is),
    };
  },
};

// Start over, while the business is being set up (spec Q31).
const startOver: Kind = {
  perm: "items.edit",
  async plan(x) {
    const ok = (await x.c.query(`select catalog_setting_up($1) as ok`, [x.t])).rows[0].ok;
    if (!ok) throw new No(`${x.w.tenantName} is live, so it can't start over. Delete what should go, product by product.`);
    const n = (await x.c.query(`select (select count(*) from items where tenant_id = $1 and deleted_at is null)::int as items,
        (select count(*) from item_variants where tenant_id = $1 and deleted_at is null)::int as lines,
        (select count(*) from categories where tenant_id = $1 and deleted_at is null)::int as cats,
        (select coalesce(sum(l.qty), 0) from stock_levels l join items i on i.id = l.item_id and i.deleted_at is null where l.tenant_id = $1)::float8 as pieces`, [x.t])).rows[0];
    return { params: { counts: n }, readings: [{ said: "start over", is: x.w.tenantName, note: "still being set up", isNew: false }], title: `Start over: ${x.w.tenantName}`, touched: {} };
  },
  async run(x) {
    const undo = (await x.c.query(`select catalog_start_over($1) as u`, [x.t])).rows[0].u;
    return { summary: "started over", lines: [], undo };
  },
  async view(x, p) {
    const n = p.counts as { items: number; lines: number; cats: number; pieces: number };
    return {
      tile: null,
      sheet: null,
      stock: [],
      warnings: [{ tone: "red", text: `This hides every product (${n.items}), line (${n.lines}) and category (${n.cats}), with ${pieces(n.pieces)} pieces in stock. Test sales stay until EasyPay clears them. Tills, staff, settings, customers and suppliers stay. Restore brings it all back for 30 days.` }],
      danger: true,
      confirm: "Start over",
      typeName: x.w.tenantName,
    };
  },
};

// Restore a delete or a start over from the log (spec Q13).
const restore: Kind = {
  perm: "items.edit",
  async plan(x, input) {
    const l = (await x.c.query(`select id, kind, summary, undo, restorable_until > now() as ok, restored_at from assistant_log where tenant_id = $1 and id = $2`, [x.t, str(input.change)])).rows[0];
    if (!l || !l.undo) throw new Ask("Which change? The log lists them, with what can be restored.");
    if (l.restored_at) throw new No("That change was already restored.");
    if (!l.ok) throw new No("That change is more than 30 days old, and can't be restored.");
    return { params: { log: l.id, undo: l.undo }, readings: [{ said: "restore", is: l.summary, note: null, isNew: false }], title: `Restore: ${l.summary}`, touched: {} };
  },
  async run(x, p) {
    const u = p.undo as { items: string[]; lines: string[]; categories: string[]; stock?: { store_id: string; item_id: string; variant_id: string | null; qty: number }[] };
    const tops = (await x.c.query(`select id from categories where tenant_id = $1 and id = any($2::uuid[]) and parent_id is null`, [x.t, u.categories])).rows.map((r) => r.id);
    await x.c.query(`update categories set deleted_at = null where tenant_id = $1 and id = any($2::uuid[])`, [x.t, tops]);
    await x.c.query(`update categories set deleted_at = null where tenant_id = $1 and id = any($2::uuid[])`, [x.t, u.categories]);
    await x.c.query(`update items set deleted_at = null where tenant_id = $1 and id = any($2::uuid[])`, [x.t, u.items]);
    const clash = (await x.c.query(
      `select v.name from item_variants v where v.tenant_id = $1 and v.id = any($2::uuid[]) and exists (
         select 1 from item_variants o where o.tenant_id = v.tenant_id and o.item_id = v.item_id and o.deleted_at is null and o.id <> v.id
            and lower(o.option_values::text) = lower(v.option_values::text)) limit 1`, [x.t, u.lines])).rows[0];
    if (clash) throw new No(`A line ${clash.name} was made since, so the old one can't come back beside it.`);
    await x.c.query(`update item_variants set deleted_at = null where tenant_id = $1 and id = any($2::uuid[])`, [x.t, u.lines]);
    const o = (u as { options?: { item: string; names: string[] } | null }).options;
    if (o && o.names.length) await x.c.query(`update items set option_names = $3 where tenant_id = $1 and id = $2 and coalesce(array_length(option_names, 1), 0) = 0`, [x.t, o.item, o.names]);
    for (const h of u.stock ?? []) {
      await x.c.query(`select stock_move($1,$2,$3,$4,$5,$6,null,null,null,$7,'Restored through Claude')`, [x.t, h.store_id, h.item_id, h.variant_id, h.qty, h.qty > 0 ? "found" : "internal", x.w.employeeId]);
    }
    await x.c.query(`update assistant_log set restored_at = now() where tenant_id = $1 and id = $2`, [x.t, p.log]);
    return { summary: "restored", lines: [] };
  },
  async view(_x, p) {
    const u = p.undo as { items: string[]; lines: string[]; categories: string[] };
    return { tile: null, sheet: null, stock: [], warnings: [], danger: false, confirm: "Restore", typeName: null, lines: [`${u.items.length} products, ${u.lines.length} lines, ${u.categories.length} categories come back`] };
  },
};

export const KINDS: Record<string, Kind> = { add_line: addLine, change_stock: changeStock, edit_lines: editLines, edit_category: editCategory, edit_product: editProduct, delete: remove, start_over: startOver, restore };

// ------------------------------------------------------- propose and confirm

const MINUTES = 15;

export async function propose(w: Who, kindName: string, input: Params, asked: string, origin: string): Promise<{ card: PreviewCard; code: string }> {
  const kind = KINDS[kindName];
  if (!kind) throw new No("EasyPay can't make that change.");
  if (w.suspended) throw new No(`${w.tenantName} is suspended, so nothing can be changed. Questions still work.`);
  if (w.mode !== "retail") throw new No("Changes through Claude are for shops for now. Questions work.");
  return withTenant(w.tenantId, async (c) => {
    const x: C = { c, w, t: w.tenantId };
    if (!(await may(x, kind.perm))) throw new No("Your role doesn't allow that change.");
    const planned = await kind.plan(x, input);
    await c.query("savepoint preview");
    let ran: Ran, viewed: Viewed;
    try {
      ran = await kind.run(x, planned.params);
      viewed = await kind.view(x, planned.params, ran, planned);
    } catch (e) {
      await c.query("rollback to savepoint preview");
      throw refusal(e);
    }
    await c.query("rollback to savepoint preview");
    const params = { ...planned.params, ...(ran.fix ?? {}) };
    const code = random(24);
    const id = (
      await c.query(
        `insert into assistant_proposals (tenant_id, grant_id, employee_id, kind, asked, params, card, touched, code_hash, expires_at)
         values ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8, now() + make_interval(mins => $9)) returning id, to_char(expires_at at time zone 'Indian/Mauritius', 'HH24:MI') as at`,
        [w.tenantId, w.grantId, w.employeeId, kindName, asked.slice(0, 500), JSON.stringify(params), JSON.stringify(planned.touched), await sha256(code), MINUTES],
      )
    ).rows[0];
    const card: PreviewCard = {
      kind: "preview",
      title: planned.title,
      business: w.tenantName,
      readings: planned.readings,
      tile: viewed.tile,
      sheet: viewed.sheet,
      stock: viewed.stock,
      lines: viewed.lines ?? ran.lines,
      warnings: viewed.warnings,
      danger: viewed.danger,
      confirm: viewed.confirm,
      typeName: viewed.typeName,
      proposal: id.id,
      expires: id.at,
      link: `${origin}/backoffice/assistant/p/${id.id}`,
    };
    await c.query(`update assistant_proposals set card = $2 where id = $1`, [id.id, JSON.stringify(card)]);
    return { card, code };
  });
}

// What a database refusal is, in words (the functions' own codes).
function refusal(e: unknown): Error {
  if (e instanceof Ask || e instanceof No) return e;
  const m = e instanceof Error ? e.message : "";
  const said: Record<string, string> = {
    "variant-exists": "That line is already there.",
    "barcode-taken": "Another line already has that barcode.",
    "sku-taken": "Another line already has that SKU.",
    "too-many-variants": "A product can have 1000 lines at most.",
    "not-enough-stock": "There isn't that much in stock to take out.",
    "stock-not-counted": "That product doesn't count its stock.",
    "bad-options": "Those values don't fit the product's options.",
    "category-not-empty": "That category still has sub categories.",
    live: "The business is live, so it can't start over.",
  };
  return new No(said[m] ?? "That couldn't be done. Nothing was changed.");
}

export async function confirm(w: Who, proposalId: string, code: string | null, viaPage = false): Promise<DoneCard> {
  return withTenant(w.tenantId, async (c) => {
    const x: C = { c, w, t: w.tenantId };
    const p = (await c.query(`select * from assistant_proposals where tenant_id = $1 and id = $2 for update`, [w.tenantId, proposalId])).rows[0];
    if (!p) throw new No("That change isn't there. Ask for it again.");
    if (p.used_at) throw new No("That change was already confirmed or cancelled.");
    if (new Date(p.expires_at) < new Date()) throw new No("That preview ran out (15 minutes). Ask for it again to see it as things are now.");
    if (!viaPage && (!code || (await sha256(code)) !== p.code_hash)) throw new No("Only the card's own Confirm button can make this change.");
    if (viaPage && p.employee_id !== w.employeeId) throw new No("Only the person who asked for this change can confirm it.");
    const kind = KINDS[p.kind];
    if (!(await may(x, kind.perm))) throw new No("Your role doesn't allow that change any more.");
    // nothing it touched moved since the card was drawn
    for (const [k, was] of Object.entries(p.touched as Record<string, string>)) {
      const [table, id, line, store] = k.split(":");
      const now =
        table === "levels"
          ? String((await c.query(`select coalesce((select qty from stock_levels where tenant_id = $1 and item_id = $2 and variant_id is not distinct from $3 and store_id = $4), 0) as q`, [w.tenantId, id, line || null, store])).rows[0].q)
          : ((await c.query(`select updated_at::text as u from ${table === "items" ? "items" : table === "item_variants" ? "item_variants" : "categories"} where tenant_id = $1 and id = $2`, [w.tenantId, id])).rows[0]?.u as string | undefined);
      if (now !== was) throw new No("Something it changes was changed since the card was drawn. Ask for it again to see it as things are now.");
    }
    let ran: Ran;
    try {
      ran = await kind.run(x, p.params);
    } catch (e) {
      throw refusal(e);
    }
    await c.query(`update assistant_proposals set used_at = now() where id = $1`, [proposalId]);
    const card = p.card as PreviewCard;
    await c.query(
      `insert into assistant_log (tenant_id, employee_id, grant_id, proposal_id, kind, asked, summary, before, after, undo, restorable_until)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $10::jsonb is null then null else now() + interval '30 days' end)`,
      [w.tenantId, w.employeeId, w.grantId, proposalId, p.kind, p.asked, card.title, JSON.stringify(card.readings), JSON.stringify(card.lines), ran.undo ? JSON.stringify(ran.undo) : null],
    );
    let tile = null, sheet = null;
    if (ran.item) {
      const prod = await product(c, w.tenantId, ran.item);
      if (prod) {
        const ls = await lines(c, w.tenantId, prod.id);
        const store = (await branches(c, w.tenantId))[0];
        const held = store ? await stock(c, w.tenantId, prod.id, store.id) : new Map();
        tile = tileOf(prod, ls, held);
        sheet = ran.picked ? sheetOf(prod, ls, held, ran.picked) : null;
      }
    }
    return { kind: "done", title: `Done: ${card.title}`, lines: [...card.lines, "Tablets get it at their next sync."], tile, sheet };
  });
}

export async function cancel(w: Who, proposalId: string): Promise<void> {
  await withTenant(w.tenantId, (c) => c.query(`update assistant_proposals set used_at = now() where tenant_id = $1 and id = $2 and used_at is null`, [w.tenantId, proposalId]));
}
