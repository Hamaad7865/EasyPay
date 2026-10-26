"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { parseUnits } from "@/lib/orders";
import { fold } from "../table-kit";
import { Submit } from "../busy";

// A line of stock that can be sent: a counted product, or one variant of it, with what each branch holds of it
// (thousandths, by branch id).
export type SendOption = { key: string; item: string; variant: string | null; label: string; sku: string | null; barcode: string | null; at: Record<string, number> };
type Typed = { key: string; qty: string };

const shown = (q: number) => (q / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });

// A transfer as it is being made (multi-branch, the spec's section 7): From, To, and the lines, found by name, SKU
// or a scanned barcode. What each line holds at From is said beside it. The lines travel with the form as one
// field, `lines`, in thousandths; `lines_ok` is empty while a quantity is not a number, and the server refuses then.
export function TransferForm({
  action, branches, from: startFrom, options,
}: {
  action: (f: FormData) => Promise<void>;
  branches: { id: string; name: string }[];
  from: string;
  options: SendOption[];
}) {
  const [from, setFrom] = useState(startFrom);
  const [to, setTo] = useState(branches.find((b) => b.id !== startFrom)?.id ?? "");
  const [lines, setLines] = useState<Typed[]>([]);
  const [q, setQ] = useState("");
  const byKey = useMemo(() => new Map(options.map((o) => [o.key, o])), [options]);
  const hay = useMemo(() => options.map((o) => ({ o, text: fold([o.label, o.sku ?? "", o.barcode ?? ""].join(" ")) })), [options]);
  const on = new Set(lines.map((l) => l.key));
  const words = fold(q).split(/\s+/).filter(Boolean);
  const code = q.trim().toLowerCase();
  const exact = code ? options.find((o) => (o.barcode ?? "").toLowerCase() === code || (o.sku ?? "").toLowerCase() === code) : undefined;
  // what From holds comes first; what is on the list already is left out
  const offered = (words.length === 0 ? [] : hay.filter((h) => words.every((w) => h.text.includes(w))).map((h) => h.o))
    .filter((o) => !on.has(o.key))
    .sort((a, b) => Number((b.at[from] ?? 0) > 0) - Number((a.at[from] ?? 0) > 0) || a.label.localeCompare(b.label))
    .slice(0, 8);
  const add = (o: SendOption) => {
    setLines((was) => (was.some((l) => l.key === o.key) ? was.map((l) => (l.key === o.key ? { ...l, qty: shown((parseUnits(l.qty) ?? 0) + 1000) } : l)) : [...was, { key: o.key, qty: "1" }]));
    setQ("");
  };
  const parsed = lines.map((l) => ({ l, o: byKey.get(l.key)!, qty: parseUnits(l.qty) }));
  const bad = parsed.some((p) => p.qty === null || p.qty === 0);
  const name = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const sent = parsed.filter((p) => p.qty).map((p) => ({ item: p.o.item, variant: p.o.variant, qty: p.qty }));

  return (
    <form action={action}>
      <input type="hidden" name="lines" value={JSON.stringify(sent)} />
      <input type="hidden" name="lines_ok" value={bad ? "" : "1"} />
      <div className="card">
        <div className="card-body">
          <div className="grid-3" style={{ gap: "0 20px" }}>
            <label className="field">
              From
              <select name="from" value={from} onChange={(e) => setFrom(e.target.value)} required>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="field">
              To
              <select name="to" value={to} onChange={(e) => setTo(e.target.value)} required>
                {branches.filter((b) => b.id !== from).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="field">
              Note
              <input name="note" maxLength={200} placeholder="For example, who takes it" />
            </label>
          </div>
        </div>
      </div>
      <div className="card flush">
        <div className="card-head">
          <div>
            <h2>What is sent</h2>
            <p>Find a product by its name, its SKU or by scanning it. It leaves {name(from)} and arrives at {name(to) || "the other branch"} at once.</p>
          </div>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const pick = exact ?? (offered.length === 1 ? offered[0] : undefined);
              if (pick) add(pick);
            }}
            placeholder="Name, SKU or scan a barcode"
            aria-label="Find a product to send"
            style={{ width: "100%" }}
          />
          {offered.length > 0 && (
            <ul className="plain" style={{ margin: "6px 0 0" }}>
              {offered.map((o) => (
                <li key={o.key}>
                  <button type="button" className="btn-quiet btn-sm" onClick={() => add(o)}>
                    {o.label} · {shown(o.at[from] ?? 0)} at {name(from)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <table>
          <thead>
            <tr><th>Product</th><th className="num">At {name(from)}</th><th className="num">To send</th><th /></tr>
          </thead>
          <tbody>
            {parsed.length === 0 && (
              <tr><td colSpan={4} className="muted">Nothing yet: find the products above.</td></tr>
            )}
            {parsed.map((p) => {
              const held = p.o.at[from] ?? 0;
              const over = p.qty !== null && p.qty > held;
              return (
                <tr key={p.l.key}>
                  <td className="strong">{p.o.label}</td>
                  <td className="num">{shown(held)}</td>
                  <td className="num">
                    <input
                      className="narrow"
                      inputMode="decimal"
                      value={p.l.qty}
                      onChange={(e) => setLines((was) => was.map((x) => (x.key === p.l.key ? { ...x, qty: e.target.value } : x)))}
                      aria-label={`How many of ${p.o.label}`}
                      style={over || p.qty === null ? { borderColor: "var(--red)" } : undefined}
                    />
                    {over && <span className="sub neg">only {shown(held)} there</span>}
                  </td>
                  <td>
                    <button type="button" className="btn-quiet btn-sm" onClick={() => setLines((was) => was.filter((x) => x.key !== p.l.key))} aria-label={`Take ${p.o.label} off`}>
                      <X aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="bo-toolbar">
        <Submit disabled={parsed.length === 0 || bad || !to}>Send</Submit>
        <span className="muted">Nothing is undone: a mistake is sent back with another transfer.</span>
      </div>
    </form>
  );
}
