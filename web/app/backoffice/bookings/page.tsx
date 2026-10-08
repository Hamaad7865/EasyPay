import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { PREMIUM_ONLY } from "@/lib/plan";
import { act, int, Refused, text, uuid } from "@/lib/action";
import * as saves from "@/lib/saves";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";
import { Submit, Wait } from "../busy";

const PATH = "/backoffice/bookings";
const STATUS = [
  ["pending", "To confirm"],
  ["confirmed", "Confirmed"],
  ["seated", "Seated"],
  ["noshow", "No-show"],
  ["cancelled", "Cancelled"],
] as const;
const NO_TABLE = "That table is not one of the booking's store. Pick another, or leave the table for later.";
// Bookings are a page of the premium tier (lib/plan.ts). The till's bookings
// are refused by the server the same way (0085).
const NOT_PREMIUM = `Bookings are ${PREMIUM_ONLY}. Nothing was changed.`;

// What a booking form holds. The day and time are the restaurant's own: they
// are turned into a moment with the store's time zone, in the query.
function fields(f: FormData) {
  const name = text(f, "name", 120);
  if (!name) throw new Refused("A booking needs the name it is under.");
  const day = String(f.get("day") ?? "");
  const time = String(f.get("time") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) throw new Refused("Pick the day and the time.");
  const table = String(f.get("table_id") ?? "");
  return {
    name,
    day,
    time,
    size: int(f, "size", 1, 99, 2),
    phone: text(f, "phone", 40) || null,
    tags: text(f, "tags", 240) || null,
    table: /^[0-9a-f-]{36}$/i.test(table) ? table : null,
  };
}

async function addBooking(f: FormData) {
  "use server";
  await act("backoffice.access", PATH, async (c, ctx) => {
    if (!ctx.premium) throw new Refused(NOT_PREMIUM);
    const b = fields(f);
    const done = await saves.addBooking(c, ctx.tenantId, uuid(f, "store_id"), b);
    if (done === "no-store") throw new Refused("That store is gone.");
    if (done === "no-table") throw new Refused(NO_TABLE);
    return `${b.name} is booked for ${b.size}. The tills have it after their next sync.`;
  });
}

async function saveBooking(f: FormData) {
  "use server";
  await act("backoffice.access", PATH, async (c, ctx) => {
    if (!ctx.premium) throw new Refused(NOT_PREMIUM);
    const b = fields(f);
    const status = String(f.get("status"));
    if (!STATUS.some(([k]) => k === status)) throw new Refused("Pick where the booking stands.");
    const done = await saves.saveBooking(c, ctx.tenantId, uuid(f, "id"), b, status);
    if (done === "no-table") throw new Refused(NO_TABLE);
    if (done === "gone") throw new Refused("That booking is no longer there. Reload the page.");
    return `${b.name} saved.`;
  });
}

type Row = {
  id: string; day: string; time: string; name: string; size: number; phone: string | null; tags: string | null;
  table_id: string | null; status: string; store_id: string; store: string; past: boolean;
};

