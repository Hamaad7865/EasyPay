// credit-notes.test.cjs — migration 0109: a shop's return policy, and credit
// notes, as a till sends them (sync_push) and gets them back (sync_pull).
//   - a plain refund (money back) is refused unless the shop refunds
//   - inside the window whoever is at the till returns alone; past it the
//     right to refund is needed, held or approved; window 0 is always
//   - a credit note is written with the exchange's refund, or neither is
//   - a note is spent in parts; used up it is refused; one spent past its
//     balance by two tills apart is flagged and closed; expired and cancelled
//     notes are refused; a payment is not corrected from the kind
//   - the pull sends the shop's notes and the credit-note type
//   - the three settings are saved from a till, and a bad value refused
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/credit-notes.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });
let made = 0;
const lineId = () => `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-cn@example.com')`, [admin]);
    const made1 = (await one(`select platform.create_tenant_of_type($1,'Note Test','Main','CN1','Owner',$2,'premium','retail') as r`, [admin, id()])).r;
    const tid = made1.tenant_id, store = made1.store_id, owner = made1.employee_id;

    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '') + (o.replayed ? ':replayed' : '');
    const tags = (out) => out.map(tag).join(' ');

    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
    const vat = (await one(`select id from taxes where tenant_id = $1 and name = 'VAT'`, [tid])).id;
    // someone at the till who may sell and take payment, and nothing else
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    const customer = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Anjali','5555 1234') returning id`, [tid])).id;
    const item = async (name, price) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,$2,$3,1000,true) returning id`, [tid, name, price])).id;
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
      await c.query(`select stock_move($1,$2,$3,null,20000,'receive',1000,'delivery',$4,$5,null)`, [tid, store, it, id(), owner]);
      return it;
    };
    const dress = await item('Dress', 59000);
    const mug = await item('Mug', 11500);
    const reviews = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id = $1 order by 1`, [rc])).rows.map((x) => x.reason).join();
    const detail = async (rc, reason) => (await one(`select detail from receipt_reviews where receipt_id = $1 and reason = $2`, [rc, reason]))?.detail;

    let seq = 0;
    const ticket = async (as) => { const tk = id(); const out = await push([op('ticket.create', { id: tk, store_id: store })], as); if (tag(out[0]) !== 'applied') throw new Error('ticket: ' + tag(out[0])); return tk; };
    const add = (tk, o) => { const lid = lineId(); return [lid, op('ticket.add_line', { id: lid, ticket_id: tk, qty: 1000, ...o })]; };
    const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
    const receiptOp = (tk, payments, extra = {}) => { const rc = id(); seq++; return [rc, op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'CN-' + seq, device_seq: seq, device_time: new Date().toISOString(), payments, ...extra })]; };
    // `as`: who is at the till for this operation (the login pushing stays the owner, who vouches for staff, as a till's login does)
    const refundOp = (rc, lines, payments, extra = {}, as) => { const rf = id(); seq++; return [rf, op('refund.create', { id: rf, refund_of: rc, store_id: store, device_id: dev, number: 'CN-R' + seq, device_seq: seq, device_time: new Date().toISOString(), reason: 'exchange', lines, payments, ...extra }, as)]; };
    // the owner, or a member of staff, tries something the server may refuse: what it said, with the transaction kept whole
    const tryApp = async (sql, params) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      await c.query('SAVEPOINT tryapp');
      let said = null;
      try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT tryapp'); }
      catch (e) { said = e.message; await c.query('ROLLBACK TO SAVEPOINT tryapp'); }
      await c.query('RESET ROLE');
      return said;
    };
    // a dress sold for cash, as the till sends it; daysAgo dates the sale by the till's clock (a receipt is never updated)
    const saleOf = async (amount, as, daysAgo = 0) => {
      const tk = await ticket(as);
      const [l, o1] = add(tk, { item_id: dress, name_snapshot: 'Dress', unit_price: amount });
      const [rc, o2] = receiptOp(tk, [{ payment_type_id: cash, amount }], daysAgo ? { device_time: ago(daysAgo) } : {});
      const out = await push([o1, o2], as);
      if (tags(out) !== 'applied applied') throw new Error('sale: ' + tags(out) + ' ' + JSON.stringify(out));
      return { rc, l, tk };
    };
    const setReturns = (returns, days = 7, months = 6) => c.query(`update pos_settings set data = data || $2::jsonb where tenant_id = $1`, [tid, JSON.stringify({ returns, returnDays: days, noteMonths: months })]);

    const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [tid])).id;
    const noteType = (await one(`select id, opens_drawer from payment_types where tenant_id = $1 and kind = 'credit_note' and deleted_at is null`, [tid]));
    check('T1 a shop has one credit-note type, made with the exchange type, that opens no drawer', !!noteType && noteType.opens_drawer === false);
    {
      await c.query('SAVEPOINT second');
      let said;
      try { await c.query(`insert into payment_types (tenant_id, name, kind) values ($1,'Another note','credit_note')`, [tid]); await c.query('RELEASE SAVEPOINT second'); said = 'made'; }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT second'); said = 'refused'; }
      check('T1 and cannot be given a second', said === 'refused', said);
    }

    // ---- T2 policy: money back only where the shop refunds ----
    {
      await setReturns('exchange');
      const s = await saleOf(11500);
      // a fresh operation each time: the server answers a repeated one with what it said the first time
      const cashBack = () => refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }])[1];
      let out = await push([cashBack()]);
      check('T2 under exchange-only a refund in cash is refused', tag(out[0]) === 'rejected:refund-policy', JSON.stringify(out[0]));
      await setReturns('credit');
      out = await push([cashBack()]);
      check('T2 under credit-note it is refused too', tag(out[0]) === 'rejected:refund-policy', tag(out[0]));
      await setReturns('refund');
      out = await push([cashBack()]);
      check('T2 under refund it is taken', tag(out[0]) === 'applied', tag(out[0]));
    }

    // ---- T3 the window ----
    {
      await setReturns('refund', 7);
      // Cara may not refund: inside the window she returns alone, past it she needs someone who may
      const s = await saleOf(11500);
      const [, r0] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }], {}, cara);
      let out = await push([r0]);
      check('T3 two hours old, Cara alone: taken', tag(out[0]) === 'applied', tag(out[0]));
      // past the window the right is needed, as it was for every refund before this (0082): from a till's
      // login, which vouches for its staff, one nobody allowed is stored and flagged; from any other, refused
      const s2 = await saleOf(11500, undefined, 9);
      const [rf1, r1] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }], {}, cara);
      out = await push([r1]);
      check('T3 nine days old, Cara alone, from the till: stored and flagged', tag(out[0]) === 'applied' && (await reviews(rf1)) === 'refund-unapproved', tag(out[0]) + ' ' + (await reviews(rf1)));
      const s2b = await saleOf(11500, undefined, 9);
      const [, r1b] = refundOp(s2b.rc, [{ ticket_line_id: s2b.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }]);
      out = await push([r1b], cara);
      check('T3 nine days old, Cara alone, from a login that vouches for nobody: refused', tag(out[0]) === 'rejected:forbidden', tag(out[0]));
      const [rf2, r2] = refundOp(s2b.rc, [{ ticket_line_id: s2b.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }], { approved_by: owner }, cara);
      out = await push([r2]);
      check('T3 nine days old, the owner approving: taken, nothing flagged', tag(out[0]) === 'applied' && (await reviews(rf2)) === '', JSON.stringify(out[0]));
      await setReturns('refund', 0);
      const s3 = await saleOf(11500);
      const r3 = (as) => refundOp(s3.rc, [{ ticket_line_id: s3.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }], {}, as)[1];
      out = await push([r3()], cara);
      check('T3 window 0, Cara alone, an hour old: refused', tag(out[0]) === 'rejected:forbidden', tag(out[0]));
      out = await push([r3()]);
      check('T3 window 0, the owner: taken, as before this', tag(out[0]) === 'applied', tag(out[0]));
    }

    // ---- T4 a note is written with its refund, or neither is ----
    let noteNo, noteId;
    {
      await setReturns('credit', 7, 6);
      const s = await saleOf(59000);
      noteId = id(); noteNo = 'CN1-T1-CN000001';
      // the exchange's refund: Rs 320 to the new sale, Rs 270 kept on a note for a named customer
      const [rf, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 32000 }, { payment_type_id: noteType.id, amount: 27000 }],
        { credit_note: { id: noteId, number: noteNo, amount: 27000, valid_to: '2027-04-14', customer_id: customer } });
      const out = await push([r1]);
      const row = await one(`select *, valid_to::text as valid from credit_notes where id = $1`, [noteId]);
      check('T4 the note is written with the refund, open, at its full amount', tag(out[0]) === 'applied' && row && Number(row.amount) === 27000 && Number(row.balance) === 27000 && row.status === 'open' && row.refund_id === rf && row.customer_id === customer && row.valid === '2027-04-14',
        tag(out[0]) + ' ' + JSON.stringify(row));
      check('T4 the answer names the note', out[0].data && out[0].data.credit_note === noteNo, JSON.stringify(out[0].data));
      const s2 = await saleOf(59000);
      const [, bad] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: exch, amount: 32000 }, { payment_type_id: noteType.id, amount: 27000 }],
        { credit_note: { id: id(), number: 'CN1-T1-CN000002', amount: 20000 } });
      check('T4 a note that does not match its payment is refused with the refund', tag((await push([bad]))[0]) === 'rejected:bad-payment');
      const [, bad2] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: exch, amount: 32000 }, { payment_type_id: noteType.id, amount: 27000 }]);
      check('T4 a payment to the note type with no note is refused', tag((await push([bad2]))[0]) === 'rejected:bad-payment');
      const [, bad3] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: noteType.id, amount: 59000 }], { credit_note: { id: id(), number: 'CN1-T1-CN000003', amount: 59000 } });
      check('T4 a note from a plain return, nothing to the new sale, is refused', tag((await push([bad3]))[0]) === 'rejected:refund-policy');
      check('T4 none of the three left a note behind', Number((await one(`select count(*) as n from credit_notes where tenant_id = $1`, [tid])).n) === 1);
    }

    // ---- T5 spending ----
    // a product at its catalogue price (a price of the till's own would be flagged as drift), the note for `amount` of it and cash for the rest
    const spend = async (amount, ref) => {
      const tk = await ticket();
      const [it, name, price] = amount > 11500 ? [dress, 'Dress', 59000] : [mug, 'Mug', 11500];
      const [, o1] = add(tk, { item_id: it, name_snapshot: name, unit_price: price });
      const [rc, o2] = receiptOp(tk, [{ payment_type_id: noteType.id, amount, reference: ref }, ...(price > amount ? [{ payment_type_id: cash, amount: price - amount }] : [])]);
      const out = await push([o1, o2]);
      return { rc, said: tags(out) };
    };
    {
      let r = await spend(10000, noteNo);
      let row = await one(`select balance, status from credit_notes where id = $1`, [noteId]);
      check('T5 Rs 100 of the note spent, cash for the rest: balance Rs 170, open, nothing flagged', r.said === 'applied applied' && Number(row.balance) === 17000 && row.status === 'open' && (await reviews(r.rc)) === '', r.said + ' ' + JSON.stringify(row) + ' ' + (await reviews(r.rc)));
      r = await spend(17000, noteNo);
      row = await one(`select balance, status, used_at from credit_notes where id = $1`, [noteId]);
      check('T5 the rest spent with cash beside it: used up', r.said === 'applied applied' && Number(row.balance) === 0 && row.status === 'used' && row.used_at !== null && (await reviews(r.rc)) === '', JSON.stringify(row) + ' ' + (await reviews(r.rc)));
      r = await spend(5000, noteNo);
      check('T5 spent again: stored, flagged as used', r.said === 'applied applied' && (await reviews(r.rc)) === 'credit-note-refused' && (await detail(r.rc, 'credit-note-refused')).notes[0].why === 'used', await reviews(r.rc));
      r = await spend(5000, 'CN1-T1-CN009999');
      check('T5 a note nobody issued: flagged as not found', (await reviews(r.rc)) === 'credit-note-refused' && (await detail(r.rc, 'credit-note-refused')).notes[0].why === 'not-found');
    }

    // ---- T6 overspent by two tills apart ----
    {
      const s = await saleOf(30000);
      const nid = id(), nno = 'CN1-T1-CN000010';
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 10000 }, { payment_type_id: noteType.id, amount: 20000 }], { credit_note: { id: nid, number: nno, amount: 20000 } });
      const o = await push([r1]);
      if (tag(o[0]) !== 'applied') throw new Error('T6 refund: ' + tag(o[0]));
      const a = await spend(15000, nno), b = await spend(15000, nno);
      const row = await one(`select balance, status from credit_notes where id = $1`, [nid]);
      const why = (await detail(b.rc, 'credit-overspent')).notes[0];
      check('T6 the first is clean; the second is flagged overspent by Rs 100 and the note is used up', (await reviews(a.rc)) === '' && (await reviews(b.rc)) === 'credit-overspent' && Number(why.excess) === 10000 && Number(why.balance) === 5000 && Number(row.balance) === 0 && row.status === 'used',
        JSON.stringify(row) + ' ' + JSON.stringify(why));
    }

    // ---- T7 expired, cancelled, a correction, the pull ----
    {
      const s = await saleOf(30000);
      const nid = id(), nno = 'CN1-T1-CN000020';
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 10000 }, { payment_type_id: noteType.id, amount: 20000 }], { credit_note: { id: nid, number: nno, amount: 20000, valid_to: '2020-01-01' } });
      const o = await push([r1]);
      if (tag(o[0]) !== 'applied') throw new Error('T7 refund: ' + tag(o[0]));
      const r = await spend(5000, nno);
      const d = await detail(r.rc, 'credit-note-refused');
      check('T7 an expired note is flagged, with its date', (await reviews(r.rc)) === 'credit-note-refused' && d.notes[0].why === 'expired' && String(d.notes[0].valid_to).startsWith('2020-01-01'), (await reviews(r.rc)) + ' ' + JSON.stringify(d));
      const first = await tryApp(`select credit_note_void($1, $2, $3, 'slip proven forged')`, [tid, owner, nid]);
      const row = await one(`select status, balance, void_reason, voided_by from credit_notes where id = $1`, [nid]);
      check('T7 cancelled: balance 0, the reason and who kept', first === null && row.status === 'void' && Number(row.balance) === 0 && row.void_reason === 'slip proven forged' && row.voided_by === owner, (first || '') + ' ' + JSON.stringify(row));
      const threw = await tryApp(`select credit_note_void($1, $2, $3, 'again')`, [tid, owner, nid]);
      check('T7 cancelled twice: refused', /note-closed/.test(threw || ''), threw);
      const blank = await tryApp(`select credit_note_void($1, $2, $3, '  ')`, [tid, owner, id()]);
      check('T7 no reason: refused before anything is looked up', /bad-payload/.test(blank || ''), blank);
      const r2 = await spend(5000, nno);
      check('T7 a cancelled note is refused as cancelled', (await detail(r2.rc, 'credit-note-refused')).notes[0].why === 'void');
      const corr = await push([op('payment.correct', { id: id(), receipt_id: r2.rc, from_payment_type_id: noteType.id, to_payment_type_id: cash })]);
      check('T7 a payment is not corrected from the credit-note type', tag(corr[0]) === 'rejected:bad-payment', tag(corr[0]));
      const pulled = await asApp(async () => (await c.query('select sync_pull($1, 0, 500) as r', [store])).rows[0].r);
      const sent = (pulled.changes.credit_notes || []);
      const nums = sent.map((x) => x.number);
      check('T7 the pull sends the shop\'s notes, the used and the cancelled too (they changed)', nums.includes(noteNo) && nums.includes(nno) && sent.find((x) => x.number === nno).status === 'void', nums.join());
      check('T7 the pull sends the credit-note type', (pulled.changes.payment_types || []).some((x) => x.kind === 'credit_note'));
    }

    // ---- T8 settings ----
    {
      let out = await push([op('settings.save', { returns: 'credit', returnDays: 14, noteMonths: 12 })]);
      const d = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('T8 the three keys are saved from a till', tag(out[0]) === 'applied' && d.returns === 'credit' && d.returnDays === 14 && d.noteMonths === 12, tag(out[0]) + ' ' + JSON.stringify(d));
      out = await push([op('settings.save', { returns: 'maybe' })]);
      check('T8 a policy nobody knows is refused', tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
      out = await push([op('settings.save', { returnDays: 900 })]);
      check('T8 a window out of range is refused', tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
      out = await push([op('settings.save', { noteMonths: 'six' })]);
      check('T8 months that are not a number are refused', tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
    }

    // ---- T9 the type follows the kind of business ----
    {
      const made2 = (await one(`select platform.create_tenant_of_type($1,'Note Resto','Main','CN2','Owner',$2,'premium','restaurant') as r`, [admin, id()])).r;
      const live = async (t) => (await c.query(`select kind from payment_types where tenant_id = $1 and kind in ('exchange','credit_note') and deleted_at is null order by 1`, [t])).rows.map((x) => x.kind).join();
      check('T9 a restaurant has neither type', (await live(made2.tenant_id)) === '');
      await c.query(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, made2.tenant_id]);
      check('T9 made a shop, it has both', (await live(made2.tenant_id)) === 'credit_note,exchange', await live(made2.tenant_id));
      await c.query(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [admin, made2.tenant_id]);
      check('T9 made a restaurant again, it has neither live', (await live(made2.tenant_id)) === '');
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE_FAILED:' + (e.stack || e.message)); process.exit(1); });
