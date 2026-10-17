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
      // this shop gives money back (0109): a shop is exchange-only until its settings say otherwise, and this day has a refund in it
      if (type === 'retail') await c.query(`update pos_settings set data = data || '{"returns":"refund"}'::jsonb where tenant_id = $1`, [tid]);
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
    // the import: an Excel workbook or a CSV file, its columns said in the second step
    const imp = await see(shop, '/backoffice/items/import', {});
    check('M7 Import products opens for a shop, and takes an Excel workbook or a CSV file', !imp.error && imp.says.includes('An Excel workbook (.xlsx) or a CSV file') && imp.html.includes('.xlsx') && imp.says.includes('Download the template'), imp.error || imp.says.slice(0, 200));
    const stock = await see(shop, '/backoffice/stock', {});
    // ten of each came in; two belts sold and one came back, a scarf sold and one written off
    const beltStock = rowsOf(stock.html).find((r) => r.includes('| Belt |')), scarfStock = rowsOf(stock.html).find((r) => r.includes('| Scarf |'));
    check('M3 Stock on hand holds what the day left on the shelves', (beltStock || '').includes('| Belt | One size | 9 |') && (scarfStock || '').includes('| Scarf | One size | 8 |'), [beltStock, scarfStock].join(' // ') + (stock.error || ''));
    for (const href of ['/backoffice/tables', '/backoffice/bookings', '/backoffice/addons']) {
      const got = await see(shop, href, {});
      check('M4 a shop has no ' + href.split('/').pop(), got.error === 'not found', got.error || 'it opened');
    }
    // An address typed by hand, or kept from somewhere, can ask for a day no
    // calendar has. The page then opens on today, as for a day that is not a
    // day at all; the database would refuse the day and the page with it.
    {
      const never = { from: '2026-99-99', to: '2026-02-30', day: '2026-13-45' };
      const dated = [
        '/backoffice', '/backoffice/reports/sales', '/backoffice/reports/day-close', '/backoffice/reports/items', '/backoffice/reports/orders',
        '/backoffice/reports/tax', '/backoffice/reports/timecards', '/backoffice/insights/sales', '/backoffice/insights/menu', '/backoffice/insights/staff',
        // Point of sale's cards take no day; a till's own tabs do, and pos-pages.test.cjs asks them for one no calendar has
        '/backoffice/stock-movements', '/backoffice/pos',
      ];
      const stopped = [];
      for (const href of dated) {
        const got = await see(shop, href, never);
        if (got.error || got.html.length < 200) stopped.push(href + ': ' + (got.error || 'drew nothing'));
      }
      check(`D1 the ${dated.length} pages that take a day open when the address asks for a day no calendar has`, stopped.length === 0, stopped.join(' || '));
      const losses = await see(shop, '/backoffice/reports/stock', { view: 'losses', ...never });
      check('D1 and so does the stock report\'s Losses', !losses.error && losses.html.length > 200, losses.error);
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
      const pay = rowsOf(p.html).filter((r) => /^(Cash|Exchange|Credit note) \|/.test(r));
      // the exchange type is no tender: since 0109 it is not among the methods at all
      check('X1 by payment method, cash holds what changed hands and the exchange is not listed', pay.length === 1 && pay[0].startsWith('Cash | 4 | Rs 637.00'), pay.join(' // '));
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

    // ---- the return policy and credit notes (migration 0109) ----
    {
      const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [shop.tid])).id;
      const noteType = (await one(`select id from payment_types where tenant_id = $1 and kind = 'credit_note' and deleted_at is null`, [shop.tid])).id;
      const priya = (await one(`select id from customers where tenant_id = $1 and name = 'Priya'`, [shop.tid])).id;
      // the shop keeps an exchange's rest on a credit note
      await c.query(`update pos_settings set data = data || '{"returns":"credit","noteMonths":6}'::jsonb where tenant_id = $1`, [shop.tid]);
      p = await see(shop, '/backoffice/settings', {});
      check('Y1 a shop\'s POS settings have the Returns card, set to a credit note', !p.error && p.html.includes('name="returns"') && p.html.includes('value="credit"') && p.html.includes('name="returnDays"') && p.html.includes('name="noteMonths"') && p.says.includes('Return window'), p.error);
      // a scarf (Rs 115.00) back, a mug taken at Rs 50.00: Rs 50.00 to the new sale, Rs 65.00 on a note for Priya
      const y = await shop.sale([{ item_id: scarf }], 11500);
      const rl = await one(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [y.rc, y.ids[0]]);
      const noteNo = 'SP1-T1-CN000001', noteId = id();
      await shop.push([op('refund.create', { id: id(), refund_of: y.rc, store_id: shop.store, device_id: shop.dev, number: 'SP1-T1-R000001', device_seq: 901, device_time: shop.at(20),
        reason: 'exchange', lines: [{ receipt_line_id: rl.id, qty: 1000 }],
        payments: [{ payment_type_id: exch, amount: 5000 }, { payment_type_id: noteType, amount: 6500, reference: noteNo }],
        credit_note: { id: noteId, number: noteNo, amount: 6500, valid_to: '2027-04-14', customer_id: priya } })]);
      await shop.sale([{ item_id: mug, unit_price: 5000, list_price: 11500, price_kind: 'discount', price_label: 'Rs 65.00 off', approved_by: shop.owner }], 5000,
        { payments: [{ payment_type_id: exch, amount: 5000, reference: 'SP1-T1-R000001' }] });
      // Rs 40.00 of the note spent on a hat, cash for the rest
      await shop.sale([{ item_id: hat }], 11500, { payments: [{ payment_type_id: noteType, amount: 4000, reference: noteNo }, { payment_type_id: shop.cash, amount: 7500 }] });
      p = await see(shop, '/backoffice/credit-notes', {});
      const noteRow = rowsOf(p.html).find((r) => r.includes(noteNo));
      check('Y2 Credit notes lists the open note: its amount, what is left, the customer, the sale it was spent on', !p.error && !!noteRow && noteRow.includes('| Rs 65.00 | Rs 25.00 |') && noteRow.includes('Priya') && noteRow.includes('1 sale') && noteRow.includes('Valid to 2027-04-14') && p.says.includes('Rs 25.00 on 1 open note'), p.error || noteRow || p.says.slice(0, 300));
      p = await see(shop, '/backoffice/receipts', {});
      check('Y3 Receipts names the note on the sale that spent it and on the refund that issued it', !p.error && (p.says.match(new RegExp('Credit note ' + noteNo, 'g')) || []).length >= 2 && !p.says.includes('is not covered'), p.error || (p.says.match(/Credit note[^|]{0,60}/g) || []).join(' / '));
      p = await see(shop, '/backoffice/reports/day-close', range);
      check('Y4 Day closing says what was issued and redeemed, and lists neither built-in kind as a method', !p.error && p.says.includes('Credit notes issued Rs 65.00') && p.says.includes('Credit notes redeemed Rs 40.00') && !/Exchange \(\d+\)/.test(p.says) && !/Credit note \(\d+\)/.test(p.says), p.error || (p.says.match(/Credit notes [^R]*Rs [\d.,]+/g) || []).join(' / '));
      p = await see(shop, '/backoffice/reports/sales', range);
      check('Y4 so does Sales summary', !p.error && p.says.includes('Credit notes: Rs 65.00 issued on exchanges, Rs 40.00 redeemed on sales'), p.error || (p.says.match(/Credit notes:[^.]*/) || [])[0]);
      // two tills apart: a second sale takes Rs 50.00 off a note with Rs 25.00 left
      await shop.sale([{ item_id: mug, unit_price: 5000, list_price: 11500, price_kind: 'discount', price_label: 'Rs 65.00 off', approved_by: shop.owner }], 5000,
        { payments: [{ payment_type_id: noteType, amount: 5000, reference: noteNo }] });
      p = await see(shop, '/backoffice/receipts', {});
      check('Y5 a sale that overspent a note is flagged, and the page says by how much', !p.error && p.says.includes(`credit note ${noteNo} had Rs 25 left and this sale took Rs 50: Rs 25 is not covered`), p.error || (p.says.match(/credit note [^.]*not covered[^.]*/) || [p.says.slice(0, 200)])[0]);
      p = await see(shop, '/backoffice/credit-notes', { show: 'closed' });
      const usedRow = rowsOf(p.html).find((r) => r.includes(noteNo));
      check('Y5 the note is used up and among the closed ones', !p.error && !!usedRow && usedRow.includes('| Rs 0.00 |') && usedRow.includes('Used up'), p.error || usedRow);
      // a second note, cancelled by the owner with a reason
      const y2 = await shop.sale([{ item_id: scarf }], 11500);
      const rl2 = await one(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [y2.rc, y2.ids[0]]);
      const note2 = id();
      await shop.push([op('refund.create', { id: id(), refund_of: y2.rc, store_id: shop.store, device_id: shop.dev, number: 'SP1-T1-R000002', device_seq: 902, device_time: shop.at(15),
        reason: 'exchange', lines: [{ receipt_line_id: rl2.id, qty: 1000 }],
        payments: [{ payment_type_id: exch, amount: 5000 }, { payment_type_id: noteType, amount: 6500, reference: 'SP1-T1-CN000002' }],
        credit_note: { id: note2, number: 'SP1-T1-CN000002', amount: 6500 } })]);
      await shop.sale([{ item_id: mug, unit_price: 5000, list_price: 11500, price_kind: 'discount', price_label: 'Rs 65.00 off', approved_by: shop.owner }], 5000,
        { payments: [{ payment_type_id: exch, amount: 5000, reference: 'SP1-T1-R000002' }] });
      await c.query(`select credit_note_void($1, $2, $3, 'slip lost, a new one written')`, [shop.tid, shop.owner, note2]);
      p = await see(shop, '/backoffice/credit-notes', { show: 'closed' });
      const voidRow = rowsOf(p.html).find((r) => r.includes('SP1-T1-CN000002'));
      check('Y6 a cancelled note says so, with its reason', !p.error && !!voidRow && voidRow.includes('Cancelled: slip lost, a new one written') && voidRow.includes('Does not expire') === false, p.error || voidRow);
      p = await see(shop, '/backoffice/credit-notes', { q: 'Priya' });
      check('Y7 the list is searched by customer', !p.error && p.says.includes('No open credit notes') === true || (rowsOf(p.html).every((r) => !r.includes('CN000002'))), p.error);
    }

    // ---- deposits (migration 0113) ----
    {
      p = await see(shop, '/backoffice/settings', {});
      check('D1 without the extra, POS settings say deposits are one, with nothing to set', !p.error && p.says.includes('Deposits are an extra for this shop') && !p.html.includes('name="depositCancel"'), p.error);
      p = await see(shop, '/backoffice/deposits', {});
      check('D1 and Deposits opens, saying so', !p.error && p.says.includes('Deposits are an extra for this shop'), p.error || p.says.slice(0, 200));
      await c.query(`select platform.set_tenant_features($1, $2, array['deposits'])`, [admin, shop.tid]);
      p = await see(shop, '/backoffice/settings', {});
      check('D2 switched on, the Deposits card has its six settings', !p.error && ['depositsOn', 'depositCancel', 'depositDays', 'depositOverdue', 'depositGrace', 'depositCustomer'].every((n) => p.html.includes(`name="${n}"`)), p.error);
      const priya = (await one(`select id from customers where tenant_id = $1 and name = 'Priya'`, [shop.tid])).id;
      const depType = (await one(`select id from payment_types where tenant_id = $1 and kind = 'deposit' and deleted_at is null`, [shop.tid])).id;
      p = await see(shop, '/backoffice/settings', { tab: 'payments' });
      check('D2 the Deposit type is not among the payment options a shop edits, nor the Credit note one', !p.error && !p.html.includes('value="Deposit"') && !p.html.includes('value="Credit note"'), p.error);
      // Priya puts Rs 50.00 down in cash on a scarf and a hat (Rs 230.00)
      const did = id(), l1 = id(), l2 = id(), number = 'SP1-T1-D000001';
      await shop.push([op('deposit.create', { id: did, store_id: shop.store, device_id: shop.dev, number, customer_id: priya, collect_by: '2026-12-31', device_time: shop.at(30),
        lines: [{ id: l1, item_id: scarf, name: 'Scarf', qty: 1000, unit_price: 11500 }, { id: l2, item_id: hat, name: 'Hat', qty: 1000, unit_price: 11500 }],
        payment: { id: id(), payment_type_id: shop.cash, amount: 5000 } })]);
      p = await see(shop, '/backoffice/deposits', {});
      const dRow = rowsOf(p.html).find((r) => r.includes(number));
      // a second customer, with no deposit, so the filter has someone to leave out
      await c.query(`insert into customers (tenant_id, name, phone) values ($1,'Ravi','52509876')`, [shop.tid]);
      p = await see(shop, '/backoffice/customers', {});
      const cRow = rowsOf(p.html).find((r) => r.includes('Priya'));
      check('D3 Customers names her open deposit and what is left to pay', !p.error && !!cRow && cRow.includes(number) && cRow.includes('Rs 180.00 to pay, collect by 2026-12-31'), p.error || cRow);
      p = await see(shop, '/backoffice/customers', { seen: 'deposit' });
      check('D3 and finds who has a deposit', !p.error && rowsOf(p.html).some((r) => r.includes('Priya')) && !rowsOf(p.html).some((r) => r.includes('Ravi')), p.error);
      p = await see(shop, '/backoffice/deposits', {});
      check('D3 Deposits lists it: the customer, the total, what is paid and left to pay', !p.error && !!dRow && dRow.includes('Priya') && dRow.includes('| Rs 230.00 | Rs 50.00 | Rs 180.00 |') && dRow.includes('Open'), p.error || dRow || p.says.slice(0, 300));
      // she collects the scarf: the deposit pays Rs 50.00 of it, cash the rest
      await shop.sale([{ item_id: scarf, deposit_line_id: l1 }], 11500, { payments: [{ payment_type_id: depType, amount: 5000, reference: number }, { payment_type_id: shop.cash, amount: 6500 }] });
      p = await see(shop, '/backoffice/deposits', { id: did });
      check('D4 its page shows the goods, one collected, the payment and the receipt that collected it', !p.error && p.says.includes('1 collected') && /Collected on SP1-/.test(p.says) && p.says.includes('Paid, Cash'), p.error || p.says.slice(0, 400));
      p = await see(shop, '/backoffice/customers', {});
      const cRow2 = rowsOf(p.html).find((r) => r.includes('Priya'));
      check('D4 after the scarf is collected (with the Rs 50.00 of the deposit used on it), the hat is what is left to pay', !p.error && !!cRow2 && cRow2.includes('Rs 115.00 to pay'), p.error || cRow2);
      p = await see(shop, '/backoffice/reports/day-close', range);
      check('D5 Day closing says the deposit taken, and lists no Deposit among the methods', !p.error && /Deposits taken, Cash \(1\) Rs 50\.00/.test(p.says) && p.says.includes('Deposits used on collection Rs 50.00') && !/Deposit \(\d+\)/.test(p.says), p.error || (p.says.match(/Deposits[^R]*Rs [\d.,]+/g) || []).join(' / '));
      p = await see(shop, '/backoffice/reports/sales', range);
      check('D5 so does Sales summary', !p.error && p.says.includes('Deposits: Rs 50.00 taken, Rs 50.00 used on collected goods'), p.error || (p.says.match(/Deposits:[^.]*/) || [])[0]);
      p = await see(shop, '/backoffice/receipts', {});
      check('D5 Receipts names the deposit on the sale it paid', !p.error && p.says.includes(number), p.error);
      // a second deposit, cancelled onto a credit note
      const d2 = id(), n2 = 'SP1-T1-D000002', note = id();
      await shop.push([op('deposit.create', { id: d2, store_id: shop.store, device_id: shop.dev, number: n2, customer_id: priya, collect_by: '2026-12-31', device_time: shop.at(25),
        lines: [{ id: id(), item_id: mug, name: 'Mug', qty: 1000, unit_price: 11500 }], payment: { id: id(), payment_type_id: shop.cash, amount: 3000 } })]);
      await shop.push([op('deposit.cancel', { deposit_id: d2, device_id: shop.dev, device_time: shop.at(24), reason: 'changed her mind', outcome: 'credit',
        credit_note: { id: note, number: n2 + '-CN', amount: 3000 } })]);
      p = await see(shop, '/backoffice/credit-notes', {});
      const nRow = rowsOf(p.html).find((r) => r.includes(n2 + '-CN'));
      check('D6 Credit notes lists the note of the cancelled deposit, naming the deposit', !p.error && !!nRow && nRow.includes(n2) && nRow.includes('a cancelled deposit') && nRow.includes('Rs 30.00'), p.error || nRow);
      p = await see(shop, '/backoffice/deposits', { show: 'all', q: n2 });
      check('D6 Deposits says it was cancelled, why, and that the money is on the note', !p.error && p.says.includes('changed her mind') && p.says.includes('Rs 30.00 on credit note ' + n2 + '-CN'), p.error || p.says.slice(0, 400));
      p = await see(shop, '/backoffice/reports/day-close', range);
      check('D6 Day closing says what went on credit notes', !p.error && p.says.includes('Deposits put on credit notes Rs 30.00'), p.error || (p.says.match(/Deposits[^R]*Rs [\d.,]+/g) || []).join(' / '));
    }

    // ---- customer accounts (migration 0114) ----
    {
      p = await see(shop, '/backoffice/settings', {});
      check('A1 without the extra, POS settings say customer accounts are one, with nothing to set', !p.error && p.says.includes('Customer accounts are an extra for this shop') && !p.html.includes('name="accountDays"'), p.error);
      p = await see(shop, '/backoffice/accounts', {});
      check('A1 and Accounts opens, saying so', !p.error && p.says.includes('Customer accounts are an extra for this shop'), p.error || p.says.slice(0, 200));
      await c.query(`select platform.set_tenant_features($1, $2, array['deposits','accounts'])`, [admin, shop.tid]);
      p = await see(shop, '/backoffice/settings', {});
      check('A2 switched on, the Customer accounts card has its two settings', !p.error && p.html.includes('name="accountsOn"') && p.html.includes('name="accountDays"'), p.error);
      p = await see(shop, '/backoffice/settings', { tab: 'payments' });
      check('A2 the On account type is not among the payment options a shop edits', !p.error && !p.html.includes('value="On account"'), p.error);
      const acct = (await one(`select id from payment_types where tenant_id = $1 and kind = 'account' and deleted_at is null`, [shop.tid])).id;
      const priya = (await one(`select id from customers where tenant_id = $1 and name = 'Priya'`, [shop.tid])).id;
      const ravi = (await one(`select id from customers where tenant_id = $1 and name = 'Ravi'`, [shop.tid])).id;
      await c.query(`insert into customers (tenant_id, name, phone) values ($1,'Nadia','52505555')`, [shop.tid]);
      // a sale on account, as the till sends it: the order names the customer
      let aseq = 800;
      const onAccount = async (who, lines, payments, minsAgo) => {
        const tk = id(), rc = id(), ids = lines.map(() => id());
        aseq++;
        await shop.push([
          op('ticket.create', { id: tk, store_id: shop.store }),
          op('ticket.update_meta', { ticket_id: tk, customer_id: who }),
          ...lines.map((l, i) => op('ticket.add_line', { id: ids[i], ticket_id: tk, qty: 1000, ...l })),
          op('receipt.create', { id: rc, ticket_id: tk, store_id: shop.store, device_id: shop.dev, number: 'SP1-T1-' + aseq, device_seq: aseq, device_time: shop.at(minsAgo), payments }),
        ]);
        return { rc, ids, number: 'SP1-T1-' + aseq };
      };
      // Priya takes a hat on account (Rs 115.00); Ravi a shirt and a belt, Rs 30.00 in cash and Rs 200.00 on account
      const pa = await onAccount(priya, [{ item_id: hat }], [{ payment_type_id: acct, amount: 11500 }], 22);
      const ra = await onAccount(ravi, [{ item_id: shirt }, { item_id: belt }], [{ payment_type_id: shop.cash, amount: 3000 }, { payment_type_id: acct, amount: 20000 }], 21);
      // Priya pays Rs 50.00 of it in cash at the till
      await shop.push([op('account.pay', { id: id(), number: 'SP1-T1-A000001', customer_id: priya, store_id: shop.store, device_id: shop.dev, device_time: shop.at(20),
        payment: { payment_type_id: shop.cash, amount: 5000 }, lines: [{ bill_id: pa.rc, amount: 5000 }] })]);
      p = await see(shop, '/backoffice/customers', {});
      const pRow = rowsOf(p.html).find((r) => r.includes('| Priya |'));
      const rRow = rowsOf(p.html).find((r) => r.includes('| Ravi |'));
      check('A3 Customers says what each owes on account', !p.error && !!pRow && pRow.endsWith('| Rs 65.00') && !!rRow && rRow.endsWith('| Rs 200.00'), p.error || pRow + ' / ' + rRow);
      p = await see(shop, '/backoffice/customers', { seen: 'owes' });
      check('A3 and finds who owes money', !p.error && rowsOf(p.html).some((r) => r.includes('| Priya |')) && rowsOf(p.html).some((r) => r.includes('| Ravi |')) && !rowsOf(p.html).some((r) => r.includes('| Nadia |')), p.error);
      p = await see(shop, '/backoffice/accounts', {});
      check('A4 Accounts: Rs 265.00 owed by two customers, nothing overdue', !p.error && stats(p.html).join(' | ') === 'Total owed: Rs 265.00 | Customers owing: 2 | Unpaid past 30 days: Rs 0.00', p.error || stats(p.html).join(' | '));
      const aRows = rowsOf(p.html);
      check('A4 one line each, the most owed first, with the oldest bill and the balance', !p.error && aRows[1]?.startsWith('Ravi') && aRows[1]?.includes('| 1 |') && aRows[1]?.includes('| Rs 200.00 |') && aRows[2]?.startsWith('Priya') && aRows[2]?.includes('| Rs 65.00 |') && aRows[2]?.includes('0 days'),
        p.error || aRows.slice(0, 4).join(' // '));
      const acc = (who) => see(shop, '/backoffice/accounts/' + who, {}, { params: { customer: who }, file: 'backoffice/accounts/[customer]' });
      p = await acc(priya);
      const billRow = rowsOf(p.html).find((r) => r.startsWith(pa.number));
      check('A5 her account: the bill, Rs 50.00 paid on it, Rs 65.00 still owed, and the payment under it', !p.error && !!billRow && billRow.includes('| Rs 115.00 | Rs 50.00 |  | Rs 65.00') && p.says.includes('Paid, Cash · SP1-T1-A000001'), p.error || billRow || p.says.slice(0, 300));
      const led = rowsOf(p.html).filter((r) => r.includes('Sale on account') || r.includes('SP1-T1-A000001 Cash'));
      check('A5 the account\'s lines: the sale (debit), the payment (credit), the balance after each', !p.error && led.length === 2 && led[0].endsWith('| Rs 115.00 |  | Rs 115.00') && led[1].endsWith('|  | Rs 50.00 | Rs 65.00'), p.error || led.join(' // '));
      check('A5 the lines and the bills agree', !p.says.includes("The account's lines come to"));
      p = await see(shop, '/backoffice/accounts/' + priya + '/statement', {}, { params: { customer: priya }, file: 'backoffice/accounts/[customer]/statement' });
      check('A6 her statement: the shop, STATEMENT OF ACCOUNT, her, the bill and Rs 65.00 owed', !p.error && p.says.includes('Pages Shop') && p.says.includes('STATEMENT OF ACCOUNT') && p.says.includes('Priya')
        && rowsOf(p.html).some((r) => r.includes(pa.number) && r.endsWith('| Rs 115.00 | Rs 50.00 | Rs 65.00')) && rowsOf(p.html).some((r) => r === 'Balance owed | Rs 65.00'), p.error || p.says.slice(0, 400));
      // Ravi's bill is from 45 days ago
      await c.query(`update account_bills set day = day - 45 where id = $1`, [ra.rc]);
      p = await see(shop, '/backoffice/accounts', {});
      check('A7 forty-five days old, his Rs 200.00 is unpaid past 30 days', !p.error && stats(p.html).join(' | ').endsWith('Unpaid past 30 days: Rs 200.00'), p.error || stats(p.html).join(' | '));
      p = await see(shop, '/backoffice/accounts', { tab: 'exceptions' });
      check('A7 and Exceptions lists him as overdue', !p.error && rowsOf(p.html).some((r) => r.startsWith('Ravi') && r.includes('| 1 |') && r.endsWith('| Rs 200.00')), p.error || rowsOf(p.html).join(' // '));
      p = await acc(ravi);
      const agedRow = rowsOf(p.html).find((r) => r.startsWith('Rs 200.00 |'));
      check('A7 his account ages it: Rs 200.00 under 31–60 days', !p.error && agedRow === 'Rs 200.00 |  | Rs 200.00 |  | ', p.error || agedRow);
      await c.query(`update account_bills set day = day + 45 where id = $1`, [ra.rc]);
      p = await see(shop, '/backoffice/reports/day-close', range);
      check('A8 Day closing says what was sold on account and paid on accounts, and lists no On account among the methods', !p.error && p.says.includes('Sold on account Rs 315.00') && p.says.includes('Paid on accounts, Cash (1) Rs 50.00') && !/On account \(\d+\)/.test(p.says),
        p.error || (p.says.match(/(Sold on account|Paid on accounts)[^R]*Rs [\d.,]+/g) || []).join(' / '));
      p = await see(shop, '/backoffice/reports/sales', range);
      check('A9 Sales summary says how much of the sales went on accounts, and what was paid on them', !p.error && p.says.includes('Rs 315.00 of these sales went on customers\' accounts') && p.says.includes('Rs 50.00 was paid on accounts in these days')
        && /Total collected Rs [\d.,]+ [^|]*Rs 315\.00 of it on account, not yet paid/.test(p.says), p.error || (p.says.match(/Customer accounts:[^.]*/) || [])[0]);
      check('A9 and no On account among its payment methods', !rowsOf(p.html).some((r) => r.startsWith('On account |')));
      p = await see(shop, '/backoffice', range);
      const mix = (p.says.split('Payment methods How the money came in')[1] || '').split('Who took the payments')[0];
      check('A9 nor among the dashboard\'s payment methods (the receipts it lists may say how each was paid)', !p.error && mix.length > 0 && !mix.includes('On account'), p.error || mix.slice(0, 300));
      p = await see(shop, '/backoffice/receipts', {});
      check('A10 Receipts says a sale was put on account', !p.error && p.says.includes('On account'), p.error);
      // Priya brings the hat back: Rs 65.00 comes off what she owes, Rs 50.00 (what she paid) back in cash
      await c.query(`update pos_settings set data = data || '{"returns":"refund"}'::jsonb where tenant_id = $1`, [shop.tid]);
      const rl = await one(`select id from receipt_lines where receipt_id = $1`, [pa.rc]);
      const rf = id();
      await shop.push([op('refund.create', { id: rf, refund_of: pa.rc, store_id: shop.store, device_id: shop.dev, number: 'SP1-T1-R000801', device_seq: 950, device_time: shop.at(18),
        reason: 'wrong size', lines: [{ receipt_line_id: rl.id, qty: 1000 }], payments: [{ payment_type_id: acct, amount: 6500 }, { payment_type_id: shop.cash, amount: 5000 }] })]);
      check('A11 the return took Rs 65.00 off her bill, and nothing to check', Number((await one(`select account_owed(b) as o from account_bills b where id = $1`, [pa.rc])).o) === 0
        && (await c.query(`select 1 from receipt_reviews where receipt_id = $1`, [rf])).rowCount === 0);
      p = await acc(priya);
      const led2 = rowsOf(p.html).filter((r) => r.includes('Goods returned from'));
      check('A11 her account: the return a credit, the balance nothing', !p.error && p.says.includes('Nothing is owed') && led2.length === 1 && led2[0].endsWith('|  | Rs 65.00 | Rs 0.00'), p.error || led2.join(' // '));
      p = await see(shop, '/backoffice/accounts', {});
      check('A11 and she is no longer on Accounts', !p.error && !rowsOf(p.html).some((r) => r.startsWith('Priya')), p.error);
      // Ravi pays Rs 250.00 on his Rs 200.00 bill (two tills took it): paid over
      await shop.push([op('account.pay', { id: id(), number: 'SP1-T1-A000002', customer_id: ravi, store_id: shop.store, device_id: shop.dev, device_time: shop.at(17),
        payment: { payment_type_id: shop.cash, amount: 25000 }, lines: [{ bill_id: ra.rc, amount: 25000 }] })]);
      p = await see(shop, '/backoffice/accounts', { tab: 'exceptions' });
      check('A12 Exceptions: his bill is paid over by Rs 50.00, and the payment is to check', !p.error && rowsOf(p.html).some((r) => r.startsWith(ra.number) && r.endsWith('| Rs 50.00')) && p.says.includes('Paid more than it owed'), p.error || rowsOf(p.html).join(' // '));
      p = await see(shop, '/backoffice/customers', {});
      check('A12 Customers says Rs 50.00 paid over', !p.error && (rowsOf(p.html).find((r) => r.includes('| Ravi |')) || '').endsWith('| Rs 50.00 paid over'), p.error);
      p = await see(shop, '/backoffice/accounts/' + ravi + '/statement', {}, { params: { customer: ravi }, file: 'backoffice/accounts/[customer]/statement' });
      check('A12 his statement shows it in brackets, and says why', !p.error && rowsOf(p.html).some((r) => r.endsWith('| (Rs 50.00)')) && p.says.includes('a figure in brackets was paid over'), p.error || p.says.slice(0, 400));
    }

    // ---- promotions (migration 0110) ----
    {
      p = await see(shop, '/backoffice/promotions', {});
      check('Z1 Promotions opens for a shop, with nothing quiet yet (every product is new)', !p.error && p.says.includes('Nothing has gone quiet') && p.says.includes('No promotions are running'), p.error || p.says.slice(0, 200));
      // the scarf was added forty days ago and sold nothing since: a slow mover
      await c.query(`update items set created_at = now() - interval '40 days' where id = $1`, [scarf]);
      await c.query(`delete from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'sale'`, [shop.tid, scarf]);
      p = await see(shop, '/backoffice/promotions', {});
      let row = rowsOf(p.html).find((r) => r.startsWith('Scarf'));
      check('Z2 a product with stock and no sale for forty days is a slow mover, with its idle days and price', !p.error && !!row && /\| 40 days \|/.test(row) && row.includes('Rs 115.00'), p.error || row || p.says.slice(0, 300));
      await c.query(`select promotion_apply($1, $2, $3, null, 9000, 'clear it')`, [shop.tid, shop.owner, scarf]);
      p = await see(shop, '/backoffice/promotions', {});
      row = rowsOf(p.html).find((r) => r.startsWith('Scarf'));
      check('Z3 on promotion: Was Rs 115.00 struck through, Now Rs 90.00, Rs 25.00 off, and no longer a slow mover', !p.error && !!row && row.includes('| Rs 115.00 | Rs 90.00 | Rs 25.00 |') && !p.says.includes('days idle') && (rowsOf(p.html).filter((r) => r.startsWith('Scarf')).length === 1), p.error || row);
      const pid = (await one(`select id from promotions where tenant_id = $1 and item_id = $2 and status = 'active'`, [shop.tid, scarf])).id;
      await c.query(`select promotion_lift($1, $2, $3)`, [shop.tid, shop.owner, pid]);
      p = await see(shop, '/backoffice/promotions', {});
      check('Z4 lifted: back among the slow movers at Rs 115.00, no promotion running', !p.error && p.says.includes('No promotions are running') && (rowsOf(p.html).find((r) => r.startsWith('Scarf')) || '').includes('Rs 115.00'), p.error);
      p = await see(shop, '/backoffice/settings', {});
      check('Z5 a shop\'s POS settings carry the two thresholds', !p.error && p.html.includes('name="slowMoverDays"') && p.html.includes('name="promoStillDays"'), p.error);
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
    for (const href of ['/backoffice/reports/stock', '/backoffice/purchase-orders', '/backoffice/stock-counts', '/backoffice/items/import', '/backoffice/items/labels']) {
      const got = await see(rest, href, {});
      check('R6 a restaurant has no ' + href.split('/').pop(), got.error === 'not found', got.error || 'it opened');
    }
    p = await see(rest, '/backoffice/settings', { tab: 'barcodes' });
    check('R7 a restaurant\'s POS settings have no Barcodes tab, and its address shows General', !p.error && !p.says.includes('Your own barcodes') && !p.html.includes('tab=barcodes') && p.says.includes('Decimals'), p.error);
    check('R7 nor a Returns card', !p.html.includes('name="returns"'));
    p = await see(rest, '/backoffice/credit-notes', {});
    check('R8 a restaurant has no credit-notes', p.error === 'not found', p.error || 'it opened');
    p = await see(rest, '/backoffice/deposits', {});
    check('R9 a restaurant has no deposits', p.error === 'not found', p.error || 'it opened');
    p = await see(rest, '/backoffice/promotions', {});
    check('R8 nor promotions', p.error === 'not found', p.error || 'it opened');
    p = await see(rest, '/backoffice/accounts', {});
    check('R9 nor customer accounts', p.error === 'not found', p.error || 'it opened');
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
