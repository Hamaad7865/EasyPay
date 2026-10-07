// stock-engine.test.cjs — migration 0067: one stock engine.
//   - a delivery with a cost moves the average; a sale leaves at the average
//   - selling below zero is allowed; the next delivery's cost becomes the average
//   - a document moves a product in a shop once
//   - a variant, and a second shop, each have their own level; the item's
//     total covers them all
//   - the first level made for an item starts from the quantity it carried
//   - a count sets an item's total, worked out under the level's lock
//   - the tenant role can use it, inside its own tenant only
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/stock-engine.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-se@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Stock Test','Main','SE1','Owner',$2,'standard') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const store2 = (await one(`insert into stores (tenant_id, name, code, created_at) values ($1,'Second','SE2', now() + interval '1 second') returning id`, [tid])).id;
    const item = async (name, cost, qty) => (await one(
      `insert into items (tenant_id, name, price, cost, stock_qty, track_stock) values ($1,$2,10000,$3,$4,true) returning id`, [tid, name, cost, qty])).id;
    const move = async (st, it, va, qty, reason, cost, refType, refId) => (await one(
      `select stock_move($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null) as id`, [tid, st, it, va, qty, reason, cost, refType, refId, emp])).id;
    const level = async (st, it, va) => one(
      `select qty, avg_cost::float8 as avg from stock_levels
        where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va]);
    const total = async (it) => (await one(`select stock_qty from items where id = $1`, [it])).stock_qty;
    const mv = async (m) => one(
      `select qty, reason, unit_cost::float8 as cost, store_id, receipt_id, ref_type, ref_id from stock_movements where id = $1`, [m]);

    const A = await item('Shirt', 4000, null);

    // E1 a delivery of 10 at Rs 40
    let m = await move(store, A, null, 10000, 'receive', 4000, 'delivery', id());
    let l = await level(store, A, null), r = await mv(m);
    check('E1 a delivery makes the level, at its cost', l.qty === 10000 && near(l.avg, 4000), JSON.stringify(l));
    check('E1 the movement keeps the shop and the cost', r.qty === 10000 && r.reason === 'receive' && near(r.cost, 4000) && r.store_id === store, JSON.stringify(r));
    check('E1 the item total follows', (await total(A)) === 10000);

    // E2 ten more at Rs 50: the average is Rs 45
    await move(store, A, null, 10000, 'receive', 5000, 'delivery', id());
    l = await level(store, A, null);
    check('E2 a dearer delivery moves the average', l.qty === 20000 && near(l.avg, 4500), JSON.stringify(l));

    // E3 a sale of 3 leaves at the average and does not move it
    const r1 = id();
    m = await move(store, A, null, -3000, 'sale', null, 'receipt', r1);
    l = await level(store, A, null); r = await mv(m);
    check('E3 a sale leaves at the average of that moment', near(r.cost, 4500) && r.receipt_id === r1 && r.ref_type === 'receipt', JSON.stringify(r));
    check('E3 and leaves the average alone', l.qty === 17000 && near(l.avg, 4500) && (await total(A)) === 17000, JSON.stringify(l));

    // E4 the same document again moves nothing
    m = await move(store, A, null, -3000, 'sale', null, 'receipt', r1);
    const n = (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and ref_id = $2`, [tid, r1])).n;
    l = await level(store, A, null);
    check('E4 a document moves a product once', m === null && n === 1 && l.qty === 17000, `${m} ${n} ${l.qty}`);

    // E5 selling more than there is
    await move(store, A, null, -20000, 'sale', null, 'receipt', id());
    l = await level(store, A, null);
    check('E5 a sale is never refused for stock', l.qty === -3000 && (await total(A)) === -3000, JSON.stringify(l));

    // E6 a delivery onto nothing: its cost is the average
    await move(store, A, null, 5000, 'receive', 6000, 'delivery', id());
    l = await level(store, A, null);
    check('E6 from zero or below, the delivery cost becomes the average', l.qty === 2000 && near(l.avg, 6000), JSON.stringify(l));

    // E7 a customer return comes back at the cost it is given
    await move(store, A, null, 1000, 'refund', 4500, 'receipt', id());
    l = await level(store, A, null);
    check('E7 a return at its own cost joins the average', l.qty === 3000 && near(l.avg, 5500), JSON.stringify(l));

    // E8 damaged goods leave at the average; E9 found goods arrive at it
    m = await move(store, A, null, -1000, 'damaged', null, null, null);
    r = await mv(m); l = await level(store, A, null);
    check('E8 an adjustment out leaves at the average', near(r.cost, 5500) && l.qty === 2000 && near(l.avg, 5500), JSON.stringify(r));
    m = await move(store, A, null, 1000, 'found', null, null, null);
    r = await mv(m); l = await level(store, A, null);
    check('E9 stock found comes in at the average', near(r.cost, 5500) && l.qty === 3000 && near(l.avg, 5500), JSON.stringify(r));

    // E10 a variant has its own level
    const V = (await one(`insert into item_variants (tenant_id, item_id, name, price) values ($1,$2,'Large',12000) returning id`, [tid, A])).id;
    await move(store, A, V, 2000, 'receive', 7000, 'delivery', id());
    const lv = await level(store, A, V); l = await level(store, A, null);
    check('E10 a variant keeps its own quantity and cost', lv.qty === 2000 && near(lv.avg, 7000) && l.qty === 3000 && near(l.avg, 5500), JSON.stringify(lv));
    check('E10 the item total covers its variants', (await total(A)) === 5000);

    // E11 a second shop has its own level
    await move(store2, A, null, 4000, 'receive', 4000, 'delivery', id());
    const l2 = await level(store2, A, null); l = await level(store, A, null);
    check('E11 each shop keeps its own', l2.qty === 4000 && near(l2.avg, 4000) && l.qty === 3000, JSON.stringify(l2));
    check('E11 the item total covers its shops', (await total(A)) === 9000);

    // E12 an item that carried a quantity before any level existed
    const B = await item('Legacy', 2500, 10000);
    await move(store, B, null, -1000, 'sale', null, 'receipt', id());
    l = await level(store, B, null);
    check('E12 the first level starts from what the item carried', l.qty === 9000 && near(l.avg, 2500) && (await total(B)) === 9000, JSON.stringify(l));
    await move(store2, B, null, 1000, 'found', null, null, null);
    const lb2 = await level(store2, B, null);
    check('E12 a later level in another shop starts from nothing', lb2.qty === 1000 && (await total(B)) === 10000, JSON.stringify(lb2));

    // E13 what does nothing, and what is refused
    m = await move(store, A, null, 0, 'adjust', null, null, null);
    check('E13 a move of nothing writes nothing', m === null);
    let e = await failsWith(`select stock_move($1,$2,$3,null,1000,'gift',null,null,null,$4,null)`, [tid, store, A, emp]);
    check('E13 an unknown reason is refused', e && e.code === '23514', e ? e.code : 'no error');
    e = await failsWith(`select stock_move($1,$2,$3,null,1000,'found',null,null,null,$4,null)`, [tid, store, id(), emp]);
    check('E13 an unknown item is refused', e && e.message === 'unknown-item', e ? e.message : 'no error');

    // E14 the first shop is the oldest
    check('E14 first_store is the oldest shop', (await one(`select first_store($1) as s`, [tid])).s === store);

    // E16 a count sets the item's total, whatever it was
    const C = await item('Counted', 3000, null);
    await move(store, C, null, 8000, 'receive', 3000, 'delivery', id());
    let d = (await one(`select stock_count_item($1,$2,$3,$4,$5,$6) as d`, [tid, store, C, 5000, emp, 'shelf count'])).d;
    l = await level(store, C, null);
    const cm = await one(`select qty, unit_cost::float8 as cost, note from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'count'`, [tid, C]);
    check('E16 a count sets the total and writes the difference, at the average',
      d === -3000 && l.qty === 5000 && (await total(C)) === 5000 && cm.qty === -3000 && near(cm.cost, 3000) && cm.note === 'shelf count', `${d} ${JSON.stringify(l)}`);
    d = (await one(`select stock_count_item($1,$2,$3,$4,$5,null) as d`, [tid, store, C, 5000, emp])).d;
    const counts = (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'count'`, [tid, C])).n;
    check('E16 counting what is there writes nothing', d === 0 && counts === 1, `${d} ${counts}`);
    e = await failsWith(`select stock_count_item($1,$2,$3,-1,$4,null)`, [tid, store, C, emp]);
    check('E16 a count below zero is refused', e && e.message === 'bad-count', e ? e.message : 'no error');

    // E15 the tenant role, with the two calls the back office makes
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    m = (await one(`select stock_move($1, $2, $3, null, $4, 'adjust', null, null, null, $5, $6) as id`, [tid, store, A, 1000, emp, 'a note'])).id;
    d = (await one(`select stock_count_item($1, $2, $3, $4, $5, $6) as d`, [tid, store, C, 6000, emp, null])).d;
    check('E15 the tenant role can adjust and count its own stock', Boolean(m) && d === 1000, `${m} ${d}`);
    await c.query(`select set_config('app.tenant_id', $1, true)`, [id()]);
    const seen = (await one(`select count(*)::int as n from stock_levels`)).n;
    check('E15 and sees no other tenant\'s levels', seen === 0, String(seen));
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'STOCK ENGINE PASS' : `STOCK ENGINE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
