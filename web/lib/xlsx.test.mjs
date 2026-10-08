// xlsx.test.mjs — an Excel workbook as rows of cells, and back (web/lib/xlsx.ts).
// fixtures/import-sample.xlsx was written by SheetJS 0.20.3, the library a
// spreadsheet import is usually built on, so the reader is checked against a
// file it did not make: two sheets, compressed, shared strings, a barcode in
// a number cell shown as 2.00E+12, one in a text cell with a zero in front,
// a quantity shown as 1,200, a price with the last digit's noise, an empty
// row, a boolean, and two formulas.
// Usage: node web/lib/xlsx.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readXlsx, writeXlsx, zipStored } from "./xlsx.ts";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + (e && e.message ? e.message.split("\n").slice(0, 3).join(" | ") : e));
  }
}
const sample = new Uint8Array(readFileSync(new URL("./fixtures/import-sample.xlsx", import.meta.url)));
const fails = async (fn) => { try { await fn(); return "read"; } catch (e) { return e.message; } };

await check("the first sheet is read, and the others are named", async () => {
  const { sheets, cells } = await readXlsx(sample);
  assert.deepEqual(sheets, ["Products", "Notes"]);
  assert.deepEqual(cells[0], ["Name", "Category", "Size", "Colour", "SKU", "Barcode", "Price", "Cost", "Opening stock", "Notes"]);
  assert.equal(cells.length, 6);
});
await check("a barcode in a number cell is its digits, however the sheet shows it; one typed as text keeps its zero", async () => {
  const { cells } = await readXlsx(sample);
  assert.equal(cells[1][5], "2000000003016");
  assert.equal(cells[2][5], "0012345678905");
  assert.equal(cells[3][5], "5901234123457");
});
await check("a number is the number, not what the sheet shows: 1,200 is 1200, and the last digit's noise is gone", async () => {
  const { cells } = await readXlsx(sample);
  assert.equal(cells[3][8], "1200");
  assert.equal(cells[3][6], "115");
  assert.equal(cells[3][7], "80.3");
  assert.equal(cells[5][8], "0.5");
  assert.equal(cells[1][6], "1290");
});
await check("text is as it was typed: accents, an ampersand, angle brackets and quotes", async () => {
  const { cells } = await readXlsx(sample);
  assert.equal(cells[3][0], "Crème brûlée dish");
  assert.equal(cells[3][1], "Home & Kitchen");
  assert.equal(cells[5][0], 'Tea <strong> & "quotes"');
});
await check("an empty row keeps its place, so a row's place in the list is its number in Excel; empty cells are empty", async () => {
  const { cells } = await readXlsx(sample);
  assert.deepEqual(cells[4], []);
  assert.equal(cells[5][0].startsWith("Tea"), true);
  assert.equal(cells[5][1], "Food");
  assert.equal(cells[5][2], "");
  assert.equal(cells[5][7], "");
});
await check("a boolean, and a formula's last result as a number or as text", async () => {
  const { cells } = await readXlsx(sample);
  assert.equal(cells[1][10], "TRUE");
  assert.equal(cells[2][10], "2");
  assert.equal(cells[3][10], "Linen shirt!");
});

const rows = [
  ["Row", "Name", "Barcode", "Problem"],
  ["2", "Linen shirt", "0012345678905", "Another product already has this barcode."],
  [],
  ["4", 'Crème & <b> "x"', "2000000003016", ""],
  ["5", "", "", "The row has no product name."],
];
await check("what is written is read back the same: every cell text, empty cells and rows kept", async () => {
  const back = await readXlsx(writeXlsx(rows, "Rows to correct"));
  assert.deepEqual(back.sheets, ["Rows to correct"]);
  assert.deepEqual(back.cells, [rows[0], rows[1], [], ['4', 'Crème & <b> "x"', "2000000003016"], ["5", "", "", "The row has no product name."]]);
});
await check("a wide sheet: the twenty-seventh column is AA, and the cell is in its place", async () => {
  const wide = [Array.from({ length: 30 }, (_, i) => "c" + i)];
  assert.deepEqual((await readXlsx(writeXlsx(wide))).cells, wide);
});

// a workbook as another program might write it: tags with a prefix, text in the cell itself, cells and rows
// that do not say where they are, the sheet under another name, a string in several runs
const X = '<?xml version="1.0"?>';
const odd = zipStored([
  ["[Content_Types].xml", X + "<Types/>"],
  ["xl/workbook.xml", X + '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="Stock &amp; prices" sheetId="7" r:id="rId9"/></x:sheets></x:workbook>'],
  ["xl/_rels/workbook.xml.rels", X + '<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId9" Target="/xl/worksheets/prices.xml"/></Relationships>'],
  ["xl/sharedStrings.xml", X + '<x:sst xmlns:x="m"><x:si><x:r><x:t>Linen </x:t></x:r><x:r><x:t xml:space="preserve">shirt</x:t></x:r><x:rPh><x:t>reading aid</x:t></x:rPh></x:si><x:si/></x:sst>'],
  ["xl/worksheets/prices.xml", X + '<x:worksheet xmlns:x="m"><x:sheetData>'
    + '<x:row><x:c t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Price</x:t></x:is></x:c></x:row>'
    + '<x:row><x:c t="s"><x:v>0</x:v></x:c><x:c><x:v>1.29E3</x:v></x:c><x:c t="s"><x:v>1</x:v></x:c><x:c t="e"><x:v>#N/A</x:v></x:c><x:c r="F2" t="str"><x:v>a_x000D_b</x:v></x:c></x:row>'
    + '<x:row r="5"><x:c r="B5"><x:v>0.30000000000000004</x:v></x:c><x:c r="C5" s="3"/></x:row>'
    + "</x:sheetData></x:worksheet>"],
]);
await check("a workbook written another way reads the same: prefixed tags, text in the cell, cells that do not say where they are", async () => {
  const { sheets, cells } = await readXlsx(odd);
  assert.deepEqual(sheets, ["Stock & prices"]);
  assert.deepEqual(cells[0], ["Name", "Price"]);
  assert.deepEqual(cells[1], ["Linen shirt", "1290", "", "", "", "a\rb"]);
  assert.deepEqual([cells[2], cells[3]], [[], []]);
  assert.deepEqual(cells[4], ["", "0.3"]);
});
await check("a file that is not a workbook is refused, and an old .xls file is told apart", async () => {
  assert.equal(await fails(() => readXlsx(new TextEncoder().encode("Name,Price\nShirt,1290\n"))), "not-a-workbook");
  assert.equal(await fails(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))), "old-excel");
  assert.equal(await fails(() => readXlsx(zipStored([["hello.txt", "not a workbook"]]))), "not-a-workbook");
  assert.equal(await fails(() => readXlsx(new Uint8Array(0))), "not-a-workbook");
});

console.log(failures === 0 ? "XLSX PASS" : `XLSX FAIL (${failures})`);
process.exit(failures ? 1 : 0);
