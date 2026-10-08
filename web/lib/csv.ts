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

// Rows of cells as a CSV file a spreadsheet opens: commas, a cell in quotes when
// it holds a comma, a quote or a line break, lines ended the way Windows ends
// them, and the mark at the start that tells Excel the file is UTF-8 (without
// it an accent comes out as two wrong letters).
export function writeCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n;\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return "\ufeff" + rows.map((line) => line.map((v) => cell(String(v ?? ""))).join(",")).join("\r\n") + "\r\n";
}
