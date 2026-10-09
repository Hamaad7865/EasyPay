import type { PoolClient } from "pg";

// What a few of the back office's forms do to the database, kept apart from
// their pages so that db/tests/backoffice-saves.test.cjs can run them as the
// restaurant's own connection. Each says whether it did what was asked: the
// page turns a "no" into the sentence the owner reads, and nothing is saved.

// One tax per item: the others are taken off, the chosen one put (back) on.
// False when the tax is not one of the restaurant's (it was removed while the
// item's panel was open): nothing is touched, so the item keeps the tax it had.
export async function setItemTax(c: PoolClient, tenantId: string, item: string, tax: string): Promise<boolean> {
  const live = await c.query(`select 1 from taxes where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, tax]);
  if (live.rowCount !== 1) return false;
  await c.query(`update item_taxes set deleted_at = now() where tenant_id = $1 and item_id = $2 and tax_id <> $3 and deleted_at is null`, [tenantId, item, tax]);
  await c.query(
    `insert into item_taxes (tenant_id, item_id, tax_id)
       select $1, $2, t.id from taxes t where t.tenant_id = $1 and t.id = $3 and t.deleted_at is null
     on conflict (item_id, tax_id) do update set deleted_at = null`,
    [tenantId, item, tax],
  );
  return true;
}

// A choice added to a group of add-ons. False when the group is not there any
// more (it was removed in another tab): there is nothing to add the choice to.
export async function addChoice(c: PoolClient, tenantId: string, group: string, name: string, price: number): Promise<boolean> {
  const r = await c.query(
    `insert into modifiers (tenant_id, group_id, name, price)
       select $1, g.id, $3, $4 from modifier_groups g where g.tenant_id = $1 and g.id = $2 and g.deleted_at is null`,
    [tenantId, group, name, price],
  );
  return r.rowCount === 1;
}

export type BookingForm = { day: string; time: string; name: string; size: number; phone: string | null; tags: string | null; table: string | null };

// A booking taken in the back office. The day and time are the restaurant's
// own: they become a moment with the store's time zone. "no-store" when the
// store is gone; "no-table" when the table picked is not one of that store's
// (it belongs to another store, or was removed meanwhile). Either way no
// booking is taken.
export async function addBooking(c: PoolClient, tenantId: string, store: string, b: BookingForm): Promise<"ok" | "no-store" | "no-table"> {
  if (b.table && !(await tableOf(c, tenantId, store, b.table))) return "no-table";
  const r = await c.query(
    `insert into bookings (tenant_id, store_id, booked_for, name, size, phone, tags, table_id, area, status)
     select s.tenant_id, s.id, ($3 || ' ' || $4)::timestamp at time zone s.timezone, $5, $6, $7, $8, tb.id, tb.area, 'confirmed'
       from stores s left join tables tb on tb.tenant_id = s.tenant_id and tb.store_id = s.id and tb.id = $9::uuid and tb.deleted_at is null
      where s.tenant_id = $1 and s.id = $2 and s.deleted_at is null`,
    [tenantId, store, b.day, b.time, b.name, b.size, b.phone, b.tags, b.table],
  );
  return r.rowCount === 0 ? "no-store" : "ok";
}

// A booking changed from the list of bookings. "no-table" when the table
// picked is not one of the booking's own store: the booking is left as it was.
// "gone" when the booking itself was removed meanwhile.
export async function saveBooking(c: PoolClient, tenantId: string, id: string, b: BookingForm, status: string): Promise<"ok" | "no-table" | "gone"> {
  if (b.table) {
    const at = await c.query(`select store_id from bookings where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, id]);
    if (at.rowCount === 1 && !(await tableOf(c, tenantId, at.rows[0].store_id as string, b.table))) return "no-table";
  }
  const r = await c.query(
    `update bookings bk set booked_for = ($3 || ' ' || $4)::timestamp at time zone s.timezone, name = $5, size = $6, phone = $7, tags = $8,
            table_id = (select tb.id from tables tb where tb.tenant_id = bk.tenant_id and tb.store_id = bk.store_id and tb.id = $9::uuid and tb.deleted_at is null),
            area = coalesce((select tb.area from tables tb where tb.tenant_id = bk.tenant_id and tb.store_id = bk.store_id and tb.id = $9::uuid and tb.deleted_at is null), bk.area),
            status = $10
       from stores s
      where bk.tenant_id = $1 and bk.id = $2 and bk.deleted_at is null and s.tenant_id = bk.tenant_id and s.id = bk.store_id`,
    [tenantId, id, b.day, b.time, b.name, b.size, b.phone, b.tags, b.table, status],
  );
  return r.rowCount === 1 ? "ok" : "gone";
}

