// service-limit.test.cjs — migration 0124: a service charge up to 30 %.
// The back office, the tablet and settings.save all take 0 to 30 %, the till
// sends it in basis points, and push_receipt_create refused anything above
// 2000 (20 %) as bad-payload: at 25 % every table sale was refused.
// Usage: node db/tests/service-limit.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, 'SL-Probe')`, [tid]);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main','SLS1') returning id`, [tid])).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select seed_demo_catalog($1)`, [tid]);
  const dp = (await q1(`select id from items where tenant_id=$1 and name='Dholl puri'`, [tid])).id;
  const cash = (await q1(`select id from payment_types where tenant_id=$1 and name='Cash'`, [tid])).id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { return (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); }
  }

  // Dholl puri 5000, VAT included; the service charge is added after tax.
  let seq = 0;
  async function sale(pct, total) {
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    seq++;
    await push([
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp, qty: 1000 })]);
    const r = await push([op('receipt.create', {
      id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'SLS1-T1-' + seq, device_seq: seq,
      service_pct: pct, payments: [{ payment_type_id: cash, amount: total }] })]);
    const row = (await c.query(`select total, service_charge from receipts where id=$1`, [rc])).rows[0];
    return { r: r[0], row };
  }

  // S1: 25 % (2500): service (5000 * 2500 + 5000) / 10000 = 1250, total 6250
  const s1 = await sale(2500, 6250);
  check('S1 a 25 % service charge is taken', s1.r.status === 'applied' && !s1.r.data?.needs_review, JSON.stringify(s1.r));
  check('S1 its total is 6250', s1.row && s1.row.total === '6250', JSON.stringify(s1.row));

  // S2: 30 % (3000), the most the settings allow: service 1500, total 6500
  const s2 = await sale(3000, 6500);
  check('S2 a 30 % service charge is taken', s2.r.status === 'applied' && !s2.r.data?.needs_review, JSON.stringify(s2.r));

  // S3: above 30 % is still refused
  const s3 = await sale(3100, 6550);
  check('S3 31 % is refused', s3.r.status !== 'applied' && !s3.row, JSON.stringify(s3.r));

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'SERVICE-LIMIT PASS' : `SERVICE-LIMIT FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
