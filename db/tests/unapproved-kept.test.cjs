// unapproved-kept.test.cjs — migration 0082: what a till took is kept.
// A refund, or a bill with a discount, that the server finds nobody was
// allowed to give used to be refused. By then the money had moved: the
// customer had the refund or had paid the discounted bill, and the sale or
// the refund never reached the books (spec 5.1 rule 8: "A recorded payment is
// never discarded by sync. If it conflicts, accept it and flag it").
//   - from a till set up with a login that may vouch for staff (the owner's,
//     a manager's), it is stored as the till recorded it, and flagged with
//     why, for the Receipts page, where someone who may refund signs it off.
//     That login could always have named anyone as having done it, so
//     nothing it could not do before is opened to it
//   - from a login that may not vouch for staff it is refused, as it always
//     was: that login's own rights are all the server has to go by, and
//     anyone holding it can call the server without a till
//   - an approval still counts only from someone who may give it; one that
//     does not count is not written on the bill as an approval
//   - what was allowed is stored as before, with nothing flagged
//   - everything else the server refuses, it still refuses
// Usage: node db/tests/unapproved-kept.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, text } = require('./page.cjs');

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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','UK-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','UKS1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
    const owner = await emp('Owner', await role('Owner', ['*'])); // the till's login: may vouch for staff
    const rWaiter = await role('Waiter', ['sale.create', 'payment.take']);
    const waiter = await emp('Waiter', rWaiter);
    const waiter2 = await emp('Waiter two', rWaiter);
    // may refund and discount, but not give a discount that needs a manager
    const manager = await emp('Manager', await role('Manager', ['sale.create', 'payment.take', 'sale.refund', 'sale.apply_discount']));
    // a login of its own that may not set tills up: the server does not take its word for who approved
    const cashierLogin = await emp('Cashier login', await role('Cashier', ['sale.create', 'payment.take', 'sale.apply_discount']));
    await c.query(`select seed_demo_catalog('${tid}')`);
    const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
    const staff = (await q1(`insert into discounts (tenant_id, name, type, value, requires_approval) values ($1,'Staff','percent',30,true) returning id`, [tid])).id;

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops, login = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const T0 = Date.parse('2026-03-02T05:00:00Z');
    const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
    let seq = 0;
    const reasons = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id = $1 and deleted_at is null order by reason`, [rc])).rows.map((r) => r.reason).join(',');
    const detail = async (rc, reason) => ((await q1(`select detail from receipt_reviews where receipt_id = $1 and reason = $2`, [rc, reason])) || {}).detail;
    const receipt = (rc) => q1(`select type, total, discount_total, needs_review, employee_id from receipts where id = $1`, [rc]);
    const approvedOn = async (rc) => ((await q1(`select approved_by from receipt_discounts where receipt_id = $1`, [rc])) || {}).approved_by;

    // one Dholl puri, paid in cash by the waiter: something to refund
    const sale = async () => {
      const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
      const r = await push([
        op('ticket.create', { id: tk, store_id: store }, waiter),
        op('ticket.add_line', { id: ln, ticket_id: tk, item_id: dp, qty: 1000 }, waiter),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'UK-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(seq) }, waiter),
      ]);
      if (!r.every((o) => o.status === 'applied')) throw new Error('sale: ' + r.map(tag).join(','));
      return { tk, rc, line: (await q1(`select id from receipt_lines where receipt_id = $1`, [rc])).id };
    };
    const refundOf = (s, who, extra) => {
      const id = crypto.randomUUID();
      return { id, o: op('refund.create', { id, refund_of: s.rc, store_id: store, device_id: dev, number: 'UK-R' + (++seq), device_seq: seq,
        reason: 'wrong order', lines: [{ receipt_line_id: s.line, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(seq), ...extra }, who) };
    };
    // two Dholl puri (Rs 100.00) on an order, to be paid with a discount
    const order = async (who) => {
      const tk = crypto.randomUUID();
      const r = await push([op('ticket.create', { id: tk, store_id: store }, who), op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp, qty: 2000 }, who)], who === cashierLogin ? cashierLogin : owner);
      if (!r.every((o) => o.status === 'applied')) throw new Error('order: ' + r.map(tag).join(','));
      return tk;
    };
    const payOf = (tk, who, discounts, amount, extra) => {
      const id = crypto.randomUUID();
      return { id, o: op('receipt.create', { id, ticket_id: tk, store_id: store, device_id: dev, number: 'UK-' + (++seq), device_seq: seq,
        discounts, payments: [{ payment_type_id: cash, amount }], device_time: at(seq), ...extra }, who) };
    };

    // ---- refunds ----
    {
      const a = refundOf(await sale(), waiter, {});
      const r = await push([a.o]);
      const row = await receipt(a.id);
      const d = await detail(a.id, 'refund-unapproved');
      check('U1 a refund by someone who may not refund is stored: the customer already has the money', tag(r[0]) === 'applied' && !!row && row.type === 'refund' && row.total === '5000', tag(r[0]) + ' ' + JSON.stringify(row));
      check('U1 it is flagged, with why', !!row && row.needs_review === true && (await reasons(a.id)) === 'refund-unapproved', (row && row.needs_review) + ' ' + (await reasons(a.id)));
      check('U1 the reason says who rang it up, how much, and that nobody approved', !!d && d.by === waiter && Number(d.total) === 5000 && (d.approved_by ?? null) === null, JSON.stringify(d));
      check('U1 the money that went back is on the books', Number(((await q1(`select coalesce(sum(amount), 0) as n from receipt_payments where receipt_id = $1`, [a.id])) || {}).n) === 5000);

      const b = refundOf(await sale(), waiter, { approved_by: waiter2 });
      const r2 = await push([b.o]);
      const d2 = await detail(b.id, 'refund-unapproved');
      check('U2 an approval by someone who may not refund either does not count: stored, flagged, and the approver named', tag(r2[0]) === 'applied' && (await reasons(b.id)) === 'refund-unapproved' && !!d2 && d2.approved_by === waiter2, tag(r2[0]) + ' ' + JSON.stringify(d2));

      const ok = refundOf(await sale(), waiter, { approved_by: manager });
      const r3 = await push([ok.o]);
      check('U3 approved by someone who may, a refund is stored with nothing flagged, as before', tag(r3[0]) === 'applied' && (await receipt(ok.id)).needs_review === false && (await reasons(ok.id)) === '', tag(r3[0]) + ' ' + (await reasons(ok.id)));
      const own = refundOf(await sale(), manager, {});
      const r4 = await push([own.o]);
      check('U3 and so is one by someone who may refund', tag(r4[0]) === 'applied' && (await receipt(own.id)).needs_review === false && (await reasons(own.id)) === '', tag(r4[0]));

      // what the server refuses for other reasons, it still refuses
      const s = await sale();
      const first = refundOf(s, manager, {});
      await push([first.o]);
      const again = await push([refundOf(s, waiter, {}).o]);
      check('U4 a refund of what was already refunded is still refused, whoever asks', tag(again[0]) === 'rejected:bad-qty', tag(again[0]));
      const none = await push([op('refund.create', { id: crypto.randomUUID(), refund_of: crypto.randomUUID(), store_id: store, device_id: dev, number: 'UK-R' + (++seq), reason: 'x', payments: [{ payment_type_id: cash, amount: 5000 }] }, waiter)]);
      check('U4 and so is a refund of a receipt that is not there', tag(none[0]) === 'rejected:bad-receipt', tag(none[0]));
    }

    // ---- a discount on a bill ----
    {
      const tk = await order(waiter);
      const a = payOf(tk, waiter, [{ type: 'percent', value: 10, name: 'Friend' }], 9000);
      const r = await push([a.o]);
      const row = await receipt(a.id);
      const d = await detail(a.id, 'discount-unapproved');
      check('U5 a bill with a discount by someone who may not give one is stored as it was paid', tag(r[0]) === 'applied' && !!row && row.total === '9000' && row.discount_total === '1000', tag(r[0]) + ' ' + JSON.stringify(row));
      check('U5 it is flagged, with why', !!row && row.needs_review === true && (await reasons(a.id)) === 'discount-unapproved', (await reasons(a.id)));
      check('U5 the reason names the discount, what it took off, and who rang it up',
        !!d && d.by === waiter && Array.isArray(d.discounts) && d.discounts.length === 1 && d.discounts[0].name === 'Friend' && Number(d.discounts[0].amount) === 1000 && d.discounts[0].why === 'not-allowed', JSON.stringify(d));
      check('U5 the order is paid and closed', ((await q1(`select status from tickets where id = $1`, [tk])) || {}).status === 'paid');

      const tk2 = await order(waiter);
      const ok = payOf(tk2, waiter, [{ type: 'percent', value: 10, name: 'Friend' }], 9000, { approved_by: manager });
      const r2 = await push([ok.o]);
      check('U6 approved by someone who may discount, it is stored with nothing flagged, as before', tag(r2[0]) === 'applied' && (await receipt(ok.id)).needs_review === false && (await reasons(ok.id)) === '', tag(r2[0]) + ' ' + (await reasons(ok.id)));
    }

    // ---- a discount that needs a manager ----
    {
      const tk = await order(manager);
      const a = payOf(tk, manager, [{ discount_id: staff }], 7000);
      const r = await push([a.o]);
      const d = await detail(a.id, 'discount-unapproved');
      check('U7 a discount that needs a manager, with nobody approving, is stored and flagged', tag(r[0]) === 'applied' && (await receipt(a.id)).total === '7000' && (await reasons(a.id)) === 'discount-unapproved', tag(r[0]) + ' ' + (await reasons(a.id)));
      check('U7 the reason says it needed an approval', !!d && d.discounts[0].name === 'Staff' && Number(d.discounts[0].amount) === 3000 && d.discounts[0].why === 'needs-approval' && d.discounts[0].discount_id === staff, JSON.stringify(d));
      check('U7 and the bill names no approver', (await approvedOn(a.id)) === null, String(await approvedOn(a.id)));

      const tk2 = await order(manager);
      const b = payOf(tk2, manager, [{ discount_id: staff, approved_by: waiter2 }], 7000);
      const r2 = await push([b.o]);
      const d2 = await detail(b.id, 'discount-unapproved');
      check('U8 approved by someone who may not approve it: stored, flagged, the approver named in the reason and not on the bill',
        tag(r2[0]) === 'applied' && !!d2 && d2.discounts[0].approved_by === waiter2 && d2.discounts[0].why === 'needs-approval' && (await approvedOn(b.id)) === null, tag(r2[0]) + ' ' + JSON.stringify(d2) + ' ' + (await approvedOn(b.id)));

      const tk3 = await order(manager);
      const ok = payOf(tk3, manager, [{ discount_id: staff, approved_by: owner }], 7000);
      const r3 = await push([ok.o]);
      check('U9 approved by someone who may, it is stored with the approver on the bill and nothing flagged, as before', tag(r3[0]) === 'applied' && (await reasons(ok.id)) === '' && (await approvedOn(ok.id)) === owner, tag(r3[0]) + ' ' + (await reasons(ok.id)));

      const tk4 = await order(manager);
      const junk = payOf(tk4, manager, [{ discount_id: staff, approved_by: 'not-an-id' }], 7000);
      const r4 = await push([junk.o]);
      check('U10 an approver that is not an id is no approver: the bill is stored and flagged, not lost', tag(r4[0]) === 'applied' && (await reasons(junk.id)) === 'discount-unapproved' && (await approvedOn(junk.id)) === null, tag(r4[0]) + ' ' + (await reasons(junk.id)));

      const big = await push([payOf(await order(manager), manager, [{ type: 'amount', value: 100, name: 'Odd', amount: 99999 }], 1).o]);
      check('U11 a discount larger than the bill is still refused', tag(big[0]) === 'rejected:bad-discount', tag(big[0]));
    }

    // ---- a login that may not vouch for staff: its own rights are all there is, and it is refused as before ----
    {
      const stored = async (id) => (await q1(`select count(*)::int as n from receipts where id = $1`, [id])).n;
      // it names a manager inside the discount: its word for that is not taken
      const tk = await order(cashierLogin);
      const forged = payOf(tk, undefined, [{ discount_id: staff, approved_by: owner }], 7000);
      const r = await push([forged.o], cashierLogin);
      check('U12 a login that may not vouch for staff cannot name an approver inside a discount: the bill is refused, not taken as approved',
        tag(r[0]) === 'rejected:approval-required' && (await stored(forged.id)) === 0, tag(r[0]) + ' stored=' + (await stored(forged.id)) + ' approver=' + (await approvedOn(forged.id)));
      const back = refundOf(await sale(), undefined, {});
      const r2 = await push([back.o], cashierLogin);
      check('U12 its refund, which its own role does not allow, is refused as before', tag(r2[0]) === 'rejected:forbidden' && (await stored(back.id)) === 0, tag(r2[0]));
      const claimed = refundOf(await sale(), undefined, { approved_by: manager });
      const r3 = await push([claimed.o], cashierLogin);
      check('U12 and so is one it says a manager approved', tag(r3[0]) === 'rejected:forbidden' && (await stored(claimed.id)) === 0, tag(r3[0]));
      // the waiter's own login, with no right to discount
      const tk2 = crypto.randomUUID();
      await push([op('ticket.create', { id: tk2, store_id: store }), op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk2, item_id: dp, qty: 2000 })], waiter);
      const disc = payOf(tk2, undefined, [{ type: 'percent', value: 10, name: 'Friend' }], 9000);
      const r4 = await push([disc.o], waiter);
      check('U12 a bill with a discount from a login that may not discount is refused as before', tag(r4[0]) === 'rejected:forbidden' && (await stored(disc.id)) === 0, tag(r4[0]));
    }

    // ---- the books and the back office ----
    {
      const bad = await q1(
        `select count(*)::int as n from receipts r where r.tenant_id = $1
          and r.needs_review <> exists (select 1 from receipt_reviews v where v.tenant_id = r.tenant_id and v.receipt_id = r.id and v.deleted_at is null)`, [tid]);
      check('U13 a receipt or a refund is flagged exactly when a reason is recorded for it', bad.n === 0, 'mismatches=' + bad.n);

      await c.query('BEGIN');
      let says = '', err;
      try { says = text(await open(c, { tenantId: tid, employeeId: owner, mode: 'restaurant' }, '/backoffice/receipts', {})); } catch (e) { err = e.message; }
      await c.query('ROLLBACK');
      check('U14 the Receipts page opens with them on it', !err && says.length > 500, err);
      check('U14 it says in words why a refund is to be checked', says.includes('Refunded by someone whose role does not allow refunds, with no approval from someone who may'), (says.match(/.{0,40}efunded by.{0,90}/) || [says.slice(0, 160)])[0]);
      check('U14 and a discount by someone who may not give one', /a discount of Rs 10(\.00)? \(Friend\) given by someone whose role does not allow discounts/.test(says), (says.match(/.{0,30}\(Friend\).{0,90}/) || [])[0]);
      check('U14 and a discount that needed a manager', /the discount Staff \(Rs 30(\.00)?\) needs a manager, and no one who may approve it did/.test(says), (says.match(/.{0,30}Staff \(.{0,90}/) || [])[0]);
      check('U14 no reason is left as its code', !says.includes('refund-unapproved') && !says.includes('discount-unapproved'));
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
