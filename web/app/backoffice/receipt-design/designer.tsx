"use client";

import { useMemo, useRef, useState } from "react";
import { Submit } from "../busy";
import {
  KINDS,
  KITCHEN_VARS,
  LOCKED,
  MOST,
  RECEIPT_VARS,
  previewReceipt,
  renderKitchen,
  sampleKitchen,
  sampleReceipt,
  type Align,
  type Block,
  type Design,
  type PaperKind,
  type Size,
} from "@/lib/papers";
import { PaperPreview } from "./preview";

type Company = { name: string; brn: string; vat: string; address: string; phone: string };
type Notes = { header: string; footer: string; logo: string | null; showLogo: boolean };
type Row = Block & { id: number };

// the till release that first prints a design; one before it prints EasyPay's own
const FROM = "0.9.13";

const NAMES: Record<PaperKind, Record<string, string>> = {
  receipt: {
    logo: "Logo",
    name: "Business name",
    address: "Address",
    phone: "Phone",
    brn: "BRN",
    vat: "VAT number",
    header: "Header note",
    title: "Title",
    customer_no: "Customer number",
    receipt_no: "Receipt number",
    date_order: "Date and order",
    order_type: "Order type",
    served_by: "Served by",
    guests: "Guests",
    customer: "Customer",
    refund_of: "Refund of",
    items: "Items",
    subtotal: "Subtotal",
    discounts: "Discounts",
    service: "Service charge",
    taxes: "Taxes",
    rounding: "Rounding",
    total: "Total",
    share: "Guest's share",
    payments: "Payments",
    bill_note: "This is not a receipt",
    remark: "Remark",
    footer: "Footer note",
    barcode: "Barcode",
    text: "Text",
    line: "Line",
    space: "Space",
  },
  kitchen: {
    station: "Station",
    heading: "Order heading",
    pickup: "Pick-up time",
    time_waiter: "Time and waiter",
    type_guests: "Order type and guests",
    items: "Items",
    remark: "Remark",
    text: "Text",
    line: "Line",
    space: "Space",
  },
};

// what a block prints, said under its name when it is open
const SAYS: Record<string, string> = {
  title: "RECEIPT, BILL or REFUND, then COPY on a reprint and REFUNDED once it is.",
  customer_no: "CUSTOMER No. 05, for an order with no table. Never on a refund.",
  receipt_no: "No. S1-T1-000128. A bill has no number yet.",
  date_order: "The date and time, and the table or the order's number and name.",
  served_by: "Who took the payment, and the waiter when it is someone else.",
  customer: "The customer's name, when it is not already the order's name.",
  refund_of: "On a refund: the receipt it refunds, and why.",
  subtotal: "Only when there is a discount, a service charge or rounding.",
  share: "On one guest's copy of a split bill: what this guest paid and the tax in it.",
  payments: "Each payment, its reference, what was given and the change.",
  bill_note: "On a bill only.",
  remark: "The order's remark, when it has one.",
  barcode: "The receipt's number in bars. Returns are scanned from it, so it always prints.",
  heading: "No. 05 large then who it is for; or the table, large.",
  pickup: "PICK UP 18:30, on a takeaway.",
  station: "KITCHEN, BAR …, or VOID - KITCHEN.",
};

// what the owner can set on each kind
const WORDS = new Set(["name", "address", "phone", "brn", "vat", "header", "title", "customer_no", "bill_note", "remark", "footer", "text", "station", "heading", "pickup", "type_guests"]);
const ROWS = new Set(["receipt_no", "date_order", "order_type", "served_by", "guests", "customer", "refund_of", "subtotal", "discounts", "service", "taxes", "rounding", "total", "share", "payments", "time_waiter"]);
const MRA = new Set(["brn", "vat", "taxes"]);

const plain = (b: Row): Block => {
  const { id: _id, ...rest } = b;
  void _id;
  return rest;
};

