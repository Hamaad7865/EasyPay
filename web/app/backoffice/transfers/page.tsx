import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { branches, pickedOf } from "@/lib/branch";
import { clock, lists } from "@/lib/report";
import { units } from "@/lib/stock";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";
import { BranchPicker } from "../branch-picker";

const PATH = "/backoffice/transfers";

type Row = { id: string; number: string; at: string; from_name: string; to_name: string; who: string | null; note: string | null; lines: number; qty: number };

// Stock sent between branches (multi-branch, the spec's section 7), newest first: those of the branch picked, sent
// or received, or every one.
export default async function TransfersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const all = await branches(c, ctx.tenantId);
    const picked = await pickedOf(all);
    const may = (await c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.adjust') as adjust`, [ctx.employeeId])).rows[0] as { view: boolean; adjust: boolean };
    const rows = may.view
      ? ((
          await c.query(
            `select t.id, t.number, t.created_at as at, f.name as from_name, o.name as to_name, e.name as who, t.note,
                    (select count(*) from stock_transfer_lines l where l.tenant_id = t.tenant_id and l.transfer_id = t.id)::int as lines,
                    (select coalesce(sum(l.qty), 0) from stock_transfer_lines l where l.tenant_id = t.tenant_id and l.transfer_id = t.id)::int as qty
               from stock_transfers t
               join stores f on f.tenant_id = t.tenant_id and f.id = t.from_store
               join stores o on o.tenant_id = t.tenant_id and o.id = t.to_store
               left join employees e on e.tenant_id = t.tenant_id and e.id = t.employee_id
              where t.tenant_id = $1 and t.deleted_at is null and ($2::uuid is null or $2::uuid in (t.from_store, t.to_store))
              order by t.created_at desc limit 300`,
            [ctx.tenantId, picked?.id ?? null],
          )
        ).rows as Row[])
      : [];
    return { all, picked, may, rows, tz: (await lists(c, ctx.tenantId)).tz };
  });
  const at = clock(d.tz);
  const head = (
    <PageHead title="Transfers" lede="Stock sent from one branch to another. It leaves one and arrives at the other at once, at the sending branch's cost, and shows in both branches' movements.">
      <BranchPicker all={d.all} picked={d.picked?.id ?? null} />
      {d.all.length > 1 && d.may.adjust && <Link href={`${PATH}/new`} className="btn">New transfer</Link>}
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
  if (!d.may.view) {
    return (
      <div>
        {head}
        <Empty icon={ArrowLeftRight} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  return (
    <div>
      {head}
      <Flash sp={sp} />
      {d.rows.length === 0 ? (
        <Empty icon={ArrowLeftRight} title="Nothing sent yet">{d.may.adjust ? "Send stock from one branch to another with New transfer." : "A transfer made by someone who may adjust stock shows here."}</Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Transfer</th><th>When</th><th>From</th><th>To</th><th className="num">Lines</th><th className="num">Units</th><th>By</th><th>Note</th></tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="strong"><Link href={`${PATH}/${r.id}`}>{r.number}</Link></td>
                    <td>{at(r.at)}</td>
                    <td>{r.from_name}</td>
                    <td>{r.to_name}</td>
                    <td className="num">{r.lines}</td>
                    <td className="num">{units(r.qty)}</td>
                    <td>{r.who ?? ""}</td>
                    <td>{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
