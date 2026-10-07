// A tenant is a restaurant or a retail shop (tenants.business_type, set by
// the platform admin and by nobody else). Pages ask this file what to call
// things; what each kind of business has is said in backoffice/nav.ts.
export type Mode = "restaurant" | "retail";

// anything that is not plainly "retail" is a restaurant: the column's default
export const asMode = (v: unknown): Mode => (v === "retail" ? "retail" : "restaurant");

// The few words that differ between the two.
const WORDS = {
  restaurant: { place: "restaurant", Place: "Restaurant", catalog: "menu", item: "item", items: "items", Items: "Items" },
  retail: { place: "shop", Place: "Shop", catalog: "catalog", item: "product", items: "products", Items: "Products" },
} as const;
export const words = (mode: Mode) => WORDS[mode];
