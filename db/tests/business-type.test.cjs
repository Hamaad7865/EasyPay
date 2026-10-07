// business-type.test.cjs — migration 0066: a tenant is a restaurant or a retail shop.
//   - every tenant starts as a restaurant
//   - only a live platform admin changes the type; the change is logged
//   - the type is copied into the settings a till pulls, beside what is there
//   - a change is refused while an order is open
//   - a tenant can be created as a shop in one step
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/business-type.test.cjs
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
  let sp = 0;
  // runs a statement that is expected to fail, without losing the transaction
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-bt@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Type Test','Main','BT1','Owner',$2,'standard') as r`, [admin, crypto.randomUUID()])).r;
    const tid = made.tenant_id;
    const typeOf = async (t) => (await one(`select business_type from tenants where id = $1`, [t])).business_type;
    const key = async (t) => ((await one(`select data->>'businessType' as k from pos_settings where tenant_id = $1`, [t])) || {}).k ?? null;
    const logged = async (t) => (await one(`select count(*)::int as n from platform.audit where tenant_id = $1 and action = 'tenant.business_type'`, [t])).n;

    // B1 every tenant starts as a restaurant
    check('B1 a new tenant is a restaurant', (await typeOf(tid)) === 'restaurant');
    check('B1 and its settings need no key to say so', (await key(tid)) === null);

    // B2 the admin makes it a shop
    await c.query(`update pos_settings set data = data || '{"servicePct": 10}'::jsonb where tenant_id = $1`, [tid]);
    await c.query(`select platform.set_tenant_business_type($1, $2, ' Retail ')`, [admin, tid]);
    const s = await one(`select data from pos_settings where tenant_id = $1`, [tid]);
    check('B2 the type is changed', (await typeOf(tid)) === 'retail');
    check('B2 the tills are told through the settings, which keep what they held',
      s.data.businessType === 'retail' && s.data.servicePct === 10, JSON.stringify(s.data));
    const a = await one(`select detail from platform.audit where tenant_id = $1 and action = 'tenant.business_type'`, [tid]);
    check('B2 the change is logged with from and to', a && a.detail.from === 'restaurant' && a.detail.to === 'retail', JSON.stringify(a));

    // B3 the same type again is no change
    await c.query(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, tid]);
    check('B3 setting the same type again logs nothing', (await logged(tid)) === 1);

    // B4 what is refused
    let e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'hotel')`, [admin, tid]);
    check('B4 an unknown type is refused', e && e.message === 'bad-business-type', said(e));
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [stranger, tid]);
    check('B4 a non-admin is refused', e && e.message === 'not-a-platform-admin', said(e));
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, crypto.randomUUID()]);
    check('B4 an unknown tenant is refused', e && e.message === 'unknown-tenant', said(e));
    e = await failsWith(`update tenants set business_type = 'hotel' where id = $1`, [tid]);
    check('B4 the column itself takes nothing else', e && e.code === '23514', e ? e.code : 'no error');

    // B5 not while an order is open
    const tk = (await one(`insert into tickets (tenant_id, store_id) values ($1, $2) returning id`, [tid, made.store_id])).id;
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [admin, tid]);
    check('B5 a change is refused while an order is open', e && e.message === 'open-orders' && (await typeOf(tid)) === 'retail', said(e));
    await c.query(`update tickets set status = 'cancelled' where id = $1`, [tk]);
    await c.query(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [admin, tid]);
    check('B5 and goes through once it is closed',
      (await typeOf(tid)) === 'restaurant' && (await key(tid)) === 'restaurant' && (await logged(tid)) === 2);

    // B6 created as a shop in one step
    const shop = (await one(`select platform.create_tenant_of_type($1,'Shop Test','Main','BT2','Owner',$2,'standard','retail') as r`, [admin, crypto.randomUUID()])).r;
    const roles = (await one(`select count(*)::int as n from roles where tenant_id = $1`, [shop.tenant_id])).n;
    check('B6 a tenant can be created as a shop, complete',
      (await typeOf(shop.tenant_id)) === 'retail' && (await key(shop.tenant_id)) === 'retail' && roles === 4 && Boolean(shop.store_id));
    const plain = (await one(`select platform.create_tenant_of_type($1,'Resto Test','Main','BT3','Owner',$2,'standard','restaurant') as r`, [admin, crypto.randomUUID()])).r;
    check('B6 or as a restaurant, which logs no change of type',
      (await typeOf(plain.tenant_id)) === 'restaurant' && (await logged(plain.tenant_id)) === 0);
    e = await failsWith(`select platform.create_tenant_of_type($1,'Nowhere Test','Main','BT4','Owner',$2,'standard','hotel')`, [admin, crypto.randomUUID()]);
    const none = (await one(`select count(*)::int as n from tenants where name = 'Nowhere Test'`)).n;
    check('B6 an unknown type creates nothing', e && e.message === 'bad-business-type' && none === 0, said(e));

    // B7 the tenant role is locked out
    await c.query('SET LOCAL ROLE app_user');
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, tid]);
    check('B7 the tenant role cannot call it', e && e.code === '42501', e ? e.code : 'no error');
    await c.query('SET LOCAL ROLE none');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'BUSINESS TYPE PASS' : `BUSINESS TYPE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
