// seed-demo-client.cjs — fills a client made to be shown to customers with a
// made-up business that looks lived in: something to sell, staff, customers,
// and three weeks of sales behind it, so the till has a menu or a shop on it
// and the back office has figures in its reports. Run by a person, on purpose:
//
//   node db/scripts/seed-demo-client.cjs 7BAFE3B9 "Demo Restaurant"            rehearses it, then puts everything back
//   node db/scripts/seed-demo-client.cjs 7BAFE3B9 "Demo Restaurant" --apply    fills the client
//   node db/scripts/seed-demo-client.cjs 7BAFE3B9 "Demo Restaurant" 1C2D3E4F "Demo Shop"   several, one after another
//   ... --days 30      how many days of sales behind it (21 unless said; 0 for none)
//   ... --dev          the dev branch of .env.local, not production
//
// The client itself, its owner's login and PIN are made in /admin by the
// platform admin: this makes none of them. A client is named twice, by the
// eight characters under its name on /admin and by its name as written there.
// It refuses a client that already has something to sell or has sold
// anything: a made-up business is never mixed into a real one.
//
// What a restaurant gets: the menu of seed_demo_catalog (43 dishes and drinks
// in 8 categories, with their choices), 12 tables in two rooms. What a shop
// gets: 32 products in 5 categories with barcodes (one in eight sizes and
// colours, one sold by weight), three suppliers, and stock: what is left
// today, some of it low and some of it gone. Both get three members of staff
// with a PIN each, eight customers, and the days of sales.
//
// The sales are not written into the tables from here. They go through
// sync_push, the one door a till's work comes in by, as the operations a till
// sends: a day opened, staff clocked in, each order rung up and paid, the
// drawer counted, the day closed. So every figure is one the server worked
// out itself (totals, VAT, stock going down), and a report on them reads as it
// would for a real business. They are sent as a till of their own ("Demo
// history", T0), switched off afterwards: a tablet set up for the client
// starts its own numbers and never meets them. Today is left empty, for the
// sales rung up while showing it.
//
// Without --apply everything is done in one transaction and rolled back, so
// what --apply will do has been done once already. The same client gets the
// same sales both times. Before either ends it checks that every operation
// was taken, that no sale was flagged for review, that the takings are what
// was planned, and that no stock went below nothing. The staff PINs are made
// up when it is done for good, and said once, at the end.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connection, clientOf, pairsOf } = require('./connection.cjs');

// the made-up shop the debug build fills an emulator with: its products are the shop's first thirteen
const shop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'debug', 'assets', 'demo-shop.json'), 'utf8'));
const id = () => crypto.randomUUID();
const RS = 100; // amounts are in cents

