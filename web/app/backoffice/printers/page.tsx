import Link from "next/link";
import { Printer } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, int, on, Refused, text, uuid } from "@/lib/action";
import { Empty, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/printers";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IP = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$/;

type Row = {
  id: string;
  name: string;
  kind: "network" | "usb";
  address: string | null;
  paper_mm: number;
  is_receipt: boolean;
  feed_lines: number;
  cut: boolean;
  is_active: boolean;
  categories: number;
  cats: string[]; // the categories whose items print here
};
type Cat = { id: string; name: string };

// Which categories print on a printer, set from the printer's side: the ones
// ticked get it, the others lose it. The same list the Categories page edits.
const ROUTE = `update categories set printer_ids = case
           when id = any($3::uuid[]) then (case when $2::uuid = any(printer_ids) then printer_ids else array_append(printer_ids, $2::uuid) end)
           else array_remove(printer_ids, $2::uuid) end
     where tenant_id = $1 and deleted_at is null and (id = any($3::uuid[]) or $2::uuid = any(printer_ids))`;
const ticked = (f: FormData) => f.getAll("cat").map(String).filter((v) => UUID.test(v));

function fields(f: FormData) {
  const name = text(f, "name", 40);
  const kind = f.get("kind") === "usb" ? "usb" : "network";
  const address = text(f, "address", 40);
  if (!name) throw new Refused("Give the printer a name, for example Kitchen or Bar.");
  if (kind === "network" && !IP.test(address)) throw new Refused("A network printer needs its IP address, for example 192.168.1.50.");
  return {
    name,
    kind,
    address: kind === "network" ? address : null,
    paper: f.get("paper_mm") === "58" ? 58 : 80,
    receipt: on(f, "is_receipt"),
    feed: int(f, "feed_lines", 0, 12, 3),
    cut: on(f, "cut"),
  };
}

async function addPrinter(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const v = fields(f);
    const store = await c.query(`select id from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [ctx.tenantId]);
    if (store.rowCount !== 1) throw new Refused("This restaurant has no store yet.");
    // one printer per store is where the cashier's receipts come out
    if (v.receipt) await c.query(`update printers set is_receipt = false where tenant_id = $1 and store_id = $2 and is_receipt`, [ctx.tenantId, store.rows[0].id]);
    const made = await c.query(
      `insert into printers (tenant_id, store_id, name, kind, address, paper_mm, is_receipt, feed_lines, cut, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = $1))
       returning id`,
      [ctx.tenantId, store.rows[0].id, v.name, v.kind, v.address, v.paper, v.receipt, v.feed, v.cut],
    );
    const cats = ticked(f);
    if (cats.length > 0) await c.query(ROUTE, [ctx.tenantId, made.rows[0].id, cats]);
    return cats.length > 0
      ? `${v.name} added. Orders for ${cats.length} ${cats.length === 1 ? "category" : "categories"} print there once the tills have synced.`
      : `${v.name} added. Tick the categories whose orders should print there.`;
  });
}

async function savePrinter(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      await c.query(`update printers set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      await c.query(`update categories set printer_ids = array_remove(printer_ids, $2::uuid) where tenant_id = $1 and $2::uuid = any(printer_ids)`, [ctx.tenantId, id]);
      return "Printer removed.";
    }
    const v = fields(f);
    if (v.receipt) {
      await c.query(
        `update printers set is_receipt = false where tenant_id = $1 and is_receipt and id <> $2
            and store_id = (select store_id from printers where tenant_id = $1 and id = $2)`,
        [ctx.tenantId, id],
      );
    }
    await c.query(
      `update printers set name = $3, kind = $4, address = $5, paper_mm = $6, is_receipt = $7, feed_lines = $8, cut = $9, is_active = $10
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id, v.name, v.kind, v.address, v.paper, v.receipt, v.feed, v.cut, on(f, "is_active")],
    );
    await c.query(ROUTE, [ctx.tenantId, id, ticked(f)]);
    return `${v.name} saved.`;
  });
}

function Form({ p, cats }: { p?: Row; cats: Cat[] }) {
  return (
    <>
      <div className="form-row">
        <label className="field">
          Name
          <input name="name" defaultValue={p?.name} required maxLength={40} placeholder="Kitchen" />
        </label>
        <label className="field">
          Connection
          <select name="kind" defaultValue={p?.kind ?? "network"}>
            <option value="network">Network (IP address)</option>
            <option value="usb">USB, plugged into the tablet</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          IP address
          <input name="address" defaultValue={p?.address ?? ""} maxLength={40} placeholder="192.168.1.50" />
          <span className="help">Network printers only. Port 9100 is used unless you add one, like 192.168.1.50:9101.</span>
        </label>
        <label className="field">
          Paper width
          <select name="paper_mm" defaultValue={String(p?.paper_mm ?? 80)}>
            <option value="80">80 mm</option>
            <option value="58">58 mm</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          Blank lines before the cut
          <input name="feed_lines" type="number" min={0} max={12} defaultValue={p?.feed_lines ?? 3} className="narrow" />
        </label>
        <div>
          <label className="check">
            <input type="checkbox" name="is_receipt" defaultChecked={p?.is_receipt ?? false} />
            <span>
              Cashier receipt printer
              <small>Receipts, bills, cash slips and closing reports come out here, and it opens the cash drawer.</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" name="cut" defaultChecked={p?.cut ?? true} />
            <span>Cut the paper after each print</span>
          </label>
          {p && (
            <label className="check">
              <input type="checkbox" name="is_active" defaultChecked={p.is_active} />
              <span>Switched on</span>
            </label>
          )}
        </div>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ padding: 0, fontWeight: 600 }}>Prints the orders of</legend>
        <span className="help">
          The categories whose items come out here when an order is sent: food on the kitchen printer, drinks on the bar printer. A category can print
          in more than one place. Each printer that prints orders is also a station on the till&apos;s kitchen display.
        </span>
        {cats.length === 0 ? (
          <span className="muted">No categories yet. Add them under Categories first.</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 8 }}>
            {cats.map((k) => (
              <label key={k.id} className="check" style={{ margin: 0 }}>
                <input type="checkbox" name="cat" value={k.id} defaultChecked={p?.cats.includes(k.id) ?? false} />
                {k.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </>
  );
}

export default async function PrintersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const { rows, cats } = await readTenant(ctx.tenantId, async (c) => ({
    rows: (
      await c.query(
        `select p.id, p.name, p.kind, p.address, p.paper_mm, p.is_receipt, p.feed_lines, p.cut, p.is_active,
                (select count(*)::int from categories k where k.tenant_id = p.tenant_id and k.deleted_at is null and p.id = any(k.printer_ids)) as categories,
                (select coalesce(array_agg(k.id::text), '{}') from categories k where k.tenant_id = p.tenant_id and k.deleted_at is null and p.id = any(k.printer_ids)) as cats
           from printers p where p.tenant_id = $1 and p.deleted_at is null order by p.sort_order, p.name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
    cats: (await c.query(`select id, name from categories where tenant_id = $1 and deleted_at is null order by sort_order, name`, [ctx.tenantId])).rows as Cat[],
  }));
  return (
    <div>
      <PageHead
        title="Printers"
        lede="The receipt printer at the till, and the kitchen and bar printers that orders are sent to. Add one for each place food or drink is made, and tick what it prints. The tablet prints to them directly, so they work without internet."
      />
      <Flash sp={sp} />
      {/* its form is the whole of a printer: it opens, like the printers under it */}
      <details className="card flush">
        <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
          <div>
            <h2>Add a printer</h2>
            <p>A kitchen printer, a bar printer, a pastry printer: name it after where it stands and tick what it prints.</p>
          </div>
          <span className="btn-quiet btn-sm">Open</span>
        </summary>
        <form action={addPrinter}>
          <div className="card-body">
            <Form cats={cats} />
          </div>
          <div className="card-foot">
            <button type="submit">Add printer</button>
          </div>
        </form>
      </details>
      {rows.length === 0 && (
        <Empty icon={Printer} title="No printers yet">
          Add the cashier&apos;s receipt printer first, then one for the kitchen and one for the bar if you have them.
        </Empty>
      )}
      {rows.map((p) => (
        <details key={p.id} className="card flush">
          <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
            <div>
              <h2>{p.name}</h2>
              <p>
                {p.kind === "usb" ? "USB" : p.address} · {p.paper_mm} mm
                {p.categories > 0 ? ` · prints ${p.categories} ${p.categories === 1 ? "category" : "categories"}` : ""}
              </p>
            </div>
            <span className="row-actions">
              {p.is_receipt && <span className="badge blue">Receipts</span>}
              {p.categories > 0 && <span className="badge">Kitchen orders</span>}
              <span className={"badge " + (p.is_active ? "green" : "red")}>{p.is_active ? "On" : "Off"}</span>
            </span>
          </summary>
          <form action={savePrinter}>
            <input type="hidden" name="id" value={p.id} />
            <div className="card-body">
              <Form p={p} cats={cats} />
            </div>
            <div className="card-foot">
              <button type="submit" name="remove" value="1" className="btn-danger" formNoValidate>Remove</button>
              <button type="submit">Save printer</button>
            </div>
          </form>
        </details>
      ))}
      <p className="muted">
        Where a category prints can also be set from its side, under <Link href="/backoffice/categories">Categories</Link>. A test print for each printer is
        on the tablet, under Settings, Printers.
      </p>
    </div>
  );
}
