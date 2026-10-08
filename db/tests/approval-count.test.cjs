// approval-count.test.cjs — migration 0054: an op the person at the till may
// not do goes through when someone who may approved it (approved_by), and the
// drawer can be counted during a shift without closing it.
// Usage: node db/tests/approval-count.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','AC-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','ACS1') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
  const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
  const owner = await emp('Owner', await role('Owner', ['*'])); // the till's login: may vouch for staff
  const rWaiter = await role('Waiter', ['sale.create', 'payment.take']);
  const waiter = await emp('Waiter', rWaiter);
  const waiter2 = await emp('Waiter two', rWaiter);
  const manager = await emp('Manager', await role('Manager', ['sale.create', 'payment.take', 'sale.refund', 'payment.correct', 'shift.open_close', 'ticket.reassign', 'sale.apply_discount']));
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
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
  const approved = async (opId) => q1(`select employee_id, approved_by, op_type from approvals where tenant_id = $1 and op_id = $2`, [tid, opId]);
  // one Dholl puri, paid in cash by the waiter: something to refund or correct
  const sale = async () => {
    const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: tk, store_id: store }, waiter),
      op('ticket.add_line', { id: ln, ticket_id: tk, item_id: dp, qty: 1000 }, waiter),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'AC-' + (++seq), device_seq: seq,
        payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(seq) }, waiter),
    ]);
    if (!r.every((o) => o.status === 'applied')) throw new Error('sale: ' + r.map(tag).join(','));
    return { tk, rc, line: (await q1(`select id from receipt_lines where receipt_id = $1`, [rc])).id };
  };

  // T1 opening the shift: a waiter may not, a manager's approval lets it through
  const shift = crypto.randomUUID();
  {
    const no = await push([op('shift.open', { id: crypto.randomUUID(), device_id: dev, opening_float: 10000, opened_at: at(0) }, waiter)]);
    const o = op('shift.open', { id: shift, device_id: dev, opening_float: 10000, opened_at: at(0), approved_by: manager }, waiter);
    const yes = await push([o]);
    const row = await q1(`select opened_by from shifts where id = $1`, [shift]);
    const log = await approved(o.op_id);
    check('T1 a waiter cannot open the shift', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T1 with a manager approving, it opens, in the waiter\'s name', tag(yes[0]) === 'applied' && row.opened_by === waiter, tag(yes[0]));
    check('T1 the approval is on record: which op, who was at the till, who approved', log && log.employee_id === waiter && log.approved_by === manager && log.op_type === 'shift.open', JSON.stringify(log));
  }

  // what a receipt or a refund is flagged for, if anything
  const flagged = async (receiptId) => q1(`select r.needs_review, (select string_agg(v.reason, ',' order by v.reason) from receipt_reviews v where v.receipt_id = r.id) as why from receipts r where r.id = $1`, [receiptId]);

  // T2 a refund. The customer has the money by the time it gets here, so one
  // nobody was allowed to give is stored and flagged, not refused (0082).
  {
    const refund = (s, extra) => op('refund.create', { id: crypto.randomUUID(), refund_of: s.rc, store_id: store, device_id: dev, number: 'AC-R' + (++seq), device_seq: seq,
      reason: 'wrong order', lines: [{ receipt_line_id: s.line, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(seq), ...extra }, waiter);
    const a = refund(await sale(), {});
    const no = await push([a]);
    const b = refund(await sale(), { approved_by: waiter2 });
    const byWaiter = await push([b]);
    const o = refund(await sale(), { approved_by: manager });
    const yes = await push([o]);
    const fa = await flagged(a.payload.id), fb = await flagged(b.payload.id), fo = await flagged(o.payload.id);
    check('T2 a refund by a waiter is stored, and flagged for the back office', tag(no[0]) === 'applied' && !!fa && fa.needs_review === true && fa.why === 'refund-unapproved', tag(no[0]) + ' ' + JSON.stringify(fa));
    check('T2 the approval of someone who may not refund either does not clear it', tag(byWaiter[0]) === 'applied' && !!fb && fb.why === 'refund-unapproved', tag(byWaiter[0]) + ' ' + JSON.stringify(fb));
    check('T2 with a manager approving, the refund goes through with nothing flagged', tag(yes[0]) === 'applied' && (await approved(o.op_id)) !== undefined && !!fo && fo.needs_review === false && fo.why === null, tag(yes[0]) + ' ' + JSON.stringify(fo));
  }

  // T3 correcting a payment type
  {
    const s = await sale();
    const no = await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: s.rc, from_payment_type_id: cash, to_payment_type_id: card }, waiter)]);
    const yes = await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: s.rc, from_payment_type_id: cash, to_payment_type_id: card, approved_by: manager }, waiter)]);
    const eff = await q1(`select payment_type_id from receipt_payments_effective where receipt_id = $1`, [s.rc]);
    check('T3 a waiter cannot correct a payment type', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T3 with a manager approving, it is corrected', tag(yes[0]) === 'applied' && eff.payment_type_id === card, tag(yes[0]));
  }

  // T4 changing the waiter, and a discount
  {
    const tk = crypto.randomUUID(), ln = crypto.randomUUID();
    await push([op('ticket.create', { id: tk, store_id: store }, waiter), op('ticket.add_line', { id: ln, ticket_id: tk, item_id: dp, qty: 2000 }, waiter)]);
    const no = await push([op('ticket.update_meta', { ticket_id: tk, opened_by: waiter2 }, waiter)]);
    const yes = await push([op('ticket.update_meta', { ticket_id: tk, opened_by: waiter2, approved_by: manager }, waiter)]);
    check('T4 a waiter cannot hand an order to someone else', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T4 with a manager approving, the order changes hands', tag(yes[0]) === 'applied' && (await q1(`select opened_by from tickets where id = $1`, [tk])).opened_by === waiter2, tag(yes[0]));
    const pay = (ticket, extra) => op('receipt.create', { id: crypto.randomUUID(), ticket_id: ticket, store_id: store, device_id: dev, number: 'AC-' + (++seq), device_seq: seq,
      discounts: [{ type: 'percent', value: 10, name: 'Friend' }], payments: [{ payment_type_id: cash, amount: 9000 }], device_time: at(seq), ...extra }, waiter);
    // the bill was paid with the discount on it: it is stored as paid, and flagged (0082)
    const noDisc = await push([pay(tk, {})]);
    const rcNo = await q1(`select id, total, discount_total from receipts where ticket_id = $1`, [tk]);
    const fNo = rcNo ? await flagged(rcNo.id) : null;
    check('T4 a bill with a discount by a waiter is stored as it was paid, and flagged', tag(noDisc[0]) === 'applied' && !!rcNo && rcNo.total === '9000' && rcNo.discount_total === '1000' && !!fNo && fNo.why === 'discount-unapproved',
      tag(noDisc[0]) + ' ' + JSON.stringify(rcNo) + ' ' + JSON.stringify(fNo));
    const tk2 = crypto.randomUUID();
    await push([op('ticket.create', { id: tk2, store_id: store }, waiter), op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk2, item_id: dp, qty: 2000 }, waiter)]);
    const disc = await push([pay(tk2, { approved_by: manager })]);
    const rc = await q1(`select total, discount_total, needs_review from receipts where ticket_id = $1`, [tk2]);
    check('T4 with a manager approving, 10% comes off and nothing is flagged', tag(disc[0]) === 'applied' && !!rc && rc.total === '9000' && rc.discount_total === '1000' && rc.needs_review === false, tag(disc[0]) + ' ' + JSON.stringify(rc));
  }

  // T5 an approval counts only from a login that may vouch for staff
  {
    const s = await sale();
    const body = { id: crypto.randomUUID(), receipt_id: s.rc, from_payment_type_id: cash, to_payment_type_id: card, approved_by: manager };
    const o = op('payment.correct', body);
    const lesser = await push([o], waiter); // the waiter's own login, claiming a manager approved
    const stray = await push([op('payment.correct', { ...body, id: crypto.randomUUID(), approved_by: crypto.randomUUID() }, waiter)]);
    const junk = await push([op('payment.correct', { ...body, id: crypto.randomUUID(), approved_by: 'not-an-id' }, waiter)]);
    check('T5 a login that may not set up tills cannot claim an approval', tag(lesser[0]) === 'rejected:forbidden' && (await approved(o.op_id)) === undefined, tag(lesser[0]));
    check('T5 an approver who is not this restaurant\'s staff is refused', tag(stray[0]) === 'rejected:bad-employee' && tag(junk[0]) === 'rejected:bad-employee', tag(stray[0]) + ' ' + tag(junk[0]));
  }

  // T6 counting the drawer during the shift, then closing it: the count changes nothing about the close
  {
    const s = await sale(); // one more cash sale of 50 on this shift, at(seq)
    const count = crypto.randomUUID();
    const o = op('drawer.count', { id: count, store_id: store, device_id: dev, shift_id: shift, counted: 24500, expected: 25000, device_time: at(60), approved_by: manager }, waiter);
    const r = await push([o]);
    const row = await q1(`select counted, expected, employee_id, shift_id, device_time from drawer_counts where id = $1`, [count]);
    check('T6 a drawer count is recorded with what was counted and what was expected', tag(r[0]) === 'applied' && row.counted === '24500' && row.expected === '25000'
      && row.employee_id === waiter && row.shift_id === shift && new Date(row.device_time).toISOString() === at(60), tag(r[0]) + ' ' + JSON.stringify(row));
    const bad = await push([
      op('drawer.count', { id: crypto.randomUUID(), store_id: store, device_id: dev, shift_id: crypto.randomUUID(), counted: 100, expected: 100 }),
      op('drawer.count', { id: crypto.randomUUID(), store_id: store, device_id: dev, shift_id: shift, counted: -1, expected: 100 }),
      op('drawer.count', { id: crypto.randomUUID(), store_id: store, device_id: dev, shift_id: shift, counted: 100 }),
    ]);
    check('T6 an unknown shift, a negative count and a count with no expected amount are refused',
      bad.map(tag).join(',') === 'rejected:bad-shift,rejected:bad-payload,rejected:bad-payload', bad.map(tag).join(','));
    const open = await q1(`select closed_at from shifts where id = $1`, [shift]);
    const noClose = await push([op('shift.close', { id: shift, counted_cash: 20000, closed_at: at(90) }, waiter)]);
    const close = await push([op('shift.close', { id: shift, counted_cash: 20000, closed_at: at(90), approved_by: manager }, waiter)]);
    // float 100 + the cash sales on this shift (each refund gave 50 back, two sales were discounted to 90)
    // (as the payments stand after any correction of their type, and with each refund dated by the till, as the server counts them)
    const cashIn = Number((await q1(`select coalesce(sum(case when r.type = 'refund' then -p.amount else p.amount end), 0) as n from receipt_payments_effective p
      join receipts r on r.id = p.receipt_id where r.tenant_id = $1 and p.payment_type_id = $2`, [tid, cash])).n);
    check('T6 the shift is still open after the count', open.closed_at === null);
    check('T6 a waiter cannot close the shift, and can with a manager approving', tag(noClose[0]) === 'rejected:forbidden' && tag(close[0]) === 'applied', tag(noClose[0]) + ' ' + tag(close[0]));
    check('T6 expected cash at close is still float + cash taken, whatever was counted earlier', Number(close[0].data.expected_cash) === 10000 + cashIn, close[0].data.expected_cash + ' vs ' + (10000 + cashIn) + ' ' + (s ? '' : ''));
  }

  // T7 closing the day
  {
    const no = await push([op('day.close', { id: crypto.randomUUID(), store_id: store, device_id: dev, closed_at: at(100) }, waiter)]);
    const yes = await push([op('day.close', { id: crypto.randomUUID(), store_id: store, device_id: dev, closed_at: at(101), approved_by: manager }, waiter)]);
    check('T7 a waiter cannot close the day, and can with a manager approving', tag(no[0]) === 'rejected:forbidden' && tag(yes[0]) === 'applied', tag(no[0]) + ' ' + tag(yes[0]));
  }

  // T8 the till gets its drawer counts back; approvals stay on the server
  {
    const pull = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const ch = pull.changes;
    check('T8 the pull carries the drawer count', Array.isArray(ch.drawer_counts) && ch.drawer_counts.length === 1 && Number(ch.drawer_counts[0].counted) === 24500, JSON.stringify(ch.drawer_counts));
    check('T8 the pull does not carry approvals', ch.approvals === undefined);
  }

  // T9 another restaurant sees neither
  {
    const other = crypto.randomUUID();
    const seen = await asApp(other, async () => (await c.query(`select (select count(*) from approvals)::int a, (select count(*) from drawer_counts)::int d`)).rows[0]);
    const here = await asApp(tid, async () => (await c.query(`select (select count(*) from approvals)::int a, (select count(*) from drawer_counts)::int d`)).rows[0]);
    check('T9 approvals and drawer counts are the restaurant\'s own', seen.a === 0 && seen.d === 0 && here.a >= 6 && here.d === 1, JSON.stringify(seen) + ' ' + JSON.stringify(here));
  }

  // T10 deleting the test transactions clears both
  {
    await c.query(`update employees set auth_user_id = null where id = $1`, [owner]);
    const out = await asApp(tid, async () => (await c.query(`select purge_transactions($1, $2) as r`, [tid, owner])).rows[0].r);
    const left = await q1(`select (select count(*) from approvals where tenant_id = $1)::int a, (select count(*) from drawer_counts where tenant_id = $1)::int d`, [tid]);
    check('T10 the purge clears approvals and drawer counts', left.a === 0 && left.d === 0, JSON.stringify(left) + ' ' + JSON.stringify(out));
  }

  await devguard.cleanupTenant(c, tid);
  await c.end();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
