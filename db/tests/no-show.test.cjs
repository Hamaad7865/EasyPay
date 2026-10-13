// no-show.test.cjs — a takeaway nobody came for (0107).
//   ticket.cancel with no_show closes an unpaid order WITH its items on it
//   and writes down what was lost, for the day closing; a paid one stays
//   paid and owes nothing. Without no_show, cancelling is as 0057 has it.
// Usage: node db/tests/no-show.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','NoShow-Probe'), ('${other}','${other}','NoShow-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','NSS1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','NSS2') returning id`)).id;
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const theirDevice = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const orole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [other])).id;
  const otherOwner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [other, orole])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  await c.query(`select ensure_pos_basics('${other}')`);
  const dp = await q1(`select id, price from items where tenant_id='${tid}' and name='Dholl puri'`);
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
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
  const ticket = (id) => q1(`select status, stage, no_show_at, no_show_total::text as total, no_show_by, no_show_device from tickets where id = $1`, [id]);
  const liveLines = async (id) => Number((await q1(`select count(*) as n from ticket_lines where ticket_id = $1 and voided_at is null and deleted_at is null`, [id])).n);
  const at = '2026-10-13T14:30:00.000Z';

  // a takeaway with one Dholl puri on it, sent to the kitchen
  async function takeawayOrder(no) {
    const t = crypto.randomUUID(), l = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: t, store_id: store, dining_option_id: takeaway, order_no: no, name: 'Ravi', stage: 'new', source: 'Counter' }),
      op('ticket.add_line', { id: l, ticket_id: t, item_id: dp.id, qty: 1000 }),
      op('ticket.send', { ticket_id: t, line_ids: [l] }),
      op('ticket.stage', { ticket_id: t, stage: 'ready' }),
    ]);
    return { t, l, made: r.map(tag).join(' ') };
  }

  // T1 not paid: closed with its items on it, and what was lost written down
  const unpaid = await takeawayOrder('A-1');
  {
    const r = await push([op('ticket.cancel', { ticket_id: unpaid.t, no_show: { total: 5000, at, device_id: device } })]);
    const row = await ticket(unpaid.t);
    check('T1 an unpaid takeaway nobody came for is closed and off the board', tag(r[0]) === 'applied' && row.status === 'cancelled' && row.stage === 'done', unpaid.made + ' | ' + tag(r[0]) + ' ' + JSON.stringify(row));
    check('T1 what was not paid, when, by whom and on which till are kept', row.total === '5000' && new Date(row.no_show_at).toISOString() === at && row.no_show_by === owner && row.no_show_device === device, JSON.stringify(row));
    check('T1 its items stay on it', (await liveLines(unpaid.t)) === 1, String(await liveLines(unpaid.t)));
    check('T1 the till is told it is a no-show', r[0].data && r[0].data.no_show === true && r[0].data.status === 'cancelled', JSON.stringify(r[0].data));
  }

  // T2 said again: answered as it stands, nothing changes
  {
    const r = await push([op('ticket.cancel', { ticket_id: unpaid.t, no_show: { total: 9900, at: '2026-10-13T18:00:00.000Z', device_id: device } })]);
    const row = await ticket(unpaid.t);
    check('T2 said twice changes nothing', tag(r[0]) === 'applied' && row.total === '5000' && new Date(row.no_show_at).toISOString() === at, tag(r[0]) + ' ' + JSON.stringify(row));
  }

  // T3 paid: it stays paid, leaves the board, and owes nothing whatever the till sent
  {
    const { t, l } = await takeawayOrder('A-2');
    const paid = await push([op('receipt.create', { id: crypto.randomUUID(), ticket_id: t, store_id: store, device_id: device, number: 'NSS1-T1-000001', device_seq: 1,
      line_ids: [l], payments: [{ payment_type_id: cash, amount: Number(dp.price) }] })]);
    const before = await ticket(t);
    const r = await push([op('ticket.cancel', { ticket_id: t, no_show: { total: 5000, at, device_id: device } })]);
    const row = await ticket(t);
    check('T3 a paid takeaway stays paid and leaves the board', tag(paid[0]) === 'applied' && before.status === 'paid' && tag(r[0]) === 'applied' && row.status === 'paid' && row.stage === 'done',
      tag(paid[0]) + ' ' + before.status + ' ' + tag(r[0]) + ' ' + JSON.stringify(row));
    check('T3 it is marked, and nothing is owed on it', row.no_show_at !== null && row.total === '0', JSON.stringify(row));
  }

  // T4 without no_show, cancelling is as it was: refused while items are on the order
  {
    const { t } = await takeawayOrder('A-3');
    const r = await push([op('ticket.cancel', { ticket_id: t })]);
    const row = await ticket(t);
    check('T4 a plain cancel of an order with items is still refused', tag(r[0]) === 'rejected:conflict' && row.status === 'open' && row.no_show_at === null, tag(r[0]) + ' ' + JSON.stringify(row));
    const empty = crypto.randomUUID();
    const e = await push([op('ticket.create', { id: empty, store_id: store }), op('ticket.cancel', { ticket_id: empty })]);
    const erow = await ticket(empty);
    check('T4 a plain cancel of an empty order still closes it, unmarked', tag(e[1]) === 'applied' && erow.status === 'cancelled' && erow.no_show_at === null, tag(e[1]) + ' ' + JSON.stringify(erow));
    // T5 an order cancelled another way is not made a no-show afterwards
    const late = await push([op('ticket.cancel', { ticket_id: empty, no_show: { total: 100, at, device_id: device } })]);
    check('T5 an order already cancelled is answered as it stands', tag(late[0]) === 'applied' && (await ticket(empty)).no_show_at === null, tag(late[0]));
  }

  // T6 what is not a no-show is refused; a till of another restaurant is not kept
  {
    const { t } = await takeawayOrder('A-4');
    const r = await push([
      op('ticket.cancel', { ticket_id: t, no_show: 'yes' }),
      op('ticket.cancel', { ticket_id: t, no_show: { total: -1, at, device_id: device } }),
    ]);
    check('T6 a no-show that is not an object is refused', tag(r[0]) === 'rejected:bad-payload', tag(r[0]));
    check('T6 a negative amount is refused, the order untouched', tag(r[1]) === 'rejected:bad-payload' && (await ticket(t)).status === 'open', tag(r[1]));
    const ok = await push([op('ticket.cancel', { ticket_id: t, no_show: { total: 5000, device_id: theirDevice } })]);
    const row = await ticket(t);
    check('T6 another restaurant\'s till is not kept; with no time said it is now', tag(ok[0]) === 'applied' && row.no_show_device === null && row.no_show_at !== null && row.total === '5000', tag(ok[0]) + ' ' + JSON.stringify(row));
    const theirs = await pushTo(other, otherOwner, [op('ticket.cancel', { ticket_id: unpaid.t, no_show: { total: 1, at } })]);
    check('T6 another restaurant cannot mark this one\'s order', tag(theirs[0]) === 'rejected:bad-ticket', tag(theirs[0]));
  }

  // T7 what the Day closing page asks: one till's unpaid no-shows between two moments
  {
    const row = await q1(
      `select count(*)::int as n, coalesce(sum(no_show_total), 0)::text as amount from tickets
        where tenant_id = $1 and no_show_device = $2 and deleted_at is null and no_show_total > 0
          and no_show_at > $3::timestamptz and no_show_at <= $4::timestamptz`,
      [tid, device, '2026-10-13T00:00:00Z', '2026-10-13T23:59:59Z']);
    check('T7 the day\'s closing finds the one that was not paid, and not the paid one', row.n === 1 && row.amount === '5000', JSON.stringify(row));
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
