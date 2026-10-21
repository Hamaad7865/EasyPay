import Link from "next/link";
import { notFound } from "next/navigation";
import { Ticket } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { onMra } from "@/lib/mra";
import { readTenant } from "@/lib/db";
import { act, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money } from "@/lib/settings";
import { clock, lists } from "@/lib/report";
import { Empty, Flash, one, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

// A shop's credit notes (migration 0109): what an exchange left over for the
// customer, printed as a slip at the till and spent there by its number.
// Nothing is issued from here: a note only comes out of an exchange at a
// till. The owner cancels one, with a reason; its refund stands.

const PATH = "/backoffice/credit-notes";

type Row = {
  id: string;
  number: string;
  amount: string;
  balance: string;
  valid_to: string | null;
  status: "open" | "used" | "void";
  created_at: string;
  void_reason: string | null;
  used_at: string | null;
  refund_no: string | null;
  receipt_no: string | null;
  deposit_no: string | null;
  customer: string | null;
  issued_by: string | null;
  spends: string;
  expired: boolean;
};

async function voidNote(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    const reason = text(f, "reason", 200);
    if (reason.length < 3) throw new Refused("Say why the note is cancelled.");
    try {
      await c.query(`select credit_note_void($1, $2, $3, $4)`, [ctx.tenantId, ctx.employeeId, id, reason]);
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      throw new Refused(m.includes("note-closed") ? "That note was already used up or cancelled." : m.includes("bad-note") ? "That note no longer exists. Reload the page." : "The note could not be cancelled. Nothing was changed.");
    }
    return "The credit note was cancelled. It can no longer be spent; the refund that issued it stands.";
  });
}

