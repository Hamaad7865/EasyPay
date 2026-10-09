// till-requests.test.cjs — migration 0091: what the back office asks of a
// till (close its day, take cash out), which the till carries out the next
// time it syncs. Who may ask and what is refused, a request reaching a pull,
// the till's answer, and a close and a cash out sent the way the till will
// send them: as the person who asked.
// Usage: node db/tests/till-requests.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, as) => ({ op_id: crypto.randomUUID(), type, payload, ...(as ? { employee_id: as } : {}) });

(async () => {
  const env = devguard.envMap();
  devguard.requireDev(env);
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Ask-Probe'), ('${other}','${other}','Ask-Other')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','ASK1') returning id`)).id;
    const otherStore = (await q1(`insert into stores (tenant_id, name, code) values ('${other}','Main','ASK2') returning id`)).id;
    const till = async (tenant, st, name, code) => (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,$3,$4) returning id`, [tenant, st, name, code])).id;
    const dev = await till(tid, store, 'Counter', 'T1');
    const old = await till(tid, store, 'Old', 'T2');
    const silent = await till(tid, store, 'Silent', 'T3');
    const idle = await till(tid, store, 'Idle', 'T4');
    const gone = await till(tid, store, 'Gone', 'T5');
    const theirs = await till(other, otherStore, 'Counter', 'T1');
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    const person = async (tenant, name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tenant, name, r])).id;
    const owner = await person(tid, 'Asha', await role('Owner', ['*']));
    const manager = await person(tid, 'Mira', await role('Manager', ['shift.open_close', 'cash.pay_in_out', 'reports.view']));
    const cashier = await person(tid, 'Ben', await role('Cashier', ['sale.create']));
    const theirRole = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [other])).id;
    const theirOwner = await person(other, 'Zed', theirRole);
    // the builds the tills said they were: 12 takes requests, 11 does not, and one never said
    for (const [d, v] of [[dev, 12], [old, 11], [idle, 12], [gone, 12], [theirs, 12]]) await c.query(`select device_heard($1, 'pull', $2)`, [d, v]);
    await c.query(`update pos_devices set deleted_at = now() where id = $1`, [gone]);

    const asApp = async (tenant, fn) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    };
    const push = (ops, as = owner) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const ask = (tenant, who, d, kind, counted, amount, reason) =>
      asApp(tenant, async () => (await c.query(`select till_request($1, $2, $3, $4, $5, $6) as id`, [who, d, kind, counted, amount, reason])).rows[0].id).then((id) => ({ id }), (e) => ({ error: e.message }));
    const cancel = (tenant, who, id) => asApp(tenant, async () => (await c.query(`select till_request_cancel($1, $2)`, [who, id]))).then(() => ({ ok: true }), (e) => ({ error: e.message }));
    const row = (id) => q1(`select device_id, store_id, shift_id, kind, counted_cash::text as counted, amount::text as amount, reason, requested_by, status, note, answered_at, server_seq::text as seq from till_requests where id = $1`, [id]);
    const openDay = async (d, float) => {
      const id = crypto.randomUUID();
      const r = await push([op('shift.open', { id, device_id: d, opening_float: float, opened_at: new Date().toISOString() })]);
      if (r[0].status !== 'applied') throw new Error('open: ' + tag(r[0]));
      return id;
    };
    let shift = await openDay(dev, 100000);
    await openDay(old, 5000);
    await openDay(silent, 5000);
    await openDay(gone, 5000);

    // R1 a request is made for the day that is open
    let first;
    {
      first = await ask(tid, manager, dev, 'close_day', null, null, null);
      const r = first.id ? await row(first.id) : null;
      check('R1 someone who may close a day asks a till to close its own', r && r.status === 'waiting' && r.kind === 'close_day' && r.device_id === dev && r.store_id === store && r.requested_by === manager, first.error || JSON.stringify(r));
      check('R1 it names the day that is open, and no count: the till closes at what it expects', r && r.shift_id === shift && r.counted === null && r.amount === null);
    }

    // R2 what is refused
    {
      const no = async (name, got, code) => check('R2 ' + name, (await got).error === code, JSON.stringify(await got));
      await no('a second closing while one waits', ask(tid, owner, dev, 'close_day', 117000, null, null), 'already-asked');
      await no('a till on a build that does not carry requests out', ask(tid, owner, old, 'close_day', null, null, null), 'till-too-old');
      await no('a till that never said its build', ask(tid, owner, silent, 'close_day', null, null, null), 'till-too-old');
      await no('a till with no day open', ask(tid, owner, idle, 'close_day', null, null, null), 'no-day-open');
      await no('a till that was deactivated', ask(tid, owner, gone, 'close_day', null, null, null), 'bad-device');
      await no('another business\'s till', ask(tid, owner, theirs, 'close_day', null, null, null), 'bad-device');
      await no('this till, asked by another business', ask(other, theirOwner, dev, 'close_day', null, null, null), 'bad-device');
      await no('someone whose role may not close a day', ask(tid, cashier, dev, 'close_day', null, null, null), 'forbidden');
      await no('someone whose role may not move cash', ask(tid, cashier, dev, 'cash_out', null, 7000, 'Ice'), 'forbidden');
      await no('a count below nothing', ask(tid, owner, dev, 'close_day', -1, null, null), 'bad-amount');
      await no('a cash out of nothing', ask(tid, owner, dev, 'cash_out', null, 0, 'Ice'), 'bad-amount');
      await no('a cash out with no amount', ask(tid, owner, dev, 'cash_out', null, null, 'Ice'), 'bad-amount');
      await no('a cash out that does not say what for', ask(tid, owner, dev, 'cash_out', null, 7000, '   '), 'reason-required');
      await no('something a till is never asked', ask(tid, owner, dev, 'open_day', null, null, null), 'bad-kind');
      check('R2 and nothing was written for any of them', (await q1(`select count(*)::int n from till_requests where tenant_id in ($1, $2)`, [tid, other])).n === 1);
    }

    // R3 a waiting request is cancelled, once
    {
      const was = (await row(first.id)).seq;
      check('R3 someone who may not close a day cannot cancel a closing', (await cancel(tid, cashier, first.id)).error === 'forbidden');
      check('R3 another business cannot cancel it', (await cancel(other, theirOwner, first.id)).error === 'bad-request');
      const done = await cancel(tid, owner, first.id);
      const r = await row(first.id);
      check('R3 it is cancelled, by anyone who could have asked', done.ok === true && r.status === 'cancelled' && r.answered_at !== null, done.error || JSON.stringify(r));
      check('R3 and the change is one a till will fetch', r.seq !== was, was + ' then ' + r.seq);
      check('R3 what is no longer waiting cannot be cancelled again', (await cancel(tid, owner, first.id)).error === 'not-waiting');
    }

    // R4 a till is sent the requests of its store
    let close;
    {
      close = await ask(tid, manager, dev, 'close_day', 117000, null, null);
      check('R4 with the cancelled one out of the way, a closing can be asked again, with a count', close.id && (await row(close.id)).counted === '117000', close.error);
      const pulled = await asApp(tid, async () => (await c.query(`select sync_pull($1::uuid, 0::bigint, 500) as r`, [store])).rows[0].r);
      const sent = pulled.changes.till_requests || [];
      const mine = sent.find((x) => x.id === close.id);
      check('R4 a pull hands the till the request: which till, which day, what, the count, who and when', mine && mine.device_id === dev && mine.shift_id === shift && mine.kind === 'close_day'
        && Number(mine.counted_cash) === 117000 && mine.requested_by === manager && mine.status === 'waiting' && typeof mine.requested_at === 'string', JSON.stringify(mine));
      check('R4 and the cancelled one as cancelled, so a till that had it does not act on it', (sent.find((x) => x.id === first.id) || {}).status === 'cancelled');
      const theirPull = await asApp(other, async () => (await c.query(`select sync_pull($1::uuid, 0::bigint, 500) as r`, [otherStore])).rows[0].r);
      check('R4 another business\'s till is sent none of it', (theirPull.changes.till_requests || []).length === 0);
    }

    // R5 the till closes the day, as the person who asked, and says so
    {
      const closedAt = new Date().toISOString();
      const r = await push([
        op('shift.close', { id: shift, counted_cash: 117000, closed_at: closedAt }, manager),
        op('day.close', { id: crypto.randomUUID(), store_id: store, device_id: dev, closed_at: closedAt }, manager),
        op('request.answer', { id: close.id, status: 'done' }, manager),
      ]);
      check('R5 the till\'s three ops are taken: the drawer\'s count, the closing, the answer', r.every((o) => o.status === 'applied'), r.map(tag).join(','));
      const sh = await q1(`select closed_by, counted_cash::text as counted from shifts where id = $1`, [shift]);
      check('R5 the day is closed by the person who asked, with their count', sh.closed_by === manager && sh.counted === '117000', JSON.stringify(sh));
      const done = await row(close.id);
      check('R5 and the request is done', done.status === 'done' && done.answered_at !== null && done.note === null, JSON.stringify(done));
      const again = await push([op('request.answer', { id: close.id, status: 'refused', note: 'too late' })]);
      check('R5 an answer to a request that is no longer waiting changes nothing', again[0].status === 'applied' && (await row(close.id)).status === 'done' && (await row(close.id)).note === null, tag(again[0]));
    }

    // R6 cash out, asked and carried out
    {
      shift = await openDay(dev, 100000);
      const out = await ask(tid, manager, dev, 'cash_out', null, 7000, '  Ice  ');
      const asked = out.id ? await row(out.id) : null;
      check('R6 a cash out is asked: how much and what for', asked && asked.kind === 'cash_out' && asked.amount === '7000' && asked.reason === 'Ice' && asked.shift_id === shift && asked.counted === null, out.error || JSON.stringify(asked));
      const more = await ask(tid, owner, dev, 'cash_out', null, 1500, 'Milk');
      check('R6 a second cash out can wait beside it', more.id !== undefined, more.error);
      const move = crypto.randomUUID();
      const r = await push([
        op('cash.move', { id: move, store_id: store, device_id: dev, shift_id: shift, type: 'out', amount: 7000, reason: 'Ice', device_time: new Date().toISOString() }, manager),
        op('request.answer', { id: out.id, status: 'done' }, manager),
      ]);
      const m = await q1(`select employee_id, amount::text as amount, type::text as type, reason from cash_movements where id = $1`, [move]);
      check('R6 the till records it as the person who asked', r.every((o) => o.status === 'applied') && m && m.employee_id === manager && m.amount === '7000' && m.type === 'out' && m.reason === 'Ice', r.map(tag).join(',') + ' ' + JSON.stringify(m));
      check('R6 and that request is done, the other still waiting', (await row(out.id)).status === 'done' && (await row(more.id)).status === 'waiting');
      const refused = await push([op('request.answer', { id: more.id, status: 'refused', note: 'That day is no longer open on the till.' })]);
      const rr = await row(more.id);
      check('R6 a till that cannot do it says why', refused[0].status === 'applied' && rr.status === 'refused' && rr.note === 'That day is no longer open on the till.', tag(refused[0]) + ' ' + JSON.stringify(rr));
    }

    // R7 an answer that is no answer
    {
      const wait = await ask(tid, owner, dev, 'cash_out', null, 500, 'Tea');
      const bad = await push([
        op('request.answer', { id: wait.id, status: 'waiting' }),
        op('request.answer', { id: crypto.randomUUID(), status: 'done' }),
        op('request.answer', { status: 'done' }),
      ]);
      check('R7 an answer must be done or refused, to a request there is', bad.map(tag).join(',') === 'rejected:bad-payload,rejected:bad-request,rejected:bad-payload', bad.map(tag).join(','));
      check('R7 and leaves the request waiting', (await row(wait.id)).status === 'waiting');
      const theirsTry = await asApp(other, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [theirOwner, JSON.stringify([op('request.answer', { id: wait.id, status: 'done' })])])).rows[0].r);
      check('R7 another business\'s till cannot answer it', tag(theirsTry[0]) === 'rejected:bad-request' && (await row(wait.id)).status === 'waiting', tag(theirsTry[0]));
    }

    // R8 another business sees none of it
    {
      const seen = await asApp(other, async () => (await c.query(`select count(*)::int n from till_requests`)).rows[0].n);
      const mine = await asApp(tid, async () => (await c.query(`select count(*)::int n from till_requests`)).rows[0].n);
      check('R8 a business sees its own requests and no others', seen === 0 && mine === 5, seen + ' and ' + mine);
    }
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