// Is this one of the store's tables, still on its floor plan?
async function tableOf(c: PoolClient, tenantId: string, store: string, table: string): Promise<boolean> {
  const r = await c.query(`select 1 from tables where tenant_id = $1 and store_id = $2 and id = $3 and deleted_at is null`, [tenantId, store, table]);
  return r.rowCount === 1;
}

// A printer, or a kitchen screen (0086): a tablet in the kitchen that shows
// the orders, reached at its address like a printer. A screen has the pairing
// code its tablet shows (`pair`) and may show every item (`all`); otherwise
// it shows the categories ticked for it. A printer has neither.
export type PrinterForm = {
  name: string; kind: "network" | "usb" | "bluetooth" | "screen"; address: string | null; paper: number; feed: number; cut: boolean;
  pair?: string | null; all?: boolean;
};

// A printer added to one of the restaurant's stores. The first printer of a
// store is where its receipts come out, until the owner says otherwise. A
// kitchen screen prints nothing: it is never that printer, and a restaurant
// that enters its screen before its printer still has its first printer made
// the receipt printer. Null when the store is not one of the restaurant's:
// nothing is added.
export async function addPrinter(c: PoolClient, tenantId: string, store: string, v: PrinterForm): Promise<{ first: boolean } | null> {
  const st = await c.query(`select id from stores where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, store]);
  if (st.rowCount !== 1) return null;
  const screen = v.kind === "screen";
  const first =
    !screen &&
    (await c.query(`select 1 from printers where tenant_id = $1 and store_id = $2 and deleted_at is null and kind <> 'screen' limit 1`, [tenantId, store])).rowCount === 0;
  await c.query(
    `insert into printers (tenant_id, store_id, name, kind, address, paper_mm, is_receipt, feed_lines, cut, pair_code, all_items, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = $1))`,
    [tenantId, store, v.name, v.kind, v.address, v.paper, first, v.feed, v.cut, screen ? (v.pair ?? null) : null, screen && v.all === true],
  );
  return { first };
}

// Which printer a store's receipts and bills come out on: one per store, or
// none. The printer has to be one of that store's own: "no-printer" when it is
// not (it was removed meanwhile, or stands in another store), "no-store" when
// the store is not the restaurant's, "screen" when it is a kitchen screen,
// which prints nothing. Either way nothing changes, and no other store is
// touched.
export async function setReceiptPrinter(
  c: PoolClient, tenantId: string, store: string, receipt: string | null,
): Promise<"ok" | "no-store" | "no-printer" | "screen"> {
  const st = await c.query(`select 1 from stores where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, store]);
  if (st.rowCount !== 1) return "no-store";
  if (receipt) {
    const own = await c.query(`select kind from printers where tenant_id = $1 and store_id = $2 and id = $3 and deleted_at is null`, [tenantId, store, receipt]);
    if (own.rowCount !== 1) return "no-printer";
    if (own.rows[0].kind === "screen") return "screen";
  }
  await c.query(
    `update printers set is_receipt = coalesce(id = $2::uuid, false)
      where tenant_id = $1 and store_id = $3 and deleted_at is null and is_receipt is distinct from coalesce(id = $2::uuid, false)`,
    [tenantId, receipt, store],
  );
  return "ok";
}

// A change to a row that is already there. False when the row is not (it was
// removed in another tab while this form was open): nothing was changed, and
// the page must not say "saved".

// An add-on group: its name and how many of its choices may be picked.
export async function saveGroup(c: PoolClient, tenantId: string, id: string, name: string, min: number, max: number): Promise<boolean> {
  const r = await c.query(`update modifier_groups set name = $3, min_select = $4, max_select = $5 where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, id, name, min, max]);
  return r.rowCount === 1;
}

// A choice of an add-on group: its name and its price.
export async function saveChoice(c: PoolClient, tenantId: string, id: string, name: string, price: number): Promise<boolean> {
  const r = await c.query(`update modifiers set name = $3, price = $4 where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, id, name, price]);
  return r.rowCount === 1;
}

