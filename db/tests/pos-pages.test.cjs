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
    check('W1 synced a few minutes ago is fine, day open or not', pos.tillState(mins(3), now, true, false) === 'ok' && pos.tillState(mins(30), now, false, false) === 'ok');
    check('W1 a till on and quiet for one check-in is still fine', pos.tillState(mins(16), now, true, false) === 'ok');
    check('W1 day open and nothing for over half an hour is quiet', pos.tillState(mins(31), now, true, false) === 'quiet' && pos.tillState(mins(60), now, true, false) === 'quiet');
    check('W1 day open and nothing for over an hour wants looking at', pos.tillState(mins(61), now, true, false) === 'silent');
    check('W1 day closed and not synced lately is a tablet put away, not a worry', pos.tillState(mins(600), now, false, false) === 'idle');
    check('W1 a till that never synced says so', pos.tillState(null, now, true, false) === 'never');
    check('W1 a deactivated till is that before anything else', pos.tillState(mins(1), now, true, true) === 'off' && pos.tillState(null, now, false, true) === 'off');
    check('W2 how long ago, in words', pos.ago(mins(0), now) === 'just now' && pos.ago(mins(7), now) === '7 min ago' && pos.ago(mins(120), now) === '2 h ago'
      && pos.ago(mins(135), now) === '2 h 15 min ago' && pos.ago(mins(60 * 30), now) === 'yesterday' && pos.ago(mins(60 * 24 * 9), now) === '9 days ago',
      [0, 7, 120, 135, 1800, 12960].map((n) => pos.ago(mins(n), now)).join(' | '));
    check('W2 a time in the future is not "minus" anything', pos.ago(new Date(now.getTime() + 5000), now) === 'just now');
    check('W2 a length of time', pos.span(40) === '40 s' && pos.span(720) === '12 min' && pos.span(3 * 3600 + 300) === '3 h 05 min' && pos.span(3 * 86400) === '3 days' && pos.span(-5) === '0 s',
      [40, 720, 11100, 259200].map((n) => pos.span(n)).join(' | '));
    check('W3 the line on a till never says more than is known',
      pos.stateLine('ok', mins(2), now) === 'Synced 2 min ago' && pos.stateLine('quiet', mins(44), now) === 'Quiet for 44 min'
      && pos.stateLine('silent', mins(135), now) === 'Not heard from for 2 h 15 min' && pos.stateLine('idle', mins(60 * 20), now) === 'Last synced 20 h ago'
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
      check('T1 and it reads as synced', pos.tillState(new Date(after.seen), new Date(), true, false) === 'ok');
      const none = await read(other, pos.TILLS, [tid, day]);
      check('T1 another restaurant asking for this one\'s tills gets nothing', none.length === 0, String(none.length));
    }

    // T2 the activity page
    {
      const rows = await read(tid, pos.ACTIVITY, [tid, day, null, 1000, store.timezone]);
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
      const few = await read(tid, pos.ACTIVITY, [tid, day, null, 3, store.timezone]);
      check('T2 cut to the latest few, it still says how many there are', few.length === 3 && few[0].total === 10 && few[0].kind === 'sale');
      const quiet = await read(tid, pos.ACTIVITY, [tid, day, spare, 1000, store.timezone]);
      const one = await read(tid, pos.ACTIVITY, [tid, day, dev, 1000, store.timezone]);
      check('T2 asked for one till, it is that till\'s day only', quiet.length === 0 && one.length === 10);
      const before = await read(tid, pos.ACTIVITY, [tid, '2020-01-01', null, 1000, store.timezone]);
      check('T2 another day is another day', before.length === 0);
      const peek = await read(other, pos.ACTIVITY, [tid, day, null, 1000, store.timezone]);
      check('T2 another restaurant sees none of it', peek.length === 0, String(peek.length));
    }

    // T3 the cash flow page
    {
      const days = await read(tid, pos.SHIFTS, [tid, dev]);
      check('T3 the till\'s days are offered, the open one first', days.length === 1 && days[0].id === shift && days[0].closed_at === null);
      const sh = (await read(tid, pos.SHIFT, [tid, shift]))[0];
      check('T3 the day says its float, its cash, and whose till it is', Number(sh.opening_float) === 100000 && Number(sh.cash_taken) === 10000 && Number(sh.cash_in) === 20000 && Number(sh.cash_out) === 7000 && sh.till === 'Counter' && sh.opened_by === 'Asha' && sh.close_no === null, JSON.stringify(sh));
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
      const peek2 = await read(other, pos.SHIFT, [tid, shift]);
      check('T3 another restaurant sees none of it', peek.length === 0 && peek2.length === 0);
    }

    // T4 a payment corrected from cash to card leaves the drawer
    {
      applied(await push([op('payment.correct', { id: crypto.randomUUID(), receipt_id: first.rc, from_payment_type_id: cash, to_payment_type_id: card, corrected_at: new Date().toISOString() })]), 'correction');
      const sh = (await read(tid, pos.SHIFT, [tid, shift]))[0];
      const lines = await read(tid, pos.LEDGER, [tid, shift]);
      const t = (await read(tid, pos.TILLS, [tid, day])).find((r) => r.id === dev);
      check('T4 corrected to card, that sale is no longer cash taken', Number(sh.cash_taken) === 5000 && Number(t.cash_taken) === 5000, String(sh.cash_taken));
      check('T4 nor a line of the drawer', !lines.some((l) => l.ref === first.number) && lines.filter((l) => l.kind === 'sale').length === 2);
      check('T4 and the drawer should hold that much less', Number(sh.opening_float) + lines.reduce((a, l) => a + Number(l.amount), 0) === SHOULD - 5000);
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
