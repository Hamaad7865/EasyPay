"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, Search } from "lucide-react";
import { asEan13, ean13Bars, ean13HumanGroups, EAN13_MODULES } from "@/lib/ean13";
import { fold } from "../../table-kit";
import { Submit } from "../../busy";

export type LabelLine = { key: string; product: string; name: string; variant: string | null; price_shown: string; barcode: string | null; qty: number };
type Action = (f: FormData) => Promise<void>;
type Layout = "roll" | "a4";

// The most labels for one line, and for one run: enough for a delivery, and
// low enough that one slip of the finger cannot spool a whole roll (the
// limits Kids Corner prints by).
const MOST_EACH = 99;
const MOST_RUN = 240;
const PER_SHEET = 24;

// A symbol with its quiet zones: 11 clear modules before the bars and 7 after.
function Bars({ code }: { code: string }) {
  return (
    <svg viewBox={`0 0 ${EAN13_MODULES + 18} 40`} preserveAspectRatio="none" shapeRendering="crispEdges" className="lb-bars" aria-hidden="true">
      {ean13Bars(code).map((b) => (
        <rect key={b.x} x={b.x + 11} y={0} width={b.width} height={40} fill="#000" />
      ))}
    </svg>
  );
}

function Label({ l }: { l: LabelLine }) {
  const ean = asEan13(l.barcode);
  return (
    <div className="lb">
      <div className="lb-name">{l.name}</div>
      {l.variant && <div className="lb-variant">{l.variant}</div>}
      {ean ? (
        <>
          <Bars code={ean} />
          <div className="lb-digits">{ean13HumanGroups(ean).join(" ")}</div>
        </>
      ) : (
        <div className="lb-code">{l.barcode ?? ""}</div>
      )}
      <div className="lb-price">{l.price_shown}</div>
    </div>
  );
}

// What prints. The sheet lives at the end of <body>, outside the back office,
// so that printing can hide everything else outright: hidden some other way,
// the page around it would still take up paper.
const CSS = (layout: Layout) => `
.lb-sheet { display: none; }
.lb { box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: space-between; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; text-align: center; }
.lb-name { font-weight: 700; line-height: 1.12; max-height: 2.3em; overflow: hidden; }
.lb-digits { font-family: "Courier New", monospace; letter-spacing: 0.4pt; line-height: 1; }
.lb-code { font-family: "Courier New", monospace; font-weight: 700; }
.lb-price { font-weight: 700; line-height: 1; }
.lb-roll .lb, .lb-try.lb-roll .lb { width: 40mm; height: 30mm; padding: 1.4mm 2mm; }
.lb-roll .lb-name { font-size: 7.5pt; } .lb-roll .lb-variant { font-size: 6.5pt; } .lb-roll .lb-bars { width: 34mm; height: 9mm; }
.lb-roll .lb-digits { font-size: 6.5pt; } .lb-roll .lb-code { font-size: 8pt; } .lb-roll .lb-price { font-size: 10pt; }
.lb-a4 .lb, .lb-try.lb-a4 .lb { width: 63.5mm; height: 33.9mm; padding: 2.4mm 3mm; }
.lb-a4 .lb-name { font-size: 9pt; } .lb-a4 .lb-variant { font-size: 8pt; } .lb-a4 .lb-bars { width: 46mm; height: 11mm; }
.lb-a4 .lb-digits { font-size: 8pt; } .lb-a4 .lb-code { font-size: 10pt; } .lb-a4 .lb-price { font-size: 12pt; }
.lb-try { display: inline-block; border: 1px dashed var(--line-strong); border-radius: 6px; background: #fff; }
@media print {
  @page { size: ${layout === "roll" ? "40mm 30mm" : "A4"}; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.lb-sheet) { display: none !important; }
  .lb-sheet { display: block; }
  .lb-roll .lb { break-after: page; }
  .lb-a4 .lb-page { width: 210mm; height: 297mm; box-sizing: border-box; padding: 12.9mm 7.2mm; display: grid; grid-template-columns: repeat(3, 63.5mm); column-gap: 2.5mm; grid-auto-rows: 33.9mm; align-content: start; break-after: page; }
}`;

