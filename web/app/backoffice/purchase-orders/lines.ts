import { Refused, UUID } from "@/lib/action";
import { orderProblem } from "@/lib/orders";

// What the order pages share on the server: reading the lines a form sends,
// and turning what the database refuses into a sentence.

export type SentLine = { item_id: string; variant_id: string | null; qty: number; unit_cost: number };

// The lines as the editor and the receive form send them: one field, `lines`,
// in thousandths and cents. `lines_ok` is empty while something typed was not
// a number: nothing is saved then. The database checks each line again.
export function linesOf(f: FormData): SentLine[] {
  if (String(f.get("lines_ok") ?? "") !== "1") throw new Refused("A quantity or a cost on one of the lines is not a number. Nothing was saved.");
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(f.get("lines") ?? "[]"));
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw) || raw.length > 500) throw new Refused("The lines could not be read. Reload the page and try again.");
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const item = String(o.item_id ?? "");
    const variant = o.variant_id === null || o.variant_id === undefined || o.variant_id === "" ? null : String(o.variant_id);
    if (!UUID.test(item) || (variant !== null && !UUID.test(variant)) || !Number.isInteger(o.qty) || !Number.isInteger(o.unit_cost)) {
      throw new Refused("The lines could not be read. Reload the page and try again.");
    }
    return { item_id: item, variant_id: variant, qty: o.qty as number, unit_cost: o.unit_cost as number };
  });
}

// Runs what changes an order or receives a delivery; a refusal of the
// database's (migration 0074) comes back as the sentence for it.
export async function ruled<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const why = e instanceof Error ? orderProblem(e.message) : null;
    if (why) throw new Refused(why);
    throw e;
  }
}
