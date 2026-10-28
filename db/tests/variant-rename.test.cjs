// variant-rename.test.cjs — a value of a product's option renamed on the lines
// that have it (migration 0141): an import that said Plain where the shop meant
// another word is put right without new lines. Checks R1 to R8.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/variant-rename.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-ren@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Rename Test','Main','RN1','Owner',$2,'premium') as r`, [admin, id()])).r;
    const other = (await one(`select platform.create_tenant($1,'Rename Other','Main','RN2','Owner',$2,'premium') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id, uid = other.tenant_id;
    const product = async (t, name, names, values) => {
      const it = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,$2,50000,true) returning id`, [t, name])).id;
      await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [t, it, names, JSON.stringify(values)]);
      return it;
    };
    const lines = (it) => all(`select id, name, option_values, barcode, server_seq from item_variants where item_id = $1 and deleted_at is null order by name`, [it]);
    const rename = (it, option, from, to, everywhere = false) =>
      one(`select variant_value_rename($1,$2,$3,$4,$5,$6) as r`, [tid, it, option, from, to, everywhere]).then((x) => x.r);
    const renameFails = (it, option, from, to, everywhere = false, t = tid) =>
      failsWith(`select variant_value_rename($1,$2,$3,$4,$5,$6)`, [t, it, option, from, to, everywhere]);

    const shirt = await product(tid, 'Shirt', ['Size', 'Colour', 'Style'], [['S', 'M'], ['White'], ['Plain']]);
    const polo = await product(tid, 'Polo', ['Size', 'Style'], [['S'], ['Plain']]);
    const cap = await product(tid, 'Cap', ['Style'], [['plain']]);
    const mug = await product(tid, 'Mug', ['Colour'], [['Plain']]);
    const theirs = await product(uid, 'Their shirt', ['Style'], [['Plain']]);
    await c.query(`update item_variants set barcode = '2000000000015' where item_id = $1 and option_values[1] = 'M'`, [shirt]);
    const before = await lines(shirt);
    const m = before.find((v) => v.option_values[0] === 'M');
    await c.query(`select stock_move($1,$2,$3,$4,4000,'receive',20000,'delivery',$5,$6,null)`, [tid, store, shirt, m.id, id(), emp]);

    // R1 one product's value renamed, by the tenant's own role as the back office does it
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    let r = await rename(shirt, 3, 'Plain', ' Colle Mao ');
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
    let after = await lines(shirt);
    check('R1 every line of it that had the value has the new one, trimmed', r.lines === 2 && r.products === 1
      && after.every((v) => v.option_values[2] === 'Colle Mao'), JSON.stringify(r) + ' ' + JSON.stringify(after.map((v) => v.option_values)));
    check('R1 each line is named by its values again', after.map((v) => v.name).join(',') === 'M / White / Colle Mao,S / White / Colle Mao', after.map((v) => v.name).join(','));
    const m2 = after.find((v) => v.id === m.id);
    const level = await one(`select qty from stock_levels where tenant_id = $1 and variant_id = $2`, [tid, m.id]);
    check('R1 the lines are the same ones: barcode and stock kept', Boolean(m2) && m2.barcode === '2000000000015' && level.qty === 4000, JSON.stringify(level));

    // R2 the tills are sent the change
    check('R2 a renamed line is given a later sync number', after.every((v) => Number(v.server_seq) > Number(before.find((b) => b.id === v.id).server_seq)));

    // R3 the other products are left alone when only this one is asked
    check('R3 another product with the same option and value keeps it', (await lines(polo))[0].option_values[1] === 'Plain');

    // R4 what is refused
    let e = await renameFails(shirt, 3, 'Striped', 'Linen');
    check('R4 a value no line has', said(e) === 'unknown-value', said(e));
    e = await renameFails(shirt, 3, 'Colle Mao', '   ');
    check('R4 an empty new name', said(e) === 'bad-options', said(e));
    e = await renameFails(shirt, 4, 'Colle Mao', 'Linen');
    check('R4 an option the product does not have', said(e) === 'bad-options', said(e));
    e = await renameFails(theirs, 1, 'Plain', 'Linen');
    check('R4 another business\'s product', said(e) === 'unknown-item', said(e));
    e = await renameFails(theirs, 1, 'Plain', 'Linen', false, uid);
    check('R4 their own product is theirs to rename (setup)', e === null, said(e));

    // R5 two lines would be one
    await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, shirt, ['Size', 'Colour', 'Style'], JSON.stringify([['S', 'M'], ['White'], ['Colle Mao', 'Plain']])]);
    e = await renameFails(shirt, 3, 'Plain', 'colle mao');
    check('R5 a rename onto the values of another line is refused, naming the product', said(e) === 'value-taken' && e.detail === 'Shirt', said(e) + ' ' + (e && e.detail));
    check('R5 and nothing changed', (await lines(shirt)).filter((v) => v.option_values[2] === 'Plain').length === 2);

    // R6 every product whose option of that name has the value, whatever its place and case
    r = await rename(shirt, 3, 'Plain', 'Plain / Colle Mao', true);
    const polo6 = (await lines(polo))[0], cap6 = (await lines(cap))[0], mug6 = (await lines(mug))[0];
    check('R6 every product with a Style of Plain takes the new value', r.lines === 4 && r.products === 3
      && polo6.option_values[1] === 'Plain / Colle Mao' && cap6.option_values[0] === 'Plain / Colle Mao', JSON.stringify(r));
    check('R6 an option of another name keeps its value', mug6.option_values[0] === 'Plain');
    check('R6 another business is not touched', (await lines(theirs))[0].option_values[0] === 'Linen');

    // R7 one product that would clash stops them all
    const vest = await product(tid, 'Vest', ['Style'], [['Linen', 'Silk']]);
    const jacket = await product(tid, 'Jacket', ['Style'], [['Linen']]);
    e = await renameFails(jacket, 1, 'Linen', 'Silk', true);
    check('R7 a clash on another product refuses the rename and names it', said(e) === 'value-taken' && e.detail === 'Vest', said(e) + ' ' + (e && e.detail));
    check('R7 and neither changed', (await lines(jacket))[0].option_values[0] === 'Linen' && (await lines(vest)).length === 2);

    // R8 the product page offers it: each option's values under its name, sent as "number:value"
    const html = await open(c, { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' }, '/backoffice/items/' + shirt, {},
      { params: { id: shirt }, file: 'backoffice/items/[id]' });
    check('R8 the product page has Rename a value, the values under their option', text(html).includes('Rename a value')
      && html.includes('<optgroup label="Style">') && html.includes('value="3:Colle Mao"') && html.includes('value="3:Plain / Colle Mao"')
      && html.includes('value="1:M"') && html.includes('name="everywhere"'), text(html).slice(0, 200));
    const simple = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,'Bag',1000,true) returning id`, [tid])).id;
    const plain = await open(c, { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' }, '/backoffice/items/' + simple, {},
      { params: { id: simple }, file: 'backoffice/items/[id]' });
    check('R8 a product with no variants has none of it', !text(plain).includes('Rename a value'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'VARIANT RENAME PASS' : `VARIANT RENAME FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
