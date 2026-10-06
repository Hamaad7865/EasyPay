// ticket-merge.test.cjs — migration 0062: one table's order put onto
// another's. The order merged away closes and frees its table, its guests and
// seats follow its lines, and it takes the permission to transfer an order.
// Usage: node db/tests/ticket-merge.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
// an op names the member of staff who was at the till; the till's own login sends it
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Merge-Probe'), ('${other}','${other}','Merge-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','MGS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','MGS2') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  // a waiter who may take orders but not transfer them
  const wrole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Waiter','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
  const waiter = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Waiter',$2) returning id`, [tid, wrole])).id;
  const orole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [other])).id;
  const otherOwner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [other, orole])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  await c.query(`select ensure_pos_basics('${other}')`);
  const dp = (await q1(`select id, price from items where tenant_id='${tid}' and name='Dholl puri'`));
  const tables = {};
  for (const n of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
    tables[n] = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,$3) returning id`, [tid, store, n])).id;
  }
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
  const ticket = (id) => q1(`select status, table_id, stage, covers, bill_at from tickets where id = $1`, [id]);
  const seats = async (id) => (await c.query(`select seat from ticket_lines where ticket_id = $1 and voided_at is null order by seat nulls first`, [id])).rows.map((r) => r.seat);
  const line = (ticketId, id) => op('ticket.add_line', { id, ticket_id: ticketId, item_id: dp.id, qty: 1000 });

  // T1 table 2's order goes onto table 1's: one order, the guests of both,
  // table 2 free, and table 2's seats numbered on after table 1's
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const a1 = crypto.randomUUID(), a2 = crypto.randomUUID(), b1 = crypto.randomUUID(), b2 = crypto.randomUUID(), b3 = crypto.randomUUID();
  {
    const r = await push([
      op('ticket.create', { id: a, store_id: store, table_id: tables.T1, covers: 4 }),
      op('ticket.create', { id: b, store_id: store, table_id: tables.T2, covers: 2 }),
      line(a, a1), line(a, a2), line(b, b1), line(b, b2), line(b, b3),
      op('ticket.place_lines', { ticket_id: a, line_ids: [a1], seat: 1 }),
      op('ticket.place_lines', { ticket_id: a, line_ids: [a2], seat: 3 }),
      op('ticket.place_lines', { ticket_id: b, line_ids: [b1], seat: 1 }),
      op('ticket.place_lines', { ticket_id: b, line_ids: [b2], seat: 2 }),
      op('ticket.update_meta', { ticket_id: a, bill_at: new Date().toISOString() }),
      op('ticket.merge', { from_ticket_ids: [b], into_ticket_id: a }),
    ]);
    const into = await ticket(a), from = await ticket(b);
    check('T1 every step before the merge was taken', r.slice(0, -1).every((o) => o.status === 'applied'), r.map(tag).join(' '));
    check('T1 the merge is applied', tag(r[r.length - 1]) === 'applied', tag(r[r.length - 1]));
    check('T1 all five lines are on the one order', (await seats(a)).length === 5 && (await seats(b)).length === 0, JSON.stringify(await seats(a)));
    check('T1 the order merged away is closed and off its table', from.status === 'cancelled' && from.table_id === null, JSON.stringify(from));
    check('T1 the guests of both are counted', into.covers === 6 && into.status === 'open' && into.table_id === tables.T1, JSON.stringify(into));
    check('T1 its seats follow on after the four already there', JSON.stringify(await seats(a)) === JSON.stringify([null, 1, 3, 5, 6]), JSON.stringify(await seats(a)));
    check('T1 the bill printed before is no longer asked', into.bill_at === null, String(into.bill_at));
    const free = await push([op('ticket.create', { id: crypto.randomUUID(), store_id: store, table_id: tables.T2, covers: 3 })]);
    check('T1 the next guests can be seated at the table it left', tag(free[0]) === 'applied', tag(free[0]));
  }

  // T2 an order with something already paid on it is not merged away
  {
    const p = crypto.randomUUID(), into = crypto.randomUUID(), pl = crypto.randomUUID();
    await push([
      op('ticket.create', { id: p, store_id: store, table_id: tables.T3, covers: 2 }),
      op('ticket.create', { id: into, store_id: store, table_id: tables.T4, covers: 2 }),
      line(p, pl),
    ]);
    await c.query(`update ticket_lines set paid = true where id = $1`, [pl]);
    const r = await push([op('ticket.merge', { from_ticket_ids: [p], into_ticket_id: into })]);
    const w = await push([op('ticket.merge', { from_ticket_ids: [p], into_ticket_id: into }, waiter)]);
    check('T2 a part-paid order is refused', tag(r[0]) === 'rejected:paid-line' && (await ticket(p)).status === 'open', tag(r[0]));
    check('T2 and says so whoever asks', tag(w[0]) === 'rejected:paid-line', tag(w[0]));
    // the other way round is fine: more goes onto the order that is part paid
    const back = await push([op('ticket.merge', { from_ticket_ids: [into], into_ticket_id: p })]);
    check('T2 the other order can be put onto the part-paid one', tag(back[0]) === 'applied' && (await ticket(into)).status === 'cancelled' && (await ticket(p)).covers === 4, tag(back[0]));
  }

  // T3 it takes the permission to transfer an order, or someone who has it
  {
    const x = crypto.randomUUID(), y = crypto.randomUUID();
    await push([
      op('ticket.create', { id: x, store_id: store, table_id: tables.T5, covers: 2 }),
      op('ticket.create', { id: y, store_id: store, table_id: tables.T6, covers: 2 }),
      line(x, crypto.randomUUID()),
    ]);
    const no = await push([op('ticket.merge', { from_ticket_ids: [x], into_ticket_id: y }, waiter)]);
    check('T3 a waiter without the permission is refused', tag(no[0]) === 'rejected:forbidden' && (await ticket(x)).status === 'open', tag(no[0]));
    const lent = await push([op('ticket.merge', { from_ticket_ids: [x], into_ticket_id: y, approved_by: waiter }, waiter)]);
    check('T3 approving it oneself changes nothing', tag(lent[0]) === 'rejected:forbidden', tag(lent[0]));
    // a login that may not set up tills cannot lend an approval: it is dropped
    const own = await pushTo(tid, waiter, [op('ticket.merge', { from_ticket_ids: [x], into_ticket_id: y, approved_by: owner })]);
    check('T3 an approval sent from the waiter\'s own login does not count', tag(own[0]) === 'rejected:forbidden', tag(own[0]));
    const o = op('ticket.merge', { from_ticket_ids: [x], into_ticket_id: y, approved_by: owner }, waiter);
    const yes = await push([o]);
    check('T3 with the owner\'s approval it goes through', tag(yes[0]) === 'applied' && (await ticket(x)).status === 'cancelled' && (await ticket(y)).covers === 4, tag(yes[0]));
    const log = await q1(`select employee_id, approved_by, op_type from approvals where tenant_id = $1 and op_id = $2`, [tid, o.op_id]);
    check('T3 and who approved it is on record', log && log.employee_id === waiter && log.approved_by === owner && log.op_type === 'ticket.merge', JSON.stringify(log));
  }

  // T4 orders that cannot be merged
  {
    const mine = crypto.randomUUID(), theirs = crypto.randomUUID();
    await push([op('ticket.create', { id: mine, store_id: store })]);
    await pushTo(other, otherOwner, [op('ticket.create', { id: theirs, store_id: otherStore })]);
    const r = await push([
      op('ticket.merge', { from_ticket_ids: [mine], into_ticket_id: mine }),
      op('ticket.merge', { from_ticket_ids: [theirs], into_ticket_id: mine }),
      op('ticket.merge', { from_ticket_ids: [mine], into_ticket_id: theirs }),
      op('ticket.merge', { from_ticket_ids: [crypto.randomUUID()], into_ticket_id: mine }),
      op('ticket.merge', { from_ticket_ids: [b], into_ticket_id: mine }),
      op('ticket.merge', { from_ticket_ids: [mine] }),
    ]);
    check('T4 an order is not merged into itself', tag(r[0]) === 'rejected:bad-payload', tag(r[0]));
    check('T4 another restaurant\'s order is not taken', tag(r[1]) === 'rejected:bad-ticket' && (await ticket(theirs)).status === 'open', tag(r[1]));
    check('T4 nor joined', tag(r[2]) === 'rejected:bad-ticket' && (await ticket(mine)).status === 'open', tag(r[2]));
    check('T4 an unknown order is refused', tag(r[3]) === 'rejected:bad-ticket', tag(r[3]));
    check('T4 an order already merged away is refused', tag(r[4]) === 'rejected:bad-ticket', tag(r[4]));
    check('T4 no order to join is refused', tag(r[5]) === 'rejected:bad-payload', tag(r[5]));
  }

  // T5 a takeaway merged away leaves the board; an order with no guests counted takes the other's
  {
    const t = crypto.randomUUID(), counter = crypto.randomUUID(), tl = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: t, store_id: store, dining_option_id: takeaway, order_no: 'A-9', name: 'Kavish', stage: 'new', source: 'Counter' }),
      op('ticket.create', { id: counter, store_id: store }),
      line(t, tl),
      op('ticket.place_lines', { ticket_id: t, line_ids: [tl], seat: 2 }),
      op('ticket.merge', { from_ticket_ids: [t], into_ticket_id: counter }),
    ]);
    const from = await ticket(t), into = await ticket(counter);
    check('T5 a takeaway merged away is off the board', tag(r[4]) === 'applied' && from.status === 'cancelled' && from.stage === 'done', tag(r[4]) + ' ' + JSON.stringify(from));
    check('T5 with no guests counted on either, none are invented', into.covers === null, String(into.covers));
    check('T5 and its seat is kept as it was', JSON.stringify(await seats(counter)) === JSON.stringify([2]), JSON.stringify(await seats(counter)));
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
