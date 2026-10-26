import Link from "next/link";
import { notFound } from "next/navigation";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { clock, lists } from "@/lib/report";
import { units } from "@/lib/stock";
import { Card, Empty, PageHead } from "../../ui";
import { PrintButton } from "../../reports/print-button";
import { ArrowLeftRight } from "lucide-react";

type Head = { number: string; at: string; from_name: string; from_address: string | null; to_name: string; to_address: string | null; who: string | null; note: string | null };
type Line = { name: string; variant: string | null; sku: string | null; qty: number };

// A transfer's note (multi-branch, the spec's section 7): what goes with the goods, to be printed and signed at
// both ends.
export default async function TransferNote({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const view = (await c.query(`select has_perm($1, 'stock.view') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    const head = (
      await c.query(
        `select t.number, t.created_at as at, f.name as from_name, f.address as from_address, o.name as to_name, o.address as to_address,
                e.name as who, t.note
           from stock_transfers t
           join stores f on f.tenant_id = t.tenant_id and f.id = t.from_store
           join stores o on o.tenant_id = t.tenant_id and o.id = t.to_store
           left join employees e on e.tenant_id = t.tenant_id and e.id = t.employee_id
          where t.tenant_id = $1 and t.id = $2 and t.deleted_at is null`,
        [ctx.tenantId, id],
      )
    ).rows[0] as Head | undefined;
    const lines = head && view
      ? ((
          await c.query(
            `select i.name, v.name as variant, coalesce(v.sku, i.sku) as sku, l.qty
               from stock_transfer_lines l
               join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
               left join item_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
              where l.tenant_id = $1 and l.transfer_id = $2
              order by i.name, v.name`,
            [ctx.tenantId, id],
          )
        ).rows as Line[])
      : [];
    return { view, head, lines, tz: (await lists(c, ctx.tenantId)).tz };
  });
  if (!d.head) notFound();
  const h = d.head;
  const at = clock(d.tz);
  const total = d.lines.reduce((a, l) => a + l.qty, 0);
  return (
    <div>
      <PageHead title={`Transfer ${h.number}`} lede={`From ${h.from_name} to ${h.to_name}, ${at(h.at)}${h.who ? `, by ${h.who}` : ""}.`}>
        <Link href="/backoffice/transfers" className="btn btn-quiet">All transfers</Link>
        <PrintButton />
      </PageHead>
      {!d.view ? (
        <Empty icon={ArrowLeftRight} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      ) : (
        <>
          <div className="grid-2">
            <Card title="From">
              <p style={{ margin: 0 }}><strong>{h.from_name}</strong>{h.from_address ? <><br />{h.from_address}</> : null}</p>
            </Card>
            <Card title="To">
              <p style={{ margin: 0 }}><strong>{h.to_name}</strong>{h.to_address ? <><br />{h.to_address}</> : null}</p>
            </Card>
          </div>
          {h.note && <p className="muted">Note: {h.note}</p>}
          <Card title="What was sent" flush>
            <table>
              <thead><tr><th>Product</th><th>Variant</th><th>SKU</th><th className="num">Quantity</th></tr></thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i}><td className="strong">{l.name}</td><td>{l.variant ?? ""}</td><td>{l.sku ?? ""}</td><td className="num">{units(l.qty)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Total</td><td className="num">{units(total)}</td></tr></tfoot>
            </table>
          </Card>
          <div className="grid-2" style={{ marginTop: 28 }}>
            <p>Sent by: ______________________________</p>
            <p>Received by: ______________________________</p>
          </div>
        </>
      )}
    </div>
  );
}
