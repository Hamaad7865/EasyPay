"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// After EasyUI's OriginDropdown and Notification Bell panel (easyui.site, MIT,
// Suraj Maurya): a card that springs out of the key that opened it, from that
// key's corner, its lines arriving one after the other. A press outside it or
// Esc puts it away (the cursor goes back to the key); arrow keys move along
// its lines.

export function Pop({ trigger, label, children, align = "right", wide, className }: {
  // the key: handed whether the card is out and what opens it
  trigger: (open: boolean, toggle: () => void, ref: React.RefObject<HTMLButtonElement | null>) => ReactNode;
  label: string;
  // the card: handed what puts it away
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  wide?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const key = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = (back = false) => {
    setOpen(false);
    if (back) key.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(card.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []);
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", keys);
    };
  }, [open]);
  return (
    <div ref={box} className={"eu-pop " + (className ?? "")}>
      {trigger(open, () => setOpen((o) => !o), key)}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={card}
            role="dialog"
            aria-label={label}
            className={"eu-pop-card " + align + (wide ? " wide" : "")}
            style={{ transformOrigin: align === "right" ? "top right" : "top left" }}
            variants={{
              hidden: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -6, transition: { duration: 0.12 } },
              show: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 30, mass: 0.6, staggerChildren: 0.03, delayChildren: 0.04 } },
            }}
            initial="hidden"
            animate="show"
            exit="hidden"
          >
            {children(() => close())}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// a line of a card that arrives in its turn
export const Line = ({ children, className }: { children: ReactNode; className?: string }) => (
  <motion.div className={className} variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 32 } } }}>
    {children}
  </motion.div>
);
