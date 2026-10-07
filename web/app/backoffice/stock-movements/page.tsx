import Link from "next/link";
import { ArrowLeftRight, Download } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { MOVE_LABEL, units } from "@/lib/stock";
import { Card, Empty, one, PageHead, type Search } from "../ui";
import { type Move, moveFilters, moveParams, moveQuery, MOVES_SQL } from "./moves";

const PATH = "/backoffice/stock-movements";
const MOST = 500;

// Every change to a shop's stock, newest first. Nothing here is edited: a
// mistake is put right by another movement, and both stay.
export default async function MovementsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const f = moveFilters((k) => one(sp[k]));
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, moves, people, picked, shop, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'costs.view') as costs`, [ctx.employeeId]),
      c.query(MOVES_SQL, moveParams(ctx.tenantId, f, MOST + 1)),
      c.query(`select id, name from employees where tenant_id = $1 and deleted_at is null order by lower(name)`, [ctx.tenantId]),
      c.query(
        `select i.name, v.name as variant
           from items i left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.id = $3::uuid
          where i.tenant_id = $1 and i.id = $2::uuid`,
        [ctx.tenantId, f.item, f.variant],
      ),
      c.query(`select timezone from stores where tenant_id = $1 and id = first_store($1)`, [ctx.tenantId]),
      loadSettings(c, ctx.tenantId),
    ]);
    return {
      may: may.rows[0] as { view: boolean; costs: boolean },
      moves: moves.rows as Move[],
      people: people.rows as { id: string; name: string }[],
      picked: picked.rows[0] as { name: string; variant: string | null } | undefined,
      tz: (shop.rows[0]?.timezone as string) ?? "Indian/Mauritius",
      decimals: settings.decimals,
    };
  });
  const head = (
    <PageHead
      title="Movements"
      lede="Every change to the shop's stock: sold, received, counted, adjusted or returned, with who did it. Nothing here is ever edited: a mistake is put right by another movement."
    />
  );
  if (!d.may.view) {
    return (
      <div>
        {head}
        <Empty icon={ArrowLeftRight} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: d.tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const shown = d.moves.slice(0, MOST);
  const filtered = Boolean(f.item || f.reason || f.who || f.from || f.to);
  return (
    <div>
      {head}
      <Card>
        <form method="get" action={PATH} className="bo-toolbar" style={{ margin: 0 }}>
          {f.item && <input type="hidden" name="item" value={f.item} />}
          {f.variant && <input type="hidden" name="variant" value={f.variant} />}
          <select name="reason" defaultValue={f.reason ?? ""} aria-label="What happened">
            <option value="">Everything that happened</option>
            {Object.entries(MOVE_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <select name="who" defaultValue={f.who ?? ""} aria-label="By">
            <option value="">By anyone</option>
            {d.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            From <input type="date" name="from" defaultValue={f.from ?? ""} />
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            to <input type="date" name="to" defaultValue={f.to ?? ""} />
          </label>
          <button type="submit" className="btn-sm">Show</button>
          {filtered && <Link href={PATH}>Show everything</Link>}
          <a href={`${PATH}/export${moveQuery(f)}`} className="btn btn-quiet btn-sm" download style={{ marginLeft: "auto" }}>
            <Download aria-hidden="true" />
            Download CSV
          </a>
        </form>
        {f.item && (
          <p className="muted" style={{ margin: "10px 0 0" }}>
            Only <strong>{d.picked ? d.picked.name + (d.picked.variant ? ", " + d.picked.variant : "") : "one product"}</strong>.{" "}
            <Link href={PATH + moveQuery({ ...f, item: null, variant: null })}>All products</Link>
          </p>
        )}
      </Card>
      {shown.length === 0 ? (
        <Empty icon={ArrowLeftRight} title={filtered ? "Nothing moved that fits" : "Nothing has moved yet"}>
          {filtered ? "Widen the dates or choose Show everything." : "A sale, a delivery, a count or an adjustment each leave a line here."}
        </Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>What</th>
                  <th className="num">Quantity</th>
                  {d.may.costs && <th className="num">Unit cost</th>}
                  <th>By</th>
                  <th>Note</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id}>
                    <td>{when.format(new Date(m.at))}</td>
                    <td className="strong">{m.item}</td>
                    <td>{m.variant ?? <span className="muted">One size</span>}</td>
                    <td>{MOVE_LABEL[m.reason] ?? m.reason}</td>
                    <td className="num strong" style={m.qty < 0 ? { color: "var(--red)" } : undefined}>
                      {m.qty > 0 ? "+" : ""}
                      {units(m.qty)}
                    </td>
                    {d.may.costs && <td className="num">{m.unit_cost === null ? <span className="muted">None</span> : money(Math.round(Number(m.unit_cost)), d.decimals)}</td>}
                    <td>{m.who ?? <span className="muted">Till</span>}</td>
                    <td>{m.note ?? ""}</td>
                    <td>{m.receipt ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.moves.length > MOST && (
            <p className="muted" style={{ padding: "12px 20px", margin: 0 }}>
              These are the latest {MOST}. Narrow the dates, or download the CSV for all of them.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
