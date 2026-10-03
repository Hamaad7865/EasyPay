// offline-price.test.cjs — Review item 4: the offline flag compares against
// the EFFECTIVE catalog price (variant price when the line has a variant,
// store override when one exists), not just items.price. A variant sold at
// catalog price and an override-priced line are clean sales.
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
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log('STEPFAIL ' + name + ': ' + e.message); throw e; }
}
const GUARDS = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','sync_ops_applied'];
const TABLES = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'];
(async () => {
  const fileEnv = loadEnv('.env.local');
  const cs = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || fileEnv.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL;
  const strip2 = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const c = new Client({ connectionString: strip2(cs), ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','OP-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','OPS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}')`);
  const emp = (await c.query(`select id from employees where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await c.query(`select id, price from items where tenant_id='${tid}' and name='Dholl puri'`)).rows[0];
  const cash = (await c.query(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).rows[0].id;
  // variant: large Dholl puri at 7000, no store override yet
  const vr = (await c.query(`insert into item_variants (tenant_id, item_id, name, price) values ('${tid}','${dp.id}','Large', 7000) returning id`)).rows[0].id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    let out;
    try { out = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); await c.query('RESET ROLE'); }
    return out;
  }
  const pay = (id, ticket, num, seq, extra) => op('receipt.create', Object.assign(
    { id, ticket_id: ticket, store_id: store, device_id: dev, number: num, device_seq: seq }, extra));

  // T1: variant sold at catalog variant price -> clean (no flag).
  // line 7000 incl, VAT (7000*1500+5750)/11500 = 913, total 7000.
  const tk1 = crypto.randomUUID(), rc1 = crypto.randomUUID();
  let r1;
  await step('T1-sale', async () => { r1 = await push([
    op('ticket.create', { id: tk1, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk1, item_id: dp.id, variant_id: vr, qty: 1000 }),
    pay(rc1, tk1, 'OPS1-T1-1', 1, { payments: [{ payment_type_id: cash, amount: 7000 }] })]); });
  check('T1 variant at catalog price applies', r1[2].status === 'applied', JSON.stringify(r1[2]));
  check('T1 variant at catalog price is NOT flagged', r1[2].status === 'applied' && r1[2].data.needs_review === false, JSON.stringify(r1[2].data));
  const snap = (await c.query(`select unit_price from receipt_lines where receipt_id='${rc1}'`)).rows[0];
  check('T1 snapshot carries variant price', snap && snap.unit_price === '7000', JSON.stringify(snap));

  // T2: store override 6000; till sends override price -> clean.
  // VAT (6000*1500+5750)/11500 = 783, total 6000.
  await c.query(`insert into store_item_overrides (tenant_id, store_id, item_id, price) values ('${tid}','${store}','${dp.id}', 6000)`);
  const tk2 = crypto.randomUUID(), rc2 = crypto.randomUUID();
  let r2;
  await step('T2-sale', async () => { r2 = await push([
    op('ticket.create', { id: tk2, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk2, item_id: dp.id, qty: 1000, unit_price: 6000 }),
    pay(rc2, tk2, 'OPS1-T1-2', 2, { payments: [{ payment_type_id: cash, amount: 6000 }] })]); });
  check('T2 override price applies unflagged', r2[2].status === 'applied' && r2[2].data.needs_review === false, JSON.stringify(r2[2]));

  // T4: variant + override both present -> variant wins (most specific).
  // Override 6000 on the item, variant Large 7000: line stamps 7000, clean.
  const tk4 = crypto.randomUUID(), rc4 = crypto.randomUUID();
  let r4;
  await step('T4-sale', async () => { r4 = await push([
    op('ticket.create', { id: tk4, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk4, item_id: dp.id, variant_id: vr, qty: 1000 }),
    pay(rc4, tk4, 'OPS1-T1-4', 4, { payments: [{ payment_type_id: cash, amount: 7000 }] })]); });
  check('T4 variant beats override', r4[2].status === 'applied', JSON.stringify(r4[2]));
  check('T4 variant price stamped, unflagged',
    r4[2].status === 'applied' && r4[2].data.needs_review === false, JSON.stringify(r4[2].data));
  const tk3 = crypto.randomUUID(), rc3 = crypto.randomUUID();
  let r3;
  await step('T3-sale', async () => { r3 = await push([
    op('ticket.create', { id: tk3, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk3, item_id: dp.id, qty: 1000, unit_price: 5000 }),
    pay(rc3, tk3, 'OPS1-T1-3', 3, { payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  check('T3 stale catalog price flagged', r3[2].status === 'applied' && r3[2].data.needs_review === true, JSON.stringify(r3[2]));

  await step('cleanup', async () => {
    await devguard.cleanupTenant(c, tid);
  });
  console.log(failures === 0 ? 'OFFLINE-PRICE PASS' : `OFFLINE-PRICE FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
