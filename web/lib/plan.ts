// The plans that carry the premium features: the kitchen display, a kitchen
// screen on another tablet, and bookings. The platform admin sets the plan
// (tenants.plan); the database says the same in has_premium (0085).
export const hasPremium = (plan: unknown): boolean => {
  const p = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  return p === "premium" || p === "trial";
};

// What someone on another plan is told where a premium page would be.
export const PREMIUM_ONLY = "part of EasyPay Premium";
