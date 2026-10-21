import { checklistWords, MRA_MOVES, MRA_STATE_WORDS, testAtMra, tillConnected, type ChecklistLine, type MraState, type TillMraStatus } from "@/lib/mra";
import { Submit } from "../../../backoffice/busy";
import { ConfirmSubmit } from "../../confirm";

type Action = (f: FormData) => Promise<void>;
export type MraTill = { id: string; name: string; code: string; store: string; mra_ebs_id: string | null; mra_status: TillMraStatus };
// the MRA's address and public key, for every client on MRA (0132)
export type MraConnection = { url: string; validTo: string | null; updatedAt: string };

// What a move button says, and what it asks before it moves.
const MOVE: Record<MraState, { label: string; ask?: { title: string; text: string; yes: string } }> = {
  off: { label: "Turn MRA off" },
  setting_up: { label: "Back to setting up" },
  training: { label: "Start training" },
  live: {
    label: "Go live with the MRA",
    ask: {
      title: "Go live with the MRA?",
      text: "Every till of this client sends real invoices to the MRA from its next sale, and they count. Do it after the day is closed. It is left only by turning the MRA off.",
      yes: "Go live with the MRA",
    },
  },
};

// A Premium MRA client's part of its page (0116, 0132): where it stands, what
// the move still lacks, the ID the MRA gave each of its tills and whether each
// is connected, the moves (training, live), the MRA's address and key shared
// by every client, and the way back to plain Premium. The owner fills the
// company details, the tax codes and goods or services in the back office;
// the IDs come from the client registering each till on the MRA's portal, and
// are typed in here; each till's MRA login is typed on the till and never
// leaves it.
export function MraPanel({
  tenantId,
  state,
  checklist,
  tills,
  connection,
  setTillMraIds,
  setMra,
  setMraConnection,
}: {
  tenantId: string;
  state: MraState;
  checklist: ChecklistLine[];
  tills: MraTill[];
  connection: MraConnection | null;
  setTillMraIds: Action;
  setMra: Action;
  setMraConnection: Action;
}) {
  const which = <input type="hidden" name="tenant" value={tenantId} />;
  const connected = tills.filter((t) => tillConnected(t.mra_status)).length;
  const lines = checklistWords(checklist, { connected, total: tills.length });
  const left = lines.filter((l) => !l.ok && l.key !== "login").length;
  const move = (to: MraState) => (
    <form key={to} action={setMra}>
      {which}
      <input type="hidden" name="state" value={to} />
      {MOVE[to].ask ? (
        <ConfirmSubmit title={MOVE[to].ask!.title} text={MOVE[to].ask!.text} yes={MOVE[to].ask!.yes} className="btn">
          {MOVE[to].label}
        </ConfirmSubmit>
      ) : (
        <Submit className={to === "training" ? "btn" : "btn-quiet"}>{MOVE[to].label}</Submit>
      )}
    </form>
  );
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
            : `${left} still to do. The owner fills the company details, the tax codes and goods or services in the back office (Company details, Taxes, Categories).`}{" "}
          {state === "setting_up" && "Training needs every line done and the MRA connection below. "}
          {state === "training" && "The tills send training invoices (TRN): nothing counts. Live needs the client live on EasyPay first. "}
          {state === "live" && "Every till sends each sale to the MRA. "}
        </p>
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 6 }}>
          {lines.map((l) => (
            <li key={l.key}>
              <span className={l.ok ? "badge green" : "badge amber"}>{l.ok ? "Done" : "To do"}</span> {l.title}
              {l.detail && <span className="muted"> · {l.detail}</span>}
            </li>
          ))}
        </ul>
        {MRA_MOVES[state].length > 0 && <div className="inline adm-part">{MRA_MOVES[state].map(move)}</div>}
        {tills.length > 0 && (
          <form action={setTillMraIds} className="adm-part">
            {which}
            <strong>EBS MRA ID of each till</strong>
            <span className="help">The ID the MRA gave the till when the client registered it on the MRA&apos;s portal. One per till.</span>
            {tills.map((t) => (
              <label key={t.id} className="field">
                {t.name} ({t.code}){t.store ? ` · ${t.store}` : ""}
                {" · "}
                <span className={tillConnected(t.mra_status) ? "badge green" : "badge amber"}>
                  {tillConnected(t.mra_status) ? "Connected" : t.mra_status?.refused ? "Login refused" : "Not connected"}
                </span>
                {testAtMra(state, t.mra_status) && (
                  <>
                    {" "}
                    <span className="badge red" title="The MRA answers this till as TEST: its sales do not count until its EBS is live on the MRA's side.">
                      Counted as TEST by the MRA
                    </span>
                  </>
                )}
                <input name={"mra_" + t.id} defaultValue={t.mra_ebs_id ?? ""} maxLength={64} autoComplete="off" spellCheck={false} />
              </label>
            ))}
            <div className="inline">
              <Submit className="btn-quiet">Save IDs</Submit>
            </div>
          </form>
        )}
        <form action={setMraConnection} className="adm-part">
          {which}
          <strong>MRA connection, for every client on MRA</strong>
          <span className="help">
            The MRA&apos;s address and its public key (the .crt from the MRA&apos;s portal, opened as text). Every till of every client on MRA
            receives them with its settings and seals its login with the key. Nothing here is secret.
            {connection
              ? ` Saved ${new Date(connection.updatedAt).toLocaleDateString("en-GB")}${connection.validTo ? `; the certificate ends ${connection.validTo}` : "; the certificate could not be read"}.`
              : " Not typed yet: no till can connect until it is."}
          </span>
          <label className="field">
            Address
            <input name="url" defaultValue={connection?.url ?? "https://vfisc.mra.mu"} required autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            Public key (certificate)
            <textarea name="certificate" rows={4} required placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} />
          </label>
          <div className="inline">
            <Submit className="btn-quiet">Save the MRA connection</Submit>
          </div>
        </form>
        <form action={setMra} className="adm-part">
          {which}
          <input type="hidden" name="state" value="off" />
          <div className="inline">
            <ConfirmSubmit
              title="Turn MRA off?"
              text={
                state === "training" || state === "live"
                  ? "The tills stop sending to the MRA. This client may be obliged by law to send every sale. What was sent stays at the MRA for good."
                  : "The client goes back to plain Premium. What it filled in for the MRA stays, for the day it moves again."
              }
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
