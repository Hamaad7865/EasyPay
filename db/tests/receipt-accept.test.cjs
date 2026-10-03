// receipt-accept.test.cjs — Review item 1: a receipt that carries payments is
// never rejected for amount mismatch. Totals compute per receipt over its own
// lines (discounts/service allowed on every chunk); mismatches store + flag
// with both figures kept. Double-pay stores + flags. Offline modifier drift
// flags but applies.
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RA-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RAS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}')`);
  const emp = (await c.query(`select id from employees where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const item = async (n) => (await c.query(`select id from items where tenant_id='${tid}' and name='${n}'`)).rows[0].id;
  const cp = await item('Cari poulet');
  const dp = await item('Dholl puri');
  const alo = await item('Alouda');
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
  const pay = (id, ticket, num, seq, extra) => op('receipt.create', Object.assign(
    { id, ticket_id: ticket, store_id: store, device_id: dev, number: num, device_seq: seq }, extra));

  // T1: split by item, 10% service on BOTH chunks (Cari 38000 / Dholl 5000)
  // chunk1: sub 38000, svc 1900, VAT 4957 -> total 39900
  // chunk2: sub 5000, svc 250, VAT 652 -> total 5250
  const tk1 = crypto.randomUUID(), rc1a = crypto.randomUUID(), rc1b = crypto.randomUUID();
  await step('T1-setup', async () => { await push([
    op('ticket.create', { id: tk1, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk1, item_id: cp, qty: 1000 }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk1, item_id: dp, qty: 1000 })]); });
  const l1 = (await c.query(`select l.id from ticket_lines l join items i on i.id = l.item_id where l.ticket_id='${tk1}' and i.name='Cari poulet'`)).rows[0].id;
  const l2 = (await c.query(`select l.id from ticket_lines l join items i on i.id = l.item_id where l.ticket_id='${tk1}' and i.name='Dholl puri'`)).rows[0].id;
  let r1;
  await step('T1-chunks', async () => { r1 = await push([
    pay(rc1a, tk1, 'RAS1-T1-1', 1, { line_ids: [l1], service_pct: 500, payments: [{ payment_type_id: cash, amount: 39900 }] }),
    pay(rc1b, tk1, 'RAS1-T1-2', 2, { line_ids: [l2], service_pct: 500, payments: [{ payment_type_id: cash, amount: 5250 }] })]); });
  check('T1 both chunks applied with own service', r1.every((o) => o.status === 'applied'), JSON.stringify(r1));
  const st1 = (await c.query(`select status from tickets where id='${tk1}'`)).rows[0].status;
  check('T1 ticket paid', st1 === 'paid', st1);

  // T2: two tills, one discounted ticket, then the double-pay (spec exit 6)
  // Alouda 9000 - loyalty 10% (900) = 8100 net, VAT (8100*1500+5750)/11500 = 1057, total 8100
  const tk2 = crypto.randomUUID(), rc2a = crypto.randomUUID(), rc2b = crypto.randomUUID();
  await step('T2-setup', async () => { await push([
    op('ticket.create', { id: tk2, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk2, item_id: alo, qty: 1000 })]); });
  await step('T2-pay1', async () => { await push([
    pay(rc2a, tk2, 'RAS1-T1-3', 3, { discounts: [{ discount_id: loy }], payments: [{ payment_type_id: cash, amount: 8100 }] })]); });
  let r2;
  await step('T2-pay2', async () => { r2 = await push([
    pay(rc2b, tk2, 'RAS1-T1-4', 4, { payments: [{ payment_type_id: cash, amount: 8100 }] })]); });
  check('T2 double-pay stored+flagged', r2[0].status === 'applied' && r2[0].data.needs_review === true, JSON.stringify(r2[0]));
  const both = (await c.query(`select count(*)::int n from receipts where ticket_id='${tk2}'`)).rows[0].n;
  check('T2 both receipts kept', both === 2, 'n=' + both);

  // T3: modifier price changed offline -> applies flagged at the snapshot price
  // Cari 38000 + rice snapshot 4000 = 42000, VAT (42000*1500+5750)/11500 = 5478, total 42000
  const tk3 = crypto.randomUUID(), rc3 = crypto.randomUUID();
  await step('T3-setup', async () => { await push([
    op('ticket.create', { id: tk3, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk3, item_id: cp, qty: 1000, modifier_ids: [rice] })]); });
  await c.query(`update modifiers set price = 5000 where id='${rice}'`);
  let r3;
  await step('T3-pay', async () => { r3 = await push([
    pay(rc3, tk3, 'RAS1-T1-5', 5, { payments: [{ payment_type_id: cash, amount: 42000 }] })]); });
  check('T3 drift applies flagged', r3[0].status === 'applied' && r3[0].data.needs_review === true, JSON.stringify(r3[0]));
  const t3 = (await c.query(`select subtotal, total from receipts where id='${rc3}'`)).rows[0];
  check('T3 snapshot totals kept', t3.subtotal === '42000' && t3.total === '42000', JSON.stringify(t3));
  await c.query(`update modifiers set price = 4000 where id='${rice}'`);

  // T4: payment != server total stores both figures flagged
  // Dholl 5000 incl, VAT 652, total 5000; tender 6000 for a 5000 chunk
  const tk4 = crypto.randomUUID(), rc4 = crypto.randomUUID();
  await step('T4-setup', async () => { await push([
    op('ticket.create', { id: tk4, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk4, item_id: dp, qty: 1000 })]); });
  let r4;
  await step('T4-overpay', async () => { r4 = await push([
    pay(rc4, tk4, 'RAS1-T1-6', 6, { payments: [{ payment_type_id: cash, amount: 6000, tendered: 6000, change: 0 }] })]); });
  check('T4 mismatch stored+flagged', r4[0].status === 'applied' && r4[0].data.needs_review === true, JSON.stringify(r4[0]));
  const t4 = (await c.query(`select total from receipts where id='${rc4}'`)).rows[0];
  const p4 = (await c.query(`select sum(amount)::bigint s from receipt_payments where receipt_id='${rc4}'`)).rows[0];
  check('T4 both figures kept', t4.total === '5000' && String(p4.s) === '6000', JSON.stringify([t4, p4]));

  await step('cleanup', async () => {
    await devguard.cleanupTenant(c, tid);
  });
  console.log(failures === 0 ? 'RECEIPT-ACCEPT PASS' : `RECEIPT-ACCEPT FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
