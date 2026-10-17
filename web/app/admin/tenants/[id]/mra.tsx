import { checklistWords, MRA_STATE_WORDS, type ChecklistLine, type MraState } from "@/lib/mra";
import { Submit } from "../../../backoffice/busy";
import { ConfirmSubmit } from "../../confirm";

type Action = (f: FormData) => Promise<void>;
export type MraTill = { id: string; name: string; code: string; store: string; mra_ebs_id: string | null };

// A Premium MRA client's part of its page (0116): where it stands, what the
// move still lacks, the ID the MRA gave each of its tills, and the way back to
// plain Premium. The owner fills the company details, the tax codes and goods
// or services in the back office; the IDs come from the client registering
// each till on the MRA's portal, and are typed in here.
export function MraPanel({
  tenantId,
  state,
  checklist,
  tills,
  setTillMraIds,
  setMra,
}: {
  tenantId: string;
  state: MraState;
  checklist: ChecklistLine[];
  tills: MraTill[];
  setTillMraIds: Action;
  setMra: Action;
}) {
  const which = <input type="hidden" name="tenant" value={tenantId} />;
  const lines = checklistWords(checklist);
  const left = lines.filter((l) => !l.ok).length;
  return (
    <section className="card flush">
      <div className="card-head">
        <h2>MRA e-invoicing</h2>
        <span className={state === "live" ? "badge green" : "badge amber"}>{MRA_STATE_WORDS[state]}</span>
      </div>
      <div className="card-body">
        <p className="help" style={{ marginTop: 0 }}>
          {left === 0
            ? "Everything the move needs is there."
            : `${left} of ${lines.length} still to do. The owner fills the company details, the tax codes and goods or services in the back office (Company details, Taxes, Categories).`}{" "}
          Training and going live come with the till update that sends sales to the MRA.
        </p>
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 6 }}>
          {lines.map((l) => (
            <li key={l.key}>
              <span className={l.ok ? "badge green" : "badge amber"}>{l.ok ? "Done" : "To do"}</span> {l.title}
              {l.detail && <span className="muted"> · {l.detail}</span>}
            </li>
          ))}
        </ul>
        {tills.length > 0 && (
          <form action={setTillMraIds} className="adm-part">
            {which}
            <strong>EBS MRA ID of each till</strong>
            <span className="help">The ID the MRA gave the till when the client registered it on the MRA&apos;s portal. One per till.</span>
            {tills.map((t) => (
              <label key={t.id} className="field">
                {t.name} ({t.code}){t.store ? ` · ${t.store}` : ""}
                <input name={"mra_" + t.id} defaultValue={t.mra_ebs_id ?? ""} maxLength={64} autoComplete="off" spellCheck={false} />
              </label>
            ))}
            <div className="inline">
              <Submit className="btn-quiet">Save IDs</Submit>
            </div>
          </form>
        )}
        <form action={setMra} className="adm-part">
          {which}
          <input type="hidden" name="state" value="off" />
          <div className="inline">
            <ConfirmSubmit
              title="Turn MRA off?"
              text="The client goes back to plain Premium. What it filled in for the MRA stays, for the day it moves again."
              yes="Turn MRA off"
              className="btn-quiet"
            >
              Turn MRA off
            </ConfirmSubmit>
          </div>
        </form>
      </div>
    </section>
  );
}
