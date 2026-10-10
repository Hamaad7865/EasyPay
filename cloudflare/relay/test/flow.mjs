// The whole exchange against a relay running on this PC (`wrangler dev`, see
// README.md): a till that EasyPay vouches for and that publishes, a phone
// that orders and is told the answer.
//
//   node test/flow.mjs            (RELAY=http://localhost:8787 by default)
//
// It uses a store of its own each run, so it can be run again and again, and
// starts the stand-in for EasyPay's till service unless one is running.
import assert from "node:assert/strict";
import { demoMenu, proofFor, T1, T7, T12 } from "./demo-menu.mjs";
import { standInApi } from "./stand-in-api.mjs";
import { LIMITS } from "../src/rules.js";

await standInApi();
const relay = (process.env.RELAY || "http://localhost:8787").replace(/\/$/, "");
const wsBase = relay.replace(/^http/, "ws");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newStore = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => B32[b & 31]).join("");
const store = newStore();
const api = (path, init) => fetch(`${relay}/api/${store}${path}`, init);
const post = (body) => api("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const menuOf = async (table = T7) => (await api("/menu/" + table)).json();

// a socket whose messages can be awaited one at a time
function line(url, proof) {
  const ws = new WebSocket(url, proof ? { headers: { authorization: proof } } : undefined);
  const got = [], wanted = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); const w = wanted.shift(); w ? w.resolve(m) : got.push(m); });
  const opened = new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", () => reject(new Error("refused"))); });
  const closed = new Promise((resolve) => ws.addEventListener("close", resolve));
  const next = (ms = 4000) => got.length ? Promise.resolve(got.shift()) : new Promise((resolve, reject) => {
    const w = { resolve: (m) => { clearTimeout(timer); resolve(m); } };
    const timer = setTimeout(() => { wanted.splice(wanted.indexOf(w), 1); reject(new Error("nothing was said in " + ms + " ms")); }, ms);
    wanted.push(w);
  });
  return { ws, opened, closed, next, say: (o) => ws.send(JSON.stringify(o)), quiet: () => got.length === 0 };
}
const tillUrl = `${wsBase}/api/till`;
const till = (of = store) => line(tillUrl, proofFor(of));

let n = 0;
const step = async (what, run) => { await run(); console.log("ok  " + (++n) + ". " + what); };

await step("a store nobody has published for has no menu, and takes no order", async () => {
  const r = await api("/menu/" + T7);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, "unknown");
  assert.equal((await post({ table: T7, lines: [{ item: "gp", qty: 1 }] })).status, 404);
  assert.equal((await api("/orders/aaaaaaaaaaaa")).status, 404);
});

await step("only a till EasyPay vouches for, with ordering on, gets in", async () => {
  await assert.rejects(line(tillUrl).opened, "no credential");
  await assert.rejects(line(tillUrl, "Bearer made-up-key-0123456789abcdef0123456789").opened, "not a till's credential");
  await assert.rejects(line(tillUrl, proofFor(store, "bad")).opened, "a till nobody knows");
  await assert.rejects(line(tillUrl, proofFor(store, "off")).opened, "ordering switched off");
  await assert.rejects(line(`${wsBase}/api/${store}/till`, proofFor(store)).opened, "a store's room is not reached by naming it");
  assert.equal((await fetch(`${relay}/api/till`, { headers: { authorization: proofFor(store) } })).status, 426, "the right till, but not a socket");
  assert.equal((await api("/menu/" + T7)).status, 404, "none of them left a menu behind");
});

let t1 = till();
await step("the store's till connects and publishes its menu", async () => {
  await t1.opened;
  assert.deepEqual(await t1.next(), { t: "hello", store, menu: false, waiting: 0 }, "the till is told its store's public id");
  t1.say({ t: "menu", menu: { name: "" } });
  assert.equal((await t1.next()).t, "menu.no");
  t1.say({ t: "menu", menu: demoMenu() });
  assert.deepEqual(await t1.next(), { t: "menu.ok", items: 43, tables: 3 });
});

