// api-till-activity.test.cjs — the deployed dev API writes down when a till
// syncs with its own key (migration 0064), and only then. No login is made:
// the restaurant, the tills and a key are set up straight in the dev
// database, so this is safe on a shared dev branch.
// Usage: node db/tests/api-till-activity.test.cjs   (after `neon deploy` to dev)
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
  const base = String(env.NEON_FUNCTION_API_BASE_URL || '').replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!base) throw new Error('NEON_FUNCTION_API_BASE_URL is not set in .env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','ApiHeard-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','AHS1') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const quiet = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T2','T2') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select ensure_pos_basics('${tid}')`);
  const key = (await q1(`select issue_device_key($1, $2) as k`, [owner, device])).k;

  const call = async (method, path, authorization, body, version) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
        ...(version !== undefined ? { 'x-till-version': String(version) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const mine = `Device ${device}:${key}`;
  const row = async (dev) => q1(`select last_seen_at, last_push_at, last_pull_at, till_version from device_activity where device_id = $1`, [dev]);
  const seqOf = async (dev) => (await q1(`select server_seq::text as s from pos_devices where id = $1`, [dev])).s;
  // as if the till was last heard from a minute ago, so the next call is written
  const age = async (dev) => c.query(
    `update device_activity set last_seen_at = last_seen_at - interval '1 minute', last_push_at = last_push_at - interval '1 minute',
            last_pull_at = last_pull_at - interval '1 minute' where device_id = $1`, [dev]);

  try {
    const health = await call('GET', '/health');
    check('the dev API that is deployed writes down when a till syncs', health.status === 200 && health.json && /^v2-\d{4}$/.test(health.json.build) && health.json.build >= 'v2-0064' && health.json.branch !== 'production', JSON.stringify(health.json));
    check('a till nobody has heard from has no row', (await row(device)) === undefined);
    const seq = await seqOf(device);
    // everything set up so far is behind this place in the queue
    const cursor = (await q1(`select max(server_seq)::text as s from pos_devices where tenant_id = $1`, [tid])).s;

    // T1 a pull with the till's key
    const pull = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=50`, mine, undefined, 77);
    const a = await row(device);
    check('T1 the pull is answered as before', pull.status === 200 && pull.json && typeof pull.json.changes === 'object', pull.status + ' ' + pull.text.slice(0, 80));
    check('T1 and the till is written down as having fetched', a && a.last_pull_at !== null && a.last_seen_at !== null && a.last_push_at === null, JSON.stringify(a));
    check('T1 with the build it said it was', a && a.till_version === 77, a && String(a.till_version));
    check('T1 what it pulled says nothing of this', !pull.text.includes('last_pull_at') && !('device_activity' in (pull.json ? pull.json.changes : {})));

    // T2 a push with the till's key
    await age(device);
    const ticket = crypto.randomUUID();
    const push = await call('POST', '/sync/push', mine, { ops: [{ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: ticket, store_id: store } }] }, 77);
    const b = await row(device);
    check('T2 the push is answered as before', push.status === 200 && Array.isArray(push.json) && push.json[0].status === 'applied', push.status + ' ' + push.text.slice(0, 120));
    check('T2 and the till is written down as having sent', b && b.last_push_at !== null && b.last_seen_at > a.last_seen_at, JSON.stringify(b));

    // T3 a till that updates is seen as updated on its next sync; one that does not say keeps what is known
    const up = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine, undefined, 78);
    check('T3 an updated till shows its new build', up.status === 200 && (await row(device)).till_version === 78);
    await age(device);
    await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine);
    check('T3 a sync that does not say its build keeps the one known', (await row(device)).till_version === 78);

    // T4 a crash report counts as being seen, not as a sync
    await age(device);
    const was = await row(device);
    const crash = await call('POST', '/crash', mine, { reports: [{ trace: 'java.lang.IllegalStateException: probe\n at Probe.kt:1', summary: 'probe', app_version: 'test' }] }, 78);
    const d = await row(device);
    check('T4 a crash report is the till being seen', crash.status === 200 && d.last_seen_at > was.last_seen_at && String(d.last_pull_at) === String(was.last_pull_at) && String(d.last_push_at) === String(was.last_push_at), JSON.stringify(d));

    // T5 what is refused writes nothing
    const wrong = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, `Device ${quiet}:${'0'.repeat(64)}`, undefined, 78);
    const none = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, undefined, undefined, 78);
    check('T5 a call with a wrong key is refused', wrong.status === 401 && none.status === 401, wrong.status + ' ' + none.status);
    check('T5 and no till is written down for it', (await row(quiet)) === undefined);
    await age(device);
    const before = await row(device);
    const bad = await call('GET', `/sync/pull?storeId=${crypto.randomUUID()}&cursor=0&limit=5`, mine, undefined, 78);
    check('T5 a pull that is turned down is not a sync', bad.status === 400 && String((await row(device)).last_pull_at) === String(before.last_pull_at), String(bad.status));

    // T6 the reason the times are kept apart: the till's own row has not moved in the queue
    check('T6 after all of that the till\'s own row is as it was', (await seqOf(device)) === seq, seq + ' then ' + (await seqOf(device)));
    const fresh = await call('GET', `/sync/pull?storeId=${store}&cursor=${cursor}&limit=50`, mine, undefined, 78);
    const devices = fresh.json && fresh.json.changes ? fresh.json.changes.pos_devices : undefined;
    check('T6 so a till that syncs gives the other tills nothing to fetch', fresh.status === 200 && (!devices || devices.length === 0), JSON.stringify(devices));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
