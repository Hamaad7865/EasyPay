// purchase-orders.test.cjs — the purchase orders migration: a shop orders
// from a supplier and receives what arrives.
//   - an order has a number, a supplier and lines; it is a draft until sent
//   - a delivery is written once, moves stock and its average cost through
//     the engine, and can never be changed
//   - an order arrives in one delivery or several; more than was ordered and
//     products that were not ordered are accepted
//   - a delivery nobody ordered is received the same way
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/purchase-orders.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-po@example.com')`, [admin]);
    const tenant = async (name, code) => (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,'standard') as r`, [admin, name, code, id()])).r;
    const made = await tenant('Orders Test', 'PO1');
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const other = await tenant('Orders Other', 'PO2');
    const sup = (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id;
    const sup2 = (await one(`insert into suppliers (tenant_id, name) values ($1,'Candle works') returning id`, [tid])).id;
    const theirSup = (await one(`insert into suppliers (tenant_id, name) values ($1,'Theirs') returning id`, [other.tenant_id])).id;
    const item = async (name, o = {}) => (await one(
      `insert into items (tenant_id, name, price, cost, track_stock, supplier_id) values ($1,$2,10000,$3,$4,$5) returning id`,
      [tid, name, o.cost ?? null, o.track ?? true, o.sup ?? sup])).id;
    const variant = async (it, name, cost, gone) => (await one(
      `insert into item_variants (tenant_id, item_id, name, price, cost, deleted_at) values ($1,$2,$3,10000,$4,$5) returning id`, [tid, it, name, cost, gone ? new Date() : null])).id;
    const shirt = await item('Shirt', { cost: 6200 });
    const tote = await item('Tote bag', { cost: 1800 });
    const candle = await item('Candle', { cost: 2100, sup: sup2 });
    const tee = await item('Tee', { cost: 2000 });
    const teeM = await variant(tee, 'M', 2000), teeL = await variant(tee, 'L', 2000), teeS = await variant(tee, 'S', 2000, true);
    const fee = await item('Bag fee', { track: false });
    const line = (it, va, qty, cost) => ({ item_id: it, variant_id: va, qty, unit_cost: cost });

    const saveSql = `select po_save($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as r`;
    const save = async (order, supplier, lines, o = {}) => (await one(saveSql, [tid, emp, order, store, supplier, o.expected ?? null, o.note ?? null, JSON.stringify(lines)])).r;
    const saveFails = (order, supplier, lines) => failsWith(saveSql, [tid, emp, order, store, supplier, null, null, JSON.stringify(lines)]);
    const order = async (o) => one(`select number, status, store_id, supplier_id, expected_on::text as expected, note, created_by, sent_at is not null as sent from purchase_orders where id = $1`, [o]);
    const lines = async (o) => (await c.query(
      `select i.name || coalesce(' ' || v.name, '') as what, l.qty, l.unit_cost::int as cost,
              coalesce((select sum(d.qty) from delivery_lines d where d.order_line_id = l.id), 0)::int as got
         from purchase_order_lines l join items i on i.id = l.item_id left join item_variants v on v.id = l.variant_id
        where l.order_id = $1 order by 1`, [o])).rows.map((r) => `${r.what}:${r.qty}@${r.cost}/${r.got}`).join(' ');
    const recvSql = `select delivery_receive($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as r`;
    const receive = async (o, ls, opt = {}) => (await one(recvSql, [tid, emp, opt.id ?? id(), store, o, opt.supplier ?? null, opt.day ?? '2026-10-07', opt.invoice ?? null, opt.note ?? null, JSON.stringify(ls)])).r;
    const recvFails = (o, ls) => failsWith(recvSql, [tid, emp, id(), store, o, null, '2026-10-07', null, null, JSON.stringify(ls)]);
    const level = async (it, va) => one(`select qty, avg_cost::float8 as avg from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, store, it, va ?? null]);

    // ---- orders ----
    const a = await save(null, sup, [line(shirt, null, 12000, 6200), line(tote, null, 40000, 1800)], { expected: '2026-10-07', note: 'before the weekend' });
    let o = await order(a.id);
    check('O1 a new order has the first number, and is a draft at its shop', a.number === 'PO-0001' && o.number === 'PO-0001' && o.status === 'draft' && o.store_id === store && !o.sent, JSON.stringify(o));
    check('O1 with its supplier, expected day, note and who made it', o.supplier_id === sup && o.expected === '2026-10-07' && o.note === 'before the weekend' && o.created_by === emp, JSON.stringify(o));
    const b = await save(null, sup2, []);
    check('O1 the next order takes the next number', b.number === 'PO-0002', b.number);
    await c.query(`select set_config('app.tenant_id', $1, true)`, [other.tenant_id]);
    const theirs = (await one(saveSql, [other.tenant_id, other.employee_id, null, other.store_id, theirSup, null, null, '[]'])).r;
    await c.query(`select set_config('app.tenant_id', '', true)`);
    check('O1 another tenant numbers on its own', theirs.number === 'PO-0001', theirs.number);
    let e = await saveFails(null, theirSup, []);
    check('O1 a supplier that is not the tenant\'s is refused', said(e) === 'unknown-supplier', said(e));

    check('O2 an order keeps its lines', (await lines(a.id)) === 'Shirt:12000@6200/0 Tote bag:40000@1800/0', await lines(a.id));
    const bad = [];
    for (const [ls, want] of [[[line(tee, null, 1000, 2000)], 'pick-variant'], [[line(tee, teeS, 1000, 2000)], 'unknown-line'], [[line(shirt, teeM, 1000, 2000)], 'unknown-line'],
      [[line(fee, null, 1000, 100)], 'not-counted'], [[line(id(), null, 1000, 100)], 'unknown-item'],
      [[line(shirt, null, 0, 6200)], 'bad-line'], [[line(shirt, null, -1000, 6200)], 'bad-line'], [[line(shirt, null, 1000, -1)], 'bad-line'], [[line(shirt, null, 1000, null)], 'bad-line']]) {
      bad.push(said(await saveFails(null, sup, ls)) === want ? 'ok' : want + '?' + said(await saveFails(null, sup, ls)));
    }
    check('O2 a line is a counted product or variant, with a quantity above zero and a cost of zero or more', bad.every((x) => x === 'ok'), bad.join(' '));
    const m = await save(null, sup, [line(tee, teeM, 6000, 2000), line(tee, teeM, 2000, 2400), line(tee, teeL, 4000, 2000)]);
    check('O2 two lines for one product become one: quantities added, cost averaged by quantity', (await lines(m.id)) === 'Tee L:4000@2000/0 Tee M:8000@2100/0', await lines(m.id));

    const again = await save(a.id, sup, [line(shirt, null, 12000, 6200), line(tote, null, 40000, 1800), line(tee, teeM, 6000, 2000)], { expected: '2026-10-09', note: null });
    o = await order(a.id);
    check('O3 saving a draft again replaces its header and its lines, and keeps its number', again.number === 'PO-0001' && o.expected === '2026-10-09' && o.note === null
      && (await lines(a.id)) === 'Shirt:12000@6200/0 Tee M:6000@2000/0 Tote bag:40000@1800/0', JSON.stringify(o) + ' ' + (await lines(a.id)));

    e = await failsWith(`select po_send($1,$2)`, [tid, b.id]);
    check('O4 an order with no lines is not sent', said(e) === 'no-lines', said(e));
    await c.query(`select po_send($1,$2)`, [tid, a.id]);
    o = await order(a.id);
    check('O4 a draft is sent', o.status === 'sent' && o.sent, JSON.stringify(o));
    e = await failsWith(`select po_send($1,$2)`, [tid, a.id]);
    check('O4 and only once', said(e) === 'not-draft', said(e));
    e = await saveFails(a.id, sup, [line(shirt, null, 1000, 6200)]);
    check('O3 an order that was sent is no longer edited', said(e) === 'not-draft' && (await lines(a.id)).startsWith('Shirt:12000@6200'), said(e));
    const direct = [
      said(await failsWith(`update purchase_order_lines set qty = 1000 where order_id = $1`, [a.id])),
      said(await failsWith(`delete from purchase_order_lines where order_id = $1`, [a.id])),
      said(await failsWith(`insert into purchase_order_lines (tenant_id, order_id, item_id, qty, unit_cost) values ($1,$2,$3,1000,100)`, [tid, a.id, candle])),
    ];
    check('O3 and no statement can change, remove or add its lines', direct.every((x) => x === 'order-not-draft'), direct.join());

    // O5 what is low
    await c.query(`select stock_set_reorder($1,$2,$3,$4,$5)`, [tid, store, shirt, 6000, 12000]); // on hand 0, reorder at 6: low, order 12
    await c.query(`select stock_set_reorder($1,$2,$3,$4,$5)`, [tid, store, tote, 10000, null]); // low, no order quantity: back to its level
    await c.query(`select stock_set_reorder($1,$2,$3,$4,$5)`, [tid, store, tee, 2000, 6000]); // both variants low
    await c.query(`select stock_set_reorder($1,$2,$3,$4,$5)`, [tid, store, candle, 5000, 24000]); // another supplier's
    await c.query(`select stock_move($1,$2,$3,null,$4,'opening',null,null,null,$5,null)`, [tid, store, tote, 4000, emp]); // 4 on hand, level 10
    await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',null,null,null,$6,null)`, [tid, store, tee, teeL, 9000, emp]); // L is above its level
    const low = await save(null, sup, [line(shirt, null, 5000, 6000)]);
    const added = (await one(`select po_fill_low($1,$2) as n`, [tid, low.id])).n;
    check('O5 what is low is added with its order quantity, at its cost; what is on the order, above its level or another supplier\'s is left',
      added === 2 && (await lines(low.id)) === 'Shirt:5000@6000/0 Tee M:6000@2000/0 Tote bag:6000@1800/0', added + ' ' + (await lines(low.id)));
    check('O5 asking again adds nothing', (await one(`select po_fill_low($1,$2) as n`, [tid, low.id])).n === 0);
    e = await failsWith(`select po_fill_low($1,$2)`, [tid, a.id]);
    check('O5 only a draft is filled', said(e) === 'not-draft', said(e));

    // ---- deliveries ----
    const d1id = id();
    const d1 = await receive(a.id, [line(shirt, null, 12000, 6200), line(tote, null, 30000, 1800)], { id: d1id, invoice: 'INV-20418', note: 'one box was open' });
    const dl = await one(`select number, order_id, store_id, supplier_id, arrived_on::text as day, invoice_no, note, received_by from deliveries where id = $1`, [d1.id]);
    check('D1 a delivery has the first number, its order, day, invoice number and note', d1.number === 'D-0001' && d1.id === d1id && dl.order_id === a.id && dl.store_id === store && dl.supplier_id === sup
      && dl.day === '2026-10-07' && dl.invoice_no === 'INV-20418' && dl.note === 'one box was open' && dl.received_by === emp, JSON.stringify(dl));
    let ls = await level(shirt), lt = await level(tote);
    check('D1 what arrived is in stock, at its cost', ls.qty === 12000 && near(ls.avg, 6200) && lt.qty === 34000 && near(lt.avg, 1800) && d1.units === 42000, JSON.stringify([ls, lt, d1.units]));
    const mv = await one(`select reason, qty, unit_cost::float8 as cost, ref_type, ref_id, employee_id from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'receive'`, [tid, shirt]);
    check('D1 through the engine, with the delivery as its document', mv.qty === 12000 && near(mv.cost, 6200) && mv.ref_type === 'delivery' && mv.ref_id === d1.id && mv.employee_id === emp, JSON.stringify(mv));
    check('D1 the order is part received while something is still to come', d1.order_status === 'part' && (await order(a.id)).status === 'part'
      && (await lines(a.id)) === 'Shirt:12000@6200/12000 Tee M:6000@2000/0 Tote bag:40000@1800/30000', await lines(a.id));

    // D5 the same delivery again
    const twice = await receive(a.id, [line(shirt, null, 12000, 6200), line(tote, null, 30000, 1800)], { id: d1id });
    check('D5 the same delivery sent twice is written once', twice.already === true && twice.number === 'D-0001' && (await level(shirt)).qty === 12000
      && (await one(`select count(*)::int as n from deliveries where tenant_id = $1`, [tid])).n === 1, JSON.stringify(twice));

    // D4 a corrected cost, D7 two lines for one product, D10 a product that was not ordered
    const d2 = await receive(a.id, [line(tee, teeM, 2000, 2000), line(tee, teeM, 2000, 2400), line(candle, null, 6000, 2300)]);
    const lm = await level(tee, teeM);
    check('D7 two lines for one product in a delivery are added together', lm.qty === 4000 && near(lm.avg, 2200) && d2.units === 10000, JSON.stringify(lm));
    check('D4 the cost on the delivery becomes the cost of what was received', (await one(`select cost::int as c from item_variants where id = $1`, [teeM])).c === 2200
      && (await one(`select cost::int as c from items where id = $1`, [candle])).c === 2300 && (await one(`select cost::int as c from item_variants where id = $1`, [teeL])).c === 2000);
    const extra = await one(`select order_line_id, qty from delivery_lines where delivery_id = $1 and item_id = $2`, [d2.id, candle]);
    check('D10 a product that was not ordered is received as a line of its own', extra.order_line_id === null && extra.qty === 6000 && (await level(candle)).qty === 6000 && d2.order_status === 'part', JSON.stringify(extra));

    // D2 the rest arrives, D3 with more than was ordered
    const d3 = await receive(a.id, [line(tote, null, 10000, 2000), line(tee, teeM, 5000, 2200)]);
    lt = await level(tote);
    check('D2 a later delivery adds to the first, and moves the average', lt.qty === 44000 && near(lt.avg, (34000 * 1800 + 10000 * 2000) / 44000) && d3.number === 'D-0003', JSON.stringify(lt));
    check('D3 more than was ordered is accepted, and the order is received', d3.order_status === 'received' && (await order(a.id)).status === 'received'
      && (await lines(a.id)) === 'Shirt:12000@6200/12000 Tee M:6000@2000/9000 Tote bag:40000@1800/40000', await lines(a.id));

    // D6 what cannot be received
    e = await recvFails(m.id, [line(tee, teeL, 1000, 2000)]);
    check('D6 a draft is not received', said(e) === 'not-open', said(e));
    e = await recvFails(a.id, [line(shirt, null, 1000, 6200)]);
    check('D6 nor an order that has arrived in full', said(e) === 'not-open', said(e));
    await c.query(`select po_send($1,$2)`, [tid, m.id]);
    const empty = [said(await recvFails(m.id, [])), said(await recvFails(m.id, [line(tee, teeL, 0, 2000)]))];
    check('D6 a delivery with nothing in it is refused', empty.every((x) => x === 'nothing-received'), empty.join());

    // D8 a delivery is a record
    const frozen = [
      said(await failsWith(`update deliveries set note = 'x' where id = $1`, [d1.id])),
      said(await failsWith(`delete from deliveries where id = $1`, [d1.id])),
      said(await failsWith(`update delivery_lines set qty = 1 where delivery_id = $1`, [d1.id])),
      said(await failsWith(`delete from delivery_lines where delivery_id = $1`, [d1.id])),
    ];
    check('D8 a delivery and its lines cannot be changed or deleted', frozen.every((x) => /insert-only/.test(x)), frozen.join(' | '));
    const rights = (await c.query(`select t, has_table_privilege('app_user', t, 'update') as upd, has_table_privilege('app_user', t, 'delete') as del, has_table_privilege('app_user', t, 'insert') as ins
                                     from unnest(array['deliveries','delivery_lines']) as t`)).rows;
    check('D8 and the tenant role has no right to', rights.every((r) => r.ins && !r.upd && !r.del), JSON.stringify(rights));

    // D9 a delivery nobody ordered
    const d4 = await receive(null, [line(candle, null, 12000, 2100)], { supplier: sup2, invoice: 'CW-7' });
    const free = await one(`select order_id, supplier_id, invoice_no from deliveries where id = $1`, [d4.id]);
    check('D9 a delivery without an order raises stock the same way', free.order_id === null && free.supplier_id === sup2 && d4.order_status === null && (await level(candle)).qty === 18000, JSON.stringify(free));
    const d5 = await receive(null, [line(shirt, null, 1000, 6200)]);
    check('D9 and its supplier can be left out', (await one(`select supplier_id from deliveries where id = $1`, [d5.id])).supplier_id === null);

    // ---- cancel and close ----
    await c.query(`select po_cancel($1,$2)`, [tid, b.id]);
    check('C1 a draft is cancelled', (await order(b.id)).status === 'cancelled');
    const s2 = await save(null, sup, [line(shirt, null, 2000, 6200), line(tote, null, 2000, 1800)]);
    await c.query(`select po_send($1,$2)`, [tid, s2.id]);
    e = await failsWith(`select po_close($1,$2)`, [tid, s2.id]);
    check('C2 an order nothing has arrived for is not closed (it is cancelled)', said(e) === 'not-part', said(e));
    await receive(s2.id, [line(shirt, null, 2000, 6200)]);
    e = await failsWith(`select po_cancel($1,$2)`, [tid, s2.id]);
    check('C1 an order something has arrived for is not cancelled', said(e) === 'already-received', said(e));
    await c.query(`select po_close($1,$2)`, [tid, s2.id]);
    check('C2 a part-received order is closed: the rest is no longer expected', (await order(s2.id)).status === 'closed');
    e = await recvFails(s2.id, [line(tote, null, 2000, 1800)]);
    check('D6 a closed order is not received', said(e) === 'not-open', said(e));
    const s3 = await save(null, sup, [line(shirt, null, 1000, 6200)]);
    await c.query(`select po_send($1,$2)`, [tid, s3.id]);
    await c.query(`select po_cancel($1,$2)`, [tid, s3.id]);
    e = await recvFails(s3.id, [line(shirt, null, 1000, 6200)]);
    check('C1 a sent order is cancelled while nothing has arrived, and is then not received', (await order(s3.id)).status === 'cancelled' && said(e) === 'not-open', said(e));

    // T1 the tenant role
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const mine = await save(null, sup, [line(shirt, null, 3000, 6200)]);
    await c.query(`select po_send($1,$2)`, [tid, mine.id]);
    const got = await receive(mine.id, [line(shirt, null, 3000, 6200)]);
    check('T1 the tenant role can order and receive', got.order_status === 'received' && /^D-\d{4}$/.test(got.number), JSON.stringify(got));
    const tried = said(await failsWith(`update deliveries set note = 'x' where id = $1`, [got.id]));
    check('T1 and cannot touch a delivery', /permission denied/.test(tried), tried);
    await c.query(`select set_config('app.tenant_id', $1, true)`, [other.tenant_id]);
    const seen = await one(`select (select count(*) from purchase_orders)::int as o, (select count(*) from deliveries)::int as d, (select count(*) from delivery_lines)::int as l`);
    check('T1 another tenant sees its own orders only, and no delivery of ours', seen.o === 1 && seen.d === 0 && seen.l === 0, JSON.stringify(seen));
    await c.query('SET LOCAL ROLE none');

    // X1 delete all transactions
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    await c.query(`select purge_transactions($1,$2)`, [tid, emp]);
    const left = await one(`select (select count(*) from purchase_orders where tenant_id = $1)::int as o, (select count(*) from purchase_order_lines where tenant_id = $1)::int as ol,
                                   (select count(*) from deliveries where tenant_id = $1)::int as d, (select count(*) from delivery_lines where tenant_id = $1)::int as dl`, [tid]);
    check('X1 deleting all transactions removes the orders and the deliveries', left.o === 0 && left.ol === 0 && left.d === 0 && left.dl === 0, JSON.stringify(left));
    const fresh = await save(null, sup, []);
    check('X1 and the numbers start again', fresh.number === 'PO-0001', fresh.number);
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PURCHASE ORDERS PASS' : `PURCHASE ORDERS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
