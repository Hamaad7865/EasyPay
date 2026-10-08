// item-ops.test.cjs — migration 0084: an item made, changed or removed from a
// till. The owner asked for it "on the tablet too": until now a till could
// change an item's price and take it off sale, and everything else about the
// menu was the back office's.
//   - item.save makes an item or changes one: its name, its price or that its
//     price is typed at the sale, its category, its barcode, whether it is on
//     sale. item.remove takes it off the menu; receipts that sold it keep it.
//   - both take the right to edit the menu, the person's own or that of
//     whoever approved, as a price changed from a till already does
//   - an item made on a till is a whole item: it carries the tax the back
//     office would have started it on, so its receipts' VAT is right; a
//     shop's new product has its stock counted, as one made in the back
//     office has
//   - what the back office refuses is refused here: no name, a category that
//     is not there, a barcode another item carries, an item that is gone, and
//     another client's item
// Usage: node db/tests/item-ops.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID(), other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','IO-Probe'), ('${other}','${other}','IO-Other')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','IOS1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
    const owner = await emp('Owner', await role('Owner', ['*'])); // the till's login
    const cashier = await emp('Cashier', await role('Cashier', ['sale.create', 'payment.take']));
    const manager = await emp('Manager', await role('Manager', ['sale.create', 'payment.take', 'items.edit']));
    await c.query(`select seed_demo_catalog('${tid}')`);
    await c.query(`select seed_demo_catalog('${other}')`);
    const cat = (await q1(`select id from categories where tenant_id = $1 and deleted_at is null order by sort_order, name limit 1`, [tid])).id;
    const cat2 = (await q1(`select id from categories where tenant_id = $1 and deleted_at is null and id <> $2 order by sort_order, name limit 1`, [tid, cat])).id;
    const theirCat = (await q1(`select id from categories where tenant_id = $1 and deleted_at is null limit 1`, [other])).id;
    const theirItem = await q1(`select id, name from items where tenant_id = $1 and deleted_at is null limit 1`, [other]);
    const tax = (await q1(`select id, rate_bp, type from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, created_at, id limit 1`, [tid]));
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const one = async (o) => { const r = await push([o]); return { said: tag(r[0]), data: r[0].data }; };
    const item = (id) => q1(`select name, price, open_price, category_id, barcode, is_available, track_stock, deleted_at from items where id = $1`, [id]);
    const taxesOf = async (id) => (await c.query(`select tax_id from item_taxes where item_id = $1 and deleted_at is null`, [id])).rows.map((r) => r.tax_id);

    // I1: a priced item, made on the till by someone who may edit the menu
    const samosa = crypto.randomUUID();
    const made = await one(op('item.save', { id: samosa, name: '  Samosa  ', price: 3000, category_id: cat }, owner));
    const s1 = await item(samosa);
    check('I1 an item is made from a till', made.said === 'applied' && !!s1 && s1.name === 'Samosa' && Number(s1.price) === 3000 && s1.category_id === cat && s1.is_available && !s1.open_price, made.said);
    check('I1 it carries the tax the back office would have started it on', (await taxesOf(samosa)).join() === tax.id, JSON.stringify(await taxesOf(samosa)));
    check('I1 the till is told it was new', !!made.data && made.data.created === true, JSON.stringify(made.data));

    // I2: one whose price is typed at the sale
    const labour = crypto.randomUUID();
    const open = await one(op('item.save', { id: labour, name: 'Labour', price: 5000, open_price: true, category_id: null }, owner));
    const l1 = await item(labour);
    check('I2 one whose price is typed at the sale has no price of its own', open.said === 'applied' && l1.open_price === true && Number(l1.price) === 0 && l1.category_id === null, JSON.stringify(l1));

    // I3: both are in the next pull
    const pulled = await asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);
    const got = (pulled.changes.items || []).filter((i) => i.id === samosa || i.id === labour);
    check('I3 a till learns of them in its next pull', got.length === 2 && got.every((i) => !i.deleted_at));

    // I4: a sale of the till-made item has its VAT
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    const sold = await push([
      op('ticket.create', { id: tk, store_id: store }, cashier),
      op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: samosa, qty: 1000 }, cashier),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'IO-1', device_seq: 1, payments: [{ payment_type_id: cash, amount: 3000 }], device_time: '2026-03-02T05:00:00Z' }, cashier),
    ]);
    const receipt = await q1(`select total, tax_total, needs_review from receipts where id = $1`, [rc]);
    const vat = tax.type === 'included' ? Math.round((3000 * tax.rate_bp) / (10000 + tax.rate_bp)) : Math.round((3000 * tax.rate_bp) / 10000);
    check('I4 its receipt carries the VAT', sold.every((o) => o.status === 'applied') && !!receipt && Number(receipt.tax_total) === vat && receipt.needs_review === false,
      JSON.stringify(receipt) + ' expected tax ' + vat);

    // I5: it takes the right to edit the menu
    const no = crypto.randomUUID();
    const refused = await one(op('item.save', { id: no, name: 'Not allowed', price: 1000 }, cashier));
    check('I5 someone who may only sell is refused, and nothing is made', refused.said === 'rejected:forbidden' && !(await item(no)), refused.said);
    const approved = await one(op('item.save', { id: no, name: 'Approved', price: 1000, approved_by: manager }, cashier));
    check('I5 with the approval of someone who may, it is made', approved.said === 'applied' && (await item(no))?.name === 'Approved', approved.said);

    // I6: changing one
    const before = (await q1(`select count(*)::int as n from item_price_changes where item_id = $1`, [samosa])).n;
    const changed = await one(op('item.save', { id: samosa, name: 'Samosa (2)', price: 3500, category_id: cat2, barcode: ' 6001 2345 ', available: false }, manager));
    const s2 = await item(samosa);
    check('I6 its name, price, category, barcode and whether it is on sale are changed',
      changed.said === 'applied' && s2.name === 'Samosa (2)' && Number(s2.price) === 3500 && s2.category_id === cat2 && s2.barcode === '60012345' && s2.is_available === false, JSON.stringify(s2));
    check('I6 the till is told it was not new', !!changed.data && changed.data.created === false);
    check('I6 the price change is written down as any other is', (await q1(`select count(*)::int as n from item_price_changes where item_id = $1`, [samosa])).n === before + 1);
    check('I6 its tax is left as it was', (await taxesOf(samosa)).join() === tax.id);

    // I7: what the back office refuses is refused here, and changes nothing
    const dup = await one(op('item.save', { id: no, name: 'Approved', price: 1000, barcode: '60012345' }, owner));
    check('I7 a barcode another item carries is refused', dup.said === 'rejected:barcode-taken' && (await item(no)).barcode === null, dup.said);
    const blank = await one(op('item.save', { id: no, name: '   ', price: 1000 }, owner));
    check('I7 no name is refused', blank.said === 'rejected:name-required' && (await item(no)).name === 'Approved', blank.said);
    const lost = await one(op('item.save', { id: no, name: 'Approved', price: 1000, category_id: theirCat }, owner));
    check("I7 another client's category is refused", lost.said === 'rejected:bad-category' && (await item(no)).category_id === null, lost.said);
    const dear = await one(op('item.save', { id: no, name: 'Approved', price: 100000001 }, owner));
    check('I7 a price over a million rupees is refused', dear.said === 'rejected:bad-payload' && Number((await item(no)).price) === 1000, dear.said);
    const theirs = await one(op('item.save', { id: theirItem.id, name: 'Taken over', price: 1 }, owner));
    check("I7 another client's item is refused and left alone", theirs.said.startsWith('rejected') && (await q1(`select name from items where id = $1`, [theirItem.id])).name === theirItem.name, theirs.said);

    // I8: removing one
    const cut = await one(op('item.remove', { item_id: no }, cashier));
    check('I8 removing takes the same right', cut.said === 'rejected:forbidden' && (await item(no)).deleted_at === null, cut.said);
    const gone = await one(op('item.remove', { item_id: no }, manager));
    check('I8 an item is removed from a till', gone.said === 'applied' && (await item(no)).deleted_at !== null, gone.said);
    const twice = await one(op('item.remove', { item_id: no }, manager));
    check('I8 removed twice is removed', twice.said === 'applied', twice.said);
    const after = await asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);
    check('I8 a till learns it is gone', ((after.changes.items || []).find((i) => i.id === no) || {}).deleted_at != null);
    const back = await one(op('item.save', { id: no, name: 'Back again', price: 1000 }, owner));
    check('I8 a removed item is not changed', back.said === 'rejected:bad-item' && (await item(no)).name === 'Approved', back.said);
    const theirGone = await one(op('item.remove', { item_id: theirItem.id }, owner));
    check("I8 another client's item is not removed", theirGone.said.startsWith('rejected') && (await q1(`select deleted_at from items where id = $1`, [theirItem.id])).deleted_at === null, theirGone.said);
    check('I8 the receipt that sold a removed item keeps it', (await q1(`select count(*)::int as n from receipt_lines where receipt_id = $1`, [rc])).n === 1);

    // I9: a shop's new product has its stock counted, as one made in the back office has; a service has none to count
    await c.query(`update tenants set business_type = 'retail' where id = $1`, [tid]);
    const mug = crypto.randomUUID(), fitting = crypto.randomUUID();
    const p1 = await one(op('item.save', { id: mug, name: 'Mug', price: 26000 }, owner));
    const p2 = await one(op('item.save', { id: fitting, name: 'Fitting', open_price: true }, owner));
    check("I9 a shop's new product has its stock counted", p1.said === 'applied' && (await item(mug)).track_stock === true, p1.said);
    check('I9 a service made in a shop has no stock to count', p2.said === 'applied' && (await item(fitting)).track_stock === false && (await item(fitting)).open_price === true, p2.said);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures === 0 ? 'ITEM-OPS PASS' : `ITEM-OPS FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
