import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { readTenant, withTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { branches, pickedOf } from "@/lib/branch";
import { units } from "@/lib/stock";
import { Empty, Flash, PageHead, type Search } from "../../ui";
import { type SendOption, TransferForm } from "../form";

const LIST = "/backoffice/transfers";
const PATH = `${LIST}/new`;

// What stock_transfer (migration 0138) refused, as a sentence. `names` are the products sent, by id; `from` the
// sending branch's name.
function problem(said: string, names: Map<string, string>, from: string): string {
  const short = /^not-enough-stock:([0-9a-f-]{36}):(-?\d+)$/.exec(said);
  if (short) return `Only ${units(Number(short[2]))} of ${names.get(short[1]) ?? "a product"} ${Number(short[2]) === 1000 ? "is" : "are"} at ${from}. Nothing was sent.`;
  return (
    {
      "same-branch": "Pick two different branches.",
      "unknown-store": "One of those branches is not one of yours. Reload the page.",
      "no-lines": "Add what is sent first.",
      "bad-quantity": "A quantity is not a number above zero.",
      "not-counted": "One of the products does not count stock, so it cannot be sent.",
      "pick-variant": "One of the products has sizes or colours: pick which one is sent.",
      "unknown-line": "One of the lines is no longer there. Reload the page.",
      "unknown-item": "One of the products is no longer there. Reload the page.",
      forbidden: "Your role cannot adjust stock, so it cannot send it either.",
    }[said] ?? "The transfer could not be made. Nothing was sent."
  );
}

// One step (the spec's section 7): what leaves one branch arrives at the other at once. Then the note opens.
async function send(f: FormData) {
  "use server";
  let to = PATH;
  try {
    const ctx = await requirePerm("stock.adjust");
    if (String(f.get("lines_ok") ?? "") !== "1") throw new Error("A quantity is not a number above zero.");
    let raw: unknown = null;
    try {
      raw = JSON.parse(String(f.get("lines") ?? "[]"));
    } catch {
      raw = null;
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw new Error("Add what is sent first.");
    const lines = raw.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const item = String(o.item ?? "");
      const variant = o.variant === null || o.variant === undefined || o.variant === "" ? null : String(o.variant);
      if (!UUID.test(item) || (variant !== null && !UUID.test(variant)) || !Number.isInteger(o.qty) || (o.qty as number) <= 0) throw new Error("The lines could not be read. Reload the page and try again.");
      return { item, variant, qty: o.qty as number };
    });
    const from = String(f.get("from") ?? "");
    const dest = String(f.get("to") ?? "");
    const id = await withTenant(ctx.tenantId, async (c) => {
      // the words for a refusal are read first: once the database refuses, this transaction can ask nothing more
      const names = new Map(
        ((await c.query(`select id::text, name from items where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, lines.map((l) => l.item)])).rows as { id: string; name: string }[]).map((r) => [r.id, r.name]),
      );
      const fromName = UUID.test(from) ? (((await c.query(`select name from stores where tenant_id = $1 and id = $2`, [ctx.tenantId, from])).rows[0]?.name as string | undefined) ?? "that branch") : "that branch";
      try {
        return (await c.query(`select stock_transfer($1, $2, $3, $4, $5::jsonb, $6) as id`, [
          ctx.tenantId, ctx.employeeId, UUID.test(from) ? from : null, UUID.test(dest) ? dest : null, JSON.stringify(lines), String(f.get("note") ?? "").trim().slice(0, 200) || null,
        ])).rows[0].id as string;
      } catch (e) {
        throw new Error(problem(e instanceof Error ? e.message : "", names, fromName));
      }
    });
    to = `${LIST}/${id}`;
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    redirect(`${PATH}?err=${encodeURIComponent(said.startsWith("Forbidden") ? "Your role cannot adjust stock, so it cannot send it either." : said || "The transfer could not be made. Nothing was sent.")}`);
  }
  redirect(to);
}

export default async function NewTransfer({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const all = await branches(c, ctx.tenantId);
    const picked = await pickedOf(all);
    const may = (await c.query(`select has_perm($1, 'stock.adjust') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    // every counted line, a product or one of its variants, with what each branch holds of it
    const options = (
      await c.query(
        `select i.id::text || coalesce(':' || v.id::text, '') as key, i.id as item, v.id as variant,
                i.name || coalesce(', ' || v.name, '') as label, coalesce(v.sku, i.sku) as sku, coalesce(v.barcode, i.barcode) as barcode,
                coalesce((select json_object_agg(l.store_id, l.qty) from stock_levels l
                           where l.tenant_id = i.tenant_id and l.item_id = i.id and l.variant_id is not distinct from v.id), '{}'::json) as at
           from items i
           left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
           left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
          where i.tenant_id = $1 and i.deleted_at is null and (i.track_stock or coalesce(c.is_stock, false))
          order by 4`,
        [ctx.tenantId],
      )
    ).rows as SendOption[];
    return { all, picked, may, options };
  });
  const head = (
    <PageHead title="New transfer" lede="Stock sent from one branch to another. It leaves one and arrives at the other at once, at the sending branch's cost. It is not a sale: no receipt, no tax.">
      <Link href={LIST} className="btn btn-quiet">All transfers</Link>
    </PageHead>
  );
  if (d.all.length < 2) {
    return (
      <div>
        {head}
        <Empty icon={ArrowLeftRight} title="This account has one branch">Stock is sent between branches. EasyPay adds a branch when you open one.</Empty>
      </div>
    );
  }
  if (!d.may) {
    return (
      <div>
        {head}
        <Empty icon={ArrowLeftRight} title="Your role cannot send stock">Sending stock takes Adjust stock, under Roles and permissions.</Empty>
      </div>
    );
  }
  return (
    <div>
      {head}
      <Flash sp={sp} />
      <TransferForm action={send} branches={d.all.map((b) => ({ id: b.id, name: b.name }))} from={d.picked?.id ?? d.all[0].id} options={d.options} />
    </div>
  );
}
