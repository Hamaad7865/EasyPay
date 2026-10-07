"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Plus, UtensilsCrossed } from "lucide-react";
import { Chev, downloadCsv, fold, NoMatch, Seg, SortTh, type Start, TableSearch, useTable } from "../table-kit";
import { type AddonGroup, ItemEditor, type Tax } from "./editor";
import { Submit } from "../busy";
import type { Mode } from "@/lib/mode";

export type Item = {
  id: string;
  name: string;
  // cents, and the same amount as the till shows it
  price: number;
  shown: string;
  is_available: boolean;
  cat_id: string | null;
  cat: string | null;
  cat_color: string | null;
  // where its category stands in the menu's own order
  cat_order: number;
  sku: string | null;
  barcode: string | null;
  tax: string | null;
  addons: number;
  // null when the item's stock is not counted
  stock: number | null;
  stock_shown: string;
  // what the panel that edits it needs: its tax, its add-on groups, and
  // whether this item alone is counted
  tax_id: string | null;
  group_ids: string[];
  own_stock: boolean;
  // for a shop: what it costs, the margin that leaves, its variants and their codes
  cost_shown: string | null;
  margin_shown: string | null;
  variants: number;
  codes: string;
};
type Action = (f: FormData) => Promise<void>;

const STATUS = [
  ["", "All"],
  ["on", "On sale"],
  ["out", "Sold out"],
  ["notax", "No tax set"],
] as const;
const LOW = 5000; // five or fewer left, as the Stock page counts it

