// till-office.test.cjs — what a till can set up as the back office does
// (migration 0094, the first build of
// docs/superpowers/specs/2026-10-11-till-setup-design.md).
//   - tax.save: a tax added or changed from a till, by the back office's
//     rules: a name of its own, a rate from 0 to 100 %, included in the price
//     or added on top, and one usual tax. A tax is never removed.
//   - item.save, grown: the product's tax, SKU, cost, brand, supplier and the
//     supplier's code, and its reorder level and order quantity in the till's
//     store. A till that sends none of these changes none of them.
//   - A cost is written only for someone who may see cost, or with the word
//     of someone who may; from anyone else it is left as it was, and the rest
//     of the change is done.
//   - Each is refused for someone who may not, done with the word of someone
//     who may, and written once however often it is sent: a till that lost an
//     answer sends the same thing again under a new change id.
// The example payloads are the files in fixtures/till-office, which the
// tablet's own tests compare with what it builds: what is sent here is what
// the tablet sends. Their stand-in ids are swapped for real ones.
// Usage: node db/tests/till-office.test.cjs
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
const id = () => crypto.randomUUID();
const op = (type, payload, employee) => ({ op_id: id(), type, payload, ...(employee ? { employee_id: employee } : {}) });
const FIX = path.join(__dirname, 'fixtures', 'till-office');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
// every stand-in in a payload swapped for what it stands for
const swap = (v, map) => (Array.isArray(v) ? v.map((x) => swap(x, map))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, map)]))
    : typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v);

