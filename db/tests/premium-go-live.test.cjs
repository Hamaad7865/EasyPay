// premium-go-live.test.cjs — migration 0157: a Premium (or trial) business that
// is being set up goes live from its tablet, or from /admin, as an offline
// tablet does: the test sales go, what they took off the shelves is put back,
// the tills stay signed in, and every till is told to empty itself.
// The owner's case: 100 of a product imported, 2 sold to try, Go live: 100.
// Everything runs in one transaction that is rolled back.
// Usage: node db/tests/premium-go-live.test.cjs
//   WITH_MIGRATION=<file name> applies that migration inside the transaction
//   first, to try it before it is applied to the branch.
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
// a change as a till of this build sends it: with when it was made (`at`, ms)
// at: when the till made it, by its own clock; sent: the till's clock as it sent it
const op = (type, payload, at, sent) => ({ op_id: crypto.randomUUID(), type, payload, ...(at === undefined ? {} : { at }), ...(sent === undefined ? {} : { sent }) });
const RUNG_UP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'go-live', 'rung-up.json'), 'utf8')).kinds;

// Every table that holds a client's rows: Go live keeps it, clears it, or
// clears a part of it. A table added later is in none, and G9 fails until
// someone has said which it is.
const KEPT = [
  'tenants', 'stores', 'roles', 'employees', 'employee_stores',
  'categories', 'items', 'item_variants', 'item_taxes', 'item_modifier_groups', 'modifier_groups', 'modifiers',
  'item_price_changes', 'store_item_overrides', 'barcode_counters', 'taxes', 'discounts', 'dining_options', 'payment_types',
  'grid_pages', 'grid_page_items', 'tables', 'floor_elements', 'printers', 'pos_settings', 'customers', 'suppliers',
  'stock_levels', 'purchase_orders', 'purchase_order_lines', 'deliveries', 'delivery_lines',
  'stock_counts', 'stock_count_lines', 'doc_counters', 'stock_transfers', 'stock_transfer_lines',
  'promotions', 'crash_reports', 'pictures', 'mra_records',
  'assistant_codes', 'assistant_grants', 'assistant_calls', 'assistant_proposals', 'assistant_log',
  // unlike Clear test activity, the tills stay: their keys, their codes, when they were heard from
  'pos_devices', 'device_keys', 'device_activity', 'tablet_codes',
  // what the back office asked of a till, with what was done of it (kept by Delete all transactions too)
  'till_requests',
  // the changes already taken: a till sending one again is answered, never given it twice
  'sync_ops_applied',
];
const CLEARED = [
  'bookings', 'approvals', 'drawer_counts', 'payment_corrections', 'day_closes', 'cash_movements',
  'receipt_reviews', 'receipt_discounts', 'receipt_payments', 'receipt_line_taxes', 'receipt_line_modifiers',
  'receipt_lines', 'receipts', 'ticket_line_taxes', 'ticket_line_modifiers', 'ticket_lines', 'tickets',
  'timeclock_punches', 'shifts',
  'credit_notes', 'deposits', 'deposit_lines', 'deposit_payments',
  'account_bills', 'account_payments', 'account_payment_lines',
];
// stock_movements: the sales, refunds and deposits go, the import, deliveries and counts stay
const IN_PART = ['stock_movements'];

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  // NOTICES=1 prints what the database warns of (sync_push names an op it did not expect)
  if (process.env.NOTICES) c.on('notice', (n) => console.log('NOTICE ' + n.message));
  await c.query('BEGIN');
  let sp = 0;
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
      await c.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', process.env.WITH_MIGRATION), 'utf8'));
    }
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'premium-go-live-test@example.com')`, [admin]);
    const tid = crypto.randomUUID(), other = crypto.randomUUID(), alone = crypto.randomUUID(), viaAdmin = crypto.randomUUID();
    await c.query(
      `insert into tenants (id, tenant_id, name, plan) values ($1,$1,'Go Live Essai','premium'), ($2,$2,'Other Live Essai','premium'),
         ($3,$3,'Alone Live Essai','offline'), ($4,$4,'Admin Live Essai','trial')`,
      [tid, other, alone, viaAdmin]);

    async function business(t, code) {
      const store = (await one(`insert into stores (tenant_id, name, code) values ($1,'Main store',$2) returning id`, [t, code])).id;
      const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [t])).id;
      const owner = (await one(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Owner',$2,$3) returning id`, [t, role, crypto.randomUUID()])).id;
      const crole = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Cashier','["sale.create","sale.refund"]'::jsonb) returning id`, [t])).id;
      const cashier = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cashier',$2) returning id`, [t, crole])).id;
      await c.query(`select seed_demo_catalog($1)`, [t]);
      await c.query(`drop table if exists _c, _i, _g, _o, _l`);
      const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [t])).id;
      const items = (await c.query(`select id, name, price from items where tenant_id = $1 and deleted_at is null order by name`, [t])).rows;
      return { t, store, owner, cashier, cash, items };
    }
    const mine = await business(tid, 'GL1');
    const theirs = await business(other, 'GL2');
    const solo = await business(alone, 'GL3');
    const adm = await business(viaAdmin, 'GL4');

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
    const redeem = async (code, device, tablet) => (await one(`select redeem_tablet_code($1, $2, $3, null, '50', null) as r`, [code, device, tablet])).r;
    const login = async (dev, key) => (await one(`select device_login($1, $2) as r`, [dev, key])).r;
    const settingUp = async (t) => (await one(`select platform.is_setting_up($1) as r`, [t])).r;
    const settings = async (t) => (await one(`select data from pos_settings where tenant_id = $1`, [t]))?.data ?? {};
    let seq = 0;
    function sale(b, dev, item, qty, at, sent) {
      const tk = crypto.randomUUID(), rc = crypto.randomUUID();
      return {
        rc,
        ops: [
          op('ticket.create', { id: tk, store_id: b.store }, at, sent),
          op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: item.id, qty }, at, sent),
          op('receipt.create', { id: rc, ticket_id: tk, store_id: b.store, device_id: dev, number: 'GL-' + (++seq), device_seq: seq,
            payments: [{ payment_type_id: b.cash, amount: Math.round(Number(item.price) * qty / 1000) }], device_time: new Date(at ?? Date.now()).toISOString() }, at, sent),
        ],
      };
    }
    // two tills of the business, set up with codes, as a tablet is
    async function till(b, name) {
      const code = await add(b.store);
      const dev = crypto.randomUUID();
      const r = await redeem(code.code, dev, name);
      await c.query(`select device_heard($1, 'push', 50)`, [dev]);
      return { dev, key: r.key, ok: r.ok };
    }

    // ---- B: the tills are told the business is being set up ----
    {
      check('B1 a client that is made starts as one being set up, and its tills read it in the settings',
        (await settingUp(tid)) && (await settings(tid)).settingUp === true && (await settings(viaAdmin)).settingUp === true,
        JSON.stringify(await settings(tid)));
      const before = (await one(`select server_seq from pos_settings where tenant_id = $1`, [other])).server_seq;
      await c.query(`delete from platform.setting_up where tenant_id = $1`, [other]);
      const after = await one(`select data, server_seq from pos_settings where tenant_id = $1`, [other]);
      check('B2 live: the settings no longer say so, and the tills pull the change', !('settingUp' in after.data) && Number(after.server_seq) > Number(before), `${before} to ${after.server_seq}`);
      await c.query(`select platform.back_to_setting_up($1, $2)`, [admin, other]);
      check('B3 back to setting up: the settings say so again', (await settings(other)).settingUp === true);
    }

    const [x, y] = mine.items;
    const level = async (it, b = mine) => (await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [b.t, b.store, it.id]))?.qty;
    const total = async (it) => (await one(`select stock_qty from items where id = $1`, [it.id])).stock_qty;
    const t1 = await till(mine, 'tablet-1');
    const t2 = await till(mine, 'tablet-2');

    // ---- G: the owner's case ----
    {
      // 100 of x imported, as an import or a delivery brings it
      await c.query(`update items set track_stock = true, cost = 2500 where id = any($1)`, [[x.id, y.id]]);
      await c.query(`select stock_move($1,$2,$3,null,100000,'receive',2500,'delivery',$4,$5,null)`, [tid, mine.store, x.id, crypto.randomUUID(), mine.owner]);
      await c.query(`select stock_move($1,$2,$3,null,10000,'receive',2500,'delivery',$4,$5,null)`, [tid, mine.store, y.id, crypto.randomUUID(), mine.owner]);
      const tried = Date.now() - 60 * 60000;
      const s1 = sale(mine, t1.dev, x, 1000, tried);
      const s2 = sale(mine, t2.dev, x, 1000, tried + 60000);
      const p = [...await push(mine, s1.ops), ...await push(mine, s2.ops)];
      check('G0 (two test sales of one each are taken, on two tills)', p.every((o) => tag(o) === 'applied'), JSON.stringify(p.map(tag)));
      check('G0 (and x holds 98)', Number(await level(x)) === 98000, String(await level(x)));
      await c.query(`update pos_devices set last_receipt_seq = 7 where tenant_id = $1`, [tid]);

      // who may
      const byCashier = op('business.go_live', {}, Date.now());
      byCashier.employee_id = mine.cashier;
      let r = (await push(mine, [byCashier]))[0];
      check('G1 only the owner goes live from a till', tag(r) === 'rejected:forbidden', tag(r));
      check('G1 and nothing was cleared', Number(await level(x)) === 98000 && (await settingUp(tid)));

      const tables = (await c.query(
        `select c.table_name as t from information_schema.columns c
           join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
          where c.table_schema = 'public' and c.column_name = 'tenant_id' and b.table_type = 'BASE TABLE' order by 1`)).rows.map((q) => q.t);
      const count = async (t) => {
        const each = tables.map((tbl) => `select '${tbl}' as t, count(*)::int as n from "${tbl}" where tenant_id = $1`);
        const out = {};
        for (const q of (await c.query(each.join(' union all '), [t])).rows) out[q.t] = q.n;
        return out;
      };
      const unsorted = tables.filter((t) => !KEPT.includes(t) && !CLEARED.includes(t) && !IN_PART.includes(t));
      const gone = [...KEPT, ...CLEARED, ...IN_PART].filter((t) => !tables.includes(t));
      check('G9 every table that holds a client\'s rows is one Go live keeps or one it clears', unsorted.length === 0 && gone.length === 0, 'not said: ' + unsorted.join(', ') + '; no such table: ' + gone.join(', '));

      const before = await count(tid), beforeOther = await count(other);
      const kept = (await c.query(`select id, reason, qty from stock_movements where tenant_id = $1 and reason not in ('sale','refund','deposit','deposit_release') order by id`, [tid])).rows;
      const pressed = Date.now();
      // someone else at the till, with the owner's PIN typed (the tablet asks for it)
      const approved = op('business.go_live', { device_id: t1.dev, approved_by: mine.owner }, pressed);
      approved.employee_id = mine.cashier;
      r = (await push(mine, [approved]))[0];
      check('G2 the cashier goes live from a till, the owner\'s PIN typed', tag(r) === 'applied', JSON.stringify(r));
      check('G2 it says what went', r.data && Number(r.data.receipts) === 2 && Number(r.data.orders) === 2, JSON.stringify(r.data));
      check('G3 x holds 100 again, on the shelf and in its total', Number(await level(x)) === 100000 && Number(await total(x)) === 100000, `${await level(x)} ${await total(x)}`);
      check('G3 y, not sold, holds its 10', Number(await level(y)) === 10000);
      const after = await count(tid), afterOther = await count(other);
      const stays = CLEARED.filter((t) => after[t] !== 0);
      // the owner's PIN typed for Go live itself is written down after it, as every approval is
      const left = (await c.query(`select op_type from approvals where tenant_id = $1`, [tid])).rows.map((q) => q.op_type);
      check('G4 nothing is left of its orders, receipts, days and cash', stays.filter((t) => t !== 'approvals').length === 0 && left.join() === 'business.go_live', stays.join(', ') + ' / approvals: ' + left.join(', '));
      const changed = KEPT.filter((t) => t !== 'pos_settings' && t !== 'stock_levels' && t !== 'items' && t !== 'sync_ops_applied' && after[t] !== before[t]);
      check('G4 its menu, staff, settings, stock papers and tills are as they were', changed.length === 0, changed.map((t) => `${t} ${before[t]} to ${after[t]}`).join(', '));
      const now = (await c.query(`select id, reason, qty from stock_movements where tenant_id = $1 order by id`, [tid])).rows;
      check('G4 the sales\' movements are gone, the deliveries kept', JSON.stringify(now) === JSON.stringify(kept) && kept.length === 2, JSON.stringify(now.map((m) => m.reason)));
      const lost = tables.filter((t) => afterOther[t] !== beforeOther[t]);
      check('G4 the other client lost nothing', lost.length === 0, lost.join(', '));
      check('G5 both tills are still signed in: their keys open them', (await login(t1.dev, t1.key)).ok === true && (await login(t2.dev, t2.key)).ok === true);
      check('G5 and their bills number from 1 again', (await one(`select max(last_receipt_seq)::int as n from pos_devices where tenant_id = $1`, [tid])).n === 0);
      const s = await settings(tid);
      check('G6 the business is live, and its settings say so', !(await settingUp(tid)) && !('settingUp' in s), JSON.stringify(s));
      check('G6 the tills are told to empty themselves (cleared) and since when the business is live (live, ms)',
        typeof s.cleared === 'string' && Number.isInteger(s.live) && s.live >= pressed - 5000 && Math.abs(Date.parse(s.cleared) - s.live) < 1000, JSON.stringify({ cleared: s.cleared, live: s.live }));
      check('G6 the answer carries the same marks', r.data.cleared === s.cleared && Number(r.data.live) === s.live, JSON.stringify(r.data));
      const note = await one(`select detail from platform.audit where tenant_id = $1 and action = 'tenant.live' and detail ? 'cleared'`, [tid]);
      check('G7 it is written down: who, from which till, how much went', note && note.detail.employee_id === mine.cashier && note.detail.approved_by === mine.owner && note.detail.device_id === t1.dev && Number(note.detail.receipts) === 2, JSON.stringify(note));
      r = (await push(mine, [op('business.go_live', {}, Date.now())]))[0];
      check('G8 a second time says it is live already', tag(r) === 'rejected:already-live', tag(r));

      // ---- L: what a till sends after Go live ----
      // a test sale a till rang up before Go live, still in its queue (it was off): dropped
      const late = sale(mine, t2.dev, x, 1000, tried + 120000);
      const pl = await push(mine, late.ops);
      check('L1 a test sale that reaches the server after Go live is answered, and dropped',
        pl.every((o) => tag(o) === 'applied' && o.data && o.data.dropped === 'before-go-live') && (await one(`select count(*)::int as n from receipts where id = $1`, [late.rc])).n === 0,
        JSON.stringify(pl.map((o) => tag(o) + ' ' + JSON.stringify(o.data))));
      check('L1 and takes nothing off the shelf', Number(await level(x)) === 100000, String(await level(x)));
      const again = await push(mine, s1.ops);
      check('L2 one the server had already taken, sent again, is answered as before and not taken again',
        again.every((o) => o.replayed === true) && (await one(`select count(*)::int as n from receipts where id = $1`, [s1.rc])).n === 0, JSON.stringify(again.map(tag)));
      // every kind that was rung up is dropped so, whatever it carries
      const kinds = await push(mine, RUNG_UP.map((k) => op(k, { nothing: true }, tried)));
      const missed = RUNG_UP.filter((k, i) => !(tag(kinds[i]) === 'applied' && kinds[i].data && kinds[i].data.dropped === 'before-go-live'));
      check('L3 every kind of change that was rung up is dropped when made before Go live', missed.length === 0, missed.join(', '));
      // what was set up before Go live still goes up: a price changed on the till while it was off
      const price = await push(mine, [op('item.set_price', { item_id: y.id, price: 123400 }, tried)]);
      check('L4 a change of the set-up made before Go live is taken', tag(price[0]) === 'applied' && !(price[0].data && price[0].data.dropped)
        && Number((await one(`select price from items where id = $1`, [y.id])).price) === 123400, JSON.stringify(price[0]));
      // the first real sale
      const real = sale(mine, t1.dev, x, 1000, Date.now() + 1000);
      const pr = await push(mine, real.ops);
      check('L5 a sale made after Go live is a sale', pr.every((o) => tag(o) === 'applied' && !(o.data && o.data.dropped)) && Number(await level(x)) === 99000, `${JSON.stringify(pr.map(tag))} ${await level(x)}`);
      // a tablet's clock can be off: when a change was made is read against the till's own clock as it sent
      // it (sent), so that it is the server's moment that is set against live
      const slow = Date.now() - 60 * 60000;
      const ps = await push(mine, sale(mine, t1.dev, x, 1000, slow, slow).ops);
      check('L8 a sale made after Go live on a till whose clock is an hour slow is a sale',
        ps.every((o) => tag(o) === 'applied' && !(o.data && o.data.dropped)) && Number(await level(x)) === 98000, `${JSON.stringify(ps.map((o) => tag(o) + ' ' + JSON.stringify(o.data)))} ${await level(x)}`);
      // rung up a minute before Go live, on a clock that reads an hour more: "after" live by that clock
      const pf = await push(mine, sale(mine, t2.dev, x, 1000, s.live - 60000 + 60 * 60000, Date.now() + 60 * 60000).ops);
      check('L9 a test sale made before Go live on a till whose clock is an hour fast is dropped',
        pf.every((o) => tag(o) === 'applied' && o.data && o.data.dropped === 'before-go-live') && Number(await level(x)) === 98000, `${JSON.stringify(pf.map(tag))} ${await level(x)}`);
      const stored = (await one(`select result from sync_ops_applied where op_id = $1`, [late.ops[2].op_id])).result;
      check('L10 what is dropped is kept whole on the server, and is not sent back to the till',
        stored.dropped_op && stored.dropped_op.type === 'receipt.create' && stored.dropped_op.payload.id === late.rc && !('dropped_op' in pl[2]), JSON.stringify(Object.keys(stored)));
      // a till of an older build says nothing of when; the till service holds it back until it is updated (hello.ts)
      const old = sale(mine, t2.dev, y, 1000);
      const po = await push(mine, old.ops);
      check('L6 a change that does not say when it was made is taken as it always was', po.every((o) => tag(o) === 'applied' && !(o.data && o.data.dropped)), JSON.stringify(po.map(tag)));
      check('L7 a business that never went live this way drops nothing', (await push(theirs, sale(theirs, crypto.randomUUID(), theirs.items[0], 1000, tried).ops)).every((o) => !(o.data && o.data.dropped)));
      r = (await push(theirs, [op('business.go_live', {}, Date.now())]))[0];
      check('G10 the owner goes live from a till, with no PIN asked', tag(r) === 'applied' && !(await settingUp(other)), tag(r));
    }

    // ---- A: /admin's Go live is the same for a client in the cloud ----
    {
      const [x2] = adm.items;
      const ta = await till(adm, 'tablet-a');
      await c.query(`update items set track_stock = true where id = $1`, [x2.id]);
      await c.query(`select stock_move($1,$2,$3,null,100000,'receive',2500,'delivery',$4,$5,null)`, [viaAdmin, adm.store, x2.id, crypto.randomUUID(), adm.owner]);
      await push(adm, sale(adm, ta.dev, x2, 2000, Date.now() - 60000).ops);
      check('A0 (a trial client sold two)', Number(await level(x2, adm)) === 98000);
      await c.query(`select platform.go_live($1, $2)`, [admin, viaAdmin]);
      check('A1 /admin\'s Go live clears it, puts the stock back, and keeps its till',
        Number(await level(x2, adm)) === 100000 && (await one(`select count(*)::int as n from receipts where tenant_id = $1`, [viaAdmin])).n === 0
          && (await login(ta.dev, ta.key)).ok === true && !(await settingUp(viaAdmin)),
        `${await level(x2, adm)}`);
      const s = await settings(viaAdmin);
      check('A1 its tills are told', typeof s.cleared === 'string' && Number.isInteger(s.live) && !('settingUp' in s), JSON.stringify(s));
      const note = await one(`select admin_auth_user_id as who, detail from platform.audit where tenant_id = $1 and action = 'tenant.live' and detail ? 'cleared'`, [viaAdmin]);
      check('A2 written down as the admin\'s', note && note.who === admin, JSON.stringify(note));
      const e = await failsWith(`select platform.go_live($1, $2)`, [admin, viaAdmin]);
      check('A3 a second time says it is live already', says(e, 'already-live'), e && e.message);
      // an offline client's trying is on its tablet: /admin only says it is live, as before
      await c.query(`select platform.go_live($1, $2)`, [admin, alone]);
      const so = await settings(alone);
      check('A4 an offline client is put live and nothing is cleared or marked', !(await settingUp(alone)) && !('live' in so) && !('cleared' in so), JSON.stringify(so));
      // from a till of an offline client (one that has a key, at Connect): its sales are on the tablet
      await c.query(`select platform.back_to_setting_up($1, $2)`, [admin, alone]);
      const r = (await push(solo, [op('business.go_live', {}, Date.now())]))[0];
      check('A5 a till of an offline client does not go live through the server', tag(r) === 'rejected:client-offline', tag(r));
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `PREMIUM GO LIVE FAIL (${failures})` : 'PREMIUM GO LIVE PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
