// pictures.test.cjs — pictures of a shop's products and of their variants (migration 0143): kept in
// the database as small JPEGs, named by items.picture_id and item_variants.picture_id so the tills
// pull the names with the rows, and fetch each picture once. Checks P1 to P6.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/pictures.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, code, text } = require('./page.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
// the start of a JPEG and some bytes after it: what the database looks at
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);

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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-pic@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Picture Test','Main','PC1','Owner',$2,'premium') as r`, [admin, id()])).r;
    const other = (await one(`select platform.create_tenant($1,'Picture Other','Main','PC2','Owner',$2,'premium') as r`, [admin, id()])).r;
    const tid = made.tenant_id, emp = made.employee_id, uid = other.tenant_id;
    const dress = (await one(`insert into items (tenant_id, name, price, track_stock) values ($1,'Dress',120000,true) returning id`, [tid])).id;
    await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, dress, ['Colour', 'Age'], JSON.stringify([['Beige', 'Black'], ['1', '2']])]);
    await c.query(`update item_variants set option_values = array['beige', '2'], name = 'beige / 2' where item_id = $1 and option_values = array['Beige', '2']`, [dress]);
    const put = (t, bytes, w = 640, h = 480) => one(`select picture_put($1,$2,$3,$4) as id`, [t, bytes, w, h]).then((x) => x.id);
    const lines = () => all(`select id, option_values, picture_id, server_seq from item_variants where item_id = $1 and deleted_at is null order by name`, [dress]);

    // P1 a picture is kept, by the tenant's own role as the back office does it
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const pic = await put(tid, jpeg());
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
    check('P1 a JPEG is kept', Boolean(pic) && (await one(`select length(jpeg) as n from pictures where id = $1`, [pic])).n === 2004);
    let e = await failsWith(`select picture_put($1,$2,640,480)`, [tid, Buffer.from('not a picture at all')]);
    check('P1 what is not a JPEG is refused', said(e) === 'bad-picture', said(e));
    e = await failsWith(`select picture_put($1,$2,640,480)`, [tid, jpeg(400001)]);
    check('P1 one over 400 KB is refused', said(e) === 'bad-picture', said(e));
    e = await failsWith(`select picture_put($1,$2,4000,480)`, [tid, jpeg()]);
    check('P1 one larger than the till keeps is refused', said(e) === 'bad-picture', said(e));

    // P2 a product's picture, and the tills are sent its name
    const seq0 = (await one(`select server_seq from items where id = $1`, [dress])).server_seq;
    await c.query(`select item_picture_set($1,$2,$3)`, [tid, dress, pic]);
    let it = await one(`select picture_id, server_seq from items where id = $1`, [dress]);
    check('P2 the product names its picture, with a later sync number', it.picture_id === pic && Number(it.server_seq) > Number(seq0));
    const theirs = await put(uid, jpeg());
    e = await failsWith(`select item_picture_set($1,$2,$3)`, [tid, dress, theirs]);
    check('P2 another business\'s picture is refused', said(e) === 'unknown-picture', said(e));
    e = await failsWith(`select item_picture_set($1,$2,$3)`, [uid, dress, theirs]);
    check('P2 another business\'s product is refused', said(e) === 'unknown-item', said(e));

    // P3 a picture per colour: every line of that colour, whatever its case
    const beige = await put(tid, jpeg());
    const n = (await one(`select variant_pictures_set($1,$2,1,'BEIGE',$3) as n`, [tid, dress, beige])).n;
    let ls = await lines();
    check('P3 every Beige line has it, the Black ones none', n === 2 && ls.filter((v) => v.option_values[0].toLowerCase() === 'beige').every((v) => v.picture_id === beige)
      && ls.filter((v) => v.option_values[0] === 'Black').every((v) => v.picture_id === null), String(n));
    e = await failsWith(`select variant_pictures_set($1,$2,1,'Green',$3)`, [tid, dress, beige]);
    check('P3 a colour no line has is refused', said(e) === 'unknown-value', said(e));

    // P4 one line's own picture, and taking pictures off
    const blackOne = ls.find((v) => v.option_values[0] === 'Black' && v.option_values[1] === '1');
    const own = await put(tid, jpeg());
    await c.query(`select variant_picture_set($1,$2,$3)`, [tid, blackOne.id, own]);
    check('P4 one line can have its own', (await one(`select picture_id from item_variants where id = $1`, [blackOne.id])).picture_id === own);
    await c.query(`select variant_pictures_set($1,$2,1,'Beige',null)`, [tid, dress]);
    await c.query(`select item_picture_set($1,$2,null)`, [tid, dress]);
    ls = await lines();
    check('P4 null takes them off', ls.filter((v) => v.option_values[0].toLowerCase() === 'beige').every((v) => v.picture_id === null)
      && (await one(`select picture_id from items where id = $1`, [dress])).picture_id === null);

    // P5 the back office serves its own pictures and no other business's
    const ctx = { tenantId: tid, employeeId: emp, mode: 'retail', premium: true, mra: 'off' };
    const route = code(c, ctx, 'app/backoffice/pictures/[id]/route.ts');
    let res = await route.GET(new Request('http://x/backoffice/pictures/' + own), { params: Promise.resolve({ id: own }) });
    const body = Buffer.from(await res.arrayBuffer());
    check('P5 its own picture, as a JPEG kept for good', res.status === 200 && res.headers.get('content-type') === 'image/jpeg'
      && /immutable/.test(res.headers.get('cache-control') || '') && body.length === 2004 && body[0] === 0xff, String(res.status));
    res = await route.GET(new Request('http://x/backoffice/pictures/' + theirs), { params: Promise.resolve({ id: theirs }) });
    check('P5 another business\'s is not found', res.status === 404, String(res.status));

    // P6 the product page: its Picture card, a picture for each colour, and one per line
    await c.query(`select item_picture_set($1,$2,$3)`, [tid, dress, pic]);
    await c.query(`select variant_pictures_set($1,$2,1,'Beige',$3)`, [tid, dress, beige]);
    const html = await open(c, ctx, '/backoffice/items/' + dress, {}, { params: { id: dress }, file: 'backoffice/items/[id]' });
    check('P6 the product page shows its picture, and the colours each with theirs', text(html).includes('Pictures by Colour')
      && html.includes(`src="/backoffice/pictures/${pic}"`) && html.includes(`src="/backoffice/pictures/${beige}"`) && html.includes(`src="/backoffice/pictures/${own}"`),
      text(html).slice(0, 200));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PICTURES PASS' : `PICTURES FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
