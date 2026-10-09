// pos-pages.test.cjs — the back office's Point of sale pages: how a till's
// last sync reads, and that the queries the pages are drawn from say what
// happened on the till. A day is made on a probe restaurant's till the way a
// till makes it (through sync_push), then read the way the back office reads
// it (as the restaurant's own connection).
// Usage: node db/tests/pos-pages.test.cjs
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

// the page's own queries and wording, compiled from the TypeScript they live in
function loadPos() {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', 'pos.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

(async () => {
  const pos = loadPos();

  // ---- how a till's last sync reads (no database) ----
  {
    const now = new Date('2026-10-07T12:00:00Z');
    const mins = (n) => new Date(now.getTime() - n * 60000);
    check('W1 synced a few minutes ago is fine', pos.tillState(mins(3), now, false) === 'ok' && pos.tillState(mins(30), now, false) === 'ok');
    check('W1 a till in use that missed one check-in is still fine', pos.tillState(mins(16), now, false) === 'ok');
    // A till left alone stops checking in, so the database can sleep: it says
    // nothing for as long as no one is at it, and that is no fault. Nothing
    // tells it from a tablet that is off, so neither is called a worry.
    check('W1 a till that has said nothing for an hour, or a night, is at rest: not a worry',
      pos.tillState(mins(31), now, false) === 'idle' && pos.tillState(mins(61), now, false) === 'idle' && pos.tillState(mins(600), now, false) === 'idle');
    check('W1 a till that never synced says so', pos.tillState(null, now, false) === 'never');
    check('W1 a deactivated till is that before anything else', pos.tillState(mins(1), now, true) === 'off' && pos.tillState(null, now, true) === 'off');
    check('W2 how long ago, in words', pos.ago(mins(0), now) === 'just now' && pos.ago(mins(7), now) === '7 min ago' && pos.ago(mins(120), now) === '2 h ago'
      && pos.ago(mins(135), now) === '2 h 15 min ago' && pos.ago(mins(60 * 30), now) === 'yesterday' && pos.ago(mins(60 * 24 * 9), now) === '9 days ago',
      [0, 7, 120, 135, 1800, 12960].map((n) => pos.ago(mins(n), now)).join(' | '));
    check('W2 a time in the future is not "minus" anything', pos.ago(new Date(now.getTime() + 5000), now) === 'just now');
    check('W2 a length of time', pos.span(40) === '40 s' && pos.span(720) === '12 min' && pos.span(3 * 3600 + 300) === '3 h 05 min' && pos.span(3 * 86400) === '3 days' && pos.span(-5) === '0 s',
      [40, 720, 11100, 259200].map((n) => pos.span(n)).join(' | '));
    check('W3 the line on a till never says more than is known',
      pos.stateLine('ok', mins(2), now) === 'Synced 2 min ago' && pos.stateLine('idle', mins(44), now) === 'Last synced 44 min ago'
      && pos.stateLine('idle', mins(60 * 20), now) === 'Last synced 20 h ago'
      && pos.stateLine('never', null, now) === 'Not synced yet' && pos.stateLine('off', null, now) === 'Deactivated');
    check('W4 late is more than two minutes after the till wrote it', pos.isLate(121) && !pos.isLate(120) && !pos.isLate(0) && !pos.isLate(null) && !pos.isLate(-900));
    check('W5 what a drawer should hold', pos.expectedCash('100000', '5000', '20000', '7000') === 118000 && pos.expectedCash(null, null, null, null) === 0);
  }

  // ---- the queries, on a day made the way a till makes it ----
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Pos-Probe'), ('${other}','${other}','Pos-Other')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','PPS1') returning id, timezone`));
    const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','PPS2') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store.id}','Counter','T1') returning id`)).id;
    const spare = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store.id}','Spare','T2') returning id`)).id;
    const theirs = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${other}','${otherStore}','Counter','T1') returning id`)).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Asha',$2) returning id`, [tid, role])).id;
    await c.query(`select seed_demo_catalog('${tid}')`);
    const item = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
    const card = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Card'`)).id;

    const asApp = async (tenant, fn) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    };
    const push = (ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const read = (tenant, sql, args) => asApp(tenant, async () => (await c.query(sql, args)).rows);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const applied = (r, what) => { if (!r.every((o) => o.status === 'applied')) throw new Error(what + ': ' + r.map(tag).join(',')); };

    // The day: opened ten minutes ago with Rs 1,000. Everything up to the last
    // sale is stamped minutes in the past, as if the till had been offline and
    // sent it all just now; the last sale is stamped now.
    const now = Date.now();
    const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: store.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now - 10 * 60000));
    let seq = 0;
    const shift = crypto.randomUUID();
    applied(await push([op('shift.open', { id: shift, device_id: dev, opening_float: 100000, opened_at: at(10) })]), 'open');
    const sale = async (payment, minutesAgo) => {
      const tk = crypto.randomUUID(), ln = crypto.randomUUID(), rc = crypto.randomUUID();
      applied(await push([
        op('ticket.create', { id: tk, store_id: store.id }),
        op('ticket.add_line', { id: ln, ticket_id: tk, item_id: item, qty: 1000 }),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store.id, device_id: dev, number: 'PP-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: payment, amount: 5000 }], device_time: at(minutesAgo) }),
      ]), 'sale');
      return { rc, line: (await q1(`select id from receipt_lines where receipt_id = $1`, [rc])).id, number: 'PP-' + seq };
    };
    const first = await sale(cash, 9);
    await sale(card, 8);
    const back = await sale(cash, 7);
    applied(await push([op('refund.create', { id: crypto.randomUUID(), refund_of: back.rc, store_id: store.id, device_id: dev, number: 'PP-R' + (++seq), device_seq: seq,
      reason: 'wrong order', lines: [{ receipt_line_id: back.line, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }], device_time: at(6) })]), 'refund');
    const move = (type, amount, reason, minutesAgo) => op('cash.move', { id: crypto.randomUUID(), store_id: store.id, device_id: dev, shift_id: shift, type, amount, ...(reason ? { reason } : {}), device_time: at(minutesAgo) });
    applied(await push([move('in', 20000, 'Change from the bank', 5), move('out', 7000, 'Ice', 4), move('drawer', 0, null, 3.5)]), 'cash moves');
    applied(await push([op('drawer.count', { id: crypto.randomUUID(), store_id: store.id, device_id: dev, shift_id: shift, counted: 117000, expected: 118000, device_time: at(3) })]), 'count');
    const last = await sale(cash, 0);
    // what the drawer should hold: 1,000 float + 50 + 50 + 50 cash - 50 refunded + 200 in - 70 out
    const SHOULD = 100000 + 5000 + 5000 + 5000 - 5000 + 20000 - 7000;

    // T1 the tills page
    {
      const rows = await read(tid, pos.TILLS, [tid, day]);
      const t = rows.find((r) => r.id === dev);
      const s = rows.find((r) => r.id === spare);
      check('T1 a restaurant sees its own tills and no others', rows.length === 2 && t && s && !rows.some((r) => r.id === theirs), rows.map((r) => r.name).join(','));
      check('T1 the till with its day open shows it, and who opened it', t.shift_id === shift && t.opened_by === 'Asha' && Number(t.opening_float) === 100000, JSON.stringify({ shift: t.shift_id, by: t.opened_by }));
      check('T1 cash taken is cash sales less cash refunds, and no card', Number(t.cash_taken) === 10000, String(t.cash_taken));
      check('T1 cash in and cash out are what was moved, not the drawer opened with no sale', Number(t.cash_in) === 20000 && Number(t.cash_out) === 7000, t.cash_in + ' ' + t.cash_out);
      check('T1 so the drawer should hold what the till would say', pos.expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out) === SHOULD, String(pos.expectedCash(t.opening_float, t.cash_taken, t.cash_in, t.cash_out)));
      check('T1 today: four sales, one refund', t.sales === 4 && t.refunds === 1 && Number(t.gross) === 20000 && Number(t.refunded) === 5000, JSON.stringify({ sales: t.sales, refunds: t.refunds, gross: t.gross }));
      check('T1 what was rung up minutes before it arrived counts as late, and the one sent at once does not', t.late === 4 && t.worst_late >= 8 * 60 && t.worst_late < 10 * 60, t.late + ' late, worst ' + t.worst_late + ' s');
      check('T1 the last receipt is the last one rung up', t.last_number === last.number && t.last_type === 'sale', t.last_number);
      check('T1 before it has synced with its key, the last thing it sent stands in', t.synced === null && t.before_times === true && t.seen !== null);
      check('T1 a till that has done nothing has no day, no sales, and was never heard from', s.shift_id === null && s.sales === 0 && s.seen === null && s.last_number === null && s.cash_taken === null);
      await c.query(`select device_heard($1, 'pull', 5)`, [dev]);
      const after = (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === dev);
      check('T1 once it syncs, that is when it was last heard from, with its build', after.synced !== null && after.before_times === false && after.till_version === 5 && after.last_pull_at !== null && after.last_push_at === null);
      check('T1 and it reads as synced', pos.tillState(new Date(after.seen), new Date(), false) === 'ok');
      const none = await read(other, pos.TILLS, [tid, day]);
      check('T1 another restaurant asking for this one\'s tills gets nothing', none.length === 0, String(none.length));
    }

    // T2 the activity page
    {
      const rows = await read(tid, pos.ACTIVITY, [tid, day, day, null, 1000, store.timezone]);
      const kinds = rows.map((r) => r.kind);
      const count = (k) => kinds.filter((x) => x === k).length;
      check('T2 the day is all there: opened, four sales, a refund, cash in and out, the drawer opened, a count',
        count('open') === 1 && count('sale') === 4 && count('refund') === 1 && count('cash_in') === 1 && count('cash_out') === 1 && count('cash_drawer') === 1 && count('count') === 1 && rows.length === 10,
        kinds.join(','));
      check('T2 newest first', rows.every((r, i) => i === 0 || new Date(rows[i - 1].at) >= new Date(r.at)) && rows[0].kind === 'sale' && rows[rows.length - 1].kind === 'open');
      check('T2 each line says how many there are in all', rows.every((r) => r.total === 10));
      const sale1 = rows.find((r) => r.ref === first.number);
      check('T2 a sale says its number, its amount, who rang it up and on which till', sale1 && Number(sale1.amount) === 5000 && sale1.who === 'Asha' && sale1.till === 'Counter' && sale1.code === 'T1', JSON.stringify(sale1));
      check('T2 and that it reached the server minutes after it was rung up', sale1.late >= 8 * 60 && rows[0].late !== null && rows[0].late < 120, sale1.late + ' s, the last ' + rows[0].late + ' s');
      const cnt = rows.find((r) => r.kind === 'count');
      const drawer = rows.find((r) => r.kind === 'cash_drawer');
      const out = rows.find((r) => r.kind === 'cash_out');
      check('T2 a count says what was counted and what was expected', Number(cnt.amount) === 117000 && Number(cnt.extra) === 118000);
      check('T2 cash out says what for; the drawer opened with no sale has no amount', out.words === 'Ice' && Number(out.amount) === 7000 && drawer.amount === null);
      check('T2 the day opened says its float', Number(rows[rows.length - 1].amount) === 100000);
      const few = await read(tid, pos.ACTIVITY, [tid, day, day, null, 3, store.timezone]);
      check('T2 cut to the latest few, it still says how many there are', few.length === 3 && few[0].total === 10 && few[0].kind === 'sale');
      const quiet = await read(tid, pos.ACTIVITY, [tid, day, day, spare, 1000, store.timezone]);
      const one = await read(tid, pos.ACTIVITY, [tid, day, day, dev, 1000, store.timezone]);
      check('T2 asked for one till, it is that till\'s day only', quiet.length === 0 && one.length === 10);
      const before = await read(tid, pos.ACTIVITY, [tid, '2020-01-01', '2020-01-01', null, 1000, store.timezone]);
      check('T2 another day is another day', before.length === 0);
      const peek = await read(other, pos.ACTIVITY, [tid, day, day, null, 1000, store.timezone]);
      check('T2 another restaurant sees none of it', peek.length === 0, String(peek.length));
    }

    // T3 the cash flow page
    {
      const days = await read(tid, pos.DAYS, [tid, dev, 6]);
      check('T3 the till\'s days, the open one first', days.length === 1 && days[0].id === shift && days[0].closed_at === null);
      const sh = days[0];
      check('T3 the day says its float, its cash, and who opened it', Number(sh.opening_float) === 100000 && Number(sh.cash_taken) === 10000 && Number(sh.cash_in) === 20000 && Number(sh.cash_out) === 7000 && sh.opened_by === 'Asha' && sh.closed_by === null, JSON.stringify(sh));
      const lines = await read(tid, pos.LEDGER, [tid, shift]);
      const kinds = lines.map((l) => l.kind);
      check('T3 the drawer line by line, in the order it happened: cash only', kinds.join(',') === 'sale,sale,refund,cash_in,cash_out,cash_drawer,count,sale', kinds.join(','));
      check('T3 a sale paid by card is not in the drawer', lines.filter((l) => l.kind === 'sale').length === 3);
      const moved = lines.reduce((a, l) => a + Number(l.amount), 0);
      check('T3 a refund and cash out take from it; a count and an opened drawer leave it as it is',
        Number(lines[2].amount) === -5000 && Number(lines[4].amount) === -7000 && Number(lines[5].amount) === 0 && Number(lines[6].amount) === 0);
      check('T3 the lines add up to what the drawer should hold', Number(sh.opening_float) + moved === SHOULD && SHOULD === pos.expectedCash(sh.opening_float, sh.cash_taken, sh.cash_in, sh.cash_out), String(Number(sh.opening_float) + moved));
      // what the drawer held at the count: 1,000 + 50 + 50 - 50 + 200 - 70 = 1,180, which is what the till expected then
      const upToCount = Number(sh.opening_float) + lines.slice(0, 6).reduce((a, l) => a + Number(l.amount), 0);
      check('T3 at the count, the lines so far come to what the till expected then', upToCount === 118000 && Number(lines[6].expected) === 118000 && Number(lines[6].counted) === 117000, String(upToCount));
      const peek = await read(other, pos.LEDGER, [tid, shift]);
      const peek2 = await read(other, pos.DAYS, [tid, dev, 6]);
      check('T3 another restaurant sees none of it', peek.length === 0 && peek2.length === 0);
    }

    // T4 a payment corrected from cash to card leaves the drawer
    {
      applied(await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: first.rc, from_payment_type_id: cash, to_payment_type_id: card, corrected_at: new Date().toISOString() })]), 'correction');
      const sh = (await read(tid, pos.DAYS, [tid, dev, 6]))[0];
      const lines = await read(tid, pos.LEDGER, [tid, shift]);
      const t = (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === dev);
      check('T4 corrected to card, that sale is no longer cash taken', Number(sh.cash_taken) === 5000 && Number(t.cash_taken) === 5000, String(sh.cash_taken));
      check('T4 nor a line of the drawer', !lines.some((l) => l.ref === first.number) && lines.filter((l) => l.kind === 'sale').length === 2);
      check('T4 and the drawer should hold that much less', Number(sh.opening_float) + lines.reduce((a, l) => a + Number(l.amount), 0) === SHOULD - 5000);
    }

    // ---- a till's own page (after Carfection's device page) ----
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: store.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now - 86400000 - 10 * 60000));

    // T5 General: what the till took today, by payment method
    {
      const rows = await read(tid, pos.TAKEN, [tid, dev, day, store.timezone]);
      const of = (name) => Number((rows.find((r) => r.name === name) || {}).amount || 0);
      // card: the sale paid by card and the one corrected to card; cash: two sales, less the refund
      check('T5 taken today by method: a refund comes off, a corrected payment counts as what it became', of('Card') === 10000 && of('Cash') === 5000 && rows.length === 2, JSON.stringify(rows));
      check('T5 a method says what kind it is', rows.find((r) => r.name === 'Cash').kind === 'cash' && rows.find((r) => r.name === 'Card').kind === 'card');
      check('T5 another day, another till and another business took nothing here',
        (await read(tid, pos.TAKEN, [tid, dev, '2020-01-01', store.timezone])).length === 0 && (await read(tid, pos.TAKEN, [tid, spare, day, store.timezone])).length === 0
        && (await read(other, pos.TAKEN, [tid, dev, day, store.timezone])).length === 0);
    }

    // T6 Traceability: the events of a from-to range
    {
      const both = await read(tid, pos.ACTIVITY, [tid, yesterday, day, dev, 1000, store.timezone]);
      const early = await read(tid, pos.ACTIVITY, [tid, '2020-01-01', yesterday, dev, 1000, store.timezone]);
      check('T6 a range that ends today holds the day; one that ends the day before does not', both.length === 10 && early.length === 0, both.length + ' and ' + early.length);
    }

    // T7 Cash flow: every payment in and out of the till over a range
    {
      const rows = await read(tid, pos.MOVES, [tid, dev, day, day, store.timezone, 500]);
      const { inflows, outflows, inTotal, outTotal } = pos.splitMoves(rows);
      check('T7 in: the four sales, whatever they were paid with, and the cash put in', inflows.length === 5 && inTotal === 40000
        && inflows.filter((r) => r.type === 'Sale').length === 4 && inflows.filter((r) => r.method === 'Card').length === 2, inflows.map((r) => r.type + ' ' + r.method + ' ' + r.amount).join(', '));
      const cashIn = inflows.find((r) => r.type === 'Cash in');
      check('T7 cash put in says what for, and by whom', cashIn && cashIn.comment === 'Change from the bank' && cashIn.who === 'Asha' && Number(cashIn.amount) === 20000 && cashIn.method === 'Cash', JSON.stringify(cashIn));
      const refund = outflows.find((r) => r.type === 'Refund');
      const paidOut = outflows.find((r) => r.type === 'Cash out');
      check('T7 out: the refund, which names the sale it gave back, and the cash paid out', outflows.length === 2 && outTotal === 12000
        && refund && refund.ref === 'PP-R4' && refund.comment === 'Refund of ' + back.number && paidOut && paidOut.comment === 'Ice', JSON.stringify(outflows));
      check('T7 a sale says its receipt and who rang it up; the drawer opened with no sale is no movement', inflows.some((r) => r.ref === last.number && r.who === 'Asha') && !rows.some((r) => Number(r.amount) === 0));
      check('T7 newest first, and each side says how many it has in all', rows.every((r, i) => i === 0 || new Date(rows[i - 1].at) >= new Date(r.at)) && inflows.every((r) => r.total === 5) && outflows.every((r) => r.total === 2));
      const few = pos.splitMoves(await read(tid, pos.MOVES, [tid, dev, day, day, store.timezone, 2]));
      check('T7 cut to the latest two of each side, it still says how many there were', few.inflows.length === 2 && few.inflows[0].total === 5 && few.outflows.length === 2 && few.inflows[0].ref === last.number);
      check('T7 another range and another business hold none of it',
        (await read(tid, pos.MOVES, [tid, dev, '2020-01-01', yesterday, store.timezone, 500])).length === 0 && (await read(other, pos.MOVES, [tid, dev, day, day, store.timezone, 500])).length === 0);
    }

    // T8 the day is closed on the till, a thousand cents short
    {
      const open = (await read(tid, pos.DAYS, [tid, dev, 6]))[0];
      check('T8 an open day says what its drawer should hold now', open.closed_at === null && open.opened_by === 'Asha' && pos.expectedCash(open.opening_float, open.cash_taken, open.cash_in, open.cash_out) === SHOULD - 5000, JSON.stringify(open));
      check('T8 and is no cash-up yet', (await read(tid, pos.CASH_UPS, [tid, 10])).length === 0);
      const closedAt = new Date().toISOString();
      applied(await push([op('shift.close', { id: shift, counted_cash: 117000, closed_at: closedAt })]), 'shift close');
      applied(await push([op('day.close', { id: crypto.randomUUID(), store_id: store.id, device_id: dev, closed_at: closedAt })]), 'day close');
      const closedDay = new Intl.DateTimeFormat('en-CA', { timeZone: store.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(closedAt));

      const ups = await read(tid, pos.CASH_UPS, [tid, 10]);
      check('T8 once closed it is a cash-up: the till, what was expected and what was counted', ups.length === 1 && ups[0].till === 'Counter' && ups[0].code === 'T1' && ups[0].device_id === dev
        && Number(ups[0].expected_cash) === SHOULD - 5000 && Number(ups[0].counted_cash) === 117000, JSON.stringify(ups));
      check('T8 which reads as short', JSON.stringify(pos.variance(ups[0].counted_cash, ups[0].expected_cash)) === JSON.stringify({ off: -1000, tone: 'red', word: 'Short' }));
      check('T8 another business sees no cash-up of this one', (await read(other, pos.CASH_UPS, [tid, 10])).length === 0);

      const days = await read(tid, pos.DAYS, [tid, dev, 6]);
      check('T8 the till\'s latest days: closed, by whom, counted and expected', days.length === 1 && days[0].closed_at !== null && days[0].closed_by === 'Asha' && Number(days[0].counted_cash) === 117000 && Number(days[0].expected_cash) === SHOULD - 5000);
      check('T8 a till that never opened a day has none', (await read(tid, pos.DAYS, [tid, spare, 6])).length === 0);

      const closures = await read(tid, pos.CLOSURES, [tid, dev, closedDay, store.timezone]);
      const cl = closures[0];
      check('T8 the closures of that date: float, cash taken, in and out, counted, expected, by whom, its number', closures.length === 1 && cl.id === shift && Number(cl.opening_float) === 100000
        && Number(cl.cash_taken) === 5000 && Number(cl.cash_in) === 20000 && Number(cl.cash_out) === 7000 && Number(cl.counted_cash) === 117000 && Number(cl.expected_cash) === SHOULD - 5000
        && cl.closed_by === 'Asha' && cl.opened_by === 'Asha' && Number(cl.close_no) === 1, JSON.stringify(cl));
      check('T8 and what did not go in the drawer, by method', JSON.stringify(cl.non_cash) === JSON.stringify([{ name: 'Card', amount: 10000 }]), JSON.stringify(cl.non_cash));
      check('T8 no closure on another date, on another till, or for another business',
        (await read(tid, pos.CLOSURES, [tid, dev, '2020-01-01', store.timezone])).length === 0 && (await read(tid, pos.CLOSURES, [tid, spare, closedDay, store.timezone])).length === 0
        && (await read(other, pos.CLOSURES, [tid, dev, closedDay, store.timezone])).length === 0);
      const t = (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === dev);
      check('T8 and the till has no day open any more', t.shift_id === null && t.last_closed_at !== null && Number(t.last_close_no) === 1);
    }

    // T9 Settings: a till renamed and deactivated by its own business
    {
      const seqOf = async (id) => (await q1(`select server_seq::text as seq from pos_devices where id = $1`, [id])).seq;
      const was = await seqOf(spare);
      const renamed = await read(tid, pos.RENAME, [tid, spare, 'Bar']);
      check('T9 a till is renamed by its own business', renamed.length === 1 && (await q1(`select name, code from pos_devices where id = $1`, [spare])).name === 'Bar');
      check('T9 its code stays as it was: it is in every receipt number', (await q1(`select code from pos_devices where id = $1`, [spare])).code === 'T2');
      check('T9 and the change is one a tablet will fetch', (await seqOf(spare)) !== was, was + ' then ' + (await seqOf(spare)));
      const notTheirs = await read(other, pos.RENAME, [tid, spare, 'Mine']);
      const notTheirs2 = await read(other, pos.RENAME, [other, spare, 'Mine']);
      check('T9 another business cannot rename it', notTheirs.length === 0 && notTheirs2.length === 0 && (await q1(`select name from pos_devices where id = $1`, [spare])).name === 'Bar');
      const off = await read(tid, pos.SET_ACTIVE, [tid, spare, false]);
      const row = (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === spare);
      check('T9 deactivated, it reads as off', off.length === 1 && row.off === true && pos.tillState(null, new Date(), row.off) === 'off');
      await read(other, pos.SET_ACTIVE, [tid, spare, true]);
      check('T9 another business cannot reactivate it', (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === spare).off === true);
      await read(tid, pos.SET_ACTIVE, [tid, spare, true]);
      check('T9 its own business can', (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === spare).off === false);
      check('T9 a name is trimmed, and one that is empty or too long is no name', pos.cleanName('  Bar 2  ') === 'Bar 2' && pos.cleanName('   ') === null && pos.cleanName('x'.repeat(41)) === null && pos.cleanName(undefined) === null && pos.cleanName('x'.repeat(40)) !== null);
    }

    // ---- the pages themselves, drawn for this business with no sign-in (page.cjs) ----
    const { open, text, rowsOf, stats } = require('./page.cjs');
    const see = async (ctx, href, sp, more) => {
      await c.query('BEGIN');
      try { const html = await open(c, ctx, href, sp, more); return { html, says: text(html) }; }
      catch (e) { return { html: '', says: '', error: (e && e.message) || String(e) }; }
      finally { await c.query('ROLLBACK'); }
    };
    const till = (ctx, id, sp) => see(ctx, '/backoffice/pos/' + id, sp, { params: { till: id }, file: 'backoffice/pos/[till]' });
    const me = { tenantId: tid, employeeId: owner, mode: 'restaurant' };
    // someone who rings up sales and sees no reports, and may not change how a till is set up
    const plain = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Cashier','["sale.create"]'::jsonb) returning id`, [tid])).id;
    const cashier = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Ben',$2) returning id`, [tid, plain])).id;
    const ben = { tenantId: tid, employeeId: cashier, mode: 'restaurant' };
    const closedDay = new Intl.DateTimeFormat('en-CA', { timeZone: store.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    // P1 the cards
    {
      const p = await see(me, '/backoffice/pos', {});
      check('P1 Point of sale opens on a card for each till', !p.error && p.html.includes(`href="/backoffice/pos/${dev}"`) && p.html.includes(`href="/backoffice/pos/${spare}"`)
        && p.says.includes('Counter') && p.says.includes('Bar') && (p.html.match(/class="till"/g) || []).length === 2, p.error || p.says.slice(0, 200));
      check('P1 a card says when its till synced, never that it is online', /Synced (just now|\d+ min ago)/.test(p.says) && p.says.includes('Not synced yet') && !/\bonline\b/i.test(p.says), (p.says.match(/.{30}ynced.{30}/) || [''])[0]);
      check('P1 a till with no day open says so, and that a day is opened on the tablet', p.says.includes('Day closed. A day is opened on the tablet.'));
      const up = rowsOf(p.html).find((r) => r.includes('Counter'));
      check('P1 the day closed just now is a recent cash-up: expected, counted, and short', p.says.includes('Recent cash-ups') && up && up.includes('Rs 1,180.00') && up.includes('Rs 1,170.00') && up.includes('Short Rs 10.00'), up);
      check('P1 its figures: two tills, none with its day open, four sales today', stats(p.html).join(' | ').includes('Tills: 2') && stats(p.html).join(' | ').includes('Days open now: 0') && stats(p.html).join(' | ').includes('Sales today: Rs 150.00'), stats(p.html).join(' | '));
      check('P1 it is worded for a restaurant, and for a shop', p.says.includes('Every till of this restaurant') && (await see({ ...me, mode: 'retail' }, '/backoffice/pos', {})).says.includes('Every till of this shop'));
      const b = await see(ben, '/backoffice/pos', {});
      check('P1 someone who sees no reports sees the tills and no money', !b.error && b.says.includes('Counter') && !b.says.includes('Rs ') && !b.says.includes('Recent cash-ups'), b.error || (b.says.match(/.{20}Rs .{20}/) || [''])[0]);
      await read(tid, pos.SET_ACTIVE, [tid, spare, false]);
      const off = await see(me, '/backoffice/pos', {});
      check('P1 a deactivated till is in a group of its own, and can be opened', off.says.includes('Deactivated. Open it to reactivate it.') && off.html.includes('class="till off"') && off.html.includes(`href="/backoffice/pos/${spare}"`)
        && stats(off.html).join(' | ').includes('Tills: 1'), stats(off.html).join(' | '));
      await read(tid, pos.SET_ACTIVE, [tid, spare, true]);
    }

    // P2 a till's page: General
    {
      const p = await till(me, dev, {});
      check('P2 a till opens on General, with its four tabs', !p.error && ['General', 'Settings', 'Cash flow', 'Traceability'].every((t) => p.says.includes(t)) && p.html.includes(`href="/backoffice/pos/${dev}?tab=trace"`), p.error);
      const st = stats(p.html).join(' | ');
      check('P2 what it took today, in all and by method', st.includes('Taken today on this till: Rs 150.00') && p.says.includes('Cash Rs 50.00') && p.says.includes('Card Rs 100.00'), st);
      check('P2 its drawer is closed, and its last activity is the day closing', st.includes('Drawer: Closed') && p.says.includes('Day closed') && p.says.includes('Day closing no. 1'), st);
      const dayRow = rowsOf(p.html).find((r) => r.includes('Asha'));
      check('P2 its latest days: who opened it, what was counted, and short', dayRow && dayRow.includes('Rs 1,170.00') && dayRow.includes('Short Rs 10.00'), dayRow);
      check('P2 and how it has been syncing', p.says.includes('Last synced') && p.says.includes('Sent late today') && p.says.includes('App stopped, 7 days'));
      const b = await till(ben, dev, {});
      check('P2 without reports it still opens, with no money', !b.error && b.says.includes('Receipts today') && !b.says.includes('Rs '), b.error || (b.says.match(/.{20}Rs .{20}/) || [''])[0]);
      check('P2 a till that is not this business\'s, or is no till at all, is not found',
        (await till(me, theirs, {})).error === 'not found' && (await till(me, crypto.randomUUID(), {})).error === 'not found' && (await till(me, 'tills-of-mine', {})).error === 'not found');
    }

    // P3 Settings
    {
      const p = await till(me, dev, { tab: 'settings' });
      check('P3 Settings has the name to change, and Deactivate', !p.error && p.html.includes('name="name"') && p.html.includes('value="Counter"') && p.says.includes('Deactivate this till') && p.html.includes(`name="till" value="${dev}"`), p.error);
      check('P3 and says the code is not changed', p.says.includes('T1') && p.says.includes('so it is not changed'));
      const b = await till(ben, dev, { tab: 'settings' });
      check('P3 a role that may not change a till reads it and has nothing to press', !b.error && b.says.includes('Your role does not include changing how a till is set up') && !b.html.includes('<button'), b.error);
      await read(tid, pos.SET_ACTIVE, [tid, spare, false]);
      const off = await till(me, spare, { tab: 'settings' });
      check('P3 a deactivated till offers Reactivate', off.says.includes('Reactivate this till') && off.says.includes('Deactivated') && !off.says.includes('Deactivate this till'));
      await read(tid, pos.SET_ACTIVE, [tid, spare, true]);
    }

    // P4 Cash flow
    {
      const p = await till(me, dev, { tab: 'cash', ref: closedDay, from: day, to: closedDay });
      check('P4 Cash flow shows the day closed on that date, by whom, and its number', !p.error && p.says.includes('by Asha') && p.says.includes('Day closing no. 1'), p.error);
      const st = stats(p.html).join(' | ');
      check('P4 its float, cash taken, cash in and out, and what was counted', st.includes('Opening float: Rs 1,000.00') && st.includes('Cash taken: Rs 50.00') && st.includes('Cash in and out: +Rs 130.00') && st.includes('Counted at closing: Rs 1,170.00')
        && p.says.includes('expected Rs 1,180.00, short by Rs 10.00'), st);
      check('P4 what did not go in the drawer', p.says.includes('Not in the drawer') && p.says.includes('Card Rs 100.00'));
      const rows = rowsOf(p.html);
      check('P4 the drawer line by line is kept, from the float to the closing count', p.says.includes('The drawer line by line') && rows.some((r) => r.includes('Day opened') && r.includes('Opening float, as counted'))
        && rows.some((r) => r.includes('Day closed') && r.includes('Counted Rs 1,170.00')), rows.filter((r) => r.includes('Day ')).join(' // '));
      check('P4 inflows and outflows, each with its total', p.says.includes('Inflows Rs 400.00') && p.says.includes('Outflows Rs 120.00')
        && rows.some((r) => r.includes('Cash in') && r.includes('Change from the bank')) && rows.some((r) => r.includes('Refund PP-R4') && r.includes('Refund of ' + back.number)) && rows.some((r) => r.includes('Cash out') && r.includes('Ice')),
        (p.says.match(/Inflows.{0,20}/) || [''])[0] + ' / ' + (p.says.match(/Outflows.{0,20}/) || [''])[0]);
      const empty = await till(me, dev, { tab: 'cash', ref: '2020-01-01', from: '2020-01-01', to: '2020-01-01' });
      check('P4 a date with no closing says so', empty.says.includes('No day was closed on 01 Jan 2020') && empty.says.includes('Nothing came in over this period.'));
      const never = await till(me, dev, { tab: 'cash', ref: '2026-99-99', from: '2026-13-45', to: '2026-02-30' });
      check('P4 dates no calendar has open on today', !never.error && never.html.length > 200, never.error);
      check('P4 someone who sees no reports is told so', (await till(ben, dev, { tab: 'cash' })).says.includes('Your role does not include seeing reports.'));
    }

    // P5 Traceability
    {
      const p = await till(me, dev, { tab: 'trace', from: day, to: closedDay });
      const lines = (p.html.match(/<li>/g) || []).length;
      check('P5 Traceability lists everything the till did, the closing included', !p.error && lines === 11 && ['Day opened', 'Day closed', 'Sale', 'Refund', 'Cash in', 'Cash out', 'Drawer opened', 'Drawer counted'].every((k) => p.says.includes(k)), p.error || lines + ' lines');
      check('P5 under a band for the day, with what each was and who did it', p.html.includes('class="trace-day"') && p.says.includes('Opening float Rs 1,000.00') && p.says.includes('by Asha') && p.says.includes('-Rs 70.00 · Ice'));
      check('P5 and says which reached the server late', p.says.includes('Reached the server') && p.says.includes('later'));
      const quiet = await till(me, spare, { tab: 'trace' });
      check('P5 a till that did nothing says so', quiet.says.includes('Nothing recorded'), quiet.error);
      check('P5 someone who sees no reports is told so', (await till(ben, dev, { tab: 'trace' })).says.includes('Your role does not include seeing reports.'));
    }

    // P6 the addresses there used to be
    {
      const went = async (href, sp) => (await see(me, href, sp)).error;
      check('P6 Tills goes to the cards', (await went('/backoffice/pos/tills', {})) === 'redirect /backoffice/pos');
      check('P6 Till activity goes to that till\'s Traceability, on its day', (await went('/backoffice/pos/activity', { till: dev, day })) === `redirect /backoffice/pos/${dev}?tab=trace&from=${day}&to=${day}`, await went('/backoffice/pos/activity', { till: dev, day }));
      check('P6 Cash flow goes to that till\'s Cash flow', (await went('/backoffice/pos/cash', { till: dev })) === `redirect /backoffice/pos/${dev}?tab=cash`);
      check('P6 and with no till named, to the cards', (await went('/backoffice/pos/activity', {})) === 'redirect /backoffice/pos' && (await went('/backoffice/pos/cash', { day: '2026-99-99' })) === 'redirect /backoffice/pos');
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
