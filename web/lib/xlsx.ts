// An Excel workbook (.xlsx) as rows of cells, and rows of cells as a
// workbook. Pure, with no imports and no library: the import screen reads a
// file with it in the browser, and its test runs it under node (both have
// DecompressionStream).
//
// It reads what an import needs and no more: the first sheet's cells, as
// text. A cell that holds a number gives the number as it is, not as the
// sheet shows it: a 13-digit barcode is 2000000003016 and never 2E+12, a
// quantity shown as 1,200 is 1200, and a price that is 115 to the last
// binary digit but one is 115. A cell that holds text gives the text as it
// was typed, so a barcode typed with a zero in front keeps it. Formats,
// formulas (their last result is read), merged cells, other sheets and the
// old .xls format are not its business; an .xls file is refused by name.
//
// It writes every cell as text, for the same reason: a barcode in a file
// made here opens in Excel as it was, not as a rounded number.

export type Workbook = { sheets: string[]; cells: string[][] };

const MOST_ROWS = 60000;
const MOST_COLUMNS = 200;

// ---------------------------------------------------------------- the zip

type Entry = { name: string; method: number; size: number; at: number };

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function entries(b: Uint8Array): Map<string, Entry> {
  // the directory's end record sits in the last few bytes (after it, only a comment)
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i -= 1) {
    if (u32(b, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("not-a-workbook");
  const out = new Map<string, Entry>();
  let at = u32(b, end + 16);
  const n = u16(b, end + 10);
  const text = new TextDecoder();
  for (let i = 0; i < n; i += 1) {
    if (u32(b, at) !== 0x02014b50) throw new Error("not-a-workbook");
    const nameLen = u16(b, at + 28);
    const name = text.decode(b.subarray(at + 46, at + 46 + nameLen));
    out.set(name, { name, method: u16(b, at + 10), size: u32(b, at + 20), at: u32(b, at + 42) });
    at += 46 + nameLen + u16(b, at + 30) + u16(b, at + 32);
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fileOf(b: Uint8Array, all: Map<string, Entry>, name: string): Promise<string | null> {
  const e = all.get(name);
  if (!e) return null;
  if (u32(b, e.at) !== 0x04034b50) throw new Error("not-a-workbook");
  const from = e.at + 30 + u16(b, e.at + 26) + u16(b, e.at + 28);
  const data = b.subarray(from, from + e.size);
  if (e.method !== 0 && e.method !== 8) throw new Error("not-a-workbook");
  return new TextDecoder().decode(e.method === 0 ? data : await inflate(data));
}

// ---------------------------------------------------------------- the XML

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// what a cell's text is once its XML is undone: the five entities, a character by its number, and Excel's own _x000D_
const plain = (s: string) =>
  s
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITY[e] ?? whole),
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
// some programs write every tag with a prefix (<x:row>): the same sheet without it
const bare = (doc: string | null) => (doc === null ? null : doc.replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1"));
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
// the text of a string: every run of it, without the reading aids some sheets carry beside the text
const runs = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => plain(m[1])).join("");

// A number as it is, without a sheet's formatting and without the last digit's noise.
function number(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const clean = Number(n.toPrecision(15));
  const s = String(clean);
  return s.includes("e") ? clean.toFixed(12).replace(/\.?0+$/, "") : s;
}

// "B" is the second column, "AA" the twenty-seventh
function column(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// The first sheet of a workbook, row by row. A row the sheet leaves empty is
// an empty row here too, so a row's place in the list is its number in Excel.
export async function readXlsx(bytes: Uint8Array): Promise<Workbook> {
  // an old .xls file (and a workbook locked with a password) starts with these bytes, not with a zip's
  if (bytes.length > 8 && u32(bytes, 0) === 0xe011cfd0) throw new Error("old-excel");
  const all = entries(bytes);
  const book = bare(await fileOf(bytes, all, "xl/workbook.xml"));
  if (book === null) throw new Error("not-a-workbook");
  const sheets = [...book.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: plain(attr(m[1], "name") ?? ""), rel: attr(m[1], "r:id") }));
  if (sheets.length === 0) throw new Error("not-a-workbook");
  const rels = bare(await fileOf(bytes, all, "xl/_rels/workbook.xml.rels")) ?? "";
  const target = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]).find((t) => attr(t, "Id") === sheets[0].rel);
  const where = target ? (attr(target, "Target") ?? "") : "worksheets/sheet1.xml";
  const sheet = bare(await fileOf(bytes, all, where.startsWith("/") ? where.slice(1) : "xl/" + where));
  if (sheet === null) throw new Error("not-a-workbook");
  const shared = [...(bare(await fileOf(bytes, all, "xl/sharedStrings.xml")) ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => runs(m[1] ?? ""));

  const cells: string[][] = [];
  let next = 0;
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(row[1], "r") ?? next + 1) - 1;
    next = r + 1;
    if (!(r >= 0) || r >= MOST_ROWS) continue;
    const line: string[] = [];
    let at = 0;
    for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], "r");
      const col = ref ? column(ref) : at;
      at = col + 1;
      if (col < 0 || col >= MOST_COLUMNS) continue;
      const type = attr(c[1], "t") ?? "n";
      const inner = c[2] ?? "";
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
      const value =
        type === "s" ? (shared[Number(v)] ?? "")
        : type === "inlineStr" ? runs(inner)
        : type === "str" || type === "d" ? plain(v)
        : type === "b" ? (v === "1" ? "TRUE" : v === "" ? "" : "FALSE")
        : type === "e" ? ""
        : v === "" ? "" : number(v);
      if (value !== "") {
        while (line.length < col) line.push("");
        line[col] = value;
      }
    }
    while (cells.length < r) cells.push([]);
    cells[r] = line;
  }
  return { sheets: sheets.map((s) => s.name), cells };
}

// ---------------------------------------------------------------- writing

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const xml = (s: string) =>
  s
    .replace(/[^\x09\x0A\x0D\x20-￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
// the day every file in the zip is dated: 1 January 2026, as a zip writes a date
const DAY = ((2026 - 1980) << 9) | (1 << 5) | 1;
const letters = (col: number): string => (col < 26 ? "" : letters(Math.floor(col / 26) - 1)) + String.fromCharCode(65 + (col % 26));

// A zip of text files, stored and not compressed. Exported for the test, which makes workbooks
// with it that a spreadsheet program would write another way.
export function zipStored(files: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  let at = 0;
  for (const [name, content] of files) {
    const n = enc.encode(name), data = enc.encode(content), crc = crc32(data);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(12, DAY, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(14, DAY, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true);
    cv.setUint32(42, at, true);
    central.set(n, 46);
    parts.push(local, data);
    dir.push(central);
    at += local.length + data.length;
  }
  const dirSize = dir.reduce((a, d) => a + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true); ev.setUint32(16, at, true);
  const out = new Uint8Array(at + dirSize + 22);
  let o = 0;
  for (const p of [...parts, ...dir, end]) { out.set(p, o); o += p.length; }
  return out;
}

// A workbook of one sheet, every cell text. Not compressed: a report of a few
// thousand rows is small, and a zip that only stores is a few lines to make.
export function writeXlsx(rows: string[][], sheet = "Sheet1"): Uint8Array {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const body = rows
    .map((line, r) => {
      const cs = line
        .map((v, c) => (v === "" || v == null ? "" : `<c r="${letters(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`))
        .join("");
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join("");
  const files: [string, string][] = [
    ["[Content_Types].xml",
      head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels",
      head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml",
      head + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels",
      head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml",
      head + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
  ];
  return zipStored(files);
}
