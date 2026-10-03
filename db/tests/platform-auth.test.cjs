// platform-auth.test.cjs — the platform admin end to end, against the real
// auth service and the deployed Function on the DEV branch.
//
// It proves what the code cannot be checked for without real accounts:
//   - a login promoted to 'admin' may create another login with a password,
//     and that login can sign in straight away;
//   - the admin can set a new password for it;
//   - a tenant made by the admin is reachable through the API by its owner;
//   - a suspended tenant still syncs but cannot register a till;
//   - an ordinary login cannot use the admin endpoints; /signup is gone.
//
// It creates two throwaway accounts (…@example.com) and one tenant, and removes
// all of them at the end. Refuses to run against production.
// Usage: node db/tests/platform-auth.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const ORIGIN = 'http://localhost:3000';
const cookiesOf = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''])
  .map((c) => c.split(';')[0]).filter(Boolean).join('; ');

(async () => {
  const env = devguard.envMap();
  const authBase = (env.NEON_AUTH_BASE_URL || '').replace(/\/$/, '');
  const fnBase = (env.NEON_FUNCTION_API_BASE_URL || '').replace(/\/$/, '');
  if (!authBase || !fnBase) throw new Error('NEON_AUTH_BASE_URL and NEON_FUNCTION_API_BASE_URL must be set in .env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();

  const stamp = Date.now();
  const adminEmail = `pa-admin-${stamp}@example.com`, ownerEmail = `pa-owner-${stamp}@example.com`;
  const adminPw = 'Probe-' + crypto.randomBytes(9).toString('base64url');
  const pw1 = 'First-' + crypto.randomBytes(9).toString('base64url');
  const pw2 = 'Second-' + crypto.randomBytes(9).toString('base64url');
  const json = (cookie) => ({ 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) });
  const authPost = (path, body, cookie) => fetch(authBase + path, { method: 'POST', headers: json(cookie), body: JSON.stringify(body) });
  const signIn = (email, password) => authPost('/sign-in/email', { email, password });
  const api = (path, jwt, init) => fetch(fnBase + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` } });
  let tid = null;

  try {
    // 1. a login becomes a platform admin: role in the auth service + a row in platform.admins
    const su = await authPost('/sign-up/email', { email: adminEmail, password: adminPw, name: 'PA Admin' });
    check('1 throwaway admin account created', su.status === 200, 'got ' + su.status);
    const adminId = (await su.json()).user.id;
    await c.query(`update neon_auth."user" set role = 'admin' where id = $1`, [adminId]);
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, $2)`, [adminId, adminEmail]);
    const adminIn = await signIn(adminEmail, adminPw);
    const adminCookie = cookiesOf(adminIn);
    check('1 admin signs in after promotion', adminIn.status === 200 && adminCookie.length > 0, 'got ' + adminIn.status);

    // 2. the admin creates the owner's login, with a password
    const cu = await authPost('/admin/create-user', { email: ownerEmail, password: pw1, name: 'PA Owner', role: 'user' }, adminCookie);
    const cuBody = await cu.json().catch(() => ({}));
    const ownerId = cuBody.user && cuBody.user.id;
    check('2 admin creates a login (role set in SQL is honoured)', cu.status === 200 && !!ownerId, cu.status + ' ' + JSON.stringify(cuBody).slice(0, 140));
    if (!ownerId) throw new Error('admin/create-user did not work; the rest cannot run');

    // 3. that login works straight away
    const in1 = await signIn(ownerEmail, pw1);
    const ownerCookie = cookiesOf(in1);
    check('3 the new login signs in with its initial password', in1.status === 200, 'got ' + in1.status);
    const tok = await fetch(authBase + '/token', { headers: { cookie: ownerCookie, origin: ORIGIN } });
    const jwt = (await tok.json().catch(() => ({}))).token;
    check('3 and gets an API token', typeof jwt === 'string' && jwt.length > 50);

    // 4. before it is linked to a tenant, the API refuses it
    check('4 an unlinked login is refused by the API (403)', (await api('/me', jwt)).status === 403);

    // 5. the admin creates the tenant around that login
    const made = (await c.query(`select platform.create_tenant($1, 'PA Test Restaurant', 'Main', 'PA1', 'PA Owner', $2, 'standard') as r`, [adminId, ownerId])).rows[0].r;
    tid = made.tenant_id;
    const me = await api('/me', jwt);
    const meBody = await me.json().catch(() => ({}));
    check('5 the owner reaches their tenant through the API', me.status === 200 && meBody.tenantId === tid && meBody.status === 'active', me.status + ' ' + JSON.stringify(meBody).slice(0, 140));
    const pushOp = () => ({ ops: [{ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: crypto.randomUUID(), store_id: made.store_id } }] });
    const p1 = await api('/sync/push', jwt, { method: 'POST', body: JSON.stringify(pushOp()) });
    check('5 and can push a sale', p1.status === 200 && (await p1.json())[0].status === 'applied');

    // 6. suspended: sales still sync, a new till is refused; reactivated: allowed again
    await c.query(`select platform.set_tenant_status($1, $2, 'suspended', 'test')`, [adminId, tid]);
    const reg = () => api('/devices/register', jwt, { method: 'POST', body: JSON.stringify({ storeId: made.store_id, deviceId: crypto.randomUUID(), name: 'Till', code: 'T' + Math.floor(Math.random() * 1e6) }) });
    check('6 suspended: registering a till is refused (403)', (await reg()).status === 403);
    const p2 = await api('/sync/push', jwt, { method: 'POST', body: JSON.stringify(pushOp()) });
    check('6 suspended: sales still sync', p2.status === 200 && (await p2.json())[0].status === 'applied');
    check('6 suspended: /me says so', (await (await api('/me', jwt)).json()).status === 'suspended');
    await c.query(`select platform.set_tenant_status($1, $2, 'active', null)`, [adminId, tid]);
    check('6 reactivated: registering a till works', (await reg()).status === 200);

    // 7. the admin sets a new password
    const sp = await authPost('/admin/set-user-password', { userId: ownerId, newPassword: pw2 }, adminCookie);
    check('7 admin sets a new password', sp.status === 200, 'got ' + sp.status);
    check('7 the new password works', (await signIn(ownerEmail, pw2)).status === 200);
    check('7 the old password no longer works', (await signIn(ownerEmail, pw1)).status !== 200);

    // 8. an ordinary login cannot use the admin endpoints; sign-up endpoint is gone
    const sneak = await authPost('/admin/create-user', { email: `pa-sneak-${stamp}@example.com`, password: pw1, name: 'X', role: 'user' }, ownerCookie);
    check('8 an ordinary login cannot create logins', sneak.status === 401 || sneak.status === 403, 'got ' + sneak.status);
    const gone = await api('/signup', jwt, { method: 'POST', body: JSON.stringify({ tenantName: 'x' }) });
    check('8 the API has no sign-up', gone.status === 404, 'got ' + gone.status);
  } finally {
    // remove everything this run created
    try {
      if (tid) await devguard.cleanupTenant(c, tid);
      const ids = (await c.query(`select id from neon_auth."user" where email like $1`, [`pa-%-${stamp}@example.com`])).rows.map((r) => r.id);
      for (const id of ids) await devguard.cleanupPlatform(c, id, tid);
      await c.query(`delete from neon_auth."user" where email like $1`, [`pa-%-${stamp}@example.com`]);
      console.log('cleaned up: ' + ids.length + ' accounts' + (tid ? ', 1 tenant' : ''));
    } catch (e) { console.log('CLEANUP FAILED (remove pa-*-' + stamp + '@example.com by hand): ' + e.message); failures++; }
    await c.end();
  }
  console.log(failures === 0 ? 'PLATFORM-AUTH PASS' : `PLATFORM-AUTH FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
