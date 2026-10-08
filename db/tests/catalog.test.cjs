// catalog.test.cjs — the catalog's rules (migration 0070): suppliers,
// barcodes and SKUs that stay unique across products and variants, variants
// made from options, prices that follow, EasyPay's own barcodes, and reorder
// levels. Checks C1 to C13 of docs/superpowers/plans/2026-10-07-retail-catalog-2a.md.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/catalog.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;
// the check digit worked out here, apart from the database's own sum
const validEan13 = (code) => /^\d{13}$/.test(code)
  && (10 - [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0) % 10) % 10 === Number(code[12]);

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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-cat@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Catalog Test','Main','CT1','Owner',$2,'standard') as r`, [admin, id()])).r;
    const other = (await one(`select platform.create_tenant($1,'Catalog Other','Main','CT2','Owner',$2,'standard') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id, uid = other.tenant_id;
    const item = async (t, name, more = {}) => (await one(
      `insert into items (tenant_id, name, price, cost, sku, barcode, track_stock) values ($1,$2,$3,$4,$5,$6,true) returning id`,
      [t, name, more.price ?? 10000, more.cost ?? null, more.sku ?? null, more.barcode ?? null])).id;
    const variants = (it) => all(`select id, name, price, cost, sku, barcode, option_values from item_variants where item_id = $1 and deleted_at is null order by name`, [it]);
    const gen = (it, names, values) => one(`select variants_generate($1,$2,$3,$4::jsonb) as r`, [tid, it, names, JSON.stringify(values)]).then((x) => x.r);
    const genFails = (it, names, values) => failsWith(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, it, names, JSON.stringify(values)]);

    // C1 suppliers belong to their tenant
    await c.query(`insert into suppliers (tenant_id, name, phone) values ($1,'Textiles Ocean','5 123 4567')`, [tid]);
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [uid]);
    const seenByOther = (await one(`select count(*)::int as n from suppliers`)).n;
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const seenByOwn = (await one(`select count(*)::int as n from suppliers`)).n;
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
    check('C1 a supplier is seen by its tenant and by no other', seenByOwn === 1 && seenByOther === 0, `${seenByOwn} ${seenByOther}`);

    // C2 a barcode is unique across products and variants
    const A = await item(tid, 'Mug', { barcode: ' 123456 ', sku: 'AB-1' });
    const B = await item(tid, 'Bowl');
    check('C2 a barcode is kept without its spaces', (await one(`select barcode from items where id = $1`, [A])).barcode === '123456');
    let e = await failsWith(`insert into items (tenant_id, name, price, barcode) values ($1,'Plate',100,'123456')`, [tid]);
    check('C2 a second product cannot take it', said(e) === 'barcode-taken', said(e));
    e = await failsWith(`insert into item_variants (tenant_id, item_id, name, price, barcode) values ($1,$2,'Large',100,'123456')`, [tid, B]);
    check('C2 nor can a variant', said(e) === 'barcode-taken', said(e));
    e = await failsWith(`update items set barcode = '123456' where id = $1`, [B]);
    check('C2 nor by a later change', said(e) === 'barcode-taken', said(e));
    await c.query(`update items set barcode = '   ' where id = $1`, [B]);
    check('C2 a blank barcode is none', (await one(`select barcode from items where id = $1`, [B])).barcode === null);

    // C3 a SKU is unique too, whatever its case
    e = await failsWith(`update items set sku = 'ab-1' where id = $1`, [B]);
    check('C3 a SKU differing only by case is taken', said(e) === 'sku-taken', said(e));
    e = await failsWith(`insert into item_variants (tenant_id, item_id, name, price, sku) values ($1,$2,'Large',100,'Ab-1')`, [tid, B]);
    check('C3 for a variant as well', said(e) === 'sku-taken', said(e));

    // C4 another tenant is another world
    const UA = await item(uid, 'Their mug', { barcode: '123456', sku: 'AB-1' });
    check('C4 another tenant may use the same barcode and SKU', Boolean(UA));

    // C2 again: a removed product frees its codes
    await c.query(`update items set deleted_at = now() where id = $1`, [A]);
    await c.query(`update items set barcode = '123456', sku = 'ab-1' where id = $1`, [B]);
    check('C2 a removed product frees its barcode and SKU', (await one(`select barcode, sku from items where id = $1`, [B])).barcode === '123456');

    // C5 variants from options
    const P = await item(tid, 'Linen shirt', { price: 129000, cost: 62000, sku: 'LS' });
    let r = await gen(P, ['Size', 'Colour'], [['S', 'M'], ['White', 'Navy']]);
    let vs = await variants(P);
    check('C5 every combination is made', r.created === 4 && r.existing === 0 && vs.length === 4, JSON.stringify(r));
    const mw = vs.find((v) => v.name === 'M / White');
    check('C5 named by its values, at the product price and cost, with a SKU of its own',
      mw && Number(mw.price) === 129000 && Number(mw.cost) === 62000 && mw.sku === 'LS-M-WHITE' && JSON.stringify(mw.option_values) === '["M","White"]', JSON.stringify(mw));
    check('C5 the product remembers its options', JSON.stringify((await one(`select option_names from items where id = $1`, [P])).option_names) === '["Size","Colour"]');
    r = await gen(P, ['Size', 'Colour'], [['S', 'M'], ['White', 'Navy', 'Red']]);
    vs = await variants(P);
    check('C5 a value added later makes only the new lines', r.created === 2 && r.existing === 4 && vs.length === 6, JSON.stringify(r));

    // C6 what is refused
    e = await genFails(P, ['Size', 'Colour', 'Cut', 'Fabric'], [['S'], ['W'], ['A'], ['B']]);
    check('C6 more than three options', said(e) === 'bad-options', said(e));
    const G = await item(tid, 'Scarf');
    e = await genFails(G, ['Size', ' '], [['S'], ['W']]);
    check('C6 an option with no name', said(e) === 'bad-options', said(e));
    e = await genFails(G, ['Size', 'size'], [['S'], ['W']]);
    check('C6 the same option twice', said(e) === 'bad-options', said(e));
    e = await genFails(G, ['Size'], [['S', ' ']]);
    check('C6 a value with nothing in it', said(e) === 'bad-options', said(e));
    e = await genFails(G, ['Size'], [['S', 's']]);
    check('C6 the same value twice', said(e) === 'bad-options', said(e));
    const six = ['1', '2', '3', '4', '5', '6'];
    e = await genFails(G, ['A', 'B', 'C'], [six, six, six]);
    check('C6 more than 200 lines', said(e) === 'too-many-variants', said(e));
    e = await genFails(P, ['Size'], [['S', 'M']]);
    check('C6 a product with variants keeps its number of options', said(e) === 'bad-options', said(e));

    // C7 a product with stock is not turned into variants
    const Q = await item(tid, 'Sandals', { cost: 89000 });
    await c.query(`select stock_move($1,$2,$3,null,5000,'receive',89000,'delivery',$4,$5,null)`, [tid, store, Q, id(), emp]);
    e = await genFails(Q, ['Size'], [['40', '41']]);
    check('C7 a product with stock cannot be given variants', said(e) === 'has-stock', said(e));
    await c.query(`select stock_move($1,$2,$3,null,-5000,'lost',null,null,null,$4,null)`, [tid, store, Q, emp]);
    r = await gen(Q, ['Size'], [['40', '41']]);
    check('C7 at zero it can', r.created === 2, JSON.stringify(r));

    // C9 a change of the product's price reaches the variants that had it
    await c.query(`update item_variants set price = 99000, cost = 50000 where id = $1`, [mw.id]);
    await c.query(`update items set price = 139000, cost = 64000 where id = $1`, [P]);
    vs = await variants(P);
    const follow = vs.filter((v) => v.id !== mw.id);
    const own = vs.find((v) => v.id === mw.id);
    check('C9 variants at the product price and cost follow it', follow.every((v) => Number(v.price) === 139000 && Number(v.cost) === 64000), JSON.stringify(follow.map((v) => [v.price, v.cost])));
    check('C9 a variant priced on its own keeps its price and cost', Number(own.price) === 99000 && Number(own.cost) === 50000, JSON.stringify(own));

    // C11 a variant's first level starts at its own cost, or the product's
    await c.query(`select stock_move($1,$2,$3,$4,1000,'found',null,null,null,$5,null)`, [tid, store, P, mw.id, emp]);
    const sn = vs.find((v) => v.name === 'S / Navy');
    await c.query(`update item_variants set cost = null where id = $1`, [sn.id]);
    await c.query(`select stock_move($1,$2,$3,$4,1000,'found',null,null,null,$5,null)`, [tid, store, P, sn.id, emp]);
    const lev = async (v) => one(`select qty, avg_cost::float8 as avg, reorder_point, reorder_qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, store, P, v]);
    check('C11 a variant with a cost starts its level at it', near((await lev(mw.id)).avg, 50000), JSON.stringify(await lev(mw.id)));
    check('C11 one without starts at the product cost', near((await lev(sn.id)).avg, 64000), JSON.stringify(await lev(sn.id)));

    // C8 removing a variant
    e = await failsWith(`select variant_archive($1,$2)`, [tid, mw.id]);
    check('C8 a variant with stock is not removed', said(e) === 'has-stock', said(e));
    await c.query(`select stock_move($1,$2,$3,$4,-1000,'lost',null,null,null,$5,null)`, [tid, store, P, mw.id, emp]);
    await c.query(`select variant_archive($1,$2)`, [tid, mw.id]);
    check('C8 at zero it is', (await variants(P)).length === 5 && (await one(`select deleted_at from item_variants where id = $1`, [mw.id])).deleted_at !== null);
    for (const v of await variants(Q)) await c.query(`select variant_archive($1,$2)`, [tid, v.id]);
    check('C8 with its last variant gone a product is simple again', JSON.stringify((await one(`select option_names from items where id = $1`, [Q])).option_names) === '[]');

    // C10 EasyPay's own barcodes
    check('C10 the check digit is the published one', (await one(`select ean13('400638133', 393) as c`)).c === '4006381333931' && (await one(`select ean13('200', 1) as c`)).c === '2000000000015');
    const R = await item(tid, 'Candle');
    const taken = (await one(`select ean13('200', 1) as c`)).c;
    await c.query(`update items set barcode = $2 where id = $1`, [G, taken]); // someone typed the first code by hand
    let n = (await one(`select assign_barcodes($1,$2) as n`, [tid, R])).n;
    const rb = (await one(`select barcode from items where id = $1`, [R])).barcode;
    check('C10 a product with no barcode is given a valid one, not one in use', n === 1 && validEan13(rb) && rb.startsWith('200') && rb !== taken, `${n} ${rb}`);
    n = (await one(`select assign_barcodes($1,$2) as n`, [tid, R])).n;
    check('C10 a product that has one is left alone', n === 0 && (await one(`select barcode from items where id = $1`, [R])).barcode === rb);
    n = (await one(`select assign_barcodes($1,$2) as n`, [tid, P])).n;
    vs = await variants(P);
    const codes = vs.map((v) => v.barcode);
    check('C10 each variant gets its own, the product none', n === 5 && codes.every(validEan13) && new Set(codes).size === 5 && !codes.includes(rb)
      && (await one(`select barcode from items where id = $1`, [P])).barcode === null, `${n} ${codes.join(',')}`);

    // C12 reorder levels on every line
    n = (await one(`select stock_set_reorder($1,$2,$3,6000,12000) as n`, [tid, store, P])).n;
    const white = vs.find((v) => v.name === 'S / White');
    const lw = await lev(white.id);
    check('C12 every line of the product gets the reorder level, its level made at zero if need be',
      n === 5 && lw && lw.qty === 0 && lw.reorder_point === 6000 && lw.reorder_qty === 12000, `${n} ${JSON.stringify(lw)}`);
    n = (await one(`select stock_set_reorder($1,$2,$3,4000,null) as n`, [tid, store, R])).n;
    check('C12 a simple product has one line', n === 1);

    // C13 the tenant role, inside its own tenant
    const H = await item(tid, 'Hat', { price: 45000 });
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    await c.query(`insert into suppliers (tenant_id, name) values ($1,'Second supplier')`, [tid]);
    r = (await one(`select variants_generate($1,$2,$3,$4::jsonb) as r`, [tid, H, ['Size'], JSON.stringify([['S', 'M']])])).r;
    n = (await one(`select assign_barcodes($1,$2) as n`, [tid, H])).n;
    const hv = (await all(`select id from item_variants where item_id = $1 and deleted_at is null`, [H]))[0].id;
    await c.query(`select stock_set_reorder($1,$2,$3,2000,6000)`, [tid, store, H]);
    await c.query(`select variant_archive($1,$2)`, [tid, hv]);
    check('C13 the tenant role can do all of it for its own tenant', r.created === 2 && n === 2);
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);

    // ---- C14 a shop's barcode settings (migration 0080) ----
    {
      const settings = async (t = tid) => (await one(`select barcode_settings($1) as r`, [t])).r;
      const save = (prefix, auto, t = tid) => one(`select barcode_settings_save($1,$2,$3) as r`, [t, prefix, auto]).then((x) => x.r);
      const saveFails = (prefix, auto) => failsWith(`select barcode_settings_save($1,$2,$3)`, [tid, prefix, auto]).then((e) => (e ? e.message : 'saved'));
      const fresh = await settings(uid);
      check('C14 a business that never made a barcode reads the defaults: 200, not automatic, the first number',
        fresh.prefix === '200' && fresh.auto === false && fresh.next_serial === 1 && fresh.next === '2000000000015' && fresh.made === 0, JSON.stringify(fresh));
      const before = await settings();
      check('C14 the next barcode shown is the one the next product gets', before.next_serial > 1 && before.next.startsWith('200') && before.next.length === 13 && before.made === before.next_serial - 1, JSON.stringify(before));
      const N1 = await item(tid, 'Notebook');
      await c.query(`select assign_barcodes($1,$2)`, [tid, N1]);
      const got = (await one(`select barcode from items where id = $1`, [N1])).barcode;
      check('C14 and it was', got === before.next, got + ' ' + before.next);

      for (const bad of ['', '2', '2a', '20000000', ' 2 0 ', null]) {
        const said = await saveFails(bad, false);
        if (said !== 'bad-prefix') check(`C14 a prefix of "${bad}" is refused`, false, said);
      }
      check('C14 a prefix is 2 to 7 digits', true);
      let s = await save(' 29 ', false);
      const N2 = await item(tid, 'Pencil');
      await c.query(`select assign_barcodes($1,$2)`, [tid, N2]);
      const second = (await one(`select barcode from items where id = $1`, [N2])).barcode;
      check('C14 a new prefix is on the next barcode, the numbers go on, and the barcodes made before keep theirs',
        s.prefix === '29' && second === s.next && second.startsWith('29') && (await one(`select barcode from items where id = $1`, [N1])).barcode === got, JSON.stringify(s) + ' ' + second);
      // seven digits leave five for the number: a shop that is past 99,999 cannot take one
      await c.query(`update barcode_counters set next_serial = 100000 where tenant_id = $1`, [tid]);
      const tooLong = await saveFails('2912345', false);
      s = await save('291234', false);
      check('C14 a prefix that leaves no room for the numbers already given is refused; one that does is taken', tooLong === 'prefix-too-long' && s.prefix === '291234' && s.left === 900000, tooLong + ' ' + JSON.stringify(s));
      await c.query(`update barcode_counters set next_serial = 999999 where tenant_id = $1`, [tid]);
      s = await settings();
      check('C14 the last number is shown, and after it there is no next one to show', s.next !== null && s.left === 1);
      await c.query(`update barcode_counters set next_serial = 1000000 where tenant_id = $1`, [tid]);
      s = await settings();
      check('C14 with the numbers used up, the page is told there is none left instead of failing', s.next === null && s.left === 0, JSON.stringify(s));
      await c.query(`update barcode_counters set next_serial = 500 where tenant_id = $1`, [tid]);

      // automatic: off does nothing, on gives every line with none its barcode
      await save('20', false);
      const A1 = await item(tid, 'Eraser');
      let made = (await one(`select barcodes_auto($1,$2) as n`, [tid, A1])).n;
      check('C14 with the switch off, a new product is left without a barcode', made === 0 && (await one(`select barcode from items where id = $1`, [A1])).barcode === null);
      const lacking = (await settings()).without;
      s = await save('20', true);
      made = (await one(`select barcodes_auto($1,$2) as n`, [tid, A1])).n;
      const a1 = (await one(`select barcode from items where id = $1`, [A1])).barcode;
      check('C14 with it on, the product is given one, and one line fewer has none', s.auto === true && made === 1 && /^20\d{11}$/.test(a1) && (await settings()).without === lacking - 1, `${made} ${a1}`);
      const A2 = await item(tid, 'Ruler', { barcode: '5012345678900' });
      made = (await one(`select barcodes_auto($1,$2) as n`, [tid, A2])).n;
      check('C14 a product that came with its maker\'s barcode keeps it', made === 0 && (await one(`select barcode from items where id = $1`, [A2])).barcode === '5012345678900');
      const A3 = await item(tid, 'Cap');
      await gen(A3, ['Size'], [['S', 'M', 'L']]);
      made = (await one(`select barcodes_auto($1,$2) as n`, [tid, A3])).n;
      const caps = (await all(`select barcode from item_variants where item_id = $1 and deleted_at is null`, [A3])).map((x) => x.barcode);
      check('C14 variants made from options each get one, and the product itself does not',
        made === 3 && caps.every((b) => /^20\d{11}$/.test(b)) && new Set(caps).size === 3 && (await one(`select barcode from items where id = $1`, [A3])).barcode === null, `${made} ${caps.join()}`);

      // the tenant's own role: its own settings, and nobody else's
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [uid]);
      const theirs = await settings(tid);
      await c.query('SAVEPOINT other');
      let said = 'saved';
      try { await c.query(`select barcode_settings_save($1,'25',true)`, [tid]); await c.query('RELEASE SAVEPOINT other'); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT other'); said = 'refused'; }
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      const mine = await settings();
      const own = await save('20', true);
      await c.query('SET LOCAL ROLE none');
      await c.query(`select set_config('app.tenant_id', '', true)`);
      check('C14 another business reads the defaults in place of ours and cannot change ours; the tenant\'s own role can',
        theirs.prefix === '200' && theirs.auto === false && said === 'refused' && mine.prefix === '20' && mine.auto === true && own.prefix === '20', JSON.stringify(theirs) + ' ' + said);
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'CATALOG PASS' : `CATALOG FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
