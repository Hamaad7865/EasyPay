// service-v2.test.cjs — migration 0056: order kinds, the takeaway board,
// the kitchen display's marks, bookings and sold out from the till.
// Usage: node db/tests/service-v2.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','V2-Probe'), ('${other}','${other}','V2-Other')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','V2S1') returning id`)).id;
  const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','V2S2') returning id`)).id;
  await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1')`);
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
  const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
  const wrole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Waiter','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
  const waiter = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Waiter',$2) returning id`, [tid, wrole])).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  await c.query(`select ensure_pos_basics('${other}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const table = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,'T1') returning id`, [tid, store])).id;

  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const pushAs = (who, ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [who, JSON.stringify(ops)])).rows[0].r);
  const push = (ops) => pushAs(owner, ops);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');

  // T1 every restaurant has one order type of each kind the till needs
  {
    const kinds = (await c.query(`select name, kind, needs_table from dining_options where tenant_id = $1 and deleted_at is null order by sort_order`, [tid])).rows;
    const by = Object.fromEntries(kinds.map((k) => [k.kind, k.name]));
    check('T1 dine, takeaway, counter and delivery types exist', by.dine === 'Dine-in' && by.takeaway === 'Takeaway' && by.counter === 'Counter' && by.delivery === 'Delivery', JSON.stringify(kinds));
    check('T1 the bar tab is a tab', by.tab === 'Bar tab', JSON.stringify(by));
    await c.query(`select ensure_pos_basics('${tid}')`);
    const again = (await q1(`select count(*)::int n from dining_options where tenant_id = $1`, [tid])).n;
    check('T1 asking again adds nothing', again === kinds.length, again);
    const made = await q1(`insert into dining_options (tenant_id, name, needs_table, kitchen, sort_order) values ($1,'Livraison express',false,'pay',9) returning kind`, [tid]);
    check('T1 a type saved without a kind gets one from its name', made.kind === 'delivery', made.kind);
  }

  // T2 a takeaway carries its number, phone, time and stage; the board moves it, paid or not
  const t = crypto.randomUUID(), l = crypto.randomUUID();
  const takeaway = (await q1(`select id from dining_options where tenant_id=$1 and kind='takeaway'`, [tid])).id;
  {
    const due = new Date(Date.now() + 15 * 60000).toISOString();
    const r = await push([
      op('ticket.create', { id: t, store_id: store, dining_option_id: takeaway, order_no: 'A-7', name: 'Kavish', phone: '+230 5877 1203', due_at: due, stage: 'new', source: 'Counter' }),
      op('ticket.add_line', { id: l, ticket_id: t, item_id: dp, qty: 2000 }),
      op('ticket.create', { id: crypto.randomUUID(), store_id: store, stage: 'cooking' }),
    ]);
    const row = await q1(`select order_no, phone, stage, source, due_at from tickets where id = $1`, [t]);
    check('T2 the order keeps its number, phone, stage and source', tag(r[0]) === 'applied' && row.order_no === 'A-7' && row.phone === '+230 5877 1203' && row.stage === 'new' && row.source === 'Counter' && !!row.due_at, JSON.stringify(row));
    check('T2 a stage the board does not have is refused', tag(r[2]) === 'rejected:bad-payload', tag(r[2]));
    const m = await push([op('ticket.update_meta', { ticket_id: t, address: 'Royal Rd, Grand Baie', phone: '' })]);
    const row2 = await q1(`select phone, address from tickets where id = $1`, [t]);
    check('T2 the address is set and an emptied phone is cleared', tag(m[0]) === 'applied' && row2.address === 'Royal Rd, Grand Baie' && row2.phone === null, JSON.stringify(row2));
    const sub = (await q1(`select price from items where id = $1`, [dp])).price * 2;
    const pay = await push([
      op('ticket.stage', { ticket_id: t, stage: 'kitchen' }),
      op('receipt.create', { id: crypto.randomUUID(), ticket_id: t, store_id: store, device_id: (await q1(`select id from pos_devices where tenant_id=$1`, [tid])).id, number: 'V2S1-T1-000001', device_seq: 1, payments: [{ payment_type_id: cash, amount: sub, tendered: sub, change: 0 }], discounts: [], line_ids: [l] }),
      op('ticket.stage', { ticket_id: t, stage: 'ready', rider: 'Jaysen' }),
      op('ticket.stage', { ticket_id: t, stage: 'gone' }),
      op('ticket.stage', { ticket_id: crypto.randomUUID(), stage: 'done' }),
    ]);
    const row3 = await q1(`select status, stage, rider from tickets where id = $1`, [t]);
    check('T2 a paid order still moves along the board', tag(pay[1]) === 'applied' && tag(pay[2]) === 'applied' && row3.status === 'paid' && row3.stage === 'ready' && row3.rider === 'Jaysen', pay.map(tag).join(' ') + ' ' + JSON.stringify(row3));
    check('T2 an unknown stage and an unknown order are refused', tag(pay[3]) === 'rejected:bad-payload' && tag(pay[4]) === 'rejected:bad-ticket', tag(pay[3]) + ' ' + tag(pay[4]));
  }

  // T3 the bill printed for a table is remembered, and forgotten when asked
  const d = crypto.randomUUID(), dl = crypto.randomUUID(), dl2 = crypto.randomUUID();
  {
    const at = new Date().toISOString();
    const r = await push([
      op('ticket.create', { id: d, store_id: store, table_id: table, covers: 4 }),
      op('ticket.add_line', { id: dl, ticket_id: d, item_id: dp, qty: 1000 }),
      op('ticket.add_line', { id: dl2, ticket_id: d, item_id: dp, qty: 1000 }),
      op('ticket.update_meta', { ticket_id: d, bill_at: at }),
    ]);
    const on = await q1(`select bill_at from tickets where id = $1`, [d]);
    await push([op('ticket.update_meta', { ticket_id: d, bill_at: null })]);
    const off = await q1(`select bill_at, covers from tickets where id = $1`, [d]);
    check('T3 bill asked is set and cleared, and nothing else moves', tag(r[3]) === 'applied' && !!on.bill_at && off.bill_at === null && off.covers === 4, JSON.stringify([on, off]));
  }

  // T4 the kitchen display marks lines it has been sent; never ones it has not
  {
    const r = await push([
      op('kitchen.mark', { line_ids: [dl], status: 'done' }),
      op('ticket.send', { ticket_id: d, line_ids: [dl], sent_at: new Date().toISOString() }),
      op('kitchen.mark', { line_ids: [dl, dl2], status: 'done' }),
      op('kitchen.mark', { line_ids: [dl], status: 'burnt' }),
      op('kitchen.mark', { line_ids: [], status: 'done' }),
    ]);
    const rows = (await c.query(`select id, kitchen_status from ticket_lines where ticket_id = $1`, [d])).rows;
    const st = Object.fromEntries(rows.map((x) => [x.id, x.kitchen_status]));
    check('T4 a line not sent yet is not marked', r[0].data && r[0].data.marked === 0, JSON.stringify(r[0]));
    check('T4 a sent line is done; its unsent neighbour is untouched', r[2].data.marked === 1 && st[dl] === 'done' && st[dl2] === 'unsent', JSON.stringify(st));
    check('T4 an unknown status and no lines are refused', tag(r[3]) === 'rejected:bad-payload' && tag(r[4]) === 'rejected:lines-required', tag(r[3]) + ' ' + tag(r[4]));
    await push([op('kitchen.mark', { line_ids: [dl], status: 'bumped' })]);
    const b = await q1(`select kitchen_status from ticket_lines where id = $1`, [dl]);
    check('T4 a bumped ticket is bumped', b.kitchen_status === 'bumped', b.kitchen_status);
  }

  // T5 a booking is made, changed and seated; bad ones are refused
  const bk = crypto.randomUUID();
  {
    const when = new Date(Date.now() + 2 * 3600000).toISOString();
    const base = { id: bk, store_id: store, booked_for: when, name: 'Ramdin party', size: 5, phone: '+230 5788 3302', area: 'Main', tags: 'Nut allergy', status: 'pending' };
    const r = await push([
      op('booking.upsert', base),
      op('booking.upsert', { ...base, status: 'confirmed', table_id: table }),
      op('booking.upsert', { ...base, id: crypto.randomUUID(), size: 0 }),
      op('booking.upsert', { ...base, id: crypto.randomUUID(), status: 'maybe' }),
      op('booking.upsert', { ...base, id: crypto.randomUUID(), store_id: otherStore }),
      op('booking.upsert', { ...base, id: crypto.randomUUID(), name: 'Somewhere else', table_id: crypto.randomUUID() }),
    ]);
    const row = await q1(`select status, table_id, size, tags, created_by from bookings where id = $1`, [bk]);
    check('T5 a booking is made and then confirmed onto a table', tag(r[0]) === 'applied' && tag(r[1]) === 'applied' && row.status === 'confirmed' && row.table_id === table && row.size === 5 && row.tags === 'Nut allergy' && row.created_by === owner, JSON.stringify(row));
    check('T5 no guests, an unknown status and another restaurant\'s store are refused', tag(r[2]) === 'rejected:bad-payload' && tag(r[3]) === 'rejected:bad-payload' && tag(r[4]) === 'rejected:bad-store', r.slice(2, 5).map(tag).join(' '));
    const loose = await q1(`select table_id from bookings where tenant_id = $1 and name = 'Somewhere else'`, [tid]);
    check('T5 a table this restaurant does not have is left off', tag(r[5]) === 'applied' && loose.table_id === null, tag(r[5]));
    const s = await push([op('booking.upsert', { ...base, status: 'seated', table_id: table, ticket_id: d })]);
    const seated = await q1(`select status, ticket_id from bookings where id = $1`, [bk]);
    check('T5 seating it links the order', tag(s[0]) === 'applied' && seated.status === 'seated' && seated.ticket_id === d, JSON.stringify(seated));
    // a second store of the same restaurant: its tables are not this store's bookings' to take (migration 0069)
    const terrace = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Terrace','V2S3') returning id`, [tid])).id;
    const theirTable = (await q1(`insert into tables (tenant_id, store_id, name) values ($1,$2,'X1') returning id`, [tid, terrace])).id;
    const cross = crypto.randomUUID();
    const x = await push([
      op('booking.upsert', { ...base, id: cross, name: 'Cross store', table_id: theirTable }),
      // the first booking is the main store's: an op that names the other store must not put it on that store's table
      op('booking.upsert', { ...base, status: 'seated', ticket_id: d, store_id: terrace, table_id: theirTable }),
    ]);
    const crossRow = await q1(`select store_id, table_id from bookings where id = $1`, [cross]);
    const kept = await q1(`select store_id, table_id, status from bookings where id = $1`, [bk]);
    check('T5 a table of another store is left off a new booking', tag(x[0]) === 'applied' && crossRow.store_id === store && crossRow.table_id === null, tag(x[0]) + ' ' + JSON.stringify(crossRow));
    check('T5 and a booking is not put on another store\'s table by an op naming that store', tag(x[1]) === 'applied' && kept.store_id === store && kept.table_id === null && kept.status === 'seated',
      tag(x[1]) + ' ' + JSON.stringify(kept));
    const again = await push([op('booking.upsert', { ...base, status: 'seated', ticket_id: d, table_id: table })]);
    check('T5 its own store\'s table is still taken', tag(again[0]) === 'applied' && (await q1(`select table_id from bookings where id = $1`, [bk])).table_id === table);
  }

  // T6 sold out from the till: someone allowed, or approved by someone allowed
  {
    const no = await pushAs(waiter, [op('item.set_available', { item_id: dp, available: false })]);
    const still = await q1(`select is_available from items where id = $1`, [dp]);
    check('T6 a waiter may not mark an item sold out', tag(no[0]) === 'rejected:forbidden' && still.is_available === true, tag(no[0]));
    const yes = await push([op('item.set_available', { item_id: dp, available: false })]);
    const off = await q1(`select is_available from items where id = $1`, [dp]);
    check('T6 the owner may', tag(yes[0]) === 'applied' && off.is_available === false, tag(yes[0]));
    // the till's own login vouches for its staff: the waiter is named on the op and the owner approves
    const appr = await push([{ op_id: crypto.randomUUID(), type: 'item.set_available', employee_id: waiter, payload: { item_id: dp, available: true, approved_by: owner } }]);
    const on = await q1(`select is_available from items where id = $1`, [dp]);
    check('T6 a waiter with the owner\'s approval may', tag(appr[0]) === 'applied' && on.is_available === true, tag(appr[0]));
    const bad = await push([op('item.set_available', { item_id: crypto.randomUUID(), available: false }), op('item.set_available', { item_id: dp })]);
    check('T6 an unknown item and a missing answer are refused', tag(bad[0]) === 'rejected:bad-item' && tag(bad[1]) === 'rejected:bad-payload', bad.map(tag).join(' '));
  }

  // T7 the pull sends bookings and order kinds to the till; another restaurant sees none of it
  {
    const pull = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const ch = pull.changes;
    check('T7 the pull carries the bookings of the store', Array.isArray(ch.bookings) && ch.bookings.some((x) => x.id === bk && x.status === 'seated'), JSON.stringify((ch.bookings || []).map((x) => x.status)));
    check('T7 the pull carries each order type\'s kind', ch.dining_options.every((x) => typeof x.kind === 'string'), JSON.stringify(ch.dining_options.map((x) => x.kind)));
    const theirs = await asApp(other, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [otherStore])).rows[0].r);
    check('T7 another restaurant gets no booking of ours', (theirs.changes.bookings || []).length === 0, (theirs.changes.bookings || []).length);
    await c.query(`update bookings set booked_for = now() - interval '9 days' where id = $1`, [bk]);
    const later = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    check('T7 a booking more than a week old is no longer sent', !later.changes.bookings.some((x) => x.id === bk), later.changes.bookings.length);
  }

  // T8 (0058) an order's number follows its kind while the kitchen has not had it
  {
    const o = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: o, store_id: store, order_no: 'C-7' }),
      op('ticket.update_meta', { ticket_id: o, dining_option_id: takeaway, order_no: 'A-3' }),
    ]);
    const row = await q1(`select order_no from tickets where id = $1`, [o]);
    check('T8 a counter sale turned takeaway takes the number it is sent', r.map(tag).join(' ') === 'applied applied' && row.order_no === 'A-3', r.map(tag).join(' ') + ' ' + row.order_no);
    await push([op('ticket.update_meta', { ticket_id: o, note: 'no onions' })]);
    const kept = await q1(`select order_no, note from tickets where id = $1`, [o]);
    check('T8 a change that does not name the number leaves it alone', kept.order_no === 'A-3' && kept.note === 'no onions', JSON.stringify(kept));
  }

  // T9 the till changes a quantity by taking the line off and putting it back
  // with the new quantity. That must go through whatever happened to the menu
  // in between: the item marked sold out, its option unticked. Otherwise the
  // line is gone on the server and the payment that names it is refused.
  {
    const withOption = await q1(
      `select g.item_id, m.id as mod, m.name, m.price from item_modifier_groups g
         join modifiers m on m.tenant_id = g.tenant_id and m.group_id = g.group_id and m.deleted_at is null
        where g.tenant_id = $1 and g.deleted_at is null limit 1`, [tid]);
    check('T9 the demo menu has an item with an option', !!withOption, JSON.stringify(withOption));
    const o = crypto.randomUUID(), l1 = crypto.randomUUID(), l2 = crypto.randomUUID();
    const mods = [{ modifier_id: withOption.mod, price: Number(withOption.price), name: withOption.name }];
    await push([
      op('ticket.create', { id: o, store_id: store }),
      op('ticket.add_line', { id: l1, ticket_id: o, item_id: withOption.item_id, qty: 3000, modifiers: mods }),
    ]);
    await push([op('item.set_available', { item_id: withOption.item_id, available: false })]);
    await c.query(`update item_modifier_groups set deleted_at = now() where tenant_id = $1 and item_id = $2`, [tid, withOption.item_id]);
    await c.query(`update modifiers set deleted_at = now() where tenant_id = $1 and id = $2`, [tid, withOption.mod]);
    const r = await push([
      op('ticket.void_line', { line_id: l1, reason: 'quantity change' }),
      op('ticket.add_line', { id: l2, ticket_id: o, item_id: withOption.item_id, qty: 2000, modifiers: mods }),
    ]);
    const live = (await c.query(`select l.id, l.qty, (select count(*)::int from ticket_line_modifiers m where m.line_id = l.id) mods
                                   from ticket_lines l where l.ticket_id = $1 and l.voided_at is null`, [o])).rows;
    check('T9 fewer of a sold-out item with an unticked option: both steps go through', r.map(tag).join(' ') === 'applied applied', r.map(tag).join(' '));
    check('T9 the order has the one line, with its option, at the new quantity', live.length === 1 && live[0].id === l2 && live[0].qty === 2000 && live[0].mods === 1, JSON.stringify(live));
  }

  await c.query(`delete from bookings where tenant_id = $1`, [tid]);
  await devguard.cleanupTenant(c, tid);
  await devguard.cleanupTenant(c, other);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
