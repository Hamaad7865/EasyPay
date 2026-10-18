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
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','TO-Shop','premium'), ('${resto}','${resto}','TO-Resto','premium'), ('${other}','${other}','TO-Other','premium')`);
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

    // ---- S: roles and staff (0095) ----
    const roleA = id(), staffA = id();
    const sids = { 'role-1': roleA, 'staff-1': staffA };
    const sx = (name, over = {}) => { const fxt = fixture(name); return [fxt.type, { ...swap(fxt.payload, sids), ...over }]; };
    const roleRow = (x) => q1(`select name, permissions, deleted_at from roles where id = $1`, [x]);
    const manager = await emp(tid, 'Manager', await role(tid, 'Manager', ['employees.edit', 'items.edit']));
    r = await one(...sx('role-save'));
    row = await roleRow(roleA);
    check('S1 a role added with its ticks', r.said === 'applied' && r.data.created === true && row && row.name === 'Supervisor'
      && JSON.stringify(row.permissions) === JSON.stringify(['payment.take', 'sale.create', 'sale.refund']), r.said + ' ' + JSON.stringify(row));
    r = await one(...sx('role-save'));
    check('S2 the same again makes no second role', r.said === 'applied' && r.data.created === false
      && (await q1(`select count(*)::int as n from roles where tenant_id = $1 and name = 'Supervisor'`, [tid])).n === 1, r.said);
    // what the sheet did not offer is kept; what it offered and left unticked is taken off
    await c.query(`update roles set permissions = permissions || '["stock.count"]'::jsonb where id = $1`, [roleA]);
    r = await one(...sx('role-save', { name: 'Shift lead', permissions: ['sale.create', 'items.edit'] }));
    row = await roleRow(roleA);
    check('S3 its ticks changed: what was not offered is kept, what was unticked is gone', r.said === 'applied' && row.name === 'Shift lead'
      && JSON.stringify(row.permissions) === JSON.stringify(['items.edit', 'sale.create', 'stock.count']), JSON.stringify(row.permissions));
    r = await one(...sx('role-save', { name: 'Shift lead', permissions: ['*', 'sale.create'], offered: ['*', 'sale.create'] }));
    row = await roleRow(roleA);
    check("S4 the owner's star is never taken", r.said === 'applied' && !row.permissions.includes('*'), JSON.stringify(row.permissions));
    const ownerRole = (await q1(`select role_id from employees where id = $1`, [owner])).role_id;
    r = await one(...sx('role-save', { id: ownerRole, name: 'Boss' }));
    const r5 = await one(...sx('role-remove', { role_id: ownerRole }));
    check("S5 the owner's role cannot be changed or removed", r.said === 'rejected:owner-role' && r5.said === 'rejected:owner-role', r.said + ' ' + r5.said);
    r = await one(...sx('role-save', { id: id(), name: 'cashier' }));
    check('S6 a name another role has is refused', r.said === 'rejected:name-taken', r.said);
    r = await one(...sx('role-save', { name: ' ' }));
    check('S7 a role needs a name', r.said === 'rejected:name-required', r.said);
    r = await one(...sx('role-save', { id: id(), name: 'Sneaky' }), cashier);
    check('S8 a cashier may not', r.said === 'rejected:forbidden', r.said);
    r = await one(...sx('role-save', { id: id(), name: 'Floor' }), manager);
    check('S9 someone who manages staff may', r.said === 'applied', r.said);

    // a member of staff with no login
    await c.query(`insert into employees (id, tenant_id, name, role_id, pin_hash) values ($1,$2,'Ben',(select role_id from employees where id = $3),'x')`, [staffA, tid, cashier]);
    const person = (x) => q1(`select name, role_id, is_active from employees where id = $1`, [x]);
    r = await one(...sx('staff-update'));
    row = await person(staffA);
    check('S10 their name and their role changed', r.said === 'applied' && row.name === 'Benjamin' && row.role_id === roleA && row.is_active === true, r.said + ' ' + JSON.stringify(row));
    r = await one('staff.update', { employee_id: staffA, active: false });
    row = await person(staffA);
    check('S11 switched off, and nothing else touched', r.said === 'applied' && row.is_active === false && row.name === 'Benjamin' && row.role_id === roleA, JSON.stringify(row));
    r = await one('staff.update', { employee_id: staffA, role_id: id() });
    check('S12 a role that is not there is refused', r.said === 'rejected:bad-role', r.said);
    r = await one('staff.update', { employee_id: staffA, name: '  ' });
    check('S13 a name cannot be emptied', r.said === 'rejected:name-required', r.said);
    await c.query(`update employees set auth_user_id = gen_random_uuid() where id = $1`, [manager]);
    r = await one('staff.update', { employee_id: manager, active: false });
    check('S14 someone with a login is not changed from a till', r.said === 'rejected:has-login' && (await person(manager)).is_active === true, r.said);
    r = await one('staff.update', { employee_id: id(), name: 'Nobody' });
    check('S15 someone who is not there is refused', r.said === 'rejected:unknown-staff', r.said);
    r = await one(...sx('role-remove'));
    check('S16 a role staff still hold is not removed', r.said === 'rejected:role-in-use' && (await roleRow(roleA)).deleted_at === null, r.said);
    await c.query(`update employees set role_id = (select role_id from employees where id = $2) where id = $1`, [staffA, cashier]);
    r = await one(...sx('role-remove'));
    row = await roleRow(roleA);
    const again = await one(...sx('role-remove'));
    check('S17 removed, its name freed, and removed twice is done', r.said === 'applied' && row.deleted_at !== null && row.name.startsWith('Shift lead (removed ') && again.said === 'applied', r.said + ' ' + row.name);
    r = await one(...sx('role-save', { name: 'Shift lead' }));
    check('S18 a removed role is not brought back by a save that arrives late', r.said === 'rejected:bad-role', r.said);
    r = await one(...sx('role-save', { id: id(), name: 'Shift lead' }));
    check('S19 its name can be given to a new one', r.said === 'applied', r.said);
    const pr2 = ((await pull()).changes || {});
    check('S20 a pull carries the roles and the staff', (pr2.roles || []).some((x) => x.id === roleA && x.deleted_at) && (pr2.employees || []).some((x) => x.id === staffA && x.name === 'Benjamin' && x.is_active === false),
      String((pr2.roles || []).length));

    // ---- D: discounts (0095) ----
    const discA = id();
    const dx = (name, over = {}) => { const fxt = fixture(name); return [fxt.type, { ...swap(fxt.payload, { 'discount-1': discA }), ...over }]; };
    const disc = (x) => q1(`select name, type, value, requires_approval, deleted_at from discounts where id = $1`, [x]);
    r = await one(...dx('discount-save'));
    row = await disc(discA);
    check('D1 a discount added', r.said === 'applied' && r.data.created === true && row && row.name === 'Staff meal' && row.type === 'percent' && Number(row.value) === 20 && row.requires_approval === true, r.said + ' ' + JSON.stringify(row));
    r = await one(...dx('discount-save', { name: 'Loyal customer', type: 'amount', value: 5000, requires_approval: false }));
    row = await disc(discA);
    check('D2 changed to an amount', r.said === 'applied' && r.data.created === false && row.name === 'Loyal customer' && row.type === 'amount' && Number(row.value) === 5000 && row.requires_approval === false, JSON.stringify(row));
    const dbad = [];
    for (const over of [{ type: 'percent', value: 101 }, { type: 'percent', value: 0 }, { type: 'amount', value: 100000001 }]) dbad.push((await one(...dx('discount-save', over))).said);
    check('D3 a percentage over 100, nothing off, or an amount too large is refused', dbad.every((x) => x === 'rejected:bad-value'), dbad.join(' '));
    r = await one(...dx('discount-save', { name: '' }));
    const r6 = await one(...dx('discount-save', { type: 'half' }));
    check('D4 it needs a name, and a kind that is one of the two', r.said === 'rejected:name-required' && r6.said === 'rejected:bad-payload', r.said + ' ' + r6.said);
    r = await one(...dx('discount-save', { id: id(), name: 'loyal CUSTOMER' }));
    check('D5 a name another discount has is refused', r.said === 'rejected:name-taken', r.said);
    r = await one(...dx('discount-save', { id: id(), name: 'Cheeky' }), cashier);
    check('D6 a cashier may not', r.said === 'rejected:forbidden', r.said);
    r = await one(...dx('discount-remove'));
    row = await disc(discA);
    const dagain = await one(...dx('discount-remove'));
    check('D7 removed, its name freed, and removed twice is done', r.said === 'applied' && row.deleted_at !== null && row.name.startsWith('Loyal customer (removed ') && dagain.said === 'applied', r.said + ' ' + row.name);
    r = await one(...dx('discount-save', { name: 'Loyal customer' }));
    const r7 = await one(...dx('discount-remove', { discount_id: id() }));
    check('D8 a removed one is not brought back, and one that never was is refused', r.said === 'rejected:bad-discount' && r7.said === 'rejected:bad-discount', r.said + ' ' + r7.said);
    const pd = ((await pull()).changes || {}).discounts || [];
    check('D9 a pull carries the discount, removed', pd.some((x) => x.id === discA && x.deleted_at), String(pd.length));

    // ---- A: add-on groups, and the items that carry them (0096). A restaurant's. ----
    const grpA = id(), chA = id(), chB = id(), dishA = id();
    const aids = { 'group-1': grpA, 'choice-1': chA, 'choice-2': chB, 'item-1': dishA, 'category-1': restoCat };
    const ax = (name, over = {}) => { const fxt = fixture(name); return [fxt.type, { ...swap(fxt.payload, aids), ...over }]; };
    const rone = (type, payload, who) => one(type, payload, who || restoOwner, restoOwner, resto);
    const grp = (x) => q1(`select name, min_select, max_select, deleted_at from modifier_groups where id = $1`, [x]);
    const choices = async (x) => (await all(`select id, name, price from modifiers where group_id = $1 and deleted_at is null order by name`, [x])).map((m) => m.name + ':' + Number(m.price));
    r = await rone(...ax('addon-save'));
    row = await grp(grpA);
    check('A1 a group added with its choices', r.said === 'applied' && r.data.created === true && row && row.name === 'Extras' && row.min_select === 0 && row.max_select === 2
      && JSON.stringify(await choices(grpA)) === JSON.stringify(['Cheese:2500', 'Chilli:0']), r.said + ' ' + JSON.stringify(await choices(grpA)));
    r = await rone(...ax('addon-save'));
    check('A2 the same again makes nothing twice', r.said === 'applied' && r.data.created === false && (await q1(`select count(*)::int as n from modifiers where group_id = $1`, [grpA])).n === 2, r.said);
    const chC = id();
    r = await rone(...ax('addon-save', { name: 'Toppings', min: 1, max: 3, choices: [{ id: chA, name: 'Cheddar', price: 3000 }, { id: chC, name: 'Egg', price: 1500 }] }));
    row = await grp(grpA);
    check('A3 changed: a choice renamed, one dropped, one added', r.said === 'applied' && row.name === 'Toppings' && row.min_select === 1 && row.max_select === 3
      && JSON.stringify(await choices(grpA)) === JSON.stringify(['Cheddar:3000', 'Egg:1500']), JSON.stringify(await choices(grpA)));
    // a choice picked alone (0106), such as All among the sauces
    {
      const alone = async (x) => (await q1(`select alone from modifiers where id = $1`, [x])).alone;
      const toppings = (a, c) => rone(...ax('addon-save', { name: 'Toppings', min: 1, max: 3, choices: [{ id: chA, name: 'Cheddar', price: 3000, ...a }, { id: chC, name: 'Egg', price: 1500, ...c }] }));
      r = await toppings({ alone: true }, { alone: false });
      const marked = [await alone(chA), await alone(chC)];
      await toppings({}, {});
      const kept = await alone(chA);
      await toppings({ alone: false }, {});
      check('A3b a choice is marked to be picked alone, a till that says nothing of it leaves it, and it is unmarked when told',
        r.said === 'applied' && marked[0] === true && marked[1] === false && kept === true && (await alone(chA)) === false, r.said + ' ' + JSON.stringify(marked) + ' ' + kept);
    }
    // a choice taken several times (0108): Eggs up to five, Mayo one or none
    {
      const most = async (x) => (await q1(`select max_qty from modifiers where id = $1`, [x])).max_qty;
      const toppings = (a, c) => rone(...ax('addon-save', { name: 'Toppings', min: 1, max: 3, choices: [{ id: chA, name: 'Cheddar', price: 3000, ...a }, { id: chC, name: 'Egg', price: 1500, ...c }] }));
      const before = [await most(chA), await most(chC)];
      r = await toppings({}, { max_qty: 5 });
      const marked = [await most(chA), await most(chC)];
      await toppings({}, {});
      const kept = await most(chC);
      await toppings({}, { max_qty: 1 });
      check('A3c a choice is one or none until it is marked, a till that says nothing of it leaves its number, and it is one again when told',
        r.said === 'applied' && before.join() === '1,1' && marked.join() === '1,5' && kept === 5 && (await most(chC)) === 1, r.said + ' ' + before + ' ' + marked + ' ' + kept);
      const none = await toppings({}, { max_qty: 0 });
      const many = await toppings({}, { max_qty: 100 });
      check('A3c a number that is not from 1 to 99 is refused', none.said === 'rejected:bad-payload' && many.said === 'rejected:bad-payload' && (await most(chC)) === 1, none.said + ' ' + many.said);
      const pm = (((await pull(restoStore, resto)).changes || {}).modifiers || []).find((x) => x.id === chC);
      check('A3c a pull hands the number out', !!pm && pm.max_qty === 1, JSON.stringify(pm && pm.max_qty));
    }
    r = await rone(...ax('addon-save', { min: 3, max: 2 }));
    const a4 = await rone(...ax('addon-save', { max: 21 }));
    check('A4 the most cannot be less than the fewest, nor more than 20', r.said === 'rejected:bad-limits' && a4.said === 'rejected:bad-limits', r.said + ' ' + a4.said);
    r = await rone(...ax('addon-save', { name: ' ' }));
    const a5 = await rone(...ax('addon-save', { choices: [{ id: id(), name: '', price: 0 }] }));
    check('A5 a group and each choice need a name', r.said === 'rejected:name-required' && a5.said === 'rejected:name-required', r.said + ' ' + a5.said);
    r = await rone(...ax('addon-save', { id: id(), name: 'toppings', choices: [] }));
    check('A6 a name another group has is refused', r.said === 'rejected:name-taken', r.said);
    // a cashier of the restaurant
    const restoCashier = await emp(resto, 'Waiter', await role(resto, 'Waiter', ['sale.create']));
    r = await rone(...ax('addon-save', { id: id(), name: 'Sauces', choices: [] }), restoCashier);
    check('A7 a waiter may not', r.said === 'rejected:forbidden', r.said);

    // an item that carries the group
    r = await rone(...ax('item-save-groups'));
    const linked = async (i) => (await all(`select group_id from item_modifier_groups where item_id = $1 and deleted_at is null`, [i])).map((x) => x.group_id);
    check('A8 a new item made with its add-on group', r.said === 'applied' && JSON.stringify(await linked(dishA)) === JSON.stringify([grpA]), r.said + ' ' + JSON.stringify(await linked(dishA)));
    const grpB = id();
    await rone('addon.save', { id: grpB, name: 'Cooking', min: 1, max: 1, choices: [{ id: id(), name: 'Rare', price: 0 }, { id: id(), name: 'Well done', price: 0 }] });
    const [it, itemPayload] = ax('item-save-groups');
    r = await rone(it, { ...itemPayload, groups: [grpB] });
    check('A9 its groups changed: the other taken off', r.said === 'applied' && JSON.stringify(await linked(dishA)) === JSON.stringify([grpB]), JSON.stringify(await linked(dishA)));
    r = await rone(it, { ...itemPayload, groups: [grpA, grpB] });
    check('A10 both, the first put back on the link it had', r.said === 'applied' && (await linked(dishA)).length === 2
      && (await q1(`select count(*)::int as n from item_modifier_groups where item_id = $1`, [dishA])).n === 2, JSON.stringify(await linked(dishA)));
    const noGroups = { ...itemPayload }; delete noGroups.groups;
    r = await rone(it, noGroups);
    check('A11 a save that names no groups leaves them', r.said === 'applied' && (await linked(dishA)).length === 2, JSON.stringify(await linked(dishA)));
    r = await rone(it, { ...itemPayload, groups: [id()] });
    check('A12 a group that is not there is refused, and the item keeps its own', r.said === 'rejected:bad-group' && (await linked(dishA)).length === 2, r.said);
    r = await rone(...ax('addon-remove'));
    row = await grp(grpA);
    const a13 = await rone(...ax('addon-remove'));
    check('A13 removed: off its items, its choices gone, its name freed; removed twice is done', r.said === 'applied' && row.deleted_at !== null && row.name.startsWith('Toppings (removed ')
      && (await choices(grpA)).length === 0 && JSON.stringify(await linked(dishA)) === JSON.stringify([grpB]) && a13.said === 'applied', r.said + ' ' + row.name);
    r = await rone(...ax('addon-save'));
    const a14 = await rone(...ax('addon-remove', { group_id: id() }));
    check('A14 a removed group is not brought back, and one that never was is refused', r.said === 'rejected:bad-group' && a14.said === 'rejected:bad-group', r.said + ' ' + a14.said);
    r = await rone(it, { ...itemPayload, groups: [] });
    check('A15 emptied: the item carries none', r.said === 'applied' && (await linked(dishA)).length === 0, JSON.stringify(await linked(dishA)));
    const pa = ((await pull(restoStore, resto)).changes || {});
    check('A16 a pull carries the groups, the choices and the links', (pa.modifier_groups || []).some((x) => x.id === grpB) && (pa.modifiers || []).some((x) => x.group_id === grpB)
      && (pa.item_modifier_groups || []).some((x) => x.item_id === dishA), String((pa.modifier_groups || []).length));

    // ---- Z: the receipt's notes and the service charge (0096) ----
    const settings = async (t) => (await q1(`select data from pos_settings where tenant_id = $1`, [t])).data;
    await c.query(`update pos_settings set data = data || '{"receipt":{"header":"Old","footer":"Old foot","logo":"data:image/png;base64,AAAA","showLogo":false},"quickPay":"cash"}'::jsonb where tenant_id = $1`, [resto]);
    r = await rone(...ax('settings-save'));
    let st = await settings(resto);
    check('Z1 the two notes and the service charge saved; the logo and the rest left', r.said === 'applied' && st.receipt.header === 'Open every day, 9 to 9' && st.receipt.footer === 'Thank you. See you again soon.'
      && st.receipt.logo === 'data:image/png;base64,AAAA' && st.receipt.showLogo === false && st.servicePct === 10 && st.quickPay === 'cash', JSON.stringify(st.receipt) + ' ' + st.servicePct);
    // a shop's deposits (0113): the sample a tablet working alone answers itself too (LocalAnswersTest)
    r = await rone(...ax('settings-save-deposits'));
    st = await settings(resto);
    check('Z1b the six deposit settings saved; the notes and the service charge left', r.said === 'applied' && st.deposits === 'on' && st.depositCancel === 'keep' && st.depositDays === 45
      && st.depositOverdue === 'cancel' && st.depositGrace === 3 && st.depositCustomer === 'optional' && st.servicePct === 10 && st.receipt.header === 'Open every day, 9 to 9', JSON.stringify(st));
    // a shop's customer accounts (0114): the sample a tablet working alone answers itself too
    r = await rone(...ax('settings-save-accounts'));
    st = await settings(resto);
    check('Z1c the two account settings saved; the deposits left', r.said === 'applied' && st.accounts === 'off' && st.accountDays === 45 && st.depositDays === 45, JSON.stringify(st));
    r = await rone('settings.save', { servicePct: 31 });
    const z2 = await rone('settings.save', { servicePct: -1 });
    check('Z2 a service charge over 30 % or below nothing is refused', r.said === 'rejected:bad-value' && z2.said === 'rejected:bad-value' && (await settings(resto)).servicePct === 10, r.said + ' ' + z2.said);
    r = await rone('settings.save', { receipt: { footer: 'x'.repeat(400) } });
    st = await settings(resto);
    check('Z3 one note alone, cut to 300; the other stays', r.said === 'applied' && st.receipt.footer.length === 300 && st.receipt.header === 'Open every day, 9 to 9', String(st.receipt.footer.length));
    // the notes offered when an item is added (0108): the list whole
    r = await rone('settings.save', { kitchenNotes: [' Sans piment ', '', 7, 'Rush', 'x'.repeat(60)] });
    st = await settings(resto);
    check('Z8 the kitchen notes saved: trimmed, forty letters, what is empty or not words left out; the rest of the settings left',
      r.said === 'applied' && JSON.stringify(st.kitchenNotes) === JSON.stringify(['Sans piment', 'Rush', 'x'.repeat(40)]) && st.servicePct === 10 && st.receipt.header === 'Open every day, 9 to 9', JSON.stringify(st.kitchenNotes));
    r = await rone('settings.save', { kitchenNotes: Array.from({ length: 20 }, (_, i) => 'n' + i) });
    const z6 = await rone('settings.save', { kitchenNotes: 'Rush' });
    check('Z9 twelve notes at most, and what is not a list is refused', r.said === 'applied' && (await settings(resto)).kitchenNotes.length === 12 && z6.said === 'rejected:bad-payload', r.said + ' ' + z6.said);
    r = await rone('settings.save', { kitchenNotes: [] });
    const z7 = await rone('settings.save', { kitchenNotes: ['Rush'] }, restoCashier);
    st = await settings(resto);
    check('Z10 a list saved empty stays empty, and a waiter may not change it', r.said === 'applied' && Array.isArray(st.kitchenNotes) && st.kitchenNotes.length === 0 && z7.said === 'rejected:forbidden', r.said + ' ' + z7.said);
    // the minutes before an order for later is due (0111): 0 to 120, 0 is off
    r = await rone(...ax('settings-save-due'));
    const z11 = await rone('settings.save', { dueReminderMinutes: 121 });
    const z12 = await rone('settings.save', { dueReminderMinutes: 'ten' });
    st = await settings(resto);
    check('Z11 the reminder before an order is due saved, 0 to 120; the rest of the settings left',
      r.said === 'applied' && st.dueReminderMinutes === 10 && st.servicePct === 10 && z11.said === 'rejected:bad-payload' && z12.said === 'rejected:bad-payload',
      r.said + ' ' + z11.said + ' ' + z12.said);
    r = await rone('settings.save', { servicePct: 0 }, restoCashier);
    check('Z4 a waiter may not', r.said === 'rejected:forbidden' && (await settings(resto)).servicePct === 10, r.said);
    r = await rone('settings.save', { something: 'else' });
    check('Z5 a key that is not one of these changes nothing', r.said === 'applied' && r.data.saved === 0, r.said + ' ' + JSON.stringify(r.data));

    // ---- V: a product's variants (0097). A shop's. ----
    const polo = id(), v1 = id(), v2 = id(), v3 = id(), v4 = id();
    await c.query(`insert into items (id, tenant_id, name, price, cost, track_stock) values ($1,$2,'Polo',49900,17000,true)`, [polo, tid]);
    const vids = { 'item-1': polo, 'variant-1': v1, 'variant-2': v2, 'variant-3': v3, 'variant-4': v4 };
    const vx = (name, over = {}) => { const fxt = fixture(name); return [fxt.type, { ...swap(fxt.payload, vids), ...over }]; };
    const lines = async (i) => (await all(`select id, name, price, cost, sku, barcode from item_variants where item_id = $1 and deleted_at is null order by name`, [i]));
    r = await one(...vx('variants-make'));
    let ls = await lines(polo);
    check('V1 four lines made under the tablet\'s ids, at the product\'s price and cost', r.said === 'applied' && r.data.created === 4 && ls.length === 4
      && ls.map((x) => x.name).join('|') === 'M / Navy|M / White|S / Navy|S / White' && ls.every((x) => Number(x.price) === 49900 && Number(x.cost) === 17000)
      && ls.find((x) => x.name === 'S / White').id === v1, r.said + ' ' + JSON.stringify(ls.map((x) => x.name)));
    check('V2 the product carries its options', JSON.stringify((await q1(`select option_names from items where id = $1`, [polo])).option_names) === JSON.stringify(['Size', 'Colour']));
    r = await one(...vx('variants-make'));
    check('V3 the same again makes nothing more', r.said === 'applied' && r.data.created === 0 && r.data.existing === 4 && (await lines(polo)).length === 4, r.said + ' ' + JSON.stringify(r.data));
    const v5 = id(), v6 = id();
    r = await one('variants.make', { item_id: polo, names: ['Size', 'Colour'], lines: [{ id: v5, values: ['L', 'White'] }, { id: v6, values: ['L', 'Navy'] }, { id: id(), values: ['s', 'white'] }] });
    check('V4 a size added later makes its lines only', r.said === 'applied' && r.data.created === 2 && r.data.existing === 1 && (await lines(polo)).length === 6, JSON.stringify(r.data));
    r = await one('variants.make', { item_id: polo, names: ['Size'], lines: [{ id: id(), values: ['XL'] }] });
    const vb = await one('variants.make', { item_id: polo, names: ['Size', 'size'], lines: [{ id: id(), values: ['XL', 'x'] }] });
    const vc = await one('variants.make', { item_id: polo, names: ['Size', 'Colour'], lines: [{ id: id(), values: ['XL'] }] });
    const vd = await one('variants.make', { item_id: polo, names: ['Size', 'Colour'], lines: [{ id: id(), values: ['XL', 'Red'] }, { id: id(), values: ['xl', 'red'] }] });
    check('V5 another number of options, an option named twice, a line short of a value, a line twice: refused', [r, vb, vc, vd].every((x) => x.said === 'rejected:bad-options'), [r, vb, vc, vd].map((x) => x.said).join(' '));
    const stocked = id();
    await c.query(`insert into items (id, tenant_id, name, price, track_stock) values ($1,$2,'Stocked',1000,true)`, [stocked, tid]);
    await c.query(`select stock_move($1,$2,$3,null,5000,'receive',1000,'delivery',$4,$5,null)`, [tid, store, stocked, id(), owner]);
    r = await one('variants.make', { item_id: stocked, names: ['Size'], lines: [{ id: id(), values: ['S'] }] });
    check('V6 a product with stock of its own is not given variants', r.said === 'rejected:has-stock', r.said);
    r = await one('variants.make', { item_id: id(), names: ['Size'], lines: [{ id: id(), values: ['S'] }] });
    const ve = await one(...vx('variants-make'), cashier);
    check('V7 a product that is not there, and a cashier, are refused', r.said === 'rejected:unknown-item' && ve.said === 'rejected:forbidden', r.said + ' ' + ve.said);

    r = await one(...vx('variants-save'));
    let line1 = (await lines(polo)).find((x) => x.id === v1);
    check('V8 a line\'s barcode, SKU and cost saved', r.said === 'applied' && line1.barcode === '6091234500024' && line1.sku === 'POLO-S-WH' && Number(line1.cost) === 17500, r.said + ' ' + JSON.stringify(line1));
    r = await one('variants.save', { item_id: polo, lines: [{ id: v1, sku: 'POLO-S-WH', barcode: '6091234500024', cost: 99900 }] }, editor);
    line1 = (await lines(polo)).find((x) => x.id === v1);
    check('V9 from someone who may not see cost, the cost is left as it was', r.said === 'applied' && Number(line1.cost) === 17500, JSON.stringify(line1));
    r = await one('variants.save', { item_id: polo, lines: [{ id: v2, barcode: '6091234500024' }] });
    const vf = await one('variants.save', { item_id: polo, lines: [{ id: v2, sku: 'polo-s-wh' }] });
    check('V10 a barcode or a SKU another line has is refused', r.said === 'rejected:barcode-taken' && vf.said === 'rejected:sku-taken', r.said + ' ' + vf.said);
    r = await one('variants.save', { item_id: polo, lines: [{ id: id(), sku: 'X' }] });
    check('V11 a line that is not the product\'s is refused', r.said === 'rejected:unknown-variant', r.said);
    r = await one('variants.save', { item_id: polo, lines: [{ id: v1, barcode: '', sku: '' }] });
    line1 = (await lines(polo)).find((x) => x.id === v1);
    check('V12 emptied: no barcode, no SKU, its cost untouched', r.said === 'applied' && line1.barcode === null && line1.sku === null && Number(line1.cost) === 17500, JSON.stringify(line1));

    await c.query(`select stock_move($1,$2,$3,$4,3000,'receive',17000,'delivery',$5,$6,null)`, [tid, store, polo, v2, id(), owner]);
    r = await one('variant.remove', { variant_id: v2 });
    check('V13 a line that holds stock is not removed', r.said === 'rejected:has-stock' && (await lines(polo)).length === 6, r.said);
    r = await one(...vx('variant-remove'));
    const vg = await one(...vx('variant-remove'));
    const vh = await one('variant.remove', { variant_id: id() });
    check('V14 a line removed; removed twice is done; one that never was is refused', r.said === 'applied' && (await lines(polo)).length === 5 && vg.said === 'applied' && vh.said === 'rejected:unknown-variant', r.said + ' ' + vg.said + ' ' + vh.said);
    const pv = ((await pull()).changes || {}).item_variants || [];
    check('V15 a pull carries the lines, the removed one too', pv.some((x) => x.id === v5 && !x.deleted_at) && pv.some((x) => x.id === v1 && x.deleted_at), String(pv.length));

    // ---- P: which printers a category's orders print on (0098). A restaurant's. ----
    const counter = id(), kitchen = id(), grill = id();
    const prn = (pid, name, addr) => ({ id: pid, store_id: restoStore, name, kind: 'network', address: addr, paper_mm: 80 });
    r = await rone('printer.save', prn(counter, 'Counter', '192.168.1.50'));
    const p2 = await rone('printer.save', prn(kitchen, 'Kitchen', '192.168.1.51'));
    const pr = await all(`select name, is_receipt from printers where tenant_id = $1 and deleted_at is null order by sort_order`, [resto]);
    check('P1 a second printer added from the till: the first prints the receipts, the second does not', r.said === 'applied' && p2.said === 'applied'
      && pr.length === 2 && pr[0].is_receipt === true && pr[1].is_receipt === false, JSON.stringify(pr));
    const cx = (over = {}) => { const fxt = fixture('category-save-printers'); return [fxt.type, { ...swap(fxt.payload, { 'category-1': grill, 'printer-1': kitchen }), ...over }]; };
    const ticked = async (x) => (await q1(`select printer_ids::text[] as ids from categories where id = $1`, [x])).ids;
    r = await rone(...cx());
    check('P2 a new category that prints in the kitchen', r.said === 'applied' && JSON.stringify(await ticked(grill)) === JSON.stringify([kitchen]), r.said + ' ' + JSON.stringify(await ticked(grill)));
    r = await rone(...cx({ printer_ids: [kitchen, counter, id(), theirStore] }));
    check('P3 both printers; one that is not the client\'s, or is no printer, is left out', r.said === 'applied' && JSON.stringify((await ticked(grill)).sort()) === JSON.stringify([counter, kitchen].sort()), JSON.stringify(await ticked(grill)));
    r = await rone('category.save', { id: grill, name: 'Grill and BBQ', color: '' });
    check('P4 a save that names no printers leaves them', r.said === 'applied' && (await ticked(grill)).length === 2 && (await q1(`select name from categories where id = $1`, [grill])).name === 'Grill and BBQ', JSON.stringify(await ticked(grill)));
    r = await rone(...cx({ printer_ids: [] }));
    check('P5 emptied: it prints nowhere of its own', r.said === 'applied' && (await ticked(grill)).length === 0, JSON.stringify(await ticked(grill)));
    r = await rone(...cx({ printer_ids: 'kitchen' }));
    const p6 = await rone(...cx({ printer_ids: ['not-an-id'] }));
    check('P6 printers that are not a list of ids are a bad payload', r.said === 'rejected:bad-payload' && p6.said === 'rejected:bad-payload', r.said + ' ' + p6.said);
    await rone(...cx());
    const pc = ((await pull(restoStore, resto)).changes || {}).categories || [];
    check('P7 a pull carries the category with its printer', pc.some((x) => x.id === grill && JSON.stringify(x.printer_ids) === JSON.stringify([kitchen])), String(pc.length));
    void restoStore; void theirOwner;
  } finally {
    try { await c.query('ROLLBACK'); } catch {}
    for (const t of [tid, resto, other]) await devguard.cleanupTenant(c, t);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-OFFICE PASS' : `TILL-OFFICE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
