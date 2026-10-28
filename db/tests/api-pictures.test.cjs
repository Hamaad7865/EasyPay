// api-pictures.test.cjs — the deployed dev API's GET /pictures/<id> (migration 0143): a till
// fetches, with its own key, a picture its pull named, and nothing of another business's. No
// login is made: the business, the till and its key are set up straight in the dev database,
// so this is safe on a shared dev branch.
// Usage: node db/tests/api-pictures.test.cjs   (after `neon deploy` to dev)
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const base = String(env.NEON_FUNCTION_API_BASE_URL || '').replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  if (!base) throw new Error('NEON_FUNCTION_API_BASE_URL is not set in .env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID(), uid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  try {
    for (const [t, name] of [[tid, 'Pictures-Probe'], [uid, 'Pictures-Other']]) {
      await c.query(`insert into tenants (id, tenant_id, name) values ($1,$1,$2)`, [t, name]);
    }
    const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main','PIC1') returning id`, [tid])).id;
    const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select ensure_pos_basics($1)`, [tid]);
    const key = (await q1(`select issue_device_key($1, $2) as k`, [owner, device])).k;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
    const mine = (await q1(`select picture_put($1,$2,640,480) as id`, [tid, jpeg])).id;
    const theirs = (await q1(`select picture_put($1,$2,640,480) as id`, [uid, jpeg])).id;
    const get = (pic, authorization) => fetch(`${base}/pictures/${pic}`, { headers: authorization ? { authorization } : {} });

    let res = await get(mine, `Device ${device}:${key}`);
    const body = Buffer.from(await res.arrayBuffer());
    check('A1 a till fetches its business\'s picture with its key, as a JPEG kept for good', res.status === 200
      && res.headers.get('content-type') === 'image/jpeg' && /immutable/.test(res.headers.get('cache-control') || '') && body.equals(jpeg),
      `${res.status} ${body.length}`);
    res = await get(theirs, `Device ${device}:${key}`);
    check('A2 another business\'s picture is not found', res.status === 404, String(res.status));
    res = await get(mine, null);
    check('A3 with no key: refused', res.status === 401, String(res.status));
    res = await get('not-an-id', `Device ${device}:${key}`);
    check('A4 what is not an id: not found', res.status === 404, String(res.status));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, uid);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
