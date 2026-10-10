// api-guest-pass.test.cjs — the deployed dev API's answer to the relay that
// carries guests' orders (migration 0093, GET /guest/pass): which store a
// till is of and whether its tables may order, asked with the till's own
// key and nothing else. No login is made: the restaurant, the till and its
// key are set up straight in the dev database, so this is safe on a shared
// dev branch.
//
// With RELAY set to a relay running on this PC whose TILL_API is this dev
// API (cloudflare/relay, the `relay-dev` launch entry), it also connects to
// that relay as the till, with the same key: the real service in place of the
// stand-in for the relay's one question.
// Usage: node db/tests/api-guest-pass.test.cjs   (after `neon deploy` to dev)
//        RELAY=http://localhost:8790 node db/tests/api-guest-pass.test.cjs
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
  const relay = String(process.env.RELAY || '').replace(/\/+$/, '');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','GuestPass-Probe')`);
  const store = await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','GPS1') returning id, guest_id`);
  const device = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store.id}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  await c.query(`select ensure_pos_basics('${tid}')`);
  const key = (await q1(`select issue_device_key($1, $2) as k`, [owner, device])).k;
  const mine = `Device ${device}:${key}`;

  const ask = async (authorization) => {
    const res = await fetch(base + '/guest/pass', { headers: authorization ? { authorization } : {} });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const plan = (p) => c.query(`update tenants set plan = $2 where id = $1`, [tid, p]);
  const sw = (on) => c.query(`insert into pos_settings (tenant_id, data) values ($1, $2::jsonb) on conflict (tenant_id) do update set data = pos_settings.data || excluded.data`, [tid, JSON.stringify({ tableOrdering: on })]);
  // the relay, as a till: the first thing it says, or that it was turned away
  const knock = (authorization) => new Promise((resolve) => {
    const ws = new WebSocket(relay.replace(/^http/, 'ws') + '/api/till', { headers: { authorization } });
    const done = (v) => { try { ws.close(); } catch { /* closed */ } resolve(v); };
    ws.addEventListener('message', (e) => { if (e.data !== 'pong') done(JSON.parse(e.data)); });
    ws.addEventListener('error', () => done(null));
    setTimeout(() => done(null), 8000);
  });

  try {
    // P1 only a till's own key is taken
    const none = await ask();
    const login = await ask('Bearer eyJhbGciOiJub25lIn0.e30.');
    const wrong = await ask(`Device ${device}:${'0'.repeat(64)}`);
    const shapeless = await ask('Device not-a-key');
    check('P1 the dev API that is deployed knows the question', none.status !== 404, String(none.status));
    check('P1 no key, a login in its place, a wrong key and a shapeless one are all turned away',
      none.status === 401 && login.status === 401 && wrong.status === 401 && shapeless.status === 401, [none.status, login.status, wrong.status, shapeless.status].join(','));

    // P2 the answer: the store's public id, and whether its tables may order
    await plan('premium');
    const off = await ask(mine);
    check('P2 a till is told its store by its public id, and nothing else', off.status === 200 && off.json && off.json.store === store.guest_id && Object.keys(off.json).sort().join() === 'ordering,store', off.status + ' ' + off.text.slice(0, 90));
    check('P2 with the switch off, its tables may not order', off.json && off.json.ordering === false);
    await sw(true);
    const on = await ask(mine);
    check('P2 Premium with the switch on: they may', on.status === 200 && on.json && on.json.ordering === true, on.text.slice(0, 90));
    await plan('standard');
    const starter = await ask(mine);
    check('P2 the Starter pack: they may not', starter.json && starter.json.ordering === false, starter.text.slice(0, 90));
    await plan('premium');

    // P3 the relay asks this very service
    if (relay) {
      const hello = await knock(mine);
      check('P3 the relay takes this till to its own store\'s room', !!hello && hello.t === 'hello' && hello.store === store.guest_id, JSON.stringify(hello));
      check('P3 a made-up key gets nowhere at the relay', (await knock(`Device ${device}:${'0'.repeat(64)}`)) === null);
      await sw(false);
      check('P3 with the switch off the relay turns the till away', (await knock(mine)) === null);
      await sw(true);
    } else console.log('SKIP P3 the relay: set RELAY to one whose TILL_API is ' + new URL(base).host);

    // P4 a till that was deactivated is told so, here and at the relay
    await c.query(`update pos_devices set deleted_at = now() where id = $1`, [device]);
    const gone = await ask(mine);
    check('P4 a deactivated till is refused, as on the sync routes', gone.status === 403 && gone.json && /deactivated/.test(gone.json.error), gone.status + ' ' + gone.text.slice(0, 90));
    if (relay) check('P4 and the relay turns it away', (await knock(mine)) === null);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
