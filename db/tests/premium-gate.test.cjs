// premium-gate.test.cjs — migration 0085: the kitchen display and bookings
// are part of the premium tier. The owner: "the kitchen and the bookings will
// be on the premium tier for restaurant customers".
//   - the plan the platform admin sets (tenants.plan) is copied into the
//     settings a till pulls, when a tenant is made and when its plan changes,
//     beside what the settings already hold
//   - premium and trial carry the premium features; standard does not
//   - a booking sent by a till of a restaurant that is not premium is refused
//     with a code of its own, and taken once the plan is
//   - every tenant that existed before was given its plan in its settings
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/premium-gate.test.cjs
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
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // a till's push, as the tenant's own connection makes it
  async function push(tenant, emp, ops) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      const r = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r;
      await c.query('SET LOCAL ROLE none');
      await c.query('RELEASE SAVEPOINT ' + name);
      return r;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT ' + name);
      await c.query('SET LOCAL ROLE none');
      throw e;
    }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-pg@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    const settings = async (t) => { await as(t); return ((await one(`select data, server_seq from pos_settings where tenant_id = $1`, [t])) || { data: {}, server_seq: null }); };
    const planKey = async (t) => (await settings(t)).data.plan ?? null;
    const bookings = async (t) => { await as(t); return (await one(`select count(*)::int as n from bookings where tenant_id = $1`, [t])).n; };

    // P1 a new tenant's settings carry the plan it was made on
    const std = await make('Gate Standard', 'PG1', 'standard');
    const prem = await make('Gate Premium', 'PG2', 'premium');
    const trial = await make('Gate Trial', 'PG3', 'trial');
    check('P1 a tenant made standard carries plan "standard" in its settings', (await planKey(std.tenant_id)) === 'standard', await planKey(std.tenant_id));
    check('P1 a tenant made premium carries "premium"; made trial carries "trial"',
      (await planKey(prem.tenant_id)) === 'premium' && (await planKey(trial.tenant_id)) === 'trial');

    // P3 which plans carry the premium features
    const free = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name, plan) values ($1, $1, 'Gate Free', 'free')`, [free]);
    const has = async (t) => (await one(`select has_premium($1::uuid) as h`, [t])).h;
    check('P3 has_premium: true for premium and trial', (await has(prem.tenant_id)) === true && (await has(trial.tenant_id)) === true);
    check('P3 has_premium: false for standard, free, an unknown tenant',
      (await has(std.tenant_id)) === false && (await has(free)) === false && (await has(crypto.randomUUID())) === false);

    // P4 a booking from a till
    const booking = (store) => ({ id: crypto.randomUUID(), store_id: store, booked_for: '2026-12-01T19:00:00+04:00', name: 'Ramgoolam', size: 4, status: 'confirmed' });
    const b1 = booking(std.store_id);
    let r = await push(std.tenant_id, std.employee_id, [op('booking.upsert', b1)]);
    check('P4 booking.upsert for a standard restaurant: rejected, code not-premium, no booking row',
      tag(r[0]) === 'rejected:not-premium' && (await bookings(std.tenant_id)) === 0, tag(r[0]));
    r = await push(trial.tenant_id, trial.employee_id, [op('booking.upsert', booking(trial.store_id))]);
    check('P4 a trial restaurant\'s booking: applied', tag(r[0]) === 'applied' && (await bookings(trial.tenant_id)) === 1, tag(r[0]));

    // P2 the admin changes the plan
    await as(std.tenant_id);
    await c.query(`update pos_settings set data = data || '{"servicePct": 10}'::jsonb where tenant_id = $1`, [std.tenant_id]);
    const before = await settings(std.tenant_id);
    await c.query(`select platform.set_tenant_plan($1, $2, ' premium ')`, [admin, std.tenant_id]);
    const after = await settings(std.tenant_id);
    check('P2 set_tenant_plan(standard -> premium) writes the settings and keeps what they held',
      after.data.plan === 'premium' && after.data.servicePct === 10, JSON.stringify(after.data));
    const log = (await c.query(`select detail from platform.audit where tenant_id = $1 and action = 'tenant.plan'`, [std.tenant_id])).rows;
    check('P2 the change is logged once, with from and to', log.length === 1 && log[0].detail.from === 'standard' && log[0].detail.to === 'premium', JSON.stringify(log));
    check('P6 a till is sent the settings row after a plan change (its server_seq went up)',
      Number(after.server_seq) > Number(before.server_seq), `${before.server_seq} -> ${after.server_seq}`);

    // P4 the same restaurant, now premium
    r = await push(std.tenant_id, std.employee_id, [op('booking.upsert', booking(std.store_id))]);
    check('P4 the same restaurant after the plan is set to premium: applied, one row',
      tag(r[0]) === 'applied' && (await bookings(std.tenant_id)) === 1, tag(r[0]));
    // and down again
    await c.query(`select platform.set_tenant_plan($1, $2, 'standard')`, [admin, std.tenant_id]);
    r = await push(std.tenant_id, std.employee_id, [op('booking.upsert', booking(std.store_id))]);
    check('P4 and refused again once the plan is back to standard, the booking it had kept',
      tag(r[0]) === 'rejected:not-premium' && (await bookings(std.tenant_id)) === 1 && (await planKey(std.tenant_id)) === 'standard', tag(r[0]));

    // P5 every tenant that was there before was told its plan
    const seen = (await one(`select count(*)::int as n from tenants`)).n;
    const apart = (await one(
      `select count(*)::int as n from tenants t left join pos_settings s on s.tenant_id = t.id and s.deleted_at is null
        where t.id <> $1 and (s.data->>'plan') is distinct from t.plan`, [free])).n;
    check("P5 every tenant's settings carry its plan", seen > 4 && apart === 0, `${apart} of ${seen} differ`);

    // P7 the tenant role cannot ask for a plan of its own
    await c.query('SET LOCAL ROLE app_user');
    const e = await failsWith(`select platform.set_tenant_plan($1, $2, 'premium')`, [admin, std.tenant_id]);
    check('P7 the tenant role cannot change a plan', e && e.code === '42501', said(e));
    await c.query('SET LOCAL ROLE none');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PREMIUM GATE PASS' : `PREMIUM GATE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
