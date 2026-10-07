// isolation.test.cjs — Phase 0 exit: two tenants, neither reads/writes the other's rows.
// Usage: node db/tests/isolation.test.cjs  (run db/migrate.cjs first)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

function loadEnv(file) {
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

async function main() {
  let fileEnv = {};
  try { fileEnv = loadEnv('.env.local'); } catch { /* CI uses process env */ }
  const cs = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
    || fileEnv.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL;
  if (!cs) throw new Error('missing DATABASE_URL (env or .env.local)');
  const c = new Client({ connectionString: cs, ssl: { require: true } });
  await c.connect();
  devguard.requireDev({ NEON_BRANCH: process.env.NEON_BRANCH || fileEnv.NEON_BRANCH });
  // Runtime least-privilege: owner has BYPASSRLS, so drop into app_user.
  await c.query('SET ROLE app_user');

  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  const ts = Date.now();

  // Create tenant A + store + category under A's context.
  await c.query('BEGIN');
  await c.query(`SET LOCAL app.tenant_id = '${a}'`);
  await c.query(`insert into tenants (id, tenant_id, name) values ('${a}','${a}','P0-A-${ts}')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${a}','Store A','SA-${ts}')`);
  await c.query(`insert into categories (tenant_id, name) values ('${a}','Cat A')`);
  await c.query('COMMIT');

  await c.query('BEGIN');
  await c.query(`SET LOCAL app.tenant_id = '${b}'`);
  await c.query(`insert into tenants (id, tenant_id, name) values ('${b}','${b}','P0-B-${ts}')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${b}','Store B','SB-${ts}')`);
  await c.query(`insert into categories (tenant_id, name) values ('${b}','Cat B')`);
  await c.query('COMMIT');

  // server_seq stamped? Asked as the owner: app_user with no tenant context
  // sees no rows at all, and a count of nothing would pass whatever happened.
  await c.query('RESET ROLE');
  const seq = await c.query(`select count(*)::int as n, count(server_seq)::int as stamped from categories where tenant_id in ('${a}','${b}')`);
  await c.query('SET ROLE app_user');
  check('server_seq stamped by touch_row', seq.rows[0].n === 2 && seq.rows[0].stamped === 2, `rows seen ${seq.rows[0].n} of 2, stamped ${seq.rows[0].stamped}`);

  // As A: sees only A.
  await c.query('BEGIN');
  await c.query(`SET LOCAL app.tenant_id = '${a}'`);
  let r = await c.query('select id from tenants');
  check('A sees exactly 1 tenant (own)', r.rows.length === 1 && r.rows[0].id === a);
  r = await c.query('select name from categories');
  check('A sees only Cat A', r.rows.length === 1 && r.rows[0].name === 'Cat A');
  r = await c.query(`select id from categories where tenant_id = '${b}'`);
  check('A cannot select B rows', r.rows.length === 0);
  const upd = await c.query(`update categories set name = 'hijack' where tenant_id = '${b}'`);
  check('A cannot update B rows (0 rows)', upd.rowCount === 0);
  let blocked = false;
  try {
    await c.query(`insert into categories (tenant_id, name) values ('${b}','hijack')`);
  } catch { blocked = true; }
  check('A cannot insert with B tenant_id (rejected)', blocked);
  await c.query('ROLLBACK');

  // As B: mirror.
  await c.query('BEGIN');
  await c.query(`SET LOCAL app.tenant_id = '${b}'`);
  r = await c.query('select id from tenants');
  check('B sees exactly 1 tenant (own)', r.rows.length === 1 && r.rows[0].id === b);
  r = await c.query('select name from categories');
  check('B sees only Cat B', r.rows.length === 1 && r.rows[0].name === 'Cat B');
  await c.query('ROLLBACK');

  // No context: sees nothing.
  await c.query('BEGIN');
  r = await c.query('select count(*)::int as n from categories');
  check('no tenant context sees 0 categories', r.rows[0].n === 0);
  await c.query('ROLLBACK');

  // RLS coverage (mirrors rls_coverage.sql).
  const cov = await c.query(fs.readFileSync(path.join(__dirname, 'rls_coverage.sql'), 'utf8'));
  check('rls coverage: every table has RLS+force+policy+touch', cov.rows.length === 0);
  if (cov.rows.length) console.log(JSON.stringify(cov.rows, null, 2));

  // Cleanup as owner through the shared one-transaction helper.
  await c.query('RESET ROLE');
  await devguard.cleanupTenant(c, a);
  await devguard.cleanupTenant(c, b);

  await c.end();
  console.log(failures === 0 ? 'ISOLATION PASS' : `ISOLATION FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
