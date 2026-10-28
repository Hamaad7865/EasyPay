import { redirect } from "next/navigation";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { UUID } from "@/lib/action";
import { cancel, confirm } from "@/lib/assistant/changes";
import { cardHtml, CARD_CSS } from "@/lib/assistant/card";
import type { DoneCard, PreviewCard } from "@/lib/assistant/types";
import { Flash, PageHead, type Search } from "../../../ui";

// A change Claude worked out, shown in the back office (spec Q4): for a Claude
// app that can't draw the card or press its button, and as the guaranteed
// human Confirm. Only the person who asked for it sees it, signed in.

const who = (ctx: Awaited<ReturnType<typeof tenantContext>>) => ({
  grantId: null,
  tenantId: ctx.tenantId,
  employeeId: ctx.employeeId,
  employeeName: ctx.employeeName ?? "",
  tenantName: ctx.tenantName ?? "",
  mode: ctx.mode,
  suspended: ctx.status !== "active",
});

async function decide(f: FormData) {
  "use server";
  const ctx = await tenantContext();
  const id = String(f.get("id") ?? "");
  const back = `/backoffice/assistant/p/${id}`;
  if (!UUID.test(id)) redirect("/backoffice/assistant");
  if (f.get("no") === "1") {
    await cancel(who(ctx), id);
    redirect(`${back}?ok=${encodeURIComponent("Cancelled. Nothing was changed.")}`);
  }
  const card = await readTenant(ctx.tenantId, async (c) => (await c.query(`select card from assistant_proposals where tenant_id = $1 and id = $2`, [ctx.tenantId, id])).rows[0]?.card as PreviewCard | undefined);
  if (card?.typeName && String(f.get("typed") ?? "").trim().toLowerCase() !== card.typeName.trim().toLowerCase()) {
    redirect(`${back}?err=${encodeURIComponent(`Type ${card.typeName} to confirm.`)}`);
  }
  let done: DoneCard;
  try {
    done = await confirm(who(ctx), id, null, true);
  } catch (e) {
    redirect(`${back}?err=${encodeURIComponent(e instanceof Error ? e.message : "That couldn't be done.")}`);
  }
  redirect(`${back}?ok=${encodeURIComponent(done.title)}`);
}

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await tenantContext();
  const p = UUID.test(id)
    ? await readTenant(ctx.tenantId, async (c) =>
        (await c.query(`select card, employee_id, used_at is not null as used, expires_at < now() as late from assistant_proposals where tenant_id = $1 and id = $2`, [ctx.tenantId, id])).rows[0],
      )
    : null;
  const mine = p && p.employee_id === ctx.employeeId;
  return (
    <div>
      <PageHead title="A change from Claude" lede="What Claude worked out, as it will be on the tablet. Nothing is changed until you confirm it." />
      <Flash sp={sp} />
      {!p || !mine ? (
        <div className="note warn">This change isn&apos;t yours to confirm, or it isn&apos;t there.</div>
      ) : (
        <>
          <style>{CARD_CSS + ".ep [data-confirm],.ep [data-cancel],.ep [data-type-name]{display:none}"}</style>
          <div className="ep" dangerouslySetInnerHTML={{ __html: cardHtml(p.card as PreviewCard) }} />
          {p.used ? (
            <p className="muted">This change was already confirmed or cancelled.</p>
          ) : p.late ? (
            <p className="muted">This preview ran out. Ask Claude for it again to see it as things are now.</p>
          ) : (
            <form action={decide} className="bo-toolbar" style={{ marginTop: 16 }}>
              <input type="hidden" name="id" value={id} />
              {(p.card as PreviewCard).typeName && <input name="typed" placeholder={`Type ${(p.card as PreviewCard).typeName} to confirm`} required />}
              <button type="submit" className={(p.card as PreviewCard).danger ? "btn danger" : "btn"}>
                {(p.card as PreviewCard).confirm}
              </button>
              <button type="submit" name="no" value="1" className="btn-link" formNoValidate>
                Cancel
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
