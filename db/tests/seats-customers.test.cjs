// seats-customers.test.cjs — migration 0055: an item is for a seat, lines move
// between seats and courses, and an order is for a customer.
// Usage: node db/tests/seats-customers.test.cjs
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
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SE-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SES1') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const seats = async (t) => (await c.query(`select id, seat, course, qty from ticket_lines where ticket_id = $1 order by created_at, qty desc`, [t])).rows;

  // T1 an item is rung up for a seat, or for the table
  const t = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID(), s = crypto.randomUUID();
  {
    const r = await push([
      op('ticket.create', { id: t, store_id: store }),
      op('ticket.add_line', { id: a, ticket_id: t, item_id: dp, qty: 2000, seat: 1, course: 1 }),
      op('ticket.add_line', { id: b, ticket_id: t, item_id: dp, qty: 1000 }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: t, item_id: dp, qty: 1000, seat: 0 }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: t, item_id: dp, qty: 1000, seat: 100 }),
    ]);
    const rows = await seats(t);
    check('T1 a line keeps the seat it was rung up for; one with none is for the table', tag(r[1]) === 'applied' && tag(r[2]) === 'applied'
      && rows.find((x) => x.id === a).seat === 1 && rows.find((x) => x.id === b).seat === null, JSON.stringify(rows.map((x) => x.seat)));
    check('T1 seat 0 and seat 100 are refused', tag(r[3]) === 'rejected:bad-payload' && tag(r[4]) === 'rejected:bad-payload', tag(r[3]) + ' ' + tag(r[4]));
  }

  // T2 lines move to another seat and course; absent keys change nothing
  {
    const seat = await push([op('ticket.place_lines', { ticket_id: t, line_ids: [a, b], seat: 2 })]);
    const afterSeat = await seats(t);
    const course = await push([op('ticket.place_lines', { ticket_id: t, line_ids: [b], course: 3 })]);
    const afterCourse = await seats(t);
    const back = await push([op('ticket.place_lines', { ticket_id: t, line_ids: [a], seat: null })]);
    const afterBack = await seats(t);
    check('T2 two lines move to seat 2, their course untouched', tag(seat[0]) === 'applied' && seat[0].data.placed === 2
      && afterSeat.every((x) => x.seat === 2) && afterSeat.find((x) => x.id === a).course === 1, JSON.stringify(afterSeat));
    check('T2 a line moves to course 3, its seat untouched', tag(course[0]) === 'applied' && afterCourse.find((x) => x.id === b).course === 3
      && afterCourse.find((x) => x.id === b).seat === 2, JSON.stringify(afterCourse));
    check('T2 seat null puts a line back on the table', tag(back[0]) === 'applied' && afterBack.find((x) => x.id === a).seat === null, JSON.stringify(afterBack));
    const bad = await push([
      op('ticket.place_lines', { ticket_id: t, line_ids: [a] }),
      op('ticket.place_lines', { ticket_id: t, line_ids: [], seat: 1 }),
      op('ticket.place_lines', { ticket_id: crypto.randomUUID(), line_ids: [a], seat: 1 }),
      op('ticket.place_lines', { ticket_id: t, line_ids: [a], seat: 120 }),
    ]);
    check('T2 nothing to change, no lines, an unknown order and a seat out of range are refused',
      bad.map(tag).join(',') === 'rejected:bad-payload,rejected:lines-required,rejected:bad-ticket,rejected:bad-payload', bad.map(tag).join(','));
  }

  // T3 splitting a line keeps its seat on both halves; a paid line stays where it is
  {
    await push([op('ticket.place_lines', { ticket_id: t, line_ids: [a], seat: 4 })]);
    const sp = await push([op('ticket.split_line', { line_id: a, new_id: s, qty: 1000 })]);
    const rows = await seats(t);
    check('T3 both halves of a split line are on seat 4', tag(sp[0]) === 'applied' && rows.find((x) => x.id === a).seat === 4 && rows.find((x) => x.id === s).seat === 4, JSON.stringify(rows));
    await push([op('receipt.create', { id: crypto.randomUUID(), ticket_id: t, store_id: store, device_id: dev, number: 'SE-1', device_seq: 1,
      line_ids: [s], payments: [{ payment_type_id: cash, amount: 5000 }] })]);
    const moved = await push([op('ticket.place_lines', { ticket_id: t, line_ids: [s, a], seat: 9 })]);
    const after = await seats(t);
    check('T3 a paid line does not move; the unpaid one does', tag(moved[0]) === 'applied' && moved[0].data.placed === 1
      && after.find((x) => x.id === s).seat === 4 && after.find((x) => x.id === a).seat === 9, JSON.stringify(after));
  }

  // T4 customers: made on the till, edited, put on an order and taken off
  const cu = crypto.randomUUID();
  {
    const made = await push([op('customer.upsert', { id: cu, name: '  Anil Ramdin ', phone: ' 5 999 0000 ', email: '', note: 'no peanuts' })]);
    const row = await q1(`select name, phone, email, note from customers where id = $1`, [cu]);
    check('T4 a customer is made, trimmed, with empty fields left empty', tag(made[0]) === 'applied' && row.name === 'Anil Ramdin' && row.phone === '5 999 0000' && row.email === null && row.note === 'no peanuts', JSON.stringify(row));
    const edit = await push([op('customer.upsert', { id: cu, name: 'Anil Ramdin', phone: '5 111 2222' })]);
    const row2 = await q1(`select phone, note from customers where id = $1`, [cu]);
    check('T4 sending it again changes it', tag(edit[0]) === 'applied' && row2.phone === '5 111 2222' && row2.note === null, JSON.stringify(row2));
    const bad = await push([op('customer.upsert', { id: crypto.randomUUID(), name: '   ' }), op('customer.upsert', { name: 'No id' })]);
    check('T4 a customer with no name or no id is refused', bad.map(tag).join(',') === 'rejected:bad-payload,rejected:bad-payload', bad.map(tag).join(','));
    const on = await push([op('ticket.update_meta', { ticket_id: t, customer_id: cu })]);
    const has = await q1(`select customer_id, name, table_id from tickets where id = $1`, [t]);
    const off = await push([op('ticket.update_meta', { ticket_id: t, customer_id: null })]);
    const none = await q1(`select customer_id from tickets where id = $1`, [t]);
    const stray = await push([op('ticket.update_meta', { ticket_id: t, customer_id: crypto.randomUUID() })]);
    const still = await q1(`select customer_id from tickets where id = $1`, [t]);
    check('T4 the order is for the customer', tag(on[0]) === 'applied' && has.customer_id === cu, tag(on[0]));
    check('T4 null takes the customer off; an unknown customer leaves the order with none', tag(off[0]) === 'applied' && none.customer_id === null
      && tag(stray[0]) === 'applied' && still.customer_id === null, tag(off[0]) + ' ' + tag(stray[0]));
  }

  // T5 the pull sends customers and seats to the till; another restaurant sees neither
  {
    const pull = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const ch = pull.changes;
    check('T5 the pull carries the customer', Array.isArray(ch.customers) && ch.customers.length === 1 && ch.customers[0].name === 'Anil Ramdin', JSON.stringify(ch.customers));
    check('T5 the pull carries each line\'s seat', ch.ticket_lines.some((x) => x.id === a && x.seat === 9), JSON.stringify(ch.ticket_lines.map((x) => x.seat)));
    const seen = await asApp(crypto.randomUUID(), async () => (await c.query(`select count(*)::int as n from customers`)).rows[0].n);
    check('T5 customers are the restaurant\'s own', seen === 0, String(seen));
  }

  await c.query(`delete from customers where tenant_id = $1`, [tid]);
  await devguard.cleanupTenant(c, tid);
  await c.end();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
