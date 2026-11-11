// invoices.test.cjs — invoices for business customers (0159,
// docs/superpowers/specs/2026-11-12-invoices-design.md), on a shop made for the test.
// It says that an invoice's figures are the ones the till's own receipt push makes of the same lines;
// that a draft saves whole and keeps the business's own taxes; that numbers run per branch with no gap,
// start where the shop says and only before its first; that an issued invoice refuses every change;
// that issuing takes the products, and a made-of product's parts, off the branch's shelf once; that
// payments never pass what is owed and a cancelled one stays; that a client on Premium MRA cannot issue;
// that Delete all transactions takes it all; and that the pages draw from it.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/invoices.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && !cond ? ' ' + extra : ''));
  if (!cond) failures++;
}
const id = () => crypto.randomUUID();
const op = (type, payload) => ({ op_id: id(), type, payload });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  let tid, owner;
  // as the back office asks: the tenant's role, inside the tenant
  const asTenant = async (fn) => {
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { return await fn(); } finally { await c.query('RESET ROLE').catch(() => {}); }
  };
  const call = (sql, params) => asTenant(async () => (await c.query(sql, params)).rows[0]);
  // the database's answer to something it must refuse: its message, and nothing of it kept
  // (the role is taken inside the savepoint, so going back to it gives the role back too)
  const refused = async (sql, params) => {
    await c.query('SAVEPOINT r');
    try {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      await c.query(sql, params);
      await c.query('RESET ROLE');
      await c.query('RELEASE SAVEPOINT r');
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT r');
      return e.message;
    }
  };
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-inv@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Invoice Hardware','Main','IV1','Owner',$2,'premium','retail') as r`, [admin, id()])).r;
    tid = made.tenant_id;
    const store = made.store_id;
    owner = made.employee_id;
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);

    const vatIn = (await one(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'VAT inv', 1500, 'included') returning id`, [tid])).id;
    const levy = (await one(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'Levy inv', 500, 'added') returning id`, [tid])).id;
    const item = async (name, price, taxes, track = true) => {
      const it = (await one(`insert into items (tenant_id, name, price, track_stock, sku) values ($1, $2, $3, $4, $5) returning id`, [tid, name, price, track, name.toUpperCase().slice(0, 6)])).id;
      for (const t of taxes) await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1, $2, $3)`, [tid, it, t]);
      return it;
    };
    const drill = await item('Drill', 345050, [vatIn]);
    const screws = await item('Screws', 1999, [vatIn, levy]);
    const cable = await item('Cable', 12000, [levy], false);
    const glue = await item('Glue', 9900, [vatIn]);
    const kit = await item('Starter kit', 50000, [vatIn]);
    await c.query(`select item_set_parts($1, $2, $3::jsonb)`, [tid, kit, JSON.stringify([{ item_id: glue, qty: 2000 }, { item_id: screws, qty: 1000 }])]);
    for (const [it, q] of [[drill, 10000], [screws, 50000], [glue, 20000]]) {
      await c.query(`select stock_move($1, $2, $3, null, $4, 'opening', 100, null, null, $5, null)`, [tid, store, it, q, owner]);
    }
    const level = async (it) => Number((await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, store, it])).qty);

    // ---- the figures are the till's ----
    const lines = [
      { kind: 'line', item_id: drill, name: 'Drill', qty: 1000, unit_price: 345050, tax_ids: [vatIn] },
      { kind: 'heading', name: 'Fixings' },
      { kind: 'line', item_id: screws, name: 'Screws', qty: 3500, unit_price: 1999, tax_ids: [vatIn, levy] },
      { kind: 'line', item_id: cable, name: 'Cable', detail: '3 core, cut to length', qty: 2750, unit_price: 12000, tax_ids: [levy] },
      { kind: 'note', name: 'Delivered to site' },
    ];
    const head = { buyer_type: 'B2B', buyer_name: 'Bel Air Builders Ltd', buyer_brn: 'C07012345', buyer_vat: 'VAT20345678', disc_type: 'percent', disc_value: 7, terms: '30', issued_on: null };
    const s1 = (await call(`select invoice_save($1, $2, null, $3, null, $4::jsonb, $5::jsonb) as r`, [tid, owner, store, JSON.stringify(head), JSON.stringify(lines)])).r;
    const inv1 = s1.id;
    check('S1 a new draft is saved with its lines in order, headings and notes kept, no number', s1.rev === 2 &&
      (await one(`select count(*)::int as n, string_agg(kind, ',' order by pos) as k from invoice_lines where invoice_id = $1`, [inv1])).k === 'line,heading,line,line,note' &&
      (await one(`select number, status from invoices where id = $1`, [inv1])).number === null, JSON.stringify(s1));
    const taxes2 = (await one(`select taxes from invoice_lines where invoice_id = $1 and pos = 3`, [inv1])).taxes;
    check('S2 a line keeps the business\'s own taxes, as they are now', taxes2.length === 2 && taxes2.some((t) => t.name === 'Levy inv' && t.rate_bp === 500 && t.type === 'added'), JSON.stringify(taxes2));

    // the same lines through the till's own push, with the same 7% off
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Counter','T1') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and kind = 'cash' limit 1`, [tid])) ||
      (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid]));
    const push = (ops) => asTenant(async () => {
      const out = (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r;
      const bad = out.filter((o) => o.status !== 'applied');
      if (bad.length) throw new Error('the server refused ' + JSON.stringify(bad));
    });
    await push([op('shift.open', { id: id(), device_id: dev, opening_float: 0, opened_at: new Date(Date.now() - 3600000).toISOString() })]);
    const tk = id(), rc = id();
    await push([
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: id(), ticket_id: tk, item_id: drill, qty: 1000 }),
      op('ticket.add_line', { id: id(), ticket_id: tk, item_id: screws, qty: 3500 }),
      op('ticket.add_line', { id: id(), ticket_id: tk, item_id: cable, qty: 2750 }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'IV1-1', device_seq: 1, device_time: new Date().toISOString(),
        discounts: [{ type: 'percent', value: 7, name: 'Trade' }], payments: [{ payment_type_id: cash.id, amount: s1.total }] }),
    ]);
    const r = await one(`select subtotal::bigint as s, discount_total::bigint as d, tax_total::bigint as t, total::bigint as x from receipts where id = $1`, [rc]);
    check('M1 an invoice\'s subtotal, discount, VAT and total are what the till\'s receipt push makes of the same lines',
      Number(r.s) === Number(s1.subtotal) && Number(r.d) === Number(s1.discount_total) && Number(r.t) === Number(s1.tax_total) && Number(r.x) === Number(s1.total),
      JSON.stringify({ receipt: r, invoice: s1 }));
    check('M2 and the figures are not all zero (the lines were counted)', Number(s1.total) > 345050 && Number(s1.tax_added) > 0, JSON.stringify(s1));

    // ---- a draft ----
    check('D1 a save from a page showing an older version is refused (two windows on one draft)',
      /invoice-changed/.test(await refused(`select invoice_save($1, $2, $3, null, 1, '{}'::jsonb, '[]'::jsonb)`, [tid, owner, inv1])) || '');
    const noBrn = (await call(`select invoice_save($1, $2, null, $3, null, $4::jsonb, $5::jsonb) as r`, [tid, owner, store, JSON.stringify({ ...head, buyer_brn: '' }), JSON.stringify(lines)])).r;
    check('D2 a business invoice cannot be issued without the buyer\'s BRN', /invoice-brn/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, noBrn.id])) || ''));

    // ---- numbers ----
    check('N1 a branch\'s numbers start where the shop says, before its first invoice',
      (await call(`select invoice_series_set($1, $2, 'INV-', 120) as r`, [tid, store])).r.start === 120);
    const i1 = (await call(`select invoice_issue($1, $2, $3, $4) as r`, [tid, owner, inv1, s1.rev])).r;
    check('N2 issuing numbers it from the branch\'s series', i1.number === 'INV-00120' && i1.already === false, JSON.stringify(i1));
    check('N3 and the start cannot be moved once the branch has issued one',
      /invoice-series-started/.test((await refused(`select invoice_series_set($1, $2, 'INV-', 500)`, [tid, store])) || ''));
    check('N4 issuing again says it was already issued, and takes no second number',
      (await call(`select invoice_issue($1, $2, $3, null) as r`, [tid, owner, inv1])).r.already === true &&
      Number((await one(`select next_no from invoice_series where tenant_id = $1 and store_id = $2`, [tid, store])).next_no) === 121);
    const draft = async (h, ls) => (await call(`select invoice_save($1, $2, null, $3, null, $4::jsonb, $5::jsonb) as r`, [tid, owner, store, JSON.stringify(h), JSON.stringify(ls)])).r;
    const small = [{ kind: 'line', item_id: glue, name: 'Glue', qty: 1000, unit_price: 9900, tax_ids: [vatIn] }];
    const d2 = await draft({ buyer_name: 'Walk-in' }, small);
    // an issue that is undone (its transaction failed) gives its number back: the next one takes it
    await c.query('SAVEPOINT gap');
    const gone = (await call(`select invoice_issue($1, $2, $3, null) as r`, [tid, owner, d2.id])).r;
    await c.query('ROLLBACK TO SAVEPOINT gap');
    const again = (await call(`select invoice_issue($1, $2, $3, null) as r`, [tid, owner, d2.id])).r;
    check('N5 a failed issue leaves no gap: the number goes to the next one issued', gone.number === 'INV-00121' && again.number === 'INV-00121', JSON.stringify([gone, again]));
    const d3 = await draft({ buyer_name: 'Walk-in', issued_on: '2020-01-01' }, small);
    check('N6 an invoice dated before the branch\'s last one is refused (numbers and dates go up together)',
      /invoice-date-order/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, d3.id])) || ''));
    const d4 = await draft({ buyer_name: 'Walk-in', issued_on: '2099-01-01' }, small);
    check('N7 and one dated after today', /invoice-future/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, d4.id])) || ''));
    const empty = await draft({ buyer_name: 'Walk-in' }, [{ kind: 'heading', name: 'Nothing' }]);
    check('N8 and one with nothing on it', /invoice-empty/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, empty.id])) || ''));
    const nameless = await draft({ buyer_name: '' }, small);
    check('N9 and one with no buyer', /invoice-buyer/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, nameless.id])) || ''));

    // ---- an issued invoice is never changed ----
    check('L1 its figures cannot be changed', /invoice-issued/.test((await refused(`update invoices set total = 1 where id = $1`, [inv1])) || ''));
    check('L2 nor its buyer', /invoice-issued/.test((await refused(`update invoices set buyer_name = 'Someone else' where id = $1`, [inv1])) || ''));
    check('L3 nor its lines changed, added or taken off',
      /invoice-issued/.test((await refused(`update invoice_lines set unit_price = 1 where invoice_id = $1`, [inv1])) || '') &&
      /invoice-issued/.test((await refused(`insert into invoice_lines (tenant_id, invoice_id, pos, name, qty, unit_price) values ($1, $2, 9, 'x', 1000, 1)`, [tid, inv1])) || '') &&
      /invoice-issued/.test((await refused(`delete from invoice_lines where invoice_id = $1`, [inv1])) || ''));
    check('L4 nor is it deleted, nor saved as a draft', /invoice-issued/.test((await refused(`delete from invoices where id = $1`, [inv1])) || '') &&
      /invoice-issued/.test((await refused(`select invoice_save($1, $2, $3, null, null, '{}'::jsonb, '[]'::jsonb)`, [tid, owner, inv1])) || ''));

    // ---- stock ----
    const moved = async (doc) => Object.fromEntries((await c.query(`select item_id, sum(qty)::int as q from stock_movements where tenant_id = $1 and ref_type = 'invoice' and ref_id = $2 group by 1`, [tid, doc])).rows.map((x) => [x.item_id, x.q]));
    const m1 = await moved(inv1);
    check('K1 issuing took the products off the branch\'s shelf; a product nobody counts was left alone',
      m1[drill] === -1000 && m1[screws] === -3500 && m1[cable] === undefined && Object.keys(m1).length === 2, JSON.stringify(m1));
    const withKit = await draft({ buyer_name: 'Walk-in' }, [
      { kind: 'line', item_id: kit, name: 'Starter kit', qty: 2000, unit_price: 50000, tax_ids: [vatIn] },
      { kind: 'line', item_id: screws, name: 'Screws', qty: 1000, unit_price: 1999, tax_ids: [vatIn] },
    ]);
    const screwsBefore = await level(screws), glueBefore = await level(glue);
    await call(`select invoice_issue($1, $2, $3, null)`, [tid, owner, withKit.id]);
    check('K2 a made-of product takes its parts, added up with the same product sold alone: one movement each',
      (await level(glue)) === glueBefore - 4000 && (await level(screws)) === screwsBefore - 3000 &&
      Number((await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and ref_type = 'invoice' and ref_id = $2`, [tid, withKit.id])).n) === 2);

    // ---- payments ----
    const today = (await one(`select invoice_today($1, $2)::text as d`, [tid, store])).d;
    const total1 = Number(s1.total);
    check('P1 a payment of more than is owed is refused', /invoice-overpaid/.test((await refused(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), $4, 'bank', 'x')`, [tid, owner, inv1, total1 + 1])) || ''));
    check('P2 a draft takes no payment', /invoice-not-issued/.test((await refused(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), 100, 'bank', null)`, [tid, owner, d3.id])) || ''));
    check('P3 nor a payment from before the invoice', /invoice-pay-early/.test((await refused(`select invoice_pay($1, $2, $3, '2020-01-01', 100, 'bank', null)`, [tid, owner, inv1])) || ''));
    const p1 = (await call(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), 100000, 'bank', 'MCB 4471') as r`, [tid, owner, inv1])).r;
    check('P4 a part payment is kept and says what is still owed', p1.owed === total1 - 100000 &&
      Number((await one(`select paid from invoices where id = $1`, [inv1])).paid) === 100000);
    const p2 = (await call(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), 5000, 'cash', null) as r`, [tid, owner, inv1])).r;
    const cancelled = (await call(`select invoice_pay_cancel($1, $2, $3) as r`, [tid, owner, p2.id])).r;
    check('P5 a payment typed in error is cancelled: it stays, struck, and the money is owed again',
      cancelled.already === false && Number((await one(`select paid from invoices where id = $1`, [inv1])).paid) === 100000 &&
      (await one(`select cancelled_at is not null as c, cancelled_by = $2 as by from invoice_payments where id = $1`, [p2.id, owner])).by === true);
    check('P6 a payment is never changed, nor cancelled twice, nor deleted by the back office',
      /invoice-payment-kept/.test((await refused(`update invoice_payments set amount = 1 where id = $1`, [p1.id])) || '') &&
      (await call(`select invoice_pay_cancel($1, $2, $3) as r`, [tid, owner, p2.id])).r.already === true &&
      /permission denied/.test((await refused(`delete from invoice_payments where id = $1`, [p1.id])) || ''));
    await call(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), $4, 'cheque', '000123')`, [tid, owner, inv1, total1 - 100000]);
    check('P7 paid in full, nothing more is taken', Number((await one(`select paid from invoices where id = $1`, [inv1])).paid) === total1 &&
      /invoice-overpaid/.test((await refused(`select invoice_pay($1, $2, $3, invoice_today($1, (select store_id from invoices where id = $3)), 1, 'bank', null)`, [tid, owner, inv1])) || ''));

    // ---- the customer's details are remembered ----
    const cust = (await one(`insert into customers (tenant_id, name, phone, email) values ($1, 'Port Louis Traders', '5250 9999', 'accounts@plt.example') returning id`, [tid])).id;
    await draft({ customer_id: cust, buyer_type: 'B2B', buyer_name: 'Port Louis Traders', buyer_brn: 'C99', buyer_address: 'Royal Road', lang: 'fr', remember: true }, small);
    const kept = await one(`select buyer_type, brn, address, lang from invoice_customers where customer_id = $1`, [cust]);
    check('C1 what an invoice says of a business customer is kept for their next one, apart from the customer the tills pull',
      kept && kept.buyer_type === 'B2B' && kept.brn === 'C99' && kept.lang === 'fr' && kept.address === 'Royal Road', JSON.stringify(kept));

    // ---- MRA ----
    const mraDraft = await draft({ buyer_name: 'Walk-in' }, small);
    await c.query(`update tenants set mra = 'training' where id = $1`, [tid]);
    check('R1 a client on Premium MRA makes drafts but cannot issue (its invoices go through a till, not built yet)',
      /invoice-mra/.test((await refused(`select invoice_issue($1, $2, $3, null)`, [tid, owner, mraDraft.id])) || ''));
    await c.query(`update tenants set mra = 'off' where id = $1`, [tid]);

    // ---- the tables are the tenant's alone ----
    const rls = (await c.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like 'invoice%' and c.relkind = 'r'
          and not (c.relrowsecurity and c.relforcerowsecurity and exists (select 1 from pg_policies p where p.tablename = c.relname))`)).rows;
    check('T1 every invoice table has its row security forced and its tenant policy', rls.length === 0, JSON.stringify(rls));

    // ---- Delete all transactions takes it all ----
    await call(`select purge_transactions($1, $2)`, [tid, owner]);
    const left = await one(`select (select count(*) from invoices where tenant_id = $1)::int as i, (select count(*) from invoice_payments where tenant_id = $1)::int as p,
                                   (select count(*) from invoice_lines where tenant_id = $1)::int as l, (select next_no from invoice_series where tenant_id = $1) as n`, [tid]);
    check('X1 Delete all transactions takes invoices, their lines and payments; the series starts again where it was set',
      left.i === 0 && left.p === 0 && left.l === 0 && Number(left.n) === 120, JSON.stringify(left));
    check('X2 and the customer\'s saved invoice details stay (they are not transactions)', !!(await one(`select 1 as x from invoice_customers where customer_id = $1`, [cust])));
  } catch (e) {
    failures++;
    console.log('FAIL the test stopped: ' + (e && e.stack));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
