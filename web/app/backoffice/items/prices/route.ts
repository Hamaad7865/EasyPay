import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { clock } from "@/lib/report";
import { loadSettings, money } from "@/lib/settings";
import type { PriceChange } from "../editor";

// Every change of one item's price, here or on a till, newest first: what the
// item's panel shows under "Price changes". Asked for when the panel opens.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return Response.json({ changes: [] });
  const ctx = await tenantContext();
  const changes = await readTenant(ctx.tenantId, async (c): Promise<PriceChange[]> => {
    const s = await loadSettings(c, ctx.tenantId);
    const r = await c.query(
      `select pc.old_price, pc.new_price, pc.created_at, pc.source, e.name as who, a.name as approver,
              (select timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1) as tz
         from item_price_changes pc
         left join employees e on e.tenant_id = pc.tenant_id and e.id = pc.changed_by
         left join employees a on a.tenant_id = pc.tenant_id and a.id = pc.approved_by
        where pc.tenant_id = $1 and pc.item_id = $2 and pc.deleted_at is null
        order by pc.created_at desc limit 12`,
      [ctx.tenantId, id],
    );
    return (r.rows as { old_price: string; new_price: string; created_at: string; source: string; who: string | null; approver: string | null; tz: string | null }[]).map((p) => ({
      when: clock(p.tz ?? "Indian/Mauritius")(p.created_at),
      from: money(Number(p.old_price), s.decimals),
      to: money(Number(p.new_price), s.decimals),
      where: p.source === "till" ? "On a till" : "Back office",
      who: p.who,
      approver: p.approver,
    }));
  });
  return Response.json({ changes });
}
