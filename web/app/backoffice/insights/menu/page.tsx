import Link from "next/link";
import type { PoolClient } from "pg";
import { TrendingUp } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { loadSettings, money } from "@/lib/settings";
import { canView, fmtQty, lists, RECEIPTS } from "@/lib/report";
import { Card, Empty, PageHead, type Search } from "../../ui";
import { Delta, Figure, SpanPicker, Standouts, pct, per, period, range } from "../parts";

// What the menu is doing: which items carry the sales, which are selling
// more or less than in the days before, and which did not sell at all. An
// item's figures are the Item sales report's for the same days. There is
// nothing about profit here: the till does not know what a dish costs to make.

type Sold = { name: string; cat: string; qty: number; amount: number };
type Idle = { name: string; cat: string | null; is_available: boolean };

// One row per item name, add-ons included in its amount, refunds taken off.
async function sold(c: PoolClient, tenantId: string, from: string, to: string): Promise<Sold[]> {
  return (
    await c.query(
      `with r as (${RECEIPTS}),
       il as (
         select r.sign, rl.name_snapshot as name, coalesce(k.name, 'No category') as cat, rl.qty,
                line_amount(rl.unit_price, rl.qty) + coalesce((select sum(m.price) from receipt_line_modifiers m
                   where m.tenant_id = $1 and m.receipt_line_id = rl.id), 0) as amount
           from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
           left join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
           left join items i on i.tenant_id = $1 and i.id = tl.item_id
           left join categories k on k.tenant_id = $1 and k.id = i.category_id
       )
       select name, max(cat) as cat, sum(sign * qty)::float8 as qty, sum(sign * amount)::float8 as amount
         from il group by name order by 4 desc, 1`,
      range(tenantId, from, to),
    )
  ).rows as Sold[];
}

const SHOWN = 20;