// name, category, price, cost, what is left today
const MORE = [
  ['Cotton T-shirt, White M', 'Clothing', 490, 210, 14], ['Polo shirt, Navy L', 'Clothing', 890, 400, 9],
  ['Chino shorts, 32', 'Clothing', 1150, 520, 6], ['Summer dress, S', 'Clothing', 1650, 760, 4], ['Kids T-shirt, 6Y', 'Clothing', 350, 150, 18],
  ['Canvas sneakers, 40', 'Shoes', 1450, 700, 5], ['Flip-flops, 38', 'Shoes', 290, 120, 22], ['Kids sandals, 30', 'Shoes', 590, 260, 7],
  ['Bamboo tray', 'Home', 520, 240, 9], ['Cushion cover', 'Home', 380, 170, 12], ['Glass tumblers, set of 4', 'Home', 640, 300, 6],
  ['Chilli paste 200 g', 'Food', 145, 70, 30], ['Coconut biscuits', 'Food', 95, 45, 44], ['Vanilla pods, 3', 'Food', 320, 150, 15], ['Raw cane sugar 500 g', 'Food', 110, 55, 26],
  ['Dodo keyring', 'Gifts', 120, 40, 60], ['Fridge magnet', 'Gifts', 90, 30, 75], ['Model boat, small', 'Gifts', 1850, 900, 3], ['Greeting card', 'Gifts', 60, 20, 48],
];
const SUPPLIERS = { Clothing: 'Textiles Océan', Shoes: 'Textiles Océan', Food: 'Island Pantry', Home: 'Artisans du Sud', Gifts: 'Artisans du Sud' };
const HUES = { Clothing: 250, Shoes: 25, Home: 140, Food: 60, Gifts: 320 };
// name, room, seats, shape, x, y, w, h: on the floor plan's grid of 100 by 60
const TABLES = [
  ['1', 'Main', 2, 'round', 5, 5, 11, 11], ['2', 'Main', 2, 'round', 21, 5, 11, 11], ['3', 'Main', 4, 'square', 37, 5, 12, 12], ['4', 'Main', 4, 'square', 54, 5, 12, 12],
  ['5', 'Main', 4, 'square', 5, 24, 12, 12], ['6', 'Main', 4, 'square', 22, 24, 12, 12], ['7', 'Main', 6, 'square', 39, 24, 18, 12], ['8', 'Main', 10, 'round', 64, 22, 28, 16],
  ['T1', 'Terrace', 2, 'round', 5, 5, 11, 11], ['T2', 'Terrace', 2, 'round', 21, 5, 11, 11], ['T3', 'Terrace', 4, 'square', 37, 5, 12, 12], ['T4', 'Terrace', 6, 'round', 55, 5, 16, 16],
];
const STAFF = {
  restaurant: [['Priya Ramdin', 'Manager'], ['Kevin Li', 'Cashier'], ['Anil Gopal', 'Waiter']],
  retail: [['Priya Ramdin', 'Manager'], ['Kevin Li', 'Cashier'], ['Sarah Marie', 'Cashier']],
};
const CUSTOMERS = [
  ['Nadia Hossen', '5 712 4410'], ['Jean-Marc Labonne', '5 258 9034'], ['Vikash Beeharry', '5 943 2207'], ['Mei Lin Ah-Kine', '5 471 6652'],
  ['Shameem Joomun', '5 806 1198'], ['Corinne Duval', '5 329 7745'], ['Ravi Seetohul', '5 990 3316'], ['Aisha Peerbux', '5 164 8829'],
];
// a day's trade: when the till opens and shuts (minutes after midnight, the
// store's own time), the hours orders come in and how busy each is, how many
// orders on an ordinary day, and each weekday's share of that (Monday first)
const TRADE = {
  restaurant: { open: 645, shut: 1365, hours: [[690, 870, 45], [870, 1110, 10], [1110, 1320, 45]], orders: 30, week: [0.8, 0.9, 1, 1, 1.35, 1.5, 1.2] },
  retail: { open: 525, shut: 1085, hours: [[540, 720, 40], [720, 840, 25], [840, 1065, 35]], orders: 20, week: [0.9, 0.9, 1, 1, 1.2, 1.5, 0] },
};
const FLOAT = 2000 * RS;

// The same client gets the same sales every time: chance drawn from its ID.
function chance(seed) {
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  const next = () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (a, b) => a + Math.floor(next() * (b - a + 1));
  const of = (list) => list[Math.floor(next() * list.length)];
  // one of a list of [thing, weight]
  const weighed = (list) => {
    let at = next() * list.reduce((n, x) => n + x[1], 0);
    for (const [thing, w] of list) { at -= w; if (at < 0) return thing; }
    return list[list.length - 1][0];
  };
  return { next, int, of, weighed };
}

// As web/lib/pin.ts writes one and the till's PinHash.kt checks it.
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `pbkdf2-sha256$20000$${salt.toString('base64')}$${crypto.pbkdf2Sync(pin, salt, 20000, 32, 'sha256').toString('base64')}`;
}

function ean13(twelve) {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
  return twelve + String((10 - (sum % 10)) % 10);
}

const lineAmount = (price, qty) => Math.floor((price * qty + 500) / 1000); // the server's line_amount