export default async function BookingsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("restaurant");
  // Not on this restaurant's plan: the page says so and shows nothing else.
  // The bookings it has are kept, and are here again when the plan is.
  if (!ctx.premium) {
    return (
      <div>
        <PageHead title="Bookings" lede="Tables reserved for a party at a time, taken here or on a till." />
        <Card title={`Bookings are ${PREMIUM_ONLY}`}>
          <p>
            This restaurant&apos;s plan does not include bookings. Any bookings already taken are kept, and are here
            again when the plan is changed. Ask EasyPay to switch Premium on.
          </p>
        </Card>
      </div>
    );
  }
  const show = one(sp.show) === "past" ? "past" : "coming";
  const d = await readTenant(ctx.tenantId, async (c) => ({
    stores: (await c.query(`select id, name, to_char(now() at time zone timezone, 'YYYY-MM-DD') as today from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]))
      .rows as { id: string; name: string; today: string }[],
    tables: (await c.query(`select id, store_id, name, area, seats from tables where tenant_id = $1 and deleted_at is null order by area, sort_order, name`, [ctx.tenantId]))
      .rows as { id: string; store_id: string; name: string; area: string; seats: number }[],
    rows: (
      await c.query(
        `select bk.id, to_char(bk.booked_for at time zone s.timezone, 'YYYY-MM-DD') as day, to_char(bk.booked_for at time zone s.timezone, 'HH24:MI') as time,
                bk.name, bk.size, bk.phone, bk.tags, bk.table_id, bk.status, bk.store_id, s.name as store,
                (bk.booked_for at time zone s.timezone)::date < (now() at time zone s.timezone)::date as past
           from bookings bk join stores s on s.tenant_id = bk.tenant_id and s.id = bk.store_id
          where bk.tenant_id = $1 and bk.deleted_at is null
            and case when $2 = 'past' then (bk.booked_for at time zone s.timezone)::date < (now() at time zone s.timezone)::date
                     else (bk.booked_for at time zone s.timezone)::date >= (now() at time zone s.timezone)::date end
          order by bk.booked_for ${show === "past" ? "desc" : "asc"} limit 300`,
        [ctx.tenantId, show],
      )
    ).rows as Row[],
  }));
  const many = d.stores.length > 1;
  // with several stores, a table is named with the store it stands in: a booking takes a table of its own store
  const storeName = new Map(d.stores.map((s) => [s.id, s.name]));
  return (
    <div>
      <PageHead
        title="Bookings"
        lede="Tables reserved for a party at a time. The tills show today's on their Bookings screen and hold the table on the floor plan until the party is seated. A booking can be taken here or on a till."
      />
      <Flash sp={sp} />
      {d.stores.length > 0 && (
        <Card title="Take a booking">
          <form action={addBooking} className="bo-toolbar" style={{ margin: 0 }}>
            {many ? (
              <select name="store_id" defaultValue={d.stores[0].id} aria-label="Store">
                {d.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <input type="hidden" name="store_id" value={d.stores[0].id} />
            )}
            <input name="day" type="date" defaultValue={d.stores[0].today} required aria-label="Day" />
            <input name="time" type="time" defaultValue="19:30" required aria-label="Time" />
            <input name="name" placeholder="Name" required maxLength={120} />
            <input name="size" type="number" min={1} max={99} defaultValue={2} className="narrow" aria-label="Guests" />
            <input name="phone" placeholder="Phone" maxLength={40} />
            <select name="table_id" defaultValue="" aria-label="Table">
              <option value="">Table: assign later</option>
              {d.tables.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.area} · {t.seats}{many ? ` · ${storeName.get(t.store_id) ?? ""}` : ""}</option>)}
            </select>
            <input name="tags" placeholder="Notes (birthday, allergy, high chair)" maxLength={240} style={{ minWidth: 240 }} />
            <Submit>Book</Submit>
          </form>
        </Card>
      )}
      <div className="tabs">
        <Link href={PATH} className={show === "coming" ? "on" : undefined}>Today and coming<Wait /></Link>
        <Link href={PATH + "?show=past"} className={show === "past" ? "on" : undefined}>Past<Wait /></Link>
      </div>
      {d.rows.length === 0 ? (
        <Empty icon={CalendarCheck} title={show === "past" ? "No past bookings" : "No bookings yet"}>{show === "past" ? "Bookings from earlier days show here." : "Take the first one above, or from a till."}</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Time</th>
              <th>Name</th>
              <th>Guests</th>
              <th>Phone</th>
              <th>Table</th>
              <th>Notes</th>
              <th>Status</th>
              {many && <th>Store</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td><input form={"b" + r.id} name="day" type="date" defaultValue={r.day} required aria-label="Day" /></td>
                <td><input form={"b" + r.id} name="time" type="time" defaultValue={r.time} required aria-label="Time" /></td>
                <td><input form={"b" + r.id} name="name" defaultValue={r.name} required maxLength={120} aria-label="Name" /></td>
                <td><input form={"b" + r.id} name="size" type="number" min={1} max={99} defaultValue={r.size} className="narrow" aria-label="Guests" /></td>
                <td><input form={"b" + r.id} name="phone" defaultValue={r.phone ?? ""} maxLength={40} aria-label="Phone" /></td>
                <td>
                  <select form={"b" + r.id} name="table_id" defaultValue={r.table_id ?? ""} aria-label="Table">
                    <option value="">Not assigned</option>
                    {d.tables.filter((t) => t.store_id === r.store_id).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.area} · {t.seats}</option>)}
                  </select>
                </td>
                <td><input form={"b" + r.id} name="tags" defaultValue={r.tags ?? ""} maxLength={240} aria-label="Notes" /></td>
                <td>
                  <select form={"b" + r.id} name="status" defaultValue={r.status} aria-label="Status">
                    {STATUS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </td>
                {many && <td>{r.store}</td>}
                <td>
                  <form id={"b" + r.id} action={saveBooking} className="row-actions">
                    <input type="hidden" name="id" value={r.id} />
                    <Submit className="btn-quiet btn-sm">Save</Submit>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
