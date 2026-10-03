// truncate-lock.test.cjs — Review item 3: sync_truncate is test-only.
// app_user (any tenant role) cannot execute it; only the owner path the
// test itself creates may. The function must not exist as a PUBLIC-callable
// migration artifact.
const fs = require('fs');
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
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());
  await c.query('BEGIN');
  await c.query('SET ROLE app_user');
  await c.query(`SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'`);
  let err = null;
  try {
    await c.query(`select sync_truncate('{categories}')`);
  } catch (e) { err = e; }
  await c.query('COMMIT');
  await c.query('RESET ROLE');
  check('app_user cannot call sync_truncate', err !== null && ['42501', '42883'].includes(err.code),
    err ? err.code + ' ' + err.message.slice(0, 80) : 'no error');
  await c.end();
  console.log(failures === 0 ? 'TRUNCATE-LOCK PASS' : `TRUNCATE-LOCK FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
