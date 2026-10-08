// csv.test.mjs — reading a spreadsheet's CSV (web/lib/csv.ts).
// Usage: node web/lib/csv.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { parseCsv, writeCsv } from "./csv.ts";

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

check("plain rows, with or without a last line break", () => {
  assert.deepEqual(parseCsv("Name,Price\nMug,320\nBowl,450"), [["Name", "Price"], ["Mug", "320"], ["Bowl", "450"]]);
  assert.deepEqual(parseCsv("Name,Price\r\nMug,320\r\n"), [["Name", "Price"], ["Mug", "320"]]);
});
check("a cell in quotes keeps its comma, its line break and its quote", () => {
  assert.deepEqual(parseCsv('Name,Price\n"Mug, large","1,290.00"\n"Said ""hello""",5\n"Two\nlines",7'), [
    ["Name", "Price"], ["Mug, large", "1,290.00"], ['Said "hello"', "5"], ["Two\nlines", "7"],
  ]);
});
check("semicolons, as a spreadsheet set to French writes them", () => {
  assert.deepEqual(parseCsv("Name;Price;Tax\nMug;320;VAT\n"), [["Name", "Price", "Tax"], ["Mug", "320", "VAT"]]);
  assert.deepEqual(parseCsv("Name;Note\nMug;a, b\n"), [["Name", "Note"], ["Mug", "a, b"]]);
});
check("tabs, as a paste from a spreadsheet", () => {
  assert.deepEqual(parseCsv("Name\tPrice\nMug\t320"), [["Name", "Price"], ["Mug", "320"]]);
});
check("the mark at the start of the file is dropped", () => {
  assert.deepEqual(parseCsv("﻿Name,Price\nMug,320")[0], ["Name", "Price"]);
});
check("empty cells and empty lines are kept as they are", () => {
  assert.deepEqual(parseCsv("A,B,C\n1,,3\n\n,,\n"), [["A", "B", "C"], ["1", "", "3"], [""], ["", "", ""]]);
});
check("a header alone, and nothing at all", () => {
  assert.deepEqual(parseCsv("Name,Price"), [["Name", "Price"]]);
  assert.deepEqual(parseCsv(""), []);
});

check("what is written is read back the same: commas, quotes, line breaks, accents, empty cells", () => {
  const rows = [["Name", "Note", "Barcode"], ["Crème, brûlée", 'said "yes"', "0012345678905"], ["two\nlines", "", "a;b"], ["", "", ""]];
  const text = writeCsv(rows);
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.equal(text.endsWith("\r\n"), true);
  assert.deepEqual(parseCsv(text), rows);
});

console.log(failures === 0 ? "CSV PASS" : `CSV FAIL (${failures})`);
// the exit code is set and node is left to end by itself: process.exit() here has crashed node on Windows while it was closing down, after every check had passed
process.exitCode = failures ? 1 : 0;
