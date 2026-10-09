"use client";

import { useId, useRef } from "react";
import { Banknote, Power } from "lucide-react";
import { Submit } from "../busy";

type Ask = (f: FormData) => Promise<void>;

// A key that asks something of a till, in a small panel of its own: the
// browser's dialog, as the confirmation panels are, so the page behind cannot
// be reached while it is open and Esc closes it. The form is inside the
// panel, so the key can sit on a till's card without being part of its link.
function Panel({
  action, till, back, title, text, yes, children, trigger,
}: {
  action: Ask; till: string; back: string; title: string; text: string; yes: string; children: React.ReactNode;
  trigger: (open: () => void) => React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = () => dialog.current?.close();
  return (
    <>
      {trigger(() => dialog.current?.showModal())}
      <dialog ref={dialog} className="confirm ask" aria-labelledby={id + "t"} aria-describedby={id + "d"} onClick={(e) => e.target === dialog.current && close()}>
        <form action={action} className="confirm-in" onSubmit={close}>
          <input type="hidden" name="till" value={till} />
          <input type="hidden" name="back" value={back} />
          <h2 id={id + "t"}>{title}</h2>
          <p id={id + "d"}>{text}</p>
          {children}
          <div className="confirm-foot">
            <button type="button" className="btn-quiet" onClick={close}>
              Cancel
            </button>
            <Submit>{yes}</Submit>
          </div>
        </form>
      </dialog>
    </>
  );
}

// Close a till's day from here. The till closes it itself, the next time it
// syncs: with what was counted, or at what it expects when nothing is typed.
export function CloseDayKey({ action, till, name, expected, back, round }: { action: Ask; till: string; name: string; expected: string | null; back: string; round?: boolean }) {
  return (
    <Panel
      action={action}
      till={till}
      back={back}
      title={`Close the day on ${name}?`}
      text="The till closes its own day the next time it syncs, with its own figures, and prints its closing report. It refuses if an order is still unpaid, or if it was used after you asked."
      yes="Ask the till to close"
      trigger={(open) =>
        round ? (
          <button type="button" className="till-key" title="Close this till's day" aria-label={`Close the day on ${name}`} aria-haspopup="dialog" onClick={open}>
            <Power strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="btn-danger" aria-haspopup="dialog" onClick={open}>
            <Power aria-hidden="true" /> Close the day
          </button>
        )
      }
    >
      <label className="field">
        Counted cash
        <input name="counted" inputMode="decimal" autoComplete="off" placeholder={expected ? `${expected} expected, as of its last sync` : "What was counted in the drawer"} />
      </label>
      <p className="help">Leave it empty to close at what the till expects. The record then says the day was closed without a count.</p>
    </Panel>
  );
}

// Cash taken out of a till's drawer, written down from here.
export function CashOutKey({ action, till, name, back }: { action: Ask; till: string; name: string; back: string }) {
  return (
    <Panel
      action={action}
      till={till}
      back={back}
      title={`Take cash out of ${name}`}
      text="For cash taken from the drawer for a small purchase. The till records it in its open day the next time it syncs. No slip prints and the drawer does not open."
      yes="Ask the till to record it"
      trigger={(open) => (
        <button type="button" className="btn-quiet" aria-haspopup="dialog" onClick={open}>
          <Banknote aria-hidden="true" /> Take cash out
        </button>
      )}
    >
      <label className="field">
        Amount
        <input name="amount" inputMode="decimal" autoComplete="off" required placeholder="190.00" />
      </label>
      <label className="field">
        What for
        <input name="reason" maxLength={120} required placeholder="Ice, milk, a delivery" />
      </label>
    </Panel>
  );
}
