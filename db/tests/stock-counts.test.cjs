// stock-counts.test.cjs — the stock counts migration: a shop counts its shelves.
//   - a count covers the whole shop, or one category, supplier or brand
//   - scans add up, whoever scans; the shop keeps selling while it is counted
//   - completing puts each counted line right once, through the stock engine
//   - a completed count is a record
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/stock-counts.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-sc@example.com')`, [admin]);
    const tenant = async (name, code) => (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,'standard') as r`, [admin, name, code, id()])).r;
    const made = await tenant('Counts Test', 'SC1');
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const other = await tenant('Counts Other', 'SC2');
    const store2 = (await one(`insert into stores (tenant_id, name, code, created_at) values ($1,'Second','SC3', now() + interval '1 second') returning id`, [tid])).id;
    const clothing = (await one(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [tid])).id;
    const home = (await one(`insert into categories (tenant_id, name) values ($1,'Home') returning id`, [tid])).id;
    const sup = (await one(`insert into suppliers (tenant_id, name) values ($1,'Textiles Ocean') returning id`, [tid])).id;
    const item = async (name, o = {}) => (await one(
      `insert into items (tenant_id, name, price, cost, track_stock, category_id, supplier_id, brand, barcode) values ($1,$2,10000,$3,$4,$5,$6,$7,$8) returning id`,
      [tid, name, o.cost ?? 1000, o.track ?? true, o.cat ?? null, o.sup ?? null, o.brand ?? null, o.barcode ?? null])).id;
    const variant = async (it, name) => (await one(`insert into item_variants (tenant_id, item_id, name, price, cost) values ($1,$2,$3,10000,6200) returning id`, [tid, it, name])).id;
    const shirt = await item('Shirt', { cat: clothing, sup, brand: 'Maison', cost: 6200 });
    const shirtM = await variant(shirt, 'M'), shirtL = await variant(shirt, 'L');
    const scarf = await item('Scarf', { cat: clothing, cost: 2800, barcode: '2000000000015' });
    const mug = await item('Mug', { cat: home, sup, cost: 1400 });
    const candle = await item('Candle', { cat: home, brand: 'Maison', cost: 2100 });
    const fee = await item('Bag fee', { track: false });
    const receive = (st, it, va, qty, cost) => c.query(`select stock_move($1,$2,$3,$4,$5,'receive',$6,'delivery',$7,$8,null)`, [tid, st, it, va, qty, cost, id(), emp]);
    await receive(store, shirt, shirtM, 4000, 6200);
    await receive(store, shirt, shirtL, 3000, 6200);
    await receive(store, scarf, null, 9000, 2800);
    await receive(store, mug, null, 26000, 1400);
    await receive(store, candle, null, 31000, 2100);
    await receive(store2, scarf, null, 5000, 2800);
    // (one transaction: these deliveries are said to have come two hours before it, see the note in the review below)
    await c.query(`update stock_movements set created_at = now() - interval '2 hours' where tenant_id = $1`, [tid]);
    const level =async (it, va, st = store) => (await one(`select qty from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va ?? null])).qty;

    const startSql = `select count_start($1,$2,$3,$4,$5,$6) as r`;
    const start = async (kind, scope, brand) => (await one(startSql, [tid, emp, store, kind, scope ?? null, brand ?? null])).r;
    const names = async (cnt) => (await c.query(
      `select i.name || coalesce(' ' || v.name, '') as what from stock_count_lines l join items i on i.id = l.item_id left join item_variants v on v.id = l.variant_id
        where l.count_id = $1 order by 1`, [cnt])).rows.map((r) => r.what).join(', ');
    const addSql = `select count_add($1,$2,$3,$4,$5,$6,$7) as n`;
    const scan = async (cnt, it, va) => (await one(addSql, [tid, cnt, it, va ?? null, 1000, 'add', emp])).n;
    const type = async (cnt, it, va, units) => (await one(addSql, [tid, cnt, it, va ?? null, units, 'set', emp])).n;
    const review = async (cnt) => Object.fromEntries((await c.query(`select * from count_review($1,$2)`, [tid, cnt])).rows.map((r) => [r.name + (r.variant ? ' ' + r.variant : ''), r]));
    const state = (r) => `${r.state}:${r.expected}/${r.counted ?? '-'}/${r.diff ?? '-'}`;
    const complete = async (cnt, uncounted) => (await one(`select count_complete($1,$2,$3,$4) as r`, [tid, emp, cnt, uncounted])).r;

    // ---- starting a count ----
    const all = await start('all');
    const head = await one(`select number, status, store_id, scope_kind, title, started_by from stock_counts where id = $1`, [all.id]);
    check('N1 a count of the whole shop has the first number, is open, and has a line for every line of stock', all.number === 'C-0001' && head.status === 'open' && head.store_id === store
      && head.started_by === emp && all.lines === 5 && (await names(all.id)) === 'Candle, Mug, Scarf, Shirt L, Shirt M', JSON.stringify(head) + ' ' + (await names(all.id)));
    check('N1 none of them counted yet', (await one(`select count(*)::int as n from stock_count_lines where count_id = $1 and (counted is not null or counted_at is not null)`, [all.id])).n === 0);
    const byCat = await start('category', clothing), bySup = await start('supplier', sup), byBrand = await start('brand', null, 'maison');
    check('N1 a count of a category, a supplier or a brand has only their lines', (await names(byCat.id)) === 'Scarf, Shirt L, Shirt M' && (await names(bySup.id)) === 'Mug, Shirt L, Shirt M'
      && (await names(byBrand.id)) === 'Candle, Shirt L, Shirt M' && byBrand.number === 'C-0004', [await names(byCat.id), await names(bySup.id), await names(byBrand.id)].join(' | '));
    const titles = (await c.query(`select title from stock_counts where tenant_id = $1 order by number`, [tid])).rows.map((r) => r.title).join(' | ');
    check('N1 each says what it counts', titles === 'The whole shop | Clothing | Textiles Ocean | Maison', titles);
    const empty = [said(await failsWith(startSql, [tid, emp, store, 'brand', null, 'Nobody'])), said(await failsWith(startSql, [tid, emp, store, 'category', id(), null])), said(await failsWith(startSql, [tid, emp, store, 'aisle', null, null]))];
    check('N1 a scope with nothing in it, or that is not one, is refused', empty.join() === 'nothing-to-count,nothing-to-count,bad-scope', empty.join());
    for (const x of [bySup, byBrand]) await c.query(`select count_cancel($1,$2)`, [tid, x.id]);

    // ---- counting ----
    const n1 = await scan(byCat.id, scarf), n2 = await scan(byCat.id, scarf), n3 = await scan(byCat.id, scarf);
    check('N2 each scan adds one to its line, whoever scans', n1 === 1000 && n2 === 2000 && n3 === 3000, [n1, n2, n3].join());
    const t1 = (await one(`select counted, counted_at from stock_count_lines where count_id = $1 and item_id = $2`, [byCat.id, scarf]));
    check('N2 and the line keeps when it was last counted', t1.counted === 3000 && t1.counted_at !== null);
    check('N2 typing sets the line to what was typed', (await type(byCat.id, scarf, null, 9000)) === 9000 && (await type(byCat.id, shirt, shirtM, 4000)) === 4000);
    await scan(byCat.id, mug);
    check('N2 a product outside the scope is added to the count', (await names(byCat.id)) === 'Mug, Scarf, Shirt L, Shirt M');
    const strangers = [said(await failsWith(addSql, [tid, byCat.id, fee, null, 1000, 'add', emp])), said(await failsWith(addSql, [tid, byCat.id, shirt, null, 1000, 'add', emp])),
      said(await failsWith(addSql, [tid, byCat.id, id(), null, 1000, 'add', emp])), said(await failsWith(addSql, [tid, byCat.id, scarf, null, -1, 'set', emp])), said(await failsWith(addSql, [tid, byCat.id, scarf, null, 1000, 'double', emp]))];
    check('N2 what is not a line of stock, or not a quantity, is refused', strangers.join() === 'not-counted,pick-variant,unknown-item,bad-quantity,bad-quantity', strangers.join());
    await c.query(`select count_cancel($1,$2)`, [tid, byCat.id]);

    // ---- the review, and trading during a count ----
    // counted: Shirt M 4 (matches), Shirt L 2 (one short), Scarf 9, Mug 27 (one over); Candle not counted
    await type(all.id, shirt, shirtM, 4000); await type(all.id, shirt, shirtL, 2000); await type(all.id, scarf, null, 9000); await type(all.id, mug, null, 27000);
    // This whole suite is one transaction, so everything that moves stock in it carries the
    // transaction's own time. These four lines are said to have been counted an hour before it:
    // what moves from here on is then "after they were counted", as it would be in a shop.
    await c.query(`update stock_count_lines set counted_at = now() - interval '1 hour' where count_id = $1 and counted_at is not null`, [all.id]);
    let r = await review(all.id);
    check('N3 the review: expected, counted and the difference of each line', [state(r['Shirt M']), state(r['Shirt L']), state(r.Scarf), state(r.Mug), state(r.Candle)].join(' ')
      === 'matching:4000/4000/0 different:3000/2000/-1000 matching:9000/9000/0 different:26000/27000/1000 uncounted:31000/-/-', Object.values(r).map(state).join(' '));
    check('N3 and what the difference is worth at the line\'s average cost', near(r['Shirt L'].value, -6200) && near(r.Mug.value, 1400) && near(r['Shirt M'].value, 0) && r.Candle.value === null, JSON.stringify([r['Shirt L'].value, r.Mug.value]));

    // N4 a sale after the scarf was counted (9 counted, then 2 sold): expected follows, and so will the level
    await c.query(`select stock_move($1,$2,$3,null,-2000,'sale',null,'receipt',$4,$5,null)`, [tid, store, scarf, id(), emp]);
    r = await review(all.id);
    check('N4 a sale after a line was counted is not a difference: it is applied on top', state(r.Scarf) === 'matching:9000/9000/0' && r.Scarf.moved === -2000 && r.Scarf.target === 7000, JSON.stringify(r.Scarf));
    // a sale of candles before they are counted: 31 - 3 = 28 on the shelf, and 28 is what gets counted
    await c.query(`select stock_move($1,$2,$3,null,-3000,'sale',null,'receipt',$4,$5,null)`, [tid, store, candle, id(), emp]);
    await type(all.id, candle, null, 28000);
    r = await review(all.id);
    check('N4 a sale before a line was counted is already in what was on the shelf', state(r.Candle) === 'matching:28000/28000/0' && r.Candle.moved === 0, JSON.stringify(r.Candle));

    // N5 a sale rung up at the till before the mug was counted, that reaches the server only now
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const ticket = (await one(`insert into tickets (tenant_id, store_id) values ($1,$2) returning id`, [tid, store])).id;
    const late = (await one(`insert into receipts (tenant_id, store_id, device_id, ticket_id, number, total, device_time) values ($1,$2,$3,$4,'T1-LATE',1400, now() - interval '2 hours') returning id`, [tid, store, dev, ticket])).id;
    await c.query(`select stock_move($1,$2,$3,null,-1000,'sale',null,'receipt',$4,$5,null)`, [tid, store, mug, late, emp]);
    r = await review(all.id);
    // the shelf held 27 when counted, and that sale was already gone from it: the books say 25, the shelf said 27
    check('N5 a sale rung up before the count and synced after is not taken for a sale made after it', r.Mug.moved === 0 && r.Mug.expected === 25000 && r.Mug.counted === 27000 && r.Mug.diff === 2000 && r.Mug.target === 27000, JSON.stringify(r.Mug));

    // N9 recount, leave out
    await c.query(`select count_line($1,$2,$3,'recount')`, [tid, all.id, r['Shirt L'].line_id]);
    check('N9 a line to recount is not counted again until it is', state((await review(all.id))['Shirt L']) === 'uncounted:3000/-/-');
    await type(all.id, shirt, shirtL, 2000);
    await c.query(`select count_line($1,$2,$3,'leave')`, [tid, all.id, r.Mug.line_id]);
    check('N9 a line can be left out of the count', (await review(all.id)).Mug.left_out === true);
    await c.query(`select count_line($1,$2,$3,'back')`, [tid, all.id, r.Mug.line_id]);
    check('N9 and put back', (await review(all.id)).Mug.left_out === false);
    await c.query(`select count_line($1,$2,$3,'leave')`, [tid, all.id, r['Shirt M'].line_id]);

    // ---- completing ----
    const before = { scarf2: await level(scarf, null, store2) };
    const done = await complete(all.id, 'leave');
    check('N6 completing puts each counted line at what was counted, plus what moved after', (await level(shirt, shirtL)) === 2000 && (await level(scarf)) === 7000 && (await level(mug)) === 27000 && (await level(candle)) === 28000,
      [await level(shirt, shirtL), await level(scarf), await level(mug), await level(candle)].join());
    const moves = (await c.query(`select i.name, m.qty, m.unit_cost::float8 as cost, m.ref_type, m.employee_id from stock_movements m join items i on i.id = m.item_id
                                   where m.tenant_id = $1 and m.reason = 'count' and m.ref_id = $2 order by i.name`, [tid, all.id])).rows;
    check('N6 with one count movement for each line that differed, the count as its document', moves.map((m) => `${m.name}:${m.qty}`).join() === 'Mug:2000,Shirt:-1000' && moves.every((m) => m.ref_type === 'count' && m.employee_id === emp)
      && near(moves[1].cost, 6200), JSON.stringify(moves));
    check('N6 it says what it changed', done.lines === 2 && done.units === 1000 && near(done.value, 2 * 1400 - 6200), JSON.stringify(done));
    const kept = await review(all.id);
    const fin = await one(`select status, completed_by, completed_at is not null as at, uncounted from stock_counts where id = $1`, [all.id]);
    check('N6 the count is completed, and keeps what each line was expected to hold, its difference and its cost', fin.status === 'completed' && fin.completed_by === emp && fin.at && fin.uncounted === 'leave'
      && state(kept['Shirt L']) === 'different:3000/2000/-1000' && state(kept.Mug) === 'different:25000/27000/2000' && near(kept.Mug.value, 2800) && state(kept.Scarf) === 'matching:9000/9000/0', Object.values(kept).map(state).join(' '));
    check('N7 a line left out is not touched', (await level(shirt, shirtM)) === 4000 && kept['Shirt M'].left_out === true);
    check('N10 a variant is counted on its own line, and another shop is untouched', (await level(scarf, null, store2)) === before.scarf2 && (await one(`select stock_qty from items where id = $1`, [shirt])).stock_qty === 6000);

    // N8 a completed count is a record
    const closed = [said(await failsWith(`select count_complete($1,$2,$3,'leave')`, [tid, emp, all.id])), said(await failsWith(addSql, [tid, all.id, scarf, null, 1000, 'add', emp])),
      said(await failsWith(`select count_line($1,$2,$3,'recount')`, [tid, all.id, kept.Scarf.line_id])), said(await failsWith(`select count_cancel($1,$2)`, [tid, all.id]))];
    check('N8 a completed count is not completed again, counted on, changed or cancelled', closed.every((x) => x === 'count-closed'), closed.join());
    const direct = [said(await failsWith(`update stock_count_lines set counted = 1 where count_id = $1`, [all.id])), said(await failsWith(`delete from stock_count_lines where count_id = $1`, [all.id])),
      said(await failsWith(`insert into stock_count_lines (tenant_id, count_id, item_id) values ($1,$2,$3)`, [tid, all.id, fee]))];
    check('N8 and no statement can change its lines', direct.every((x) => x === 'count-closed'), direct.join());
    check('N8 completing it again moved nothing', (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and reason = 'count'`, [tid])).n === 2);
    check('N8 a cancelled count is not completed either', said(await failsWith(`select count_complete($1,$2,$3,'zero')`, [tid, emp, byCat.id])) === 'count-closed');

    // N7 the lines not counted, set to nothing
    const z = await start('category', home);
    await type(z.id, mug, null, 27000);
    const zdone = await complete(z.id, 'zero');
    check('N7 "set to zero" empties the lines that were not counted, and leaves the counted ones', (await level(candle)) === 0 && (await level(mug)) === 27000 && zdone.lines === 1 && zdone.units === -28000, JSON.stringify(zdone));
    const l2 = await start('category', home);
    await complete(l2.id, 'leave');
    check('N7 "leave" changes nothing for the lines that were not counted', (await level(mug)) === 27000 && (await level(candle)) === 0);
    check('N7 anything else is not an answer', said(await failsWith(`select count_complete($1,$2,$3,'maybe')`, [tid, emp, (await start('category', home)).id])) === 'bad-uncounted');

    // T1 the tenant role
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const mine = await start('supplier', sup);
    await scan(mine.id, mug);
    const rv = await review(mine.id);
    const fd = await complete(mine.id, 'leave');
    check('T1 the tenant role can start, count, review and complete', mine.lines === 3 && rv.Mug.counted === 1000 && fd.lines === 1 && (await level(mug)) === 1000, JSON.stringify(fd));
    await c.query(`select set_config('app.tenant_id', $1, true)`, [other.tenant_id]);
    const seen = await one(`select (select count(*) from stock_counts)::int as c, (select count(*) from stock_count_lines)::int as l, (select count(*) from count_review($1,$2))::int as r`, [tid, mine.id]);
    check('T1 another tenant sees no count of ours', seen.c === 0 && seen.l === 0 && seen.r === 0, JSON.stringify(seen));
    await c.query('SET LOCAL ROLE none');

    // X1 delete all transactions
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    await c.query(`select purge_transactions($1,$2)`, [tid, emp]);
    const left = await one(`select (select count(*) from stock_counts where tenant_id = $1)::int as c, (select count(*) from stock_count_lines where tenant_id = $1)::int as l`, [tid]);
    check('X1 deleting all transactions removes the counts', left.c === 0 && left.l === 0, JSON.stringify(left));
    check('X1 and their numbers start again', (await start('all')).number === 'C-0001');
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'STOCK COUNTS PASS' : `STOCK COUNTS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
