// till-stock.test.cjs — the stock tools a shop's till has (migration 0092).
// The owner sells an offline edition whose tablet does the shop's stock work
// itself; built first, these changes land on tills that are linked to the
// server, and each waits for its answer as a product saved from a till does.
//   - supplier.save / supplier.remove: what the back office's page does.
//   - po.save, po.send, po.cancel, po.close: an order, under the id the tablet
//     made. delivery.receive: with an order or without. count.complete: a
//     count the tablet kept, sent whole.
//   - Every one is refused for someone who may not, done with the word of
//     someone who may, and written once however often it is sent: a till that
//     lost an answer sends the same thing again under a new change id.
//   - A count is exactly the lines the tablet sends. The server adds none, so
//     "set the uncounted to nothing" cannot zero a product nobody saw.
//   - A line's moment is the tablet's clock: right for sales, which a till
//     stamps itself, and set right by clock_ahead_ms for what the server
//     stamps.
//   - A shop's till is sent suppliers, orders and deliveries with their lines,
//     finished counts and thirty days of movements; a restaurant's is not.
// The example payloads are the files in fixtures/till-stock, which the
// tablet's own tests compare with what it builds: what is sent here is what
// the tablet sends. Their stand-in ids are swapped for real ones.
// Two connections in one group, so this suite commits and cleans up after
// itself. KEEP_PULL=<file> writes the shop's pull there.
// Usage: node db/tests/till-stock.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const id = () => crypto.randomUUID();
const op = (type, payload, employee) => ({ op_id: id(), type, payload, ...(employee ? { employee_id: employee } : {}) });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = path.join(__dirname, 'fixtures', 'till-stock');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
// every stand-in in a payload swapped for what it stands for
const swap = (v, map) => (Array.isArray(v) ? v.map((x) => swap(x, map))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, map)]))
    : typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v);
const iso = (d) => new Date(d).toISOString();

