// settled-close.test.cjs — migration 0125: an order with nothing left to pay
// is closed by ticket.cancel, as paid.
//   Check 1 of a split bill paid, then check 2's items taken off: the order
//   had only paid lines and nothing to pay, and stayed open for good, its
//   table taken (found by the restaurant review of 2026-10-20). The till now
//   sends ticket.cancel for it; the server closes it as 'paid'. An order with
//   something still to pay is refused as before, an empty one is cancelled.
// Usage: node db/tests/settled-close.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, 'SC-Probe')`, [tid]);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main','SCS1') returning id`, [tid])).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select seed_demo_catalog($1)`, [tid]);
  const dp = (await q1(`select id from items where tenant_id=$1 and name='Dholl puri'`, [tid])).id;
  const cash = (await q1(`select id from payment_types where tenant_id=$1 and name='Cash'`, [tid])).id;
  const table = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,'T5') returning id`, [tid, store])).id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { return (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const status = async (t) => (await q1(`select status from tickets where id=$1`, [t])).status;

  // an order on table 5 with two Dholl puri on two lines
  let seq = 0;
  async function twoLines() {
    const t = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID();
    await push([
      op('ticket.create', { id: t, store_id: store, table_id: table, covers: 2 }),
      op('ticket.add_line', { id: a, ticket_id: t, item_id: dp, qty: 1000 }),
      op('ticket.add_line', { id: b, ticket_id: t, item_id: dp, qty: 1000 })]);
    return { t, a, b };
  }
  async function payLine(t, line) {
    seq++;
    return push([op('receipt.create', { id: crypto.randomUUID(), ticket_id: t, store_id: store, device_id: dev,
      number: 'SCS1-T1-' + seq, device_seq: seq, line_ids: [line], payments: [{ payment_type_id: cash, amount: 5000 }] })]);
  }

  // C1: check 1 paid, check 2's item taken off, then ticket.cancel: closed as paid
  const o1 = await twoLines();
  await payLine(o1.t, o1.a);
  await push([op('ticket.void_line', { line_id: o1.b })]);
  check('C1 the order is still open with nothing to pay', (await status(o1.t)) === 'open');
  const r1 = await push([op('ticket.cancel', { ticket_id: o1.t })]);
  check('C1 ticket.cancel is taken', tag(r1[0]) === 'applied', JSON.stringify(r1[0]));
  check('C1 the order is closed as paid', (await status(o1.t)) === 'paid');
  check('C1 it says so', r1[0].data && r1[0].data.status === 'paid', JSON.stringify(r1[0].data));
  const paidLines = (await q1(`select count(*)::int n from ticket_lines where ticket_id=$1 and paid and voided_at is null`, [o1.t])).n;
  check('C1 its paid line stays as it was', paidLines === 1, 'n=' + paidLines);

  // C2: sent again, it is answered as it stands
  const r2 = await push([op('ticket.cancel', { ticket_id: o1.t })]);
  check('C2 sent twice is not refused', tag(r2[0]) === 'applied' && (await status(o1.t)) === 'paid', JSON.stringify(r2[0]));

  // C3: something still to pay: refused as before
  const o3 = await twoLines();
  await payLine(o3.t, o3.a);
  const r3 = await push([op('ticket.cancel', { ticket_id: o3.t })]);
  check('C3 an order with something to pay is refused', tag(r3[0]) === 'rejected:conflict', JSON.stringify(r3[0]));
  check('C3 and stays open', (await status(o3.t)) === 'open');

  // C4: nothing on it at all: cancelled as before
  const o4 = await twoLines();
  await push([op('ticket.void_line', { line_id: o4.a }), op('ticket.void_line', { line_id: o4.b })]);
  const r4 = await push([op('ticket.cancel', { ticket_id: o4.t })]);
  check('C4 an empty order is cancelled', tag(r4[0]) === 'applied' && (await status(o4.t)) === 'cancelled', JSON.stringify(r4[0]));

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'SETTLED-CLOSE PASS' : `SETTLED-CLOSE FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
