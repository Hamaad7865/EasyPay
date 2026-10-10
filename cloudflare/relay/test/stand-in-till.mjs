// A till played by a script, for trying the guest's page with no tablet.
//
//   node test/stand-in-till.mjs                 accepts each order after 4 seconds
//   node test/stand-in-till.mjs --after=10      ...after 10 seconds
//   node test/stand-in-till.mjs --never         leaves them waiting
//
// An order with a note that says "decline" is declined, to see that too. It
// publishes the demo menu and prints the address of each table's page.
import { demoMenu, DEMO_STORE, proofFor } from "./demo-menu.mjs";
import { standInApi } from "./stand-in-api.mjs";

const arg = (name) => process.argv.find((a) => a.startsWith("--" + name));
const relay = (process.env.RELAY || "http://localhost:8787").replace(/\/$/, "");
const after = arg("never") ? null : Number((arg("after") || "=4").split("=")[1]) * 1000;
const store = DEMO_STORE;
// the relay asks EasyPay's till service whose till this is: a stand-in answers, unless one is running already
if (await standInApi()) console.log("till: a stand-in for EasyPay's till service is answering on 8788");
const menu = demoMenu();
const items = new Map(menu.items.map((i) => [i.id, i]));
const opts = new Map(menu.groups.flatMap((g) => g.opts.map((o) => [o.id, o])));

function connect() {
  const ws = new WebSocket(relay.replace(/^http/, "ws") + `/api/${store}/till`, { headers: { authorization: proofFor(store) } });
  const say = (o) => ws.send(JSON.stringify(o));
  ws.addEventListener("open", () => {
    console.log("till: connected");
    say({ t: "menu", menu });
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return; // the answer to the beat below, not a message
    const m = JSON.parse(e.data);
    if (m.t === "hello") console.log(`till: the relay has ${m.waiting} waiting`);
    else if (m.t === "menu.ok") {
      console.log(`till: menu published, ${m.items} dishes, ${m.tables} tables`);
      for (const t of menu.tables) console.log(`  ${t.name}: ${relay}/${store}/${t.c}`);
    } else if (m.t === "order") {
      const o = m.order;
      console.log(`till: order ${o.id} for ${menu.tables.find((t) => t.c === o.table)?.name}`);
      for (const l of o.lines) console.log(`  ${l.qty} x ${items.get(l.item)?.name}${l.mods.length ? " (" + l.mods.map((x) => opts.get(x)?.name).join(", ") + ")" : ""}${l.note ? " — " + l.note : ""}`);
      if (after === null) return;
      const no = o.lines.some((l) => /decline/i.test(l.note));
      setTimeout(() => say(no ? { t: "answer", id: o.id, status: "declined", reason: "Sorry, the kitchen has just closed." } : { t: "answer", id: o.id, status: "accepted" }), after);
    } else console.log("till:", e.data);
  });
  ws.addEventListener("close", () => { console.log("till: disconnected, trying again in 3 s"); setTimeout(connect, 3000); });
  ws.addEventListener("error", () => { /* close follows */ });
  // keeps the line from being dropped; the relay answers without waking the room
  const beat = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); else clearInterval(beat); }, 30000);
}
connect();
