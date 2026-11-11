"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Heading2, Plus, Printer, StickyNote, Trash2, UserPlus, X } from "lucide-react";
import { parseRs } from "@/lib/money";
import { money } from "@/lib/settings";
import { lineAmount } from "@/lib/receipt-doc";
import { dueOf, exclOf, figures, type InvTax, lineFits, parseQty, percentOff, priceAfter, qtyText, TERMS, termsWords } from "@/lib/invoice-money";
import { addCustomer, customerGlance, deleteDraft, issueInvoice, saveDraft, searchCustomers, searchProducts, type SentHead, type SentLine, stockFor } from "../actions";
import type { CustomerHit, Found, Glance, Invoice } from "../data";
import { GlanceCard } from "../glance";

// An invoice being written (docs/superpowers/specs/2026-11-12-invoices-design.md). Keyboard first: the box under
// the lines finds a product by name, SKU or barcode and Enter adds it (a scanner works the same); Tab moves
// along a line; Enter on a line goes back to the box. What is typed keeps itself: a second after the last key it
// is saved, one save at a time, and until then it is kept in this browser too, so a reload loses nothing.
// The figures are the till's own (lib/invoice-money.ts), and the database works them out again on every save.

export type Tax = { id: string; name: string; rate_bp: number; type: string };
type Kind = "line" | "heading" | "note";
type Ed = {
  key: string;
  kind: Kind;
  item_id: string | null;
  variant_id: string | null;
  name: string;
  detail: string;
  sku: string | null;
  // as typed: "2", "2.5"; "1,250.50"
  qty: string;
  price: string;
  // the catalog's price, when the price was lowered from it, and the percent off as typed
  list: number | null;
  off: string;
  taxes: InvTax[];
  cost: number | null;
  more: boolean;
};
type Head = {
  customer_id: string;
  buyer_type: "B2C" | "B2B" | "B2G";
  buyer_name: string;
  buyer_email: string;
  buyer_cc: string;
  buyer_phone: string;
  buyer_address: string;
  buyer_contact: string;
  buyer_brn: string;
  buyer_vat: string;
  deliver_to: string;
  issued_on: string;
  terms: string;
  due_on: string;
  cust_ref: string;
  our_ref: string;
  rep_id: string;
  lang: "en" | "fr";
  show_excl: boolean;
  note: string;
  disc_type: "amount" | "percent";
  disc: string;
  remember: boolean;
};

const centsText = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const offText = (bp: number) => (bp <= 0 ? "" : bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, ""));
let seq = 0;
const newKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;
const stockKey = (item: string | null, variant: string | null) => `${item}|${variant ?? ""}`;

const headOf = (i: Invoice): Head => ({
  customer_id: i.customer_id ?? "",
  buyer_type: i.buyer_type,
  buyer_name: i.buyer_name ?? "",
  buyer_email: i.buyer_email ?? "",
  buyer_cc: i.buyer_cc ?? "",
  buyer_phone: i.buyer_phone ?? "",
  buyer_address: i.buyer_address ?? "",
  buyer_contact: i.buyer_contact ?? "",
  buyer_brn: i.buyer_brn ?? "",
  buyer_vat: i.buyer_vat ?? "",
  deliver_to: i.deliver_to ?? "",
  issued_on: i.issued_on,
  terms: i.terms,
  due_on: i.due_on ?? "",
  cust_ref: i.cust_ref ?? "",
  our_ref: i.our_ref ?? "",
  rep_id: i.rep_id ?? "",
  lang: i.lang,
  show_excl: i.show_excl,
  note: i.note ?? "",
  disc_type: i.disc_type,
  disc: i.disc_value > 0 ? (i.disc_type === "percent" ? String(i.disc_value) : centsText(i.disc_value)) : "",
  remember: true,
});
const linesOf = (i: Invoice): Ed[] =>
  i.lines.map((l) => ({
    key: l.id,
    kind: l.kind,
    item_id: l.item_id,
    variant_id: l.variant_id,
    name: l.name,
    detail: l.detail ?? "",
    sku: l.sku,
    qty: l.kind === "line" ? qtyText(l.qty) : "",
    price: l.kind === "line" ? centsText(l.unit_price) : "",
    list: l.list_price,
    off: l.list_price !== null ? offText(percentOff(l.list_price, l.unit_price)) : "",
    taxes: l.taxes,
    cost: l.unit_cost,
    more: !!l.detail,
  }));

const discValue = (h: Head) => (h.disc_type === "percent" ? Math.max(0, Math.min(100, parseInt(h.disc, 10) || 0)) : (parseRs(h.disc) ?? 0));
const sentHead = (h: Head): SentHead => ({
  customer_id: h.customer_id || null,
  buyer_type: h.buyer_type,
  buyer_name: h.buyer_name,
  buyer_email: h.buyer_email,
  buyer_cc: h.buyer_cc,
  buyer_phone: h.buyer_phone,
  buyer_address: h.buyer_address,
  buyer_contact: h.buyer_contact,
  buyer_brn: h.buyer_brn,
  buyer_vat: h.buyer_vat,
  deliver_to: h.deliver_to,
  issued_on: h.issued_on,
  terms: h.terms,
  due_on: h.terms === "date" ? h.due_on || null : null,
  cust_ref: h.cust_ref,
  our_ref: h.our_ref,
  rep_id: h.rep_id || null,
  lang: h.lang,
  show_excl: h.show_excl,
  note: h.note,
  disc_type: h.disc_type,
  disc_value: discValue(h),
  remember: !!h.customer_id && h.remember,
});
const sentLines = (ls: Ed[]): SentLine[] =>
  ls.map((l) =>
    l.kind === "line"
      ? {
          kind: "line",
          item_id: l.item_id,
          variant_id: l.variant_id,
          name: l.name,
          detail: l.detail,
          sku: l.sku,
          qty: parseQty(l.qty) ?? 0,
          unit_price: parseRs(l.price) ?? 0,
          list_price: l.list,
          tax_ids: l.taxes.map((t) => t.tax_id).filter((t): t is string => !!t),
        }
      : { kind: l.kind, item_id: null, variant_id: null, name: l.name, detail: "", sku: null, qty: 0, unit_price: 0, list_price: null, tax_ids: [] },
  );
