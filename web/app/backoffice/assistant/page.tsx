import { headers } from "next/headers";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, uuid } from "@/lib/action";
import { confirm, propose } from "@/lib/assistant/changes";
import { Card, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

// EasyPay in the owner's own Claude (spec, Back office pages): how to connect
// it, the connections there are, and every change made through it, with
// Restore on a delete for 30 days.

const PATH = "/backoffice/assistant";

async function disconnect(f: FormData) {
  "use server";
  await act("assistant.use", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    const owner = (await c.query(`select has_perm($1, 'employees.edit') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    const r = await c.query(
      `update assistant_grants set ended_at = now(), ended_why = 'disconnected'
        where tenant_id = $1 and id = $2 and ended_at is null and ($3 or employee_id = $4)`,
      [ctx.tenantId, id, owner, ctx.employeeId],
    );
    if (!r.rowCount) throw new Refused("That connection was already ended.");
    return "Disconnected. That Claude can't reach the shop any more.";
  });
}

// Restore, pressed here: the same change Claude's Restore makes, confirmed by
// the person pressing it in their own signed-in back office.
async function restoreChange(f: FormData) {
  "use server";
  await act("items.edit", PATH, async (_c, ctx) => {
    const id = uuid(f, "id");
    const w = { grantId: null, tenantId: ctx.tenantId, employeeId: ctx.employeeId, employeeName: ctx.employeeName ?? "", tenantName: ctx.tenantName ?? "", mode: ctx.mode, suspended: ctx.status !== "active" };
    try {
      const { card } = await propose(w, "restore", { change: id }, "Restore, pressed in the back office", "");
      await confirm(w, card.proposal, null, true);
    } catch (e) {
      throw new Refused(e instanceof Error ? e.message : "That couldn't be restored.");
    }
    return "Restored.";
  });
}

export default async function AssistantPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const h = await headers();
  const address = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host") ?? "easypaypos.com"}/mcp`;
  const d = await readTenant(ctx.tenantId, async (c) => {
    const [may, owner] = (await c.query(`select has_perm($1, 'assistant.use') as may, has_perm($1, 'employees.edit') as owner`, [ctx.employeeId])).rows.map((r) => [r.may, r.owner])[0] as [boolean, boolean];
    const grants = (
      await c.query(
        `select g.id, e.name as who, to_char(g.created_at at time zone 'Indian/Mauritius', 'DD Mon YYYY HH24:MI') as since,
                to_char(g.last_used_at at time zone 'Indian/Mauritius', 'DD Mon YYYY HH24:MI') as used
           from assistant_grants g join employees e on e.id = g.employee_id
          where g.tenant_id = $1 and g.ended_at is null and ($2 or g.employee_id = $3) order by g.created_at desc`,
        [ctx.tenantId, owner, ctx.employeeId],
      )
    ).rows as { id: string; who: string; since: string; used: string | null }[];
    const log = (
      await c.query(
        `select l.id, e.name as who, to_char(l.created_at at time zone 'Indian/Mauritius', 'DD Mon YYYY HH24:MI') as at, l.kind, l.asked, l.summary, l.after,
                l.undo is not null and l.restored_at is null and l.restorable_until > now() as can_restore, l.restored_at is not null as restored
           from assistant_log l join employees e on e.id = l.employee_id
          where l.tenant_id = $1 order by l.created_at desc limit 60`,
        [ctx.tenantId],
      )
    ).rows as { id: string; who: string; at: string; kind: string; asked: string | null; summary: string; after: string[] | null; can_restore: boolean; restored: boolean }[];
    return { may, owner, grants, log };
  });
  return (
    <div>
      <PageHead
        title="EasyPay in Claude"
        lede="Connect EasyPay to your own Claude and run the shop by talking to it: find stock, add a variant with its opening stock, tidy the catalog. Every change shows how it will look on the tablet, and waits for you to confirm it."
      />
      <Flash sp={sp} />
      {!ctx.premium && <div className="note warn">EasyPay in Claude is part of EasyPay Premium.</div>}
      {!d.may && <div className="note warn">Your role doesn&apos;t include Use the assistant. The owner can tick it for your role under Staff, Roles.</div>}
      <Card title="Use EasyPay in Claude">
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
          <li>
            In Claude on the web or the desktop app, open Settings, then Connectors, then <b>Add custom connector</b>.
          </li>
          <li>
            Name it EasyPay and paste this address: <input readOnly value={address} style={{ minWidth: 300, fontFamily: "monospace" }} aria-label="EasyPay's connector address" />
          </li>
          <li>Claude opens EasyPay&apos;s sign-in. Sign in with your back office login and press Allow.</li>
          <li>Once added, it is in the Claude app on your phone too. Claude&apos;s free plan allows one connector.</li>
        </ol>
        <p className="muted" style={{ marginBottom: 0 }}>
          Claude reads and changes the shop as you, with what your role allows. What it reads goes to Anthropic under your own Claude account.
        </p>
      </Card>
      <Card title="Connected apps">
        {d.grants.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No Claude is connected{d.owner ? "" : " as you"}.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th>Connected</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.grants.map((g) => (
                <tr key={g.id}>
                  <td className="strong">Claude, as {g.who}</td>
                  <td>{g.since}</td>
                  <td>{g.used ?? <span className="muted">Not yet</span>}</td>
                  <td className="num">
                    <form action={disconnect}>
                      <input type="hidden" name="id" value={g.id} />
                      <Submit className="btn-link danger">Disconnect</Submit>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Changes made through Claude">
        {d.log.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.log.map((l) => (
                <tr key={l.id}>
                  <td>{l.at}</td>
                  <td>{l.who}</td>
                  <td>
                    <span className="strong">{l.summary}</span>
                    {l.asked && <small className="cell-sub">Asked: {l.asked}</small>}
                    {(l.after ?? []).slice(0, 4).map((x, i) => (
                      <small key={i} className="cell-sub">
                        {x}
                      </small>
                    ))}
                  </td>
                  <td className="num">
                    {l.can_restore ? (
                      <form action={restoreChange}>
                        <input type="hidden" name="id" value={l.id} />
                        <Submit className="btn-sm">Restore</Submit>
                      </form>
                    ) : l.restored ? (
                      <span className="muted">Restored</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
