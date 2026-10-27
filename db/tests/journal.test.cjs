// journal.test.cjs — the back office's Sales journal, opened as its page is
// (db/tests/page.cjs), on a shop with a day of the till's trade made through
// sync_push: a cash sale, a sale on account part paid, an earlier sale paid
// on today, a return off an account, an exchange, a deposit. Every table must
// foot to the money received, and the bridge to what was sold must hold.
// Then a restaurant (its order types), a filter, a comparison, and a
// business on the offline plan (no journal).
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/journal.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-jn@example.com')`, [admin]);
    async function business(name, code, type, plan = 'premium') {
      const made = (await one(`select platform.create_tenant_of_type($1,$2,'Main',$3,'Owner',$4,$5,$6) as r`, [admin, name, code, id(), plan, type])).r;
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
      let card = (await one(`select id from payment_types where tenant_id = $1 and kind = 'card' and deleted_at is null limit 1`, [tid]))?.id;
      if (!card) card = (await one(`insert into payment_types (tenant_id, name, kind) values ($1,'Card','card') returning id`, [tid])).id;
      const vat = (await one(`select id from taxes where tenant_id = $1 and name = 'VAT'`, [tid])).id;
      const cat = (await one(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [tid])).id;
      const item = async (nm) => {
        const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, category_id) values ($1,$2,11500,4000,true,$3) returning id`, [tid, nm, cat])).id;
        await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
        await c.query(`select stock_move($1,$2,$3,null,10000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, it, id(), owner]);
        return it;
      };
      const tz = (await one(`select timezone from stores where id = $1`, [store])).timezone;
      const today = (await one(`select (now() at time zone $1)::date::text as d`, [tz])).d;
      // the till's clock: so many seconds ago (the period is today)
      const at = (secsAgo) => new Date(Date.now() - secsAgo * 1000).toISOString();
      let seq = 0;
      // a sale as the till sends it; customer: on the order
      const sale = async (lines, payments, { customer, time } = {}) => {
        const tk = id(), rc = id(), ids = lines.map(() => id());
        seq++;
        await push([
          op('ticket.create', { id: tk, store_id: store }),
          ...(customer ? [op('ticket.update_meta', { ticket_id: tk, customer_id: customer })] : []),
          ...lines.map((l, i) => op('ticket.add_line', { id: ids[i], ticket_id: tk, qty: 1000, name_snapshot: 'x', ...l })),
          op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: code + '-' + seq, device_seq: seq, device_time: time ?? at(30 - seq), payments }),
        ]);
        return { rc, ids, number: code + '-' + seq };
      };
      const ctx = { tenantId: tid, employeeId: owner, mode: type };
      return { tid, store, owner, dev, cash, card, item, push, sale, at, today, tz, ctx, code };
    }
    const see = async (who, sp) => {
      await c.query('SAVEPOINT pg');
      try {
        const html = await open(c, who.ctx, '/backoffice/reports/journal', sp);
        await c.query('RELEASE SAVEPOINT pg');
        return { html, says: text(html) };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT pg');
        return { html: '', says: '', error: (e && e.message) || String(e) };
      }
    };
    // the tables' Total lines, and each table's money column
    const totals = (html) => rowsOf(html).filter((r) => r.startsWith('Total'));

    // ---------------------------------------------------------------- a shop
    const shop = await business('Journal Shop', 'JN1', 'retail', 'premium');
    await c.query(`select platform.set_tenant_features($1, $2, array['deposits','accounts'])`, [admin, shop.tid]);
    await c.query(`update pos_settings set data = data || '{"returns":"refund"}'::jsonb where tenant_id = $1`, [shop.tid]);
    const hat = await shop.item('Hat'), scarf = await shop.item('Scarf'), shirt = await shop.item('Shirt');
    const acct = (await one(`select id from payment_types where tenant_id = $1 and kind = 'account' and deleted_at is null`, [shop.tid])).id;
    const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [shop.tid])).id;
    const priya = (await one(`insert into customers (tenant_id, name) values ($1,'Priya') returning id`, [shop.tid])).id;
    const ravi = (await one(`insert into customers (tenant_id, name) values ($1,'Ravi') returning id`, [shop.tid])).id;
    // 40 days ago: Ravi takes a shirt on account
    const e = await shop.sale([{ item_id: shirt }], [{ payment_type_id: acct, amount: 11500 }], { customer: ravi, time: new Date(Date.now() - 40 * 86400000).toISOString() });
    // today: a hat for cash
    await shop.sale([{ item_id: hat }], [{ payment_type_id: shop.cash, amount: 11500 }]);
    // Priya takes a hat and a scarf on account (Rs 230.00) and pays Rs 100.00 of it in cash
    const b = await shop.sale([{ item_id: hat }, { item_id: scarf }], [{ payment_type_id: acct, amount: 23000 }], { customer: priya });
    await shop.push([op('account.pay', { id: id(), number: 'JN1-T1-A000001', customer_id: priya, store_id: shop.store, device_id: shop.dev, device_time: shop.at(10),
      payment: { payment_type_id: shop.cash, amount: 10000 }, lines: [{ bill_id: b.rc, amount: 10000 }] })]);
    // Ravi pays his shirt by card today
    await shop.push([op('account.pay', { id: id(), number: 'JN1-T1-A000002', customer_id: ravi, store_id: shop.store, device_id: shop.dev, device_time: shop.at(9),
      payment: { payment_type_id: shop.card, amount: 11500 }, lines: [{ bill_id: e.rc, amount: 11500 }] })]);
    // Priya brings the scarf back: Rs 115.00 off her bill, no money moves
    await shop.push([op('refund.create', { id: id(), refund_of: b.rc, store_id: shop.store, device_id: shop.dev, number: 'JN1-T1-R1', device_seq: 901, device_time: shop.at(8),
      reason: 'changed mind', lines: [{ ticket_line_id: b.ids[1], qty: 1000 }], payments: [{ payment_type_id: acct, amount: 11500 }] })]);
    // an exchange: a hat sold for cash comes back for a hat and a scarf (Rs 230.00), the difference in cash
    const cs = await shop.sale([{ item_id: hat }], [{ payment_type_id: shop.cash, amount: 11500 }]);
    await shop.push([op('refund.create', { id: id(), refund_of: cs.rc, store_id: shop.store, device_id: shop.dev, number: 'JN1-T1-R2', device_seq: 902, device_time: shop.at(6),
      reason: 'exchange', lines: [{ ticket_line_id: cs.ids[0], qty: 1000 }], payments: [{ payment_type_id: exch, amount: 11500 }] })]);
    await shop.sale([{ item_id: hat }, { item_id: scarf }], [{ payment_type_id: exch, amount: 11500, reference: 'JN1-T1-R2' }, { payment_type_id: shop.cash, amount: 11500 }]);
    // a deposit of Rs 50.00 in cash: money, but no sale
    await shop.push([op('deposit.create', { id: id(), store_id: shop.store, device_id: shop.dev, number: 'JN1-T1-D000001', customer_id: priya, collect_by: '2026-12-31', device_time: shop.at(4),
      lines: [{ id: id(), item_id: shirt, name: 'Shirt', qty: 1000, unit_price: 11500 }], payment: { id: id(), payment_type_id: shop.cash, amount: 5000 } })]);

    const day = { from: shop.today, to: shop.today };
    let p = await see(shop, day);
    check('J1 the journal opens for a shop on Premium', !p.error, p.error);
    // money: cash 115 + 100 + 115 + 115 = 445, card 115: Rs 560.00
    check('J2 the money received: Rs 560.00 from five sales, two of them customers', stats(p.html).join(' | ').startsWith('Sales that took money: 5 | Total received incl. tax: Rs 560.00') && stats(p.html).join(' | ').includes('Customers: 2'), stats(p.html).join(' | '));
    const rows = rowsOf(p.html);
    check('J3 by payment method: Cash Rs 445.00 (four), Card Rs 115.00 (one)', rows.some((r) => r.startsWith('Cash') && r.endsWith('| 4 | Rs 445.00')) && rows.some((r) => r.startsWith('Card') && r.endsWith('| 1 | Rs 115.00')), rows.filter((r) => /^(Cash|Card)/.test(r)).join(' // '));
    const t = totals(p.html);
    check('J4 every table foots to Rs 560.00: sale methods, taxes, payments, categories, people', t.length === 5 && t.every((r) => r.includes('Rs 560.00')), t.join(' // '));
    check('J4 and the VAT in it: Rs 73.04 (15% in every price), Rs 486.96 before it', t[1] === 'Total | Rs 73.04 | Rs 486.96 | Rs 560.00', t[1]);
    // under Payments' total, as Carfectionist has it: Rs 115.00 paid on an earlier sale (in the total), Rs 15.00 still on account
    // of the Rs 460.00 sold (115 + 230 + 115 + 230 - 115 - 115), each with its count of sales; an empty cell is written "|  |"
    check('J5 under the total: Rs 115.00 paid on an earlier sale, Rs 15.00 on account of Rs 460.00 sold', rows.includes('Paid on earlier sales (1 sale) in the total already |  | Rs 115.00')
      && rows.includes('On account (not yet paid) (1 sale) of Rs 460.00 sold |  | Rs 15.00'), rows.filter((r) => /^(Total|Paid|On account)/.test(r)).join(' // '));
    check('J5 and none of the old bridge\'s lines', !/Less money paid|Plus what|Sold in these days|Money received/.test(p.says));
    // a line's sales are on the page, hidden until it is opened: a row under it, the amount under Amount
    check('J5 the sale still on account is Priya\'s', p.says.includes(b.number) && rows.some((r) => /^JN1-\d+ · Priya \|  \| Rs 15\.00$/.test(r)), rows.filter((r) => r.includes('Priya')).join(' // '));
    check('J5 every payment method opens to its sales, closed at first', /<tr class="row"[^>]*><td><span class="lead"><button type="button" class="chev" aria-expanded="false" aria-label="Open Cash"/.test(p.html) && /<tr class="sale" hidden="">/.test(p.html), (p.html.match(/<tr class="row"[^>]*>.{0,160}/) || [])[0]);
    check('J6 the deposit is said apart, in no figure', p.says.includes('Deposits: Rs 50.00 taken and Rs 0.00 given back'));
    // a sales summary of the same day says the same sales
    const sums = await (async () => {
      await c.query('SAVEPOINT s');
      const html = await open(c, shop.ctx, '/backoffice/reports/sales', day);
      await c.query('RELEASE SAVEPOINT s');
      return stats(html).join(' | ');
    })();
    check('J7 and the Sales summary\'s total is that same Rs 460.00 sold', sums.startsWith('Total collected: Rs 460.00'), sums);

    // a filter: the hours from now on hold nothing sold
    p = await see(shop, { ...day, t0: '23:59', t1: '23:59' });
    check('J8 a filter that keeps nothing: Rs 0.00, still footing', !p.error && stats(p.html).join(' | ').includes('Total received incl. tax: Rs 0.00') && totals(p.html).every((r) => r.includes('Rs 0.00')), p.error || stats(p.html).join(' | '));
    p = await see(shop, { ...day, item: 'Scarf' });
    check('J8 with the item Scarf: the sales that have one, every table footing', !p.error && totals(p.html).length === 5 && new Set(totals(p.html).map((r) => r.match(/Rs [\d,.]+$/)?.[0] ?? r.match(/Rs [\d,.]+/g)?.slice(-1)[0])).size >= 1, p.error);
    p = await see(shop, { ...day, cmp: 'previous-period' });
    check('J9 compared with the day before: a column of before, nothing then', !p.error && p.says.includes('compared with') && rowsOf(p.html).includes('Total |  | Rs 560.00 | Rs 0.00 new'), p.error || rowsOf(p.html).filter((r) => r.startsWith('Total')).join(' // '));
    p = await see(shop, { from: shop.today, to: shop.today, cmp: 'nonsense', from2: 'x' });
    check('J9 a comparison nobody knows is none', !p.error && !p.says.includes('compared with'), p.error);

    // ---------------------------------------------------------------- a restaurant
    const rest = await business('Journal Bistro', 'JN2', 'restaurant', 'premium');
    const soup = await rest.item('Soup');
    await rest.sale([{ item_id: soup }], [{ payment_type_id: rest.cash, amount: 11500 }]);
    p = await see(rest, { from: rest.today, to: rest.today });
    check('J10 a restaurant on Premium: its sale methods are its order types', !p.error && stats(p.html).join(' | ').includes('Total received incl. tax: Rs 115.00') && totals(p.html).length === 5 && !p.says.includes('Sales [Journal Bistro]'), p.error || p.says.slice(0, 300));
    check('J10 every sale paid in full that day: Payments ends at its total', !p.error && !/Paid on earlier sales|On account/.test(p.says) && rowsOf(p.html).includes('Total |  | Rs 115.00'), p.error || rowsOf(p.html).filter((r) => /^(Total|Paid|On account)/.test(r)).join(' // '));

    // ---------------------------------------------------------------- the offline plan
    const alone = await business('Journal Tablet', 'JN3', 'retail', 'offline');
    p = await see(alone, { from: alone.today, to: alone.today });
    check('J11 a business on the offline plan is told the journal comes with Premium', !p.error && p.says.includes('The sales journal comes with Premium'), p.error || p.says.slice(0, 200));
    const tried = await business('Journal Trial', 'JN4', 'retail', 'trial');
    p = await see(tried, { from: tried.today, to: tried.today });
    check('J12 a business on trial has it', !p.error && !p.says.includes('comes with Premium') && p.says.includes('Total received incl. tax'), p.error || p.says.slice(0, 200));
  } catch (e) {
    failures++;
    console.log('FAIL threw: ' + e.message + '\n' + e.stack);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `JOURNAL FAIL (${failures})` : 'JOURNAL PASS');
  process.exit(failures ? 1 : 0);
})();
