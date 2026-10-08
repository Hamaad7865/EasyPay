// api-register.test.cjs — which login may set a till up (the API's
// /devices/register and /devices/key).
// The server takes a till's word for who rang something up, and who approved
// it, only from a login that may set up tills (settings.device: the owner's,
// a manager's). A till set up under a cashier's or a waiter's login has every
// approval ignored: a refund a manager approved with their PIN is refused
// after the money has moved. So such a login is told, at set-up, to use the
// owner's or a manager's; and it is not given a till's key in its own name.
//
// The API is run here, in this process, from hello.ts as it is: nothing is
// deployed and nothing is asked of the hosted sign-in service. A token is
// checked the way the API checks one, against a key this test makes and
// serves itself. The restaurant, its logins and its tills are set up straight
// in the dev database and taken away again.
// Usage: node db/tests/api-register.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const jose = require(path.join(ROOT, 'node_modules', 'jose'));
  // the sign-in service's key, stood in for: the API fetches it from here
  const made = await jose.generateKeyPair('ES256');
  const other = await jose.generateKeyPair('ES256');
  const jwk = { ...(await jose.exportJWK(made.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.DATABASE_URL = env.DATABASE_URL;
  process.env.NEON_AUTH_BASE_URL = origin + '/auth';
  process.env.NEON_AUTH_JWKS_URL = origin + '/jwks';
  const token = (sub, key = made.privateKey) =>
    new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setSubject(sub).setIssuer(origin).setIssuedAt().setExpirationTime('5m').sign(key);

  // hello.ts as it is, compiled here
  const ts = require(path.join(ROOT, 'web', 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, 'hello.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require('module').createRequire(path.join(ROOT, 'hello.ts')), mod, mod.exports);
  const app = mod.exports.default;

  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','ApiRegister-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','ARS1') returning id`)).id;
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    // a login: an employee linked to a sign-in (the id is made up; no account exists anywhere)
    const login = async (name, r) => {
      const sub = crypto.randomUUID();
      const id = (await q1(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,$2,$3,$4) returning id`, [tid, name, r, sub])).id;
      return { id, sub, bearer: 'Bearer ' + (await token(sub)) };
    };
    const owner = await login('Owner', await role('Owner', ['*']));
    const manager = await login('Manager', await role('Manager', ['sale.create', 'payment.take', 'sale.refund', 'settings.device']));
    const cashier = await login('Cashier', await role('Cashier', ['sale.create', 'payment.take', 'sale.apply_discount']));

    const call = async (method, route, authorization, body) => {
      const res = await app.request(route, {
        method,
        headers: { ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const said = await res.text();
      let json = null;
      try { json = JSON.parse(said); } catch { /* not json */ }
      return { status: res.status, json, said };
    };
    const till = (code) => ({ storeId: store, deviceId: crypto.randomUUID(), name: 'Till ' + code, code });
    const rowOf = async (id) => q1(`select (select count(*)::int from pos_devices where id = $1) as tills, (select count(*)::int from device_keys where device_id = $1 and revoked_at is null) as keys`, [id]);

    // the stand-in for the sign-in service is a real check, not a way round one
    const nobody = await call('POST', '/devices/register', undefined, till('T0'));
    const stranger = await call('POST', '/devices/register', 'Bearer ' + (await token(owner.sub, other.privateKey)), till('T0'));
    check('A0 with no token, or one signed by another key, nothing is set up', nobody.status === 401 && stranger.status === 401, nobody.status + ' ' + stranger.status);

    // A1 a cashier's login
    const t1 = till('T1');
    const no = await call('POST', '/devices/register', cashier.bearer, t1);
    const left = await rowOf(t1.deviceId);
    check('A1 a login that may not set up tills is refused at set-up', no.status === 403, no.status + ' ' + no.said.slice(0, 120));
    check('A1 and told which login to use', !!no.json && /owner/i.test(no.json.error || '') && /manager/i.test(no.json.error || '') && /PIN/.test(no.json.error || ''), no.said.slice(0, 200));
    check('A1 no till and no key were made for it', left.tills === 0 && left.keys === 0, JSON.stringify(left));

    // A2 a manager's, and the owner's
    const t2 = till('T2');
    const yes = await call('POST', '/devices/register', manager.bearer, t2);
    check('A2 a manager\'s login sets a till up and is given its key', yes.status === 200 && !!yes.json && yes.json.deviceId === t2.deviceId && /^[0-9a-f]{64}$/.test(yes.json.syncKey || ''), yes.status + ' ' + yes.said.slice(0, 120));
    const t3 = till('T3');
    const own = await call('POST', '/devices/register', owner.bearer, t3);
    check('A2 so does the owner\'s', own.status === 200 && !!own.json && /^[0-9a-f]{64}$/.test(own.json.syncKey || ''), own.status + ' ' + own.said.slice(0, 120));
    const key2 = `Device ${t2.deviceId}:${yes.json && yes.json.syncKey}`;
    const pull = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, key2);
    check('A2 and the till syncs with that key', pull.status === 200, pull.status + ' ' + pull.said.slice(0, 80));

    // A3 a key for a till that is already there
    const noKey = await call('POST', '/devices/key', cashier.bearer, { deviceId: t2.deviceId });
    const still = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, key2);
    check('A3 a login that may not set up tills is not given a till\'s key in its own name', noKey.status === 403 && !!noKey.json && /owner/i.test(noKey.json.error || ''), noKey.status + ' ' + noKey.said.slice(0, 120));
    check('A3 and the key the till has still works', still.status === 200, String(still.status));
    const newKey = await call('POST', '/devices/key', owner.bearer, { deviceId: t2.deviceId });
    const withNew = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, `Device ${t2.deviceId}:${newKey.json && newKey.json.syncKey}`);
    check('A3 the owner\'s login is given one, as before, and it works', newKey.status === 200 && withNew.status === 200, newKey.status + ' ' + withNew.status);

    // A4 what such a login could do before, it still can
    const me = await call('GET', '/me', cashier.bearer);
    const ownPull = await call('GET', `/sync/pull?storeId=${store}&cursor=0&limit=5`, cashier.bearer);
    check('A4 a cashier\'s login still reads its own business and syncs a till it is signed in on', me.status === 200 && !!me.json && me.json.tenantId === tid && ownPull.status === 200, me.status + ' ' + ownPull.status);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
