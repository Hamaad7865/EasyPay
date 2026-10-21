// auto-close.test.cjs — migration 0133: a till closes its own day.
//   A1 settings.save takes autoClose "HH:MM", null switches it off, anything else is bad-value
//   A2 shift.close marked auto keeps no count and no closer, whatever count it carries
//   A3 day.close with totals.auto keeps no closer, and its totals as sent
//   A4 a closing that is not automatic is as before: a count is needed, the closer is kept
//   A5 a login that may set up tills (settings.device) may push an automatic closing; one that may do neither may not
//   A6 the pull brings both back as they are kept
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/auto-close.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-autoclose@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Auto Close Test','Main',$3,'Owner',$2,'offline','restaurant') as r`, [admin, id(), 'AC' + crypto.randomInt(1000, 9999)])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    await c.query(`select platform.set_tenant_plan($1,$2,'premium')`, [admin, tid]);
    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const pull = () => asApp(async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const data = async () => (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const at = (min) => new Date(Date.UTC(2026, 0, 1, 20, 0) + min * 60_000).toISOString();

    // ---- A1 the setting ----
    {
      const save = (p) => push([op('settings.save', p)]);
      let o = await save({ autoClose: '05:00', servicePct: 10 });
      let d = await data();
      check('A1 settings.save takes autoClose', tag(o[0]) === 'applied' && d.autoClose === '05:00' && d.servicePct === 10, tag(o[0]) + ' ' + JSON.stringify(d.autoClose));
      o = await save({ autoClose: '00:00' });
      check('A1 midnight is a time', tag(o[0]) === 'applied' && (await data()).autoClose === '00:00', tag(o[0]));
      for (const [label, v] of [['24:00', '24:00'], ['5:00', '5:00'], ['words', 'midnight'], ['a number', 5], ['00:60', '00:60']]) {
        const r = await save({ autoClose: v });
        check('A1 ' + label + ' is refused', tag(r[0]) === 'rejected:bad-value', tag(r[0]));
      }
      o = await save({ autoClose: null });
      d = await data();
      check('A1 null switches it off, the other keys untouched', tag(o[0]) === 'applied' && d.autoClose === null && d.servicePct === 10, JSON.stringify({ a: d.autoClose, s: d.servicePct }));
    }

    // ---- A2, A3 a day closed by itself ----
    const shift = id();
    check('A2 the day opens', tag((await push([op('shift.open', { id: shift, device_id: dev, opening_float: 10000, opened_at: at(0) })]))[0]) === 'applied');
    {
      // pushed as the till pushes it: no employee on the op, so it is the login's
      const o = await push([op('shift.close', { id: shift, counted_cash: 10000, closed_at: at(240), auto: true })]);
      const s = await one(`select closed_by, counted_cash, expected_cash, closed_at from shifts where id = $1`, [shift]);
      check('A2 an automatic shift.close keeps no count and no closer', tag(o[0]) === 'applied' && s.closed_by === null && s.counted_cash === null && Number(s.expected_cash) === 10000 && s.closed_at.toISOString() === at(240),
        tag(o[0]) + ' ' + JSON.stringify(s));
      const dc = id();
      const o2 = await push([op('day.close', { id: dc, store_id: store, device_id: dev, closed_at: at(240), totals: { sales: 0, expected: 10000, auto: true, carried: 2 } })]);
      const row = await one(`select closed_by, totals from day_closes where id = $1`, [dc]);
      check('A3 an automatic day.close keeps no closer, and its totals as sent', tag(o2[0]) === 'applied' && row.closed_by === null && row.totals.auto === true && row.totals.carried === 2,
        tag(o2[0]) + ' ' + JSON.stringify(row));
      // ---- A6 the pull ----
      const p = await pull();
      const ps = p.changes.shifts.find((x) => x.id === shift), pd = p.changes.day_closes.find((x) => x.id === dc);
      check('A6 the pull brings the shift with no count and the closing with totals.auto', ps && ps.counted_cash === null && ps.closed_by === null && pd && pd.totals.auto === true && pd.closed_by === null,
        JSON.stringify({ ps: ps && { c: ps.counted_cash, b: ps.closed_by }, pd: pd && pd.totals }));
    }

    // ---- A4 as before ----
    {
      const s2 = id();
      await push([op('shift.open', { id: s2, device_id: dev, opening_float: 5000, opened_at: at(300) })]);
      const no = await push([op('shift.close', { id: s2, closed_at: at(400) })]);
      check('A4 a shift.close that is not automatic needs a count', tag(no[0]) === 'rejected:bad-payload', tag(no[0]));
      const ok = await push([op('shift.close', { id: s2, counted_cash: 4900, closed_at: at(400) })]);
      const s = await one(`select closed_by, counted_cash from shifts where id = $1`, [s2]);
      check('A4 and keeps who closed it and what they counted', tag(ok[0]) === 'applied' && s.closed_by === owner && Number(s.counted_cash) === 4900, JSON.stringify(s));
      const dc = id();
      await push([op('day.close', { id: dc, store_id: store, device_id: dev, closed_at: at(400), totals: { sales: 0 } })]);
      check('A4 a day.close that is not automatic keeps its closer', (await one(`select closed_by from day_closes where id = $1`, [dc])).closed_by === owner);
    }

    // ---- A5 who may ----
    {
      const setter = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Sets up tills','["settings.device"]'::jsonb) returning id`, [tid])).id;
      const waiter = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till hand','["sale.create"]'::jsonb) returning id`, [tid])).id;
      const sam = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Sam',$2) returning id`, [tid, setter])).id;
      const wes = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Wes',$2) returning id`, [tid, waiter])).id;
      const s3 = id();
      await push([op('shift.open', { id: s3, device_id: dev, opening_float: 0, opened_at: at(500) })]);
      const refused = await push([op('shift.close', { id: s3, counted_cash: 0, closed_at: at(600), auto: true })], wes);
      check('A5 a login that may neither close a day nor set up tills may not', tag(refused[0]) === 'rejected:forbidden', tag(refused[0]));
      const taken = await push([op('shift.close', { id: s3, counted_cash: 0, closed_at: at(600), auto: true })], sam);
      check('A5 a login that may set up tills may push an automatic closing', tag(taken[0]) === 'applied', tag(taken[0]));
      const notAuto = await push([op('day.close', { id: id(), store_id: store, device_id: dev, closed_at: at(600), totals: {} })], sam);
      check('A5 but not a closing that is not automatic', tag(notAuto[0]) === 'rejected:forbidden', tag(notAuto[0]));
    }
  } catch (e) {
    failures++;
    console.log('FAIL ' + e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
