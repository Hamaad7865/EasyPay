// promotions.test.cjs — migration 0110: a shop's promotions.
//   - apply: never below cost, a real reduction, a cost must be known, one
//     live promotion per line; the price moves and promo_was keeps the old one
//   - reduce: the same floor, lower than the promotion price, original kept
//   - lift: the price put back when still the promotion's, left when changed
//     by hand since; promo_was cleared either way
//   - slow_movers: never sold counts from creation, no stock left out, on
//     promotion left out, the day it turns; stale_promotions
//   - the three push operations and their refusals; the two settings; the pull
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/promotions.test.cjs
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
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-pr@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Promo Test','Main','PR1','Owner',$2,'standard','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '') + (o.replayed ? ':replayed' : '');
    // something the server may refuse, with the transaction kept whole
    const tryIt = async (sql, params) => {
      await c.query('SAVEPOINT t');
      try { const r = await c.query(sql, params); await c.query('RELEASE SAVEPOINT t'); return { ok: true, row: r.rows[0] }; }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT t'); return { ok: false, err: e.message }; }
    };
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    const vat = (await one(`select id from taxes where tenant_id = $1 and name = 'VAT'`, [tid])).id;
    const item = async (name, price, cost, daysOld = 0) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, created_at) values ($1,$2,$3,$4,true, now() - ($5 || ' days')::interval) returning id`, [tid, name, price, cost, String(daysOld)])).id;
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
      return it;
    };
    const stock = (it, va, qty) => c.query(`select stock_move($1,$2,$3,$4,$5,'receive',1000,'delivery',$6,$7,null)`, [tid, store, it, va, qty, id(), owner]);
    const line = (it, va) => va
      ? one(`select price, promo_was from item_variants where id = $1`, [va])
      : one(`select price, promo_was from items where id = $1`, [it]);

    // a tee at Rs 350 that cost Rs 120, forty days old, two on the shelf; a mug at Rs 320 that cost Rs 140, sold last week
    const tee = await item('Tee', 35000, 12000, 40);
    await stock(tee, null, 2000);
    const mug = await item('Mug', 32000, 14000, 40);
    await stock(mug, null, 5000);
    await c.query(`select stock_move($1,$2,$3,null,-1000,'sale',14000,'receipt',$4,$5,null)`, [tid, store, mug, id(), owner]);
    const hat = await item('Hat', 20000, 9000, 40); // nothing on the shelf
    const fresh = await item('Fresh', 20000, 9000, 3); // made three days ago, never sold
    await stock(fresh, null, 1000);
    const nocost = await item('Mystery', 20000, null, 40);
    await c.query(`update items set cost = null where id = $1`, [nocost]);
    await stock(nocost, null, 1000);
    // a shirt with two sizes, S cheaper to make
    const shirt = await item('Shirt', 129000, 60000, 40);
    const vs = (await one(`insert into item_variants (tenant_id, item_id, name, price, cost, created_at) values ($1,$2,'S',129000,55000, now() - interval '40 days') returning id`, [tid, shirt])).id;
    const vm = (await one(`insert into item_variants (tenant_id, item_id, name, price, cost, created_at) values ($1,$2,'M',129000,60000, now() - interval '40 days') returning id`, [tid, shirt])).id;
    await stock(shirt, vs, 3000); await stock(shirt, vm, 3000);

    // ---- P1 slow movers ----
    {
      const rows = (await c.query(`select name, variant, qty, days_idle from slow_movers($1, 30) order by name, variant`, [tid])).rows;
      const names = rows.map((r) => r.name + (r.variant ? ' ' + r.variant : '')).join(',');
      check('P1 slow movers: the tee and the shirt\'s two sizes (never sold, forty days old, with stock); not the mug (sold last week), the hat (none left), the fresh one (three days old)', names === 'Mystery,Shirt M,Shirt S,Tee' && rows.find((r) => r.name === 'Tee').days_idle >= 40, names);
      check('P1 count_slow_movers agrees', (await one(`select count_slow_movers($1, 30) as n`, [tid])).n === 4);
      check('P1 the fresh one turns on its thirtieth day', (await c.query(`select name from slow_movers($1, 3)`, [tid])).rows.some((r) => r.name === 'Fresh') && !(await c.query(`select name from slow_movers($1, 4)`, [tid])).rows.some((r) => r.name === 'Fresh'));
    }

    // ---- P2 apply ----
    let promoId;
    {
      let r = await tryIt(`select promotion_apply($1,$2,$3,null,11000,'clear it') as id`, [tid, owner, tee]);
      check('P2 below cost (Rs 110 for a tee that cost Rs 120): refused', !r.ok && /below-cost/.test(r.err), r.err);
      r = await tryIt(`select promotion_apply($1,$2,$3,null,35000,null) as id`, [tid, owner, tee]);
      check('P2 not lower than the price: refused', !r.ok && /not-lower/.test(r.err), r.err);
      r = await tryIt(`select promotion_apply($1,$2,$3,null,15000,null) as id`, [tid, owner, nocost]);
      check('P2 a line with no cost known: refused', !r.ok && /no-cost/.test(r.err), r.err);
      r = await tryIt(`select promotion_apply($1,$2,$3,null,100000,null) as id`, [tid, owner, shirt]);
      check('P2 a product with variants is promoted by the variant: refused for the product', !r.ok && /pick-variant/.test(r.err), r.err);
      r = await tryIt(`select promotion_apply($1,$2,$3,null,25000,'clear it') as id`, [tid, cara, tee]);
      check('P2 a cashier: refused', !r.ok && /forbidden/.test(r.err), r.err);
      r = await tryIt(`select promotion_apply($1,$2,$3,null,25000,'clear it') as id`, [tid, owner, tee]);
      promoId = r.row && r.row.id;
      const l = await line(tee);
      const pr = await one(`select original_price, promo_price, status, note, applied_by from promotions where id = $1`, [promoId]);
      check('P2 the tee at Rs 250: the price moved, promo_was keeps Rs 350, the row says it all', r.ok && Number(l.price) === 25000 && Number(l.promo_was) === 35000 && pr && Number(pr.original_price) === 35000 && Number(pr.promo_price) === 25000 && pr.status === 'active' && pr.note === 'clear it' && pr.applied_by === owner, r.err || JSON.stringify({ l, pr }));
      const log = await one(`select old_price, new_price, source, changed_by from item_price_changes where tenant_id = $1 and item_id = $2 order by created_at desc limit 1`, [tid, tee]);
      check('P2 and the price change is on the record, by the owner, from the till side of the trigger', log && Number(log.old_price) === 35000 && Number(log.new_price) === 25000 && log.changed_by === owner, JSON.stringify(log));
      r = await tryIt(`select promotion_apply($1,$2,$3,null,20000,null) as id`, [tid, owner, tee]);
      check('P2 a second live promotion on the line: refused', !r.ok && /on-promotion/.test(r.err), r.err);
      check('P2 the tee is no slow mover now', !(await c.query(`select name from slow_movers($1, 30)`, [tid])).rows.some((x) => x.name === 'Tee'));
      // a variant on its own
      r = await tryIt(`select promotion_apply($1,$2,$3,$4,99000,null) as id`, [tid, owner, shirt, vs]);
      const ls = await line(shirt, vs), lm = await line(shirt, vm);
      check('P2 the small shirt at Rs 990: its price alone moved', r.ok && Number(ls.price) === 99000 && Number(ls.promo_was) === 129000 && Number(lm.price) === 129000 && lm.promo_was === null, r.err || JSON.stringify({ ls, lm }));
    }

    // ---- P3 reduce ----
    {
      let r = await tryIt(`select promotion_reduce($1,$2,$3,null,26000,null) as id`, [tid, owner, tee]);
      check('P3 not lower than the promotion price: refused', !r.ok && /not-lower/.test(r.err), r.err);
      r = await tryIt(`select promotion_reduce($1,$2,$3,null,11000,null) as id`, [tid, owner, tee]);
      check('P3 below cost: refused', !r.ok && /below-cost/.test(r.err), r.err);
      r = await tryIt(`select promotion_reduce($1,$2,$3,null,19900,'still here') as id`, [tid, owner, tee]);
      const l = await line(tee);
      const pr = await one(`select original_price, promo_price, note from promotions where id = $1`, [promoId]);
      check('P3 reduced to Rs 199: the price moved, the original is kept, the note replaced', r.ok && Number(l.price) === 19900 && Number(l.promo_was) === 35000 && Number(pr.original_price) === 35000 && Number(pr.promo_price) === 19900 && pr.note === 'still here', r.err || JSON.stringify({ l, pr }));
      r = await tryIt(`select promotion_reduce($1,$2,$3,null,19000,null) as id`, [tid, owner, mug]);
      check('P3 a line not on promotion: refused', !r.ok && /not-active/.test(r.err), r.err);
    }

    // ---- P4 stale ----
    {
      await c.query(`update promotions set applied_at = now() - interval '20 days' where id = $1`, [promoId]);
      const rows = (await c.query(`select name, days_idle from stale_promotions($1, 14)`, [tid])).rows;
      check('P4 a promotion twenty days old with no sale since is still not selling', rows.length === 1 && rows[0].name === 'Tee' && rows[0].days_idle >= 20, JSON.stringify(rows));
      check('P4 and not at a threshold of 30', (await c.query(`select name from stale_promotions($1, 30)`, [tid])).rows.length === 0);
    }

    // ---- P5 lift ----
    {
      let r = await tryIt(`select promotion_lift($1,$2,$3) as restored`, [tid, owner, promoId]);
      const l = await line(tee);
      const pr = await one(`select status, lifted_by from promotions where id = $1`, [promoId]);
      check('P5 lifted: Rs 350 is back, promo_was cleared, the row says lifted', r.ok && r.row.restored === true && Number(l.price) === 35000 && l.promo_was === null && pr.status === 'lifted' && pr.lifted_by === owner, r.err || JSON.stringify({ l, pr }));
      r = await tryIt(`select promotion_lift($1,$2,$3) as restored`, [tid, owner, promoId]);
      check('P5 lifted twice: refused', !r.ok && /not-active/.test(r.err), r.err);
      // the small shirt's price changed by hand during the promotion: lifting leaves it
      await c.query(`update item_variants set price = 89000 where id = $1`, [vs]);
      const sp = (await one(`select id from promotions where tenant_id = $1 and variant_id = $2 and status = 'active'`, [tid, vs])).id;
      r = await tryIt(`select promotion_lift($1,$2,$3) as restored`, [tid, owner, sp]);
      const ls = await line(shirt, vs);
      check('P5 a price changed by hand during the promotion is left as it stands, and promo_was cleared', r.ok && r.row.restored === false && Number(ls.price) === 89000 && ls.promo_was === null, r.err || JSON.stringify(ls));
    }

    // ---- P6 the operations, as a till sends them ----
    {
      const pid = id();
      let out = await push([op('promotion.apply', { id: pid, item_id: mug, price: 25000, note: 'from the till' })]);
      const l = await line(mug);
      check('P6 promotion.apply from a till: applied, under the id the till gave', tag(out[0]) === 'applied' && out[0].data.id === pid && Number(l.price) === 25000 && Number(l.promo_was) === 32000, tag(out[0]) + ' ' + JSON.stringify(l));
      out = await push([op('promotion.apply', { id: id(), item_id: hat, price: 5000 })]);
      check('P6 below cost from a till: rejected with its code', tag(out[0]) === 'rejected:below-cost', tag(out[0]));
      out = await push([op('promotion.reduce', { item_id: mug, price: 22000 })]);
      check('P6 promotion.reduce', tag(out[0]) === 'applied' && Number((await line(mug)).price) === 22000, tag(out[0]));
      out = await push([op('promotion.lift', { item_id: mug })]);
      const lm = await line(mug);
      check('P6 promotion.lift by the line: the price back, the row lifted', tag(out[0]) === 'applied' && out[0].data.restored === true && Number(lm.price) === 32000 && lm.promo_was === null, tag(out[0]) + ' ' + JSON.stringify(lm));
      out = await push([op('promotion.apply', { id: id(), item_id: hat, price: 15000 }, cara)]);
      check('P6 a cashier from a till: refused', tag(out[0]) === 'rejected:forbidden', tag(out[0]));
      out = await push([op('settings.save', { slowMoverDays: 45, promoStillDays: 10 })]);
      const d = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('P6 the two thresholds are saved from a till', tag(out[0]) === 'applied' && d.slowMoverDays === 45 && d.promoStillDays === 10, tag(out[0]) + ' ' + JSON.stringify(d));
      out = await push([op('settings.save', { slowMoverDays: 0 })]);
      check('P6 a threshold of 0 is refused', tag(out[0]) === 'rejected:bad-payload', tag(out[0]));
      const pulled = await asApp(async () => (await c.query('select sync_pull($1, 0, 500) as r', [store])).rows[0].r);
      const sent = pulled.changes.promotions || [];
      check('P6 the pull sends the shop\'s promotions, the lifted ones too (they changed)', sent.length === 3 && sent.every((x) => x.status === 'lifted'), JSON.stringify(sent.map((x) => x.status)));
      check('P6 and the lines carry promo_was', (pulled.changes.items || []).some((x) => x.id === mug && x.promo_was === null) && 'promo_was' in (pulled.changes.item_variants || [{}])[0]);
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE_FAILED:' + (e.stack || e.message)); process.exit(1); });
