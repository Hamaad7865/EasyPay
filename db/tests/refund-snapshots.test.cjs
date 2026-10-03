// refund-snapshots.test.cjs — Item 3: refunds use line tax/discount/modifier
// snapshots, never hardcoded rates. Partial refund of a modded + discounted
// line must carry its modifier money, its discount share, and its snapshot tax.
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
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log('STEPFAIL ' + name + ': ' + e.message); throw e; }
}
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RF-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RFS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}')`);
  const emp = (await c.query(`select id from employees where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const cp = (await c.query(`select id from items where tenant_id='${tid}' and name='Cari poulet'`)).rows[0].id;
  const rice = (await c.query(`select id from modifiers where tenant_id='${tid}' and name='Extra rice'`)).rows[0].id;
  const cash = (await c.query(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).rows[0].id;
  const loy = (await c.query(`select id from discounts where tenant_id='${tid}' and name='Loyalty member'`)).rows[0].id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    let out;
    try { out = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); await c.query('RESET ROLE'); }
    return out;
  }

  // sale: 1x Cari poulet 38000 + Extra rice 4000, loyalty 10%
  // sub = 42000, disc = 4200, net 37800, VAT 15% = 5670, total 43470
  const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
  const sale = await push([
    op('ticket.create', { id: tk, store_id: store }),
    op('ticket.add_line', { id: ln, ticket_id: tk, item_id: cp, qty: 1000, modifier_ids: [rice] }),
    op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'RFS1-T1-1', device_seq: 1,
      discounts: [{ discount_id: loy }], payments: [{ payment_type_id: cash, amount: 43470 }] }),
  ]);
  check('sale applied', sale.every((o) => o.status === 'applied'), JSON.stringify(sale.map((o) => o.status + ':' + (o.code || ''))));

  // change VAT after the sale: refund must use the 1500 snapshot, not 2000
  await c.query(`update taxes set rate_bp = 2000 where tenant_id='${tid}' and name='VAT'`);

  // partial refund: the single line, full qty (with payment recorded)
  const rline = (await c.query(`select id, qty from receipt_lines where receipt_id='${rc}'`)).rows[0];
  const rf = crypto.randomUUID();
  const res = await push([
    op('refund.create', { id: rf, refund_of: rc, store_id: store, device_id: dev, number: 'RFS1-T1-2', device_seq: 2,
      reason: 't', lines: [{ receipt_line_id: rline.id, qty: rline.qty }],
      payments: [{ payment_type_id: cash, amount: 43470 }] }),
  ]);
  check('partial refund applied', res[0].status === 'applied', JSON.stringify(res[0]));
  const got = (await c.query(`select subtotal, discount_total, tax_total, total from receipts where id='${rf}'`)).rows[0];
  // sub 42000 (38000 + 4000 mods), disc share 4200 (whole ticket refunded),
  // tax on (42000-4200) at snapshot 1500 = 5670, total 43470
  check('refund subtotal carries modifier money', got.subtotal === '42000', 'got ' + got.subtotal);
  check('refund discount mirrors original share', got.discount_total === '4200', 'got ' + got.discount_total);
  check('refund tax uses snapshot rate, not current', got.tax_total === '5670', 'got ' + got.tax_total);
  check('refund total assembles', got.total === '43470', 'got ' + got.total);
  const modRows = (await c.query(`select count(*)::int n from receipt_line_modifiers where receipt_line_id in (select id from receipt_lines where receipt_id='${rf}')`)).rows[0].n;
  check('refund copies modifier snapshots', modRows === 1, 'n=' + modRows);
  const taxRows = (await c.query(`select count(*)::int n from receipt_line_taxes where receipt_line_id in (select id from receipt_lines where receipt_id='${rf}')`)).rows[0].n;
  check('refund copies tax snapshots', taxRows === 1, 'n=' + taxRows);
  const payRows = (await c.query(`select amount from receipt_payments where receipt_id='${rf}'`)).rows;
  check('refund records payment rows summing to total',
    payRows.length === 1 && Number(payRows[0].amount) === 43470, JSON.stringify(payRows));

  // T8: several partial refunds against one 2-unit line, cumulative cap enforced.
  // NOTE: VAT is 2000bp here (changed above): sub 18000, tax 3600, total 21600.
  const tk8 = crypto.randomUUID(), rc8 = crypto.randomUUID();
  const cntItems = await c.query(`select count(*)::int n from items where tenant_id='${tid}'`);
  const aloRows = await c.query(`select id from items where tenant_id='${tid}' and name='Alouda'`);
  const alo = aloRows.rows[0].id;
  await step('T8-setup', async () => { const s8 = await push([
    op('ticket.create', { id: tk8, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk8, item_id: alo, qty: 2000 }),
    op('receipt.create', { id: rc8, ticket_id: tk8, store_id: store, device_id: dev, number: 'RFS1-T1-3', device_seq: 3,
      payments: [{ payment_type_id: cash, amount: 21600 }] }),
  ]);
  check('T8-setup applied', s8.every((o) => o.status === 'applied'), JSON.stringify(s8)); });
  const rl8 = (await c.query(`select id from receipt_lines where receipt_id='${rc8}'`)).rows[0].id;
  const rf8a = crypto.randomUUID(), rf8b = crypto.randomUUID(), rf8c = crypto.randomUUID();
  let r8;
  // half qty: sub 9000, tax 1350, total 10350
  await step('T8-part1', async () => { r8 = await push([
    op('refund.create', { id: rf8a, refund_of: rc8, store_id: store, device_id: dev, number: 'RFS1-T1-4', device_seq: 4,
      reason: 't', lines: [{ receipt_line_id: rl8, qty: 1000 }],
      payments: [{ payment_type_id: cash, amount: 10800 }] }),
  ]); });
  check('T8 first partial applies', r8[0].status === 'applied', JSON.stringify(r8[0]));
  await step('T8-part2', async () => { r8 = await push([
    op('refund.create', { id: rf8b, refund_of: rc8, store_id: store, device_id: dev, number: 'RFS1-T1-5', device_seq: 5,
      reason: 't', lines: [{ receipt_line_id: rl8, qty: 1000 }],
      payments: [{ payment_type_id: cash, amount: 10800 }] }),
  ]); });
  check('T8 second partial applies (cumulative respected)', r8[0].status === 'applied', JSON.stringify(r8[0]));
  await step('T8-over', async () => { r8 = await push([
    op('refund.create', { id: rf8c, refund_of: rc8, store_id: store, device_id: dev, number: 'RFS1-T1-6', device_seq: 6,
      reason: 't', lines: [{ receipt_line_id: rl8, qty: 1000 }],
      payments: [{ payment_type_id: cash, amount: 10800 }] }),
  ]); });
  check('T8 over-refund rejected', r8[0].status === 'rejected' && r8[0].code === 'bad-qty', JSON.stringify(r8[0]));

  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} disable trigger trg_no_update`);
  for (const t of ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  for (const t of ['sync_ops_applied','receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes','receipt_payments','receipt_discounts'])
    await c.query(`alter table ${t} enable trigger trg_no_update`);
  console.log(failures === 0 ? 'REFUND-SNAPSHOT PASS' : `REFUND-SNAPSHOT FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
