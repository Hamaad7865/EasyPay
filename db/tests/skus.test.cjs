// skus.test.cjs — SKUs made from a product's name and its line's values (the owner, 2026-10-29: "auto
// generate SKU for all product … all SKUs are unique and derived from product name and its variant … it
// gets an SKU while it's getting imported … for the current ones a button"). Checks K1 to K8:
//   - the code: the product's initials (LSP), then each value made short (10Y, BLU), joined by dashes
//   - one product, one stem for all its lines; another product with the same initials takes LSP2, and keeps it
//   - a SKU typed by hand is kept; one two lines would share gets a number; none is ever another's
//   - a product without lines gets the stem itself; a product with lines keeps none of its own
//   - every product at once, in the order they were made; a second time makes none
//   - an import gives the lines it adds with none their SKU
//   - the product page's button saves what was typed on the lines first, then makes the SKUs
//   - the products page says how many lines have none, for a shop
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/skus.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, code, text } = require('./page.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-skus@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Sku Test','Main','SK1','Owner',$2,'premium','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, emp = made.employee_id;
    const ctx = { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' };
    const product = async (name, names, values) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, option_names) values ($1,$2,67500,40000,true,$3) returning id`, [tid, name, names || '{}'])).id;
      if (names) await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, it, names, JSON.stringify(values)]);
      return it;
    };
    const assign = async (it) => (await one(`select assign_skus($1,$2) as n`, [tid, it])).n;
    const skus = async (it) => Object.fromEntries((await c.query(`select name, sku from item_variants where item_id = $1 and deleted_at is null`, [it])).rows.map((r) => [r.name, r.sku]));
    const addLine = async (it, value) => c.query(`select variant_add($1,$2,$3,67500,40000,null,null,null,null,$4)`, [tid, it, [value], emp]);

    // the code
    const stems = await one(`select sku_stem('Long Sleeve Plain') a, sku_stem('Long Sleeve Plain Colle Mao') b, sku_stem('Chemise classique') c,
                                    sku_stem('Tee') d, sku_stem('Épée légère') e, sku_stem('!!!') f, sku_stem('Coca Cola 1.5L') g`);
    check('K1 a product\'s stem: LSP, LSPCM, CHCL, TEE, EPLE, ITEM, CC15L', Object.values(stems).join(',') === 'LSP,LSPCM,CHCL,TEE,EPLE,ITEM,CC15L', Object.values(stems).join(','));
    const parts = await one(`select sku_part('10 Year') a, sku_part('Blue') b, sku_part('Green') c, sku_part('Grey') d, sku_part('XL') e,
                                    sku_part('Navy Blue') f, sku_part('') g, sku_part('Rouge foncé') h, sku_part('Red') i`);
    check('K1 a value made short: 10Y, BLU, GRN, GRY, XL, NB, X, RF, RED', Object.values(parts).join(',') === '10Y,BLU,GRN,GRY,XL,NB,X,RF,RED', Object.values(parts).join(','));

    // Kids Corner's shirt, fifteen ages, one SKU typed by hand already
    const years = Array.from({ length: 15 }, (_, i) => `${i + 1} Year`);
    const shirt = await product('Long Sleeve Plain', ['Size'], [years]);
    await c.query(`update item_variants set sku = 'OLD-7' where item_id = $1 and name = '7 Year'`, [shirt]);
    let n = await assign(shirt);
    let s = await skus(shirt);
    check('K2 fourteen made, LSP-1Y to LSP-15Y, the one typed by hand kept, the product itself given none',
      n === 14 && s['1 Year'] === 'LSP-1Y' && s['10 Year'] === 'LSP-10Y' && s['15 Year'] === 'LSP-15Y' && s['7 Year'] === 'OLD-7'
        && (await one(`select sku from items where id = $1`, [shirt])).sku === null && new Set(Object.values(s)).size === 15, `${n} ${JSON.stringify(s)}`);
    check('K2 a second time makes none', (await assign(shirt)) === 0);

    // another product with the same initials takes the next stem, for all its lines
    const pink = await product('Long Sleeve Pink', ['Size'], [['1 Year', '2 Year']]);
    await assign(pink);
    s = await skus(pink);
    check('K3 Long Sleeve Pink: LSP2-1Y, LSP2-2Y', s['1 Year'] === 'LSP2-1Y' && s['2 Year'] === 'LSP2-2Y', JSON.stringify(s));
    const pants = await product('Lucky Star Pants', ['Size'], [['S', 'M']]);
    await assign(pants);
    s = await skus(pants);
    check('K3 a third: LSP3-S, LSP3-M', s.S === 'LSP3-S' && s.M === 'LSP3-M', JSON.stringify(s));
    await addLine(shirt, '16 Year');
    n = await assign(shirt);
    check('K3 a line added later takes its product\'s stem: LSP-16Y', n === 1 && (await skus(shirt))['16 Year'] === 'LSP-16Y', JSON.stringify(await skus(shirt)));
    // Pink removed frees LSP2; the pants keep LSP3 all the same
    await c.query(`update items set deleted_at = now() where id = $1`, [pink]);
    await addLine(pants, 'L');
    await assign(pants);
    check('K3 a product keeps the stem it has when a smaller one comes free: LSP3-L', (await skus(pants)).L === 'LSP3-L', JSON.stringify(await skus(pants)));

    // two values that come out the same: the second line gets a number
    const scarf = await product('Scarf', ['Colour'], [['Grey', 'Gray']]);
    await assign(scarf);
    s = await skus(scarf);
    check('K4 Grey and Gray, both GRY: SCAR-GRY and SCAR-GRY-2', [s.Grey, s.Gray].sort().join(',') === 'SCAR-GRY,SCAR-GRY-2', JSON.stringify(s));
    // a code typed by hand on another product is never given again
    const cap = await product('Cap');
    await c.query(`update items set sku = 'BELT' where id = $1`, [cap]);
    const belt = await product('Belt');
    await assign(belt);
    check('K4 Belt, when another product\'s own SKU is BELT: BELT2', (await one(`select sku from items where id = $1`, [belt])).sku === 'BELT2', (await one(`select sku from items where id = $1`, [belt])).sku);

    // a product without lines gets the stem
    const tee = await product('Tee');
    n = await assign(tee);
    check('K5 Tee, no lines: TEE; Cap\'s typed BELT kept', n === 1 && (await one(`select sku from items where id = $1`, [tee])).sku === 'TEE' && (await assign(cap)) === 0
      && (await one(`select sku from items where id = $1`, [cap])).sku === 'BELT');

    // the products page: how many lines have none, and every product at once
    const hat = await product('Hat');
    const sock = await product('Sock', ['Size'], [['S', 'M']]);
    let html = await open(c, ctx, '/backoffice/items', {});
    check('K6 the products page says 3 lines have no SKU, with the button', /3 lines have no SKU/.test(text(html)) && /Make their SKUs/.test(text(html)), text(html).slice(0, 300));
    let r = (await one(`select assign_skus_for($1, null) as r`, [tid])).r;
    check('K6 every product at once: 3 made, like HAT (Hat before Sock)', r.made === 3 && r.like === 'HAT'
      && (await skus(sock)).S === 'SOCK-S' && (await one(`select sku from items where id = $1`, [hat])).sku === 'HAT', JSON.stringify(r));
    r = (await one(`select assign_skus_for($1, null) as r`, [tid])).r;
    html = await open(c, ctx, '/backoffice/items', {});
    check('K6 a second time makes none, and the page no longer asks', r.made === 0 && r.like === null && !/have no SKU/.test(text(html)), JSON.stringify(r));

    // an import: the lines it adds with none get theirs; one typed in the file is kept
    const imp = code(c, ctx, 'app/backoffice/items/import/actions.ts');
    const rows = [
      { n: 1, name: 'Kids Polo', o1: 'Size', v1: '2 Year', price: 50000 },
      { n: 2, name: 'Kids Polo', o1: 'Size', v1: '4 Year', price: 50000, sku: 'KP-4Y-OWN' },
      { n: 3, name: 'Sandal', price: 30000 },
    ];
    const dry = await imp.importCatalog(rows, true);
    check('K7 a dry run makes nothing', dry.ok && dry.result.skus === undefined && !(await one(`select 1 as x from items where tenant_id = $1 and name = 'Sandal'`, [tid])), JSON.stringify(dry));
    const real = await imp.importCatalog(rows, false);
    const polo = (await one(`select id from items where tenant_id = $1 and name = 'Kids Polo'`, [tid])).id;
    s = await skus(polo);
    check('K7 the import made 2: KIPO-2Y and SAND; the file\'s KP-4Y-OWN kept', real.ok && real.result.skus === 2 && s['2 Year'] === 'KIPO-2Y' && s['4 Year'] === 'KP-4Y-OWN'
      && (await one(`select sku from items where tenant_id = $1 and name = 'Sandal'`, [tid])).sku === 'SAND', JSON.stringify(real.result) + ' ' + JSON.stringify(s));

    // the product page: the button, and what it does with what was typed and not yet saved
    const dress = await product('Dress', ['Size'], [['S', 'M', 'L']]);
    html = await open(c, ctx, '/backoffice/items/' + dress, {}, { params: { id: dress }, file: 'backoffice/items/[id]' });
    check('K8 the lines\' Save bar offers to make the 3 SKUs', /Make SKUs for the 3 lines that have none/.test(text(html)), text(html).slice(-400));
    const Page = code(c, ctx, 'app/backoffice/items/[id]/page.tsx').default;
    const tree = await Page({ params: Promise.resolve({ id: dress }), searchParams: Promise.resolve({}) });
    const said = (el) => (el == null || typeof el === 'boolean' ? '' : typeof el !== 'object' ? String(el) : Array.isArray(el) ? el.map(said).join('') : said(el.props && el.props.children));
    const find = (el, test) => {
      if (!el || typeof el !== 'object') return null;
      if (Array.isArray(el)) { for (const e of el) { const f = find(e, test); if (f) return f; } return null; }
      if (!el.props) return null;
      return test(el) ? el : find(el.props.children, test);
    };
    const button = find(tree, (el) => typeof el.props.formAction === 'function' && said(el).startsWith('Make SKUs'));
    const lines = (await c.query(`select id, name from item_variants where item_id = $1 and deleted_at is null`, [dress])).rows;
    const f = new FormData();
    f.set('id', dress);
    for (const l of lines) {
      f.append('v', l.id);
      f.set(`price:${l.id}`, '999');
      f.set(`cost:${l.id}`, '400');
      f.set(`barcode:${l.id}`, '');
      f.set(`sku:${l.id}`, l.name === 'S' ? 'MY-S' : '');
    }
    let answer = 'no button';
    if (button) {
      try { await button.props.formAction(f); answer = 'no answer'; } catch (e) { answer = decodeURIComponent(((e && e.message) || String(e)).replace(/\+/g, ' ')); }
    }
    s = await skus(dress);
    const prices = (await c.query(`select distinct price::int as p from item_variants where item_id = $1 and deleted_at is null`, [dress])).rows.map((x) => x.p);
    check('K8 the button saves the prices typed (Rs 999) and the SKU typed (MY-S), then makes the others (DRES-M, DRES-L)',
      prices.join() === '99900' && s.S === 'MY-S' && s.M === 'DRES-M' && s.L === 'DRES-L' && /ok=/.test(answer) && /2 SKUs made/.test(answer), `${answer} ${prices} ${JSON.stringify(s)}`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'SKUS PASS' : `SKUS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
