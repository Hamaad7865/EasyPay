// accounts.test.cjs — migration 0114: a shop's customer accounts, as a till
// sends them (sync_push) and gets them back (sync_pull).
//   - a sale paid in part or whole "On account" writes a bill on its
//     customer; it is never refused (the goods left): no customer, no extra,
//     no right or a sale paid already are stored and flagged
//   - money paid on the account goes on the bills ticked, cash in the drawer;
//     past what a bill owes (two tills apart) stored and flagged
//   - a return takes off the bill first, whatever the shop's return policy;
//     money back before money came in is flagged
//   - the pull, the settings, payment corrections, clearing a test client
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/accounts.test.cjs
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
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-acc@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Account Test','Main','AC1','Owner',$2,'offline','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;

    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const pull = () => asApp(async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '') + (o.replayed || o.data?.replayed ? ':replayed' : '');
    const tags = (out) => out.map(tag).join(' ');

    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const dev2 = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T2','T2') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and kind = 'cash' and deleted_at is null order by sort_order limit 1`, [tid])).id;
    let card = (await one(`select id from payment_types where tenant_id = $1 and kind = 'card' and deleted_at is null limit 1`, [tid]))?.id;
    if (!card) card = (await one(`insert into payment_types (tenant_id, name, kind) values ($1,'Card','card') returning id`, [tid])).id;
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    const anjali = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Anjali','5555 1234') returning id`, [tid])).id;
    const ravi = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Ravi','5555 9876') returning id`, [tid])).id;
    const shift = (await one(`insert into shifts (tenant_id, store_id, device_id, opened_by, opening_float, opened_at) values ($1,$2,$3,$4,0,now()) returning id`, [tid, store, dev, owner])).id;
    const toy = (await one(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,'Toy',10000,4000,true) returning id`, [tid])).id;
    await c.query(`select stock_move($1,$2,$3,null,50000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, toy, id(), owner]);
    const acct = await one(`select id, is_active, opens_drawer, name from payment_types where tenant_id = $1 and kind = 'account' and deleted_at is null`, [tid]);
    const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [tid])).id;
    const bill = async (rc) => one(`select *, account_owed(b) as owed from account_bills b where id = $1`, [rc]);
    const reviews = async (rc) => (await c.query(`select reason, detail from receipt_reviews where receipt_id = $1 order by 1`, [rc])).rows;
    const setSettings = (o) => c.query(`update pos_settings set data = data || $2::jsonb where tenant_id = $1`, [tid, JSON.stringify(o)]);
    const now = () => new Date().toISOString();

    let seq = 0;
    // a sale of `qty` toys at 100.00 for `customer`, paid by `payments`
    const sale = async (qty, payments, { customer = anjali, as, extra = {} } = {}) => {
      const tk = id(), l = id(), rc = id(); seq++;
      const ops = [op('ticket.create', { id: tk, store_id: store }, as)];
      if (customer) ops.push(op('ticket.update_meta', { ticket_id: tk, customer_id: customer }, as));
      ops.push(op('ticket.add_line', { id: l, ticket_id: tk, item_id: toy, name_snapshot: 'Toy', unit_price: 10000, qty: qty * 1000 }, as));
      ops.push(op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'AC1-T1-' + seq, device_seq: seq, device_time: now(), payments, ...extra }, as));
      const out = await push(ops);
      return { rc, l, tk, out };
    };
    const refund = async (s, qty, payments, extra = {}, as) => {
      const rf = id(); seq++;
      const out = await push([op('refund.create', { id: rf, refund_of: s.rc, store_id: store, device_id: dev, number: 'AC1-R' + seq, device_seq: seq, device_time: now(), reason: 'changed mind', lines: [{ ticket_line_id: s.l, qty: qty * 1000 }], payments, ...extra }, as)]);
      return { rf, out };
    };
    let pn = 0;
    const payOp = (customer, payment, lines, extra = {}) => {
      const pid = id(); pn++;
      return [pid, op('account.pay', { id: pid, number: 'AC1-T1-A' + pn, customer_id: customer, store_id: store, device_id: dev, shift_id: shift, device_time: now(),
        payment: { payment_type_id: cash, ...payment }, lines, ...extra })];
    };

    check('T0 a shop has an On account type, inactive (an old till never offers it), opening no drawer', !!acct && acct.is_active === false && acct.opens_drawer === false && acct.name === 'On account', JSON.stringify(acct));
    check('T0 has_feature: a shop on Offline has no accounts', (await one(`select has_feature($1,'accounts') as x`, [tid])).x === false);

    // ---- T1 the extra ----
    {
      const s = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const b = await bill(s.rc);
      check('T1 without the extra a sale on account is still taken (the goods left)', tags(s.out).endsWith('applied') && !!b, tags(s.out));
      check('T1 and its bill says not-entitled, the receipt to review', b.flags.some((f) => f.why === 'not-entitled') && (await reviews(s.rc)).some((r) => r.reason === 'account'), JSON.stringify(b.flags));
      await c.query(`select platform.set_tenant_features($1,$2,array['accounts'])`, [admin, tid]);
      check('T1 switched on in /admin: has_feature, and the tills are told', (await one(`select has_feature($1,'accounts') as x`, [tid])).x === true
        && JSON.stringify((await one(`select data->'features' as f from pos_settings where tenant_id = $1`, [tid])).f) === '["accounts"]');
      await c.query(`select platform.set_tenant_features($1,$2,array['deposits','accounts'])`, [admin, tid]);
      check('T1 both extras at once', (await one(`select has_feature($1,'deposits') and has_feature($1,'accounts') as x`, [tid])).x === true);
      const p = await one(`select has_feature(t.id,'accounts') as x from tenants t where lower(plan) in ('premium','trial') limit 1`);
      check('T1 premium and trial carry it', !p || p.x === true);
      await c.query(`update account_bills set deleted_at = now() where id = $1`, [s.rc]);
      // from here on a shop in the cloud, as one that sells on account is (Clear test activity is not for one on Offline)
      await c.query(`select platform.set_tenant_plan($1,$2,'premium')`, [admin, tid]);
    }

    // ---- T2 selling on account ----
    let S1, S2, S3;
    {
      S1 = await sale(3, [{ payment_type_id: acct.id, amount: 30000 }]);
      const b = await bill(S1.rc);
      check('T2 a sale of 300.00 all on account: applied, a bill of 300.00 on Anjali', tags(S1.out) === 'applied applied applied applied' && Number(b.amount) === 30000 && b.customer_id === anjali && Number(b.owed) === 30000, JSON.stringify(b));
      check('T2 the bill carries the receipt\'s number and the shop\'s day', b.number === 'AC1-T1-' + seq && !!b.day && b.device_id === dev);
      check('T2 nothing flagged', b.flags.length === 0 && (await reviews(S1.rc)).length === 0, JSON.stringify(await reviews(S1.rc)));
      check('T2 the stock went down as for any sale', Number((await one(`select qty from stock_levels where item_id = $1`, [toy])).qty) === 46000);
      check('T2 the sale is revenue: the receipt totals 300.00', Number((await one(`select total from receipts where id = $1`, [S1.rc])).total) === 30000);
      S2 = await sale(2, [{ payment_type_id: cash, amount: 5000, tendered: 5000, change: 0 }, { payment_type_id: acct.id, amount: 15000 }]);
      check('T2 part cash, part on account: the bill is only the account part', Number((await bill(S2.rc)).amount) === 15000);
      S3 = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }], { customer: ravi });
      check('T2 a second customer\'s bill', (await bill(S3.rc)).customer_id === ravi);
      const none = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }], { customer: null });
      const nb = await bill(none.rc);
      check('T2 no customer: stored, its bill with nobody, flagged no-customer', tags(none.out).endsWith('applied') && nb && nb.customer_id === null && nb.flags.some((f) => f.why === 'no-customer'), JSON.stringify(nb?.flags));
      await c.query(`update account_bills set deleted_at = now() where id = $1`, [none.rc]);
      const byCara = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }], { as: cara });
      const cb = await bill(byCara.rc);
      check('T2 by someone without "Sell on account": stored and flagged not-allowed', cb.flags.some((f) => f.why === 'not-allowed'), JSON.stringify(cb.flags));
      const approved = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }], { as: cara, extra: { approved_by: owner } });
      check('T2 approved by the owner\'s PIN: not flagged', (await bill(approved.rc)).flags.length === 0);
      await c.query(`update account_bills set deleted_at = now() where id = any($1)`, [[byCara.rc, approved.rc]]);
      const change = await sale(1, [{ payment_type_id: acct.id, amount: 10000, tendered: 20000, change: 10000 }]);
      check('T2 change on account is refused', tag(change.out[3]) === 'rejected:bad-change', tag(change.out[3]));
    }

    // ---- T3 a payment on the account, on the bills ticked ----
    {
      // 250.00 cash over S1 (300.00) and S2 (150.00): oldest first, S1 fully... no: the till splits; here 250 on S1
      const [p1, o1] = payOp(anjali, { amount: 25000, tendered: 30000, change: 5000 }, [{ bill_id: S1.rc, amount: 25000 }]);
      const out = await push([o1]);
      const b1 = await bill(S1.rc);
      check('T3 250.00 put on a bill of 300.00: 50.00 still owed', tag(out[0]) === 'applied' && Number(b1.paid) === 25000 && Number(b1.owed) === 5000, tag(out[0]) + ' ' + b1.owed);
      const cm = await one(`select type, amount, reason, account_payment_id, shift_id from cash_movements where id = $1`, [p1]);
      check('T3 the cash is a drawer row, the payment named, in the shift', cm && cm.type === 'in' && Number(cm.amount) === 25000 && cm.account_payment_id === p1 && cm.shift_id === shift && cm.reason === 'Account payment AC1-T1-A1', JSON.stringify(cm));
      const again = await push([o1]);
      const dup = await push([op('account.pay', { ...o1.payload })]);
      check('T3 the same payment again (same op, or a new op) is written once', again[0].status === 'applied' && dup[0].data?.replayed === true && Number((await bill(S1.rc)).paid) === 25000);
      // 200.00 by card over two bills
      const [p2, o2] = payOp(anjali, { payment_type_id: card, amount: 20000 }, [{ bill_id: S1.rc, amount: 5000 }, { bill_id: S2.rc, amount: 15000 }]);
      const out2 = await push([o2]);
      check('T3 one payment over two bills clears both', tag(out2[0]) === 'applied' && Number((await bill(S1.rc)).owed) === 0 && Number((await bill(S2.rc)).owed) === 0);
      check('T3 card money is not in the drawer', !(await one(`select 1 as x from cash_movements where id = $1`, [p2])));
      const lines = (await c.query(`select bill_id, amount from account_payment_lines where account_payment_id = $1 order by amount`, [p2])).rows;
      check('T3 its lines say what went on each bill', lines.length === 2 && Number(lines[0].amount) === 5000 && Number(lines[1].amount) === 15000);
      for (const [why, lines2, pay, code] of [
        ['lines that do not add up to the payment', [{ bill_id: S3.rc, amount: 100 }], { amount: 200 }, 'bad-account'],
        ['no lines', [], { amount: 100 }, 'bad-account'],
        ['a bill twice', [{ bill_id: S3.rc, amount: 100 }, { bill_id: S3.rc, amount: 100 }], { amount: 200 }, 'bad-account'],
        ['paid "on account"', [{ bill_id: S3.rc, amount: 100 }], { payment_type_id: acct.id, amount: 100 }, 'bad-payment'],
        ['paid with the exchange type', [{ bill_id: S3.rc, amount: 100 }], { payment_type_id: exch, amount: 100 }, 'bad-payment'],
        ['wrong change', [{ bill_id: S3.rc, amount: 100 }], { amount: 100, tendered: 500, change: 100 }, 'bad-change'],
      ]) {
        const [, o] = payOp(ravi, pay, lines2);
        const r = await push([o]);
        check('T3 refused: ' + why, tag(r[0]) === 'rejected:' + code, tag(r[0]));
      }
      const [, nobody] = payOp(id(), { amount: 100 }, [{ bill_id: S3.rc, amount: 100 }]);
      check('T3 refused: a customer the shop does not have', tag((await push([nobody]))[0]) === 'rejected:bad-account');
      check('T3 nothing of the refused ones reached Ravi\'s bill', Number((await bill(S3.rc)).paid) === 0);
    }

    // ---- T4 two tills apart pay the same bill; a bill of someone else; one unknown ----
    {
      const [, a] = payOp(ravi, { amount: 10000 }, [{ bill_id: S3.rc, amount: 10000 }]);
      const [pb, b] = payOp(ravi, { amount: 10000 }, [{ bill_id: S3.rc, amount: 10000 }], { device_id: dev2, shift_id: null });
      const out = await push([a, b]);
      const b3 = await bill(S3.rc);
      check('T4 both stored (the money was taken twice)', tags(out) === 'applied applied', tags(out));
      check('T4 the bill is paid over by 100.00 and says so', Number(b3.owed) === -10000 && b3.flags.some((f) => f.why === 'over-paid'), JSON.stringify(b3.flags));
      check('T4 the second payment is flagged', (await one(`select flags from account_payments where id = $1`, [pb])).flags.some((f) => f.why === 'over-paid'));
      const S4 = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const [po, o] = payOp(ravi, { amount: 10000 }, [{ bill_id: S4.rc, amount: 10000 }]);
      await push([o]);
      check('T4 Ravi\'s money on Anjali\'s bill: kept, flagged other-customer', (await one(`select flags from account_payments where id = $1`, [po])).flags.some((f) => f.why === 'other-customer'));
      const [pu, u] = payOp(ravi, { amount: 500 }, [{ bill_id: id(), amount: 500 }]);
      const outU = await push([u]);
      check('T4 a bill the server does not know: kept, flagged bill-unknown', tag(outU[0]) === 'applied' && (await one(`select flags from account_payments where id = $1`, [pu])).flags.some((f) => f.why === 'bill-unknown'));
      await c.query(`update account_bills set deleted_at = now() where id = $1`, [S4.rc]);
    }

    // ---- T5 returns ----
    {
      await setSettings({ returns: 'exchange', returnDays: 30 });
      const s = await sale(2, [{ payment_type_id: acct.id, amount: 20000 }]);
      const r1 = await refund(s, 1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const b = await bill(s.rc);
      check('T5 an exchange-only shop takes a return off the bill (no money moves)', tag(r1.out[0]) === 'applied' && Number(b.returned) === 10000 && Number(b.owed) === 10000, tag(r1.out[0]));
      check('T5 the refund is not to review', (await reviews(r1.rf)).length === 0);
      const cashBack = await refund(s, 1, [{ payment_type_id: cash, amount: 10000 }]);
      check('T5 money back still follows the policy (exchange only: refused)', tag(cashBack.out[0]) === 'rejected:refund-policy', tag(cashBack.out[0]));
      await setSettings({ returns: 'refund' });
      const early = await refund(s, 1, [{ payment_type_id: cash, amount: 10000 }]);
      const rv = await reviews(early.rf);
      check('T5 cash back for goods never paid for: stored (handed over) and flagged', tag(early.out[0]) === 'applied' && rv.some((r) => r.reason === 'account' && r.detail.flags.some((f) => f.why === 'money-before-paid')), JSON.stringify(rv));
      // a paid sale: return after the bill was paid takes off the bill to below nothing
      const s2 = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const [, po] = payOp(anjali, { amount: 10000 }, [{ bill_id: s2.rc, amount: 10000 }]);
      await push([po]);
      const r2 = await refund(s2, 1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const b2 = await bill(s2.rc);
      check('T5 off a bill already paid (another till took the money): stored, paid over, flagged', tag(r2.out[0]) === 'applied' && Number(b2.owed) === -10000 && b2.flags.some((f) => f.why === 'over-returned'), JSON.stringify(b2.flags));
      const s3 = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const [, po3] = payOp(anjali, { amount: 10000 }, [{ bill_id: s3.rc, amount: 10000 }]);
      await push([po3]);
      const r3 = await refund(s3, 1, [{ payment_type_id: cash, amount: 10000 }]);
      check('T5 a paid bill refunded in cash: nothing flagged', tag(r3.out[0]) === 'applied' && (await reviews(r3.rf)).length === 0, JSON.stringify(await reviews(r3.rf)));
      const plain = await sale(1, [{ payment_type_id: cash, amount: 10000 }]);
      const r4 = await refund(plain, 1, [{ payment_type_id: acct.id, amount: 10000 }]);
      check('T5 "off the bill" for a sale that had none: refused', tag(r4.out[0]) === 'rejected:bad-payment', tag(r4.out[0]));
      const over = await refund(s, 1, [{ payment_type_id: acct.id, amount: 20000 }]);
      check('T5 more than the refund is worth: refused', tag(over.out[0]).startsWith('rejected'), tag(over.out[0]));
      for (const x of [s, s2, s3]) await c.query(`update account_bills set deleted_at = now() where id = $1`, [x.rc]);
    }

    // ---- T6 a sale paid already is not billed twice ----
    {
      const s = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      const rc2 = id(); seq++;
      const out = await push([op('receipt.create', { id: rc2, ticket_id: s.tk, store_id: store, device_id: dev, number: 'AC1-T1-' + seq, device_seq: seq, device_time: now(), payments: [{ payment_type_id: acct.id, amount: 10000 }] })]);
      const b = await bill(rc2);
      check('T6 a second receipt for a paid sale: its bill is nothing, flagged double-pay', tag(out[0]) === 'applied' && b && Number(b.amount) === 0 && b.flags.some((f) => f.why === 'double-pay'), tag(out[0]) + ' ' + JSON.stringify(b?.flags));
      await c.query(`update account_bills set deleted_at = now() where id = any($1)`, [[s.rc, rc2]]);
    }

    // ---- T7 a payment type is not corrected to or from On account ----
    {
      const s = await sale(1, [{ payment_type_id: cash, amount: 10000 }]);
      const out = await push([op('payment.correct', { id: id(), receipt_id: s.rc, from_payment_type_id: cash, to_payment_type_id: acct.id })]);
      check('T7 cash corrected into On account: refused', tag(out[0]) === 'rejected:bad-payment', tag(out[0]));
      const out2 = await push([op('payment.correct', { id: id(), receipt_id: S1.rc, from_payment_type_id: acct.id, to_payment_type_id: cash })]);
      check('T7 On account corrected into cash: refused', tag(out2[0]) === 'rejected:bad-payment', tag(out2[0]));
      const dp = await push([op('deposit.create', { id: id(), store_id: store, device_id: dev, number: 'AC1-T1-D1', customer_id: anjali, collect_by: '2026-12-31', device_time: now(),
        lines: [{ id: id(), item_id: toy, name: 'Toy', qty: 1000, unit_price: 10000 }], payment: { id: id(), payment_type_id: acct.id, amount: 1000 } })]);
      check('T7 a deposit is never paid on account', tag(dp[0]) === 'rejected:bad-payment', tag(dp[0]));
    }

    // ---- T8 the pull ----
    {
      const r = await pull();
      const rows = r.changes.account_bills || [];
      check('T8 the pull sends the open bills and the ones paid over', rows.some((x) => x.id === S3.rc) && rows.some((x) => x.id === S1.rc), rows.length);
      check('T8 and the On account type', (r.changes.payment_types || []).some((p) => p.kind === 'account'));
      check('T8 and the drawer rows say which payment', (r.changes.cash_movements || []).some((m) => m.account_payment_id));
    }

    // ---- T9 settings ----
    {
      const ok = await push([op('settings.save', { accounts: 'off', accountDays: 45 })]);
      const s = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('T9 the two settings are saved from a till', tag(ok[0]) === 'applied' && s.accounts === 'off' && s.accountDays === 45);
      for (const bad of [{ accountDays: 0 }, { accountDays: 400 }, { accounts: 'yes' }, { accountDays: 'x' }]) {
        const out = await push([op('settings.save', bad)]);
        check('T9 refused: ' + JSON.stringify(bad), tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
      }
      const later = await sale(1, [{ payment_type_id: acct.id, amount: 10000 }]);
      check('T9 switched off by the shop, a sale already on account still writes its bill', !!(await bill(later.rc)));
    }

    // ---- T10 a till is not bare; clearing a test client ----
    {
      check('T10 a till that sold on account is not bare', (await one(`select platform.till_is_bare($1,$2) as b`, [tid, dev])).b === false);
      await c.query('SAVEPOINT clear');
      let said = null, left = null;
      try {
        await c.query(`select platform.clear_test_activity($1,$2)`, [admin, tid]);
        left = await one(`select (select count(*) from account_bills where tenant_id = $1)::int as b, (select count(*) from account_payments where tenant_id = $1)::int as p,
          (select count(*) from account_payment_lines where tenant_id = $1)::int as l`, [tid]);
      } catch (e) { said = e.message; }
      await c.query('ROLLBACK TO SAVEPOINT clear');
      check('T10 Clear test activity clears bills, payments and their lines', said === null && left.b === 0 && left.p === 0 && left.l === 0, said || JSON.stringify(left));
    }
    // ---- T11 a customer deleted outright (a client removed for good) leaves their bills with nobody ----
    {
      await c.query('SAVEPOINT del');
      let said = null, left = null;
      try {
        await c.query(`delete from customers where id = $1`, [ravi]);
        left = await one(`select (select count(*) from account_bills where tenant_id = $1 and customer_id is null and id = $2)::int as b,
          (select count(*) from account_payments where tenant_id = $1 and customer_id is null)::int as p`, [tid, S3.rc]);
      } catch (e) { said = e.message; }
      await c.query('ROLLBACK TO SAVEPOINT del');
      check('T11 deleting a customer outright keeps their bills and payments, naming nobody', said === null && left.b === 1 && left.p >= 2, said || JSON.stringify(left));
    }
  } catch (e) {
    failures++;
    console.log('FAIL threw: ' + e.message + '\n' + e.stack);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
