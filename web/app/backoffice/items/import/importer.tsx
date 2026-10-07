"use client";

import Link from "next/link";
import { useState } from "react";
import { toCatalogRows } from "@/lib/catalog-rows";
import { parseCsv } from "@/lib/csv";
import { parseRs } from "@/lib/money";
import { importCatalog, type ImportResult, type ImportRow } from "./actions";

const WHY: Record<string, string> = {
  "name-missing": "The row has no product name.",
  "price-missing": "The row has no price, or one that is not a number.",
  "bad-number": "A cost, a price or a quantity on the row is not a number.",
  "bad-options": "An option and its value go together: one is there without the other, or an option is named twice.",
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

// The server, asked. A request that never gets an answer (the connection dropped,
// the file too large to send) must not leave the screen saying "Reading the
// file" for good: it comes back as a refusal like any other.
async function ask(rows: ImportRow[], dry: boolean): ReturnType<typeof importCatalog> {
  try {
    return await importCatalog(rows, dry);
  } catch {
    return { ok: false, message: dry ? "The file could not be sent to be checked. Check the connection and choose it again." : "The import could not be sent. Check the connection, then choose the file again: what was already saved is not saved twice." };
  }
}

type Stage = { at: "start" } | { at: "busy"; what: string } | { at: "checked"; rows: ImportRow[]; result: ImportResult; file: string } | { at: "done"; result: ImportResult };

// A catalog from a spreadsheet, in three steps on one screen: choose the file,
// see what it would do and which rows have a problem, then import. Nothing is
// saved before the last step, and a product arrives whole or not at all.
export function Importer() {
  const [stage, setStage] = useState<Stage>({ at: "start" });
  const [note, setNote] = useState("");

  async function choose(file: File | undefined) {
    if (!file) return;
    setNote("");
    setStage({ at: "busy", what: "Reading the file" });
    const { rows, unknown, noName } = toCatalogRows(parseCsv(await file.text()), parseRs);
    if (noName) {
      setStage({ at: "start" });
      setNote("That file has no Name column. Download the template to see the columns, and save the spreadsheet as CSV.");
      return;
    }
    if (rows.length === 0) {
      setStage({ at: "start" });
      setNote("That file has a header and no rows.");
      return;
    }
    const answer = await ask(rows, true);
    if (!answer.ok) {
      setStage({ at: "start" });
      setNote(answer.message);
      return;
    }
    setNote(unknown.length ? `Not read, because the importer does not know ${unknown.length === 1 ? "this column" : "these columns"}: ${unknown.join(", ")}.` : "");
    setStage({ at: "checked", rows, result: answer.result, file: file.name });
  }

  async function run(rows: ImportRow[]) {
    setStage({ at: "busy", what: "Importing" });
    const answer = await ask(rows, false);
    if (!answer.ok) {
      setStage({ at: "start" });
      setNote(answer.message);
      return;
    }
    setNote("");
    setStage({ at: "done", result: answer.result });
  }

  const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  return (
    <>
      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>1. The file</h2>
            <p>A spreadsheet saved as CSV, one line per product, or per variant of a product. Rows with the same name are one product.</p>
          </div>
        </div>
        <div className="card-body bo-toolbar" style={{ margin: 0 }}>
          <input type="file" accept=".csv,text/csv" aria-label="The CSV file" disabled={stage.at === "busy"} onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export?template=1">Download the template</a>
          <a className="btn btn-quiet btn-sm" href="/backoffice/items/export">Download your products</a>
          {stage.at === "busy" && <span className="muted" role="status">{stage.what}…</span>}
        </div>
        {note && <div className="card-body"><p className="note warn" role="alert" style={{ margin: 0 }}>{note}</p></div>}
      </section>

      {stage.at === "checked" && (
        <section className="card flush">
          <div className="card-head">
            <div>
              <h2>2. What it would do</h2>
              <p>{stage.file}: {count(stage.result.rows, "row", "rows")} read. Nothing is saved yet.</p>
            </div>
            <button type="button" disabled={stage.result.good === 0} onClick={() => void run(stage.rows)}>
              Import {count(stage.result.products, "product", "products")}
            </button>
          </div>
          <div className="stats" style={{ padding: "0 20px 16px" }}>
            <div className="stat"><div className="stat-label">New products</div><div className="stat-value">{stage.result.new_products}</div></div>
            <div className="stat"><div className="stat-label">Products updated</div><div className="stat-value">{stage.result.products - stage.result.new_products}</div></div>
            <div className="stat"><div className="stat-label">New lines</div><div className="stat-value">{stage.result.new_lines}</div></div>
            <div className="stat"><div className="stat-label">Rows with a problem</div><div className="stat-value" style={stage.result.problems.length ? { color: "var(--red)" } : undefined}>{stage.result.rows - stage.result.good}</div></div>
          </div>
          {stage.result.problems.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th className="num">Row</th><th>Product</th><th>Problem</th></tr>
                </thead>
                <tbody>
                  {stage.result.problems.map((p) => (
                    <tr key={p.n}>
                      <td className="num">{p.n}</td>
                      <td className="strong">{p.name ?? <span className="muted">No name</span>}</td>
                      <td>{WHY[p.why] ?? p.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-body">
            <p className="muted" style={{ margin: 0 }}>
              {stage.result.problems.length > 0
                ? "Import the rows that are right now and the rest later, or fix the file and choose it again. A product with a problem on one of its rows waits whole."
                : "Every row is right."}
              {stage.result.rows - stage.result.good > stage.result.problems.length && " Only the first 300 problems are listed."}
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
                {(stage.result.stock_skipped ?? 0) > 0 && ` ${count(stage.result.stock_skipped ?? 0, "line", "lines")} already had stock history: their quantity was left alone.`}
                {stage.result.rows - stage.result.good > 0 && ` ${count(stage.result.rows - stage.result.good, "row", "rows")} left out.`}
              </p>
            </div>
            <Link className="btn" href="/backoffice/items">See the products</Link>
          </div>
        </section>
      )}
    </>
  );
}
