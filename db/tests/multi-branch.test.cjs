// multi-branch.test.cjs — one account, two branches (docs/superpowers/specs/2026-10-27-multi-branch-design.md).
// A restaurant with Main and Port Louis, a till in each, sales made at both through sync_push; and a restaurant
// with one branch, for which nothing may change. It says that the back office's branch picker (the bo-branch
// cookie, stood in for by ctx.branch) filters the reports and the dashboard, that All branches adds a By branch
// table, that a pick that is not one of the account's branches reads as All branches, and that every page that
// reads the reports' receipts still opens, for one branch and for two.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/multi-branch.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mb@example.com')`, [admin]);

    // a restaurant: Main, made with the account, and Port Louis, added by EasyPay
    const made = (await one(`select platform.create_tenant_of_type($1,'Branch Bistro','Main','MB1','Owner',$2,'premium','restaurant') as r`, [admin, id()])).r;
    const tid = made.tenant_id, main = made.store_id, owner = made.employee_id;
    const pl = (await one(`select platform.add_store($1,$2,'Port Louis','PL') as s`, [admin, tid])).s;
    const asTill = async (tenant, emp, ops) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      try {
        const out = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r;
        const bad = out.filter((o) => o.status !== 'applied');
        if (bad.length) throw new Error('the server refused ' + JSON.stringify(bad));
        return out;
      } finally { await c.query('RESET ROLE'); }
    };
    const push = (ops) => asTill(tid, owner, ops);
    const tillMain = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Main till','M1') returning id`, [tid, main])).id;
    const tillPl = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Port Louis till','P1') returning id`, [tid, pl])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
    const cat = (await one(`insert into categories (tenant_id, name) values ($1,'Grill') returning id`, [tid])).id;
    const item = async (nm) => (await one(`insert into items (tenant_id, name, price, category_id) values ($1,$2,11500,$3) returning id`, [tid, nm, cat])).id;
    const grill = await item('Mix grill'), lassi = await item('Lassi');
    const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
    let seq = 0;
    // an order at a branch's till: lines as [item, qty in thousandths], paid in cash on one receipt
    const order = async (store, dev, code, lines) => {
      const tk = id(), rc = id();
      const amount = lines.reduce((a, [, q]) => a + (11500 * q) / 1000, 0);
      await push([
        op('ticket.create', { id: tk, store_id: store }),
        ...lines.map(([it, qty]) => op('ticket.add_line', { id: id(), ticket_id: tk, item_id: it, qty })),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: code + '-' + (++seq), device_seq: seq, device_time: at(60 - seq),
          payments: [{ payment_type_id: cash, amount }] }),
      ]);
      return rc;
    };
    await push([op('shift.open', { id: id(), device_id: tillMain, opening_float: 0, opened_at: at(70) })]);
    await push([op('shift.open', { id: id(), device_id: tillPl, opening_float: 0, opened_at: at(70) })]);
    // Main: a Mix grill, then another (Rs 230.00 on two receipts). Port Louis: one Lassi (Rs 115.00).
    await order(main, tillMain, 'M1', [[grill, 1000]]);
    await order(main, tillMain, 'M1', [[grill, 1000]]);
    await order(pl, tillPl, 'P1', [[lassi, 1000]]);

    // a restaurant with one branch, and one sale
    const solo = (await one(`select platform.create_tenant_of_type($1,'Solo Grill','Main','MB2','Owner',$2,'premium','restaurant') as r`, [admin, id()])).r;
    const soloTill = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Counter','S1') returning id`, [solo.tenant_id, solo.store_id])).id;
    const soloCash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [solo.tenant_id])).id;
    const soloItem = (await one(`insert into items (tenant_id, name, price) values ($1,'Dholl puri',5000) returning id`, [solo.tenant_id])).id;
    {
      const tk = id();
      await asTill(solo.tenant_id, solo.employee_id, [
        op('shift.open', { id: id(), device_id: soloTill, opening_float: 0, opened_at: at(70) }),
        op('ticket.create', { id: tk, store_id: solo.store_id }),
        op('ticket.add_line', { id: id(), ticket_id: tk, item_id: soloItem, qty: 1000 }),
        op('receipt.create', { id: id(), ticket_id: tk, store_id: solo.store_id, device_id: soloTill, number: 'S1-1', device_seq: 1, device_time: at(30),
          payments: [{ payment_type_id: soloCash, amount: 5000 }] }),
      ]);
    }

    const base = { tenantId: tid, employeeId: owner, mode: 'restaurant', premium: true, mra: 'off' };
    const soloCtx = { tenantId: solo.tenant_id, employeeId: solo.employee_id, mode: 'restaurant', premium: true, mra: 'off' };
    let see = async (who, href, sp, more) => {
      await c.query('SAVEPOINT pg');
      try {
        const html = await open(c, who, href, sp, more);
        await c.query('RELEASE SAVEPOINT pg');
        return { html, says: text(html) };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT pg');
        return { html: '', says: '', error: (e && e.message) || String(e) };
      }
    };
    // MB_DUMP=<folder>: the pages drawn are also written there as HTML, to be looked at with the real stylesheet
    if (process.env.MB_DUMP) {
      const fs = require('fs');
      const draw = see;
      let n = 0;
      see = async (who, href, sp, more) => {
        const p = await draw(who, href, sp, more);
        if (p.html) fs.writeFileSync(require('path').join(process.env.MB_DUMP, `${String(++n).padStart(2, '0')}${href.replace(/\W+/g, '-')}${who.branch ? '-picked' : ''}.html`), p.html);
        return p;
      };
    }
    const d = await one(`select (now() at time zone timezone - interval '1 day')::date::text as from, (now() at time zone timezone)::date::text as to from stores where id = $1`, [main]);
    const days = { from: d.from, to: d.to };
    const total = (html) => (stats(html).find((s) => s.startsWith('Total collected')) || '');

    // ---- B0: every page that reads the reports' receipts opens, for one branch and for two, at each pick ----
    const customer = (await one(`insert into customers (tenant_id, name) values ($1,'Ravi') returning id`, [tid])).id;
    const soloCustomer = (await one(`insert into customers (tenant_id, name) values ($1,'Mia') returning id`, [solo.tenant_id])).id;
    const pages = (cu, till) => [
      ['/backoffice', {}],
      ['/backoffice/reports/sales', days], ['/backoffice/reports/items', days], ['/backoffice/reports/orders', days],
      ['/backoffice/reports/tax', days], ['/backoffice/reports/journal', days], ['/backoffice/reports/day-close', days],
      ['/backoffice/reports/timecards', days], ['/backoffice/reports/stock', days],
      ['/backoffice/insights/menu', days], ['/backoffice/insights/sales', days], ['/backoffice/insights/staff', days],
      ['/backoffice/pos', {}], ['/backoffice/mra', {}],
      ['/backoffice/customers/' + cu, {}, { params: { customer: cu }, file: 'backoffice/customers/[customer]' }],
      ['/backoffice/pos/' + till, {}, { params: { till }, file: 'backoffice/pos/[till]' }],
    ];
    const broke = [];
    for (const [who, cu, till, picks] of [
      [soloCtx, soloCustomer, soloTill, [null]],
      [base, customer, tillMain, [null, main, pl]],
    ]) {
      for (const pick of picks) {
        for (const [href, sp, more] of pages(cu, till)) {
          const p = await see({ ...who, branch: pick ?? undefined }, href, sp, more);
          // a page this account has no business with may answer "not found" or send elsewhere; a query may not fail
          if (p.error && p.error !== 'not found' && !p.error.startsWith('redirect ')) broke.push(`${href} [${pick ?? 'all'}]: ${p.error}`);
        }
      }
    }
    check('B0 every page that reads the reports opens, one branch and two, at each pick', broke.length === 0, broke.join(' || '));

    // ---- B1, B2: Sales, all branches and one ----
    let p = await see(base, '/backoffice/reports/sales', days);
    check('B1 Sales with no branch picked: both branches', !p.error && total(p.html) === 'Total collected: Rs 345.00', p.error || total(p.html));
    const byBranch = rowsOf(p.html).filter((r) => r.startsWith('Main') || r.startsWith('Port Louis'));
    check('B1 and a By branch table with each', p.says.includes('By branch') && byBranch.some((r) => r.startsWith('Main') && r.includes('Rs 230.00')) && byBranch.some((r) => r.startsWith('Port Louis') && r.includes('Rs 115.00')), byBranch.join(' || '));
    check('B1 the picker is there, on All branches', p.html.includes('data-branch-picker') && p.says.includes('All branches'));
    p = await see({ ...base, branch: pl }, '/backoffice/reports/sales', days);
    check('B2 Sales with Port Louis picked: Port Louis only', !p.error && total(p.html) === 'Total collected: Rs 115.00', p.error || total(p.html));
    check('B2 and no By branch table', !p.says.includes('By branch'));

    // ---- B3: Orders, with a Branch column ----
    p = await see(base, '/backoffice/reports/orders', days);
    check('B3 Orders lists the three receipts', !p.error && (p.html.match(/<details/g) || []).length === 3, p.error || (p.html.match(/<details/g) || []).length);
    check('B3 each says its branch', p.says.includes('Port Louis') && p.says.includes('Main'));
    p = await see({ ...base, branch: main }, '/backoffice/reports/orders', days);
    check('B3 with Main picked, Main\'s two', !p.error && (p.html.match(/<details/g) || []).length === 2, p.error || (p.html.match(/<details/g) || []).length);

    // ---- B4: a pick that is not one of this account's branches is All branches ----
    p = await see({ ...base, branch: 'nonsense' }, '/backoffice/reports/sales', days);
    check('B4 a pick that is not an id reads as All branches', total(p.html) === 'Total collected: Rs 345.00', p.error || total(p.html));
    p = await see({ ...base, branch: solo.store_id }, '/backoffice/reports/sales', days);
    check('B4 another account\'s branch reads as All branches', total(p.html) === 'Total collected: Rs 345.00', p.error || total(p.html));

    // ---- B5: the dashboard ----
    p = await see({ ...base, branch: pl }, '/backoffice', {});
    check('B5 the dashboard with Port Louis picked names Port Louis', !p.error && p.says.includes('Port Louis') && !p.says.includes('By branch'), p.error);
    p = await see(base, '/backoffice', {});
    check('B5 the dashboard with All branches has a By branch table', !p.error && p.says.includes('By branch'), p.error);

    // ---- B6: one branch: no picker, no By branch ----
    p = await see(soloCtx, '/backoffice/reports/sales', days);
    check('B6 one branch: Sales as before', !p.error && total(p.html) === 'Total collected: Rs 50.00', p.error || total(p.html));
    check('B6 with no picker and no By branch table', !p.html.includes('data-branch-picker') && !p.says.includes('By branch'));
    p = await see(soloCtx, '/backoffice', {});
    check('B6 nor on the dashboard', !p.error && !p.html.includes('data-branch-picker') && !p.says.includes('By branch'), p.error);

    // ---- B7: a shop with two branches: a customer's money is the account's, each line says its branch ----
    const shopMade = (await one(`select platform.create_tenant_of_type($1,'Branch Shop','Curepipe','MB3','Owner',$2,'premium','retail') as r`, [admin, id()])).r;
    const sid = shopMade.tenant_id, sowner = shopMade.employee_id;
    const rh = (await one(`select platform.add_store($1,$2,'Rose Hill','RH') as s`, [admin, sid])).s;
    const rhTill = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Rose Hill till','R1') returning id`, [sid, rh])).id;
    const sCash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [sid])).id;
    const shirt = (await one(`insert into items (tenant_id, name, price) values ($1,'Shirt',50000) returning id`, [sid])).id;
    const buyer = (await one(`insert into customers (tenant_id, name) values ($1,'Anil') returning id`, [sid])).id;
    const tk = id(), sale = id(), line = id();
    await asTill(sid, sowner, [
      op('shift.open', { id: id(), device_id: rhTill, opening_float: 0, opened_at: at(70) }),
      op('ticket.create', { id: tk, store_id: rh }),
      op('ticket.add_line', { id: line, ticket_id: tk, item_id: shirt, qty: 1000 }),
      op('receipt.create', { id: sale, ticket_id: tk, store_id: rh, device_id: rhTill, number: 'R1-1', device_seq: 1, device_time: at(40),
        payments: [{ payment_type_id: sCash, amount: 50000 }] }),
    ]);
    const rl = await one(`select id from receipt_lines where receipt_id = $1`, [sale]);
    // a shop gives an exchange by default: this one gives money back, so the refund goes through
    await c.query(`update pos_settings set data = data || '{"returns":"refund","returnDays":7}'::jsonb where tenant_id = $1`, [sid]);
    const back = id();
    await asTill(sid, sowner, [op('refund.create', { id: back, refund_of: sale, store_id: rh, device_id: rhTill, number: 'R1-R2', device_seq: 2, device_time: at(30),
      reason: 'size', lines: [{ receipt_line_id: rl.id, qty: 1000 }], payments: [{ payment_type_id: sCash, amount: 50000 }] })]);
    await c.query(`insert into credit_notes (id, tenant_id, store_id, device_id, number, amount, balance, refund_id, customer_id)
                   values ($1,$2,$3,$4,'CN-77',50000,50000,$5,$6)`, [id(), sid, rh, rhTill, back, buyer]);
    const shopCtx = { tenantId: sid, employeeId: sowner, mode: 'retail', premium: true, mra: 'off' };
    p = await see(shopCtx, '/backoffice/credit-notes', {});
    const noteRow = rowsOf(p.html).find((r) => r.startsWith('CN-77')) || '';
    check('B7 Credit notes has a Branch column, and the note says Rose Hill', !p.error && rowsOf(p.html)[0].includes('Branch') && noteRow.includes('Rose Hill'), p.error || noteRow);
    for (const [href, sp, more] of [
      ['/backoffice/deposits', {}], ['/backoffice/deposits', { show: 'all' }],
      ['/backoffice/accounts/' + buyer, {}, { params: { customer: buyer }, file: 'backoffice/accounts/[customer]' }],
      ['/backoffice/customers/' + buyer, {}, { params: { customer: buyer }, file: 'backoffice/customers/[customer]' }],
    ]) {
      p = await see(shopCtx, href, sp, more);
      check(`B7 ${href} opens for a shop with two branches`, !p.error, p.error);
    }
  } catch (e) {
    console.log('FAIL the test itself: ' + ((e && e.stack) || e));
    failures++;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
