// item-price.test.cjs — migration 0061: an item's price is changed from the
// till by someone allowed to edit the menu, and every change of a price,
// wherever it is made, leaves a line saying who, when, from what to what.
// Usage: node db/tests/item-price.test.cjs
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
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Price-Probe'), ('${other}','${other}','Price-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','PRS1') returning id`)).id;
  await c.query(`insert into stores (tenant_id, name, code) values ('${other}','Main','PRS2')`);
  await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1')`);
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const wrole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Waiter','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
  const waiter = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Waiter',$2) returning id`, [tid, wrole])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  await c.query(`select seed_demo_catalog('${other}')`);
  const item = await q1(`select id, name, price::int as price, server_seq from items where tenant_id = $1 and deleted_at is null order by name limit 1`, [tid]);
  const theirs = await q1(`select id, price::int as price from items where tenant_id = $1 and deleted_at is null order by name limit 1`, [other]);

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const pushAs = (who, ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [who, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  const price = async (id) => (await q1(`select price::int as p from items where id = $1`, [id])).p;
  const trail = async () => (await c.query(
    `select old_price::int as was, new_price::int as now, changed_by, approved_by, source from item_price_changes where tenant_id = $1 and item_id = $2 order by created_at, id`, [tid, item.id])).rows;

  // T1 someone allowed to edit the menu changes a price from the till
  {
    const r = await pushAs(owner, [op('item.set_price', { item_id: item.id, price: item.price + 2500 })]);
    const t = await trail();
    check('T1 the price is changed', tag(r[0]) === 'applied' && (await price(item.id)) === item.price + 2500, tag(r[0]) + ' ' + (await price(item.id)));
    check('T1 the change is written down: from, to, who, where', t.length === 1 && t[0].was === item.price && t[0].now === item.price + 2500 && t[0].changed_by === owner && t[0].approved_by === null && t[0].source === 'till', JSON.stringify(t));
    const seq = (await q1(`select server_seq from items where id = $1`, [item.id])).server_seq;
    check('T1 the other tills are told: the item moved on', Number(seq) > Number(item.server_seq), seq + ' > ' + item.server_seq);
  }

  // T2 a waiter may not; with a manager's approval it goes through and both names are kept
  {
    const before = await price(item.id);
    const no = await pushAs(waiter, [op('item.set_price', { item_id: item.id, price: 100 })]);
    check('T2 a waiter cannot change a price', tag(no[0]) === 'rejected:forbidden' && (await price(item.id)) === before, tag(no[0]));
    const yes = await pushAs(owner, [{ ...op('item.set_price', { item_id: item.id, price: before - 500, approved_by: owner }), employee_id: waiter }]);
    const t = await trail();
    const last = t[t.length - 1];
    check('T2 with an approval it is changed, in the waiter\'s name with the approver on record',
      tag(yes[0]) === 'applied' && (await price(item.id)) === before - 500 && last.changed_by === waiter && last.approved_by === owner, tag(yes[0]) + ' ' + JSON.stringify(last));
  }

  // T3 what is not a price, and what is not this restaurant's item
  {
    const before = await price(item.id);
    const r = await pushAs(owner, [
      op('item.set_price', { item_id: item.id, price: -100 }),
      op('item.set_price', { item_id: item.id, price: 'cheap' }),
      op('item.set_price', { item_id: item.id }),
      op('item.set_price', { item_id: item.id, price: 100000001 }),
      op('item.set_price', { item_id: theirs.id, price: 100 }),
      op('item.set_price', { item_id: crypto.randomUUID(), price: 100 }),
    ]);
    check('T3 a negative, a word, nothing and a silly amount are refused', r.slice(0, 4).every((x) => tag(x) === 'rejected:bad-payload'), r.slice(0, 4).map(tag).join(' '));
    check('T3 another restaurant\'s item and an unknown one are refused', tag(r[4]) === 'rejected:bad-item' && tag(r[5]) === 'rejected:bad-item', tag(r[4]) + ' ' + tag(r[5]));
    check('T3 nothing changed, here or there', (await price(item.id)) === before && (await price(theirs.id)) === theirs.price);
  }

  // T4 the same price again changes nothing and writes nothing
  {
    const n = (await trail()).length;
    const r = await pushAs(owner, [op('item.set_price', { item_id: item.id, price: await price(item.id) })]);
    check('T4 the same price again is accepted and leaves no line', tag(r[0]) === 'applied' && (await trail()).length === n, tag(r[0]));
  }

  // T5 a price changed in the back office is written down too
  {
    const before = await price(item.id);
    await asApp(tid, async () => c.query(`update items set price = $2 where tenant_id = $1 and id = $3`, [tid, before + 1000, item.id]));
    const t = await trail();
    const last = t[t.length - 1];
    check('T5 a back office change leaves a line too', last.was === before && last.now === before + 1000 && last.source === 'backoffice' && last.changed_by === null, JSON.stringify(last));
    // and a till change after it is not mistaken for one of the back office's
    await pushAs(owner, [op('item.set_price', { item_id: item.id, price: before })]);
    await asApp(tid, async () => c.query(`update items set name = name where tenant_id = $1 and id = $2`, [tid, item.id]));
    const t2 = await trail();
    check('T5 a change of name is not a change of price', t2.length === t.length + 1 && t2[t2.length - 1].source === 'till');
  }

  // T6 the lines are the restaurant's own
  {
    const seen = await asApp(other, async () => (await c.query(`select count(*)::int n from item_price_changes`)).rows[0].n);
    const mine = await asApp(tid, async () => (await c.query(`select count(*)::int n from item_price_changes`)).rows[0].n);
    check('T6 another restaurant sees none of them', seen === 0 && mine >= 4, seen + ' / ' + mine);
  }

  // T7 a sale rung up at the new price is not flagged
  {
    const now = await price(item.id);
    await pushAs(owner, [op('item.set_price', { item_id: item.id, price: now + 700 })]);
    const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
    const dev = (await q1(`select id from pos_devices where tenant_id = $1`, [tid])).id;
    const cash = (await q1(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
    const r = await pushAs(owner, [
      op('ticket.create', { id: tk, store_id: store }),
      op('ticket.add_line', { id: ln, ticket_id: tk, item_id: item.id, qty: 1000, unit_price: now + 700, name_snapshot: item.name, modifiers: [] }),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'PRS1-T1-000001', device_seq: 1, payments: [{ payment_type_id: cash, amount: now + 700 }], discounts: [], line_ids: [ln] }),
    ]);
    const row = await q1(`select total::int as total, needs_review from receipts where id = $1`, [rc]);
    check('T7 a sale at the new price is stored at that price and not flagged', r.map(tag).join(' ') === 'applied applied applied' && row.total === now + 700 && row.needs_review === false, r.map(tag).join(' ') + ' ' + JSON.stringify(row));
  }

  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
