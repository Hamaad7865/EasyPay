// usage.test.cjs — migration 0090: what the admin area's Usage page is drawn
// from. Which five minutes each client was active in, Neon's totals as the
// hourly job read them, and how much of the database each client's rows take.
// Usage: node db/tests/usage.test.cjs
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
  devguard.requireDev(env);
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const project = 'usage-probe-' + crypto.randomUUID().slice(0, 8);
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const fails = async (sql, args) => { try { await c.query(sql, args); return undefined; } catch (e) { return e.message; } };
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Usage-Probe'), ('${other}','${other}','Usage-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','USG1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','USG2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T2','T2') returning id`);
  const theirDevice = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','T1','T1') returning id`)).id;

  const mark = (tenant, at) => c.query(`select platform.usage_mark($1, $2::timestamptz)`, [tenant, at]);
  const hours = async (tenant) => (await c.query(
    `select to_char(hour at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as hour, slots, xmin::text as version
       from platform.usage_hours where tenant_id = $1 order by hour`, [tenant])).rows;

  // U1 a mark sets the bit of its five minutes, in the row of its hour
  {
    await mark(tid, '2026-03-04T10:07:30Z');
    const r = await hours(tid);
    check('U1 a client active at 10:07 is marked in the second five minutes of 10:00', r.length === 1 && r[0].hour === '2026-03-04 10:00' && r[0].slots === 2, JSON.stringify(r));
  }

  // U2 marked again in the same five minutes, nothing is written
  {
    const was = (await hours(tid))[0];
    await mark(tid, '2026-03-04T10:09:59Z');
    await mark(tid, '2026-03-04T10:05:00Z');
    const r = (await hours(tid))[0];
    check('U2 marked again in the same five minutes, the row is not written again', r.version === was.version && r.slots === 2, was.version + ' then ' + r.version);
  }

  // U3 another five minutes is another bit, another hour another row
  {
    await mark(tid, '2026-03-04T10:59:59Z');
    await mark(tid, '2026-03-04T10:00:00Z');
    await mark(tid, '2026-03-04T11:30:00Z');
    const r = await hours(tid);
    check('U3 the first and the last five minutes of the hour are bits 0 and 11', r.length === 2 && r[0].slots === (1 | 2 | 2048), JSON.stringify(r));
    check('U3 and half past eleven is its own row', r[1] && r[1].hour === '2026-03-04 11:00' && r[1].slots === 64, JSON.stringify(r[1]));
  }

  // U4 a client that is not there is not marked, and nothing stops
  {
    const err = await fails(`select platform.usage_mark($1, now())`, [crypto.randomUUID()]);
    check('U4 a mark for nobody is dropped without an error', err === undefined, err);
  }

  // U5 a till heard from marks its client, now
  {
    await c.query(`select device_heard($1, 'pull', 12)`, [theirDevice]);
    const r = await q1(`select count(*)::int as n, coalesce(sum(slots), 0)::int as slots from platform.usage_hours where tenant_id = $1 and hour > now() - interval '2 hours'`, [other]);
    check('U5 a till that syncs marks its client as active', r.n === 1 && r.slots > 0, JSON.stringify(r));
    const mine = await q1(`select count(*)::int as n from platform.usage_hours where tenant_id = $1 and hour > now() - interval '2 hours'`, [tid]);
    check('U5 and nobody else', mine.n === 0, JSON.stringify(mine));
    // heard again at once: device_heard writes nothing, and the mark is already there
    const was = (await hours(other))[0];
    await c.query(`select device_heard($1, 'pull', 12)`, [theirDevice]);
    check('U5 heard again at once, the mark is not written again', (await hours(other))[0].version === was.version);
  }

  // U6 none of it is a client's to read or to write
  {
    const asApp = async (tenant, sql, args) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
        const r = await c.query(sql, args);
        await c.query('ROLLBACK');
        return { rows: r.rows, n: r.rowCount };
      } catch (e) { await c.query('ROLLBACK'); return { error: e.message }; }
    };
    const read = await asApp(tid, `select * from platform.usage_hours`);
    check('U6 a client cannot read who was active when', read.error !== undefined, JSON.stringify(read).slice(0, 90));
    const call = await asApp(tid, `select platform.usage_mark($1, now())`, [other]);
    check('U6 nor mark anyone as active', call.error !== undefined, JSON.stringify(call).slice(0, 90));
    const days = await asApp(tid, `select * from platform.usage_days`);
    check('U6 nor read what Neon was asked', days.error !== undefined, JSON.stringify(days).slice(0, 90));
    const save = await asApp(tid, `select platform.usage_read('{}'::jsonb)`);
    check('U6 nor save a reading', save.error !== undefined, JSON.stringify(save).slice(0, 90));
    const size = await asApp(tid, `select * from platform.storage_by_tenant()`);
    check('U6 nor ask how much each client stores', size.error !== undefined, JSON.stringify(size).slice(0, 90));
  }

  // U7 a reading is kept as its day's, the day in Mauritius, and a later one replaces it
  {
    const reading = (at, compute) => JSON.stringify({
      project_id: project, read_at: at, period_start: '2026-03-01T00:00:00Z', period_end: '2026-04-01T00:00:00Z', plan: 'free_v3',
      compute_seconds: compute, active_seconds: compute * 4, storage_limit_bytes: 1073741824, branches_limit: 10,
      branches: [{ name: 'production', default: true, compute_seconds: compute, active_seconds: compute * 4, logical_size: 5000000 }],
    });
    const rows = async () => (await c.query(
      `select day::text, compute_seconds::int as compute, active_seconds::int as active, plan, branches_limit, storage_limit_bytes::text as lim,
              jsonb_array_length(branches) as branches, to_char(period_start at time zone 'UTC', 'YYYY-MM-DD') as starts
         from platform.usage_days where project_id = $1 order by day`, [project])).rows;
    await c.query(`select platform.usage_read($1::jsonb)`, [reading('2026-03-04T10:00:00Z', 100)]);
    let r = await rows();
    check('U7 a reading is saved with what Neon said', r.length === 1 && r[0].day === '2026-03-04' && r[0].compute === 100 && r[0].active === 400 && r[0].plan === 'free_v3'
      && r[0].branches_limit === 10 && r[0].lim === '1073741824' && r[0].branches === 1 && r[0].starts === '2026-03-01', JSON.stringify(r));
    await c.query(`select platform.usage_read($1::jsonb)`, [reading('2026-03-04T12:00:00Z', 180)]);
    r = await rows();
    check('U7 a later reading the same day replaces it', r.length === 1 && r[0].compute === 180, JSON.stringify(r));
    await c.query(`select platform.usage_read($1::jsonb)`, [reading('2026-03-04T11:00:00Z', 150)]);
    r = await rows();
    check('U7 an earlier one that arrives late does not', r.length === 1 && r[0].compute === 180, JSON.stringify(r));
    // 21:30 UTC is half past one the next morning in Mauritius
    await c.query(`select platform.usage_read($1::jsonb)`, [reading('2026-03-04T21:30:00Z', 260)]);
    r = await rows();
    check('U7 the day is the day in Mauritius', r.length === 2 && r[1].day === '2026-03-05' && r[1].compute === 260, JSON.stringify(r));
    const bad = await fails(`select platform.usage_read($1::jsonb)`, [JSON.stringify({ project_id: project, read_at: '2026-03-06T10:00:00Z' })]);
    check('U7 a reading without its figures is refused', bad !== undefined && (await rows()).length === 2, bad);
    await c.query(`delete from platform.usage_days where project_id = $1`, [project]);
  }

  // U8 how much of the database each client's rows take. A client's part of
  // a table goes by its rows, so the two are given the same rows in every
  // table but one: the first has a second till.
  {
    await c.query(`select device_heard($1, 'pull', 12)`, [device]);
    const r = (await c.query(`select tenant_id, bytes::text as bytes from platform.storage_by_tenant()`)).rows;
    const of = (t) => Number((r.find((x) => x.tenant_id === t) || {}).bytes || 0);
    check('U8 a client with rows has a size', of(tid) > 0 && of(other) > 0, of(tid) + ' and ' + of(other));
    check('U8 and the one with more tills the larger', of(tid) > of(other), of(tid) + ' against ' + of(other));
    const all = r.reduce((s, x) => s + Number(x.bytes), 0);
    const whole = Number((await q1(`select pg_database_size(current_database())::text as n`)).n);
    check('U8 together they are no more than the database', all > 0 && all <= whole, all + ' of ' + whole);
    check('U8 each client is there once', new Set(r.map((x) => x.tenant_id)).size === r.length);
  }

  // U9 a client that is removed takes its marks with it
  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  const left = (await q1(`select count(*)::int n from platform.usage_hours where tenant_id in ($1, $2)`, [tid, other])).n;
  check('U9 a client that is removed takes its marks with it', left === 0, String(left));
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
