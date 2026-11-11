"use client";

import { useState } from "react";
import { Banknote } from "lucide-react";
import { METHOD_WORDS, METHODS } from "@/lib/invoice-money";
import { Drawer } from "../../drawer";
import { Submit } from "../../busy";
import { cancelPayment, recordPayment } from "../actions";

// Money received on an issued invoice: typed here when it reaches the bank (or arrives as a cheque, or cash at
// the counter). It is kept on the invoice and in the Sales journal; it never goes through a till's drawer.
export function PaymentPanel({ id, owed, today, issued, decimals }: { id: string; owed: number; today: string; issued: string; decimals: number }) {
  const [open, setOpen] = useState(false);
  const amount = (owed / 100).toFixed(decimals === 0 ? 0 : 2);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        <Banknote aria-hidden="true" />
        Record a payment
      </button>
      <Drawer
        open={open}
        title="Record a payment"
        subtitle="Money received on this invoice. A payment typed in error is cancelled, never deleted: it stays on the invoice, struck through."
        onClose={() => setOpen(false)}
        foot={(close) => (
          <>
            <Submit form="inv-pay">Record payment</Submit>
            <button type="button" className="btn-quiet" onClick={close}>
              Cancel
            </button>
          </>
        )}
      >
        <form id="inv-pay" action={recordPayment}>
          <input type="hidden" name="id" value={id} />
          <label className="field">
            Amount received, in rupees
            <input name="amount" defaultValue={amount} inputMode="decimal" required data-focus />
          </label>
          <label className="field">
            How it was paid
            <select name="method" defaultValue="bank">
              {METHODS.map((m) => (
                <option key={m} value={m}>{METHOD_WORDS[m].en}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Received on
            <input name="day" type="date" defaultValue={today} min={issued} max={today} required />
          </label>
          <label className="field">
            Reference
            <input name="reference" maxLength={120} placeholder="Bank reference, cheque number…" />
          </label>
        </form>
      </Drawer>
    </>
  );
}

export function CancelPayment({ id, payment, says }: { id: string; payment: string; says: string }) {
  return (
    <form
      action={cancelPayment}
      onSubmit={(e) => {
        if (!window.confirm(`Cancel the payment of ${says}? It stays on the invoice, struck through, and the money is owed again.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="payment" value={payment} />
      <Submit className="btn-link inv-cancel-pay">Cancel</Submit>
    </form>
  );
}
