// open-price.test.cjs — migration 0083: an item whose price is typed at the
// sale. "Labour" is on the menu at nothing; the first customer is charged
// Rs 100 and the second Rs 200. The till sends each line at the price that
// was typed, and until now the server took any line charged differently from
// the catalog for a price that had drifted, and marked the receipt for
// review: every sale of such an item would have asked the owner to look.
//   - an item marked open_price is charged what the till says, with nothing
//     flagged, by anyone who may sell: typing its price is not changing a
//     price, so it needs no right and no approval
//   - two of it at different prices are two lines of one bill
//   - a till learns of the mark with the item, in its next pull
//   - everything else is as it was: an ordinary item charged differently from
//     its price is still flagged, and an open-price item that was taken off
//     sale is still flagged as that
// Usage: node db/tests/open-price.test.cjs
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
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','OP-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','OPS1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = async (name, perms) => (await q1(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, name, JSON.stringify(perms)])).id;
    const emp = async (name, r) => (await q1(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, name, r])).id;
    const owner = await emp('Owner', await role('Owner', ['*'])); // the till's login
    // sells and takes payment, and nothing more: may not discount, may not change a price
    const cashier = await emp('Cashier', await role('Cashier', ['sale.create', 'payment.take']));
    await c.query(`select seed_demo_catalog('${tid}')`);
    const dp = (await q1(`select id from items where tenant_id='${tid}' and name='Dholl puri'`)).id; // Rs 50
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

    // O1: the mark exists, and nothing has it until someone sets it
    const marked = await q1(`select count(*)::int as n from items where tenant_id = $1 and open_price`, [tid]);
    check('O1 no item asks for its price until it is marked', marked.n === 0);
    const labour = (await q1(`insert into items (tenant_id, name, price, open_price) values ($1,'Labour',0,true) returning id`, [tid])).id;

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const T0 = Date.parse('2026-03-02T05:00:00Z');
    let seq = 0;
    const reviews = async (rc) => (await c.query(`select reason, detail from receipt_reviews where receipt_id = $1 and deleted_at is null order by reason`, [rc])).rows;
    // a bill of these lines [item, price or null for the listed one], paid in cash for `paid`, rung up by `who`
    const sell = async (lines, paid, who = cashier) => {
      const tk = crypto.randomUUID(), rc = crypto.randomUUID();
      const r = await push([
        op('ticket.create', { id: tk, store_id: store }, who),
        ...lines.map(([item, price]) => op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: item, qty: 1000, ...(price === null ? {} : { unit_price: price }) }, who)),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'OP-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount: paid }], device_time: new Date(T0 + seq * 60000).toISOString() }, who),
      ]);
      const receipt = await q1(`select total, needs_review from receipts where id = $1`, [rc]);
      const charged = (await c.query(`select name_snapshot as name, unit_price from receipt_lines where receipt_id = $1 order by unit_price`, [rc])).rows;
      return { said: r.map(tag).join(','), rc, receipt, charged, reviews: await reviews(rc) };
    };

    // O2, O3: the first customer is charged Rs 100, the second Rs 200
    const first = await sell([[labour, 10000]], 10000);
    check('O2 Labour at Rs 100 is taken', first.said === 'applied,applied,applied', first.said);
    check('O2 the bill is Rs 100', first.receipt && Number(first.receipt.total) === 10000 && Number(first.charged[0].unit_price) === 10000, JSON.stringify(first.receipt));
    check('O2 and nothing about it asks to be looked at', first.receipt && first.receipt.needs_review === false && first.reviews.length === 0, JSON.stringify(first.reviews));
    const second = await sell([[labour, 20000]], 20000);
    check('O3 the next customer is charged Rs 200, as cleanly',
      second.said === 'applied,applied,applied' && Number(second.receipt.total) === 20000 && second.receipt.needs_review === false && second.reviews.length === 0, JSON.stringify(second.reviews));

    // O4: two of it on one bill, at two prices, beside an ordinary item
    const both = await sell([[labour, 10000], [labour, 35000], [dp, null]], 50000);
    check('O4 two Labours at two prices are two lines of one bill',
      both.said.split(',').every((s) => s === 'applied') && both.charged.length === 3 && both.charged.map((l) => Number(l.unit_price)).join() === '5000,10000,35000', JSON.stringify(both.charged));
    check('O4 the bill adds up and is clean', Number(both.receipt.total) === 50000 && both.receipt.needs_review === false && both.reviews.length === 0, JSON.stringify(both.reviews));

    // O5: it took no right to type that price: the cashier may neither discount nor change a price
    check('O5 someone who may only sell rang all of them up', (await q1(`select count(*)::int as n from receipts where tenant_id = $1 and employee_id = $2`, [tid, cashier])).n === 3);

    // O6: a till learns of the mark with the item
    const pulled = await asApp(async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [store])).rows[0].r);
    const sent = (pulled.changes.items || []).find((i) => i.id === labour);
    const plain = (pulled.changes.items || []).find((i) => i.id === dp);
    check('O6 a pull hands the till the mark', !!sent && sent.open_price === true && !!plain && plain.open_price === false, JSON.stringify(sent && { open_price: sent.open_price }));

    // O7: an ordinary item charged something other than its price is still flagged
    const drifted = await sell([[dp, 6000]], 6000);
    check('O7 an ordinary item at another price is still kept and flagged',
      drifted.said === 'applied,applied,applied' && drifted.receipt.needs_review === true && drifted.reviews.some((r) => r.reason === 'price-drift'), JSON.stringify(drifted.reviews.map((r) => r.reason)));

    // O8: an open-price item that was taken off sale is still flagged as that
    await c.query(`update items set is_available = false where id = $1`, [labour]);
    const off = await sell([[labour, 10000]], 10000);
    const why = off.reviews.find((r) => r.reason === 'price-drift');
    check('O8 one that is off sale is still flagged, as unavailable',
      off.said === 'applied,applied,applied' && !!why && why.detail.items.some((i) => i.kind === 'unavailable'), JSON.stringify(off.reviews));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures === 0 ? 'OPEN-PRICE PASS' : `OPEN-PRICE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
