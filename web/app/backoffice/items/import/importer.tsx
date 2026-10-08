"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { autoMap, FIELDS, headerKey, headerRow, type Mapping, mappingProblem, type Target, toCatalogRows } from "@/lib/catalog-rows";
import { parseCsv, writeCsv } from "@/lib/csv";
import { parseRs } from "@/lib/money";
import { readXlsx, writeXlsx } from "@/lib/xlsx";
import type { ImportResult, ImportRow } from "./actions";

const WHY: Record<string, string> = {
  "name-missing": "The row has no product name.",
  "price-missing": "The row has no price, or one that is not a number.",
  "bad-number": "A cost, a price or a quantity on the row is not a number.",
  "bad-options": "An option and its value go together: one is there without the other, an option is named twice, or the row has more than three.",
  "tax-unknown": "No tax of that name is set up. Use a name from Taxes, or leave it empty for the usual one.",
  "options-differ": "The rows of this product do not name the same options, or the product already has a different number of them.",
  "duplicate-line": "This line is in the file twice.",
  "has-stock": "This product has stock of its own, so it cannot be given variants. Bring it to zero under Stock first.",
  "barcode-twice": "This barcode is on more than one row.",
  "sku-twice": "This SKU is on more than one row.",
  "barcode-taken": "Another product already has this barcode.",
  "sku-taken": "Another product already has this SKU.",
  "too-many-variants": "That would make more than 200 lines for one product.",
  "product-has-problems": "Another row of this product has a problem, so the whole product waits.",
};
// the problems that are about one cell, and which kind of column that cell is in: it can be emptied there
const CLEARS: Record<string, Target> = { "barcode-twice": "barcode", "barcode-taken": "barcode", "sku-twice": "sku", "sku-taken": "sku" };

// The file as it was read: its cells, and which of its rows holds the headers.
type Sheet = { file: string; excel: boolean; cells: string[][]; at: number; header: string[]; sheets: string[] };
type Answer = { ok: true; result: ImportResult } | { ok: false; message: string };
type RowFilter = "all" | "errors" | "new" | "ready";
// what a row of the sheet will do: a problem, something new it brings with it, or nothing to say
type RowStatus = { why?: string; news: string[] };

// The columns someone chose for a file are kept on this computer, by the
// file's headers: the same supplier's sheet next month is matched the same
// way. Nothing is lost if the browser will not keep it.
const KEPT = "easypay.import.columns";
const sign = (header: string[]) => header.map(headerKey).join("|");
function kept(header: string[]): Mapping | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}") as Record<string, Mapping>;
    const m = all[sign(header)];
    return Array.isArray(m) && m.length === header.length && m.every((x) => x === null || FIELDS.some((f) => f.key === x)) ? m : null;
  } catch {
    return null;
  }
}
function keep(header: string[], mapping: Mapping) {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}") as Record<string, Mapping>;
    delete all[sign(header)];
    const next = Object.fromEntries([...Object.entries(all).slice(-19), [sign(header), mapping]]);
    window.localStorage.setItem(KEPT, JSON.stringify(next));
  } catch {
    /* not kept: the columns are matched from their headers next time */
  }
}

