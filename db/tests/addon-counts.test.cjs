// addon-counts.test.cjs — how many of an add-on a line takes (0105).
//   A line's row for an add-on carries a count, and its price is for that
//   many. The receipt and a refund keep the count, the price is held against
//   the catalog's for that many, and a till built before sends none: one.
// Usage: node db/tests/addon-counts.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','AC-Probe')`);
  const store = (await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','ACS1') returning id`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  const role = (await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]') returning id`)).rows[0].id;
  const emp = (await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}') returning id`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // Dholl puri is 5000 and carries Street add-ons; Extra rougaille is 2500
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id;
  const grp = (await q1(`select id from modifier_groups where tenant_id='${tid}' and name='Street add-ons'`)).id;
  const roug = (await q1(`select id from modifiers where tenant_id='${tid}' and group_id='${grp}' and name='Extra rougaille'`)).id;
  const free = (await q1(`insert into modifiers (tenant_id, group_id, name, price) values ('${tid}','${grp}','Chilli',0) returning id`)).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

  async function asApp(fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  const rcOp = (id, ticket, extra) => op('receipt.create', { id, ticket_id: ticket, store_id: store, device_id: dev, number: 'ACS1-T1-' + (++seq), device_seq: seq, ...extra });
  const pay = (amount) => [{ payment_type_id: cash, amount }];
  const reasons = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id='${rc}' order by reason`)).rows.map((r) => r.reason);
  async function ticketWith(line) {
    const t = crypto.randomUUID(), l = crypto.randomUUID();
    const r = await push([op('ticket.create', { id: t, store_id: store }),
      op('ticket.add_line', { id: l, ticket_id: t, item_id: dp, qty: 1000, ...line })]);
    return { t, l, r: r[1] };
  }
  const lineRow = (l, m) => q1(`select qty, price::text from ticket_line_modifiers where line_id = $1 and modifier_id = $2`, [l, m]);
  const receiptRow = (rc) => q1(`select m.qty, m.price::text from receipt_line_modifiers m join receipt_lines l on l.id = m.receipt_line_id where l.receipt_id = $1`, [rc]);

  // T1 three of an add-on: one row, a count of three, the price of three
  const three = crypto.randomUUID();
  {
    const { t, l, r } = await ticketWith({ unit_price: 5000, modifiers: [{ modifier_id: roug, price: 7500, name: 'Extra rougaille', qty: 3 }] });
    const row = await lineRow(l, roug);
    check('T1 the line keeps three, at the price of three', tag(r) === 'applied' && row.qty === 3 && row.price === '7500', JSON.stringify(row));
    const res = await push([rcOp(three, t, { payments: pay(12500) })]);
    const rc = await q1(`select total::text, needs_review from receipts where id='${three}'`);
    check('T1 the receipt is 5000 and three at 2500', tag(res[0]) === 'applied' && rc.total === '12500', JSON.stringify(rc));
    check('T1 and is not marked for review', rc.needs_review === false && (await reasons(three)).length === 0, JSON.stringify(await reasons(three)));
    const snap = await receiptRow(three);
    check('T1 the receipt keeps three, at the price of three', snap.qty === 3 && snap.price === '7500', JSON.stringify(snap));
  }

  // T2 a till built before this sends no count: one, as it was
  {
    const { t, l } = await ticketWith({ unit_price: 5000, modifiers: [{ modifier_id: roug, price: 2500 }] });
    const row = await lineRow(l, roug);
    const rc = crypto.randomUUID();
    await push([rcOp(rc, t, { payments: pay(7500) })]);
    const snap = await receiptRow(rc);
    check('T2 no count sent is one, unflagged', row.qty === 1 && row.price === '2500' && snap.qty === 1 && (await reasons(rc)).length === 0, JSON.stringify(row));
    const old = await ticketWith({ modifier_ids: [roug] });
    check('T2 the oldest shape (modifier_ids) is one too', (await lineRow(old.l, roug)).qty === 1);
  }

  // T3 a count with no price is charged the catalog's price for that many
  {
    const { l } = await ticketWith({ unit_price: 5000, modifiers: [{ modifier_id: roug, qty: 2 }] });
    const row = await lineRow(l, roug);
    check('T3 two with no price sent are 5000', row.qty === 2 && row.price === '5000', JSON.stringify(row));
  }

  // T4 a count that is not one a line can have is refused
  {
    const none = await ticketWith({ modifiers: [{ modifier_id: roug, price: 0, qty: 0 }] });
    const many = await ticketWith({ modifiers: [{ modifier_id: roug, price: 250000, qty: 100 }] });
    check('T4 none of an add-on is refused', tag(none.r) === 'rejected:bad-payload', tag(none.r));
    check('T4 a hundred is refused', tag(many.r) === 'rejected:bad-payload', tag(many.r));
  }

  // T5 the price really drifted: three charged at 2000 each while the catalog says 2500
  {
    const { t } = await ticketWith({ unit_price: 5000, modifiers: [{ modifier_id: roug, price: 6000, qty: 3 }] });
    const rc = crypto.randomUUID();
    await push([rcOp(rc, t, { payments: pay(11000) })]);
    const d = (await q1(`select detail from receipt_reviews where receipt_id='${rc}' and reason='price-drift'`)) || { detail: { items: [] } };
    check('T5 stored at what the till charged, and marked', (await q1(`select total::text from receipts where id='${rc}'`)).total === '11000'
      && JSON.stringify(await reasons(rc)) === '["price-drift"]', JSON.stringify(await reasons(rc)));
    check('T5 both figures are for the three', d.detail.items.length === 1 && d.detail.items[0].till === 6000 && d.detail.items[0].catalog === 7500, JSON.stringify(d.detail));
  }

  // T6 a refund's rows keep the count
  {
    const line = await q1(`select id, qty from receipt_lines where receipt_id='${three}'`);
    const rf = crypto.randomUUID();
    const res = await push([op('refund.create', { id: rf, refund_of: three, store_id: store, device_id: dev, number: 'ACS1-T1-R1', device_seq: 900,
      reason: 't', lines: [{ receipt_line_id: line.id, qty: line.qty }], payments: pay(12500) })]);
    const snap = await receiptRow(rf);
    const got = await q1(`select total::text from receipts where id='${rf}'`);
    check('T6 the refund is for all of it', tag(res[0]) === 'applied' && got.total === '12500', tag(res[0]) + ' ' + JSON.stringify(got));
    check('T6 and keeps three', snap && snap.qty === 3 && snap.price === '7500', JSON.stringify(snap));
  }

  // T7 the part split off a line keeps the count (a free add-on: a priced one is not divided)
  {
    const t = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID();
    await push([op('ticket.create', { id: t, store_id: store }),
      op('ticket.add_line', { id: a, ticket_id: t, item_id: dp, qty: 2000, modifiers: [{ modifier_id: free, price: 0, qty: 2 }] })]);
    const r = await push([op('ticket.split_line', { line_id: a, new_id: b, qty: 1000 })]);
    const row = await lineRow(b, free);
    check('T7 the new line has two of it', tag(r[0]) === 'applied' && row && row.qty === 2, tag(r[0]) + ' ' + JSON.stringify(row));
  }

  // T9 an add-on is for every one of the item (0123). The owner: a burger at
  // Rs 100 with an egg at Rs 20, two of them, is 120 + 120. Two dholl puris
  // with an extra rougaille each: the line's add-on is two at 2500.
  {
    const two = { qty: 2000, unit_price: 5000 };
    const each = await ticketWith({ ...two, modifiers: [{ modifier_id: roug, price: 5000, name: 'Extra rougaille', qty: 1 }] });
    const rc = crypto.randomUUID();
    await push([rcOp(rc, each.t, { payments: pay(15000) })]);
    const got = await q1(`select total::text, needs_review from receipts where id='${rc}'`);
    check('T9 two with an add-on each: 5000 + 2500, twice', got.total === '15000', JSON.stringify(got));
    check('T9 and is not marked for review', got.needs_review === false && (await reasons(rc)).length === 0, JSON.stringify(await reasons(rc)));
    // a till built before 0123 still charges it once for the line: not drift either
    const once = await ticketWith({ ...two, modifiers: [{ modifier_id: roug, price: 2500, name: 'Extra rougaille', qty: 1 }] });
    const rc2 = crypto.randomUUID();
    await push([rcOp(rc2, once.t, { payments: pay(12500) })]);
    check('T9 an older till, once for the line, is not marked', (await reasons(rc2)).length === 0, JSON.stringify(await reasons(rc2)));
    // neither: marked, and the catalog's figure is for the two
    const off = await ticketWith({ ...two, modifiers: [{ modifier_id: roug, price: 3000, name: 'Extra rougaille', qty: 1 }] });
    const rc3 = crypto.randomUUID();
    await push([rcOp(rc3, off.t, { payments: pay(13000) })]);
    const d = (await q1(`select detail from receipt_reviews where receipt_id='${rc3}' and reason='price-drift'`)) || { detail: { items: [] } };
    check('T9 another price is marked, held against two', JSON.stringify(await reasons(rc3)) === '["price-drift"]'
      && d.detail.items.length === 1 && d.detail.items[0].catalog === 5000, JSON.stringify(d.detail));
  }

  // T8 the count reaches the tills with the row
  {
    const r = await asApp(async () => (await c.query(`select sync_pull($1, 0, 500) as r`, [store])).rows[0].r);
    const rows = (r.changes && r.changes.ticket_line_modifiers) || [];
    check('T8 a pull hands out the count', rows.some((x) => x.modifier_id === roug && x.qty === 3) && rows.every((x) => Number.isInteger(x.qty)), 'rows=' + rows.length);
  }

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'ADDON-COUNTS PASS' : `ADDON-COUNTS FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
