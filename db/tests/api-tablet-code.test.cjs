// api-tablet-code.test.cjs — the deployed dev API sets a tablet up with a
// code (migration 0099, POST /devices/redeem), with no login, and gives it a
// till's key that the sync routes take. No login is made: the business and
// its code are set up straight in the dev database, so this is safe on a
// shared dev branch. What a login is refused (setting up a tablet where the
// plan is offline) needs a login and is not asked here.
// Usage: node db/tests/api-tablet-code.test.cjs   (after `neon deploy` to dev)
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
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','ApiCode-Probe','offline')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','ACS1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  await c.query(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Owner',$2,$3)`, [tid, role, crypto.randomUUID()]);
  await c.query(`select ensure_pos_basics('${tid}')`);
  // as /admin leaves a business made on that plan: the settings a till pulls say so
  await c.query(`insert into pos_settings (tenant_id, data) values ($1, jsonb_build_object('plan','offline')) on conflict (tenant_id) do update set data = pos_settings.data || excluded.data`, [tid]);
  const make = async (device) => (await q1(`select tablet_code_make($1, $2, $3) as r`, [tid, store, device || null])).r;

  const call = async (method, path, authorization, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-till-version': '13' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const pulls = (device, key) => call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=20`, `Device ${device}:${key}`);

  try {
    const first = await make();
    const device = crypto.randomUUID(), tabletA = 'tablet-a-' + crypto.randomUUID(), tabletB = 'tablet-b-' + crypto.randomUUID();

    // C1 a tablet is set up with its code, and no login
    const r = await call('POST', '/devices/redeem', null, { code: first.code.toLowerCase(), deviceId: device, tablet: tabletA, name: 'Counter', appVersion: '0.9.0' });
    check('C1 the code sets the tablet up, with no login', r.status === 200 && r.json && r.json.deviceId === device && r.json.tenantId === tid && r.json.storeId === store && r.json.business === 'ApiCode-Probe' && r.json.code === 'T1' && r.json.name === 'Counter' && r.json.moved === false && r.json.lastReceiptSeq === 0, r.status + ' ' + r.text.replace(/[0-9a-f]{64}/g, '<key>').slice(0, 200));
    check('C1 and gives it a till\'s key', r.json && /^[0-9a-f]{64}$/.test(r.json.syncKey || ''));
    const pull = await pulls(device, r.json.syncKey);
    check('C1 which the sync routes take: the tablet pulls its business, told it runs on its tablet', pull.status === 200 && pull.json && typeof pull.json.changes === 'object' && JSON.stringify(pull.json.changes.pos_settings || []).includes('"plan":"offline"'), pull.status + ' ' + pull.text.slice(0, 80));
    const seen = await q1(`select app_version, last_seen_at is not null as seen from pos_devices where id = $1`, [device]);
    check('C1 the till is there for /admin: its build, and that it was heard from', seen && seen.app_version === '0.9.0' && seen.seen === true, JSON.stringify(seen));

    // C2 one code, one tablet
    const thief = await call('POST', '/devices/redeem', null, { code: first.code, deviceId: crypto.randomUUID(), tablet: tabletB });
    check('C2 a second tablet is told the code is used', thief.status === 409 && thief.json && thief.json.why === 'used' && /another tablet/.test(thief.json.error), thief.status + ' ' + thief.text.slice(0, 120));
    const again = await call('POST', '/devices/redeem', null, { code: first.code, deviceId: device, tablet: tabletA });
    check('C2 the tablet that used it may ask again, and has a new key', again.status === 200 && again.json.deviceId === device && again.json.syncKey !== r.json.syncKey);
    check('C2 the key before it opens nothing', (await pulls(device, r.json.syncKey)).status === 401 && (await pulls(device, again.json.syncKey)).status === 200);

    // C3 a tablet that replaces another is that till
    await c.query(`select revoke_device_key($1)`, [device]);
    await c.query(`update tablet_codes set ended_at = now() where device_id = $1 and ended_at is null`, [device]);
    const moved = await make(device);
    const sent = crypto.randomUUID();
    const m = await call('POST', '/devices/redeem', null, { code: moved.code, deviceId: sent, tablet: tabletB });
    check('C3 the new tablet is told which till it now is, whatever id it sent', m.status === 200 && m.json.deviceId === device && m.json.deviceId !== sent && m.json.code === 'T1' && m.json.moved === true, m.status + ' ' + m.text.replace(/[0-9a-f]{64}/g, '<key>').slice(0, 160));
    check('C3 and syncs as it', (await pulls(device, m.json.syncKey)).status === 200);
    const olds = await call('POST', '/devices/redeem', null, { code: first.code, deviceId: device, tablet: tabletA });
    check('C3 the old tablet\'s code is over', olds.status === 409 && olds.json.why === 'ended', olds.status + ' ' + olds.text.slice(0, 120));

    // C4 what is not a code
    const wrong = await call('POST', '/devices/redeem', null, { code: 'AAAA-BBBB-CCCC', deviceId: crypto.randomUUID(), tablet: tabletA });
    const empty = await call('POST', '/devices/redeem', null, { deviceId: crypto.randomUUID(), tablet: tabletA });
    const noDevice = await call('POST', '/devices/redeem', null, { code: first.code, tablet: tabletA });
    const noTablet = await call('POST', '/devices/redeem', null, { code: first.code, deviceId: crypto.randomUUID() });
    const notJson = await call('POST', '/devices/redeem', null, null);
    check('C4 a code that is none of ours is 404, said plainly', wrong.status === 404 && /not a code/.test(wrong.json.error) && empty.status === 404, wrong.status + ' ' + empty.status);
    check('C4 a call that is not a tablet\'s is 400', noDevice.status === 400 && noTablet.status === 400 && notJson.status === 400, [noDevice.status, noTablet.status, notJson.status].join(' '));
    const tills = await q1(`select count(*)::int as n from pos_devices where tenant_id = $1`, [tid]);
    check('C4 and through all of it one till was made', tills.n === 1, String(tills.n));
  } finally {
    await devguard.cleanupTenant(c, tid);
    const left = (await q1(`select count(*)::int n from tablet_codes where tenant_id = $1`, [tid])).n;
    check('Z a business that is removed takes its codes with it', left === 0, String(left));
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + String(e.stack || e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
