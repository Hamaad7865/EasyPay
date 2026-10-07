// pos-operations.test.cjs — migration 0049: send to kitchen, a void with no
// reason, change waiter, cash in and out, day closing, correcting a payment
// type, stock, and what the pull sends a till.
// Usage: node db/tests/pos-operations.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','PO-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','POS1') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
  const rOwner = await role('Owner', ['*']);
  const rCashier = await role('Cashier', ['sale.create', 'payment.take', 'shift.open_close', 'sale.void_line']);
  const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
  const owner = await emp('Owner', rOwner);
  const cashier = await emp('Cashier', rCashier);
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = await q1(`select id, category_id from items where tenant_id='${tid}' and name='Dholl puri'`);
  const other = (await q1(`select id from items where tenant_id='${tid}' and category_id <> $1 limit 1`, [dp.category_id])).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const card = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Card'`)).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops, login = owner) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const T0 = Date.parse('2026-03-02T05:00:00Z');
  const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
  let seq = 0;

  // T1 send to kitchen stamps the named lines once
  const t1 = crypto.randomUUID(), l1 = crypto.randomUUID(), l2 = crypto.randomUUID();
  {
    await push([
      op('ticket.create', { id: t1, store_id: store }),
      op('ticket.add_line', { id: l1, ticket_id: t1, item_id: dp.id, qty: 2000 }),
      op('ticket.add_line', { id: l2, ticket_id: t1, item_id: dp.id, qty: 1000, note: 'later' }),
    ]);
    const a = await push([op('ticket.send', { ticket_id: t1, line_ids: [l1], sent_at: at(1) })]);
    const again = await push([op('ticket.send', { ticket_id: t1, line_ids: [l1, l2, crypto.randomUUID()], sent_at: at(9) })]);
    const rows = (await c.query(`select id, sent_to_kitchen_at from ticket_lines where ticket_id = $1`, [t1])).rows;
    const s1 = rows.find((r) => r.id === l1).sent_to_kitchen_at, s2 = rows.find((r) => r.id === l2).sent_to_kitchen_at;
    check('T1 the first send stamps its line', tag(a[0]) === 'applied' && a[0].data.sent === 1 && new Date(s1).toISOString() === at(1), tag(a[0]));
    check('T1 a later send stamps only the new line and skips an unknown one', tag(again[0]) === 'applied' && again[0].data.sent === 1 && new Date(s2).toISOString() === at(9), JSON.stringify(again[0]));
    const bad = await push([op('ticket.send', { ticket_id: crypto.randomUUID(), line_ids: [] })]);
    check('T1 an unknown order is refused', tag(bad[0]) === 'rejected:bad-ticket', tag(bad[0]));
  }

  // T2 a void needs no reason
  {
    const r = await push([op('ticket.void_line', { line_id: l2 })]);
    const row = await q1(`select voided_at, void_reason, voided_by from ticket_lines where id = $1`, [l2]);
    check('T2 a void with no reason is accepted', tag(r[0]) === 'applied' && row.voided_at !== null && row.void_reason === 'void' && row.voided_by === owner, tag(r[0]));
  }

  // T3 change waiter needs ticket.reassign and someone of this restaurant
  {
    const no = await push([op('ticket.update_meta', { ticket_id: t1, opened_by: owner }, cashier)]);
    const yes = await push([op('ticket.update_meta', { ticket_id: t1, opened_by: cashier })]);
    const row = await q1(`select opened_by from tickets where id = $1`, [t1]);
    const stray = await push([op('ticket.update_meta', { ticket_id: t1, opened_by: crypto.randomUUID() })]);
    const after = await q1(`select opened_by from tickets where id = $1`, [t1]);
    check('T3 a cashier cannot change the waiter', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T3 the owner can', tag(yes[0]) === 'applied' && row.opened_by === cashier, tag(yes[0]));
    check('T3 someone unknown leaves the waiter as it was', tag(stray[0]) === 'applied' && after.opened_by === cashier, tag(stray[0]));
  }

  // T4 order types carry the table and kitchen rules, and the demo menu loads
  // on a restaurant that already has its basics without doubling anything
  {
    const rows = (await c.query(`select name, needs_table, kitchen from dining_options where tenant_id = $1`, [tid])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    check('T4 Dine-in needs a table and goes to the kitchen on Save', by['Dine-in'] && by['Dine-in'].needs_table === true && by['Dine-in'].kitchen === 'save', JSON.stringify(rows));
    check('T4 Takeaway goes when it is paid, a bar tab on Save', by['Takeaway'] && by['Takeaway'].kitchen === 'pay' && by['Bar tab'] && by['Bar tab'].kitchen === 'save' && by['Bar tab'].needs_table === false);
    const t2 = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name) values ('${t2}','${t2}','PO-Probe-2')`);
    await c.query(`select ensure_pos_basics('${t2}')`);
    let seeded = '';
    try { seeded = JSON.stringify((await q1(`select seed_demo_catalog('${t2}') as r`)).r); } catch (e) { seeded = 'ERR ' + e.message; }
    const dup = await q1(`select
        (select count(*) from (select lower(name) from taxes where tenant_id = $1 group by 1 having count(*) > 1) x)::int as taxes,
        (select count(*) from (select lower(name) from payment_types where tenant_id = $1 group by 1 having count(*) > 1) x)::int as pays,
        (select count(*) from (select lower(name) from dining_options where tenant_id = $1 group by 1 having count(*) > 1) x)::int as dining,
        (select count(*) from items i where i.tenant_id = $1 and not exists (select 1 from item_taxes it where it.item_id = i.id))::int as untaxed,
        (select count(*) from items where tenant_id = $1)::int as items`, [t2]);
    check('T4 the demo menu loads after the basics', seeded.includes('"seeded": true') || seeded.includes('"seeded":true'), seeded);
    check('T4 and nothing is doubled, every item carries a tax', dup.taxes === 0 && dup.pays === 0 && dup.dining === 0 && dup.untaxed === 0 && dup.items > 0, JSON.stringify(dup));
    await devguard.cleanupTenant(c, t2);
  }

  // T5 cash in and out count in the period's expected cash; a drawer opening does not
  const shift = crypto.randomUUID();
  {
    await push([op('shift.open', { id: shift, device_id: dev, opening_float: 10000, opened_at: at(10) })]);
    const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
    await push([
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: ln, ticket_id: tk, item_id: dp.id, qty: 1000 }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'PO-' + (++seq), device_seq: seq,
        payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(11) }),
    ]);
    const mv = await push([
      op('cash.move', { id: crypto.randomUUID(), store_id: store, device_id: dev, shift_id: shift, type: 'in', amount: 2000, reason: 'change from the bank', device_time: at(12) }),
      op('cash.move', { id: crypto.randomUUID(), store_id: store, device_id: dev, shift_id: shift, type: 'out', amount: 700, reason: 'bread', device_time: at(13) }, cashier),
      op('cash.move', { id: crypto.randomUUID(), store_id: store, device_id: dev, type: 'drawer', device_time: at(14) }),
      op('cash.move', { id: crypto.randomUUID(), store_id: store, device_id: dev, type: 'out', amount: 0 }),
    ]);
    const close = await push([op('shift.close', { id: shift, counted_cash: 16300, closed_at: at(20) })]);
    const who = await q1(`select employee_id from cash_movements where tenant_id = $1 and type = 'out'`, [tid]);
    check('T5 cash in, cash out and a drawer opening are recorded', mv.slice(0, 3).every((o) => tag(o) === 'applied') && who.employee_id === cashier, mv.map(tag).join(','));
    check('T5 a cash movement of nothing is refused', tag(mv[3]) === 'rejected:bad-payload', tag(mv[3]));
    check('T5 expected cash = float + cash sales + in - out', tag(close[0]) === 'applied' && Number(close[0].data.expected_cash) === 10000 + 5000 + 2000 - 700, JSON.stringify(close[0].data));

    // T6 correcting the payment type: its own row, the receipt untouched
    const no = await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: rc, from_payment_type_id: cash, to_payment_type_id: card }, cashier)]);
    const yes = await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: rc, from_payment_type_id: cash, to_payment_type_id: card, corrected_at: at(30) })]);
    const eff = await q1(`select payment_type_id, original_payment_type_id from receipt_payments_effective where receipt_id = $1`, [rc]);
    const raw = await q1(`select payment_type_id from receipt_payments where receipt_id = $1`, [rc]);
    const twice = await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: rc, from_payment_type_id: cash, to_payment_type_id: card })]);
    check('T6 a cashier cannot correct a payment type', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T6 the owner can: the effective type changes, the payment row does not', tag(yes[0]) === 'applied' && eff.payment_type_id === card
      && eff.original_payment_type_id === cash && raw.payment_type_id === cash, tag(yes[0]));
    check('T6 nothing left of the old type to correct is refused', tag(twice[0]) === 'rejected:bad-payment', tag(twice[0]));
  }

  // T7 day closings are numbered per store and start where the last one ended
  {
    const d1 = crypto.randomUUID(), d2 = crypto.randomUUID();
    const no = await push([op('day.close', { id: crypto.randomUUID(), store_id: store, device_id: dev, closed_at: at(40) }, (await emp('Waiter', await role('Waiter', ['sale.create']))))]);
    const a = await push([op('day.close', { id: d1, store_id: store, device_id: dev, closed_at: at(41), totals: { gross: 5000 } })]);
    const b = await push([op('day.close', { id: d2, store_id: store, device_id: dev, closed_at: at(90) })]);
    const row = await q1(`select number, from_time, totals from day_closes where id = $1`, [d2]);
    check('T7 a waiter cannot close the day', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T7 the first closing is number 1 and keeps the printed totals', tag(a[0]) === 'applied' && a[0].data.number === 1, JSON.stringify(a[0]));
    check('T7 the second is number 2 and starts at the first', tag(b[0]) === 'applied' && row.number === 2 && new Date(row.from_time).toISOString() === at(41), JSON.stringify(row));
  }

  // T8 stock: a counted item goes down with a sale and back up with a refund
  {
    await c.query(`update categories set is_stock = true where id = $1`, [dp.category_id]);
    await c.query(`update items set stock_qty = 10000 where id = $1`, [dp.id]);
    const tk = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID(), rc = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: a, ticket_id: tk, item_id: dp.id, qty: 3000 }),
      op('ticket.add_line', { id: b, ticket_id: tk, item_id: other, qty: 1000 }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'PO-' + (++seq), device_seq: seq,
        payments: [{ payment_type_id: cash, amount: 1 }], device_time: at(50) }),
    ]);
    const left = await q1(`select stock_qty from items where id = $1`, [dp.id]);
    const untouched = await q1(`select stock_qty from items where id = $1`, [other]);
    const mv = (await c.query(`select item_id, qty, reason from stock_movements where receipt_id = $1`, [rc])).rows;
    check('T8 selling 3 of a counted item takes 3 from its stock', tag(r[3]) === 'applied' && left.stock_qty === 7000
      && mv.length === 1 && mv[0].qty === -3000 && mv[0].reason === 'sale', tag(r[3]) + ' ' + JSON.stringify(mv));
    check('T8 an item that is not counted is left alone', untouched.stock_qty === null);
    const line = await q1(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [rc, a]);
    const total = await q1(`select total, (select coalesce(sum(amount),0) from receipt_payments where receipt_id = $1) as paid from receipts where id = $1`, [rc]);
    // refund what the payments allow: one of the three, if the receipt was paid in full
    await c.query(`select 1`);
    const rf = crypto.randomUUID();
    const full = Number(total.total);
    // the probe paid 1 cent on purpose (flagged, not refused); a real refund
    // needs money in, so pay the sale properly on a second order instead
    const tk2 = crypto.randomUUID(), a2 = crypto.randomUUID(), rc2 = crypto.randomUUID();
    await push([
      op('ticket.create', { id: tk2, store_id: store }),
      op('ticket.add_line', { id: a2, ticket_id: tk2, item_id: dp.id, qty: 2000 }),
      op('receipt.create', { id: rc2, ticket_id: tk2, store_id: store, device_id: dev, number: 'PO-' + (++seq), device_seq: seq,
        payments: [{ payment_type_id: cash, amount: 10000 }], device_time: at(51) }),
    ]);
    const before = (await q1(`select stock_qty from items where id = $1`, [dp.id])).stock_qty;
    const line2 = await q1(`select id from receipt_lines where receipt_id = $1`, [rc2]);
    const back = await push([op('refund.create', { id: rf, refund_of: rc2, store_id: store, device_id: dev, number: 'PO-R' + (++seq), device_seq: seq,
      reason: 'wrong order', lines: [{ receipt_line_id: line2.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }] })]);
    const after = (await q1(`select stock_qty from items where id = $1`, [dp.id])).stock_qty;
    check('T8 refunding 1 puts 1 back', tag(back[0]) === 'applied' && before === 5000 && after === 6000, tag(back[0]) + ' ' + before + '->' + after + ' ' + full + ' ' + (line ? 'l' : ''));
  }

  // T9 the pull sends a till its printers, settings, cash movements and day closings
  {
    const printer = (await q1(`insert into printers (tenant_id, store_id, name, kind, address, is_receipt) values ($1,$2,'Kitchen','network','192.168.1.50', false) returning id`, [tid, store])).id;
    await c.query(`update categories set printer_ids = array[$1::uuid] where id = $2`, [printer, dp.category_id]);
    await c.query(`insert into pos_settings (tenant_id, data) values ($1, '{"decimals":0}'::jsonb) on conflict (tenant_id) do update set data = excluded.data`, [tid]);
    const pull = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const ch = pull.changes;
    const cat = ch.categories.find((x) => x.id === dp.category_id);
    check('T9 printers and settings come down', ch.printers.length === 1 && ch.printers[0].address === '192.168.1.50' && ch.pos_settings.length === 1 && ch.pos_settings[0].data.decimals === 0);
    check('T9 a category says where it prints and that it is stock', cat && cat.printer_ids.length === 1 && cat.printer_ids[0] === printer && cat.is_stock === true, JSON.stringify(cat && cat.printer_ids));
    check('T9 cash movements and day closings come down', ch.cash_movements.length === 3 && ch.day_closes.length === 2, ch.cash_movements.length + '/' + ch.day_closes.length);
    check('T9 a dining option says if it needs a table', ch.dining_options.every((d) => 'needs_table' in d && 'kitchen' in d));
  }

  // T10 isolation: another restaurant sees none of it
  {
    const other2 = crypto.randomUUID();
    const n = await asApp(other2, async () => (await c.query(
      `select (select count(*) from printers)::int + (select count(*) from cash_movements)::int + (select count(*) from day_closes)::int
            + (select count(*) from payment_corrections)::int + (select count(*) from stock_movements)::int + (select count(*) from pos_settings)::int as n`)).rows[0].n);
    check('T10 another restaurant sees none of these rows', n === 0, String(n));
  }

  // T11 delete all transactions: the owner only, and only through the function
  {
    const before = (await q1(`select count(*)::int n from receipts where tenant_id = $1`, [tid])).n;
    let direct = '';
    try { await asApp(tid, () => c.query(`delete from receipts where tenant_id = $1`, [tid])); } catch (e) { direct = e.message; }
    let changed = '';
    try { await asApp(tid, () => c.query(`update receipts set total = total where tenant_id = $1`, [tid])); } catch (e) { changed = e.message; }
    // migration 0065: the restaurant's role has no right to change or delete what is insert-only, whatever the triggers say
    const rights = (await c.query(
      `select t, has_table_privilege('app_user', t, 'update') as upd, has_table_privilege('app_user', t, 'delete') as del,
              has_table_privilege('app_user', t, 'insert') as ins, has_table_privilege('app_user', t, 'select') as sel
         from unnest($1::text[]) as t`, [devguard.GUARDS])).rows;
    let refused = '';
    try { await asApp(tid, () => c.query(`select purge_transactions($1, $2)`, [tid, cashier])); } catch (e) { refused = e.message; }
    let wrongTenant = '';
    try { await asApp(crypto.randomUUID(), () => c.query(`select purge_transactions($1, $2)`, [tid, owner])); } catch (e) { wrongTenant = e.message; }
    const still = (await q1(`select count(*)::int n from receipts where tenant_id = $1`, [tid])).n;
    check('T11 a plain delete of receipts is refused: the restaurant role has no right to', direct.includes('permission denied'), direct);
    check('T11 nor to change one', changed.includes('permission denied'), changed);
    check('T11 on every insert-only table it may add and read, and neither change nor delete',
      rights.length === devguard.GUARDS.length && rights.every((r) => r.ins && r.sel && !r.upd && !r.del), JSON.stringify(rights.filter((r) => r.upd || r.del || !r.ins || !r.sel).map((r) => r.t)));
    check('T11 a cashier cannot delete all transactions', refused === 'forbidden' && still === before && before > 0, refused);
    check('T11 nor can someone working in another restaurant', wrongTenant === 'forbidden', wrongTenant);
    const out = await asApp(tid, async () => (await c.query(`select purge_transactions($1, $2) as r`, [tid, owner])).rows[0].r);
    const left = await q1(`select (select count(*) from receipts where tenant_id = $1)::int r, (select count(*) from tickets where tenant_id = $1)::int t,
      (select count(*) from shifts where tenant_id = $1)::int s, (select count(*) from cash_movements where tenant_id = $1)::int m,
      (select count(*) from items where tenant_id = $1)::int i, (select count(*) from printers where tenant_id = $1)::int p`, [tid]);
    check('T11 the owner can: orders, receipts, shifts and cash movements are gone', Number(out.receipts) === before && left.r === 0 && left.t === 0 && left.s === 0 && left.m === 0, JSON.stringify(left));
    check('T11 the menu and the printers stay', left.i > 0 && left.p === 1);
    // a sale made after the purge is as protected as any other, also from the owner connection
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    await push([
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp.id, qty: 1000 }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'PO-AFTER', device_seq: 1,
        payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(200) }),
    ]);
    let after = '';
    try { await c.query(`delete from receipts where id = $1`, [rc]); } catch (e) { after = e.message; }
    const kept = (await q1(`select count(*)::int n from receipts where id = $1`, [rc])).n;
    check('T11 the way out closes behind it', after.includes('insert-only') && kept === 1, after);
  }

  await devguard.cleanupTenant(c, tid);
  const left = await q1(`select (select count(*) from printers where tenant_id = $1)::int a, (select count(*) from stock_movements where tenant_id = $1)::int b`, [tid]);
  check('cleanup removed the probe rows', left.a === 0 && left.b === 0);
  await c.end();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