// Barcode labels: how many of each line, on a roll or on A4 sheets, and Print.
// The labels are drawn here, in the browser, from what the page already
// holds; the browser's own print dialog does the rest.
export function LabelPicker({ lines, preselect, makeBarcodes }: { lines: LabelLine[]; preselect: string; makeBarcodes: Action }) {
  const [copies, setCopies] = useState<Record<string, number>>(() => Object.fromEntries(lines.filter((l) => preselect && l.product === preselect).map((l) => [l.key, 1])));
  const [layout, setLayout] = useState<Layout>("roll");
  const [q, setQ] = useState("");
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => setBody(document.body), []);

  const hay = useMemo(() => new Map(lines.map((l) => [l.key, fold([l.name, l.variant ?? "", l.barcode ?? ""].join(" "))])), [lines]);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const shown = lines.filter((l) => words.every((w) => hay.get(l.key)!.includes(w)));
  const set = (key: string, n: number) => setCopies((c) => ({ ...c, [key]: Math.max(0, Math.min(MOST_EACH, Math.round(n) || 0)) }));
  const setShown = (fn: (l: LabelLine) => number) => setCopies((c) => ({ ...c, ...Object.fromEntries(shown.map((l) => [l.key, Math.max(0, Math.min(MOST_EACH, fn(l)))])) }));

  const chosen = lines.filter((l) => (copies[l.key] ?? 0) > 0);
  const bare = chosen.filter((l) => !l.barcode);
  const ready = chosen.filter((l) => l.barcode);
  // every label of the run, in the order of the list, cut at what one run prints
  const all = ready.flatMap((l) => Array.from({ length: copies[l.key] }, () => l));
  const run = all.slice(0, MOST_RUN);
  const pages = Array.from({ length: Math.ceil(run.length / PER_SHEET) }, (_, i) => run.slice(i * PER_SHEET, (i + 1) * PER_SHEET));
  const noBars = ready.filter((l) => !asEan13(l.barcode)).length;

  return (
    <section className="card flush">
      <style>{CSS(layout)}</style>
      <div className="card-head">
        <div>
          <h2>What to label</h2>
          <p>
            {lines.length} {lines.length === 1 ? "line" : "lines"}. Type how many labels of each, then print.
          </p>
        </div>
        <label className="table-search">
          <Search aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, variant, barcode" aria-label="Search lines" />
        </label>
      </div>
      <div className="table-filters bo-toolbar" style={{ margin: 0 }}>
        <label className="inline muted">
          Printed on
          <select value={layout} onChange={(e) => setLayout(e.target.value === "a4" ? "a4" : "roll")}>
            <option value="roll">A label roll, 40 x 30 mm</option>
            <option value="a4">A4 sheets, 24 labels of 63.5 x 33.9 mm</option>
          </select>
        </label>
        <button type="button" className="btn-quiet btn-sm" onClick={() => setShown(() => 1)}>One of each shown</button>
        <button type="button" className="btn-quiet btn-sm" onClick={() => setShown((l) => Math.ceil(Math.max(0, l.qty) / 1000))}>As many as on hand</button>
        <button type="button" className="btn-quiet btn-sm" onClick={() => setCopies({})}>Clear</button>
        <span className="spacer" />
        <button type="button" className="btn-sm" disabled={run.length === 0} onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          Print {run.length} {run.length === 1 ? "label" : "labels"}
        </button>
      </div>
      {(bare.length > 0 || all.length > MOST_RUN || noBars > 0 || run.length > 0) && (
        <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
          {run.length > 0 && (
            <span className={`lb-try lb-${layout}`} title="The first label, at its printed size">
              <Label l={run[0]} />
            </span>
          )}
          <div style={{ flex: "1 1 320px" }}>
            {all.length > MOST_RUN && (
              <p className="note warn">One run prints {MOST_RUN} labels: the last {all.length - MOST_RUN} are left for a second run.</p>
            )}
            {noBars > 0 && (
              <p className="muted">
                {noBars === 1 ? "One line has" : `${noBars} lines have`} a maker&apos;s code that is not an EAN-13: its label carries the code as text, with no bars.
              </p>
            )}
            {bare.length > 0 && (
              <form action={makeBarcodes} className="bo-toolbar" style={{ margin: 0 }}>
                {[...new Set(bare.map((l) => l.product))].map((p) => (
                  <input key={p} type="hidden" name="p" value={p} />
                ))}
                <span className="muted">
                  {bare.length === 1 ? "One line you chose has" : `${bare.length} lines you chose have`} no barcode, so no label.
                </span>
                <Submit className="btn-sm btn-quiet">Make {bare.length === 1 ? "it an EasyPay barcode" : "them EasyPay barcodes"}</Submit>
              </form>
            )}
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Variant</th>
              <th>Barcode</th>
              <th className="num">Price</th>
              <th className="num">On hand</th>
              <th className="num">Labels</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">Nothing matches that search.</td>
              </tr>
            )}
            {shown.map((l) => (
              <tr key={l.key}>
                <td className="strong">{l.name}</td>
                <td>{l.variant ?? <span className="muted">None</span>}</td>
                <td>{l.barcode ?? <span className="badge amber">No barcode</span>}</td>
                <td className="num">{l.price_shown}</td>
                <td className="num">{(l.qty / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })}</td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={MOST_EACH}
                    value={copies[l.key] ?? 0}
                    onChange={(e) => set(l.key, Number(e.target.value))}
                    className="narrow"
                    aria-label={`Labels of ${l.name}${l.variant ? `, ${l.variant}` : ""}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body &&
        createPortal(
          <div className={`lb-sheet lb-${layout}`}>
            {layout === "roll"
              ? run.map((l, i) => <Label key={i} l={l} />)
              : pages.map((page, i) => (
                  <div key={i} className="lb-page">
                    {page.map((l, j) => (
                      <Label key={j} l={l} />
                    ))}
                  </div>
                ))}
          </div>,
          body,
        )}
    </section>
  );
}
