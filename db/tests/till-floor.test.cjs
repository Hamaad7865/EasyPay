// till-floor.test.cjs — a restaurant's floor plan, changed from a till
// (migration 0101).
//   - floor.save writes one room as the tablet's plan holds it: tables moved,
//     sized, renumbered, given other covers or another shape, added, and the
//     ones taken off removed. Other rooms are not touched. Sent twice it
//     leaves what one sending left.
//   - room.rename gives every table of a room the new name; room.remove
//     removes every table of a room.
//   - The rules are the back office's: whoever may change settings, a table
//     whole on the 100 by 60 plan, a number its own in the whole store, 300
//     tables to a store, two tables free to swap numbers in one save.
//   - Each is refused for someone who may not and done with the word of
//     someone who may.
//   - Since 0102: a table may be set at an angle (left as it is when a save
//     does not say), a booth and a bar stool are tables, and a room's walls,
//     doors, windows and bar are saved with its plan, renamed with the room
//     and removed with it; a save that does not name them leaves them alone.
// The example payloads are the files in fixtures/till-floor, which the
// tablet's own tests compare with what it builds. Their stand-in ids are
// swapped for real ones.
// Usage: node db/tests/till-floor.test.cjs
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
const FIX = path.join(__dirname, 'fixtures', 'till-floor');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
// every stand-in in a payload swapped for what it stands for
const swap = (v, map) => (Array.isArray(v) ? v.map((x) => swap(x, map))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, map)]))
    : typeof v === 'string' && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v);
