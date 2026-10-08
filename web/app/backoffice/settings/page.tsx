import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, int, on, Refused, text, uuid } from "@/lib/action";
import { loadSettings, money, saveSettings } from "@/lib/settings";
import { Card, Flash, one, PageHead, type Search } from "../ui";
import { Submit, Wait } from "../busy";

const PATH = "/backoffice/settings";
const KINDS = [
  ["cash", "Cash"],
  ["card", "Card"],
  ["wallet", "Mobile wallet"],
  ["qr", "QR payment"],
  ["other", "Other"],
] as const;
const ORDER_KINDS = [
  ["dine", "At a table"],
  ["counter", "Counter sale (Quick sale)"],
  ["takeaway", "Takeaway (on the board)"],
  ["delivery", "Delivery (on the board, with an address)"],
  ["tab", "Named tab"],
] as const;
const KITCHEN = [
  ["save", "When Send is pressed"],
  ["pay", "When the bill is paid"],
  ["off", "Never"],
] as const;

async function saveGeneral(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const decimals = int(f, "decimals", 0, 2, 2) as 0 | 1 | 2;
    await saveSettings(c, ctx.tenantId, {
      decimals,
      billNumbering: f.get("billNumbering") === "reset" ? "reset" : "continuous",
      dayCloseDetailed: on(f, "dayCloseDetailed"),
      drawerByNotes: on(f, "drawerByNotes"),
      lockMinutes: int(f, "lockMinutes", 0, 120, 0),
      // a shop's form has no Service card: what those settings held is left as it is
      ...(ctx.mode === "retail"
        ? {}
        : {
            servicePct: int(f, "servicePct", 0, 30, 0),
            prepMinutes: int(f, "prepMinutes", 1, 180, 15),
            kitchenSound: on(f, "kitchenSound"),
            kitchenNotes: String(f.get("kitchenNotes") ?? "").split("\n").map((n) => n.trim().slice(0, 40)).filter(Boolean).slice(0, 12),
          }),
    });
    return "Settings saved. The tills pick them up the next time they sync.";
  });
}

// A shop's own barcodes (migration 0080): the digits they begin with, and
// whether a product added with none is given one by itself.
async function saveBarcodes(f: FormData) {
  "use server";
  await act("settings.device", PATH + "?tab=barcodes", async (c, ctx) => {
    if (ctx.mode !== "retail") throw new Refused("Barcodes are a shop's setting.");
    const prefix = text(f, "prefix", 12).replace(/\s+/g, "");
    if (!/^[0-9]{2,7}$/.test(prefix)) throw new Refused("The digits your barcodes begin with are 2 to 7 digits, for example 200.");
    try {
      await c.query(`select barcode_settings_save($1, $2, $3)`, [ctx.tenantId, prefix, on(f, "auto")]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("prefix-too-long")) {
        throw new Refused("That is too many digits: the barcodes already made would no longer fit behind them. Use a shorter one.");
      }
      throw e;
    }
    return "Barcode settings saved. Barcodes already made keep the digits they were made with.";
  });
}

async function addPayment(f: FormData) {
  "use server";
  await act("settings.device", PATH + "?tab=payments", async (c, ctx) => {
    const name = text(f, "name", 40);
    const kind = String(f.get("kind"));
    if (!name) throw new Refused("Give the payment option a name.");
    if (!KINDS.some(([k]) => k === kind)) throw new Refused("Pick what kind of payment it is.");
    await c.query(
      `insert into payment_types (tenant_id, name, kind, opens_drawer, sort_order)
       values ($1, $2, $3, $4, (select coalesce(max(sort_order), -1) + 1 from payment_types where tenant_id = $1))`,
      [ctx.tenantId, name, kind, kind === "cash"],
    );
    return `${name} added.`;
  });
}

async function savePayment(f: FormData) {
  "use server";
  await act("settings.device", PATH + "?tab=payments", async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      const left = await c.query(
        `select count(*)::int as n from payment_types where tenant_id = $1 and deleted_at is null and is_active and id <> $2 and kind <> 'exchange'`,
        [ctx.tenantId, id],
      );
      if (left.rows[0].n === 0) throw new Refused("Keep at least one payment option switched on, or the tills cannot take a payment.");
      // (a shop's Exchange type is not a payment option: it settles exchanges, and stays)
      await c.query(`update payment_types set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null and kind <> 'exchange'`, [ctx.tenantId, id]);
      return "Payment option removed. Receipts already paid with it keep its name.";
    }
    const name = text(f, "name", 40);
    const kind = String(f.get("kind"));
    if (!name || !KINDS.some(([k]) => k === kind)) throw new Refused("A payment option needs a name and a kind.");
    await c.query(
      `update payment_types set name = $3, kind = $4, opens_drawer = $5, is_active = $6, sort_order = $7
        where tenant_id = $1 and id = $2 and deleted_at is null and kind <> 'exchange'`,
      [ctx.tenantId, id, name, kind, on(f, "opens_drawer"), on(f, "is_active"), int(f, "sort_order", 0, 999, 0)],
    );
    return `${name} saved.`;
  });
}

