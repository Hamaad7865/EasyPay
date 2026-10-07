// stock-adjust.test.cjs — migration 0073: a shop's stock, line by line.
//   - an adjustment has a reason, and the reason decides whether it takes
//     out or puts in; taking out never goes below zero
//   - a line of stock is a counted product, or each variant of one
//   - who may see stock, adjust it and see cost: the new permissions reach
//     the roles that could edit the catalog, and a new tenant's Manager
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/stock-adjust.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;
const NEW = ['stock.view', 'stock.receive', 'stock.adjust', 'stock.count', 'suppliers.edit', 'costs.view'];

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
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-sa@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Adjust Test','Main','SA1','Owner',$2,'standard') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const store2 = (await one(`insert into stores (tenant_id, name, code, created_at) values ($1,'Second','SA2', now() + interval '1 second') returning id`, [tid])).id;
    const counted = (await one(`insert into categories (tenant_id, name, is_stock) values ($1,'Drinks',true) returning id`, [tid])).id;
    const plain = (await one(`insert into categories (tenant_id, name) values ($1,'Services') returning id`, [tid])).id;
    const sup = (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id;
    const item = async (name, o = {}) => (await one(
      `insert into items (tenant_id, name, price, cost, track_stock, category_id, supplier_id, sku, barcode)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [tid, name, o.price ?? 10000, o.cost ?? null, o.track ?? true, o.cat ?? null, o.sup ?? null, o.sku ?? null, o.barcode ?? null])).id;
    const variant = async (it, name, o = {}) => (await one(
      `insert into item_variants (tenant_id, item_id, name, price, cost, deleted_at) values ($1,$2,$3,$4,$5,$6) returning id`,
      [tid, it, name, o.price ?? 10000, o.cost ?? null, o.gone ? new Date() : null])).id;
    const adjustSql = `select stock_adjust($1,$2,$3,$4,$5,$6,$7,$8) as id`;
    const adjust = async (st, it, va, units, reason, note) => (await one(adjustSql, [tid, st, it, va, units, reason, emp, note ?? null])).id;
    const refuses = (st, it, va, units, reason) => failsWith(adjustSql, [tid, st, it, va, units, reason, emp, null]);
    const move = async (st, it, va, qty, reason, cost, refType) => (await one(
      `select stock_move($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null) as id`, [tid, st, it, va, qty, reason, cost, refType, refType ? id() : null, emp])).id;
    const level = async (st, it, va) => one(
      `select qty, avg_cost::float8 as avg from stock_levels
        where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va]);
    const mv = async (m) => one(`select qty, reason, unit_cost::float8 as cost, store_id, employee_id, note, ref_id from stock_movements where id = $1`, [m]);
    const moves = async (it) => (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and item_id = $2`, [tid, it])).n;

    // ---- adjustments ----
    const shirt = await item('Shirt', { cost: 4000, sup, sku: 'SH-1', barcode: '2000000000015' });
    await move(store, shirt, null, 10000, 'receive', 4000, 'delivery');

    // A1 each reason that takes out
    let m = await adjust(store, shirt, null, 2000, 'damaged', 'torn in the stockroom');
    let l = await level(store, shirt, null), r = await mv(m);
    check('A1 damaged goods leave the line, at its average cost', l.qty === 8000 && near(l.avg, 4000) && r.qty === -2000 && r.reason === 'damaged' && near(r.cost, 4000), JSON.stringify([l, r]));
    check('A1 the movement keeps the shop, who and why', r.store_id === store && r.employee_id === emp && r.note === 'torn in the stockroom' && r.ref_id === null, JSON.stringify(r));
    const outs = [];
    for (const reason of ['expired', 'lost', 'internal', 'supplier_return']) {
      r = await mv(await adjust(store, shirt, null, 1000, reason));
      outs.push(r.reason + ':' + r.qty);
    }
    l = await level(store, shirt, null);
    check('A1 expired, lost, used in the shop and returned to the supplier all take out', outs.join() === 'expired:-1000,lost:-1000,internal:-1000,supplier_return:-1000' && l.qty === 4000 && near(l.avg, 4000), outs.join() + ' ' + JSON.stringify(l));

    // A2 the floor
    const before = await moves(shirt);
    let e = await refuses(store, shirt, null, 5000, 'damaged');
    l = await level(store, shirt, null);
    check('A2 taking out more than the line holds is refused, and nothing changes', said(e) === 'not-enough-stock' && l.qty === 4000 && (await moves(shirt)) === before, said(e) + ' ' + l.qty);
    await adjust(store, shirt, null, 4000, 'lost');
    l = await level(store, shirt, null);
    check('A2 taking out exactly what it holds leaves zero, and the line stays', l && l.qty === 0, JSON.stringify(l));

    // A3 found
    r = await mv(await adjust(store, shirt, null, 3000, 'found'));
    l = await level(store, shirt, null);
    check('A3 stock found comes in at the line\'s average', r.qty === 3000 && r.reason === 'found' && near(r.cost, 4000) && l.qty === 3000 && near(l.avg, 4000), JSON.stringify([r, l]));
    const cap = await item('Cap', { cost: 1500 });
    await adjust(store, cap, null, 1000, 'found');
    l = await level(store, cap, null);
    check('A3 on a line that never had stock, at the product\'s cost', l.qty === 1000 && near(l.avg, 1500), JSON.stringify(l));

    // A4 what is not an adjustment
    const badQty = [];
    for (const q of [0, -1000, null]) badQty.push(said(await refuses(store, shirt, null, q, 'damaged')));
    check('A4 a quantity of nothing, or less, is refused', badQty.every((x) => x === 'bad-quantity'), badQty.join());
    const badReason = [];
    for (const reason of ['adjust', 'sale', 'refund', 'receive', 'count', 'opening', 'gift', null]) badReason.push(said(await refuses(store, shirt, null, 1000, reason)));
    check('A4 only the six reasons are adjustments', badReason.every((x) => x === 'bad-reason'), badReason.join());

    // A5 variants
    const tee = await item('Tee', { cost: 2000, price: 10000 });
    const teeM = await variant(tee, 'M', { cost: 2000, price: 12000 });
    const teeL = await variant(tee, 'L', { cost: 2500 });
    const teeS = await variant(tee, 'S', { gone: true });
    await move(store, tee, teeM, 5000, 'receive', 2000, 'delivery');
    e = await refuses(store, tee, null, 1000, 'damaged');
    check('A5 a product with variants is adjusted on a variant', said(e) === 'pick-variant', said(e));
    await adjust(store, tee, teeM, 1000, 'damaged');
    check('A5 and the variant\'s own line moves', (await level(store, tee, teeM)).qty === 4000);
    const strangers = [said(await refuses(store, tee, teeS, 1000, 'found')), said(await refuses(store, shirt, teeM, 1000, 'found')), said(await refuses(store, tee, id(), 1000, 'found'))];
    check('A5 a removed variant, another product\'s, or one that never was, is refused', strangers.every((x) => x === 'unknown-line'), strangers.join());

    // A6 what is not counted
    const fee = await item('Bag fee', { track: false, cat: plain });
    e = await refuses(store, fee, null, 1000, 'found');
    check('A6 a product that is not counted has no stock to adjust', said(e) === 'not-counted', said(e));
    const soda = await item('Soda', { track: false, cat: counted, cost: 800 });
    check('A6 a product of a counted category is counted', Boolean(await adjust(store, soda, null, 2000, 'found')));

    // A7 the other shop
    await move(store2, shirt, null, 6000, 'receive', 4000, 'delivery');
    await adjust(store, shirt, null, 1000, 'damaged');
    check('A7 another shop\'s line of the same product is untouched', (await level(store2, shirt, null)).qty === 6000 && (await level(store, shirt, null)).qty === 2000);
    e = await refuses(id(), shirt, null, 1000, 'found');
    check('A7 a shop that is not the tenant\'s has no stock to adjust', said(e) === 'unknown-store', said(e));

    // A8 the engine itself is as it was (a restaurant's Stock page)
    await move(store, cap, null, -5000, 'adjust', null, null);
    check('A8 the engine still lets a plain adjustment go below zero', (await level(store, cap, null)).qty === -4000);

    // ---- the lines of Stock on hand ----
    const mug = await item('Mug', { cost: 900, price: 3200, sup, cat: counted });
    const old = await item('Old line', { cost: 100 });
    await c.query(`update items set deleted_at = now() where id = $1`, [old]);
    await c.query(`select stock_set_reorder($1,$2,$3,$4,$5)`, [tid, store, shirt, 6000, 12000]);
    // what the shirt sold: 2 in this shop, 1 came back, 1 in the other shop, 1 forty days ago
    await move(store, shirt, null, 10000, 'receive', 4000, 'delivery');
    await move(store, shirt, null, -2000, 'sale', null, 'receipt');
    await move(store, shirt, null, 1000, 'refund', 4000, 'receipt');
    await move(store2, shirt, null, -1000, 'sale', null, 'receipt');
    const long = await move(store, shirt, null, -1000, 'sale', null, 'receipt');
    await c.query(`update stock_movements set created_at = now() - interval '40 days' where id = $1`, [long]);

    const lines = (await c.query(`select * from stock_on_hand($1, $2) order by name, variant nulls first`, [tid, store])).rows;
    const key = (x) => x.name + (x.variant ? ' / ' + x.variant : '');
    const names = lines.map(key).join(' | ');
    check('L1 a line is a counted product, or each live variant of one', names === 'Cap | Mug | Shirt | Soda | Tee / L | Tee / M', names);
    const by = Object.fromEntries(lines.map((x) => [key(x), x]));
    check('L2 a line that never had stock here shows nothing on hand, at its own cost, else the product\'s',
      by['Tee / L'].qty === 0 && near(by['Tee / L'].avg_cost, 2500) && by.Mug.qty === 0 && near(by.Mug.avg_cost, 900), JSON.stringify([by['Tee / L'], by.Mug]));
    const s = by.Shirt;
    check('L3 a line carries what this shop holds, its cost and its reorder level', s.qty === 10000 && near(s.avg_cost, 4000) && s.reorder_point === 6000 && s.reorder_qty === 12000, JSON.stringify(s));
    check('L3 its codes, its category and its supplier', s.sku === 'SH-1' && s.barcode === '2000000000015' && s.supplier === 'Textiles Ocean' && s.supplier_id === sup
      && by.Mug.category === 'Drinks' && by.Mug.category_id === counted && s.category === null, JSON.stringify(s));
    check('L3 the price it sells at: the variant\'s, else the product\'s', Number(by['Tee / M'].price) === 12000 && Number(by['Tee / L'].price) === 10000 && Number(by.Mug.price) === 3200);
    check('L3 what it sold here in 30 days, less what came back', s.sold30 === 1000 && by['Tee / M'].sold30 === 0, String(s.sold30));
    const there = (await c.query(`select name, qty, sold30 from stock_on_hand($1, $2) where name = 'Shirt'`, [tid, store2])).rows[0];
    check('L3 the other shop has its own figures', there.qty === 5000 && there.sold30 === 1000, JSON.stringify(there));

    // ---- who may ----
    const held = async (roleId) => (await c.query(`select p, count(*)::int as n from roles r, jsonb_array_elements_text(r.permissions) p where r.id = $1 group by p`, [roleId])).rows;
    const has = (rows) => NEW.map((p) => rows.find((x) => x.p === p)?.n ?? 0).join('');
    const role = async (name) => (await one(`select id from roles where tenant_id = $1 and name = $2`, [tid, name])).id;
    check('P2 a new tenant\'s Manager holds the six, its Cashier and Waiter none',
      has(await held(await role('Manager'))) === '111111' && has(await held(await role('Cashier'))) === '000000' && has(await held(await role('Waiter'))) === '000000',
      [has(await held(await role('Manager'))), has(await held(await role('Cashier')))].join(' '));
    const clerk = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Stock clerk','["items.edit","backoffice.access"]') returning id`, [tid])).id;
    const greeter = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Greeter','["sale.create"]') returning id`, [tid])).id;
    const first = (await one(`select grant_stock_perms($1) as n`, [tid])).n;
    check('P1 a role that could edit the catalog is given the six, once each', first === 1 && has(await held(clerk)) === '111111', first + ' ' + has(await held(clerk)));
    const again = (await one(`select grant_stock_perms($1) as n`, [tid])).n;
    check('P1 granting again adds nothing', again === 0 && has(await held(clerk)) === '111111', again + ' ' + has(await held(clerk)));
    check('P1 a role that could not is given none', has(await held(greeter)) === '000000');
    const kept = (await held(clerk)).filter((x) => x.p === 'items.edit' || x.p === 'backoffice.access').length;
    check('P1 and what a role already held is kept', kept === 2);

    // T1 the tenant role
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    m = await adjust(store, soda, null, 1000, 'internal', 'staff drinks');
    const mine = (await one(`select count(*)::int as n from stock_on_hand($1, $2)`, [tid, store])).n;
    check('T1 the tenant role can adjust and read its own stock', Boolean(m) && mine === 6, `${m} ${mine}`);
    await c.query(`select set_config('app.tenant_id', $1, true)`, [id()]);
    const theirs = (await one(`select count(*)::int as n from stock_on_hand($1, $2)`, [tid, store])).n;
    check('T1 and sees no line of another tenant', theirs === 0, String(theirs));
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'STOCK ADJUST PASS' : `STOCK ADJUST FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
