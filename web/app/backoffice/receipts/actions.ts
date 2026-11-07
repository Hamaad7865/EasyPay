"use server";

import { revalidatePath } from "next/cache";
import { act, backTo, Refused, uuid } from "@/lib/action";
import { PLAIN } from "./data";

// What the Receipts pop-up changes (docs/superpowers/specs/2026-11-07-receipts-popup-design.md).
// Each goes back to the page as it was, the receipt still open (the form's "back").
const PATH = "/backoffice/receipts";

// Signing off a money discrepancy takes the same authority as refunding one.
export async function resolveReceipt(f: FormData) {
  await act("sale.refund", backTo(f, PATH), async (c, ctx) => {
    const note = String(f.get("note") ?? "").trim().slice(0, 300);
    if (!note) throw new Refused("Say what was done.");
    await c.query(
      `update receipt_reviews set resolved_at = now(), resolved_by = $1, resolution = $2
        where receipt_id = $3 and tenant_id = $4 and resolved_at is null and deleted_at is null`,
      [ctx.employeeId, note, uuid(f, "receipt"), ctx.tenantId],
    );
    // the dashboard's Needs attention counts them too
    revalidatePath("/backoffice");
    return "Signed off.";
  });
}

// A bill rung up under the wrong payment type is corrected, not edited: the
// payment stays as it was recorded and the correction is kept with who made
// it and when. The amount never changes. Only money that came in by hand is
// moved, and only to another such type: on account, an exchange, a credit
// note and a deposit stand for money that went somewhere else, and the server
// would take a correction to one of them.
export async function correctPayment(f: FormData) {
  await act("payment.correct", backTo(f, PATH), async (c, ctx) => {
    const payload = { id: crypto.randomUUID(), receipt_id: uuid(f, "receipt"), from_payment_type_id: uuid(f, "from"), to_payment_type_id: uuid(f, "to") };
    if (payload.from_payment_type_id === payload.to_payment_type_id) throw new Refused("Pick a different payment method.");
    const kinds = (
      await c.query(`select id, kind from payment_types where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [
        ctx.tenantId,
        [payload.from_payment_type_id, payload.to_payment_type_id],
      ])
    ).rows as { id: string; kind: string }[];
    if (kinds.length !== 2 || kinds.some((k) => !PLAIN.includes(k.kind)))
      throw new Refused("Only cash, card, wallet, QR and other payments are changed here. On account, an exchange, a credit note and a deposit stay as they were.");
    try {
      await c.query(`select push_payment_correct($1, $2, $3::jsonb)`, [ctx.tenantId, ctx.employeeId, JSON.stringify(payload)]);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      throw new Refused(
        m === "forbidden"
          ? "Your role does not include correcting a payment type."
          : m === "mra-no-correction"
            ? "This business is live on MRA e-invoicing, which keeps how a sale was paid. Refund the sale and ring it up again."
            : "That payment could not be corrected. Reload the page and try again.",
      );
    }
    return "Payment method changed. The reports use the new one; the receipt keeps a note of the change.";
  });
}
