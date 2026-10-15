// papers.test.mjs — the preview on Receipt design prints what the till prints
// (web/lib/papers.ts against the shared examples in db/tests/fixtures/papers,
// which the till's PapersFixtureTest reads too).
// Usage: node web/lib/papers.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EASYPAY, compact, readDesign, renderKitchen, renderReceipt, sampleKitchen, sampleReceipt } from "./papers.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "tests", "fixtures", "papers");
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + e.message);
  }
}
const load = (f) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

check("EasyPay's designs are the two files", () => {
  assert.deepEqual(readDesign("receipt", load("default-receipt.json"), false), { design: EASYPAY.receipt, fellBack: false });
  assert.deepEqual(readDesign("kitchen", load("default-kitchen.json"), false), { design: EASYPAY.kitchen, fellBack: false });
  assert.deepEqual(compact("receipt", EASYPAY.receipt), load("default-receipt.json"));
});

const examples = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("default-")).sort();
check("the examples are there", () => assert.ok(examples.length >= 19));
for (const f of examples) {
  check(f + " prints the lines it expects", () => {
    const x = load(f);
    const shop = x.shop;
    const got =
      x.paper === "kitchen"
        ? renderKitchen(readDesign("kitchen", x.design, false).design, x.doc, x.columns)
        : renderReceipt(readDesign("receipt", x.design, shop.bars).design, x.doc, shop, x.columns, x.decimals);
    const want = x.expect.map((s) => ({ t: s.t, size: s.size, bold: s.bold, align: s.align, ...(s.bars ? { bars: s.bars } : {}) }));
    assert.deepEqual(got, want);
  });
}

const locked = [{ k: "title" }, { k: "items" }, { k: "total" }];
check("what is not a design of this version prints EasyPay's, and says it could not be read", () => {
  assert.deepEqual(readDesign("receipt", undefined, false), { design: EASYPAY.receipt, fellBack: false });
  for (const raw of ["x", [], { v: 2, blocks: locked }, { v: "1", blocks: locked }, { v: 1, blocks: {} }])
    assert.deepEqual(readDesign("receipt", raw, false), { design: EASYPAY.receipt, fellBack: true });
});
check("a locked block missing or hidden prints EasyPay's, a shop's barcode included", () => {
  assert.equal(readDesign("receipt", { v: 1, blocks: [{ k: "title" }, { k: "items" }] }, false).fellBack, true);
  assert.equal(readDesign("receipt", { v: 1, blocks: [{ k: "title" }, { k: "items", hide: true }, { k: "total" }] }, false).fellBack, true);
  assert.equal(readDesign("receipt", { v: 1, blocks: locked }, true).fellBack, true);
  assert.equal(readDesign("receipt", { v: 1, blocks: [...locked, { k: "barcode" }] }, true).design.blocks.length, 4);
});
check("an unknown kind and a second of a kind that is there once are skipped; a setting not understood takes the kind's own", () => {
  const d = readDesign("receipt", { v: 1, blocks: [{ k: "hologram" }, ...locked, { k: "title", bold: false }, { k: "name", size: "huge", bold: "yes" }, { k: "space", n: 9 }, { k: "line", ch: "*" }, { k: "text", text: "x".repeat(310) }, 7] }, false).design;
  assert.deepEqual(d.blocks.map((b) => b.k), ["title", "items", "total", "name", "space", "line", "text"]);
  assert.equal(d.blocks[0].bold, true);
  assert.equal(d.blocks[3].size, "big");
  assert.equal(d.blocks[3].bold, false);
  assert.equal(d.blocks[4].n, 1);
  assert.equal(d.blocks[5].ch, "-");
  assert.equal(d.blocks[6].text.length, 300);
});
check("sixty blocks at most", () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ k: "text", text: String(i) }));
  assert.equal(readDesign("receipt", { v: 1, blocks: [...many, ...locked] }, false).fellBack, true);
  assert.equal(readDesign("receipt", { v: 1, blocks: [...locked, ...many] }, false).design.blocks.length, 60);
});
check("a design kept is only what differs, and reads back the same", () => {
  const d = readDesign("receipt", { v: 1, blocks: [...locked, { k: "items", addons: "rows" }] }, false).design;
  d.blocks[1] = { ...d.blocks[1], addonPrices: true, unitPrice: true };
  const kept = compact("receipt", d);
  assert.deepEqual(kept.blocks[1], { k: "items", addonPrices: true, unitPrice: true });
  assert.deepEqual(readDesign("receipt", kept, false).design, d);
});
check("the preview's made-up orders print on both widths", () => {
  const shop = { name: "CafeTino", address: "", phone: "", brn: "", vat: "", header: "", footer: "Thank you", bars: false };
  const r = renderReceipt(EASYPAY.receipt, sampleReceipt("receipt", true, false, 1790000000000), shop, 32, 2);
  assert.ok(r.some((l) => l.t === "CUSTOMER No. 05" && l.size === "big"));
  assert.ok(r.some((l) => l.t.startsWith("TOTAL")));
  const b = renderReceipt(EASYPAY.receipt, sampleReceipt("bill", false, false, 1790000000000), shop, 48, 2);
  assert.ok(b.some((l) => l.t === "This is not a receipt"));
  const k = renderKitchen(EASYPAY.kitchen, sampleKitchen(true, 1790000000000), 48);
  assert.equal(k[1].t, "No. 05");
});

if (failures > 0) {
  console.log(failures + " failed");
  process.exit(1);
}
console.log("all passed");
