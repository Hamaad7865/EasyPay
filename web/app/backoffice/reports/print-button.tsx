"use client";

import { Download, Printer } from "lucide-react";

// Prints the report as it is on screen (the sidebar and the filters are left
// out by the print styles). "Save as PDF" in the print dialog makes the PDF.
export function PrintButton() {
  return (
    <button type="button" className="btn-quiet" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print or save as PDF
    </button>
  );
}

const NUMBER = /^-?\d+(\.\d+)?%?$/;

// One cell of the file. An amount loses its "Rs" and its thousands commas so a
// spreadsheet adds it up as a number. A cell a spreadsheet would run as a
// formula (a name starting with = + - or @) is marked as plain text.
function cell(el: Element): string {
  let t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const plain = t.replace(/^(-?)Rs\s*/, "$1").replace(/,/g, "");
  if (el.classList.contains("num") && NUMBER.test(plain)) t = plain;
  else if (/^[=+\-@]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// The same figures as a file: every table of the report as it is on screen,
// with the days and filters that were picked, each under its heading. Nothing
// is worked out again here, so the file cannot say something the page does not.
export function CsvButton() {
  const download = () => {
    const main = document.querySelector("main.bo-main");
    if (!main) return;
    const title = (main.querySelector("h1")?.textContent ?? "Report").trim();
    const days = ["from", "to"].map((n) => (main.querySelector(`.filters input[name="${n}"]`) as HTMLInputElement | null)?.value ?? "").filter(Boolean);
    const out: string[] = [];
    out.push([title, ...days].map((v) => (/[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(","));
    // the figures above the tables, with their notes: a list that is cut short says so there
    const stats = [...main.querySelectorAll(".stats .stat")];
    if (stats.length > 0) out.push("");
    stats.forEach((st) => {
      const part = (sel: string) => st.querySelector(sel);
      const row = [part(".stat-label"), part(".stat-value"), part(".stat-note")].filter((e): e is Element => e !== null);
      const cells = row.map((e) => (e.classList.contains("stat-value") ? cell(Object.assign(document.createElement("span"), { className: "num", textContent: e.textContent })) : cell(e)));
      if (cells.length > 0) out.push(cells.join(","));
    });
    main.querySelectorAll("table").forEach((table) => {
      // a table says what it is with the heading of its card, or the one before it
      const head = table.closest(".card")?.querySelector("h2")?.textContent?.trim();
      out.push("");
      if (head) out.push(cell(Object.assign(document.createElement("span"), { textContent: head })));
      table.querySelectorAll("tr").forEach((tr) => {
        // the share bars are drawings, and the empty heading above them goes with them
        const cells = [...tr.children].filter((c) => !c.querySelector(".bar")).map(cell);
        while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
        if (cells.length > 0) out.push(cells.join(","));
      });
    });
    if (out.length === 1) out.push("", "Nothing in these days.");
    // the mark at the start tells Excel the file is UTF-8, so "sautées" stays "sautées"
    const blob = new Blob(["﻿" + out.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = [title, ...days].join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <button type="button" className="btn-quiet" onClick={download}>
      <Download aria-hidden="true" />
      Download CSV
    </button>
  );
}
