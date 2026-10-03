// vat-included.test.cjs — Item 4 (owner decision): menu prices INCLUDE VAT.
// Seed VAT must be type 'included'; a plain sale's total equals its subtotal
// with tax_total as the extracted portion, never added on top.
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
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','VI-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','VIS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}')`);
  const emp = (await c.query(`select id from employees where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const vat = (await c.query(`select type, rate_bp from taxes where tenant_id='${tid}' and name='VAT'`)).rows[0];
  check('seed VAT is included type', vat.type === 'included' && vat.rate_bp === 1500, JSON.stringify(vat));
  const dp = (await c.query(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).rows[0].id;
  const cash = (await c.query(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).rows[0].id;

  await c.query('BEGIN');
  await c.query('SET ROLE app_user');
  await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
  const tk = crypto.randomUUID(), rc = crypto.randomUUID();
  const batch = [
    op('ticket.create', { id: tk, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp, qty: 2000 }),
    // 2x5000 = 10000 incl; VAT portion = round(10000*1500/11500) = 1304; total 10000
    op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'VIS1-T1-1', device_seq: 1,
      payments: [{ payment_type_id: cash, amount: 10000 }] }),
  ];
  const r = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(batch)])).rows[0].r;
  await c.query('COMMIT');
  await c.query('RESET ROLE');
  check('sale applied', r.every((o) => o.status === 'applied'), JSON.stringify(r));
  const got = (await c.query(`select subtotal, discount_total, tax_total, total from receipts where id='${rc}'`)).rows[0];
  check('total equals subtotal (VAT inside)', got.subtotal === '10000' && got.total === '10000', JSON.stringify(got));
  check('tax_total extracts the VAT portion', got.tax_total === '1304', 'got ' + got.tax_total);

  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} disable trigger trg_no_update`);
  for (const t of ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} enable trigger trg_no_update`);
  console.log(failures === 0 ? 'VAT-INCLUDED PASS' : `VAT-INCLUDED FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
