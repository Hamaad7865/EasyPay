"use client";

import { useActionState } from "react";
import { Submit } from "../../../backoffice/busy";
import { ConfirmSubmit } from "../../confirm";

export type TabletCode = {
  id: string;
  hint: string;
  store: string;
  till: string | null;
  till_code: string | null;
  state: "waiting" | "used" | "ended";
  made_at: string;
  used_at: string | null;
  ended_at: string | null;
};
// What making a code answers: the code itself, once, and what it is for. It
// comes back in the answer to the form and is kept in this page only: never
// in the page's address, never in what was done here.
export type CodeAnswer = { id?: string; code?: string; what?: string; error?: string } | null;
export type CodeAction = (was: CodeAnswer, f: FormData) => Promise<CodeAnswer>;
type Action = (f: FormData) => Promise<void>;

const when = (at: string) => new Date(at).toLocaleString("en-GB", { timeZone: "Indian/Mauritius", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function Answer({ answer, codes }: { answer: CodeAnswer; codes: TabletCode[] }) {
  if (!answer) return null;
  if (answer.error) return <div className="note danger" role="alert">{answer.error}</div>;
  // a code that was used or taken back meanwhile is no longer one to hand out
  if (codes.find((c) => c.id === answer.id)?.state !== "waiting") return null;
  return (
    <div className="note ok" role="status">
      {answer.what}: <strong>{answer.code}</strong>. It is shown this once: write it down or send it now. On the tablet, at the first screen, choose
      &ldquo;Set up with a code&rdquo;.
    </div>
  );
}

// A client's tablets by code (migration 0099): one code sets up one tablet.
// A code for a new tablet in a store, a code for the tablet that replaces a
// till's, and the codes there are, with one nobody used yet to take back. A
// code that waits or is over can be removed from the list (0104); one in use
// is a tablet at work, and goes with its till.
export function Tablets({
  tenant,
  offline,
  stores,
  tills,
  codes,
  addTablet,
  moveTablet,
  endCode,
  removeCode,
}: {
  tenant: string;
  offline: boolean;
  stores: { id: string; name: string }[];
  tills: { id: string; name: string; code: string; store: string }[];
  codes: TabletCode[];
  addTablet: CodeAction;
  moveTablet: CodeAction;
  endCode: Action;
  removeCode: Action;
}) {
  const [added, add] = useActionState(addTablet, null);
  const [moved, move] = useActionState(moveTablet, null);
  const which = <input type="hidden" name="tenant" value={tenant} />;
  return (
    <section className="card flush">
      <div className="card-head">
        <div>
          <h2>Tablets by code</h2>
          <p>
            {offline
              ? "This client runs on its tablet: each tablet it bought is set up with a code, one code for one tablet. Its login sets up no tablet."
              : "A tablet can be set up with a code in place of the login: one code for one tablet."}
          </p>
        </div>
      </div>
      <form action={add} className="table-filters">
        {which}
        <select name="store" aria-label="Store" defaultValue={stores[0]?.id}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Submit>Code for a new tablet</Submit>
      </form>
      <Answer answer={added} codes={codes} />
      {tills.length > 0 && (
        <form action={move} className="table-filters">
          {which}
          <select name="device" aria-label="Till" defaultValue={tills[0]?.id}>
            {tills.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code}), {d.store}
              </option>
            ))}
          </select>
          <ConfirmSubmit
            className="btn-sm"
            title="Replace this till's tablet?"
            text="From this moment the tablet that is this till can no longer sync. A tablet that works on its own is not stopped by this: it keeps selling. The tablet set up with the new code becomes this till. Filled from the old tablet's backup, it has everything that backup holds; with no backup, a tablet that worked on its own starts again from nothing."
            yes="Make the code"
          >
            Code for a replacement tablet
          </ConfirmSubmit>
        </form>
      )}
      <Answer answer={moved} codes={codes} />
      <div className="adm-scroll">
        <table className="adm-nowrap">
          <thead>
            <tr>
              <th>Code</th>
              <th>For</th>
              <th>Made</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No codes yet.
                </td>
              </tr>
            )}
            {codes.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="strong">····-····-{c.hint}</span>
                </td>
                <td>
                  {c.till ? `${c.till} (${c.till_code})` : "A new tablet"}
                  <span className="sub">{c.store}</span>
                </td>
                <td>{when(c.made_at)}</td>
                <td>
                  {c.state === "used" ? (
                    <span className="badge green">In use since {when(c.used_at ?? c.made_at)}</span>
                  ) : c.state === "waiting" ? (
                    <span className="badge">Waiting for its tablet</span>
                  ) : (
                    <span className="muted">Over{c.ended_at ? `, ${when(c.ended_at)}` : ""}</span>
                  )}
                </td>
                <td>
                  {c.state !== "used" && (
                    <div className="row-actions">
                      {c.state === "waiting" && (
                        <form action={endCode}>
                          {which}
                          <input type="hidden" name="code" value={c.id} />
                          <Submit className="btn-sm">Take back</Submit>
                        </form>
                      )}
                      <form action={removeCode}>
                        {which}
                        <input type="hidden" name="code" value={c.id} />
                        <ConfirmSubmit
                          className="btn-quiet btn-sm"
                          title={`Remove the code ending ${c.hint}?`}
                          text={
                            c.state === "waiting"
                              ? "It is taken off the list for good, and sets up nothing from then on."
                              : "It is taken off the list for good. It is over already: nothing else changes."
                          }
                          yes="Remove"
                        >
                          Remove
                        </ConfirmSubmit>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
