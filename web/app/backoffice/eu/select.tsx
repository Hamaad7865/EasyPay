"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Search } from "lucide-react";

// After EasyUI's Spring Select and Combobox (easyui.site, MIT, Suraj Maurya),
// in this app's own CSS (eu.css).
//
// Mounted once in the back office. Every drop-down on its pages stays the
// browser's own <select>, so a form still sends it, a page's own onChange
// still runs, and a keyboard or a phone still gets the browser's own list.
// A click of the mouse opens this list in its place: a card that springs
// from the field, the chosen line ticked, a pill that follows the pointer,
// and, for a long list, a box to type in that narrows it. Choosing sets the
// select and tells the page as the browser would (input, then change).
// A select marked data-native keeps the browser's list.

type Opt = { value: string; label: string; disabled: boolean; group: string | null; index: number };
type Open = { el: HTMLSelectElement; opts: Opt[]; rect: DOMRect; host: HTMLElement };

const LONG = 9; // from this many lines the list has a box to type in
const EASE = [0.23, 1, 0.32, 1] as const;

function read(el: HTMLSelectElement): Opt[] {
  return Array.from(el.options).map((o, index) => ({
    value: o.value,
    label: o.label || o.text,
    disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
    group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : null,
    index,
  }));
}

// the select's value set the way the browser sets it, so React and a plain form both see it
function choose(el: HTMLSelectElement, index: number) {
  if (el.selectedIndex === index) return;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")?.set;
  if (set) set.call(el, index);
  else el.selectedIndex = index;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function SelectPop() {
  const [open, setOpen] = useState<Open | null>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(-1);
  const reduce = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const mouse = useRef(false);
  // nothing is drawn until the page is up, so the server's page and the browser's first draw are the same
  const [up, setUp] = useState(false);
  useEffect(() => setUp(true), []);

  const close = useCallback((focus = true) => {
    setOpen((o) => {
      if (o && focus) o.el.focus({ preventScroll: true });
      return null;
    });
    setQ("");
  }, []);

  // a mouse press on a select opens this list instead of the browser's
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      mouse.current = e.pointerType === "mouse";
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof HTMLSelectElement ? e.target : null;
      if (!el || !mouse.current || e.button !== 0) return;
      if (el.multiple || el.size > 1 || el.disabled || el.dataset.native !== undefined || !el.closest(".bo, dialog")) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      setOpen((o) => {
        if (o?.el === el) return null;
        // inside an open dialog the list goes into it: anything outside is behind the dialog and cannot be reached
        const host = (el.closest("dialog[open]") as HTMLElement | null) ?? document.body;
        return { el, opts: read(el), rect: el.getBoundingClientRect(), host };
      });
      setQ("");
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, []);

  const long = (open?.opts.length ?? 0) >= LONG;
  const shown = useMemo(() => {
    if (!open) return [];
    const f = fold(q.trim());
    return f ? open.opts.filter((o) => fold(o.label).includes(f)) : open.opts;
  }, [open, q]);

  // the chosen line is the one under the keys when the list opens
  useEffect(() => {
    if (!open) return;
    const i = shown.findIndex((o) => o.index === open.el.selectedIndex);
    setAt(q ? shown.findIndex((o) => !o.disabled) : i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);

  // where it goes (fixed to the window, also inside a dialog, which is not moved once it is open): under the field, or over it when there is no room below; it follows the page as it scrolls
  const [pos, setPos] = useState<{ x: number; y: number; w: number; maxH: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const r = open.el.isConnected ? open.el.getBoundingClientRect() : open.rect;
      const vh = window.innerHeight, vw = window.innerWidth;
      const w = Math.max(r.width, 200);
      const below = vh - r.bottom - 12, above = r.top - 12;
      const up = below < 220 && above > below;
      const maxH = Math.min(340, Math.max(140, (up ? above : below) - 8));
      const x = Math.min(Math.max(8, r.left), vw - w - 8);
      // opening upwards it hangs from its foot, just over the field
      const y = up ? vh - r.top + 6 : r.bottom + 6;
      setPos({ x, y, w, maxH, up });
    };
    place();
    const onScroll = (e: Event) => {
      if (list.current?.contains(e.target as Node)) return;
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // a click anywhere else closes it; so does the field leaving the page
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (card.current?.contains(e.target as Node) || e.target === open.el) return;
      close(false);
    };
    const t = setInterval(() => !open.el.isConnected && close(false), 400);
    document.addEventListener("pointerdown", away, true);
    if (long) requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
    else requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
    return () => {
      clearInterval(t);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [open, long, close]);

  // the line under the keys is kept in view
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-at="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (o: Opt) => {
    if (!open || o.disabled) return;
    choose(open.el, o.index);
    close();
  };
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    let i = at;
    for (let n = 0; n < shown.length; n++) {
      i = (i + d + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    setAt(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), step(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), step(-1));
    else if (e.key === "Home") (e.preventDefault(), setAt(shown.findIndex((o) => !o.disabled)));
    else if (e.key === "End") (e.preventDefault(), setAt(shown.length - 1 - [...shown].reverse().findIndex((o) => !o.disabled)));
    else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[at]) pick(shown[at]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") close(false);
    else if (!long && e.key.length === 1 && /\S/.test(e.key)) {
      // a letter goes to the next line that starts with it, as the browser's list does
      const k = fold(e.key);
      const from = at + 1;
      const hit = [...shown.slice(from), ...shown.slice(0, from)].find((o) => !o.disabled && fold(o.label).startsWith(k));
      if (hit) setAt(shown.indexOf(hit));
    }
  };

  if (!up) return null;
  const id = "eu-sel-list";
  const chosen = open?.el.selectedIndex ?? -1;

  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          key="sel"
          ref={card}
          className={"eu-sel" + (pos.up ? " up" : "")}
          style={{ left: pos.x, ...(pos.up ? { bottom: pos.y } : { top: pos.y }), width: pos.w, transformOrigin: pos.up ? "bottom center" : "top center" }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: pos.up ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: pos.up ? 4 : -4, transition: { duration: 0.12 } }}
          transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.7 }}
          onKeyDown={onKey}
        >
          {long && (
            <label className="eu-sel-q">
              <Search aria-hidden />
              <input
                ref={box}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type to find"
                aria-label="Type to find"
                role="combobox"
                aria-expanded="true"
                aria-controls={id}
                aria-activedescendant={at >= 0 ? `${id}-${at}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <ul
            ref={list}
            id={id}
            role="listbox"
            tabIndex={long ? -1 : 0}
            aria-label={open.el.getAttribute("aria-label") ?? open.el.labels?.[0]?.textContent?.trim() ?? "Choices"}
            aria-activedescendant={!long && at >= 0 ? `${id}-${at}` : undefined}
            style={{ maxHeight: pos.maxH - (long ? 46 : 0) }}
            onPointerLeave={() => setAt(-1)}
          >
            {shown.length === 0 && <li className="eu-sel-none">Nothing matches “{q}”.</li>}
            {shown.map((o, i) => {
              const head = o.group !== null && (i === 0 || shown[i - 1].group !== o.group);
              return (
                <Line key={o.index} o={o} i={i} id={`${id}-${i}`} head={head} on={i === at} chosen={o.index === chosen} reduce={Boolean(reduce)} onPick={pick} onHover={setAt} />
              );
            })}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>,
    open?.host ?? document.body,
  );
}

function Line({ o, i, id, head, on, chosen, reduce, onPick, onHover }: { o: Opt; i: number; id: string; head: boolean; on: boolean; chosen: boolean; reduce: boolean; onPick: (o: Opt) => void; onHover: (i: number) => void }) {
  return (
    <>
      {head && (
        <li className="eu-sel-group" role="presentation">
          {o.group}
        </li>
      )}
      <motion.li
        id={id}
        data-at={i}
        role="option"
        aria-selected={chosen}
        aria-disabled={o.disabled || undefined}
        className={"eu-sel-line" + (chosen ? " chosen" : "")}
        onPointerMove={() => !o.disabled && onHover(i)}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => onPick(o)}
        initial={reduce ? false : { opacity: 0, x: -4 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18, ease: EASE, delay: reduce ? 0 : Math.min(i, 10) * 0.012 }}
      >
        {on && <motion.span layoutId="eu-sel-hover" className="eu-sel-hover" transition={{ type: "spring", stiffness: 600, damping: 40 }} />}
        <span className="eu-sel-text">{o.label || " "}</span>
        {chosen && <Check className="eu-sel-tick" aria-hidden />}
      </motion.li>
    </>
  );
}
