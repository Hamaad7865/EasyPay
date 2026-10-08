// till-categories-stock.test.cjs — migration 0087: a category made, changed or
// removed from a till, and stock added or taken out there. The owner asked
// for both "in the apk": until now a till could make an item and had to be
// handed its category, and could read what was left and change none of it.
//   - category.save makes a category or changes one: its name and its colour,
//     and nothing else. Its printers, whether its stock is counted and its
//     place among the buttons are the back office's and are left as they were.
//     category.remove is refused while items are in it, as the back office
//     refuses.
//   - stock.adjust puts stock in or takes it out, with a reason that need not
//     be given ("with reason but make reason optional"). A reason has to
//     belong to the direction; taking out more than there is is refused.
//   - item.save can say whether the item's stock is counted; a till that does
//     not say leaves it as it was.
// Usage: node db/tests/till-categories-stock.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','CS-Probe'), ('${other}','${other}','CS-Other')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','CSS1') returning id`)).id;
    const theirStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','CSS2') returning id`)).id;
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
    const owner = await emp('Owner', await role('Owner', ['*'])); // the till's login
    const cashier = await emp('Cashier', await role('Cashier', ['sale.create', 'payment.take']));
    const manager = await emp('Manager', await role('Manager', ['sale.create', 'items.edit', 'stock.adjust']));
    await c.query(`select seed_demo_catalog('${tid}')`);
    await c.query(`select seed_demo_catalog('${other}')`);
    const theirCat = await q1(`select id, name from categories where tenant_id = $1 and deleted_at is null limit 1`, [other]);
    // a category with items in it, as the back office set it up
    const full = (await q1(`select c.id from categories c where c.tenant_id = $1 and c.deleted_at is null
        and exists (select 1 from items i where i.category_id = c.id and i.deleted_at is null) order by c.sort_order, c.name limit 1`, [tid])).id;
    const printer = (await q1(`insert into printers (tenant_id, store_id, name, kind, address) values ($1,$2,'Grill','network','10.0.0.9') returning id`, [tid, store])).id;
    await c.query(`update categories set printer_ids = array[$2]::uuid[], sort_order = 7 where id = $1`, [full, printer]);

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
    const cat = (id) => q1(`select name, color, sort_order, is_stock, printer_ids::text as printers, deleted_at from categories where id = $1`, [id]);
    const pull = () => asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);

    // C1: a category made on the till
    const top = (await q1(`select max(sort_order)::int as n from categories where tenant_id = $1 and deleted_at is null`, [tid])).n;
    const grill = crypto.randomUUID();
    const made = await one(op('category.save', { id: grill, name: '  Grill  ', color: '#B9521C' }, owner));
    const g1 = await cat(grill);
    check('C1 a category is made from a till', made.said === 'applied' && !!g1 && g1.name === 'Grill' && String(g1.color).toUpperCase() === '#B9521C', made.said + ' ' + JSON.stringify(g1));
    check('C1 it goes last among the buttons', !!g1 && g1.sort_order === top + 1, g1 && g1.sort_order + ' after ' + top);
    check('C1 the till is told it was new', !!made.data && made.data.created === true, JSON.stringify(made.data));

    // C2: a change is of the name and the colour, and of nothing else
    const was = await cat(full);
    const changed = await one(op('category.save', { id: full, name: 'Mains', color: '#2459C9' }, manager));
    const f2 = await cat(full);
    check('C2 its name and colour are changed', changed.said === 'applied' && f2.name === 'Mains' && String(f2.color).toUpperCase() === '#2459C9', changed.said);
    check('C2 its printers, its place and whether its stock is counted are as they were',
      f2.printers === was.printers && f2.printers.includes(printer) && f2.sort_order === 7 && f2.is_stock === was.is_stock, JSON.stringify(f2));
    check('C2 the till is told it was not new', !!changed.data && changed.data.created === false);
    const plain = await one(op('category.save', { id: full, name: 'Mains', color: '' }, manager));
    check('C2 no colour is no colour', plain.said === 'applied' && (await cat(full)).color === null, plain.said);

    // C3: what is refused, and changes nothing
    const blank = await one(op('category.save', { id: full, name: '   ', color: '' }, owner));
    check('C3 no name is refused', blank.said === 'rejected:name-required' && (await cat(full)).name === 'Mains', blank.said);
    const red = await one(op('category.save', { id: full, name: 'Mains', color: 'red' }, owner));
    check('C3 a colour that is not one is refused', red.said === 'rejected:bad-payload' && (await cat(full)).color === null, red.said);
    const no = crypto.randomUUID();
    const refused = await one(op('category.save', { id: no, name: 'Not allowed' }, cashier));
    check('C3 someone who may only sell is refused, and nothing is made', refused.said === 'rejected:forbidden' && !(await cat(no)), refused.said);
    const approved = await one(op('category.save', { id: no, name: 'Approved', approved_by: manager }, cashier));
    check('C3 with the approval of someone who may, it is made', approved.said === 'applied' && (await cat(no))?.name === 'Approved', approved.said);
    const theirs = await one(op('category.save', { id: theirCat.id, name: 'Taken over' }, owner));
    check("C3 another client's category is refused and left alone", theirs.said.startsWith('rejected') && (await cat(theirCat.id)).name === theirCat.name, theirs.said);

    // C4: removing one
    const held = await one(op('category.remove', { category_id: full }, owner));
    check('C4 a category with items in it is not removed', held.said === 'rejected:has-items' && (await cat(full)).deleted_at === null, held.said);
    const cut = await one(op('category.remove', { category_id: no }, cashier));
    check('C4 removing takes the same right', cut.said === 'rejected:forbidden' && (await cat(no)).deleted_at === null, cut.said);
    const gone = await one(op('category.remove', { category_id: no }, manager));
    check('C4 an empty category is removed from a till', gone.said === 'applied' && (await cat(no)).deleted_at !== null, gone.said);
    const twice = await one(op('category.remove', { category_id: no }, manager));
    check('C4 removed twice is removed', twice.said === 'applied', twice.said);
    const back = await one(op('category.save', { id: no, name: 'Back again' }, owner));
    check('C4 a removed category is not changed', back.said === 'rejected:bad-category' && (await cat(no)).name === 'Approved', back.said);
    const theirGone = await one(op('category.remove', { category_id: theirCat.id }, owner));
    check("C4 another client's category is not removed", theirGone.said.startsWith('rejected') && (await cat(theirCat.id)).deleted_at === null, theirGone.said);
    const p1 = await pull();
    const seen = (p1.changes.categories || []);
    check('C4 a till learns of the new one and of the one that is gone',
      !!seen.find((x) => x.id === grill && !x.deleted_at) && (seen.find((x) => x.id === no) || {}).deleted_at != null);

    // stock: a counted item, one that is not, and a product with a variant
    const counted = crypto.randomUUID(), loose = crypto.randomUUID(), shirt = crypto.randomUUID(), medium = crypto.randomUUID();
    await c.query(`insert into items (id, tenant_id, name, price, track_stock) values ($1,$4,'Cola',5000,true), ($2,$4,'Tea',3000,false), ($3,$4,'Shirt',90000,true)`, [counted, loose, shirt, tid]);
    await c.query(`insert into item_variants (id, tenant_id, item_id, name, price) values ($1,$2,$3,'M',90000)`, [medium, tid, shirt]);
    const level = async (item, variant) => Number((await q1(`select coalesce((select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3
        and variant_id is not distinct from $4 and deleted_at is null), 0) as q`, [tid, store, item, variant || null])).q);
    const lastMove = (item) => q1(`select qty, reason, employee_id, note from stock_movements where tenant_id = $1 and item_id = $2 order by created_at desc, id desc limit 1`, [tid, item]);
    const adj = (who, more) => one(op('stock.adjust', { store_id: store, item_id: counted, units: 5000, direction: 'in', ...more }, who));

    // S1: stock put in, with no reason and with one
    const in1 = await adj(manager, {});
    const m1 = await lastMove(counted);
    check('S1 stock is added from a till', in1.said === 'applied' && (await level(counted)) === 5000, in1.said + ' ' + (await level(counted)));
    check('S1 with no reason it is an adjustment, by whoever made it', !!m1 && m1.reason === 'adjust' && Number(m1.qty) === 5000 && m1.employee_id === manager, JSON.stringify(m1));
    check('S1 the till is told what there is now', !!in1.data && Number(in1.data.qty) === 5000, JSON.stringify(in1.data));
    const in2 = await adj(manager, { reason: 'receive', note: ' from the van ' });
    const m2 = await lastMove(counted);
    check('S1 a delivery is written down as one, with its note', in2.said === 'applied' && m2.reason === 'receive' && m2.note === 'from the van' && (await level(counted)) === 10000, in2.said + ' ' + JSON.stringify(m2));

    // S2: stock taken out
    const out1 = await adj(manager, { direction: 'out', units: 2000, reason: 'damaged' });
    const m3 = await lastMove(counted);
    check('S2 stock is taken out with its reason', out1.said === 'applied' && (await level(counted)) === 8000 && m3.reason === 'damaged' && Number(m3.qty) === -2000, out1.said + ' ' + JSON.stringify(m3));
    const out2 = await adj(manager, { direction: 'out', units: 1000 });
    check('S2 and with none', out2.said === 'applied' && (await level(counted)) === 7000 && (await lastMove(counted)).reason === 'adjust', out2.said);

    // S3: what is refused, and moves nothing
    const still = async (name, r, code) => check(name, r.said === 'rejected:' + code && (await level(counted)) === 7000, r.said + ' ' + (await level(counted)));
    await still('S3 more than there is cannot be taken out', await adj(manager, { direction: 'out', units: 7001 }), 'not-enough-stock');
    await still('S3 a reason for taking out does not put in', await adj(manager, { reason: 'damaged' }), 'bad-reason');
    await still('S3 a reason for putting in does not take out', await adj(manager, { direction: 'out', units: 1000, reason: 'found' }), 'bad-reason');
    await still('S3 a reason that is a sale is not one', await adj(manager, { reason: 'sale' }), 'bad-reason');
    await still('S3 nothing is not a quantity', await adj(manager, { units: 0 }), 'bad-qty');
    await still('S3 a direction that is neither is refused', await adj(manager, { direction: 'up' }), 'bad-payload');
    await still("S3 another client's store is refused", await adj(manager, { store_id: theirStore }), 'bad-store');
    await still('S3 someone who may only sell is refused', await adj(cashier, {}), 'forbidden');
    const ok = await adj(cashier, { units: 1000, approved_by: manager });
    check('S3 with the approval of someone who may, it is done', ok.said === 'applied' && (await level(counted)) === 8000, ok.said);
    const un = await one(op('stock.adjust', { store_id: store, item_id: loose, units: 1000, direction: 'in' }, manager));
    check('S3 an item whose stock is not counted takes none', un.said === 'rejected:not-counted' && (await level(loose)) === 0, un.said);
    const whole = await one(op('stock.adjust', { store_id: store, item_id: shirt, units: 3000, direction: 'in' }, manager));
    check('S3 a product with variants needs one', whole.said === 'rejected:pick-variant' && (await level(shirt)) === 0, whole.said);
    const wrong = await one(op('stock.adjust', { store_id: store, item_id: shirt, variant_id: crypto.randomUUID(), units: 3000, direction: 'in' }, manager));
    check('S3 a variant that is not its own is refused', wrong.said === 'rejected:bad-variant', wrong.said);
    const sized = await one(op('stock.adjust', { store_id: store, item_id: shirt, variant_id: medium, units: 3000, direction: 'in' }, manager));
    check('S3 and its variant takes the stock', sized.said === 'applied' && (await level(shirt, medium)) === 3000, sized.said);

    // S4: the till learns of it
    const p2 = await pull();
    const lv = (p2.changes.stock_levels || []).find((l) => l.item_id === counted && !l.variant_id);
    check('S4 a till learns what is left in its next pull', !!lv && Number(lv.qty) === 8000, JSON.stringify(lv));

    // T1: an item's stock is counted from the till, or left as it was
    const flag = async (id) => (await q1(`select track_stock from items where id = $1`, [id])).track_stock;
    const on = await one(op('item.save', { id: loose, name: 'Tea', price: 3000, track_stock: true }, manager));
    check('T1 an item is switched to counted from a till', on.said === 'applied' && (await flag(loose)) === true, on.said);
    const kept = await one(op('item.save', { id: loose, name: 'Tea', price: 3200 }, manager));
    check('T1 a till that does not say leaves it as it was', kept.said === 'applied' && (await flag(loose)) === true, kept.said);
    const off = await one(op('item.save', { id: loose, name: 'Tea', price: 3200, track_stock: false }, manager));
    check('T1 and it is switched off again', off.said === 'applied' && (await flag(loose)) === false, off.said);
    const svc = crypto.randomUUID();
    const service = await one(op('item.save', { id: svc, name: 'Labour', open_price: true, track_stock: true }, manager));
    check('T1 one whose price is typed at the sale has no stock to count', service.said === 'applied' && (await flag(svc)) === false, service.said);
    const fresh = crypto.randomUUID();
    const born = await one(op('item.save', { id: fresh, name: 'Juice', price: 4000, track_stock: true }, manager));
    check('T1 a new item can be counted from the start', born.said === 'applied' && (await flag(fresh)) === true, born.said);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-CATEGORIES-STOCK PASS' : `TILL-CATEGORIES-STOCK FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
