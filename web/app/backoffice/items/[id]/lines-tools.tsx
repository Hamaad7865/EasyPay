"use client";

import { useEffect, useRef, useState } from "react";

// Above a product's lines (the owner, 2026-10-29: "too many scroll when a product has many variants"): a chip
// for each value of each option, to see only those lines, and one price or cost typed for every line shown.
// The lines are the page's own rows (tr[data-line], their values in data-o1..3) in the same form. Nothing here
// is sent with it: a price filled in waits for Save the lines, and a line a chip hides is saved as it is.
export function LinesTools({ options, chips, mayCost }: { options: { name: string; values: string[] }[]; chips: boolean; mayCost: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<(string | null)[]>(() => options.map(() => null));
  const [shown, setShown] = useState<{ n: number; of: number } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const rows = () => [...(box.current?.closest("form")?.querySelectorAll<HTMLTableRowElement>("tr[data-line]") ?? [])];

  useEffect(() => {
    const all = rows();
    let n = 0;
    for (const r of all) {
      const fits = picked.every((v, i) => v === null || r.dataset[`o${i + 1}`] === v);
      r.hidden = !fits;
      if (fits) n++;
    }
    setShown({ n, of: all.length });
  }, [picked]);

  const pick = (i: number, v: string | null) => {
    setSaid(null);
    setPicked((p) => p.map((x, k) => (k === i ? v : x)));
  };
  const fill = (field: "price" | "cost", value: string) => {
    if (!value.trim()) return;
    let n = 0;
    for (const r of rows()) {
      const input = r.hidden ? null : r.querySelector<HTMLInputElement>(`input[name^="${field}:"]`);
      if (input) { input.value = value.trim(); n++; }
    }
    setSaid(`${field === "price" ? "Price" : "Cost"} ${value.trim()} put on ${n} ${n === 1 ? "line" : "lines"}. Press Save the lines to keep it.`);
  };
  // Enter fills, rather than sending the whole form
  const enter = (field: "price" | "cost", value: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); fill(field, value); }
  };
  const filtered = picked.some((v) => v !== null);

  return (
    <div ref={box} className="line-tools">
      {chips &&
        options.map((o, i) => (
          <div key={o.name} className="line-chips" role="group" aria-label={`Show the lines of one ${o.name.toLowerCase()}`}>
            <span className="line-chips-name">{o.name}</span>
            <button type="button" className={picked[i] === null ? "line-chip on" : "line-chip"} aria-pressed={picked[i] === null} onClick={() => pick(i, null)}>All</button>
            {o.values.map((v) => (
              <button key={v} type="button" className={picked[i] === v ? "line-chip on" : "line-chip"} aria-pressed={picked[i] === v} onClick={() => pick(i, picked[i] === v ? null : v)}>{v}</button>
            ))}
          </div>
        ))}
      <div className="line-fill">
        <span className="muted">{filtered && shown ? `${shown.n} of ${shown.of} lines shown.` : "For every line shown:"}</span>
        <input value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={enter("price", price)} inputMode="decimal" placeholder="Price" className="narrow" aria-label="Same price for the lines shown" />
        <button type="button" className="btn-quiet btn-sm" onClick={() => fill("price", price)}>Same price</button>
        {mayCost && (
          <>
            <input value={cost} onChange={(e) => setCost(e.target.value)} onKeyDown={enter("cost", cost)} inputMode="decimal" placeholder="Cost" className="narrow" aria-label="Same cost for the lines shown" />
            <button type="button" className="btn-quiet btn-sm" onClick={() => fill("cost", cost)}>Same cost</button>
          </>
        )}
        {filtered && <button type="button" className="btn-link" onClick={() => setPicked(options.map(() => null))}>Show all</button>}
      </div>
      {said && <p className="help" role="status" style={{ margin: 0 }}>{said}</p>}
    </div>
  );
}
