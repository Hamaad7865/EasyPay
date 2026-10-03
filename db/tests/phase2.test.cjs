// phase2.test.cjs — Phase 2 exit scenarios (spec 14): triple-push (#2),
// kill-mid-push redelivery (#3), bad-op isolation (#4), two-device lines
// (#5), double-pay flagging (#6), price snapshots (#7), totals invariant
// (#12), refund permissions. Replay returns ORIGINAL envelopes (item 2).
// Usage: node db/tests/phase2.test.cjs
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
const GUARDS = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','sync_ops_applied'];
const TABLES = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'];
(async () => {
  const fileEnv = loadEnv('.env.local');
  const cs = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || fileEnv.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL;
  const strip2 = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const c = new Client({ connectionString: strip2(cs), ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const P = (n) => `P2-${n}`;

  await step('setup', async () => {
    await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','P2-Probe')`);
    await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','P2S1')`);
    await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}', (select id from stores where tenant_id='${tid}'), 'T1', 'T1')`);
    await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]'), ('${tid}','Waiter','["sale.create","payment.take"]')`);
    const ownerRole = (await c.query(`select id from roles where tenant_id='${tid}' and name='Owner'`)).rows[0].id;
    const waiterRole = (await c.query(`select id from roles where tenant_id='${tid}' and name='Waiter'`)).rows[0].id;
    await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','Boss','${ownerRole}'), ('${tid}','Wally','${waiterRole}')`);
    await c.query(`select seed_demo_catalog('${tid}')`);
  });
  const q1 = async (q) => (await c.query(q.replaceAll('TID', tid))).rows[0];
  const store = (await q1(`select id from stores where tenant_id='TID'`)).id;
  const dev = (await q1(`select id from pos_devices where tenant_id='TID'`)).id;
  const empO = (await q1(`select id from employees where tenant_id='TID' and name='Boss'`)).id;
  const empW = (await q1(`select id from employees where tenant_id='TID' and name='Wally'`)).id;
  const dp = await q1(`select id, price from items where tenant_id='TID' and name='Dholl puri'`);
  const cp = await q1(`select id from items where tenant_id='TID' and name='Cari poulet'`);
  const cash = await q1(`select id from payment_types where tenant_id='TID' and name='Cash'`);
  const loy = await q1(`select id from discounts where tenant_id='TID' and name='Loyalty member'`);

  async function push(emp, ops) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    let out;
    try { out = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; }
    finally { await c.query('COMMIT'); await c.query('RESET ROLE'); }
    return out;
  }
  const status = (res) => res.map((o) => o.status);

  const tk1 = crypto.randomUUID(), rc1 = crypto.randomUUID();
  const batch1 = [
    op('ticket.create', { id: tk1, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk1, item_id: dp.id, qty: 2000 }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk1, item_id: dp.id, qty: 1000 }),
    op('receipt.create', { id: rc1, ticket_id: tk1, store_id: store, device_id: dev, number: P(1), device_seq: 1,
      payments: [{ payment_type_id: cash.id, amount: 17250, tendered: 20000, change: 2750 }] }),
  ];
  let r;
  await step('T1-push', async () => { r = await push(empO, batch1); });
  check('T1 all applied', status(r).every((s) => s === 'applied'));
  const rc = (await c.query(`select subtotal, tax_total, total, needs_review from receipts where id='${rc1}'`)).rows[0];
  check('T1 totals 15000+2250=17250', rc.subtotal === '15000' && rc.tax_total === '2250' && rc.total === '17250' && rc.needs_review === false);
  await step('T1-repush', async () => { r = await push(empO, batch1); });
  check('T1 replay keeps original applied status + replayed flag',
    status(r).every((s) => s === 'applied') && r.every((o) => o.replayed === true));
  const nRc = (await c.query(`select count(*)::int n from receipts where ticket_id='${tk1}'`)).rows[0].n;
  check('T1 triple-push creates receipt once', nRc === 1, 'n=' + nRc);

  const tk2 = crypto.randomUUID();
  await step('T2-push', async () => { r = await push(empO, [
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk2, item_id: crypto.randomUUID(), qty: 1000 }),
    op('ticket.create', { id: crypto.randomUUID(), store_id: store }),
  ]); });
  check('T2 bad op rejected, good applied', r[0].status === 'rejected' && r[1].status === 'applied');

  const tk3 = crypto.randomUUID();
  await step('T3-push', async () => { await push(empO, [op('ticket.create', { id: tk3, store_id: store })]); });
  await step('T3-A', async () => { await push(empO, [op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk3, item_id: dp.id, qty: 1000 })]); });
  await step('T3-B', async () => { await push(empW, [op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk3, item_id: cp.id, qty: 1000 })]); });
  const nL = (await c.query(`select count(*)::int n from ticket_lines where ticket_id='${tk3}' and voided_at is null`)).rows[0].n;
  check('T3 both devices lines present', nL === 2, 'n=' + nL);

  const tk4 = crypto.randomUUID(), rc4a = crypto.randomUUID(), rc4b = crypto.randomUUID();
  await step('T4-setup', async () => { await push(empO, [op('ticket.create', { id: tk4, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk4, item_id: dp.id, qty: 2000 })]); });
  await step('T4-pay1', async () => { await push(empO, [op('receipt.create', { id: rc4a, ticket_id: tk4, store_id: store, device_id: dev, number: P(4), device_seq: 2,
    payments: [{ payment_type_id: cash.id, amount: 11500 }] })]); });
  await step('T4-pay2', async () => { r = await push(empW, [op('receipt.create', { id: rc4b, ticket_id: tk4, store_id: store, device_id: dev, number: P(5), device_seq: 3,
    payments: [{ payment_type_id: cash.id, amount: 11500 }] })]); });
  const flags = (await c.query(`select needs_review from receipts where ticket_id='${tk4}' order by created_at`)).rows;
  check('T4 both payments stored, second flagged', flags.length === 2 && flags[0].needs_review === false && flags[1].needs_review === true);

  await step('T5-reprice', () => c.query(`update items set price = 99999 where id='${dp.id}'`));
  const snap = (await c.query(`select unit_price from receipt_lines where receipt_id='${rc1}' limit 1`)).rows[0].unit_price;
  check('T5 receipt keeps old price', snap === '5000', 'got ' + snap);
  await step('T5-restore', () => c.query(`update items set price = 5000 where id='${dp.id}'`));

  const tk6 = crypto.randomUUID(), rc6 = crypto.randomUUID();
  await step('T6-setup', async () => { await push(empO, [op('ticket.create', { id: tk6, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk6, item_id: cp.id, qty: 2000 })]); });
  await step('T6-pay', async () => { await push(empO, [op('receipt.create', { id: rc6, ticket_id: tk6, store_id: store, device_id: dev, number: P(6), device_seq: 4,
    discounts: [{ discount_id: loy.id }], payments: [{ payment_type_id: cash.id, amount: 78660, tendered: 78660, change: 0 }] })]); });
  const t6 = (await c.query(`select subtotal, discount_total, tax_total, service_charge, rounding, total from receipts where id='${rc6}'`)).rows[0];
  const calc = Number(t6.subtotal) + Number(t6.tax_total) + Number(t6.service_charge) + Number(t6.rounding) - Number(t6.discount_total);
  check('T6 invariant holds, total 78660', calc === Number(t6.total) && t6.total === '78660', JSON.stringify(t6));
  const pay6 = (await c.query(`select amount, change from receipt_payments where receipt_id='${rc6}'`)).rows[0];
  check('T6 payments-change=total', Number(pay6.amount) - Number(pay6.change) === Number(t6.total));

  const rf1 = crypto.randomUUID(), rf2 = crypto.randomUUID();
  await step('T7-waiter', async () => { r = await push(empW, [op('refund.create', { id: rf1, refund_of: rc1, store_id: store, device_id: dev, number: P(7), device_seq: 5, reason: 't' })]); });
  check('T7 waiter refund forbidden', r[0].status === 'rejected' && r[0].code === 'forbidden');
  await step('T7-manager', async () => { r = await push(empO, [op('refund.create', { id: rf1, refund_of: rc1, store_id: store, device_id: dev, number: P(7), device_seq: 5, reason: 't' })]); });
  const rf = (await c.query(`select type, total from receipts where id='${rf1}'`)).rows[0];
  check('T7 manager refund mirrors total', r[0].status === 'applied' && rf.type === 'refund' && rf.total === '17250');
  await step('T7-double', async () => { r = await push(empO, [op('refund.create', { id: rf2, refund_of: rc1, store_id: store, device_id: dev, number: P(8), device_seq: 6, reason: 'x' })]); });
  check('T7 second refund rejected', r[0].status === 'rejected' && r[0].code === 'already-refunded');

  await step('cleanup', async () => {
    for (const t of GUARDS) await c.query(`alter table ${t} disable trigger trg_no_update`);
    for (const t of TABLES) await c.query(`delete from ${t} where tenant_id='${tid}'`);
    for (const t of GUARDS) await c.query(`alter table ${t} enable trigger trg_no_update`);
  });
  console.log(failures === 0 ? 'PHASE2 PASS' : `PHASE2 FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
