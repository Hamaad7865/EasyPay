// nav.test.mjs — the back office's menu: which pages a restaurant and a shop
// have, and which line is lit for an address (web/app/backoffice/nav.ts).
// Usage: node web/lib/nav.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { GROUPS, groupOf, groupsFor, isOn, pagesOf } from "../app/backoffice/nav.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + (e && e.message ? e.message.split("\n")[0] : e));
  }
}
const hrefs = (mode) => groupsFor(mode).flatMap((g) => g.links.map((l) => l.href));
const lit = (mode, path) => groupsFor(mode).flatMap((g) => g.links).filter((l) => isOn(l.href, path)).map((l) => l.label);

check("a shop has Barcode labels in its Catalog, after Products; a restaurant has no such line", () => {
  const catalog = groupsFor("retail").find((g) => g.links.some((l) => l.href === "/backoffice/items"));
  const labels = catalog.links.map((l) => l.label);
  assert.equal(catalog.title, "Catalog");
  assert.equal(labels[labels.indexOf("Products") + 1], "Barcode labels");
  assert.ok(!hrefs("restaurant").includes("/backoffice/items/labels"));
});
check("on Barcode labels only Barcode labels is lit, not Products above it", () => {
  assert.deepEqual(lit("retail", "/backoffice/items/labels"), ["Barcode labels"]);
});
check("on the products list, a product's own page and the import, Products is lit", () => {
  assert.deepEqual(lit("retail", "/backoffice/items"), ["Products"]);
  assert.deepEqual(lit("retail", "/backoffice/items/0b0e6f0e-1111-4222-8333-444455556666"), ["Products"]);
  assert.deepEqual(lit("retail", "/backoffice/items/import"), ["Products"]);
});
check("a page under another keeps its parent lit when it has no line of its own", () => {
  assert.deepEqual(lit("retail", "/backoffice/purchase-orders/receive"), ["Purchase orders"]);
  assert.deepEqual(lit("retail", "/backoffice/stock-counts/abc"), ["Counts"]);
  assert.deepEqual(lit("restaurant", "/backoffice/tables/plan"), ["Tables"]);
});
check("pages whose addresses begin alike do not light each other", () => {
  assert.deepEqual(lit("retail", "/backoffice/stock"), ["Stock on hand"]);
  assert.deepEqual(lit("retail", "/backoffice/stock-movements"), ["Movements"]);
  assert.deepEqual(lit("retail", "/backoffice/reports/stock"), ["Stock reports"]);
});
check("the dashboard is lit on the dashboard alone", () => {
  assert.ok(isOn("/backoffice", "/backoffice"));
  assert.ok(!isOn("/backoffice", "/backoffice/items"));
});
check("every address in the menu lights exactly one line for the business that has it", () => {
  for (const mode of ["restaurant", "retail"]) {
    for (const href of hrefs(mode)) assert.equal(lit(mode, href).length, 1, mode + " " + href + ": " + lit(mode, href).join());
  }
});
check("the group that opens for Barcode labels is the catalog's, and the search lists the page for a shop only", () => {
  const catalog = GROUPS.find((g) => g.links.some((l) => l.href === "/backoffice/items")).id;
  assert.equal(groupOf("/backoffice/items/labels", "retail"), catalog);
  assert.ok(pagesOf("retail").some((p) => p.label === "Barcode labels"));
  assert.ok(!pagesOf("restaurant").some((p) => p.label === "Barcode labels"));
});

console.log(failures === 0 ? "NAV PASS" : `NAV FAIL (${failures})`);
process.exit(failures ? 1 : 0);
