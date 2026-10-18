// deposits.test.cjs — migration 0113: a shop's deposits (layaway), as a till
// sends them (sync_push) and gets them back (sync_pull).
//   - only a client with the feature (premium, trial, or switched on in
//     /admin) takes one; money that already moved is never refused
//   - taking one holds the goods off the shelf, once per product, at the
//     price of the day; cash goes in the drawer's rows with the deposit named
//   - payments add up; one on a closed deposit is kept and said
//   - a collection is an ordinary receipt: its deposit lines are sold at the
//     kept price whatever the catalogue says, move no stock, and its Deposit
//     payment is taken up to what is free; beyond that it is stored, flagged
//   - a cancel puts back what was not collected and gives the money back,
//     onto a credit note, or keeps it, as the till said; a second is nothing
//   - past the date the server cancels for a shop set to (not a tablet alone)
//   - refunding a collection; numbers that clash; the pull; the settings;
//     clearing a test client with deposits on it
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/deposits.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

// a module of web/lib, compiled from the TypeScript it lives in, as stock-reports.test.cjs does
function lib(name, stubs = {}) {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)((id) => (id in stubs ? stubs[id] : require(id)), mod, mod.exports);
  return mod.exports;
}

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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-dep@example.com')`, [admin]);
    const made1 = (await one(`select platform.create_tenant_of_type($1,'Deposit Test','Main','DP1','Owner',$2,'standard','retail') as r`, [admin, id()])).r;
    const tid = made1.tenant_id, store = made1.store_id, owner = made1.employee_id;

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
    const vat = (await one(`select id, type, rate_bp from taxes where tenant_id = $1 and name = 'VAT'`, [tid]));
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    const customer = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Anjali','5555 1234') returning id`, [tid])).id;
    const shift = (await one(`insert into shifts (tenant_id, store_id, device_id, opened_by, opening_float, opened_at) values ($1,$2,$3,$4,0,now()) returning id`, [tid, store, dev, owner])).id;
    const item = async (name, price) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,$2,$3,1000,true) returning id`, [tid, name, price])).id;
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat.id]);
      await c.query(`select stock_move($1,$2,$3,null,20000,'receive',1000,'delivery',$4,$5,null)`, [tid, store, it, id(), owner]);
      return it;
    };
    const pram = await item('Pram', 150000);
    const cot = await item('Cot', 50000);
    const stock = async (it) => Number((await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, store, it]))?.qty ?? 0);
    const dep = async (did) => one(`select * from deposits where id = $1`, [did]);
    const reviews = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id = $1 order by 1`, [rc])).rows.map((x) => x.reason).join();
    const setSettings = (o) => c.query(`update pos_settings set data = data || $2::jsonb where tenant_id = $1`, [tid, JSON.stringify(o)]);
    const depType = (await one(`select id, is_active, opens_drawer from payment_types where tenant_id = $1 and kind = 'deposit' and deleted_at is null`, [tid]));

    let n = 0;
    const now = () => new Date().toISOString();
    const createOp = (lines, payment, extra = {}) => {
      const did = id(); n++;
      return [did, 'DP1-T1-D' + String(n).padStart(6, '0'), op('deposit.create', {
        id: did, store_id: store, device_id: dev, number: 'DP1-T1-D' + String(n).padStart(6, '0'), customer_id: customer,
        collect_by: '2026-12-31', device_time: now(),
        lines: lines.map((l) => ({ id: id(), qty: 1000, ...l })),
        ...(payment ? { payment: { id: id(), shift_id: shift, ...payment } } : {}), ...extra,
      })];
    };
    const lineIds = async (did) => (await c.query(`select id, item_id, qty, qty_collected, unit_price from deposit_lines where deposit_id = $1 order by sort`, [did])).rows;

    let seq = 0;
    const ticket = async () => { const tk = id(); const out = await push([op('ticket.create', { id: tk, store_id: store })]); if (tag(out[0]) !== 'applied') throw new Error('ticket'); return tk; };
    // a collection: lines handed over from a deposit, paid with the Deposit type then others
    const collect = async (number, lines, payments) => {
      const tk = await ticket();
      const ops = lines.map((l) => op('ticket.add_line', { id: id(), ticket_id: tk, qty: 1000, ...l }));
      const rc = id(); seq++;
      ops.push(op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'DP-S' + seq, device_seq: seq, device_time: now(), payments }));
      const out = await push(ops);
      return { rc, out };
    };
    const total = async (rc) => Number((await one(`select total from receipts where id = $1`, [rc])).total);

    check('T0 a shop has a Deposit type, inactive (an old till never offers it), opening no drawer', !!depType && depType.is_active === false && depType.opens_drawer === false);

    // ---- T1 the feature ----
    {
      const [, , o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], null);
      let out = await push([o]);
      check('T1 a Standard shop without the feature: a deposit with no money is refused', tag(out[0]) === 'rejected:not-entitled', tag(out[0]));
      const [did, , o2] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 10000 });
      out = await push([o2]);
      const d = await dep(did);
      check('T1 with money already taken it is stored and flagged', tag(out[0]) === 'applied' && d.flags.some((f) => f.why === 'not-entitled'), JSON.stringify(d?.flags));
      await c.query(`select platform.set_tenant_features($1,$2,array['deposits'])`, [admin, tid]);
      const feats = (await one(`select data->'features' as f from pos_settings where tenant_id = $1`, [tid])).f;
      check('T1 switched on in /admin: the tills are told through their settings', JSON.stringify(feats) === '["deposits"]', JSON.stringify(feats));
      const [, , o3] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], null);
      out = await push([o3]);
      check('T1 then a deposit with nothing paid is taken', tag(out[0]) === 'applied', tag(out[0]));
      let said = null;
      try { await c.query('SAVEPOINT f'); await c.query(`select platform.set_tenant_features($1,$2,array['nonsense'])`, [admin, tid]); await c.query('RELEASE SAVEPOINT f'); }
      catch (e) { said = e.message; await c.query('ROLLBACK TO SAVEPOINT f'); }
      check('T1 a feature nobody knows is refused', said === 'bad-feature', said);
      check('T1 has_feature is true once switched on', (await one(`select has_feature($1,'deposits') as x`, [tid])).x === true);
    }

    // ---- T2 taking one: held, frozen, drawer ----
    let A, Anum;
    {
      const pram0 = await stock(pram), cot0 = await stock(cot);
      // two lines of the same product (one at a discount) and one other: held once per product
      const [did, num, o] = createOp([
        { item_id: pram, name: 'Pram', unit_price: 150000 },
        { item_id: pram, name: 'Pram', unit_price: 135000, list_price: 150000, price_kind: 'discount', price_label: '10%' },
        { item_id: cot, name: 'Cot', unit_price: 50000 },
      ], { payment_type_id: cash, amount: 50000, tendered: 60000, change: 10000 });
      A = did; Anum = num;
      const out = await push([o]);
      const d = await dep(did);
      check('T2 taken', tag(out[0]) === 'applied', JSON.stringify(out[0]));
      const added = vat.type === 'added' ? Math.round(335000 * vat.rate_bp / 10000) : 0;
      check('T2 its total is the lines at the day\'s prices (and a tax added on top, if any)', Number(d.total) === 335000 + added, d.total);
      check('T2 paid 500.00, free 500.00', Number(d.paid) === 50000 && Number((await one(`select deposit_free(d) as f from deposits d where id = $1`, [did])).f) === 50000);
      check('T2 two prams and a cot left the shelf', (await stock(pram)) === pram0 - 2000 && (await stock(cot)) === cot0 - 1000, `${pram0}->${await stock(pram)}`);
      const mv = (await c.query(`select item_id, qty, reason from stock_movements where ref_id = $1 order by item_id`, [did])).rows;
      check('T2 one movement per product, kind deposit', mv.length === 2 && mv.every((m) => m.reason === 'deposit'), JSON.stringify(mv));
      const cm = await one(`select type, amount, reason, deposit_id, shift_id from cash_movements where deposit_id = $1`, [did]);
      check('T2 the cash is in the drawer\'s rows, with the deposit named', cm && cm.type === 'in' && Number(cm.amount) === 50000 && cm.shift_id === shift && cm.reason === 'Deposit ' + num, JSON.stringify(cm));
      const again = await push([o]);
      check('T2 the same operation again is answered as before', again[0].status === 'applied' && (await c.query(`select count(*)::int as n from deposits where id = $1`, [did])).rows[0].n === 1);
      const dup = op('deposit.create', { ...o.payload });
      const out2 = await push([dup]);
      check('T2 the same deposit sent again under a new operation changes nothing', out2[0].status === 'applied' && out2[0].data.replayed === true && (await stock(pram)) === pram0 - 2000, JSON.stringify(out2[0]));
    }

    // ---- T3 payments ----
    {
      const out = await push([op('deposit.pay', { deposit_id: A, device_id: dev, device_time: now(), payment: { id: id(), payment_type_id: card, amount: 70000, shift_id: shift } })]);
      const d = await dep(A);
      check('T3 700.00 by card: paid 1,200.00', tag(out[0]) === 'applied' && Number(d.paid) === 120000, d.paid);
      check('T3 card money is not in the drawer', (await one(`select count(*)::int as n from cash_movements where deposit_id = $1`, [A])).n === 1);
      const bad = await push([op('deposit.pay', { deposit_id: A, device_id: dev, payment: { id: id(), payment_type_id: depType.id, amount: 100 } })]);
      check('T3 a deposit is not paid with the Deposit type', tag(bad[0]) === 'rejected:bad-payment', tag(bad[0]));
      const unknown = await push([op('deposit.pay', { deposit_id: id(), device_id: dev, payment: { id: id(), payment_type_id: cash, amount: 100 } })]);
      check('T3 a deposit nobody has: refused', tag(unknown[0]) === 'rejected:bad-deposit', tag(unknown[0]));
    }

    // ---- T4 a collection in two visits, at the kept price ----
    let first;
    {
      // the price goes up after the deposit
      await c.query(`update items set price = 175000 where id = $1`, [pram]);
      const L = await lineIds(A);
      const pram0 = await stock(pram);
      const r1 = await collect(Anum, [{ item_id: pram, name_snapshot: 'Pram', unit_price: 150000, deposit_line_id: L[0].id }],
        [{ payment_type_id: depType.id, amount: 120000, reference: Anum }, { payment_type_id: cash, amount: 30000 }]);
      first = r1.rc;
      check('T4 first visit, one pram: the receipt is taken at the kept price, not flagged', tags(r1.out) === 'applied applied' && (await total(r1.rc)) === 150000 && (await reviews(r1.rc)) === '', tags(r1.out) + ' ' + (await reviews(r1.rc)));
      check('T4 no stock moved again', (await stock(pram)) === pram0);
      let d = await dep(A);
      check('T4 the deposit used 1,200.00, nothing free, still open', Number(d.used) === 120000 && d.status === 'open', `${d.used} ${d.status}`);
      // the second visit: the discounted pram and the cot, the rest in cash (the deposit has nothing free)
      const r2 = await collect(Anum, [
        { item_id: pram, name_snapshot: 'Pram', unit_price: 135000, list_price: 150000, price_kind: 'discount', price_label: '10%', deposit_line_id: L[1].id },
        { item_id: cot, name_snapshot: 'Cot', unit_price: 50000, deposit_line_id: L[2].id },
      ], [{ payment_type_id: cash, amount: 185000 }]);
      d = await dep(A);
      check('T4 second visit: taken, the discount allowed then is not asked again', tags(r2.out) === 'applied applied applied' && (await reviews(r2.rc)) === '', await reviews(r2.rc));
      check('T4 every line collected: the deposit is collected', d.status === 'collected', d.status);
      const L2 = await lineIds(A);
      check('T4 each line says what was taken', L2.every((l) => l.qty === l.qty_collected));
    }

    // ---- T4b part of a deposit taken, paid in cash: the other tablets hear of it (0117) ----
    {
      const [did, num, o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }, { item_id: cot, name: 'Cot', unit_price: 50000 }], null);
      await push([o]);
      const L = await lineIds(did);
      const before = Number((await dep(did)).server_seq);
      const r = await collect(num, [{ item_id: cot, name_snapshot: 'Cot', unit_price: 50000, deposit_line_id: L[0].id }], [{ payment_type_id: cash, amount: 50000 }]);
      const d = await dep(did);
      const taken = (await lineIds(did)).find((l) => l.id === L[0].id);
      check('T4b one of two lines taken and paid in cash: the deposit, still open, goes out again at the next pull',
        tags(r.out) === 'applied applied' && taken.qty_collected === 1000 && d.status === 'open' && Number(d.server_seq) > before,
        `${tags(r.out)} ${taken.qty_collected} ${d.status} ${before} ${d.server_seq}`);
    }

    // ---- T5 using more than is free; a line beyond what is held ----
    {
      const [did, num, o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 20000 });
      await push([o]);
      const L = await lineIds(did);
      const cot0 = await stock(cot);
      const r = await collect(num, [{ item_id: cot, name_snapshot: 'Cot', unit_price: 50000, qty: 2000, deposit_line_id: L[0].id }],
        [{ payment_type_id: depType.id, amount: 30000, reference: num }, { payment_type_id: cash, amount: 70000 }]);
      const det = (await one(`select detail from receipt_reviews where receipt_id = $1 and reason = 'deposit-overused'`, [r.rc]))?.detail;
      check('T5 stored and flagged deposit-overused', tag(r.out.at(-1)) === 'applied' && !!det, JSON.stringify(det));
      check('T5 says both: one cot not held, Rs 100.00 more than was free', det && det.deposits.some((x) => x.why === 'not-held' && x.qty === 1000) && det.deposits.some((x) => x.why === 'overused' && x.excess === 10000), JSON.stringify(det));
      check('T5 the cot that was not held left the shelf as a sale', (await stock(cot)) === cot0 - 1000, `${cot0} -> ${await stock(cot)}`);
      const d = await dep(did);
      check('T5 the deposit used only what was free', Number(d.used) === 20000 && d.status === 'collected', `${d.used} ${d.status}`);
      const r2 = await collect('NOPE-1', [{ item_id: cot, name_snapshot: 'Cot', unit_price: 50000 }], [{ payment_type_id: depType.id, amount: 50000, reference: 'NOPE-1' }]);
      check('T5 a Deposit payment naming no deposit: stored and flagged', tag(r2.out.at(-1)) === 'applied' && (await reviews(r2.rc)).includes('deposit-overused'), await reviews(r2.rc));
    }

    // ---- T6 cancel: refund, credit, keep ----
    const cancelOp = (did, outcome, extra = {}, as) => op('deposit.cancel', { deposit_id: did, device_id: dev, device_time: now(), reason: 'Changed mind', outcome, ...extra }, as);
    {
      const [did, , o] = createOp([{ item_id: pram, name: 'Pram', unit_price: 150000 }, { item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 40000 });
      await push([o]);
      const L = await lineIds(did);
      const dnum = (await dep(did)).number;
      // the cot is collected first, the deposit paying 300 of it
      await collect(dnum, [{ item_id: cot, name_snapshot: 'Cot', unit_price: 50000, deposit_line_id: L[1].id }],
        [{ payment_type_id: depType.id, amount: 30000, reference: dnum }, { payment_type_id: cash, amount: 20000 }]);
      const pram0 = await stock(pram);
      const out = await push([cancelOp(did, 'refund', { back: [{ id: id(), payment_type_id: cash, amount: 10000, shift_id: shift }] }, cara)]);
      check('T6 Cara may not refund: from the till that vouches for her the cancel is stored and flagged', tag(out[0]) === 'applied' && (await dep(did)).flags.some((f) => f.why === 'cancel-unapproved'), tag(out[0]));
      const d = await dep(did);
      check('T6 refund: the pram is back on the shelf, the cot stays sold', (await stock(pram)) === pram0 + 1000, `${pram0} -> ${await stock(pram)}`);
      check('T6 refund: 100.00 given back, nothing free, cancelled', Number(d.given_back) === 10000 && d.status === 'cancelled' && d.cancel_outcome === 'refund' && Number(d.owed) === 0, `${d.given_back} ${d.status} ${d.owed}`);
      const out1 = await (await one(`select type, amount from cash_movements where deposit_id = $1 and type = 'out'`, [did]));
      check('T6 the cash given back left the drawer', out1 && Number(out1.amount) === 10000);
      const again = await push([cancelOp(did, 'refund')]);
      check('T6 a second cancel changes nothing', again[0].status === 'applied' && again[0].data.already === true && (await stock(pram)) === pram0 + 1000);
      const rel = (await c.query(`select count(*)::int as n from stock_movements where ref_id = $1 and reason = 'deposit_release'`, [did])).rows[0].n;
      check('T6 one release movement, for what was not collected', rel === 1, rel);
    }
    {
      const [did, num, o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: card, amount: 25000 });
      await push([o]);
      const noteId = id();
      const out = await push([cancelOp(did, 'credit', { credit_note: { id: noteId, number: num + '-CN', amount: 25000, valid_to: '2027-04-16' } })]);
      const note = await one(`select * from credit_notes where id = $1`, [noteId]);
      check('T6 credit: a note of 250.00, numbered from the deposit, no refund behind it', tag(out[0]) === 'applied' && note && note.number === num + '-CN' && Number(note.balance) === 25000 && note.refund_id === null && note.deposit_id === did && note.customer_id === customer, JSON.stringify(note));
      const d = await dep(did);
      check('T6 credit: the deposit is cancelled, its money on the note, nothing free', d.cancel_outcome === 'credit' && Number(d.noted) === 25000 && Number((await one(`select deposit_free(x) as f from deposits x where id = $1`, [did])).f) === 0 && d.credit_note_id === noteId);
      // the note is spent on a sale
      const noteType = (await one(`select id from payment_types where tenant_id = $1 and kind = 'credit_note' and deleted_at is null`, [tid])).id;
      const tk = await ticket(); seq++;
      const rc = id();
      const sp = await push([op('ticket.add_line', { id: id(), ticket_id: tk, item_id: cot, qty: 1000, unit_price: 50000, name_snapshot: 'Cot' }),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'DP-S' + seq, device_seq: seq, device_time: now(),
          payments: [{ payment_type_id: noteType, amount: 25000, reference: num + '-CN' }, { payment_type_id: cash, amount: 25000 }] })]);
      check('T6 the note is spent on a sale', tags(sp) === 'applied applied' && Number((await one(`select balance from credit_notes where id = $1`, [noteId])).balance) === 0 && (await reviews(rc)) === '', await reviews(rc));
    }
    {
      const [did, , o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 15000 });
      await push([o]);
      await push([cancelOp(did, 'keep')]);
      const d = await dep(did);
      check('T6 keep: the shop keeps 150.00', d.cancel_outcome === 'keep' && Number(d.kept) === 15000 && Number(d.given_back) === 0);
      const out = await push([op('deposit.pay', { deposit_id: did, device_id: dev, payment: { id: id(), payment_type_id: cash, amount: 5000 } })]);
      check('T6 money on a cancelled deposit: kept and said', tag(out[0]) === 'applied' && (await dep(did)).flags.some((f) => f.why === 'closed-payment'));
      const r = await collect((await dep(did)).number, [{ item_id: cot, name_snapshot: 'Cot', unit_price: 50000, deposit_line_id: (await lineIds(did))[0].id }],
        [{ payment_type_id: cash, amount: 50000 }]);
      check('T6 a collection after the cancel: stored, flagged, and the cot leaves the shelf as a sale', tag(r.out.at(-1)) === 'applied' && (await reviews(r.rc)) === 'deposit-overused');
    }
    {
      // a login that vouches for nobody may not cancel without the right
      const [did, , o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], null);
      await push([o]);
      const out = await push([cancelOp(did, 'keep')], cara);
      check('T6 a cancel from a login that may not refund: refused', tag(out[0]) === 'rejected:forbidden', tag(out[0]));
      const ok = await push([cancelOp(did, 'keep', { approved_by: owner })]);
      check('T6 with someone who may approving: taken', tag(ok[0]) === 'applied');
      const bad = await push([cancelOp(did, 'nonsense')]);
      check('T6 an outcome nobody knows is refused', tag(bad[0]) === 'rejected:bad-payload', tag(bad[0]));
    }

    // ---- T7 past the date ----
    {
      const old = (o) => { o.payload.collect_by = '2026-01-01'; return o; };
      const [d1, , o1] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 10000 });
      await push([old(o1)]);
      await setSettings({ depositOverdue: 'show' });
      let nn = (await one(`select deposits_expire($1) as n`, [tid])).n;
      check('T7 set to show: nothing is cancelled', nn === 0 && (await dep(d1)).status === 'open');
      await setSettings({ depositOverdue: 'cancel', depositGrace: 0, depositCancel: 'refund' });
      const cot0 = await stock(cot);
      await asApp(() => c.query('select sync_pull($1, 0, 1)', [store]));
      let d = await dep(d1);
      check('T7 set to cancel: the next pull cancels it; under refund the money is owed', d.status === 'cancelled' && d.auto_cancelled && Number(d.owed) === 10000 && (await stock(cot)) === cot0 + 1000, `${d.status} ${d.owed}`);
      const gb = await push([op('deposit.give_back', { deposit_id: d1, device_id: dev, device_time: now(), back: [{ id: id(), payment_type_id: cash, amount: 10000, shift_id: shift }] })]);
      d = await dep(d1);
      check('T7 Give back pays what was owed', tag(gb[0]) === 'applied' && Number(d.owed) === 0 && Number(d.given_back) === 10000);
      const [d2, n2, o2] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 12000 });
      await push([old(o2)]);
      await setSettings({ depositCancel: 'credit', noteMonths: 6 });
      await one(`select deposits_expire($1) as n`, [tid]);
      const nt = await one(`select * from credit_notes where deposit_id = $1`, [d2]);
      check('T7 under credit: a note for what was free, valid six months', nt && nt.number === n2 + '-CN' && Number(nt.amount) === 12000 && nt.valid_to !== null, JSON.stringify(nt));
      const [d3, , o3] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 9000 });
      await push([old(o3)]);
      await c.query(`update tenants set plan = 'offline' where id = $1`, [tid]);
      nn = (await one(`select deposits_expire($1) as n`, [tid])).n;
      check('T7 a client on the offline plan: the server leaves it to the tablet', nn === 0 && (await dep(d3)).status === 'open');
      await c.query(`update tenants set plan = 'standard' where id = $1`, [tid]);
      // a tablet alone cancelling by date sends it as auto, with no right asked
      const out = await push([cancelOp(d3, 'refund', { auto: true })], cara);
      d = await dep(d3);
      check('T7 a tablet\'s own cancel by date: taken without the right, the money owed', tag(out[0]) === 'applied' && Number(d.owed) === 9000 && d.auto_cancelled);
      await setSettings({ depositOverdue: 'show' });
    }

    // ---- T8 refunding a collection ----
    {
      await setSettings({ returns: 'refund' });
      const [did, num, o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 50000 });
      await push([o]);
      const L = await lineIds(did);
      const tk = await ticket(); const lid = id(); seq++; const rc = id();
      await push([op('ticket.add_line', { id: lid, ticket_id: tk, item_id: cot, qty: 1000, unit_price: 50000, name_snapshot: 'Cot', deposit_line_id: L[0].id }),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'DP-S' + seq, device_seq: seq, device_time: now(),
          payments: [{ payment_type_id: depType.id, amount: 50000, reference: num }] })]);
      const cot0 = await stock(cot);
      seq++;
      const rf = await push([op('refund.create', { id: id(), refund_of: rc, store_id: store, device_id: dev, number: 'DP-R' + seq, device_seq: seq, device_time: now(), reason: 'faulty',
        lines: [{ ticket_line_id: lid, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 50000 }] })]);
      check('T8 a collection is refunded in the tender the cashier picks, the cot back on the shelf', tag(rf[0]) === 'applied' && (await stock(cot)) === cot0 + 1000, tag(rf[0]) + ' ' + JSON.stringify(rf[0]));
      check('T8 the deposit stays collected', (await dep(did)).status === 'collected');
      const corr = await push([op('payment.correct', { id: id(), receipt_id: rc, from_payment_type_id: depType.id, to_payment_type_id: cash })]);
      check('T8 a payment is not corrected from the Deposit type', tag(corr[0]) === 'rejected:bad-payment', tag(corr[0]));
    }

    // ---- T9 a number that clashes ----
    {
      const [, , o] = createOp([{ item_id: cot, name: 'Cot', unit_price: 50000 }], { payment_type_id: cash, amount: 1000 });
      const o2 = op('deposit.create', { ...o.payload, id: id(), device_id: dev2, lines: o.payload.lines.map((l) => ({ ...l, id: id() })), payment: { ...o.payload.payment, id: id() } });
      await push([o]);
      const out = await push([o2]);
      const d = await dep(o2.payload.id);
      check('T9 a second tablet with the same number: kept with a suffix, and said', tag(out[0]) === 'applied' && d.number === o.payload.number + '-2' && d.flags.some((f) => f.why === 'number-collision'), d?.number);
    }

    // ---- T10 the pull ----
    {
      const r = await pull();
      const rows = r.changes.deposits || [];
      const a = rows.find((x) => x.id === A);
      check('T10 the pull sends the shop\'s deposits, each with its lines and payments', rows.length > 0 && a && a.lines.length === 3 && a.payments.length === 2, `${rows.length} ${a?.lines?.length} ${a?.payments?.length}`);
      check('T10 and the deposit type', (r.changes.payment_types || []).some((p) => p.kind === 'deposit'));
      check('T10 and the drawer rows say which deposit', (r.changes.cash_movements || []).some((m) => m.deposit_id === A));
    }

    // ---- T11 settings ----
    {
      const ok = await push([op('settings.save', { deposits: 'on', depositCancel: 'keep', depositDays: 45, depositOverdue: 'cancel', depositGrace: 3, depositCustomer: 'optional' })]);
      const s = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('T11 the six settings are saved from a till', tag(ok[0]) === 'applied' && s.depositCancel === 'keep' && s.depositDays === 45 && s.depositGrace === 3 && s.depositCustomer === 'optional' && s.depositOverdue === 'cancel' && s.deposits === 'on');
      for (const bad of [{ depositDays: 0 }, { depositDays: 400 }, { depositCancel: 'x' }, { depositGrace: -1 }, { depositCustomer: 'maybe' }, { deposits: 'yes' }]) {
        const out = await push([op('settings.save', bad)]);
        check('T11 refused: ' + JSON.stringify(bad), tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
      }
      await setSettings({ depositOverdue: 'show' });
    }

    // ---- T12 a till is not bare; clearing a test client ----
    {
      check('T12 a till that took a deposit is not bare', (await one(`select platform.till_is_bare($1,$2) as b`, [tid, dev])).b === false);
      await c.query('SAVEPOINT clear');
      let said = null;
      try { await c.query(`select platform.clear_test_activity($1,$2)`, [admin, tid]); } catch (e) { said = e.message; }
      const left = said ? null : (await one(`select (select count(*) from deposits where tenant_id = $1)::int as d, (select count(*) from credit_notes where tenant_id = $1)::int as n,
        (select count(*) from stock_movements where tenant_id = $1 and reason in ('deposit','deposit_release'))::int as m`, [tid]));
      const pramLevel = said ? null : await stock(pram);
      await c.query('ROLLBACK TO SAVEPOINT clear');
      check('T12 Clear test activity clears deposits, their notes and their stock', said === null && left.d === 0 && left.n === 0 && left.m === 0, said || JSON.stringify(left));
      check('T12 and the shelf is back to what was received', pramLevel === 20000, pramLevel);
    }

    // ---- T13 a stock count, and a deposit that reaches the server late (0119) ----
    // A count sets a line to what was counted plus what moved after the line
    // was counted. A deposit is set against the tablet's own moment, as a sale
    // is, not against when it reached the server. The whole test is one
    // transaction, so everything it writes is written "now" (T): the moments
    // the tablet says are set around T.
    {
      const T = (await one(`select now() as t`)).t.getTime();
      const at = (ms) => new Date(T + ms).toISOString();
      const counted = (it, qty, ms) => ({ item_id: it, variant_id: '', counted: qty, counted_at: at(ms), left_out: false });
      const countOp = (lines, extra = {}) => op('count.complete', { id: id(), store_id: store, scope_kind: 'all', scope_id: '', scope_text: '',
        started_at: lines[0].counted_at, clock_ahead_ms: 0, uncounted: 'leave', lines, ...extra });
      const bib = await item('Bib', 2000), bottle = await item('Bottle', 3000), cap = await item('Cap', 4000), sock = await item('Sock', 1000);
      // their deliveries came in long before any of it
      await c.query(`update stock_movements set created_at = now() - interval '2 hours' where tenant_id = $1 and item_id = any($2::uuid[]) and reason = 'receive'`,
        [tid, [bib, bottle, cap, sock]]);

      // taken two minutes before the shelf was counted, sent after it: the shelf showed it gone already
      let [, , o] = createOp([{ item_id: bib, name: 'Bib', unit_price: 2000 }], null, { device_time: at(-120000) });
      await push([o]);
      check('T13 a deposit taken before a line was counted is not what moved after it',
        (await one(`select stock_moved_since($1,$2,$3,null,$4) as m`, [tid, store, bib, at(-60000)])).m === 0
        && (await one(`select stock_moved_since_at($1,$2,$3,null,$4,$4) as m`, [tid, store, bib, at(-60000)])).m === 0);
      let out = await push([countOp([counted(bib, 19000, -60000)])]);
      check('T13 a count completed after it: the shelf is what was counted, not one less', tag(out[0]) === 'applied' && (await stock(bib)) === 19000, tag(out[0]) + ' ' + (await stock(bib)));

      // taken a minute after the shelf was counted: still on it when it was counted, so it is taken off
      [, , o] = createOp([{ item_id: bottle, name: 'Bottle', unit_price: 3000 }], null, { device_time: at(-60000) });
      await push([o]);
      out = await push([countOp([counted(bottle, 20000, -120000)])]);
      check('T13 one taken after the line was counted is taken off what was counted', tag(out[0]) === 'applied' && (await stock(bottle)) === 19000, tag(out[0]) + ' ' + (await stock(bottle)));

      // taken before the count, cancelled on the tablet after the line was counted: the cap came back after it
      let did;
      [did, , o] = createOp([{ item_id: cap, name: 'Cap', unit_price: 4000 }], null, { device_time: at(-300000) });
      await push([o]);
      out = await push([op('deposit.cancel', { deposit_id: did, device_id: dev, device_time: at(120000), reason: 'Changed mind', outcome: 'keep' })]);
      const capCancel = tag(out[0]);
      out = await push([countOp([counted(cap, 19000, 60000)])]);
      check('T13 a deposit cancelled on the tablet after the line was counted: what came back is added', capCancel === 'applied' && tag(out[0]) === 'applied' && (await stock(cap)) === 20000, capCancel + ' ' + tag(out[0]) + ' ' + (await stock(cap)));

      // cancelled by the server past its date: that moment is the server's own. The tablet's clock is
      // ten minutes fast; its line "counted at T + 8 minutes" was in truth counted two minutes before T.
      [did, , o] = createOp([{ item_id: sock, name: 'Sock', unit_price: 1000 }], null, { device_time: at(-1800000), collect_by: '2026-01-01' });
      await push([o]);
      await setSettings({ depositOverdue: 'cancel', depositGrace: 0, depositCancel: 'keep' });
      await one(`select deposits_expire($1) as n`, [tid]);
      await setSettings({ depositOverdue: 'show' });
      const sockDep = await dep(did);
      out = await push([countOp([counted(sock, 19000, 480000)], { clock_ahead_ms: 600000 })]);
      check('T13 a deposit the server cancelled after the line was truly counted: what came back is added', sockDep.status === 'cancelled' && tag(out[0]) === 'applied' && (await stock(sock)) === 20000,
        sockDep.status + ' ' + tag(out[0]) + ' ' + (await stock(sock)));
    }

    // ---- T14 goods collected from a deposit are sold: in cost and profit, and not slow (0120) ----
    // A collection moves no stock (it left with the deposit), so what the goods cost is the deposit's
    // movement, and when they sold is the collection's receipt, as the tablet's own lists read it.
    {
      const rep = lib('stock-reports');
      const report = lib('report', { '@/lib/action': { UUID: /^[0-9a-f-]{36}$/i }, '@/lib/settings': { withDefaults: (x) => x }, '@/lib/day': lib('day') });
      const tz = (await one(`select timezone from stores where id = $1`, [store])).timezone;
      const day = report.today(tz);
      const rattle = await item('Rattle', 5000), blanket = await item('Blanket', 8000);
      // both in the shop for forty days, the blanket on a promotion for twenty, and neither sold
      await c.query(`update items set created_at = now() - interval '40 days' where id = any($1::uuid[])`, [[rattle, blanket]]);
      await c.query(`update stock_movements set created_at = now() - interval '40 days' where tenant_id = $1 and item_id = any($2::uuid[]) and reason = 'receive'`, [tid, [rattle, blanket]]);
      await c.query(`select promotion_apply($1,$2,$3,null,6000,null)`, [tid, owner, blanket]);
      await c.query(`update promotions set applied_at = now() - interval '20 days' where tenant_id = $1 and item_id = $2`, [tid, blanket]);
      const quiet = async () => (await asApp(() => c.query(rep.UNSOLD_SQL, [tid, store, 30]))).rows.map((x) => x.name);
      const slow = async () => (await c.query(`select name from slow_movers($1, 30)`, [tid])).rows.map((x) => x.name);
      const stale = async () => (await c.query(`select name from stale_promotions($1, 14)`, [tid])).rows.map((x) => x.name);
      check('T14 before anything is taken: both are quiet, the rattle slow and the blanket\'s promotion still',
        (await quiet()).includes('Rattle') && (await slow()).includes('Rattle') && (await stale()).includes('Blanket'), `${await quiet()} | ${await slow()} | ${await stale()}`);

      // a rattle and a blanket taken on a deposit, the shelf's average a rupee then; dearer stock comes in after
      const [did, num, o] = createOp([{ item_id: rattle, name: 'Rattle', unit_price: 5000 }, { item_id: blanket, name: 'Blanket', unit_price: 6000 }], null);
      await push([o]);
      await c.query(`select stock_move($1,$2,$3,null,10000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, rattle, id(), owner]);
      const L = await lineIds(did);
      const r = await collect(num, [
        { item_id: rattle, name_snapshot: 'Rattle', unit_price: 5000, deposit_line_id: L[0].id },
        { item_id: blanket, name_snapshot: 'Blanket', unit_price: 6000, deposit_line_id: L[1].id },
      ], [{ payment_type_id: cash, amount: 11000 }]);
      const rows = await asApp(() => c.query(rep.itemSalesSql(report.RECEIPTS, 'item', true), [tid, day, day, null, null, 'all']));
      const rat = rows.rows.find((x) => x.name === 'Rattle');
      check('T14 collected: the rattle sold costs what it cost when it left the shelf, and its sale is in the profit',
        tags(r.out) === 'applied applied applied' && rat && Number(rat.cost) === 1000 && Number(rat.costed) === Number(rat.ex_vat) && Number(rat.costed) > 0, JSON.stringify(rat));
      check('T14 the rattle is not quiet any more, nor slow', !(await quiet()).includes('Rattle') && !(await slow()).includes('Rattle'), `${await quiet()} | ${await slow()}`);
      check('T14 and the blanket\'s promotion sold', !(await stale()).includes('Blanket'), String(await stale()));
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
