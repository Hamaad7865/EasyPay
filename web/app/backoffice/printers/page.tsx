import Link from "next/link";
import { Printer } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, int, on, Refused, text, uuid } from "@/lib/action";
import { Card, Empty, Flash, PageHead, type Search } from "../ui";

const PATH = "/backoffice/printers";
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
};

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
    await c.query(
      `insert into printers (tenant_id, store_id, name, kind, address, paper_mm, is_receipt, feed_lines, cut, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = $1))`,
      [ctx.tenantId, store.rows[0].id, v.name, v.kind, v.address, v.paper, v.receipt, v.feed, v.cut],
    );
    return `${v.name} added. Tick it on the categories that should print there.`;
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
    return `${v.name} saved.`;
  });
}

function Form({ p }: { p?: Row }) {
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
    </>
  );
}

export default async function PrintersPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const rows = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `select p.id, p.name, p.kind, p.address, p.paper_mm, p.is_receipt, p.feed_lines, p.cut, p.is_active,
                (select count(*)::int from categories k where k.tenant_id = p.tenant_id and k.deleted_at is null and p.id = any(k.printer_ids)) as categories
           from printers p where p.tenant_id = $1 and p.deleted_at is null order by p.sort_order, p.name`,
        [ctx.tenantId],
      )
      .then((r) => r.rows as Row[]),
  );
  return (
    <div>
      <PageHead
        title="Printers"
        lede="The receipt printer at the till, and the kitchen and bar printers that orders are sent to. The tablet prints to them directly, so they work without internet."
      />
      <Flash sp={sp} />
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
              <Form p={p} />
            </div>
            <div className="card-foot">
              <button type="submit" name="remove" value="1" className="btn-danger" formNoValidate>Remove</button>
              <button type="submit">Save printer</button>
            </div>
          </form>
        </details>
      ))}
      <Card title="Add a printer" lede="After adding a kitchen or bar printer, tick it on the categories it should print.">
        <form action={addPrinter}>
          <Form />
          <button type="submit">Add printer</button>
        </form>
      </Card>
      <p className="muted">
        Which categories print where is set under <Link href="/backoffice/categories">Categories</Link>. A test print is on the tablet, under Settings.
      </p>
    </div>
  );
}
