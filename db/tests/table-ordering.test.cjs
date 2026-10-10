// table-ordering.test.cjs — migration 0093: ordering from the table by QR
// code. A store's public id (the address on its table cards): every store has
// one, a new store is given one, it has the shape the relay expects and is
// never changed. And guest_pass, the till service's answer to the relay's one
// question: which store a till is of, and whether table ordering is on for it
// (Premium or a trial, a restaurant, an account that is not suspended, and
// the switch in POS settings).
// Usage: node db/tests/table-ordering.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const SHAPE = /^[a-z2-7]{16}$/;

(async () => {
  const env = devguard.envMap();
  devguard.requireDev(env);
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const refused = async (sql, args) => { try { await c.query(sql, args); return ''; } catch (e) { return e.message; } };
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Guest-Probe'), ('${other}','${other}','Guest-Other')`);
  try {
    // G1 every store has an address of its own
    {
      const all = await q1(`select count(*)::int as n, count(distinct guest_id)::int as d, count(*) filter (where guest_id ~ '^[a-z2-7]{16}$')::int as ok from stores`);
      check('G1 every store has a public id of sixteen letters and digits, and no two share one', all.n > 0 && all.n === all.d && all.n === all.ok, JSON.stringify(all));
    }

    // G2 a new store is given one, of its own
    const store = await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','GST1') returning id, guest_id`);
    const second = await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Second','GST2') returning id, guest_id`);
    const theirs = await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','GST3') returning id, guest_id`);
    check('G2 a new store is given a public id, and each its own', SHAPE.test(store.guest_id) && SHAPE.test(second.guest_id) && new Set([store.guest_id, second.guest_id, theirs.guest_id]).size === 3);
    {
      const many = (await c.query(`select new_guest_id() as g from generate_series(1, 400)`)).rows.map((r) => r.g);
      const letters = new Set(many.join(''));
      check('G2 four hundred made in a row are all of the shape, all different, and use the whole alphabet', many.every((g) => SHAPE.test(g)) && new Set(many).size === 400 && letters.size === 32, letters.size + ' letters');
    }

    // G3 it is for good: cards are printed with it
    {
      const why = await refused(`update stores set guest_id = 'aaaaaaaaaaaaaaaa' where id = $1`, [store.id]);
      check('G3 a store\'s public id cannot be changed', /printed|for good/i.test(why), why);
      await c.query(`update stores set name = 'Main room' where id = $1`, [store.id]);
      const now = await q1(`select name, guest_id from stores where id = $1`, [store.id]);
      check('G3 the store itself can still be changed, and keeps its id', now.name === 'Main room' && now.guest_id === store.guest_id);
      const short = await refused(`insert into stores (tenant_id, name, code, guest_id) values ('${tid}','Bad','GST4','short')`);
      const upper = await refused(`insert into stores (tenant_id, name, code, guest_id) values ('${tid}','Bad','GST5','AAAAAAAAAAAAAAAA')`);
      const twice = await refused(`insert into stores (tenant_id, name, code, guest_id) values ('${tid}','Bad','GST6',$1)`, [store.guest_id]);
      check('G3 one that is not of the shape, or is another store\'s, is refused', !!short && !!upper && !!twice);
    }

    // G4 the till service's answer
    const asApp = async (tenant, fn) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    };
    const pass = (tenant, st) => asApp(tenant, async () => (await c.query('select guest_pass($1::uuid) as r', [st])).rows[0].r);
    const plan = (p) => c.query(`update tenants set plan = $2 where id = $1`, [tid, p]);
    const settings = (d) => c.query(`insert into pos_settings (tenant_id, data) values ($1, $2::jsonb) on conflict (tenant_id) do update set data = excluded.data`, [tid, JSON.stringify(d)]);
    const ordering = async () => (await pass(tid, store.id)).ordering;

    await plan('premium');
    {
      const p = await pass(tid, store.id);
      check('G4 the answer names the store by its public id', p && p.store === store.guest_id && Object.keys(p).sort().join() === 'ordering,store', JSON.stringify(p));
      check('G4 with nothing switched on, ordering is off', p.ordering === false);
    }
    await settings({ tableOrdering: true });
    check('G4 Premium, a restaurant, the switch on: ordering is on', (await ordering()) === true);
    check('G4 and for each of its stores, by that store\'s own id', (await pass(tid, second.id)).store === second.guest_id && (await pass(tid, second.id)).ordering === true);
    await plan('trial');
    check('G4 a trial has it too, as it has the kitchen screen', (await ordering()) === true);
    await plan('standard');
    check('G4 the Starter pack does not', (await ordering()) === false);
    await plan('premium');
    await settings({ tableOrdering: 'true' });
    check('G4 the switch is on only when it says true, not a word that looks like it', (await ordering()) === false);
    await settings({ tableOrdering: false });
    check('G4 switched off, it is off', (await ordering()) === false);
    await settings({ tableOrdering: true, businessType: 'retail' });
    check('G4 a shop has no tables to order from', (await ordering()) === false);
    await settings({ tableOrdering: true, businessType: 'restaurant' });
    await c.query(`update tenants set status = 'suspended' where id = $1`, [tid]);
    check('G4 a suspended account takes no orders from its tables', (await ordering()) === false);
    await c.query(`update tenants set status = 'active' where id = $1`, [tid]);
    check('G4 and takes them again once it is active', (await ordering()) === true);

    // G5 one business cannot ask about another's store, and a store that is gone has no answer
    check('G5 a store of another business has no answer', (await pass(tid, theirs.id)) === null && (await pass(other, store.id)) === null);
    check('G5 its own has one, with ordering off: nothing is switched on there', (await pass(other, theirs.id)).ordering === false);
    await c.query(`update stores set deleted_at = now() where id = $1`, [second.id]);
    check('G5 a store that was removed has no answer', (await pass(tid, second.id)) === null);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
