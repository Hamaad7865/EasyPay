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

  // on a phone the panel is a sheet from the foot: pulled down by its head, it follows the finger, and past a third of
  // the way (or flicked) it goes; let go sooner and it springs back
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (!window.matchMedia("(max-width: 640px)").matches || (e.target as HTMLElement).closest("button")) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    ref.current?.classList.add("dragging");
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current, el = ref.current;
    if (!d || !el) return;
    d.dy = Math.max(0, e.clientY - d.y);
    el.style.transform = `translateY(${d.dy}px)`;
  };
  const onUp = () => {
    const d = drag.current, el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    el.classList.remove("dragging");
    const fast = d.dy / Math.max(1, performance.now() - d.t) > 0.6;
    if (d.dy > el.offsetHeight / 3 || (fast && d.dy > 40)) {
      // it leaves from where the finger let it go, then is put back for the next time it opens
      el.style.transition = "transform 0.18s cubic-bezier(0.4, 0, 1, 1)";
      el.style.transform = "translateY(100%)";
      close();
      setTimeout(() => {
        el.style.transition = "";
        el.style.transform = "";
      }, 260);
    } else {
      el.style.transition = "transform 0.32s cubic-bezier(0.34, 1.4, 0.64, 1)";
      el.style.transform = "";
      setTimeout(() => el && (el.style.transition = ""), 340);
    }
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
          <header className="drawer-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
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
