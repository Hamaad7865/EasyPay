// crash-reports.test.cjs — migration 0059: a till's crash reports land under
// its own restaurant, once, cut to size, and no other restaurant sees them.
// Usage: node db/tests/crash-reports.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Crash-Probe'), ('${other}','${other}','Crash-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','CRS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','CRS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const theirDevice = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const report = (tenant, reports) => asApp(tenant, async () => (await c.query('select report_crashes($1, $2::jsonb) as n', [owner, JSON.stringify(reports)])).rows[0].n);
  const trace = 'java.lang.IllegalStateException: no store\n\tat com.restopos.core.data.TicketRepository.ctx(TicketRepository.kt:62)\n\tat com.restopos.feature.pay.PayViewModel.record(Pay.kt:280)';
  const at = '2026-10-06T08:15:30.000Z';

  // T1 a report is kept with what the till said about itself
  {
    const n = await report(tid, [{ at, app_version: '0.2.0 (2)', android: '14', model: 'Lenovo TB-X606F', thread: 'main', trace, device_id: device }]);
    const row = await q1(`select app_version, android, model, thread, summary, trace, device_id, employee_id, happened_at from crash_reports where tenant_id = $1`, [tid]);
    check('T1 one report in', n === 1 && !!row, n);
    check('T1 its summary is the first line of the trace', row.summary === 'java.lang.IllegalStateException: no store', row.summary);
    check('T1 version, tablet, thread, till and time are kept', row.app_version === '0.2.0 (2)' && row.model === 'Lenovo TB-X606F' && row.thread === 'main' && row.device_id === device
      && row.employee_id === owner && new Date(row.happened_at).toISOString() === at, JSON.stringify({ ...row, trace: undefined }));
  }

  // T2 the same crash sent again (the till died before deleting its file) is kept once
  {
    const n = await report(tid, [{ at, app_version: '0.2.0 (2)', android: '14', model: 'Lenovo TB-X606F', thread: 'main', trace, device_id: device }]);
    const count = (await q1(`select count(*)::int n from crash_reports where tenant_id = $1`, [tid])).n;
    check('T2 the same report twice is one row', n === 0 && count === 1, n + ' ' + count);
    const later = await report(tid, [{ at: '2026-10-06T09:00:00.000Z', trace, device_id: device }]);
    check('T2 the same crash at another time is another row', later === 1);
  }

  // T3 what comes in is cut to size, and junk is skipped rather than refused
  {
    const before = (await q1(`select count(*)::int n from crash_reports where tenant_id = $1`, [tid])).n;
    const big = 'java.lang.OutOfMemoryError: big\n' + 'x'.repeat(50000);
    const n = await report(tid, [
      { at: '2026-10-06T10:00:00.000Z', trace: big, model: 'm'.repeat(500) },
      { at: '2026-10-06T10:01:00.000Z', trace: '   ' },
      { at: 'not a time', trace: 'java.lang.Error: undated' },
      { at: '2026-10-06T10:02:00.000Z', trace: 'java.lang.Error: wrong till', device_id: theirDevice },
      { at: '2026-10-06T10:03:00.000Z', trace: 'java.lang.Error: bad id', device_id: 'nonsense' },
    ]);
    const rows = (await c.query(`select summary, length(trace) len, length(model) mlen, device_id from crash_reports where tenant_id = $1 order by created_at, summary`, [tid])).rows;
    const bigRow = rows.find((r) => r.summary.includes('OutOfMemory'));
    check('T3 an empty trace is skipped, the others are kept', n === 4 && rows.length === before + 4, n + ' ' + rows.length);
    check('T3 a long trace and a long model are cut', bigRow.len === 20000 && bigRow.mlen === 80, JSON.stringify(bigRow));
    check('T3 a till of another restaurant, or a bad id, is left off', rows.filter((r) => /wrong till|bad id/.test(r.summary)).every((r) => r.device_id === null));
    check('T3 a report with no readable time is kept', rows.some((r) => r.summary === 'java.lang.Error: undated'));
    const many = Array.from({ length: 14 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 6, 12, i)).toISOString(), trace: 'java.lang.Error: burst ' + i }));
    check('T3 at most ten are taken at a time', (await report(tid, many)) === 10);
    let refused = false;
    try { await report(tid, { trace: 'not a list' }); } catch (e) { refused = /bad-batch/.test(e.message); }
    check('T3 something that is not a list is refused', refused);
  }

  // T4 another restaurant sees none of it
  {
    const theirs = await asApp(other, async () => (await c.query(`select count(*)::int n from crash_reports`)).rows[0].n);
    const mine = await asApp(tid, async () => (await c.query(`select count(*)::int n from crash_reports`)).rows[0].n);
    check('T4 the other restaurant sees no crash report', theirs === 0, theirs);
    check('T4 this one sees its own', mine > 0, mine);
    let blocked = false;
    try {
      await asApp(other, async () => c.query(`insert into crash_reports (tenant_id, summary, trace) values ($1, 'x', 'x')`, [tid]));
    } catch (e) { blocked = true; }
    check('T4 a restaurant cannot write a report into another', blocked);
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
