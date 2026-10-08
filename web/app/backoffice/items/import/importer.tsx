"use client";

import Link from "next/link";
import { useRef, useState } from "react";
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

// The file as it was read: its cells, and which of its rows holds the headers.
type Sheet = { file: string; excel: boolean; cells: string[][]; at: number; header: string[]; sheets: string[] };
type Answer = { ok: true; result: ImportResult } | { ok: false; message: string };
type Stage = { at: "start" } | { at: "busy"; what: string } | { at: "columns" } | { at: "checked"; rows: ImportRow[]; result: ImportResult } | { at: "done"; result: ImportResult };

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

// A catalog from a spreadsheet, in three steps on one screen: choose the file
// (Excel or CSV), say what its columns are, see what it would do and which
// rows have a problem, then import. Nothing is saved before the last step, and
// a product arrives whole or not at all. `run` is the server's side of it
// (./actions): asked once to check, and once more to import.
export function Importer({ run }: { run: (rows: ImportRow[], dry: boolean) => Promise<Answer> }) {
  const [stage, setStage] = useState<Stage>({ at: "start" });
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  // only the answer to the last question asked is shown
  const asked = useRef(0);

  // The server, asked. A request that never gets an answer (the connection
  // dropped, the file too large to send) must not leave the screen saying
  // "Checking" for good: it comes back as a refusal like any other.
  async function ask(rows: ImportRow[], dry: boolean): Promise<Answer> {
    try {
      return await run(rows, dry);
    } catch {
      return { ok: false, message: dry ? "The file could not be sent to be checked. Check the connection and choose it again." : "The import could not be sent. Check the connection, then choose the file again: what was already saved is not saved twice." };
    }
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    setNote("");
    setSheet(null);
    setStage({ at: "busy", what: "Reading the file" });
    const stop = (why: string) => { setStage({ at: "start" }); setNote(why); };
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
    if (cells.slice(at + 1).every((line) => line.every((c) => String(c ?? "").trim() === ""))) return stop("That file has a header and no rows.");
    const next: Sheet = { file: file.name, excel, cells, at, header, sheets };
    const guess = kept(header) ?? autoMap(header);
    setSheet(next);
    setMapping(guess);
    await check(next, guess);
  }

  // What the file would do with its columns read this way. Asked again each time a column is changed.
  async function check(s: Sheet, m: Mapping) {
    const mine = ++asked.current;
    if (mappingProblem(m) !== null) { setStage({ at: "columns" }); return; }
    setStage({ at: "busy", what: "Checking the file" });
    const { rows } = toCatalogRows(s.cells, parseRs, m);
    if (rows.length > 5000) {
      if (mine === asked.current) { setStage({ at: "columns" }); setNote("A file can hold 5,000 rows at most. Split it in two."); }
      return;
    }
    const answer = await ask(rows, true);
    if (mine !== asked.current) return;
    if (!answer.ok) { setStage({ at: "columns" }); setNote(answer.message); return; }
    setNote("");
    setStage({ at: "checked", rows, result: answer.result });
  }

  function setColumn(col: number, to: Target | null) {
    if (!sheet) return;
    // a kind of column is one column's: choosing it here takes it from where it was (an option can be several)
    const next = mapping.map((was, i) => (i === col ? to : to !== null && to !== "option" && was === to ? null : was));
    while (next.length < sheet.header.length) next.push(null);
    setMapping(next);
    setNote("");
    void check(sheet, next);
  }

  async function importNow(rows: ImportRow[]) {
    asked.current += 1;
    setStage({ at: "busy", what: "Importing" });
    const answer = await ask(rows, false);
    if (!answer.ok) { setStage({ at: "columns" }); setNote(answer.message); return; }
    if (sheet) keep(sheet.header, mapping);
    setNote("");
    setStage({ at: "done", result: answer.result });
  }

  // The rows with a problem, as a file of the kind that was chosen: the row's own cells, and what is wrong with it.
  function report(result: ImportResult) {
    if (!sheet) return;
    const why = new Map(result.problems.map((p) => [p.n, WHY[p.why] ?? p.why]));
    const width = Math.max(sheet.header.length, ...sheet.cells.map((l) => l.length));
    const fill = (line: string[]) => Array.from({ length: width }, (_, i) => String(line[i] ?? ""));
    const rows = [
      [...fill(sheet.header), "Problem"],
      ...sheet.cells.flatMap((line, i) => (why.has(i + 1) ? [[...fill(line), why.get(i + 1) ?? ""]] : [])),
    ];
    const base = sheet.file.replace(/\.[^.]+$/, "") + " - rows to correct";
    if (sheet.excel) save(base + ".xlsx", writeXlsx(rows, "Rows to correct") as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    else save(base + ".csv", writeCsv(rows), "text/csv;charset=utf-8");
  }

  const busy = stage.at === "busy";
  const problem = sheet ? mappingProblem(mapping) : null;
  const example = (col: number) => {
    if (!sheet) return "";
    const seen: string[] = [];
    for (const line of sheet.cells.slice(sheet.at + 1)) {
      const v = String(line[col] ?? "").trim();
      if (v !== "" && !seen.includes(v)) seen.push(v);
      if (seen.length === 2) break;
    }
    return seen.join(", ");
  };
  const dataRows = sheet ? sheet.cells.slice(sheet.at + 1).filter((line) => line.some((c) => String(c ?? "").trim() !== "")).length : 0;
  const unread = sheet ? sheet.header.filter((h, i) => h !== "" && !mapping[i]) : [];
  const result = stage.at === "checked" ? stage.result : null;
  const bad = result ? result.rows - result.good : 0;
  const adds = result ? [
    result.new_categories?.length ? `${count(result.new_categories.length, "new category", "new categories")}: ${some(result.new_categories)}` : "",
    result.revived_categories?.length ? `${count(result.revived_categories.length, "category that was removed, brought back", "categories that were removed, brought back")}: ${some(result.revived_categories)}` : "",
    result.new_suppliers?.length ? `${count(result.new_suppliers.length, "new supplier", "new suppliers")}: ${some(result.new_suppliers)}` : "",
  ].filter(Boolean) : [];
  const added = result ? (result.new_categories?.length ?? 0) + (result.revived_categories?.length ?? 0) + (result.new_suppliers?.length ?? 0) : 0;

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
            type="file" accept=".xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="The Excel or CSV file" disabled={busy}
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }}
          />
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export?template=1">Download the template</a>
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export">Download your products</a>
          {busy && <span className="muted" role="status">{stage.what}…</span>}
        </div>
        {note && <div className="card-body"><p className="note warn" role="alert" style={{ margin: 0 }}>{note}</p></div>}
      </section>

      {sheet && stage.at !== "done" && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>2. The columns</h2>
              <p>
                {sheet.file}: {count(dataRows, "row", "rows")}.
                {sheet.sheets.length > 1 && ` The workbook has ${sheet.sheets.length} sheets: the first, ${sheet.sheets[0]}, is the one read.`}
                {" "}Each column of the file is read as what its header says. Change any that is wrong; a column set to Not read is left out.
              </p>
            </div>
          </div>
          {problem && <div className="card-body"><p className="note warn" role="alert" style={{ margin: 0 }}>{problem}</p></div>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Column in the file</th><th>For example</th><th>Read as</th></tr>
              </thead>
              <tbody>
                {sheet.header.map((h, col) => {
                  const eg = example(col);
                  if (h === "" && eg === "") return null;
                  return (
                    <tr key={col}>
                      <td className="strong">{h || <span className="muted">No header</span>}</td>
                      <td className="muted">{eg || "Empty"}</td>
                      <td>
                        <select value={mapping[col] ?? ""} disabled={busy && stage.what === "Importing"} aria-label={`What the column ${h || col + 1} is`} onChange={(e) => setColumn(col, (e.target.value || null) as Target | null)}>
                          <option value="">Not read</option>
                          {FIELDS.filter((f) => !f.pair).map((f) => <option key={f.key} value={f.key}>{f.label}{f.required ? " (needed)" : ""}</option>)}
                          <optgroup label="A file made by EasyPay">
                            {FIELDS.filter((f) => f.pair).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                          </optgroup>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result && stage.at === "checked" && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>3. What it would do</h2>
              <p>Nothing is saved yet.{unread.length > 0 && ` Not read: ${some(unread)}.`}</p>
            </div>
            <button type="button" disabled={result.good === 0} onClick={() => void importNow(stage.rows)}>
              Import {count(result.products, "product", "products")}
            </button>
          </div>
          <div className="stats" style={{ padding: "0 20px 16px" }}>
            <div className="stat"><div className="stat-label">New products</div><div className="stat-value">{result.new_products}</div></div>
            <div className="stat"><div className="stat-label">Products updated</div><div className="stat-value">{result.products - result.new_products}</div></div>
            <div className="stat"><div className="stat-label">New lines</div><div className="stat-value">{result.new_lines}</div></div>
            <div className="stat"><div className="stat-label">Rows with a problem</div><div className="stat-value" style={bad ? { color: "var(--red)" } : undefined}>{bad}</div></div>
          </div>
          {adds.length > 0 && (
            <div className="card-body">
              <p className="note" style={{ margin: 0 }}>
                It would also add {adds.join("; ")}. If {added === 1 ? "that" : "one of them"} is a spelling of something you already have, correct the file first: the import makes what the file names.
              </p>
            </div>
          )}
          {result.problems.length > 0 && (
            <>
              <div className="card-body bo-toolbar" style={{ margin: 0 }}>
                <button type="button" className="btn-quiet btn-sm" onClick={() => report(result)}>
                  Download the {count(result.problems.length, "row", "rows")} to correct
                </button>
                <span className="muted">The same rows as in your file, with what is wrong beside each. Correct them there and choose that file.</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th className="num">Row</th><th>Product</th><th>Problem</th></tr>
                  </thead>
                  <tbody>
                    {result.problems.slice(0, 300).map((p) => (
                      <tr key={p.n}>
                        <td className="num">{p.n}</td>
                        <td className="strong">{p.name ?? <span className="muted">No name</span>}</td>
                        <td>{WHY[p.why] ?? p.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="card-body">
            <p className="muted" style={{ margin: 0 }}>
              {result.problems.length > 0
                ? "Import the rows that are right now and the rest later, or correct the file and choose it again. A product with a problem on one of its rows waits whole."
                : "Every row is right."}
              {result.problems.length > 300 && ` The first 300 are listed here; the file to download holds all ${result.problems.length.toLocaleString("en-US")}.`}
            </p>
          </div>
        </section>
      )}

      {stage.at === "done" && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>Imported</h2>
              <p>
                {count(stage.result.products, "product", "products")} ({stage.result.new_products} new), {count(stage.result.lines, "line", "lines")} ({stage.result.new_lines} new).
                {(stage.result.stock_set ?? 0) > 0 && ` Opening stock set on ${count(stage.result.stock_set ?? 0, "line", "lines")}.`}
                {(stage.result.barcodes ?? 0) > 0 && ` ${count(stage.result.barcodes ?? 0, "barcode", "barcodes")} made for the lines that came with none.`}
                {(stage.result.new_categories?.length ?? 0) + (stage.result.revived_categories?.length ?? 0) > 0 &&
                  ` Categories added: ${some([...(stage.result.new_categories ?? []), ...(stage.result.revived_categories ?? [])])}.`}
                {(stage.result.new_suppliers?.length ?? 0) > 0 && ` Suppliers added: ${some(stage.result.new_suppliers ?? [])}.`}
                {(stage.result.stock_skipped ?? 0) > 0 && ` ${count(stage.result.stock_skipped ?? 0, "line", "lines")} already had stock history: their quantity was left alone.`}
                {stage.result.rows - stage.result.good > 0 && ` ${count(stage.result.rows - stage.result.good, "row", "rows")} left out.`}
              </p>
            </div>
            <Link className="btn" href="/backoffice/items">See the products</Link>
          </div>
          {stage.result.problems.length > 0 && sheet && (
            <div className="card-body bo-toolbar" style={{ margin: 0 }}>
              <button type="button" className="btn-quiet btn-sm" onClick={() => report(stage.result)}>
                Download the {count(stage.result.problems.length, "row", "rows")} that were left out
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