const payloadOf = (h: Head, ls: Ed[]) => JSON.stringify([sentHead(h), sentLines(ls)]);

type Status = "saved" | "waiting" | "saving" | "error" | "stale";

export function InvoiceEditor(p: {
  inv: Invoice;
  taxes: Tax[];
  staff: { id: string; name: string }[];
  branch: string | null;
  today: string;
  next: string;
  stock: Record<string, number | null>;
  glance: Glance | null;
  decimals: number;
  costs: boolean;
  shop: boolean;
  mra: boolean;
}) {
  const { inv, decimals, shop } = p;
  const router = useRouter();
  const rs = (c: number) => money(c, decimals);
  const [head, setHead] = useState<Head>(() => headOf(inv));
  const [lines, setLines] = useState<Ed[]>(() => linesOf(inv));
  const [stock, setStock] = useState(p.stock);
  const [glance, setGlance] = useState<Glance | null>(p.glance);
  const [glancing, setGlancing] = useState(false);
  const [status, setStatus] = useState<Status>("saved");
  const [problem, setProblem] = useState("");
  const [asking, setAsking] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [offer, setOffer] = useState<{ head: Head; lines: Ed[] } | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const put = (patch: Partial<Head>) => setHead((h) => ({ ...h, ...patch }));

  // ---- keeping it: one save at a time, the last word always saved, a copy in the browser meanwhile ----
  const KEY = `invoice-draft-${inv.id}`;
  const rev = useRef(inv.rev);
  const latest = useRef({ head, lines });
  latest.current = { head, lines };
  const payload = useMemo(() => payloadOf(head, lines), [head, lines]);
  const saved = useRef(payload);
  const flying = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const backup = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ rev: rev.current, ...latest.current }));
    } catch {}
  };
  const forget = () => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
  };
  const saveNow = async (): Promise<void> => {
    if (stopped.current) return;
    if (flying.current) return flying.current;
    const snap = latest.current;
    const sending = payloadOf(snap.head, snap.lines);
    if (sending === saved.current) {
      setStatus("saved");
      return;
    }
    const run = (async () => {
      setStatus("saving");
      const r = await saveDraft(inv.id, rev.current, sentHead(snap.head), sentLines(snap.lines));
      if (r.ok) {
        rev.current = r.rev;
        saved.current = sending;
        setProblem("");
      } else {
        setProblem(r.error);
        // changed elsewhere, issued, gone: saving again would only be refused again
        if (["invoice-changed", "invoice-issued", "invoice-gone"].includes(r.code)) stopped.current = true;
        setStatus(stopped.current ? "stale" : "error");
      }
      return;
    })();
    flying.current = run;
    try {
      await run;
    } finally {
      flying.current = null;
    }
    if (stopped.current) return;
    const now = payloadOf(latest.current.head, latest.current.lines);
    if (now === saved.current) {
      forget();
      setStatus("saved");
    } else if (saved.current === sending) {
      // typed on while it was away: the copy here carries the new number, then the rest is saved
      backup();
      return saveNow();
    }
  };
  // every change: kept here at once, saved a moment after the last key
  useEffect(() => {
    if (payload === saved.current || stopped.current || issuing) return;
    backup();
    setStatus("waiting");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void saveNow();
    }, 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);
  // what was typed here and never reached the server, on top of what it still has: offered back once
  useEffect(() => {
    try {
      const b = JSON.parse(localStorage.getItem(KEY) ?? "null") as { rev: number; head: Head; lines: Ed[] } | null;
      if (b && b.rev === inv.rev && payloadOf(b.head, b.lines) !== saved.current) setOffer({ head: b.head, lines: b.lines });
      else if (b) localStorage.removeItem(KEY);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // leaving with something not saved yet asks first; Ctrl+S saves now
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (status !== "saved" && status !== "stale") e.preventDefault();
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        void saveNow();
      }
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("keydown", keys);
    };
  });

  // ---- the figures, as the till works them out ----
  const fig = useMemo(
    () =>
      figures(
        lines.filter((l) => l.kind === "line").map((l) => ({ qty: parseQty(l.qty) ?? 0, unit_price: parseRs(l.price) ?? 0, taxes: l.taxes })),
        { type: head.disc_type, value: discValue(head) },
      ),
    [lines, head],
  );
  const due = dueOf(head.issued_on, head.terms, head.due_on || null);

  // ---- lines ----
  const change = (key: string, patch: Partial<Ed>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const move = (key: string, by: -1 | 1) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const drop = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const blank = (kind: Kind, name = ""): Ed => ({ key: newKey(), kind, item_id: null, variant_id: null, name, detail: "", sku: null, qty: kind === "line" ? "1" : "", price: "", list: null, off: "", taxes: [], cost: null, more: false });
  // a product found: added, or one more of it when it is the line just above (a scanner, scanning twice)
  const addProduct = (f: { item_id: string; variant_id: string | null; name: string; sku: string | null; price: number; taxes: InvTax[]; cost: number | null }) => {
    setLines((ls) => {
      const last = ls[ls.length - 1];
      if (last && last.kind === "line" && last.item_id === f.item_id && last.variant_id === f.variant_id && parseRs(last.price) === f.price) {
        const q = (parseQty(last.qty) ?? 0) + 1000;
        return [...ls.slice(0, -1), { ...last, qty: qtyText(q) }];
      }
      return [...ls, { ...blank("line", f.name), item_id: f.item_id, variant_id: f.variant_id, sku: f.sku, price: centsText(f.price), list: null, taxes: f.taxes, cost: f.cost }];
    });
  };
  const fetchStock = async (keys: { item_id: string; variant_id: string | null }[]) => {
    const got = await stockFor(inv.store_id, keys);
    setStock((s) => ({ ...s, ...got }));
  };
  const backToFind = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      findRef.current?.focus();
    }
  };

  // ---- the customer ----
  const pickCustomer = async (c: CustomerHit) => {
    const d = c.details;
    put({
      customer_id: c.id,
      buyer_name: c.name,
      buyer_phone: c.phone ?? "",
      buyer_email: c.email ?? "",
      buyer_type: d?.buyer_type ?? "B2C",
      buyer_address: d?.address ?? "",
      buyer_brn: d?.brn ?? "",
      buyer_vat: d?.vat_no ?? "",
      buyer_cc: d?.email_cc ?? "",
      buyer_contact: d?.contact ?? "",
      deliver_to: d?.deliver_to ?? "",
      ...(d?.lang ? { lang: d.lang } : {}),
      ...(d?.terms ? { terms: d.terms } : {}),
      remember: true,
    });
    setGlancing(true);
    setGlance(await customerGlance(c.id));
    setGlancing(false);
  };
  const letGo = () => {
    put({ customer_id: "" });
    setGlance(null);
  };

  // ---- issuing ----
  const lineRows = lines.filter((l) => l.kind === "line");
  const blockers: string[] = [];
  if (!head.buyer_name.trim()) blockers.push("Say who the invoice is for.");
  if (head.buyer_type !== "B2C" && !head.buyer_brn.trim()) blockers.push(`A ${head.buyer_type === "B2B" ? "business" : "government"} buyer needs their BRN.`);
  if (lineRows.length === 0) blockers.push(`Add at least one ${shop ? "product" : "item"} or line.`);
  if (lineRows.some((l) => !l.name.trim() || !parseQty(l.qty))) blockers.push("A line has no description or no quantity.");
  if (lineRows.some((l) => parseRs(l.price) === null || parseQty(l.qty) === null)) blockers.push("A quantity or a price is not a number.");
  if (head.issued_on > p.today) blockers.push("An invoice cannot be dated after today.");
  if (head.terms === "date" && (!head.due_on || head.due_on < head.issued_on)) blockers.push("Pick the day it is due, on or after the invoice's date.");
  const short = lineRows.filter((l) => {
    const s = stock[stockKey(l.item_id, l.variant_id)];
    return l.item_id && s !== undefined && s !== null && (parseQty(l.qty) ?? 0) > s;
  });

  const issue = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    while (flying.current) await flying.current;
    if (stopped.current) return;
    setIssuing(true);
    const snap = latest.current;
    const r = await issueInvoice(inv.id, rev.current, sentHead(snap.head), sentLines(snap.lines));
    if (r.ok) {
      stopped.current = true;
      saved.current = payloadOf(snap.head, snap.lines);
      forget();
      setStatus("saved");
      router.refresh();
      return;
    }
    setIssuing(false);
    setAsking(false);
    setProblem(r.error);
    if (["invoice-changed", "invoice-issued", "invoice-gone"].includes(r.code)) {
      stopped.current = true;
      setStatus("stale");
    } else void saveNow();
  };
  const printIt = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (payload === saved.current) return;
    e.preventDefault();
    const w = window.open("about:blank", "_blank");
    if (timer.current) clearTimeout(timer.current);
    await saveNow();
    if (w) w.location.href = `/backoffice/invoices/${inv.id}/print`;
  };

  const said = {
    saved: "Saved",
    waiting: "Not saved yet",
    saving: "Saving…",
    error: problem || "Not saved",
    stale: problem || "Not saved",
  }[status];
  const many = lineRows.length;
  const word = shop ? "product" : "item";
  const aWord = shop ? "a product" : "an item";

  return (
    <div className="inv-ed">
      {offer && (
        <div className="note warn inv-offer" role="alert">
          <span>Something typed on this invoice in this browser was not saved before the page closed.</span>
          <button type="button" className="btn-sm" onClick={() => { setHead(offer.head); setLines(offer.lines); setOffer(null); }}>
            Bring it back
          </button>
          <button type="button" className="btn-quiet btn-sm" onClick={() => { forget(); setOffer(null); }}>
            Leave it
          </button>
        </div>
      )}
      {status === "stale" && (
        <div className="note danger" role="alert">
          {problem} <button type="button" className="btn-link" onClick={() => window.location.reload()}>Reload the page</button>
          <span className="muted"> What was typed here stays in this browser, and is offered back after the reload when it can be.</span>
        </div>
      )}
      <fieldset className="inv-ed-grid" disabled={issuing || status === "stale"}>
        <div className="inv-ed-main">
          {/* ---- bill to ---- */}
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Bill to</h2>
              </div>
              <div className="seg" role="radiogroup" aria-label="Who is buying">
                {(
                  [
                    ["B2C", "A person"],
                    ["B2B", "A business"],
                    ["B2G", "Government"],
                  ] as const
                ).map(([v, t]) => (
                  <label key={v}>
                    <input type="radio" name="buyer_type" checked={head.buyer_type === v} onChange={() => put({ buyer_type: v })} />
                    {t}
                  </label>
                ))}
              </div>
            </div>
            <div className="card-body">
              {head.customer_id ? (
                <p className="inv-picked">
                  <span>
                    Customer: <strong>{glance?.name ?? head.buyer_name}</strong>
                  </span>
                  <button type="button" className="btn-link" onClick={letGo}>
                    Not this customer
                  </button>
                </p>
              ) : (
                <CustomerFind onPick={pickCustomer} />
              )}
              <div className="form-row">
                <label className="field">
                  Name on the invoice
                  <input value={head.buyer_name} onChange={(e) => put({ buyer_name: e.target.value })} maxLength={200} placeholder="Port Louis Traders Ltd" />
                </label>
                {head.buyer_type !== "B2C" ? (
                  <label className="field">
                    BRN
                    <input value={head.buyer_brn} onChange={(e) => put({ buyer_brn: e.target.value })} maxLength={40} placeholder="C07012345" className={head.buyer_brn.trim() ? undefined : "inv-want"} />
                  </label>
                ) : (
                  <label className="field">
                    Phone
                    <input value={head.buyer_phone} onChange={(e) => put({ buyer_phone: e.target.value })} maxLength={60} inputMode="tel" />
                  </label>
                )}
                {head.buyer_type !== "B2C" && (
                  <>
                    <label className="field">
                      VAT number
                      <input value={head.buyer_vat} onChange={(e) => put({ buyer_vat: e.target.value })} maxLength={40} placeholder="If they have one" />
                    </label>
                    <label className="field">
                      Phone
                      <input value={head.buyer_phone} onChange={(e) => put({ buyer_phone: e.target.value })} maxLength={60} inputMode="tel" />
                    </label>
                  </>
                )}
                <label className="field">
                  Address
                  <textarea rows={2} value={head.buyer_address} onChange={(e) => put({ buyer_address: e.target.value })} maxLength={500} />
                </label>
                <label className="field">
                  Email
                  <input type="email" value={head.buyer_email} onChange={(e) => put({ buyer_email: e.target.value })} maxLength={200} />
                </label>
              </div>
              <details className="inv-more" open={!!(head.buyer_contact || head.buyer_cc || head.deliver_to) || undefined}>
                <summary>Contact person, copy to, deliver to</summary>
                <div className="form-row">
                  <label className="field">
                    Contact person
                    <input value={head.buyer_contact} onChange={(e) => put({ buyer_contact: e.target.value })} maxLength={200} />
                  </label>
                  <label className="field">
                    Copy the email to
                    <input value={head.buyer_cc} onChange={(e) => put({ buyer_cc: e.target.value })} maxLength={200} placeholder="accounts@…" />
                  </label>
                  <label className="field">
                    Deliver to, if not the address
                    <textarea rows={2} value={head.deliver_to} onChange={(e) => put({ deliver_to: e.target.value })} maxLength={500} />
                  </label>
                </div>
              </details>
              {head.customer_id && (
                <label className="check inv-remember">
                  <input type="checkbox" checked={head.remember} onChange={(e) => put({ remember: e.target.checked })} />
                  Keep these details for their next invoice
                </label>
              )}
            </div>
          </section>

          {/* ---- dates and terms ---- */}
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Dates and terms</h2>
              </div>
              {p.branch && <span className="muted inv-small">From {p.branch}</span>}
            </div>
            <div className="card-body inv-terms">
              <label className="field">
                Invoice date
                <input type="date" value={head.issued_on} max={p.today} onChange={(e) => e.target.value && put({ issued_on: e.target.value })} />
              </label>
              <label className="field">
                Payment terms
                <select value={head.terms} onChange={(e) => put({ terms: e.target.value })}>
                  {[...TERMS, ...(TERMS.includes(head.terms as (typeof TERMS)[number]) ? [] : [head.terms])].map((t) => (
                    <option key={t} value={t}>{termsWords(t)}</option>
                  ))}
                </select>
              </label>
              {head.terms === "date" ? (
                <label className="field">
                  Due on
                  <input type="date" value={head.due_on} min={head.issued_on} onChange={(e) => put({ due_on: e.target.value })} />
                </label>
              ) : (
                <div className="field">
                  Due on
                  <output className="inv-due">{due}</output>
                </div>
              )}
              <label className="field">
                Their order number
                <input value={head.cust_ref} onChange={(e) => put({ cust_ref: e.target.value })} maxLength={80} placeholder="PO 4471" />
              </label>
              <label className="field">
                Our reference
                <input value={head.our_ref} onChange={(e) => put({ our_ref: e.target.value })} maxLength={80} />
              </label>
              <label className="field">
                Sold by
                <select value={head.rep_id} onChange={(e) => put({ rep_id: e.target.value })}>
                  <option value="">Nobody named</option>
                  {p.staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                On paper in
                <select value={head.lang} onChange={(e) => put({ lang: e.target.value === "fr" ? "fr" : "en" })}>
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                </select>
              </label>
              <label className="check inv-excl">
                <input type="checkbox" checked={head.show_excl} onChange={(e) => put({ show_excl: e.target.checked })} />
                Show prices before VAT on paper
              </label>
            </div>
          </section>

          {/* ---- lines ---- */}
          <section className="card flush">
            <div className="card-head">
              <div>
                <h2>Lines</h2>
                <p>{many === 0 ? `Find ${aWord} below, or type a line of your own.` : many === 1 ? "1 line" : `${many} lines`}</p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="inv-lines">
                <thead>
                  <tr>
                    <th className="inv-c-move" aria-label="Order" />
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th className="num">Off %</th>
                    <th>Tax</th>
                    <th className="num">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <LineRow
                      key={l.key}
                      l={l}
                      first={i === 0}
                      last={i === lines.length - 1}
                      taxes={p.taxes}
                      stock={l.item_id ? stock[stockKey(l.item_id, l.variant_id)] : undefined}
                      costs={p.costs}
                      rs={rs}
                      change={change}
                      move={move}
                      drop={drop}
                      onKey={backToFind}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inv-find-row">
              <ProductFind
                store={inv.store_id}
                shop={shop}
                rs={rs}
                inputRef={findRef}
                onPick={(f) => {
                  addProduct(f);
                  setStock((s) => ({ ...s, [stockKey(f.item_id, f.variant_id)]: f.stock }));
                }}
                onFree={(name) => setLines((ls) => [...ls, blank("line", name)])}
              />
              <button type="button" className="btn-quiet btn-sm" onClick={() => setLines((ls) => [...ls, blank("heading")])}>
                <Heading2 aria-hidden="true" />
                Heading
              </button>
              <button type="button" className="btn-quiet btn-sm" onClick={() => setLines((ls) => [...ls, blank("note")])}>
                <StickyNote aria-hidden="true" />
                Note
              </button>
            </div>
            {short.length > 0 && (
              <p className="note warn inv-short">
                <AlertTriangle aria-hidden="true" />
                <span>
                  {short.map((l) => l.name).join(", ")}: more than {p.branch ?? "the branch"} holds. Issuing takes {short.length === 1 ? "it" : "them"} below
                  zero, as a sale at the till would.
                </span>
              </p>
            )}
          </section>

          {/* ---- totals and note ---- */}
          <div className="inv-bottom">
            <section className="card">
              <div className="card-body">
                <label className="field inv-wide">
                  Note on the invoice
                  <textarea rows={3} value={head.note} onChange={(e) => put({ note: e.target.value })} maxLength={2000} placeholder="Delivery on Thursday. Warranty one year." />
                </label>
              </div>
            </section>
            <section className="card inv-totals">
              <div className="card-body">
                <dl className="kv">
                  <dt>Lines</dt>
                  <dd>{rs(fig.subtotal)}</dd>
                  <dt className="inv-disc">
                    Discount
                    <select aria-label="Discount in" value={head.disc_type} onChange={(e) => put({ disc_type: e.target.value === "percent" ? "percent" : "amount", disc: "" })}>
                      <option value="percent">%</option>
                      <option value="amount">Rs</option>
                    </select>
                    <input
                      aria-label="Discount"
                      inputMode="decimal"
                      value={head.disc}
                      onChange={(e) => put({ disc: e.target.value })}
                      placeholder="0"
                      className={head.disc && (head.disc_type === "percent" ? !/^\d{1,3}$/.test(head.disc.trim()) : parseRs(head.disc) === null) ? "inv-bad" : undefined}
                    />
                  </dt>
                  <dd>{fig.discount ? "−" + rs(fig.discount) : rs(0)}</dd>
                  {fig.taxes.filter((t) => !t.included).map((t) => (
                    <FragmentRow key={t.key} label={`${t.name} ${t.rateBp / 100}%`} value={rs(t.amount)} />
                  ))}
                  <dt className="total">Total</dt>
                  <dd className="total">{rs(fig.total)}</dd>
                  {fig.taxes.filter((t) => t.included).map((t) => (
                    <FragmentRow key={t.key} label={`of which ${t.name} ${t.rateBp / 100}%`} value={rs(t.amount)} muted />
                  ))}
                </dl>
              </div>
            </section>
          </div>
        </div>

        <GlanceCard
          id={head.customer_id || null}
          g={head.customer_id ? glance : null}
          today={p.today}
          decimals={decimals}
          shop={shop}
          loading={glancing}
          onAdd={(o) => {
            addProduct({ item_id: o.item_id, variant_id: o.variant_id, name: o.name, sku: o.sku, price: o.last_price, taxes: o.taxes, cost: null });
            void fetchStock([{ item_id: o.item_id, variant_id: o.variant_id }]);
          }}
        />
      </fieldset>

      {/* ---- the foot: where the save stands, and what to do next ---- */}
      <div className="inv-foot">
      {asking && !p.mra && (
        <div className="inv-ask card" role="dialog" aria-label="Issue this invoice">
          <div className="card-body">
            {blockers.length > 0 ? (
              <>
                <strong>Before it can be issued:</strong>
                <ul className="inv-blockers">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
                <button type="button" className="btn-quiet" onClick={() => setAsking(false)}>Back to the invoice</button>
              </>
            ) : (
              <>
                <p>
                  Issue it as <strong>{p.next}</strong>, for <strong>{rs(fig.total)}</strong>, due {due}? Once issued it cannot be changed or deleted, and what is on
                  it leaves {p.branch ? `${p.branch}'s` : "the"} stock.
                </p>
                <div className="inv-ask-do">
                  <button type="button" onClick={() => void issue()} disabled={issuing} aria-busy={issuing || undefined}>
                    <span>Issue {p.next}</span>
                  </button>
                  <button type="button" className="btn-quiet" onClick={() => setAsking(false)} disabled={issuing}>
                    Not yet
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="inv-bar" role="region" aria-label="Save and issue">
        <span className={"inv-state inv-state-" + status} role="status" aria-live="polite">
          {said}
          {status === "error" && (
            <button type="button" className="btn-link" onClick={() => void saveNow()}>
              Try again
            </button>
          )}
        </span>
        <span className="spacer" />
        <form action={deleteDraft} onSubmit={(e) => { if (!window.confirm("Delete this draft? It has no number yet, so nothing is skipped.")) e.preventDefault(); }}>
          <input type="hidden" name="id" value={inv.id} />
          <button type="submit" className="btn-quiet btn-danger-quiet" disabled={issuing}>
            <Trash2 aria-hidden="true" />
            Delete draft
          </button>
        </form>
        <Link href={`/backoffice/invoices/${inv.id}/print`} target="_blank" className="btn btn-quiet" onClick={printIt}>
          <Printer aria-hidden="true" />
          Print or PDF
        </Link>
        {p.mra ? (
          <span className="muted inv-small">Issued through a till (MRA): comes next</span>
        ) : (
          <button type="button" onClick={() => setAsking(true)} disabled={issuing || status === "stale"}>
            Issue invoice
          </button>
        )}
      </div>
      </div>
    </div>
  );
}

function FragmentRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <>
      <dt className={muted ? "inv-sub" : undefined}>{label}</dt>
      <dd className={muted ? "inv-sub" : undefined}>{value}</dd>
    </>
  );
}

// ---- one line ----
function LineRow({ l, first, last, taxes, stock, costs, rs, change, move, drop, onKey }: {
  l: Ed;
  first: boolean;
  last: boolean;
  taxes: Tax[];
  stock: number | null | undefined;
  costs: boolean;
  rs: (c: number) => string;
  change: (key: string, patch: Partial<Ed>) => void;
  move: (key: string, by: -1 | 1) => void;
  drop: (key: string) => void;
  onKey: (e: React.KeyboardEvent) => void;
}) {
  const handles = (
    <td className="inv-c-move">
      <button type="button" className="inv-icon" aria-label="Move up" disabled={first} onClick={() => move(l.key, -1)}>
        <ArrowUp aria-hidden="true" />
      </button>
      <button type="button" className="inv-icon" aria-label="Move down" disabled={last} onClick={() => move(l.key, 1)}>
        <ArrowDown aria-hidden="true" />
      </button>
    </td>
  );
  const remove = (
    <td className="inv-c-x">
      <button type="button" className="inv-icon" aria-label={"Take off " + (l.name || "this line")} onClick={() => drop(l.key)}>
        <X aria-hidden="true" />
      </button>
    </td>
  );
  if (l.kind !== "line") {
    return (
      <tr className={"inv-" + l.kind}>
        {handles}
        <td colSpan={6}>
          <input
            className={l.kind === "heading" ? "inv-heading-in" : "inv-note-in"}
            value={l.name}
            onChange={(e) => change(l.key, { name: e.target.value })}
            onKeyDown={onKey}
            maxLength={300}
            placeholder={l.kind === "heading" ? "A heading over the lines below it" : "A note between the lines"}
            aria-label={l.kind === "heading" ? "Heading" : "Note"}
            autoFocus={l.key.startsWith("n") && !l.name}
          />
        </td>
        {remove}
      </tr>
    );
  }
  // a line added here (not one the page came with) takes the focus where it needs typing
  const added = l.key.startsWith("n");
  const qty = parseQty(l.qty);
  const price = parseRs(l.price);
  const amount = qty !== null && price !== null && lineFits(price, qty) ? lineAmount(price, qty) : null;
  const short = stock !== undefined && stock !== null && qty !== null && qty > stock;
  const excl = price !== null ? exclOf(price, l.taxes) : null;
  const margin = costs && l.cost !== null && excl ? Math.round(((excl - l.cost) / excl) * 100) : null;
  const combo = (ts: { tax_id: string | null }[]) => ts.map((t) => t.tax_id ?? "").sort().join(",");
  const now = combo(l.taxes);
  const choices: [string, string, InvTax[]][] = [];
  const seen = new Set<string>();
  const offer = (ts: InvTax[]) => {
    const k = combo(ts);
    if (seen.has(k)) return;
    seen.add(k);
    choices.push([k, ts.length ? ts.map((t) => `${t.name}${t.type === "added" ? " +" : ""}`).join(", ") : "No tax", ts]);
  };
  offer(l.taxes);
  offer([]);
  for (const t of taxes) offer([{ tax_id: t.id, name: t.name, rate_bp: t.rate_bp, type: t.type }]);
  return (
    <tr className={short ? "inv-line inv-line-short" : "inv-line"}>
      {handles}
      <td className="inv-c-desc">
        <input value={l.name} onChange={(e) => change(l.key, { name: e.target.value })} onKeyDown={onKey} maxLength={300} aria-label="Description" placeholder="What it is" autoFocus={added && !l.name} />
        {l.more ? (
          <textarea rows={2} value={l.detail} onChange={(e) => change(l.key, { detail: e.target.value })} maxLength={1000} aria-label="More about it" placeholder="Serial number, size, what was done…" />
        ) : (
          <button type="button" className="btn-link inv-more-btn" onClick={() => change(l.key, { more: true })}>
            <Plus aria-hidden="true" />
            Detail
          </button>
        )}
        {(l.sku || short || margin !== null) && (
          <span className="cell-sub">
            {l.sku}
            {short && <span className="inv-warn">{l.sku ? " · " : ""}{stock! <= 0 ? "None in stock" : `${qtyText(stock!)} in stock`}</span>}
            {margin !== null && <span className={margin < 0 ? "inv-warn" : undefined}>{l.sku || short ? " · " : ""}margin {margin}%</span>}
          </span>
        )}
      </td>
      <td className="num">
        <input className={"inv-num-in" + (qty === null ? " inv-bad" : "")} inputMode="decimal" value={l.qty} onChange={(e) => change(l.key, { qty: e.target.value })} onKeyDown={onKey} aria-label="Quantity" />
      </td>
      <td className="num">
        <input
          className={"inv-num-in inv-price-in" + (price === null ? " inv-bad" : "")}
          inputMode="decimal"
          value={l.price}
          onChange={(e) => {
            const v = e.target.value;
            const c = parseRs(v);
            change(l.key, { price: v, off: l.list !== null && c !== null ? offText(percentOff(l.list, c)) : l.off });
          }}
          onKeyDown={onKey}
          aria-label="Price"
          autoFocus={added && !!l.name && !l.price}
        />
        {l.list !== null && price !== null && price < l.list && <span className="cell-sub inv-was">was {rs(l.list)}</span>}
      </td>
      <td className="num">
        <input
          className="inv-num-in inv-off-in"
          inputMode="decimal"
          value={l.off}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            const n = Number(v.replace(",", "."));
            const list = l.list ?? price;
            if (v.trim() === "" ) {
              change(l.key, { off: "", price: l.list !== null ? centsText(l.list) : l.price, list: null });
            } else if (Number.isFinite(n) && n >= 0 && n <= 100 && list !== null) {
              change(l.key, { off: v, list, price: centsText(priceAfter(list, Math.round(n * 100))) });
            } else change(l.key, { off: v });
          }}
          onKeyDown={onKey}
          aria-label="Percent off the price"
        />
      </td>
      <td>
        <select
          className="inv-tax"
          value={now}
          onChange={(e) => change(l.key, { taxes: choices.find(([k]) => k === e.target.value)?.[2] ?? [] })}
          aria-label="Tax on this line"
        >
          {choices.map(([k, t]) => (
            <option key={k} value={k}>{t}</option>
          ))}
        </select>
      </td>
      <td className="num inv-amount">{amount === null ? <span className="inv-warn">?</span> : rs(amount)}</td>
      {remove}
    </tr>
  );
}

