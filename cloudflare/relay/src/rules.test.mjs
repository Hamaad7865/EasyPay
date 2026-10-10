// node --test cloudflare/relay/src/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { storeId, isStoreId, isKey, readMenu, readOrder, LIMITS } from "./rules.js";
import { demoMenu, DEMO_KEY } from "../test/demo-menu.mjs";

const menu = () => readMenu(demoMenu()).menu;
const order = (lines, table = "t0000007") => ({ table, lines });

test("a store's id is sixteen letters and digits worked out from its key, the same every time", async () => {
  const a = await storeId(DEMO_KEY), b = await storeId(DEMO_KEY), c = await storeId(DEMO_KEY + "x");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(isStoreId(a), a);
  assert.ok(!isStoreId(a.toUpperCase()) && !isStoreId(a.slice(1)) && !isStoreId(a + "a"));
});

test("a key is long, and of letters, digits, - and _ only", () => {
  assert.ok(isKey(DEMO_KEY));
  assert.ok(!isKey("short") && !isKey("x".repeat(31)) && !isKey("a b".repeat(20)) && !isKey(null));
});

test("the demo menu is taken whole", () => {
  const m = menu();
  assert.equal(m.name, "Le Flamboyant");
  assert.equal(m.items.length, 43);
  assert.equal(m.tables.length, 3);
  assert.deepEqual(m.items.find((i) => i.id === "cp").groups, ["cs", "ca"]);
  assert.equal(m.items.find((i) => i.id === "cal").out, true);
  assert.deepEqual(m.items.find((i) => i.id === "gp").tags, ["Veg"]);
  assert.deepEqual(m.popular, ["cp", "dp", "mf", "bp", "alo"]);
});

test("a menu keeps only what is known of it: a group, a category or a favourite that does not exist is dropped", () => {
  const raw = demoMenu();
  raw.items[0].groups = ["nope", "cs"];
  raw.items[1].cat = "nope";
  raw.popular = ["cp", "ghost"];
  raw.items[2].price = 1200;
  raw.extra = { anything: true };
  const m = readMenu(raw).menu;
  assert.deepEqual(m.items[0].groups, ["cs"]);
  assert.equal(m.items[1].cat, null);
  assert.deepEqual(m.popular, ["cp"]);
  assert.equal(m.extra, undefined);
});

test("a menu is refused when it is not one", () => {
  const no = (change) => { const raw = demoMenu(); change(raw); return readMenu(raw).error; };
  assert.ok(readMenu(null).error && readMenu([]).error && readMenu("menu").error);
  assert.ok(no((m) => { m.name = ""; }));
  assert.ok(no((m) => { m.items = "many"; }));
  assert.ok(no((m) => { m.items[0].price = -5; }));
  assert.ok(no((m) => { m.items[0].price = 12.5; }));
  assert.ok(no((m) => { m.items.push({ ...m.items[0] }); }), "the same dish twice");
  assert.ok(no((m) => { m.tables[0].c = "has a space"; }));
  assert.ok(no((m) => { m.groups[0].opts[0].name = ""; }));
  assert.ok(no((m) => { m.tables = Array.from({ length: LIMITS.tables + 1 }, (_, i) => ({ c: "t" + i, name: "T" + i })); }));
});

test("an order of dishes with their options is taken, with nothing of a price in it", () => {
  const got = readOrder(order([
    { item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "  no onion  ", price: 1 },
    { item: "gp", qty: 1 },
  ]), menu());
  assert.equal(got.error, undefined);
  assert.deepEqual(got.order, { table: "t0000007", lines: [
    { item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "no onion" },
    { item: "gp", qty: 1, mods: [], note: "" },
  ] });
});

test("an order is refused for a table, a dish or an option the menu does not have", () => {
  const m = menu();
  assert.equal(readOrder(order([{ item: "gp", qty: 1 }], "t9999999"), m).code, "table");
  assert.equal(readOrder(order([{ item: "ghost", qty: 1 }]), m).code, "gone");
  assert.equal(readOrder(order([{ item: "gp", qty: 1, mods: ["cs1"] }]), m).code, "gone", "an option of another dish");
  assert.equal(readOrder(order([{ item: "cal", qty: 1 }]), m).code, "gone", "sold out");
});

test("a group's least and most are kept", () => {
  const m = menu();
  assert.equal(readOrder(order([{ item: "cp", qty: 1, mods: [] }]), m).code, "options", "the spice must be chosen");
  assert.equal(readOrder(order([{ item: "cp", qty: 1, mods: ["cs0", "cs1"] }]), m).code, "options", "one spice only");
  assert.equal(readOrder(order([{ item: "cp", qty: 1, mods: ["cs0", "ca0", "ca1", "ca2"] }]), m).error, undefined, "up to three add-ons");
  assert.equal(readOrder(order([{ item: "alo", qty: 1 }]), m).error, undefined, "ice is optional");
  assert.equal(readOrder(order([{ item: "alo", qty: 1, mods: ["ic0", "ic1"] }]), m).code, "options");
});

test("quantities, lines and notes have their limits", () => {
  const m = menu();
  assert.ok(readOrder(order([]), m).error);
  assert.ok(readOrder(order([{ item: "gp", qty: 0 }]), m).error);
  assert.ok(readOrder(order([{ item: "gp", qty: LIMITS.qty + 1 }]), m).error);
  assert.ok(readOrder(order([{ item: "gp", qty: 1.5 }]), m).error);
  assert.ok(readOrder(order(Array.from({ length: LIMITS.lines + 1 }, () => ({ item: "gp", qty: 1 }))), m).error);
  assert.ok(readOrder(order([{ item: "cp", qty: 1, mods: ["cs0", "cs0"] }]), m).error, "the same option twice");
  const long = readOrder(order([{ item: "gp", qty: 1, note: "x".repeat(500) }]), m);
  assert.equal(long.order.lines[0].note.length, LIMITS.note);
});