await step("a phone reads the menu and its own table, and no other table's code", async () => {
  const r = await api("/menu/" + T7);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /no-store/);
  const text = await r.text(), { open, table, menu } = JSON.parse(text);
  assert.equal(open, true);
  assert.deepEqual(table, { c: T7, name: "Table 7", area: "Terrace" });
  assert.equal(menu.name, "Le Flamboyant");
  assert.equal(menu.items.length, 43);
  assert.equal(menu.tables, undefined);
  assert.ok(!text.includes(T1) && !text.includes(T12));
  const none = await api("/menu/" + T7.slice(0, 8));
  assert.equal(none.status, 404);
  assert.equal((await none.json()).code, "table");
});

let first;
await step("an order reaches the till as it was sent, with nothing of a price", async () => {
  const r = await post({ table: T7, lines: [{ item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "no onion", price: 1 }, { item: "gp", qty: 1 }] });
  assert.equal(r.status, 200);
  first = (await r.json()).id;
  assert.match(first, /^[a-z2-7]{12}$/);
  const told = await t1.next();
  assert.equal(told.t, "order");
  assert.equal(told.order.id, first);
  assert.equal(told.order.table, T7);
  assert.deepEqual(told.order.lines, [{ item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "no onion" }, { item: "gp", qty: 1, mods: [], note: "" }]);
  assert.deepEqual(await (await api("/orders/" + first)).json(), { id: first, status: "waiting", reason: "" });
});

await step("the phone is told the moment the till accepts, and its line is closed", async () => {
  const phone = line(`${wsBase}/api/${store}/orders/${first}`);
  await phone.opened;
  assert.equal((await phone.next()).status, "waiting");
  t1.say({ t: "answer", id: first, status: "accepted" });
  assert.deepEqual(await t1.next(), { t: "answer.ok", id: first, status: "accepted" });
  assert.deepEqual(await phone.next(), { id: first, status: "accepted", reason: "" });
  await phone.closed;
  assert.equal((await (await api("/orders/" + first)).json()).status, "accepted");
});

await step("an answer given twice changes nothing; the first one stands", async () => {
  t1.say({ t: "answer", id: first, status: "declined", reason: "too late" });
  assert.deepEqual(await t1.next(), { t: "answer.late", id: first, status: "accepted" });
  t1.say({ t: "answer", id: "aaaaaaaaaaaa", status: "accepted" });
  assert.equal((await t1.next()).t, "answer.no");
});

await step("what the menu does not have is refused, and says why", async () => {
  const no = async (body, status, code) => { const r = await post(body); assert.equal(r.status, status, JSON.stringify(body).slice(0, 80)); assert.equal((await r.json()).code, code); };
  await no({ table: "5f0c2a9e-9999-4a11-8c01-000000000099", lines: [{ item: "gp", qty: 1 }] }, 404, "table");
  await no({ table: T7, lines: [{ item: "cal", qty: 1 }] }, 400, "gone");
  await no({ table: T7, lines: [{ item: "cp", qty: 1 }] }, 400, "options");
  await no({ table: T7, lines: [] }, 400, "invalid");
  await no("{not json", 400, "invalid");
  await no({ table: T7, lines: [{ item: "gp", qty: 1, note: "x".repeat(LIMITS.orderBytes) }] }, 413, "invalid");
  assert.ok(t1.quiet(), "the till heard of none of them");
});

await step("a declined order carries the cashier's reason to the phone", async () => {
  const id = (await (await post({ table: T1, lines: [{ item: "alo", qty: 1, mods: ["ic1"] }] })).json()).id;
  assert.equal((await t1.next()).order.id, id);
  t1.say({ t: "answer", id, status: "declined", reason: "  Sorry, the kitchen has just closed.  " });
  await t1.next();
  assert.deepEqual(await (await api("/orders/" + id)).json(), { id, status: "declined", reason: "Sorry, the kitchen has just closed." });
});

