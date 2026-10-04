// staff-shifts.test.cjs — migration 0047: who rang it up, sales periods
// (shifts), clock punches, and what the pull sends a till.
// Usage: node db/tests/staff-shifts.test.cjs
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
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SS-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SSS1') returning id`)).id;
  const store2 = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Second','SSS2') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const dev2 = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T2','T2') returning id`)).id;
  const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
  const rOwner = await role('Owner', ['*']);
  const rCashier = await role('Cashier', ['sale.create', 'payment.take', 'shift.open_close']);
  const rWaiter = await role('Waiter', ['sale.create', 'sale.void_line']);
  const emp = async (name, r, active = true) => (await q1(`insert into employees (tenant_id, name, role_id, is_active) values ($1,$2,$3,$4) returning id`, [tid, name, r, active])).id;
  const owner = await emp('Owner', rOwner);
  const cashier = await emp('Cashier', rCashier);
  const waiter = await emp('Waiter', rWaiter);
  const gone = await emp('Left last month', rCashier, false);
  await c.query(`select seed_demo_catalog('${tid}')`);
  const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const card = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Card'`)).id;

  // every statement below runs the way the API does
  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  // login = the employee the signed-in login belongs to (what the API passes)
  const push = (ops, login = owner) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [login, JSON.stringify(ops)])).rows[0].r);
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  async function sale(device, amount, type, who, at) {
    const t = crypto.randomUUID(), l = crypto.randomUUID(), rc = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: t, store_id: store }, who),
      op('ticket.add_line', { id: l, ticket_id: t, item_id: dp, qty: 1000 }, who),
      op('receipt.create', { id: rc, ticket_id: t, store_id: store, device_id: device, number: 'SSS1-X-' + (++seq), device_seq: seq,
        payments: [{ payment_type_id: type, amount }], device_time: at }, who),
    ]);
    return { t, rc, tags: r.map(tag) };
  }
  const T0 = Date.parse('2026-03-02T05:00:00Z');
  const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();

  // T1 open a sales period: no employee named, so it is the login's own
  const s1 = crypto.randomUUID();
  {
    const r = await push([op('shift.open', { id: s1, device_id: dev, opening_float: 15000, opened_at: at(0) })]);
    const row = await q1(`select opened_by, store_id, opening_float, closed_at from shifts where id = $1`, [s1]);
    check('T1 the login opens a sales period with its float', tag(r[0]) === 'applied' && row && row.opened_by === owner && row.store_id === store
      && Number(row.opening_float) === 15000 && row.closed_at === null, tag(r[0]));
  }

  // T2 one open period per till
  {
    const r = await push([op('shift.open', { id: crypto.randomUUID(), device_id: dev, opening_float: 0, opened_at: at(1) })]);
    const n = (await q1(`select count(*)::int n from shifts where tenant_id = $1 and device_id = $2`, [tid, dev])).n;
    check('T2 a second open period on the same till is refused', tag(r[0]) === 'rejected:conflict' && n === 1, tag(r[0]));
  }

  // T3 the named member of staff's permissions apply, not the login's
  const s2 = crypto.randomUUID();
  {
    const no = await push([op('shift.open', { id: crypto.randomUUID(), device_id: dev2, opening_float: 0, opened_at: at(2) }, waiter)]);
    const yes = await push([op('shift.open', { id: s2, device_id: dev2, opening_float: 5000, opened_at: at(3) }, cashier)]);
    const row = await q1(`select opened_by from shifts where id = $1`, [s2]);
    check('T3 a waiter cannot open a sales period', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T3 a cashier can, and it is recorded as theirs', tag(yes[0]) === 'applied' && row && row.opened_by === cashier, tag(yes[0]));
  }

  // T4 clock punches belong to whoever entered their PIN
  {
    const pin = crypto.randomUUID(), pout = crypto.randomUUID();
    const r = await push([
      op('timeclock.punch', { id: pin, store_id: store, device_id: dev, kind: 'in', device_time: at(4) }, cashier),
      op('timeclock.punch', { id: pout, store_id: store, device_id: dev, kind: 'out', device_time: at(200) }, cashier),
      op('timeclock.punch', { id: crypto.randomUUID(), store_id: store, device_id: dev, kind: 'sideways', device_time: at(5) }, cashier),
      op('timeclock.punch', { id: crypto.randomUUID(), store_id: crypto.randomUUID(), device_id: dev, kind: 'in', device_time: at(5) }, cashier),
    ]);
    const rows = (await c.query(`select employee_id, kind from timeclock_punches where tenant_id = $1 order by device_time`, [tid])).rows;
    check('T4 in and out are stored for that employee', tag(r[0]) === 'applied' && tag(r[1]) === 'applied' && rows.length === 2
      && rows.every((x) => x.employee_id === cashier) && rows[0].kind === 'in' && rows[1].kind === 'out', r.map(tag).join(' '));
    check('T4 a bad kind and an unknown store are refused', tag(r[2]) === 'rejected:bad-payload' && tag(r[3]) === 'rejected:bad-store', r.map(tag).join(' '));
  }

  // T5 a sale is attributed to who rang it up, at the time on the till
  let cashierSale;
  {
    cashierSale = await sale(dev, 5000, cash, cashier, at(30));
    const rc = await q1(`select employee_id, device_time from receipts where id = $1`, [cashierSale.rc]);
    const tk = await q1(`select opened_by from tickets where id = $1`, [cashierSale.t]);
    check('T5 the receipt and the order carry the cashier', cashierSale.tags.every((x) => x === 'applied') && rc.employee_id === cashier && tk.opened_by === cashier, cashierSale.tags.join(' '));
    check('T5 the receipt keeps the time of sale', new Date(rc.device_time).toISOString() === at(30), String(rc.device_time));
  }

  // T6 an id that was never this restaurant's is refused; one switched off since is not
  {
    const r = await push([
      op('ticket.create', { id: crypto.randomUUID(), store_id: store }, crypto.randomUUID()),
      op('ticket.create', { id: crypto.randomUUID(), store_id: store }, 'not-a-uuid'),
    ]);
    check('T6 unknown and malformed employee ids are refused', tag(r[0]) === 'rejected:bad-employee' && tag(r[1]) === 'rejected:bad-employee', r.map(tag).join(' '));
    const t = crypto.randomUUID();
    const ok = await push([op('ticket.create', { id: t, store_id: store }, gone)]);
    const row = await q1(`select opened_by from tickets where id = $1`, [t]);
    check('T6 a member of staff switched off since still gets their order', tag(ok[0]) === 'applied' && row.opened_by === gone, tag(ok[0]));
  }

  // T7 a login that may not set up tills cannot borrow someone else's permissions
  {
    const t = crypto.randomUUID();
    const r = await push([
      op('ticket.create', { id: t, store_id: store }, owner),
      op('shift.close', { id: s2, counted_cash: 5000, closed_at: at(40) }, owner),
    ], waiter);
    const row = await q1(`select opened_by from tickets where id = $1`, [t]);
    const still = await q1(`select closed_at from shifts where id = $1`, [s2]);
    check('T7 the op stays the lesser login\'s own (nothing lost)', tag(r[0]) === 'applied' && row.opened_by === waiter, tag(r[0]));
    check('T7 and the owner\'s permission is not borrowed', tag(r[1]) === 'rejected:forbidden' && still.closed_at === null, tag(r[1]));
  }

  // T8 the same op twice is applied once
  {
    const p = op('timeclock.punch', { id: crypto.randomUUID(), store_id: store, device_id: dev2, kind: 'in', device_time: at(50) }, waiter);
    const a = await push([p]);
    const b = await push([p]);
    const n = (await q1(`select count(*)::int n from timeclock_punches where id = $1`, [p.payload.id])).n;
    check('T8 a replayed punch is stored once', tag(a[0]) === 'applied' && b[0].replayed === true && n === 1, JSON.stringify(b[0]));
  }

  // T9 closing: expected = float + this till's cash while it was open
  {
    await sale(dev, 5000, card, cashier, at(60)); // card: not in the drawer
    await sale(dev2, 5000, cash, cashier, at(61)); // the other till's drawer
    await sale(dev, 5000, cash, owner, at(500)); // after this period closed
    const no = await push([op('shift.close', { id: s1, counted_cash: 19000, closed_at: at(120) }, waiter)]);
    const r = await push([op('shift.close', { id: s1, counted_cash: 19000, closed_at: at(120) }, cashier)]);
    const row = await q1(`select closed_by, closed_at, expected_cash, counted_cash from shifts where id = $1`, [s1]);
    check('T9 a waiter cannot close it', tag(no[0]) === 'rejected:forbidden', tag(no[0]));
    check('T9 expected cash is the float plus this till\'s cash sales in the period', tag(r[0]) === 'applied'
      && Number(row.expected_cash) === 20000 && Number(row.counted_cash) === 19000 && row.closed_by === cashier
      && new Date(row.closed_at).toISOString() === at(120), `${tag(r[0])} expected ${row.expected_cash}`);
    const again = await push([
      op('shift.close', { id: s1, counted_cash: 1, closed_at: at(130) }),
      op('shift.close', { id: crypto.randomUUID(), counted_cash: 1, closed_at: at(130) }),
    ]);
    const same = await q1(`select counted_cash from shifts where id = $1`, [s1]);
    check('T9 a closed period is not closed again; an unknown one is refused', tag(again[0]) === 'rejected:shift-closed'
      && tag(again[1]) === 'rejected:bad-shift' && Number(same.counted_cash) === 19000, again.map(tag).join(' '));
  }

  // T10 once closed, the till can open the next period
  const s3 = crypto.randomUUID();
  {
    const r = await push([op('shift.open', { id: s3, device_id: dev, opening_float: 20000, opened_at: at(600) })]);
    check('T10 the next period opens on the same till', tag(r[0]) === 'applied', tag(r[0]));
  }

  // T11 the pull: this store's periods and punches, staff with their PIN hash
  {
    const pull = (s) => asApp(tid, async () => (await c.query('select sync_pull($1::uuid, 0, 1000) as r', [s])).rows[0].r);
    const a = await pull(store);
    const b = await pull(store2);
    const ids = (rows) => (rows || []).map((x) => x.id);
    check('T11 a till gets its store\'s sales periods and punches', ids(a.changes.shifts).includes(s1) && ids(a.changes.shifts).includes(s3)
      && (a.changes.timeclock_punches || []).length === 3, `${(a.changes.shifts || []).length} shifts, ${(a.changes.timeclock_punches || []).length} punches`);
    check('T11 another store\'s till gets none of them', (b.changes.shifts || []).length === 0 && (b.changes.timeclock_punches || []).length === 0);
    check('T11 staff and roles reach both', (a.changes.employees || []).length === 4 && (b.changes.roles || []).length === 3
      && Object.prototype.hasOwnProperty.call(a.changes.employees[0], 'pin_hash'));
  }

  // T12 another restaurant sees none of it
  {
    const seen = await asApp(crypto.randomUUID(), async () => (await c.query(
      `select (select count(*)::int from shifts) a, (select count(*)::int from timeclock_punches) b`)).rows[0]);
    check('T12 sales periods and punches are tenant-scoped', seen.a === 0 && seen.b === 0, JSON.stringify(seen));
  }

  await devguard.cleanupTenant(c, tid);
  const left = await q1(`select (select count(*)::int from shifts where tenant_id = $1) a, (select count(*)::int from timeclock_punches where tenant_id = $1) b`, [tid]);
  check('cleanup removed the probe rows', left.a === 0 && left.b === 0);
  console.log(failures === 0 ? 'STAFF-SHIFTS PASS' : `STAFF-SHIFTS FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
