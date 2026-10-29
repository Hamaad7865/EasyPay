"use server";

import { act, backTo, Refused, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { parseRs } from "@/lib/money";
import { leftWords, planPromotion, promoTargets, PROMO_SAID, runPromotion } from "@/lib/promotions";

// Promote a product from the Promotions page: any product, selling or not (a
// shop just imported has no slow movers), one line or every line at once, at a
// price or a percent off ("500", "20%"). The rules are EasyPay in Claude's
// (lib/promotions): lines that can't take it are left out, and the answer says
// which and why.
export async function promoteChosen(f: FormData) {
  await act("items.edit", backTo(f, "/backoffice/promotions"), async (c, ctx) => {
    const item = uuid(f, "item");
    const line = String(f.get("variant") ?? "") || null;
    const amount = String(f.get("amount") ?? "").trim().replace(/^rs\.?\s*/i, "");
    const pct = /%$/.test(amount) ? Number(amount.slice(0, -1).trim()) : null;
    const price = pct === null ? parseRs(amount) : null;
    if (pct !== null && !(pct >= 1 && pct <= 99)) throw new Refused("A percent off is between 1 and 99.");
    if (pct === null && price === null) throw new Refused("Type a price, like 500, or a percent off, like 20%.");
    const s = await loadSettings(c, ctx.tenantId);
    const m = (v: number) => money(v, s.decimals);
    const { targets } = await promoTargets(c, ctx.tenantId, [item]);
    const chosen = line ? targets.filter((t) => t.line === line) : targets;
    if (!chosen.length) throw new Refused("That product is not there any more. Find it again.");
    const { plan, left } = planPromotion(chosen, price, pct, 10 ** (2 - s.decimals));
    const said = pct !== null ? `${pct}% off` : m(price as number);
    const mayCost = (await c.query(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    const words = leftWords(left, said, mayCost, m);
    if (!plan.length) throw new Refused(words.join(" ") || "Nothing could be put on promotion.");
    try {
      await runPromotion(c, ctx.tenantId, ctx.employeeId, plan, null);
    } catch (e) {
      throw new Refused((e instanceof Error && PROMO_SAID[e.message]) || "That could not be done. Nothing was changed.");
    }
    return `${plan.length} ${plan.length === 1 ? "line" : "lines"} on promotion. The tills show the new ${plan.length === 1 ? "price" : "prices"} on their next sync.${words.length ? " " + words.join(" ") : ""}`;
  });
}
