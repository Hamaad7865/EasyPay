// tables.test.cjs — migration 0048: tables and their floor plan, an order's
// table, moving an order, and what the pull sends a till.
// Usage: node db/tests/tables.test.cjs
const crypto = require('crypto');
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
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','TB-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','TBS1') returning id`)).id;
  const store2 = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Second','TBS2') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]') returning id`)).id;
  const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}') returning id`)).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const push = (ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r);
  const pull = (s) => asApp(tid, async () => (await c.query('select sync_pull($1::uuid, 0, 1000) as r', [s])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const ids = (rows) => (rows || []).map((x) => x.id);

  // T1 the back office (as app_user) lays out tables; a name is unique per store
  let t1, t2, other;
  {
    const add = (s, name, x) => asApp(tid, async () => (await c.query(
      `insert into tables (tenant_id, store_id, name, area, seats, shape, x, y, w, h) values ($1,$2,$3,'Main',4,'square',$4,10,12,12) returning id`,
      [tid, s, name, x])).rows[0].id);
    t1 = await add(store, '1', 5);
    t2 = await add(store, '2', 25);
    other = await add(store2, '1', 5); // the same name in another store is fine
    let clash = null;
    try { await add(store, '1', 45); } catch (e) { clash = e.code; }
    check('T1 tables are created, and a name cannot repeat within a store', Boolean(t1 && t2 && other) && clash === '23505', String(clash));
    let off = null;
    try { await add(store, 'off the plan', 500); } catch (e) { off = e.code; }
    check('T1 a position off the plan is refused', off === '23514', String(off));
  }

  // T2 an order opened on a table carries it
  const tk = crypto.randomUUID(), line = crypto.randomUUID();
  {
    const r = await push([
      op('ticket.create', { id: tk, store_id: store, table_id: t1, covers: 2 }),
      op('ticket.add_line', { id: line, ticket_id: tk, item_id: dp, qty: 1000 }),
    ]);
    const row = await q1(`select table_id, covers from tickets where id = $1`, [tk]);
    check('T2 the order is on its table', r.every((x) => tag(x) === 'applied') && row.table_id === t1 && row.covers === 2, r.map(tag).join(' '));
  }

  // T3 a table this restaurant does not have never costs the order
  {
    const lost = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: lost, store_id: store, table_id: crypto.randomUUID() }),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: lost, item_id: dp, qty: 1000 }),
    ]);
    const row = await q1(`select table_id from tickets where id = $1`, [lost]);
    check('T3 an unknown table is left off, and the order and its line are kept', r.every((x) => tag(x) === 'applied') && row && row.table_id === null, r.map(tag).join(' '));
  }

  // T4 moving the order to another table, and taking it off its table
  {
    const a = await push([op('ticket.update_meta', { ticket_id: tk, table_id: t2 })]);
    const moved = await q1(`select table_id, covers from tickets where id = $1`, [tk]);
    check('T4 the order moves to the other table and keeps its guests', tag(a[0]) === 'applied' && moved.table_id === t2 && moved.covers === 2, tag(a[0]));
    const b = await push([op('ticket.update_meta', { ticket_id: tk, name: 'Birthday' })]);
    const kept = await q1(`select table_id, name from tickets where id = $1`, [tk]);
    check('T4 a change that does not mention the table leaves it', tag(b[0]) === 'applied' && kept.table_id === t2 && kept.name === 'Birthday');
    const d = await push([op('ticket.update_meta', { ticket_id: tk, table_id: null })]);
    const off = await q1(`select table_id from tickets where id = $1`, [tk]);
    check('T4 an explicit null takes the order off its table', tag(d[0]) === 'applied' && off.table_id === null);
    await push([op('ticket.update_meta', { ticket_id: tk, table_id: t2 })]);
  }

  // T5 the pull: this store's tables, and the open order with its line
  {
    const a = await pull(store);
    const b = await pull(store2);
    check('T5 a till gets its own store\'s tables', ids(a.changes.tables).includes(t1) && ids(a.changes.tables).includes(t2)
      && !ids(a.changes.tables).includes(other) && ids(b.changes.tables).length === 1 && ids(b.changes.tables)[0] === other,
      `${(a.changes.tables || []).length} and ${(b.changes.tables || []).length}`);
    const got = (a.changes.tickets || []).find((x) => x.id === tk);
    check('T5 the open order arrives with its table and its line', got && got.table_id === t2 && got.status === 'open'
      && ids(a.changes.ticket_lines).includes(line) && !ids(b.changes.tickets).includes(tk));
  }

  // T6 a removed table: gone from new orders, its row still pulled (as deleted)
  {
    await asApp(tid, () => c.query(`update tables set deleted_at = now() where id = $1 and tenant_id = $2`, [t1, tid]));
    const a = await pull(store);
    const row = (a.changes.tables || []).find((x) => x.id === t1);
    check('T6 a removed table reaches the till marked deleted', row && row.deleted_at !== null);
    const again = await asApp(tid, async () => (await c.query(
      `insert into tables (tenant_id, store_id, name, area, seats, shape, x, y, w, h) values ($1,$2,'1','Main',2,'round',5,10,10,10) returning id`,
      [tid, store])).rows[0].id);
    check('T6 its name can be used again', Boolean(again));
  }

  // T7 paying closes the order; the close reaches the till; old closed orders do not
  {
    const rc = crypto.randomUUID();
    const r = await push([op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'TBS1-T1-1', device_seq: 1,
      payments: [{ payment_type_id: cash, amount: 5000 }] })]);
    const a = await pull(store);
    const got = (a.changes.tickets || []).find((x) => x.id === tk);
    check('T7 the paid order arrives closed', tag(r[0]) === 'applied' && got && got.status === 'paid', tag(r[0]));
    // An order closed long ago is not sent to a new till. touch_row keeps
    // updated_at current, so the row is aged with the trigger off, inside one
    // transaction: if anything fails the trigger is back on, never left off.
    await c.query('BEGIN');
    try {
      await c.query(`alter table tickets disable trigger trg_touch`);
      await c.query(`update tickets set updated_at = now() - interval '45 days' where id = $1`, [tk]);
      await c.query(`alter table tickets enable trigger trg_touch`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    const later = await pull(store);
    check('T7 an order closed more than 30 days ago is not sent', !ids(later.changes.tickets).includes(tk) && !ids(later.changes.ticket_lines).includes(line));
  }

  // T8 another restaurant sees none of it
  {
    const seen = await asApp(crypto.randomUUID(), async () => (await c.query(`select count(*)::int n from tables`)).rows[0]);
    check('T8 tables are tenant-scoped', seen.n === 0, JSON.stringify(seen));
  }

  await devguard.cleanupTenant(c, tid);
  const left = await q1(`select count(*)::int n from tables where tenant_id = $1`, [tid]);
  check('cleanup removed the probe rows', left.n === 0);
  console.log(failures === 0 ? 'TABLES PASS' : `TABLES FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
