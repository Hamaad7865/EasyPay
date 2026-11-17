"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

// After EasyUI's Date Picker, Calendar and StretchSwitch (easyui.site, MIT,
// Suraj Maurya), in this app's own CSS (eu.css).
//
// The days a page reports on. The key says the days picked; pressed, a card
// springs out of it (above it when there is no room below) with the quick
// choices down its side and a month to pick from: the first day pressed starts
// the range, a band follows the pointer to show where it would end, the
// second press ends it. The months slide the way they are turned. Apply, or a
// quick choice, takes the page to those days: the address carries them, as it
// did before, so a link to the page still opens on the same days.

const parse = (s: string) => new Date(s + "T00:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const long = (s: string) => parse(s).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).replace(",", "");
const title = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const slide = {
  enter: (d: number) => ({ x: d * 24, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (d: number) => ({ x: d * -24, opacity: 0 }),
};

export type Preset = { label: string; from: string; to: string };

// `path` is the page's address and `keep` the rest of its address to carry
// along ("compare=1"), so the server hands over words and not a function.
export function RangePicker({ from, to, presets, today, path, keep = "" }: { from: string; to: string; presets: Preset[]; today: string; path: string; keep?: string }) {
  const hrefFor = (f: string, t: string) => `${path}?from=${f}&to=${t}${keep ? "&" + keep : ""}`;
  const router = useRouter();
  const reduce = useReducedMotion();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  const [a, setA] = useState<string | null>(from);
  const [b, setB] = useState<string | null>(to);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(() => ({ y: parse(to).getUTCFullYear(), m: parse(to).getUTCMonth() }));
  const [dir, setDir] = useState(1);
  const [up, setUp] = useState(false);
  const key = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  // opened afresh on the days the page shows
  const show = () => {
    setA(from);
    setB(to);
    setHover(null);
    setMonth({ y: parse(to).getUTCFullYear(), m: parse(to).getUTCMonth() });
    setOpen(true);
  };
  // the card goes above the key when there is no room under it
  useLayoutEffect(() => {
    if (!open || !key.current) return;
    const r = key.current.getBoundingClientRect();
    setUp(window.innerHeight - r.bottom < 440 && r.top > window.innerHeight - r.bottom);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node) && !key.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        key.current?.focus();
      }
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const go = (f: string, t: string) => {
    setOpen(false);
    start(() => router.push(hrefFor(f, t)));
  };
  const turn = (by: number) => {
    setDir(by);
    setMonth(({ y, m }) => {
      const d = new Date(Date.UTC(y, m + by, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });
  };
  const pick = (d: string) => {
    if (!a || b) {
      setA(d);
      setB(null);
    } else if (d < a) {
      setB(a);
      setA(d);
    } else setB(d);
  };

  // the month's days, Monday first, with the days of the months either side to fill the weeks
  const days = useMemo(() => {
    const first = new Date(Date.UTC(month.y, month.m, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(Date.UTC(month.y, month.m, 1 - lead + i));
      return { day: iso(d), n: d.getUTCDate(), out: d.getUTCMonth() !== month.m };
    });
  }, [month]);
  // the end shown: the one picked, or where the pointer is while the second is still to pick
  const end = b ?? (a && hover && hover >= a ? hover : null);
  const lo = a, hi = end ?? a;
  const over = (d: string) => Boolean(lo && hi && d >= lo && d <= hi);
  const span = a && b ? Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000) + 1 : null;
  const tooLong = span != null && span > 366;
  const chosen = presets.find((p) => p.from === from && p.to === to)?.label;

  return (
    <div className="eu-range">
      <button ref={key} type="button" className="eu-range-key" aria-haspopup="dialog" aria-expanded={open} aria-busy={busy || undefined} onClick={() => (open ? setOpen(false) : show())}>
        <CalendarDays aria-hidden="true" />
        <span>
          {chosen && <small>{chosen}</small>}
          {long(from)} - {long(to)}
        </span>
        <ChevronDown aria-hidden="true" className="eu-chev" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={card}
            role="dialog"
            aria-label="Pick the days"
            className={"eu-range-card" + (up ? " up" : "")}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: up ? 8 : -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: up ? 6 : -6 }}
            transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.6 }}
            style={{ transformOrigin: up ? "bottom left" : "top left" }}
          >
            <div className="eu-presets">
              {presets.map((p) => (
                <button key={p.label} type="button" className={p.from === from && p.to === to ? "on" : undefined} onClick={() => go(p.from, p.to)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="eu-cal">
              <div className="eu-cal-head">
                <button type="button" aria-label="The month before" onClick={() => turn(-1)}><ChevronLeft aria-hidden="true" /></button>
                <div className="eu-cal-title" aria-live="polite">
                  <AnimatePresence initial={false} custom={dir} mode="popLayout">
                    <motion.span key={`${month.y}-${month.m}`} custom={dir} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.2 }}>
                      {title(month.y, month.m)}
                    </motion.span>
                  </AnimatePresence>
                </div>
                <button type="button" aria-label="The month after" onClick={() => turn(1)}><ChevronRight aria-hidden="true" /></button>
              </div>
              <div className="eu-cal-week" aria-hidden>{WEEK.map((w) => <span key={w}>{w}</span>)}</div>
              <div className="eu-cal-clip">
                <AnimatePresence initial={false} custom={dir} mode="popLayout">
                  <motion.div key={`${month.y}-${month.m}`} className="eu-cal-grid" role="grid" custom={dir} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} onPointerLeave={() => setHover(null)}>
                    {days.map((d) => {
                      const isA = d.day === lo, isB = d.day === hi;
                      const ends = isA || isB;
                      return (
                        <button
                          key={d.day}
                          type="button"
                          role="gridcell"
                          aria-selected={ends}
                          aria-label={long(d.day)}
                          className={"eu-day" + (d.out ? " out" : "") + (over(d.day) ? " in" : "") + (isA ? " first" : "") + (isB ? " last" : "") + (d.day === today ? " today" : "")}
                          onPointerEnter={() => setHover(d.day)}
                          onClick={() => pick(d.day)}
                        >
                          {ends && <motion.span layoutId={`${uid}-${isA ? "a" : "b"}`} className="eu-day-pill" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                          <span className="eu-day-n">{d.n}</span>
                        </button>
                      );
                    })}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="eu-cal-foot">
                <span>{a && b ? (tooLong ? "A year at most" : `${long(a)} - ${long(b)} · ${span} ${span === 1 ? "day" : "days"}`) : a ? "Now the last day" : "Pick the first day"}</span>
                <button type="button" className="eu-btn" disabled={!a || !b || tooLong} onClick={() => a && b && go(a, b)}>Apply</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// After EasyUI's StretchSwitch: the knob stretches while it is pressed and
// snaps across on a spring. It is a link's switch here: it takes the page to
// the same days with the comparison on or off.
export function Stretch({ on, label, href }: { on: boolean; label: string; href: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [now, setNow] = useState(on);
  const [press, setPress] = useState(false);
  useEffect(() => setNow(on), [on]);
  const x = useMotionValue(on ? 16 : 0);
  useEffect(() => {
    const c = animate(x, now ? 16 : 0, { type: "spring", stiffness: 380, damping: 30, mass: 0.5 });
    return () => c.stop();
  }, [now, x]);
  const sx = useTransform(x, () => (press ? 1.2 : 1));
  const sy = useTransform(x, () => (press ? 0.86 : 1));
  return (
    <button
      type="button"
      role="switch"
      aria-checked={now}
      aria-busy={busy || undefined}
      className="eu-switch-row"
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      onPointerCancel={() => setPress(false)}
      onClick={() => {
        setNow(!now);
        start(() => router.push(href));
      }}
    >
      {label}
      <span className={"eu-switch" + (now ? " on" : "")}>
        <motion.i style={{ x, scaleX: sx, scaleY: sy }} />
      </span>
    </button>
  );
}
