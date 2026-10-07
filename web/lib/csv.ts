// A CSV file as rows of cells. Pure, with no imports: the import screen reads
// a file with it in the browser, and its test runs it under node.
//
// The separator is whichever of comma, semicolon and tab the header line uses
// most: a spreadsheet set to French writes semicolons. A cell in quotes may
// hold the separator, a line break, and a quote written twice. The mark some
// programs put at the very start of a file is dropped.
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const end = src.search(/\r?\n/);
  const head = end === -1 ? src : src.slice(0, end);
  const sep = [",", ";", "\t"].map((s) => [s, head.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