function save(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const some = (names: string[]) => (names.length <= 8 ? names.join(", ") : `${names.slice(0, 8).join(", ")} and ${names.length - 8} more`);
// "A", "B", ... "AA": a column as a spreadsheet names it
const letter = (col: number): string => (col < 26 ? "" : letter(Math.floor(col / 26) - 1)) + String.fromCharCode(65 + (col % 26));
const blank = (line: string[] | undefined) => !line || line.every((c) => String(c ?? "").trim() === "");
// the most rows of the sheet drawn at once: the ones with a problem come first, so those are the ones seen
const DRAWN = 200;

// A catalog from a spreadsheet, in two steps on one screen. Choose the file
// (Excel or CSV). Then the file itself is on the screen as a sheet: above each
// column a list says what the column is read as, each row says beside it what
// it will do, and a cell can be corrected where it stands. Nothing is saved
// until Import is pressed, and a product arrives whole or not at all. `run`
// is the server's side of it (./actions): asked to check each time the sheet
// or its columns change, and once more to import.
export function Importer({ run }: { run: (rows: ImportRow[], dry: boolean) => Promise<Answer> }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  // the server's answer about the sheet as it is now, and the rows it was asked about
  const [result, setResult] = useState<ImportResult | null>(null);
  const [sent, setSent] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<ImportResult | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [statusOpen, setStatusOpen] = useState(true);
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState("");
  // only the answer to the last question asked is shown
  const asked = useRef(0);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (later.current) clearTimeout(later.current); }, []);

  // The server, asked. A request that never gets an answer (the connection
  // dropped, the file too large to send) must not leave the screen saying
  // "Checking" for good: it comes back as a refusal like any other.
  async function ask(rows: ImportRow[], dry: boolean): Promise<Answer> {
    try {
      return await run(rows, dry);
    } catch {
      return { ok: false, message: dry ? "The sheet could not be sent to be checked. Check the connection and choose the file again." : "The import could not be sent. Check the connection, then choose the file again: what was already saved is not saved twice." };
    }
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    asked.current += 1;
    setNote("");
    setSheet(null);
    setResult(null);
    setDone(null);
    setEditing(null);
    setFilter("all");
    setBusy("Reading the file");
    const stop = (why: string) => { setBusy(""); setNote(why); };
    let cells: string[][], sheets: string[] = [], excel = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // a workbook is a zip, whatever the file is called
      excel = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      if (excel || /\.(xlsx|xlsm|xls)$/i.test(file.name)) {
        const book = await readXlsx(bytes);
        cells = book.cells;
        sheets = book.sheets;
        excel = true;
      } else cells = parseCsv(new TextDecoder().decode(bytes));
    } catch (e) {
      return stop(
        e instanceof Error && e.message === "old-excel"
          ? "That is an old Excel file (.xls), or a workbook locked with a password. Open it in Excel and save it as an Excel workbook (.xlsx) or as CSV, then choose that file."
          : "That file could not be read. Choose an Excel workbook (.xlsx) or a CSV file.",
      );
    }
    const at = headerRow(cells);
    const header = (cells[at] ?? []).map((h) => String(h ?? "").trim());
    if (header.every((h) => h === "")) return stop("That file is empty.");
    if (cells.slice(at + 1).every(blank)) return stop("That file has a header and no rows.");
    // every row as wide as the widest, so a column is a column all the way down
    const width = Math.max(header.length, ...cells.map((l) => l.length));
    const next: Sheet = { file: file.name, excel, cells: cells.map((l) => Array.from({ length: width }, (_, i) => String(l[i] ?? ""))), at, header: Array.from({ length: width }, (_, i) => header[i] ?? ""), sheets };
    const guess = kept(next.header) ?? autoMap(next.header);
    setSheet(next);
    setMapping(guess);
    await check(next, guess);
  }

  // What the sheet would do with its columns read this way. Asked again each time a column or a cell is changed.
  async function check(s: Sheet, m: Mapping) {
    const mine = ++asked.current;
    if (mappingProblem(m) !== null) { setBusy(""); setResult(null); return; }
    setBusy("Checking");
    const { rows } = toCatalogRows(s.cells, parseRs, m);
    if (rows.length > 5000) {
      if (mine === asked.current) { setBusy(""); setResult(null); setNote("A file can hold 5,000 rows at most. Split it in two."); }
      return;
    }
    const answer = await ask(rows, true);
    if (mine !== asked.current) return;
    setBusy("");
    if (!answer.ok) { setResult(null); setNote(answer.message); return; }
    setNote("");
    setSent(rows);
    setResult(answer.result);
  }

  function setColumn(col: number, to: Target | null) {
    if (!sheet) return;
    // a kind of column is one column's: choosing it here takes it from where it was (an option can be several)
    const next = sheet.header.map((_, i) => (i === col ? to : to !== null && to !== "option" && mapping[i] === to ? null : (mapping[i] ?? null)));
    setMapping(next);
    setNote("");
    void check(sheet, next);
  }

  // A cell corrected on the screen: the sheet here changes, the file on the computer does not.
  function setCell(row: number, col: number, value: string) {
    if (!sheet || (sheet.cells[row]?.[col] ?? "") === value) return;
    const next: Sheet = { ...sheet, cells: sheet.cells.map((line, i) => (i === row ? line.map((c, j) => (j === col ? value : c)) : line)) };
    setSheet(next);
    // a moment's wait, so three cells corrected one after the other are one question
    asked.current += 1;
    setBusy("Checking");
    if (later.current) clearTimeout(later.current);
    later.current = setTimeout(() => void check(next, mapping), 500);
  }
  const commit = () => {
    if (!editing) return;
    setCell(editing.row, editing.col, draft.trim());
    setEditing(null);
  };

  async function importNow() {
    if (!sheet || !result || busy) return;
    asked.current += 1;
    setBusy("Importing");
    const answer = await ask(sent, false);
    setBusy("");
    if (!answer.ok) { setNote(answer.message); return; }
    keep(sheet.header, mapping);
    setNote("");
    setDone(answer.result);
  }

  // The rows with a problem, as a file of the kind that was chosen: the row's own cells as they are on the screen, and what is wrong with it.
  function report(r: ImportResult) {
    if (!sheet) return;
    const why = new Map(r.problems.map((p) => [p.n, WHY[p.why] ?? p.why]));
    const rows = [
      [...sheet.header, "Problem"],
      ...sheet.cells.flatMap((line, i) => (why.has(i + 1) ? [[...line, why.get(i + 1) ?? ""]] : [])),
    ];
    const base = sheet.file.replace(/\.[^.]+$/, "") + " - rows to correct";
    if (sheet.excel) save(base + ".xlsx", writeXlsx(rows, "Rows to correct") as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    else save(base + ".csv", writeCsv(rows), "text/csv;charset=utf-8");
  }

  const problem = sheet ? mappingProblem(mapping) : null;
  // what each row will do, by its number in the file
  const status = useMemo(() => {
    const by = new Map<number, RowStatus>();
    if (!result) return by;
    const low = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.toLowerCase()));
    const cats = low(result.new_categories), back = low(result.revived_categories), sups = low(result.new_suppliers);
    for (const r of sent) {
      const news: string[] = [];
      if (r.category && cats.has(r.category.toLowerCase())) news.push(`${r.category} will be added as a new category`);
      if (r.category && back.has(r.category.toLowerCase())) news.push(`${r.category} was removed and will be brought back as a category`);
      if (r.supplier && sups.has(r.supplier.toLowerCase())) news.push(`${r.supplier} will be added as a new supplier`);
      by.set(r.n, { news });
    }
    for (const p of result.problems) by.set(p.n, { why: p.why, news: [] });
    return by;
  }, [result, sent]);

  // the rows of the sheet that hold something, those with a problem first, then those that bring something new
  const rows = useMemo(() => {
    if (!sheet) return [];
    const rank = (n: number) => { const s = status.get(n); return s?.why ? 0 : s && s.news.length ? 1 : 2; };
    return sheet.cells
      .map((line, i) => ({ line, i, n: i + 1 }))
      .filter((r) => r.i > sheet.at && !blank(r.line))
      .sort((a, b) => rank(a.n) - rank(b.n) || a.n - b.n);
  }, [sheet, status]);
  const counts = {
    all: rows.length,
    errors: result ? result.problems.length : 0,
    new: rows.filter((r) => { const s = status.get(r.n); return s && !s.why && s.news.length > 0; }).length,
    ready: rows.filter((r) => { const s = status.get(r.n); return s && !s.why && s.news.length === 0; }).length,
  };
  const wanted = rows.filter((r) => {
    const s = status.get(r.n);
    if (filter === "errors") return Boolean(s?.why);
    if (filter === "new") return Boolean(s && !s.why && s.news.length);
    if (filter === "ready") return Boolean(s && !s.why && s.news.length === 0);
    return true;
  });
  const shown = wanted.slice(0, DRAWN);
  const adds = result ? [
    result.new_categories?.length ? `${count(result.new_categories.length, "new category", "new categories")}: ${some(result.new_categories)}` : "",
    result.revived_categories?.length ? `${count(result.revived_categories.length, "category that was removed, brought back", "categories that were removed, brought back")}: ${some(result.revived_categories)}` : "",
    result.new_suppliers?.length ? `${count(result.new_suppliers.length, "new supplier", "new suppliers")}: ${some(result.new_suppliers)}` : "",
  ].filter(Boolean) : [];
  const added = result ? (result.new_categories?.length ?? 0) + (result.revived_categories?.length ?? 0) + (result.new_suppliers?.length ?? 0) : 0;

  // The sheet and the statuses beside it scroll as one: row 27 on the left is
  // row 27 on the right. Each pane, when it moves, puts the other where it is;
  // the other's own move then finds them level and stops there.
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mirror = (from: React.RefObject<HTMLDivElement | null>, to: React.RefObject<HTMLDivElement | null>) => () => {
    if (from.current && to.current && Math.abs(to.current.scrollTop - from.current.scrollTop) >= 1) to.current.scrollTop = from.current.scrollTop;
  };
  // The sheet's header and its bar along the bottom are as tall as the browser
  // draws them: the statuses take the same, so both panes hold the same rows.
  const [edge, setEdge] = useState({ head: 68, bar: 0 });
  useEffect(() => {
    const g = gridRef.current;
    if (!g) return;
    const measure = () => {
      const head = g.querySelector("thead")?.getBoundingClientRect().height ?? 68;
      const bar = g.offsetHeight - g.clientHeight;
      setEdge((was) => (Math.abs(was.head - head) < 0.01 && was.bar === bar ? was : { head, bar }));
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(g);
    return () => seen.disconnect();
  }, [sheet === null, done === null, statusOpen]);

  return (
    <>
      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>1. The file</h2>
            <p>An Excel workbook (.xlsx) or a CSV file, one line per product, or per variant of a product. Rows with the same name are one product. Its headers do not have to be EasyPay&apos;s: you say what each column is in the next step.</p>
          </div>
        </div>
        <div className="card-body bo-toolbar" style={{ margin: 0 }}>
          <input
            type="file" accept=".xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="The Excel or CSV file" disabled={busy !== ""}
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }}
          />
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export?template=1">Download the template</a>
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export">Download your products</a>
          {busy === "Reading the file" && <span className="muted" role="status">Reading the file…</span>}
        </div>
        {note && <div className="card-body"><p className="note warn" role="alert" style={{ margin: 0 }}>{note}</p></div>}
      </section>

      {sheet && !done && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>2. Check the sheet</h2>
              <p>
                {sheet.file}: {count(rows.length, "row", "rows")}.
                {sheet.sheets.length > 1 && ` The workbook has ${sheet.sheets.length} sheets: the first, ${sheet.sheets[0]}, is the one read.`}
                {" "}Nothing is saved until you press Import.
              </p>
            </div>
            <button type="button" disabled={!result || result.good === 0 || busy !== ""} onClick={() => void importNow()}>
              {busy === "Importing" ? "Importing…" : result ? `Import ${count(result.products, "product", "products")}` : "Import"}
            </button>
          </div>
          {problem && <div className="card-body"><p className="note warn" role="alert" style={{ margin: 0 }}>{problem} Pick it from the list above its column.</p></div>}
          {adds.length > 0 && (
            <div className="card-body">
              <p className="note" style={{ margin: 0 }}>
                It would also add {adds.join("; ")}. If {added === 1 ? "that" : "one of them"} is a spelling of something you already have, correct it in the sheet below first: the import makes what the sheet names.
              </p>
            </div>
          )}
          <div className="table-filters">
            <div className="seg" role="radiogroup" aria-label="Which rows to show">
              {([["all", "All"], ["errors", "Errors"], ["new", "New values"], ["ready", "Ready"]] as const).map(([key, label]) => (
                <label key={key}>
                  <input type="radio" name="sheet-rows" checked={filter === key} onChange={() => setFilter(key)} />
                  {label} {result || key === "all" ? counts[key].toLocaleString("en-US") : ""}
                </label>
              ))}
            </div>
            <span className="muted" role="status">
              {busy === "Checking" ? "Checking…" : result
                ? `${count(result.new_products, "new product", "new products")}, ${count(result.products - result.new_products, "product updated", "products updated")}, ${count(result.new_lines, "new line", "new lines")}.`
                : ""}
            </span>
            <span className="spacer" />
            <span className="muted sheet-hint">Change a list to say what its column is. Click a cell to correct it.</span>
          </div>

          <div className="sheet">
            <div className="sheet-grid" ref={gridRef} onScroll={mirror(gridRef, listRef)}>
              <table>
                <thead>
                  <tr>
                    <th className="sheet-no">Row</th>
                    {sheet.header.map((h, col) => (
                      <th key={col}>
                        <div className="sheet-col" title={h}>{letter(col)} · {h || "no header"}</div>
                        <select value={mapping[col] ?? ""} disabled={busy === "Importing"} aria-label={`What column ${letter(col)}, ${h || "with no header"}, is`} className={mapping[col] ? undefined : "unread"} onChange={(e) => setColumn(col, (e.target.value || null) as Target | null)}>
                          <option value="">Not read</option>
                          {FIELDS.filter((f) => !f.pair).map((f) => <option key={f.key} value={f.key}>{f.label}{f.required ? " (needed)" : ""}</option>)}
                          <optgroup label="A file made by EasyPay">
                            {FIELDS.filter((f) => f.pair).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                          </optgroup>
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const s = status.get(r.n);
                    const clears = s?.why ? CLEARS[s.why] : undefined;
                    return (
                      <tr key={r.n} className={s?.why ? "bad" : s && s.news.length ? "new" : undefined}>
                        <td className="sheet-no">{r.n}</td>
                        {r.line.map((raw, col) => {
                          const kind = mapping[col];
                          const value = raw.trim();
                          const isNew = !s?.why && value !== "" && ((kind === "category" && s?.news.some((x) => x.includes("category"))) || (kind === "supplier" && s?.news.some((x) => x.includes("supplier"))));
                          return (
                            <td key={col}>
                              {editing?.row === r.i && editing.col === col ? (
                                <input
                                  autoFocus value={draft} aria-label={`${sheet.header[col] || "Column " + letter(col)} on row ${r.n}`}
                                  onChange={(e) => setDraft(e.target.value)} onBlur={commit}
                                  onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(null); }}
                                />
                              ) : (
                                <span className="sheet-in">
                                  <button type="button" className={"sheet-cell" + (value === "" ? " sheet-void" : "")} disabled={busy === "Importing"} title={value || "Empty: click to type"} onClick={() => { setEditing({ row: r.i, col }); setDraft(raw); }}>
                                    {value || "—"}
                                  </button>
                                  {isNew && <span className="badge amber">New</span>}
                                  {clears !== undefined && clears === kind && value !== "" && (
                                    <button type="button" className="sheet-fix" title="Empty this cell: the row then goes in without it" onClick={() => setCell(r.i, col, "")}>Clear</button>
                                  )}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {statusOpen ? (
              <div className="sheet-status">
                <div className="sheet-status-head" style={{ height: edge.head }}>
                  <div className="sheet-col">
                    Status
                    <button type="button" className="sheet-fold" title="Fold the statuses away" aria-label="Fold the statuses away" onClick={() => setStatusOpen(false)}>›</button>
                  </div>
                  <div className="sheet-says">What each row will do</div>
                </div>
                <div className="sheet-status-list" ref={listRef} onScroll={mirror(listRef, gridRef)}>
                  <ul style={{ paddingBottom: edge.bar }}>
                    {shown.map((r) => {
                      const s = status.get(r.n);
                      const say = !s ? "" : s.why ? (WHY[s.why] ?? s.why) : s.news.length ? s.news.join(", ") + "." : "Goes in as it is.";
                      return (
                        <li key={r.n} title={say}>
                          <span className="sheet-n">{r.n}</span>
                          {!s ? <span className="muted">{busy === "Checking" ? "Checking…" : "—"}</span> : (
                            <>
                              <span className={"badge " + (s.why ? "red" : s.news.length ? "amber" : "green")}>{s.why ? "Error" : s.news.length ? "New" : "Ready"}</span>
                              <span className={"sheet-why" + (s.why ? " bad" : s.news.length ? " new" : "")}>{say}</span>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ) : (
              <button type="button" className="sheet-unfold" title="Show what each row will do" onClick={() => setStatusOpen(true)}>‹ Status</button>
            )}
          </div>

          <div className="card-body bo-toolbar sheet-foot" style={{ margin: 0 }}>
            <span className="muted">
              {shown.length === 0 ? "No row to show here." : `Showing ${count(shown.length, "row", "rows")} of ${wanted.length.toLocaleString("en-US")}, those with a problem first.`}
              {wanted.length > shown.length && ` ${(wanted.length - shown.length).toLocaleString("en-US")} more are not drawn: correct these and they come up.`}
            </span>
            <span className="spacer" />
            {result && result.problems.length > 0 && (
              <button type="button" className="btn-quiet btn-sm" title="The same rows as on the screen, with what is wrong beside each: correct them in the file and choose it again" onClick={() => report(result)}>
                Download the {count(result.problems.length, "row", "rows")} to correct
              </button>
            )}
          </div>
          {result && (
            <div className="card-body">
              <p className="muted" style={{ margin: 0 }}>
                {result.problems.length > 0
                  ? "Import the rows that are right now and the rest later, or correct them here first. A product with a problem on one of its rows waits whole."
                  : "Every row is right."}
              </p>
            </div>
          )}
        </section>
      )}

      {done && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>Imported</h2>
              <p>
                {count(done.products, "product", "products")} ({done.new_products} new), {count(done.lines, "line", "lines")} ({done.new_lines} new).
                {(done.stock_set ?? 0) > 0 && ` Opening stock set on ${count(done.stock_set ?? 0, "line", "lines")}.`}
                {(done.barcodes ?? 0) > 0 && ` ${count(done.barcodes ?? 0, "barcode", "barcodes")} made for the lines that came with none.`}
                {(done.new_categories?.length ?? 0) + (done.revived_categories?.length ?? 0) > 0 &&
                  ` Categories added: ${some([...(done.new_categories ?? []), ...(done.revived_categories ?? [])])}.`}
                {(done.new_suppliers?.length ?? 0) > 0 && ` Suppliers added: ${some(done.new_suppliers ?? [])}.`}
                {(done.stock_skipped ?? 0) > 0 && ` ${count(done.stock_skipped ?? 0, "line", "lines")} already had stock history: their quantity was left alone.`}
                {done.rows - done.good > 0 && ` ${count(done.rows - done.good, "row", "rows")} left out.`}
              </p>
            </div>
            <Link className="btn" href="/backoffice/items">See the products</Link>
          </div>
          {done.problems.length > 0 && sheet && (
            <div className="card-body bo-toolbar" style={{ margin: 0 }}>
              <button type="button" className="btn-quiet btn-sm" onClick={() => report(done)}>
                Download the {count(done.problems.length, "row", "rows")} that were left out
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
