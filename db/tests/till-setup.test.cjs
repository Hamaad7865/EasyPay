// till-setup.test.cjs — migration 0089: what a tablet sets up on its first
// run. The owner asked for "an onboarding flow for POS right after sign in
// for the first time", on the tablet, covering tables, the printer, staff and
// PINs and the business's details. Until now each was the back office's only.
//   - tables.add adds the tables of a new room and changes none. A room sent
//     twice adds nothing; a name is a table's own in the whole store.
//   - printer.save makes a printer or changes how it is reached. The first
//     printer of a store prints its receipts. A kitchen screen is the back
//     office's.
//   - company.save writes what Company details writes: tenants and the
//     settings the tills read.
//   - staff.save adds a member of staff with no login; staff.set_pin sets a
//     PIN. Both take the hash, never the PIN, and only the owner may.
//   - setup.finish marks the set-up done for every tablet of the business.
//   - A client made in /admin starts with its set-up open; one from before has
//     no mark and is never shown it.
//   - A BRN or VAT number typed in /admin reaches the settings, which a till
//     is sent; tenants, where it was kept alone, is in no pull.
// Usage: node db/tests/till-setup.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });
// what web/lib/pin.ts makes of 1234 with a salt of sixteen bytes of 7
const H = 'pbkdf2-sha256$20000$BwcHBwcHBwcHBwcHBwcHBw==$e9J4dc709SPTq5CLB1eFvtyPhs9JnBATLVf107XfVaI=';
// the tables of a room, ten to a row on the 100 by 60 plan
const room = (names) => names.map((name, i) => ({
  id: crypto.randomUUID(), name: String(name), seats: 4, shape: 'square', x: 2 + 10 * (i % 10), y: 2 + 10 * Math.floor(i / 10), w: 8, h: 8,
}));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID(), other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // premium, so that a kitchen screen can stand in one of its stores
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','SU-Probe','premium'), ('${other}','${other}','SU-Other','standard')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SUS1') returning id`)).id;
    const second = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Annex','SUS3') returning id`)).id;
    const theirStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','SUS2') returning id`)).id;
    const role = async (t, name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [t, name, JSON.stringify(perms)])).id;
    const emp = async (t, name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [t, name, r])).id;
    const owner = await emp(tid, 'Owner', await role(tid, 'Owner', ['*'])); // the till's login
    const manager = await emp(tid, 'Manager', await role(tid, 'Manager', ['settings.device', 'items.edit']));
    const cashierRole = await role(tid, 'Cashier', ['sale.create', 'payment.take', 'shift.open_close']);
    const cashier = await emp(tid, 'Cashier', cashierRole);
    const theirRole = await role(other, 'Owner', ['*']);
    const theirOwner = await emp(other, 'Their owner', theirRole);
    await c.query(`select ensure_pos_basics('${tid}')`);
    await c.query(`select ensure_pos_basics('${other}')`);
    await c.query(`update pos_settings set data = data || '{"setup":"open"}'::jsonb where tenant_id = $1`, [tid]);

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const pushAs = (login, ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    // one op, sent under the owner's login unless another is named
    const one = async (o, login = owner) => { const r = await pushAs(login, [o]); return { said: tag(r[0]), data: r[0].data }; };
    const pull = () => asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);
    const tablesOf = async (s) => (await c.query(`select id, name, area, seats, sort_order from tables where store_id = $1 and deleted_at is null order by sort_order`, [s])).rows;
    const settings = async (t = tid) => (await q1(`select data from pos_settings where tenant_id = $1`, [t])).data;
    const tenant = (t = tid) => q1(`select name, brn, vat_number from tenants where id = $1`, [t]);
    const printer = (id) => q1(`select name, kind, address, paper_mm, is_receipt, feed_lines, cut, is_active, sort_order, store_id, deleted_at from printers where id = $1`, [id]);
    const person = (id) => q1(`select name, role_id, pin_hash, auth_user_id, is_active, tenant_id from employees where id = $1`, [id]);

    // ---- tables ----
    const main = room(range(1, 12));
    const t1 = await one(op('tables.add', { store_id: store, area: 'Main', tables: main }));
    let rows = await tablesOf(store);
    check('T1 a room of twelve is added from a till', t1.said === 'applied' && rows.length === 12 && rows.every((r) => r.area === 'Main' && r.seats === 4), t1.said + ' ' + rows.length);
    check('T1 the till is told how many', !!t1.data && t1.data.added === 12, JSON.stringify(t1.data));
    check('T1 in the order they were sent', rows.map((r) => r.sort_order).join() === range(0, 11).join() && rows[0].name === '1' && rows[11].name === '12', rows.map((r) => r.sort_order).join());

    const terrace = room(range(13, 18));
    const t2 = await one(op('tables.add', { store_id: store, area: 'Terrace', tables: terrace }));
    rows = await tablesOf(store);
    check('T2 a second room goes after the first', t2.said === 'applied' && rows.length === 18 && rows[12].name === '13' && rows[12].sort_order === 12 && rows[17].area === 'Terrace', t2.said + ' ' + rows.length);

    const t3 = await one(op('tables.add', { store_id: store, area: 'Terrace', tables: terrace }));
    check('T3 the same room sent again adds nothing', t3.said === 'applied' && t3.data.added === 0 && (await tablesOf(store)).length === 18, t3.said + ' ' + JSON.stringify(t3.data));

    const still = async (name, o, code, login) => {
      const r = await one(o, login);
      check(name, r.said === 'rejected:' + code && (await tablesOf(store)).length === 18, r.said);
    };
    const add = (area, tables, extra = {}, who) => op('tables.add', { store_id: store, area, tables, ...extra }, who);
    await still('T4 a room the store has cannot be added again, whatever the capitals', add('main', room(['90', '91'])), 'room-exists');
    await still('T4 a number in use is refused', add('Bar', room(['7'])), 'name-taken');
    await still('T4 two tables of one name are refused', add('Bar', room(['A', 'a'])), 'name-taken');
    await still('T4 no tables is not a room', add('Bar', []), 'bad-payload');
    await still('T4 sixty is the most at once', add('Bar', room(range(101, 161))), 'bad-payload');
    const bad = (change) => add('Bar', room(['90']).map((t) => ({ ...t, ...change })));
    await still('T4 a table narrower than four', bad({ w: 3 }), 'bad-payload');
    await still('T4 a table that leaves the plan', bad({ x: 95 }), 'bad-payload');
    await still('T4 a table with no seat', bad({ seats: 0 }), 'bad-payload');
    await still('T4 a shape that is neither', bad({ shape: 'star' }), 'bad-payload');
    await still('T4 a table with no name', bad({ name: '   ' }), 'bad-payload');
    await still('T4 a room with no name', add('  ', room(['90'])), 'bad-payload');
    await still("T4 another client's store", op('tables.add', { store_id: theirStore, area: 'Bar', tables: room(['90']) }), 'bad-store');
    const theirTable = (await q1(`insert into tables (tenant_id, store_id, name, area) values ($1,$2,'T9','Main') returning id`, [other, theirStore])).id;
    await still("T4 another client's table is not taken over", add('Bar', room(['90']).map((t) => ({ ...t, id: theirTable }))), 'conflict');
    check('T4 and theirs is as it was', (await q1(`select name from tables where id = $1`, [theirTable])).name === 'T9');
    await still('T4 someone who may only sell is refused', add('Bar', room(['90']), {}, cashier), 'forbidden');
    const t4 = await one(add('Bar', room(['90']), { approved_by: manager }, cashier));
    check('T4 with the approval of someone who may, it is added', t4.said === 'applied' && (await tablesOf(store)).length === 19, t4.said);
    await c.query(`update tables set deleted_at = now() where store_id = $1 and area = 'Bar'`, [store]);

    const p1 = await pull();
    const pulled = (p1.changes.tables || []).filter((t) => !t.deleted_at);
    check('T6 a till is sent the tables in its next pull', pulled.length === 18 && pulled.some((t) => t.name === '18' && t.area === 'Terrace'), String(pulled.length));

    // ---- the printer ----
    const receipt = crypto.randomUUID();
    const pr1 = await one(op('printer.save', { id: receipt, store_id: store, name: '  Receipt ', kind: 'network', address: '192.168.1.50', paper_mm: 80, one_printer: true }));
    let p = await printer(receipt);
    check('P1 a printer is made from a till', pr1.said === 'applied' && !!p && p.name === 'Receipt' && p.kind === 'network' && p.address === '192.168.1.50' && p.paper_mm === 80, pr1.said + ' ' + JSON.stringify(p));
    check("P1 the store's first printer prints its receipts, as one made in the back office", !!p && p.is_receipt === true && p.feed_lines === 3 && p.cut === true && p.is_active === true, JSON.stringify(p));
    check('P1 the till is told so', !!pr1.data && pr1.data.created === true && pr1.data.receipt === true, JSON.stringify(pr1.data));
    let s = await settings();
    check('P1 one printer for everything is switched on, and nothing else in the settings is touched', s.onePrinter === true && s.setup === 'open', JSON.stringify(s));

    const blue = crypto.randomUUID();
    const pr2 = await one(op('printer.save', { id: blue, store_id: store, name: 'Bar', kind: 'bluetooth', address: 'MPT-II', paper_mm: 58 }));
    p = await printer(blue);
    check('P2 a second printer does not take the receipts', pr2.said === 'applied' && p.is_receipt === false && p.kind === 'bluetooth' && p.address === 'MPT-II' && p.paper_mm === 58 && pr2.data.receipt === false, pr2.said + ' ' + JSON.stringify(p));
    check('P2 a till that does not say leaves the switch as it was', (await settings()).onePrinter === true);

    const before = await printer(receipt);
    const pr3 = await one(op('printer.save', { id: receipt, store_id: store, name: 'Counter', kind: 'usb', address: 'whatever', paper_mm: 80, one_printer: false }));
    p = await printer(receipt);
    check('P3 a printer is changed: its name and how it is reached', pr3.said === 'applied' && p.name === 'Counter' && p.kind === 'usb' && p.address === null && pr3.data.created === false, pr3.said + ' ' + JSON.stringify(p));
    check('P3 its receipts, its place and whether it is on are as they were', p.is_receipt === true && p.sort_order === before.sort_order && p.is_active === true && p.feed_lines === 3 && p.cut === true, JSON.stringify(p));
    check('P3 and the switch is switched off', (await settings()).onePrinter === false);

    const count = async () => (await q1(`select count(*)::int as n from printers where tenant_id = $1 and deleted_at is null`, [tid])).n;
    const had = await count();
    const noPrinter = async (name, payload, code, who, login) => {
      const r = await one(op('printer.save', { id: crypto.randomUUID(), store_id: store, name: 'Kitchen', kind: 'network', address: '192.168.1.51', paper_mm: 80, ...payload }, who), login);
      check(name, r.said === 'rejected:' + code && (await count()) === had, r.said);
    };
    await noPrinter('P4 a printer with no name', { name: '  ' }, 'name-required');
    await noPrinter('P4 a network printer needs an IP address', { address: 'printer.local' }, 'bad-address');
    await noPrinter('P4 and not none', { address: '' }, 'bad-address');
    await noPrinter('P4 a Bluetooth printer needs a name or an address', { kind: 'bluetooth', address: '' }, 'bad-address');
    await noPrinter('P4 which an IP address is not', { kind: 'bluetooth', address: '192.168.1.9' }, 'bad-address');
    await noPrinter('P4 a kitchen screen is not made from a till', { kind: 'screen' }, 'bad-payload');
    await noPrinter('P4 paper is 58 or 80', { paper_mm: 70 }, 'bad-payload');
    await noPrinter('P4 the switch is yes or no', { one_printer: 'yes' }, 'bad-payload');
    await noPrinter("P4 another client's store", { store_id: theirStore }, 'bad-store');
    const theirPrinter = (await q1(`insert into printers (tenant_id, store_id, name, kind, address) values ($1,$2,'Theirs','network','10.0.0.9') returning id`, [other, theirStore])).id;
    await noPrinter("P4 another client's printer is not taken over", { id: theirPrinter }, 'conflict');
    check('P4 and theirs is as it was', (await printer(theirPrinter)).name === 'Theirs');
    await noPrinter('P4 someone who may only sell is refused', {}, 'forbidden', cashier);
    const kitchen = crypto.randomUUID();
    const pr4 = await one(op('printer.save', { id: kitchen, store_id: store, name: 'Kitchen', kind: 'network', address: '192.168.1.51', paper_mm: 80, approved_by: manager }, cashier));
    check('P4 with the approval of someone who may, it is made', pr4.said === 'applied' && (await printer(kitchen))?.name === 'Kitchen', pr4.said);

    // the other store holds a kitchen screen and no printer
    const screen = (await q1(`insert into printers (tenant_id, store_id, name, kind, address, pair_code) values ($1,$2,'Pass','screen','192.168.1.60','KTCHN234') returning id`, [tid, second])).id;
    const annex = crypto.randomUUID();
    const pr5 = await one(op('printer.save', { id: annex, store_id: second, name: 'Annex', kind: 'network', address: '192.168.1.70', paper_mm: 80 }));
    check('P5 a store with only a kitchen screen: its first printer prints its receipts', pr5.said === 'applied' && (await printer(annex)).is_receipt === true, pr5.said);
    const asScreen = await one(op('printer.save', { id: screen, store_id: second, name: 'Pass', kind: 'network', address: '192.168.1.60', paper_mm: 80 }));
    check('P4 a kitchen screen is not changed from a till', asScreen.said === 'rejected:bad-printer' && (await printer(screen)).kind === 'screen', asScreen.said);
    const moved = await one(op('printer.save', { id: annex, store_id: store, name: 'Moved', kind: 'network', address: '192.168.1.70', paper_mm: 80 }));
    check('P4 a printer of another store of the business is not this till\'s to change', moved.said === 'rejected:bad-printer' && (await printer(annex)).name === 'Annex', moved.said);
    await c.query(`update printers set deleted_at = now() where id = $1`, [kitchen]);
    const gone = await one(op('printer.save', { id: kitchen, store_id: store, name: 'Back', kind: 'network', address: '192.168.1.51', paper_mm: 80 }));
    check('P4 a printer that was removed stays removed', gone.said === 'rejected:bad-printer' && (await printer(kitchen)).deleted_at !== null, gone.said);

    const p2 = await pull();
    const sent = (p2.changes.printers || []).filter((x) => !x.deleted_at).map((x) => x.name).sort();
    const sentSettings = (p2.changes.pos_settings || [])[0];
    check('P6 a till is sent its printers and the switch', sent.includes('Counter') && sent.includes('Bar') && !!sentSettings && sentSettings.data.onePrinter === false, sent.join() + ' ' + JSON.stringify(sentSettings && sentSettings.data));

    // ---- the business's details ----
    const theirs0 = JSON.stringify([await tenant(other), await settings(other)]);
    const c1 = await one(op('company.save', { name: ' Chez Nous ', address: 'Royal Road\nCurepipe', phone: '5 123 4567', brn: 'C12345678', vat: 'VAT27000000' }));
    let t = await tenant();
    s = await settings();
    check('C1 the details are saved where the back office keeps them', c1.said === 'applied' && t.name === 'Chez Nous' && t.brn === 'C12345678' && t.vat_number === 'VAT27000000', c1.said + ' ' + JSON.stringify(t));
    check('C1 and where the tills read them', !!s.company && s.company.name === 'Chez Nous' && s.company.address === 'Royal Road\nCurepipe' && s.company.phone === '5 123 4567' && s.company.brn === 'C12345678' && s.company.vat === 'VAT27000000', JSON.stringify(s.company));
    check('C1 nothing else in the settings is touched', s.setup === 'open' && s.onePrinter === false, JSON.stringify(s));
    const p3 = await pull();
    const co = ((p3.changes.pos_settings || [])[0] || { data: {} }).data.company;
    check('C1 a till is sent them in its next pull', !!co && co.name === 'Chez Nous' && co.brn === 'C12345678', JSON.stringify(co));

    const c2 = await one(op('company.save', { name: 'x'.repeat(100), address: 'Royal Road\nCurepipe', phone: '5 123 4567', brn: '', vat: '' }));
    t = await tenant();
    s = await settings();
    check('C2 no BRN and no VAT number are none, and a name is cut at eighty', c2.said === 'applied' && t.brn === null && t.vat_number === null && s.company.brn === '' && s.company.vat === '' && t.name.length === 80, c2.said + ' ' + JSON.stringify(t));
    await one(op('company.save', { name: 'Chez Nous', address: 'Royal Road\nCurepipe', phone: '5 123 4567', brn: 'C12345678', vat: 'VAT27000000' }));
    const c3 = await one(op('company.save', { name: '  ', address: '', phone: '', brn: '', vat: '' }));
    check('C3 a business with no name is refused', c3.said === 'rejected:name-required' && (await tenant()).name === 'Chez Nous', c3.said);
    const c3b = await one(op('company.save', { name: 'Not allowed', address: '', phone: '', brn: '', vat: '' }, cashier));
    check('C3 someone who may only sell is refused', c3b.said === 'rejected:forbidden' && (await tenant()).name === 'Chez Nous', c3b.said);
    const c3c = await one(op('company.save', { name: 'Chez Nous', address: 'Royal Road\nCurepipe', phone: '5 999 0000', brn: 'C12345678', vat: 'VAT27000000', approved_by: manager }, cashier));
    check('C3 with the approval of someone who may, it is saved', c3c.said === 'applied' && (await settings()).company.phone === '5 999 0000', c3c.said);
    check("C3 another client's details are as they were", JSON.stringify([await tenant(other), await settings(other)]) === theirs0);

    // ---- staff and PINs ----
    const asha = crypto.randomUUID();
    const f1 = await one(op('staff.save', { id: asha, name: ' Asha ', role_id: cashierRole, pin_hash: H }));
    let e = await person(asha);
    check('F1 a member of staff is added from a till', f1.said === 'applied' && !!e && e.name === 'Asha' && e.role_id === cashierRole && e.pin_hash === H && e.auth_user_id === null && e.is_active === true, f1.said + ' ' + JSON.stringify(e));
    check('F1 the till is told so', !!f1.data && f1.data.created === true, JSON.stringify(f1.data));
    const at = (await c.query(`select store_id from employee_stores where employee_id = $1`, [asha])).rows.map((r) => r.store_id).sort();
    check('F1 at every store of the business, as one added in the back office', at.join() === [store, second].sort().join(), at.join());
    const f2 = await one(op('staff.save', { id: asha, name: 'Someone else', role_id: cashierRole, pin_hash: H }));
    check('F2 sent again, the person is left as they are', f2.said === 'applied' && f2.data.created === false && (await person(asha)).name === 'Asha', f2.said);

    const staff = async () => (await q1(`select count(*)::int as n from employees where tenant_id = $1`, [tid])).n;
    const crew = await staff();
    const nobody = async (name, payload, code, who, login) => {
      const r = await one(op('staff.save', { id: crypto.randomUUID(), name: 'Ravi', role_id: cashierRole, pin_hash: H, ...payload }, who), login);
      check(name, r.said === 'rejected:' + code && (await staff()) === crew, r.said);
    };
    await nobody('F3 a person with no name', { name: ' ' }, 'name-required');
    await nobody("F3 another client's role", { role_id: theirRole }, 'bad-role');
    const dead = await role(tid, 'Gone', ['sale.create']);
    await c.query(`update roles set deleted_at = now() where id = $1`, [dead]);
    await nobody('F3 a role that was removed', { role_id: dead }, 'bad-role');
    await nobody('F3 a hash that is not one', { pin_hash: 'abc' }, 'bad-pin');
    await nobody('F3 a PIN in clear is not a hash', { pin_hash: '1234' }, 'bad-pin');
    await nobody('F3 a hash of other rounds', { pin_hash: H.replace('$20000$', '$10000$') }, 'bad-pin');
    await nobody("F3 another client's member of staff is not taken over", { id: theirOwner }, 'conflict');
    check('F3 and theirs is as they were', (await person(theirOwner)).name === 'Their owner');
    await nobody('F3 a manager may not add staff', {}, 'forbidden', undefined, manager);
    await nobody('F3 nor with the approval of another who may not', { approved_by: manager }, 'forbidden', cashier);
    const ravi = crypto.randomUUID();
    const f3 = await one(op('staff.save', { id: ravi, name: 'Ravi', role_id: cashierRole, pin_hash: H, approved_by: owner }), manager);
    check('F3 with the owner\'s approval, a manager adds one', f3.said === 'applied' && (await person(ravi))?.name === 'Ravi', f3.said);

    const f4 = await one(op('staff.set_pin', { employee_id: owner, pin_hash: H }));
    check('F4 a PIN is set from a till', f4.said === 'applied' && (await person(owner)).pin_hash === H, f4.said);
    const f4b = await one(op('staff.set_pin', { employee_id: theirOwner, pin_hash: H }));
    check("F4 another client's member of staff is not given one", f4b.said === 'rejected:unknown-staff' && (await person(theirOwner)).pin_hash === null, f4b.said);
    await c.query(`update employees set deleted_at = now() where id = $1`, [ravi]);
    const f4c = await one(op('staff.set_pin', { employee_id: ravi, pin_hash: H.replace('e9J4', 'f9J4') }));
    check('F4 nor one who was removed', f4c.said === 'rejected:unknown-staff' && (await person(ravi)).pin_hash === H, f4c.said);
    const f4d = await one(op('staff.set_pin', { employee_id: manager, pin_hash: '0000' }));
    check('F4 a PIN in clear is refused', f4d.said === 'rejected:bad-pin' && (await person(manager)).pin_hash === null, f4d.said);
    const f4e = await one(op('staff.set_pin', { employee_id: manager, pin_hash: H }), manager);
    check('F4 a manager may not set a PIN, their own included', f4e.said === 'rejected:forbidden' && (await person(manager)).pin_hash === null, f4e.said);

    const p4 = await pull();
    const her = (p4.changes.employees || []).find((x) => x.id === asha);
    check('F5 a till is sent the new member of staff with the hash it checks', !!her && her.pin_hash === H && her.name === 'Asha', JSON.stringify(her));

    // ---- the set-up is finished ----
    const d0 = await one(op('setup.finish', {}, cashier));
    check('D1 someone who may only sell does not finish it', d0.said === 'rejected:forbidden' && (await settings()).setup === 'open', d0.said);
    const d1 = await one(op('setup.finish', {}));
    s = await settings();
    check('D1 the set-up is marked done, and nothing else in the settings is touched', d1.said === 'applied' && s.setup === 'done' && s.company.name === 'Chez Nous' && s.onePrinter === false, d1.said + ' ' + JSON.stringify(s));
    const d2 = await one(op('setup.finish', { approved_by: manager }, cashier));
    check('D1 done already is done', d2.said === 'applied' && (await settings()).setup === 'done', d2.said);

    // ---- a store that is nearly full ----
    await c.query(`insert into tables (tenant_id, store_id, name, area, x, y, w, h) select $1, $2, 'x' || g, 'Hall', 0, 0, 4, 4 from generate_series(1, 290) g`, [tid, second]);
    const t5 = await one(op('tables.add', { store_id: second, area: 'Gallery', tables: room(range(1, 11)) }));
    check('T5 a store holds three hundred tables and no more', t5.said === 'rejected:too-many' && (await tablesOf(second)).length === 290, t5.said);
    const t5b = await one(op('tables.add', { store_id: second, area: 'Gallery', tables: room(range(1, 10)) }));
    check('T5 the three hundredth is taken', t5b.said === 'applied' && (await tablesOf(second)).length === 300, t5b.said);

    // ---- /admin: a new client, and the details it holds. Rolled back. ----
    check('N1 a client from before has no mark, and is never shown the set-up', !('setup' in (await settings(other))), JSON.stringify(await settings(other)));
    await c.query('BEGIN');
    try {
      const admin = crypto.randomUUID();
      await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-su@example.com')`, [admin]);
      const made = (await q1(`select platform.create_tenant_of_type($1,'SU New','Main','SUN1','Owner',$2,'standard','restaurant') as r`, [admin, crypto.randomUUID()])).r;
      const fresh = await settings(made.tenant_id);
      check('N1 a client made in /admin starts with its set-up open', fresh.setup === 'open' && fresh.plan === 'standard', JSON.stringify(fresh));

      await c.query(`select platform.set_tenant_details($1, $2, 'New Name', 'C999', 'VAT999')`, [admin, tid]);
      t = await tenant();
      s = await settings();
      check('N2 the details typed in /admin are kept as before', t.name === 'New Name' && t.brn === 'C999' && t.vat_number === 'VAT999', JSON.stringify(t));
      check('N2 and reach the settings a till is sent, the address and phone left as they were', s.company.name === 'New Name' && s.company.brn === 'C999' && s.company.vat === 'VAT999' && s.company.address === 'Royal Road\nCurepipe' && s.company.phone === '5 999 0000', JSON.stringify(s.company));
      await c.query(`select platform.set_tenant_details($1, $2, 'New Name', '', 'VAT999')`, [admin, tid]);
      check('N2 a BRN taken away is none in both', (await tenant()).brn === null && (await settings()).company.brn === '', JSON.stringify((await settings()).company));

      // what tenants holds and the settings lack is copied in; what is there is kept
      const mk = async (name, brn, vat, data) => {
        const id = crypto.randomUUID();
        await c.query(`insert into tenants (id, tenant_id, name, brn, vat_number) values ($1,$1,$2,$3,$4)`, [id, name, brn, vat]);
        if (data) await c.query(`insert into pos_settings (tenant_id, data) values ($1, $2::jsonb)`, [id, JSON.stringify(data)]);
        await c.query(`select company_from_tenants($1)`, [id]);
        return (await q1(`select data from pos_settings where tenant_id = $1`, [id]))?.data;
      };
      const a = await mk('SU A', 'T1', 'V1', { plan: 'standard' });
      check('N3 a BRN and VAT number held in /admin alone reach the settings', !!a && a.company.brn === 'T1' && a.company.vat === 'V1' && a.company.name === 'SU A' && a.plan === 'standard', JSON.stringify(a));
      const b = await mk('SU B', 'ADMIN', null, { company: { brn: 'SAVED', address: 'Here' } });
      check('N3 what a client saved is kept', !!b && b.company.brn === 'SAVED' && b.company.address === 'Here' && b.company.name === 'SU B' && !('vat' in b.company), JSON.stringify(b));
      const d = await mk('SU C', null, null, { company: { name: 'C Saved', address: 'There' } });
      check('N3 a client with neither gains neither', !!d && d.company.name === 'C Saved' && d.company.address === 'There' && !('brn' in d.company) && !('vat' in d.company), JSON.stringify(d));
      const n = await mk('SU D', 'T4', null, null);
      check('N3 a client with no settings yet is given them', !!n && n.company.brn === 'T4' && n.company.name === 'SU D', JSON.stringify(n));
    } finally {
      await c.query('ROLLBACK');
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-SETUP PASS' : `TILL-SETUP FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
