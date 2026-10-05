// ticket-cancel.test.cjs — migration 0057: an order given up is closed, not
// left open for ever with nothing on it.
// Usage: node db/tests/ticket-cancel.test.cjs
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
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Cancel-Probe'), ('${other}','${other}','Cancel-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','CXS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','CXS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const orole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [other])).id;
  const otherOwner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [other, orole])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  await c.query(`select ensure_pos_basics('${other}')`);
  const dp = (await q1(`select id, price from items where tenant_id='${tid}' and name='Dholl puri'`));
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const table = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,'T1') returning id`, [tid, store])).id;
  const takeaway = (await q1(`select id from dining_options where tenant_id=$1 and kind='takeaway'`, [tid])).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const pushTo = (tenant, who, ops) => asApp(tenant, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [who, JSON.stringify(ops)])).rows[0].r);
  const push = (ops) => pushTo(tid, owner, ops);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const ticket = (id) => q1(`select status, table_id, stage from tickets where id = $1`, [id]);

  // T1 a table seated by mistake: the order is closed and lets go of the table
  const seated = crypto.randomUUID();
  {
    const r = await push([
      op('ticket.create', { id: seated, store_id: store, table_id: table, covers: 2 }),
      op('ticket.cancel', { ticket_id: seated }),
    ]);
    const row = await ticket(seated);
    check('T1 an empty order on a table is cancelled', tag(r[1]) === 'applied' && row.status === 'cancelled', r.map(tag).join(' ') + ' ' + JSON.stringify(row));
    check('T1 and the table is free', row.table_id === null, row.table_id);
    const free = await push([op('ticket.create', { id: crypto.randomUUID(), store_id: store, table_id: table, covers: 4 })]);
    check('T1 the next guests can be seated there', tag(free[0]) === 'applied', tag(free[0]));
  }

  // T2 an order with something still on it is not cancelled
  const busy = crypto.randomUUID(), line = crypto.randomUUID();
  {
    const r = await push([
      op('ticket.create', { id: busy, store_id: store }),
      op('ticket.add_line', { id: line, ticket_id: busy, item_id: dp.id, qty: 1000 }),
      op('ticket.cancel', { ticket_id: busy }),
    ]);
    const row = await ticket(busy);
    check('T2 an order with an item on it stays open', tag(r[2]) === 'rejected:conflict' && row.status === 'open', tag(r[2]) + ' ' + row.status);
  }

  // T3 once everything is taken off it can be; its lines are kept, voided
  {
    const r = await push([
      op('ticket.void_line', { line_id: line, reason: 'deleted' }),
      op('ticket.cancel', { ticket_id: busy }),
    ]);
    const row = await ticket(busy);
    const kept = (await q1(`select count(*)::int n, count(voided_at)::int v from ticket_lines where ticket_id = $1`, [busy]));
    check('T3 with every item taken off it is cancelled', r.map(tag).join(' ') === 'applied applied' && row.status === 'cancelled', r.map(tag).join(' ') + ' ' + row.status);
    check('T3 nothing is deleted: the voided line is still there', kept.n === 1 && kept.v === 1, JSON.stringify(kept));
  }

  // T4 sent twice, or after the order was paid, changes nothing and is not refused
  {
    const again = await push([op('ticket.cancel', { ticket_id: busy })]);
    check('T4 cancelling again is answered, not refused', tag(again[0]) === 'applied' && (await ticket(busy)).status === 'cancelled', tag(again[0]));
    const paid = crypto.randomUUID(), pl = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: paid, store_id: store }),
      op('ticket.add_line', { id: pl, ticket_id: paid, item_id: dp.id, qty: 1000 }),
      op('receipt.create', { id: crypto.randomUUID(), ticket_id: paid, store_id: store, device_id: device, number: 'CXS1-T1-000001', device_seq: 1,
        payments: [{ payment_type_id: cash, amount: Number(dp.price) }], discounts: [], line_ids: [pl] }),
      op('ticket.cancel', { ticket_id: paid }),
    ]);
    const row = await ticket(paid);
    check('T4 a paid order stays paid', tag(r[2]) === 'applied' && tag(r[3]) === 'applied' && row.status === 'paid', r.map(tag).join(' ') + ' ' + row.status);
  }

  // T5 an order this restaurant does not have
  {
    const theirs = crypto.randomUUID();
    await pushTo(other, otherOwner, [op('ticket.create', { id: theirs, store_id: otherStore })]);
    const r = await push([op('ticket.cancel', { ticket_id: crypto.randomUUID() }), op('ticket.cancel', { ticket_id: theirs }), op('ticket.cancel', {})]);
    check('T5 an unknown order is refused', tag(r[0]) === 'rejected:bad-ticket', tag(r[0]));
    check('T5 another restaurant\'s order is refused and untouched', tag(r[1]) === 'rejected:bad-ticket' && (await ticket(theirs)).status === 'open', tag(r[1]));
    check('T5 no order named is refused', tag(r[2]) === 'rejected:bad-payload', tag(r[2]));
  }

  // T6 a takeaway given up leaves the board, and takes no payment afterwards
  {
    const t = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: t, store_id: store, dining_option_id: takeaway, order_no: 'A-3', name: 'Kavish', stage: 'new', source: 'Counter' }),
      op('ticket.cancel', { ticket_id: t }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: t, item_id: dp.id, qty: 1000 }),
    ]);
    const row = await ticket(t);
    check('T6 a cancelled takeaway is off the board', tag(r[1]) === 'applied' && row.status === 'cancelled' && row.stage === 'done', tag(r[1]) + ' ' + JSON.stringify(row));
    check('T6 nothing can be added to it afterwards', r[2].status === 'rejected', tag(r[2]));
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