const waiting = [];
await step("a table may have three orders waiting, and no more; other tables are not held up", async () => {
  for (let i = 0; i < LIMITS.waiting; i++) {
    const r = await post({ table: T12, lines: [{ item: "gp", qty: i + 1 }] });
    assert.equal(r.status, 200);
    waiting.push((await r.json()).id);
    await t1.next();
  }
  const r = await post({ table: T12, lines: [{ item: "gp", qty: 1 }] });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, "busy");
  // a room's guests share one address on its Wi-Fi: many orders from it are an ordinary evening
  for (const table of [T1, T7, T1, T7, T1]) {
    const ok = await post({ table, lines: [{ item: "gp", qty: 1 }] });
    assert.equal(ok.status, 200);
    waiting.push((await t1.next()).order.id);
    t1.say({ t: "answer", id: waiting.pop(), status: "accepted" });
    await t1.next();
  }
});

await step("with no till listening the menu still shows, and ordering says to ask staff", async () => {
  t1.ws.close();
  await t1.closed;
  const { open, menu } = await menuOf();
  assert.equal(open, false);
  assert.equal(menu.items.length, 43);
  const r = await post({ table: T7, lines: [{ item: "gp", qty: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "closed");
});

await step("a till that comes back is handed what waited, oldest first", async () => {
  t1 = till();
  await t1.opened;
  assert.deepEqual(await t1.next(), { t: "hello", store, menu: true, waiting: waiting.length });
  for (const id of waiting) assert.equal((await t1.next()).order.id, id);
  assert.equal((await menuOf()).open, true);
});

await step("with two tills, the one that did not answer is told the order is gone", async () => {
  const t2 = till();
  await t2.opened;
  await t2.next(); // hello
  for (const _ of waiting) await t2.next();
  t2.say({ t: "answer", id: waiting[0], status: "accepted" });
  assert.equal((await t2.next()).t, "answer.ok");
  assert.deepEqual(await t1.next(), { t: "gone", id: waiting[0], status: "accepted" });
  t2.ws.close();
  await t2.closed;
});

await step("a till is taken to its own store's room and to no other", async () => {
  const elsewhere = newStore();
  const t3 = till(elsewhere);
  await t3.opened;
  assert.equal((await t3.next()).store, elsewhere);
  t3.say({ t: "menu", menu: { ...demoMenu(), name: "Another place" } });
  await t3.next();
  assert.equal((await menuOf()).menu.name, "Le Flamboyant", "this store's menu is as its own till published it");
  assert.equal((await (await fetch(`${relay}/api/${elsewhere}/menu/${T7}`)).json()).menu.name, "Another place");
  const id = (await (await post({ table: T7, lines: [{ item: "gp", qty: 1 }] })).json()).id;
  assert.equal((await t1.next()).order.id, id);
  assert.ok(t3.quiet(), "the other store's till heard nothing of it");
  t3.say({ t: "answer", id, status: "accepted" });
  assert.equal((await t3.next()).t, "answer.no", "and cannot answer it");
  t1.say({ t: "answer", id, status: "accepted" });
  await t1.next();
  t3.ws.close();
  await t3.closed;
});

await step("a till that says it has stopped taking orders closes the table's ordering", async () => {
  t1.say({ t: "menu", menu: { ...demoMenu(), accepting: false } });
  await t1.next();
  assert.equal((await menuOf()).open, false);
  assert.equal((await post({ table: T7, lines: [{ item: "gp", qty: 1 }] })).status, 409);
});

await step("a guest's socket cannot speak for a till, and other addresses are not found", async () => {
  const phone = line(`${wsBase}/api/${store}/orders/${waiting[1]}`);
  await phone.opened;
  await phone.next();
  phone.say({ t: "answer", id: waiting[1], status: "accepted" });
  phone.say({ t: "menu", menu: { ...demoMenu(), name: "Taken over" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await (await api("/orders/" + waiting[1])).json()).status, "waiting");
  assert.equal((await menuOf()).menu.name, "Le Flamboyant");
  phone.ws.close();
  assert.equal((await fetch(`${relay}/api/${store}/nothing`)).status, 404);
  assert.equal((await fetch(`${relay}/api/${store}/menu`)).status, 404, "the menu is asked for with a table");
  assert.equal((await fetch(`${relay}/api/NOT-A-STORE/menu/${T7}`)).status, 404);
});

t1.ws.close();
console.log(`\nall ${n} steps passed against ${relay}`);
process.exit(0);
