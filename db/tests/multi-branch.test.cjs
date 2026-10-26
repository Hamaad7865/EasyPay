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

    // ---- S: staff per branch (piece 2) ----
    // what the back office runs, as the back office runs it: the tenant's role, inside a savepoint
    const asApp = async (tenant, sql, params) => {
      await c.query('SAVEPOINT s');
      try {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
        const r = await c.query(sql, params);
        await c.query('RESET ROLE');
        await c.query('RELEASE SAVEPOINT s');
        return { rows: r.rows };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT s');
        return { error: e.message };
      }
    };
    const role = (await one(`select id from roles where tenant_id = $1 and name = 'Cashier'`, [tid])) || (await one(`select id from roles where tenant_id = $1 limit 1`, [tid]));
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role.id])).id;
    await c.query(`insert into employee_stores (tenant_id, employee_id, store_id) select $1, $2, s.id from stores s where s.tenant_id = $1`, [tid, cara]);
    const worksAt = async (emp) => (await c.query(`select s.name from employee_stores es join stores s on s.id = es.store_id where es.employee_id = $1 and es.deleted_at is null order by s.name`, [emp])).rows.map((r) => r.name).join(', ');
    let r = await asApp(tid, `select employee_set_stores($1, $2, $3::uuid[]) as n`, [tid, cara, [pl]]);
    check('S1 Cara kept to Port Louis', !r.error && (await worksAt(cara)) === 'Port Louis', r.error || (await worksAt(cara)));
    r = await asApp(tid, `select employee_set_stores($1, $2, $3::uuid[]) as n`, [tid, cara, []]);
    check('S2 no branch at all is refused', r.error === 'no-branch' && (await worksAt(cara)) === 'Port Louis', r.error);
    r = await asApp(tid, `select employee_set_stores($1, $2, $3::uuid[]) as n`, [tid, cara, [pl, solo.store_id]]);
    check('S2 another account\'s branch is refused', r.error === 'unknown-store' && (await worksAt(cara)) === 'Port Louis', r.error);
    r = await asApp(tid, `select employee_set_stores($1, $2, $3::uuid[]) as n`, [tid, cara, [main, pl]]);
    check('S1 and back to both: the removed row comes back', !r.error && (await worksAt(cara)) === 'Main, Port Louis', r.error || (await worksAt(cara)));
    await asApp(tid, `select employee_set_stores($1, $2, $3::uuid[]) as n`, [tid, cara, [pl]]);
    const gb = (await one(`select platform.add_store($1,$2,'Grand Baie','GB') as s`, [admin, tid])).s;
    check('S3 a new branch takes the staff who work at every branch', (await worksAt(owner)).includes('Grand Baie'), await worksAt(owner));
    check('S3 and not Cara, kept to Port Louis', (await worksAt(cara)) === 'Port Louis', await worksAt(cara));
    const off = (await one(`select platform.create_tenant_of_type($1,'Offline Cafe','Main','MB4','Owner',$2,'offline','restaurant') as r`, [admin, id()])).r;
    await c.query('SAVEPOINT s');
    let err = null;
    try { await c.query(`select platform.add_store($1,$2,'Second','SC')`, [admin, off.tenant_id]); } catch (e) { err = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT s');
    check('S4 an offline account has one branch', err === 'offline-one-branch', err);
    await c.query('SAVEPOINT s');
    err = null;
    try { await c.query(`select platform.set_tenant_plan($1,$2,'offline')`, [admin, tid]); } catch (e) { err = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT s');
    check('S5 an account with branches cannot go offline', err === 'offline-one-branch', err);
    p = await see(base, '/backoffice/staff', {});
    const caraRow = rowsOf(p.html).find((x) => x.startsWith('Cara')) || '';
    check('S6 Staff has Works at, with each branch', !p.error && rowsOf(p.html)[0].includes('Works at') && p.says.includes('Grand Baie'), p.error || rowsOf(p.html)[0]);
    check('S6 Cara works at Port Louis; the owner everywhere', caraRow.split(' | ')[5] === 'Port Louis' && (rowsOf(p.html).find((x) => x.startsWith('Owner')) || '').split(' | ')[5] === 'Every branch', caraRow);
    p = await see(soloCtx, '/backoffice/staff', {});
    check('S6 one branch: no Works at', !p.error && !p.says.includes('Works at'), p.error);
    void gb;

    // ---- K: stock per branch (piece 3) ----
    const level = async (tenant, store, item) => Number((await one(`select coalesce(sum(qty), 0) as q from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3`, [tenant, store, item])).q);
    const itemTotal = async (item) => Number((await one(`select coalesce(stock_qty, 0) as q from items where id = $1`, [item])).q);
    const cola = (await one(`insert into items (tenant_id, name, price, category_id, track_stock) values ($1,'Cola',5000,$2,true) returning id`, [tid, cat])).id;
    await asApp(tid, `select stock_move($1,$2,$3,null,10000,'adjust',null,null,null,$4,null)`, [tid, main, cola, owner]);
    await asApp(tid, `select stock_move($1,$2,$3,null,4000,'adjust',null,null,null,$4,null)`, [tid, pl, cola, owner]);
    r = await asApp(tid, `select stock_count_item($1,$2,$3,3000,$4,null) as d`, [tid, pl, cola, owner]);
    check('K1 a count of 3 at Port Louis writes -1 there', !r.error && Number(r.rows[0].d) === -1000, r.error || r.rows[0].d);
    check('K1 Main keeps its 10, Port Louis has 3, the total is 13', (await level(tid, main, cola)) === 10000 && (await level(tid, pl, cola)) === 3000 && (await itemTotal(cola)) === 13000,
      `${await level(tid, main, cola)} ${await level(tid, pl, cola)} ${await itemTotal(cola)}`);
    // a shop: opening stock from a file, at Curepipe and then at Rose Hill
    const curepipe = shopMade.store_id;
    const mug = [{ n: 1, name: 'Ceramic mug', price: 32000, cost: 14000, stock: 26000 }];
    r = await asApp(sid, `select catalog_import($1,$2,$3,$4::jsonb,false) as r`, [sid, curepipe, sowner, JSON.stringify(mug)]);
    const mugId = (await one(`select id from items where tenant_id = $1 and name = 'Ceramic mug'`, [sid])).id;
    r = await asApp(sid, `select catalog_import($1,$2,$3,$4::jsonb,false) as r`, [sid, rh, sowner, JSON.stringify([{ ...mug[0], stock: 5000 }])]);
    check('K5 opening stock at Rose Hill, though Curepipe holds some', !r.error && (await level(sid, rh, mugId)) === 5000 && (await level(sid, curepipe, mugId)) === 26000, r.error || `${await level(sid, rh, mugId)} ${await level(sid, curepipe, mugId)}`);
    r = await asApp(sid, `select catalog_import($1,$2,$3,$4::jsonb,false) as r`, [sid, rh, sowner, JSON.stringify([{ ...mug[0], stock: 7000 }])]);
    check('K5 and not twice at the same branch', !r.error && (await level(sid, rh, mugId)) === 5000, r.error || await level(sid, rh, mugId));

    // a table's cell by its column's heading: branches sit in the order they were made, which one transaction does not fix
    const cell = (html, rowHas, head) => {
      const rows = rowsOf(html);
      const at = (rows[0] || '').split(' | ').indexOf(head);
      const row = rows.find((x) => x.includes(rowHas)) || '';
      return at < 0 ? undefined : row.split(' | ')[at];
    };
    // the restaurant's Stock page: Cola, 10 at Main and 3 at Port Louis
    p = await see({ ...base, branch: pl }, '/backoffice/stock', {});
    let colaRow = rowsOf(p.html).find((x) => x.includes('Cola')) || '';
    check('K2 a restaurant\'s Stock with Port Louis picked: its 3', !p.error && colaRow.split(' | ')[3] === '3', p.error || colaRow);
    p = await see(base, '/backoffice/stock', {});
    colaRow = rowsOf(p.html).find((x) => x.includes('Cola')) || '';
    check('K2 with All branches: 13, then 10 and 3 under each branch', !p.error && cell(p.html, 'Cola', 'All branches') === '13' && cell(p.html, 'Cola', 'Main') === '10' && cell(p.html, 'Cola', 'Port Louis') === '3', p.error || colaRow);
    check('K3 a restaurant\'s low stock is judged at each branch', /Low at .*Port Louis/.test(colaRow) && !/Low at .*Main/.test(colaRow), colaRow);
    // the shop's Stock on hand: the mug, 26 at Curepipe and 5 at Rose Hill, reordered at Rose Hill below 6
    await asApp(sid, `select stock_set_reorder($1,$2,$3,6000,null)`, [sid, rh, mugId]);
    const shopBase = { tenantId: sid, employeeId: sowner, mode: 'retail', premium: true, mra: 'off' };
    p = await see({ ...shopBase, branch: rh }, '/backoffice/stock', {});
    let mugRow = rowsOf(p.html).find((x) => x.includes('Ceramic mug')) || '';
    check('K2 a shop\'s Stock on hand with Rose Hill picked: its 5, low', !p.error && mugRow.includes('| 5 |') && /Low/.test(mugRow), p.error || mugRow);
    p = await see(shopBase, '/backoffice/stock', {});
    mugRow = rowsOf(p.html).find((x) => x.includes('Ceramic mug')) || '';
    check('K2 with All branches: 31, then 26 and 5', !p.error && cell(p.html, 'Ceramic mug', 'All branches') === '31' && cell(p.html, 'Ceramic mug', 'Curepipe') === '26' && cell(p.html, 'Ceramic mug', 'Rose Hill') === '5', p.error || mugRow);
    check('K3 low at Rose Hill only', /Low at Rose Hill/.test(mugRow) && !/Curepipe/.test(mugRow.split(' | ').slice(-1)[0]), mugRow);
    check('K3 and nothing is adjusted from All branches', !p.html.includes('Save adjustment'), '');
    p = await see(shopBase, '/backoffice/reports/stock', { view: 'reorder' });
    check('K3 the reorder list with All branches names the branch', !p.error && p.says.includes('Ceramic mug · Rose Hill') && !p.says.includes('Ceramic mug · Curepipe'), p.error || p.says.slice(0, 300));
    await c.query(`insert into suppliers (tenant_id, name) values ($1, 'Textiles Ocean')`, [sid]);
    // a new order, and receiving without one: the branch is the one picked, or chosen
    p = await see({ ...shopBase, branch: rh }, '/backoffice/purchase-orders', {});
    check('K4 a new order with Rose Hill picked goes to Rose Hill', !p.error && p.html.includes(`name="store" value="${rh}"`), p.error);
    p = await see(shopBase, '/backoffice/purchase-orders', {});
    check('K4 with All branches the order asks which branch', !p.error && /<select name="store"/.test(p.html), p.error);
    const dv = id();
    r = await asApp(sid, `select delivery_receive($1,$2,$3,$4,null,null,current_date,null,null,$5::jsonb) as r`,
      [sid, sowner, dv, rh, JSON.stringify([{ item_id: mugId, variant_id: null, qty: 4000, unit_cost: 15000 }])]);
    check('K4 a delivery received at Rose Hill adds there', !r.error && (await level(sid, rh, mugId)) === 9000 && (await level(sid, curepipe, mugId)) === 26000, r.error || `${await level(sid, rh, mugId)} ${await level(sid, curepipe, mugId)}`);
    // movements, one branch's and all of them
    p = await see({ ...shopBase, branch: curepipe }, '/backoffice/stock-movements', {});
    check('K6 Movements with Curepipe picked: Curepipe\'s alone', !p.error && rowsOf(p.html).filter((x) => x.includes('Ceramic mug')).length === 1, p.error || rowsOf(p.html).filter((x) => x.includes('Ceramic mug')).join(' || '));
    p = await see(shopBase, '/backoffice/stock-movements', {});
    check('K6 with All branches every one, each with its branch', !p.error && rowsOf(p.html).filter((x) => x.includes('Ceramic mug')).length === 3 && p.says.includes('Rose Hill'), p.error || rowsOf(p.html).filter((x) => x.includes('Ceramic mug')).length);
    // every stock page opens, at each pick
    const stockBroke = [];
    for (const pick of [null, curepipe, rh]) {
      for (const [href, sp, more] of [
        ['/backoffice/stock', {}], ['/backoffice/stock-counts', {}], ['/backoffice/purchase-orders', {}], ['/backoffice/purchase-orders/receive', {}],
        ['/backoffice/stock-movements', {}], ['/backoffice/reports/stock', { view: 'value' }], ['/backoffice/reports/stock', { view: 'reorder' }],
        ['/backoffice/reports/stock', { view: 'losses' }], ['/backoffice/reports/stock', { view: 'unsold' }], ['/backoffice/items/import', {}],
        ['/backoffice/items/' + mugId, {}, { params: { id: mugId }, file: 'backoffice/items/[id]' }], ['/backoffice', {}],
      ]) {
        const q = await see({ ...shopBase, branch: pick ?? undefined }, href, sp, more);
        if (q.error) stockBroke.push(`${href} ${JSON.stringify(sp)} [${pick ?? 'all'}]: ${q.error}`);
      }
    }
    check('K7 every stock page opens for a shop with two branches, at each pick', stockBroke.length === 0, stockBroke.join(' || '));
    p = await see(shopBase, '/backoffice/items/' + mugId, {}, { params: { id: mugId }, file: 'backoffice/items/[id]' });
    check('K7 the product page says each branch\'s stock and has its reorder level', !p.error && p.says.includes('Curepipe 26') && p.says.includes('Rose Hill 9') && p.html.includes(`name="reorder_${rh}"`), p.error || p.says.slice(0, 200));

    // ---- T: transfers between branches (piece 4) ----
    const avg = async (tenant, store, item) => Number((await one(`select avg_cost from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tenant, store, item])).avg_cost);
    const send = (from, to, lines, emp = sowner) => asApp(sid, `select stock_transfer($1,$2,$3,$4,$5::jsonb,$6) as id`, [sid, emp, from, to, JSON.stringify(lines), 'by van']);
    const [cBefore, rBefore, cAvg, rAvg, totBefore] = [await level(sid, curepipe, mugId), await level(sid, rh, mugId), await avg(sid, curepipe, mugId), await avg(sid, rh, mugId), await itemTotal(mugId)];
    const rhSeq = Number((await one(`select server_seq from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3`, [sid, rh, mugId])).server_seq);
    r = await send(curepipe, rh, [{ item: mugId, variant: null, qty: 4000 }]);
    const t1 = r.rows?.[0]?.id;
    check('T1 4 sent: Curepipe 4 fewer, Rose Hill 4 more, the total the same', !r.error && (await level(sid, curepipe, mugId)) === cBefore - 4000 && (await level(sid, rh, mugId)) === rBefore + 4000 && (await itemTotal(mugId)) === totBefore,
      r.error || `${await level(sid, curepipe, mugId)} ${await level(sid, rh, mugId)} ${await itemTotal(mugId)}`);
    const want = (rBefore * rAvg + 4000 * cAvg) / (rBefore + 4000);
    check('T2 they arrive at Curepipe\'s cost, and Rose Hill\'s average moves with them', Math.abs((await avg(sid, rh, mugId)) - want) < 0.001 && (await avg(sid, curepipe, mugId)) === cAvg, `${await avg(sid, rh, mugId)} want ${want}`);
    const moved = (await c.query(`select reason, store_id, qty, note from stock_movements where ref_type = 'transfer' and ref_id = $1 order by qty`, [t1])).rows;
    check('T7 two movements under the transfer: out at Curepipe, in at Rose Hill, each naming the other', moved.length === 2 && moved[0].reason === 'transfer_out' && moved[0].store_id === curepipe && /to Rose Hill/.test(moved[0].note)
      && moved[1].reason === 'transfer_in' && moved[1].store_id === rh && /from Curepipe/.test(moved[1].note), JSON.stringify(moved));
    check('T8 Rose Hill\'s level moved on, so its till pulls it', Number((await one(`select server_seq from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3`, [sid, rh, mugId])).server_seq) > rhSeq);
    const cNow = await level(sid, curepipe, mugId);
    r = await send(curepipe, rh, [{ item: mugId, variant: null, qty: cNow + 1000 }]);
    check('T3 more than Curepipe holds is refused, and says how many it holds', /^not-enough-stock:/.test(r.error || '') && r.error.endsWith(':' + cNow) && (await level(sid, curepipe, mugId)) === cNow, r.error);
    r = await send(rh, rh, [{ item: mugId, variant: null, qty: 1000 }]);
    check('T4 a branch to itself is refused', r.error === 'same-branch', r.error);
    r = await send(curepipe, solo.store_id, [{ item: mugId, variant: null, qty: 1000 }]);
    check('T4 another account\'s branch is refused', r.error === 'unknown-store', r.error);
    const wrap = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,'Gift wrapping',5000,false) returning id`, [sid])).id;
    r = await send(curepipe, rh, [{ item: wrap, variant: null, qty: 1000 }]);
    check('T5 a product that does not count stock is refused', r.error === 'not-counted', r.error);
    const shirtV = (await one(`insert into items (tenant_id, name, price, track_stock, option_names) values ($1,'Linen shirt',90000,true,array['Size']) returning id`, [sid])).id;
    const sizeM = (await one(`insert into item_variants (tenant_id, item_id, name, option_values, price) values ($1,$2,'M',array['M'],90000) returning id`, [sid, shirtV])).id;
    r = await send(curepipe, rh, [{ item: shirtV, variant: null, qty: 1000 }]);
    check('T5 a product with sizes needs its size', r.error === 'pick-variant', r.error);
    await asApp(sid, `select stock_move($1,$2,$3,$4,3000,'adjust',null,null,null,$5,null)`, [sid, curepipe, shirtV, sizeM, sowner]);
    r = await send(curepipe, rh, [{ item: shirtV, variant: sizeM, qty: 1000 }, { item: shirtV, variant: sizeM, qty: 2000 }]);
    const mAt = async (store) => Number((await one(`select coalesce(sum(qty), 0) as q from stock_levels where store_id = $1 and variant_id = $2`, [store, sizeM])).q);
    check('T10 the same size on two lines moves once, both together', !r.error && (await mAt(curepipe)) === 0 && (await mAt(rh)) === 3000, r.error || `${await mAt(curepipe)} ${await mAt(rh)}`);
    r = await send(rh, curepipe, [{ item: shirtV, variant: sizeM, qty: 2000 }, { item: shirtV, variant: sizeM, qty: 2000 }]);
    check('T10 and the two together are held to what is there', /^not-enough-stock:/.test(r.error || ''), r.error);
    const rice = (await one(`insert into items (tenant_id, name, price, track_stock, sold_by) values ($1,'Basmati rice',12000,true,'weight') returning id`, [sid])).id;
    await asApp(sid, `select stock_move($1,$2,$3,null,10000,'adjust',null,null,null,$4,null)`, [sid, curepipe, rice, sowner]);
    r = await send(curepipe, rh, [{ item: rice, variant: null, qty: 1500 }]);
    check('T11 1.5 kg sent is 1.5 kg at both', !r.error && (await level(sid, curepipe, rice)) === 8500 && (await level(sid, rh, rice)) === 1500, r.error || `${await level(sid, curepipe, rice)} ${await level(sid, rh, rice)}`);
    const viewer = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Viewer','["backoffice.access","stock.view"]'::jsonb) returning id`, [sid])).id;
    const vic = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Vic',$2) returning id`, [sid, viewer])).id;
    r = await send(curepipe, rh, [{ item: mugId, variant: null, qty: 1000 }], vic);
    check('T6 a role without Adjust stock may not send', r.error === 'forbidden', r.error);
    r = await asApp(sid, `update stock_transfers set note = 'changed' where id = $1`, [t1]);
    check('T6 a transfer is not changed afterwards', !!r.error, r.error);
    p = await see(shopBase, '/backoffice/transfers', {});
    check('T9 Transfers lists it, from Curepipe to Rose Hill', !p.error && (rowsOf(p.html).find((x) => x.includes('T-0001')) || '').includes('Curepipe') && (rowsOf(p.html).find((x) => x.includes('T-0001')) || '').includes('Rose Hill'), p.error || rowsOf(p.html).join(' || '));
    p = await see(shopBase, '/backoffice/transfers/' + t1, {}, { params: { id: t1 }, file: 'backoffice/transfers/[id]' });
    check('T9 its note: both branches, the product and how many', !p.error && p.says.includes('Curepipe') && p.says.includes('Rose Hill') && (rowsOf(p.html).find((x) => x.includes('Ceramic mug')) || '').includes('4'), p.error || p.says.slice(0, 300));
    p = await see(shopBase, '/backoffice/transfers/new', {});
    check('T9 a new transfer asks From and To', !p.error && /name="from"/.test(p.html) && /name="to"/.test(p.html), p.error);
    // ---- R: each branch's own head (piece 5) ----
    p = await see(base, '/backoffice/company', {});
    check('R1 Company details has each branch\'s name, address and phone', !p.error && p.html.includes(`name="name_${pl}"`) && p.html.includes(`name="phone_${pl}"`) && p.html.includes(`name="addr_${main}"`), p.error);
    p = await see(soloCtx, '/backoffice/company', {});
    check('R1 one branch: no Branches card', !p.error && !p.html.includes('name="name_'), p.error);
    p = await see(soloCtx, '/backoffice/transfers', {});
    check('T9 one branch: nothing to transfer', !p.error && p.says.includes('one branch'), p.error || p.says.slice(0, 200));

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