export default async function CreditNotesPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (ctx.mode !== "retail") notFound();
  const show = one(sp.show) === "closed" ? "closed" : "open";
  const q = one(sp.q).trim().slice(0, 60);
  const d = await readTenant(ctx.tenantId, async (c) => ({
    l: await lists(c, ctx.tenantId),
    s: await loadSettings(c, ctx.tenantId),
    may: (await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId])).rows[0].ok as boolean,
    rows: (
      await c.query(
        `select n.id, n.number, n.amount, n.balance, n.valid_to::text as valid_to, n.status, n.created_at, n.void_reason, n.used_at,
                r.number as refund_no, o.number as receipt_no, dp.number as deposit_no, cu.name as customer, e.name as issued_by,
                (n.status = 'open' and n.valid_to is not null and n.valid_to < current_date) as expired,
                (select count(*) from receipt_payments rp
                   join receipts s on s.tenant_id = rp.tenant_id and s.id = rp.receipt_id and s.type = 'sale' and s.deleted_at is null
                   join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id
                  where rp.tenant_id = n.tenant_id and rp.reference = n.number and pt.kind = 'credit_note') as spends
           from credit_notes n
           left join receipts r on r.tenant_id = n.tenant_id and r.id = n.refund_id
           left join receipts o on o.tenant_id = r.tenant_id and o.id = r.refund_of
           left join deposits dp on dp.tenant_id = n.tenant_id and dp.id = n.deposit_id
           left join customers cu on cu.tenant_id = n.tenant_id and cu.id = n.customer_id
           left join employees e on e.tenant_id = n.tenant_id and e.id = n.issued_by
          where n.tenant_id = $1 and n.deleted_at is null
            and (case when $2 = 'open' then n.status = 'open' and (n.valid_to is null or n.valid_to >= current_date)
                      else not (n.status = 'open' and (n.valid_to is null or n.valid_to >= current_date)) end)
            and ($3 = '' or n.number ilike '%' || $3 || '%' or cu.name ilike '%' || $3 || '%')
          order by n.created_at desc limit 300`,
        [ctx.tenantId, show, q],
      )
    ).rows as Row[],
  }));
  const at = clock(d.l.tz);
  const m = (v: string | number) => money(Number(v), d.s.decimals);
  const open = d.rows.reduce((a, r) => a + (show === "open" ? Number(r.balance) : 0), 0);
  const state = (r: Row) =>
    r.status === "void" ? `Cancelled: ${r.void_reason ?? ""}` : r.status === "used" ? `Used up${r.used_at ? " " + at(r.used_at) : ""}` : r.expired ? `Expired on ${r.valid_to}` : r.valid_to ? `Valid to ${r.valid_to}` : "Does not expire";
  return (
    <div>
      {/* for a client on MRA a credit note is the MRA's word for a refund: EasyPay's are store credit (design 7, 0132) */}
      <PageHead
        title={onMra(ctx.mra) ? "Store credit" : "Credit notes"}
        lede={`What an exchange left over for the customer, printed as a slip at the till and spent there by its number, in one go or in parts. A note is issued only at a till; from here one can be cancelled.${onMra(ctx.mra) ? " It is store credit, not an MRA credit note: a refund goes to the MRA as one by itself." : ""}`}
      >
        <Link href="/backoffice/settings" className="btn-quiet">Returns setting</Link>
      </PageHead>
      <Flash sp={sp} />
      <form method="get" className="inline" style={{ marginBottom: 14 }}>
        <input type="hidden" name="show" value={show} />
        <input name="q" defaultValue={q} placeholder="Number or customer" aria-label="Find a credit note" />
        <Submit className="btn-quiet btn-sm">Find</Submit>
        <span className="seg" style={{ marginLeft: 12 }}>
          <Link href={`${PATH}?show=open${q ? "&q=" + encodeURIComponent(q) : ""}`} className={show === "open" ? "on" : undefined}>Open</Link>
          <Link href={`${PATH}?show=closed${q ? "&q=" + encodeURIComponent(q) : ""}`} className={show === "closed" ? "on" : undefined}>Used, expired, cancelled</Link>
        </span>
      </form>
      {show === "open" && d.rows.length > 0 && (
        <div className="note"><strong>{m(open)} on {d.rows.length} open {d.rows.length === 1 ? "note" : "notes"}</strong>Money the shop owes in goods. It is in no tender on the reports; Day closing says what was issued and redeemed.</div>
      )}
      {d.rows.length === 0 ? (
        <Empty icon={Ticket} title={show === "open" ? "No open credit notes" : "Nothing here"}>
          {show === "open" ? "A note is issued at the till when an exchange is worth less than what came back, and Returns is set to keep the rest on a credit note." : "Used, expired and cancelled notes show here."}
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Issued</th>
              <th>From</th>
              <th>Customer</th>
              <th className="num">Amount</th>
              <th className="num">Left</th>
              <th>State</th>
              <th>Spent on</th>
              {d.may && show === "open" && <th />}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.number}</td>
                <td>{at(r.created_at)}{r.issued_by && <span className="sub">{r.issued_by}</span>}</td>
                <td>
                  {r.deposit_no ? (
                    <>
                      <Link href={`/backoffice/deposits?q=${encodeURIComponent(r.deposit_no)}`}>{r.deposit_no}</Link>
                      <span className="sub">a cancelled deposit</span>
                    </>
                  ) : (
                    <>{r.refund_no}{r.receipt_no && <span className="sub">exchange of {r.receipt_no}</span>}</>
                  )}
                </td>
                <td>{r.customer ?? <span className="muted">Not named</span>}</td>
                <td className="num">{m(r.amount)}</td>
                <td className="num strong">{m(r.balance)}</td>
                <td>{state(r)}</td>
                <td>{Number(r.spends) === 0 ? <span className="muted">Nothing yet</span> : `${r.spends} ${Number(r.spends) === 1 ? "sale" : "sales"}`}</td>
                {d.may && show === "open" && (
                  <td>
                    <details>
                      <summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>Cancel</summary>
                      <form action={voidNote} className="inline" style={{ marginTop: 6 }}>
                        <input type="hidden" name="id" value={r.id} />
                        <input name="reason" placeholder="Why it is cancelled" required minLength={3} />
                        <Submit className="btn-quiet btn-sm">Cancel the note</Submit>
                      </form>
                    </details>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
