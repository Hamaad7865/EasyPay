import Link from "next/link";
import { Printer } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, int, on, Refused, text, uuid } from "@/lib/action";
import { type PrinterCat as Cat, type PrinterRow as Row, printerWarnings, receiptField, receiptPicks } from "@/lib/printers";
import * as saves from "@/lib/saves";
import { loadSettings, saveSettings } from "@/lib/settings";
import { Empty, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

const PATH = "/backoffice/printers";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IP = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$/;

// Setting the printers up, in the two steps a restaurant takes:
//   1. the printers themselves: what each is called and how the tablet reaches it;
//   2. what prints where: which one prints receipts and bills, and for each
//      category which printers its orders come out on. A restaurant with a
//      single printer switches on "One printer for everything" instead.
// The till follows the same rule (Routing.kt): with that switch on, every
// kitchen order prints on the receipt printer, whatever is ticked here.

function fields(f: FormData) {
  const name = text(f, "name", 40);
  const kind: saves.PrinterForm["kind"] = f.get("kind") === "usb" ? "usb" : "network";
  const address = text(f, "address", 40);
  if (!name) throw new Refused("Give the printer a name, for example Kitchen, Bar or Cashier.");
  if (kind === "network" && !IP.test(address)) throw new Refused("A network printer needs its IP address, for example 192.168.1.50.");
  return {
    name,
    kind,
    address: kind === "network" ? address : null,
    paper: f.get("paper_mm") === "58" ? 58 : 80,
    feed: int(f, "feed_lines", 0, 12, 3),
    cut: on(f, "cut"),
  };
}

async function addPrinter(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const v = fields(f);
    const store = String(f.get("store_id") ?? "");
    if (!UUID.test(store)) throw new Refused("This restaurant has no store yet.");
    // the first printer of a store is where its receipts come out, until step 2 says otherwise
    const added = await saves.addPrinter(c, ctx.tenantId, store, v);
    if (!added) throw new Refused("That store is gone. Reload the page.");
    return added.first
      ? `${v.name} added. It prints the receipts and bills. Say below what else it prints.`
      : `${v.name} added. Say below what it prints.`;
  });
}

