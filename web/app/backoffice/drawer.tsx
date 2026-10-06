"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// A panel that slides in from the right, over the page it belongs to: a form
// that used to be a page of its own opens here, and the list stays where it
// was behind it. It is the browser's own dialog, so the page behind cannot be
// reached while it is open, Esc closes it and focus goes back to what opened
// it. A click on the dimmed page closes it too. `foot` is handed the way to
// close it, so a Cancel down there leaves the same way the X does.
export function Drawer({ open, title, subtitle, onClose, children, foot }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; foot?: (close: () => void) => React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // the dialog puts focus on its first button, the X; a form that starts
      // empty marks the field to start typing in
      d.querySelector<HTMLElement>("[data-focus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // it slides out before it goes
  const close = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      setLeaving(false);
      onClose();
    }, 180);
  };

  return (
    <dialog
      ref={ref}
      className={"drawer" + (leaving ? " leaving" : "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === ref.current && close()}
    >
      {open && (
        <div className="drawer-panel">
          <header className="drawer-head">
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button type="button" className="drawer-x" onClick={close} aria-label="Close">
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="drawer-body">{children}</div>
          {foot && <footer className="drawer-foot">{foot(close)}</footer>}
        </div>
      )}
    </dialog>
  );
}
