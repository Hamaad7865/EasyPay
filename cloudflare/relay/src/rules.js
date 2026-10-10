// What the relay takes and refuses, as plain functions: a store's public id
// from its key, a menu from a till, an order from a guest. Nothing here
// touches the network or the room's store, so it is all tested by itself
// (rules.test.mjs).

export const LIMITS = {
  menuBytes: 512 * 1024, // a menu as the till publishes it
  orderBytes: 16 * 1024, // an order as a phone sends it
  lines: 40, // lines in one order
  qty: 20, // of one dish in one line
  note: 140, // characters of a note for the kitchen
  waiting: 3, // orders a table may have waiting at once
  items: 2000,
  tables: 400,
  staleMs: 2 * 60 * 60 * 1000, // an order nobody answered is dropped after this
  keepMs: 6 * 60 * 60 * 1000, // an answered one is forgotten after this
};

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

// The store's address on a card: the first 80 bits of SHA-256 of its key, in
// sixteen letters and digits. A till proves it is the store's by giving the
// key; the relay works the id out again and needs to keep no secret.
export async function storeId(key) {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key))));
  let bits = 0, held = 0, out = "";
  for (let i = 0; i < 10; i++) {
    held = (held << 8) | sum[i];
    bits += 8;
    while (bits >= 5) { out += B32[(held >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}

export const isStoreId = (s) => typeof s === "string" && /^[a-z2-7]{16}$/.test(s);
// a key is made by the server: long enough that it cannot be guessed
export const isKey = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(s);

const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const whole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// A menu as a till publishes it. Returns the menu cut down to what the page
// and the order check use, or says why it is refused.
export function readMenu(raw) {
  const bad = (why) => ({ error: why });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("a menu is an object");
  if (!text(raw.name, 80)) return bad("the restaurant has no name");
  const list = (v) => (Array.isArray(v) ? v : null);
  const tables = list(raw.tables), categories = list(raw.categories), groups = list(raw.groups), items = list(raw.items);
  if (!tables || !categories || !groups || !items) return bad("tables, categories, groups and items are lists");
  if (tables.length > LIMITS.tables || items.length > LIMITS.items || categories.length > 300 || groups.length > 600) return bad("the menu is too long");

  const out = {
    name: raw.name,
    currency: text(raw.currency, 8) ? raw.currency : "Rs",
    decimals: whole(raw.decimals, 0, 3) ? raw.decimals : 2,
    note: typeof raw.note === "string" ? raw.note.slice(0, 200) : "",
    accepting: raw.accepting !== false,
    tables: [], categories: [], groups: [], items: [],
    popular: [],
  };
  const seen = new Set();
  const fresh = (kind, v) => { const k = kind + ":" + v; if (seen.has(k)) return false; seen.add(k); return true; };
  const colour = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null);

  for (const t of tables) {
    if (!t || !id(t.c) || !text(t.name, 40) || !fresh("t", t.c)) return bad("a table is not as expected");
    out.tables.push({ c: t.c, name: t.name, area: typeof t.area === "string" ? t.area.slice(0, 40) : "" });
  }
  for (const c of categories) {
    if (!c || !id(c.id) || !text(c.name, 60) || !fresh("c", c.id)) return bad("a category is not as expected");
    out.categories.push({ id: c.id, name: c.name, color: colour(c.color) });
  }
  const groupIds = new Set();
  for (const g of groups) {
    if (!g || !id(g.id) || !text(g.name, 60) || !fresh("g", g.id) || !Array.isArray(g.opts) || g.opts.length > 60) return bad("a group of options is not as expected");
    const min = whole(g.min, 0, 20) ? g.min : 0;
    const max = whole(g.max, 1, 20) ? g.max : 1;
    const opts = [];
    for (const o of g.opts) {
      if (!o || !id(o.id) || !text(o.name, 60) || !fresh("o", o.id) || !whole(o.price ?? 0, 0, 100_000_000)) return bad("an option is not as expected");
      opts.push({ id: o.id, name: o.name, price: o.price ?? 0 });
    }
    groupIds.add(g.id);
    out.groups.push({ id: g.id, name: g.name, min: Math.min(min, max), max, opts });
  }
  const catIds = new Set(out.categories.map((c) => c.id));
  for (const i of items) {
    if (!i || !id(i.id) || !text(i.name, 80) || !fresh("i", i.id) || !whole(i.price, 0, 100_000_000)) return bad("a dish is not as expected");
    const its = Array.isArray(i.groups) ? i.groups.filter((g) => groupIds.has(g)).slice(0, 12) : [];
    const tags = Array.isArray(i.tags) ? i.tags.filter((t) => text(t, 24)).slice(0, 6) : [];
    out.items.push({ id: i.id, cat: catIds.has(i.cat) ? i.cat : null, name: i.name, price: i.price, groups: its, tags, out: i.out === true, color: colour(i.color) });
  }
  const itemIds = new Set(out.items.map((i) => i.id));
  if (Array.isArray(raw.popular)) out.popular = raw.popular.filter((p) => itemIds.has(p)).slice(0, 8);
  return { menu: out };
}

// The least and most of a group of options, for what was picked of it.
// Returns the group's name when too few or too many were picked.
export function groupFault(group, picked) {
  if (picked.length < group.min) return "choose " + group.name;
  if (picked.length > group.max) return "too many of " + group.name;
  return null;
}

// An order from a phone, checked against the menu the till published. The
// prices are never the phone's: the till works them out from its own menu
// when it accepts. Returns the order as kept, or why it is refused.
export function readOrder(raw, menu) {
  const bad = (why, code = "invalid") => ({ error: why, code });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("an order is an object");
  const table = menu.tables.find((t) => t.c === raw.table);
  if (!table) return bad("this table's code is not in use", "table");
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return bad("the order is empty");
  if (raw.lines.length > LIMITS.lines) return bad("the order has too many lines");

  const items = new Map(menu.items.map((i) => [i.id, i]));
  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  const lines = [];
  for (const l of raw.lines) {
    if (!l || typeof l !== "object") return bad("a line is not as expected");
    const item = items.get(l.item);
    if (!item) return bad("a dish is no longer on the menu", "gone");
    if (item.out) return bad(item.name + " is sold out", "gone");
    if (!whole(l.qty, 1, LIMITS.qty)) return bad("a quantity is not as expected");
    const mods = Array.isArray(l.mods) ? l.mods : [];
    if (mods.length > 40 || new Set(mods).size !== mods.length) return bad("the options of a dish are not as expected");
    const left = new Set(mods);
    for (const gid of item.groups) {
      const g = groups.get(gid);
      const picked = g.opts.filter((o) => left.has(o.id));
      for (const o of picked) left.delete(o.id);
      const fault = groupFault(g, picked);
      if (fault) return bad(item.name + ": " + fault, "options");
    }
    if (left.size) return bad(item.name + ": an option is no longer offered", "gone");
    const note = typeof l.note === "string" ? l.note.trim().slice(0, LIMITS.note) : "";
    lines.push({ item: item.id, qty: l.qty, mods, note });
  }
  return { order: { table: table.c, lines } };
}
