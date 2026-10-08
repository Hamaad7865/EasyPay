"use client";

import { useId, useRef } from "react";
import { useFormStatus } from "react-dom";
import { TriangleAlert } from "lucide-react";

// A form's button for something that should not happen on one slip of the
// finger (suspending a client, deactivating a till). It does not send the
// form: it asks first, in a small panel that says what will happen, and the
// form goes only from the panel's own button. The panel is the browser's own
// dialog, so the page behind cannot be reached while it is open, Esc and a
// click on the dimmed page close it, and focus starts on Cancel. A form with
// a required field still empty says so before anything is asked. Once sent,
// the panel is gone and the button turns until the answer is back.
export function ConfirmSubmit({ title, text, yes, className, children }: { title: string; text: string; yes: string; className?: string; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  const id = useId();
  const close = () => dialog.current?.close();
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        disabled={pending}
        aria-busy={pending || undefined}
        aria-haspopup="dialog"
        onClick={() => button.current?.form?.reportValidity() && dialog.current?.showModal()}
      >
        {children}
      </button>
      <dialog ref={dialog} className="confirm" aria-labelledby={id + "t"} aria-describedby={id + "d"} onClick={(e) => e.target === dialog.current && close()}>
        <div className="confirm-in">
          <span className="ico red" aria-hidden="true">
            <TriangleAlert strokeWidth={1.9} />
          </span>
          <h2 id={id + "t"}>{title}</h2>
          <p id={id + "d"}>{text}</p>
          <div className="confirm-foot">
            <button type="button" className="btn-quiet" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                close();
                button.current?.form?.requestSubmit();
              }}
            >
              {yes}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
