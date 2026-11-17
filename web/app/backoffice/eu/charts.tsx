"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { fmtRs } from "@/lib/money";

// The back office's charts, after EasyUI's (easyui.site, MIT, Suraj Maurya):
// its Interactive Area Chart, Bar Chart and Donut Chart, drawn by hand in SVG
// and moved with framer-motion. Ported, not installed: EasyUI is written in
// Tailwind, which this app does not use, so the classes became the `eu-` rules
// in eu.css and every colour one of the app's tokens (light and dark alike).
//
// What each one is fed is what the dashboard already worked out; nothing here
// asks the server for anything.

// How a figure is written. The dashboard draws on the server, which cannot
// hand a function to the browser, so a chart is told the kind of figure and
// writes it itself: rupees (from cents, as everywhere in the app) or a count.
export type Unit = "rs" | "n";
const count = (v: number) => Math.round(v).toLocaleString("en-US");
export const fmtOf = (u: Unit) => (v: number) => (u === "rs" ? fmtRs(Math.round(v)) : count(v));
// the figures up the side: whole rupees
const tickOf = (u: Unit) => (v: number) => (u === "rs" ? fmtRs(Math.round(v / 100) * 100) : count(v));

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const SPRING = { type: "spring", duration: 0.5, bounce: 0 } as const;
export const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
// a series' colour: the chart tokens in eu.css, in turn
export const tone = (i: number) => `var(--chart-${(i % 6) + 1})`;

// a step that makes four even lines up the side cover the largest value
function niceStep(raw: number) {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

// the width the chart is given, followed as the window changes
function useWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth) || initial);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width] as const;
}

// a finger that lifts anywhere else puts the reading away
function useDismissOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [ref, open, close]);
}

