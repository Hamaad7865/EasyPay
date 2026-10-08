// shop-pages.test.cjs — a shop's back office, opened page by page the way its
// owner would: each page is the real one (db/tests/page.cjs compiles it and
// gives it this test's connection, as the tenant's role), on a shop that has
// had a day's trade made the way a till makes it (through sync_push). No
// account on dev is needed, so this is what stands in for signing in.
// It says two things: every page in a shop's menu opens (its own queries run
// on the real tables), and the figures an owner reads are the till's: a
// discount given on one line and a price typed for one sale are counted
// where discounts are counted, and said apart.
// The same reports are then opened for a restaurant, which has neither.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/shop-pages.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, text, rowsOf, stats } = require('./page.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
const id = () => crypto.randomUUID();

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-sp@example.com')`, [admin]);
    const tenant = async (name, code, type) => (await one(`select platform.create_tenant_of_type($1,$2,'Main',$3,'Owner',$4,'standard',$5) as r`, [admin, name, code, id(), type])).r;

    // a business with a till, and a day on it. Every price is Rs 115.00 with VAT in it.
    async function business(name, code, type) {
      const made = await tenant(name, code, type);
      const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
      const asApp = async (fn) => {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        try { return await fn(); } finally { await c.query('RESET ROLE'); }
      };
      const push = async (ops) => {
        const out = await asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
        const bad = out.filter((o) => o.status !== 'applied');
        if (bad.length) throw new Error(name + ': the server refused ' + JSON.stringify(bad));
        return out;
      };
      const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Counter','T1') returning id`, [tid, store])).id;
      const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
      const vat = (await one(`select id from taxes where tenant_id = $1 and name = 'VAT'`, [tid])).id;
      const cat = (await one(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [tid])).id;
      const sup = type === 'retail' ? (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id : null;
      const item = async (nm, track) => {
        const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, category_id, supplier_id) values ($1,$2,11500,4000,$3,$4,$5) returning id`, [tid, nm, track, cat, sup])).id;
        await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
        if (track) await c.query(`select stock_move($1,$2,$3,null,10000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, it, id(), owner]);
        return it;
      };
      const tz = (await one(`select timezone from stores where id = $1`, [store])).timezone;
      // the till's clock: the day is opened an hour ago and closed five minutes ago
      const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
      let seq = 0;
      const sale = async (lines, total, extra = {}) => {
        const tk = id(), rc = id();
        const ids = lines.map(() => id());
        await push([
          op('ticket.create', { id: tk, store_id: store }),
          ...lines.map((l, i) => op('ticket.add_line', { id: ids[i], ticket_id: tk, qty: 1000, ...l })),
          op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: code + '-' + (++seq), device_seq: seq, device_time: at(40 - seq),
            payments: [{ payment_type_id: cash, amount: total }], ...extra }),
        ]);
        return { rc, ids };
      };
      // gives back one of a line; paid back in cash unless `payments` says otherwise. Returns the refund's number.
      const refund = async (rc, ticketLine, amount, payments) => {
        const rl = await one(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [rc, ticketLine]);
        const number = code + '-R' + (++seq);
        await push([op('refund.create', { id: id(), refund_of: rc, store_id: store, device_id: dev, number, device_seq: seq, device_time: at(40 - seq),
          reason: 'changed mind', lines: [{ receipt_line_id: rl.id, qty: 1000 }], payments: payments ?? [{ payment_type_id: cash, amount }] })]);
        return number;
      };
      const days = async () => (await one(`select (now() at time zone $1 - interval '1 day')::date::text as from, (now() at time zone $1)::date::text as to`, [tz]));
      return { tid, store, owner, dev, cash, cat, sup, item, push, sale, refund, at, days, ctx: { tenantId: tid, employeeId: owner, mode: type } };
    }

    // ---------------------------------------------------------------- the shop
    const shop = await business('Pages Shop', 'SP1', 'retail');
    const shirt = await shop.item('Shirt', true), scarf = await shop.item('Scarf', true), belt = await shop.item('Belt', true);
    const mug = await shop.item('Mug', true), hat = await shop.item('Hat', true);
    const shift = id();
    await shop.push([op('shift.open', { id: shift, device_id: shop.dev, opening_float: 100000, opened_at: shop.at(60) })]);
    // a shirt and a scarf, 10% off the whole sale: Rs 230.00 less Rs 23.00
    await shop.sale([{ item_id: shirt }, { item_id: scarf }], 20700, { discounts: [{ type: 'percent', value: 10, name: 'Friend' }] });
    // two belts with Rs 15.00 off each, a mug typed at Rs 100.00, a hat as listed: Rs 200.00 + Rs 100.00 + Rs 115.00
    const b = await shop.sale([
      { item_id: belt, qty: 2000, unit_price: 10000, list_price: 11500, price_kind: 'discount', price_label: 'Rs 15.00 off', approved_by: shop.owner },
      { item_id: mug, unit_price: 10000, list_price: 11500, price_kind: 'override', approved_by: shop.owner },
      { item_id: hat },
    ], 41500);
    // one of the two belts comes back, at the Rs 100.00 it was charged
    await shop.refund(b.rc, b.ids[0], 10000);
    await shop.push([op('shift.close', { id: shift, counted_cash: 152200, closed_at: shop.at(6) })]);
    await shop.push([op('day.close', { id: id(), store_id: shop.store, device_id: shop.dev, closed_at: shop.at(5) })]);
    // the back office's own side of a shop: one of each, so no page is only its empty state
    await c.query(`select stock_adjust($1,$2,$3,null,1000,'damaged',$4,null)`, [shop.tid, shop.store, scarf, shop.owner]);
    await c.query(`update stock_levels set reorder_point = 20000, reorder_qty = 12000 where tenant_id = $1 and item_id = $2`, [shop.tid, shirt]);
    const po = (await one(`select po_save($1,$2,null,$3,$4,null,null,'[]'::jsonb) as r`, [shop.tid, shop.owner, shop.store, shop.sup])).r;
    await c.query(`select po_fill_low($1,$2)`, [shop.tid, po.id]);
    const count = (await one(`select count_start($1,$2,$3,'all',null,null) as r`, [shop.tid, shop.owner, shop.store])).r;
    const countId = typeof count === 'object' && count !== null ? count.id : count;
    await c.query(`insert into customers (tenant_id, name, phone) values ($1,'Priya','52501234')`, [shop.tid]);

    const d = await shop.days();
    const range = { from: d.from, to: d.to };
    const see = async (who, href, sp, more) => {
      await c.query('SAVEPOINT pg');
      try {
        const html = await open(c, who.ctx, href, sp, more);
        await c.query('RELEASE SAVEPOINT pg');
        return { html, says: text(html) };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT pg');
        return { html: '', says: '', error: (e && e.message) || String(e) };
      }
    };

    // ---- the figures ----
    let p = await see(shop, '/backoffice/reports/sales', range);
    check('S1 Sales summary opens for a shop', !p.error, p.error);
    check('S1 the figures at its top are the receipts\' own', stats(p.html).join(' | ').startsWith('Total collected: Rs 522.00 | Sales before refunds: Rs 622.00 | Refunds: Rs 100.00'), stats(p.html).join(' | '));
    // Rs 23.00 off the first sale and Rs 30.00 off the two belts. It is said under "Sales before refunds", so the belt that came back changes nothing of it
    check('S2 discounts are what was taken off whole sales and off single lines', p.says.includes('after Rs 53.00 of discounts'), (p.says.match(/after Rs [\d.,]+ of discounts/) || [])[0]);
    check('S2 and it says which is which', p.says.includes('Rs 30.00 of the discounts were given on single lines, Rs 23.00 on whole sales.'), (p.says.match(/Rs [\d.,]+ of the discounts[^.]*\./) || [])[0]);
    check('S1 a shop is not asked about order types, nor shown a split by them', !p.says.includes('Order type') && !p.says.includes('order type'), (p.says.match(/.{30}[Oo]rder type.{30}/) || [])[0]);
    check('S3 a price typed for one sale is said apart, and is not a discount', p.says.includes('Prices typed for one sale came to Rs 15.00 below the listed prices'), (p.says.match(/Prices typed[^:]*/) || [])[0]);

    p = await see(shop, '/backoffice/reports/day-close', range);
    check('S4 Day closing opens for a shop', !p.error, p.error);
    // the till's own report takes a refund's part of a discount back, and so does this page: Rs 53.00 less the Rs 15.00 of the belt that came back
    check('S4 its discounts are the till\'s figure, with the lines\' in it', p.says.includes('Discounts given Rs 38.00'), (p.says.match(/Discounts given Rs [\d.,]+/g) || []).join(' / '));
    check('S4 and prices typed are a line of their own', p.says.includes('Prices typed, under the listed prices Rs 15.00'), (p.says.match(/Prices typed[^R]*Rs [\d.,]+/g) || []).join(' / '));
    check('S4 the day adds up: Rs 622.00 sold, Rs 100.00 refunded', p.says.includes('Sales Rs 622.00') && p.says.includes('Refunds (1) -Rs 100.00'), (p.says.match(/Sales Rs [\d.,]+/) || [])[0]);

    p = await see(shop, '/backoffice', range);
    check('S5 the dashboard opens for a shop', !p.error, p.error);
    check('S5 without a card of order types', !p.says.includes('Order types'), (p.says.match(/.{30}Order types.{30}/) || [])[0]);
    check('S5 and counts the same discounts', /After Rs 38 of discounts and Rs 100 of refunds/i.test(p.says), (p.says.match(/After Rs [\d.,]+ of discounts[^.]{0,40}/i) || [p.says.slice(0, 200)])[0]);

    p = await see(shop, '/backoffice/insights/staff', range);
    check('S6 Staff performance opens for a shop', !p.error, p.error);
    check('S6 who gave the discounts gave the lines\' too', p.says.includes('gave the most in discounts: Rs 38.00'), (p.says.match(/gave the most in discounts: Rs [\d.,]+/) || [])[0]);

    p = await see(shop, '/backoffice/reports/orders', range);
    check('S7 Order details opens for a shop', !p.error, p.error);
    const lines = rowsOf(p.html);
    const beltRow = lines.find((r) => r.startsWith('Belt') && r.includes('| 2 |'));
    check('S7 a discounted line says what it was listed at and who allowed it', !!beltRow && beltRow.includes('Rs 15.00 off: listed at Rs 115.00, allowed by Owner') && beltRow.endsWith('Rs 100.00 | Rs 200.00'), beltRow);
    const mugRow = lines.find((r) => r.startsWith('Mug'));
    check('S7 a line charged a typed price says so', !!mugRow && mugRow.includes('Price typed for this sale: listed at Rs 115.00'), mugRow);
    const hatRow = lines.find((r) => r.startsWith('Hat'));
    check('S7 a line sold as listed says nothing more', !!hatRow && !hatRow.includes('listed at'), hatRow);

    p = await see(shop, '/backoffice/reports/items', range);
    check('S8 Item sales opens for a shop, with cost and profit', !p.error && /Profit/.test(p.says), p.error);
    const beltSold = rowsOf(p.html).find((r) => r.includes('| Belt |'));
    // one belt kept, at the Rs 100.00 it was charged: Rs 86.95 without VAT, against the Rs 40.00 it cost
    check('S8 a product\'s sales, and its profit, are from what its lines were charged', !!beltSold && beltSold.includes('| Belt | Clothing | 1 | Rs 100.00 |') && beltSold.includes('| Rs 86.95 | Rs 40.00 | Rs 46.95 |'), beltSold);

    // every product of this shop comes from Textiles Ocean, and none has a brand
    p = await see(shop, '/backoffice/reports/items', { ...range, group: 'supplier' });
    const supRows = rowsOf(p.html).filter((r) => /^\d+ \| /.test(r));
    check('S9 Item sales by supplier: one row for the supplier, with all the sales', !p.error && supRows.length === 1 && supRows[0].startsWith('1 | Textiles Ocean | 5 | Rs 545.00'), p.error || supRows.join(' // '));
    p = await see(shop, '/backoffice/reports/items', { ...range, group: 'brand' });
    const brandRows = rowsOf(p.html).filter((r) => /^\d+ \| /.test(r));
    check('S9 by brand: products with no brand are under "No brand"', !p.error && brandRows.length === 1 && brandRows[0].startsWith('1 | No brand | 5 | Rs 545.00') && p.says.includes('Brands sold'), p.error || brandRows.join(' // '));

    // ---- every page in a shop's menu ----
    const menu = [
      ['/backoffice/insights/sales', range], ['/backoffice/insights/menu', range], ['/backoffice/reports/tax', range], ['/backoffice/reports/timecards', range],
      ['/backoffice/reports/stock', {}], ['/backoffice/reports/stock', { view: 'reorder' }], ['/backoffice/reports/stock', { view: 'losses', ...range }], ['/backoffice/reports/stock', { view: 'unsold' }],
      ['/backoffice/receipts', {}], ['/backoffice/categories', {}], ['/backoffice/items', {}], ['/backoffice/taxes', {}], ['/backoffice/discounts', {}],
      ['/backoffice/stock', {}], ['/backoffice/purchase-orders', {}], ['/backoffice/suppliers', {}], ['/backoffice/stock-counts', {}], ['/backoffice/stock-movements', {}],
      ['/backoffice/customers', {}], ['/backoffice/printers', {}], ['/backoffice/receipt-design', {}], ['/backoffice/settings', {}], ['/backoffice/company', {}],
      ['/backoffice/staff', {}], ['/backoffice/roles', {}], ['/backoffice/data', {}],
    ];
    const broken = [];
    for (const [href, sp] of menu) {
      const got = await see(shop, href, sp);
      if (got.error || got.html.length < 200) broken.push(href + (sp.view ? '?view=' + sp.view : '') + ': ' + (got.error || 'drew nothing'));
    }
    check(`M1 the other ${menu.length} pages of a shop's menu open on a shop that has traded`, broken.length === 0, broken.join(' || '));
    const one1 = await see(shop, '/backoffice/purchase-orders/' + po.id, {}, { params: { id: po.id }, file: 'backoffice/purchase-orders/[id]' });
    const one2 = await see(shop, '/backoffice/stock-counts/' + countId, {}, { params: { id: countId }, file: 'backoffice/stock-counts/[id]' });
    check('M2 a purchase order and a count open', !one1.error && !one2.error && one1.says.includes('Shirt') && one2.html.length > 500, [one1.error, one2.error].filter(Boolean).join(' || '));
    // barcode labels: every product is listed with its price and what is on hand, and one with no barcode says so
    const labels = await see(shop, '/backoffice/items/labels', {});
    const labelRows = rowsOf(labels.html).filter((r) => r.includes('Belt') || r.includes('Shirt'));
    check('M5 Barcode labels opens, and lists the products with their prices', !labels.error && labelRows.length >= 2 && labelRows.every((r) => r.includes('Rs 115.00')) && labels.says.includes('40 x 30 mm') && labels.says.includes('A4 sheets'), labels.error || labelRows.join(' // '));
    // a shop's barcode settings: the digits, the switch, the next barcode, and how many lines have none
    const bc = await see(shop, '/backoffice/settings', { tab: 'barcodes' });
    check('M6 a shop\'s POS settings have a Barcodes tab: its digits, the next barcode and the lines that have none',
      !bc.error && bc.says.includes('Your own barcodes') && bc.html.includes('name="prefix"') && bc.html.includes('value="200"') && bc.says.includes('2000000000015')
      && bc.says.includes('5 lines have no barcode yet') && bc.html.includes('href="/backoffice/items/labels"'), bc.error || (bc.says.match(/The next barcode.{0,200}/) || [bc.says.slice(0, 200)])[0]);
    check('M6 and Barcode labels points back at them', labels.html.includes('href="/backoffice/settings?tab=barcodes"'));
    const stock = await see(shop, '/backoffice/stock', {});
    // ten of each came in; two belts sold and one came back, a scarf sold and one written off
    const beltStock = rowsOf(stock.html).find((r) => r.includes('| Belt |')), scarfStock = rowsOf(stock.html).find((r) => r.includes('| Scarf |'));
    check('M3 Stock on hand holds what the day left on the shelves', (beltStock || '').includes('| Belt | One size | 9 |') && (scarfStock || '').includes('| Scarf | One size | 8 |'), [beltStock, scarfStock].join(' // ') + (stock.error || ''));
    for (const href of ['/backoffice/tables', '/backoffice/bookings', '/backoffice/addons']) {
      const got = await see(shop, href, {});
      check('M4 a shop has no ' + href.split('/').pop(), got.error === 'not found', got.error || 'it opened');
    }

    // ---- an exchange: the hat comes back and pays for part of a shirt and a scarf (migration 0079) ----
    {
      const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [shop.tid])).id;
      const before = stats((await see(shop, '/backoffice/reports/sales', range)).html).join(' | ');
      // Rs 115.00 of hat back, Rs 230.00 of goods out: Rs 115.00 more in cash
      const number = await shop.refund(b.rc, b.ids[2], 11500, [{ payment_type_id: exch, amount: 11500 }]);
      await shop.sale([{ item_id: shirt }, { item_id: scarf }], 23000, { payments: [{ payment_type_id: exch, amount: 11500, reference: number }, { payment_type_id: shop.cash, amount: 11500 }] });
      p = await see(shop, '/backoffice/reports/sales', range);
      check('X1 after an exchange, what was collected is up by the difference alone', !p.error && before.startsWith('Total collected: Rs 522.00 |') && stats(p.html).join(' | ').startsWith('Total collected: Rs 637.00 | Sales before refunds: Rs 852.00 | Refunds: Rs 215.00'), stats(p.html).join(' | '));
      const pay = rowsOf(p.html).filter((r) => /^(Cash|Exchange) \|/.test(r));
      check('X1 by payment method, cash holds what changed hands and the exchange holds nothing', pay.length === 2 && pay[0].startsWith('Cash | 4 | Rs 637.00') && pay[1].startsWith('Exchange | 2 | Rs 0.00'), pay.join(' // '));
      p = await see(shop, '/backoffice/reports/orders', range);
      check('X2 Order details says what paid for the sale, naming the refund, and where the refund went',
        !p.error && p.says.includes(`Paid by Exchange · ref ${number} Rs 115.00`) && p.says.includes('Paid back by Exchange Rs 115.00') && !p.says.includes('Needs a check'), p.error || (p.says.match(/Paid[^R]*Exchange[^R]*Rs [\d.,]+/g) || []).join(' / '));
      p = await see(shop, '/backoffice/receipts', {});
      check('X2 neither receipt is listed for review', !p.error && !p.says.includes('exchange against refund'), p.error);
      p = await see(shop, '/backoffice/settings', { tab: 'payments' });
      check('X3 the Exchange type is not among the payment options a shop edits', !p.error && p.html.includes('value="Cash"') && !p.html.includes('value="Exchange"'), p.error);
      // a sale that names a refund which is not there is flagged, and the Receipts page says why
      await shop.sale([{ item_id: mug }], 11500, { payments: [{ payment_type_id: exch, amount: 11500, reference: 'SP1-R-NOWHERE' }] });
      p = await see(shop, '/backoffice/receipts', {});
      check('X4 a sale settled against a refund that is not there is on the Receipts page, with the reason', !p.error && p.says.includes('Rs 115 of it was settled as an exchange against refund SP1-R-NOWHERE, which is not there for that amount'), p.error || (p.says.match(/settled as an exchange[^.]*/) || [p.says.slice(0, 300)])[0]);
    }

    // -------------------------------------------------------- a restaurant
    const rest = await business('Pages Bistro', 'SP2', 'restaurant');
    const soup = await rest.item('Soup', false), cake = await rest.item('Cake', false);
    const rshift = id();
    await rest.push([op('shift.open', { id: rshift, device_id: rest.dev, opening_float: 100000, opened_at: rest.at(60) })]);
    await rest.sale([{ item_id: soup }, { item_id: cake }], 20700, { discounts: [{ type: 'percent', value: 10, name: 'Friend' }] });
    await rest.push([op('shift.close', { id: rshift, counted_cash: 120700, closed_at: rest.at(6) })]);
    await rest.push([op('day.close', { id: id(), store_id: rest.store, device_id: rest.dev, closed_at: rest.at(5) })]);
    const rd = await rest.days();
    const rrange = { from: rd.from, to: rd.to };
    p = await see(rest, '/backoffice/reports/sales', rrange);
    check('R1 Sales summary for a restaurant: the bill\'s discount, and nothing about lines', !p.error && p.says.includes('after Rs 23.00 of discounts') && !p.says.includes('single lines') && !p.says.includes('Prices typed'), p.error || (p.says.match(/after Rs [\d.,]+ of discounts/) || [])[0]);
    check('R1 and its order types are there to pick and to split by', p.says.includes('Order type') && p.says.includes('order type'));
    p = await see(rest, '/backoffice/reports/day-close', rrange);
    check('R2 Day closing for a restaurant: the same', !p.error && p.says.includes('Discounts given Rs 23.00') && !p.says.includes('Prices typed'), p.error || (p.says.match(/Discounts given Rs [\d.,]+/g) || []).join(' / '));
    p = await see(rest, '/backoffice', rrange);
    check('R3 the dashboard for a restaurant', !p.error && /After Rs 23 of discounts and Rs 0 of refunds/i.test(p.says) && p.says.includes('Order types'), p.error || (p.says.match(/After Rs [\d.,]+ of discounts[^.]{0,40}/i) || [])[0]);
    p = await see(rest, '/backoffice/insights/staff', rrange);
    check('R4 Staff performance for a restaurant', !p.error && p.says.includes('gave the most in discounts: Rs 23.00'), p.error || (p.says.match(/gave the most in discounts: Rs [\d.,]+/) || [])[0]);
    p = await see(rest, '/backoffice/reports/items', { ...rrange, group: 'supplier' });
    check('R4 a restaurant is not offered Item sales by supplier or brand, and asked for one gets its items', !p.error && !p.html.includes('value="supplier"') && rowsOf(p.html).some((r) => r.includes('| Soup |')), p.error);
    p = await see(rest, '/backoffice/reports/orders', rrange);
    check('R5 Order details for a restaurant: no line says "listed at"', !p.error && rowsOf(p.html).some((r) => r.startsWith('Soup')) && !p.says.includes('listed at'), p.error);
    for (const href of ['/backoffice/reports/stock', '/backoffice/purchase-orders', '/backoffice/stock-counts']) {
      const got = await see(rest, href, {});
      check('R6 a restaurant has no ' + href.split('/').pop(), got.error === 'not found', got.error || 'it opened');
    }
    p = await see(rest, '/backoffice/settings', { tab: 'barcodes' });
    check('R7 a restaurant\'s POS settings have no Barcodes tab, and its address shows General', !p.error && !p.says.includes('Your own barcodes') && !p.html.includes('tab=barcodes') && p.says.includes('Decimals'), p.error);
    // what one business's owner is shown is its own
    p = await see(rest, '/backoffice/reports/orders', rrange);
    check('T1 a restaurant\'s owner sees nothing of the shop', !p.says.includes('Belt') && !p.says.includes('SP1-'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'SHOP PAGES PASS' : `SHOP PAGES FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
