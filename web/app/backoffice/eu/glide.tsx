"use client";

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

// After EasyUI's Animated Tabs (easyui.site, MIT, Suraj Maurya), in this app's
// own CSS (eu.css): a .seg switch whose chosen part has a pill under it that
// springs to the part chosen next. It works on what is inside it as it is:
// radio buttons in labels (a form sends them as before) or links, one marked
// .on or aria-current. The pill is drawn by this component, the parts are the
// page's own.

type Box = { x: number; y: number; w: number; h: number };

export function Glide({ as = "div", className, children, ...rest }: { as?: "div" | "span"; className?: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const [box, setBox] = useState<Box | null>(null);
  const [moved, setMoved] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>(":scope > label:has(input:checked), :scope > a.on, :scope > a[aria-current='page'], :scope > button[aria-pressed='true']");
    const next = on && on.offsetWidth > 0 ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight } : null;
    setBox((was) => (was && next && was.x === next.x && was.y === next.y && was.w === next.w && was.h === next.h ? was : next));
  }, []);

  useLayoutEffect(measure);
  // the pill is drawn: from here it, not the part's own colour, shows the choice
  useLayoutEffect(() => {
    if (ref.current) ref.current.dataset.live = "";
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // a choice moves the pill on a spring; the first draw puts it in place
    const change = () => {
      setMoved(true);
      measure();
    };
    el.addEventListener("change", change);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(change);
    mo.observe(el, { subtree: true, attributes: true, attributeFilter: ["class", "aria-current", "aria-pressed"] });
    return () => {
      el.removeEventListener("change", change);
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  return createElement(
    as,
    { ref, className: (className ?? "seg") + " eu-glide", ...rest },
    <motion.span
      key="pill"
      className="eu-glide-pill"
      aria-hidden
      initial={false}
      animate={box ? { x: box.x, y: box.y, width: box.w, height: box.h, opacity: 1 } : { opacity: 0 }}
      transition={moved && !reduce ? { type: "spring", stiffness: 480, damping: 36, mass: 0.8 } : { duration: 0 }}
    />,
    children,
  );
}
