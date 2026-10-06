// device-keys.test.cjs — migration 0063: a till that has been set up has a
// key of its own for syncing, which does not lapse and can be stopped.
// Usage: node db/tests/device-keys.test.cjs
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
  const fails = async (sql, args) => { try { await c.query(sql, args); return null; } catch (e) { return e.message; } };
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Key-Probe'), ('${other}','${other}','Key-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','DKS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','DKS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const device2 = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T2','T2') returning id`)).id;
  const theirDevice = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const second = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Second',$2) returning id`, [tid, role])).id;
  const orole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [other])).id;
  const otherOwner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [other, orole])).id;

  const issue = async (emp, dev) => (await q1(`select issue_device_key($1, $2) as k`, [emp, dev])).k;
  const login = async (dev, key) => (await q1(`select device_login($1, $2) as r`, [dev, key])).r;

  // T1 a key is made, and only its fingerprint is kept
  const key = await issue(owner, device);
  {
    const row = await q1(`select encode(key_hash, 'hex') as h, employee_id, revoked_at from device_keys where device_id = $1`, [device]);
    check('T1 a key is 32 random bytes, in hex', /^[0-9a-f]{64}$/.test(key), String(key).length + ' chars');
    check('T1 what is kept is its SHA-256, not the key', row.h === crypto.createHash('sha256').update(key).digest('hex') && row.h !== key, 'stored ' + row.h.slice(0, 8) + '…');
    check('T1 with the login that set the till up', row.employee_id === owner && row.revoked_at === null);
    const who = await login(device, key);
    check('T1 the key says who it is: that login, its restaurant, the till\'s store', who.ok === true && who.employee_id === owner && who.tenant_id === tid && who.store_id === store && who.status === 'active', JSON.stringify(who));
  }

  // T2 anything else is not the key
  {
    const wrong = await login(device, 'f'.repeat(64));
    const none = await login(device, null);
    const elsewhere = await login(device2, key);
    const unknown = await login(crypto.randomUUID(), key);
    check('T2 a wrong key is refused', wrong.ok === false && wrong.why === 'bad-key', JSON.stringify(wrong));
    check('T2 no key is refused', none.ok === false && none.why === 'bad-key', JSON.stringify(none));
    check('T2 a key does not open another till', elsewhere.ok === false && elsewhere.why === 'bad-key', JSON.stringify(elsewhere));
    check('T2 nor a till that does not exist', unknown.ok === false && unknown.why === 'bad-key', JSON.stringify(unknown));
  }

  // T3 issuing again replaces the key: the old one is dead
  const key2 = await issue(second, device);
  {
    const old = await login(device, key);
    const now = await login(device, key2);
    const n = (await q1(`select count(*)::int n from device_keys where device_id = $1`, [device])).n;
    check('T3 a new key is a different key', key2 !== key && /^[0-9a-f]{64}$/.test(key2));
    check('T3 the old key no longer works', old.ok === false && old.why === 'bad-key', JSON.stringify(old));
    check('T3 the new one does, as the login that asked for it', now.ok === true && now.employee_id === second, JSON.stringify(now));
    check('T3 a till has one key at a time', n === 1, String(n));
  }

  // T4 a key that was ended (the tablet was signed out) stays ended until a new one is issued
  {
    const ended = (await q1(`select revoke_device_key($1) as r`, [device])).r;
    const after = await login(device, key2);
    const again = (await q1(`select revoke_device_key($1) as r`, [device])).r;
    check('T4 ending a key is answered', ended === true && again === false, ended + ' ' + again);
    check('T4 an ended key is refused', after.ok === false && after.why === 'revoked', JSON.stringify(after));
    const key3 = await issue(owner, device);
    const fresh = await login(device, key3);
    check('T4 signing in on the till again gives it a new one', fresh.ok === true && (await login(device, key2)).ok === false, JSON.stringify(fresh));
  }

  // T5 switching off the login that set the till up stops its key; switching it back on brings it back
  {
    const k = await issue(second, device2);
    await c.query(`update employees set is_active = false where id = $1`, [second]);
    const off = await login(device2, k);
    await c.query(`update employees set is_active = true where id = $1`, [second]);
    const on = await login(device2, k);
    check('T5 a switched-off login\'s till is stopped', off.ok === false && off.why === 'login-off', JSON.stringify(off));
    check('T5 and syncs again once the login is back', on.ok === true, JSON.stringify(on));
    await c.query(`update employees set is_active = false where id = $1`, [second]);
    const refused = await fails(`select issue_device_key($1, $2)`, [second, device2]);
    await c.query(`update employees set is_active = true where id = $1`, [second]);
    check('T5 a switched-off login cannot ask for a key', /bad-employee/.test(refused || ''), String(refused));
  }

  // T6 a deactivated till is stopped, and is given no new key
  {
    const k = await issue(owner, device2);
    await c.query(`update pos_devices set deleted_at = now() where id = $1`, [device2]);
    const off = await login(device2, k);
    check('T6 a deactivated till\'s key is refused', off.ok === false && off.why === 'till-off', JSON.stringify(off));
    check('T6 and it gets no new one', /bad-device/.test(await fails(`select issue_device_key($1, $2)`, [owner, device2]) || ''));
    await c.query(`update pos_devices set deleted_at = null where id = $1`, [device2]);
    check('T6 reactivated, its key works again', (await login(device2, k)).ok === true);
  }

  // T7 a restaurant's login cannot take a key for another restaurant's till
  {
    check('T7 another restaurant\'s till is refused', /bad-device/.test(await fails(`select issue_device_key($1, $2)`, [owner, theirDevice]) || ''));
    const theirs = await issue(otherOwner, theirDevice);
    const who = await login(theirDevice, theirs);
    check('T7 each till\'s key is its own restaurant\'s', who.ok === true && who.tenant_id === other && who.store_id === otherStore, JSON.stringify(who));
  }

  // T8 the tenant's own connection can neither read the keys nor use the functions
  {
    const asApp = async (sql, args) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        const r = await c.query(sql, args);
        await c.query('ROLLBACK');
        return { rows: r.rows };
      } catch (e) { await c.query('ROLLBACK'); return { error: e.message }; }
    };
    const read = await asApp(`select count(*)::int n from device_keys`);
    check('T8 a tenant connection sees no keys', read.error !== undefined || read.rows[0].n === 0, JSON.stringify(read));
    const make = await asApp(`select issue_device_key($1, $2)`, [owner, device]);
    check('T8 and cannot make one', make.error !== undefined, JSON.stringify(make).slice(0, 90));
    const ask = await asApp(`select device_login($1, $2)`, [device, key]);
    check('T8 nor check one', ask.error !== undefined, JSON.stringify(ask).slice(0, 90));
    const pull = await asApp(`select sync_pull($1::uuid, 0::bigint, 200) as r`, [store]);
    check('T8 the keys are not part of what a till pulls', pull.rows && !('device_keys' in pull.rows[0].r.changes) && !JSON.stringify(pull.rows[0].r).includes('key_hash'), pull.error);
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  const left = (await q1(`select count(*)::int n from device_keys where tenant_id in ($1, $2)`, [tid, other])).n;
  check('T9 a restaurant that is removed takes its keys with it', left === 0, String(left));
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
