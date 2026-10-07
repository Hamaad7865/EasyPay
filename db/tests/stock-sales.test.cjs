// stock-sales.test.cjs — migration 0068: a sale and a refund move stock
// through the one engine (0067).
//   - a sale writes one movement per product, with the shop and the cost
//   - pushed twice, it moves stock once
//   - a refund puts the goods back at the cost they left at
//   - selling more than there is goes through
// Usage: node db/tests/stock-sales.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SS-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SS1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select seed_demo_catalog('${tid}')`);
    const dp = await q1(`select id, category_id from items where tenant_id='${tid}' and name='Dholl puri'`);
    const other = (await q1(`select id from items where tenant_id='${tid}' and category_id <> $1 limit 1`, [dp.category_id])).id;
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    let seq = 0;
    const level = () => q1(`select qty, avg_cost::float8 as avg from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, store, dp.id]);
    const total = async () => (await q1(`select stock_qty from items where id = $1`, [dp.id])).stock_qty;
    const moves = async (receipt) => (await c.query(
      `select qty, reason, unit_cost::float8 as cost, store_id, ref_type, ref_id from stock_movements where receipt_id = $1`, [receipt])).rows;
    const sale = (qtys, rc, amount) => {
      const tk = crypto.randomUUID();
      return [
        op('ticket.create', { id: tk, store_id: store }),
        ...qtys.map((q) => op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: q.item || dp.id, qty: q.qty })),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'SS-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount }], device_time: new Date(Date.parse('2026-03-02T05:00:00Z') + seq * 60000).toISOString() }),
      ];
    };

    // Dholl puri is counted, costs Rs 25, and 10 arrive (it sells at Rs 50)
    await c.query(`update items set track_stock = true, cost = 2500 where id = $1`, [dp.id]);
    await c.query(`select stock_move($1,$2,$3,null,10000,'receive',2500,'delivery',$4,$5,null)`, [tid, store, dp.id, crypto.randomUUID(), owner]);

    // K1 a sale of 3
    const rc1 = crypto.randomUUID();
    const ops1 = sale([{ qty: 3000 }], rc1, 15000);
    const r1 = await push(ops1);
    let mv = await moves(rc1), l = await level();
    check('K1 the sale is applied', tag(r1[r1.length - 1]) === 'applied', tag(r1[r1.length - 1]));
    check('K1 one movement, with the shop, the cost and the receipt',
      mv.length === 1 && mv[0].qty === -3000 && mv[0].reason === 'sale' && near(mv[0].cost, 2500)
        && mv[0].store_id === store && mv[0].ref_type === 'receipt' && mv[0].ref_id === rc1, JSON.stringify(mv));
    check('K1 the level and the item total go down', l.qty === 7000 && (await total()) === 7000, JSON.stringify(l));

    // K2 the same operations arriving again
    await push(ops1);
    mv = await moves(rc1); l = await level();
    check('K2 a sale that arrives twice moves stock once', mv.length === 1 && l.qty === 7000 && (await total()) === 7000, `${mv.length} ${l.qty}`);

    // K3 a dearer delivery, then a refund of one from the first sale
    await c.query(`select stock_move($1,$2,$3,null,10000,'receive',3500,'delivery',$4,$5,null)`, [tid, store, dp.id, crypto.randomUUID(), owner]);
    const avgBefore = (await level()).avg; // (7000*2500 + 10000*3500) / 17000
    check('K3 the delivery moved the average', near(avgBefore, 3088.24), String(avgBefore));
    const line = await q1(`select id from receipt_lines where receipt_id = $1`, [rc1]);
    const rf = crypto.randomUUID();
    const back = await push([op('refund.create', { id: rf, refund_of: rc1, store_id: store, device_id: dev, number: 'SS-R' + (++seq), device_seq: seq,
      reason: 'wrong size', lines: [{ receipt_line_id: line.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }] })]);
    mv = await moves(rf); l = await level();
    check('K3 the refund is applied', tag(back[0]) === 'applied', tag(back[0]));
    check('K3 what comes back comes back at the cost it left at',
      mv.length === 1 && mv[0].qty === 1000 && mv[0].reason === 'refund' && near(mv[0].cost, 2500), JSON.stringify(mv));
    check('K3 and joins the average at that cost', l.qty === 18000 && near(l.avg, (17000 * avgBefore + 1000 * 2500) / 18000), JSON.stringify(l));

    // K4 two lines of one product on one order are one movement
    const rc2 = crypto.randomUUID();
    await push(sale([{ qty: 1000 }, { qty: 2000 }], rc2, 15000));
    mv = await moves(rc2);
    check('K4 two lines of one product make one movement', mv.length === 1 && mv[0].qty === -3000, JSON.stringify(mv));

    // K5 selling more than there is
    const rc3 = crypto.randomUUID();
    const r3 = await push(sale([{ qty: 20000 }], rc3, 100000));
    l = await level();
    check('K5 a sale is not refused for stock', tag(r3[r3.length - 1]) === 'applied' && l.qty === -5000 && (await total()) === -5000, JSON.stringify(l));

    // K6 an item that is not counted
    const rc4 = crypto.randomUUID();
    await push(sale([{ qty: 1000, item: other }], rc4, 1));
    const none = (await q1(`select count(*)::int as n from stock_levels where tenant_id = $1 and item_id = $2`, [tid, other])).n;
    check('K6 an item that is not counted has no level and no movement', none === 0 && (await moves(rc4)).length === 0);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `STOCK SALES FAIL (${failures})` : 'STOCK SALES PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
