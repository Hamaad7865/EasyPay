// loyalty.test.cjs — migration 0128: loyalty points, as a till sends them
// (sync_push) and gets them back (sync_pull).
//   - a sale earns what the till says it earned, and uses points as a Points
//     discount that needs no right to discount; the balance on the customer
//     moves in the same transaction
//   - the till's figures stand, held to bounds: an unknown customer, points
//     used past the balance, points earned past the total are stored and
//     flagged ("points"), never refused
//   - a refund takes back its share of what the sale earned and gives back
//     its share of what it used, never more than is left of either
//   - an exchange, a split bill, the card on customer.upsert, the settings,
//     the pull, clearing a test client
//   - after every step, a customer's balance is the sum of their receipts
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/loyalty.test.cjs
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-loyalty@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Loyalty Test','Main','LY1','Owner',$2,'offline','retail') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    // a client in the cloud, as one whose test activity can be cleared
    await c.query(`select platform.set_tenant_plan($1,$2,'premium')`, [admin, tid]);

    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const pull = () => asApp(async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const tags = (out) => out.map(tag).join(' ');

    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const cash = (await one(`select id from payment_types where tenant_id = $1 and kind = 'cash' and deleted_at is null order by sort_order limit 1`, [tid])).id;
    const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [tid])).id;
    // a cashier who may take payment and nothing else: no right to give a discount, no right to set up tills
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till only','["sale.create","payment.take"]'::jsonb) returning id`, [tid])).id;
    const cara = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Cara',$2) returning id`, [tid, role])).id;
    const anjali = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Anjali','5555 1234') returning id`, [tid])).id;
    const ravi = (await one(`insert into customers (tenant_id, name, phone) values ($1,'Ravi','5555 9876') returning id`, [tid])).id;
    const toy = (await one(`insert into items (tenant_id, name, price, cost, track_stock) values ($1,'Toy',10000,4000,true) returning id`, [tid])).id;
    await c.query(`select stock_move($1,$2,$3,null,50000,'receive',4000,'delivery',$4,$5,null)`, [tid, store, toy, id(), owner]);
    await c.query(`update pos_settings set data = data || '{"returns":"refund","returnDays":30,"loyalty":"on","loyaltyBp":100}'::jsonb where tenant_id = $1`, [tid]);
    const reviews = async (rc) => (await c.query(`select reason, detail from receipt_reviews where receipt_id = $1 order by 1`, [rc])).rows;
    const pointsFlags = async (rc) => ((await reviews(rc)).find((r) => r.reason === 'points')?.detail?.flags || []).map((f) => f.why);
    const receipt = async (rc) => one(`select customer_id, points_earned::int as earned, points_used::int as used, total::int as total, needs_review from receipts where id = $1`, [rc]);
    const bal = async (cust) => Number((await one(`select points from customers where id = $1`, [cust])).points);
    const sumOf = async (cust) => Number((await one(`select coalesce(sum(points_earned - points_used), 0) as s from receipts where customer_id = $1 and deleted_at is null`, [cust])).s);
    const now = () => new Date().toISOString();
    // what each customer's balance should be, step by step
    const want = { [anjali]: 0, [ravi]: 0 };
    const same = async (label, cust) => {
      const b = await bal(cust), s = await sumOf(cust);
      check(label + ': the balance is ' + want[cust] + ' and the sum of the receipts', b === want[cust] && s === want[cust], 'balance ' + b + ', receipts ' + s);
    };

    let seq = 0;
    // a sale of `qty` toys at 100.00, the ticket for `customer`, paid by `payments`
    const sale = async (qty, payments, { customer = anjali, as, login, extra = {} } = {}) => {
      const tk = id(), l = id(), rc = id(); seq++;
      const ops = [op('ticket.create', { id: tk, store_id: store }, as)];
      if (customer) ops.push(op('ticket.update_meta', { ticket_id: tk, customer_id: customer }, as));
      ops.push(op('ticket.add_line', { id: l, ticket_id: tk, item_id: toy, name_snapshot: 'Toy', unit_price: 10000, qty: qty * 1000 }, as));
      ops.push(op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'LY1-T1-' + seq, device_seq: seq, device_time: now(), payments, ...extra }, as));
      const out = await push(ops, login);
      return { rc, l, tk, out, number: 'LY1-T1-' + seq };
    };
    const refund = async (s, qty, payments, extra = {}) => {
      const rf = id(); seq++;
      const out = await push([op('refund.create', { id: rf, refund_of: s.rc, store_id: store, device_id: dev, number: 'LY1-R' + seq, device_seq: seq, device_time: now(), reason: 'changed mind', lines: [{ ticket_line_id: s.l, qty: qty * 1000 }], payments, ...extra })]);
      return { rf, out, number: 'LY1-R' + seq };
    };
    const pointsOff = (amount) => ({ type: 'amount', value: amount, name: 'Points', amount, points: true });

    // ---- L1 a sale earns ----
    let S1;
    {
      S1 = await sale(3, [{ payment_type_id: cash, amount: 30000, tendered: 30000, change: 0 }], { extra: { points: { customer_id: anjali, earned: 300 } } });
      const r = await receipt(S1.rc);
      check('L1 a sale of 300.00 earning 3.00: applied', tags(S1.out) === 'applied applied applied applied', tags(S1.out));
      check('L1 the receipt keeps who earned and how much', r.customer_id === anjali && r.earned === 300 && r.used === 0, JSON.stringify(r));
      check('L1 nothing flagged', (await reviews(S1.rc)).length === 0 && r.needs_review === false, JSON.stringify(await reviews(S1.rc)));
      want[anjali] += 300;
      await same('L1', anjali);
    }

    // ---- L2 a sale uses points, by a cashier with no right to discount ----
    let S2;
    {
      S2 = await sale(1, [{ payment_type_id: cash, amount: 9800, tendered: 10000, change: 200 }], {
        as: cara, login: cara, extra: { discounts: [pointsOff(200)], points: { customer_id: anjali, earned: 98 } },
      });
      const r = await receipt(S2.rc);
      check('L2 Rs 2.00 of points off a Rs 100 sale, rung up and sent by Cara (no right to discount, no right to set up tills): applied', tags(S2.out) === 'applied applied applied applied', tags(S2.out));
      check('L2 the receipt is 98.00, used 2.00, earned 0.98', r.total === 9800 && r.used === 200 && r.earned === 98, JSON.stringify(r));
      const d = await one(`select name_snapshot, amount::int as amount, discount_id from receipt_discounts where receipt_id = $1`, [S2.rc]);
      check('L2 the points are the receipt\'s discount "Points"', d && d.name_snapshot === 'Points' && d.amount === 200 && d.discount_id === null, JSON.stringify(d));
      check('L2 nothing flagged: points are not a discount the shop gives', (await reviews(S2.rc)).length === 0, JSON.stringify(await reviews(S2.rc)));
      want[anjali] += 98 - 200;
      await same('L2', anjali);
      // an ordinary discount from Cara is still hers to be refused, beside points
      const plain = await sale(1, [{ payment_type_id: cash, amount: 9000, tendered: 9000, change: 0 }], {
        as: cara, login: cara, extra: { discounts: [{ type: 'amount', value: 1000, name: 'Friend', amount: 1000 }] },
      });
      check('L2 an ordinary discount from Cara\'s login is still refused (the rule of 0082 stands)', tag(plain.out[3]) === 'rejected:forbidden', tags(plain.out));
    }

    // ---- L3 more points used than the customer has ----
    {
      const s = await sale(1, [{ payment_type_id: cash, amount: 5000, tendered: 5000, change: 0 }], { extra: { discounts: [pointsOff(5000)], points: { customer_id: anjali, earned: 50 } } });
      const r = await receipt(s.rc);
      check('L3 Rs 50 of points against a balance of Rs 1.98: stored, never refused (the goods left)', tag(s.out[3]) === 'applied' && r.used === 5000 && r.earned === 50, tags(s.out) + ' ' + JSON.stringify(r));
      check('L3 flagged overspent, the receipt to review', (await pointsFlags(s.rc)).includes('overspent') && r.needs_review === true, JSON.stringify(await reviews(s.rc)));
      want[anjali] += 50 - 5000;
      await same('L3 the balance goes below zero', anjali);
      check('L3 it is below zero', (await bal(anjali)) < 0);
    }

    // ---- L4 the customer ----
    {
      const s = await sale(1, [{ payment_type_id: cash, amount: 9900, tendered: 9900, change: 0 }], { customer: null, extra: { discounts: [pointsOff(100)], points: { customer_id: id(), earned: 99 } } });
      const r = await receipt(s.rc);
      check('L4 an unknown customer: applied, the points dropped', tag(s.out[2]) === 'applied' && r.customer_id === null && r.earned === 0 && r.used === 0, tags(s.out) + ' ' + JSON.stringify(r));
      check('L4 the Points discount stays on the receipt, flagged no-customer', r.total === 9900 && (await pointsFlags(s.rc)).includes('no-customer'), JSON.stringify(await reviews(s.rc)));
      // points used and no points block: the ticket's customer is the one
      const s2 = await sale(1, [{ payment_type_id: cash, amount: 9900, tendered: 9900, change: 0 }], { customer: ravi, extra: { discounts: [pointsOff(100)] } });
      const r2 = await receipt(s2.rc);
      check('L4 points used with no points block: the ticket\'s customer (Ravi), who has none: overspent', r2.customer_id === ravi && r2.used === 100 && r2.earned === 0 && (await pointsFlags(s2.rc)).includes('overspent'), JSON.stringify(r2));
      want[ravi] -= 100;
      await same('L4 Ravi', ravi);
    }

    // ---- L5 earned out of bounds ----
    {
      const a = await sale(1, [{ payment_type_id: cash, amount: 10000, tendered: 10000, change: 0 }], { customer: ravi, extra: { points: { customer_id: ravi, earned: -5 } } });
      const ra = await receipt(a.rc);
      check('L5 earned below zero is taken as nothing, flagged over-earned', tag(a.out[3]) === 'applied' && ra.earned === 0 && (await pointsFlags(a.rc)).includes('over-earned'), JSON.stringify(ra));
      const b = await sale(1, [{ payment_type_id: cash, amount: 10000, tendered: 10000, change: 0 }], { customer: ravi, extra: { points: { customer_id: ravi, earned: 999999 } } });
      const rb = await receipt(b.rc);
      check('L5 earned past the total is held to the total, flagged over-earned', tag(b.out[3]) === 'applied' && rb.earned === 10000 && (await pointsFlags(b.rc)).includes('over-earned'), JSON.stringify(rb));
      want[ravi] += 10000;
      await same('L5 Ravi', ravi);
    }

    // ---- L6 refunds take back their share ----
    {
      const r1 = await refund(S1, 1, [{ payment_type_id: cash, amount: 10000 }], { points: { customer_id: anjali, taken: 100, back: 0 } });
      const x1 = await receipt(r1.rf);
      check('L6 a refund of one toy of three takes back 1.00 of the 3.00 earned', tag(r1.out[0]) === 'applied' && x1.customer_id === anjali && x1.earned === -100 && x1.used === 0, tag(r1.out[0]) + ' ' + JSON.stringify(x1));
      check('L6 nothing flagged', (await reviews(r1.rf)).length === 0, JSON.stringify(await reviews(r1.rf)));
      want[anjali] -= 100;
      await same('L6', anjali);
      const r2 = await refund(S1, 2, [{ payment_type_id: cash, amount: 20000 }], { points: { customer_id: anjali, taken: 250, back: 0 } });
      const x2 = await receipt(r2.rf);
      check('L6 the rest claiming 2.50 when 2.00 is left: held to 2.00, flagged over-returned', tag(r2.out[0]) === 'applied' && x2.earned === -200 && (await pointsFlags(r2.rf)).includes('over-returned') && x2.needs_review === true,
        tag(r2.out[0]) + ' ' + JSON.stringify(x2) + ' ' + JSON.stringify(await reviews(r2.rf)));
      want[anjali] -= 200;
      await same('L6 the sale has every point it earned taken back', anjali);
    }

    // ---- L7 a refund gives back the points a sale used ----
    {
      const r = await refund(S2, 1, [{ payment_type_id: cash, amount: 9800 }], { points: { customer_id: anjali, taken: 98, back: 200 } });
      const x = await receipt(r.rf);
      check('L7 the toy bought with Rs 2.00 of points comes back: 0.98 taken back, 2.00 given back', tag(r.out[0]) === 'applied' && x.earned === -98 && x.used === -200, tag(r.out[0]) + ' ' + JSON.stringify(x));
      want[anjali] += 200 - 98;
      await same('L7', anjali);
      // a refund naming points on a sale that had none: held to nothing
      const s = await sale(1, [{ payment_type_id: cash, amount: 10000, tendered: 10000, change: 0 }]);
      const r2 = await refund(s, 1, [{ payment_type_id: cash, amount: 10000 }], { points: { customer_id: anjali, taken: 0, back: 500 } });
      const x2 = await receipt(r2.rf);
      check('L7 a refund giving back points its sale never used: nothing given, flagged over-returned', tag(r2.out[0]) === 'applied' && x2.used === 0 && (await pointsFlags(r2.rf)).includes('over-returned'), JSON.stringify(x2));
      await same('L7 after it', anjali);
    }

    // ---- L8 an exchange ----
    {
      const s = await sale(1, [{ payment_type_id: cash, amount: 10000, tendered: 10000, change: 0 }], { customer: ravi, extra: { points: { customer_id: ravi, earned: 100 } } });
      want[ravi] += 100;
      const r = await refund(s, 1, [{ payment_type_id: exch, amount: 10000 }], { points: { customer_id: ravi, taken: 100, back: 0 } });
      want[ravi] -= 100;
      const n = await sale(1, [{ payment_type_id: exch, amount: 10000, reference: r.number }], { customer: ravi, extra: { points: { customer_id: ravi, earned: 100 } } });
      want[ravi] += 100;
      check('L8 an exchange: the refund to the exchange type and the new sale paid by it are applied', tag(r.out[0]) === 'applied' && tag(n.out[3]) === 'applied', tag(r.out[0]) + ' ' + tags(n.out));
      check('L8 the refund took back what the first sale earned, the new sale earned its own', (await receipt(r.rf)).earned === -100 && (await receipt(n.rc)).earned === 100);
      await same('L8 a like-for-like swap leaves the balance where it was', ravi);
    }

    // ---- L9 a bill split in two receipts ----
    {
      const tk = id(), l1 = id(), l2 = id(), a = id(), b = id();
      const out = await push([
        op('ticket.create', { id: tk, store_id: store }),
        op('ticket.update_meta', { ticket_id: tk, customer_id: ravi }),
        op('ticket.add_line', { id: l1, ticket_id: tk, item_id: toy, name_snapshot: 'Toy', unit_price: 10000, qty: 1000 }),
        op('ticket.add_line', { id: l2, ticket_id: tk, item_id: toy, name_snapshot: 'Toy', unit_price: 10000, qty: 2000 }),
        op('receipt.create', { id: a, ticket_id: tk, store_id: store, device_id: dev, number: 'LY1-T1-' + (++seq), device_seq: seq, device_time: now(), line_ids: [l1], payments: [{ payment_type_id: cash, amount: 10000 }], points: { customer_id: ravi, earned: 100 } }),
        op('receipt.create', { id: b, ticket_id: tk, store_id: store, device_id: dev, number: 'LY1-T1-' + (++seq), device_seq: seq, device_time: now(), line_ids: [l2], payments: [{ payment_type_id: cash, amount: 20000 }], points: { customer_id: ravi, earned: 200 } }),
      ]);
      check('L9 a split bill: both receipts applied, each earning on its own total', tags(out) === 'applied applied applied applied applied applied' && (await receipt(a)).earned === 100 && (await receipt(b)).earned === 200, tags(out));
      check('L9 the order is paid', (await one(`select status from tickets where id = $1`, [tk])).status === 'paid');
      want[ravi] += 300;
      await same('L9', ravi);
    }

    // ---- L10 the card ----
    {
      const before = await bal(anjali);
      const up = (extra) => push([op('customer.upsert', { id: anjali, name: 'Anjali', phone: '5555 1234', ...extra })]);
      const o1 = await up({ card: 'EP0000000001' });
      const c1 = await one(`select card, points from customers where id = $1`, [anjali]);
      check('L10 customer.upsert with a card sets it, and leaves the points alone', tag(o1[0]) === 'applied' && c1.card === 'EP0000000001' && Number(c1.points) === before, tag(o1[0]) + ' ' + JSON.stringify(c1));
      await up({});
      check('L10 without a card the card is kept', (await one(`select card from customers where id = $1`, [anjali])).card === 'EP0000000001');
      await up({ card: '  ' });
      check('L10 a blank card clears it', (await one(`select card from customers where id = $1`, [anjali])).card === null);
      const o4 = await up({ card: 'x'.repeat(41) });
      check('L10 a card longer than 40 is refused', tag(o4[0]) === 'rejected:bad-payload', tag(o4[0]));
      await up({ card: 'EP0000000001' });
      const made2 = id();
      const o5 = await push([op('customer.upsert', { id: made2, name: 'Neha', card: 'EP0000000002' })]);
      check('L10 a customer made on a till with a card', tag(o5[0]) === 'applied' && (await one(`select card, points from customers where id = $1`, [made2])).card === 'EP0000000002');
      check('L10 points stay with the customer after their details change', (await bal(anjali)) === before);
    }

    // ---- L11 the settings ----
    {
      const save = (p) => push([op('settings.save', p)]);
      const o = await save({ loyalty: 'off', loyaltyBp: 250 });
      const d = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('L11 settings.save takes loyalty and loyaltyBp', tag(o[0]) === 'applied' && d.loyalty === 'off' && d.loyaltyBp === 250, tag(o[0]) + ' ' + JSON.stringify({ l: d.loyalty, b: d.loyaltyBp }));
      for (const [label, p] of [['loyalty yes', { loyalty: 'yes' }], ['0%', { loyaltyBp: 0 }], ['over 100%', { loyaltyBp: 10001 }], ['not a number', { loyaltyBp: 'ten' }]]) {
        check('L11 refused: ' + label, tag((await save(p))[0]) === 'rejected:bad-payload');
      }
      await save({ loyalty: 'on', loyaltyBp: 100 });
      check('L11 back on at 1%', (await one(`select data->>'loyalty' as l, (data->>'loyaltyBp')::int as b from pos_settings where tenant_id = $1`, [tid])).b === 100);
    }

    // ---- L12 the pull ----
    {
      const ch = (await pull()).changes;
      const cu = (ch.customers || []).find((x) => x.id === anjali);
      check('L12 the pull carries the customer\'s points and card', cu && Number(cu.points) === want[anjali] && cu.card === 'EP0000000001', JSON.stringify(cu));
      const rc = (ch.receipts || []).find((x) => x.id === S2.rc);
      check('L12 and the receipt\'s customer, points earned and used', rc && rc.customer_id === anjali && Number(rc.points_earned) === 98 && Number(rc.points_used) === 200, JSON.stringify(rc && { c: rc.customer_id, e: rc.points_earned, u: rc.points_used }));
    }

    // ---- L15 a sale with nothing of points is as it was ----
    {
      const s = await sale(1, [{ payment_type_id: cash, amount: 10000, tendered: 10000, change: 0 }]);
      const r = await receipt(s.rc);
      check('L15 a sale without points: none earned or used, nobody named, nothing flagged', r.earned === 0 && r.used === 0 && r.customer_id === null && (await reviews(s.rc)).length === 0, JSON.stringify(r));
    }

    // ---- L13 the balance is the receipts' sum, for everyone ----
    {
      const off = (await c.query(`select c.name, c.points, coalesce(sum(r.points_earned - r.points_used), 0) as s
          from customers c left join receipts r on r.customer_id = c.id and r.deleted_at is null
         where c.tenant_id = $1 group by c.id having c.points <> coalesce(sum(r.points_earned - r.points_used), 0)`, [tid])).rows;
      check('L13 every customer\'s balance is the sum of their receipts', off.length === 0, JSON.stringify(off));
    }

    // ---- L14 clearing a test client ----
    {
      await c.query('SAVEPOINT clear');
      let said = null, left = null;
      try {
        await c.query(`select platform.clear_test_activity($1,$2)`, [admin, tid]);
        left = await one(`select count(*)::int as n from customers c where tenant_id = $1 and points <> coalesce((select sum(points_earned - points_used) from receipts r where r.customer_id = c.id and r.deleted_at is null), 0)`, [tid]);
        left.any = Number((await one(`select coalesce(sum(abs(points)), 0) as s from customers where tenant_id = $1`, [tid])).s);
      } catch (e) { said = e.message; }
      await c.query('ROLLBACK TO SAVEPOINT clear');
      check('L14 Clear test activity puts every balance back to what is left of the receipts (none)', said === null && left.n === 0 && left.any === 0, said || JSON.stringify(left));
    }
  } catch (e) {
    failures++;
    console.log('FAIL ' + e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
