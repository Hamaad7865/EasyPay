// What the search's server side answers with: a few records of each kind,
// each leading to a page that exists.
export type Hit = { title: string; sub: string; href: string };
export type HitGroup = { kind: "items" | "categories" | "customers" | "tables" | "staff"; label: string; hits: Hit[] };
