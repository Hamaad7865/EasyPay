// fill-test-shop.cjs — gives a retail test client on dev something to sell.
// It puts the debug build's made-up catalog into the client: 13 products in
// five categories (one with eight size and colour variants, one sold by
// weight), their barcodes and SKUs, a supplier, and the opening stock, so a
// till signed in to that client shows the retail screens with products and
// stock on them, and the back office has stock to count and reorder.
//
// The client itself, and its login, are made in /admin by the platform admin:
// this script makes neither. Dev only: db/tests/require-dev.cjs refuses
// production before a connection is opened.
//
// Usage:
//   node db/scripts/fill-test-shop.cjs "<client name>"            what it would do; nothing is kept
//   node db/scripts/fill-test-shop.cjs "<client name>" --apply    does it
//   node db/scripts/fill-test-shop.cjs --selftest                 makes a throwaway shop, fills it, checks it, rolls back
// It refuses a client that is not a shop, and one that already has products.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const selftest = args.includes('--selftest');
const name = args.find((a) => !a.startsWith('--'));
if (!selftest && !name) { console.error('usage: node db/scripts/fill-test-shop.cjs "<client name>" [--apply]   or   --selftest'); process.exit(1); }

const shop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'debug', 'assets', 'demo-shop.json'), 'utf8'));
const id = () => crypto.randomUUID();

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  let kept = false;
  try {
    let tid;
    if (selftest) {
      const admin = id();
      await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'fill-selftest@example.com')`, [admin]);
      tid = (await one(`select platform.create_tenant_of_type($1,'Fill selftest','Main','FST1','Owner',$2,'standard','retail') as r`, [admin, id()])).r.tenant_id;
    } else {
      const found = (await c.query(`select id, name, business_type from tenants where lower(btrim(name)) = lower(btrim($1))`, [name])).rows;
      if (found.length === 0) throw new Error(`no client is called "${name}" on dev. Make it in /admin first (New client, type Shop).`);
      if (found.length > 1) throw new Error(`${found.length} clients are called "${name}": rename one.`);
      if (found[0].business_type !== 'retail') throw new Error(`"${found[0].name}" is a restaurant, not a shop: nothing was done.`);
      tid = found[0].id;
    }
    const has = (await one(`select count(*)::int as n from items where tenant_id = $1`, [tid])).n;
    if (has > 0) throw new Error(`this client already has ${has} products: nothing was done (the catalog is not mixed into one that exists).`);
    const store = (await one(`select first_store($1) as id`, [tid])).id;
    const owner = (await one(`select id from employees where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [tid])).id;
    const tax = await one(`select id, name, rate_bp, type from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, created_at limit 1`, [tid]);
    if (!store || !owner || !tax) throw new Error('the client has no store, no member of staff or no tax: it was not made the usual way');

    // every id is new: the made-up shop's own ids belong to the replay tests
    const cats = new Map();
    for (const k of shop.categories) {
      const kid = id();
      cats.set(k.id, kid);
      await c.query(`insert into categories (id, tenant_id, name) values ($1,$2,$3)`, [kid, tid, k.name]);
    }
    const supplier = (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id;
    const clothing = shop.categories.find((k) => k.name === 'Clothing')?.id;
    let products = 0, variants = 0, lines = 0;
    for (const it of shop.items) {
      const iid = id();
      await c.query(
        `insert into items (id, tenant_id, category_id, name, price, cost, sku, barcode, sold_by, track_stock, option_names, supplier_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [iid, tid, cats.get(it.category) ?? null, it.name, it.price, it.cost, it.sku, it.barcode, it.sold_by, it.track_stock, it.options, it.category === clothing ? supplier : null],
      );
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, iid, tax.id]);
      products++;
      const stocked = [];
      for (const v of it.variants) {
        const vid = id();
        await c.query(`insert into item_variants (id, tenant_id, item_id, name, price, cost, sku, barcode, option_values) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vid, tid, iid, v.name, v.price, v.cost, v.sku, v.barcode, v.values]);
        stocked.push([vid, v.stock, v.cost]);
        variants++;
      }
      if (!it.variants.length) stocked.push([null, it.stock, it.cost]);
      // what the shop holds, as opening stock at the product's cost
      if (it.track_stock) for (const [va, qty, cost] of stocked) {
        if (qty > 0) { await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',$6,'import',$7,$8,null)`, [tid, store, iid, va, qty, cost, id(), owner]); lines++; }
      }
    }
    // one line below its reorder point, so the reorder list and "Add what is low" have something
    await c.query(
      `update stock_levels set reorder_point = qty + 5000, reorder_qty = 12000
        where tenant_id = $1 and (item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) in (
          select item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid) from stock_levels where tenant_id = $1 and qty > 0 order by qty limit 1)`, [tid]);

    const got = await one(
      `select (select count(*)::int from items where tenant_id = $1) as products,
              (select count(*)::int from item_variants where tenant_id = $1) as variants,
              (select count(*)::int from stock_levels where tenant_id = $1 and qty > 0) as stocked,
              (select count(*)::int from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null) as exchange,
              (select name from tenants where id = $1) as name`, [tid]);
    // as a till would get it: the catalog and the stock are in the pull
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const page = (await one('select sync_pull($1, 0, 1000) as r', [store])).r;
    await c.query('RESET ROLE');
    const pulled = (t) => (page.changes[t] || []).length;
    const ok = got.products === shop.items.length && got.products === products && got.variants === variants && got.stocked === lines
      && pulled('items') === products && pulled('item_variants') === variants && pulled('stock_levels') >= lines && got.exchange === 1;
    console.log(`${got.name}: ${got.products} products, ${got.variants} variants, ${got.stocked} lines of stock, one supplier; tax on them: ${tax.name}.`);
    console.log(`A till that syncs is sent ${pulled('items')} products, ${pulled('item_variants')} variants, ${pulled('stock_levels')} stock figures and ${pulled('payment_types')} payment types.`);
    if (!ok) throw new Error('the figures do not add up: nothing was kept');
    if (apply && !selftest) { await c.query('COMMIT'); kept = true; console.log('Done: the client is filled.'); }
    else console.log(selftest ? 'Selftest passed. Nothing was kept.' : 'Nothing was kept. Run again with --apply to fill the client.');
  } finally {
    if (!kept) await c.query('ROLLBACK');
    await c.end();
  }
})().catch((e) => { console.error('STOPPED: ' + e.message); process.exit(1); });
