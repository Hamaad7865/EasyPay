// customer-history.test.cjs — a customer's history in the back office
// (/backoffice/customers/<id>, 2026-10-26), opened as its owner would, on a
// restaurant whose till made the orders (through sync_push). It says that
// the page's figures are the receipts' own and the same as the Spent column
// on Customers, that a split bill is one visit, that what they buy most has
// what came back taken off, and that the figures and receipts are shown only
// to a role that may see reports. Orders, whose receipt card the page shares,
// is opened again.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/customer-history.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-ch@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'History Bistro','Main','CH1','Owner',$2,'offline','restaurant') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    const push = async (ops) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try {
        const out = (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r;
        const bad = out.filter((o) => o.status !== 'applied');
        if (bad.length) throw new Error('the server refused ' + JSON.stringify(bad));
        return out;
      } finally { await c.query('RESET ROLE'); }
    };
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Counter','T1') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
    const cat = (await one(`insert into categories (tenant_id, name) values ($1,'Grill') returning id`, [tid])).id;
    const item = async (nm) => (await one(`insert into items (tenant_id, name, price, category_id) values ($1,$2,11500,$3) returning id`, [tid, nm, cat])).id;
    const grill = await item('Mix grill'), lassi = await item('Lassi');
    const ravi = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Ravi Doorga','52501234') returning id`, [tid])).id;
    const mia = (await one(`insert into customers (tenant_id, name) values ($1,'Mia') returning id`, [tid])).id;
    const gone = (await one(`insert into customers (tenant_id, name, deleted_at) values ($1,'Old Friend', now()) returning id`, [tid])).id;
    const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
    let seq = 0;
    // an order for `who`, its lines as [item, qty in thousandths], paid by the receipts in `pays` (each the lines it pays, by index)
    const order = async (who, lines, pays) => {
      const tk = id(), ids = lines.map(() => id()), rcs = [];
      const ops = [op('ticket.create', { id: tk, store_id: store }), op('ticket.update_meta', { ticket_id: tk, customer_id: who }),
        ...lines.map(([it, qty], i) => op('ticket.add_line', { id: ids[i], ticket_id: tk, item_id: it, qty }))];
      for (const p of pays) {
        const rc = id();
        rcs.push(rc);
        const amount = p.reduce((a, i) => a + (11500 * lines[i][1]) / 1000, 0);
        ops.push(op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'CH1-' + (++seq), device_seq: seq, device_time: at(60 - seq),
          ...(pays.length > 1 ? { line_ids: p.map((i) => ids[i]) } : {}), payments: [{ payment_type_id: cash, amount }] }));
      }
      await push(ops);
      return { rcs, ids };
    };
    const shift = id();
    await push([op('shift.open', { id: shift, device_id: dev, opening_float: 0, opened_at: at(70) })]);
    // a split bill: a grill and a lassi, each paid on its own receipt. One visit.
    await order(ravi, [[grill, 1000], [lassi, 1000]], [[0], [1]]);
    // two grills, and one of them comes back
    const b = await order(ravi, [[grill, 2000]], [[0]]);
    const rl = await one(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [b.rcs[0], b.ids[0]]);
    await push([op('refund.create', { id: id(), refund_of: b.rcs[0], store_id: store, device_id: dev, number: 'CH1-R' + (++seq), device_seq: seq, device_time: at(60 - seq),
      reason: 'cold', lines: [{ receipt_line_id: rl.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 11500 }] })]);
    // a grill and a lassi on one receipt
    await order(ravi, [[grill, 1000], [lassi, 1000]], [[0, 1]]);
    // someone else's order, which is not Ravi's
    await order(null, [[lassi, 1000]], [[0]]);
    // Ravi: sales 115 + 115 + 230 + 230 = Rs 690.00, less the Rs 115.00 refund: Rs 575.00 over three visits

    const ctx = { tenantId: tid, employeeId: owner, mode: 'restaurant' };
    const see = async (who, href, sp, more) => {
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
    const history = (who, cu) => see(who, '/backoffice/customers/' + cu, {}, { params: { customer: cu }, file: 'backoffice/customers/[customer]' });

    let p = await history(ctx, ravi);
    check('H1 the page opens for the owner', !p.error && p.says.includes('Ravi Doorga') && p.says.includes('52501234'), p.error);
    const st = stats(p.html).join(' | ');
    check('H2 three visits, the split bill one of them', st.includes('Visits: 3'), st);
    check('H2 spent: the sales less the refund', st.includes('Spent: Rs 575.00'), st);
    check('H2 the average per visit', st.includes('Average per visit: Rs 191.67'), st);
    check('H2 first and last visit', p.says.includes('first on ') && st.includes('Last visit:') && !st.includes('Last visit: None'), st);
    const list = await see(ctx, '/backoffice/customers', {});
    const row = rowsOf(list.html).find((r) => r.includes('Ravi Doorga')) || '';
    check('H2 the same Spent as the Customers column', row.includes('Rs 575.00'), row);
    check('H10 Customers links the name to the page', list.html.includes(`href="/backoffice/customers/${ravi}"`));
    const most = (p.says.match(/Buys most (.*?) Receipts/) || [])[1] || '';
    check('H3 what they buy most, what came back taken off', /Mix grill\s*3.*Lassi\s*2/.test(most), most);
    for (let n = 1; n <= 5; n++) check(`H4 receipt CH1-${n === 4 ? 'R4' : n} is listed`, p.says.includes(`CH1-${n === 4 ? 'R4' : n}`));
    check('H4 another customer\'s receipt is not', !p.says.includes('CH1-6'), (p.says.match(/CH1-\w+/g) || []).join(' '));
    check('H4 each receipt has its items', (p.html.match(/<details/g) || []).length === 5 && p.says.includes('Refund'), (p.html.match(/<details/g) || []).length);

    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Host','["backoffice.access"]'::jsonb) returning id`, [tid])).id;
    const host = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Hana',$2) returning id`, [tid, role])).id;
    p = await history({ tenantId: tid, employeeId: host, mode: 'restaurant', role: 'Host' }, ravi);
    check('H5 a role without reports opens the page and sees the name', !p.error && p.says.includes('Ravi Doorga'), p.error);
    check('H5 but no figures and no receipts', stats(p.html).length === 0 && !p.says.includes('CH1-') && !p.says.includes('Rs 575.00'), stats(p.html).join(' | '));

    p = await history(ctx, mia);
    check('H6 a customer who bought nothing', !p.error && p.says.includes('Mia') && p.says.includes('Nothing bought yet'), p.error || p.says.slice(0, 200));
    p = await history(ctx, gone);
    check('H7 a removed customer\'s page opens and says so', !p.error && p.says.includes('Old Friend') && p.says.includes('removed from Customers'), p.error);
    p = await history(ctx, id());
    check('H8 an unknown customer is not found', p.error === 'not found', p.error);
    p = await history(ctx, 'not-an-id');
    check('H8 nor is an id that is not one', p.error === 'not found', p.error);

    const d = await one(`select (now() at time zone timezone - interval '1 day')::date::text as from, (now() at time zone timezone)::date::text as to from stores where id = $1`, [store]);
    p = await see(ctx, '/backoffice/reports/orders', { from: d.from, to: d.to });
    check('H9 Orders opens and draws every receipt', !p.error && (p.html.match(/<details/g) || []).length === 6 && p.says.includes('Paid by Cash'), p.error || (p.html.match(/<details/g) || []).length);
    check('H9 its figures', stats(p.html).join(' | ') === 'Receipts shown: 6 | Sales: 5 | Refunds: 1 | Total: Rs 690.00', stats(p.html).join(' | '));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.log('FAILED ' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
