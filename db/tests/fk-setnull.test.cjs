// fk-setnull.test.cjs — composite FKs null ONLY the named column (PG15+
// set-null(column)), never tenant_id. Deleting a referenced parent succeeds;
// children keep their tenant and lose just the association. Insert-only
// tables use NO ACTION. Surrogate id PKs allow duplicate pairs.
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
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());

  // plain whole-row SET NULL has no column list; the named form does.
  // confdeltype cannot tell them apart, so match the rendered definition.
  const bad = await c.query(
    `select cl.relname as tbl, c.conname from pg_constraint c
     join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
     where c.contype = 'f' and n.nspname = 'public'
       and pg_get_constraintdef(c.oid) like '%ON DELETE SET NULL'
       and pg_get_constraintdef(c.oid) not like '%ON DELETE SET NULL (%'`);
  check('no whole-row SET NULL constraints remain', bad.rows.length === 0,
    JSON.stringify(bad.rows.map((r) => r.tbl + '.' + r.conname)));

  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','FK-Probe')`);
  await c.query(`insert into roles (tenant_id, name) values ('${tid}','R')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','E','${role}')`);
  await c.query(`insert into categories (tenant_id, name) values ('${tid}','C')`);
  const cat = (await c.query(`select id from categories where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into items (tenant_id, category_id, name, price) values ('${tid}','${cat}','I', 100)`);

  await c.query(`delete from roles where tenant_id='${tid}'`);
  const emp = (await c.query(`select tenant_id, role_id from employees where tenant_id='${tid}'`)).rows[0];
  check('role delete succeeds, only role_id nulled', emp.tenant_id === tid && emp.role_id === null, JSON.stringify(emp));
  await c.query(`delete from categories where tenant_id='${tid}'`);
  const item = (await c.query(`select tenant_id, category_id from items where tenant_id='${tid}'`)).rows[0];
  check('category delete succeeds, only category_id nulled', item.tenant_id === tid && item.category_id === null, JSON.stringify(item));
  const nullTenant = await c.query(`select count(*)::int n from items where tenant_id is null`);
  check('no nulled tenant_id anywhere', nullTenant.rows[0].n === 0);

  for (const t of ['items','employees','roles','categories','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  console.log(failures === 0 ? 'FK-SETNULL PASS' : `FK-SETNULL FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
