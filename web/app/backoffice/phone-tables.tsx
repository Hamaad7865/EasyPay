"use client";

import { useEffect } from "react";

// On a phone a table is not a grid: there is no room for its columns side by
// side. Each line is drawn as a short block instead (globals.css, "a phone: a
// table as a list"): what the line is, then each of its other cells with its
// column's title in front, "On hand 12". The titles are in the table's head,
// which a phone does not show, so they are copied here onto the cells they
// stand over, once the page is drawn and again whenever a list changes (a
// search, a filter, a line that opens). One place does it for every table of
// the back office, those not yet written included.
//
// A cell gets `data-th`, its column's title. The first cell of a line that
// says something under a title is what the line is: it gets `data-title`
// instead and is drawn large, with no title in front. A cell across several
// columns (a group's name, an open line's panel) gets neither. Five kinds of
// cell are marked for what is in them:
//   data-tick   the box that ticks a line, under no title: the line's top left corner
//   data-chev   the arrow that opens a line: its top right corner
//   data-pic    a picture to press, alone in its cell: its top right corner too
//   data-field  one box to type in or one list to choose from: half a line, its title over it
//   data-wide   buttons, a form: a line of its own
// A table marked `keep` stays a grid.

const PHONE = "(max-width: 640px)";
const BOX = 'select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])';
const PRESSED = ".row-actions, form, details, button:not(.chev):not(.btn-link):not(.picture-thumb), a.btn";

const mark = (cell: Element, name: string, on: boolean) => {
  if (cell.hasAttribute(name) !== on) cell.toggleAttribute(name, on);
};

function label(table: HTMLTableElement) {
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  // the title over each column, a title across two columns standing over both; a table with no head has none
  const titles: string[] = [];
  for (const th of head?.cells ?? []) {
    const text = (th.textContent ?? "").replace(/\s+/g, " ").trim();
    for (let i = 0; i < th.colSpan; i++) titles.push(text);
  }
  const rows = [...[...table.tBodies].flatMap((b) => [...b.rows]), ...(table.tFoot ? [...table.tFoot.rows] : [])];
  for (const tr of rows) {
    let col = 0;
    let titled = false;
    for (const cell of tr.cells) {
      const title = cell.colSpan === 1 ? (titles[col] ?? "") : "";
      col += cell.colSpan;
      const says = Boolean((cell.textContent ?? "").trim());
      const only = cell.childElementCount === 1 && !says ? cell.firstElementChild : null;
      const tick = !title && Boolean(only?.matches('input[type="checkbox"], input[type="radio"]'));
      const chev = Boolean(only?.matches("button.chev"));
      // a picture's button may hold a sign or a letter, which is not something the line says
      const pic = cell.childElementCount === 1 && cell.firstElementChild!.matches("button.picture-thumb");
      const wide = !tick && !chev && !pic && cell.querySelector(PRESSED) !== null;
      const field = !wide && cell.querySelectorAll(BOX).length === 1;
      const first = Boolean(title) && !titled && says && !pic && !wide && !field;
      if (first) titled = true;
      const th = first || pic ? null : title || null;
      if (cell.getAttribute("data-th") !== th) {
        if (th) cell.setAttribute("data-th", th);
        else cell.removeAttribute("data-th");
      }
      mark(cell, "data-title", first);
      mark(cell, "data-tick", tick);
      mark(cell, "data-chev", chev);
      mark(cell, "data-pic", pic);
      mark(cell, "data-field", field);
      mark(cell, "data-wide", wide);
    }
  }
}

export function PhoneTables() {
  useEffect(() => {
    const phone = window.matchMedia(PHONE);
    let frame = 0;
    const all = () => {
      frame = 0;
      if (!phone.matches) return;
      document.querySelectorAll<HTMLTableElement>(".bo-main table:not(.keep)").forEach(label);
    };
    // once for however many changes arrive together
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(all);
    };
    all();
    const seen = new MutationObserver(soon);
    seen.observe(document.body, { childList: true, subtree: true });
    phone.addEventListener("change", soon);
    return () => {
      seen.disconnect();
      phone.removeEventListener("change", soon);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
