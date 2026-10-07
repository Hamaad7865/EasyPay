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
export async function saveBooking(c: PoolClient, tenantId: string, id: string, b: BookingForm, status: string): Promise<"ok" | "no-table"> {
  if (b.table) {
    const at = await c.query(`select store_id from bookings where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, id]);
    if (at.rowCount === 1 && !(await tableOf(c, tenantId, at.rows[0].store_id as string, b.table))) return "no-table";
  }
  await c.query(
    `update bookings bk set booked_for = ($3 || ' ' || $4)::timestamp at time zone s.timezone, name = $5, size = $6, phone = $7, tags = $8,
            table_id = (select tb.id from tables tb where tb.tenant_id = bk.tenant_id and tb.store_id = bk.store_id and tb.id = $9::uuid and tb.deleted_at is null),
            area = coalesce((select tb.area from tables tb where tb.tenant_id = bk.tenant_id and tb.store_id = bk.store_id and tb.id = $9::uuid and tb.deleted_at is null), bk.area),
            status = $10
       from stores s
      where bk.tenant_id = $1 and bk.id = $2 and bk.deleted_at is null and s.tenant_id = bk.tenant_id and s.id = bk.store_id`,
    [tenantId, id, b.day, b.time, b.name, b.size, b.phone, b.tags, b.table, status],
  );
  return "ok";
}

// Is this one of the store's tables, still on its floor plan?
async function tableOf(c: PoolClient, tenantId: string, store: string, table: string): Promise<boolean> {
  const r = await c.query(`select 1 from tables where tenant_id = $1 and store_id = $2 and id = $3 and deleted_at is null`, [tenantId, store, table]);
  return r.rowCount === 1;
}

export type PrinterForm = { name: string; kind: "network" | "usb"; address: string | null; paper: number; feed: number; cut: boolean };

// A printer added to one of the restaurant's stores. The first printer of a
// store is where its receipts come out, until the owner says otherwise. Null
// when the store is not one of the restaurant's: no printer is added.
export async function addPrinter(c: PoolClient, tenantId: string, store: string, v: PrinterForm): Promise<{ first: boolean } | null> {
  const st = await c.query(`select id from stores where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, store]);
  if (st.rowCount !== 1) return null;
  const first = (await c.query(`select 1 from printers where tenant_id = $1 and store_id = $2 and deleted_at is null limit 1`, [tenantId, store])).rowCount === 0;
  await c.query(
    `insert into printers (tenant_id, store_id, name, kind, address, paper_mm, is_receipt, feed_lines, cut, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = $1))`,
    [tenantId, store, v.name, v.kind, v.address, v.paper, first, v.feed, v.cut],
  );
  return { first };
}

// Which printer the cashier's receipts and bills come out on: one per store.
// The printer picked takes over in its own store, and the other stores are
// left alone; "no-printer" when it is not there any more, and nothing changes.
// With no printer picked, receipts come off the first store's printers, as
// before there could be more than one store.
export async function setReceiptPrinter(c: PoolClient, tenantId: string, receipt: string | null): Promise<"ok" | "no-store" | "no-printer"> {
  const st = receipt
    ? await c.query(`select store_id as id from printers where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, receipt])
    : await c.query(`select id from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [tenantId]);
  if (st.rowCount !== 1) return receipt ? "no-printer" : "no-store";
  await c.query(
    `update printers set is_receipt = coalesce(id = $2::uuid, false)
      where tenant_id = $1 and store_id = $3 and deleted_at is null and is_receipt is distinct from coalesce(id = $2::uuid, false)`,
    [tenantId, receipt, st.rows[0].id],
  );
  return "ok";
}
