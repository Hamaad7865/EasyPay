// purge-tells-tills.test.cjs — migration 0155: Delete all transactions writes
// when into the business's settings, so that its tills, which a pull never
// tells what was deleted, empty their Receipts (android core/sync/OfficeClear).
// Usage: node db/tests/purge-tells-tills.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const tenants = [];
  async function shop(name, settings) {
    const tid = crypto.randomUUID();
    tenants.push(tid);
    await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, $2)`, [tid, name]);
    if (settings) {
      await c.query(`insert into pos_settings (tenant_id, data) values ($1, $2::jsonb)
        on conflict (tenant_id) do update set data = excluded.data`, [tid, JSON.stringify(settings)]);
    } else {
      await c.query(`delete from pos_settings where tenant_id = $1`, [tid]);
    }
    const store = (await q1(`insert into stores (tenant_id, name, code) values ($1, 'Main', 'PT1') returning id`, [tid])).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, 'T1', 'T1') returning id`, [tid, store])).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1, 'Owner', '["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1, 'Owner', $2) returning id`, [tid, role])).id;
    await c.query(`select seed_demo_catalog($1)`, [tid]);
    return { tid, store, dev, owner };
  }
  const pull = (s, cursor) => asApp(s.tid, async () => (await c.query(`select sync_pull($1, $2, 1000) as r`, [s.store, cursor])).rows[0].r);
  const purge = (s) => asApp(s.tid, async () => (await c.query(`select purge_transactions($1, $2) as r`, [s.tid, s.owner])).rows[0].r);
  const settings = async (s) => (await q1(`select data from pos_settings where tenant_id = $1`, [s.tid]))?.data;
  // a till's whole pull from a cursor, every page
  async function pullAll(s, from) {
    let cursor = from, out = {};
    for (let i = 0; i < 50; i++) {
      const p = await pull(s, cursor);
      for (const [t, rows] of Object.entries(p.changes)) out[t] = (out[t] || []).concat(rows);
      const moved = Number(p.next_cursor) > cursor;
      cursor = Number(p.next_cursor);
      if (!p.has_more || !moved) break;
    }
    return { changes: out, cursor };
  }

  // a shop with its settings, one sale made at its till
  const a = await shop('PT-Probe', { plan: 'premium', businessType: 'retail', returns: 'exchange', returnDays: 14 });
  {
    const dp = (await q1(`select id from items where tenant_id = $1 and name = 'Dholl puri'`, [a.tid])).id;
    const cash = (await q1(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [a.tid])).id;
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    const r = await asApp(a.tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [a.owner, JSON.stringify([
      op('ticket.create', { id: tk, store_id: a.store }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp, qty: 1000 }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: a.store, device_id: a.dev, number: 'PT-1', device_seq: 1,
        payments: [{ payment_type_id: cash, amount: 5000 }], device_time: new Date().toISOString() }),
    ])])).rows[0].r);
    if (!r.every((o) => o.status === 'applied')) throw new Error('sale: ' + JSON.stringify(r));
  }
  const before = await pullAll(a, 0);
  check('P0 the till has the sale', (before.changes.receipts || []).length === 1, String((before.changes.receipts || []).length));

  // P1 the purge writes when, and leaves the shop's other settings as they were
  await purge(a);
  const s1 = await settings(a);
  check('P1 the settings say when the transactions were deleted', typeof s1.cleared === 'string' && !Number.isNaN(Date.parse(s1.cleared)), JSON.stringify(s1));
  check('P1 and keep every other setting', s1.plan === 'premium' && s1.businessType === 'retail' && s1.returns === 'exchange' && s1.returnDays === 14, JSON.stringify(s1));

  // P2 the till's next pull, from where it was, carries the mark
  const after = await pullAll(a, before.cursor);
  const sent = (after.changes.pos_settings || []).map((r) => r.data);
  check('P2 the pull after the purge brings the settings with the mark', sent.length === 1 && sent[0].cleared === s1.cleared, JSON.stringify(sent));
  check('P2 and no receipt', (after.changes.receipts || []).length === 0);
  const fresh = await pullAll(a, 0);
  check('P2 a till pulling from nothing gets no receipt and the mark', (fresh.changes.receipts || []).length === 0 && !!s1.cleared && (fresh.changes.pos_settings || [])[0]?.data?.cleared === s1.cleared);

  // P3 a second purge is a new mark
  await new Promise((r) => setTimeout(r, 20));
  await purge(a);
  const s3 = await settings(a);
  check('P3 a second purge writes a new mark', s3.cleared && s3.cleared !== s1.cleared && Date.parse(s3.cleared) > Date.parse(s1.cleared), s1.cleared + ' ' + s3.cleared);

  // P4 a business with no settings row is given one
  const b = await shop('PT-Bare', null);
  await purge(b);
  const s4 = await settings(b);
  check('P4 a business with no settings gets the mark', s4 && typeof s4.cleared === 'string', JSON.stringify(s4));

  // P5 the migration marks the purges of the last week from their audit, not older ones (rolled back)
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0155_purge_tells_the_tills.sql'), 'utf8');
    const fill = sql.slice(sql.indexOf('-- the purges of the last week'));
    const recent = await shop('PT-Recent', { plan: 'premium' });
    const old = await shop('PT-Old', { plan: 'premium' });
    await c.query('BEGIN');
    try {
      const by = crypto.randomUUID();
      await c.query(`insert into platform.audit (admin_auth_user_id, action, tenant_id, detail, created_at) values
        ($3, 'tenant.purge_transactions', $1, '{}'::jsonb, now() - interval '2 days'),
        ($3, 'tenant.purge_transactions', $1, '{}'::jsonb, now() - interval '3 hours'),
        ($3, 'tenant.purge_transactions', $2, '{}'::jsonb, now() - interval '10 days')`, [recent.tid, old.tid, by]);
      const hours = (await q1(`select to_jsonb(now() - interval '3 hours') #>> '{}' as t`)).t;
      await c.query(fill);
      const r = (await q1(`select data from pos_settings where tenant_id = $1`, [recent.tid])).data;
      const o = (await q1(`select data from pos_settings where tenant_id = $1`, [old.tid])).data;
      check('P5 a purge of this week is marked, by its latest', r.cleared === hours && r.plan === 'premium', JSON.stringify(r) + ' ' + hours);
      check('P5 an older purge is not', o.cleared === undefined && o.plan === 'premium', JSON.stringify(o));
    } finally {
      await c.query('ROLLBACK');
    }
  }

  for (const t of tenants) await devguard.cleanupTenant(c, t);
  await c.end();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
