// catalog-rows.test.mjs — a catalog file's cells as rows for the database
// (web/lib/catalog-rows.ts), with the real file reader and the real money reader.
// Usage: node web/lib/catalog-rows.test.mjs   (Node runs the .ts files itself)
import assert from "node:assert/strict";
import { autoMap, headerRow, mappingProblem, toCatalogRows } from "./catalog-rows.ts";
import { parseCsv } from "./csv.ts";
import { parseRs } from "./money.ts";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
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
  assert.equal(read("Thing,Amount\nMug,320\n").noName, true);
});

// ---- a supplier's own sheet: its headers matched, and matched by hand ----
check("a supplier's headers are matched to what they are, in English or in French, with or without accents", () => {
  assert.deepEqual(autoMap(["Item", "Retail price", "Qty", "EAN", "Dept", "Make", "Buy price"]), ["name", "price", "stock", "barcode", null, "brand", "cost"]);
  assert.deepEqual(autoMap(["Désignation", "Prix de vente", "Catégorie", "Code-barres", "Quantité", "Fournisseur", "TVA"]), ["name", "price", "category", "barcode", "stock", "supplier", "tax"]);
  assert.deepEqual(autoMap(["", "  ", "Notes"]), [null, null, null]);
});
check("a kind of column is given to one header only: the first", () => {
  assert.deepEqual(autoMap(["Name", "Price", "Retail price", "Product"]), ["name", "price", null, null]);
});
check("columns headed Size and Colour are options named after themselves, three at most", () => {
  assert.deepEqual(autoMap(["Name", "Size", "Colour", "Price"]), ["name", "option", "option", "price"]);
  assert.deepEqual(autoMap(["Size", "Color", "Taille", "Couleur"]), ["option", "option", "option", null]);
});
check("an option column gives the row an option by the column's name, and nothing when its cell is empty", () => {
  const { rows } = read("Name,Size,Colour,Price\nShirt,M,White,1290\nShirt,L,White,1290\nMug,,Blue,320\nBowl,,,450\n");
  assert.deepEqual(rows, [
    { n: 2, name: "Shirt", o1: "Size", v1: "M", o2: "Colour", v2: "White", price: 129000 },
    { n: 3, name: "Shirt", o1: "Size", v1: "L", o2: "Colour", v2: "White", price: 129000 },
    { n: 4, name: "Mug", o1: "Colour", v1: "Blue", price: 32000 },
    { n: 5, name: "Bowl", price: 45000 },
  ]);
});
check("what each column is can be said by hand, and that is what is read", () => {
  const cells = parseCsv("Ref,Libellé,Tarif,Stk,Matière\nA-1,Scarf,590,6,Wool\n");
  assert.deepEqual(autoMap(cells[0]), ["sku", "name", null, null, null]);
  const { rows, unknown, noName } = toCatalogRows(cells, parseRs, ["sku", "name", "price", "stock", "option"]);
  assert.deepEqual(rows, [{ n: 2, sku: "A-1", name: "Scarf", price: 59000, stock: 6000, o1: "Matière", v1: "Wool" }]);
  assert.deepEqual(unknown, []);
  assert.equal(noName, false);
  // a column set to nothing is not read, and is named
  assert.deepEqual(toCatalogRows(cells, parseRs, ["sku", "name", "price", null, null]).unknown, ["Stk", "Matière"]);
});
check("options named after columns go after the file's own Option columns, and a fourth marks the row", () => {
  const cells = parseCsv("Name,Option 1,Value 1,Size,Colour,Fit,Price\nShirt,Fabric,Linen,M,White,,1290\nShirt,Fabric,Linen,M,White,Slim,1290\n");
  const { rows } = toCatalogRows(cells, parseRs, ["name", "o1", "v1", "option", "option", "option", "price"]);
  assert.deepEqual(rows[0], { n: 2, name: "Shirt", o1: "Fabric", v1: "Linen", o2: "Size", v2: "M", o3: "Colour", v3: "White", price: 129000 });
  assert.equal(rows[1].bad, "bad-options");
});
check("a mapping that cannot be used says why, in words", () => {
  assert.equal(mappingProblem(["name", "price"]), null);
  assert.equal(mappingProblem(["name", null]), "Say which column holds the selling price.");
  assert.equal(mappingProblem([null, "sku"]), "Say which column holds the product name and the selling price.");
  assert.equal(mappingProblem(["name", "price", "price"]), "Two columns are set to selling price. Keep one.");
  assert.equal(mappingProblem(["name", "price", "option", "option", "option", "option"]), "A product has three options at most. Set fewer columns as options.");
});
check("the headers are on the first row that is not empty, and a row's number is still its line in the file", () => {
  const { rows, header } = toCatalogRows([[], ["", ""], ["Name", "Price"], ["Mug", "320"], [], ["Bowl", "450"]], parseRs);
  assert.deepEqual(header, ["Name", "Price"]);
  assert.deepEqual(rows.map((r) => [r.n, r.name]), [[4, "Mug"], [6, "Bowl"]]);
  assert.equal(headerRow([[], ["Name"]]), 1);
});
check("a quantity written 1,200 is twelve hundred; one written 2,5 is not guessed at", () => {
  const { rows } = read('Name,Price,Opening stock\nMug,320,"1,200"\nRice,80,"2,5"\nTea,195,0.5\nSalt,20,"12,345,678.5"\n');
  assert.equal(rows[0].stock, 1200000);
  assert.equal(rows[1].bad, "bad-number");
  assert.equal(rows[2].stock, 500);
  assert.equal(rows[3].stock, 12345678500);
});

// ---- the same catalog as an Excel workbook and as a CSV file ----
await check("an Excel workbook gives the rows its CSV twin gives", async () => {
  const { readFileSync } = await import("node:fs");
  const { readXlsx } = await import("./xlsx.ts");
  const book = await readXlsx(new Uint8Array(readFileSync(new URL("./fixtures/import-sample.xlsx", import.meta.url))));
  const twin =
    "Name,Category,Size,Colour,SKU,Barcode,Price,Cost,Opening stock,Notes\n" +
    "Linen shirt,Clothing,M,White,LS-M-WH,2000000003016,1290,620,14,a\n" +
    "Linen shirt,Clothing,L,Navy,LS-L-NV,0012345678905,1290,620,3,b\n" +
    'Crème brûlée dish,Home & Kitchen,,,CB-1,5901234123457,115,80.3,"1,200",c\n' +
    "\n" +
    '"Tea <strong> & ""quotes""",Food,,,,,195,,0.5,d\n';
  const fromExcel = toCatalogRows(book.cells, parseRs), fromCsv = read(twin);
  assert.deepEqual(fromExcel.rows, fromCsv.rows);
  assert.deepEqual(fromExcel.unknown, ["Notes"]);
  assert.deepEqual(fromExcel.rows[1], { n: 3, name: "Linen shirt", category: "Clothing", o1: "Size", v1: "L", o2: "Colour", v2: "Navy", sku: "LS-L-NV", barcode: "0012345678905", price: 129000, cost: 62000, stock: 3000 });
  assert.deepEqual(fromExcel.rows[2], { n: 4, name: "Crème brûlée dish", category: "Home & Kitchen", sku: "CB-1", barcode: "5901234123457", price: 11500, cost: 8030, stock: 1200000 });
  assert.equal(fromExcel.rows[3].n, 6);
});

console.log(failures === 0 ? "CATALOG ROWS PASS" : `CATALOG ROWS FAIL (${failures})`);
// the exit code is set and node is left to end by itself: process.exit() here has crashed node on Windows while it was closing down, after every check had passed
process.exitCode = failures ? 1 : 0;