(async () => {
  const cs = devguard.envMap().DATABASE_URL_UNPOOLED;
  const c = new Client({ connectionString: cs, ssl: { require: true } });
  await c.connect();
  const tid = id(), resto = id(), other = id();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const all = async (sql, args) => (await c.query(sql, args)).rows;
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','TO-Shop','standard'), ('${resto}','${resto}','TO-Resto','standard'), ('${other}','${other}','TO-Other','standard')`);
  try {
    const mkStore = async (t, name, code) => (await q1(`insert into stores (tenant_id, name, code) values ($1,$2,$3) returning id`, [t, name, code])).id;
    const store = await mkStore(tid, 'Main', 'TOS1');
    const restoStore = await mkStore(resto, 'Main', 'TOS2');
    const theirStore = await mkStore(other, 'Main', 'TOS3');
    const role = async (t, name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [t, name, JSON.stringify(perms)])).id;
    const emp = async (t, name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [t, name, r])).id;
    const owner = await emp(tid, 'Owner', await role(tid, 'Owner', ['*'])); // the till's login
    const editor = await emp(tid, 'Editor', await role(tid, 'Editor', ['items.edit'])); // may change products, may not see cost
    const buyer = await emp(tid, 'Buyer', await role(tid, 'Buyer', ['costs.view'])); // may see cost, may not change products
    const cashier = await emp(tid, 'Cashier', await role(tid, 'Cashier', ['sale.create', 'payment.take']));
    const restoOwner = await emp(resto, 'Owner', await role(resto, 'Owner', ['*']));
    const theirOwner = await emp(other, 'Owner', await role(other, 'Owner', ['*']));
    for (const t of [tid, resto, other]) await c.query(`select ensure_pos_basics($1)`, [t]);
    for (const t of [tid, other]) {
      await c.query(`update tenants set business_type = 'retail' where id = $1`, [t]);
      await c.query(`update pos_settings set data = data || '{"businessType":"retail"}'::jsonb where tenant_id = $1`, [t]);
    }
    const cat = (await q1(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [tid])).id;
    const restoCat = (await q1(`insert into categories (tenant_id, name) values ($1,'Street food') returning id`, [resto])).id;
    const sup = (await q1(`insert into suppliers (tenant_id, name) values ($1,'Maison Ltd') returning id`, [tid])).id;
    const theirSup = (await q1(`insert into suppliers (tenant_id, name) values ($1,'Theirs') returning id`, [other])).id;
    const theirTax = (await q1(`select id from taxes where tenant_id = $1 order by is_default desc limit 1`, [other])).id;
    // the tax a new client starts with: the usual one
    const usual = await q1(`select id, name from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, created_at, id limit 1`, [tid]);
    await c.query(`update taxes set is_default = true where id = $1`, [usual.id]);

    const begin = async (t) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
    };
    async function asApp(fn, t = tid) {
      await begin(t);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const pushAs = (login, ops, t = tid) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r, t);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    // one change, under the owner's login (the till's): `who` is the person at the till, the owner when none
    const one = async (type, payload, who, login = owner, t = tid) => { const r = await pushAs(login, [op(type, payload, who)], t); return { said: tag(r[0]), data: r[0].data, op: r[0].op_id }; };
    const pull = (st = store, t = tid) => asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 1000) as r', [st])).rows[0].r, t);

    const taxA = id(), itemA = id();
    const ids = { 'tax-1': taxA, 'item-1': itemA, 'category-1': cat, 'supplier-1': sup, 'store-1': store };
    // an example payload with its stand-ins swapped, and anything in `over` put over it
    const fx = (name, over = {}, more = {}) => { const f = fixture(name); return [f.type, { ...swap(f.payload, { ...ids, ...more }), ...over }]; };
    const tax = (t) => q1(`select name, rate_bp, type, is_default, deleted_at from taxes where id = $1`, [t]);

    // ---- T: a tax ----
    let r = await one(...fx('tax-save'));
    let row = await tax(taxA);
    check('T1 a tax added from a till', r.said === 'applied' && r.data.created === true && row && row.name === 'Tourist levy' && row.rate_bp === 750 && row.type === 'added' && row.is_default === false,
      r.said + ' ' + JSON.stringify(row));
    r = await one(...fx('tax-save'));
    check('T2 the same again is done, and makes no second tax', r.said === 'applied' && r.data.created === false
      && (await q1(`select count(*)::int as n from taxes where tenant_id = $1 and name = 'Tourist levy'`, [tid])).n === 1, r.said);
    r = await one(...fx('tax-save', { name: '  Levy  ', rate_bp: 1000, type: 'included' }));
    row = await tax(taxA);
    check('T3 its name, rate and way changed', r.said === 'applied' && row.name === 'Levy' && row.rate_bp === 1000 && row.type === 'included', JSON.stringify(row));
    r = await one(...fx('tax-save', { rate_bp: 10001 }));
    const r2 = await one(...fx('tax-save', { rate_bp: -1 }));
    check('T4 a rate above 100 % or below nothing is refused', r.said === 'rejected:bad-rate' && r2.said === 'rejected:bad-rate', r.said + ' ' + r2.said);
    r = await one(...fx('tax-save', { name: '   ' }));
    check('T5 a tax needs a name', r.said === 'rejected:name-required', r.said);
    r = await one(...fx('tax-save', { id: id(), name: usual.name.toUpperCase() }));
    check('T6 a name another tax has is refused, in any case of letters', r.said === 'rejected:name-taken', r.said);
    r = await one(...fx('tax-save', { type: 'sometimes' }));
    check('T7 a way that is neither is a bad payload', r.said === 'rejected:bad-payload', r.said);
    const taxB = id();
    r = await one(...fx('tax-save', { id: taxB, name: 'Cashier tax' }), cashier);
    check('T8 a cashier may not', r.said === 'rejected:forbidden' && !(await tax(taxB)), r.said);
    r = await one(...fx('tax-save', { id: taxB, name: 'Cashier tax', approved_by: owner }), cashier);
    const appr = await q1(`select employee_id, approved_by from approvals where op_id = $1`, [r.op]);
    check('T9 with the owner\'s word it is done, and the approval written', r.said === 'applied' && !!(await tax(taxB)) && appr && appr.employee_id === cashier && appr.approved_by === owner, r.said + ' ' + JSON.stringify(appr));
    r = await one(...fx('tax-save', { name: 'Levy', rate_bp: 1000, type: 'included', is_default: true }));
    check('T10 made the usual one, the other stops being it', r.said === 'applied' && (await tax(taxA)).is_default === true && (await tax(usual.id)).is_default === false
      && (await q1(`select count(*)::int as n from taxes where tenant_id = $1 and is_default`, [tid])).n === 1, r.said);
    r = await one(...fx('tax-save', { name: 'Levy', rate_bp: 1000, type: 'included', is_default: false }));
    check('T11 saved again without the switch, it stays the usual one', r.said === 'applied' && (await tax(taxA)).is_default === true, r.said);
    const before = await q1(`select name, rate_bp from taxes where id = $1`, [theirTax]);
    r = await one(...fx('tax-save', { id: theirTax, name: 'Mine now' }));
    const after = await q1(`select name, rate_bp from taxes where id = $1`, [theirTax]);
    check('T12 another client\'s tax cannot be taken by its id', r.said === 'rejected:conflict' && after.name === before.name, r.said + ' ' + JSON.stringify(after));
    const pulled = ((await pull()).changes || {}).taxes || [];
    check('T13 a pull carries the tax', pulled.some((x) => x.id === taxA && x.name === 'Levy' && x.rate_bp === 1000 && x.is_default === true), String(pulled.length));
    r = await one('tax.save', { id: 'not-an-id', name: 'X', rate_bp: 100, type: 'added' });
    check('T14 an id that is not one is a bad payload', r.said === 'rejected:bad-payload', r.said);

    // ---- I: a product with everything the back office's sheet has ----
    const item = (i) => q1(`select name, price, sku, cost, brand, supplier_id, supplier_code, barcode, track_stock, category_id from items where id = $1`, [i]);
    const taxesOf = async (i) => (await all(`select tax_id from item_taxes where item_id = $1 and deleted_at is null`, [i])).map((x) => x.tax_id);
    const level = (i, st = store) => q1(`select reorder_point, reorder_qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, st, i]);
    r = await one(...fx('item-save-full'));
    row = await item(itemA);
    let lv = await level(itemA);
    check('I1 a new product with every field', r.said === 'applied' && r.data.created === true && row && row.sku === 'POLO-01' && Number(row.cost) === 17000 && row.brand === 'Maison'
      && row.supplier_id === sup && row.supplier_code === 'M-POLO' && row.barcode === '6091234500017' && row.category_id === cat, r.said + ' ' + JSON.stringify(row));
    check('I2 its tax is the one sent, and the only one', JSON.stringify(await taxesOf(itemA)) === JSON.stringify([taxA]), JSON.stringify(await taxesOf(itemA)));
    check('I3 its reorder level and order quantity, in the till\'s store', lv && lv.reorder_point === 3000 && lv.reorder_qty === 12000, JSON.stringify(lv));
    // the sheet as an older till sends it: none of the new keys
    const old = { id: itemA, name: 'Polo shirt', price: 45000, open_price: false, category_id: cat, barcode: '6091234500017', available: true };
    r = await one('item.save', old);
    row = await item(itemA); lv = await level(itemA);
    check('I4 an older till\'s save changes the price and none of them', r.said === 'applied' && Number(row.price) === 45000 && row.sku === 'POLO-01' && Number(row.cost) === 17000 && row.brand === 'Maison'
      && row.supplier_id === sup && row.supplier_code === 'M-POLO' && lv.reorder_point === 3000 && lv.reorder_qty === 12000
      && JSON.stringify(await taxesOf(itemA)) === JSON.stringify([taxA]), JSON.stringify(row));
    r = await one('item.save', { ...old, tax_id: usual.id });
    check('I5 its tax moved, and one tax is left on it', r.said === 'applied' && JSON.stringify(await taxesOf(itemA)) === JSON.stringify([usual.id]), JSON.stringify(await taxesOf(itemA)));
    r = await one('item.save', { ...old, tax_id: taxA });
    check('I6 and moved back onto the link it had', r.said === 'applied' && JSON.stringify(await taxesOf(itemA)) === JSON.stringify([taxA])
      && (await q1(`select count(*)::int as n from item_taxes where item_id = $1`, [itemA])).n === 2, JSON.stringify(await taxesOf(itemA)));
    r = await one('item.save', { ...old, tax_id: id() });
    const r3 = await one('item.save', { ...old, tax_id: theirTax });
    check('I7 a tax that is not the client\'s is refused, and the product keeps its own', r.said === 'rejected:bad-tax' && r3.said === 'rejected:bad-tax'
      && JSON.stringify(await taxesOf(itemA)) === JSON.stringify([taxA]), r.said + ' ' + r3.said);
    r = await one('item.save', { ...old, supplier_id: theirSup });
    check('I8 another client\'s supplier is refused', r.said === 'rejected:unknown-supplier' && (await item(itemA)).supplier_id === sup, r.said);
    r = await one('item.save', { ...old, reorder_point: 1000, reorder_qty: 2000 });
    const r4 = await one('item.save', { ...old, store_id: theirStore, reorder_point: 1000, reorder_qty: 2000 });
    check('I9 a reorder level needs a store of the client', r.said === 'rejected:bad-store' && r4.said === 'rejected:bad-store' && (await level(itemA)).reorder_point === 3000, r.said + ' ' + r4.said);
    r = await one('item.save', { ...old, store_id: store, reorder_point: -1, reorder_qty: 2000 });
    check('I10 a reorder level below nothing is refused', r.said === 'rejected:bad-quantity', r.said);
    const itemB = id();
    r = await one('item.save', { id: itemB, name: 'Other polo', price: 1000, open_price: false, category_id: '', barcode: '', available: true, sku: 'polo-01' });
    check('I11 a SKU another product has is refused', r.said === 'rejected:sku-taken' && !(await item(itemB)), r.said);

    // cost: only for someone who may see it
    r = await one('item.save', { ...old, cost: 99900, brand: 'Atelier' }, editor);
    row = await item(itemA);
    check('I12 an editor who may not see cost: the brand is saved, the cost left as it was', r.said === 'applied' && row.brand === 'Atelier' && Number(row.cost) === 17000, r.said + ' ' + JSON.stringify(row));
    r = await one('item.save', { ...old, cost: 18500, approved_by: buyer }, editor);
    check('I13 with the word of someone who may see cost, it is written', r.said === 'applied' && Number((await item(itemA)).cost) === 18500, r.said);
    r = await one('item.save', { ...old, cost: -5 });
    check('I14 a cost below nothing is a bad payload', r.said === 'rejected:bad-payload', r.said);
    r = await one(...fx('item-save-cleared'));
    row = await item(itemA); lv = await level(itemA);
    check('I15 emptied: no SKU, cost, brand, supplier or code, and no reorder figures', r.said === 'applied' && row.sku === null && row.cost === null && row.brand === null && row.supplier_id === null
      && row.supplier_code === null && lv.reorder_point === null && lv.reorder_qty === null && row.barcode === '6091234500017', JSON.stringify(row) + ' ' + JSON.stringify(lv));
    r = await one('item.save', { ...old, cost: 21000 }, cashier);
    check('I16 a cashier may not change a product at all', r.said === 'rejected:forbidden' && (await item(itemA)).cost === null, r.said);
    const itemC = id();
    r = await one('item.save', { id: itemC, name: 'Belt', price: 30000, open_price: false, category_id: cat, barcode: '', available: true });
    check('I17 a new product with no tax named gets the usual one', r.said === 'applied' && JSON.stringify(await taxesOf(itemC)) === JSON.stringify([taxA]), JSON.stringify(await taxesOf(itemC)));
    r = await one('item.save', { id: itemC, name: 'Belt', price: 30000, open_price: false, category_id: cat, barcode: '', available: true, tax_id: '' });
    check('I18 an empty tax leaves the product its own', r.said === 'applied' && JSON.stringify(await taxesOf(itemC)) === JSON.stringify([taxA]), JSON.stringify(await taxesOf(itemC)));
    const pi = ((await pull()).changes || {}).items || [];
    check('I19 a pull carries the supplier\'s code with the product', pi.some((x) => x.id === itemA && 'supplier_code' in x && 'sku' in x && 'cost' in x), String(pi.length));

    // ---- R: a restaurant's item ----
    const restoTax = id(), dish = id();
    r = await one('tax.save', { id: restoTax, name: 'No VAT', rate_bp: 0, type: 'included', is_default: false }, restoOwner, restoOwner, resto);
    check('R1 a restaurant adds a tax of nothing', r.said === 'applied' && (await tax(restoTax)).rate_bp === 0, r.said);
    const [type, payload] = fx('item-save-tax', {}, { 'item-1': dish, 'category-1': restoCat, 'tax-1': restoTax });
    r = await one(type, payload, restoOwner, restoOwner, resto);
    const dt = await taxesOf(dish);
    check('R2 its item is made with that tax', r.said === 'applied' && JSON.stringify(dt) === JSON.stringify([restoTax]), r.said + ' ' + JSON.stringify(dt));
    r = await one(type, { ...payload, tax_id: taxA }, restoOwner, restoOwner, resto);
    check('R3 and cannot take the shop\'s', r.said === 'rejected:bad-tax', r.said);
    void restoStore; void theirOwner;
  } finally {
    try { await c.query('ROLLBACK'); } catch {}
    for (const t of [tid, resto, other]) await devguard.cleanupTenant(c, t);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-OFFICE PASS' : `TILL-OFFICE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