// The reading that follows the pointer: it glides from point to point on a
// spring, stays inside the chart, and turns below its point near the top.
function Tip({ pos, boundsWidth, children }: { pos: { x: number; y: number } | null; boundsWidth: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(false);
  const x = useSpring(0, { stiffness: 520, damping: 42, mass: 0.6 });
  const y = useSpring(0, { stiffness: 520, damping: 42, mass: 0.6 });
  useLayoutEffect(() => {
    if (!pos) {
      seen.current = false;
      return;
    }
    const w = ref.current?.offsetWidth ?? 130;
    const h = ref.current?.offsetHeight ?? 60;
    let tx = clamp(pos.x - w / 2, 0, Math.max(0, boundsWidth - w));
    let ty = pos.y - h - 12;
    const host = ref.current?.offsetParent as HTMLElement | null;
    const box = host?.getBoundingClientRect();
    if (box) {
      const pad = 8;
      tx = clamp(tx, pad - box.left, Math.max(pad - box.left, window.innerWidth - pad - w - box.left));
      const anchorY = box.top + pos.y;
      if (anchorY - pad < h + 12 && window.innerHeight - pad - anchorY > anchorY - pad) ty = pos.y + 18;
    } else if (ty < 0) ty = pos.y + 18;
    if (!seen.current) {
      x.jump(tx);
      y.jump(ty);
      seen.current = true;
    } else {
      x.set(tx);
      y.set(ty);
    }
  }, [pos, boundsWidth, x, y]);
  return (
    <motion.div ref={ref} aria-hidden className="eu-tip" style={{ x, y }} initial={false} animate={{ opacity: pos ? 1 : 0 }} transition={{ duration: 0.14, ease: EASE_OUT }}>
      {children}
    </motion.div>
  );
}

const Dot = ({ color, dashed }: { color: string; dashed?: boolean }) => <i className={"eu-dot" + (dashed ? " dashed" : "")} style={{ background: dashed ? undefined : color, borderColor: color }} aria-hidden />;

// A count that runs up to its value: the figure in a donut's middle.
function Counting({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const fmt = useRef(format);
  fmt.current = format;
  const text = useTransform(mv, (v) => fmt.current(Math.round(v)));
  useEffect(() => {
    const c = animate(mv, value, { duration: reduce ? 0 : 0.8, ease: EASE_OUT });
    return () => c.stop();
  }, [value, mv, reduce]);
  return <motion.span>{text}</motion.span>;
}

/* ---------------------------------- Area ----------------------------------- */

export type AreaPoint = { key: string; label: string; long: string; value: number };

// A curve through the points that never dips below the lower of two
// neighbours: a quiet day stays at its own height instead of sagging under
// the floor the way a plain spline would.
function curve(p: { x: number; y: number }[]) {
  const n = p.length;
  const at = (q: { x: number; y: number }) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  if (n < 3) return p.map((q, i) => (i === 0 ? "M" : "L") + at(q)).join(" ");
  const dx: number[] = [], m: number[] = [], t: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1].x - p[i].x);
    m.push((p[i + 1].y - p[i].y) / dx[i]);
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i]);
  let d = "M" + at(p[0]);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${at({ x: p[i].x + h, y: p[i].y + t[i] * h })} ${at({ x: p[i + 1].x - h, y: p[i + 1].y - t[i + 1] * h })} ${at(p[i + 1])}`;
  }
  return d;
}

// After EasyUI's Interactive Area Chart: a soft filled curve that draws itself
// in, a crosshair and a reading that glide with the pointer (arrow keys too),
// and the period before as a dashed line when it is compared. `upto` is how
// many of the points have happened: the line stops at today instead of running
// along the floor through days still to come.
export function AreaChart({
  points, before, upto, unit, height = 300, label, beforeLabel,
}: {
  points: AreaPoint[];
  before?: number[] | null;
  upto?: number;
  unit: Unit;
  height?: number;
  label: string;
  beforeLabel?: string;
}) {
  const format = fmtOf(unit), tick = tickOf(unit);
  const reduce = useReducedMotion();
  const [rootRef, W] = useWidth<HTMLDivElement>(720);
  const [hot, setHot] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useDismissOutside(wrap, hot !== null, useCallback(() => setHot(null), []));
  const id = "eu-area" + useId().replace(/:/g, "");

  const n = points.length;
  const live = clamp(upto ?? n, 0, n);
  const prev = before && n > 1 ? before.slice(0, n) : null;
  const max = Math.max(0, ...points.slice(0, live).map((p) => p.value), ...(prev ?? []));
  const step = niceStep((max || 1) / 4);
  const top = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const L = Math.max(...ticks.map((t) => tick(t).length)) * 6.6 + 16, R = 14, T = 14, B = 30;
  const plotW = Math.max(10, W - L - R), plotH = height - T - B;
  const x = (i: number) => (n === 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const y = (v: number) => T + plotH - (Math.max(0, v) / top) * plotH;
  const floor = T + plotH;
  const shown = points.slice(0, live).map((p, i) => ({ x: x(i), y: y(p.value) }));
  const line = curve(shown);
  const area = live > 1 ? `${line} L${x(live - 1).toFixed(1)},${floor} L${x(0).toFixed(1)},${floor} Z` : "";
  const every = Math.ceil(n / Math.max(2, Math.floor(plotW / 84)));
  const at = hot != null && hot < live ? hot : null;

  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = n === 1 ? 0 : Math.round(((e.clientX - box.left) / box.width) * (n - 1));
    setHot(clamp(i, 0, Math.max(0, live - 1)));
  };
  const key = (e: React.KeyboardEvent) => {
    const last = Math.max(0, live - 1);
    if (e.key === "ArrowRight") setHot((a) => clamp((a ?? -1) + 1, 0, last));
    else if (e.key === "ArrowLeft") setHot((a) => clamp((a ?? live) - 1, 0, last));
    else if (e.key === "Home") setHot(0);
    else if (e.key === "End") setHot(last);
    else if (e.key === "Escape") setHot(null);
    else return;
    e.preventDefault();
  };
  // the curve draws itself in when the days change, not on every pointer move
  const drawKey = points.map((p) => p.key + ":" + p.value).join("|");

  return (
    <div ref={rootRef} className="eu-chart">
      <div ref={wrap} className="eu-chart-in" style={{ height }}>
        <svg width={W} height={height} role="img" aria-label={label} tabIndex={0} onKeyDown={key} onBlur={() => setHot(null)} className="eu-svg">
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((t, k) => (
            <g key={k}>
              <line className={k === 0 ? "eu-axis" : "eu-grid"} x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
              <text className="eu-tick" x={L - 10} y={y(t)} textAnchor="end" dominantBaseline="middle">
                {tick(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={p.key} className={"eu-tick" + (at === i ? " on" : "")} x={x(i)} y={height - 9} textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
          {prev && <path className="eu-prev" d={curve(prev.map((v, i) => ({ x: x(i), y: y(v) })))} />}
          {live > 1 && (
            <motion.path key={"a" + drawKey} d={area} fill={`url(#${id})`} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 0.25, ease: EASE_OUT }} />
          )}
          {live > 1 && (
            <motion.path key={"l" + drawKey} className="eu-line" d={line} initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: EASE_OUT }} />
          )}
          {live === 1 && <circle className="eu-point" cx={x(0)} cy={y(points[0].value)} r={4} />}
          <AnimatePresence>
            {at != null && (
              <motion.g key="hot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
                <motion.line className="eu-cross" initial={false} animate={{ x1: x(at), x2: x(at) }} y1={T} y2={floor} transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }} />
                {prev?.[at] != null && <motion.circle className="eu-point prev" r={3.5} initial={false} animate={{ cx: x(at), cy: y(prev[at]) }} transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }} />}
                <motion.circle className="eu-point hot" r={5.5} initial={false} animate={{ cx: x(at), cy: y(points[at].value) }} transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }} />
              </motion.g>
            )}
          </AnimatePresence>
          <rect x={L} y={T} width={plotW} height={plotH} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={(e) => e.pointerType === "mouse" && setHot(null)} />
        </svg>
        <Tip pos={at == null ? null : { x: x(at), y: y(points[at].value) }} boundsWidth={W}>
          {at != null && (
            <>
              <p className="eu-tip-head">{points[at].long}</p>
              <p className="eu-tip-row">
                <span><Dot color="var(--chart-1)" />This period</span>
                <b>{format(points[at].value)}</b>
              </p>
              {prev?.[at] != null && (
                <p className="eu-tip-row">
                  <span><Dot color="var(--ink3)" dashed />{beforeLabel ?? "Before"}</span>
                  <b>{format(prev[at])}</b>
                </p>
              )}
            </>
          )}
        </Tip>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.slice(0, live).map((p) => (
            <tr key={p.key}><th scope="row">{p.long}</th><td>{format(p.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------- Bar ----------------------------------- */

export type Bar = { label: string; long?: string; value: number; sub?: string };

// a bar with round shoulders, always drawn with the same commands so any two morph into each other
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}

// After EasyUI's Bar Chart: bars that grow from the floor one after the other,
// a band that slides under the one pointed at (arrow keys too), the others
// fading back, and the reading above it. The tallest is in the strong colour.
export function BarChart({ bars, unit, height = 240, label }: { bars: Bar[]; unit: Unit; height?: number; label: string }) {
  const format = fmtOf(unit), tick = tickOf(unit);
  const reduce = useReducedMotion();
  const [rootRef, width] = useWidth<HTMLDivElement>(560);
  const [active, setActive] = useState<number | null>(null);
  const [entered, setEntered] = useState(Boolean(reduce));
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 1200);
    return () => clearTimeout(t);
  }, []);
  useDismissOutside(wrap, active !== null, useCallback(() => setActive(null), []));
  const n = bars.length;
  const maxV = Math.max(1e-9, ...bars.map((b) => Math.max(0, b.value)));
  const step = niceStep(maxV / 4);
  const yMax = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const M = { top: 8, right: 6, bottom: 26, left: Math.ceil(Math.max(...ticks.map((t) => tick(t).length)) * 6.4) + 12 };
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const base = M.top + ih;
  const y = (v: number) => base - (Math.max(0, v) / yMax) * ih;
  const stepX = iw / Math.max(1, n);
  const barW = clamp(stepX * 0.62, 4, 40);
  const labelEvery = Math.max(1, Math.ceil((Math.max(...bars.map((b) => b.label.length), 1) * 6.4 + 12) / stepX));
  const peak = bars.reduce((a, b, i) => (b.value > bars[a].value ? i : a), 0);
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setActive(clamp(Math.floor((e.clientX - box.left) / stepX), 0, n - 1));
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setActive((a) => clamp((a ?? -1) + 1, 0, n - 1));
    else if (e.key === "ArrowLeft") setActive((a) => clamp((a ?? n) - 1, 0, n - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };
  if (!n) return null;
  return (
    <div ref={rootRef} className="eu-chart">
      <div ref={wrap} className="eu-chart-in" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={label} tabIndex={0} onKeyDown={key} onBlur={() => setActive(null)} className="eu-svg">
          {ticks.map((t, k) => (
            <g key={k}>
              <line className={k === 0 ? "eu-axis" : "eu-grid"} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
              <text className="eu-tick" x={M.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">{tick(t)}</text>
            </g>
          ))}
          <motion.rect
            y={M.top} height={ih} width={stepX} rx={8} className="eu-band" initial={false}
            animate={{ x: M.left + stepX * (active ?? 0), opacity: active === null ? 0 : 1 }}
            transition={reduce ? { duration: 0 } : { x: { type: "spring", duration: 0.3, bounce: 0.1 }, opacity: { duration: 0.15 } }}
          />
          {bars.map((b, i) => {
            const cxp = M.left + stepX * i + stepX / 2;
            const h = (Math.max(0, b.value) / yMax) * ih;
            return (
              <motion.path
                key={b.label}
                fill={i === peak && b.value > 0 ? "var(--chart-strong)" : "var(--chart-1)"}
                style={{ opacity: active === null || active === i ? 1 : 0.38, transition: "opacity .2s" }}
                initial={reduce ? false : { d: barPath(cxp - barW / 2, base, barW, 0, 0) }}
                animate={{ d: barPath(cxp - barW / 2, base - h, barW, h, Math.min(6, barW / 2)) }}
                transition={reduce ? { duration: 0 } : entered ? SPRING : { duration: 0.8, ease: EASE_OUT, delay: i * 0.035 }}
              />
            );
          })}
          {bars.map((b, i) =>
            i % labelEvery === 0 ? (
              <text key={b.label} className={"eu-tick" + (active === i ? " on" : "")} x={M.left + stepX * i + stepX / 2} y={height - 8} textAnchor="middle">{b.label}</text>
            ) : null,
          )}
          <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)} />
        </svg>
        <Tip pos={active === null ? null : { x: M.left + stepX * (active + 0.5), y: y(bars[active].value) }} boundsWidth={width}>
          {active !== null && (
            <>
              <p className="eu-tip-head">{bars[active].long ?? bars[active].label}</p>
              <p className="eu-tip-row"><b>{format(bars[active].value)}</b></p>
              {bars[active].sub && <p className="eu-tip-sub">{bars[active].sub}</p>}
            </>
          )}
        </Tip>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}><th scope="row">{b.long ?? b.label}</th><td>{format(b.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------- Donut ---------------------------------- */

export type Slice = { label: string; value: number; sub?: string };

const pt = (cx: number, cy: number, r: number, a: number) => ({ x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) });
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p0 = pt(cx, cy, r, a0);
  const p1 = pt(cx, cy, r, a1);
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function Arc({ c, r, a0, a1, color, width, dim, delay, label, onEnter, onLeave, onClick }: {
  c: { x: number; y: number }; r: number; a0: number; a1: number; color: string; width: number; dim: boolean; delay: number; label: string;
  onEnter: () => void; onLeave: () => void; onClick: () => void;
}) {
  const reduce = useReducedMotion();
  const s = useMotionValue(a0);
  const e = useMotionValue(reduce ? a1 : a0);
  const w = useMotionValue(width);
  const first = useRef(true);
  const d = useTransform<number, string>([s, e], ([p, q]) => arcPath(c.x, c.y, r, p, Math.max(q, p + 0.0004)));
  useEffect(() => {
    const intro = first.current && !reduce;
    const spring = { type: "spring", duration: 0.7, bounce: 0 } as const;
    const c1 = animate(s, a0, intro || reduce ? { duration: 0 } : spring);
    const c2 = animate(e, a1, reduce ? { duration: 0 } : intro ? { duration: 1, ease: EASE_OUT, delay } : spring);
    first.current = false;
    return () => {
      c1.stop();
      c2.stop();
    };
  }, [a0, a1, delay, s, e, reduce]);
  useEffect(() => {
    const k = animate(w, width, { type: "spring", duration: 0.35, bounce: 0.15 });
    return () => k.stop();
  }, [width, w]);
  return (
    <g style={{ opacity: dim ? 0.35 : 1, transition: "opacity .2s" }}>
      <motion.path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
      <motion.path d={d} fill="none" stroke="transparent" strokeWidth={30} strokeLinecap="round" pointerEvents="stroke" style={{ cursor: "pointer" }} onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={onClick} aria-label={label} />
    </g>
  );
}

// After EasyUI's Donut Chart: a ring whose arcs sweep in one after the other,
// the total counting up in its middle, and a legend beside it. Pointing at an
// arc or a line of the legend thickens that arc and puts its own figure and
// share in the middle; pressing a line of the legend leaves that one out of
// the ring (the ring never empties).
export function DonutChart({ slices, unit, centre = "Total", size = 200, thickness = 16, label }: { slices: Slice[]; unit: Unit; centre?: string; size?: number; thickness?: number; label: string }) {
  const format = fmtOf(unit);
  const reduce = useReducedMotion();
  const [rootRef, rootW] = useWidth<HTMLDivElement>(420);
  const [hidden, setHidden] = useState<number[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useDismissOutside(wrap, active !== null, useCallback(() => setActive(null), []));
  const side = rootW >= 440;
  const D = Math.round(Math.max(130, Math.min(size, side ? rootW * 0.45 : rootW)));
  const grow = thickness + 6;
  const r = D / 2 - grow / 2 - 1;
  const c = { x: D / 2, y: D / 2 };
  const items = slices.map((s, i) => ({ ...s, i, color: tone(i), off: hidden.includes(i) }));
  const total = items.reduce((a, x) => a + (x.off ? 0 : Math.max(0, x.value)), 0);
  const pad = 3.5 / r + thickness / 2 / r;
  let acc = 0;
  const segs = items.map((it) => {
    const f = it.off || total === 0 ? 0 : Math.max(0, it.value) / total;
    const a0 = acc * Math.PI * 2;
    acc += f;
    const a1 = acc * Math.PI * 2;
    const room = a1 - a0 - 2 * pad;
    const mid = (a0 + a1) / 2;
    return { ...it, f, a0: room > 0 ? a0 + pad : mid, a1: room > 0 ? a1 - pad : mid };
  });
  const toggle = (i: number) => setHidden((h) => (h.includes(i) ? h.filter((x) => x !== i) : items.length - h.length > 1 ? [...h, i] : h));
  const act = active !== null ? segs[active] : null;
  const big = clamp(D * 0.12, 18, 28);
  return (
    <div ref={rootRef} className={"eu-donut" + (side ? " side" : "")}>
      <div ref={wrap} className="eu-donut-ring" style={{ width: D, height: D }}>
        <svg width={D} height={D} role="img" aria-label={`${label}. ${centre} ${format(total)}`} className="eu-svg">
          <path className="eu-track" d={arcPath(c.x, c.y, r, 0, Math.PI * 1.9999)} fill="none" strokeWidth={thickness} strokeLinecap="round" />
          {segs.map((sg, i) => (
            <Arc
              key={i} c={c} r={r} a0={sg.a0} a1={sg.a1} color={sg.color}
              width={sg.off ? 0 : active === i ? thickness + 4 : thickness}
              dim={active !== null && active !== i} delay={0.12 + i * 0.09}
              label={`${sg.label}: ${format(sg.value)}`}
              onEnter={() => setActive(i)} onLeave={() => setActive(null)} onClick={() => setActive((a) => (a === i ? null : i))}
            />
          ))}
        </svg>
        <div className="eu-donut-mid">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={active ?? "total"} initial={{ opacity: 0, y: reduce ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduce ? 0 : -4 }} transition={{ duration: 0.16, ease: EASE_OUT }}>
              <p className="eu-donut-label">{act ? act.label : centre}</p>
              <p className="eu-donut-value" style={{ fontSize: big }}>{act ? format(act.value) : <Counting value={total} format={format} />}</p>
              {act && <p className="eu-donut-label">{Math.round(act.f * 100)}%</p>}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <ul className="eu-legend" aria-label="Legend">
        {segs.map((sg, i) => (
          <li key={i}>
            <button
              type="button" aria-pressed={!sg.off} className={sg.off ? "off" : undefined}
              title={sg.off ? "Put it back in the ring" : "Leave it out of the ring"}
              onClick={() => toggle(i)}
              onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
              onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
              onFocus={() => setActive(i)} onBlur={() => setActive(null)}
            >
              <Dot color={sg.color} />
              <span className="eu-legend-name">
                {sg.label}
                {sg.sub && <small>{sg.sub}</small>}
              </span>
              <b>{format(sg.value)}</b>
              <em>{sg.off ? "—" : `${Math.round(sg.f * 100)}%`}</em>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
