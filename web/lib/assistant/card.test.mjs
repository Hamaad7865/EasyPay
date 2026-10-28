// card.test.mjs — the assistant's cards drawn as HTML, from a shop's own rows.
// Usage: node web/lib/assistant/card.test.mjs
import assert from "node:assert/strict";
import { CARD_CSS, cardHtml } from "./card.ts";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); } catch (e) { failures++; console.log("FAIL " + name + " " + e.message); }
}

// What a person reads: the tags taken out, the entities read back.
function text(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&rarr;/g, "→").replace(/&middot;/g, "·")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

// Kids Corner's Chemise Long Sleeve
const tile = { name: "Chemise Long Sleeve", price: "Rs 875", category: "Long Sleeve", picture: null, lines: 56, pieces: "120 left" };
const sheet = {
  options: [
    { name: "Colour", keys: [{ value: "Red", on: true, left: null, tone: null }, { value: "Navy Blue", on: false, left: null, tone: null }], more: 3 },
    { name: "Age", keys: [{ value: "0-3m", on: false, left: null, tone: null }, { value: "3-6m", on: true, left: null, tone: null }], more: 0 },
    { name: "Style", keys: [{ value: "stripe", on: true, left: "6 left", tone: "plenty" }, { value: "Plain", on: false, left: "2 left", tone: "few" }, { value: "Colle Mao", on: false, left: "None", tone: "none", isNew: true }], more: 0 },
  ],
  add: "Add Red / 3-6m / stripe",
};
const cards = {
  product: {
    kind: "product", tile, path: "Shirt › Long Sleeve", branch: "Main shop", plain: [],
    options: [
      { name: "Colour", values: [{ value: "Red", lines: 14 }, { value: "Navy Blue", lines: 12 }] },
      { name: "Age", values: [{ value: "0-3m", lines: 20 }, { value: "3-6m", lines: 22 }] },
      { name: "Style", values: [{ value: "stripe", lines: 30 }, { value: "Plain", lines: 26 }] },
    ],
    grids: [{
      title: "Style: stripe", rows: ["Red", "Navy Blue"], cols: ["0-3m", "3-6m"],
      cells: [[{ qty: "4", tone: "plenty", line: "ln_red_03_stripe" }, { qty: "-1", tone: "below", line: "ln_red_36_stripe" }], [{ qty: "0", tone: "none", line: "ln_navy_03_stripe" }, null]],
    }],
  },
  lines: {
    kind: "lines", title: "Lines below zero", more: 12,
    rows: [{ product: "Chemise Long Sleeve", line: "Red / 3-6m / stripe", branch: "Main shop", qty: "-1", tone: "below" }],
  },
  history: {
    kind: "history", product: "Chemise Long Sleeve", line: "Red / 3-6m / stripe", now: "4", more: true,
    rows: [
      { when: "28 Oct 14:02", what: "Sale", qty: "-1", branch: "Main shop", who: "Asha", ref: "Receipt 1043" },
      { when: "1 Oct 09:15", what: "Opening stock", qty: "+5", branch: "Main shop", who: null, ref: null },
    ],
  },
  preview: {
    kind: "preview", title: "Add Red / 3-6m / stripe to Chemise Long Sleeve", business: "Kids Corner",
    readings: [
      { said: "shirt long sleeve", is: "Chemise Long Sleeve", note: "in Shirt › Long Sleeve", isNew: false },
      { said: "striped", is: "stripe", note: "56 lines", isNew: false },
      { said: "colle mao", is: "Colle Mao", note: null, isNew: true },
    ],
    tile, sheet,
    stock: [{ branch: "Main shop", line: "Red / 3-6m / stripe", before: "0", after: "6" }],
    lines: Array.from({ length: 11 }, (_, i) => `Line ${i + 1} renamed`),
    warnings: [{ tone: "amber", text: "Colle Mao is a new spelling." }],
    danger: false, confirm: "Add the line", typeName: null, proposal: "pr_7Hq2", expires: "14:32",
    link: "https://easypaypos.com/backoffice/assistant/p/pr_7Hq2",
  },
  done: { kind: "done", title: "Added Red / 3-6m / stripe", lines: ["Opening stock 6 at Main shop"], tile, sheet },
};
const all = Object.values(cards).map(cardHtml);

