// review-reasons.test.cjs — review items D and E.
//   D: every flagged receipt records why (receipt_reviews), reviews can be
//      resolved, and a double payment does not count as a sale.
//   E: modifier prices and discount amounts follow the till; a difference
//      from the catalog is recorded as price-drift, not as a short payment.
// Usage: node db/tests/review-reasons.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RV-Probe')`);
  const store = (await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RVS1') returning id`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  const role = (await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]') returning id`)).rows[0].id;
  const emp = (await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}') returning id`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const q1 = async (sql) => (await c.query(sql)).rows[0];
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id;
  const roug = (await q1(`select m.id from modifiers m join modifier_groups g on g.id = m.group_id
    where m.tenant_id='${tid}' and g.name='Street add-ons' and m.name='Extra rougaille'`)).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const loy = (await q1(`select id from discounts where tenant_id='${tid}' and name='Loyalty member'`)).id;

  // every statement below runs the way the API and back office do
  async function asApp(fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  const num = () => 'RVS1-T1-' + (++seq);
  const rcOp = (id, ticket, extra) => op('receipt.create', { id, ticket_id: ticket, store_id: store, device_id: dev, number: num(), device_seq: seq, ...extra });
  const pay = (amount) => [{ payment_type_id: cash, amount }];
  const reasons = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id='${rc}' order by reason`)).rows.map((r) => r.reason);
  const detail = async (rc, reason) => (await q1(`select detail from receipt_reviews where receipt_id='${rc}' and reason='${reason}'`)).detail;
  async function ticketWith(line) {
    const t = crypto.randomUUID(), l = crypto.randomUUID();
    await push([op('ticket.create', { id: t, store_id: store }),
      op('ticket.add_line', { id: l, ticket_id: t, item_id: dp, qty: 1000, ...line })]);
    return { t, l };
  }

  // T1 clean sale: no flag, no reason rows
  const clean = crypto.randomUUID();
  {
    const { t } = await ticketWith({});
    const r = await push([rcOp(clean, t, { payments: pay(5000) })]);
    const row = await q1(`select needs_review from receipts where id='${clean}'`);
    check('T1 clean sale is not flagged and has no reasons', tag(r[0]) === 'applied' && row.needs_review === false && (await reasons(clean)).length === 0);
  }

  // T2 double pay: second receipt stored with reason double-pay, and it is not a sale
  const dup = crypto.randomUUID();
  {
    const { t } = await ticketWith({});
    const first = crypto.randomUUID();
    await push([rcOp(first, t, { payments: pay(5000) })]);
    const r = await push([rcOp(dup, t, { payments: pay(5000) })]);
    check('T2 second payment stored', tag(r[0]) === 'applied');
    check('T2 reason is double-pay only', JSON.stringify(await reasons(dup)) === '["double-pay"]', JSON.stringify(await reasons(dup)));
    const rev = (await c.query(`select id, counts_as_sale from receipt_revenue where ticket_id='${t}'`)).rows;
    check('T2 only the first receipt counts as a sale',
      rev.length === 2 && rev.find((x) => x.id === first).counts_as_sale === true && rev.find((x) => x.id === dup).counts_as_sale === false, JSON.stringify(rev));
    const sales = await q1(`select coalesce(sum(signed_total) filter (where counts_as_sale), 0)::text s from receipt_revenue where ticket_id='${t}'`);
    check('T2 ticket revenue is counted once (5000)', sales.s === '5000', sales.s);
  }

  // T3 short and long payments carry both figures
  const under = crypto.randomUUID(), over = crypto.randomUUID();
  {
    const a = await ticketWith({});
    await push([rcOp(under, a.t, { payments: pay(100) })]);
    const b = await ticketWith({});
    await push([rcOp(over, b.t, { payments: pay(6000) })]);
    check('T3 underpaid recorded with both figures',
      JSON.stringify(await reasons(under)) === '["underpaid"]' && JSON.stringify(await detail(under, 'underpaid')) === '{"total": 5000, "received": 100}'.replace(/ /g, ''),
      JSON.stringify(await detail(under, 'underpaid')));
    check('T3 overpaid recorded', JSON.stringify(await reasons(over)) === '["overpaid"]', JSON.stringify(await reasons(over)));
  }

  // T4 (E) modifier price changed while the till was offline: the till charged 2500
  const drift = crypto.randomUUID();
  {
    await c.query(`update modifiers set price = 3000 where id='${roug}'`);
    const { t } = await ticketWith({ unit_price: 5000, modifiers: [{ modifier_id: roug, price: 2500 }] });
    const r = await push([rcOp(drift, t, { payments: pay(7500) })]);
    const row = await q1(`select total, needs_review from receipts where id='${drift}'`);
    check('T4 receipt stored at the till total 7500', tag(r[0]) === 'applied' && row.total === '7500' && row.needs_review === true, JSON.stringify(row));
    check('T4 reason is price-drift, not underpaid', JSON.stringify(await reasons(drift)) === '["price-drift"]', JSON.stringify(await reasons(drift)));
    const d = await detail(drift, 'price-drift');
    check('T4 detail keeps till and catalog prices',
      d.items.length === 1 && d.items[0].kind === 'modifier' && d.items[0].till === 2500 && d.items[0].catalog === 3000, JSON.stringify(d));
    const snap = await q1(`select m.price from receipt_line_modifiers m join receipt_lines l on l.id = m.receipt_line_id where l.receipt_id='${drift}'`);
    check('T4 receipt snapshot holds the till price', snap.price === '2500', snap.price);
    await c.query(`update modifiers set price = 2500 where id='${roug}'`);
    // the older payload shape still works and prices from the catalog
    const { t: t2 } = await ticketWith({ modifier_ids: [roug] });
    const legacy = crypto.randomUUID();
    await push([rcOp(legacy, t2, { payments: pay(7500) })]);
    check('T4 modifier_ids still accepted, unflagged', (await reasons(legacy)).length === 0 && (await q1(`select total from receipts where id='${legacy}'`)).total === '7500');
  }

  // T5 (E) discount amount as charged: catalog says 10% of 5000 = 500, the till took 400
  const disc = crypto.randomUUID();
  {
    const { t } = await ticketWith({});
    const r = await push([rcOp(disc, t, { discounts: [{ discount_id: loy, amount: 400 }], payments: pay(4600) })]);
    const row = await q1(`select discount_total, total from receipts where id='${disc}'`);
    check('T5 till discount stored (400, total 4600)', tag(r[0]) === 'applied' && row.discount_total === '400' && row.total === '4600', JSON.stringify(row));
    const d = await detail(disc, 'price-drift');
    check('T5 flagged as price-drift with both figures',
      JSON.stringify(await reasons(disc)) === '["price-drift"]' && d.items[0].kind === 'discount' && d.items[0].till === 400 && d.items[0].catalog === 500, JSON.stringify(d));
    const b = await ticketWith({});
    const same = crypto.randomUUID();
    await push([rcOp(same, b.t, { discounts: [{ discount_id: loy, amount: 500 }], payments: pay(4500) })]);
    check('T5 a matching amount is not flagged', (await reasons(same)).length === 0);
    const x = await ticketWith({});
    const big = await push([rcOp(crypto.randomUUID(), x.t, { discounts: [{ discount_id: loy, amount: 9000 }], payments: pay(1) })]);
    check('T5 discount larger than the subtotal is refused', tag(big[0]) === 'rejected:bad-discount', tag(big[0]));
    const neg = await push([rcOp(crypto.randomUUID(), x.t, { discounts: [{ discount_id: loy, amount: -100 }], payments: pay(5100) })]);
    check('T5 negative discount is refused', tag(neg[0]) === 'rejected:bad-discount', tag(neg[0]));
  }

  // T6 number collision
  {
    const a = await ticketWith({}), b = await ticketWith({});
    const r1 = crypto.randomUUID(), r2 = crypto.randomUUID();
    const number = 'RVS1-T1-SAME';
    await push([op('receipt.create', { id: r1, ticket_id: a.t, store_id: store, device_id: dev, number, device_seq: 900, payments: pay(5000) })]);
    await push([op('receipt.create', { id: r2, ticket_id: b.t, store_id: store, device_id: dev, number, device_seq: 901, payments: pay(5000) })]);
    check('T6 collision recorded', JSON.stringify(await reasons(r2)) === '["number-collision"]', JSON.stringify(await reasons(r2)));
  }

  // T7 the flag and the reasons never disagree
  {
    const bad = await q1(`select count(*)::int n from receipts r where r.tenant_id='${tid}' and r.type='sale'
      and r.needs_review <> exists (select 1 from receipt_reviews v where v.receipt_id = r.id)`);
    check('T7 needs_review is true exactly when a reason exists', bad.n === 0, 'mismatches=' + bad.n);
  }

  // T8 resolving, as the back office does it
  {
    const open = async () => (await asApp(async () => (await c.query(
      `select count(distinct receipt_id)::int n from receipt_reviews where resolved_at is null and deleted_at is null and tenant_id = $1`, [tid])).rows[0].n));
    const before = await open();
    const n = await asApp(async () => (await c.query(
      `update receipt_reviews set resolved_at = now(), resolved_by = $1, resolution = $2
        where receipt_id = $3 and tenant_id = $4 and resolved_at is null`, [emp, 'cash counted, short by Rs 49', under, tid])).rowCount);
    const row = await q1(`select resolved_by, resolution, resolved_at is not null as done from receipt_reviews where receipt_id='${under}'`);
    check('T8 review resolved with who and why', n === 1 && row.done && row.resolved_by === emp && row.resolution.startsWith('cash counted'), JSON.stringify(row));
    check('T8 open count drops by one', (await open()) === before - 1, `${before} -> ${await open()}`);
    const again = await asApp(async () => (await c.query(
      `update receipt_reviews set resolved_at = now() where receipt_id = $1 and tenant_id = $2 and resolved_at is null`, [under, tid])).rowCount);
    check('T8 a resolved review is not resolved twice', again === 0);
  }

  // T9 another tenant sees none of it
  {
    const other = crypto.randomUUID();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [other]);
    const seen = (await c.query(`select (select count(*)::int from receipt_reviews) a, (select count(*)::int from receipt_revenue) b`)).rows[0];
    await c.query('ROLLBACK');
    check('T9 reviews and revenue view are tenant-scoped', seen.a === 0 && seen.b === 0, JSON.stringify(seen));
  }

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'REVIEW-REASONS PASS' : `REVIEW-REASONS FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
