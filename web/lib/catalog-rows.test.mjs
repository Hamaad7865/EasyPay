// catalog-rows.test.mjs — a catalog file's cells as rows for the database
// (web/lib/catalog-rows.ts), with the real file reader and the real money reader.
// Usage: node web/lib/catalog-rows.test.mjs   (Node runs the .ts files itself)
import assert from "node:assert/strict";
import { toCatalogRows } from "./catalog-rows.ts";
import { parseCsv } from "./csv.ts";
import { parseRs } from "./money.ts";

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
const read = (text) => toCatalogRows(parseCsv(text), parseRs);

check("the template's columns, with money in cents and quantities in thousandths", () => {
  const { rows, unknown, noName } = read(
    "Name,Category,Brand,Supplier,Supplier code,Option 1,Value 1,Option 2,Value 2,Option 3,Value 3,SKU,Barcode,Price,Cost,Tax,Reorder at,Order quantity,Opening stock\n" +
      'Linen shirt,Clothing,Atelier Sud,Textiles Ocean,TO-LS,Size,M,Colour,White,,,LS-M-WH,5901234123457,"1,290.00",620,VAT,6,12,14\n',
  );
  assert.equal(noName, false);
  assert.deepEqual(unknown, []);
  assert.deepEqual(rows, [{
    n: 2, name: "Linen shirt", category: "Clothing", brand: "Atelier Sud", supplier: "Textiles Ocean", supplier_code: "TO-LS",
    o1: "Size", v1: "M", o2: "Colour", v2: "White", sku: "LS-M-WH", barcode: "5901234123457",
    price: 129000, cost: 62000, tax: "VAT", reorder: 6000, order_qty: 12000, stock: 14000,
  }]);
});
check("headers in other spellings, and in any order", () => {
  const { rows } = read("selling price;PRODUCT;Supplier's code;In stock;option 1 name;Option1Value\nRs 320;Mug;M-1;2.5;Colour;Blue\n");
  assert.deepEqual(rows, [{ n: 2, price: 32000, name: "Mug", supplier_code: "M-1", stock: 2500, o1: "Colour", v1: "Blue" }]);
});
check("a row's number is its line in the file, and empty rows are skipped", () => {
  const { rows } = read("Name,Price\nMug,320\n,\n\nBowl,450\n");
  assert.deepEqual(rows.map((r) => [r.n, r.name]), [[2, "Mug"], [5, "Bowl"]]);
});
check("a price that is not a number marks the row, and so does a quantity", () => {
  const { rows } = read("Name,Price,Cost,Opening stock\nMug,abc,,\nBowl,450,x,\nCup,100,,-3\nJug,12,50,\nPot,\"12,50\",,\n");
  assert.equal(rows[0].bad, "price-missing");
  assert.equal(rows[1].bad, "bad-number");
  assert.equal(rows[2].bad, "bad-number");
  assert.equal(rows[3].bad, undefined);
  assert.equal(rows[4].bad, "price-missing"); // twelve fifty the French way is not read as 1,250
});
check("an empty price is left for the database to name", () => {
  const { rows } = read("Name,Price\nMug,\n");
  assert.deepEqual(rows, [{ n: 2, name: "Mug" }]);
});
check("a column the importer does not know is reported, and a file with no Name is not a catalog", () => {
  const a = read("Name,Price,Colour of the box\nMug,320,red\n");
  assert.deepEqual(a.unknown, ["Colour of the box"]);
  assert.equal(a.rows[0].name, "Mug");
  assert.equal(read("Item,Amount\nMug,320\n").noName, true);
});

console.log(failures === 0 ? "CATALOG ROWS PASS" : `CATALOG ROWS FAIL (${failures})`);
process.exit(failures ? 1 : 0);
