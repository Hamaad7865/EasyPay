// sub-categories.test.cjs — a category under another, one level deep (migration 0145): Shirt › Long
// Sleeve. Checks S1 to S8. Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/sub-categories.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, text, code } = require('./page.cjs');

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
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const all = async (sql, params) => (await c.query(sql, params)).rows;
  const id = () => crypto.randomUUID();
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-subcat@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Sub Test','Main','SB1','Owner',$2,'premium') as r`, [admin, id()])).r;
    const other = (await one(`select platform.create_tenant($1,'Sub Other','Main','SB2','Owner',$2,'premium') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id, uid = other.tenant_id;
    const printer = (await one(`insert into printers (tenant_id, store_id, name) values ($1,$2,'Bar') returning id`, [tid, store])).id;
    const cat = async (name, extra = {}, t = tid) => (await one(
      `insert into categories (tenant_id, name, color, is_stock, mra_nature, printer_ids, parent_id, follows_parent)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,true)) returning *`,
      [t, name, extra.color ?? null, extra.is_stock ?? false, extra.mra_nature ?? null, extra.printer_ids ?? '{}', extra.parent ?? null, extra.follows ?? null]));
    const row = (cid) => one(`select * from categories where id = $1`, [cid]);

    // S1 a sub takes its parent's settings, and keeps taking them while it follows it
    const shirt = await cat('Shirt', { color: '#aa0000', is_stock: true, mra_nature: 'goods', printer_ids: [printer] });
    const long = await cat('Long Sleeve', { parent: shirt.id, color: '#00ff00' });
    check('S1 a sub is made under its category', long.parent_id === shirt.id);
    check('S1 it takes the parent\'s colour, counting, printers and MRA nature', long.color === '#aa0000' && long.is_stock === true
      && long.mra_nature === 'goods' && JSON.stringify(long.printer_ids) === JSON.stringify(shirt.printer_ids), JSON.stringify(long));
    await c.query(`update categories set color = '#0000aa', mra_nature = 'services' where id = $1`, [shirt.id]);
    let l2 = await row(long.id);
    check('S1 the parent\'s colour changes, the sub\'s follows', l2.color === '#0000aa' && l2.mra_nature === 'services', JSON.stringify([l2.color, l2.mra_nature]));
    check('S1 the sub gets a new sync number, so the tills pull it', Number(l2.server_seq) > Number(long.server_seq), `${long.server_seq} -> ${l2.server_seq}`);
    const own = await cat('Short Sleeve', { parent: shirt.id, follows: false, color: '#123456' });
    await c.query(`update categories set color = '#654321' where id = $1`, [shirt.id]);
    check('S1 a sub with its own settings keeps them', (await row(own.id)).color === '#123456', (await row(own.id)).color);

    // S7 a till that gives a sub its own colour makes it stop following (push_category_save)
    const polo = await cat('Polo', { parent: shirt.id });
    await one(`select push_category_save($1,$2,$3::jsonb) as r`, [tid, emp, JSON.stringify({ id: polo.id, name: 'Polo', color: '#111111' })]);
    await c.query(`update categories set color = '#222222' where id = $1`, [shirt.id]);
    const p2 = await row(polo.id);
    check('S7 a sub coloured on the till keeps its colour and stops following', p2.color === '#111111' && p2.follows_parent === false, JSON.stringify([p2.color, p2.follows_parent]));
    await one(`select push_category_save($1,$2,$3::jsonb) as r`, [tid, emp, JSON.stringify({ id: long.id, name: 'Long Sleeve', color: '#222222' })]);
    check('S7 a sub saved on the till with its parent\'s colour still follows', (await row(long.id)).follows_parent === true);

    // S2 one level only, and a parent of the same business that is there
    const pants = await cat('Pants');
    let e = await failsWith(`insert into categories (tenant_id, name, parent_id) values ($1,'Deep',$2)`, [tid, long.id]);
    check('S2 a sub under a sub is refused', said(e) === 'too-deep', said(e));
    e = await failsWith(`update categories set parent_id = $2 where id = $1`, [shirt.id, pants.id]);
    check('S2 a category that has subs is not put under another', said(e) === 'too-deep', said(e));
    e = await failsWith(`update categories set parent_id = id where id = $1`, [pants.id]);
    check('S2 a category under itself is refused', said(e) === 'bad-parent', said(e));
    const theirs = await cat('Theirs', {}, uid);
    e = await failsWith(`insert into categories (tenant_id, name, parent_id) values ($1,'Stolen',$2)`, [tid, theirs.id]);
    check('S2 another business\'s category is no parent', said(e) === 'bad-parent', said(e));
    const gone = await cat('Gone');
    await c.query(`update categories set deleted_at = now() where id = $1`, [gone.id]);
    e = await failsWith(`insert into categories (tenant_id, name, parent_id) values ($1,'Orphan',$2)`, [tid, gone.id]);
    check('S2 a removed category is no parent', said(e) === 'bad-parent', said(e));
    await c.query(`update categories set parent_id = $2 where id = $1`, [own.id, pants.id]);
    check('S2 a sub moves to another parent', (await row(own.id)).parent_id === pants.id);

    // S3 a category with live subs is not removed
    e = await failsWith(`update categories set deleted_at = now() where id = $1`, [shirt.id]);
    check('S3 a category with a live sub is not removed', said(e) === 'category-not-empty', said(e));
    await c.query(`update categories set deleted_at = now() where id = any($1::uuid[])`, [[long.id, polo.id]]);
    e = await failsWith(`update categories set deleted_at = now() where id = $1`, [shirt.id]);
    check('S3 once its subs are removed, it is', e === null, said(e));

    // S4 the import: a Sub category column beside the Category
    const rows = [
      { n: 2, name: 'Long Sleeve Design', category: 'Tops', sub_category: 'Long Sleeve', price: 87500, o1: 'Colour', v1: 'Red', o2: 'Size', v2: '10', stock: 1000 },
      { n: 3, name: 'Long Sleeve Design', category: 'Tops', sub_category: 'Long Sleeve', price: 87500, o1: 'Colour', v1: 'Black', o2: 'Size', v2: '10' },
      { n: 4, name: 'Cap', sub_category: 'Hats', price: 30000 },
    ];
    const imp = async (r, dry) => (await one(`select catalog_import($1,$2,$3,$4::jsonb,$5) as r`, [tid, store, emp, JSON.stringify(r), dry])).r;
    let dry = await imp(rows, true);
    check('S4 the check says the category and the sub it would make', JSON.stringify(dry.new_categories) === JSON.stringify(['Tops', 'Tops › Long Sleeve']),
      JSON.stringify(dry.new_categories));
    check('S4 a sub category with no category is a problem', dry.problems.length === 1 && dry.problems[0].why === 'sub-without-category' && dry.problems[0].n === 4,
      JSON.stringify(dry.problems));
    const done = await imp(rows.slice(0, 2), false);
    const tops = await one(`select * from categories where tenant_id = $1 and name = 'Tops' and parent_id is null`, [tid]);
    const sub = await one(`select * from categories where tenant_id = $1 and name = 'Long Sleeve' and parent_id = $2`, [tid, tops && tops.id]);
    const item = await one(`select category_id from items where tenant_id = $1 and name = 'Long Sleeve Design'`, [tid]);
    check('S4 the import makes Tops › Long Sleeve and puts the product in the sub', Boolean(tops && sub) && item.category_id === sub.id && done.new_products === 1,
      JSON.stringify(done).slice(0, 160));
    dry = await imp([{ n: 2, name: 'Long Sleeve Design', category: 'tops', sub_category: 'long sleeve', price: 87500, o1: 'Colour', v1: 'Blue', o2: 'Size', v2: '10' }], true);
    check('S4 the same names again, in another case, make nothing new', dry.new_categories.length === 0 && dry.problems.length === 0, JSON.stringify(dry));
    await imp([{ n: 2, name: 'Long Sleeve Design', category: 'Tops', price: 87500, o1: 'Colour', v1: 'Green', o2: 'Size', v2: '10' }], false);
    check('S4 a file with no sub category leaves the product in its sub', (await one(`select category_id from items where tenant_id = $1 and name = 'Long Sleeve Design'`, [tid])).category_id === sub.id);
    await cat('Long Sleeve', { parent: pants.id });
    dry = await imp([{ n: 2, name: 'Sock', category: 'Long Sleeve', price: 5000 }], true);
    check('S4 a Category column names a top category, not a sub of that name', JSON.stringify(dry.new_categories) === JSON.stringify(['Long Sleeve']), JSON.stringify(dry.new_categories));

    // S5 the tills are sent a category's parent
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const pulled = (await one(`select sync_pull($1, 0, 1000) as r`, [store])).r;
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
    const cats = (pulled.changes && pulled.changes.categories) || [];
    check('S5 a pull hands out parent_id', cats.some((x) => x.id === sub.id && x.parent_id === tops.id) && cats.some((x) => x.id === tops.id && x.parent_id === null),
      'categories=' + cats.length);

    // S6 the Categories page lists a sub under its parent
    const html = await open(c, { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' }, '/backoffice/categories', { open: tops.id },
      { file: 'backoffice/categories' });
    const t = text(html);
    check('S6 the Categories page shows Tops › Long Sleeve and offers Add sub category', t.includes('Long Sleeve') && t.includes('Add sub category')
      && t.indexOf('Tops') < t.lastIndexOf('Long Sleeve'), t.slice(0, 200));

    // S8 Download your products (and its template) says the category and the sub apart, so the file imports back
    // into the sub, not into a top category named after it
    const shop = { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' };
    await c.query(`insert into items (tenant_id, name, price, category_id) values ($1,'Tops tee',40000,$2)`, [tid, tops.id]);
    const { parseCsv } = code(c, shop, 'lib/csv.ts');
    const { toCatalogRows } = code(c, shop, 'lib/catalog-rows.ts');
    const { parseRs } = code(c, shop, 'lib/money.ts');
    const download = async (q) => (await (await code(c, shop, 'app/backoffice/items/export/route.ts').GET(new Request('http://localhost/backoffice/items/export' + q))).text()).replace(/^﻿/, '');
    const csv = parseCsv(await download(''));
    const head = csv[0] || [];
    const cell = (product, h) => { const r = csv.find((x) => x[0] === product); return r ? r[head.indexOf(h)] : undefined; };
    check('S8 the file has a Sub category column beside Category', head.indexOf('Sub category') === head.indexOf('Category') + 1, head.join(','));
    check('S8 a product in a sub: Category Tops, Sub category Long Sleeve', cell('Long Sleeve Design', 'Category') === 'Tops' && cell('Long Sleeve Design', 'Sub category') === 'Long Sleeve',
      JSON.stringify([cell('Long Sleeve Design', 'Category'), cell('Long Sleeve Design', 'Sub category')]));
    check('S8 a product in a top category: no Sub category', cell('Tops tee', 'Category') === 'Tops' && cell('Tops tee', 'Sub category') === '',
      JSON.stringify([cell('Tops tee', 'Category'), cell('Tops tee', 'Sub category')]));
    const back = toCatalogRows(csv, parseRs).rows;
    dry = await imp(back, true);
    check('S8 the file imports back with nothing new and no problem', dry.new_categories.length === 0 && dry.problems.length === 0 && dry.new_products === 0,
      JSON.stringify({ new_categories: dry.new_categories, problems: dry.problems, new_products: dry.new_products }));
    const tpl = parseCsv(await download('?template=1'));
    check('S8 the template has the Sub category column too', (tpl[0] || []).includes('Sub category') && tpl.length === 1, (tpl[0] || []).join(','));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'SUB CATEGORIES PASS' : `SUB CATEGORIES FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