async function seed(c, short, name, apply, days) {
  const rows = async (sql, args) => (await c.query(sql, args)).rows;
  const one = async (sql, args) => (await rows(sql, args))[0];
  await c.query('BEGIN');
  try {
    await c.query(`set local statement_timeout = '300s'`);
    const t = await clientOf(c, short, name);
    const type = t.business_type === 'retail' ? 'retail' : 'restaurant';
    const has = await one(
      `select (select count(*)::int from items where tenant_id = $1) as items, (select count(*)::int from receipts where tenant_id = $1) as receipts,
              (select count(*)::int from tickets where tenant_id = $1) as tickets`, [t.id]);
    if (has.items || has.receipts || has.tickets) throw new Error(`"${t.name}" already has ${has.items} things to sell and ${has.receipts} sales: a made-up business is not mixed into one that exists`);
    const store = await one(`select id, code, timezone from stores where tenant_id = $1 and deleted_at is null order by created_at limit 1`, [t.id]);
    const owner = await one(
      `select e.id from employees e where e.tenant_id = $1 and e.deleted_at is null and e.is_active and e.auth_user_id is not null
          and has_perm(e.id, 'settings.device') order by e.created_at limit 1`, [t.id]);
    const tax = await one(`select id, type from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, created_at limit 1`, [t.id]);
    if (!store || !owner || !tax) throw new Error('the client has no store, no owner login or no tax: it was not made in /admin');
    if (tax.type !== 'included') throw new Error('the client adds its tax on top of its prices: the made-up sales are worked out for prices that include it');
    const roles = new Map((await rows(`select name, id from roles where tenant_id = $1 and deleted_at is null`, [t.id])).map((r) => [r.name, r.id]));
    const pays = new Map();
    for (const p of await rows(`select id, kind from payment_types where tenant_id = $1 and deleted_at is null and is_active order by sort_order`, [t.id])) if (!pays.has(p.kind)) pays.set(p.kind, p.id);
    if (!pays.get('cash') || !pays.get('card')) throw new Error('the client has no Cash or no Card to be paid with');
    const r = chance(t.id);

    // ---- something to sell
    const said = [];
    if (type === 'restaurant') {
      const made = (await one(`select seed_demo_catalog($1) as r`, [t.id])).r;
      if (!made.seeded) throw new Error('the menu was not put in: ' + JSON.stringify(made));
      for (const [i, [tn, room, seats, shape, x, y, w, h]] of TABLES.entries()) {
        await c.query(`insert into tables (tenant_id, store_id, name, area, seats, shape, x, y, w, h, sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [t.id, store.id, tn, room, seats, shape, x, y, w, h, i]);
      }
      said.push(`${made.items} dishes and drinks in ${made.categories} categories, ${made.modifiers} choices, ${TABLES.length} tables in two rooms`);
    } else {
      const cats = new Map();
      for (const [i, k] of shop.categories.entries()) {
        cats.set(k.name, (await one(`insert into categories (tenant_id, name, color, sort_order) values ($1,$2,$3,$4) returning id`, [t.id, k.name, `oklch(0.65 0.13 ${HUES[k.name] ?? 200})`, i])).id);
      }
      const catName = new Map(shop.categories.map((k) => [k.id, k.name]));
      const suppliers = new Map();
      for (const s of new Set(Object.values(SUPPLIERS))) suppliers.set(s, (await one(`insert into suppliers (tenant_id, name) values ($1,$2) returning id`, [t.id, s])).id);
      const products = shop.items.map((it) => ({ ...it, category: catName.get(it.category) })).concat(MORE.map(([n, cat, price, cost, left], i) => ({
        name: n, category: cat, price: price * RS, cost: cost * RS, sku: `${cat.slice(0, 2).toUpperCase()}-${101 + i}`, barcode: ean13('609990' + String(100001 + i)),
        sold_by: 'each', track_stock: true, stock: left * 1000, options: [], variants: [],
      })));
      let variants = 0;
      for (const it of products) {
        it.id = id();
        await c.query(
          `insert into items (id, tenant_id, category_id, name, price, cost, sku, barcode, sold_by, track_stock, option_names, supplier_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [it.id, t.id, cats.get(it.category) ?? null, it.name, it.price, it.cost, it.sku, it.barcode, it.sold_by, it.track_stock, it.options, suppliers.get(SUPPLIERS[it.category]) ?? null]);
        await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) values ($1,$2,$3)`, [t.id, it.id, tax.id]);
        for (const v of it.variants) {
          v.id = id();
          await c.query(`insert into item_variants (id, tenant_id, item_id, name, price, cost, sku, barcode, option_values) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [v.id, t.id, it.id, v.name, v.price, v.cost, v.sku, v.barcode, v.values]);
          variants++;
        }
      }
      said.push(`${products.length} products in ${cats.size} categories, ${variants} sizes and colours, ${suppliers.size} suppliers`);
    }

    // ---- who works there
    const staff = [];
    for (const [who, role] of STAFF[type]) {
      if (!roles.get(role)) throw new Error(`the client has no role called ${role}`);
      let pin;
      do pin = String(crypto.randomInt(0, 10000)).padStart(4, '0'); while (staff.some((s) => s.pin === pin));
      const eid = (await one(`insert into employees (tenant_id, name, role_id, pin_hash) values ($1,$2,$3,$4) returning id`, [t.id, who, roles.get(role), hashPin(pin)])).id;
      await c.query(`insert into employee_stores (tenant_id, employee_id, store_id) select $1, $2, s.id from stores s where s.tenant_id = $1 and s.deleted_at is null`, [t.id, eid]);
      staff.push({ id: eid, name: who, role, pin });
    }
    const manager = staff.find((s) => s.role === 'Manager');
    const tills = staff.filter((s) => s.role !== 'Waiter'); // who may take a payment
    const floor = staff.filter((s) => s.role === 'Waiter').concat(staff.filter((s) => s.role === 'Cashier')); // who rings an order up

    // ---- what there is to sell, as the sales will pick from it. Always in
    // the same order (by name, never by ID, which is new every time), so that
    // the same draws pick the same things in the rehearsal and for good.
    const menu = await rows(
      `select i.id, i.name, i.price, i.sold_by, i.track_stock, coalesce(c.name, '') as category from items i
         left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
        where i.tenant_id = $1 and i.deleted_at is null and i.is_available order by i.name, i.price`, [t.id]);
    const variantsOf = new Map();
    for (const v of await rows(`select id, item_id, price from item_variants where tenant_id = $1 and deleted_at is null order by name, price`, [t.id])) {
      if (!variantsOf.has(v.item_id)) variantsOf.set(v.item_id, []);
      variantsOf.get(v.item_id).push(v);
    }
    // an item's choices: one of each group that asks for one, sometimes an extra
    const choices = new Map();
    for (const m of await rows(
      `select g.item_id, mg.id as grp, mg.min_select, mo.id, mo.price from item_modifier_groups g
         join modifier_groups mg on mg.tenant_id = g.tenant_id and mg.id = g.group_id and mg.deleted_at is null
         join modifiers mo on mo.tenant_id = mg.tenant_id and mo.group_id = mg.id and mo.deleted_at is null
        where g.tenant_id = $1 and g.deleted_at is null order by mg.name, mo.name, mo.price`, [t.id])) {
      if (!choices.has(m.item_id)) choices.set(m.item_id, new Map());
      const groups = choices.get(m.item_id);
      if (!groups.has(m.grp)) groups.set(m.grp, { must: m.min_select > 0, of: [] });
      groups.get(m.grp).of.push({ id: m.id, price: Number(m.price) });
    }
    const dining = new Map((await rows(`select name, id from dining_options where tenant_id = $1 and deleted_at is null`, [t.id])).map((d) => [d.name, d.id]));
    const tables = await rows(`select id, seats from tables where tenant_id = $1 and deleted_at is null order by sort_order, name`, [t.id]);
    const inCats = (...names) => menu.filter((m) => names.includes(m.category));
    const mains = inCats('Curries & mains', 'Rice & noodles', 'Grill & seafood', 'Street food');
    const kinds = { main: mains.length ? mains : menu, starter: inCats('Starters'), dessert: inCats('Desserts'), drink: inCats('Drinks', 'Bar') };

    // one line of an order: the item, how many, its choices, what it comes to
    const lineOf = (item, qty) => {
      const vs = variantsOf.get(item.id);
      const v = vs ? r.of(vs) : null;
      const mods = [];
      for (const g of (choices.get(item.id) ?? new Map()).values()) {
        if (g.must) mods.push(r.of(g.of));
        else if (r.next() < 0.15) mods.push(r.of(g.of));
      }
      const price = Number(v ? v.price : item.price);
      return { item, variant: v, qty, mods, amount: lineAmount(price, qty) + mods.reduce((n, m) => n + m.price, 0) };
    };
    const orderOf = () => {
      const lines = [];
      const add = (item, qty) => {
        const same = lines.find((l) => l.item.id === item.id && !l.variant && !l.mods.length && item.sold_by !== 'weight');
        if (same && !variantsOf.get(item.id) && !choices.get(item.id)) { same.qty += qty; same.amount = lineAmount(Number(item.price), same.qty); } else lines.push(lineOf(item, qty));
      };
      const o = { lines };
      if (type === 'restaurant') {
        o.how = r.weighed([['Dine-in', 65], ['Takeaway', 22], ['Delivery', 8], ['Counter', 5]]);
        if (!dining.get(o.how)) o.how = 'Dine-in';
        const covers = o.how === 'Dine-in' ? r.weighed([[1, 10], [2, 40], [3, 15], [4, 25], [5, 6], [6, 4]]) : r.weighed([[1, 55], [2, 30], [3, 15]]);
        if (o.how === 'Dine-in' && tables.length) { o.table = r.of(tables.filter((tb) => tb.seats >= covers).length ? tables.filter((tb) => tb.seats >= covers) : tables).id; o.covers = covers; }
        for (let n = 0; n < covers; n++) {
          add(r.of(kinds.main), 1000);
          if (kinds.drink.length && r.next() < (o.how === 'Dine-in' ? 0.8 : 0.35)) add(r.of(kinds.drink), 1000);
          if (kinds.starter.length && o.how === 'Dine-in' && r.next() < 0.3) add(r.of(kinds.starter), 1000);
          if (kinds.dessert.length && o.how === 'Dine-in' && r.next() < 0.25) add(r.of(kinds.dessert), 1000);
        }
      } else {
        // what costs less sells more often
        const pick = () => r.weighed(menu.map((m) => [m, 1 / Math.sqrt(Number(m.price) / RS + 40)]));
        for (let n = r.weighed([[1, 50], [2, 30], [3, 15], [4, 5]]); n > 0; n--) {
          const item = pick();
          add(item, item.sold_by === 'weight' ? 250 * r.int(2, 10) : 1000 * r.weighed([[1, 82], [2, 14], [3, 4]]));
        }
      }
      o.total = lines.reduce((n, l) => n + l.amount, 0);
      o.pay = r.weighed([['cash', 48], ['card', 40], [pays.get('wallet') ? 'wallet' : 'card', 12]]);
      return o;
    };

    // ---- the days behind it, planned before anything is sent
    const trade = TRADE[type];
    const calendar = days > 0 ? await rows(
      `select to_char(d, 'YYYY-MM-DD') as day, extract(isodow from d)::int as dow, extract(epoch from (d::timestamp at time zone $2))::bigint as start
         from generate_series((now() at time zone $2)::date - $1::int, (now() at time zone $2)::date - 1, interval '1 day') d order by 1`, [days, store.timezone]) : [];
    const plan = [];
    for (const d of calendar) {
      const n = Math.round(trade.orders * trade.week[d.dow - 1] * (0.85 + r.next() * 0.3));
      if (n <= 0) continue;
      const at = (minute) => new Date((Number(d.start) + minute * 60) * 1000).toISOString();
      const orders = [];
      for (let k = 0; k < n; k++) {
        const [from, to] = r.weighed(trade.hours.map((h) => [h, h[2]]));
        orders.push({ ...orderOf(), minute: r.int(from, to - 1) });
      }
      orders.sort((a, b) => a.minute - b.minute);
      plan.push({ ...d, at, orders });
    }
    const planned = plan.reduce((n, d) => n + d.orders.length, 0);
    const takings = plan.reduce((n, d) => n + d.orders.reduce((m, o) => m + o.total, 0), 0);

    // ---- a shop's stock: what the days will sell, and what is left today
    if (type === 'retail') {
      const sold = new Map();
      for (const d of plan) for (const o of d.orders) for (const l of o.lines) {
        const k = l.item.id + '|' + (l.variant ? l.variant.id : '');
        sold.set(k, (sold.get(k) ?? 0) + l.qty);
      }
      const left = await rows(
        `select i.id as item, null::uuid as variant, i.cost, i.name as name from items i
          where i.tenant_id = $1 and i.track_stock and not exists (select 1 from item_variants v where v.tenant_id = i.tenant_id and v.item_id = i.id)
         union all
         select v.item_id, v.id, v.cost, v.name from item_variants v join items i on i.tenant_id = v.tenant_id and i.id = v.item_id and i.track_stock where v.tenant_id = $1`, [t.id]);
      // what is left today is what the made-up shop's file says, and for the rest what MORE says
      const today = new Map();
      for (const it of shop.items) { if (it.variants.length) for (const v of it.variants) today.set(v.name + '|' + it.name, v.stock); else today.set(it.name, it.stock); }
      for (const [n, , , , units] of MORE) today.set(n, units * 1000);
      const itemName = new Map(menu.map((m) => [m.id, m.name]));
      let stocked = 0;
      for (const s of left) {
        const remains = s.variant ? today.get(s.name + '|' + itemName.get(s.item)) ?? 0 : today.get(s.name) ?? 0;
        const opening = remains + (sold.get(s.item + '|' + (s.variant ?? '')) ?? 0);
        if (opening > 0) { await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',$6,'import',$7,$8,null)`, [t.id, store.id, s.item, s.variant, opening, s.cost, id(), owner.id]); stocked++; }
      }
      // below five of anything, it is on the list of what to order again
      await c.query(
        `update stock_levels l set reorder_point = 5000, reorder_qty = 12000
          where l.tenant_id = $1 and exists (select 1 from items i where i.tenant_id = l.tenant_id and i.id = l.item_id and i.sold_by = 'each')`, [t.id]);
      said.push(`stock on ${stocked} lines`);
    }

    // ---- the till the days were rung up on
    const till = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Demo history','T0') returning id`, [t.id, store.id])).id;
    const op = (opType, payload, by) => ({ op_id: id(), type: opType, payload, ...(by ? { employee_id: by.id } : {}) });
    let sent = 0;
    const push = async (ops) => {
      const out = (await one('select sync_push($1, $2::jsonb) as r', [owner.id, JSON.stringify(ops)])).r;
      const list = Array.isArray(out) ? out : out.results ?? out.ops ?? [];
      if (list.length !== ops.length) throw new Error(`${ops.length} operations sent and ${list.length} answered`);
      list.forEach((e, i) => { if (e.status !== 'applied') throw new Error(`the server did not take a ${ops[i].type}: ${e.status} ${e.code ?? ''}`); });
      sent += ops.length;
    };
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
    await push(CUSTOMERS.map(([who, phone]) => op('customer.upsert', { id: id(), name: who, phone })));
    let seq = 0;
    const short1 = plan.length > 3 ? plan[Math.floor(plan.length / 2)].day : null; // one day the drawer is Rs 50 short
    for (const d of plan) {
      const ops = [];
      const shift = id();
      staff.forEach((s, i) => ops.push(op('timeclock.punch', { id: id(), store_id: store.id, device_id: till, kind: 'in', device_time: d.at(trade.open - 12 + i * 3) }, s)));
      ops.push(op('shift.open', { id: shift, device_id: till, opened_at: d.at(trade.open), opening_float: FLOAT }, manager));
      let cash = 0;
      for (const o of d.orders) {
        const ticket = id();
        const by = r.of(floor);
        ops.push(op('ticket.create', { id: ticket, store_id: store.id, ...(dining.get(o.how) ? { dining_option_id: dining.get(o.how) } : {}), ...(o.table ? { table_id: o.table, covers: o.covers } : {}) }, by));
        for (const l of o.lines) {
          ops.push(op('ticket.add_line', { id: id(), ticket_id: ticket, item_id: l.item.id, qty: l.qty, ...(l.variant ? { variant_id: l.variant.id } : {}), ...(l.mods.length ? { modifier_ids: l.mods.map((m) => m.id) } : {}) }, by));
        }
        const payment = { payment_type_id: pays.get(o.pay), amount: o.total };
        if (o.pay === 'cash') {
          // handed over in notes: the next Rs 100, sometimes the next Rs 500
          const note = (r.next() < 0.3 ? 500 : 100) * RS;
          payment.tendered = Math.ceil(o.total / note) * note;
          payment.change = payment.tendered - o.total;
          cash += o.total;
        }
        seq++;
        ops.push(op('receipt.create', { id: id(), ticket_id: ticket, store_id: store.id, device_id: till, number: `${store.code}-T0-${String(seq).padStart(6, '0')}`, device_seq: seq,
          payments: [payment], device_time: d.at(o.minute) + '' }, r.of(tills)));
      }
      ops.push(op('shift.close', { id: shift, closed_at: d.at(trade.shut), counted_cash: FLOAT + cash - (d.day === short1 ? 50 * RS : 0) }, manager));
      ops.push(op('day.close', { id: id(), store_id: store.id, device_id: till, closed_at: d.at(trade.shut + 5), totals: {} }, manager));
      staff.forEach((s, i) => ops.push(op('timeclock.punch', { id: id(), store_id: store.id, device_id: till, kind: 'out', device_time: d.at(trade.shut + 8 + i * 2) }, s)));
      await push(ops);
    }
    // as a tablet set up for the client would get it
    const page = (await one('select sync_pull($1, 0, 1000) as r', [store.id])).r;
    await c.query('RESET ROLE');
    await c.query(`update pos_devices set deleted_at = now() where id = $1 and tenant_id = $2`, [till, t.id]);

    // ---- when it happened. A sale carries the time it was rung up, and the
    // reports on sales go by that. What the server stores beside it carries
    // the moment it was stored, which is now: the stock pages go by that, and
    // would show three weeks of stock leaving in one minute, and "sold in the
    // last seven days" as everything ever sold. So the stock a sale took goes
    // to that sale's time, the opening stock to the evening before the first
    // day, an order to a while before it was paid, the customers to the start.
    if (plan.length) {
      await c.query(
        `update stock_movements m set created_at = r.device_time from receipts r
          where m.tenant_id = $1 and m.reason = 'sale' and r.tenant_id = m.tenant_id and r.id = coalesce(m.receipt_id, m.ref_id)`, [t.id]);
      await c.query(`update stock_movements set created_at = $2::timestamptz where tenant_id = $1 and reason = 'opening'`, [t.id, plan[0].at(-240)]);
      await c.query(
        `update tickets k set created_at = r.device_time - case when k.table_id is not null then interval '45 minutes' else interval '9 minutes' end
           from receipts r where k.tenant_id = $1 and r.tenant_id = k.tenant_id and r.ticket_id = k.id`, [t.id]);
      await c.query(
        `update ticket_lines l set created_at = k.created_at + interval '1 minute' from tickets k
          where l.tenant_id = $1 and k.tenant_id = l.tenant_id and k.id = l.ticket_id`, [t.id]);
      await c.query(`update customers set created_at = $2::timestamptz where tenant_id = $1`, [t.id, plan[0].at(trade.open)]);
    }

    // ---- is it what was planned
    const got = await one(
      `select (select count(*)::int from receipts where tenant_id = $1) as receipts,
              (select coalesce(sum(total), 0)::bigint from receipts where tenant_id = $1) as takings,
              (select count(*)::int from receipts where tenant_id = $1 and needs_review) as flagged,
              (select count(*)::int from receipt_reviews where tenant_id = $1) as reviews,
              (select count(*)::int from stock_levels where tenant_id = $1 and qty < 0) as below,
              (select count(*)::int from stock_levels where tenant_id = $1 and qty > 0 and qty < reorder_point) as low,
              (select count(*)::int from shifts where tenant_id = $1 and closed_at is null) as open,
              (select count(*)::int from day_closes where tenant_id = $1) as closes,
              (select count(*)::int from items where tenant_id = $1) as items,
              (select count(*)::int from customers where tenant_id = $1) as customers`, [t.id]);
    if (got.receipts !== planned) throw new Error(`${planned} sales planned and ${got.receipts} stored`);
    if (Number(got.takings) !== takings) throw new Error(`takings planned ${takings} and stored ${got.takings}`);
    if (got.flagged || got.reviews) throw new Error(`${got.flagged} sales are flagged for review`);
    if (got.below) throw new Error(`${got.below} lines of stock went below nothing`);
    if (got.open) throw new Error('a day was left open');
    if (got.closes !== plan.length) throw new Error(`${plan.length} days planned and ${got.closes} closed`);
    const pulled = (table) => (page.changes[table] || []).length;
    if (pulled('items') !== got.items || pulled('employees') < staff.length + 1) throw new Error(`a tablet would be sent ${pulled('items')} of ${got.items} things to sell and ${pulled('employees')} staff`);

    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { client: t, type, said, staff, customers: got.customers, days: plan.length, receipts: got.receipts, takings, low: got.low, sent, first: plan[0]?.day, last: plan[plan.length - 1]?.day };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* the connection is gone: nothing was committed */ }
    throw e;
  }
}

