// The plans that carry the premium features: the kitchen display, a kitchen
// screen on another tablet, and bookings. The platform admin sets the plan
// (tenants.plan); the database says the same in has_premium (0085).
export const hasPremium = (plan: unknown): boolean => {
  const p = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  return p === "premium" || p === "trial";
};

// What someone on another plan is told where a premium page would be.
export const PREMIUM_ONLY = "part of EasyPay Premium";

// Ordering from the table (lib/guest.ts) was built in pieces, and the back
// office's piece was ready before the till's and before the ordering site was
// live. A card printed then would have sent a guest to an address that does
// not answer, and a card is for good. So while this said false the back
// office showed none of it: no switch in POS settings, no key on the Tables
// page, no entry in the menu, and the cards page said "not yet". True since
// 2026-10-11, with the till's piece, for the release the owner tries it in:
// the ordering site (cloudflare/relay) is deployed BEFORE that release's tag.
// Back to false, with the "Table cards" line out of nav.ts, hides it again.
export const TABLE_ORDERING_LIVE = true;
