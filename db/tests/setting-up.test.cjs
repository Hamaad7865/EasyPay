// setting-up.test.cjs — migration 0104: a client is set up before it is live,
// a till or a code can be removed from /admin, and what a client being set up
// was tried with can be cleared: its sales and its tills go, its set-up stays.
// Everything runs in one transaction that is rolled back.
// Usage: node db/tests/setting-up.test.cjs
//   WITH_MIGRATION=1 applies 0104 inside that transaction first, to try the
//   migration before it is applied to the branch.
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
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

// Every table that holds a client's rows is in one of these. A table added
// later is in none, and X6 fails until someone has said which it is.
const KEPT = [
  'tenants', 'stores', 'roles', 'employees', 'employee_stores',
  'categories', 'items', 'item_variants', 'item_taxes', 'item_modifier_groups', 'modifier_groups', 'modifiers',
  'item_price_changes', 'store_item_overrides', 'barcode_counters', 'taxes', 'discounts', 'dining_options', 'payment_types',
  'grid_pages', 'grid_page_items', 'tables', 'floor_elements', 'printers', 'pos_settings', 'customers', 'suppliers',
  // the stock that was entered, and the papers it came in on
  'stock_levels', 'purchase_orders', 'purchase_order_lines', 'deliveries', 'delivery_lines',
  'stock_counts', 'stock_count_lines', 'doc_counters',
  // a shop's promotions (0110) are prices it decided on, not its trying
  'promotions',
  // what a till wrote down when it stopped: EasyPay's own, not the client's trying
  'crash_reports',
];
const CLEARED = [
  'bookings', 'approvals', 'drawer_counts', 'payment_corrections', 'day_closes', 'cash_movements',
  'receipt_reviews', 'receipt_discounts', 'receipt_payments', 'receipt_line_taxes', 'receipt_line_modifiers',
  'receipt_lines', 'receipts', 'ticket_line_taxes', 'ticket_line_modifiers', 'ticket_lines', 'tickets',
  'timeclock_punches', 'shifts', 'sync_ops_applied',
  'till_requests', 'device_activity', 'device_keys', 'pos_devices',
  // a shop's credit notes (0109) and deposits (0113): made at its tills
  'credit_notes', 'deposits', 'deposit_lines', 'deposit_payments',
  // its customer accounts (0114): bills and the money paid on them, made at its tills
  'account_bills', 'account_payments', 'account_payment_lines',
];
// stock_movements: the sales, refunds and deposits go, everything else stays.
// tablet_codes: the codes tills were set up with go, one nobody used yet stays.
const IN_PART = ['stock_movements', 'tablet_codes'];

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  // runs a statement that is expected to fail, without losing the transaction
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const says = (e, code) => !!e && e.message === code;
  try {
    if (process.env.WITH_MIGRATION) {
      await c.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0104_setting_up.sql'), 'utf8'));
    }
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'setting-up-test@example.com')`, [admin]);
    const tid = crypto.randomUUID(), other = crypto.randomUUID(), alone = crypto.randomUUID();
    await c.query(
      `insert into tenants (id, tenant_id, name, plan) values ($1,$1,'Chez Essai','standard'), ($2,$2,'Other Essai','standard'), ($3,$3,'Alone Essai','offline')`,
      [tid, other, alone]);

    // what a client has: a store, an owner, a menu
    async function business(t, code) {
      const store = (await one(`insert into stores (tenant_id, name, code) values ($1,'Main store',$2) returning id`, [t, code])).id;
      const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [t])).id;
      const owner = (await one(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Owner',$2,$3) returning id`, [t, role, crypto.randomUUID()])).id;
      await c.query(`select seed_demo_catalog($1)`, [t]);
      // the seed keeps its working tables to the end of the transaction: a second client needs them gone
      await c.query(`drop table if exists _c, _i, _g, _o, _l`);
      const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [t])).id;
      const items = (await c.query(`select id, name, price from items where tenant_id = $1 and deleted_at is null order by name`, [t])).rows;
      return { t, store, owner, cash, items };
    }
    const mine = await business(tid, 'SU1');
    const theirs = await business(other, 'SU2');
    const solo = await business(alone, 'SU3');

    // a till's operations, sent as the till service sends them
    async function push(b, ops) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [b.t]);
      try { return (await c.query('select sync_push($1, $2::jsonb) as r', [b.owner, JSON.stringify(ops)])).rows[0].r; }
      finally {
        await c.query('RESET ROLE');
        await c.query(`select set_config('app.tenant_id', '', true)`);
      }
    }
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const add = async (st) => (await one(`select platform.tablet_code_add($1, $2) as r`, [admin, st])).r;
    const redeem = async (code, device, tablet) => (await one(`select redeem_tablet_code($1, $2, $3, null, '21', null) as r`, [code, device, tablet])).r;
    const login = async (dev, key) => (await one(`select device_login($1, $2) as r`, [dev, key])).r;
    const settingUp = async (t) => (await one(`select platform.is_setting_up($1) as r`, [t])).r;
    const logged = async (t, action) => (await one(`select count(*)::int as n from platform.audit where tenant_id = $1 and action = $2`, [t, action])).n;
    let seq = 0;
    const at = (min) => new Date(Date.parse('2026-03-02T05:00:00Z') + min * 60000).toISOString();
    // a sale of one item on one till: [the order, its lines, the receipt]
    function sale(b, dev, item, qty, minute) {
      const tk = crypto.randomUUID(), rc = crypto.randomUUID();
      return {
        rc,
        ops: [
          op('ticket.create', { id: tk, store_id: b.store }),
          op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: item.id, qty }),
          op('receipt.create', { id: rc, ticket_id: tk, store_id: b.store, device_id: dev, number: 'SU-' + (++seq), device_seq: seq,
            payments: [{ payment_type_id: b.cash, amount: Math.round(Number(item.price) * qty / 1000) }], device_time: at(minute) }),
        ],
      };
    }

    // ---- S: being set up, and live ----
    {
      check('S1 a client that is made starts as one being set up', (await settingUp(tid)) && (await settingUp(other)) && (await settingUp(alone)));
      let e = await failsWith(`select platform.go_live($1, $2)`, [stranger, other]);
      check('S2 only a platform admin puts a client live', says(e, 'not-a-platform-admin'), e && e.message);
      e = await failsWith(`select platform.go_live($1, $2)`, [admin, crypto.randomUUID()]);
      check('S2 and only a client that is there', says(e, 'unknown-tenant'), e && e.message);
      await c.query(`select platform.go_live($1, $2)`, [admin, other]);
      check('S3 put live, it is no longer being set up, and that is written down', !(await settingUp(other)) && (await logged(other, 'tenant.live')) === 1);
      e = await failsWith(`select platform.go_live($1, $2)`, [admin, other]);
      check('S3 a second time says it is live already', says(e, 'already-live'), e && e.message);
      e = await failsWith(`select platform.back_to_setting_up($1, $2)`, [stranger, other]);
      check('S4 only a platform admin takes it back', says(e, 'not-a-platform-admin'), e && e.message);
      await c.query(`select platform.back_to_setting_up($1, $2)`, [admin, other]);
      check('S4 a live client with no receipt can be taken back to being set up', (await settingUp(other)) && (await logged(other, 'tenant.setting_up')) === 1);
      e = await failsWith(`select platform.back_to_setting_up($1, $2)`, [admin, other]);
      check('S4 once', says(e, 'already-setting-up'), e && e.message);
    }

    // ---- T: a till is removed ----
    let otherDev, otherKey;
    {
      const code1 = await add(mine.store);
      const dev1 = crypto.randomUUID();
      const r1 = await redeem(code1.code, dev1, 'tablet-1');
      check('T0 a tablet set up with a code is till T1', r1.ok === true && r1.code === 'T1', JSON.stringify({ ...r1, key: undefined }));
      // a code for its replacement that nobody used: it ends the first, and waits
      const moved = (await one(`select platform.tablet_code_move($1, $2) as r`, [admin, dev1])).r;
      await c.query(`select device_heard($1, 'seen', 21)`, [dev1]);

      let e = await failsWith(`select platform.remove_till($1, $2)`, [stranger, dev1]);
      check('T1 only a platform admin removes a till', says(e, 'not-a-platform-admin'), e && e.message);
      e = await failsWith(`select platform.remove_till($1, $2)`, [admin, crypto.randomUUID()]);
      check('T1 and only a till that is there', says(e, 'unknown-till'), e && e.message);

      await c.query(`select platform.remove_till($1, $2)`, [admin, dev1]);
      const left = await one(
        `select (select count(*) from pos_devices where id = $1)::int as tills,
                (select count(*) from device_keys where device_id = $1)::int as keys,
                (select count(*) from device_activity where device_id = $1)::int as heard,
                (select count(*) from tablet_codes where id = any($2))::int as codes`, [dev1, [code1.id, moved.id]]);
      check('T2 a till with nothing recorded is removed, with its key, when it was heard from and its codes',
        left.tills === 0 && left.keys === 0 && left.heard === 0 && left.codes === 0, JSON.stringify(left));
      check('T2 its key opens nothing', (await login(dev1, r1.key)).ok === false);
      check('T2 the till service is told it was removed', (await one(`select till_removed($1) as r`, [dev1])).r === true && (await one(`select till_removed($1) as r`, [crypto.randomUUID()])).r === false);
      const note = await one(`select detail from platform.audit where tenant_id = $1 and action = 'till.remove'`, [tid]);
      check('T2 and it is written down, with which till', note && note.detail.device_id === dev1 && note.detail.code === 'T1', JSON.stringify(note));
      const code2 = await add(mine.store);
      const r2 = await redeem(code2.code, crypto.randomUUID(), 'tablet-2');
      check('T3 its number is free again: the next tablet is T1, not T2', r2.ok === true && r2.code === 'T1', r2.code);

      // a till that opened a day has something recorded
      const opened = await push(mine, [op('shift.open', { id: crypto.randomUUID(), device_id: r2.device_id, opening_float: 10000, opened_at: at(1) })]);
      check('T4 (the till opens its day)', tag(opened[0]) === 'applied', tag(opened[0]));
      e = await failsWith(`select platform.remove_till($1, $2)`, [admin, r2.device_id]);
      check('T4 a till that opened a day is not removed', says(e, 'till-has-records'), e && e.message);
      check('T4 and is still there, key and all', (await login(r2.device_id, r2.key)).ok === true);
      mine.dev = r2.device_id; mine.key = r2.key; mine.codeId = code2.id;

      // a client that runs on its tablet: the server never sees what it sold
      const soloCode = await add(solo.store);
      const soloDev = crypto.randomUUID();
      await redeem(soloCode.code, soloDev, 'tablet-solo');
      await c.query(`select platform.go_live($1, $2)`, [admin, alone]);
      e = await failsWith(`select platform.remove_till($1, $2)`, [admin, soloDev]);
      check('T5 a live client that runs on its tablet keeps its till', says(e, 'till-of-live-offline'), e && e.message);
      await c.query(`select platform.back_to_setting_up($1, $2)`, [admin, alone]);
      await c.query(`select platform.remove_till($1, $2)`, [admin, soloDev]);
      check('T5 while it is being set up the till is removed', (await one(`select count(*)::int as n from pos_devices where tenant_id = $1`, [alone])).n === 0);

      // the other client's till, to see that nothing of it is touched below
      const oc = await add(theirs.store);
      otherDev = crypto.randomUUID();
      otherKey = (await redeem(oc.code, otherDev, 'tablet-other')).key;
    }

    // ---- C: a code is removed ----
    {
      const waits = await add(mine.store);
      const over = await add(mine.store);
      await c.query(`select platform.tablet_code_end($1, $2)`, [admin, over.id]);
      let e = await failsWith(`select platform.remove_code($1, $2)`, [stranger, waits.id]);
      check('C1 only a platform admin removes a code', says(e, 'not-a-platform-admin'), e && e.message);
      e = await failsWith(`select platform.remove_code($1, $2)`, [admin, crypto.randomUUID()]);
      check('C1 and only a code that is there', says(e, 'unknown-code'), e && e.message);
      e = await failsWith(`select platform.remove_code($1, $2)`, [admin, mine.codeId]);
      check('C2 a code in use is not removed: it is a tablet at work', says(e, 'code-in-use'), e && e.message);
      await c.query(`select platform.remove_code($1, $2)`, [admin, waits.id]);
      await c.query(`select platform.remove_code($1, $2)`, [admin, over.id]);
      const left = await one(`select count(*)::int as n from tablet_codes where id = any($1)`, [[waits.id, over.id]]);
      check('C3 a code that waits and one that is over are removed', left.n === 0, String(left.n));
      const unused = await redeem(waits.code, crypto.randomUUID(), 'tablet-late');
      check('C3 a removed code sets up nothing', unused.ok === false && unused.why === 'bad-code', JSON.stringify(unused));
      check('C3 and both are written down', (await logged(tid, 'tablet.code_remove')) === 2);
    }

    // ---- X: what a client was tried with is cleared ----
    {
      const [a, b, plain] = mine.items;
      // two counted products with ten each, as a delivery brought them
      await c.query(`update items set track_stock = true, cost = 2500 where id = any($1)`, [[a.id, b.id]]);
      for (const it of [a, b]) {
        await c.query(`select stock_move($1,$2,$3,null,10000,'receive',2500,'delivery',$4,$5,null)`, [tid, mine.store, it.id, crypto.randomUUID(), mine.owner]);
      }
      const level = async (it) => (await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, mine.store, it.id])).qty;
      const total = async (it) => (await one(`select stock_qty from items where id = $1`, [it.id])).stock_qty;

      // A: three sold, one of them refunded
      const s1 = sale(mine, mine.dev, a, 3000, 10);
      const p1 = await push(mine, s1.ops);
      const line = await one(`select id from receipt_lines where receipt_id = $1`, [s1.rc]);
      const back = await push(mine, [op('refund.create', { id: crypto.randomUUID(), refund_of: s1.rc, store_id: mine.store, device_id: mine.dev, number: 'SU-R' + (++seq), device_seq: seq,
        reason: 'tried', lines: [{ receipt_line_id: line.id, qty: 1000 }], payments: [{ payment_type_id: mine.cash, amount: Math.round(Number(a.price)) }] })]);
      // B: two sold, then the shelf is counted and still holds ten, then one more sold
      const s2 = sale(mine, mine.dev, b, 2000, 20);
      const p2 = await push(mine, s2.ops);
      await c.query(`select stock_count_item($1,$2,$3,10000,$4,'counted')`, [tid, mine.store, b.id, mine.owner]);
      // rung up after the count, whenever it reaches the server
      const s3 = sale(mine, mine.dev, b, 1000, 0);
      s3.ops[2].payload.device_time = new Date(Date.now() + 60000).toISOString();
      const p3 = await push(mine, s3.ops);
      // an item that is not counted, an order left open, cash, a request, the other client's sale
      const p4 = await push(mine, sale(mine, mine.dev, plain, 1000, 30).ops);
      const open = crypto.randomUUID();
      const shift = (await one(`select id from shifts where tenant_id = $1 and device_id = $2`, [tid, mine.dev])).id;
      const p5 = await push(mine, [
        op('ticket.create', { id: open, store_id: mine.store }),
        op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: open, item_id: plain.id, qty: 1000 }),
        op('cash.move', { id: crypto.randomUUID(), store_id: mine.store, device_id: mine.dev, shift_id: shift, type: 'in', amount: 2000, reason: 'change', device_time: at(40) }),
      ]);
      await c.query(`insert into till_requests (tenant_id, store_id, device_id, shift_id, kind, requested_by) values ($1,$2,$3,$4,'close_day',$5)`, [tid, mine.store, mine.dev, shift, mine.owner]);
      await c.query(`select device_heard($1, 'push', 21)`, [mine.dev]);
      const theirSale = sale(theirs, otherDev, theirs.items[0], 1000, 50);
      const p6 = await push(theirs, theirSale.ops);
      check('X0 (the sales, the refund, the open order and the cash are all taken)',
        [p1, p2, p3, p4, p5, p6, back].every((r) => r.every((o) => tag(o) === 'applied')), JSON.stringify([p1, p2, p3, p4, p5, p6, back].map((r) => r.map(tag))));
      check('X0 (stock went down with them: A 10 - 3 + 1, B 10 - 2, counted back to 10, - 1)', (await level(a)) === 8000 && (await level(b)) === 9000, `${await level(a)} ${await level(b)}`);

      const tables = (await c.query(
        `select c.table_name as t from information_schema.columns c
           join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and b.table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
      const count = async (t) => {
        const each = tables.map((tbl) => `select '${tbl}' as t, count(*)::int as n from "${tbl}" where tenant_id = $1`);
        const out = {};
        for (const r of (await c.query(each.join(' union all '), [t])).rows) out[r.t] = r.n;
        return out;
      };
      const unsorted = tables.filter((t) => !KEPT.includes(t) && !CLEARED.includes(t) && !IN_PART.includes(t));
      const gone = [...KEPT, ...CLEARED, ...IN_PART].filter((t) => !tables.includes(t));
      check('X6 every table that holds a client\'s rows is one that is kept or one that is cleared', unsorted.length === 0 && gone.length === 0, 'not said: ' + unsorted.join(', ') + '; no such table: ' + gone.join(', '));

      // who may, and when
      let e = await failsWith(`select platform.clear_test_activity($1, $2)`, [stranger, tid]);
      check('X1 only a platform admin clears', says(e, 'not-a-platform-admin'), e && e.message);
      e = await failsWith(`select platform.clear_test_activity($1, $2)`, [admin, crypto.randomUUID()]);
      check('X1 and only a client that is there', says(e, 'unknown-tenant'), e && e.message);
      e = await failsWith(`select platform.clear_test_activity($1, $2)`, [admin, alone]);
      check('X1 a client that runs on its tablet has nothing here to clear', says(e, 'client-offline'), e && e.message);
      await c.query(`select platform.go_live($1, $2)`, [admin, tid]);
      e = await failsWith(`select platform.clear_test_activity($1, $2)`, [admin, tid]);
      check('X2 a live client is not cleared', says(e, 'client-live'), e && e.message);
      e = await failsWith(`select platform.back_to_setting_up($1, $2)`, [admin, tid]);
      check('X2 and one with receipts is not taken back to being set up', says(e, 'has-receipts'), e && e.message);
      check('X2 nothing of it was touched', (await one(`select count(*)::int as n from receipts where tenant_id = $1`, [tid])).n === 5);
      // the test goes on with it being set up: the row itself, since the way back is rightly refused
      await c.query(`insert into platform.setting_up (tenant_id) values ($1)`, [tid]);

      // codes: the one the till was set up with, one that is over, and one for a new tablet that waits
      const spare = await add(mine.store);
      const done = await add(mine.store);
      await c.query(`select platform.tablet_code_end($1, $2)`, [admin, done.id]);
      const before = await count(tid), beforeOther = await count(other);
      const kept = (await c.query(`select id, reason, qty from stock_movements where tenant_id = $1 and reason not in ('sale','refund') order by id`, [tid])).rows;
      const out = (await one(`select platform.clear_test_activity($1, $2) as r`, [admin, tid])).r;
      const after = await count(tid), afterOther = await count(other);

      check('X3 it says what it cleared', Number(out.receipts) === 5 && Number(out.orders) === 5 && Number(out.tills) === 1 && Number(out.codes) === 2, JSON.stringify(out));
      const had = CLEARED.filter((t) => before[t] > 0);
      check('X3 the tables it clears had rows to clear', ['receipts', 'receipt_lines', 'receipt_payments', 'tickets', 'ticket_lines', 'shifts', 'cash_movements',
        'sync_ops_applied', 'till_requests', 'device_activity', 'device_keys', 'pos_devices'].every((t) => had.includes(t)), had.join(', '));
      const codes = (await c.query(`select id from tablet_codes where tenant_id = $1`, [tid])).rows.map((r) => r.id);
      check('X3 the codes its tills were set up with are gone, and the one that is over; the one that waits for a new tablet is kept',
        before.tablet_codes === 3 && codes.length === 1 && codes[0] === spare.id, `${before.tablet_codes} then ${codes.length}`);
      const stays = CLEARED.filter((t) => after[t] !== 0);
      check('X3 nothing is left of its orders, receipts, days, cash, tills, keys and codes', stays.length === 0, stays.join(', '));
      const changed = KEPT.filter((t) => after[t] !== before[t]);
      check('X4 its menu, staff, tables, settings and stock papers are as they were', changed.length === 0, changed.map((t) => `${t} ${before[t]} to ${after[t]}`).join(', '));
      const lost = tables.filter((t) => afterOther[t] !== beforeOther[t]);
      check('X4 the other client lost nothing', lost.length === 0 && (await login(otherDev, otherKey)).ok === true, lost.join(', '));

      check('X5 what was sold is back on the shelf: A holds ten again', (await level(a)) === 10000 && (await total(a)) === 10000, `${await level(a)} ${await total(a)}`);
      check('X5 a sale from before the shelf was counted is not put back twice: B holds ten, not twelve', (await level(b)) === 10000 && (await total(b)) === 10000, `${await level(b)} ${await total(b)}`);
      const now = (await c.query(`select id, reason, qty from stock_movements where tenant_id = $1 order by id`, [tid])).rows;
      check('X5 the sales\' and refunds\' movements are gone, the delivery and the count are kept', JSON.stringify(now) === JSON.stringify(kept) && kept.length === 3, JSON.stringify(now.map((m) => m.reason)));

      check('X7 the till\'s key opens nothing, and the till service is told it was removed', (await login(mine.dev, mine.key)).ok === false && (await one(`select till_removed($1) as r`, [mine.dev])).r === true);
      const note = await one(`select detail from platform.audit where tenant_id = $1 and action = 'tenant.clear_test'`, [tid]);
      check('X7 it is written down with how much went', note && Number(note.detail.receipts) === 5 && Number(note.detail.tills) === 1, JSON.stringify(note));
      check('X7 the client is still being set up, to be tried again', await settingUp(tid));
      const way = await one(`select coalesce(current_setting('app.purge_tenant', true), '') as v`);
      e = await failsWith(`delete from receipts where tenant_id = $1`, [other]);
      check('X8 the way through the guards is shut again: another client\'s receipt cannot be deleted', way.v === '' && e && /insert-only/.test(e.message), way.v + ' ' + (e && e.message));

      // the tablet is set up again: it starts as the first till, at the first receipt
      const fresh = await redeem(spare.code, crypto.randomUUID(), 'tablet-1-again');
      check('X9 a tablet set up afterwards, with the code that was kept, is T1 and starts its receipts from nothing', fresh.ok === true && fresh.code === 'T1' && Number(fresh.last_receipt_seq) === 0, JSON.stringify({ ...fresh, key: undefined }));
      const again = (await one(`select platform.clear_test_activity($1, $2) as r`, [admin, tid])).r;
      check('X9 and it can be cleared again, as often as it is tried', Number(again.receipts) === 0 && Number(again.tills) === 1 && Number(again.codes) === 1, JSON.stringify(again));
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `SETTING UP FAIL (${failures})` : 'SETTING UP PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
