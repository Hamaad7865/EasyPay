"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanBarcode } from "lucide-react";
import { parseUnits } from "@/lib/orders";
import { fold } from "../../table-kit";
import type { Counted } from "./actions";

// A line of the count, for finding it by name. What it is expected to hold is
// not here: it never reaches the browser while counting.
export type CountLine = { key: string; item: string; variant: string | null; label: string; sku: string | null; barcode: string | null };
export type Recent = { label: string; counted: number; when: string };

const shown = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// The counting box, after the approved "Count" board. A scan adds one to its
// line and the box is ready for the next scan; a name finds the line, and a
// quantity is typed for it. Each goes to the server by itself, so two people
// counting on two devices add up. The review beside the box is the server's:
// it is asked for again a moment after the last scan, not after every one, so
// a run of scans is not a run of whole pages.
export function Counting({
  count, lines, recent, scan, set,
}: {
  count: string;
  lines: CountLine[];
  recent: Recent[];
  scan: (count: string, code: string) => Promise<Counted>;
  set: (count: string, item: string, variant: string | null, units: number, label: string) => Promise<Counted>;
}) {
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<CountLine | null>(null);
  const [qty, setQty] = useState("");
  // what this box counted and the page has not shown yet; `recent` is the server's list
  const [mine, setMine] = useState<(Recent & { at: number })[]>([]);
  // what was scanned and not counted stays in view until it is cleared: in a run of scans, one that failed is easy to miss
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(0);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // the page was drawn again: it holds everything counted before it was asked for
  useEffect(() => setMine((was) => was.filter((x) => x.at > asked.current)), [recent]);
  const last = [...mine, ...recent.filter((r) => !mine.some((x) => x.label === r.label))].slice(0, 8);

  const hay = useMemo(() => lines.map((l) => ({ l, text: fold([l.label, l.sku ?? "", l.barcode ?? ""].join(" ")) })), [lines]);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const found = words.length === 0 ? [] : hay.filter((h) => words.every((w) => h.text.includes(w))).map((h) => h.l).slice(0, 8);
  const typedQty = parseUnits(qty);

  const done = (r: Counted) => {
    if (!r.ok) return setProblems((was) => [r.message, ...was].slice(0, 5));
    setMine((was) => [{ label: r.label, counted: r.counted, when: "A moment ago", at: Date.now() }, ...was.filter((x) => x.label !== r.label)].slice(0, 8));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      asked.current = Date.now();
      router.refresh();
    }, 900);
  };
  const send = (code: string) => {
    setQ("");
    box.current?.focus();
    start(async () => done(await scan(count, code)));
  };
  const save = () => {
    if (!picked || typedQty === null) return;
    const line = picked;
    setPicked(null);
    setQty("");
    setQ("");
    box.current?.focus();
    start(async () => done(await set(count, line.item, line.variant, typedQty, line.label)));
  };

  return (
    <section className="card no-print">
      <h2>Counting</h2>
      <label className="table-search" style={{ width: "100%" }}>
        <ScanBarcode aria-hidden="true" />
        <input
          ref={box}
          type="search"
          value={q}
          autoFocus
          onChange={(e) => {
            setQ(e.target.value);
            setPicked(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // what the box holds, not what was last drawn: a scanner types faster than the page
            const code = e.currentTarget.value.trim();
            if (!code) return;
            // a name that finds one line asks how many; anything else is taken for a scanned code
            const exact = lines.some((l) => (l.barcode ?? "").toLowerCase() === code.toLowerCase() || (l.sku ?? "").toLowerCase() === code.toLowerCase());
            if (!exact && found.length === 1) return setPicked(found[0]);
            send(code);
          }}
          placeholder="Scan a barcode, or search a name"
          aria-label="Scan or search"
          autoComplete="off"
          style={{ width: "100%", height: 52, fontSize: 16, border: "2px solid var(--green)", background: "var(--green-bg)", borderRadius: 12 }}
        />
      </label>
      <p className="muted" style={{ margin: "10px 0" }}>Each scan adds one. The expected quantity is hidden while counting, so the count is honest.</p>
      {problems.length > 0 && (
        <div className="note warn" role="alert" style={{ margin: "0 0 10px" }}>
          <strong>Not counted</strong>
          <div>
            {problems.map((m, i) => (
              <div key={problems.length - i}>{m}</div>
            ))}
            <button type="button" className="btn-link" onClick={() => setProblems([])}>
              Clear
            </button>
          </div>
        </div>
      )}
      {picked ? (
        <div className="bo-toolbar" style={{ marginBottom: 10 }}>
          <strong>{picked.label}</strong>
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            autoFocus
            inputMode="decimal"
            className="narrow"
            placeholder="How many"
            aria-label={`How many of ${picked.label}`}
            aria-invalid={typedQty === null}
          />
          <button type="button" className="btn-sm" onClick={save} disabled={typedQty === null || qty.trim() === "" || busy}>
            Set
          </button>
          <button type="button" className="btn-link" onClick={() => setPicked(null)}>
            Back
          </button>
        </div>
      ) : (
        found.length > 0 && (
          <div className="bo-toolbar" style={{ marginBottom: 10 }}>
            {found.map((l) => (
              <button key={l.key} type="button" className="btn-quiet btn-sm" onClick={() => setPicked(l)}>
                {l.label}
              </button>
            ))}
          </div>
        )
      )}
      <table>
        <thead>
          <tr>
            <th>Last counted</th>
            <th className="num">Counted</th>
          </tr>
        </thead>
        <tbody>
          {last.map((r) => (
            <tr key={r.label}>
              <td>
                <span className="strong">{r.label}</span>
                <small className="cell-sub">{r.when}</small>
              </td>
              <td className="num strong">{shown(r.counted)}</td>
            </tr>
          ))}
          {last.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">Nothing counted yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="note" style={{ margin: "12px 0 0" }}>The shop can stay open. A sale made after its product was counted is applied on top of the counted figure.</p>
    </section>
  );
}
