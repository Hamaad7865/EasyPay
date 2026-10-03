// fk-restrict.test.cjs — composite FKs must be RESTRICT, never SET NULL:
// deleting a parent with referencing rows must fail loudly, never null
// any tenant_id (which would break RLS + touch_row).
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
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

  const leftovers = await c.query(
    `select c.conname, cl.relname as tbl from pg_constraint c
     join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
     where c.contype = 'f' and c.confdeltype = 'n' and n.nspname = 'public'`);
  check('no composite SET NULL constraints remain', leftovers.rows.length === 0,
    JSON.stringify(leftovers.rows.map((r) => r.tbl + '.' + r.conname)));

  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','FK-Probe')`);
  await c.query(`insert into roles (tenant_id, name) values ('${tid}','R')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','E','${role}')`);
  await c.query(`insert into categories (tenant_id, name) values ('${tid}','C')`);
  const cat = (await c.query(`select id from categories where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into items (tenant_id, category_id, name, price) values ('${tid}','${cat}','I', 100)`);

  const refused = (e, fkey) =>
    e !== null && String(e.code).startsWith('23') && String(e.message).includes('RESTRICT') && String(e.message).includes(fkey);
  let roleErr = null;
  try { await c.query(`delete from roles where tenant_id='${tid}'`); } catch (e) { roleErr = e; }
  check('deleting a referenced role is refused', refused(roleErr, 'employees_tenant_id_role_id_fkey'), roleErr && (roleErr.code + ' :: ' + roleErr.message));
  let catErr = null;
  try { await c.query(`delete from categories where tenant_id='${tid}'`); } catch (e) { catErr = e; }
  check('deleting a referenced category is refused', refused(catErr, 'items_tenant_id_category_id_fkey'), catErr && (catErr.code + ' :: ' + catErr.message));
  const intact = await c.query(`select (select tenant_id from employees where tenant_id='${tid}' limit 1) as e, (select tenant_id from items where tenant_id='${tid}' limit 1) as i`);
  check('tenant_ids intact after refused deletes', intact.rows[0].e === tid && intact.rows[0].i === tid);

  for (const t of ['items','employees','roles','categories','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  console.log(failures === 0 ? 'FK-RESTRICT PASS' : `FK-RESTRICT FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
