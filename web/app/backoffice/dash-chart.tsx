"use client";

import { useEffect, useRef, useState } from "react";
import { fmtRs } from "@/lib/money";

export type Day = { day: string; gross: number };

const parse = (s: string) => new Date(s + "T00:00:00Z");
const short = (s: string) => parse(s).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
const named = (s: string) => parse(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function niceMax(rupees: number) {
  if (rupees <= 0) return 2000;
  const pow = 10 ** Math.floor(Math.log10(rupees));
  const f = rupees / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 8 ? 8 : 10) * pow;
}

// A curve through the points that never dips below the lower of two
// neighbours: a quiet day stays at its own height instead of sagging under
// the axis the way a plain spline would.
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

// Gross sales by day, with the days before as a dashed line when they are
// compared. Drawn at the width it is given, so the figures on the axes stay
// the size they are written at; pointing at a day shows what it took. `upto`
// is how many of the days have happened: the line stops at today instead of
// running along the floor through days that are still to come.
export function SalesChart({ cur, prev, upto }: { cur: Day[]; prev: Day[] | null; upto?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [hot, setHot] = useState<number | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const seen = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const H = 320, L = 70, R = 26, T = 14, B = 32;
  const plotW = W - L - R, plotH = H - T - B;
  const n = cur.length;
  const before = prev && n > 1 ? prev.slice(0, n) : null;
  const top = niceMax(Math.max(0, ...cur.map((d) => d.gross), ...(before ?? []).map((d) => d.gross)) / 100);
  const x = (i: number) => (n === 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const y = (cents: number) => T + plotH - (Math.max(0, cents) / 100 / top) * plotH;
  const points = (days: Day[]) => days.map((d, i) => ({ x: x(i), y: y(d.gross) }));
  const live = Math.max(0, Math.min(n, upto ?? n));
  const shown = cur.slice(0, live);
  const line = curve(points(shown));
  const every = Math.ceil(n / Math.max(2, Math.floor(plotW / 80)));
  const floor = T + plotH;

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = n === 1 ? 0 : Math.round(((vx - L) / plotW) * (n - 1));
    setHot(Math.min(live - 1, Math.max(0, i)));
  };
  const at = hot != null && hot >= 0 && hot < live ? hot : null;

  return (
    <div className="chart-wrap" ref={host}>
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gross sales by day" onPointerMove={move} onPointerLeave={() => setHot(null)}>
        {[0, 1, 2, 3, 4].map((k) => {
          const yy = floor - (k / 4) * plotH;
          return (
            <g key={k}>
              <line className="grid" x1={L} x2={W - R} y1={yy} y2={yy} />
              <text x={L - 10} y={yy + 4} textAnchor="end">
                {fmtRs(((top * k) / 4) * 100)}
              </text>
            </g>
          );
        })}
        {cur.map((d, i) =>
          i % every === 0 ? (
            <text key={d.day} x={x(i)} y={H - 9} textAnchor="middle">
              {short(d.day)}
            </text>
          ) : null,
        )}
        {before && <path className="prev" d={curve(points(before))} />}
        {live > 1 && <path className="area" d={`${line} L${x(live - 1).toFixed(1)},${floor} L${x(0).toFixed(1)},${floor} Z`} />}
        {live > 1 && <path className="line" d={line} />}
        {n <= 31 && shown.map((d, i) => (d.gross !== 0 || live === 1 ? <circle key={d.day} className="dot" cx={x(i)} cy={y(d.gross)} r={3.5} /> : null))}
        {at != null && <line className="guide" x1={x(at)} x2={x(at)} y1={T} y2={floor} />}
        {at != null && <circle className="hot" cx={x(at)} cy={y(cur[at].gross)} r={5.5} />}
      </svg>
      {at != null && (
        <div
          className={y(cur[at].gross) < 76 ? "chart-tip below" : "chart-tip"}
          style={{ left: `${Math.min(88, Math.max(12, (x(at) / W) * 100))}%`, top: `${(y(cur[at].gross) / H) * 100}%` }}
        >
          <strong>{fmtRs(cur[at].gross)}</strong>
          <span>
            {named(cur[at].day)}
            {before?.[at] ? ` · before ${fmtRs(before[at].gross)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
