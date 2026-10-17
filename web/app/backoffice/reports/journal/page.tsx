import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { isDay } from "@/lib/day";
import { isOffline } from "@/lib/plan";
import { money } from "@/lib/settings";
import { fmtDay, reportStart, today } from "@/lib/report";
import { journalData } from "@/lib/journal-db";
import { buildJournal, COMPARISONS, type Compare, compareRange, type Filters, pctChange, presets, type Ref } from "@/lib/journal";
import { Card, one, PageHead, type Search } from "../../ui";
import { Stat } from "../parts";
import { PrintButton } from "../print-button";
import { Submit } from "../../busy";

// The sales journal (Carfectionist's, after Cashmag's "Journal de ventes"):
// one period, money received, broken down five ways that all foot to the
// same total, and the bridge from that money to what was sold. Standard and
// Premium (and trial); a business on the offline plan has no back office of
// its own, and the platform admin looking in is told so. The address is the
// report's only state, so a link or a print is the same report.

const PATH = "/backoffice/reports/journal";
const TIME = /^\d{2}:\d{2}$/;
const minutes = (v: string) => (TIME.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)) : undefined);

export default async function SalesJournal({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const { l, ok, s } = await reportStart(c, ctx.tenantId, ctx.employeeId);
    const t = (await c.query(`select name, plan from tenants where id = $1`, [ctx.tenantId])).rows[0] as { name: string; plan: string | null };
    const now = today(l.tz);
    let from = isDay(one(sp.from)) ? one(sp.from) : now;
    let to = isDay(one(sp.to)) ? one(sp.to) : from;
    if (to < from) [from, to] = [to, from];
    const cmp = (COMPARISONS.find((x) => x.key === one(sp.cmp))?.key ?? "none") as Compare;
    const filters: Filters = {
      device: one(sp.dev) || undefined, user: one(sp.usr) || undefined, item: one(sp.item) || undefined,
      from: minutes(one(sp.t0)), to: minutes(one(sp.t1)),
    };
    if (!ok || isOffline(t.plan)) return { ok, offline: isOffline(t.plan), s, now, from, to, cmp, filters, t, l };
    const data = await journalData(c, ctx.tenantId, from, to, shop);
    const label = shop ? `Sales [${t.name}]` : undefined;
    const j = buildJournal({ ...data, filters, shopLabel: label });
    const range = compareRange(cmp, { from, to });
    const prior = range ? buildJournal({ ...(await journalData(c, ctx.tenantId, range.from, range.to, shop)), filters, shopLabel: label }) : null;
    return { ok, offline: false, s, now, from, to, cmp, filters, t, l, j, prior, range, data };
  });
  const head = <PageHead title="Sales journal" lede="One period's takings, broken down by sale method, tax, payment, category and person, every part adding up to the same money received." />;
  if (d.offline) return <div>{head}<div className="note">The sales journal comes with the Standard and Premium plans. This business is on the offline plan: its sales are on its tablet.</div></div>;
  if (!d.ok || !("j" in d) || !d.j) return <div>{head}<div className="note warn">Your role does not include seeing reports.</div></div>;
  const j = d.j;
  const prior = d.prior ?? null;
  const m = (v: number) => money(v, d.s.decimals);
  const q = (o: Record<string, string>) => {
    const p = new URLSearchParams({ from: d.from, to: d.to });
    if (d.cmp !== "none") p.set("cmp", d.cmp);
    for (const [k, v] of Object.entries({ dev: one(sp.dev), usr: one(sp.usr), item: one(sp.item), t0: one(sp.t0), t1: one(sp.t1) })) if (v) p.set(k, v);
    for (const [k, v] of Object.entries(o)) v ? p.set(k, v) : p.delete(k);
    return `${PATH}?${p}`;
  };
  const label = d.from === d.to ? fmtDay(d.from) : `${fmtDay(d.from)} to ${fmtDay(d.to)}`;
  const delta = (now: number, prev: number) => {
    const p = pctChange(now, prev);
    return p === null ? "new" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`;
  };
  const priorCell = (now: number, prev: number | undefined) => (prior ? <td className="num muted">{m(prev ?? 0)} <span className="sub">{delta(now, prev ?? 0)}</span></td> : null);
  const priorHead = prior ? <th className="num">Before</th> : null;
  const find = <T extends { label: string }>(rows: T[] | undefined, l: string) => rows?.find((r) => r.label === l);
  const merged = <T extends { label: string }>(now: T[], prev: T[] | undefined, zero: (l: string) => T) => (prev ? [...now, ...prev.filter((p) => !now.some((x) => x.label === p.label)).map((p) => zero(p.label))] : now);
  const refs = (list: Ref[]) =>
    list.length > 0 && (
      <details className="no-print">
        <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>{list.length} {list.length === 1 ? "sale" : "sales"}</summary>
        <ul className="plain" style={{ margin: "6px 0 0", paddingLeft: 16 }}>
          {list.slice(0, 200).map((r) => (
            <li key={r.id} style={{ fontSize: 12.5 }}>
              <Link href={`/backoffice/receipts?q=${encodeURIComponent(r.number)}`}>{r.number}</Link> · {fmtDay(r.day)}
              {r.customer ? ` · ${r.customer}` : ""}{r.earlier ? " · sold earlier" : ""} · {m(r.cents)}
            </li>
          ))}
        </ul>
      </details>
    );
  const p = presets(d.now);
  const f = d.data!.facets;
  return (
    <div>
      {head}
      <form method="get" action={PATH} className="filters no-print" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginBottom: 16 }}>
        <span className="seg">
          {p.map((x) => (
            <Link key={x.key} href={q({ from: x.range.from, to: x.range.to })} className={d.from === x.range.from && d.to === x.range.to ? "on" : undefined}>{x.label}</Link>
          ))}
        </span>
        <label className="field" style={{ margin: 0 }}>From<input type="date" name="from" defaultValue={d.from} /></label>
        <label className="field" style={{ margin: 0 }}>To<input type="date" name="to" defaultValue={d.to} /></label>
        <label className="field" style={{ margin: 0 }}>
          Compare with
          <select name="cmp" defaultValue={d.cmp}>
            {COMPARISONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          Till
          <select name="dev" defaultValue={one(sp.dev)}>
            <option value="">All tills</option>
            {f.devices.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          Rung up by
          <select name="usr" defaultValue={one(sp.usr)}>
            <option value="">Everyone</option>
            {f.users.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          With the item
          <select name="item" defaultValue={one(sp.item)}>
            <option value="">Any</option>
            {f.items.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>From hour<input type="time" name="t0" defaultValue={one(sp.t0)} /></label>
        <label className="field" style={{ margin: 0 }}>To hour<input type="time" name="t1" defaultValue={one(sp.t1)} /></label>
        <Submit className="btn-quiet">Show</Submit>
        <PrintButton />
      </form>

      <div style={{ marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>{d.t.name}</div>
        <h2 style={{ margin: "2px 0 0" }}>{label}</h2>
        {prior && d.range && <div className="muted">compared with {d.range.from === d.range.to ? fmtDay(d.range.from) : `${fmtDay(d.range.from)} to ${fmtDay(d.range.to)}`}</div>}
        <div className="muted" style={{ fontSize: 12.5 }}>
          Cash basis: every figure is money received in these days, whatever sale it paid for. A sale put on a customer&apos;s account counts the day it is paid.
        </div>
      </div>

      <div className="stats three">
        <Stat label="Sales that took money" value={String(j.bills)} note={prior ? `${prior.bills} before · ${delta(j.bills, prior.bills)}` : undefined} />
        <Stat label="Total received incl. tax" value={m(j.incl)} note={`Average ${m(j.avg)}` + (prior ? ` · ${m(prior.incl)} before · ${delta(j.incl, prior.incl)}` : "")} />
        <Stat label="Customers" value={String(j.clients)} note={j.clients ? `${m(j.clientIncl)} received · average ${m(j.clientAvg)}` : "No named customer"} />
      </div>
      {d.data!.unplaced !== 0 && (
        <div className="note warn">
          <strong>{m(d.data!.unplaced)} paid on accounts in these days is left out of every figure.</strong>It was put on a sale the server does not hold. See Accounts, Exceptions.
        </div>
      )}

      <Card title="Sale methods" flush>
        <table>
          <thead><tr><th>Sale method</th><th className="num">Sales</th><th className="num">Excl. tax</th><th className="num">Incl. tax</th>{priorHead}</tr></thead>
          <tbody>
            {merged(j.methods, prior?.methods, (l) => ({ label: l, n: 0, excl: 0, incl: 0 })).map((r) => (
              <tr key={r.label}><td className="strong">{r.label}</td><td className="num">{r.n}</td><td className="num">{m(r.excl)}</td><td className="num strong">{m(r.incl)}</td>{priorCell(r.incl, find(prior?.methods, r.label)?.incl)}</tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{j.bills}</td><td className="num">{m(j.excl)}</td><td className="num">{m(j.incl)}</td>{priorCell(j.incl, prior?.incl)}</tr></tfoot>
        </table>
      </Card>

      <Card title="Taxes" flush>
        <table>
          <thead><tr><th>Tax</th><th className="num">Tax</th><th className="num">Excl. tax</th><th className="num">Incl. tax</th>{priorHead}</tr></thead>
          <tbody>
            {j.taxes.map((r) => (
              <tr key={r.label}><td className="strong">{r.label}</td><td className="num">{m(r.tax)}</td><td className="num">{m(r.excl)}</td><td className="num strong">{m(r.incl)}</td>{priorCell(r.incl, find(prior?.taxes, r.label)?.incl)}</tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{m(j.vat)}</td><td className="num">{m(j.excl)}</td><td className="num">{m(j.incl)}</td>{priorCell(j.incl, prior?.incl)}</tr></tfoot>
        </table>
      </Card>

      <Card title="Payments" lede="The money, by how it came in; money given back on a return is taken off" flush>
        <table>
          <thead><tr><th>Payment method</th><th className="num">Payments</th><th className="num">Amount</th>{priorHead}</tr></thead>
          <tbody>
            {j.payments.length === 0 && <tr><td colSpan={prior ? 4 : 3} className="muted">No money was taken in these days.</td></tr>}
            {j.payments.map((r) => (
              <tr key={r.label}><td className="strong">{r.label}{refs(r.refs)}</td><td className="num">{r.n}</td><td className="num strong">{m(r.cents)}</td>{priorCell(r.cents, find(prior?.payments, r.label)?.cents)}</tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Total received</td><td /><td className="num">{m(j.received)}</td>{priorCell(j.received, prior?.received)}</tr>
          </tfoot>
        </table>
        <table>
          <thead><tr><th>From the money to what was sold</th><th className="num">Amount</th></tr></thead>
          <tbody>
            <tr><td>Money received</td><td className="num">{m(j.received)}</td></tr>
            <tr><td>Less money paid on sales made before these days{refs(j.earlierRefs)}</td><td className="num">{m(-j.earlier)}</td></tr>
            <tr><td>Plus what was settled without money: returned goods, credit notes, deposits, taken off earlier accounts{refs(j.withoutRefs)}</td><td className="num">{m(j.without)}</td></tr>
            <tr><td>Plus what is still on account, not yet paid{refs(j.onAccountRefs)}</td><td className="num">{m(j.onAccount)}</td></tr>
          </tbody>
          <tfoot><tr><td>Sold in these days, less refunds</td><td className="num">{m(j.sold)}</td></tr></tfoot>
        </table>
        {shop && (d.data!.deposits.taken !== 0 || d.data!.deposits.back !== 0) && (
          <p className="muted" style={{ padding: "10px 16px", margin: 0 }}>
            Deposits: {m(d.data!.deposits.taken)} taken and {m(d.data!.deposits.back)} given back in these days. That is money too, but not a sale until the goods
            are collected, so it is in no figure here; it is on Deposits and on Day closing.
          </p>
        )}
      </Card>

      <Card title="Categories" flush>
        <table>
          <thead><tr><th>Category</th><th className="num">Quantity</th><th className="num">%</th><th className="num">Excl. tax</th><th className="num">Incl. tax</th>{priorHead}</tr></thead>
          <tbody>
            {merged(j.categories, prior?.categories, (l) => ({ label: l, qty: 0, pct: 0, excl: 0, incl: 0 })).map((r) => (
              <tr key={r.label}>
                <td className="strong">{r.label}</td>
                <td className="num">{Number.isInteger(r.qty / 1000) ? r.qty / 1000 : (r.qty / 1000).toFixed(2)}</td>
                <td className="num muted">{r.pct.toFixed(2)}%</td>
                <td className="num">{m(r.excl)}</td>
                <td className="num strong">{m(r.incl)}</td>
                {priorCell(r.incl, find(prior?.categories, r.label)?.incl)}
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td /><td /><td className="num">{m(j.excl)}</td><td className="num">{m(j.incl)}</td>{priorCell(j.incl, prior?.incl)}</tr></tfoot>
        </table>
      </Card>

      <Card title="People" lede="Who took the money" flush>
        <table>
          <thead><tr><th>Person</th><th className="num">Sales</th><th className="num">Excl. tax</th><th className="num">Incl. tax</th>{priorHead}</tr></thead>
          <tbody>
            {merged(j.users, prior?.users, (l) => ({ label: l, n: 0, excl: 0, incl: 0 })).map((r) => (
              <tr key={r.label}><td className="strong">{r.label}</td><td className="num">{r.n}</td><td className="num">{m(r.excl)}</td><td className="num strong">{m(r.incl)}</td>{priorCell(r.incl, find(prior?.users, r.label)?.incl)}</tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td /><td className="num">{m(j.excl)}</td><td className="num">{m(j.incl)}</td>{priorCell(j.incl, prior?.incl)}</tr></tfoot>
        </table>
      </Card>
    </div>
  );
}
