"use client";

import Link from "next/link";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { TERMS, termsWords } from "@/lib/invoice-money";
import { Drawer } from "../drawer";
import { Submit } from "../busy";
import { saveSeries, saveSetup } from "./actions";
import { numberOf, type Series, type Setup } from "./data";

// What every invoice carries that is not on Company details: the bank to pay into, the usual terms and language,
// the words at the foot; and each branch's numbers, with the first one taken over from a book or another system.
// Opens from its button, or by itself when a save comes back to it (?setup=1).
export function SetupPanel({ open, setup, series, manage, said }: { open: boolean; setup: Setup; series: Series[]; manage: boolean; said: { ok: string; err: string } }) {
  const [shown, setShown] = useState(open);
  const close = () => {
    setShown(false);
    const p = new URLSearchParams(window.location.search);
    for (const k of ["setup", "ok", "err"]) p.delete(k);
    const s = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (s ? "?" + s : ""));
  };
  const many = series.length > 1;
  return (
    <>
      <button type="button" className="btn-quiet" onClick={() => setShown(true)}>
        <Settings2 aria-hidden="true" />
        Invoice set-up
      </button>
      <Drawer open={shown} title="Invoice set-up" subtitle="What every invoice carries, and where its numbers start." onClose={close}>
        {said.err && <div className="note danger" role="alert">{said.err}</div>}
        {said.ok && <div className="note ok" role="status">{said.ok}</div>}
        <p className="muted inv-setup-lede inv-first">
          The business&rsquo;s name, BRN, VAT number, address and logo come from <Link href="/backoffice/company">Company details</Link>.
        </p>
        <form action={saveSetup}>
          <fieldset disabled={!manage} className="inv-fieldset">
            <h3 className="inv-h3">Paid into</h3>
            <div className="form-row">
              <label className="field">
                Bank
                <input name="bank_name" defaultValue={setup.bank_name} maxLength={120} placeholder="MCB" data-focus />
              </label>
              <label className="field">
                Account name
                <input name="account_name" defaultValue={setup.account_name} maxLength={120} />
              </label>
              <label className="field">
                Account number
                <input name="account_no" defaultValue={setup.account_no} maxLength={60} inputMode="numeric" />
              </label>
              <label className="field">
                SWIFT or IBAN
                <input name="swift" defaultValue={setup.swift} maxLength={40} />
              </label>
            </div>
            <h3 className="inv-h3">A new invoice starts with</h3>
            <div className="form-row">
              <label className="field">
                Payment terms
                <select name="terms" defaultValue={setup.terms}>
                  {TERMS.filter((t) => t !== "date").map((t) => (
                    <option key={t} value={t}>{termsWords(t)}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Language on paper
                <select name="lang" defaultValue={setup.lang}>
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                </select>
              </label>
            </div>
            <label className="field inv-wide">
              At the foot of every invoice
              <textarea name="footer" defaultValue={setup.footer} maxLength={600} rows={3} placeholder="Thank you for your business. Goods remain our property until paid in full." />
            </label>
            {manage && (
              <div className="inv-setup-save">
                <Submit>Save set-up</Submit>
              </div>
            )}
          </fieldset>
        </form>

        <h3 className="inv-h3 inv-gap">Numbers{many ? ", branch by branch" : ""}</h3>
        <p className="muted inv-setup-lede">
          Each number is given once, in order, when an invoice is issued: a draft has none, so no number is ever skipped. Coming from a book or another
          system? Start where it stopped. Once a {many ? "branch" : "business"} has issued an invoice its numbers can no longer change.
        </p>
        {series.map((s) => (
          <form key={s.store_id} action={saveSeries} className="inv-series">
            <input type="hidden" name="store" value={s.store_id} />
            {many && <strong className="inv-series-name">{s.branch}</strong>}
            {s.issued > 0 ? (
              <p className="inv-series-done">
                {numberOf(s.prefix, s.start_no)} to {numberOf(s.prefix, s.next_no - 1)} issued. Next: <strong>{numberOf(s.prefix, s.next_no)}</strong>
              </p>
            ) : (
              <fieldset disabled={!manage} className="inv-series-row">
                <label className="field">
                  Prefix
                  <input name="prefix" defaultValue={s.prefix} maxLength={16} />
                </label>
                <label className="field">
                  First number
                  <input name="start" type="number" min={1} step={1} defaultValue={s.start_no} />
                </label>
                <span className="inv-series-eg muted">The first will be {numberOf(s.prefix, s.start_no)}</span>
                {manage && <Submit className="btn-quiet">Save</Submit>}
              </fieldset>
            )}
          </form>
        ))}
      </Drawer>
    </>
  );
}