if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dev = args.includes('--dev');
  const at = args.indexOf('--days');
  const days = at < 0 ? 21 : Number(args[at + 1]);
  if (!Number.isInteger(days) || days < 0 || days > 90) throw new Error('--days takes a number of days from 0 to 90, like --days 30: nothing was done');
  const rest = args.filter((a, i) => !(at >= 0 && (i === at || i === at + 1)));
  const strange = rest.filter((a) => a.startsWith('--') && a !== '--apply' && a !== '--dev');
  if (strange.length) throw new Error(`${strange.join(' ')} is not something this takes: nothing was done`);
  const pairs = pairsOf(rest.filter((a) => !a.startsWith('--')), 'seed-demo-client.cjs');

  const { url, where } = connection(dev);
  const c = new Client({ connectionString: url, ssl: { require: true } });
  await c.connect();
  const money = (cents) => 'Rs ' + Math.round(cents / RS).toLocaleString('en-US');
  let done = 0;
  try {
    for (const [short, name] of pairs) {
      const s = await seed(c, short, name, apply, days);
      done++;
      console.log(`${where}: ${s.client.name} (${short.toUpperCase()}), ${s.type === 'retail' ? 'shop' : 'restaurant'}, ${s.client.plan}.`);
      console.log(`  ${s.said.join('; ')}.`);
      console.log(`  ${s.staff.length} staff, ${s.customers} customers.`);
      console.log(s.days ? `  ${s.receipts} sales over ${s.days} days of trade (${s.first} to ${s.last}), ${money(s.takings)} taken; every day opened, counted and closed.` : '  No sales behind it.');
      if (s.type === 'retail') console.log(`  ${s.low} products are low and on the list to order again.`);
      console.log(`  ${apply ? 'Done' : 'Rehearsed'}: ${s.sent} operations taken by the server as from a till, none flagged for review.`);
      if (apply) {
        console.log('  Staff PINs, for the till (said once, here; a new one is set under Staff in the back office):');
        for (const m of s.staff) console.log(`    ${m.name.padEnd(14)} ${m.role.padEnd(8)} ${m.pin}`);
        console.log('');
      } else console.log('  Everything was put back: nothing was changed.\n');
    }
  } catch (e) {
    throw new Error(`${e.message}: ${done && apply ? `stopped here. ${done} client${done === 1 ? ' was' : 's were'} filled before this one, as said above; this one was not touched` : 'nothing was done'}`);
  } finally {
    await c.end();
  }
  if (!apply) console.log('To fill for good: the same command with --apply at the end.');
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });

module.exports = { seed };
