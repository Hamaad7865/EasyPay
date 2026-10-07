// stock-locks.test.cjs — the stock engine (migration 0067) reaches the
// tenant's lock before a level, so a sale and a back office change of the
// same product at the same moment both go through.
//
// Every write in a tenant waits its turn on one lock per tenant (touch_row
// takes it on the first row a transaction writes). A sale holds it long before
// it reaches stock. A change that begins with stock must reach it first too:
// otherwise it would hold a level while it waits for the tenant's lock, the
// sale would hold the tenant's lock while it waits for the level, and the
// database would have to stop one of them.
// The engine gets this from stock_level_for's first statement: its insert
// fires touch_row even when the level is already there. This suite is the
// guard on that: change the insert and this is what would break.
// Two connections, so this suite commits and then cleans up after itself.
// Usage: node db/tests/stock-locks.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cs = devguard.envMap().DATABASE_URL_UNPOOLED;
  const c = new Client({ connectionString: cs, ssl: { require: true } });
  const a = new Client({ connectionString: cs, ssl: { require: true } });
  const b = new Client({ connectionString: cs, ssl: { require: true } });
  await c.connect(); await a.connect(); await b.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SL-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SL1') returning id`)).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    const item = (await q1(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,'Shirt',10000,4000,true) returning id`, [tid])).id;
    // the level exists before either side starts
    await c.query(`select stock_move($1,$2,$3,null,10000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, item, crypto.randomUUID(), emp]);

    const begin = async (x) => {
      await x.query('BEGIN');
      await x.query('SET LOCAL ROLE app_user');
      await x.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    };
    const settle = (p) => p.then((r) => ({ ok: true, id: r.rows[0].id }), (e) => ({ ok: false, code: e.code, message: e.message }));
    const end = (x, r) => x.query(r.ok ? 'COMMIT' : 'ROLLBACK');

    // A is a sale part-way through: it has written its receipt, so it holds the tenant's lock
    await begin(a);
    await a.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [tid]);
    // B is the back office adjusting the same product: its first act is stock
    await begin(b);
    const pb = settle(b.query(`select stock_move($1, $2, $3, null, $4, 'adjust', null, null, null, $5, $6) as id`, [tid, store, item, 1000, emp, 'from the back office']));
    await pause(1500); // B has reached whatever it waits on
    // A now reaches its stock
    const ra = await settle(a.query(`select stock_move($1,$2,$3,null,-1000,'sale',null,'receipt',$4,$5,null) as id`, [tid, store, item, crypto.randomUUID(), emp]));
    await end(a, ra);
    const rb = await pb;
    await end(b, rb);

    check('L1 the sale goes through', ra.ok, JSON.stringify(ra));
    check('L1 the back office change goes through', rb.ok, JSON.stringify(rb));
    const l = await q1(`select qty from stock_levels where tenant_id = $1 and item_id = $2`, [tid, item]);
    const n = (await q1(`select count(*)::int as n from stock_movements where tenant_id = $1 and item_id = $2`, [tid, item])).n;
    check('L1 both are counted: 10 in, 1 sold, 1 added', l.qty === 10000 && n === 3, `${l.qty} ${n}`);
  } finally {
    try { await a.query('ROLLBACK'); } catch {}
    try { await b.query('ROLLBACK'); } catch {}
    await a.end(); await b.end();
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `STOCK LOCKS FAIL (${failures})` : 'STOCK LOCKS PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
