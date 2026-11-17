"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { fmtOf, type Unit } from "./charts";

// After EasyUI's Animated Number Morph and Stat Card (easyui.site, MIT, Suraj
// Maurya), in this app's own CSS (eu.css).

// One figure of a number: a column 0 to 9 that rolls on a spring to its digit.
function Digit({ d }: { d: number }) {
  const spring = useSpring(d, { stiffness: 170, damping: 22, mass: 0.6 });
  const y = useTransform(spring, (v) => `-${v * 10}%`);
  useEffect(() => spring.set(d), [spring, d]);
  return (
    <span className="eu-digit" aria-hidden>
      <motion.span style={{ y }}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <span key={n}>{n}</span>
        ))}
      </motion.span>
    </span>
  );
}

// A figure written as the app writes it ("Rs 17,160.25", "19"), each digit
// rolling to its place: from nought on the first draw, and from the old figure
// to the new one when the figure changes. The words around it (Rs, a comma)
// stand still. Without motion it is the text as it is.
export function Rolling({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion();
  // the first draw on the server and in the browser is the plain text, then the digits roll from nought
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  if (reduce || !live) return <span className={"eu-roll " + (className ?? "")}>{text}</span>;
  // the columns are keyed from the right, so a figure that grows a digit keeps its units where they were
  const chars = text.split("");
  return (
    <span className={"eu-roll " + (className ?? "")} aria-label={text} role="img">
      {chars.map((ch, i) => {
        const k = chars.length - i;
        // a space between flex items folds to nothing: it is drawn as a no-break space (U+00A0)
        return /\d/.test(ch) ? <Digit key={"d" + k} d={Number(ch)} /> : <span key={"c" + k + ch} aria-hidden>{ch === " " ? " " : ch}</span>;
      })}
    </span>
  );
}

// The small curve under a tile's figure, after Stat Card's sparkline: drawn in
// on arrival; running a finger or the pointer along it shows each day's figure
// in place of the tile's note.
function Spark({ values, labels, unit, onScrub }: { values: number[]; labels: string[]; unit: Unit; onScrub: (s: string | null) => void }) {
  const format = fmtOf(unit);
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(200);
  const [at, setAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const up = () => setW(Math.round(el.clientWidth) || 200);
    up();
    const ro = new ResizeObserver(up);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 40;
  const n = values.length;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const x = (i: number) => (n === 1 ? w / 2 : (i * (w - 4)) / (n - 1) + 2);
  const y = (v: number) => (max === min ? H / 2 : 3 + (1 - (v - min) / (max - min)) * (H - 6));
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const say = useCallback((i: number | null) => {
    setAt(i);
    onScrub(i == null ? null : `${labels[i]}: ${format(values[i])}`);
  }, [labels, values, format, onScrub]);
  const move = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    say(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  if (n < 2) return null;
  return (
    <div ref={box} className="eu-spark" onPointerMove={move} onPointerDown={move} onPointerLeave={() => say(null)} aria-hidden>
      <svg width={w} height={H}>
        <motion.path d={`${line} L${x(n - 1)},${H} L${x(0)},${H} Z`} className="eu-spark-area" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.3 }} />
        <motion.path d={line} className="eu-spark-line" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: [0.23, 1, 0.32, 1] }} />
        {at != null && <circle cx={x(at)} cy={y(values[at])} r={3.5} className="eu-spark-dot" />}
      </svg>
    </div>
  );
}

export type Stat = {
  label: string;
  value: string;
  note: string;
  // the period before, when it is compared: its figure written out, and the change
  before?: string;
  delta?: { text: string; good: boolean; up: boolean } | null;
  trend?: { values: number[]; labels: string[]; unit: Unit };
  href?: string;
};

// A tile of the dashboard: what it counts, the figure rolling in, a pill with
// the change on the period before (green when it is good news, amber when it
// is not: more refunds is not), a curve of the days when there is one, and
// what the figure means.
export function StatCard({ s, i }: { s: Stat; i: number }) {
  const [scrub, setScrub] = useState<string | null>(null);
  const Arrow = s.delta?.up ? ArrowUpRight : ArrowDownRight;
  const body = (
    <>
      <div className="eu-stat-top">
        <span className="eu-stat-label">{s.label}</span>
        {s.delta && (
          <span className={"eu-pill " + (s.delta.good ? "good" : "bad")}>
            <Arrow aria-hidden="true" />
            {s.delta.text}
          </span>
        )}
      </div>
      <Rolling text={s.value} className="eu-stat-value" />
      {s.trend && <Spark values={s.trend.values} labels={s.trend.labels} unit={s.trend.unit} onScrub={setScrub} />}
      <div className="eu-stat-note">{scrub ?? s.note}</div>
      {s.before != null && <div className="eu-stat-before">Before: {s.before}</div>}
    </>
  );
  const style = { "--i": i } as React.CSSProperties;
  return s.href ? (
    <Link href={s.href} className="eu-stat" style={style}>{body}</Link>
  ) : (
    <div className="eu-stat" style={style}>{body}</div>
  );
}