// The items as one table. A line is an item as the till has it; the box above
// finds it by name, category, SKU or barcode as you type, the two filters
// narrow the list and a column's title sorts by it. Tapping a line opens it
// for what changes day to day: its price, and whether it is on sale. Ticking
// lines takes several off sale (or puts them back) in one go. The rest (its
// name, category, tax, add-ons, barcode) is in a panel that slides in from the
// right when its name is tapped: the list stays where it was behind it.
export function ItemsTable({
  items, cats, taxes, groups, start, problem, quickSave, bulkSave, saveItem, mode,
}: {
  // a shop's product opens on a page of its own; a restaurant's item in the panel
  mode: Mode;
  items: Item[]; cats: { id: string; name: string }[]; taxes: Tax[]; groups: AddonGroup[]; start: Start;
  // why the last save was refused, if it was
  problem: string;
  quickSave: Action; bulkSave: Action; saveItem: Action;
}) {
  const t = useTable("/backoffice/items", start);
  // the item in the panel: its id, "new" for one being added, nothing when shut
  const editing = t.get("edit");
  const edited = editing && editing !== "new" ? (items.find((i) => i.id === editing) ?? null) : null;
  const panelOpen = editing === "new" || edited !== null;
  const shop = mode === "retail";
  const router = useRouter();
  const edit = (id: string) => t.set("edit", id);
  // what a tap on a product or on Add does: its page for a shop, the panel for a restaurant
  const open = (id: string) => (shop ? router.push(`/backoffice/items/${id}`) : edit(id));
  // Why the panel's last save was refused: said in the panel the server sent
  // back open, and gone once that panel is shut.
  const refusal = () => (start.edit && problem ? { id: start.edit, why: problem } : null);
  const [refused, setRefused] = useState(refusal);
  // A save comes back as a fresh draw of the list. When it says what the one
  // before said ("saved", twice running) the table is not started again, so
  // the panel takes its cue from the address here: shut after a save, open
  // with the reason after a refusal.
  const drawn = useRef(items);
  useEffect(() => {
    if (drawn.current === items) return;
    drawn.current = items;
    edit(start.edit ?? "");
    setRefused(refusal());
  });
  // the same thing as an address, for a middle click or a new tab
  const editHref = (id: string) => {
    const b = t.back(undefined, ["edit"]);
    return `${b}${b.includes("?") ? "&" : "?"}edit=${id}`;
  };
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const cat = t.get("category");
  const status = t.get("status");

  const hay = useMemo(() => new Map(items.map((i) => [i.id, fold([i.name, i.cat ?? "", i.sku ?? "", i.barcode ?? "", i.codes].join(" "))])), [items]);
  const shown = t.sorted(
    items.filter(
      (i) =>
        (!cat || (cat === "none" ? !i.cat_id : i.cat_id === cat)) &&
        (!status || (status === "on" ? i.is_available : status === "out" ? !i.is_available : status === "notax" ? !i.tax : true)) &&
        t.finds(hay.get(i.id)!),
    ),
    {
      name: (a, b) => a.name.localeCompare(b.name),
      category: (a, b) => a.cat_order - b.cat_order || (a.cat ?? "").localeCompare(b.cat ?? "") || a.name.localeCompare(b.name),
      price: (a, b) => a.price - b.price || a.name.localeCompare(b.name),
      stock: (a, b) => (a.stock ?? 0) - (b.stock ?? 0) || a.name.localeCompare(b.name),
    },
    { stock: (i) => i.stock === null },
  );

  const soldOut = items.filter((i) => !i.is_available).length;
  const noTax = items.filter((i) => !i.tax).length;
  const withStock = items.some((i) => i.stock !== null);
  const cols = withStock ? 9 : 8;
  // ticking: the box in the title takes every line the list is showing
  const here = shown.filter((i) => picked.has(i.id)).length;
  const pick = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const pickAll = () =>
    setPicked((was) => {
      const next = new Set(was);
      for (const i of shown) here === shown.length ? next.delete(i.id) : next.add(i.id);
      return next;
    });
  const chosen = items.filter((i) => picked.has(i.id));

  // the list as it is on screen, as a file a spreadsheet opens
  const csv = () =>
    shop
      ? downloadCsv("products", [
          ["Product", "Category", "Price", "Cost", "Margin", "Variants", "SKU", "Barcode", "On sale", "In stock"],
          ...shown.map((i) => [i.name, i.cat ?? "", (i.price / 100).toFixed(2), i.cost_shown ?? "", i.margin_shown ?? "", i.variants, i.sku ?? "", i.barcode ?? "", i.is_available ? "Yes" : "Off sale", i.stock === null ? "" : i.stock / 1000]),
        ])
      : downloadCsv("items", [
          ["Item", "Category", "Price", "Tax", "Add-on groups", "SKU", "Barcode", "On sale", "In stock"],
          ...shown.map((i) => [i.name, i.cat ?? "", (i.price / 100).toFixed(2), i.tax ?? "", i.addons, i.sku ?? "", i.barcode ?? "", i.is_available ? "Yes" : "Sold out", i.stock === null ? "" : i.stock / 1000]),
        ]);

  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>All items</h2>
          <p>
            {shown.length !== items.length ? `${shown.length} of ${items.length}` : items.length} {items.length === 1 ? "item" : "items"}
            {soldOut > 0 && ` · ${soldOut} sold out`}
            {noTax > 0 && ` · ${noTax} with no tax set`}. Tap an item to change its price or take it off sale.
          </p>
        </div>
        <TableSearch t={t} placeholder="Search name, category, SKU, barcode" label="Search items" />
      </div>
      <div className="table-filters">
        <label className="inline muted">
          Category
          <select value={cat} onChange={(e) => t.set("category", e.target.value)}>
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="none">No category</option>
          </select>
        </label>
        <Seg t={t} name="status" label="Show" options={STATUS} />
        <span className="spacer" />
        <button type="button" className="btn-quiet btn-sm" onClick={csv} title="The list as it is shown, as a file for a spreadsheet">
          <Download aria-hidden="true" />
          Download CSV
        </button>
        <button type="button" className="btn-sm" onClick={() => open("new")}>
          <Plus aria-hidden="true" />
          {shop ? "Add product" : "Add item"}
        </button>
      </div>
      {chosen.length > 0 && (
        <form action={bulkSave} className="table-bulk" role="region" aria-label="The items ticked">
          <input type="hidden" name="back" value={t.back(undefined, ["edit"])} />
          {chosen.map((i) => (
            <input key={i.id} type="hidden" name="id" value={i.id} />
          ))}
          <strong>
            {chosen.length} {chosen.length === 1 ? "item" : "items"} ticked
            {chosen.length > here && ` (${chosen.length - here} not in the list as filtered)`}
          </strong>
          <Submit name="available" value="0" className="btn-sm">
            Mark sold out
          </Submit>
          <Submit name="available" value="1" className="btn-quiet btn-sm">
            Put back on sale
          </Submit>
          <span className="spacer" />
          <button type="button" className="btn-link" onClick={() => setPicked(new Set())}>
            Untick all
          </button>
        </form>
      )}
      <div className="table-scroll" hidden={items.length === 0}>
        <table className="rows-open with-ticks">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Tick every item shown"
                  checked={shown.length > 0 && here === shown.length}
                  ref={(el) => {
                    if (el) el.indeterminate = here > 0 && here < shown.length;
                  }}
                  onChange={pickAll}
                />
              </th>
              <th />
              <SortTh t={t} k="name" label={shop ? "Product" : "Item"} />
              <SortTh t={t} k="category" label="Category" />
              <th className={shop ? "num" : undefined}>{shop ? "Cost" : "Tax"}</th>
              <th className={shop ? "num" : undefined}>{shop ? "Margin" : "Add-ons"}</th>
              {withStock && <SortTh t={t} k="stock" label="Stock" num />}
              <SortTh t={t} k="price" label="Price" num />
              <th>On sale</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <NoMatch t={t} cols={cols} what={shop ? "product" : "item"} filters={["category", "status"]} />}
            {shown.map((it) => {
              const on = t.isOpen(it.id);
              const code = [it.sku && `SKU ${it.sku}`, it.barcode].filter(Boolean).join(" · ");
              return [
                <tr key={it.id} className={on ? "row on" : "row"} onClick={() => t.toggle(it.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Tick ${it.name}`} checked={picked.has(it.id)} onChange={() => pick(it.id)} />
                  </td>
                  <td>
                    <Chev open={on} name={it.name} onClick={() => t.toggle(it.id)} />
                  </td>
                  <td>
                    <a
                      href={shop ? `/backoffice/items/${it.id}` : editHref(it.id)}
                      className="strong"
                      onClick={(e) => {
                        e.stopPropagation();
                        // a plain click opens the panel here; with a key held it is the browser's (new tab)
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        open(it.id);
                      }}
                    >
                      {it.name}
                    </a>
                    {code && <small className="cell-sub">{code}</small>}
                    {shop && it.variants > 0 && <small className="cell-sub">{it.variants} {it.variants === 1 ? "variant" : "variants"}</small>}
                  </td>
                  <td>
                    {it.cat ? (
                      <>
                        {it.cat_color && <span className="swatch" style={{ background: it.cat_color }} />}
                        {it.cat}
                      </>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  {shop ? (
                    <>
                      <td className="num">{it.cost_shown ?? <span className="muted">Not set</span>}</td>
                      <td className="num">{it.margin_shown ?? <span className="muted">None</span>}</td>
                    </>
                  ) : (
                    <>
                      <td>{it.tax ?? <span className="badge amber">No tax set</span>}</td>
                      <td>{it.addons > 0 ? `${it.addons} ${it.addons === 1 ? "group" : "groups"}` : <span className="muted">None</span>}</td>
                    </>
                  )}
                  {withStock && (
                    <td className="num">
                      {it.stock === null ? <span className="muted">Not counted</span> : it.stock <= LOW ? <span className="badge amber">{it.stock_shown} left</span> : it.stock_shown}
                    </td>
                  )}
                  <td className="num strong">{it.shown}</td>
                  <td>{it.is_available ? <span className="badge green">On sale</span> : <span className="badge red">Sold out</span>}</td>
                </tr>,
                on && (
                  <tr key={it.id + "-open"} className="open-body">
                    <td colSpan={cols}>
                      <div className="open-panel">
                        <form action={quickSave} className="bo-toolbar" style={{ margin: 0 }}>
                          <input type="hidden" name="id" value={it.id} />
                          <input type="hidden" name="back" value={t.back(it.id, ["edit"])} />
                          <label className="inline muted">
                            Price (Rs)
                            <input name="price" defaultValue={(it.price / 100).toString()} className="narrow" inputMode="decimal" aria-label={`Price of ${it.name}`} />
                          </label>
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" name="available" defaultChecked={it.is_available} />
                            On sale
                          </label>
                          <span className="spacer" />
                          <Submit className="btn-sm">
                            Save
                          </Submit>
                          <button type="button" className="btn-quiet btn-sm" onClick={() => open(it.id)}>
                            Edit everything
                          </button>
                        </form>
                        <p className="muted open-hint">{shop ? "Its supplier, cost, variants and barcodes are on its page, under Edit everything." : "Its name, category, tax, add-ons and barcode are under Edit everything."}</p>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {items.length === 0 && (
        <div className="empty" style={{ border: 0, margin: 0 }}>
          <UtensilsCrossed aria-hidden="true" strokeWidth={1.6} />
          <strong>No items here yet</strong>
          <button type="button" className="btn-link" onClick={() => open("new")}>
            Add the first one
          </button>
        </div>
      )}
      <ItemEditor
        open={panelOpen}
        item={edited}
        cats={cats}
        taxes={taxes}
        groups={groups}
        category={cat && cat !== "none" ? cat : ""}
        back={t.back(undefined, ["edit"])}
        problem={refused && refused.id === editing ? refused.why : ""}
        save={saveItem}
        onClose={() => {
          edit("");
          setRefused(null);
        }}
      />
    </section>
  );
}
