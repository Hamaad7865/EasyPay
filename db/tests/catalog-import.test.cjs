// catalog-import.test.cjs — a shop's catalog from a spreadsheet (migration
// 0071, catalog_import).
//   - a dry run saves nothing and says what would happen, row by row
//   - a real run makes products, variants, categories and suppliers, sets the
//     tax and the reorder level, and books opening stock at its cost
//   - the same file again changes nothing and does not double the stock
//   - a product with a row that has a problem is left out whole; the others go in
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/catalog-import.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-imp@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Import Test','Main','IM1','Owner',$2,'standard') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const run = async (rows, dry) => (await one(`select catalog_import($1,$2,$3,$4::jsonb,$5) as r`, [tid, store, emp, JSON.stringify(rows), dry])).r;
    const count = async (table) => (await one(`select count(*)::int as n from ${table} where tenant_id = $1 and deleted_at is null`, [tid])).n;
    const itemsBefore = await count('items');

    const shirt = (v1, v2, more = {}) => ({ name: 'Linen shirt', category: 'Clothing', brand: 'Atelier Sud', supplier: 'Textiles Ocean', supplier_code: 'TO-LS',
      o1: 'Size', v1, o2: 'Colour', v2, price: 129000, cost: 62000, tax: 'VAT', reorder: 6000, order_qty: 12000, ...more });
    const rows = [
      shirt('M', 'White', { sku: 'LS-M-WH', barcode: '5901234123457', stock: 14000 }),
      shirt('L', 'Navy', { sku: 'LS-L-NV', stock: 3000 }),
      { name: 'Ceramic mug', category: 'Home', price: 32000, cost: 14000, barcode: '4006381333931', stock: 26000 },
      { name: 'Gift wrapping', price: 5000 },
    ].map((r, i) => ({ n: i + 2, ...r }));

    // I1 a dry run saves nothing
    let r = await run(rows, true);
    check('I1 a dry run says what would happen', r.dry === true && r.rows === 4 && r.good === 4 && r.new_products === 3 && r.new_lines === 4 && r.problems.length === 0, JSON.stringify(r));
    check('I1 and saves nothing', (await count('items')) === itemsBefore && (await count('suppliers')) === 0);

    // I2 a real run
    r = await run(rows, false);
    check('I2 the run reports what it made', r.dry === false && r.products === 3 && r.new_products === 3 && r.lines === 4 && r.new_lines === 4 && r.stock_set === 3, JSON.stringify(r));
    const sh = await one(`select i.id, i.price, i.cost, i.brand, i.supplier_code, i.option_names, i.track_stock, c.name as cat, s.name as sup,
        (select t.name from item_taxes it join taxes t on t.id = it.tax_id where it.item_id = i.id and it.deleted_at is null) as tax
      from items i left join categories c on c.id = i.category_id left join suppliers s on s.id = i.supplier_id
      where i.tenant_id = $1 and i.name = 'Linen shirt' and i.deleted_at is null`, [tid]);
    check('I2 a product with its category, supplier, brand, tax and options',
      sh && Number(sh.price) === 129000 && Number(sh.cost) === 62000 && sh.brand === 'Atelier Sud' && sh.supplier_code === 'TO-LS' && sh.cat === 'Clothing'
        && sh.sup === 'Textiles Ocean' && JSON.stringify(sh.option_names) === '["Size","Colour"]' && sh.track_stock === true && /vat/i.test(sh.tax || ''), JSON.stringify(sh));
    const vs = (await c.query(`select v.id, v.name, v.sku, v.barcode, v.price, v.option_values from item_variants v where v.item_id = $1 and v.deleted_at is null order by v.name`, [sh.id])).rows;
    check('I2 its variants, each with its codes', vs.length === 2 && vs[1].name === 'M / White' && vs[1].sku === 'LS-M-WH' && vs[1].barcode === '5901234123457' && vs[0].name === 'L / Navy', JSON.stringify(vs));
    const lev = async (item, variant) => one(`select qty, avg_cost::float8 as avg, reorder_point, reorder_qty from stock_levels where tenant_id = $1 and item_id = $2 and variant_id is not distinct from $3`, [tid, item, variant]);
    const lmw = await lev(sh.id, vs[1].id);
    check('I2 opening stock at its cost, with the reorder level', lmw && lmw.qty === 14000 && near(lmw.avg, 62000) && lmw.reorder_point === 6000 && lmw.reorder_qty === 12000, JSON.stringify(lmw));
    const om = await one(`select count(*)::int as n, min(reason) as reason from stock_movements where tenant_id = $1 and item_id = $2`, [tid, sh.id]);
    check('I2 booked as opening stock', om.n === 2 && om.reason === 'opening', JSON.stringify(om));
    const mug = await one(`select id, barcode, stock_qty from items where tenant_id = $1 and name = 'Ceramic mug' and deleted_at is null`, [tid]);
    check('I2 a simple product carries its own barcode and stock', mug && mug.barcode === '4006381333931' && mug.stock_qty === 26000, JSON.stringify(mug));
    const wrap = await one(`select (select count(*)::int from item_taxes it where it.item_id = i.id and it.deleted_at is null) as taxes from items i where i.tenant_id = $1 and i.name = 'Gift wrapping'`, [tid]);
    check('I2 a row with no tax named gets the default tax', wrap && wrap.taxes === 1, JSON.stringify(wrap));

    // I3 the same file again
    r = await run(rows, false);
    const lmw2 = await lev(sh.id, vs[1].id);
    check('I3 the same file again makes nothing new', r.new_products === 0 && r.new_lines === 0 && r.products === 3 && (await count('items')) === itemsBefore + 3, JSON.stringify(r));
    check('I3 and does not double the stock', r.stock_set === 0 && r.stock_skipped === 3 && lmw2.qty === 14000, JSON.stringify(lmw2));

    // I4 a changed file changes what it names
    r = await run([{ n: 2, ...shirt('M', 'White', { price: 135000 }) }, { n: 3, ...shirt('XL', 'White', { price: 135000 }) }], false);
    const after = (await c.query(`select name, price, sku from item_variants where item_id = $1 and deleted_at is null order by name`, [sh.id])).rows;
    check('I4 a price in the file is the price now, a line not in it is left alone, a new line is made',
      r.new_lines === 1 && after.length === 3 && Number(after.find((v) => v.name === 'M / White').price) === 135000
        && after.find((v) => v.name === 'M / White').sku === 'LS-M-WH' && Number(after.find((v) => v.name === 'L / Navy').price) === 135000, JSON.stringify(after));

    // I5 problems, row by row
    const bad = [
      { n: 2, name: '', price: 100 },
      { n: 3, name: 'Scarf', o1: 'Colour', price: 100 },
      { n: 4, name: 'Hat', price: 45000, barcode: '4006381333931' },
      { n: 5, name: 'Glove', price: 100, barcode: '111' }, { n: 6, name: 'Sock', price: 100, barcode: '111' },
      { n: 7, name: 'Belt', price: 100, tax: 'Luxury tax' },
      { n: 8, name: 'Coat', o1: 'Size', v1: 'M', price: 100 }, { n: 9, name: 'Coat', o1: 'Colour', v1: 'Red', price: 100 },
      { n: 10, name: 'Cap', o1: 'Size', v1: 'M', price: 100 }, { n: 11, name: 'Cap', o1: 'Size', v1: 'm', price: 100 },
      { n: 12, name: 'Tie', price: null },
      { n: 13, name: 'Linen shirt', price: 100 },
      { n: 14, name: 'Bag', o1: 'Size', v1: 'S', price: 100 }, { n: 15, name: 'Bag', o1: 'Size', v1: 'L', price: 100, barcode: '5901234123457' },
      { n: 16, name: 'Umbrella', price: 78000, sku: 'UMB' },
    ];
    r = await run(bad, true);
    const why = Object.fromEntries(r.problems.map((p) => [p.n, p.why]));
    check('I5 each problem is named on its row',
      why[2] === 'name-missing' && why[3] === 'bad-options' && why[4] === 'barcode-taken' && why[5] === 'barcode-twice' && why[6] === 'barcode-twice'
        && why[7] === 'tax-unknown' && why[8] === 'options-differ' && why[9] === 'options-differ' && why[10] === 'duplicate-line' && why[11] === 'duplicate-line'
        && why[12] === 'price-missing' && why[13] === 'options-differ' && why[15] === 'barcode-taken', JSON.stringify(why));
    check('I5 a product with a bad row is left out whole, and a clean one is good', why[14] === 'product-has-problems' && why[16] === undefined && r.good === 1, JSON.stringify(r.good));
    r = await run(bad, false);
    const umb = await one(`select count(*)::int as n from items where tenant_id = $1 and name in ('Umbrella') and deleted_at is null`, [tid]);
    const bag = await one(`select count(*)::int as n from items where tenant_id = $1 and name in ('Bag','Hat','Coat') and deleted_at is null`, [tid]);
    check('I5 only the clean product goes in', r.products === 1 && umb.n === 1 && bag.n === 0, JSON.stringify(r));

    // I6 too much at once
    const e = await failsWith(`select catalog_import($1,$2,$3,$4::jsonb,true)`, [tid, store, emp, JSON.stringify(Array.from({ length: 5001 }, (_, i) => ({ n: i, name: 'x' + i, price: 1 })))]);
    check('I6 more than 5000 rows are refused', e && e.message === 'too-many-rows', e ? e.message : 'no error');

    // I7 the tenant role. The function's work table goes with its transaction;
    // this suite is one transaction under two roles, so the table the owner's
    // calls left is dropped here by hand before the other role makes its own.
    await c.query('drop table if exists _imp');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    r = await run([{ n: 2, name: 'Keyring', category: 'Gifts', supplier: 'Second supplier', price: 9000, cost: 3000, stock: 5000 }], false);
    check('I7 the tenant role can import into its own tenant', r.products === 1 && r.stock_set === 1, JSON.stringify(r));
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'CATALOG IMPORT PASS' : `CATALOG IMPORT FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
