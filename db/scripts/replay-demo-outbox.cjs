// replay-demo-outbox.cjs — sends to the dev server what a till on an emulator
// did with the debug build's made-up shop, and checks the server ends up
// where the till did. It is the till's own operations, as the till wrote
// them, not ones typed here: the proof that what the Android code sends is
// what the server takes.
//
// The shop is android/app/src/debug/assets/demo-shop.json, the same file the
// debug build fills an emulator with (adb shell am broadcast -n
// com.restopos.app/com.restopos.debug.DemoReceiver -a com.restopos.app.DEMO_SHOP).
// It is made here with the same ids, in ONE transaction that is rolled back:
// nothing is left on dev.
//
// Usage: node db/scripts/replay-demo-outbox.cjs <till-state.json> [restaurant]
//   restaurant: the emulator was filled with the same catalog as a restaurant
//   (--es type restaurant), to check a restaurant's till still sends what the
//   server takes.
//   till-state.json: {"outbox": [...], "receipts": [...], "receipt_lines": [...], "levels": [...], "lines": [...]}
//   as read off the emulator with sqlite3 -json (see the plan's record for the commands).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const till = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const restaurant = process.argv[3] === 'restaurant';
  const shop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'debug', 'assets', 'demo-shop.json'), 'utf8'));
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const tid = shop.tenant, store = shop.store.id, owner = shop.staff[0].id;
    await c.query(`insert into tenants (id, tenant_id, name, business_type) values ($1,$1,$2,$3)`, [tid, shop.store.name, restaurant ? 'restaurant' : 'retail']);
    await c.query(`insert into stores (id, tenant_id, name, code) values ($1,$2,$3,$4)`, [store, tid, shop.store.name, shop.store.code]);
    await c.query(`insert into pos_devices (id, tenant_id, store_id, name, code) values ($1,$2,$3,$4,$5)`, [shop.device.id, tid, store, shop.device.name, shop.device.code]);
    const { businessType, ...plain } = shop.settings;
    await c.query(`insert into pos_settings (tenant_id, data) values ($1,$2::jsonb)`, [tid, JSON.stringify(restaurant ? plain : shop.settings)]);
    for (const r of shop.roles) await c.query(`insert into roles (id, tenant_id, name, permissions) values ($1,$2,$3,$4::jsonb)`, [r.id, tid, r.name, JSON.stringify(r.permissions)]);
    for (const e of shop.staff) await c.query(`insert into employees (id, tenant_id, name, role_id) values ($1,$2,$3,$4)`, [e.id, tid, e.name, e.role]);
    await c.query(`insert into taxes (id, tenant_id, name, rate_bp, type, is_default) values ($1,$2,$3,$4,$5,true)`, [shop.tax.id, tid, shop.tax.name, shop.tax.rate_bp, shop.tax.type]);
    if (restaurant) {
      for (const [i, d] of shop.restaurant.dining.entries()) {
        await c.query(`insert into dining_options (id, tenant_id, name, is_default, sort_order, needs_table, kitchen, kind) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [d.id, tid, d.name, d.is_default, i, d.needs_table, d.kitchen, d.kind]);
      }
      for (const [i, t] of shop.restaurant.tables.entries()) {
        await c.query(`insert into tables (id, tenant_id, store_id, name, area, seats, shape, x, y, w, h, sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [t.id, tid, store, t.name, t.area, t.seats, t.shape, t.x, t.y, t.w, t.h, i]);
      }
    } else {
      await c.query(`insert into dining_options (id, tenant_id, name, is_default, sort_order, needs_table, kitchen, kind) values ($1,$2,$3,true,0,false,'pay',$4)`, [shop.dining.id, tid, shop.dining.name, shop.dining.kind]);
    }
    for (const [i, p] of shop.payments.entries()) await c.query(`insert into payment_types (id, tenant_id, name, kind, opens_drawer, sort_order) values ($1,$2,$3,$4,$5,$6)`, [p.id, tid, p.name, p.kind, p.opens_drawer, i]);
    for (const k of shop.categories) await c.query(`insert into categories (id, tenant_id, name) values ($1,$2,$3)`, [k.id, tid, k.name]);
    for (const it of shop.items) {
      await c.query(
        `insert into items (id, tenant_id, category_id, name, price, cost, sku, barcode, sold_by, track_stock, option_names) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [it.id, tid, it.category, it.name, it.price, it.cost, it.sku, it.barcode, it.sold_by, it.track_stock, it.options],
      );
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it.id, shop.tax.id]);
      for (const v of it.variants) {
        await c.query(`insert into item_variants (id, tenant_id, item_id, name, price, cost, sku, barcode, option_values) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [v.id, tid, it.id, v.name, v.price, v.cost, v.sku, v.barcode, v.values]);
      }
      // what the shop holds, as opening stock at the product's cost
      const stocked = it.variants.length ? it.variants.map((v) => [v.id, v.stock, v.cost]) : [[null, it.stock, it.cost]];
      if (it.track_stock) for (const [va, qty, cost] of stocked) {
        if (qty > 0) await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',$6,'import',$7,$8,null)`, [tid, store, it.id, va, qty, cost, crypto.randomUUID(), owner]);
      }
    }

    // the till's operations, in the order it made them, as its own connection would send them
    const ops = till.outbox.map((o) => ({ op_id: o.op_id, type: o.type, payload: JSON.parse(o.payload), ...(o.employee_id ? { employee_id: o.employee_id } : {}) }));
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const out = (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r;
    await c.query('RESET ROLE');
    const said = out.map((o, i) => ops[i].type + ':' + o.status + (o.code ? ':' + o.code : ''));
    check(`the server takes every one of the till's ${ops.length} operations`, out.length === ops.length && out.every((o) => o.status === 'applied'), '\n     ' + said.join('\n     '));

    // every receipt the till holds is on the server with the same figures, and none is flagged
    for (const r of till.receipts) {
      const s = await one(`select type, subtotal, discount_total, tax_total, total, needs_review from receipts where id = $1`, [r.id]);
      const same = s && s.type === r.type && Number(s.subtotal) === r.subtotal && Number(s.discount_total) === r.discount_total && Number(s.tax_total) === r.tax_total && Number(s.total) === r.total;
      check(`${r.type} ${r.number}: the server's figures are the till's, to the cent`, Boolean(same), JSON.stringify(s) + ' till ' + JSON.stringify([r.subtotal, r.discount_total, r.tax_total, r.total]));
      const why = (await c.query(`select reason from receipt_reviews where receipt_id = $1`, [r.id])).rows.map((x) => x.reason).join();
      check(`${r.type} ${r.number}: nothing to review`, s && s.needs_review === false && why === '', why);
    }
    // each line of each receipt says what the till's says: what was charged, what it was listed at, and why
    const sl = (await c.query(`select rl.receipt_id, rl.ticket_line_id, rl.name_snapshot, rl.unit_price, rl.qty, rl.list_price, rl.price_kind, rl.price_label
                                 from receipt_lines rl join receipts r on r.id = rl.receipt_id where r.tenant_id = $1`, [tid])).rows;
    const key = (l) => [l.receipt_id, l.ticket_line_id, l.name_snapshot, Number(l.unit_price), l.qty, l.list_price == null ? null : Number(l.list_price), l.price_kind, l.price_label].join('|');
    check(`the ${till.receipt_lines.length} receipt lines are the same on both`, sl.map(key).sort().join('\n') === till.receipt_lines.map(key).sort().join('\n'), '\n     server: ' + sl.map(key).sort().join('\n             ') + '\n     till:   ' + till.receipt_lines.map(key).sort().join('\n             '));
    // who allowed each changed price is on the server's line
    for (const l of till.lines.filter((x) => x.price_kind)) {
      const s = await one(`select unit_price, list_price, price_kind, price_by from ticket_lines where id = $1`, [l.id]);
      check(`${l.name_snapshot} (${l.price_label}): the server names who allowed it`, s && Number(s.unit_price) === l.unit_price && s.price_kind === l.price_kind && s.price_by === l.price_by, JSON.stringify(s) + ' till ' + l.price_by);
    }
    // the shelves: what the server holds is what the till shows, line by line
    const levels = (await c.query(`select item_id, variant_id, qty from stock_levels where tenant_id = $1 and store_id = $2`, [tid, store])).rows;
    const held = new Map(levels.map((l) => [l.item_id + '|' + (l.variant_id ?? ''), l.qty]));
    const off = till.levels.filter((l) => (held.get(l.item_id + '|' + (l.variant_id ?? '')) ?? 0) !== l.qty);
    check(`stock: the till's ${till.levels.length} figures are the server's`, off.length === 0, JSON.stringify(off.map((l) => ({ ...l, server: held.get(l.item_id + '|' + (l.variant_id ?? '')) ?? 0 }))));
    // a return not put back: it came back and left again as damaged
    for (const r of till.receipts.filter((x) => x.type === 'refund')) {
      const moves = (await c.query(`select reason, qty, ref_type from stock_movements where ref_id = $1 order by created_at, reason desc`, [r.id])).rows.map((m) => `${m.reason}:${m.qty}:${m.ref_type}`).join(' ');
      const op = ops.find((o) => o.type === 'refund.create' && o.payload.id === r.id);
      console.log(`     refund ${r.number} (restock ${op?.payload.restock === false ? 'off' : 'on'}): ${moves}`);
      if (op?.payload.restock === false) check(`refund ${r.number}: not put back, so written off as damaged`, /refund:\d+:receipt damaged:-\d+:refund-writeoff/.test(moves), moves);
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'REPLAY PASS (rolled back: nothing was left on dev)' : `REPLAY FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('REPLAY_FAILED:' + (e.stack || e.message)); process.exit(1); });