export default async function MenuPerformance({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => {
    const l = await lists(c, ctx.tenantId);
    const p = period(sp, l.tz);
    if (!(await canView(c, ctx.employeeId))) return { p, ok: false as const };
    return {
      p,
      ok: true as const,
      s: await loadSettings(c, ctx.tenantId),
      now: await sold(c, ctx.tenantId, p.from, p.to),
      before: await sold(c, ctx.tenantId, p.prevFrom, p.prevTo),
      // on the menu today, and on no receipt in these days
      idle: (
        await c.query(
          `with r as (${RECEIPTS}),
           went as (select distinct tl.item_id
                      from r join receipt_lines rl on rl.tenant_id = $1 and rl.receipt_id = r.id
                      join ticket_lines tl on tl.tenant_id = $1 and tl.id = rl.ticket_line_id
                     where r.type = 'sale' and tl.item_id is not null)
           select i.name, k.name as cat, i.is_available
             from items i left join categories k on k.tenant_id = i.tenant_id and k.id = i.category_id
            where i.tenant_id = $1 and i.deleted_at is null and i.id not in (select item_id from went)
            order by k.name nulls last, i.name`,
          range(ctx.tenantId, p.from, p.to),
        )
      ).rows as Idle[],
    };
  });

  const head = (
    <PageHead title="Menu performance" lede="Which items carry your sales, which are selling more or less than before, and which did not sell at all." />
  );
  if (!d.ok) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const { p } = d;
  const m = (v: number) => money(Math.round(v), d.s.decimals);
  const picker = <SpanPicker path="/backoffice/insights/menu" p={p} />;
  const now = d.now.filter((r) => r.qty !== 0 || r.amount !== 0);
  if (!now.length) {
    return (
      <div>
        {head}
        {picker}
        <Empty icon={TrendingUp} title="Nothing sold in these days">
          <p>Once the till has taken payments, the items that sell best show here.</p>
        </Empty>
      </div>
    );
  }

  const total = now.reduce((a, r) => a + r.amount, 0);
  const units = now.reduce((a, r) => a + r.qty, 0);
  const was = new Map(d.before.map((r) => [r.name, r]));
  const top = now[0];
  const mostOrdered = now.reduce((a, b) => (b.qty > a.qty ? b : a));
  const top5 = now.slice(0, 5).reduce((a, r) => a + r.amount, 0);
  // movers: by how many more or fewer were sold, items gone quiet included
  const names = new Set([...now.map((r) => r.name), ...d.before.map((r) => r.name)]);
  const moves = [...names]
    .map((name) => {
      const a = now.find((r) => r.name === name)?.qty ?? 0;
      const b = was.get(name)?.qty ?? 0;
      return { name, now: a, before: b, by: a - b };
    })
    .filter((x) => x.by !== 0);
  const rising = moves.filter((x) => x.by > 0).sort((a, b) => b.by - a.by).slice(0, 5);
  const falling = moves.filter((x) => x.by < 0).sort((a, b) => a.by - b.by).slice(0, 5);
  const idleShown = d.idle.slice(0, 18);
  // "New" means something only when the days before had sales of their own
  const fresh = d.before.length ? "New" : undefined;

  const movers = (rows: typeof moves, none: string) =>
    rows.length ? (
      <ul className="rank">
        {rows.map((r) => (
          <li key={r.name}>
            <div className="rank-row">
              <b>{r.name}</b>
              <strong>{fmtQty(r.now)}</strong>
              <Delta now={r.now} before={r.before} fresh={fresh} />
            </div>
            <small>{r.before > 0 ? `${fmtQty(r.before)} in the ${p.days} days before` : `Not sold in the ${p.days} days before`}</small>
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{none}</p>
    );

  return (
    <div>
      {head}
      {picker}
      <div className="stats">
        <Figure label="Items that sold" value={String(now.length)} now={now.length} before={d.before.filter((r) => r.qty > 0).length} note={`on the ${p.days} days before`} none={`None in the ${p.days} days before`} />
        <Figure label="Units sold" value={fmtQty(units)} now={units} before={d.before.reduce((a, r) => a + r.qty, 0)} />
        <Figure label="From the top five" value={total > 0 ? pct(top5 / total) : "0%"} note="of menu sales" />
        <Figure label="Did not sell" value={String(d.idle.length)} note={d.idle.length === 1 ? "item on the menu" : "items on the menu"} />
      </div>

      <Standouts
        lines={[
          <>
            <b>{top.name}</b> brings in the most: {m(top.amount)}, {total > 0 ? pct(top.amount / total) : "0%"} of what the menu sold.
          </>,
          mostOrdered.name !== top.name && (
            <>
              <b>{mostOrdered.name}</b> is ordered the most: {fmtQty(mostOrdered.qty)} times.
            </>
          ),
          rising[0] && (
            <>
              <b>{rising[0].name}</b> is the biggest climber: {fmtQty(rising[0].now)} sold
              {rising[0].before > 0 ? `, up from ${fmtQty(rising[0].before)}` : `, and none in the ${p.days} days before`}.
            </>
          ),
          falling[0] && (
            <>
              <b>{falling[0].name}</b> fell the most: {fmtQty(falling[0].now)} sold, down from {fmtQty(falling[0].before)}.
            </>
          ),
          d.idle.length > 0 && (
            <>
              <b>
                {d.idle.length} {d.idle.length === 1 ? "item" : "items"}
              </b>{" "}
              on the menu did not sell once in these {p.days} days.
            </>
          ),
        ]}
      />

      <Card
        title="Ranking"
        lede={now.length > SHOWN ? `The ${SHOWN} items that brought in the most, of ${now.length}` : "Every item that sold, by what it brought in"}
        action={
          <Link href={`/backoffice/reports/items?from=${p.from}&to=${p.to}`} className="card-link">
            Item sales
          </Link>
        }
        flush
      >
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Item</th>
              <th className="num">Sold</th>
              <th className="num">Sales</th>
              <th>Share of menu sales</th>
              <th className="num">Sold, on before</th>
            </tr>
          </thead>
          <tbody>
            {now.slice(0, SHOWN).map((r, i) => (
              <tr key={r.name}>
                <td className="num muted">{i + 1}</td>
                <td>
                  <span className="strong">{r.name}</span>
                  <small className="cell-sub">{r.cat}</small>
                </td>
                <td className="num">{fmtQty(r.qty)}</td>
                <td className="num">{m(r.amount)}</td>
                <td>
                  <span className="bar-with">
                    <span className="bar">
                      <i style={{ width: `${Math.max(0, per(r.amount, top.amount) * 100)}%` }} />
                    </span>
                    {total > 0 ? pct(r.amount / total) : "0%"}
                  </span>
                </td>
                <td className="num">
                  <Delta now={r.qty} before={was.get(r.name)?.qty ?? 0} fresh={fresh} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid-2">
        <Card title="Selling more" lede={`Sold, against the ${p.days} days before`}>
          {movers(rising, "Nothing sold more than before.")}
        </Card>
        <Card title="Selling less" lede={`Sold, against the ${p.days} days before`}>
          {movers(falling, "Nothing sold less than before.")}
        </Card>
      </div>

      {d.idle.length > 0 && (
        <Card title="Did not sell" lede={`On the menu today, and on no receipt in these ${p.days} days`}>
          <div className="idle">
            {idleShown.map((i) => (
              <span key={i.name + (i.cat ?? "")} className={i.is_available ? undefined : "off"}>
                {i.name}
                <small>{i.is_available ? (i.cat ?? "No category") : "Sold out"}</small>
              </span>
            ))}
          </div>
          {d.idle.length > idleShown.length && <p className="muted idle-more">And {d.idle.length - idleShown.length} more.</p>}
        </Card>
      )}
    </div>
  );
}