async function savePrinter(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      await c.query(`update printers set deleted_at = now(), is_receipt = false where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      await c.query(`update categories set printer_ids = array_remove(printer_ids, $2::uuid) where tenant_id = $1 and $2::uuid = any(printer_ids)`, [ctx.tenantId, id]);
      return "Printer removed.";
    }
    const v = fields(f);
    if (!(await saves.savePrinter(c, ctx.tenantId, id, v, on(f, "is_active")))) throw new Refused("That printer is no longer there. Reload the page.");
    return `${v.name} saved.`;
  });
}

// Step 2, saved as a whole: each store's receipt printer, the one-printer
// switch, and the printers of every category.
async function saveRoutes(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    // each store's own choice of receipt printer, or none
    const picks = receiptPicks(f);
    const one = on(f, "one");
    const pairs = f.getAll("route").map((v) => String(v).toLowerCase()).filter((v) => PAIR.test(v));
    if (one && (picks.length === 0 || picks.some((x) => !x.printer))) {
      throw new Refused("With one printer for everything, choose which printer that is, under Receipts and bills.");
    }
    // one printer per store is where the cashier's receipts come out
    for (const x of picks) {
      const set = await saves.setReceiptPrinter(c, ctx.tenantId, x.store, x.printer);
      if (set === "no-store") throw new Refused("That store is gone. Reload the page.");
      if (set === "no-printer") throw new Refused("That printer is no longer there. Reload the page.");
    }
    await saveSettings(c, ctx.tenantId, { onePrinter: one });
    // each category's printers are the ones ticked for it; a category that did not change is left alone
    await c.query(
      `with want as (
         select k.id, coalesce((select array_agg(p.id order by p.sort_order, p.name) from printers p
                                 where p.tenant_id = $1 and p.deleted_at is null and (k.id::text || ':' || p.id::text) = any($2::text[])), '{}'::uuid[]) as ids
           from categories k where k.tenant_id = $1 and k.deleted_at is null)
       update categories k set printer_ids = w.ids from want w
        where k.id = w.id and k.tenant_id = $1 and k.printer_ids is distinct from w.ids`,
      [ctx.tenantId, pairs],
    );
    return one ? "Saved. Everything prints on one printer once the tills have synced." : "Saved. The tills follow once they have synced.";
  });
}

function Hardware({ p }: { p?: Row }) {
  return (
    <>
      <div className="form-row">
        <label className="field">
          Name
          <input name="name" defaultValue={p?.name} required maxLength={40} placeholder="Kitchen" />
          <span className="help">Where it stands: Cashier, Kitchen, Bar. It is what the kitchen display calls its station.</span>
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
            <input type="checkbox" name="cut" defaultChecked={p?.cut ?? true} />
            <span>Cut the paper after each print</span>
          </label>
          {p && (
            <label className="check">
              <input type="checkbox" name="is_active" defaultChecked={p.is_active} />
              <span>
                Switched on
                <small>Off, nothing is sent to it, and what it printed prints nowhere until it is back on.</small>
              </span>
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
  const { stores, rows, cats, one } = await readTenant(ctx.tenantId, async (c) => ({
    stores: (await c.query(`select id, name from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId])).rows as { id: string; name: string }[],
    rows: (
      await c.query(
        `select id, store_id, name, kind, address, paper_mm, is_receipt, feed_lines, cut, is_active
           from printers where tenant_id = $1 and deleted_at is null order by sort_order, name`,
        [ctx.tenantId],
      )
    ).rows as Row[],
    cats: (
      await c.query(`select id, name, printer_ids::text[] as printer_ids from categories where tenant_id = $1 and deleted_at is null order by sort_order, name`, [
        ctx.tenantId,
      ])
    ).rows as Cat[],
    one: (await loadSettings(c, ctx.tenantId)).onePrinter,
  }));
  const notes = printerWarnings(rows, cats, one, stores);
  // with several stores, a printer is added to the store it stands in and is named with it
  const many = stores.length > 1;
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  return (
    <div>
      <PageHead
        title="Printers"
        lede="Two steps: set up each printer, then say what prints where. The tablet prints to them directly, so they work without internet."
      />
      <Flash sp={sp} />
      {notes.length > 0 && (
        <div className="note warn" role="status">
          <strong>Worth a look before service</strong>
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      <h2>1 · Your printers</h2>
      {/* its form is the whole of a printer: it opens, like the printers under it */}
      <details className="card flush" open={rows.length === 0}>
        <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
          <div>
            <h2>Add a printer</h2>
            <p>One for each printer in the restaurant, even if there is only one. What it prints is said in step 2.</p>
          </div>
          <span className="btn-quiet btn-sm">Open</span>
        </summary>
        <form action={addPrinter}>
          <div className="card-body">
            {many ? (
              <div className="form-row">
                <label className="field">
                  Store
                  <select name="store_id" defaultValue={stores[0].id}>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="help">The store this printer stands in. A store&apos;s first printer prints its receipts and bills.</span>
                </label>
              </div>
            ) : (
              stores.length === 1 && <input type="hidden" name="store_id" value={stores[0].id} />
            )}
            <Hardware />
          </div>
          <div className="card-foot">
            <Submit>Add printer</Submit>
          </div>
        </form>
      </details>
      {rows.length === 0 && (
        <Empty icon={Printer} title="No printers yet">
          Add the printer at the till first. If it is the only one, it can print the kitchen orders too.
        </Empty>
      )}
      {rows.map((p) => {
        const prints = cats.filter((k) => k.printer_ids.includes(p.id)).length;
        return (
          <details key={p.id} className="card flush">
            <summary className="card-head" style={{ cursor: "pointer", listStyle: "none" }}>
              <div>
                <h2>{p.name}</h2>
                <p>
                  {p.kind === "usb" ? "USB" : p.address} · {p.paper_mm} mm
                  {many ? ` · ${storeName.get(p.store_id) ?? ""}` : ""}
                </p>
              </div>
              <span className="row-actions">
                {one && p.is_receipt ? (
                  <span className="badge blue">Everything</span>
                ) : (
                  <>
                    {p.is_receipt && <span className="badge blue">Receipts and bills</span>}
                    {!one && prints > 0 && <span className="badge">Kitchen orders</span>}
                  </>
                )}
                <span className={"badge " + (p.is_active ? "green" : "red")}>{p.is_active ? "On" : "Off"}</span>
              </span>
            </summary>
            <form action={savePrinter}>
              <input type="hidden" name="id" value={p.id} />
              <div className="card-body">
                <Hardware p={p} />
              </div>
              <div className="card-foot">
                <Submit name="remove" value="1" className="btn-danger" formNoValidate>
                  Remove
                </Submit>
                <Submit>Save printer</Submit>
              </div>
            </form>
          </details>
        );
      })}

      {rows.length > 0 && (
        <>
          <h2 style={{ marginTop: 28 }}>2 · What prints where</h2>
          <form action={saveRoutes} className="card flush">
            <div className="card-body">
              {/* a store's receipts come out on one of its own printers: one choice per store that has printers */}
              {stores
                .map((s) => ({ s, own: rows.filter((p) => p.store_id === s.id) }))
                .filter(({ own }) => own.length > 0)
                .map(({ s, own }) => (
                  <label className="field" key={s.id}>
                    Receipts and bills{many ? ` · ${s.name}` : ""}
                    <select name={receiptField(s.id)} defaultValue={own.find((p) => p.is_receipt)?.id ?? ""}>
                      <option value="">No printer</option>
                      {own.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.is_active ? "" : " (switched off)"}
                        </option>
                      ))}
                    </select>
                    <span className="help">Receipts, bills, cash slips and closing reports come out here, and it opens the cash drawer.</span>
                  </label>
                ))}
              <label className="check">
                <input type="checkbox" name="one" defaultChecked={one} />
                <span>
                  One printer for everything
                  <small>
                    For a restaurant with a single printer. Kitchen orders print on the same printer as the receipts and bills, each on its own slip headed
                    KITCHEN ORDER, and a category added later is covered without doing anything. The ticks below are kept, but not used while this is on.
                  </small>
                </span>
              </label>
            </div>
            <div className="card-head" style={{ borderTop: "1px solid var(--glass-line)" }}>
              <div>
                <h2>Kitchen orders, by category</h2>
                <p>
                  Tick where each category&apos;s items come out when an order is sent: food in the kitchen, drinks at the bar. A category can print in more than
                  one place, and each printer ticked here is a station on the till&apos;s kitchen display.
                </p>
              </div>
            </div>
            {cats.length === 0 ? (
              <div className="card-body">
                <span className="muted">
                  No categories yet. Add them under <Link href="/backoffice/categories">Categories</Link> first.
                </span>
              </div>
            ) : (
              <div className="table-scroll" style={one ? { opacity: 0.55 } : undefined}>
                <table style={{ minWidth: 0 }}>
                  <thead>
                    <tr>
                      <th>Category</th>
                      {rows.map((p) => (
                        <th key={p.id} style={{ textAlign: "center" }}>
                          {p.name}
                          {many ? ` · ${storeName.get(p.store_id) ?? ""}` : ""}
                          {p.is_active ? "" : " (off)"}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cats.map((k) => (
                      <tr key={k.id}>
                        <td className="strong">{k.name}</td>
                        {rows.map((p) => (
                          <td key={p.id} style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              name="route"
                              value={`${k.id}:${p.id}`}
                              defaultChecked={k.printer_ids.includes(p.id)}
                              aria-label={`${k.name} prints on ${p.name}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-foot">
              <Submit>Save what prints where</Submit>
            </div>
          </form>
        </>
      )}
      <p className="muted">
        A test print for each printer is on the tablet, under Settings, Printers: it also shows whether each one is answering. Where a category prints can be set
        from its side too, under <Link href="/backoffice/categories">Categories</Link>.
      </p>
    </div>
  );
}
