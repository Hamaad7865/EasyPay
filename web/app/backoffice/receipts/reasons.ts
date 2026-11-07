import { fmtRs } from "@/lib/money";
import type { Review } from "./data";

// Why the system flagged a receipt: one plain sentence per reason, with the
// figures the server recorded (receipt_reviews). Moved here from the page
// (2026-11-07) for the Receipts pop-up.

type DriftItem = { kind?: string; name?: string; till?: number | null; catalog?: number | null };

const rs = (v: unknown) => fmtRs(Number(v ?? 0));

// One plain sentence per reason, with the figures the server recorded.
export function describe(v: Review): string {
  const d = v.detail ?? {};
  switch (v.reason) {
    case "double-pay":
      return `Ticket was already paid (${rs(d.already_paid)}); another ${rs(d.received)} was taken`;
    case "underpaid":
      return `Short payment: ${rs(d.received)} taken for a total of ${rs(d.total)}`;
    case "overpaid":
      return `Overpayment: ${rs(d.received)} taken for a total of ${rs(d.total)}`;
    case "number-collision":
      return `Number ${String(d.requested)} was already used; stored as ${String(d.stored)}`;
    case "price-drift": {
      const items = (Array.isArray(d.items) ? d.items : []) as DriftItem[];
      return items
        .map((i) =>
          i.kind === "unavailable"
            ? `item sold at ${rs(i.till)} is no longer available`
            : i.kind === "modifier-unlinked"
              ? `a modifier (${rs(i.till)}) that this item does not offer`
            : `${i.kind === "discount" ? `discount ${i.name ?? ""}`.trim() : (i.kind ?? "item")} charged ${rs(i.till)}, catalog ${rs(i.catalog)}`,
        )
        .join("; ");
    }
    case "exchange-unmatched": {
      // a sale paid in part with returned goods, whose refund is not on the books as the till said (migration 0079)
      const credits = (Array.isArray(d.credits) ? d.credits : []) as { amount?: number | null; refund?: string | null }[];
      return credits
        .map((x) => `${rs(x.amount)} of it was settled as an exchange against refund ${x.refund || "(not named)"}, which is not there for that amount: check that the goods came back`)
        .join("; ");
    }
    case "price-unapproved": {
      // a discount on one line, or a price typed for it, by someone whose role does not allow it (migration 0077)
      const lines = (Array.isArray(d.lines) ? d.lines : []) as { kind?: string; listed?: number | null; charged?: number | null }[];
      return lines
        .map((l) => `${l.kind === "override" ? "a price changed on one line" : "a discount on one line"}, from ${rs(l.listed)} to ${rs(l.charged)}, by someone whose role does not allow it`)
        .join("; ");
    }
    case "discount-unapproved": {
      // a discount on the bill that nobody was allowed to give; the bill was paid with it, so it is kept (migration 0082)
      const discounts = (Array.isArray(d.discounts) ? d.discounts : []) as { name?: string | null; amount?: number | null; why?: string }[];
      return discounts
        .map((x) =>
          x.why === "needs-approval"
            ? `the discount ${x.name ?? ""} (${rs(x.amount)}) needs a manager, and no one who may approve it did`
            : `a discount of ${rs(x.amount)} (${x.name ?? "Discount"}) given by someone whose role does not allow discounts`,
        )
        .join("; ");
    }
    case "refund-unapproved":
      // the customer had the money by the time it reached the server, so it is kept (migration 0082)
      return "Refunded by someone whose role does not allow refunds, with no approval from someone who may";
    case "credit-note-refused": {
      // a sale paid in part with a credit note the server could not honour (migration 0109)
      const notes = (Array.isArray(d.notes) ? d.notes : []) as { amount?: number; number?: string; why?: string; valid_to?: string }[];
      return notes
        .map((n) => `${rs(n.amount)} of it was paid with credit note ${n.number || "(not named)"}, which ${n.why === "not-found" ? "was never issued" : n.why === "void" ? "was cancelled" : n.why === "expired" ? `expired on ${n.valid_to ?? ""}` : "was already used up"}: that part of the sale is not covered`)
        .join("; ");
    }
    case "credit-overspent": {
      // two tills apart both spent one note; the second to arrive took more than was left (migration 0109)
      const notes = (Array.isArray(d.notes) ? d.notes : []) as { amount?: number; number?: string; balance?: number; excess?: number }[];
      return notes
        .map((n) => `credit note ${n.number} had ${rs(n.balance)} left and this sale took ${rs(n.amount)}: ${rs(n.excess)} is not covered (two tills spent it while apart)`)
        .join("; ");
    }
    case "points": {
      // loyalty points (migration 0128): the till's figures were kept, held to what they could be
      const flags = (Array.isArray(d.flags) ? d.flags : []) as { why?: string; used?: number; balance?: number; total?: number; left?: number; till?: string | number | null; what?: string }[];
      return flags
        .map((f) =>
          f.why === "overspent"
            ? `${rs(f.used)} of points used when the customer had ${rs(f.balance)}: their balance is below zero (two tills spent it while apart)`
            : f.why === "no-customer"
              ? `points earned or used for a customer this business does not know: the points were not kept (the discount on the receipt stands)`
              : f.why === "over-earned"
                ? `the till said ${rs(Number(f.till) || 0)} of points earned on a sale of ${rs(f.total)}: kept as the most it could be`
                : f.why === "over-returned"
                  ? `the refund ${f.what === "back" ? "gave back" : "took back"} more points than the sale had left (${rs(f.left)}): held to that`
                  : `points: ${f.why ?? "flagged"}`,
        )
        .join("; ");
    }
    default:
      return v.reason;
  }
}

