// remove-test-clients.test.cjs — what db/remove-test-clients.cjs removes and
// what it must leave. Two clients are made inside one transaction, one with a
// login and one without; the one without is removed; the transaction is rolled
// back, so nothing is made and nothing is removed for real.
//
// Usage: node db/tests/remove-test-clients.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { listClients, withoutLogin, removeClients } = require('../remove-test-clients.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const thrown = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  try {
    const stamp = Date.now();
    // a client as the early suites left them: a store, a catalog, an applied op, no login
    const none = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, $2)`, [none, `RTC-none-${stamp}`]);
    await c.query(`insert into stores (tenant_id, name, code) values ($1, 'Main', 'RTC1')`, [none]);
    await c.query(`select seed_demo_catalog($1)`, [none]);
    await c.query(`insert into sync_ops_applied (op_id, tenant_id, type) values (gen_random_uuid(), $1, 'probe')`, [none]);
    // a client as the platform admin makes one: it has its owner's login
    const owner = (await c.query(
      `insert into neon_auth."user" (id, name, email, "emailVerified", role) values (gen_random_uuid(), 'RTC', $1, false, 'user') returning id`,
      [`rtc-${stamp}@example.invalid`])).rows[0].id;
    const real = await devguard.createTenantAsAdmin(c, { name: `RTC-real-${stamp}`, storeCode: 'RTC2', ownerName: 'Owner', ownerAuth: owner });
    await c.query(`insert into sync_ops_applied (op_id, tenant_id, type) values (gen_random_uuid(), $1, 'probe')`, [real.tid]);

    const clients = await listClients(c);
    const a = clients.find((x) => x.id === none);
    const b = clients.find((x) => x.id === real.tid);
    check('L1 both are listed, with their logins counted', !!a && !!b && a.logins === 0 && b.logins === 1, JSON.stringify({ a: a && a.logins, b: b && b.logins }));
    const going = withoutLogin(clients).map((x) => x.id);
    check('L2 the one without a login is to go, the one with a login is not', going.includes(none) && !going.includes(real.tid));
    // the rule on what this branch really holds: its three real clients have a login
    const named = clients.filter((x) => ['CafeTino', 'Saheer Resto', 'Hamaad Retail'].includes(x.name));
    check('L3 no real client of this branch is to go', named.every((x) => !going.includes(x.id)), `${named.length} looked at`);

    check('R1 a client with a login is refused, by name', (await thrown(() => removeClients(c, [none, real.tid]))) === `has-login:RTC-real-${stamp}`);
    check('R2 and nothing was removed by that', (await c.query(`select 1 from tenants where id = any($1::uuid[])`, [[none, real.tid]])).rowCount === 2);
    check('R3 an empty list removes nothing', Object.keys(await removeClients(c, [])).length === 0);

    const before = (await c.query(`select count(*)::int as n from tenants`)).rows[0].n;
    const gone = await removeClients(c, [none]);
    check('R4 the client is removed', gone.tenants === 1 && (await c.query(`select 1 from tenants where id = $1`, [none])).rowCount === 0);
    check('R5 with its catalog and its store', gone.items > 0 && gone.categories > 0 && gone.stores === 1, JSON.stringify({ items: gone.items, categories: gone.categories, stores: gone.stores }));
    check('R6 and its row in an insert-only table', gone.sync_ops_applied === 1);
    check('R7 one client fewer, no more', (await c.query(`select count(*)::int as n from tenants`)).rows[0].n === before - 1);
    const realLeft = await c.query(
      `select (select count(*)::int from stores where tenant_id = $1) as stores,
              (select count(*)::int from employees where tenant_id = $1) as employees,
              (select count(*)::int from sync_ops_applied where tenant_id = $1) as ops`, [real.tid]);
    check('R8 the client with a login keeps everything', realLeft.rows[0].stores === 1 && realLeft.rows[0].employees === 1 && realLeft.rows[0].ops === 1, JSON.stringify(realLeft.rows[0]));

    const off = await c.query(
      `select count(*)::int as n from pg_trigger g join pg_proc p on p.oid = g.tgfoid
        where not g.tgisinternal and p.proname = 'block_update' and g.tgenabled <> 'O'`);
    check('G1 every insert-only guard is back on', off.rows[0].n === 0);
    await c.query('SAVEPOINT g');
    const refused = await thrown(() => c.query(`delete from sync_ops_applied where tenant_id = $1`, [real.tid]));
    await c.query('ROLLBACK TO SAVEPOINT g');
    check('G2 and refuses a delete again', refused !== '', refused.slice(0, 60));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'REMOVE-TEST-CLIENTS PASS' : `REMOVE-TEST-CLIENTS FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
