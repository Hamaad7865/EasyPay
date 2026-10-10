// The plans that carry the premium features: the kitchen display, a kitchen
// screen on another tablet, and bookings. The platform admin sets the plan
// (tenants.plan); the database says the same in has_premium (0085).
export const hasPremium = (plan: unknown): boolean => {
  const p = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  return p === "premium" || p === "trial";
};

// What someone on another plan is told where a premium page would be.
export const PREMIUM_ONLY = "part of EasyPay Premium";

// Ordering from the table (lib/guest.ts) is built in pieces, and the back
// office's piece was ready before the till's and before the ordering site was
// live. A card printed then would send a guest to an address that does not
// answer, and a card is for good. So until this says true the back office
// shows none of it: no switch in POS settings, no key on the Tables page, no
// entry in the menu (nav.ts gets its "Table cards" line back with this), and
// the cards page says "not yet". It is turned on in the release that carries
// the till's piece, once order.easypaypos.com answers.
export const TABLE_ORDERING_LIVE = false;
