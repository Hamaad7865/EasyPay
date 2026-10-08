// api-till-key.test.cjs — the deployed dev API takes a till's own key on the
// sync routes (migration 0063), and nothing else in its place. No login is
// made: the restaurant, the till and its key are set up straight in the dev
// database, so this is safe on a shared dev branch.
// Usage: node db/tests/api-till-key.test.cjs   (after `neon deploy` to dev)
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','ApiKey-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','AKS1') returning id`)).id;
  const store2 = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Second','AKS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select ensure_pos_basics('${tid}')`);
  const key = (await q1(`select issue_device_key($1, $2) as k`, [owner, device])).k;

  const call = async (method, path, authorization, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const mine = `Device ${device}:${key}`;

  try {
    const health = await call('GET', '/health');
    check('the dev API that is deployed knows about till keys', health.status === 200 && health.json && /^v2-\d{4}$/.test(health.json.build) && health.json.build >= 'v2-0063' && health.json.branch !== 'production', JSON.stringify(health.json));

    // T1 the key opens the sync routes, as the login that set the till up
    const pull = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=50`, mine);
    check('T1 a till pulls with its key', pull.status === 200 && pull.json && typeof pull.json.changes === 'object', pull.status + ' ' + pull.text.slice(0, 80));
    check('T1 and what it pulls holds no keys', !pull.text.includes('key_hash') && !('device_keys' in (pull.json ? pull.json.changes : {})));
    const ticket = crypto.randomUUID();
    const push = await call('POST', '/sync/push', mine, { ops: [{ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: ticket, store_id: store } }] });
    const saved = await q1(`select status, tenant_id from tickets where id = $1`, [ticket]);
    check('T1 a till pushes with its key', push.status === 200 && Array.isArray(push.json) && push.json[0].status === 'applied', push.status + ' ' + push.text.slice(0, 120));
    check('T1 and the order is in its own restaurant', saved && saved.tenant_id === tid && saved.status === 'open', JSON.stringify(saved));
    const crash = await call('POST', '/crash', mine, { reports: [{ trace: 'java.lang.IllegalStateException: probe\n at Probe.kt:1', summary: 'probe', app_version: 'test' }] });
    check('T1 a till reports a crash with its key', crash.status === 200, crash.status + ' ' + crash.text.slice(0, 80));

    // T2 it opens nothing else
    const other = await call('GET', `/sync/pull?storeId=${store2}&cursor=0&limit=5`, mine);
    check('T2 a till does not pull another store', other.status === 400, other.status + ' ' + other.text.slice(0, 80));
    const me = await call('GET', '/me', mine);
    const reg = await call('POST', '/devices/register', mine, { storeId: store, deviceId: crypto.randomUUID(), name: 'X', code: 'X9' });
    const again = await call('POST', '/devices/key', mine, { deviceId: device });
    check('T2 the key is no login: /me', me.status === 401, String(me.status));
    check('T2 it cannot set up a till', reg.status === 401, String(reg.status));
    check('T2 nor ask for a key', again.status === 401, String(again.status));

    // T3 what is not the key is refused
    const wrong = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, `Device ${device}:${'0'.repeat(64)}`);
    const shape = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, 'Device nonsense');
    const none = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`);
    const stranger = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, `Device ${crypto.randomUUID()}:${key}`);
    check('T3 a wrong key is refused', wrong.status === 401, String(wrong.status));
    check('T3 a malformed one is refused', shape.status === 401, String(shape.status));
    check('T3 no key and no login is refused', none.status === 401, String(none.status));
    check('T3 the key of one till does not open another', stranger.status === 401, String(stranger.status));

    // T4 a deactivated till is told so, and syncs again when it is brought back
    await c.query(`update pos_devices set deleted_at = now() where id = $1`, [device]);
    const off = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine);
    check('T4 a deactivated till is refused, and told why', off.status === 403 && off.json && /deactivated/.test(off.json.error), off.status + ' ' + off.text.slice(0, 90));
    await c.query(`update pos_devices set deleted_at = null where id = $1`, [device]);
    check('T4 brought back, it syncs again', (await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine)).status === 200);

    // T5 so is the till of a login that was switched off
    await c.query(`update employees set is_active = false where id = $1`, [owner]);
    const loginOff = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine);
    check('T5 a switched-off login stops its till', loginOff.status === 403 && loginOff.json && /switched off/.test(loginOff.json.error), loginOff.status + ' ' + loginOff.text.slice(0, 90));
    await c.query(`update employees set is_active = true where id = $1`, [owner]);

    // T6 the tablet is signed out: the key ends with it
    const end = await call('DELETE', '/devices/key', mine);
    const after = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, mine);
    check('T6 a till can end its own key', end.status === 200 && end.json && end.json.ended === true, end.status + ' ' + end.text.slice(0, 80));
    check('T6 an ended key opens nothing', after.status === 401, String(after.status));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
