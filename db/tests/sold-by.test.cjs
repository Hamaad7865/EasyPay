// sold-by.test.cjs — a shop's product sold by the kilo, set by the shop itself
// (migration 0131): the till's item.save (push_item_save) and the import
// (catalog_import) read how a product is sold, and a change of unit is
// refused while the product counts stock and holds any (item_holds_stock).
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/sold-by.test.cjs
//   WITH_MIGRATION=db/migrations/0131_sold_by.sql runs that file inside the
//   transaction first, to try it before it is applied to dev.
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    if (process.env.WITH_MIGRATION) await c.query(fs.readFileSync(process.env.WITH_MIGRATION, 'utf8'));
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-soldby@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Sold By Test','Main','SB1','Owner',$2,'offline','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;

    // what item.save says: "done", or the code it was refused with
    async function save(p) {
      const name = 'sp' + (++sp);
      await c.query('SAVEPOINT ' + name);
      try { await c.query(`select push_item_save($1,$2,$3::jsonb)`, [tid, emp, JSON.stringify(p)]); await c.query('RELEASE SAVEPOINT ' + name); return 'done'; }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e.message; }
    }
    const item = async (i) => one(`select name, price, sold_by, open_price, track_stock from items where tenant_id = $1 and id = $2`, [tid, i]);
    const stock = async (i, qty) => c.query(`select stock_move($1,$2,$3,null,$4,'adjust',0,'test',null,$5,'test')`, [tid, store, i, qty, emp]);

    // S1 a new product, by the kilo or as before
    const wash = id(), towel = id();
    check('S1 a new product sold by the kilo', (await save({ id: wash, name: 'Wash & fold', price: 12000, sold_by: 'weight', track_stock: false })) === 'done'
      && (await item(wash)).sold_by === 'weight');
    check('S1 a new product saved with no sold_by is sold each', (await save({ id: towel, name: 'Towel', price: 30000 })) === 'done'
      && (await item(towel)).sold_by === 'each');

    // S2 an older tablet's save sends no sold_by: the unit stays
    check('S2 a save with no sold_by keeps it', (await save({ id: wash, name: 'Wash & fold', price: 13000 })) === 'done'
      && (await item(wash)).sold_by === 'weight' && Number((await item(wash)).price) === 13000);

    // S3 by the kilo and at the sale exclude each other
    check('S3 by the kilo with its price typed at the sale is refused (new)', (await save({ id: id(), name: 'X', price: 0, sold_by: 'weight', open_price: true })) === 'open-price-not-here');
    check('S3 and on an existing product', (await save({ id: wash, name: 'Wash & fold', price: 0, sold_by: 'weight', open_price: true })) === 'open-price-not-here');
    check('S3 an old tablet asking for a typed price on a kilo product is still refused', (await save({ id: wash, name: 'Wash & fold', price: 0, open_price: true })) === 'open-price-not-here');
    const pkg = id();
    await save({ id: pkg, name: 'Package', price: 50000, sold_by: 'weight', track_stock: false });
    const atSale = await save({ id: pkg, name: 'Package', price: 0, sold_by: 'each', open_price: true });
    const p = await item(pkg);
    check('S3 from by the kilo to at the sale in one save', atSale === 'done' && p.sold_by === 'each' && p.open_price === true && Number(p.price) === 0 && p.track_stock === false, atSale + ' ' + JSON.stringify(p));

    // S4 a change of unit while it counts stock and holds some
    const rice = id();
    await save({ id: rice, name: 'Rice', price: 5000, track_stock: true });
    await stock(rice, 5000);
    check('S4 a counted product holding stock cannot change unit', (await save({ id: rice, name: 'Rice', price: 5000, sold_by: 'weight' })) === 'unit-has-stock');
    check('S4 nor when the change only says its unit again with counting on', (await save({ id: rice, name: 'Rice', price: 5000, sold_by: 'weight', track_stock: true })) === 'unit-has-stock');
    check('S4 the same unit sent again is no change', (await save({ id: rice, name: 'Rice', price: 5500, sold_by: 'each' })) === 'done');
    const off = await save({ id: rice, name: 'Rice', price: 5000, sold_by: 'weight', track_stock: false });
    check('S4 with counting turned off in the same save, it changes', off === 'done' && (await item(rice)).sold_by === 'weight' && (await item(rice)).track_stock === false, off);
    const beans = id();
    await save({ id: beans, name: 'Beans', price: 5000, track_stock: true });
    await stock(beans, 2000); await stock(beans, -2000);
    check('S4 counted at zero, it changes', (await save({ id: beans, name: 'Beans', price: 5000, sold_by: 'weight' })) === 'done' && (await item(beans)).sold_by === 'weight');

    // S5 a unit the server does not know
    check('S5 sold_by litre is a bad payload', /bad-payload/.test(await save({ id: id(), name: 'Milk', price: 4000, sold_by: 'litre' })));

    // the import
    const run = async (rows, dry = false) => (await one(`select catalog_import($1,$2,$3,$4::jsonb,$5) as r`, [tid, store, emp, JSON.stringify(rows.map((r, i) => ({ n: i + 2, ...r }))), dry])).r;
    const named = async (n) => one(`select id, price, sold_by, open_price, track_stock from items where tenant_id = $1 and name = $2 and deleted_at is null`, [tid, n]);

    // S6 the two new keys, and a row without them
    let r = await run([
      { name: 'Ironing', price: 11000, sold_by: 'weight', tax: 'VAT' },
      { name: 'Chemise', sold_by: 'open', tax: 'VAT' },
      { name: 'Pick-up', price: 12500, count_stock: false },
      { name: 'Laundry bag', price: 15500 },
    ]);
    check('S6 four products go in', r.new_products === 4 && r.problems.length === 0, JSON.stringify(r.problems));
    const ir = await named('Ironing'), ch = await named('Chemise'), pu = await named('Pick-up'), lb = await named('Laundry bag');
    check('S6 by the kilo, counted as a new product is', ir.sold_by === 'weight' && !ir.open_price && ir.track_stock === true && Number(ir.price) === 11000, JSON.stringify(ir));
    check('S6 at the sale with no price: typed at the sale, Rs 0, not counted', ch.sold_by === 'each' && ch.open_price === true && Number(ch.price) === 0 && ch.track_stock === false, JSON.stringify(ch));
    check('S6 count stock no', pu.sold_by === 'each' && pu.track_stock === false && Number(pu.price) === 12500, JSON.stringify(pu));
    check('S6 a row without them, as before', lb.sold_by === 'each' && !lb.open_price && lb.track_stock === true, JSON.stringify(lb));

    // S7 what the import refuses
    const why = async (row) => ((await run([row], true)).problems[0] || {}).why;
    check('S7 at the sale with options', (await why({ name: 'Shirt', sold_by: 'open', o1: 'Size', v1: 'M' })) === 'open-price-not-here');
    check('S7 at the sale with an opening stock', (await why({ name: 'Bag', sold_by: 'open', stock: 3000 })) === 'stock-not-counted');
    check('S7 count stock no with an opening stock', (await why({ name: 'Bag', price: 100, count_stock: false, stock: 3000 })) === 'stock-not-counted');
    check('S7 an unknown sold by', (await why({ name: 'Bag', price: 100, sold_by: 'litre' })) === 'bad-sold-by');
    check('S7 at the sale with no price is not price-missing', (await why({ name: 'Bag', sold_by: 'open' })) === undefined);
    check('S7 no price and no at the sale is still price-missing', (await why({ name: 'Bag' })) === 'price-missing');
    await stock(lb.id, 4000);
    check('S7 by the kilo on a counted product holding stock', (await why({ name: 'Laundry bag', price: 15500, sold_by: 'weight' })) === 'unit-has-stock');
    check('S7 the same with count stock no goes in', (await why({ name: 'Laundry bag', price: 15500, sold_by: 'weight', count_stock: false })) === undefined);
    const shirt = id();
    await save({ id: shirt, name: 'Shirt', price: 50000, track_stock: false });
    await c.query(`insert into item_variants (tenant_id, item_id, name, price, option_values) values ($1, $2, 'M', 50000, array['M'])`, [tid, shirt]);
    check('S7 at the sale on an existing product with variants', (await why({ name: 'Shirt', sold_by: 'open' })) === 'open-price-not-here');

    // S8 an existing product changes only where the row says
    r = await run([{ name: 'Ironing', price: 11500 }, { name: 'Pick-up', price: 12500, count_stock: true }, { name: 'Chemise', price: 20000, sold_by: 'each' }]);
    const ir2 = await named('Ironing'), pu2 = await named('Pick-up'), ch2 = await named('Chemise');
    check('S8 no sold by: the kilo stays, the price moves', r.problems.length === 0 && ir2.sold_by === 'weight' && Number(ir2.price) === 11500, JSON.stringify(r.problems));
    check('S8 count stock yes turns counting on', pu2.track_stock === true);
    check('S8 sold by each takes the price off the till\'s keypad', ch2.open_price === false && ch2.sold_by === 'each' && Number(ch2.price) === 20000, JSON.stringify(ch2));
    r = await run([{ name: 'Pick-up', price: 12500, sold_by: 'open' }]);
    const pu3 = await named('Pick-up');
    check('S8 sold by at the sale: typed at the sale, not counted', pu3.open_price === true && Number(pu3.price) === 0 && pu3.track_stock === false, JSON.stringify(pu3));

    // the shared rule
    check('item_holds_stock says so', (await one(`select item_holds_stock($1,$2) as h`, [tid, lb.id])).h === true
      && (await one(`select item_holds_stock($1,$2) as h`, [tid, pu.id])).h === false);
  } catch (e) {
    console.log('FAIL the suite stopped: ' + e.message);
    failures++;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