// ---- finding a product: name, SKU or barcode; Enter adds it ----
function ProductFind({ store, shop, rs, inputRef, onPick, onFree }: {
  store: string;
  shop: boolean;
  rs: (c: number) => string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: Found) => void;
  onFree: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Found[]>([]);
  const [hitsFor, setHitsFor] = useState("");
  const [at, setAt] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    const t = q.trim();
    if (!t) {
      setHits([]);
      setHitsFor("");
      return;
    }
    const n = ++asked.current;
    const h = setTimeout(async () => {
      const r = await searchProducts(store, t);
      if (n === asked.current) {
        setHits(r);
        setHitsFor(t);
        setAt(0);
      }
    }, 160);
    return () => clearTimeout(h);
  }, [q, store]);
  const done = () => {
    asked.current++;
    setQ("");
    setHits([]);
    setHitsFor("");
    setAt(0);
  };
  const pick = (f: Found) => {
    onPick(f);
    done();
  };
  const free = (name: string) => {
    onFree(name);
    done();
  };
  const t = q.trim();
  const fresh = hitsFor === t && t !== "";
  const options = fresh ? hits.length + 1 : 0;
  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && options) {
      e.preventDefault();
      setAt((a) => (a + 1) % options);
    } else if (e.key === "ArrowUp" && options) {
      e.preventDefault();
      setAt((a) => (a - 1 + options) % options);
    } else if (e.key === "Escape") {
      done();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!t) return;
      if (fresh) {
        if (at < hits.length) pick(hits[at]);
        else free(t);
        return;
      }
      // a scanner types the code and Enter at once: ask now, and take what the code finds
      const r = await searchProducts(store, t);
      if (r[0]) pick(r[0]);
      else free(t);
    }
  };
  const word = shop ? "product" : "item";
  const aWord = shop ? "a product" : "an item";
  return (
    <div className="inv-find">
      <label className="table-search inv-find-box">
        <Plus aria-hidden="true" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Add ${aWord}: name, SKU or barcode, then Enter`}
          aria-label={`Find ${aWord} to add`}
          role="combobox"
          aria-expanded={options > 0}
          aria-controls="inv-find-list"
          aria-autocomplete="list"
          autoComplete="off"
        />
      </label>
      {options > 0 && (
        <ul className="inv-pop" id="inv-find-list" role="listbox">
          {hits.map((f, i) => (
            <li
              key={`${f.item_id}|${f.variant_id ?? ""}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(f);
              }}
              onMouseEnter={() => setAt(i)}
            >
              <span className="inv-pop-name">
                {f.name}
                {f.sku && <small>{f.sku}</small>}
              </span>
              {f.stock !== null && <span className={f.stock <= 0 ? "inv-pop-stock inv-warn" : "inv-pop-stock"}>{f.stock <= 0 ? "None in stock" : `${qtyText(f.stock)} in stock`}</span>}
              <span className="inv-pop-price">{rs(f.price)}</span>
            </li>
          ))}
          <li
            role="option"
            aria-selected={at === hits.length}
            className={"inv-pop-free" + (at === hits.length ? " on" : "")}
            onMouseDown={(e) => {
              e.preventDefault();
              free(t);
            }}
            onMouseEnter={() => setAt(hits.length)}
          >
            {hits.length === 0 ? `No ${word} found. ` : ""}Add &ldquo;{t}&rdquo; as a line of its own
          </li>
        </ul>
      )}
    </div>
  );
}

