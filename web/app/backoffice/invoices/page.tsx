import { Plus, ScrollText } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { branches, pickedOf, workingBranch } from "@/lib/branch";
import { stateOf } from "@/lib/invoice-money";
import { BranchPicker } from "../branch-picker";
import { Empty, Flash, one, PageHead, type Search, startKey, startOf } from "../ui";
import { Submit } from "../busy";
import { newInvoice } from "./actions";
import { type ListRow, listRows, loadSeries, loadSetup, NO_SETUP, receivedOn } from "./data";
import { InvoiceList } from "./list";
import { SetupPanel } from "./setup";

// Invoices (docs/superpowers/specs/2026-11-12-invoices-design.md): A4 invoices for customers who pay later. The list,
// today's figures on top, a new one, and the set-up. Every business with a back office has it, restaurant or shop.
export default async function InvoicesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const all = await branches(c, ctx.tenantId);
    const picked = await pickedOf(all);
    const working = workingBranch(all, picked);
    const may = (await c.query(`select has_perm($1, 'invoices.manage') as manage, has_perm($1, 'reports.view') as view`, [ctx.employeeId])).rows[0] as { manage: boolean; view: boolean };
    if (!may.manage && !may.view) return { all, picked, working, may, rows: [] as ListRow[], today: "", received: 0, setup: NO_SETUP, series: [], decimals: 2 as const };
    // the day where the branch is, not the server's: an invoice is late from the branch's own midnight
    const today = (
      await c.query(
        `select invoice_today($1, coalesce($2::uuid, (select id from stores where tenant_id = $1 and deleted_at is null order by created_at, id limit 1)))::text as d`,
        [ctx.tenantId, working?.id ?? null],
      )
    ).rows[0].d as string;
    const [rows, received, setup, series, settings] = await Promise.all([
      listRows(c, ctx.tenantId, working?.id ?? null),
      receivedOn(c, ctx.tenantId, today, working?.id ?? null),
      loadSetup(c, ctx.tenantId),
      loadSeries(c, ctx.tenantId),
      loadSettings(c, ctx.tenantId),
    ]);
    return { all, picked, working, may, rows, today, received, setup, series, decimals: settings.decimals };
  });

  const customer = one(sp.customer);
  const head = (
    <PageHead
      title="Invoices"
      lede="A4 invoices for customers who pay later: companies, government offices, anyone who asks for one. A draft keeps itself as you type; issuing it gives it its number and takes what is on it out of stock."
    >
      <BranchPicker all={d.all} picked={d.picked?.id ?? null} />
      {(d.may.manage || d.may.view) && (
        <SetupPanel
          key={[one(sp.setup), one(sp.ok), one(sp.err)].join("|")}
          open={one(sp.setup) === "1"}
          setup={d.setup}
          series={d.series}
          manage={d.may.manage}
          said={{ ok: one(sp.ok), err: one(sp.err) }}
        />
      )}
      {d.may.manage && (
        <form action={newInvoice} className="inv-new">
          {/* the branch it is from: the one picked, or chosen here with All branches */}
          {d.working ? (
            <input type="hidden" name="store" value={d.working.id} />
          ) : (
            <select name="store" required defaultValue="" aria-label="Branch the invoice is from">
              <option value="" disabled>Branch</option>
              {d.all.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          {/* from a customer's page: the new invoice starts with them on it */}
          {UUID.test(customer) && <input type="hidden" name="customer" value={customer} />}
          <Submit>
            <Plus aria-hidden="true" />
            New invoice
          </Submit>
        </form>
      )}
    </PageHead>
  );

  if (!d.may.manage && !d.may.view) {
    return (
      <div className="inv-page">
        {head}
        <Empty icon={ScrollText} title="Your role cannot see invoices">Ask the owner to tick Make and issue invoices, or See reports, on your role, under Roles and permissions.</Empty>
      </div>
    );
  }

  const rs = (cents: number) => money(cents, d.decimals);
  const issued = d.rows.filter((r) => r.status === "issued");
  const today = issued.filter((r) => r.issued_on === d.today);
  const owed = issued.filter((r) => r.total > r.paid);
  const late = owed.filter((r) => stateOf(r, d.today) === "overdue");
  const sum = (xs: ListRow[], f: (r: ListRow) => number) => xs.reduce((a, r) => a + f(r), 0);
  const count = (n: number) => (n === 1 ? "1 invoice" : `${n} invoices`);
  const start = startOf(sp, "q", "tab", "sort");
  return (
    <div className="inv-page">
      {head}
      <Flash sp={sp} />
      {ctx.mra !== "off" && (
        <p className="note warn">
          This business sends its invoices to the MRA through its tills. An invoice can be prepared here as a draft; issuing it from the back office waits
          until a till can send it to the MRA, which comes next.
        </p>
      )}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Issued today</div>
          <div className="stat-value">{rs(sum(today, (r) => r.total))}</div>
          <div className="stat-note">{today.length ? count(today.length) : "None yet"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Received today</div>
          <div className="stat-value">{rs(d.received)}</div>
          <div className="stat-note">Paid on invoices, every way</div>
        </div>
        <div className="stat">
          <div className="stat-label">Not paid yet</div>
          <div className="stat-value">{rs(sum(owed, (r) => r.total - r.paid))}</div>
          <div className="stat-note">{owed.length ? count(owed.length) : "Nothing owed"}</div>
        </div>
        <div className={"stat" + (late.length ? " inv-late" : "")}>
          <div className="stat-label">Overdue</div>
          <div className="stat-value">{rs(sum(late, (r) => r.total - r.paid))}</div>
          <div className="stat-note">{late.length ? count(late.length) + " past their due day" : "None late"}</div>
        </div>
      </div>
      <InvoiceList key={startKey(sp, start)} rows={d.rows} start={start} today={d.today} many={!d.working} decimals={d.decimals} />
    </div>
  );
}
