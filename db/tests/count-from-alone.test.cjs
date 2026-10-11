// count-from-alone.test.cjs — migration 0103: a count completed on a tablet
// that worked on its own is right the day its queue is sent.
//
// The tablet's changes reach the server in order, long after they were made:
// a delivery received a month ago is written now. A count takes "what moved
// since the line was counted" into its sum, and for anything but a sale the
// server reads when the movement was written, so it took that delivery for
// one that came after the count. The tablet now says what moved (`moved`, on
// each counted line), and that is used; a line that does not say is worked
// out as before.
//
// Everything runs in one transaction that is rolled back.
// Usage: node db/tests/count-from-alone.test.cjs
//   WITH_MIGRATION=db/migrations/0103_count_from_a_tablet_alone.sql runs that
//   file inside the same transaction first, to try it before it is applied.
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const id = () => crypto.randomUUID();

(async () => {
  const env = devguard.envMap();
  devguard.requireDev(env);
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const q1 = async (sql, p) => (await c.query(sql, p)).rows[0];
  try {
    if (process.env.WITH_MIGRATION) await c.query(fs.readFileSync(process.env.WITH_MIGRATION, 'utf8'));

    const tid = id();
    await c.query(`insert into tenants (id, tenant_id, name, plan, business_type) values ($1,$1,'Count Alone','premium','retail')`, [tid]);
    const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main','CA1') returning id`, [tid])).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select ensure_pos_basics($1)`, [tid]);
    const item = async (name) => (await q1(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,$2,10000,4500,true) returning id`, [tid, name])).id;
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const level = async (it) => (await q1(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3`, [tid, store, it]) || {}).qty;
    const line = async (count, it) => q1(`select counted, expected, diff, till_moved from stock_count_lines where tenant_id = $1 and count_id = $2 and item_id = $3`, [tid, count, it]);
    const push = async (ops) => (await q1(`select sync_push($1, $2::jsonb) as r`, [owner, JSON.stringify(ops)])).r.map((o) => o.status + (o.code ? ':' + o.code : ''));
    const op = (type, payload) => ({ op_id: id(), type, payload, employee_id: owner });
    const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
    const past = new Date(Date.now() - 30 * 86400000);            // a month ago, by the tablet
    const later = new Date(past.getTime() + 3600000);            // an hour after that
    const delivery = (it, qty) => op('delivery.receive', { id: id(), store_id: store, order_id: '', supplier_id: '', arrived_on: iso(past).slice(0, 10), invoice_no: '', note: '', lines: [{ item_id: it, variant_id: '', qty, unit_cost: 4500 }] });
    const count = (cid, lines, uncounted = 'leave') => op('count.complete', { id: cid, store_id: store, scope_kind: 'all', scope_id: '', scope_text: '', started_at: iso(past), clock_ahead_ms: 0, uncounted, lines });
    const counted = (it, n, at, extra = {}) => ({ item_id: it, variant_id: '', counted: n, counted_at: n === null ? null : iso(at), left_out: false, ...extra });

    // A: the queue of a tablet that worked on its own, sent in one go: ten received, then ten counted
    {
      const soap = await item('Soap'), cnt = id();
      const said = await push([delivery(soap, 10000), count(cnt, [counted(soap, 10000, later, { moved: 0 })])]);
      check('A1 both are taken', said.join() === 'applied,applied', said.join());
      check('A1 ten received and ten counted is ten on the shelf, not twenty', (await level(soap)) === 10000, String(await level(soap)));
      const l = await line(cnt, soap);
      check('A1 the line keeps what the tablet said moved, and shows no difference', l.till_moved === 0 && l.expected === 10000 && l.diff === 0, JSON.stringify(l));
    }

    // B: counted nine when it held ten, and one more went out before the count was completed
    {
      const rice = await item('Rice'), cnt = id();
      const out = op('stock.adjust', { store_id: store, item_id: rice, variant_id: '', units: 1000, direction: 'out', reason: 'damaged', note: '' });
      const said = await push([delivery(rice, 10000), out, count(cnt, [counted(rice, 9000, later, { moved: -1000 })])]);
      check('B1 all three are taken', said.join() === 'applied,applied,applied', said.join());
      // nine were there when it was counted and one has gone since: eight, as on the tablet
      check('B1 what went out after the line was counted stays out: eight', (await level(rice)) === 8000, String(await level(rice)));
      const l = await line(cnt, rice);
      check('B1 it was one short of the ten held when it was counted', l.till_moved === -1000 && l.expected === 10000 && l.diff === -1000, JSON.stringify(l));
      const moves = (await c.query(`select reason, qty from stock_movements where tenant_id = $1 and item_id = $2 order by created_at, reason`, [tid, rice])).rows.map((m) => m.reason + ':' + m.qty).sort().join();
      check('B1 and the stock history has the count\'s one correction', moves === 'count:-1000,damaged:-1000,receive:10000', moves);
    }

    // C: a line that does not say what moved is worked out by the server itself, as before 0103
    {
      const tea = await item('Tea'), cnt = id();
      // counted after the delivery was written (a linked till: things are written when they happen)
      const soon = new Date(Date.now() + 600000);
      let said = await push([delivery(tea, 10000), count(cnt, [counted(tea, 7000, soon)])]);
      check('C1 a linked till\'s count, with no word of what moved: taken', said.join() === 'applied,applied', said.join());
      check('C1 nothing was written after it was counted, so the shelf is what was counted', (await level(tea)) === 7000, String(await level(tea)));
      check('C1 and the line says nothing was said', (await line(cnt, tea)).till_moved === null);
      // the same with a moment in the past: the delivery is written after it, and is added, as it always was
      const milk = await item('Milk'), cnt2 = id();
      said = await push([delivery(milk, 10000), count(cnt2, [counted(milk, 10000, later)])]);
      check('C2 without the tablet\'s word a delivery written after the moment of counting is added: why the tablet says it', (await level(milk)) === 20000, String(await level(milk)));
    }

    // D: what is not a number is not taken, and a line nobody counted keeps no word
    {
      const salt = await item('Salt'), oil = await item('Oil'), cnt = id();
      let said = await push([count(id(), [counted(salt, 1000, later, { moved: 'a few' })])]);
      check('D1 a word that is no whole number is a bad payload', said.join() === 'rejected:bad-payload', said.join());
      said = await push([delivery(salt, 5000), delivery(oil, 5000), count(cnt, [counted(salt, 5000, later, { moved: 0 }), counted(oil, null, later, { moved: 3000 })], 'zero')]);
      check('D2 a count with a line nobody counted, set to nothing: taken', said.join() === 'applied,applied,applied', said.join());
      check('D2 the counted line stands and the uncounted one is nothing', (await level(salt)) === 5000 && (await level(oil)) === 0, `${await level(salt)} ${await level(oil)}`);
      check('D2 and what was said of the uncounted line is not kept', (await line(cnt, oil)).till_moved === null);
    }
  } catch (e) {
    failures++;
    console.log('FAIL the suite stopped: ' + (e && e.message));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'COUNT FROM ALONE PASS' : `COUNT FROM ALONE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
