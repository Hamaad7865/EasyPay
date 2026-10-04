// split-check.test.cjs — migration 0053: splitting a line in two for a split
// check, paying each check on its own receipt, and one receipt paid in
// several shares.
// Usage: node db/tests/split-check.test.cjs
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
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SC-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SCS1') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const card = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Card'`)).id;
  const paidMod = await q1(`select m.id, m.price, m.name from modifiers m where m.tenant_id = $1 and m.price > 0 limit 1`, [tid]);

  async function asApp(fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  const receipt = (ticket, lines, payments) => op('receipt.create', { id: crypto.randomUUID(), ticket_id: ticket, store_id: store, device_id: dev,
    number: 'SC-' + (++seq), device_seq: seq, line_ids: lines, payments });

  // T1 three of the same on one line: one goes to a new line, nothing else changes
  const t = crypto.randomUUID(), a = crypto.randomUUID(), b = crypto.randomUUID();
  {
    await push([
      op('ticket.create', { id: t, store_id: store }),
      op('ticket.add_line', { id: a, ticket_id: t, item_id: dp, qty: 3000, note: 'well done', course: 2 }),
      op('ticket.send', { ticket_id: t, line_ids: [a], sent_at: '2026-03-02T05:00:00Z' }),
    ]);
    const r = await push([op('ticket.split_line', { line_id: a, new_id: b, qty: 1000 })]);
    const rows = (await c.query(`select id, qty, unit_price, note, course, sent_to_kitchen_at, voided_at, paid from ticket_lines where ticket_id = $1 order by qty desc`, [t])).rows;
    const taxes = (await q1(`select (select count(*) from ticket_line_taxes where line_id = $1)::int a, (select count(*) from ticket_line_taxes where line_id = $2)::int b`, [a, b]));
    check('T1 the split is accepted', tag(r[0]) === 'applied', tag(r[0]));
    check('T1 two lines: 2 and 1, same price, note and course', rows.length === 2 && rows[0].id === a && rows[0].qty === 2000 && rows[1].id === b && rows[1].qty === 1000
      && rows[1].unit_price === rows[0].unit_price && rows[1].note === 'well done' && rows[1].course === 2, JSON.stringify(rows.map((x) => x.qty)));
    check('T1 the new line is already with the kitchen, and nothing was voided', rows[1].sent_to_kitchen_at !== null && rows.every((x) => x.voided_at === null));
    check('T1 the new line carries the same taxes', taxes.a > 0 && taxes.a === taxes.b, JSON.stringify(taxes));
  }

  // T2 what cannot be split
  {
    const all = await push([op('ticket.split_line', { line_id: a, new_id: crypto.randomUUID(), qty: 2000 })]);
    const half = await push([op('ticket.split_line', { line_id: a, new_id: crypto.randomUUID(), qty: 500 })]);
    const gone = await push([op('ticket.split_line', { line_id: crypto.randomUUID(), new_id: crypto.randomUUID(), qty: 1000 })]);
    check('T2 the whole quantity cannot be split off', tag(all[0]) === 'rejected:bad-qty', tag(all[0]));
    check('T2 half a unit cannot be split off', tag(half[0]) === 'rejected:bad-qty', tag(half[0]));
    check('T2 an unknown line is refused', tag(gone[0]) === 'rejected:bad-line', tag(gone[0]));
    const t2 = crypto.randomUUID(), m = crypto.randomUUID();
    const add = await push([
      op('ticket.create', { id: t2, store_id: store }),
      op('ticket.add_line', { id: m, ticket_id: t2, item_id: dp, qty: 2000, modifiers: [{ modifier_id: paidMod.id, price: Number(paidMod.price), name: paidMod.name }] }),
    ]);
    const withAddon = await push([op('ticket.split_line', { line_id: m, new_id: crypto.randomUUID(), qty: 1000 })]);
    check('T2 a line with a priced add-on is refused', tag(add[1]) === 'applied' && tag(withAddon[0]) === 'rejected:bad-modifier', tag(add[1]) + ' ' + tag(withAddon[0]));
  }

  // T3 each check is paid on its own receipt; the order closes with the last one
  {
    const before = await q1(`select status from tickets where id = $1`, [t]);
    const one = await push([receipt(t, [b], [{ payment_type_id: cash, amount: 5000, tendered: 10000, change: 5000 }])]);
    const mid = await q1(`select status, (select count(*) from ticket_lines where ticket_id = $1 and paid)::int as paid from tickets where id = $1`, [t]);
    const paidLine = await push([op('ticket.split_line', { line_id: b, new_id: crypto.randomUUID(), qty: 1000 })]);
    // the second check, paid in two shares on one receipt: cash and card
    const two = await push([receipt(t, [a], [{ payment_type_id: cash, amount: 5000, tendered: 5000, change: 0 }, { payment_type_id: card, amount: 5000 }])]);
    const after = await q1(`select status from tickets where id = $1`, [t]);
    const rc = (await c.query(`select total, needs_review, (select count(*) from receipt_payments p where p.receipt_id = r.id)::int as payments from receipts r where ticket_id = $1 order by created_at`, [t])).rows;
    check('T3 the first check is paid and the order stays open', before.status === 'open' && tag(one[0]) === 'applied' && mid.status === 'open' && mid.paid === 1, tag(one[0]));
    check('T3 a paid line cannot be split', tag(paidLine[0]) === 'rejected:paid-line', tag(paidLine[0]));
    check('T3 the second check, in two shares, closes the order', tag(two[0]) === 'applied' && after.status === 'paid', tag(two[0]) + ' ' + after.status);
    check('T3 two receipts of 50 and 100, neither flagged, the second with two payments', rc.length === 2 && rc[0].total === '5000' && rc[1].total === '10000'
      && rc.every((x) => x.needs_review === false) && rc[1].payments === 2, JSON.stringify(rc));
  }

  await devguard.cleanupTenant(c, tid);
  await c.end();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
