// made-of.test.cjs — migration 0112: an item made of others.
//   - a Mix grill made of a Chicken BBQ and a Lamb BBQ takes one of each
//   - a Chicken BBQ sold alone beside it on the same receipt is one movement
//   - a refund gives the parts back
//   - the rules: one level only, no variants, no itself, a quantity above 0
//   - a till's item.save carries parts; one that sends none leaves them
// Usage: node db/tests/made-of.test.cjs
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
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','MO-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','MO1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select seed_demo_catalog('${tid}')`);
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;
    const counted = (await q1(`insert into categories (tenant_id, name, is_stock) values ($1,'Grills',true) returning id`, [tid])).id;
    const item = async (name, price, track, cat = null) =>
      (await q1(`insert into items (tenant_id, name, price, track_stock, category_id) values ($1,$2,$3,$4,$5) returning id`, [tid, name, price, track, cat])).id;
    const chicken = await item('Chicken BBQ', 30000, true);
    const lamb = await item('Lamb BBQ', 40000, true);
    const sauce = await item('Sauce', 0, false);
    // the Mix grill sits in a counted category, and its own switch is on: neither may count it once it has parts
    const mix = await item('Mix grill', 60000, true, counted);
    const half = await item('Half lamb plate', 25000, false);
    const shirt = await item('Shirt', 50000, true);
    await c.query(`insert into item_variants (tenant_id, item_id, name, price) values ($1,$2,'Red',50000)`, [tid, shirt]);

    for (const [it, n] of [[chicken, 30000], [lamb, 30000]]) {
      await c.query(`select stock_move($1,$2,$3,null,$4,'receive',1000,'delivery',$5,$6,null)`, [tid, store, it, n, crypto.randomUUID(), owner]);
    }

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const setParts = async (it, parts) => {
      try { await asApp(() => c.query(`select item_set_parts($1,$2,$3::jsonb)`, [tid, it, JSON.stringify(parts)])); return 'ok'; }
      catch (e) { return e.message; }
    };
    const partsOf = async (it) => (await q1(`select parts from items where id = $1`, [it])).parts;
    const same = (parts, want) => parts.length === want.length && want.every(([id, n], i) => parts[i].item_id === id && parts[i].qty === n);
    const qty = async (it) => (await q1(`select coalesce((select qty from stock_levels where tenant_id=$1 and store_id=$2 and item_id=$3 and variant_id is null), 0) as q`, [tid, store, it])).q;
    const moves = async (ref) => (await c.query(
      `select m.item_id, m.qty, m.reason, m.note, m.ref_type, m.receipt_id from stock_movements m where m.ref_id = $1 order by m.qty`, [ref])).rows;
    let seq = 0;
    const sale = (lines, rc, amount) => {
      const tk = crypto.randomUUID();
      return [
        op('ticket.create', { id: tk, store_id: store }),
        ...lines.map((l) => op('ticket.add_line', { id: l.id || crypto.randomUUID(), ticket_id: tk, item_id: l.item, qty: l.qty })),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'MO-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount }], device_time: new Date(Date.parse('2026-03-02T05:00:00Z') + seq * 60000).toISOString() }),
      ];
    };

    // M1 the rules
    check('M1 a part that is the item itself is refused', (await setParts(mix, [{ item_id: mix, qty: 1000 }])) === 'bad-part');
    check('M1 a part with variants is refused', (await setParts(mix, [{ item_id: shirt, qty: 1000 }])) === 'bad-part');
    check('M1 a quantity of 0 is refused', (await setParts(mix, [{ item_id: chicken, qty: 0 }])) === 'bad-quantity');
    check('M1 something that is not a list is refused', (await setParts(mix, { item_id: chicken })) === 'bad-payload');
    check('M1 another client\'s item is refused', (await setParts(mix, [{ item_id: crypto.randomUUID(), qty: 1000 }])) === 'bad-part');
    check('M1 the Mix grill made of a chicken and a lamb',
      (await setParts(mix, [{ item_id: chicken, qty: 1000 }, { item_id: lamb, qty: 1000 }, { item_id: sauce, qty: 1000 }])) === 'ok');
    const m = await q1(`select parts, track_stock from items where id = $1`, [mix]);
    check('M1 its parts are kept in order, and it no longer counts itself',
      m.parts.length === 3 && m.parts[0].item_id === chicken && m.parts[1].item_id === lamb && m.parts[0].qty === 1000 && m.track_stock === false, JSON.stringify(m));
    check('M1 an item with parts cannot be a part', (await setParts(half, [{ item_id: mix, qty: 1000 }])) === 'part-has-parts');
    check('M1 a part cannot be given parts', (await setParts(chicken, [{ item_id: lamb, qty: 1000 }])) === 'is-a-part');
    check('M1 a part named twice is one part of both',
      (await setParts(half, [{ item_id: lamb, qty: 250 }, { item_id: lamb, qty: 250 }])) === 'ok'
        && same(await partsOf(half), [[lamb, 500]]));

    // M2 two Mix grills and a Chicken BBQ alone, on one receipt
    const rc1 = crypto.randomUUID();
    const mixLine = crypto.randomUUID();
    const r1 = await push(sale([{ item: mix, qty: 2000, id: mixLine }, { item: chicken, qty: 1000 }], rc1, 150000));
    check('M2 the sale is applied', tag(r1[r1.length - 1]) === 'applied', tag(r1[r1.length - 1]));
    let mv = await moves(rc1);
    const of = (it) => mv.filter((x) => x.item_id === it);
    check('M2 chicken goes down by 3, in one movement that says it was sold in a Mix grill',
      of(chicken).length === 1 && of(chicken)[0].qty === -3000 && of(chicken)[0].note === 'Sold in Mix grill' && of(chicken)[0].receipt_id === rc1, JSON.stringify(of(chicken)));
    check('M2 lamb goes down by 2', of(lamb).length === 1 && of(lamb)[0].qty === -2000, JSON.stringify(of(lamb)));
    check('M2 the sauce, not counted, and the Mix grill itself move nothing', of(sauce).length === 0 && of(mix).length === 0 && mv.length === 2, JSON.stringify(mv));
    check('M2 the levels: chicken 27, lamb 28, no Mix grill', (await qty(chicken)) === 27000 && (await qty(lamb)) === 28000 && (await qty(mix)) === 0);

    // M3 the same sale arriving again
    await push(sale([{ item: mix, qty: 2000 }], rc1, 120000));
    check('M3 a sale that arrives twice moves its parts once', (await qty(chicken)) === 27000 && (await qty(lamb)) === 28000);

    // M4 a refund of one Mix grill
    const line = await q1(`select id from receipt_lines where receipt_id = $1 and ticket_line_id = $2`, [rc1, mixLine]);
    const rf = crypto.randomUUID();
    const back = await push([op('refund.create', { id: rf, refund_of: rc1, store_id: store, device_id: dev, number: 'MO-R' + (++seq), device_seq: seq,
      reason: 'cold', lines: [{ receipt_line_id: line.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 60000 }] })]);
    check('M4 the refund is applied', tag(back[0]) === 'applied', tag(back[0]));
    mv = await moves(rf);
    check('M4 one chicken and one lamb come back', mv.length === 2 && mv.every((x) => x.qty === 1000 && x.reason === 'refund'), JSON.stringify(mv));
    check('M4 the levels: chicken 28, lamb 29', (await qty(chicken)) === 28000 && (await qty(lamb)) === 29000);

    // M5 half a portion of lamb, three plates
    const rc2 = crypto.randomUUID();
    await push(sale([{ item: half, qty: 3000 }], rc2, 75000));
    mv = await moves(rc2);
    check('M5 three half plates take one and a half lamb', mv.length === 1 && mv[0].item_id === lamb && mv[0].qty === -1500, JSON.stringify(mv));

    // M6 a till's item.save: with parts, and without
    const t1 = await push([op('item.save', { id: half, name: 'Half lamb plate', price: 25000, parts: [{ item_id: chicken, qty: 1000 }] })]);
    check('M6 a till sets the parts', tag(t1[0]) === 'applied'
      && same(await partsOf(half), [[chicken, 1000]]), tag(t1[0]));
    const t2 = await push([op('item.save', { id: half, name: 'Chicken plate', price: 25000 })]);
    check('M6 a till that sends no parts leaves them', tag(t2[0]) === 'applied'
      && (await q1(`select parts from items where id = $1`, [half])).parts.length === 1);
    const t3 = await push([op('item.save', { id: half, name: 'Chicken plate', price: 25000, parts: [{ item_id: mix, qty: 1000 }] })]);
    check('M6 a till is refused a part that has parts', tag(t3[0]) === 'rejected:part-has-parts', tag(t3[0]));
    const t4 = await push([op('item.save', { id: half, name: 'Chicken plate', price: 25000, parts: [] })]);
    check('M6 an empty list takes the parts off', tag(t4[0]) === 'applied' && (await q1(`select parts from items where id = $1`, [half])).parts.length === 0);

    // M7 a part removed since is still taken
    await c.query(`update items set deleted_at = now() where id = $1`, [lamb]);
    const rc3 = crypto.randomUUID();
    await push(sale([{ item: mix, qty: 1000 }], rc3, 60000));
    mv = await moves(rc3);
    check('M7 a removed part still has its stock taken', mv.some((x) => x.item_id === lamb && x.qty === -1000), JSON.stringify(mv));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `MADE OF FAIL (${failures})` : 'MADE OF PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
