// refund-order-line.test.cjs — migration 0060: a refund of part of a receipt
// names its lines by the order's lines, which is all a till knows them by.
// The amounts are worked out here with the till's formula (the same one as in
// refund-shares.test.cjs) and must be what the server accepts, to the cent.
// Usage: node db/tests/refund-order-line.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

// --- the till-side formula (BigInt division truncates like Postgres and Kotlin) ---
const B = (n) => BigInt(n);
const lineAmount = (unit, qty) => (B(unit) * B(qty) + 500n) / 1000n;
const alloc = (share, k, q) => (share < 0n ? -((-share * B(k) + B(q) / 2n) / B(q)) : (share * B(k) + B(q) / 2n) / B(q));
function shares(lines, rc) {
  const sorted = [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const W = sorted.reduce((s, l) => s + l.base, 0n);
  const T = { sub: B(rc.subtotal), disc: B(rc.discount_total), svc: B(rc.service_charge), rnd: B(rc.rounding) };
  T.tadd = B(rc.total) - (T.sub - T.disc + T.svc + T.rnd);
  const acc = { sub: 0n, disc: 0n, svc: 0n, rnd: 0n, tadd: 0n };
  const out = {};
  sorted.forEach((l, i) => {
    const s = i < sorted.length - 1
      ? { sub: l.base, disc: W > 0n ? (T.disc * l.base) / W : 0n, svc: W > 0n ? (T.svc * l.base) / W : 0n, rnd: W > 0n ? (T.rnd * l.base) / W : 0n, tadd: 0n }
      : { sub: T.sub - acc.sub, disc: T.disc - acc.disc, svc: T.svc - acc.svc, rnd: T.rnd - acc.rnd, tadd: T.tadd - acc.tadd };
    for (const k of Object.keys(acc)) acc[k] += s[k];
    out[l.id] = { ...s, qty: l.qty };
  });
  return out;
}
const amount = (s, done, q) => {
  const part = (x) => alloc(x, done + q, s.qty) - alloc(x, done, s.qty);
  return part(s.sub) - part(s.disc) + part(s.tadd) + part(s.svc) + part(s.rnd);
};

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RefundLine-Probe')`);
  const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RLS1') returning id`)).id;
  const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
  const role = (await q1(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]') returning id`)).id;
  const emp = (await q1(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}') returning id`)).id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const items = (await c.query(`select id, name, price from items where tenant_id='${tid}' order by name`)).rows;
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const loy = (await q1(`select id from discounts where tenant_id='${tid}' and name='Loyalty member'`)).id;

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try { const r = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r; await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  const num = () => 'RLS1-T1-' + String(++seq).padStart(6, '0');

  // a table's bill: three of one item, two of another, one of a third, 10% off, 10% service
  async function sell() {
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    // the lines' ids in rising order, so which line is "the last" (it takes what is left of each share) is the same on every run
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
    const lines = [{ item: items[0], qty: 3000 }, { item: items[1], qty: 2000 }, { item: items[2], qty: 1000 }].map((l, i) => ({ id: ids[i], ...l, base: lineAmount(l.item.price, l.qty) }));
    const sub = lines.reduce((s, l) => s + l.base, 0n);
    const disc = (sub * 10n + 50n) / 100n;
    const svc = ((sub - disc) * 1000n + 5000n) / 10000n;
    const total = sub - disc + svc;
    const res = await push([
      op('ticket.create', { id: tk, store_id: store }),
      ...lines.map((l) => op('ticket.add_line', { id: l.id, ticket_id: tk, item_id: l.item.id, qty: l.qty })),
      op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: num(), device_seq: seq, service_pct: 1000,
        discounts: [{ discount_id: loy }], payments: [{ payment_type_id: cash, amount: Number(total) }] }),
    ]);
    const row = await q1(`select subtotal, discount_total, service_charge, rounding, total, needs_review from receipts where id = $1`, [rc]);
    return { rc, lines, res, row, sh: shares(lines, row) };
  }
  const refund = (rc, lines, amt) => op('refund.create', { id: crypto.randomUUID(), refund_of: rc, store_id: store, device_id: dev, number: num(), device_seq: seq,
    reason: 'sent back', ...(lines ? { lines } : {}), payments: amt > 0n ? [{ payment_type_id: cash, amount: Number(amt) }] : [] });

  const s = await sell();
  check('T0 the bill is stored as the till worked it out', tag(s.res[s.res.length - 1]) === 'applied' && s.row.needs_review === false, JSON.stringify(s.row));
  // The same bill is in the till's own test (RefundCalcTest, the_bill_the_server_accepted): these figures are what both must give.
  console.log('     lines: ' + s.lines.map((l) => `${l.item.name} x${l.qty / 1000} = ${l.base}`).join(' | '));
  const [a, b, d] = s.lines;

  // T1 one of the three, named by the order's line
  const first = amount(s.sh[a.id], 0n, 1000n);
  {
    const r = await push([refund(s.rc, [{ ticket_line_id: a.id, qty: 1000 }], first)]);
    const made = await q1(`select r.total, (select json_agg(json_build_object('t', l.ticket_line_id, 'q', l.qty)) from receipt_lines l where l.receipt_id = r.id) lines
                             from receipts r where r.refund_of = $1 order by r.created_at desc limit 1`, [s.rc]);
    check('T1 one unit of a line is refunded for its exact share', tag(r[0]) === 'applied' && B(made.total) === first, tag(r[0]) + ' ' + made.total + ' vs ' + first);
    check('T1 that share is 8910, the figure the till\'s own test holds', first === 8910n, String(first));
    check('T1 the refund says which line and how many', made.lines.length === 1 && made.lines[0].t === a.id && made.lines[0].q === 1000, JSON.stringify(made.lines));
  }

  // T2 the amount must be the share: a rupee more or less is refused
  {
    const right = amount(s.sh[b.id], 0n, 1000n);
    const r = await push([refund(s.rc, [{ ticket_line_id: b.id, qty: 1000 }], right + 100n), refund(s.rc, [{ ticket_line_id: b.id, qty: 1000 }], right - 100n)]);
    check('T2 a wrong amount is refused, over or under', tag(r[0]) === 'rejected:bad-payment' && tag(r[1]) === 'rejected:bad-payment', r.map(tag).join(' '));
  }

  // T3 two lines at once, one of them already partly refunded
  {
    const amt = amount(s.sh[a.id], 1000n, 1000n) + amount(s.sh[b.id], 0n, 2000n);
    const r = await push([refund(s.rc, [{ ticket_line_id: a.id, qty: 1000 }, { ticket_line_id: b.id, qty: 2000 }], amt)]);
    check('T3 several lines in one refund, counting what was already given back', tag(r[0]) === 'applied', tag(r[0]) + ' ' + amt);
    check('T3 that refund is 76230, as in the till\'s test', amt === 76230n, String(amt));
  }

  // T4 what cannot be: more than is left, a line twice, a line of another order, no id at all
  {
    const other = await sell();
    const r = await push([
      refund(s.rc, [{ ticket_line_id: b.id, qty: 1000 }], 100n),
      refund(s.rc, [{ ticket_line_id: a.id, qty: 500 }, { ticket_line_id: a.id, qty: 500 }], 100n),
      refund(s.rc, [{ ticket_line_id: other.lines[0].id, qty: 1000 }], 100n),
      refund(s.rc, [{ ticket_line_id: crypto.randomUUID(), qty: 1000 }], 100n),
      refund(s.rc, [{ qty: 1000 }], 100n),
    ]);
    check('T4 more than is left of a line is refused', tag(r[0]) === 'rejected:bad-qty', tag(r[0]));
    check('T4 the same line twice in one refund is refused', tag(r[1]) === 'rejected:bad-payload', tag(r[1]));
    check('T4 a line of another receipt, an unknown line and no line are refused', r.slice(2).every((x) => tag(x) === 'rejected:bad-line'), r.slice(2).map(tag).join(' '));
  }

  // T5 the rest of the receipt, and then nothing more; every cent paid came back, no more
  {
    const before = B((await q1(`select coalesce(sum(total), 0)::text s from receipts where refund_of = $1`, [s.rc])).s);
    const rest = B(s.row.total) - before;
    const expected = amount(s.sh[a.id], 2000n, 1000n) + amount(s.sh[d.id], 0n, 1000n);
    const r = await push([refund(s.rc, null, rest)]);
    const after = B((await q1(`select coalesce(sum(total), 0)::text s from receipts where refund_of = $1`, [s.rc])).s);
    check('T5 what is left is what the remaining lines add up to', rest === expected, rest + ' vs ' + expected);
    check('T5 and it is 56430, as in the till\'s test', rest === 56430n, String(rest));
    check('T5 "the rest" is refunded and the receipt is given back exactly', tag(r[0]) === 'applied' && after === B(s.row.total), tag(r[0]) + ' ' + after + ' of ' + s.row.total);
    const more = await push([refund(s.rc, [{ ticket_line_id: d.id, qty: 1000 }], 100n)]);
    check('T5 nothing more comes back afterwards', tag(more[0]) === 'rejected:bad-qty', tag(more[0]));
  }

  // T6 the server's own receipt line id still works
  {
    const o = await sell();
    const rl = await q1(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [o.rc, o.lines[1].id]);
    const r = await push([refund(o.rc, [{ receipt_line_id: rl.id, qty: 1000 }], amount(o.sh[o.lines[1].id], 0n, 1000n))]);
    check('T6 a line named by the receipt line id is refunded as before', tag(r[0]) === 'applied', tag(r[0]));
  }

  await devguard.cleanupTenant(c, tid);
  await c.end();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
