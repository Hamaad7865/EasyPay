// stock-reports.test.cjs — a shop's stock reports: what the stock is worth and
// where, what to order, what was lost, what is not selling, and what each
// product earned after its cost. The questions are the pages' own
// (web/lib/stock-reports.ts and the sums in web/lib/stock.ts), asked as the
// tenant's own connection.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/stock-reports.test.cjs
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

// a module of web/lib, compiled from the TypeScript it lives in; `stubs` stand in for what it imports
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
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const stock = lib('stock');
  const rep = lib('stock-reports');
  // the receipts every report starts from (web/lib/report.ts); what it imports is not needed for that
  const report = lib('report', { '@/lib/action': { UUID: /^[0-9a-f-]{36}$/i }, '@/lib/settings': { withDefaults: (x) => x } });

  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-sr@example.com')`, [admin]);
    const tenant = async (name, code) => (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,'standard') as r`, [admin, name, code, id()])).r;
    const made = await tenant('Reports Test', 'SR1');
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const other = await tenant('Reports Other', 'SR2');
    const tz = (await one(`select timezone from stores where id = $1`, [store])).timezone;

    // as the tenant's own connection, inside this transaction
    async function asApp(tenantId, fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const ask = (sql, params, as = tid) => asApp(as, async () => (await c.query(sql, params)).rows);

    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const cash = ((await one(`select id from payment_types where tenant_id = $1 and deleted_at is null order by name = 'Cash' desc limit 1`, [tid]))
      ?? (await one(`insert into payment_types (tenant_id, name) values ($1,'Cash') returning id`, [tid]))).id;
    const vat = (await one(`insert into taxes (tenant_id, name, rate_bp, type) values ($1,'VAT 15',1500,'included') returning id`, [tid])).id;
    const clothing = (await one(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [tid])).id;
    const home = (await one(`insert into categories (tenant_id, name) values ($1,'Home') returning id`, [tid])).id;
    const textiles = (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id;
    const atelier = (await one(`insert into suppliers (tenant_id, name) values ($1,'Atelier') returning id`, [tid])).id;
    // every price is Rs 115.00 with VAT in it (Rs 100.00 without), unless said
    const item = async (name, o = {}) => {
      const it = (await one(
        `insert into items (tenant_id, name, price, cost, track_stock, category_id, supplier_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [tid, name, o.price ?? 11500, o.cost ?? null, o.track ?? true, o.cat ?? null, o.sup ?? null])).id;
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
      return it;
    };
    const variant = async (it, name) => (await one(`insert into item_variants (tenant_id, item_id, name, price, cost) values ($1,$2,$3,34500,14000) returning id`, [tid, it, name])).id;
    const shirt = await item('Shirt', { cat: clothing, sup: textiles, cost: 6200 });
    const scarf = await item('Scarf', { cat: clothing, cost: 2800 });
    const mug = await item('Mug', { cat: home, sup: atelier, cost: 1400 });
    const hat = await item('Hat', { sup: textiles, cost: 3000 });
    const belt = await item('Belt', { cat: clothing, cost: 1000 });
    const jacket = await item('Jacket', { cat: clothing, sup: textiles, price: 34500, cost: 14000 });
    const jacketM = await variant(jacket, 'M'), jacketL = await variant(jacket, 'L');
    const fee = await item('Bag fee', { track: false, price: 2300 });
    const receive = (it, va, qty, cost) => c.query(`select stock_move($1,$2,$3,$4,$5,'receive',$6,'delivery',$7,$8,null)`, [tid, store, it, va, qty, cost, id(), emp]);
    await receive(shirt, null, 10000, 6200);
    await receive(scarf, null, 9000, 2800);
    await receive(mug, null, 26000, 1400);
    await receive(jacket, jacketM, 4000, 14000);
    await receive(jacket, jacketL, 3000, 14000);
    // these came in a hundred days ago
    await c.query(`update stock_movements set created_at = now() - interval '100 days' where tenant_id = $1`, [tid]);

    const push = (ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    let seq = 0;
    const sale = async (items, extra) => {
      const tk = id(), rc = id();
      const out = await push([
        op('ticket.create', { id: tk, store_id: store }),
        ...items.map((it) => op('ticket.add_line', typeof it === 'string' ? { id: id(), ticket_id: tk, item_id: it, qty: 1000 } : { id: id(), ticket_id: tk, qty: 1000, ...it })),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'SR-' + (++seq), device_seq: seq, device_time: new Date().toISOString(), ...extra }),
      ]);
      return { rc, said: tag(out[out.length - 1]) };
    };
    const day = report.today(tz);
    const sales = async (byCategory, withCost, as = tid) => {
      const rows = await ask(rep.itemSalesSql(report.RECEIPTS, byCategory, withCost), [tid, day, day, null, null, 'all'], as);
      return Object.fromEntries(rows.map((r) => [r.name, { qty: r.qty, amount: Number(r.amount), ex: r.ex_vat == null ? null : Number(r.ex_vat), costed: r.costed == null ? null : Number(r.costed), cost: r.cost == null ? null : Number(r.cost) }]));
    };
    const fig = (r) => (r ? [r.qty, r.amount, r.ex, r.costed, r.cost].join('/') : 'none');

    // ---- cost and profit on item sales ----
    // one bill: two lines of one shirt each, a scarf and a bag fee, 10% off the bill. Rs 368.00, less Rs 36.80
    const s1 = await sale([shirt, shirt, scarf, fee], { discounts: [{ type: 'percent', value: 10, name: 'Friend' }], payments: [{ payment_type_id: cash, amount: 33120 }] });
    check('the first sale is applied', s1.said === 'applied', s1.said);
    let r = await sales(false, true);
    // each Rs 115.00 line is Rs 103.50 after its share of the discount, of which Rs 13.50 is VAT
    check('P5 sales excluding VAT are after the bill\'s discount', r.Shirt?.ex === 18000 && r.Scarf?.ex === 9000 && r['Bag fee']?.ex === 1800, [fig(r.Shirt), fig(r.Scarf), fig(r['Bag fee'])].join(' '));
    const bill = await one(`select subtotal, discount_total, tax_total from receipts where id = $1`, [s1.rc]);
    check('P5 and add up to what the receipt holds without its VAT', r.Shirt.ex + r.Scarf.ex + r['Bag fee'].ex === Number(bill.subtotal) - Number(bill.discount_total) - Number(bill.tax_total), JSON.stringify(bill));
    check('P2 two lines of one product on one receipt cost what the two cost, not twice that', r.Shirt.cost === 12400 && r.Shirt.qty === 2000, fig(r.Shirt));
    check('P4 a product not counted in stock has no cost, and its sales are in no profit', r['Bag fee'].cost === null && r['Bag fee'].costed === 0 && r['Bag fee'].amount === 2300, fig(r['Bag fee']));

    // the shirt gets dearer: ten more at Rs 80.00, and the product's own cost is retyped
    await receive(shirt, null, 10000, 8000);
    await c.query(`update items set cost = 9900 where id = $1`, [shirt]);
    r = await sales(false, true);
    check('P1 a cost changed after the sale changes nothing of what was sold', r.Shirt.cost === 12400, fig(r.Shirt));
    // a second bill: a shirt at the new average (8 at 62.00 and 10 at 80.00 make 72.00), and a hat nobody received
    const s2 = await sale([shirt, hat], { payments: [{ payment_type_id: cash, amount: 23000 }] });
    check('the second sale is applied', s2.said === 'applied', s2.said);
    r = await sales(false, true);
    check('P1 each sale costs what the goods cost when they were sold', r.Shirt.cost === 12400 + 7200 && r.Shirt.ex === 28000 && r.Hat?.cost === 3000 && r.Hat?.ex === 10000, [fig(r.Shirt), fig(r.Hat)].join(' '));

    // one shirt of the first bill comes back
    const line = await one(`select id from receipt_lines where receipt_id = $1 and name_snapshot = 'Shirt' limit 1`, [s1.rc]);
    const back = await push([op('refund.create', { id: id(), refund_of: s1.rc, store_id: store, device_id: dev, number: 'SR-R' + (++seq), device_seq: seq, device_time: new Date().toISOString(),
      reason: 'wrong size', lines: [{ receipt_line_id: line.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 10350 }] })]);
    check('the refund is applied', tag(back[0]) === 'applied', tag(back[0]));
    r = await sales(false, true);
    check('P3 a refund takes off its sales, its cost and its profit', r.Shirt.qty === 2000 && r.Shirt.amount === 23000 && r.Shirt.ex === 19000 && r.Shirt.cost === 13400 && r.Shirt.costed === 19000, fig(r.Shirt));
    const plain = await sales(false, false);
    check('the page without costs asks the same sales', Object.keys(r).sort().join() === Object.keys(plain).sort().join() && Object.keys(r).every((k) => r[k].qty === plain[k].qty && r[k].amount === plain[k].amount && plain[k].cost === null),
      JSON.stringify(plain));
    const cats = await sales(true, true);
    check('P1 by category, the same sums', cats.Clothing?.ex === 28000 && cats.Clothing?.cost === 16200 && cats['No category']?.ex === 11800 && cats['No category']?.cost === 3000 && cats['No category']?.costed === 10000,
      [fig(cats.Clothing), fig(cats['No category'])].join(' '));

    // one variant of a product is sold: the line names it, as the till's does
    const s3 = await sale([{ item_id: jacket, variant_id: jacketL, name_snapshot: 'Jacket, L', unit_price: 34500 }], { payments: [{ payment_type_id: cash, amount: 34500 }] });
    r = await sales(false, true);
    const lvl = async (va) => (await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id = $4`, [tid, store, jacket, va])).qty;
    check("P6 a variant sold costs what that variant cost, and leaves that variant's shelf only",
      s3.said === 'applied' && r['Jacket, L']?.qty === 1000 && r['Jacket, L']?.ex === 30000 && r['Jacket, L']?.cost === 14000 && (await lvl(jacketL)) === 2000 && (await lvl(jacketM)) === 4000,
      s3.said + ' ' + fig(r['Jacket, L']));

    // ---- losses ----
    const adjust = async (it, units, reason) => (await one(`select stock_adjust($1,$2,$3,null,$4,$5,$6,null) as id`, [tid, store, it, units, reason, emp])).id;
    const at = (mv, when) => c.query(`update stock_movements set created_at = ($2::timestamp at time zone $3) where id = $1`, [mv, when, tz]);
    await at(await adjust(mug, 2000, 'damaged'), '2026-09-15 12:00');
    await at(await adjust(mug, 1000, 'lost'), '2026-09-30 23:30');
    await at(await adjust(scarf, 1000, 'expired'), '2026-10-01 00:30');
    await at(await adjust(mug, 1000, 'found'), '2026-09-16 12:00');
    await at(await adjust(scarf, 1000, 'internal'), '2026-09-16 12:00');
    await at(await adjust(mug, 1000, 'supplier_return'), '2026-09-16 12:00');
    const losses = async (from, to, as = tid) => (await ask(rep.LOSSES_SQL, [tid, store, from, to], as)).map((x) => [x.reason, x.name, x.qty, x.value == null ? null : Number(x.value)].join(':')).join(' ');
    check('L1 losses are what was damaged, expired or lost, by reason and product, at the cost of the moment', (await losses('2026-09-01', '2026-09-30')) === 'damaged:Mug:2000:2800 lost:Mug:1000:1400', await losses('2026-09-01', '2026-09-30'));
    check('L2 the days are the shop\'s: 23:30 on the last day is in, 00:30 the next day is out',
      (await losses('2026-09-30', '2026-09-30')) === 'lost:Mug:1000:1400' && (await losses('2026-10-01', '2026-10-01')) === 'expired:Scarf:1000:2800', (await losses('2026-09-30', '2026-09-30')) + ' | ' + (await losses('2026-10-01', '2026-10-01')));
    await receive(mug, null, 10000, 5000);
    await c.query(`update items set cost = 5000 where id = $1`, [mug]);
    check('L3 a cost changed after the loss does not change what the loss was worth', (await losses('2026-09-01', '2026-09-30')) === 'damaged:Mug:2000:2800 lost:Mug:1000:1400', await losses('2026-09-01', '2026-09-30'));

    // ---- not selling ----
    const quiet = async (days, as = tid) => Object.fromEntries((await ask(rep.UNSOLD_SQL, [tid, store, days], as)).map((x) => [x.name + (x.variant ? ' ' + x.variant : ''), x]));
    let u = await quiet(60);
    check('U1 not selling: what holds stock and was not sold in the days asked', Object.keys(u).sort().join() === 'Jacket M,Mug', Object.keys(u).sort().join());
    check('U1 a line never sold says so, and says when stock last came in', u['Jacket M'].last_sold === null && u['Jacket M'].days_quiet === null && u['Jacket M'].last_in !== null && u['Jacket M'].days_in === 100 && u.Mug.qty === 33000, JSON.stringify(u['Jacket M']));
    // the scarf's sale is said to be 61 days old, then 59
    const scarfSale = (await one(`select id from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'sale'`, [tid, scarf])).id;
    await c.query(`update stock_movements set created_at = now() - interval '61 days' where id = $1`, [scarfSale]);
    u = await quiet(60);
    check('U1 a line last sold before the days asked is on the list, with when', u.Scarf?.days_quiet === 61 && u.Scarf?.last_sold !== null, JSON.stringify(u.Scarf));
    await c.query(`update stock_movements set created_at = now() - interval '59 days' where id = $1`, [scarfSale]);
    check('U1 and one sold inside them is not', !('Scarf' in (await quiet(60))) && 'Scarf' in (await quiet(30)));
    // the shirt's sales are said to be 70 days old; what came back today is not a sale
    await c.query(`update stock_movements set created_at = now() - interval '70 days' where tenant_id = $1 and item_id = $2 and reason = 'sale'`, [tid, shirt]);
    u = await quiet(60);
    check('U1 a refund is not a sale', u.Shirt?.days_quiet === 70, JSON.stringify(u.Shirt));
    check('U1 a line with nothing on hand, or below zero, is not on the list', !('Belt' in u) && !('Hat' in u) && !('Jacket L' in u), Object.keys(u).join());

    // ---- what the stock is worth, and what to order ----
    await c.query(`update stock_levels set reorder_point = 20000, reorder_qty = 24000 where tenant_id = $1 and item_id = $2`, [tid, shirt]);
    await c.query(`update stock_levels set reorder_point = 40000 where tenant_id = $1 and item_id = $2`, [tid, mug]);
    await c.query(`update stock_levels set reorder_point = 5000, reorder_qty = 0 where tenant_id = $1 and item_id = $2 and variant_id = $3`, [tid, jacket, jacketM]);
    await c.query(`update stock_levels set reorder_point = 1000 where tenant_id = $1 and item_id = $2 and variant_id = $3`, [tid, jacket, jacketL]);
    await c.query(`update stock_levels set reorder_point = 9000 where tenant_id = $1 and item_id = $2`, [tid, scarf]);
    const onHand = async (as = tid) => (await ask(`select * from stock_on_hand($1, $2)`, [tid, store], as)).map((l) => ({
      ...l, qty: l.qty, avgCost: Number(l.avg_cost), price: Number(l.price), reorderPoint: l.reorder_point, reorderQty: l.reorder_qty, supplierId: l.supplier_id }));
    const lines = await onHand();
    const all = stock.stockTotals(lines);
    const sum = (rows, k) => rows.reduce((a, x) => a + x[k], 0);
    const byCat = stock.valueBy(lines, (l) => l.category, 'No category'), bySup = stock.valueBy(lines, (l) => l.supplier, 'No supplier');
    check('V1 stock value by category and by supplier each add up to the totals of Stock on hand',
      sum(byCat, 'atCost') === all.atCost && sum(byCat, 'atPrice') === all.atPrice && sum(bySup, 'atCost') === all.atCost && sum(bySup, 'atPrice') === all.atPrice && all.atCost > 0,
      JSON.stringify({ all, byCat: byCat.map((x) => x.name + ':' + x.atCost), bySup: bySup.map((x) => x.name + ':' + x.atCost) }));
    const hatRow = byCat.find((x) => x.name === 'No category');
    check('V1 a line below zero counts for what it shows, and what has no category has a row of its own', hatRow && hatRow.units === -1000 && hatRow.atCost === -3000 && bySup.some((x) => x.name === 'No supplier'), JSON.stringify(hatRow));
    const list = stock.reorderList(lines);
    const want = async (sup) => {
      const o = (await one(`select po_save($1,$2,null,$3,$4,null,null,'[]'::jsonb) as r`, [tid, emp, store, sup])).r;
      await c.query(`select po_fill_low($1,$2)`, [tid, o.id]);
      return (await c.query(`select item_id, variant_id, qty from purchase_order_lines where tenant_id = $1 and order_id = $2`, [tid, o.id])).rows.map((x) => [x.item_id, x.variant_id, x.qty].join(':')).sort().join(' ');
    };
    const have = (sup) => (list.find((g) => g.supplierId === sup)?.lines ?? []).map((x) => [x.item_id, x.variant_id, x.order].join(':')).sort().join(' ');
    const wantT = await want(textiles), wantA = await want(atelier);
    check('O1 the reorder list holds, for each supplier, what "Add what is low" puts on an order, in the same quantities',
      wantT !== '' && wantA !== '' && have(textiles) === wantT && have(atelier) === wantA, JSON.stringify({ wantT, haveT: have(textiles), wantA, haveA: have(atelier) }));
    const loose = list.find((g) => g.supplierId === null);
    check('O1 a low line with no supplier is on the list under no supplier; a line above its point, or with none, is not on it',
      loose && loose.lines.map((x) => x.name).join() === 'Scarf' && !list.some((g) => g.lines.some((x) => x.name === 'Belt' || (x.name === 'Jacket' && x.variant === 'L'))), JSON.stringify(list.map((g) => [g.supplier, g.lines.map((x) => x.name + (x.variant ?? ''))])));

    // ---- the tenant role, and another tenant ----
    const seen = {
      sales: Object.keys(await sales(false, true, other.tenant_id)).length,
      losses: await losses('2026-09-01', '2026-10-31', other.tenant_id),
      quiet: Object.keys(await quiet(60, other.tenant_id)).length,
      stock: (await onHand(other.tenant_id)).length,
    };
    check('T1 another tenant asking for ours sees nothing', seen.sales === 0 && seen.losses === '' && seen.quiet === 0 && seen.stock === 0, JSON.stringify(seen));
    const counted = (await ask(rep.COUNTED_SQL, [tid, store, '2026-09-01', '2026-09-30']))[0];
    check('what counts corrected in the same days is none here', counted.counts === 0 && counted.qty === 0 && Number(counted.value) === 0, JSON.stringify(counted));

    // ---- discounts given on one line, and prices typed for one sale ----
    // (last: these sales would change what the reports above are asked about)
    const prices = async (as = tid, kind = 'all') => { const x = (await ask(rep.linePricesSql(report.RECEIPTS), [tid, day, day, null, null, kind], as))[0]; sold = Number(x.sold_off) + '/' + Number(x.sold_changed); return Number(x.off) + '/' + Number(x.changed); };
    let sold = '';
    check('D1 with nothing changed on a line, nothing is counted (a discount on the bill is the receipt\'s own)', (await prices()) === '0/0', await prices());
    // two belts at Rs 100.00 instead of Rs 115.00 (Rs 30.00 off), a mug typed at Rs 100.00 (Rs 15.00 under), a scarf typed at Rs 125.00 (Rs 10.00 over)
    const beltLine = id();
    const s4 = await sale([
      { id: beltLine, item_id: belt, qty: 2000, unit_price: 10000, list_price: 11500, price_kind: 'discount', price_label: 'Rs 15.00 off', approved_by: emp },
      { item_id: mug, unit_price: 10000, list_price: 11500, price_kind: 'override', approved_by: emp },
      { item_id: scarf, unit_price: 12500, list_price: 11500, price_kind: 'override', approved_by: emp },
      hat,
    ], { payments: [{ payment_type_id: cash, amount: 54000 }] });
    check('D2 a discount on a line is counted apart from a price typed, which counts under and over the listed price',
      s4.said === 'applied' && (await prices()) === '3000/500', s4.said + ' ' + (await prices()));
    const s4r = await one(`select total, discount_total, needs_review from receipts where id = $1`, [s4.rc]);
    check('D2 the receipt holds none of it as its own discount, and is not flagged', Number(s4r.total) === 54000 && Number(s4r.discount_total) === 0 && s4r.needs_review === false, JSON.stringify(s4r));
    // one of the two belts comes back, at the Rs 100.00 it was charged
    const beltRl = await one(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [s4.rc, beltLine]);
    const back2 = await push([op('refund.create', { id: id(), refund_of: s4.rc, store_id: store, device_id: dev, number: 'SR-R' + (++seq), device_seq: seq, device_time: new Date().toISOString(),
      reason: 'changed mind', lines: [{ receipt_line_id: beltRl.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 10000 }] })]);
    check('D3 a refund takes back its part of the discount', tag(back2[0]) === 'applied' && (await prices()) === '1500/500', tag(back2[0]) + ' ' + (await prices()));
    check('D3 and the sales alone still say what was taken off them', sold === '3000/500', sold);
    check('D3 and asked for sales only, or refunds only, each has its own', (await prices(tid, 'sale')) === '3000/500' && (await prices(tid, 'refund')) === '-1500/0', (await prices(tid, 'sale')) + ' ' + (await prices(tid, 'refund')));
    check('D4 another business sees none of it', (await prices(other.tenant_id)) === '0/0', await prices(other.tenant_id));
    r = await sales(false, true);
    // one belt kept at Rs 100.00. Without VAT: Rs 173.91 of the two sold, less Rs 86.96 of the one returned
    check('D5 item sales are what the line was charged, not its listed price', r.Belt?.qty === 1000 && r.Belt?.amount === 10000 && r.Belt?.ex === 8695, fig(r.Belt));
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'STOCK REPORTS PASS' : `STOCK REPORTS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