(async () => {
  const cs = devguard.envMap().DATABASE_URL_UNPOOLED;
  const c = new Client({ connectionString: cs, ssl: { require: true } });
  const a = new Client({ connectionString: cs, ssl: { require: true } });
  const b = new Client({ connectionString: cs, ssl: { require: true } });
  await c.connect(); await a.connect(); await b.connect();
  const tid = id(), resto = id(), other = id();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const all = async (sql, args) => (await c.query(sql, args)).rows;
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','TS-Probe','standard'), ('${resto}','${resto}','TS-Resto','standard'), ('${other}','${other}','TS-Other','standard')`);
  try {
    const mkStore = async (t, name, code) => (await q1(`insert into stores (tenant_id, name, code) values ($1,$2,$3) returning id`, [t, name, code])).id;
    const store = await mkStore(tid, 'Main', 'TSS1');
    const second = await mkStore(tid, 'Annex', 'TSS2');
    const restoStore = await mkStore(resto, 'Main', 'TSS3');
    const theirStore = await mkStore(other, 'Main', 'TSS4');
    const role = async (t, name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [t, name, JSON.stringify(perms)])).id;
    const emp = async (t, name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [t, name, r])).id;
    const owner = await emp(tid, 'Owner', await role(tid, 'Owner', ['*'])); // the till's login
    const stock = await emp(tid, 'Stock', await role(tid, 'Stock', ['stock.receive', 'stock.count', 'stock.view', 'suppliers.edit']));
    const cashier = await emp(tid, 'Cashier', await role(tid, 'Cashier', ['sale.create', 'payment.take']));
    const restoOwner = await emp(resto, 'Owner', await role(resto, 'Owner', ['*']));
    const theirOwner = await emp(other, 'Owner', await role(other, 'Owner', ['*']));
    for (const t of [tid, resto, other]) await c.query(`select ensure_pos_basics($1)`, [t]);
    for (const t of [tid, other]) {
      await c.query(`update tenants set business_type = 'retail' where id = $1`, [t]);
      await c.query(`update pos_settings set data = data || '{"businessType":"retail"}'::jsonb where tenant_id = $1`, [t]);
    }

    const drinks = (await q1(`insert into categories (tenant_id, name) values ($1,'Drinks') returning id`, [tid])).id;
    const item = async (name, o = {}) => (await q1(
      `insert into items (tenant_id, name, price, cost, track_stock, category_id, brand) values ($1,$2,10000,$3,$4,$5,$6) returning id`,
      [tid, name, o.cost ?? 1000, o.track ?? true, o.cat ?? null, o.brand ?? null])).id;
    const variant = async (it, name) => (await q1(`insert into item_variants (tenant_id, item_id, name, price, cost) values ($1,$2,$3,10000,17000) returning id`, [tid, it, name])).id;
    const plain = await item('Milk', { cost: 4500, cat: drinks });
    const sized = await item('Polo', { cost: 17000, brand: 'Maison' });
    const sizedS = await variant(sized, 'S'), sizedM = await variant(sized, 'M');
    const extra = await item('Candle', { cost: 2100 }); // counted in stock, and in no example payload
    const fee = await item('Bag fee', { track: false });
    const goner = await item('Old soap', { cost: 900 });
    const clocky = await item('Clock', { cost: 5000 });
    const put = (it, va, qty, cost) => c.query(`select stock_move($1,$2,$3,$4,$5,'receive',$6,'delivery',$7,$8,null)`, [tid, store, it, va, qty, cost, id(), owner]);
    await put(plain, null, 20000, 4500); await put(sized, sizedS, 5000, 17000); await put(sized, sizedM, 5000, 17000);
    await put(extra, null, 7000, 2100); await put(goner, null, 3000, 900);
    // a level with no movement behind it: the clock checks must see only the one correction they make
    await c.query(`insert into stock_levels (tenant_id, store_id, item_id, qty, avg_cost) values ($1,$2,$3,5000,5000)`, [tid, store, clocky]);
    const level = async (it, va = null, st = store) => (await q1(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va]) || {}).qty;
    const theirSup = (await q1(`insert into suppliers (tenant_id, name) values ($1,'Theirs') returning id`, [other])).id;

    const begin = async (x, t) => {
      await x.query('BEGIN');
      await x.query('SET LOCAL ROLE app_user');
      await x.query(`select set_config('app.tenant_id', $1, true)`, [t]);
    };
    async function asApp(fn, t = tid) {
      await begin(c, t);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const pushAs = (login, ops, t = tid) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r, t);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    // one change, under the owner's login (the till's): `who` is the person at the till, the owner when none
    const one = async (type, payload, who) => { const r = await pushAs(owner, [op(type, payload, who)]); return { said: tag(r[0]), data: r[0].data, op: r[0].op_id }; };
    const pull = (st = store, t = tid) => asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 1000) as r', [st])).rows[0].r, t);

    const supA = id(), ordA = id(), delA = id(), cntA = id();
    const ids = { 'store-1': store, 'supplier-1': supA, 'order-1': ordA, 'delivery-1': delA, 'count-1': cntA,
      'item-plain': plain, 'item-sized': sized, 'variant-s': sizedS, 'variant-m': sizedM };
    // an example payload with its stand-ins swapped, and anything in `over` put over it
    const fx = (name, over = {}, more = {}) => { const f = fixture(name); return [f.type, { ...swap(f.payload, { ...ids, ...more }), ...over }]; };
    const line = (it, va, qty, cost) => ({ item_id: it, variant_id: va || '', qty, unit_cost: cost });

    // ---------------------------------------------------------------- suppliers
    let r = await one(...fx('supplier-save'), cashier);
    check('S1 a cashier may not add a supplier', r.said === 'rejected:forbidden' && !(await q1(`select 1 as x from suppliers where id = $1`, [supA])), r.said);
    r = await one(...fx('supplier-save', { approved_by: stock }), cashier);
    let s = await q1(`select name, contact, phone, email, address, note from suppliers where id = $1 and tenant_id = $2`, [supA, tid]);
    check('S2 with the word of someone who may, it is added as typed, empty fields as none', r.said === 'applied' && s && s.name === 'Maurilait' && s.contact === 'Devi' && s.phone === '52501234'
      && s.email === null && s.address === 'Phoenix' && s.note === null, r.said + ' ' + JSON.stringify(s));
    check('S2 and who gave their word is written down', (await q1(`select count(*)::int as n from approvals where op_id = $1 and approved_by = $2`, [r.op, stock])).n === 1);
    r = await one(...fx('supplier-save', { phone: '59990000' }), stock);
    s = await all(`select phone from suppliers where tenant_id = $1 and lower(name) = 'maurilait' and deleted_at is null`, [tid]);
    check('S3 saved again under the same id it is one supplier, changed', r.said === 'applied' && s.length === 1 && s[0].phone === '59990000', r.said + ' ' + JSON.stringify(s));
    r = await one(...fx('supplier-save', { id: id(), name: 'MAURILAIT' }));
    check('S4 two suppliers cannot share a name, whatever its capitals', r.said === 'rejected:name-taken', r.said);
    r = await one(...fx('supplier-save', { id: id(), name: '   ' }));
    check('S4 a supplier needs a name', r.said === 'rejected:name-required', r.said);
    r = await one(...fx('supplier-save', { id: theirSup, name: 'Taken over' }));
    check('S5 another client\'s supplier is not reached by its id', r.said === 'rejected:conflict' && (await q1(`select name from suppliers where id = $1`, [theirSup])).name === 'Theirs', r.said);
    const supR = id();
    await one(...fx('supplier-save', { id: supR, name: 'Gone tomorrow' }));
    r = await one(...fx('supplier-remove', { id: supR }), cashier);
    check('S6 a cashier may not remove one', r.said === 'rejected:forbidden', r.said);
    r = await one(...fx('supplier-remove', { id: supR }), stock);
    check('S6 removed: marked, not deleted', r.said === 'applied' && (await q1(`select deleted_at is not null as gone from suppliers where id = $1`, [supR])).gone, r.said);
    r = await one(...fx('supplier-remove', { id: supR }));
    check('S6 removed again is done', r.said === 'applied', r.said);

    // ---------------------------------------------------------------- orders
    const order = async (o) => q1(`select number, status, supplier_id, expected_on::text as expected, note, created_by, sent_at from purchase_orders where id = $1 and tenant_id = $2`, [o, tid]);
    const lines = async (o) => (await all(
      `select i.name || coalesce(' ' || v.name, '') as what, l.qty, l.unit_cost::int as cost from purchase_order_lines l
         join items i on i.id = l.item_id left join item_variants v on v.id = l.variant_id where l.order_id = $1 order by 1`, [o])).map((x) => `${x.what}:${x.qty}@${x.cost}`).join(' ');
    r = await one(...fx('po-save'), cashier);
    check('O1 a cashier may not write an order', r.said === 'rejected:forbidden', r.said);
    r = await one(...fx('po-save'), stock);
    let o = await order(ordA);
    check('O1 a new order under the tablet\'s id is a draft with the first number', r.said === 'applied' && o && o.number === 'PO-0001' && o.status === 'draft' && o.supplier_id === supA
      && o.expected === '2026-10-20' && o.note === null && o.created_by === stock, r.said + ' ' + JSON.stringify(o));
    check('O1 with its two lines', (await lines(ordA)) === 'Milk:12000@4500 Polo S:6000@18000', await lines(ordA));
    r = await one(...fx('po-save'), stock);
    check('O2 sent again it is still one order with its number and its lines', r.said === 'applied' && (await order(ordA)).number === 'PO-0001'
      && (await q1(`select count(*)::int as n from purchase_orders where tenant_id = $1`, [tid])).n === 1 && (await lines(ordA)) === 'Milk:12000@4500 Polo S:6000@18000', r.said + ' ' + (await lines(ordA)));
    r = await one(...fx('po-save', { lines: [line(plain, null, 3000, 4500)] }), stock);
    check('O3 saved again with one line it has one line', r.said === 'applied' && (await lines(ordA)) === 'Milk:3000@4500', await lines(ordA));
    r = await one(...fx('po-save', { lines: [line(plain, null, 3000, 4500), line(plain, null, 1000, 4900)] }), stock);
    check('O3 two lines of one product are one: quantities added, cost averaged', r.said === 'applied' && (await lines(ordA)) === 'Milk:4000@4600', await lines(ordA));
    const bad = [];
    for (const [over, want] of [[{ supplier_id: id() }, 'unknown-supplier'], [{ lines: [line(fee, null, 1000, 100)] }, 'not-counted'],
      [{ lines: [line(sized, null, 1000, 100)] }, 'pick-variant'], [{ lines: [line(plain, sizedS, 1000, 100)] }, 'unknown-line'], [{ lines: [line(id(), null, 1000, 100)] }, 'unknown-item'],
      [{ store_id: id(), id: id() }, 'unknown-store'], [{ id: 'not-an-id' }, 'bad-payload']]) {
      const got = (await one(...fx('po-save', over), stock)).said;
      bad.push(got === 'rejected:' + want ? 'ok' : want + '?' + got);
    }
    check('O4 what an order may not hold is refused by name', bad.every((x) => x === 'ok'), bad.join(' '));
    const ordB = id();
    r = await one(...fx('po-save', { id: ordB, lines: [], approved_by: stock }), cashier);
    check('O5 with the word of someone who may, a cashier\'s order is written', r.said === 'applied' && (await order(ordB)).status === 'draft', r.said);
    r = await one(...fx('po-send', { id: ordB }), stock);
    check('O5 an order with no lines is not sent', r.said === 'rejected:no-lines', r.said);
    await one(...fx('po-save'), stock); // the example's two lines again
    r = await one(...fx('po-send'), cashier);
    check('O6 a cashier may not send one', r.said === 'rejected:forbidden', r.said);
    r = await one(...fx('po-send'), stock);
    o = await order(ordA);
    const sentAt = String(o.sent_at);
    check('O6 a draft is sent', r.said === 'applied' && o.status === 'sent' && o.sent_at !== null, r.said + ' ' + JSON.stringify(o));
    r = await one(...fx('po-send'), stock);
    check('O6 sent again is done, and it was sent when it was first sent', r.said === 'applied' && String((await order(ordA)).sent_at) === sentAt, r.said);
    r = await one(...fx('po-save'), stock);
    check('O7 a sent order is no longer a draft', r.said === 'rejected:not-draft', r.said);
    r = await one(...fx('po-close'), stock);
    check('O7 an order nothing has arrived for is not closed', r.said === 'rejected:not-part', r.said);
    const ordC = id();
    await one(...fx('po-save', { id: ordC, lines: [line(plain, null, 1000, 4500)] }), stock);
    await one(...fx('po-send', { id: ordC }), stock);
    r = await one(...fx('po-cancel', { id: ordC }), stock);
    check('O8 a sent order is cancelled while nothing has arrived', r.said === 'applied' && (await order(ordC)).status === 'cancelled', r.said);
    r = await one(...fx('po-cancel', { id: ordC }), stock);
    check('O8 cancelled again is done', r.said === 'applied', r.said);
    r = await one(...fx('po-send', { id: id() }), stock);
    check('O8 an order that is not there', r.said === 'rejected:unknown-order', r.said);

    // ---------------------------------------------------------------- deliveries
    const delivery = async (d) => q1(`select number, order_id, supplier_id, arrived_on::text as day, invoice_no, received_by from deliveries where id = $1 and tenant_id = $2`, [d, tid]);
    r = await one(...fx('delivery-receive'), cashier);
    check('D1 a cashier may not receive a delivery', r.said === 'rejected:forbidden' && (await level(plain)) === 20000, r.said);
    r = await one(...fx('delivery-receive'), stock);
    let d = await delivery(delA);
    check('D1 a delivery against a sent order: written, with the order\'s supplier', r.said === 'applied' && d && d.number === 'D-0001' && d.order_id === ordA && d.supplier_id === supA
      && d.day === '2026-10-10' && d.invoice_no === 'INV-88' && d.received_by === stock, r.said + ' ' + JSON.stringify(d));
    check('D1 the stock is up by what arrived and the product costs what was paid', (await level(plain)) === 30000 && Number((await q1(`select cost from items where id = $1`, [plain])).cost) === 4600, String(await level(plain)));
    check('D1 the order is part received', (await order(ordA)).status === 'part');
    r = await one(...fx('delivery-receive'), stock);
    check('D2 the same delivery sent again is answered as written, and moves nothing', r.said === 'applied' && r.data && r.data.already === true && (await level(plain)) === 30000
      && (await q1(`select count(*)::int as n from deliveries where tenant_id = $1`, [tid])).n === 1, r.said + ' ' + JSON.stringify(r.data));
    r = await one(...fx('delivery-receive', { id: id(), lines: [line(plain, null, 2000, 4600), line(sized, sizedS, 6000, 18000)] }), stock);
    check('D3 the rest arrives and the order is received', r.said === 'applied' && (await order(ordA)).status === 'received' && (await level(plain)) === 32000 && (await level(sized, sizedS)) === 11000, r.said);
    const ordE = id(), delE = id();
    await one(...fx('po-save', { id: ordE, lines: [line(plain, null, 5000, 4600)] }), stock);
    await one(...fx('po-send', { id: ordE }), stock);
    r = await one(...fx('delivery-receive', { id: delE, order_id: ordE, lines: [line(plain, null, 1000, 4600), line(extra, null, 1000, 2100)] }), stock);
    const dl = await all(`select item_id, order_line_id from delivery_lines where delivery_id = $1`, [delE]);
    check('D4 a product that was not ordered is received on the order\'s delivery, tied to no line of it', r.said === 'applied' && dl.length === 2
      && dl.find((x) => x.item_id === extra).order_line_id === null && dl.find((x) => x.item_id === plain).order_line_id !== null && (await level(extra)) === 8000, r.said + ' ' + JSON.stringify(dl));
    r = await one(...fx('po-close', { id: ordE }), cashier);
    check('D5 a cashier may not close an order', r.said === 'rejected:forbidden', r.said);
    r = await one(...fx('po-close', { id: ordE }), stock);
    check('D5 a part-received order is closed: the rest will not come', r.said === 'applied' && (await order(ordE)).status === 'closed', r.said);
    r = await one(...fx('po-close', { id: ordE }), stock);
    check('D5 closed again is done', r.said === 'applied', r.said);
    r = await one(...fx('po-cancel', { id: ordE }), stock);
    check('D5 an order something arrived for is not cancelled', r.said === 'rejected:already-received', r.said);
    const delF = id();
    r = await one(...fx('delivery-receive', { id: delF, order_id: '', supplier_id: '', lines: [line(extra, null, 1000, 2200)] }), stock);
    d = await delivery(delF);
    check('D6 a delivery nobody ordered, from nobody named', r.said === 'applied' && d && d.order_id === null && d.supplier_id === null && (await level(extra)) === 9000, r.said + ' ' + JSON.stringify(d));
    r = await one(...fx('delivery-receive', { id: id(), order_id: '', lines: [] }), stock);
    const r0 = await one(...fx('delivery-receive', { id: id(), order_id: '', lines: [line(extra, null, 0, 0)] }), stock);
    check('D7 a delivery of nothing is refused', r.said === 'rejected:nothing-received' && r0.said === 'rejected:nothing-received', r.said + ' ' + r0.said);
    r = await one(...fx('delivery-receive', { id: id(), order_id: ordB }), stock);
    check('D7 nothing is received against a draft', r.said === 'rejected:not-open', r.said);

    // ---------------------------------------------------------------- counts
    const count = async (k) => q1(`select number, status, title, scope_kind, uncounted, started_by, completed_by, clock_ahead_ms from stock_counts where id = $1 and tenant_id = $2`, [k, tid]);
    const countLines = async (k) => (await all(
      `select i.name || coalesce(' ' || v.name, '') as what, l.counted, l.left_out from stock_count_lines l
         join items i on i.id = l.item_id left join item_variants v on v.id = l.variant_id where l.count_id = $1 order by 1`, [k]))
      .map((x) => `${x.what}:${x.counted === null ? '-' : x.counted}${x.left_out ? ':out' : ''}`).join(' ');
    const serverNow = async () => new Date((await q1(`select now() as t`)).t).getTime();
    // a sale rung up on a till at a moment by the till's own clock
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const ticket = (await q1(`insert into tickets (tenant_id, store_id) values ($1,$2) returning id`, [tid, store])).id;
    let n = 0;
    const sale = async (it, qty, at) => {
      const rc = (await q1(`insert into receipts (tenant_id, store_id, device_id, ticket_id, number, total, device_time) values ($1,$2,$3,$4,$5,1000,$6) returning id`, [tid, store, dev, ticket, 'TS-' + (++n), iso(at)])).id;
      await c.query(`select stock_move($1,$2,$3,null,$4,'sale',null,'receipt',$5,$6,null)`, [tid, store, it, -qty, rc, owner]);
    };
    // the moment the shelf was counted: after everything above, by ten seconds
    let T = (await serverNow()) + 10000;
    const times = (t) => ({ '2026-10-10T08:00:00Z': iso(t - 300000), '2026-10-10T08:05:00Z': iso(t) });
    const before = { plain: await level(plain), s: await level(sized, sizedS), m: await level(sized, sizedM), extra: await level(extra) };
    await sale(plain, 1000, T - 60000); // rung up a minute before the shelf was counted: already off it
    await sale(plain, 2000, T + 60000); // rung up a minute after: still on it when it was counted
    r = await one(...fx('count-complete', {}, times(T)), cashier);
    check('C1 a cashier may not complete a count', r.said === 'rejected:forbidden', r.said);
    r = await one(...fx('count-complete', {}, times(T)), stock);
    let k = await count(cntA);
    check('C1 a count the tablet kept arrives whole and completed', r.said === 'applied' && k && k.number === 'C-0001' && k.status === 'completed' && k.title === 'The whole shop'
      && k.uncounted === 'leave' && k.started_by === stock && k.completed_by === stock && k.clock_ahead_ms === 0, r.said + ' ' + JSON.stringify(k));
    check('C1 with exactly the lines it was sent', (await countLines(cntA)) === 'Milk:9000 Polo M:-:out Polo S:-', await countLines(cntA));
    check('C1 a counted line is what was counted, less what sold after it by the till\'s clock, and not what sold before', (await level(plain)) === 7000, String(await level(plain)));
    check('C1 an uncounted line is left as it was, and so is one left out', (await level(sized, sizedS)) === before.s && (await level(sized, sizedM)) === before.m, `${await level(sized, sizedS)} ${await level(sized, sizedM)}`);
    r = await one(...fx('count-complete', {}, times(T)), stock);
    check('C2 the same count sent again is answered as written, and moves nothing', r.said === 'applied' && r.data && r.data.already === true && (await level(plain)) === 7000
      && (await q1(`select count(*)::int as n from stock_movements where tenant_id = $1 and ref_id = $2`, [tid, cntA])).n === 1, r.said + ' ' + JSON.stringify(r.data));

    T = (await serverNow()) + 10000;
    const cl = (it, va, counted, at, out = false) => ({ item_id: it, variant_id: va || '', counted, counted_at: counted === null ? null : iso(at), left_out: out });
    const cnt = (over) => fx('count-complete', { id: id(), ...over }, times(T));
    r = await one(...cnt({ uncounted: 'zero', lines: [cl(sized, sizedS, null), cl(sized, sizedM, null, 0, true)] }), stock);
    check('C3 the uncounted set to nothing: the line the tablet showed is 0', r.said === 'applied' && (await level(sized, sizedS)) === 0, r.said + ' ' + (await level(sized, sizedS)));
    check('C3 a line left out is not touched', (await level(sized, sizedM)) === before.m, String(await level(sized, sizedM)));
    check('C3 and a product that was not among the lines keeps its stock', (await level(extra)) === 9000 && (await level(plain)) === 7000 && (await level(goner)) === 3000, `${await level(extra)} ${await level(plain)} ${await level(goner)}`);

    await c.query(`update items set deleted_at = now() where id = $1`, [goner]);
    const cntG = id();
    r = await one(...cnt({ id: cntG, lines: [cl(sized, sizedM, 4000, T), cl(goner, null, null, 0, true)] }), stock);
    check('C4 a line left out whose product was removed since: the count completes without it', r.said === 'applied' && (await countLines(cntG)) === 'Polo M:4000' && (await level(sized, sizedM)) === 4000, r.said + ' ' + (await countLines(cntG)));
    r = await one(...cnt({ lines: [cl(goner, null, 2000, T)] }), stock);
    check('C4 a counted line whose product was removed is refused', r.said === 'rejected:unknown-item', r.said);

    // The tablet's clock runs ten minutes fast. A correction is made now; a line counted at "now plus
    // 8 minutes" by the tablet was in truth counted 2 minutes before it, one at "now plus 12" after it.
    await c.query(`select stock_move($1,$2,$3,null,1000,'found',null,null,null,$4,'behind the shelf')`, [tid, store, clocky, owner]);
    const S = await serverNow();
    r = await one(...cnt({ clock_ahead_ms: 600000, lines: [cl(clocky, null, 4000, S + 480000)] }), stock);
    check('C5 the tablet\'s clock set right: a correction made after the line was truly counted is added to it', r.said === 'applied' && (await level(clocky)) === 5000, r.said + ' ' + (await level(clocky)));
    r = await one(...cnt({ clock_ahead_ms: 600000, lines: [cl(clocky, null, 3000, S + 720000)] }), stock);
    check('C5 and one made before it was counted is not', r.said === 'applied' && (await level(clocky)) === 3000, r.said + ' ' + (await level(clocky)));

    const cntC = id();
    r = await one(...cnt({ id: cntC, scope_kind: 'category', scope_id: drinks, lines: [cl(plain, null, 7000, T)], approved_by: stock }), cashier);
    check('C6 with the word of someone who may, a cashier\'s count of a category is taken, named after it', r.said === 'applied' && (await count(cntC)).title === 'Drinks', r.said);
    const cntM = id();
    r = await one(...cnt({ id: cntM, scope_kind: 'brand', scope_text: 'Maison', lines: [cl(sized, sizedM, 4000, T)] }), stock);
    check('C6 a count of a brand is named after it', r.said === 'applied' && (await count(cntM)).title === 'Maison', r.said);
    const refused = [];
    for (const [over, want] of [[{ lines: [] }, 'nothing-to-count'], [{ uncounted: 'maybe' }, 'bad-uncounted'], [{ scope_kind: 'aisle' }, 'bad-scope'],
      [{ scope_kind: 'category', scope_id: id() }, 'bad-scope'], [{ clock_ahead_ms: 90000000 }, 'bad-payload'], [{ store_id: id() }, 'unknown-store'],
      [{ lines: [cl(fee, null, 1000, T)] }, 'not-counted'], [{ lines: [cl(sized, null, 1000, T)] }, 'pick-variant'], [{ lines: [cl(plain, sizedS, 1000, T)] }, 'unknown-line']]) {
      const got = (await one(...cnt(over), stock)).said;
      refused.push(got === 'rejected:' + want ? 'ok' : want + '?' + got);
    }
    check('C7 what a count may not be is refused by name', refused.every((x) => x === 'ok'), refused.join(' '));

    // ---------------------------------------------------------------- two at once
    // The first send is still being written when the second arrives (a slow answer, tapped again).
    const both = async (name, over) => {
      const [type, payload] = fx(name, over);
      const send = (x) => x.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify([op(type, payload, stock)])]).then((q) => tag(q.rows[0].r[0]), (e) => 'threw:' + e.message);
      await begin(a, tid);
      const ra = await send(a); // written, not committed
      await begin(b, tid);
      const pb = send(b);
      await pause(1500); // B has reached whatever it waits on
      await a.query('COMMIT');
      const rb = await pb;
      await b.query(rb.startsWith('threw') ? 'ROLLBACK' : 'COMMIT');
      return ra + ' ' + rb;
    };
    const supX = id(), ordX = id();
    let two = await both('supplier-save', { id: supX, name: 'Twice' });
    check('X1 a new supplier sent twice at once is one supplier, and both are answered done', two === 'applied applied'
      && (await q1(`select count(*)::int as n from suppliers where tenant_id = $1 and name = 'Twice'`, [tid])).n === 1, two);
    two = await both('po-save', { id: ordX, lines: [line(plain, null, 1000, 4600)] });
    check('X1 a new order sent twice at once is one order with one line', two === 'applied applied'
      && (await q1(`select count(*)::int as n from purchase_orders where id = $1`, [ordX])).n === 1 && (await lines(ordX)) === 'Milk:1000@4600', two + ' ' + (await lines(ordX)));

    // ---------------------------------------------------------------- the pull
    // an order finished long ago: its last change set back, with the trigger that stamps "now" switched off for the moment
    const ordOld = id(), ordOpenOld = id();
    await one(...fx('po-save', { id: ordOld, lines: [line(plain, null, 1000, 4600)] }), stock);
    await one(...fx('po-send', { id: ordOld }), stock);
    await one(...fx('po-cancel', { id: ordOld }), stock);
    await one(...fx('po-save', { id: ordOpenOld, lines: [line(plain, null, 1000, 4600)] }), stock);
    await c.query('BEGIN');
    try {
      await c.query(`set local lock_timeout = '8s'`);
      await c.query(`alter table purchase_orders disable trigger trg_touch`);
      await c.query(`update purchase_orders set updated_at = now() - interval '31 days', created_at = now() - interval '40 days' where id = any($1::uuid[])`, [[ordOld, ordOpenOld]]);
      await c.query(`alter table purchase_orders enable trigger trg_touch`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }

    const p = await pull();
    const ch = p.changes || {};
    const KEYS = ['suppliers', 'purchase_orders', 'deliveries', 'stock_counts', 'stock_count_lines', 'stock_movements'];
    check('P1 a shop\'s till is sent the six tables', KEYS.every((key) => Array.isArray(ch[key])), JSON.stringify(Object.keys(ch).filter((key) => KEYS.includes(key))));
    const got = (key) => ch[key] || [];
    check('P1 its suppliers, the removed one marked', got('suppliers').some((x) => x.id === supA && x.phone === '59990000') && got('suppliers').some((x) => x.id === supR && x.deleted_at), String(got('suppliers').length));
    const pa = got('purchase_orders').find((x) => x.id === ordA) || {};
    const paLine = (pa.lines || []).find((x) => x.item_id === plain) || {};
    check('P2 an order arrives with its lines, each with what was received of it', pa.status === 'received' && (pa.lines || []).length === 2 && paLine.qty === 12000 && paLine.received === 12000
      && paLine.variant_id === null && Number(paLine.unit_cost) === 4500, JSON.stringify(pa.lines));
    const px = got('purchase_orders').find((x) => x.id === ordX) || {};
    check('P2 a draft whose lines were replaced arrives with the lines it has now', (px.lines || []).length === 1 && px.lines[0].qty === 1000, JSON.stringify(px.lines));
    check('P2 an order finished more than thirty days ago is not sent, an open one of that age is',
      !got('purchase_orders').some((x) => x.id === ordOld) && got('purchase_orders').some((x) => x.id === ordOpenOld));
    const pd = got('deliveries').find((x) => x.id === delE) || {};
    check('P3 a delivery arrives with its lines', got('deliveries').length === 4 && (pd.lines || []).length === 2 && pd.lines.every((x) => x.qty === 1000), `${got('deliveries').length} ${JSON.stringify(pd.lines)}`);
    check('P4 counts, and the lines of those that are finished', got('stock_counts').some((x) => x.id === cntA && x.status === 'completed' && x.number === 'C-0001')
      && got('stock_count_lines').filter((x) => x.count_id === cntA).length === 3
      && got('stock_count_lines').some((x) => x.count_id === cntA && x.item_id === plain && x.counted === 9000 && x.diff !== null), String(got('stock_count_lines').length));
    const mv = got('stock_movements');
    check('P5 the shop\'s movements: a delivery, a sale, a count, a correction', ['receive', 'sale', 'count', 'found'].every((why) => mv.some((x) => x.reason === why)) && mv.every((x) => x.store_id === store),
      JSON.stringify([...new Set(mv.map((x) => x.reason))]));
    if (process.env.KEEP_PULL) fs.writeFileSync(process.env.KEEP_PULL, JSON.stringify(p));

    const p2 = (await pull(second)).changes || {};
    check('P6 the shop\'s other store is sent the suppliers and none of this store\'s papers', (p2.suppliers || []).some((x) => x.id === supA)
      && ['purchase_orders', 'deliveries', 'stock_counts', 'stock_count_lines', 'stock_movements'].every((key) => Array.isArray(p2[key]) && p2[key].length === 0),
      JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, (p2[key] || []).length]))));
    const pr = (await pull(restoStore, resto)).changes || {};
    check('P7 a restaurant\'s till is sent none of the six', KEYS.every((key) => !(key in pr)), JSON.stringify(Object.keys(pr).filter((key) => KEYS.includes(key))));
    const po = (await pull(theirStore, other)).changes || {};
    check('P8 another shop is sent its own supplier and nothing of this one', (po.suppliers || []).length === 1 && po.suppliers[0].id === theirSup
      && ['purchase_orders', 'deliveries', 'stock_counts', 'stock_count_lines', 'stock_movements'].every((key) => (po[key] || []).length === 0),
      JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, (po[key] || []).length]))));
    void restoOwner; void theirOwner;
  } finally {
    for (const x of [a, b]) { try { await x.query('ROLLBACK'); } catch {} await x.end(); }
    try { await c.query('ROLLBACK'); } catch {}
    for (const t of [tid, resto, other]) await devguard.cleanupTenant(c, t);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-STOCK PASS' : `TILL-STOCK FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
