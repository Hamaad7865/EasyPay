import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { onlyFor, requirePerm } from "@/lib/tenant";
import { readTenant, withTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { COUNT_STATUS, COUNT_TONE, countProblem, type CountStatus } from "@/lib/counts";
import { units } from "@/lib/stock";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

const PATH = "/backoffice/stock-counts";

// A new count, of the whole shop or of one category, supplier or brand. It
// opens on its own page, ready to scan. (Not through act(): where it goes
// next is only known once the count has its id.)
async function newCount(f: FormData) {
  "use server";
  let to = PATH;
  try {
    const ctx = await requirePerm("stock.count");
    const what = String(f.get("what") ?? "");
    const cut = what.indexOf(":");
    const kind = cut < 0 ? what : what.slice(0, cut);
    const rest = cut < 0 ? "" : what.slice(cut + 1);
    const scope = (kind === "category" || kind === "supplier") && UUID.test(rest) ? rest : null;
    const made = await withTenant(ctx.tenantId, async (c) =>
      (await c.query(`select count_start($1, $2, first_store($1), $3, $4, $5) as r`, [ctx.tenantId, ctx.employeeId, kind, scope, kind === "brand" ? rest.slice(0, 80) : null])).rows[0].r as { id: string },
    );
    to = `${PATH}/${made.id}`;
  } catch (e) {
    unstable_rethrow(e);
    const said = e instanceof Error ? e.message : "";
    const why = said.startsWith("Forbidden") ? "Your role cannot run stock counts." : said.includes("suspended") ? said : (countProblem(said) ?? "The count could not be started. Nothing was saved.");
    redirect(`${PATH}?err=${encodeURIComponent(why)}`);
  }
  redirect(to);
}

type Row = { id: string; number: string; title: string; status: CountStatus; day: string; by: string | null; lines: number; counted: number; units: number; value: string };

// The shop's counts: the ones being counted, and the ones that were applied.
export default async function CountsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("retail");
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, rows, scopes, settings] = await Promise.all([
      c.query(`select has_perm($1, 'stock.view') as view, has_perm($1, 'stock.count') as count, has_perm($1, 'costs.view') as costs`, [ctx.employeeId]),
      c.query(
        `select c.id, c.number, c.title, c.status, to_char(c.created_at at time zone s.timezone, 'FMDD FMMonth YYYY') as day, e.name as by,
                coalesce(l.lines, 0)::int as lines, coalesce(l.counted, 0)::int as counted, coalesce(l.units, 0)::int as units, coalesce(l.value, 0)::bigint as value
           from stock_counts c
           join stores s on s.tenant_id = c.tenant_id and s.id = c.store_id
           left join employees e on e.tenant_id = c.tenant_id and e.id = c.started_by
           left join lateral (select count(*) as lines, count(x.counted) as counted, sum(x.diff) as units, round(sum(x.diff * x.unit_cost) / 1000) as value
                                from stock_count_lines x where x.tenant_id = c.tenant_id and x.count_id = c.id) l on true
          where c.tenant_id = $1 and c.store_id = first_store($1) and c.deleted_at is null
          order by c.created_at desc limit 200`,
        [ctx.tenantId],
      ),
      // what a count can be of: the categories, suppliers and brands that have lines of stock in this shop
      c.query(
        `select 'category' as kind, s.category_id::text as id, s.category as name from stock_on_hand($1, first_store($1)) s where s.category_id is not null group by 2, 3
         union all
         select 'supplier', s.supplier_id::text, s.supplier from stock_on_hand($1, first_store($1)) s where s.supplier_id is not null group by 2, 3
         union all
         select 'brand', min(btrim(i.brand)), min(btrim(i.brand)) from stock_on_hand($1, first_store($1)) s join items i on i.tenant_id = $1 and i.id = s.item_id
          where btrim(coalesce(i.brand, '')) <> '' group by lower(btrim(i.brand))
         order by 1, 3`,
        [ctx.tenantId],
      ),
      loadSettings(c, ctx.tenantId),
    ]);
    return {
      may: may.rows[0] as { view: boolean; count: boolean; costs: boolean },
      rows: rows.rows as Row[],
      scopes: scopes.rows as { kind: string; id: string; name: string }[],
      decimals: settings.decimals,
    };
  });
  const head = (
    <PageHead title="Counts" lede="Counting the shelves, all of them or a part, without closing the shop. A count is scanned or typed, reviewed, and then applied: every line that differs is put right, and the difference is kept." />
  );
  if (!d.may.view) {
    return (
      <div>
        {head}
        <Empty icon={ClipboardCheck} title="Your role cannot see stock">Ask the owner to tick See stock on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const group = (kind: string, title: string) => {
    const of = d.scopes.filter((s) => s.kind === kind);
    return of.length === 0 ? null : (
      <optgroup label={title}>
        {of.map((s) => (
          <option key={kind + s.id} value={`${kind}:${s.id}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
    );
  };
  return (
    <div>
      {head}
      <Flash sp={sp} />
      {d.may.count && (
        <Card title="New count">
          <form action={newCount} className="bo-toolbar" style={{ margin: 0 }}>
            <select name="what" defaultValue="all" aria-label="What to count">
              <option value="all">The whole shop</option>
              {group("category", "One category")}
              {group("supplier", "One supplier")}
              {group("brand", "One brand")}
            </select>
            <Submit>Start counting</Submit>
            <span className="muted">The shop can stay open while it is counted.</span>
          </form>
        </Card>
      )}
      {d.rows.length === 0 ? (
        <Empty icon={ClipboardCheck} title="No counts yet">{d.may.count ? "Start the first one above." : "A count started by someone who may run counts shows here."}</Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Count</th>
                  <th>What</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th className="num">Lines counted</th>
                  <th className="num">Net difference</th>
                  {d.may.costs && <th className="num">At cost</th>}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">
                      <Link href={`${PATH}/${r.id}`}>{r.number}</Link>
                    </td>
                    <td>{r.title}</td>
                    <td>
                      <span className={COUNT_TONE[r.status]}>{COUNT_STATUS[r.status]}</span>
                    </td>
                    <td>
                      {r.day}
                      {r.by ? `, ${r.by}` : ""}
                    </td>
                    <td className="num">{r.counted} of {r.lines}</td>
                    <td className="num">{r.status === "completed" ? (r.units > 0 ? "+" : "") + units(r.units) : ""}</td>
                    {d.may.costs && <td className="num">{r.status === "completed" ? money(Number(r.value), d.decimals) : ""}</td>}
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