export function Designer({
  paper,
  shop,
  initial,
  own,
  unreadable,
  receipt,
  company,
  decimals,
  canEdit,
  save,
  reset,
  now,
}: {
  paper: PaperKind;
  shop: boolean;
  initial: Design;
  own: boolean;
  unreadable: boolean;
  receipt: Notes;
  company: Company;
  decimals: number;
  canEdit: boolean;
  save: (f: FormData) => Promise<void>;
  reset: (f: FormData) => Promise<void>;
  // the made-up order's time, from the server so the page is drawn the same in the browser
  now: number;
}) {
  const next = useRef(0);
  const tag = (b: Block): Row => ({ ...b, id: next.current++ });
  const [blocks, setBlocks] = useState<Row[]>(() => initial.blocks.map(tag));
  const [open, setOpen] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [header, setHeader] = useState(receipt.header);
  const [footer, setFooter] = useState(receipt.footer);
  const [logo, setLogo] = useState<string | null>(receipt.logo);
  const [showLogo, setShowLogo] = useState(receipt.showLogo);
  const [problem, setProblem] = useState("");
  const [width, setWidth] = useState<80 | 58>(80);
  const [kind, setKind] = useState<"receipt" | "bill">("receipt");
  const [takeaway, setTakeaway] = useState(true);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const names = NAMES[paper];
  // a block that cannot print on this business's paper is kept but not offered
  const offered = (b: Row) => !(paper === "receipt" && ((!shop && b.k === "barcode") || (shop && b.k === "customer_no")));
  const locked = (b: Row) => LOCKED[paper].includes(b.k) || (shop && b.k === "barcode");

  const change = (id: number, patch: Partial<Block>) => {
    setBlocks((all) => all.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    setDirty(true);
  };
  // moves a block to stand before `to` (or last), among the ones shown
  const moveTo = (id: number, to: number | null) => {
    setBlocks((all) => {
      const from = all.findIndex((b) => b.id === id);
      if (from < 0 || id === to) return all;
      const rest = all.filter((b) => b.id !== id);
      const at = to === null ? rest.length : rest.findIndex((b) => b.id === to);
      rest.splice(at < 0 ? rest.length : at, 0, all[from]);
      return rest;
    });
    setDirty(true);
  };
  // Dragging is by the handle, with the pointer (a mouse or a finger): the
  // block goes before the first one whose middle is below where it is let go.
  const listRef = useRef<HTMLOListElement>(null);
  const before = (y: number): number | null => {
    for (const r of listRef.current?.querySelectorAll<HTMLElement>("[data-block]") ?? []) {
      const box = r.getBoundingClientRect();
      if (y < box.top + box.height / 2) return Number(r.dataset.block);
    }
    return null;
  };
  const step = (id: number, dir: -1 | 1) => {
    const shown = blocks.filter(offered);
    const i = shown.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shown.length) return;
    // up: before the one above; down: before the one after the one below
    moveTo(id, dir < 0 ? shown[j].id : (shown[j + 1]?.id ?? null));
  };
  const add = (k: "text" | "line" | "space") => {
    if (blocks.length >= MOST) return;
    const b = tag({ ...KINDS[paper][k] });
    setBlocks((all) => {
      const at = open === null ? all.length : all.findIndex((x) => x.id === open) + 1;
      const copy = all.slice();
      copy.splice(at, 0, b);
      return copy;
    });
    setOpen(b.id);
    setDirty(true);
  };
  const remove = (id: number) => {
    setBlocks((all) => all.filter((b) => b.id !== id));
    setOpen(null);
    setDirty(true);
  };

  // A logo is drawn onto a small canvas first: a thermal printer is 384 or 576
  // dots wide, so a phone photo would only slow every sync down.
  function pick(file: File | undefined) {
    setProblem("");
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setProblem("The logo must be a PNG or a JPEG image.");
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 384 / img.width, 200 / img.height);
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      const g = cv.getContext("2d");
      if (!g) return setProblem("This browser could not read the image.");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      setLogo(cv.toDataURL("image/png"));
      setShowLogo(true);
      setDirty(true);
    };
    img.onerror = () => setProblem("That file could not be read as an image.");
    img.src = url;
  }

  const columns = width === 58 ? 32 : 48;
  const design: Design = useMemo(() => ({ blocks: blocks.map(plain) }), [blocks]);
  const shopInfo = { ...company, header, footer, bars: shop };
  const shown = showLogo && logo ? logo : null;
  const preview =
    paper === "kitchen"
      ? { lines: renderKitchen(design, sampleKitchen(takeaway, now), columns), logoAt: null }
      : previewReceipt(design, sampleReceipt(kind, takeaway, shop, now), shopInfo, columns, decimals, shown !== null);
  const logoBlock = blocks.find((b) => b.k === "logo");

  const seg = <T extends string>(name: string, value: T, options: [T, string][], set: (v: T) => void) => (
    <div className="seg">
      {options.map(([v, label]) => (
        <label key={v}>
          <input type="radio" name={name} checked={value === v} onChange={() => set(v)} disabled={!canEdit} />
          {label}
        </label>
      ))}
    </div>
  );
  const tick = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} disabled={!canEdit} />
      <span>{label}</span>
    </label>
  );
  const textRef = useRef<HTMLTextAreaElement>(null);
  const insert = (b: Row, v: string) => {
    const el = textRef.current;
    const at = el ? el.selectionStart : b.text.length;
    const end = el ? el.selectionEnd : b.text.length;
    change(b.id, { text: (b.text.slice(0, at) + `{${v}}` + b.text.slice(end)).slice(0, 300) });
  };

  function settings(b: Row) {
    const id = b.id;
    const words = WORDS.has(b.k);
    const row = ROWS.has(b.k);
    const items = b.k === "items";
    return (
      <div className="pd-settings">
        {SAYS[b.k] && <p className="help" style={{ marginTop: 0 }}>{SAYS[b.k]}</p>}
        {b.k === "text" && (
          <div className="field" style={{ maxWidth: "none" }}>
            <textarea ref={textRef} value={b.text} rows={3} maxLength={300} placeholder={paper === "kitchen" ? "No. {customer_no}, for {order}" : "Wi-Fi: CafeTino, password 12345678"} onChange={(e) => change(id, { text: e.target.value })} disabled={!canEdit} />
            <span className="help">Click a variable to put it where the cursor is. One with nothing to say prints nothing, and an empty line is left out.</span>
            <div className="pd-vars">
              {(paper === "kitchen" ? KITCHEN_VARS : RECEIPT_VARS).map((v) => (
                <button key={v} type="button" className="pd-var" onClick={() => insert(b, v)} disabled={!canEdit}>
                  {"{" + v + "}"}
                </button>
              ))}
            </div>
          </div>
        )}
        {(b.k === "header" || b.k === "footer") && (
          <label className="field" style={{ maxWidth: "none" }}>
            <textarea
              value={b.k === "header" ? header : footer}
              rows={3}
              maxLength={300}
              placeholder={b.k === "header" ? "Open every day, 10:00 to 22:00" : "Thank you. See you again soon."}
              onChange={(e) => {
                (b.k === "header" ? setHeader : setFooter)(e.target.value);
                setDirty(true);
              }}
              disabled={!canEdit}
            />
            <span className="help">Also set on the tablet, under Settings, Receipt.</span>
          </label>
        )}
        {b.k === "logo" && (
          <div className="field" style={{ maxWidth: "none" }}>
            <div className="bo-toolbar" style={{ margin: 0 }}>
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => pick(e.target.files?.[0])} disabled={!canEdit} />
              {logo && (
                <button
                  type="button"
                  className="btn-quiet btn-sm"
                  onClick={() => {
                    setLogo(null);
                    setDirty(true);
                  }}
                  disabled={!canEdit}
                >
                  Remove logo
                </button>
              )}
            </div>
            <span className="help">PNG or JPEG. It prints in black and white, so a simple dark logo on white works best.</span>
            {problem && <span className="help flag">{problem}</span>}
            {tick("Print the logo", showLogo, (v) => {
              setShowLogo(v);
              setDirty(true);
            })}
          </div>
        )}
        {(words || row || items) && (
          <div className="pd-field">
            <span>Size</span>
            {seg<Size>(`${id}-size`, b.size, [["normal", "Normal"], ["tall", "Tall"], ["big", "Big"]], (v) => change(id, { size: v }))}
          </div>
        )}
        {(words || b.k === "logo") && (
          <div className="pd-field">
            <span>Alignment</span>
            {seg<Align>(`${id}-align`, b.align, [["left", "Left"], ["center", "Centre"], ["right", "Right"]], (v) => change(id, { align: v }))}
          </div>
        )}
        {items && paper === "receipt" && (
          <>
            <div className="pd-field">
              <span>Add-ons</span>
              {seg(`${id}-addons`, b.addons, [["line", "On one line"], ["rows", "One per row"]], (v) => change(id, { addons: v }))}
            </div>
            {tick("Show each add-on's price (the item then shows its own price)", b.addonPrices, (v) => change(id, { addonPrices: v }))}
            {tick("Show the price of one under a line of more than one (2 x 50.00)", b.unitPrice, (v) => change(id, { unitPrice: v }))}
            {tick("Show the notes", b.notes, (v) => change(id, { notes: v }))}
            {tick("Show the old price when it was changed (was 120.00, 10% off)", b.was, (v) => change(id, { was: v }))}
          </>
        )}
        {items && paper === "kitchen" && (
          <>
            <div className="pd-field">
              <span>Add-ons</span>
              {seg(`${id}-addons`, b.addons, [["groups", "A line per group"], ["line", "All on one line"]], (v) => change(id, { addons: v }))}
            </div>
            {tick("Show the seat", b.seat, (v) => change(id, { seat: v }))}
            {tick("Show the notes", b.notes, (v) => change(id, { notes: v }))}
          </>
        )}
        {b.k === "line" && (
          <div className="pd-field">
            <span>Drawn with</span>
            {seg(`${id}-ch`, b.ch, [["-", "- - - -"], ["=", "= = = ="]], (v) => change(id, { ch: v }))}
          </div>
        )}
        {b.k === "space" && (
          <div className="pd-field">
            <span>Blank lines</span>
            {seg(`${id}-n`, String(b.n), ["1", "2", "3", "4", "5"].map((v) => [v, v] as [string, string]), (v) => change(id, { n: Number(v) }))}
          </div>
        )}
        {(words || row || items) && tick("Bold", b.bold, (v) => change(id, { bold: v }))}
        {(words || row || items || b.k === "logo") && tick("A line above it", b.above, (v) => change(id, { above: v }))}
        <div className="bo-toolbar" style={{ margin: "4px 0 0" }}>
          <button type="button" className="btn-quiet btn-sm" onClick={() => step(id, -1)} disabled={!canEdit}>
            Move up
          </button>
          <button type="button" className="btn-quiet btn-sm" onClick={() => step(id, 1)} disabled={!canEdit}>
            Move down
          </button>
          <span className="spacer" />
          {(b.k === "text" || b.k === "line" || b.k === "space") && (
            <button type="button" className="btn-danger btn-sm" onClick={() => remove(id)} disabled={!canEdit}>
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }

  const summary = (b: Row) =>
    b.k === "text" ? b.text.split("\n")[0].slice(0, 32) : b.k === "line" ? (b.ch === "=" ? "= = =" : "- - -") : b.k === "space" ? `${b.n} blank line${b.n > 1 ? "s" : ""}` : "";

  return (
    <div className="pd">
      <div>
        {unreadable && (
          <p className="help flag" style={{ marginTop: 0 }}>
            The design kept for this paper could not be read, so the tills print EasyPay&apos;s. Saving puts yours in its place.
          </p>
        )}
        <ol className="pd-list" ref={listRef}>
          {blocks.filter(offered).map((b) => {
            const isOpen = open === b.id;
            const lock = locked(b);
            return (
              <li key={b.id}>
                <div className={"pd-block" + (isOpen ? " open" : "") + (b.hide ? " off" : "") + (over === b.id && dragging !== b.id ? " drop" : "")} data-block={b.id}>
                  <span
                    className="pd-grip"
                    title={canEdit ? "Drag to move" : undefined}
                    onPointerDown={(e) => {
                      if (!canEdit) return;
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDragging(b.id);
                    }}
                    onPointerMove={(e) => {
                      if (dragging === null) return;
                      setOver(before(e.clientY) ?? -1);
                    }}
                    onPointerUp={(e) => {
                      if (dragging !== null) moveTo(dragging, before(e.clientY));
                      setDragging(null);
                      setOver(null);
                    }}
                    onPointerCancel={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  >
                    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
                      {[3, 8, 13].flatMap((y) => [<circle key={"a" + y} cx="2.5" cy={y} r="1.4" />, <circle key={"b" + y} cx="7.5" cy={y} r="1.4" />])}
                    </svg>
                  </span>
                  <button type="button" className="pd-name" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}>
                    {names[b.k] ?? b.k}
                    {summary(b) && <small>{summary(b)}</small>}
                  </button>
                  {lock ? (
                    <span className="pd-icon" title="Always printed: it can be moved, not hidden">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                      </svg>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="pd-icon"
                      title={b.hide ? "Hidden: click to print it" : "Printed: click to hide it"}
                      aria-pressed={!b.hide}
                      onClick={() => change(b.id, { hide: !b.hide })}
                      disabled={!canEdit}
                    >
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                        <circle cx="12" cy="12" r="3" />
                        {b.hide && <path d="M4 4l16 16" />}
                      </svg>
                    </button>
                  )}
                </div>
                {b.hide && MRA.has(b.k) && <p className="pd-warn">A receipt without these may not satisfy the MRA. Check with your accountant.</p>}
                {isOpen && settings(b)}
              </li>
            );
          })}
          <li className={"pd-end" + (over === -1 ? " drop" : "")} />
        </ol>
        <div className="bo-toolbar">
          <span className="muted">Add a block{open !== null ? " under the open one" : ""}:</span>
          {(["text", "line", "space"] as const).map((k) => (
            <button key={k} type="button" className="btn-quiet btn-sm" onClick={() => add(k)} disabled={!canEdit || blocks.length >= MOST}>
              {NAMES[paper][k]}
            </button>
          ))}
        </div>
        <div className="bo-toolbar" style={{ marginTop: 16 }}>
          <form action={save}>
            <input type="hidden" name="design" value={JSON.stringify({ v: 1, blocks: design.blocks })} />
            {paper === "receipt" && (
              <>
                <input type="hidden" name="header" value={header} />
                <input type="hidden" name="footer" value={footer} />
                <input type="hidden" name="logo" value={logo ?? ""} />
                <input type="hidden" name="showLogo" value={showLogo ? "on" : ""} />
              </>
            )}
            <Submit disabled={!canEdit}>{paper === "kitchen" ? "Save kitchen ticket" : "Save receipt design"}</Submit>
          </form>
          {dirty && <span className="muted">Not saved yet</span>}
          <span className="spacer" />
          <form
            action={reset}
            onSubmit={(e) => {
              if (!confirm("Go back to EasyPay's design? This paper's blocks and their settings are taken away. The logo and the notes stay.")) e.preventDefault();
            }}
          >
            <input type="hidden" name="paper" value={paper} />
            <Submit className="btn-quiet" disabled={!canEdit || !own}>
              Back to EasyPay&apos;s design
            </Submit>
          </form>
        </div>
        {!own && !unreadable && <p className="help">This paper prints EasyPay&apos;s design until you save one.</p>}
      </div>
      <div className="pd-preview">
        <div className="bo-toolbar">
          <strong>Preview</strong>
          <span className="spacer" />
          {seg<"80" | "58">("pd-width", String(width) as "80" | "58", [["80", "80 mm"], ["58", "58 mm"]], (v) => setWidth(v === "58" ? 58 : 80))}
        </div>
        <div className="bo-toolbar" style={{ marginTop: -4 }}>
          {paper === "receipt" && seg<"receipt" | "bill">("pd-kind", kind, [["receipt", "Receipt"], ["bill", "Bill"]], setKind)}
          {!shop && seg<"t" | "s">("pd-order", takeaway ? "t" : "s", [["t", "Takeaway, No. 05"], ["s", "Table 4"]], (v) => setTakeaway(v === "t"))}
        </div>
        <div className="paper-wrap">
          <PaperPreview lines={preview.lines} columns={columns} logo={shown} logoAt={preview.logoAt} logoAlign={logoBlock?.align ?? "center"} />
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          A made-up order, with your business&apos;s details. The paper width of each printer is set under Printers. Tills print this design from version {FROM}; a till
          not yet updated prints EasyPay&apos;s own until it is.
        </p>
      </div>
    </div>
  );
}
