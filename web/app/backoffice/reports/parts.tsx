import type { Filters, Lists } from "@/lib/report";
import { PrintButton } from "./print-button";

// The filter bar the reports share. Each report says which filters it has.
export function ReportFilters({
  path,
  f,
  l,
  show,
}: {
  path: string;
  f: Filters;
  l: Lists;
  show: ("employee" | "dining" | "kind" | "payment" | "tax" | "group" | "kind-no-all")[];
}) {
  const has = (k: (typeof show)[number]) => show.includes(k);
  return (
    <form className="filters no-print" action={path}>
      <label>
        From
        <input type="date" name="from" defaultValue={f.from} />
      </label>
      <label>
        To
        <input type="date" name="to" defaultValue={f.to} />
      </label>
      {has("employee") && (
        <label>
          Employee
          <select name="employee" defaultValue={f.employee ?? ""}>
            <option value="">Everyone</option>
            {l.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      {has("dining") && (
        <label>
          Order type
          <select name="dining" defaultValue={f.dining ?? ""}>
            <option value="">All types</option>
            {l.dining.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      {has("kind") && (
        <label>
          Show
          <select name="kind" defaultValue={f.kind}>
            <option value="all">Sales and refunds</option>
            <option value="sale">Sales only</option>
            <option value="refund">Refunds only</option>
          </select>
        </label>
      )}
      {has("payment") && (
        <label>
          Payment method
          <select name="payment" defaultValue={f.payment ?? ""}>
            <option value="">All methods</option>
            {l.payments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      {has("tax") && (
        <label>
          VAT type
          <select name="tax" defaultValue={f.tax ?? ""}>
            <option value="">All</option>
            {l.taxes.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      {has("group") && (
        <label>
          Rank by
          <select name="group" defaultValue={f.group}>
            <option value="item">Item</option>
            <option value="category">Category</option>
          </select>
        </label>
      )}
      <button type="submit">Show</button>
      <span className="spacer" />
      <PrintButton />
    </form>
  );
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