check("each kind renders in its own root", () => {
  for (const [kind, card] of Object.entries(cards)) {
    const html = cardHtml(card);
    assert.ok(html.startsWith(`<div class="ep ep-${kind}`), kind);
    assert.ok(html.endsWith("</div>"), kind);
  }
});
check("product: the tile, the path, the options with their counts, the grid", () => {
  const t = text(cardHtml(cards.product));
  for (const s of ["Chemise Long Sleeve", "Rs 875", "56 variants, 120 left", "Shirt › Long Sleeve", "Colour 2", "Red 14", "Navy Blue 12", "Stock at Main shop", "Colour down, Age across", "Style: stripe"]) assert.ok(t.includes(s), s);
});
check("a grid cell is a button that opens its line's history, in its tone", () => {
  const html = cardHtml(cards.product);
  assert.ok(html.includes('<button type="button" class="ep-q ep-q-plenty" data-history="ln_red_03_stripe"'));
  assert.ok(html.includes('class="ep-q ep-q-below" data-history="ln_red_36_stripe"'));
  assert.ok(html.includes('class="ep-q ep-q-none" data-history="ln_navy_03_stripe"'));
  assert.equal((html.match(/data-history=/g) || []).length, 3, "the empty cell has no button");
});
check("a product with fewer than two options lists its lines", () => {
  const plain = { ...cards.product, options: [], grids: [], plain: [{ line: "One size", qty: "3", tone: "few" }] };
  const html = cardHtml(plain);
  assert.ok(text(html).includes("Stock at Main shop One size 3"));
  assert.ok(html.includes("ep-q-few"));
});
check("lines: product, line, branch, qty and how many more", () => {
  const t = text(cardHtml(cards.lines));
  for (const s of ["Lines below zero", "Chemise Long Sleeve", "Red / 3-6m / stripe", "Main shop", "-1", "12 more"]) assert.ok(t.includes(s), s);
  assert.ok(!text(cardHtml({ ...cards.lines, more: 0 })).includes("more"));
});
check("history: now, each move, and older moves", () => {
  const t = text(cardHtml(cards.history));
  for (const s of ["now 4", "28 Oct 14:02", "Sale", "Main shop · Asha · Receipt 1043", "-1", "Opening stock", "+5", "Older moves: ask for more"]) assert.ok(t.includes(s), s);
  assert.ok(!text(cardHtml({ ...cards.history, more: false })).includes("Older moves"));
});
check("preview: what was read, the tablet, the stock, the changes, the buttons", () => {
  const html = cardHtml(cards.preview);
  const t = text(html);
  for (const s of ["Kids Corner", "I read this as", '"striped" → stripe 56 lines', "Colle Mao New", "On the tablet", "Add Red / 3-6m / stripe", "6 left", "Red / 3-6m / stripe Main shop 0 → 6", "Line 8 renamed", "3 more", "Colle Mao is a new spelling.", "Cancel", "Add the line", "Waits for you until 14:32. Or confirm in the back office:"]) assert.ok(t.includes(s), s);
  assert.ok(html.includes('data-confirm="pr_7Hq2"'));
  assert.ok(html.includes("data-cancel"));
  assert.ok(html.includes('<a href="https://easypaypos.com/backoffice/assistant/p/pr_7Hq2"'));
  assert.ok(html.includes('<span class="ep-key ep-on"><span class="ep-key-v">Red</span>'), "the lit key");
  assert.ok(html.includes("ep-key-new"), "the new value's key");
  assert.ok(html.includes('class="ep-warn ep-warn-amber"'));
  assert.ok(!html.includes("ep-danger") && !html.includes("ep-confirm-red"));
  assert.ok(/<details class="ep-fold"><summary>3 more<\/summary><ul class="ep-bullets"><li>Line 9 renamed/.test(html), "lines past eight are folded");
  assert.ok(!html.includes("data-type-name"));
});
check("a danger preview is red, and Confirm with it", () => {
  const html = cardHtml({ ...cards.preview, danger: true, confirm: "Delete 284 lines, 582 pieces", warnings: [{ tone: "red", text: "Tablets lose these at their next sync." }] });
  assert.ok(html.startsWith('<div class="ep ep-preview ep-danger"'));
  assert.ok(html.includes('<button type="button" class="ep-btn ep-confirm ep-confirm-red" data-confirm="pr_7Hq2">Delete 284 lines, 582 pieces</button>'));
  assert.ok(html.includes('class="ep-warn ep-warn-red"'));
});
check("typing the business's name makes the input", () => {
  const html = cardHtml({ ...cards.preview, danger: true, typeName: "Kids Corner" });
  assert.ok(html.includes('data-type-name="Kids Corner"'));
  assert.ok(html.includes('placeholder="Type Kids Corner to confirm"'));
});
check("done: the check, the title, the lines, the tablet as it now is", () => {
  const html = cardHtml(cards.done);
  assert.ok(html.includes('class="ep-check"'));
  for (const s of ["Added Red / 3-6m / stripe", "Opening stock 6 at Main shop", "On the tablet now", "Chemise Long Sleeve"]) assert.ok(text(html).includes(s), s);
});
check("a name with a script in it comes out as text", () => {
  const evil = `<script>alert(1)</script> & "Co" 'x'`;
  const t2 = { ...tile, name: evil, category: evil, picture: "javascript:alert(1)" };
  const outs = [
    cardHtml({ ...cards.product, tile: t2, path: evil, grids: [{ ...cards.product.grids[0], rows: [evil, "Navy Blue"], cells: [[{ qty: evil, tone: "few", line: `"><script>x</script>` }, null], [null, null]] }] }),
    cardHtml({ ...cards.lines, title: evil, rows: [{ ...cards.lines.rows[0], product: evil }] }),
    cardHtml({ ...cards.history, product: evil, rows: [{ ...cards.history.rows[0], who: evil }] }),
    cardHtml({ ...cards.preview, title: evil, business: evil, tile: t2, typeName: evil, proposal: `"><script>`, link: "javascript:alert(1)", readings: [{ said: evil, is: evil, note: evil, isNew: true }] }),
    cardHtml({ ...cards.done, title: evil, tile: t2 }),
  ];
  for (const html of outs) {
    assert.ok(!/<script/i.test(html), "no raw script tag");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot; &#39;x&#39;"));
    assert.ok(!html.includes("javascript:alert(1)\""), "no javascript: link or picture");
  }
  assert.ok(!outs[3].includes('href="javascript'));
});
check("none of the sample cards carries a script", () => {
  for (const html of all) assert.ok(!/<script/i.test(html));
});
check("the stylesheet is on .ep, light and dark", () => {
  assert.ok(CARD_CSS.includes(".ep{--ep-"));
  assert.ok(/@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\) \.ep\{--ep-/.test(CARD_CSS));
  assert.ok(CARD_CSS.includes('[data-theme="dark"] .ep'));
  assert.ok(CARD_CSS.includes("--ep-green:#2BD48A") && CARD_CSS.includes("--ep-green-ink:#052A1B"));
  assert.ok(!/@import|url\(/.test(CARD_CSS), "no outside fonts or pictures");
});

console.log(failures === 0 ? "CARD PASS" : `CARD FAIL (${failures})`);
process.exit(failures ? 1 : 0);
