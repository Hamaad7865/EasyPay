// pull-pages.test.cjs — Item 5: paging to has_more=false must deliver every
// row even when one table is truncated at the limit while another holds newer
// rows. 450 items + 30 newer modifiers, limit 200 -> all 480 must arrive.
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
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','PG-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','PGS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into categories (tenant_id, name) values ('${tid}','Bulk')`);
  const cat = (await c.query(`select id from categories where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into modifier_groups (tenant_id, name) values ('${tid}','Bulk mods')`);
  const grp = (await c.query(`select id from modifier_groups where tenant_id='${tid}'`)).rows[0].id;
  // 450 items first (older seqs)...
  await c.query(`insert into items (tenant_id, category_id, name, price)
    select '${tid}', '${cat}', 'bulk-' || g, 100 from generate_series(1, 450) g`);
  // ...then 30 modifiers (newer seqs).
  await c.query(`insert into modifiers (tenant_id, group_id, name, price)
    select '${tid}', '${grp}', 'mod-' || g, 10 from generate_series(1, 30) g`);

  async function pullAs(cursor, tenant, storeId) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tenant}'`);
    const r = (await c.query(`select sync_pull('${storeId}', ${cursor}, 200) as r`)).rows[0].r;
    await c.query('COMMIT');
    await c.query('RESET ROLE');
    return r;
  }
  async function pull(cursor) { return pullAs(cursor, tid, store); }

  // small catalog: nothing cut off -> next_cursor is the highest sequence
  const tidS = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tidS}','${tidS}','PG-Small')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tidS}','Main','PGSS')`);
  const storeS = (await c.query(`select id from stores where tenant_id='${tidS}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tidS}')`);
  const q0 = await pullAs(0, tidS, storeS);
  let max0 = 0;
  for (const rows of Object.values(q0.changes)) for (const r of rows) max0 = Math.max(max0, r.server_seq || 0);
  check('untruncated pull settles at global max', q0.next_cursor === max0 && !q0.has_more,
    `cursor=${q0.next_cursor} max=${max0} more=${q0.has_more}`);
  for (const t of ['grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','stores','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tidS}'`);

  const items = new Set(), mods = new Set();
  let cursor = 0, rounds = 0, more = true;
  while (more && rounds < 10) {
    const p = await pull(cursor);
    (p.changes.items || []).forEach((r) => items.add(r.id));
    (p.changes.modifiers || []).forEach((r) => mods.add(r.id));
    cursor = p.next_cursor;
    more = p.has_more;
    rounds++;
  }
  check('all 450 items arrive', items.size === 450, 'got ' + items.size);
  check('all 30 modifiers arrive', mods.size === 30, 'got ' + mods.size);
  check('terminates', !more && rounds <= 10, `rounds=${rounds} more=${more}`);

  for (const t of ['modifiers','modifier_groups','items','categories','stores','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  console.log(failures === 0 ? 'PULL-PAGES PASS' : `PULL-PAGES FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