async function addDining(f: FormData) {
  "use server";
  await act("settings.device", PATH + "?tab=orders", async (c, ctx) => {
    const name = text(f, "name", 40);
    const kind = String(f.get("kind"));
    if (!name) throw new Refused("Give the order type a name.");
    if (!ORDER_KINDS.some(([k]) => k === kind)) throw new Refused("Pick what kind of order it is.");
    await c.query(
      `insert into dining_options (tenant_id, name, kind, needs_table, kitchen, sort_order)
       values ($1, $2, $3, $4, $5, (select coalesce(max(sort_order), -1) + 1 from dining_options where tenant_id = $1))`,
      [ctx.tenantId, name, kind, kind === "dine", kind === "dine" || kind === "tab" ? "save" : "pay"],
    );
    return `${name} added.`;
  });
}

async function saveDining(f: FormData) {
  "use server";
  await act("settings.device", PATH + "?tab=orders", async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      const row = await c.query(`select is_default from dining_options where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      if (row.rows[0]?.is_default) throw new Refused("This is the order type a new order starts with. Make another one the default first.");
      await c.query(`update dining_options set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Order type removed.";
    }
    const name = text(f, "name", 40);
    const kitchen = String(f.get("kitchen"));
    const kind = String(f.get("kind"));
    if (!name || !KITCHEN.some(([k]) => k === kitchen)) throw new Refused("An order type needs a name.");
    if (!ORDER_KINDS.some(([k]) => k === kind)) throw new Refused("Pick what kind of order it is.");
    if (on(f, "is_default")) {
      await c.query(`update dining_options set is_default = false where tenant_id = $1 and is_default and id <> $2`, [ctx.tenantId, id]);
    }
    await c.query(
      `update dining_options set name = $3, needs_table = $4, kitchen = $5, is_default = is_default or $6, kind = $7
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id, name, kind === "dine", kitchen, on(f, "is_default"), kind],
    );
    return `${name} saved.`;
  });
}

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  // a shop has no order types: its address for that tab shows General
  // nor a restaurant barcodes of its own
  const tab = one(sp.tab) === "payments" ? "payments" : one(sp.tab) === "orders" && !shop ? "orders" : one(sp.tab) === "barcodes" && shop ? "barcodes" : "general";
  const data = await readTenant(ctx.tenantId, async (c) => ({
    settings: await loadSettings(c, ctx.tenantId),
    payments: (
      await c.query(
        `select id, name, kind, opens_drawer, is_active, sort_order from payment_types
          where tenant_id = $1 and deleted_at is null and kind <> 'exchange' order by sort_order, name`,
        [ctx.tenantId],
      )
    ).rows as { id: string; name: string; kind: string; opens_drawer: boolean; is_active: boolean; sort_order: number }[],
    dining: (
      await c.query(
        `select id, name, kind, needs_table, kitchen, is_default from dining_options
          where tenant_id = $1 and deleted_at is null order by sort_order, name`,
        [ctx.tenantId],
      )
    ).rows as { id: string; name: string; kind: string; needs_table: boolean; kitchen: string; is_default: boolean }[],
    barcodes: shop
      ? ((await c.query(`select barcode_settings($1) as r`, [ctx.tenantId])).rows[0].r as {
          prefix: string; auto: boolean; next: string | null; left: number; made: number; without: number;
        })
      : null,
  }));
  const bc = data.barcodes;
  const s = data.settings;
  return (
    <div>
      <PageHead title="POS settings" lede="How the tills behave. A change reaches a till the next time it syncs, which is within a minute when it is online." />
      <Flash sp={sp} />
      <div className="tabs">
        <Link href={PATH} className={tab === "general" ? "on" : undefined}>General<Wait /></Link>
        <Link href={PATH + "?tab=payments"} className={tab === "payments" ? "on" : undefined}>Payment options<Wait /></Link>
        {!shop && <Link href={PATH + "?tab=orders"} className={tab === "orders" ? "on" : undefined}>Order types and kitchen<Wait /></Link>}
        {shop && <Link href={PATH + "?tab=barcodes"} className={tab === "barcodes" ? "on" : undefined}>Barcodes<Wait /></Link>}
      </div>

      {tab === "barcodes" && bc && (
        <form action={saveBarcodes}>
          <Card title="Your own barcodes">
            <div className="setting">
              <div>
                <strong>The digits they begin with</strong>
                <small>
                  A barcode EasyPay makes is 13 digits (EAN-13): these digits, then a number that counts up. Barcodes beginning with 20 to 29
                  are kept for a shop&apos;s own labels, so they never clash with a maker&apos;s. If your scale prints labels that hold a weight or a price,
                  use digits the scale does not. Changing them changes the barcodes made from now on, not the ones already on your goods.
                </small>
              </div>
              <input name="prefix" defaultValue={bc.prefix} inputMode="numeric" pattern="[0-9]{2,7}" maxLength={7} required aria-label="The digits they begin with" style={{ width: 120 }} />
            </div>
            <div className="setting">
              <div>
                <strong>Make one when a product is added</strong>
                <small>
                  On: a product or a variant added with no barcode is given one of yours at once, here and from an imported file. A product that
                  comes with its maker&apos;s barcode keeps it. Off: you make them when you want, on the product&apos;s page or on Barcode labels.
                </small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" name="auto" defaultChecked={bc.auto} />
                Automatically
              </label>
            </div>
            <div className="setting">
              <div>
                <strong>The next barcode</strong>
                <small>
                  {bc.made === 0 ? "None made yet." : `${bc.made.toLocaleString("en-US")} made so far.`}{" "}
                  {bc.next ? `Room for ${bc.left.toLocaleString("en-US")} more behind these digits.` : "There is no room left behind these digits: use fewer digits to make more."}
                  {bc.without > 0 && (
                    <>
                      {" "}{bc.without === 1 ? "One line has" : `${bc.without.toLocaleString("en-US")} lines have`} no barcode yet: give them one on{" "}
                      <Link href="/backoffice/items/labels">Barcode labels</Link>.
                    </>
                  )}
                </small>
              </div>
              <code style={{ fontSize: 16, letterSpacing: "0.04em" }}>{bc.next ?? "None left"}</code>
            </div>
          </Card>
          <div className="bo-toolbar" style={{ justifyContent: "flex-end" }}>
            <Submit>Save</Submit>
          </div>
        </form>
      )}

      {tab === "general" && (
        <form action={saveGeneral}>
          <Card title="Amounts">
            <div className="setting">
              <div>
                <strong>Decimals</strong>
                <small>How amounts are shown and printed. With no decimals, a total is rounded to the nearest rupee and the receipt shows the rounding.</small>
              </div>
              <div className="seg">
                {([0, 1, 2] as const).map((d) => (
                  <label key={d}>
                    <input type="radio" name="decimals" value={d} defaultChecked={s.decimals === d} />
                    {money(125000, d)}
                  </label>
                ))}
              </div>
            </div>
          </Card>
          <Card title="Closing the day">
            <div className="setting">
              <div>
                <strong>Count the drawer by notes and coins</strong>
                <small>
                  Off: the cash counted is typed on the till as one amount, which starts on what the drawer should hold for someone
                  allowed to see the day&apos;s figures. On: the till asks how many of each note and coin there are, and adds them up.
                </small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" name="drawerByNotes" defaultChecked={s.drawerByNotes} />
                By notes and coins
              </label>
            </div>
            <div className="setting">
              <div>
                <strong>Detailed day closing report</strong>
                <small>On: the report also breaks sales down by category and by tax. Off: it shows the totals, the payment methods and the cash in and out, with no categories.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" name="dayCloseDetailed" defaultChecked={s.dayCloseDetailed} />
                Detailed
              </label>
            </div>
            <div className="setting">
              <div>
                <strong>Bill numbers</strong>
                <small>
                  Keep counting is the safe choice: every bill has its own number for good. Starting again from 1 after each day
                  closing puts the closing number in front, so two bills still never share a number. Check with your accountant
                  that this suits the MRA before choosing it.
                </small>
              </div>
              <div className="seg">
                <label>
                  <input type="radio" name="billNumbering" value="continuous" defaultChecked={s.billNumbering === "continuous"} />
                  Keep counting
                </label>
                <label>
                  <input type="radio" name="billNumbering" value="reset" defaultChecked={s.billNumbering === "reset"} />
                  Start again each day
                </label>
              </div>
            </div>
          </Card>
          {!shop && (
          <Card title="Service">
            <div className="setting">
              <div>
                <strong>Service charge</strong>
                <small>A percentage added to orders served at a table, shown on the bill and the receipt as its own line. 0 means none. Counter sales, takeaways and deliveries never carry it.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input name="servicePct" type="number" min={0} max={30} defaultValue={s.servicePct} className="narrow" aria-label="Service charge percent" />%
              </label>
            </div>
            <div className="setting">
              <div>
                <strong>Takeaway time</strong>
                <small>How many minutes after it is rung up a takeaway is due on the till&apos;s board. A delivery gets twice as long. The time can be moved on the board.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input name="prepMinutes" type="number" min={1} max={180} defaultValue={s.prepMinutes} className="narrow" aria-label="Takeaway minutes" />
                minutes
              </label>
            </div>
            <div className="setting">
              <div>
                <strong>Kitchen notes</strong>
                <small>What a waiter can tick when adding an item, one per line, up to twelve. They print on the kitchen ticket and show on the kitchen display.</small>
              </div>
              <textarea name="kitchenNotes" rows={5} defaultValue={s.kitchenNotes.join("\n")} aria-label="Kitchen notes" style={{ minWidth: 260 }} />
            </div>
            <div className="setting">
              <div>
                <strong>Sound on the kitchen display</strong>
                <small>A short sound when an order arrives on a tablet that is showing the kitchen display.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" name="kitchenSound" defaultChecked={s.kitchenSound} />
                Play it
              </label>
            </div>
          </Card>
          )}
          <Card title="Security">
            <div className="setting">
              <div>
                <strong>Lock the till when it is left alone</strong>
                <small>After this many minutes without a touch the till goes back to its start screen, where a name and its PIN open it again. The order on screen is kept. 0 means never. The kitchen display and a payment in progress do not lock.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input name="lockMinutes" type="number" min={0} max={120} defaultValue={s.lockMinutes} className="narrow" aria-label="Lock after minutes" />
                minutes
              </label>
            </div>
          </Card>
          <Submit>Save settings</Submit>
        </form>
      )}

      {tab === "payments" && (
        <>
          <Card title="Add a payment option">
            <form action={addPayment} className="bo-toolbar" style={{ margin: 0 }}>
              <input name="name" placeholder="Name, for example Gift voucher" required maxLength={40} style={{ minWidth: 260 }} />
              <select name="kind" defaultValue="other" aria-label="Kind">
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <Submit>Add</Submit>
            </form>
          </Card>
          <Card title="Payment options" lede="What a cashier can pick on the payment screen, in this order. The cash drawer opens only for the ones ticked." flush>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Order</th>
                  <th>Opens the drawer</th>
                  <th>On the till</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td><input form={"p" + p.id} name="name" defaultValue={p.name} required maxLength={40} aria-label="Name" /></td>
                    <td>
                      <select form={"p" + p.id} name="kind" defaultValue={p.kind} aria-label="Kind">
                        {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                    </td>
                    <td><input form={"p" + p.id} name="sort_order" type="number" min={0} max={999} defaultValue={p.sort_order} className="narrow" aria-label="Order" /></td>
                    <td><input form={"p" + p.id} name="opens_drawer" type="checkbox" defaultChecked={p.opens_drawer} aria-label="Opens the drawer" /></td>
                    <td><input form={"p" + p.id} name="is_active" type="checkbox" defaultChecked={p.is_active} aria-label="On the till" /></td>
                    <td>
                      <form id={"p" + p.id} action={savePayment} className="row-actions">
                        <input type="hidden" name="id" value={p.id} />
                        <Submit className="btn-quiet btn-sm">Save</Submit>
                        <Submit name="remove" value="1" className="btn-link danger">Remove</Submit>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {tab === "orders" && (
        <>
          <Card title="Add an order type">
            <form action={addDining} className="bo-toolbar" style={{ margin: 0 }}>
              <input name="name" placeholder="Name, for example Delivery" required maxLength={40} style={{ minWidth: 260 }} />
              <select name="kind" defaultValue="takeaway" aria-label="Kind">
                {ORDER_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <Submit>Add</Submit>
            </form>
          </Card>
          <Card
            title="Order types"
            lede="The kinds of order the tills take. At a table: opened from the floor plan. Counter sale: the Quick sale key. Takeaway and delivery: on the takeaway board until they have left. The kitchen column says when an order's items go to the kitchen printers and the kitchen display."
            flush
          >
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Send to the kitchen</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.dining.map((d) => (
                  <tr key={d.id}>
                    <td><input form={"d" + d.id} name="name" defaultValue={d.name} required maxLength={40} aria-label="Name" /></td>
                    <td>
                      <select form={"d" + d.id} name="kind" defaultValue={d.kind} aria-label="Kind">
                        {ORDER_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select form={"d" + d.id} name="kitchen" defaultValue={d.kitchen} aria-label="Send to the kitchen">
                        {KITCHEN.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                    </td>
                    <td>
                      {d.is_default ? <span className="badge blue">Default</span> : (
                        <label className="check" style={{ margin: 0 }}>
                          <input form={"d" + d.id} name="is_default" type="checkbox" />
                          Make default
                        </label>
                      )}
                    </td>
                    <td>
                      <form id={"d" + d.id} action={saveDining} className="row-actions">
                        <input type="hidden" name="id" value={d.id} />
                        <Submit className="btn-quiet btn-sm">Save</Submit>
                        <Submit name="remove" value="1" className="btn-link danger">Remove</Submit>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