// ---- finding a customer, or adding one ----
function CustomerFind({ onPick }: { onPick: (c: CustomerHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [hitsFor, setHitsFor] = useState("");
  const [at, setAt] = useState(0);
  const [adding, setAdding] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    const t = q.trim();
    if (!t) {
      setHits([]);
      setHitsFor("");
      return;
    }
    const n = ++asked.current;
    const h = setTimeout(async () => {
      const r = await searchCustomers(t);
      if (n === asked.current) {
        setHits(r);
        setHitsFor(t);
        setAt(0);
      }
    }, 180);
    return () => clearTimeout(h);
  }, [q]);
  const t = q.trim();
  const fresh = hitsFor === t && t !== "";
  const options = fresh ? hits.length + 1 : 0;
  const pick = (c: CustomerHit) => {
    asked.current++;
    setQ("");
    setHits([]);
    setHitsFor("");
    onPick(c);
  };
  const startAdd = () => {
    const digits = t.replace(/[\s+-]/g, "");
    setAdding(/^\d{5,}$/.test(digits) ? { name: "", phone: t, email: "" } : t.includes("@") ? { name: "", phone: "", email: t } : { name: t, phone: "", email: "" });
    setQ("");
    setHits([]);
    setHitsFor("");
  };
  if (adding) {
    return (
      <div className="inv-add-cust">
        <strong className="inv-small">A new customer</strong>
        {err && <p className="note danger">{err}</p>}
        <div className="inv-add-row">
          <input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Name" aria-label="Customer's name" maxLength={120} autoFocus />
          <input value={adding.phone} onChange={(e) => setAdding({ ...adding, phone: e.target.value })} placeholder="Phone" aria-label="Customer's phone" inputMode="tel" maxLength={40} />
          <input value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} placeholder="Email" aria-label="Customer's email" type="email" maxLength={120} />
          <button
            type="button"
            className="btn-sm"
            disabled={busy || !adding.name.trim()}
            aria-busy={busy || undefined}
            onClick={async () => {
              setBusy(true);
              const r = await addCustomer(adding.name, adding.phone, adding.email);
              setBusy(false);
              if (r.ok) {
                setAdding(null);
                setErr("");
                onPick(r.customer);
              } else setErr(r.error);
            }}
          >
            <span>Add customer</span>
          </button>
          <button type="button" className="btn-quiet btn-sm" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </div>
        <p className="muted inv-small">A customer like any other: on the tills after their next sync.</p>
      </div>
    );
  }
  return (
    <div className="inv-find inv-cust-find">
      <label className="table-search inv-find-box">
        <UserPlus aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && options) {
              e.preventDefault();
              setAt((a) => (a + 1) % options);
            } else if (e.key === "ArrowUp" && options) {
              e.preventDefault();
              setAt((a) => (a - 1 + options) % options);
            } else if (e.key === "Enter" && fresh) {
              e.preventDefault();
              if (at < hits.length) pick(hits[at]);
              else startAdd();
            } else if (e.key === "Escape") setQ("");
          }}
          placeholder="Find a customer: name, phone, email or BRN"
          aria-label="Find a customer"
          role="combobox"
          aria-expanded={options > 0}
          aria-controls="inv-cust-list"
          aria-autocomplete="list"
          autoComplete="off"
        />
      </label>
      {options > 0 && (
        <ul className="inv-pop" id="inv-cust-list" role="listbox">
          {hits.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === at}
              className={i === at ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setAt(i)}
            >
              <span className="inv-pop-name">
                {c.name}
                <small>{[c.phone, c.email, c.details?.brn ? "BRN " + c.details.brn : null].filter(Boolean).join(" · ")}</small>
              </span>
              {c.details && c.details.buyer_type !== "B2C" && <span className="badge">{c.details.buyer_type === "B2B" ? "Business" : "Government"}</span>}
            </li>
          ))}
          <li
            role="option"
            aria-selected={at === hits.length}
            className={"inv-pop-free" + (at === hits.length ? " on" : "")}
            onMouseDown={(e) => {
              e.preventDefault();
              startAdd();
            }}
            onMouseEnter={() => setAt(hits.length)}
          >
            {hits.length === 0 ? "Nobody found. " : ""}Add &ldquo;{t}&rdquo; as a new customer
          </li>
        </ul>
      )}
    </div>
  );
}
