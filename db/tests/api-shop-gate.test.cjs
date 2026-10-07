// api-shop-gate.test.cjs — the deployed dev API asks a shop's till to be new
// enough (build 3: the first with a shop's screens) and asks a restaurant's
// till nothing new. No login is made: a shop, a restaurant, a till in each
// and their keys are set up straight in the dev database and taken away
// again, so this is safe on a shared dev branch.
// Usage: node db/tests/api-shop-gate.test.cjs   (after `neon deploy` to dev)
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
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // a business with one store, one till and the till's own key
  const business = async (name, code, type) => {
    const tid = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name, business_type) values ($1,$1,$2,$3)`, [tid, name, type]);
    const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main',$2) returning id`, [tid, code])).id;
    const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select ensure_pos_basics($1)`, [tid]);
    const key = (await q1(`select issue_device_key($1, $2) as k`, [owner, device])).k;
    return { tid, store, device, auth: `Device ${device}:${key}` };
  };
  const call = async (method, path, authorization, version, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization, ...(version != null ? { 'x-till-version': String(version) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const shop = await business('ShopGate-Shop', 'SGS1', 'retail');
  const rest = await business('ShopGate-Rest', 'SGR1', 'restaurant');
  const pull = (b, v) => call('GET', `/sync/pull?storeId=${b.store}&cursor=0&limit=50`, b.auth, v);
  const push = (b, v, ticket) => call('POST', '/sync/push', b.auth, v, { ops: [{ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: ticket, store_id: b.store } }] });

  try {
    const health = await fetch(base + '/health').then((r) => r.json());
    check('the dev API that is deployed has the gate', health.ok && /^v2-\d{4}$/.test(health.build) && health.build >= 'v2-0077' && health.branch !== 'production', JSON.stringify(health));

    // G1 a shop's till that is too old
    const old = await pull(shop, 2);
    check("G1 a shop's till of an older build is told to update (426), on the pull", old.status === 426 && old.json && old.json.min === 3 && /updated/.test(old.json.error), old.status + ' ' + old.text.slice(0, 140));
    const t1 = crypto.randomUUID();
    const oldPush = await push(shop, 2, t1);
    const kept = await q1(`select count(*)::int as n from tickets where id = $1`, [t1]);
    check('G1 and on the push, and nothing it sent was taken', oldPush.status === 426 && kept.n === 0, oldPush.status + ' ' + kept.n);
    const silent = await pull(shop, null);
    check('G1 a till that does not say its build is an older one still', silent.status === 426, String(silent.status));

    // G2 a shop's till that is new enough
    const fresh = await pull(shop, 3);
    check("G2 a shop's till of build 3 syncs, and is sent the shop's settings and stock levels", fresh.status === 200 && fresh.json && Array.isArray(fresh.json.changes.stock_levels) && fresh.json.changes.pos_settings.length === 1, fresh.status + ' ' + fresh.text.slice(0, 120));
    const t2 = crypto.randomUUID();
    const freshPush = await push(shop, 3, t2);
    check('G2 and what it sends is taken', freshPush.status === 200 && Array.isArray(freshPush.json) && freshPush.json[0].status === 'applied', freshPush.status + ' ' + freshPush.text.slice(0, 120));
    check('G2 a later build too', (await pull(shop, 12)).status === 200);

    // G3 a restaurant's till is asked nothing new
    check("G3 a restaurant's till of the older build syncs as before", (await pull(rest, 2)).status === 200);
    check('G3 and one that does not say its build', (await pull(rest, null)).status === 200);
    const t3 = crypto.randomUUID();
    const restPush = await push(rest, 2, t3);
    check('G3 and its orders are taken', restPush.status === 200 && restPush.json[0].status === 'applied', restPush.status + ' ' + restPush.text.slice(0, 120));
  } finally {
    await devguard.cleanupTenant(c, shop.tid);
    await devguard.cleanupTenant(c, rest.tid);
    await c.end();
  }
  console.log(failures === 0 ? 'API SHOP GATE PASS' : `API SHOP GATE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
