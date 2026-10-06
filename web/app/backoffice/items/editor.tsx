"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { Drawer } from "../drawer";
import type { Item } from "./table";

export type Tax = { id: string; name: string; rate_bp: number; type: string; is_default: boolean };
export type AddonGroup = { id: string; name: string; n: number };
export type PriceChange = { when: string; from: string; to: string; where: string; who: string | null; approver: string | null };
type Action = (f: FormData) => Promise<void>;

// One item, in the panel: what it is called, what it costs, which tax it
// carries, which add-on groups the till offers with it. Everything it needs
// came down with the list, so it opens at once; only the history of its price
// is fetched when it opens. `item` is null for a new one.
export function ItemEditor({
  open, item, cats, taxes, groups, category, back, problem, save, onClose,
}: {
  open: boolean;
  item: Item | null;
  cats: { id: string; name: string }[];
  taxes: Tax[];
  groups: AddonGroup[];
  // the category a new item starts in: the one the list is narrowed to
  category: string;
  // the list as it is, to come back to once saved
  back: string;
  // why the last save was refused, when this panel is back open because of it
  problem: string;
  save: Action;
  onClose: () => void;
}) {
  const [prices, setPrices] = useState<PriceChange[] | null>(null);
  const id = item?.id ?? "";
  useEffect(() => {
    setPrices(null);
    if (!open || !id) return;
    const stop = new AbortController();
    fetch(`/backoffice/items/prices?id=${id}`, { signal: stop.signal })
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : { changes: [] }))
      .then((d: { changes?: PriceChange[] }) => setPrices(d.changes ?? []))
      .catch(() => {});
    return () => stop.abort();
  }, [open, id]);

  // The save goes to the server and comes back with the list redrawn: about a
  // second from here. The buttons say so meanwhile, and take no second click.
  const [, submit, saving] = useActionState(async (_: null, f: FormData) => {
    await save(f);
    return null;
  }, null);

  const tax = item?.tax_id ?? taxes.find((t) => t.is_default)?.id ?? taxes[0]?.id;
  return (
    <Drawer
      open={open}
      title={item ? item.name : "New item"}
      subtitle={item ? "Change it here; the tills have it after their next sync." : "It is on the tills after their next sync."}
      onClose={onClose}
      foot={(close) => (
        <>
          <button type="submit" form="item-editor" disabled={saving}>
            {saving ? "Saving…" : item ? "Save item" : "Add item"}
          </button>
          <button type="button" className="btn-quiet" onClick={close} disabled={saving}>
            Cancel
          </button>
          <span className="spacer" />
          {item && (
            <button type="submit" form="item-editor" name="remove" value="1" className="btn-danger" formNoValidate disabled={saving}>
              Remove item
            </button>
          )}
        </>
      )}
    >
      {open && (
        // a form per item, so one item's typing never shows in another's panel
        <form id="item-editor" key={id || "new"} action={submit} className="drawer-form">
          {item && <input type="hidden" name="id" value={item.id} />}
          <input type="hidden" name="back" value={back} />
          {problem && (
            <div className="note danger" role="alert">
              {problem}
            </div>
          )}
          <section>
            <h3>Item</h3>
            <label className="field">
              Name
              <input name="name" defaultValue={item?.name} required maxLength={80} data-focus={item ? undefined : ""} />
            </label>
            <div className="form-row">
              <label className="field">
                Price (Rs)
                <input name="price" defaultValue={item ? (item.price / 100).toString() : ""} required inputMode="decimal" />
              </label>
              <label className="field">
                Category
                <select name="category" defaultValue={item ? (item.cat_id ?? "") : category}>
                  <option value="">No category</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Barcode
              <input name="barcode" defaultValue={item?.barcode ?? ""} maxLength={64} placeholder="Scan it here, or leave empty" autoComplete="off" />
              <span className="help">For bottled drinks and packets. With a scanner plugged into the tablet, scanning it on the till adds the item to the order.</span>
            </label>
            <label className="check">
              <input type="checkbox" name="available" defaultChecked={item?.is_available ?? true} />
              <span>
                On sale
                <small>Untick when it is sold out: the till greys it and will not sell it.</small>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" name="track_stock" defaultChecked={item?.own_stock ?? false} />
              <span>
                Count its stock
                <small>Every item of a counted category is counted anyway; tick this to count this one alone.</small>
              </span>
            </label>
          </section>
          <section>
            <h3>Tax</h3>
            <p className="muted drawer-lede">Whether the price already includes the tax is set on the tax itself.</p>
            {taxes.map((t) => (
              <label key={t.id} className="check">
                <input type="radio" name="tax" value={t.id} defaultChecked={t.id === tax} required />
                <span>
                  {t.name} {t.rate_bp > 0 ? `${t.rate_bp / 100}%` : "0%"}
                  <small>{t.rate_bp === 0 ? "No tax is charged." : t.type === "included" ? "Included in the price." : "Added on top of the price."}</small>
                </span>
              </label>
            ))}
            {taxes.length === 0 && (
              <p className="muted">
                No taxes are set up. Add them under <Link href="/backoffice/taxes">Taxes</Link>.
              </p>
            )}
          </section>
          <section>
            <h3>Add-ons</h3>
            <p className="muted drawer-lede">The groups of extras the till offers when this item is tapped.</p>
            {groups.map((g) => (
              <label key={g.id} className="check">
                <input type="checkbox" name="group" value={g.id} defaultChecked={item?.group_ids.includes(g.id) ?? false} />
                <span>
                  {g.name}
                  <small>
                    {g.n} {g.n === 1 ? "choice" : "choices"}
                  </small>
                </span>
              </label>
            ))}
            {groups.length === 0 && (
              <p className="muted">
                No add-on groups yet. Create them under <Link href="/backoffice/addons">Add-ons</Link>.
              </p>
            )}
          </section>
          {item && prices && prices.length > 0 && (
            <section>
              <h3>Price changes</h3>
              <p className="muted drawer-lede">Every time its price was changed, here or on a till. Receipts keep the price they were sold at.</p>
              <ul className="drawer-prices">
                {prices.map((c, i) => (
                  <li key={i}>
                    <span>
                      <b>
                        {c.from} to {c.to}
                      </b>
                      <small>
                        {c.where}
                        {c.who && ` · ${c.who}`}
                        {c.approver && ` · approved by ${c.approver}`}
                      </small>
                    </span>
                    <time>{c.when}</time>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </form>
      )}
    </Drawer>
  );
}
