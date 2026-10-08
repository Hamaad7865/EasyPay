// device-activity.test.cjs — migration 0064: when each till was last heard
// from, kept where no till pulls it and no restaurant can write it.
// Usage: node db/tests/device-activity.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Heard-Probe'), ('${other}','${other}','Heard-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','DAS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','DAS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const device2 = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T2','T2') returning id`)).id;
  const theirDevice = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role]);

  const heard = async (dev, what, version) => (await q1(`select device_heard($1, $2, $3) as ok`, [dev, what, version ?? null])).ok;
  const row = async (dev) => q1(`select tenant_id, last_seen_at, last_push_at, last_pull_at, till_version, server_seq::text as seq from device_activity where device_id = $1`, [dev]);
  // as if the till was last heard from a minute ago
  const age = async (dev) => c.query(
    `update device_activity set last_seen_at = last_seen_at - interval '1 minute', last_push_at = last_push_at - interval '1 minute',
            last_pull_at = last_pull_at - interval '1 minute' where device_id = $1`, [dev]);
  const deviceSeq = async (dev) => (await q1(`select server_seq::text as seq from pos_devices where id = $1`, [dev])).seq;

  // T1 the first time a till is heard from, its row is made
  const before = await deviceSeq(device);
  {
    const ok = await heard(device, 'pull', 12);
    const r = await row(device);
    check('T1 a till that fetched is written down', ok === true && r && r.tenant_id === tid && r.last_seen_at !== null && r.last_pull_at !== null, JSON.stringify(r));
    check('T1 it has not sent anything yet', r.last_push_at === null);
    check('T1 with the build it said it was', r.till_version === 12, String(r.till_version));
  }

  // T2 sending is kept apart from fetching
  {
    await age(device);
    const was = await row(device);
    await heard(device, 'push', 12);
    const r = await row(device);
    check('T2 a push sets when it last sent', r.last_push_at !== null && r.last_seen_at > was.last_seen_at, JSON.stringify(r));
    check('T2 and leaves when it last fetched', String(r.last_pull_at) === String(was.last_pull_at));
  }

  // T3 asked again straight away, nothing is written
  {
    const was = await row(device);
    await heard(device, 'push', 12);
    await heard(device, 'seen', 12);
    await heard(device, 'seen', null);
    const r = await row(device);
    check('T3 heard again within ten seconds, the row is not written again', r.seq === was.seq && String(r.last_seen_at) === String(was.last_seen_at), was.seq + ' then ' + r.seq);
    // a pull is new, though: it has not fetched for a minute
    await heard(device, 'pull', 12);
    const pulled = await row(device);
    check('T3 but a fetch after a push is written', pulled.seq !== was.seq && pulled.last_pull_at > was.last_pull_at);
  }

  // T4 a different build is written at once; no build said leaves it as it was
  {
    const was = await row(device);
    await heard(device, 'pull', 13);
    const r = await row(device);
    check('T4 an updated till is seen as updated at once', r.till_version === 13 && r.seq !== was.seq, String(r.till_version));
    await age(device);
    await heard(device, 'pull', null);
    check('T4 a sync that does not say its build keeps the one known', (await row(device)).till_version === 13);
    await age(device);
    await heard(device, 'pull', -4);
    await age(device);
    await heard(device, 'pull', 2000000000);
    check('T4 and a build that is not one is not kept', (await row(device)).till_version === 13);
  }

  // T5 only seen: set up, or a crash report
  {
    await heard(device2, 'seen', 12);
    const r = await row(device2);
    check('T5 a till only seen has neither sent nor fetched', r.last_seen_at !== null && r.last_push_at === null && r.last_pull_at === null, JSON.stringify(r));
    await age(device2);
    await heard(device2, null, 12);
    check('T5 with no word on what it did, it was still seen', (await row(device2)).last_push_at === null && (await row(device2)).last_pull_at === null);
  }

  // T6 a till that does not exist
  {
    const ghost = crypto.randomUUID();
    const ok = await heard(ghost, 'pull', 12);
    const n = (await q1(`select count(*)::int n from device_activity where device_id = $1`, [ghost])).n;
    check('T6 a till that is not there is not written down', ok === false && n === 0);
  }

  // T7 the reason for the table: hearing from a till changes nothing a till pulls
  {
    check('T7 the till\'s own row is as it was', (await deviceSeq(device)) === before, before + ' then ' + (await deviceSeq(device)));
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
    const pull = await asApp(tid, `select sync_pull($1::uuid, 0::bigint, 200) as r`, [store]);
    check('T7 it is not part of what a till pulls', pull.rows && !('device_activity' in pull.rows[0].r.changes) && !JSON.stringify(pull.rows[0].r).includes('last_pull_at'), pull.error);

    // T8 a restaurant reads its own tills' rows and nobody else's
    await heard(theirDevice, 'pull', 9);
    const mine = await asApp(tid, `select device_id from device_activity order by device_id`);
    check('T8 a restaurant sees its own tills', mine.rows && mine.rows.length === 2 && mine.rows.every((x) => x.device_id === device || x.device_id === device2), JSON.stringify(mine));
    const theirs = await asApp(other, `select device_id from device_activity`);
    check('T8 and not another restaurant\'s', theirs.rows && theirs.rows.length === 1 && theirs.rows[0].device_id === theirDevice, JSON.stringify(theirs));
    const peek = await asApp(other, `select count(*)::int n from device_activity where device_id = $1`, [device]);
    check('T8 even asked for by name', peek.rows && peek.rows[0].n === 0, JSON.stringify(peek));

    // T9 and cannot write them
    const ins = await asApp(tid, `insert into device_activity (tenant_id, device_id, last_seen_at) values ($1, $2, now())`, [tid, crypto.randomUUID()]);
    check('T9 a restaurant cannot add a row', ins.error !== undefined, JSON.stringify(ins).slice(0, 90));
    const upd = await asApp(tid, `update device_activity set last_seen_at = now() + interval '1 day' where device_id = $1`, [device]);
    check('T9 nor change one', upd.error !== undefined || upd.n === 0, JSON.stringify(upd).slice(0, 90));
    const del = await asApp(tid, `delete from device_activity where device_id = $1`, [device]);
    check('T9 nor remove one', del.error !== undefined || del.n === 0, JSON.stringify(del).slice(0, 90));
    const call = await asApp(tid, `select device_heard($1, 'pull', 1)`, [device]);
    check('T9 nor say a till was heard from', call.error !== undefined, JSON.stringify(call).slice(0, 90));
    check('T9 the row is still there, as it was', (await row(device)) !== undefined && (await row(device)).till_version === 13);
  }

  // T10 a till that is removed takes its row with it, and so does a restaurant
  await c.query(`delete from pos_devices where id = $1`, [device2]);
  check('T10 a till that is removed takes its row with it', (await row(device2)) === undefined);
  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  const left = (await q1(`select count(*)::int n from device_activity where tenant_id in ($1, $2)`, [tid, other])).n;
  check('T10 a restaurant that is removed takes its rows with it', left === 0, String(left));
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
