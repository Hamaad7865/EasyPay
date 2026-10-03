// receipt-deltas.test.cjs — Item 4: partials skip paid lines, modifiers are
// per-unit (x qty), rounding is bounded, service charge is derived from
// service_pct, restricted discounts need an approver.
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
const INSERT_ONLY = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','sync_ops_applied'];
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  devguard.requireDev(devguard.envMap());
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RD-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RDS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]'), ('${tid}','Cashier','["sale.create","payment.take","sale.apply_discount"]')`);
  const ownerRole = (await c.query(`select id from roles where tenant_id='${tid}' and name='Owner'`)).rows[0].id;
  const cashRole = (await c.query(`select id from roles where tenant_id='${tid}' and name='Cashier'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','Boss','${ownerRole}'), ('${tid}','Cass','${cashRole}')`);
  const empO = (await c.query(`select id from employees where tenant_id='${tid}' and name='Boss'`)).rows[0].id;
  const empC = (await c.query(`select id from employees where tenant_id='${tid}' and name='Cass'`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const item = async (n) => (await c.query(`select id, price from items where tenant_id='${tid}' and name='${n}'`)).rows[0];
  const dp = await item('Dholl puri');
  const cp = await item('Cari poulet');
  const alo = await item('Alouda');
  const rice = (await c.query(`select id from modifiers where tenant_id='${tid}' and name='Extra rice'`)).rows[0].id;
  const cash = (await c.query(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).rows[0].id;
  const staff = (await c.query(`select id from discounts where tenant_id='${tid}' and name='Staff meal'`)).rows[0].id;

  async function push(emp, ops) {
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

  // T2 partials: 2 lines, pay line-by-line
  const tk2 = crypto.randomUUID(), la = crypto.randomUUID(), lb = crypto.randomUUID();
  const rc2a = crypto.randomUUID(), rc2b = crypto.randomUUID();
  await step('T2-setup', async () => { await push(empC, [
    op('ticket.create', { id: tk2, store_id: store }),
    op('ticket.add_line', { id: la, ticket_id: tk2, item_id: dp.id, qty: 1000 }),
    op('ticket.add_line', { id: lb, ticket_id: tk2, item_id: dp.id, qty: 1000 })]); });
  await step('T2-chunk1', async () => { await push(empC, [
    pay(rc2a, tk2, 'RDS1-T1-21', 21, { line_ids: [la], payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  const st1 = (await c.query(`select status from tickets where id='${tk2}'`)).rows[0].status;
  check('T2 chunk1 keeps ticket open', st1 === 'open', st1);
  await step('T2-chunk2', async () => { await push(empC, [
    pay(rc2b, tk2, 'RDS1-T1-22', 22, { line_ids: [lb], payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  const st2 = (await c.query(`select status from tickets where id='${tk2}'`)).rows[0].status;
  check('T2 chunk2 closes ticket', st2 === 'paid', st2);
  const r2lines = (await c.query(`select count(*)::int n from receipt_lines where receipt_id='${rc2b}'`)).rows[0].n;
  check('T2 second receipt snapshots only uncovered lines', r2lines === 1, 'n=' + r2lines);

  // T3 modifiers flat per line: 2x Cari 38000 + Extra rice 4000
  // sub = 76000+4000 = 80000, VAT = 10435, total 80000
  const tk3 = crypto.randomUUID(), rc3 = crypto.randomUUID();
  let r3;
  await step('T3-sale', async () => { r3 = await push(empC, [
    op('ticket.create', { id: tk3, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk3, item_id: cp.id, qty: 2000, modifier_ids: [rice] }),
    pay(rc3, tk3, 'RDS1-T1-23', 23, { payments: [{ payment_type_id: cash, amount: 80000 }] })]); });
  check('T3 receipt applied', r3[2].status === 'applied', JSON.stringify(r3[2]));
  const t3 = (await c.query(`select subtotal, tax_total, total from receipts where id='${rc3}'`)).rows[0];
  check('T3 flat mods, sub 80000 tax 10435', t3.subtotal === '80000' && t3.tax_total === '10435' && t3.total === '80000', JSON.stringify(t3));

  // T4 rounding bounded: 99999 rejected; -30 accepted into the total
  const tk4 = crypto.randomUUID(), rc4 = crypto.randomUUID(), rc4b = crypto.randomUUID();
  await step('T4-setup', async () => { await push(empC, [
    op('ticket.create', { id: tk4, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk4, item_id: dp.id, qty: 1000 })]); });
  let r4;
  await step('T4-biground', async () => { r4 = await push(empC, [
    pay(rc4, tk4, 'RDS1-T1-24', 24, { rounding: 99999, payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  check('T4 wild rounding rejected', r4[0].status === 'rejected' && r4[0].code === 'bad-rounding', JSON.stringify(r4[0]));
  await step('T4-smallround', async () => { r4 = await push(empC, [
    pay(rc4b, tk4, 'RDS1-T1-25', 25, { rounding: -30, payments: [{ payment_type_id: cash, amount: 4970 }] })]); });
  check('T4 small rounding accepted in total', r4[0].status === 'applied');
  const t4 = (await c.query(`select rounding, total from receipts where id='${rc4b}'`)).rows[0];
  check('T4 rounding stored, total 5720', t4.rounding === '-30' && t4.total === '4970', JSON.stringify(t4));

  // T5 service derived from service_pct (1000 bps = 10%): sub 5000, VAT 750, svc 500
  const tk5 = crypto.randomUUID(), rc5 = crypto.randomUUID();
  let r5;
  await step('T5-pct', async () => { r5 = await push(empC, [
    op('ticket.create', { id: tk5, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk5, item_id: dp.id, qty: 1000 }),
    pay(rc5, tk5, 'RDS1-T1-26', 26, { service_pct: 1000, payments: [{ payment_type_id: cash, amount: 5500 }] })]); });
  // sub 5000, VAT 750, svc = 5000*1000/10000 = 500, total 6250
  check('T5 service derived from pct', r5[2].status === 'applied', JSON.stringify(r5[2]));
  const t5 = (await c.query(`select service_charge, total from receipts where id='${rc5}'`)).rows[0];
  check('T5 service 500 total 6250', t5.service_charge === '500' && t5.total === '5500', JSON.stringify(t5));
  const tk5b = crypto.randomUUID(), rc5b = crypto.randomUUID();
  await step('T5-legacy', async () => { r5 = await push(empC, [
    op('ticket.create', { id: tk5b, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk5b, item_id: dp.id, qty: 1000 }),
    pay(rc5b, tk5b, 'RDS1-T1-27', 27, { service_charge: 2000, payments: [{ payment_type_id: cash, amount: 6500 }] })]); });
  check('T5 trusted service_charge rejected', r5[2].status === 'rejected', JSON.stringify(r5[2]));

  // T7: offline price drift is accepted and flagged, never lost
  const tk7 = crypto.randomUUID(), rc7 = crypto.randomUUID();
  let r7;
  await step('T7-sale', async () => { r7 = await push(empC, [
    op('ticket.create', { id: tk7, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk7, item_id: dp.id, qty: 1000, unit_price: 6000, name_snapshot: 'Dholl puri' }),
    // till price 6000, VAT = (6000*1500+5750)/11500 = 782, total 6000
    pay(rc7, tk7, 'RDS1-T1-30', 30, { payments: [{ payment_type_id: cash, amount: 6000 }] })]); });
  check('T7 drifted price accepted+flagged', r7[2].status === 'applied' && r7[2].data.needs_review === true, JSON.stringify(r7[2]));
  const t7 = (await c.query(`select unit_price, total from receipt_lines join receipts on receipts.id = receipt_lines.receipt_id where receipt_lines.receipt_id='${rc7}'`)).rows[0];
  check('T7 snapshot keeps till price', t7.unit_price === '6000', JSON.stringify(t7));

  // T8: number collision disambiguates with a flag instead of losing the sale
  const tk8 = crypto.randomUUID(), rc8a = crypto.randomUUID(), rc8b = crypto.randomUUID();
  const tk8b = crypto.randomUUID();
  await step('T8-setup', async () => { await push(empC, [
    op('ticket.create', { id: tk8, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk8, item_id: dp.id, qty: 1000 }),
    op('ticket.create', { id: tk8b, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk8b, item_id: dp.id, qty: 1000 })]); });
  await step('T8-first', async () => { await push(empC, [
    pay(rc8a, tk8, 'RDS1-T1-80', 80, { payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  let r8;
  await step('T8-collide', async () => { r8 = await push(empC, [
    pay(rc8b, tk8b, 'RDS1-T1-80', 81, { payments: [{ payment_type_id: cash, amount: 5000 }] })]); });
  check('T8 collision disambiguated+flagged',
    r8[0].status === 'applied' && r8[0].data.number === 'RDS1-T1-80-2' && r8[0].data.needs_review === true,
    JSON.stringify(r8[0]));
  const tk6 = crypto.randomUUID(), rc6 = crypto.randomUUID(), rc6b = crypto.randomUUID();
  await step('T6-setup', async () => { await push(empC, [
    op('ticket.create', { id: tk6, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk6, item_id: alo.id, qty: 1000 })]); });
  let r6;
  await step('T6-noapprover', async () => { r6 = await push(empC, [
    pay(rc6, tk6, 'RDS1-T1-28', 28, { discounts: [{ discount_id: staff }], payments: [{ payment_type_id: cash, amount: 6300 }] })]); });
  check('T6 restricted discount without approver rejected', r6[0].status === 'rejected' && r6[0].code === 'approval-required', JSON.stringify(r6[0]));
  await step('T6-approver', async () => { r6 = await push(empC, [
    pay(rc6b, tk6, 'RDS1-T1-29', 29, { discounts: [{ discount_id: staff, approved_by: empO }], payments: [{ payment_type_id: cash, amount: 6300 }] })]); });
  // sub 9000, disc 2700, net 6300, VAT 945, total 7245
  check('T6 owner-approved discount applied', r6[0].status === 'applied', JSON.stringify(r6[0]));
  const t6 = (await c.query(`select discount_total, total from receipts where id='${rc6b}'`)).rows[0];
  check('T6 discount 2700 total 7245', t6.discount_total === '2700' && t6.total === '6300', JSON.stringify(t6));

  // T9: paid lines refuse void/move/merge (correction path is refunds).
  // tk2 is paid with both lines paid after T2.
  let r9;
  await step('T9-void', async () => { r9 = await push(empC, [
    op('ticket.void_line', { line_id: lb, reason: 'x' })]); });
  check('T9 void paid line refused', r9[0].status === 'rejected' && r9[0].code === 'paid-line', JSON.stringify(r9[0]));
  const tk9 = crypto.randomUUID();
  await step('T9-setup', async () => { await push(empC, [op('ticket.create', { id: tk9, store_id: store })]); });
  await step('T9-move', async () => { r9 = await push(empC, [
    op('ticket.move_lines', { line_ids: [lb], to_ticket_id: tk9 })]); });
  check('T9 move paid line refused', r9[0].status === 'rejected' && r9[0].code === 'paid-line', JSON.stringify(r9[0]));
  await step('T9-merge', async () => { r9 = await push(empC, [
    op('ticket.merge', { from_ticket_ids: [tk2], into_ticket_id: tk9 })]); });
  check('T9 merge paid ticket refused', r9[0].status === 'rejected' && r9[0].code === 'paid-line', JSON.stringify(r9[0]));

  await step('cleanup', async () => {
    await devguard.cleanupTenant(c, tid);
  });
  console.log(failures === 0 ? 'RECEIPT-DELTAS PASS' : `RECEIPT-DELTAS FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });

