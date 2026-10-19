// booking-partial.test.cjs — migration 0126: a booking changed on a tablet
// changes only what the tablet changed.
//   A tablet sent every field of its own copy of a booking on each tap, and
//   the server wrote them all: the office changed a booking to 8 guests and
//   gave it table 7, a waiter on a tablet that had not fetched since tapped
//   Seat, and the booking went back to 4 guests with no table (the restaurant
//   review of 2026-10-20). The till now sends `partial: true` with only what
//   changed; the server leaves the rest as it is. A full booking (a new one, or
//   from a till built before this) is as before.
// Usage: node db/tests/booking-partial.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const env = devguard.envMap();
  devguard.requireDev(env);
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // bookings are a premium feature (0085)
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ($1, $1, 'BP-Probe', 'premium')`, [tid]);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main','BPS1') returning id`, [tid])).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const t7 = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,'T7') returning id`, [tid, store])).id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { return (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const booking = (id) => q1(`select name, size, phone, table_id, status, booked_for from bookings where id = $1`, [id]);

  const id = crypto.randomUUID();
  const at = '2026-10-20T15:30:00.000Z';
  const full = { id, store_id: store, booked_for: at, name: 'Ravi', size: 4, status: 'confirmed', phone: '5252 5270', area: '', tags: '', table_id: null };
  const r0 = await push([op('booking.upsert', full)]);
  check('P0 a new booking is taken whole', tag(r0[0]) === 'applied', JSON.stringify(r0[0]));

  // the office changes it: 8 guests, table 7
  await c.query(`update bookings set size = 8, table_id = $2 where id = $1`, [id, t7]);

  // P1: a tablet that had not fetched taps Seat: it sends what Seat changed, and only that
  const r1 = await push([op('booking.upsert', { id, store_id: store, partial: true, status: 'seated' })]);
  check('P1 a partial change is taken', tag(r1[0]) === 'applied', JSON.stringify(r1[0]));
  const b1 = await booking(id);
  check('P1 the office\'s 8 guests stay', b1.size === 8, 'size=' + b1.size);
  check('P1 the office\'s table stays', b1.table_id === t7, String(b1.table_id));
  check('P1 the status is what the tablet changed', b1.status === 'seated', b1.status);
  check('P1 the name and phone stay', b1.name === 'Ravi' && b1.phone === '5252 5270', JSON.stringify(b1));

  // P2: a field cleared is cleared
  await push([op('booking.upsert', { id, store_id: store, partial: true, table_id: null, phone: '' })]);
  const b2 = await booking(id);
  check('P2 a table taken off is taken off', b2.table_id === null, String(b2.table_id));
  check('P2 a phone cleared is cleared', b2.phone === null, String(b2.phone));

  // P3: what is sent is checked as before
  const r3 = await push([op('booking.upsert', { id, store_id: store, partial: true, size: 0 })]);
  check('P3 a partial change with no guests is refused', tag(r3[0]) === 'rejected:bad-payload', JSON.stringify(r3[0]));
  const r3b = await push([op('booking.upsert', { id, store_id: store, partial: true, status: 'maybe' })]);
  check('P3 an unknown status is refused', tag(r3b[0]) === 'rejected:bad-payload', JSON.stringify(r3b[0]));

  // P4: a partial change of a booking the server does not have cannot make one
  const r4 = await push([op('booking.upsert', { id: crypto.randomUUID(), store_id: store, partial: true, status: 'seated' })]);
  check('P4 a partial change of no booking is refused', tag(r4[0]) === 'rejected:bad-payload', JSON.stringify(r4[0]));

  // P5: a till built before this sends the whole booking: written whole, as before
  const r5 = await push([op('booking.upsert', { ...full, size: 5 })]);
  check('P5 a whole booking is written whole', tag(r5[0]) === 'applied' && (await booking(id)).size === 5, JSON.stringify(r5[0]));

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'BOOKING-PARTIAL PASS' : `BOOKING-PARTIAL FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
