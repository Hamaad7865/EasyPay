// variant-add.test.cjs — one line added to a product that has variants (migration 0142): a shop with
// 40 colours, 21 ages and 10 styles adds the one it received, not every combination. Checks A1 to A7.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/variant-add.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, text } = require('./page.cjs');

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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-add@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Add Test','Main','AD1','Owner',$2,'premium') as r`, [admin, id()])).r;
    const other = (await one(`select platform.create_tenant($1,'Add Other','Main','AD2','Owner',$2,'premium') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id, uid = other.tenant_id;
    const dress = (await one(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,'Dress',120000,50000,true) returning id`, [tid])).id;
    await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, dress, ['Colour', 'Age', 'Style'], JSON.stringify([['Beige', 'Black'], ['1', '2'], ['Plain']])]);
    const lines = () => all(`select id, name, price, cost, sku, barcode, option_values from item_variants where item_id = $1 and deleted_at is null order by created_at, name`, [dress]);
    const add = (values, more = {}, t = tid, it = dress) => one(`select variant_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v`,
      [t, it, values, more.price ?? null, more.cost ?? null, more.sku ?? null, more.barcode ?? null, more.store ?? null, more.qty ?? null, emp]).then((x) => x.v);
    const addFails = (values, more = {}, t = tid, it = dress) => failsWith(`select variant_add($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t, it, values, more.price ?? null, more.cost ?? null, more.sku ?? null, more.barcode ?? null, more.store ?? null, more.qty ?? null, emp]);

    // A1 one line, and only that one, by the tenant's own role as the back office does it
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const v = await add(['Green Mint', '3', ' Striped '], { price: 135000, sku: 'DR-GM-3', barcode: '2000000000022', store, qty: 2000 });
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
    let ls = await lines();
    const made1 = ls.find((x) => x.id === v);
    check('A1 one line is made, the four before it kept', ls.length === 5 && Boolean(made1), String(ls.length));
    check('A1 named by its values, trimmed, with its price, SKU and barcode', made1 && made1.name === 'Green Mint / 3 / Striped'
      && Number(made1.price) === 135000 && made1.sku === 'DR-GM-3' && made1.barcode === '2000000000022', JSON.stringify(made1));
    const lev = await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and variant_id = $3`, [tid, store, v]);
    const mv = await one(`select reason, qty from stock_movements where tenant_id = $1 and variant_id = $2`, [tid, v]);
    check('A1 its quantity is an opening stock at the branch named', lev && lev.qty === 2000 && mv && mv.reason === 'opening' && mv.qty === 2000, JSON.stringify([lev, mv]));

    // A2 the product's price and cost when none is given
    const v2 = await add(['Black', '3', 'Plain']);
    const made2 = (await lines()).find((x) => x.id === v2);
    check('A2 no price given: the product\'s price and cost', Number(made2.price) === 120000 && Number(made2.cost) === 50000, JSON.stringify(made2));

    // A3 a value typed in another case takes the spelling the product already uses
    const v3 = await add(['beige', '3', 'plain']);
    const made3 = (await lines()).find((x) => x.id === v3);
    check('A3 beige and plain are written Beige and Plain', made3.name === 'Beige / 3 / Plain', made3.name);

    // A4 what is refused
    let e = await addFails(['BLACK', '1', 'PLAIN']);
    check('A4 a line already there, whatever its case', said(e) === 'variant-exists', said(e));
    e = await addFails(['Black', '1']);
    check('A4 a value missing', said(e) === 'bad-options', said(e));
    e = await addFails(['Black', '', 'Plain']);
    check('A4 an empty value', said(e) === 'bad-options', said(e));
    e = await addFails(['Black', '4', 'x'.repeat(31)]);
    check('A4 a value over 30 characters', said(e) === 'bad-options', said(e));
    e = await addFails(['Black', '4', 'Plain'], { barcode: '2000000000022' });
    check('A4 a barcode another line has', said(e) === 'barcode-taken', said(e));
    e = await addFails(['Black', '4', 'Plain'], {}, uid);
    check('A4 another business\'s product', said(e) === 'unknown-item', said(e));
    const bag = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,'Bag',1000,true) returning id`, [tid])).id;
    e = await addFails(['Black'], {}, tid, bag);
    check('A4 a product with no options', said(e) === 'bad-options', said(e));
    await c.query(`update items set track_stock = false where id = $1`, [dress]);
    e = await addFails(['Black', '4', 'Plain'], { store, qty: 1000 });
    check('A4 a quantity for a product that counts no stock', said(e) === 'stock-not-counted', said(e));
    await c.query(`update items set track_stock = true where id = $1`, [dress]);
    check('A4 nothing was made by any of them', (await lines()).length === 7, String((await lines()).length));

    // A5 1000 lines at most (0144; 200 until then): a shop's shirt in many colours, ages and styles has more than 200
    const big = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,'Big',1000,true) returning id`, [tid])).id;
    const upTo = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
    await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, big, ['N'], JSON.stringify([upTo(200)])]);
    e = await addFails(['201'], {}, tid, big);
    check('A5 a 201st line is made', e === null, said(e));
    // an import past 200 lines, then to 1000: the check before importing says what would go in
    const rows = upTo(300).slice(201).map((n, i) => ({ n: i + 2, name: 'Big', price: 100000, o1: 'N', v1: n }));
    let dry = (await one(`select catalog_import($1,$2,$3,$4::jsonb,true) as r`, [tid, store, emp, JSON.stringify(rows)])).r;
    check('A5 a file taking a product from 201 lines to 300 goes in', dry.good === 99 && dry.new_lines === 99 && dry.problems.length === 0, JSON.stringify(dry).slice(0, 160));
    const r5 = await one(`select variants_generate($1,$2,$3,$4::jsonb) as r`, [tid, big, ['N'], JSON.stringify([upTo(1000)])]);
    check('A5 Make every combination goes to 1000', r5.r.created === 799, JSON.stringify(r5.r));
    e = await addFails(['1001'], {}, tid, big);
    check('A5 a 1001st line is refused', said(e) === 'too-many-variants', said(e));
    dry = (await one(`select catalog_import($1,$2,$3,$4::jsonb,true) as r`, [tid, store, emp, JSON.stringify([{ n: 2, name: 'Big', price: 100000, o1: 'N', v1: '1001' }])])).r;
    check('A5 and an import of a 1001st is refused', dry.problems.length === 1 && dry.problems[0].why === 'too-many-variants', JSON.stringify(dry.problems));

    // A6 the tills are sent it: it has a sync number
    check('A6 the new line has a sync number', (await one(`select server_seq from item_variants where id = $1`, [v])).server_seq !== null);

    // A7 the product page offers it, with the values the product uses
    const html = await open(c, { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' }, '/backoffice/items/' + dress, {},
      { params: { id: dress }, file: 'backoffice/items/[id]' });
    check('A7 the product page has Add a variant, a field per option with its values suggested', text(html).includes('Add a variant')
      && html.includes('name="value1"') && html.includes('name="value3"') && html.includes('<option value="Green Mint">') && html.includes('name="qty"')
      && text(html).includes('Make every combination'), text(html).slice(0, 160));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'VARIANT ADD PASS' : `VARIANT ADD FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
