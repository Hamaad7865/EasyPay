// payments-perm.test.cjs — migration 0111: "See the day's payments"
// (payments.view) is a permission of its own, apart from "See all receipts".
//   - a new client's Manager has it; its Cashier and Waiter do not, and its
//     Cashier still sees all receipts
//   - grant_payments_perm gives it, once, to a role that sees the day's figures
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/payments-perm.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-pp@example.com')`, [admin]);
    const tid = (await one(`select platform.create_tenant($1,'Payments Test','Main','PP1','Owner',$2,'premium') as r`, [admin, crypto.randomUUID()])).r.tenant_id;
    const has = async (role, perm) => (await one(`select permissions ? $3 as has from roles where tenant_id = $1 and name = $2`, [tid, role, perm])).has;

    check("P1 a new client's Manager sees the day's payments; its Cashier and Waiter do not",
      (await has('Manager', 'payments.view')) === true && (await has('Cashier', 'payments.view')) === false && (await has('Waiter', 'payments.view')) === false);
    check('P1 its Cashier still sees all receipts', (await has('Cashier', 'receipts.view_all')) === true);

    const figures = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Supervisor','["sale.create","shift.view_report"]'::jsonb) returning id`, [tid])).id;
    const plain = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till','["sale.create","receipts.view_all"]'::jsonb) returning id`, [tid])).id;
    const n = (await one(`select grant_payments_perm($1) as n`, [tid])).n;
    const of = async (id) => (await one(`select permissions ? 'payments.view' as has from roles where id = $1`, [id])).has;
    const again = (await one(`select grant_payments_perm($1) as n`, [tid])).n;
    check("P2 a role that sees the day's figures is given it, once; one that sees receipts alone is not",
      n === 1 && (await of(figures)) === true && (await of(plain)) === false && again === 0, `${n} ${again}`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PAYMENTS PERM PASS' : `PAYMENTS PERM FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
