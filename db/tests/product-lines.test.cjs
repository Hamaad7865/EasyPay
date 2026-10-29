// product-lines.test.cjs — a product's lines on its back office page, when it has many (the owner,
// 2026-10-29: "too many scroll when a product has many variants"). Checks L1 to L6:
//   - the lines go by number when an option's values start with one (1, 2 … 15 Year, not 1, 10, 11 … 2),
//     and words keep the order they came in (S, M, L)
//   - the lines are the whole page wide, below the two columns
//   - each row carries its values, and above ten lines a chip for each value shows only those
//   - one price, or cost, for every line shown; the cost one only for whom may see cost
//   - the picture in a row is a small square, without words; the Save bar stays in reach
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/product-lines.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, text, rowsOf } = require('./page.cjs');

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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-lines@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Lines Test','Main','LN1','Owner',$2,'premium','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, emp = made.employee_id;
    const product = async (name, names, values) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, option_names) values ($1,$2,67500,40000,true,$3) returning id`, [tid, name, names])).id;
      await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, it, names, JSON.stringify(values)]);
      return it;
    };
    const ctx = { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' };
    const page = (it, who = ctx) => open(c, who, '/backoffice/items/' + it, {}, { params: { id: it }, file: 'backoffice/items/[id]' });
    // the line rows, by the variant's name in its row (the second cell, after the picture)
    const lineNames = (html) => [...html.matchAll(/<tr[^>]*data-line[^>]*>(.*?)<\/tr>/g)].map((m) => text([...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)][1][1]));

    // Kids Corner's shirt: fifteen ages, made in one go as an import makes them (so in the order of their letters)
    const years = Array.from({ length: 15 }, (_, i) => `${i + 1} Year`).sort();
    const shirt = await product('Long Sleeve Plain', ['Size'], [years]);
    let html = await page(shirt);
    const names = lineNames(html);
    check('L1 the lines go by number: 1 Year, 2 Year … 15 Year', names.join(',') === Array.from({ length: 15 }, (_, i) => `${i + 1} Year`).join(','), names.join(','));
    check('L2 the lines are below the two columns, the whole page wide', html.indexOf('class="lines-wide"') > html.indexOf('Remove Long Sleeve Plain'), String(html.indexOf('class="lines-wide"')));
    const chips = [...html.matchAll(/<button[^>]*class="line-chip[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]));
    check('L3 each row carries its value, and fifteen lines get a chip for each age, in order, after All',
      /<tr[^>]*data-line=""[^>]*data-o1="7 Year"/.test(html) && chips.join(',') === ['All', ...Array.from({ length: 15 }, (_, i) => `${i + 1} Year`)].join(','), chips.join(','));
    check('L4 one price and one cost for every line shown', html.includes('aria-label="Same price for the lines shown"') && html.includes('aria-label="Same cost for the lines shown"'));
    const rows = rowsOf(html).filter((r) => / Year /.test(r) || / Year$/.test(r));
    check('L5 a row\'s picture is a small square with no words; the Save bar stays in reach', rows.length >= 15 && !rows.some((r) => r.includes('Add a picture')) && html.includes('aria-label="Add a picture to 7 Year"') && html.includes('class="card-body bo-toolbar lines-save"'),
      rows.slice(0, 2).join(' // '));

    // words keep the order they came in; two options give a row of chips each
    const tee = await product('Tee', ['Size', 'Colour'], [['S', 'M', 'L', 'XL'], ['Red', 'Blue', 'Green']]);
    await c.query(`update item_variants set created_at = now() + (case option_values[1] when 'S' then 1 when 'M' then 2 when 'L' then 3 else 4 end) * interval '1 second' where item_id = $1`, [tee]);
    html = await page(tee);
    const teeNames = lineNames(html);
    check('L1 words keep the order they came in: S, M, L, XL (not L, M, S, XL)', ['S', 'M', 'L', 'XL'].every((s, k) => teeNames.slice(k * 3, k * 3 + 3).every((n) => n.startsWith(s + ' /'))), teeNames.join(','));
    // the colours were made in the same moment, so they came in A to Z
    const teeChips = [...html.matchAll(/<button[^>]*class="line-chip[^"]*"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]));
    check('L3 twelve lines of two options: a row of chips for each', teeChips.join(',') === 'All,S,M,L,XL,All,Blue,Green,Red', teeChips.join(','));

    // few lines: no chips; a role that may not see cost: no cost box
    const cap = await product('Cap', ['Size'], [['S', 'M', 'L']]);
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Stock keeper','["items.edit"]'::jsonb) returning id`, [tid])).id;
    const keeper = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Keeper',$2) returning id`, [tid, role])).id;
    html = await page(cap, { ...ctx, employeeId: keeper });
    check('L3 three lines get no chips', !/class="line-chip/.test(html) && /data-line=""/.test(html));
    check('L4 one who may not see cost gets the price box, not the cost one', html.includes('aria-label="Same price for the lines shown"') && !html.includes('aria-label="Same cost for the lines shown"'));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PRODUCT LINES PASS' : `PRODUCT LINES FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
