// node --test cloudflare/relay/src/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStoreId, readMenu, readOrder, forPhones, LIMITS } from "./rules.js";
import { demoMenu, DEMO_STORE, T7 } from "../test/demo-menu.mjs";

const menu = () => readMenu(demoMenu()).menu;
const order = (lines, table = T7) => ({ table, lines });

test("a store's id is sixteen letters and digits", () => {
  assert.ok(isStoreId(DEMO_STORE));
  assert.ok(!isStoreId(DEMO_STORE.toUpperCase()) && !isStoreId(DEMO_STORE.slice(1)) && !isStoreId(DEMO_STORE + "a") && !isStoreId("demostore0000001") && !isStoreId(null));
});

test("a phone is sent the menu without its tables", () => {
  const m = menu(), sent = forPhones(m);
  assert.equal(sent.tables, undefined);
  assert.equal(sent.items.length, m.items.length);
  assert.equal(m.tables.length, 3, "the menu itself keeps them");
  assert.ok(!JSON.stringify(sent).includes(T7));
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
  assert.deepEqual(got.order, { table: T7, lines: [
    { item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "no onion" },
    { item: "gp", qty: 1, mods: [], note: "" },
  ] });
});

test("an order is refused for a table, a dish or an option the menu does not have", () => {
  const m = menu();
  assert.equal(readOrder(order([{ item: "gp", qty: 1 }], "5f0c2a9e-9999-4a11-8c01-000000000099"), m).code, "table");
  assert.equal(readOrder(order([{ item: "gp", qty: 1 }], T7.slice(0, 8)), m).code, "table", "the start of a table's id is not the table");
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
