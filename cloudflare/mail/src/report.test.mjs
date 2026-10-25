// node --test cloudflare/mail/src/report.test.mjs
//
// The report and its PDF, made from test/z-parts.json: the parts of a day
// closing as the till lays its paper out (ZMailRulesTest on the till writes
// and holds that file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { readParts, partsOfLines, shape, said, reportHtml } from "./report.js";
import { reportPdf, base64, winAnsi } from "./pdf.js";
import { readZ, zMail, zFile } from "./rules.js";

const example = JSON.parse(readFileSync(new URL("../test/z-parts.json", import.meta.url), "utf8"));
const parts = readParts(example);
const names = { business: "Chez Ravi", till: "Till 1", date: "24/10/2026 15:06" };

test("the till's parts are read, and what is not one of them is refused", () => {
  assert.equal(parts.length, example.length);
  assert.deepEqual(parts[0], { k: "center", l: "Chez Ravi", r: "", b: false, s: "big" });
  assert.equal(readParts([{ k: "script", l: "x" }]), null);
  assert.equal(readParts("x"), null);
  assert.equal(readParts([]), null);
  assert.equal(readParts(Array(401).fill({ k: "rule" })), null);
  assert.equal(readParts([{ k: "row", l: "a\u0007b", r: "x".repeat(300), s: "huge" }])[0].r.length, 100);
});

test("words in capitals read as words in a report", () => {
  assert.equal(said("BY PAYMENT METHOD"), "By payment method");
  assert.equal(said("DAY CLOSING (Z) No. 12"), "Day closing (Z) No. 12");
  assert.equal(said("TOTAL"), "Total");
  assert.equal(said("Cash in"), "Cash in");
});

test("the report's shape: the business's lines, the title, the details, the total, the sections", () => {
  const r = shape(parts);
  assert.equal(r.test, false);
  assert.deepEqual(r.header, ["Royal Road, Curepipe", "Tel: 5 123 4567", "BRN: C12345678", "VAT: VAT27000000"]);
  assert.equal(r.title, "Day closing (Z) No. 12");
  assert.deepEqual(r.meta[0], { l: "Opened", r: "24/10/2026 04:00" });
  assert.ok(!r.meta.some((m) => m.l === "Till"));
  assert.ok(r.meta.some((m) => m.l === "First bill" && m.r === "CT-T1-000101"));
  assert.deepEqual(r.total, { l: "Total", r: "Rs 18,400.00", b: true, big: true });
  assert.deepEqual(r.sections.map((s) => s.title), ["", "By payment method", "By category", "Tax", "Cash in and out", "Cash drawer"]);
  const drawer = r.sections.at(-1).items;
  assert.ok(drawer.some((i) => i.l === "Short" && i.r === "-50.00" && i.b));
  assert.ok(r.sections[3].items.some((i) => i.l === "VAT 15%"));
  assert.equal(r.signature, true);
  assert.ok(!r.sections.some((s) => s.items.some((i) => /^Signature/.test(i.l))));
});

test("a tablet that is setting up: the TEST mark is the report's, not a line of it", () => {
  const r = shape([{ k: "center", l: "TEST, NOT A RECEIPT", b: true }, ...parts, { k: "center", l: "TEST, NOT A RECEIPT", b: true }]);
  assert.equal(r.test, true);
  assert.ok(!JSON.stringify(r.sections).includes("TEST, NOT"));
});

test("the report's HTML escapes what the till sent and links to stop", () => {
  const evil = parts.map((p) => (p.l.startsWith("Cash (") ? { ...p, l: "<img src=x onerror=alert(1)>" } : p));
  const html = reportHtml(shape(evil), { ...names, business: "Ravi & <Sons>" }, "https://mail.easypaypos.com/s/abc", true);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("Ravi &amp; &lt;Sons&gt;"));
  assert.ok(html.includes("Rs 18,400.00"));
  assert.ok(html.includes("By payment method"));
  assert.ok(html.includes("The same report is attached as a PDF."));
  assert.ok(html.includes('href="https://mail.easypaypos.com/s/abc"'));
  assert.ok(!reportHtml(shape(parts), names, "s").includes("attached as a PDF"));
});

test("the PDF is one A4 page of the same report", async () => {
  const bytes = await reportPdf(shape(parts), names);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  const [w, h] = doc.getPage(0).getSize().width ? [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()] : [0, 0];
  assert.equal(Math.round(w), 595);
  assert.equal(Math.round(h), 842);
  assert.equal(doc.getTitle(), "Day closing (Z) No. 12 · Chez Ravi · Till 1");
  assert.ok(bytes.length < 60000, `a small file: ${bytes.length} bytes`);
});

test("a long report goes on as many pages as it takes, each with its foot", async () => {
  const many = [...parts.slice(0, 20), { k: "rule" }, { k: "text", l: "BY CATEGORY", b: true }, ...Array.from({ length: 120 }, (_, i) => ({ k: "row", l: `Category ${i}`, r: `${i}.00`, b: false, s: "normal" }))];
  const doc = await PDFDocument.load(await reportPdf(shape(many), names));
  assert.ok(doc.getPageCount() >= 3, `pages: ${doc.getPageCount()}`);
});

test("what Helvetica cannot write is written without its accent, or as ?", () => {
  assert.equal(winAnsi("Crevettes sautées à l'ail · €5"), "Crevettes sautées à l'ail · €5");
  assert.equal(winAnsi("Đồng ŝ 中"), "Đong s ?".replace("Đ", "?"));
});

test("the mail carries the report, the paper's text and the PDF, named for the closing", async () => {
  const report = readZ({ to: "o@x.mu", key: "a".repeat(64), id: "0190f1c2-aaaa-7bbb", number: 12, date: "24/10/2026 15:06", lines: ["DAY CLOSING (Z) No. 12"], parts: example, business: "Chez Ravi", till: "Till 1" });
  assert.equal(report.parts.length, example.length);
  const pdf = await reportPdf(shape(report.parts), report);
  const m = zMail(report, "https://mail.easypaypos.com/s/abc", pdf);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, "Z-report-12-Till-1-2026-10-24.pdf");
  assert.equal(m.attachments[0].type, "application/pdf");
  // the file goes as its bytes (the binding takes a string as the file's own text); base64 only for wrangler's stand-in
  assert.ok(m.attachments[0].content instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(m.attachments[0].content.slice(0, 5)), "%PDF-");
  assert.ok(atob(base64(pdf)).startsWith("%PDF-"));
  assert.ok(m.text.startsWith("DAY CLOSING (Z) No. 12\n"));
  assert.ok(m.text.includes("attached as a PDF"));
  assert.ok(m.html.includes("Rs 18,400.00"));
  // without a PDF the mail still goes, saying nothing of one
  assert.equal(zMail(report, "s").attachments, undefined);
  // a till that sent no parts: the report is made from its paper's lines
  const plain = readZ({ to: "o@x.mu", key: "a".repeat(64), id: "0190f1c2-aaaa-7bbb", number: 3, lines: ["Demo", "-".repeat(48), "Sales   1.00"], business: "B" });
  assert.equal(plain.parts, null);
  assert.ok(zMail(plain, "s").html.includes("Sales   1.00"));
  assert.deepEqual(partsOfLines(["-".repeat(20)])[0].k, "rule");
  assert.equal(zFile({ number: 7, till: "Bar / Terrasse", date: "" }), "Z-report-7-Bar-Terrasse.pdf");
});
