"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

// After EasyUI's Activity Heatmap (easyui.site, MIT, Suraj Maurya), on the
// app's own heat map (globals.css .heat): the squares ripple in from the
// top corner, the one under the pointer lifts with its day and its hour lit
// and the rest of its row and column, and a card beside it says what it was.

export type HeatCell = { level: number; head: string; line: string };
export type HeatRow = { day: string; cells: HeatCell[] };

export function Heatmap({ hours, rows }: { hours: string[]; rows: HeatRow[] }) {
  const reduce = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ r: number; c: number; x: number; y: number; below: boolean } | null>(null);

  const point = (r: number, c: number, el: HTMLElement) => {
    const w = wrap.current?.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (!w) return;
    const below = b.top - w.top < 56;
    setAt({ r, c, x: b.left - w.left + b.width / 2, y: below ? b.bottom - w.top + 8 : b.top - w.top - 8, below });
  };
  const cell = at ? rows[at.r]?.cells[at.c] : null;

  return (
    <div ref={wrap} className="eu-heat" onPointerLeave={() => setAt(null)}>
      <div className="heat-wrap">
        <div className={"heat" + (at ? " pointing" : "")} style={{ "--cols": hours.length } as React.CSSProperties}>
          <span />
          {hours.map((h, c) => (
            <span key={h} className={"heat-hour" + (at?.c === c ? " lit" : "")}>
              {h}
            </span>
          ))}
          {rows.map((row, r) => (
            <div key={row.day} className="heat-row">
              <span className={"heat-day" + (at?.r === r ? " lit" : "")}>{row.day}</span>
              {row.cells.map((x, c) => (
                <motion.i
                  key={c}
                  className={`h${x.level}` + (at && (at.r === r || at.c === c) ? " lit" : "")}
                  role="img"
                  aria-label={`${x.head}: ${x.line}`}
                  onPointerEnter={(e) => point(r, c, e.currentTarget)}
                  initial={reduce ? false : { opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 26, delay: reduce ? 0 : (r + c) * 0.018 }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <AnimatePresence>
        {at && cell && (
          <motion.div
            key="tip"
            className="eu-heat-tip"
            aria-hidden
            initial={{ opacity: 0, scale: 0.92, x: at.x, y: at.y }}
            animate={{ opacity: 1, scale: 1, x: at.x, y: at.y }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
            transition={{ type: "spring", stiffness: 520, damping: 36, opacity: { duration: 0.12 } }}
            // the card's own offset is the CSS translate, which adds to the spring's x and y
            style={{ translate: at.below ? "-50% 0" : "-50% -100%" }}
          >
            <b>{cell.head}</b>
            {cell.line}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
