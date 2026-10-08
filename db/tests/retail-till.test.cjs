// retail-till.test.cjs — migration 0077: what a shop's till sends, as the
// till sends it (sync_push), and what it gets back (sync_pull).
//   - a line keeps its variant, the price it was listed at, and why it is
//     charged something else
//   - a line nothing has been done with is changed in place
//   - a receipt and a refund carry all that, to the cent
//   - a return not put back on the shelf comes back and leaves as damaged
//   - the pull carries the shop's stock levels
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/retail-till.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });
// ids that sort in the order they are made: a refund's last line is the one that takes the remainder
let made = 0;
const lineId = () => `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-rt@example.com')`, [admin]);
    const tenant = async (name, code) => (await one(`select platform.create_tenant_of_type($1,$2,'Main',$3,'Owner',$4,'standard','retail') as r`, [admin, name, code, id()])).r;
    const made1 = await tenant('Till Test', 'RT1');
    const tid = made1.tenant_id, store = made1.store_id, owner = made1.employee_id;
    const other = await tenant('Till Other', 'RT2');
    const store2 = (await one(`insert into stores (tenant_id, name, code, created_at) values ($1,'Second','RT3', now() + interval '1 second') returning id`, [tid])).id;

    async function asApp(tenantId, fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '') + (o.replayed ? ':replayed' : '');
    const tags = (out) => out.map(tag).join(' ');

    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [tid])).id;
    const vat = (await one(`select id from taxes where tenant_id = $1 and name = 'VAT'`, [tid])).id;
    // someone at the till who may sell and take payment, and nothing else
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    // every price is Rs 115.00 with VAT in it, unless said
    const item = async (name, o = {}) => {
      const it = (await one(`insert into items (tenant_id, name, price, cost, track_stock, sold_by) values ($1,$2,$3,$4,true,$5) returning id`, [tid, name, o.price ?? 11500, o.cost ?? 1000, o.by ?? 'each'])).id;
      await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [tid, it, vat]);
      return it;
    };
    const variant = async (it, name) => (await one(`insert into item_variants (tenant_id, item_id, name, price, cost) values ($1,$2,$3,11500,6200) returning id`, [tid, it, name])).id;
    const shirt = await item('Shirt', { cost: 6200 });
    const shirtM = await variant(shirt, 'M'), shirtL = await variant(shirt, 'L');
    const mug = await item('Mug', { cost: 1400 });
    const rice = await item('Rice', { price: 8000, cost: 4500, by: 'weight' });
    const receive = (st, it, va, qty, cost) => c.query(`select stock_move($1,$2,$3,$4,$5,'receive',$6,'delivery',$7,$8,null)`, [tid, st, it, va, qty, cost, id(), owner]);
    await receive(store, shirt, shirtM, 5000, 6200);
    await receive(store, shirt, shirtL, 5000, 6200);
    await receive(store, mug, null, 10000, 1400);
    await receive(store, rice, null, 10000, 4500);
    await receive(store2, mug, null, 7000, 1400);
    const level = async (it, va, st = store) => (await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va ?? null])).qty;
    const line = (lid) => one(`select item_id, variant_id, name_snapshot, unit_price, list_price, price_kind, price_label, price_by, qty, note, paid from ticket_lines where id = $1`, [lid]);

    let seq = 0;
    const ticket = async () => { const tk = id(); const out = await push([op('ticket.create', { id: tk, store_id: store })]); if (tag(out[0]) !== 'applied') throw new Error('ticket: ' + tag(out[0])); return tk; };
    const add = (tk, o, as) => { const lid = lineId(); return [lid, op('ticket.add_line', { id: lid, ticket_id: tk, qty: 1000, ...o }, as)]; };
    const receipt = (tk, amount, extra = {}, as) => { const rc = id(); seq++; return [rc, op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'RT-' + seq, device_seq: seq, device_time: new Date().toISOString(), payments: [{ payment_type_id: cash, amount }], ...extra }, as)]; };
    const refund = (rc, lines, amount, extra = {}) => { const rf = id(); seq++; return [rf, op('refund.create', { id: rf, refund_of: rc, store_id: store, device_id: dev, number: 'RT-R' + seq, device_seq: seq, device_time: new Date().toISOString(), reason: 'changed their mind', lines, payments: [{ payment_type_id: cash, amount }], ...extra })]; };
    const reviews = async (rc) => (await c.query(`select reason from receipt_reviews where receipt_id = $1 order by 1`, [rc])).rows.map((x) => x.reason).join();
    const rcRow = (rc) => one(`select subtotal, discount_total, tax_total, total, needs_review from receipts where id = $1`, [rc]);

    // ---- A1 a variant ----
    {
      const tk = await ticket();
      const [l1, o1] = add(tk, { item_id: shirt, variant_id: shirtM, name_snapshot: 'Shirt, M', unit_price: 11500 });
      const [rc, o2] = receipt(tk, 11500);
      const out = await push([o1, o2]);
      const row = await line(l1);
      check('A1 a line added with a variant keeps it', tags(out) === 'applied applied' && row.variant_id === shirtM && row.name_snapshot === 'Shirt, M', tags(out));
      check("A1 its receipt takes from that variant's shelf only", (await level(shirt, shirtM)) === 4000 && (await level(shirt, shirtL)) === 5000 && !(await rcRow(rc)).needs_review, [await level(shirt, shirtM), await level(shirt, shirtL)].join());
    }

    // ---- A2 a line that says what it was listed at ----
    const tk2 = await ticket();
    const [d1, od1] = add(tk2, { item_id: mug, name_snapshot: 'Mug', unit_price: 10350, list_price: 11500, price_kind: 'discount', price_label: '10% off' });
    const [, bad1] = add(tk2, { item_id: mug, name_snapshot: 'Mug', unit_price: 12000, list_price: 11500, price_kind: 'discount', price_label: 'more' });
    const [p1, op1] = add(tk2, { item_id: mug, name_snapshot: 'Mug', unit_price: 12000, list_price: 11500, price_kind: 'override', price_label: 'Price changed' });
    const [, bad2] = add(tk2, { item_id: mug, name_snapshot: 'Mug', unit_price: 9000, list_price: 11500, price_kind: 'sale' });
    {
      const out = await push([od1, bad1, op1, bad2]);
      const a = await line(d1), b = await line(p1);
      check('A2 a line keeps the price it was listed at, why it is charged another, and who allowed it',
        tag(out[0]) === 'applied' && Number(a.unit_price) === 10350 && Number(a.list_price) === 11500 && a.price_kind === 'discount' && a.price_label === '10% off' && a.price_by === owner, JSON.stringify(a));
      check('A2 a discount cannot charge more than the listed price; a price change can; a kind nobody knows is refused',
        tag(out[1]) === 'rejected:bad-payload' && tag(out[2]) === 'applied' && Number(b.unit_price) === 12000 && b.price_kind === 'override' && tag(out[3]) === 'rejected:bad-payload', tags(out));
    }

    // ---- A3 a line changed in place ----
    {
      const e1 = op('ticket.edit_line', { line_id: d1, qty: 3000 });
      const e2 = op('ticket.edit_line', { line_id: d1, note: 'gift' });
      const e3 = op('ticket.edit_line', { line_id: d1, unit_price: 9000, list_price: 11500, price_kind: 'override', price_label: 'Price changed' });
      let out = await push([e1, e2, e3]);
      let row = await line(d1);
      check('A3 a line is changed in place: its quantity, its note, its price', tags(out) === 'applied applied applied' && row.qty === 3000 && row.note === 'gift' && Number(row.unit_price) === 9000 && row.price_kind === 'override', tags(out) + ' ' + JSON.stringify(row));
      out = await push([e1]);
      check('A3 sent twice, it is applied once', tag(out[0]) === 'applied:replayed', tag(out[0]));
      // back to the listed price: the line says nothing about its price any more
      out = await push([op('ticket.edit_line', { line_id: d1, unit_price: 11500, list_price: null, price_kind: null, price_label: null, qty: 1000, note: '' })]);
      row = await line(d1);
      check('A3 a price put back says nothing more about it', tag(out[0]) === 'applied' && Number(row.unit_price) === 11500 && row.list_price === null && row.price_kind === null && row.price_label === null && row.price_by === null && row.note === null && row.qty === 1000, JSON.stringify(row));
      out = await push([op('ticket.edit_line', { line_id: d1, qty: 0 }), op('ticket.edit_line', { line_id: d1, unit_price: -1 }), op('ticket.edit_line', { line_id: id(), qty: 1000 }), op('ticket.edit_line', { line_id: d1 })]);
      check('A3 a quantity of nothing, a price below nothing, a line that is not there, or nothing to change is refused', tags(out) === 'rejected:bad-payload rejected:bad-payload rejected:bad-line rejected:bad-payload', tags(out));
      // a line the kitchen has, a line taken off, a line that is paid
      const tk = await ticket();
      const [s1, os1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 11500 });
      const [v1, ov1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 11500, note: 'x' });
      const [q1, oq1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 11500, note: 'y' });
      await push([os1, ov1, oq1]);
      await c.query(`update ticket_lines set sent_to_kitchen_at = now() where id = $1`, [s1]);
      await push([op('ticket.void_line', { line_id: v1, reason: 'mistake' })]);
      const [, opay] = receipt(tk, 11500, { line_ids: [q1] });
      await push([opay]);
      out = await push([op('ticket.edit_line', { line_id: s1, qty: 2000 }), op('ticket.edit_line', { line_id: v1, qty: 2000 }), op('ticket.edit_line', { line_id: q1, qty: 2000 })]);
      check('A3 a line a kitchen has, a line taken off and a line that is paid cannot be changed', tags(out) === 'rejected:bad-line rejected:bad-line rejected:paid-line', tags(out));
    }

    // ---- A4, A5, A7 a receipt with a discounted line, and its refunds ----
    // (tk2 holds d1, a mug at its listed price again, and p1, a mug re-priced to Rs 120.00: take p1 off)
    await push([op('ticket.void_line', { line_id: p1, reason: 'mistake' })]);
    const tk3 = await ticket();
    const [a1, oa1] = add(tk3, { item_id: shirt, variant_id: shirtL, name_snapshot: 'Shirt, L', unit_price: 10350, list_price: 11500, price_kind: 'discount', price_label: '10% off' });
    const [a2, oa2] = add(tk3, { item_id: mug, name_snapshot: 'Mug', unit_price: 11500, qty: 2000 });
    // Rs 103.50 + Rs 230.00 = Rs 333.50, less 10% on the bill
    const [rc3, orc3] = receipt(tk3, 30015, { discounts: [{ type: 'percent', value: 10, name: 'Friend' }] });
    {
      const out = await push([oa1, oa2, orc3]);
      const r = await rcRow(rc3);
      check('A7 the totals of a receipt with a discounted line are the sums of today, over the price charged',
        tags(out) === 'applied applied applied' && Number(r.subtotal) === 33350 && Number(r.discount_total) === 3335 && Number(r.tax_total) === 3915 && Number(r.total) === 30015, tags(out) + ' ' + JSON.stringify(r));
      check('A5 a line discounted by someone who may is not flagged', r.needs_review === false && (await reviews(rc3)) === '', await reviews(rc3));
      const rl = (await c.query(`select name_snapshot, unit_price, list_price, price_kind, price_label from receipt_lines where receipt_id = $1 order by ticket_line_id`, [rc3])).rows;
      check('A4 the receipt keeps what each line was listed at', rl.length === 2 && Number(rl[0].list_price) === 11500 && rl[0].price_kind === 'discount' && rl[0].price_label === '10% off' && rl[1].list_price === null, JSON.stringify(rl));
      // one mug back, then the other, then the shirt: Rs 103.50, Rs 103.50, Rs 93.15
      const [rf1, of1] = refund(rc3, [{ ticket_line_id: a2, qty: 1000 }], 10350);
      const [, of2] = refund(rc3, [{ ticket_line_id: a2, qty: 1000 }], 10350);
      const [rf3, of3] = refund(rc3, [{ ticket_line_id: a1, qty: 1000 }], 9315);
      const back = await push([of1, of2, of3]);
      const sum = Number((await one(`select coalesce(sum(total), 0) as s from receipts where refund_of = $1`, [rc3])).s);
      check('A7 refunded line by line, it gives back the receipt exactly', tags(back) === 'applied applied applied' && sum === 30015, tags(back) + ' ' + sum);
      const rfl = await one(`select list_price, price_kind, price_label from receipt_lines where receipt_id = $1`, [rf3]);
      check("A4 a refund's line keeps it too", Number(rfl.list_price) === 11500 && rfl.price_kind === 'discount' && rfl.price_label === '10% off', JSON.stringify(rfl));
      check('A8 a refund, as before, puts the goods back', (await level(shirt, shirtL)) === 5000 && (await level(mug)) === 9000, [await level(shirt, shirtL), await level(mug)].join());
      void rf1;
    }
    // (mugs: 10 received, 1 sold in A3, 2 sold and 2 back here: 9)

    // a listed price that is no longer the catalog's is still drift
    {
      const tk = await ticket();
      const [, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 9000, list_price: 10000, price_kind: 'discount', price_label: '10% off' });
      const [rc, o2] = receipt(tk, 9000);
      const out = await push([o1, o2]);
      check('A5 a listed price that is not the catalog price is still flagged as drift', tags(out) === 'applied applied' && (await reviews(rc)) === 'price-drift', tags(out) + ' ' + (await reviews(rc)));
    }

    // ---- A6 someone who may not ----
    {
      const tk = await ticket();
      const [, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 10350, list_price: 11500, price_kind: 'discount', price_label: '10% off' }, cara);
      const [rc, o2] = receipt(tk, 10350, {}, cara);
      const out = await push([o1, o2]);
      const r = await rcRow(rc);
      check('A6 a line discounted by someone who may not is stored, and flagged', tags(out) === 'applied applied' && r.needs_review === true && (await reviews(rc)) === 'price-unapproved', tags(out) + ' ' + (await reviews(rc)));
      // with someone who may standing by
      const tkb = await ticket();
      const [lb, ob1] = add(tkb, { item_id: mug, name_snapshot: 'Mug', unit_price: 9000, list_price: 11500, price_kind: 'override', price_label: 'Price changed', approved_by: owner }, cara);
      const [rcb, ob2] = receipt(tkb, 9000, {}, cara);
      const outb = await push([ob1, ob2]);
      check('A5 a price changed with the go-ahead of someone who may is not flagged, and names them', tags(outb) === 'applied applied' && (await reviews(rcb)) === '' && (await line(lb)).price_by === owner, tags(outb) + ' ' + (await reviews(rcb)));
      // a price change takes its own right: one who may discount may not re-price
      const disc = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Discounts','["sale.create","payment.take","sale.apply_discount"]'::jsonb) returning id`, [tid])).id;
      const dan = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Dan',$2) returning id`, [tid, disc])).id;
      const tkc = await ticket();
      const [, oc1] = add(tkc, { item_id: mug, name_snapshot: 'Mug', unit_price: 10350, list_price: 11500, price_kind: 'discount', price_label: '10% off' }, dan);
      const [, oc2] = add(tkc, { item_id: mug, name_snapshot: 'Mug', unit_price: 9000, list_price: 11500, price_kind: 'override', price_label: 'Price changed', note: 'b' }, dan);
      const [rcc, oc3] = receipt(tkc, 19350, {}, dan);
      const outc = await push([oc1, oc2, oc3]);
      const why = await one(`select detail from receipt_reviews where receipt_id = $1 and reason = 'price-unapproved'`, [rcc]);
      check('A6 a price change needs its own right: one who may only discount is flagged for it, and only for it', tags(outc) === 'applied applied applied' && why && why.detail.lines.length === 1 && why.detail.lines[0].kind === 'override', tags(outc) + ' ' + JSON.stringify(why));
    }

    // ---- A13 a discounted line divided between two checks (migration 0078) ----
    {
      const tk = await ticket();
      // three mugs at Rs 103.50 each, listed at Rs 115.00
      const [l1, o1] = add(tk, { item_id: mug, name_snapshot: "Mug", unit_price: 10350, list_price: 11500, price_kind: "discount", price_label: "10% off", qty: 3000 });
      const l2 = lineId();
      const out = await push([o1, op("ticket.split_line", { line_id: l1, new_id: l2, qty: 1000 })]);
      const part = await line(l2);
      check("A13 a line divided for a split check keeps what it was listed at, on both parts", tags(out) === "applied applied" && Number(part.unit_price) === 10350 && Number(part.list_price) === 11500 && part.price_kind === "discount" && part.price_label === "10% off" && part.price_by === owner && part.qty === 1000 && (await line(l1)).qty === 2000, tags(out) + " " + JSON.stringify(part));
      const [rcA, oA] = receipt(tk, 20700, { line_ids: [l1] });
      const [rcB, oB] = receipt(tk, 10350, { line_ids: [l2] });
      const paid = await push([oA, oB]);
      const rl = (await c.query(`select list_price, price_kind from receipt_lines where receipt_id = any($1::uuid[])`, [[rcA, rcB]])).rows;
      check("A13 and paid as two checks, neither is flagged and both receipts say what the line was", tags(paid) === "applied applied" && (await reviews(rcA)) === "" && (await reviews(rcB)) === "" && rl.length === 2 && rl.every((x) => Number(x.list_price) === 11500 && x.price_kind === "discount"), tags(paid) + " " + (await reviews(rcA)) + "|" + (await reviews(rcB)) + " " + JSON.stringify(rl));
    }

    // ---- A8 a return not put back on the shelf ----
    {
      const tk = await ticket();
      const [l1, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 11500, qty: 2000 });
      const [rc, o2] = receipt(tk, 23000);
      await push([o1, o2]);
      const before = await level(mug);
      const [rf, of1] = refund(rc, [{ ticket_line_id: l1, qty: 1000 }], 11500, { restock: false });
      let out = await push([of1]);
      const moves = (await c.query(`select reason, qty, ref_type, unit_cost::float8 as cost from stock_movements where ref_id = $1 order by created_at, reason desc`, [rf])).rows;
      check('A8 a return not put back comes back at the cost it left at and leaves again as damaged',
        tag(out[0]) === 'applied' && (await level(mug)) === before && moves.map((m) => `${m.reason}:${m.qty}:${m.ref_type}`).join() === 'refund:1000:receipt,damaged:-1000:refund-writeoff' && moves[0].cost === 1400, tag(out[0]) + ' ' + JSON.stringify(moves));
      out = await push([of1]);
      check('A8 sent twice, it moves stock once', tag(out[0]) === 'applied:replayed' && (await level(mug)) === before && Number((await one(`select count(*) as n from stock_movements where ref_id = $1`, [rf])).n) === 2);
      const [, of2] = refund(rc, [{ ticket_line_id: l1, qty: 1000 }], 11500, { restock: true });
      await push([of2]);
      check('A8 put back, it is on the shelf again', (await level(mug)) === before + 1000, String(await level(mug)));
    }

    // ---- A9 sold by weight ----
    {
      const tk = await ticket();
      // 350 g at Rs 80.00 a kilo
      const [l1, o1] = add(tk, { item_id: rice, name_snapshot: 'Rice', unit_price: 8000, qty: 350 });
      const [rc, o2] = receipt(tk, 2800);
      const out = await push([o1, o2]);
      check('A9 a weighed line is charged and leaves the shelf by its weight', tags(out) === 'applied applied' && Number((await rcRow(rc)).total) === 2800 && (await level(rice)) === 9650 && (await line(l1)).qty === 350, tags(out) + ' ' + (await level(rice)));
    }

    // ---- A10 the pull ----
    {
      const pull = (st, cursor, as = tid) => asApp(as, async () => (await c.query(`select sync_pull($1, $2, 1000) as r`, [st, cursor])).rows[0].r);
      const first = await pull(store, 0);
      const mine = first.changes.stock_levels ?? [];
      check("A10 the pull carries the shop's own stock levels, and no other shop's",
        mine.length === 4 && mine.every((l) => l.store_id === store) && mine.some((l) => l.item_id === shirt && l.variant_id === shirtM && l.qty === 4000), JSON.stringify(mine.map((l) => [l.store_id === store, l.qty])));
      const [, o1] = add(await ticket(), { item_id: mug, name_snapshot: 'Mug', unit_price: 11500 });
      const tkp = o1.payload.ticket_id;
      const [, o2] = receipt(tkp, 11500);
      await push([o1, o2]);
      const next = await pull(store, first.next_cursor);
      const again = next.changes.stock_levels ?? [];
      check('A10 a level that changed arrives again, alone', again.length === 1 && again[0].item_id === mug && again[0].qty === (await level(mug)), JSON.stringify(again.map((l) => l.qty)));
      const theirs = await asApp(other.tenant_id, async () => {
        await c.query('SAVEPOINT other');
        try { await c.query(`select sync_pull($1, 0, 1000)`, [store]); await c.query('RELEASE SAVEPOINT other'); return 'pulled'; }
        catch (e) { await c.query('ROLLBACK TO SAVEPOINT other'); return e.message; }
      });
      check("T1 another tenant cannot pull our shop", theirs === 'unknown store', theirs);
    }

    // ---- A11 a variant's price, from the till ----
    {
      const out = await push([op('item.set_price', { item_id: shirt, variant_id: shirtL, price: 12500 }), op('item.set_price', { item_id: shirt, variant_id: id(), price: 12500 }), op('item.set_price', { item_id: mug, price: 12000 })]);
      const v = await one(`select (select price from item_variants where id = $1) as l, (select price from item_variants where id = $2) as m, (select price from items where id = $3) as shirt, (select price from items where id = $4) as mug`, [shirtL, shirtM, shirt, mug]);
      check("A11 a variant's price is changed from the till, and nothing else is", tags(out) === 'applied rejected:bad-variant applied' && Number(v.l) === 12500 && Number(v.m) === 11500 && Number(v.shirt) === 11500 && Number(v.mug) === 12000, tags(out) + ' ' + JSON.stringify(v));
      const cashier = await push([op('item.set_price', { item_id: shirt, variant_id: shirtL, price: 100 })], cara);
      check('A11 by someone allowed to edit products only', tag(cashier[0]) === 'rejected:forbidden', tag(cashier[0]));
    }

    // ---- A12 the right to change a price ----
    {
      const roles = (await c.query(`select name, permissions ? 'sale.change_price' as has from roles where tenant_id = $1 and name in ('Manager','Cashier','Waiter') order by name`, [tid])).rows;
      check("A12 a new tenant's Manager may change a price; its Cashier and Waiter may not", roles.map((r) => r.name + ':' + r.has).join() === 'Cashier:false,Manager:true,Waiter:false', JSON.stringify(roles));
      const old = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Old manager','["sale.create","sale.apply_restricted_discount"]'::jsonb) returning id`, [tid])).id;
      const n = (await one(`select grant_price_perm($1) as n`, [tid])).n;
      const has = (await one(`select permissions ? 'sale.change_price' as has from roles where id = $1`, [old])).has;
      check('A12 a role that could give a restricted discount is given it, once', n === 1 && has === true && (await one(`select grant_price_perm($1) as n`, [tid])).n === 0, String(n));
    }
    // ---- E an exchange: goods come back and pay for part of a new sale (migration 0079) ----
    {
      const types = (await c.query(`select id, opens_drawer, is_active from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [tid])).rows;
      check('E1 a shop has one Exchange payment type, which opens no drawer', types.length === 1 && types[0].opens_drawer === false && types[0].is_active === true, JSON.stringify(types));
      const exch = types[0].id;
      const card = (await one(`select id from payment_types where tenant_id = $1 and name = 'Card'`, [tid])).id;
      const second = await asApp(tid, async () => {
        await c.query('SAVEPOINT second');
        try { await c.query(`insert into payment_types (tenant_id, name, kind) values ($1,'Another exchange','exchange')`, [tid]); await c.query('RELEASE SAVEPOINT second'); return 'made'; }
        catch (e) { await c.query('ROLLBACK TO SAVEPOINT second'); return 'refused'; }
      });
      check('E1 and cannot be given a second', second === 'refused', second);

      // what each kind of payment holds, refunds taken off
      const nets = async () => {
        const rows = (await c.query(`select pt.kind, sum(case when r.type = 'refund' then -p.amount else p.amount end)::int as net
          from receipt_payments p join receipts r on r.id = p.receipt_id join payment_types pt on pt.id = p.payment_type_id where p.tenant_id = $1 group by pt.kind`, [tid])).rows;
        const by = Object.fromEntries(rows.map((x) => [x.kind, x.net]));
        return { cash: by.cash ?? 0, card: by.card ?? 0, exchange: by.exchange ?? 0 };
      };
      const moved = (a, b) => [b.cash - a.cash, b.card - a.card, b.exchange - a.exchange].join('/');
      const sell = async (items, payments) => {
        const tk = await ticket();
        const adds = items.map((o) => add(tk, o));
        const [rc, o] = receipt(tk, 0, { payments });
        const out = await push([...adds.map((a) => a[1]), o]);
        return { rc, lines: adds.map((a) => a[0]), said: tags(out), number: 'RT-' + seq };
      };
      const back = async (rc, line, payments, extra = {}) => {
        const [rf, o] = refund(rc, [{ ticket_line_id: line, qty: 1000 }], 0, { payments, ...extra });
        const out = await push([o]);
        return { rf, said: tag(out[0]), number: 'RT-R' + seq };
      };
      // products of this section's own: nothing above has changed their prices
      const cup = await item('Cup', { cost: 1400 }), tea = await item('Tea', { price: 8000, cost: 4500 }), vase = await item('Vase', { cost: 3000 });
      for (const it of [cup, tea, vase]) await receive(store, it, null, 10000, 1000);
      const mugLine = { item_id: cup, name_snapshot: 'Cup', unit_price: 11500 };
      const riceLine = { item_id: tea, name_snapshot: 'Tea', unit_price: 8000 };

      // two cups are sold for cash; each comes back in an exchange of its own
      const a = await sell([mugLine, mugLine], [{ payment_type_id: cash, amount: 23000 }]);
      let was = await nets();
      const mugs = await level(cup), rices = await level(tea);
      // worth more: a cup (Rs 115.00) for a cup and a tin of tea (Rs 195.00). The customer pays Rs 80.00 by card
      const r1 = await back(a.rc, a.lines[0], [{ payment_type_id: exch, amount: 11500 }]);
      const s1 = await sell([mugLine, riceLine], [{ payment_type_id: exch, amount: 11500, reference: r1.number }, { payment_type_id: card, amount: 8000 }]);
      let now = await nets();
      check('E2 an exchange for goods worth more: the refund and the sale are both taken, and neither is flagged',
        r1.said === 'applied' && s1.said === 'applied applied applied' && (await reviews(s1.rc)) === '' && !(await rcRow(s1.rc)).needs_review, r1.said + ' | ' + s1.said + ' | ' + (await reviews(s1.rc)));
      check('E2 only the difference changed hands: Rs 80.00 by card, nothing in cash, and the exchange holds nothing', moved(was, now) === '0/8000/0', moved(was, now));
      check('E2 the cup that came back is on the shelf, and what left has left', (await level(cup)) === mugs && (await level(tea)) === rices - 1000, [await level(cup), await level(tea)].join());
      // worth less: the other cup (Rs 115.00) for a tin of tea (Rs 80.00). The shop gives Rs 35.00 back in cash
      was = now;
      const r2 = await back(a.rc, a.lines[1], [{ payment_type_id: exch, amount: 8000 }, { payment_type_id: cash, amount: 3500 }]);
      const s2 = await sell([riceLine], [{ payment_type_id: exch, amount: 8000, reference: r2.number }]);
      now = await nets();
      check('E3 an exchange for goods worth less: Rs 35.00 goes back in cash, and the exchange holds nothing',
        r2.said === 'applied' && s2.said === 'applied applied' && (await reviews(s2.rc)) === '' && moved(was, now) === '-3500/0/0', r2.said + ' | ' + s2.said + ' | ' + moved(was, now));
      // worth the same: a vase (Rs 115.00) for a cup (Rs 115.00), and the vase is faulty
      const b = await sell([{ item_id: vase, name_snapshot: 'Vase', unit_price: 11500 }], [{ payment_type_id: cash, amount: 11500 }]);
      was = await nets();
      const shirts = await level(vase);
      const r3 = await back(b.rc, b.lines[0], [{ payment_type_id: exch, amount: 11500 }], { restock: false });
      const s3 = await sell([mugLine], [{ payment_type_id: exch, amount: 11500, reference: r3.number }]);
      now = await nets();
      check('E4 an even exchange: nothing changes hands', r3.said === 'applied' && s3.said === 'applied applied' && (await reviews(s3.rc)) === '' && moved(was, now) === '0/0/0', r3.said + ' | ' + s3.said + ' | ' + moved(was, now));
      const wrote = (await c.query(`select reason, qty from stock_movements where ref_id = $1 order by created_at, reason desc`, [r3.rf])).rows.map((m) => m.reason + ':' + m.qty).join();
      check('E4 and what came back faulty is written off, not put back', (await level(vase)) === shirts && wrote === 'refund:1000,damaged:-1000', (await level(vase)) + ' ' + wrote);
      const paidBy = (await c.query(`select pt.name, p.amount::int, p.reference from receipt_payments p join payment_types pt on pt.id = p.payment_type_id where p.receipt_id = $1 order by p.amount desc`, [s1.rc])).rows;
      check('E2 the sale says what paid for it: the returned goods, naming their refund, and the card',
        paidBy.map((x) => [x.name, x.amount, x.reference ?? ''].join(':')).join() === `Exchange:11500:${r1.number},Card:8000:`, JSON.stringify(paidBy));

      // the refund the sale names is not there: another till refunded that receipt first, and this till's refund was refused
      const s4 = await sell([mugLine], [{ payment_type_id: exch, amount: 8000, reference: 'RT-R-NOWHERE' }, { payment_type_id: cash, amount: 3500 }]);
      const why = (await one(`select detail from receipt_reviews where receipt_id = $1 and reason = 'exchange-unmatched'`, [s4.rc]))?.detail;
      check('E5 a sale settled against a refund that is not there is stored, and flagged', s4.said === 'applied applied' && (await reviews(s4.rc)) === 'exchange-unmatched' && (await rcRow(s4.rc)).needs_review === true
        && JSON.stringify(why) === JSON.stringify({ credits: [{ amount: 8000, refund: 'RT-R-NOWHERE' }] }), s4.said + ' | ' + (await reviews(s4.rc)) + ' | ' + JSON.stringify(why));
      // a refund that gave Rs 80.00 to an exchange cannot pay for Rs 115.00 of a sale
      const cRc = await sell([mugLine, mugLine], [{ payment_type_id: cash, amount: 23000 }]);
      const r5 = await back(cRc.rc, cRc.lines[0], [{ payment_type_id: exch, amount: 8000 }, { payment_type_id: cash, amount: 3500 }]);
      const s5 = await sell([mugLine], [{ payment_type_id: exch, amount: 11500, reference: r5.number }]);
      check('E5 so is one settled for another amount than its refund gave', r5.said === 'applied' && (await reviews(s5.rc)) === 'exchange-unmatched', r5.said + ' | ' + (await reviews(s5.rc)));
      // one refund pays for one sale
      const s6 = await sell([mugLine], [{ payment_type_id: exch, amount: 11500, reference: r1.number }]);
      check('E5 and one that names a refund another sale has used', (await reviews(s6.rc)) === 'exchange-unmatched', await reviews(s6.rc));
      check('E5 the first sale that used it stays as it was', (await reviews(s1.rc)) === '');

      // what was settled with goods is not corrected into money, nor money into it
      const fix = (rc, from, to) => push([op('payment.correct', { id: id(), receipt_id: rc, from_payment_type_id: from, to_payment_type_id: to })]).then((out) => tag(out[0]));
      const f1 = await fix(s1.rc, exch, cash), f2 = await fix(s1.rc, card, exch), f3 = await fix(s1.rc, card, cash);
      check('E6 a payment is not corrected from or to the exchange; another correction still works', f1 === 'rejected:bad-payment' && f2 === 'rejected:bad-payment' && f3 === 'applied', [f1, f2, f3].join(' '));

      // the type follows the kind of business
      const live = async (t) => (await c.query(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [t])).rows.map((x) => x.id);
      const first = await live(other.tenant_id);
      await c.query(`select platform.set_tenant_business_type($1,$2,'restaurant')`, [admin, other.tenant_id]);
      const asRestaurant = await live(other.tenant_id);
      await c.query(`select platform.set_tenant_business_type($1,$2,'retail')`, [admin, other.tenant_id]);
      const again = await live(other.tenant_id);
      check('E7 a shop that becomes a restaurant has no Exchange type; a shop again, it has the one it had', first.length === 1 && asRestaurant.length === 0 && again.join() === first.join(), JSON.stringify({ first, asRestaurant, again }));
      const bistro = (await one(`select platform.create_tenant_of_type($1,'Till Bistro','Main','RT9','Owner',$2,'standard','restaurant') as r`, [admin, id()])).r;
      check('E7 a restaurant is not given one', (await live(bistro.tenant_id)).length === 0);
      const pulled = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
      check('E8 the till is sent the Exchange type with the others', (pulled.changes.payment_types || []).some((x) => x.kind === 'exchange' && x.id === exch));
    }

    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'RETAIL TILL PASS' : `RETAIL TILL FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
