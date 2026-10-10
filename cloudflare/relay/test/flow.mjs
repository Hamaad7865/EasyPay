// The whole exchange against a relay running on this PC (`wrangler dev`):
// a till that proves its key and publishes, a phone that orders and is told
// the answer. Run with the dev server up:
//
//   node test/flow.mjs            (RELAY=http://localhost:8787 by default)
//
// It uses a store of its own each run, so it can be run again and again.
import assert from "node:assert/strict";
import { demoMenu } from "./demo-menu.mjs";
import { storeId, LIMITS } from "../src/rules.js";

const relay = (process.env.RELAY || "http://localhost:8787").replace(/\/$/, "");
const wsBase = relay.replace(/^http/, "ws");
const key = "flow-" + crypto.randomUUID().replaceAll("-", "") + "-key";
const store = await storeId(key);
const api = (path, init) => fetch(`${relay}/api/${store}${path}`, init);
const post = (body) => api("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

// a socket whose messages can be awaited one at a time
function line(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
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
const till = () => line(`${wsBase}/api/${store}/till`, { authorization: "Bearer " + key });

let n = 0;
const step = async (what, run) => { await run(); console.log("ok  " + (++n) + ". " + what); };

await step("a store nobody has published for has no menu, and takes no order", async () => {
  assert.equal((await api("/menu")).status, 404);
  assert.equal((await post({ table: "t0000007", lines: [{ item: "gp", qty: 1 }] })).status, 404);
});

await step("a till with another key, or none, is turned away before any room is opened", async () => {
  await assert.rejects(line(`${wsBase}/api/${store}/till`, { authorization: "Bearer " + key + "x" }).opened);
  await assert.rejects(line(`${wsBase}/api/${store}/till`).opened);
  assert.equal((await api("/till", { headers: { authorization: "Bearer " + key } })).status, 426, "the right key, but not a socket");
});

let t1 = till();
await step("the store's till connects and publishes its menu", async () => {
  await t1.opened;
  assert.deepEqual(await t1.next(), { t: "hello", menu: false, waiting: 0 });
  t1.say({ t: "menu", menu: { name: "" } });
  assert.equal((await t1.next()).t, "menu.no");
  t1.say({ t: "menu", menu: demoMenu() });
  assert.deepEqual(await t1.next(), { t: "menu.ok", items: 43, tables: 3 });
});

await step("a phone reads the menu and sees that orders are taken", async () => {
  const r = await api("/menu");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /no-store/);
  const { open, menu } = await r.json();
  assert.equal(open, true);
  assert.equal(menu.name, "Le Flamboyant");
  assert.equal(menu.items.length, 43);
});

let first;
await step("an order reaches the till as it was sent, with nothing of a price", async () => {
  const r = await post({ table: "t0000007", lines: [{ item: "cp", qty: 2, mods: ["cs2", "ca0"], note: "no onion", price: 1 }, { item: "gp", qty: 1 }] });
  assert.equal(r.status, 200);
  first = (await r.json()).id;
  assert.match(first, /^[a-z2-7]{12}$/);
  const told = await t1.next();
  assert.equal(told.t, "order");
  assert.equal(told.order.id, first);
  assert.equal(told.order.table, "t0000007");
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
  const no = async (body, status, code) => { const r = await post(body); assert.equal(r.status, status, JSON.stringify(body)); assert.equal((await r.json()).code, code); };
  await no({ table: "t9999999", lines: [{ item: "gp", qty: 1 }] }, 404, "table");
  await no({ table: "t0000007", lines: [{ item: "cal", qty: 1 }] }, 400, "gone");
  await no({ table: "t0000007", lines: [{ item: "cp", qty: 1 }] }, 400, "options");
  await no({ table: "t0000007", lines: [] }, 400, "invalid");
  await no("{not json", 400, "invalid");
  await no({ table: "t0000007", lines: [{ item: "gp", qty: 1, note: "x".repeat(LIMITS.orderBytes) }] }, 413, "invalid");
  assert.ok(t1.quiet(), "the till heard of none of them");
});

await step("a declined order carries the cashier's reason to the phone", async () => {
  const id = (await (await post({ table: "t0000001", lines: [{ item: "alo", qty: 1, mods: ["ic1"] }] })).json()).id;
  assert.equal((await t1.next()).order.id, id);
  t1.say({ t: "answer", id, status: "declined", reason: "  Sorry, the kitchen has just closed.  " });
  await t1.next();
  assert.deepEqual(await (await api("/orders/" + id)).json(), { id, status: "declined", reason: "Sorry, the kitchen has just closed." });
});

const waiting = [];
await step("a table may have three orders waiting, and no more", async () => {
  for (let i = 0; i < LIMITS.waiting; i++) {
    const r = await post({ table: "t0000012", lines: [{ item: "gp", qty: i + 1 }] });
    assert.equal(r.status, 200);
    waiting.push((await r.json()).id);
    await t1.next();
  }
  const r = await post({ table: "t0000012", lines: [{ item: "gp", qty: 1 }] });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, "busy");
  assert.equal((await post({ table: "t0000001", lines: [{ item: "gp", qty: 1 }] })).status, 200, "another table is not held up");
  waiting.push((await t1.next()).order.id);
});

await step("with no till listening the menu still shows, and ordering says to ask staff", async () => {
  t1.ws.close();
  await t1.closed;
  const { open, menu } = await (await api("/menu")).json();
  assert.equal(open, false);
  assert.equal(menu.items.length, 43);
  const r = await post({ table: "t0000007", lines: [{ item: "gp", qty: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "closed");
});

await step("a till that comes back is handed what waited, oldest first", async () => {
  t1 = till();
  await t1.opened;
  assert.deepEqual(await t1.next(), { t: "hello", menu: true, waiting: waiting.length });
  for (const id of waiting) assert.equal((await t1.next()).order.id, id);
  assert.equal((await (await api("/menu")).json()).open, true);
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

await step("a till that says it has stopped taking orders closes the table's ordering", async () => {
  t1.say({ t: "menu", menu: { ...demoMenu(), accepting: false } });
  await t1.next();
  assert.equal((await (await api("/menu")).json()).open, false);
  assert.equal((await post({ table: "t0000007", lines: [{ item: "gp", qty: 1 }] })).status, 409);
});

await step("a guest's socket cannot speak for a till, and other addresses are not found", async () => {
  const phone = line(`${wsBase}/api/${store}/orders/${waiting[1]}`);
  await phone.opened;
  await phone.next();
  phone.say({ t: "answer", id: waiting[1], status: "accepted" });
  phone.say({ t: "menu", menu: { ...demoMenu(), name: "Taken over" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await (await api("/orders/" + waiting[1])).json()).status, "waiting");
  assert.equal((await (await api("/menu")).json()).menu.name, "Le Flamboyant");
  phone.ws.close();
  assert.equal((await fetch(`${relay}/api/${store}/nothing`)).status, 404);
  assert.equal((await fetch(`${relay}/api/NOT-A-STORE/menu`)).status, 404);
});

t1.ws.close();
console.log(`\nall ${n} steps passed against ${relay}`);
process.exit(0);
