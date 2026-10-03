// api6.test.cjs — Item 6: 409 without tenantId, no DB detail leaks,
// seed-demo by permission, devices/register code conflicts, FK null-column.
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
async function authedUser(authBase, tag) {
  const email = `api6${tag}${Date.now()}@example.com`;
  const su = await fetch(authBase + '/sign-up/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3112' },
    body: JSON.stringify({ email, password: 'Probe1234!', name: tag }),
  });
  if (su.status !== 200) throw new Error('auth signup failed ' + su.status);
  const data = await su.json();
  const cookie = su.headers.get('set-cookie').split(';')[0];
  const tj = await fetch(authBase + '/token', { headers: { cookie, origin: 'http://localhost:3112' } });
  return { sub: data.user.id, jwt: (await tj.json()).token, email };
}
(async () => {
  const fileEnv = (() => { try { return loadEnv('.env.local'); } catch { return {}; } })();
  const pick = (k) => process.env[k] || fileEnv[k];
  const stripCs = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const fnBase = stripCs(pick('NEON_FUNCTION_API_BASE_URL') || '');
  const authBase = stripCs(pick('NEON_AUTH_BASE_URL') || '');
  const httpTests = !!fnBase && !!authBase;
  if (!httpTests) console.log('SKIP http checks T0-T4 (function/auth URLs not set)');
  const c = new Client({ connectionString: stripCs(pick('DATABASE_URL_UNPOOLED') || pick('DATABASE_URL')), ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());
  const H = (jwt) => ({ 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) });
  const post = (path, jwt, body) => statusOf(fetch(fnBase + path, { method: 'POST', headers: H(jwt), body: JSON.stringify(body) }));

  // owner user + tenant (HTTP mode) or direct SQL setup (DB-only mode)
  let tid, storeId;
  if (httpTests) {
  const owner = await authedUser(authBase, 'own');
  const sg = JSON.parse((await post('/signup', owner.jwt, { tenantName: 'API6', storeName: 'Main', storeCode: 'A6S1', ownerName: 'O' })).body);
  tid = sg.tenantId; storeId = sg.storeId;
  const noDetail = (r) => !r.body.includes('"detail"');

  // T0: no token -> 401 (never a tenant); garbage token -> 401
  const t0 = await post('/signup', undefined, { tenantName: 'NoAuth', storeName: 'X', storeCode: 'NX', ownerName: 'X' });
  check('T0 signup without token is 401', t0.status === 401, 'got ' + t0.status);
  const t0b = await post('/signup', 'garbage', { tenantName: 'BadAuth', storeName: 'X', storeCode: 'BX', ownerName: 'X' });
  check('T0 garbage token is 401', t0b.status === 401, 'got ' + t0b.status);

  // T1: duplicate signup 409 carries no tenantId
  const dup = await post('/signup', owner.jwt, { tenantName: 'Again', storeName: 'X', storeCode: 'AX', ownerName: 'X' });
  const dupBody = JSON.parse(dup.body);
  check('T1 409 without tenantId', dup.status === 409 && dupBody.tenantId === undefined, dup.status + ' ' + dup.body.slice(0, 120));

  // T2: error responses carry no database detail
  const bad = await post('/devices/register', owner.jwt, { storeId: crypto.randomUUID(), name: 'X', code: 'T9', deviceId: crypto.randomUUID() });
  check('T2 no detail leak', bad.status === 400 && noDetail({ body: bad.body }), bad.status + ' ' + bad.body.slice(0, 160));

  // T3 seeds (owner seed removed: cashier proves the permission gate)
  const cashier = await authedUser(authBase, 'csh');
  const cashRole = (await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','CashierX','["sale.create","items.edit"]') returning id`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id, auth_user_id) values ('${tid}','CX','${cashRole}','${cashier.sub}')`);
  const seed = await post('/seed-demo', cashier.jwt, {});
  check('T3 permited cashier can seed', seed.status === 200 && JSON.parse(seed.body).seeded === true, seed.status + ' ' + seed.body.slice(0, 160));

  // T4: device code conflicts
  const d1 = crypto.randomUUID(), d2 = crypto.randomUUID();
  const reg1 = await post('/devices/register', owner.jwt, { storeId, name: 'Till A', code: 'TA', deviceId: d1 });
  check('T4 first registration ok', reg1.status === 200, reg1.status + ' ' + reg1.body.slice(0, 120));
  const reg2 = await post('/devices/register', owner.jwt, { storeId, name: 'Till B', code: 'TA', deviceId: d2 });
  check('T4 code held by another device is 409', reg2.status === 409, reg2.status + ' ' + reg2.body.slice(0, 120));
  const reg3 = await post('/devices/register', owner.jwt, { storeId, name: 'Till A', code: 'TA' });
  check('T4 missing deviceId is 400', reg3.status === 400, reg3.status);
  } else {
    tid = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','API6-DB')`);
    await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','A6S1')`);
    storeId = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
    await c.query(`select seed_demo_catalog('${tid}')`);
  }

  // T5: deleting a referenced category nulls only the FK column
  const cat = (await c.query(`select id from categories where tenant_id='${tid}' limit 1`)).rows[0].id;
  let delOk = true, delErr = '';
  try { await c.query(`delete from categories where id='${cat}'`); }
  catch (e) { delOk = false; delErr = e.message.slice(0, 100); }
  check('T5 delete succeeds', delOk, delErr);
  const nullTenant = await c.query(`select count(*)::int n from items where tenant_id is null`);
  check('T5 no nulled tenant_id anywhere', nullTenant.rows[0].n === 0, 'n=' + nullTenant.rows[0].n);
  const uncategorized = await c.query(`select count(*)::int n from items where tenant_id='${tid}' and category_id is null`);
  check('T5 orphaned items kept, uncategorized', uncategorized.rows[0].n > 0, 'n=' + uncategorized.rows[0].n);

  // T6: same modifier twice on one line (surrogate PK)
  const tk = crypto.randomUUID();
  await c.query(`insert into tickets (id, tenant_id, store_id) values ('${tk}','${tid}','${storeId}')`);
  const ln = crypto.randomUUID();
  await c.query(`insert into ticket_lines (id, tenant_id, ticket_id, name_snapshot, unit_price, qty) values ('${ln}','${tid}','${tk}','X', 100, 1000)`);
  const mod = (await c.query(`select id from modifiers where tenant_id='${tid}' limit 1`)).rows[0].id;
  let dupOk = true;
  try {
    await c.query(`insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot) values ('${tid}','${ln}','${mod}','M'), ('${tid}','${ln}','${mod}','M')`);
  } catch (e) { dupOk = false; }
  check('T6 duplicate modifier pair inserts', dupOk);

  // cleanup tenant + probe auth users as owner
  await devguard.cleanupTenant(c, tid);
  if (typeof owner !== 'undefined' && typeof cashier !== 'undefined') {
    await c.query(`delete from neon_auth."user" where email in ('${owner.email}','${cashier.email}')`);
  }
  await c.end();
  console.log(failures === 0 ? 'API6 PASS' : `API6 FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
