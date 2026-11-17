"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "framer-motion";
import { X, type LucideIcon } from "lucide-react";

// After EasyUI's Product Tour (easyui.site, MIT, Suraj Maurya), in this app's
// own CSS (eu.css): the page dims, a lit hole springs from one part of the
// page to the next with a card beside it saying what that part is for; the
// card docks to the foot of a phone's screen. Next and Back (or the arrow
// keys) move along, Esc or Skip stop. A step whose part is not on the screen
// is shown in the middle with nothing lit.

export type TourStep = {
  // what to light: a CSS selector; none for a word in the middle of the page
  target?: string;
  title: string;
  body: ReactNode;
  placement?: "auto" | "top" | "bottom" | "left" | "right";
  padding?: number;
  // the part of the back office the step is about, said after the count ("4 of 11 · Search")
  section?: string;
  // the small picture on top of the card: the part's mark in a tile, and up to three small cards beside it
  art?: { icon: LucideIcon; bits?: LucideIcon[] };
};

// the picture band on top of the card: the step's mark and three sketched cards, sliding in with the step
function Art({ art, step }: { art: NonNullable<TourStep["art"]>; step: number }) {
  const Icon = art.icon;
  return (
    <div className="eu-tour-art" aria-hidden>
      <motion.span key={"t" + step} className="eu-tour-tile" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 26 }}>
        <Icon />
      </motion.span>
      {(art.bits ?? []).slice(0, 3).map((B, i) => (
        <motion.span
          key={step + "-" + i}
          className="eu-tour-bit"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 28, delay: 0.05 + i * 0.05 }}
        >
          <B />
          <i />
          <i />
        </motion.span>
      ))}
    </div>
  );
}
export type TourEnd = "done" | "skip" | "dismiss";

type Rect = { x: number; y: number; w: number; h: number; r: number };

const CARD_W = 340;
const SMALL = 640; // under this width the card docks to the foot of the screen
const cardWidth = (vw: number) => (vw < SMALL ? Math.min(440, vw - 24) : CARD_W);
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const SPOT = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 } as const;
const CARD = { type: "spring", stiffness: 320, damping: 34, mass: 0.9 } as const;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// the part to light, only when it is drawn and has a size (a part of a menu that is folded away has none)
function resolve(t?: string): HTMLElement | null {
  if (!t) return null;
  const all = Array.from(document.querySelectorAll<HTMLElement>(t));
  return all.find((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }) ?? null;
}

function rectOf(el: HTMLElement, s: TourStep): Rect {
  const b = el.getBoundingClientRect();
  const p = s.padding ?? 8;
  const w = b.width + p * 2;
  const h = b.height + p * 2;
  const cs = getComputedStyle(el).borderTopLeftRadius;
  let br = parseFloat(cs) || 0;
  if (cs.includes("%")) br = (br / 100) * Math.min(b.width, b.height);
  const r = Math.min(Math.max(br + p, 8), Math.min(w, h) / 2);
  return { x: b.left - p, y: b.top - p, w, h, r };
}

// find the part (it may come a moment late), bring it into view, and wait for the page to stop moving
async function prepare(s: TourStep, instant: boolean, bottomInset = 0) {
  if (!s.target) return null;
  let el = resolve(s.target);
  for (let i = 0; !el && i < 24; i++) {
    await frame();
    el = resolve(s.target);
  }
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const M = 24;
  const visible = b.top >= M && b.bottom <= window.innerHeight - M - bottomInset && b.left >= 0 && b.right <= window.innerWidth;
  if (!visible) {
    const prevMargin = el.style.scrollMarginBottom;
    if (bottomInset) el.style.scrollMarginBottom = `${bottomInset}px`;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: instant ? "auto" : "smooth" });
    let last = el.getBoundingClientRect().top;
    let still = 0;
    const t0 = performance.now();
    while (still < 6 && performance.now() - t0 < 1000) {
      await frame();
      const top = el.getBoundingClientRect().top;
      still = Math.abs(top - last) < 0.5 ? still + 1 : 0;
      last = top;
    }
    el.style.scrollMarginBottom = prevMargin;
  }
  return el;
}

// the side of the part with room for the card (the one asked for first), kept on the screen
function place(r: Rect | null, cw: number, ch: number, vw: number, vh: number, pref: TourStep["placement"] = "auto", dock?: number) {
  const M = 16;
  const G = 14;
  if (!r) return { x: (vw - cw) / 2, y: (vh - ch) / 2 };
  if (dock !== undefined) return { x: (vw - cw) / 2, y: Math.max(12, vh - ch - dock) };
  const room = { bottom: vh - (r.y + r.h) - M - ch - G, top: r.y - M - ch - G, right: vw - (r.x + r.w) - M - cw - G, left: r.x - M - cw - G };
  const all = ["bottom", "top", "right", "left"] as const;
  const order = pref === "auto" ? all : [pref, ...all.filter((s) => s !== pref)];
  const side = order.find((s) => room[s] >= 0) ?? all.reduce((a, b) => (room[a] > room[b] ? a : b));
  let x = r.x + r.w / 2 - cw / 2;
  let y = r.y + r.h / 2 - ch / 2;
  if (side === "bottom") y = r.y + r.h + G;
  if (side === "top") y = r.y - G - ch;
  if (side === "right") x = r.x + r.w + G;
  if (side === "left") x = r.x - G - cw;
  return { x: clamp(x, M, Math.max(M, vw - cw - M)), y: clamp(y, M, Math.max(M, vh - ch - M)) };
}

