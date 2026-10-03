// refund-shares.test.cjs — review item C: refunds are exact shares of what the
// receipt charged and never exceed the money received.
//   T1 the Rs 170 case: three single-unit refunds apply and sum to 17000
//   T2 Rs 1 received on a Rs 50 receipt: no refund of Rs 50, full or by line
//   T3 "refund the rest" after a partial returns exactly the remainder
//   T4 randomised receipts (qty, modifiers, discount, service, rounding):
//      every unit refunded in random order sums to the total exactly
// The till must compute refund amounts itself, so this test mirrors the
// documented formula (0042 header) in JS instead of asking the server.
// Usage: node db/tests/refund-shares.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

// --- the till-side formula (BigInt division truncates like Postgres) --------
const B = (n) => BigInt(n);
const lineAmount = (unit, qty) => (B(unit) * B(qty) + 500n) / 1000n;
const alloc = (share, k, q) => (share < 0n ? -((-share * B(k) + B(q) / 2n) / B(q)) : (share * B(k) + B(q) / 2n) / B(q));
// lines: [{ ticketLineId, receiptLineId, unit, qty, mods: [price], taxes: [{rate, type}] }]
// rc: { subtotal, discount, service, rounding, total } (cents)
function shares(lines, rc) {
  const sorted = [...lines].sort((a, b) => (a.ticketLineId < b.ticketLineId ? -1 : a.ticketLineId > b.ticketLineId ? 1 : 0));
  const base = (l) => lineAmount(l.unit, l.qty) + l.mods.reduce((s, m) => s + B(m), 0n);
  const W = sorted.reduce((s, l) => s + base(l), 0n);
  const T = { sub: B(rc.subtotal), disc: B(rc.discount), svc: B(rc.service), rnd: B(rc.rounding) };
  T.tadd = B(rc.total) - (T.sub - T.disc + T.svc + T.rnd);
  const acc = { sub: 0n, disc: 0n, svc: 0n, rnd: 0n, tadd: 0n };
  return sorted.map((l, i) => {
    let s;
    if (i < sorted.length - 1) {
      const b = base(l);
      const disc = W > 0n ? (T.disc * b) / W : 0n;
      let tadd = 0n;
      for (const t of l.taxes) if (t.type === 'added') tadd += ((b - disc) * B(t.rate) + 5000n) / 10000n;
      s = { sub: b, disc, svc: W > 0n ? (T.svc * b) / W : 0n, rnd: W > 0n ? (T.rnd * b) / W : 0n, tadd };
    } else {
      s = { sub: T.sub - acc.sub, disc: T.disc - acc.disc, svc: T.svc - acc.svc, rnd: T.rnd - acc.rnd, tadd: T.tadd - acc.tadd };
    }
    for (const k of Object.keys(acc)) acc[k] += s[k];
    return { line: l, s };
  });
}
// refund of q units of a line that already has d refunded
function refundAmount(sh, d, q) {
  const Q = sh.line.qty;
  const part = (x) => alloc(x, d + q, Q) - alloc(x, d, Q);
  return part(sh.s.sub) - part(sh.s.disc) + part(sh.s.tadd) + part(sh.s.svc) + part(sh.s.rnd);
}
// deterministic pseudo-random so a failure can be reproduced
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','RS-Probe')`);
  const store = (await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','RSS1') returning id`)).rows[0].id;
  const dev = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;
  const role = (await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]') returning id`)).rows[0].id;
  const emp = (await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}') returning id`)).rows[0].id;
  await c.query(`select seed_demo_catalog('${tid}')`);
  const q1 = async (sql) => (await c.query(sql)).rows[0];
  const items = (await c.query(`select id, name, price from items where tenant_id='${tid}'`)).rows;
  const item = (name) => items.find((i) => i.name === name);
  const mod = async (grp, name) => q1(`select m.id, m.price from modifiers m join modifier_groups g on g.id = m.group_id
    where m.tenant_id='${tid}' and g.name='${grp}' and m.name='${name}'`);
  const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
  const loy = (await q1(`select id from discounts where tenant_id='${tid}' and name='Loyalty member'`)).id;
  const VAT = [{ rate: 1500, type: 'included' }];

  async function push(ops) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    try {
      const r = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r;
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  let seq = 0;
  const num = () => 'RSS1-T1-' + (++seq);
  // sells lines [{item, qty, mods:[{id,price}]}], pays `pay` (default: the exact total)
  async function sell(lines, extra, pay) {
    const tk = crypto.randomUUID(), rc = crypto.randomUUID();
    const ops = [op('ticket.create', { id: tk, store_id: store })];
    const model = lines.map((l) => ({ ticketLineId: crypto.randomUUID(), unit: Number(l.item.price), qty: l.qty,
      mods: (l.mods || []).map((m) => Number(m.price)), taxes: VAT, modIds: (l.mods || []).map((m) => m.id), itemId: l.item.id }));
    for (const m of model) ops.push(op('ticket.add_line', { id: m.ticketLineId, ticket_id: tk, item_id: m.itemId, qty: m.qty, modifier_ids: m.modIds }));
    const sub = model.reduce((s, m) => s + lineAmount(m.unit, m.qty) + m.mods.reduce((a, b) => a + B(b), 0n), 0n);
    const disc = extra && extra.discount ? (sub * 10n + 50n) / 100n : 0n;
    const svc = extra && extra.service_pct ? ((sub - disc) * B(extra.service_pct) + 5000n) / 10000n : 0n;
    const rnd = B((extra && extra.rounding) || 0);
    const total = sub - disc + svc + rnd;
    const payload = { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: num(), device_seq: seq,
      payments: [{ payment_type_id: cash, amount: Number(pay === undefined ? total : pay) }] };
    if (extra && extra.discount) payload.discounts = [{ discount_id: loy }];
    if (extra && extra.service_pct) payload.service_pct = extra.service_pct;
    if (extra && extra.rounding) payload.rounding = extra.rounding;
    ops.push(op('receipt.create', payload));
    const res = await push(ops);
    const row = await q1(`select subtotal, discount_total, service_charge, rounding, total, needs_review from receipts where id='${rc}'`);
    const rls = (await c.query(`select id, ticket_line_id from receipt_lines where receipt_id='${rc}'`)).rows;
    for (const m of model) m.receiptLineId = rls.find((r) => r.ticket_line_id === m.ticketLineId).id;
    return { rc, res, row, model, expect: { sub, disc, svc, rnd, total },
      sh: shares(model, { subtotal: row.subtotal, discount: row.discount_total, service: row.service_charge, rounding: row.rounding, total: row.total }) };
  }
  const refund = (rc, lines, amount) => op('refund.create', { id: crypto.randomUUID(), refund_of: rc, store_id: store, device_id: dev,
    number: num(), device_seq: seq, reason: 't', ...(lines ? { lines } : {}),
    payments: amount > 0 ? [{ payment_type_id: cash, amount: Number(amount) }] : [] });
  const refunded = async (rc) => B((await q1(`select coalesce(sum(total),0)::text s from receipts where refund_of='${rc}'`)).s);

  // T1: 3 x Dholl puri (5000) + one flat Achard (2000) = 17000
  {
    const s = await sell([{ item: item('Dholl puri'), qty: 3000, mods: [await mod('Street add-ons', 'Achard')] }]);
    check('T1 sale 17000, not flagged', s.row.total === '17000' && s.row.needs_review === false, JSON.stringify(s.row));
    const got = [];
    for (let u = 0; u < 3; u++) {
      const amt = refundAmount(s.sh[0], u * 1000, 1000);
      const r = await push([refund(s.rc, [{ receipt_line_id: s.model[0].receiptLineId, qty: 1000 }], amt)]);
      got.push(tag(r[0]) + '@' + amt);
    }
    check('T1 three single-unit refunds all apply', got.every((g) => g.startsWith('applied')), got.join(' '));
    check('T1 amounts are 5667, 5666, 5667', got.map((g) => g.split('@')[1]).join(',') === '5667,5666,5667', got.join(' '));
    check('T1 refunded in total equals paid', (await refunded(s.rc)) === 17000n, String(await refunded(s.rc)));
    const r4 = await push([refund(s.rc, [{ receipt_line_id: s.model[0].receiptLineId, qty: 1000 }], 5667n)]);
    check('T1 a fourth unit is refused', tag(r4[0]) === 'rejected:bad-qty', tag(r4[0]));
  }

  // T2: Rs 1 received on a Rs 50 receipt (stored and flagged) can never pay out Rs 50
  {
    const s = await sell([{ item: item('Dholl puri'), qty: 1000 }], null, 100);
    check('T2 underpaid sale stored and flagged', tag(s.res[s.res.length - 1]) === 'applied' && s.row.needs_review === true && s.row.total === '5000', JSON.stringify(s.row));
    const full = await push([refund(s.rc, null, 5000n)]);
    check('T2 full refund of 5000 refused', tag(full[0]) === 'rejected:bad-qty', tag(full[0]));
    const byLine = await push([refund(s.rc, [{ receipt_line_id: s.model[0].receiptLineId, qty: 1000 }], 5000n)]);
    check('T2 by-line refund of 5000 refused', tag(byLine[0]) === 'rejected:bad-qty', tag(byLine[0]));
    check('T2 nothing went out', (await refunded(s.rc)) === 0n);
  }

  // T3: one unit by line, then "refund the rest" (no lines) returns exactly the remainder
  {
    const s = await sell([{ item: item('Cari poulet'), qty: 2000, mods: [await mod('Curry add-ons', 'Extra rice')] },
      { item: item('Alouda'), qty: 1000 }], { discount: true, service_pct: 1000 });
    check('T3 sale total as computed by the till', s.row.total === String(s.expect.total) && !s.row.needs_review, JSON.stringify(s.row));
    const first = refundAmount(s.sh.find((x) => x.line.itemId === item('Cari poulet').id), 0, 1000);
    const r1 = await push([refund(s.rc, [{ receipt_line_id: s.model[0].receiptLineId, qty: 1000 }], first)]);
    const rest = B(s.row.total) - first;
    const r2 = await push([refund(s.rc, null, rest)]);
    check('T3 partial then the rest both apply', tag(r1[0]) === 'applied' && tag(r2[0]) === 'applied', tag(r1[0]) + ' ' + tag(r2[0]));
    check('T3 refunded in total equals paid', (await refunded(s.rc)) === B(s.row.total), `${await refunded(s.rc)} vs ${s.row.total}`);
    const r3 = await push([refund(s.rc, null, 1n)]);
    check('T3 nothing left to refund', tag(r3[0]) === 'rejected:bad-qty', tag(r3[0]));
    const comp = await q1(`select sum(subtotal)::text sub, sum(discount_total)::text disc, sum(service_charge)::text svc, sum(tax_total)::text tax
      from receipts where refund_of='${s.rc}'`);
    const o = await q1(`select subtotal::text sub, discount_total::text disc, service_charge::text svc, tax_total::text tax from receipts where id='${s.rc}'`);
    check('T3 every component adds back to the original', JSON.stringify(comp) === JSON.stringify(o), JSON.stringify({ comp, o }));
  }

  // T4: randomised receipts, every unit refunded one at a time in random order
  {
    const rand = rng(20261004);
    const pool = [
      { item: item('Dholl puri'), mods: [await mod('Street add-ons', 'Achard'), await mod('Street add-ons', 'Extra rougaille')] },
      { item: item('Cari poulet'), mods: [await mod('Curry add-ons', 'Extra rice'), await mod('Curry add-ons', 'Extra chutney')] },
      { item: item('Mine frire poulet'), mods: [await mod('Wok add-ons', 'Extra sauce')] },
      { item: item('Alouda'), mods: [] },
    ];
    let allApplied = true, allExact = true, neverOver = true, detail = '';
    for (let round = 0; round < 6; round++) {
      const lines = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const pk = pool[Math.floor(rand() * pool.length)];
        lines.push({ item: pk.item, qty: (1 + Math.floor(rand() * 4)) * 1000, mods: pk.mods.filter(() => rand() < 0.5) });
      }
      const extra = { discount: rand() < 0.5, service_pct: rand() < 0.5 ? 1000 : 0, rounding: [0, 0, -30, 20][Math.floor(rand() * 4)] };
      const s = await sell(lines, extra);
      if (s.row.total !== String(s.expect.total) || s.row.needs_review) { allExact = false; detail += ` sale#${round} ${JSON.stringify(s.row)} exp ${s.expect.total}`; continue; }
      const units = [];
      s.sh.forEach((sh) => { for (let u = 0; u < sh.line.qty / 1000; u++) units.push(sh); });
      for (let i = units.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [units[i], units[j]] = [units[j], units[i]]; }
      const done = new Map();
      for (const sh of units) {
        const d = done.get(sh.line.receiptLineId) || 0;
        const amt = refundAmount(sh, d, 1000);
        const r = await push([refund(s.rc, [{ receipt_line_id: sh.line.receiptLineId, qty: 1000 }], amt)]);
        if (tag(r[0]) !== 'applied') { allApplied = false; detail += ` r#${round} ${tag(r[0])}@${amt}`; }
        done.set(sh.line.receiptLineId, d + 1000);
        if ((await refunded(s.rc)) > B(s.row.total)) neverOver = false;
      }
      const back = await refunded(s.rc);
      if (back !== B(s.row.total)) { allExact = false; detail += ` sum#${round} ${back} vs ${s.row.total}`; }
    }
    check('T4 every single-unit refund applies', allApplied, detail);
    check('T4 refunds sum to the receipt total exactly', allExact, detail);
    check('T4 refunds never exceed what was paid', neverOver);
  }

  await devguard.cleanupTenant(c, tid);
  console.log(failures === 0 ? 'REFUND-SHARES PASS' : `REFUND-SHARES FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
