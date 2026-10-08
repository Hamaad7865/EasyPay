import { UUID } from "@/lib/action";
import { isDay } from "@/lib/day";
import { MOVE_LABEL } from "@/lib/stock";

// The movements of a shop's stock, as the Movements page and its CSV both
// read them: one question, so the file holds what the page showed. The shop
// is the first one (stock is kept per shop and one shop is shown); a movement
// written before stock had shops belongs to it too.

export type MoveFilters = { item: string | null; variant: string | null; reason: string | null; who: string | null; from: string | null; to: string | null };

// What the address asks for, with anything that is not what it should be left out.
export function moveFilters(get: (k: string) => string): MoveFilters {
  const id = (k: string) => (UUID.test(get(k)) ? get(k) : null);
  const day = (k: string) => (isDay(get(k)) ? get(k) : null);
  const reason = get("reason");
  return { item: id("item"), variant: id("variant"), reason: Object.hasOwn(MOVE_LABEL, reason) ? reason : null, who: id("who"), from: day("from"), to: day("to") };
}

// The same filters, as the end of an address.
export function moveQuery(f: MoveFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

export type Move = {
  id: string; at: string; item: string; variant: string | null; qty: number; reason: string;
  unit_cost: string | null; who: string | null; note: string | null; receipt: string | null;
};

// $1 tenant, $2 product, $3 variant, $4 reason, $5 person, $6 from, $7 to (days in the shop's time zone), $8 how many
export const MOVES_SQL = `
  select m.id, m.created_at as at, i.name as item, v.name as variant, m.qty, m.reason, m.unit_cost, e.name as who, m.note,
         case when m.ref_type = 'receipt' then r.number end as receipt
    from stock_movements m
    join stores s on s.tenant_id = m.tenant_id and s.id = first_store($1)
    join items i on i.tenant_id = m.tenant_id and i.id = m.item_id
    left join item_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
    left join employees e on e.tenant_id = m.tenant_id and e.id = m.employee_id
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
   where m.tenant_id = $1 and m.deleted_at is null and (m.store_id = s.id or m.store_id is null)
     and ($2::uuid is null or m.item_id = $2::uuid)
     and ($3::uuid is null or m.variant_id = $3::uuid)
     and ($4::text is null or m.reason = $4::text)
     and ($5::uuid is null or m.employee_id = $5::uuid)
     and ($6::date is null or (m.created_at at time zone s.timezone)::date >= $6::date)
     and ($7::date is null or (m.created_at at time zone s.timezone)::date <= $7::date)
   order by m.created_at desc, m.id desc
   limit $8`;

export const moveParams = (tenantId: string, f: MoveFilters, limit: number) => [tenantId, f.item, f.variant, f.reason, f.who, f.from, f.to, limit];
