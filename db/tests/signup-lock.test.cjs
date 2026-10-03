// signup-lock.test.cjs — there is no self-serve sign-up: /signup is gone and
// an unlinked login is refused. PUBLIC cannot execute seed_demo_catalog, and
// /sync/push runs with the employee from the token. Ends with a real user
// linked to a tenant the way the platform admin does it.
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
function loadEnv(file) {
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('='); env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
async function statusOf(promise) {
  try {
    const r = await promise;
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 'FETCH-FAIL', body: e.message }; }
}
(async () => {
  const fileEnv = (() => { try { return loadEnv('.env.local'); } catch { return {}; } })();
  const pick = (k) => process.env[k] || fileEnv[k];
  const fnBase = pick('NEON_FUNCTION_API_BASE_URL');
  const authBase = pick('NEON_AUTH_BASE_URL');
  const httpTests = !!fnBase && !!authBase;
  if (!httpTests) console.log('SKIP http checks (NEON_FUNCTION_API_BASE_URL / NEON_AUTH_BASE_URL not set)');

  // T1: no token -> 401 (not a tenant)
  if (httpTests) {
  const t1 = await statusOf(fetch(fnBase + '/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantName: 'NoAuth', storeName: 'X', storeCode: 'NX', ownerName: 'X' }),
  }));
  check('T1 signup without token is gone (404)', t1.status === 404, 'got ' + t1.status);

  // T2: garbage token -> 401
  const t2 = await statusOf(fetch(fnBase + '/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer garbage' },
    body: JSON.stringify({ tenantName: 'BadAuth', storeName: 'X', storeCode: 'BX', ownerName: 'X' }),
  }));
  check('T2 signup with garbage token is gone (404)', t2.status === 404, 'got ' + t2.status);
  }

  // T3: app_user cannot run the seeder directly (42501)
  const stripCs = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const c = new Client({ connectionString: stripCs(pick('DATABASE_URL_UNPOOLED') || pick('DATABASE_URL')), ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());
  let denied = null;
  try {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${crypto.randomUUID()}'`);
    await c.query(`select seed_demo_catalog('${crypto.randomUUID()}')`);
    await c.query('COMMIT');
  } catch (e) { denied = e; try { await c.query('ROLLBACK'); } catch {} }
  try { await c.query('RESET ROLE'); } catch {}
  check('T3 app_user seeder call denied', denied !== null && denied.code === '42501', denied && (denied.code + ' ' + denied.message));

  // T4: real user end-to-end (dev branch only; needs function + auth URLs)
  if (httpTests) {
  const email = `t4${Date.now()}@example.com`;
  const su = await fetch(authBase + '/sign-up/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3112' },
    body: JSON.stringify({ email, password: 'Probe1234!', name: 'T4' }),
  });
  check('T4 auth signup works', su.status === 200, 'got ' + su.status);
  const sub = (await su.json()).user.id;
  const cookie = su.headers.get('set-cookie').split(';')[0];
  const tj = await fetch(authBase + '/token', { headers: { cookie, origin: 'http://localhost:3112' } });
  const jwt = (await tj.json()).token;
  check('T4 JWT minted', typeof jwt === 'string' && jwt.length > 50);
  // a valid login cannot create its own tenant any more
  const sg = await statusOf(fetch(fnBase + '/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ tenantName: 'T4 Tenant', storeName: 'Main', storeCode: 'T4S1', ownerName: 'T4' }),
  }));
  check('T4 a valid login cannot sign itself up (404)', sg.status === 404, 'got ' + sg.status);
  const unlinked = await statusOf(fetch(fnBase + '/me', { headers: { authorization: `Bearer ${jwt}` } }));
  check('T4 a login with no tenant is refused (403)', unlinked.status === 403, 'got ' + unlinked.status);
  // the platform admin links it to a tenant
  const made = await devguard.createTenantAsAdmin(c, { name: 'T4 Tenant', storeCode: 'T4S1', ownerName: 'T4', ownerAuth: sub });
  const sgBody = { tenantId: made.tid, storeId: made.storeId };
  const me = await statusOf(fetch(fnBase + '/me', { headers: { authorization: `Bearer ${jwt}` } }));
  const meBody = JSON.parse(me.body);
  check('T4 /me sees own tenant', me.status === 200 && meBody.tenantId === sgBody.tenantId, me.status + ' ' + me.body.slice(0, 120));
  const linked = await c.query(`select tenant_id from employees where auth_user_id='${sub}'`);
  check('T4 employee linked to real sub', linked.rows.length === 1 && linked.rows[0].tenant_id === sgBody.tenantId);
  const tk = crypto.randomUUID();
  const push = await statusOf(fetch(fnBase + '/sync/push', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ ops: [{ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: tk, store_id: sgBody.storeId } }] }),
  }));
  check('T4 push with token employee works', push.status === 200 && JSON.parse(push.body)[0].status === 'applied', push.status + ' ' + push.body.slice(0, 160));

  // cleanup the T4 tenant as owner (tenant rows + the probe auth user)
  const tid = sgBody.tenantId;
  await c.query(`delete from neon_auth."user" where email='${email}'`);
  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupPlatform(c, made.adminId, tid);
  } // end httpTests (T4)
  await c.end();
  console.log(failures === 0 ? 'SIGNUP-LOCK PASS' : `SIGNUP-LOCK FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
