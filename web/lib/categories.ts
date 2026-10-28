// The categories as a picker or a filter lists them (0145): each category,
// then its sub categories under it, named by their path ("Shirt › Long
// Sleeve"), in the till's order. $1 is the business.
export type CategoryPick = { id: string; name: string; parent_id: string | null };

const ORDERED = `select k.id, case when p.id is null then k.name else p.name || ' › ' || k.name end as name, k.parent_id,
         row_number() over (order by coalesce(p.sort_order, k.sort_order), coalesce(p.name, k.name), k.parent_id is not null, k.sort_order, k.name) as ord
    from categories k left join categories p on p.tenant_id = k.tenant_id and p.id = k.parent_id
   where k.tenant_id = $1 and k.deleted_at is null`;

// as rows
export const CATEGORY_PICK = `select id, name, parent_id from (${ORDERED}) x order by ord`;

// as one JSON array, for a page that asks for several lists in one question
export const CATEGORY_PICK_JSON = `coalesce((select json_agg(json_build_object('id', x.id, 'name', x.name, 'parent_id', x.parent_id) order by x.ord)
    from (${ORDERED}) x), '[]'::json)`;

// A filter on a category takes in its sub categories: the ids it stands for.
export function within(cats: CategoryPick[], picked: string): Set<string> {
  return new Set([picked, ...cats.filter((c) => c.parent_id === picked).map((c) => c.id)]);
}
