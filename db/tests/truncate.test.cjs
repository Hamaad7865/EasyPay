// truncate.test.cjs — Item 5: a truncated table must not silently drop rows
// for clients holding a cursor past the rewritten history. sync_truncate()
// bumps a per-table epoch that every sync_pull response carries; clients
// reset to cursor 0 on mismatch.
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','TR-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','TRS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);

  async function pullAsApp(cursor) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    const r = (await c.query(`select sync_pull('${store}', ${cursor}, 200) as r`)).rows[0].r;
    await c.query('COMMIT');
    await c.query('RESET ROLE');
    return r;
  }

  // baseline pull carries epochs
  const p0 = await pullAsApp(0);
  const e0cat = p0.epochs && p0.epochs.categories;
  const e0items = p0.epochs && p0.epochs.items;
  check('pull carries epochs map', Number.isInteger(e0cat) && Number.isInteger(e0items), JSON.stringify(e0cat));
  const n0 = p0.changes.items.length;
  check('baseline sees seeded items', n0 === 43, 'n=' + n0);
  const cursor = p0.next_cursor;

  // history rewrite through the disciplined path + rewound sequence
  // (simulates dump-restore / seq reset; plain TRUNCATE alone would not
  // rewind sync_seq since it owns no serial columns). Catalog + transaction
  // tables go in one statement (FK-safe); stores/roles/employees survive so
  // the tenant stays usable. sync_ops_applied is NEVER truncated (replay log).
  const ALL = ['categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','employee_stores','store_item_overrides',
    'grid_pages','grid_page_items','pos_devices',
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes',
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts'];
  await c.query(`select sync_truncate($1::text[])`, ['{' + ALL.join(',') + '}']);
  await c.query(`select setval('sync_seq', 1, false)`);
  await c.query(`select seed_demo_catalog('${tid}')`);

  const p1 = await pullAsApp(cursor);
  check('epoch bumped for truncated tables', p1.epochs.categories === e0cat + 1 && p1.epochs.items === e0items + 1,
    JSON.stringify({ categories: p1.epochs.categories, items: p1.epochs.items }));
  check('untouched tables keep epoch', p1.epochs.stores === 1 && p1.epochs.roles === 1,
    JSON.stringify({ stores: p1.epochs.stores, roles: p1.epochs.roles }));
  const p2 = await pullAsApp(0);
  check('fresh pull sees reseeded rows', p2.changes.items.length === 43, 'n=' + p2.changes.items.length);

  // cleanup (owner; disable insert-only guards)
  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} disable trigger trg_no_update`).catch(() => {});
  for (const t of ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`).catch((e) => { throw new Error(t + ': ' + e.message); });
  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} enable trigger trg_no_update`).catch(() => {});
  console.log(failures === 0 ? 'TRUNCATE PASS' : `TRUNCATE FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