const table = (name, x, y, more = {}) => ({ id: id(), name: String(name), seats: 4, shape: 'square', x, y, w: 8, h: 8, ...more });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = id(), other = id();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name, plan) values ('${tid}','${tid}','TF-Resto','offline'), ('${other}','${other}','TF-Other','standard')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','TFS1') returning id`)).id;
    const theirStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','TFS2') returning id`)).id;
    const role = async (t, name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [t, name, JSON.stringify(perms)])).id;
    const emp = async (t, name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [t, name, r])).id;
    const owner = await emp(tid, 'Owner', await role(tid, 'Owner', ['*'])); // the till's login
    const manager = await emp(tid, 'Manager', await role(tid, 'Manager', ['settings.device']));
    const cashier = await emp(tid, 'Cashier', await role(tid, 'Cashier', ['sale.create', 'payment.take']));
    await emp(other, 'Their owner', await role(other, 'Owner', ['*']));
    await c.query(`select ensure_pos_basics('${tid}')`);
    await c.query(`select ensure_pos_basics('${other}')`);
    const theirs = (await q1(`insert into tables (tenant_id, store_id, name, area) values ($1,$2,'1','Main') returning id`, [other, theirStore])).id;

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
    const all = async () => (await c.query(
      `select id, name, area, seats, shape, x, y, w, h, sort_order, deleted_at is not null as gone from tables where store_id = $1 order by sort_order, name`, [store])).rows;
    const live = async () => (await all()).filter((t) => !t.gone);
    const by = (rows, name) => rows.find((t) => t.name === name);
    const state = async () => JSON.stringify((await live()).map((t) => [t.id, t.name, t.area, t.seats, t.shape, t.x, t.y, t.w, t.h, t.sort_order]));

    // two rooms, as the first-run set-up leaves them
    const main = [table(1, 2, 2), table(2, 14, 2), table(3, 26, 2), table(4, 38, 2)];
    const terrace = [table(5, 2, 2), table(6, 14, 2)];
    check('S0 the rooms are there', (await one(op('tables.add', { store_id: store, area: 'Main', tables: main }))).said === 'applied'
      && (await one(op('tables.add', { store_id: store, area: 'Terrace', tables: terrace }))).said === 'applied' && (await live()).length === 6);
    const save = (area, tables, removed = [], extra = {}, who) => op('floor.save', { store_id: store, area, tables, removed, ...extra }, who);
    const asIs = (t, change = {}) => ({ id: t.id, name: t.name, seats: t.seats, shape: t.shape, x: t.x, y: t.y, w: t.w, h: t.h, ...change });

    // ---- floor.save: the example the tablet builds ----
    {
      const ex = fixture('floor-save');
      const sent = swap(ex.payload, { 'store-1': store, 'table-1': main[0].id, 'table-2': main[1].id, 'table-3': main[2].id });
      const before = await live();
      const r = await one(op(ex.type, sent));
      const now = await all();
      const t1 = now.find((t) => t.id === main[0].id), t2 = now.find((t) => t.id === main[1].id), t3 = now.find((t) => t.id === main[2].id), t4 = now.find((t) => t.id === main[3].id);
      check('F1 the room is saved as the plan holds it', r.said === 'applied' && r.data.saved === 2 && r.data.removed === 1, r.said + ' ' + JSON.stringify(r.data));
      check('F1 a table is moved and made bigger', t1.x === 2 && t1.y === 2 && t1.w === 12 && t1.h === 12 && !t1.gone, JSON.stringify(t1));
      check('F1 a table is given other covers and another shape', t2.seats === 6 && t2.shape === 'round' && t2.x === 20 && t2.w === 16 && t2.h === 14, JSON.stringify(t2));
      check('F1 the table taken off is removed', t3.gone === true);
      check('F1 a table of the room that was not sent is left as it was', !t4.gone && t4.x === 38 && t4.w === 8 && t4.area === 'Main', JSON.stringify(t4));
      check('F1 the other room is not touched', JSON.stringify(now.filter((t) => t.area === 'Terrace')) === JSON.stringify(before.filter((t) => t.area === 'Terrace')));
      check('F1 the tables keep their place in the order', t1.sort_order === by(before, '1').sort_order && t2.sort_order === by(before, '2').sort_order);
      const was = await state();
      const again = await one(op(ex.type, sent));
      check('F1 sent again under a new change id, it leaves what one sending left', again.said === 'applied' && (await state()) === was, again.said);
    }

    // ---- floor.save: what the plan can do ----
    {
      const rows = await live();
      const t1 = by(rows, '1'), t2 = by(rows, '2'), t4 = by(rows, '4');
      const fresh = table(7, 50, 20, { seats: 8, shape: 'round', w: 14, h: 14 });
      const r = await one(save('Main', [asIs(t1), asIs(t2), asIs(t4), fresh]));
      const now = await live();
      const made = now.find((t) => t.id === fresh.id);
      check('F2 a table is added to a room the store has', r.said === 'applied' && !!made && made.area === 'Main' && made.seats === 8 && made.shape === 'round', r.said);
      check('F2 the new table goes after the last in the order', !!made && made.sort_order > Math.max(...now.filter((t) => t.id !== fresh.id).map((t) => t.sort_order)));
      const swapped = await one(save('Main', [asIs(t1, { name: '2' }), asIs(t2, { name: '1' })]));
      const after = await live();
      check('F3 two tables swap numbers in one save', swapped.said === 'applied' && after.find((t) => t.id === t1.id).name === '2' && after.find((t) => t.id === t2.id).name === '1', swapped.said);
      await one(save('Main', [asIs(t1), asIs(t2)])); // back as they were
      const moved = await one(save('Terrace', [asIs(t4)]));
      check('F4 a table saved with another room goes to that room', moved.said === 'applied' && (await live()).find((t) => t.id === t4.id).area === 'Terrace', moved.said);
      await one(save('Main', [asIs(t4)]));
      const none = await one(save('Main', [], []));
      check('F5 a save that names nothing changes nothing', none.said === 'applied' && none.data.saved === 0 && (await live()).length === 6, none.said);
    }

    // ---- floor.save: what is refused, and that nothing changes then ----
    {
      const rows = await live();
      const t1 = by(rows, '1'), t5 = by(rows, '5');
      const was = await state();
      const still = async (name, o, code, login) => {
        const r = await one(o, login);
        const ok = Array.isArray(code) ? code.map((x) => 'rejected:' + x).includes(r.said) : r.said === 'rejected:' + code;
        check(name, ok && (await state()) === was, r.said);
      };
      await still('F6 a number another room uses is refused', save('Main', [asIs(t1, { name: '5' })]), 'name-taken');
      await still('F6 a number in other capitals is the same number', save('Main', [asIs(t1, { name: 'A' }), table('a', 60, 40)]), 'name-taken');
      await still('F6 a table that leaves the plan', save('Main', [asIs(t1, { x: 95 })]), 'bad-payload');
      await still('F6 a table that is lower than the plan', save('Main', [asIs(t1, { y: 55 })]), 'bad-payload');
      await still('F6 a table narrower than four', save('Main', [asIs(t1, { w: 3 })]), 'bad-payload');
      await still('F6 a table with no seat', save('Main', [asIs(t1, { seats: 0 })]), 'bad-payload');
      await still('F6 a shape that is neither', save('Main', [asIs(t1, { shape: 'star' })]), 'bad-payload');
      await still('F6 a table with no number', save('Main', [asIs(t1, { name: '  ' })]), 'bad-payload');
      await still('F6 a room with no name', save('  ', [asIs(t1)]), 'bad-payload');
      await still('F6 one table sent twice', save('Main', [asIs(t1), asIs(t1)]), 'bad-payload');
      await still('F6 a table both on the plan and taken off it', save('Main', [asIs(t1)], [t1.id]), 'bad-payload');
      await still('F6 removed that is not a list', op('floor.save', { store_id: store, area: 'Main', tables: [asIs(t1)], removed: 'all' }), 'bad-payload');
      await still("F6 another client's store", op('floor.save', { store_id: theirStore, area: 'Main', tables: [table(90, 2, 2)], removed: [] }), 'bad-store');
      await still("F6 another client's table is not written over", save('Main', [{ ...table(91, 60, 40), id: theirs }]), ['conflict', 'error']);
      await still('F6 a cashier may not change the plan', save('Main', [asIs(t1, { x: 40 })], [], {}, cashier), 'forbidden');
      const their = await q1(`select name, area, x, deleted_at from tables where id = $1`, [theirs]);
      check("F6 another client's table is as it was", their.name === '1' && their.area === 'Main' && their.deleted_at === null, JSON.stringify(their));
      const gone = (await all()).find((t) => t.gone);
      await still('F6 a table that was removed does not come back by its id', save('Main', [{ id: gone.id, name: '33', seats: 4, shape: 'square', x: 60, y: 40, w: 8, h: 8 }]), 'conflict');
      const taken = await one(save('Terrace', [asIs(t5)], [theirs]));
      check("F6 another client's table is not removed", taken.said === 'applied' && taken.data.removed === 0 && (await q1(`select deleted_at from tables where id = $1`, [theirs])).deleted_at === null, taken.said);
      const word = await one(save('Main', [asIs(t1, { x: 40 })], [], { approved_by: manager }, cashier));
      check('F7 with the word of someone who may, it is done', word.said === 'applied' && (await live()).find((t) => t.id === t1.id).x === 40, word.said);
      await one(save('Main', [asIs(t1)]));
    }

    // ---- what a till is given by its next sync ----
    {
      const page = await asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);
      const rows = JSON.stringify(page);
      const gone = (await all()).find((t) => t.gone);
      check('P1 the next sync carries the plan, and the table that was removed as removed', rows.includes(gone.id) && rows.includes((await live())[0].id));
    }

    // ---- room.rename ----
    {
      const ex = fixture('room-rename');
      const r = await one(op(ex.type, swap(ex.payload, { 'store-1': store })));
      const now = await live();
      check('R1 every table of the room takes the new name', r.said === 'applied' && r.data.renamed === 4 && now.filter((t) => t.area === 'Dining room').length === 4 && now.filter((t) => t.area === 'Terrace').length === 2, r.said + ' ' + JSON.stringify(r.data));
      const again = await one(op(ex.type, swap(ex.payload, { 'store-1': store })));
      check('R1 sent again, there is nothing left to rename', again.said === 'applied' && again.data.renamed === 0, again.said);
      const clash = await one(op('room.rename', { store_id: store, from: 'Dining room', to: 'terrace' }));
      check('R2 the name of another room is refused, whatever the capitals', clash.said === 'rejected:room-exists', clash.said);
      const capitals = await one(op('room.rename', { store_id: store, from: 'Dining room', to: 'DINING ROOM' }));
      check('R3 a room may change its own capitals', capitals.said === 'applied' && (await live()).filter((t) => t.area === 'DINING ROOM').length === 4, capitals.said);
      const no = await one(op('room.rename', { store_id: store, from: 'DINING ROOM', to: 'Hall' }, cashier));
      check('R4 a cashier may not rename a room', no.said === 'rejected:forbidden', no.said);
      const blank = await one(op('room.rename', { store_id: store, from: 'DINING ROOM', to: '   ' }));
      check('R5 a room is not renamed to nothing', blank.said === 'rejected:bad-payload', blank.said);
      const back = await one(op('room.rename', { store_id: store, from: 'DINING ROOM', to: 'Main' }));
      check('R6 and back', back.said === 'applied' && (await live()).filter((t) => t.area === 'Main').length === 4, back.said);
    }

    // ---- 300 tables to a store ----
    {
      const have = (await live()).length;
      const rooms = [];
      for (let left = 300 - have, n = 0; left > 0; n++) {
        const size = Math.min(60, left);
        rooms.push(Array.from({ length: size }, (_, i) => table('B' + n + '-' + i, 2 + 9 * (i % 10), 2 + 9 * Math.floor(i / 10))));
        left -= size;
      }
      let ok = true;
      for (const [n, r] of rooms.entries()) ok = ok && (await one(op('tables.add', { store_id: store, area: 'Big ' + n, tables: r }))).said === 'applied';
      const t1 = by(await live(), '1');
      const over = await one(save('Main', [asIs(t1), table(999, 60, 40)]));
      check('L1 a store holds 300 tables at most', ok && (await live()).length === 300 && over.said === 'rejected:too-many', over.said);
      const replaced = await one(save('Main', [asIs(t1), table(999, 60, 40)], [by(await live(), '2').id]));
      check('L2 one taken off makes room for one more in the same save', replaced.said === 'applied' && (await live()).length === 300, replaced.said);
      for (const n of rooms.keys()) await one(op('room.remove', { store_id: store, area: 'Big ' + n }));
    }

    // ---- room.remove ----
    {
      const ex = fixture('room-remove');
      const before = (await live()).filter((t) => t.area !== 'Terrace').length;
      const no = await one(op(ex.type, swap(ex.payload, { 'store-1': store }), cashier));
      check('D1 a cashier may not remove a room', no.said === 'rejected:forbidden' && (await live()).some((t) => t.area === 'Terrace'), no.said);
      const r = await one(op(ex.type, swap(ex.payload, { 'store-1': store })));
      const now = await live();
      check('D2 every table of the room is removed, and no other', r.said === 'applied' && r.data.removed === 2 && !now.some((t) => t.area === 'Terrace') && now.length === before, r.said + ' ' + JSON.stringify(r.data));
      const again = await one(op(ex.type, swap(ex.payload, { 'store-1': store })));
      check('D2 sent again, there is nothing left to remove', again.said === 'applied' && again.data.removed === 0, again.said);
      const theirsStill = await one(op('room.remove', { store_id: theirStore, area: 'Main' }));
      check("D3 another client's room is not removed", theirsStill.said === 'rejected:bad-store' && (await q1(`select deleted_at from tables where id = $1`, [theirs])).deleted_at === null, theirsStill.said);
      // a number freed by a removed table can be used again
      const reuse = await one(save('Main', [table(5, 60, 40)]));
      check('D4 the number of a removed table is free again', reuse.said === 'applied', reuse.said);
    }

    // ---- 0102: an angle, booths and stools, and what stands in the room ----
    {
      const els = async () => (await c.query(
        `select id, area, kind, x, y, w, h, rotation, deleted_at is not null as gone from floor_elements where store_id = $1 order by sort_order, id`, [store])).rows;
      const el = (kind, x, y, w, h, more = {}) => ({ id: id(), kind, x, y, w, h, rotation: 0, ...more });
      const rot = async (tableId) => (await q1(`select rotation, shape, seats from tables where id = $1`, [tableId]));
      const old = el('window', 90, 0, 8, 1);
      const first = await one(op('floor.save', { store_id: store, area: 'Hall', tables: [], removed: [], elements: [old] }));
      check('E0 a room may be given something to stand in it before it has a table', first.said === 'applied' && first.data.elements === 1, first.said);

      const ex = fixture('floor-save-pieces');
      const ids = { 'store-1': store, 'table-1': id(), 'table-2': id(), 'table-3': id(), 'element-1': id(), 'element-2': id(), 'element-3': id(), 'element-4': old.id };
      const sent = { ...swap(ex.payload, ids), area: 'Hall' };
      // the example's numbers are free in this store
      sent.tables = sent.tables.map((t, i) => ({ ...t, name: ['H1', 'HB1', 'HS1'][i] }));
      const r = await one(op(ex.type, sent));
      const now = await els();
      check('E1 the plan is saved with its pieces', r.said === 'applied' && r.data.saved === 3 && r.data.elements === 3 && r.data.elements_removed === 1, r.said + ' ' + JSON.stringify(r.data));
      const t1 = await rot(ids['table-1']), t2 = await rot(ids['table-2']), t3 = await rot(ids['table-3']);
      check('E1 a table is set at an angle', t1.rotation === 45);
      check('E1 a booth and a bar stool are tables', t2.shape === 'booth' && t3.shape === 'stool' && t3.seats === 1, JSON.stringify([t2, t3]));
      const wall = now.find((x) => x.id === ids['element-1']), bar = now.find((x) => x.id === ids['element-3']);
      check('E1 a wall one unit thick, and a bar turned a quarter', !!wall && wall.kind === 'wall' && wall.h === 1 && wall.area === 'Hall' && !!bar && bar.rotation === 90, JSON.stringify([wall, bar]));
      check('E1 the element taken off is removed', now.find((x) => x.id === old.id).gone === true);
      const was = JSON.stringify(await els()) + (await state());
      const again = await one(op(ex.type, sent));
      check('E1 sent again, it leaves what one sending left', again.said === 'applied' && JSON.stringify(await els()) + (await state()) === was, again.said);

      // a till built before this names no angle and no elements: neither is touched
      const plain = sent.tables.map(({ rotation, ...t }) => t);
      const older = await one(op('floor.save', { store_id: store, area: 'Hall', tables: plain, removed: [] }));
      check('E2 a save that names no angle turns nothing back', older.said === 'applied' && (await rot(ids['table-1'])).rotation === 45, older.said);
      check('E2 a save that names no elements leaves them where they stand', JSON.stringify(await els()) + (await state()) === was);
      const none = await one(op('floor.save', { store_id: store, area: 'Hall', tables: [], removed: [], elements: [] }));
      check('E2 nor does one that names none', none.said === 'applied' && (await els()).filter((x) => !x.gone).length === 3, none.said);
      const turned = await one(op('floor.save', { store_id: store, area: 'Hall', tables: [{ ...sent.tables[0], rotation: 0 }], removed: [] }));
      check('E2 an angle of nought is an angle', turned.said === 'applied' && (await rot(ids['table-1'])).rotation === 0, turned.said);

      const still = async (name, payload, code, login) => {
        const before = JSON.stringify(await els()) + (await state());
        const res = await one(op('floor.save', { store_id: store, area: 'Hall', tables: [], removed: [], ...payload }), login);
        const ok = Array.isArray(code) ? code.map((x) => 'rejected:' + x).includes(res.said) : res.said === 'rejected:' + code;
        check(name, ok && JSON.stringify(await els()) + (await state()) === before, res.said);
      };
      await still('E3 a kind that is none of the four', { elements: [el('pillar', 2, 2, 2, 2)] }, 'bad-payload');
      await still('E3 an element that leaves the plan', { elements: [el('wall', 95, 0, 10, 1)] }, 'bad-payload');
      await still('E3 an element with no thickness', { elements: [el('wall', 2, 2, 10, 0)] }, 'bad-payload');
      await still('E3 an angle past the circle', { elements: [el('door', 2, 2, 8, 2, { rotation: 360 })] }, 'bad-payload');
      await still('E3 a table at an angle past the circle', { tables: [{ ...sent.tables[0], rotation: 400 }] }, 'bad-payload');
      await still('E3 a shape that is none of the four', { tables: [{ ...sent.tables[0], shape: 'sofa' }] }, 'bad-payload');
      const twice = el('wall', 2, 30, 10, 1);
      await still('E3 one element sent twice', { elements: [twice, twice] }, 'bad-payload');
      await still('E3 an element both on the plan and taken off it', { elements: [twice], removed_elements: [twice.id] }, 'bad-payload');
      await still('E3 elements that are not a list', { elements: 'all' }, 'bad-payload');
      await still('E3 an element that was removed does not come back by its id', { elements: [{ ...old }] }, 'conflict');
      await still('E3 a cashier may not move a wall', { elements: [el('wall', 2, 40, 10, 1)] }, 'forbidden', cashier);
      const theirEl = (await q1(`insert into floor_elements (tenant_id, store_id, area, kind) values ($1,$2,'Main','wall') returning id`, [other, theirStore])).id;
      await still("E3 another client's element is not written over", { elements: [{ ...el('wall', 2, 40, 10, 1), id: theirEl }] }, ['conflict', 'error']);
      const taken = await one(op('floor.save', { store_id: store, area: 'Hall', tables: [], removed: [], removed_elements: [theirEl] }));
      check("E3 nor removed", taken.said === 'applied' && taken.data.elements_removed === 0 && (await q1(`select deleted_at from floor_elements where id = $1`, [theirEl])).deleted_at === null, taken.said);

      const page = JSON.stringify(await asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r));
      check("P2 the next sync carries the room's elements and a table's angle", page.includes(ids['element-1']) && page.includes('"floor_elements"') && page.includes('"rotation"'));

      const renamed = await one(op('room.rename', { store_id: store, from: 'Hall', to: 'Great hall' }));
      check('R7 a room renamed takes what stands in it', renamed.said === 'applied' && (await els()).filter((x) => !x.gone).every((x) => x.area === 'Great hall'), renamed.said);

      // 200 to a store
      const have = (await els()).filter((x) => !x.gone).length;
      const many = Array.from({ length: 200 - have }, (_, i) => el('wall', i % 90, Math.floor(i / 90) * 2 + 20, 1, 1));
      const filled = await one(op('floor.save', { store_id: store, area: 'Great hall', tables: [], removed: [], elements: many }));
      const over = await one(op('floor.save', { store_id: store, area: 'Great hall', tables: [], removed: [], elements: [el('wall', 2, 50, 10, 1)] }));
      check('L3 a store holds 200 elements at most', filled.said === 'applied' && (await els()).filter((x) => !x.gone).length === 200 && over.said === 'rejected:too-many', filled.said + ' ' + over.said);
      const longList = await one(op('floor.save', { store_id: store, area: 'Great hall', tables: [], removed: [], elements: Array.from({ length: 201 }, (_, i) => el('wall', i % 90, 20, 1, 1)) }));
      check('L3 and a save names 200 at most', longList.said === 'rejected:bad-payload', longList.said);

      const gone = await one(op('room.remove', { store_id: store, area: 'Great hall' }));
      check('D5 a room removed takes what stood in it', gone.said === 'applied' && (await els()).every((x) => x.gone), gone.said);
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures === 0 ? 'TILL-FLOOR PASS' : `TILL-FLOOR FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