// A printer or a kitchen screen: how the tablet reaches it, and whether it is
// switched on. "receipt" when the row is the store's receipt printer and was
// asked to become a kitchen screen: receipts would have nowhere to come out,
// so nothing is changed. A screen switched on for a restaurant whose plan
// does not carry screens is refused by the database (not-premium, 0086).
export async function savePrinter(c: PoolClient, tenantId: string, id: string, v: PrinterForm, active: boolean): Promise<boolean | "receipt"> {
  const screen = v.kind === "screen";
  if (screen) {
    const now = await c.query(`select is_receipt from printers where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, id]);
    if (now.rows[0]?.is_receipt) return "receipt";
  }
  const r = await c.query(
    `update printers set name = $3, kind = $4, address = $5, paper_mm = $6, feed_lines = $7, cut = $8, is_active = $9, pair_code = $10, all_items = $11
      where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, id, v.name, v.kind, v.address, v.paper, v.feed, v.cut, active, screen ? (v.pair ?? null) : null, screen && v.all === true],
  );
  return r.rowCount === 1;
}

// A shop's product, as its page saves it (the row; its tax, codes and reorder
// level are saved beside it).
export type ProductRow = {
  tenantId: string; id: string; name: string; price: number; cost: number | null; category: string | null; brand: string | null;
  supplier: string | null; supplierCode: string | null; available: boolean; counted: boolean;
};

// False when the product to change is no longer there. A cost is only written
// by someone who may see cost: their form has no cost field, so what arrives
// from it is empty, and saving that would wipe the cost they cannot see. For
// anyone else the cost stays as it was, and a product they add has none.
export async function saveProductRow(c: PoolClient, editing: boolean, p: ProductRow, mayCost: boolean): Promise<boolean> {
  const row = [p.tenantId, p.id, p.name, p.price, mayCost ? p.cost : null, p.category, p.brand, p.supplier, p.supplierCode, p.available, p.counted];
  if (editing) {
    const done = await c.query(
      `update items set name = $3, price = $4, cost = case when $12 then $5::bigint else cost end, category_id = $6, brand = $7,
              supplier_id = (select s.id from suppliers s where s.tenant_id = $1 and s.id = $8 and s.deleted_at is null),
              supplier_code = $9, is_available = $10, track_stock = $11
        where tenant_id = $1 and id = $2 and deleted_at is null`,
      [...row, mayCost],
    );
    return done.rowCount === 1;
  }
  await c.query(
    `insert into items (tenant_id, id, name, price, cost, category_id, brand, supplier_id, supplier_code, is_available, track_stock)
     values ($1, $2, $3, $4, $5, $6, $7,
             (select s.id from suppliers s where s.tenant_id = $1 and s.id = $8 and s.deleted_at is null), $9, $10, $11)`,
    row,
  );
  // a shop that has its barcodes made automatically: the new product gets one now (migration 0080; nothing otherwise)
  await c.query(`select barcodes_auto($1, $2)`, [p.tenantId, p.id]);
  return true;
}

// After a file has been imported, in the same transaction: a shop that has
// its barcodes made automatically (migration 0080) gets one for every line
// the file added with none. Those are the products made in this transaction,
// and the products it added a variant to (now() is the transaction's own
// start, and a row's created_at is taken from it). A product that was there
// before and was not added to is left as it is. Returns how many were made;
// none when the shop makes its barcodes by hand.
export async function barcodesForNewLines(c: PoolClient, tenantId: string): Promise<number> {
  const r = await c.query(
    `select coalesce(sum(barcodes_auto($1, i.id)), 0)::int as n
       from items i
      where i.tenant_id = $1 and i.deleted_at is null
        and (i.created_at = now()
          or exists (select 1 from item_variants v where v.tenant_id = $1 and v.item_id = i.id and v.deleted_at is null and v.created_at = now()))`,
    [tenantId],
  );
  return r.rows[0].n as number;
}

export type VariantLine = { id: string; barcode: string | null; sku: string | null; price: number; cost: number | null };

// The lines of a product, saved together in one statement. Their costs are
// only written by someone who may see cost, as for the product itself.
export async function saveVariantLines(c: PoolClient, tenantId: string, item: string, lines: VariantLine[], mayCost: boolean): Promise<void> {
  await c.query(
    `update item_variants v set barcode = x.barcode, sku = x.sku, price = x.price, cost = case when $4 then x.cost else v.cost end
       from jsonb_to_recordset($3::jsonb) as x(id uuid, barcode text, sku text, price bigint, cost bigint)
      where v.tenant_id = $1 and v.item_id = $2 and v.id = x.id and v.deleted_at is null`,
    [tenantId, item, JSON.stringify(lines), mayCost],
  );
}
