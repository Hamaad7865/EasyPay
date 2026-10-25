// node cloudflare/mail/test/flow.mjs
//
// The whole exchange, asserted, against the Worker running on this PC under
// `wrangler dev`, which this starts with a store of its own and stops at the
// end. Nothing is sent: wrangler plays the mail binding and writes each mail
// to a file, and says where; that is how the confirm link is read here, as an
// owner would read it in their mail. Needs wrangler 4.20 or later (the one
// web/ builds with is used when it is there).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const PORT = Number(process.env.PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const own = join(root, ".claude", "cf", "web", "node_modules", "wrangler", "bin", "wrangler.js");
const store = mkdtempSync(join(tmpdir(), "easypay-mail-"));

const args = ["dev", "--config", join(here, "..", "wrangler.toml"), "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", store, "--log-level", "debug", "--var", `SITE:${BASE}`];
const dev = existsSync(own) ? spawn(process.execPath, [own, ...args], { cwd: root }) : spawn("npx", ["--yes", "wrangler@4.117.0", ...args], { cwd: root, shell: true });
let log = "";
// wrangler says where each mail went only at its debug level, in colour: the colour is taken out
const said = (c) => { log += String(c).replace(/\x1b\[[0-9;]*m/g, ""); };
dev.stdout.on("data", said);
dev.stderr.on("data", said);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wrangler's runtime is a process of its own: on Windows the whole tree is stopped, or it stays
const stop = () => {
  try { if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" }); else dev.kill(); } catch { /* gone */ }
  try { rmSync(store, { recursive: true, force: true }); } catch { /* held */ }
};

// the mails wrangler has written so far, each with its text as read from its file
function mails() {
  const out = [];
  const re = /send_email binding called with MessageBuilder:([\s\S]*?)(?=send_email binding called|\n\[wrangler|$)/g;
  for (const m of log.matchAll(re)) {
    const block = m[1];
    const to = /To: (.*)/.exec(block)?.[1]?.trim();
    const subject = /Subject: (.*)/.exec(block)?.[1]?.trim();
    const file = /Text: (.*\.txt)/.exec(block)?.[1]?.trim();
    const page = /HTML: (.*\.html)/.exec(block)?.[1]?.trim();
    out.push({ to, subject, text: file && existsSync(file) ? readFileSync(file, "utf8") : "", html: page && existsSync(page) ? readFileSync(page, "utf8") : "", block });
  }
  return out;
}

const post = async (path, body, raw = false) => {
  const r = await fetch(BASE + path, { method: "POST", headers: raw ? {} : { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: r.status, json, text };
};
const get = async (path) => { const r = await fetch(BASE + path); return { status: r.status, text: await r.text() }; };

const KEY = "0123456789abcdef".repeat(4);
const OTHER = "f".repeat(64);
const TO = "owner@example.mu";
const ask = { to: "Owner@Example.mu", key: KEY, business: "Chez Ravi", till: "Till 1" };
// the parts a till lays its paper out from, as the till itself makes them (ZMailRulesTest holds this file)
const parts = JSON.parse(readFileSync(join(here, "z-parts.json"), "utf8"));
const z = (over = {}) => ({ to: TO, key: KEY, id: "0190f1c2aaaa7bbb0001", number: 12, date: "25/10/2026 23:10", business: "Chez Ravi", till: "Till 1", test: false, lines: ["DAY CLOSING (Z) No. 12", "Sales                1,250.00", "TOTAL            Rs 1,250.00"], parts, ...over });

let step = 0;
const ok = (what) => console.log(`  ok ${++step}  ${what}`);

try {
  for (let i = 0; i < 120 && !/Ready on/.test(log); i++) await sleep(500);
  if (!/Ready on/.test(log)) throw new Error("wrangler dev did not start:\n" + log.slice(-2000));
  await sleep(500);
  console.log(`easypay-mail under wrangler dev on ${BASE}`);

  assert.deepEqual((await post("/health", {})).status, 404);
  assert.equal((await get("/health")).status, 200);
  ok("it answers /health");

  assert.equal((await post("/v1/ask", "{not json", true)).status, 400);
  assert.equal((await post("/v1/ask", { ...ask, to: "nope" })).status, 400);
  assert.equal((await post("/v1/ask", "x".repeat(70 * 1024), true)).status, 413);
  ok("it refuses what it cannot read, a wrong address and a body too long");

  let r = await post("/v1/ask", ask);
  assert.equal(r.status, 200); assert.equal(r.json.state, "waiting");
  await sleep(300);
  assert.equal(mails().length, 1);
  const first = mails()[0];
  assert.equal(first.to, TO);
  assert.match(first.subject, /^Confirm: Z reports of Chez Ravi to this address$/);
  const confirm = /Confirm: (http\S+\/c\/[a-z2-7]{24})/.exec(first.text)?.[1];
  assert.ok(confirm, "the confirm link is in the mail:\n" + first.text);
  assert.ok(confirm.startsWith(BASE + "/c/"), "the link is to the service's own address (SITE): " + confirm);
  ok("an ask mails the address once, to confirm, with a link");

  r = await post("/v1/ask", ask);
  assert.equal(r.json.state, "waiting"); await sleep(200);
  assert.equal(mails().length, 1);
  ok("asking again within ten minutes mails nothing more");

  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "waiting");
  r = await post("/v1/z", z());
  assert.equal(r.status, 403); assert.equal(r.json.state, "waiting");
  assert.equal(mails().length, 1);
  ok("a report to an address that has not confirmed is refused, and nothing is mailed");

  const path = new URL(confirm).pathname;
  let p = await get(path);
  assert.equal(p.status, 200); assert.match(p.text, /<form method="post">/); assert.match(p.text, /Chez Ravi&#39;s till, Till 1, will send its Z report to owner@example\.mu/);
  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "waiting");
  ok("opening the link shows a Confirm button and confirms nothing (a mail scanner opens links)");

  p = await post(path, "", true);
  assert.equal(p.status, 200); assert.match(p.text, /Confirmed/);
  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "yes");
  assert.equal((await post("/v1/state", { to: TO, key: OTHER })).json.state, "none");
  assert.equal((await get(path)).status, 404);
  ok("pressing Confirm confirms the address for that till's key only, and the link is used up");

  r = await post("/v1/z", z());
  assert.equal(r.status, 200); assert.equal(r.json.sent, true); await sleep(300);
  assert.equal(mails().length, 2);
  const report = mails()[1];
  assert.equal(report.to, TO);
  assert.equal(report.subject, "Z report No. 12 · Chez Ravi · Till 1 · 25/10/2026 23:10");
  assert.ok(report.text.startsWith("DAY CLOSING (Z) No. 12\nSales                1,250.00\nTOTAL            Rs 1,250.00\n"), report.text);
  const stopLink = /Stop these emails: (http\S+\/s\/[a-z2-7]{24})/.exec(report.text)?.[1];
  assert.ok(stopLink);
  // laid out as a report from the till's parts, with the same report as a PDF
  assert.ok(report.text.includes("The same report is attached as a PDF."), report.text);
  assert.ok(report.html.includes("Rs 18,400.00") && report.html.includes("By payment method"), "the report's HTML");
  ok("a report to the confirmed address is mailed as a report with its PDF, the paper's lines as its text, and a link to stop");

  r = await post("/v1/z", z());
  assert.equal(r.status, 200); assert.equal(r.json.sent, true); await sleep(200);
  assert.equal(mails().length, 2);
  ok("the same closing sent again is answered sent and mailed once");

  r = await post("/v1/z", z({ key: OTHER, id: "0190f1c2aaaa7bbb0002" }));
  assert.equal(r.status, 403); assert.equal(r.json.state, "none");
  ok("another key (another till, or someone who read the app) cannot mail that address");

  r = await post("/v1/z", z({ id: "0190f1c2aaaa7bbb0003", number: 13, test: true }));
  assert.equal(r.status, 200); await sleep(200);
  assert.match(mails()[2].subject, /^TEST · Z report No\. 13/);
  ok("a report of a tablet that is setting up says TEST");

  const s = new URL(stopLink).pathname;
  p = await get(s);
  assert.equal(p.status, 200); assert.match(p.text, /Stop these emails\?/);
  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "yes");
  p = await post(s, "List-Unsubscribe=One-Click", true);
  assert.equal(p.status, 200); assert.match(p.text, /Stopped/);
  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "none");
  r = await post("/v1/z", z({ id: "0190f1c2aaaa7bbb0004", number: 14 }));
  assert.equal(r.status, 403); assert.equal(r.json.state, "none");
  ok("the stop link at a report's foot stops them (its button, or a mail client's one click)");

  r = await post("/v1/ask", ask);
  assert.equal(r.json.state, "waiting"); await sleep(200);
  assert.equal(mails().length, 4);
  assert.equal((await post("/v1/stop", { to: TO, key: KEY })).json.state, "none");
  assert.equal((await post("/v1/state", { to: TO, key: KEY })).json.state, "none");
  ok("the till can ask again, and its setting switched off forgets the ask");

  r = await post("/v1/ask", ask); assert.equal(r.status, 200); await sleep(200);
  assert.equal(mails().length, 5);
  await post("/v1/stop", { to: TO, key: KEY });
  r = await post("/v1/ask", ask);
  assert.equal(r.status, 429); await sleep(200);
  assert.equal(mails().length, 5);
  ok("an address gets three mails to confirm a day at most");

  console.log(`\nAll ${step} steps passed.`);
  stop();
  process.exit(0);
} catch (e) {
  console.log(`\nFAILED at step ${step + 1}: ${e.message}\n--- wrangler said ---\n${log.slice(-3000)}`);
  stop();
  process.exit(1);
}