const slide = {
  enter: (d: number) => ({ opacity: 0, x: d * 20, filter: "blur(3px)" }),
  center: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (d: number) => ({ opacity: 0, x: d * -20, filter: "blur(3px)" }),
};

export function ProductTour({ steps, open, onClose }: { steps: TourStep[]; open: boolean; onClose: (why: TourEnd) => void }) {
  const uid = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setIndex(0);
    else setReady(false);
  }

  const sx = useMotionValue(0), sy = useMotionValue(0), sw = useMotionValue(0), sh = useMotionValue(0), sr = useMotionValue(0);
  const cx = useMotionValue(0), cy = useMotionValue(0), regionH = useMotionValue(0);
  // an SVG rectangle refuses a width, height or corner below nought
  const safeW = useTransform(sw, (v) => Math.max(0, v));
  const safeH = useTransform(sh, (v) => Math.max(0, v));
  const safeR = useTransform(sr, (v) => Math.max(0, v));

  const rectRef = useRef<Rect | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const cardHRef = useRef(0);
  const firstRef = useRef(true);
  const preparingRef = useRef(false);
  const movingRef = useRef(false);
  const dirRef = useRef(1);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roRef = useRef<ResizeObserver | null>(null);
  const prevFocus = useRef<Element | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const contentEl = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const safeRef = useRef<HTMLDivElement>(null);

  const step = steps[Math.min(index, steps.length - 1)];
  const stepRef = useRef(step);
  stepRef.current = step;

  const move = (mv: MotionValue<number>, to: number, mode: "spring" | "instant", spring: typeof SPOT | typeof CARD = SPOT) => {
    if (mode === "instant" || reduce) {
      mv.stop();
      mv.set(to);
    } else animate(mv, to, spring);
  };
  const layoutCut = (mode: "spring" | "instant", intro = false) => {
    const r = rectRef.current;
    const c = r ?? { x: window.innerWidth / 2, y: window.innerHeight / 2, w: 0, h: 0, r: 0 };
    if (intro && !reduce && r) {
      // the hole starts wide and closes in on its part
      sx.set(c.x - 48);
      sy.set(c.y - 48);
      sw.set(Math.max(0, c.w + 96));
      sh.set(Math.max(0, c.h + 96));
      sr.set(Math.max(0, c.r + 16));
    }
    move(sx, c.x, mode);
    move(sy, c.y, mode);
    move(sw, Math.max(0, c.w), mode);
    move(sh, Math.max(0, c.h), mode);
    move(sr, Math.max(0, c.r), mode);
  };
  const layoutCard = (mode: "spring" | "instant") => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const safe = parseFloat(getComputedStyle(safeRef.current ?? document.body).paddingBottom) || 0;
    const dock = vw < SMALL ? 12 + safe : undefined;
    const p = place(rectRef.current, cardWidth(vw), cardHRef.current, vw, vh, stepRef.current.placement, dock);
    move(cx, p.x, mode, CARD);
    move(cy, p.y, mode, CARD);
  };
  const go = (i: number) => {
    if (i < 0) return;
    if (i >= steps.length) return onClose("done");
    dirRef.current = i > index ? 1 : -1;
    setIndex(i);
  };

  useEffect(() => setMounted(true), []);

  // a new step: find its part, bring it into view, measure it, spring the hole over
  useEffect(() => {
    if (!open || !mounted) return;
    let cancelled = false;
    preparingRef.current = true;
    (async () => {
      const s = steps[index];
      const compact = window.innerWidth < SMALL;
      if (compact) await frame();
      if (cancelled) return;
      const safe = parseFloat(getComputedStyle(safeRef.current ?? document.body).paddingBottom) || 0;
      const inset = compact ? Math.max(cardHRef.current, 200) + 24 + safe : 0;
      const el = await prepare(s, Boolean(reduce), inset);
      if (cancelled) return;
      elRef.current = el;
      rectRef.current = el ? rectOf(el, s) : null;
      roRef.current?.disconnect();
      if (el) roRef.current?.observe(el);
      preparingRef.current = false;
      movingRef.current = true;
      clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(() => (movingRef.current = false), 700);
      const intro = firstRef.current;
      firstRef.current = false;
      layoutCut("spring", intro);
      layoutCard(intro ? "instant" : "spring");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, mounted]);

  // the card's words are measured, so the card grows or shrinks to them and is placed where it fits
  useEffect(() => {
    if (!open || !mounted) return;
    const el = contentEl.current;
    if (!el) return;
    const report = () => {
      const card = cardRef.current, region = regionRef.current;
      if (!card || !region) return;
      const vh = window.innerHeight;
      const cap = window.innerWidth < SMALL ? vh * 0.4 : vh - 160;
      const contentH = Math.min(el.offsetHeight, Math.max(96, cap));
      const chrome = card.offsetHeight - region.offsetHeight;
      const first = cardHRef.current === 0;
      cardHRef.current = contentH + chrome;
      move(regionH, contentH, first ? "instant" : "spring", CARD);
      if (!preparingRef.current) layoutCard(first ? "instant" : "spring");
      setReady(true);
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, mounted]);

  // the hole stays on its part as the page scrolls or the window changes
  useEffect(() => {
    if (!open || !mounted) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (preparingRef.current) return;
        const s = stepRef.current;
        const el = elRef.current?.isConnected ? elRef.current : resolve(s.target);
        if (el) {
          elRef.current = el;
          rectRef.current = rectOf(el, s);
        }
        const mode = movingRef.current ? "spring" : "instant";
        layoutCut(mode);
        layoutCard(mode);
      });
    };
    roRef.current = new ResizeObserver(update);
    if (elRef.current) roRef.current.observe(elRef.current);
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", update);
      roRef.current?.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  // the page does not scroll under the tour (the tour still brings parts into view)
  useEffect(() => {
    if (!open) {
      firstRef.current = true;
      cardHRef.current = 0;
      rectRef.current = null;
      elRef.current = null;
      return;
    }
    const stop = (e: Event) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
    };
    window.addEventListener("wheel", stop, { passive: false });
    window.addEventListener("touchmove", stop, { passive: false });
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose("dismiss");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index]);

  // the cursor goes into the card, and back where it was once the tour ends
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    return () => (prevFocus.current as HTMLElement | null)?.focus?.({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (open && ready) nextRef.current?.focus({ preventScroll: true });
  }, [open, ready]);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const f = cardRef.current?.querySelectorAll<HTMLElement>("button");
    if (!f?.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!mounted || steps.length === 0) return null;
  const isLast = index === steps.length - 1;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="tour" className="eu-tour" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: EASE_OUT }}>
          <svg className="eu-tour-dim" aria-hidden>
            <defs>
              <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
                <rect width="100%" height="100%" fill="white" />
                <motion.rect x={sx} y={sy} width={safeW} height={safeH} rx={safeR} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" className="eu-tour-shade" mask={`url(#${uid}-mask)`} />
            <motion.rect x={sx} y={sy} width={safeW} height={safeH} rx={safeR} className="eu-tour-ring" />
          </svg>
          {/* reads the phone's safe area, so the docked card clears the home bar */}
          <div ref={safeRef} aria-hidden className="eu-tour-safe" />
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-label="A tour of the back office"
            onKeyDown={trapTab}
            className="eu-tour-card"
            style={{ x: cx, y: cy }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: ready ? 1 : 0, scale: ready ? 1 : 0.96 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <button type="button" className="eu-tour-x" aria-label="Close the tour" onClick={() => onClose("skip")}>
              <X aria-hidden />
            </button>
            {step.art && <Art art={step.art} step={index} />}
            <motion.div ref={regionRef} className="eu-tour-region" style={{ height: regionH }} aria-live="polite">
              <AnimatePresence mode="popLayout" initial={false} custom={dirRef.current}>
                <motion.div
                  key={index}
                  ref={(el) => {
                    if (el) contentEl.current = el;
                  }}
                  custom={dirRef.current}
                  variants={slide}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.2, ease: EASE_OUT }}
                  className="eu-tour-words"
                >
                  <p className="eu-tour-count">
                    {index + 1} of {steps.length}
                    {step.section ? ` · ${step.section}` : ""}
                  </p>
                  <h2>{step.title}</h2>
                  <div>{step.body}</div>
                </motion.div>
              </AnimatePresence>
            </motion.div>
            <div className="eu-tour-foot">
              <div className="eu-tour-dots">
                {steps.map((_, i) => (
                  <button key={i} type="button" aria-label={`Go to step ${i + 1}`} aria-current={i === index} onClick={() => go(i)}>
                    <span className={i === index ? "on" : undefined} />
                  </button>
                ))}
              </div>
              <div className="eu-tour-keys">
                {index > 0 && <button type="button" className="eu-tour-back" onClick={() => go(index - 1)}>Back</button>}
                <button ref={nextRef} type="button" className="eu-tour-next" onClick={() => go(index + 1)}>{isLast ? "Done" : "Next"}</button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
