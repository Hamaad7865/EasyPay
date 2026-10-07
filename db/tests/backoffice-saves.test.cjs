// backoffice-saves.test.cjs — what a few of the back office's forms do when
// what they are sent is not what the page offered: a tax or an add-on group
// removed while the form was open, a table of another store. The saves are
// the pages' own (web/lib/saves.ts), run as the restaurant's own connection.
// Usage: node db/tests/backoffice-saves.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

// a module of web/lib, compiled from the TypeScript it lives in
function lib(name) {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

(async () => {
  const saves = lib('saves');

  // ---- the kitchen notes a restaurant saved (no database) ----
  {
    const s = lib('settings');
    const usual = s.DEFAULT_SETTINGS.kitchenNotes.join('|');
    const notes = (raw) => s.withDefaults(raw).kitchenNotes;
    check('N1 a restaurant that never saved its notes is offered the usual five', usual.split('|').length === 5 && notes(null).join('|') === usual && notes({ decimals: 2 }).join('|') === usual);
    check('N1 the notes saved are the notes offered, twelve at most', notes({ kitchenNotes: [' Sans piment ', '', 'Rush'] }).join('|') === 'Sans piment|Rush'
      && notes({ kitchenNotes: Array.from({ length: 20 }, (_, i) => 'n' + i) }).length === 12);
    check('N2 a list saved empty stays empty', notes({ kitchenNotes: [] }).length === 0 && notes({ kitchenNotes: ['', ' '] }).length === 0,
      JSON.stringify(notes({ kitchenNotes: [] })));
    check('N2 something that is not a list is the usual five', notes({ kitchenNotes: 'Rush' }).join('|') === usual && notes({ kitchenNotes: null }).join('|') === usual);
  }

  // ---- a price typed in a form (no database) ----
  {
    const { parseRs } = lib('money');
    const got = (cases) => cases.map(([typed]) => `${JSON.stringify(typed)}=${parseRs(typed)}`).join(' ');
    const reads = (cases) => cases.every(([typed, cents]) => parseRs(typed) === cents);
    const prices = [['12', 1200], ['12.5', 1250], ['12.50', 1250], ['0', 0], ['0.05', 5], [' 99 ', 9900], ['12.', 1200], ['.5', 50]];
    check('P1 a price is read in cents', reads(prices), got(prices));
    check('P1 commas between thousands are left out', reads([['1,250', 125000], ['1,250.75', 125075]]));
    check('P1 what the forms show is read back as it was', [0, 5, 50, 1250, 125075, 19999999].every((cents) => parseRs((cents / 100).toString()) === cents));
    const junk = [['12abc', null], ['12 50', null], ['1e3', null], ['Rs 12', null], ['12.5.1', null]];
    check('P2 a number with anything else after it is not a price', reads(junk), got(junk));
    const empty = [['', null], ['   ', null], ['.', null], ['-5', null], ['+5', null], ['abc', null]];
    check('P2 nothing, a sign or a dot alone is not a price', reads(empty), got(empty));
    const fine = [['12.345', null], ['0.001', null]];
    check('P2 a third decimal is refused, not rounded', reads(fine), got(fine));
    // "12,50" is twelve rupees fifty to someone who writes prices the French way: read as Rs 1,250 it is a hundred times too much
    const commas = [['12,50', null], ['1,2', null], ['1,25', null], [',5', null], ['1,,250', null], ['12,500', 1250000], ['1,250,000.5', 125000050]];
    check('P3 a comma only goes between thousands', reads(commas), got(commas));
  }

  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // one change, the way a form's action makes it: the restaurant's own transaction
  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }

  try {
    await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, 'Saves-Probe'), ($2, $2, 'Saves-Other')`, [tid, other]);
    // two stores: what belongs to one must not be taken for the other
    const main = (await q1(`insert into stores (tenant_id, name, code) values ($1, 'Main', 'SVS1') returning id`, [tid])).id;
    const beach = (await q1(`insert into stores (tenant_id, name, code) values ($1, 'Beach', 'SVS2') returning id`, [tid])).id;
    const theirStore = (await q1(`insert into stores (tenant_id, name, code) values ($1, 'Main', 'SVS3') returning id`, [other])).id;

    // ---- an item's tax ----
    {
      const vat = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'VAT 15%', 1500, 'included') returning id`, [tid])).id;
      const zero = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'Zero rated', 0, 'included') returning id`, [tid])).id;
      const gone = (await q1(`insert into taxes (tenant_id, name, rate_bp, type, deleted_at) values ($1, 'Old levy', 500, 'added', now()) returning id`, [tid])).id;
      const theirs = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'VAT 15%', 1500, 'included') returning id`, [other])).id;
      const item = (await q1(`insert into items (tenant_id, name, price) values ($1, 'Dholl puri', 2500) returning id`, [tid])).id;
      const carried = async () => (await c.query(`select tax_id from item_taxes where tenant_id = $1 and item_id = $2 and deleted_at is null`, [tid, item])).rows.map((r) => r.tax_id);

      const first = await asApp(tid, () => saves.setItemTax(c, tid, item, vat));
      check('T1 an item is given the tax picked', first === true && (await carried()).join() === vat);
      const changed = await asApp(tid, () => saves.setItemTax(c, tid, item, zero));
      check('T1 picking another tax leaves that one alone on the item', changed === true && (await carried()).join() === zero);
      const back = await asApp(tid, () => saves.setItemTax(c, tid, item, vat));
      check('T1 a tax the item carried before is put back on', back === true && (await carried()).join() === vat);

      const removed = await asApp(tid, () => saves.setItemTax(c, tid, item, gone));
      check('T2 a tax removed while the panel was open is refused', removed === false, String(removed));
      check('T2 and the item keeps the tax it had', (await carried()).join() === vat, JSON.stringify(await carried()));
      const foreign = await asApp(tid, () => saves.setItemTax(c, tid, item, theirs));
      check('T2 a tax of another restaurant is refused, the item keeping its own', foreign === false && (await carried()).join() === vat, JSON.stringify(await carried()));
      const unknown = await asApp(tid, () => saves.setItemTax(c, tid, item, crypto.randomUUID()));
      check('T2 a tax that never existed is refused, the item keeping its own', unknown === false && (await carried()).join() === vat, JSON.stringify(await carried()));
    }

    // ---- a choice added to a group of add-ons ----
    {
      const group = (await q1(`insert into modifier_groups (tenant_id, name) values ($1, 'Extras') returning id`, [tid])).id;
      const removed = (await q1(`insert into modifier_groups (tenant_id, name, deleted_at) values ($1, 'Sauces (removed)', now()) returning id`, [tid])).id;
      const theirs = (await q1(`insert into modifier_groups (tenant_id, name) values ($1, 'Extras') returning id`, [other])).id;
      const choices = async (g) => (await c.query(`select name, price::int as price from modifiers where group_id = $1 and deleted_at is null`, [g])).rows;

      const added = await asApp(tid, () => saves.addChoice(c, tid, group, 'Cheese', 2500));
      check('C1 a choice is added to its group, at its price', added === true && JSON.stringify(await choices(group)) === '[{"name":"Cheese","price":2500}]', JSON.stringify(await choices(group)));
      const late = await asApp(tid, () => saves.addChoice(c, tid, removed, 'Chilli', 0));
      check('C2 a choice for a group removed meanwhile is refused, and none is added', late === false && (await choices(removed)).length === 0, String(late));
      const foreign = await asApp(tid, () => saves.addChoice(c, tid, theirs, 'Chilli', 0));
      check('C2 a choice for another restaurant\'s group is refused, and none is added', foreign === false && (await choices(theirs)).length === 0, String(foreign));
      const unknown = await asApp(tid, () => saves.addChoice(c, tid, crypto.randomUUID(), 'Chilli', 0));
      check('C2 a choice for a group that never existed is refused', unknown === false, String(unknown));

      // a group or a choice changed from a page that was open while it was removed in another tab
      const one = async (tbl, id) => q1(`select name, deleted_at is not null as removed from ${tbl} where id = $1`, [id]);
      const cheese = (await q1(`select id from modifiers where group_id = $1 and name = 'Cheese'`, [group])).id;
      const bacon = (await q1(`insert into modifiers (tenant_id, group_id, name, price, deleted_at) values ($1, $2, 'Bacon', 3000, now()) returning id`, [tid, group])).id;
      const theirChoice = (await q1(`insert into modifiers (tenant_id, group_id, name, price) values ($1, $2, 'Their sauce', 100) returning id`, [other, theirs])).id;
      const saveChoice = (id, name, price) => asApp(tid, () => saves.saveChoice(c, tid, id, name, price));
      const saveGroup = (id, name, min, max) => asApp(tid, () => saves.saveGroup(c, tid, id, name, min, max));
      check('C3 a choice is changed: its name and its price', (await saveChoice(cheese, 'Cheddar', 3000)) === true && JSON.stringify(await choices(group)) === '[{"name":"Cheddar","price":3000}]', JSON.stringify(await choices(group)));
      const lateChoice = await saveChoice(bacon, 'Bacon bits', 1);
      check('C4 a choice removed meanwhile is not said to be saved', lateChoice === false && (await one('modifiers', bacon)).name === 'Bacon', String(lateChoice));
      const foreignChoice = await saveChoice(theirChoice, 'Ours now', 1);
      check("C4 nor is another restaurant's, which stays as it was", foreignChoice === false && (await one('modifiers', theirChoice)).name === 'Their sauce', String(foreignChoice));
      const g = async () => q1(`select name, min_select, max_select from modifier_groups where id = $1`, [group]);
      check('C3 a group is changed: its name and how many may be picked', (await saveGroup(group, 'Toppings', 1, 3)) === true && JSON.stringify(await g()) === '{"name":"Toppings","min_select":1,"max_select":3}', JSON.stringify(await g()));
      const lateGroup = await saveGroup(removed, 'Sauces', 0, 0);
      check('C4 a group removed meanwhile is not said to be saved', lateGroup === false && (await one('modifier_groups', removed)).name === 'Sauces (removed)', String(lateGroup));
      const foreignGroup = await saveGroup(theirs, 'Ours now', 0, 0);
      check("C4 nor is another restaurant's, which stays as it was", foreignGroup === false && (await one('modifier_groups', theirs)).name === 'Extras', String(foreignGroup));
    }

    // ---- the table a booking is given ----
    {
      const table = async (tenant, store, name, removed) =>
        (await q1(`insert into tables (tenant_id, store_id, name, deleted_at) values ($1, $2, $3, ${removed ? 'now()' : 'null'}) returning id`, [tenant, store, name])).id;
      const t1 = await table(tid, main, 'T1');
      const t2 = await table(tid, main, 'T2');
      const b1 = await table(tid, beach, 'B1');
      const old = await table(tid, main, 'T9', true);
      const theirs = await table(other, theirStore, 'T1');
      const form = (tableId, more) => ({ day: '2026-12-24', time: '19:30', name: 'Ramgoolam', size: 4, phone: null, tags: null, table: tableId, ...more });
      const booked = async () => (await c.query(
        `select bk.id, bk.store_id, bk.table_id, bk.name, bk.size, bk.status, to_char(bk.booked_for at time zone s.timezone, 'YYYY-MM-DD HH24:MI') as at
           from bookings bk join stores s on s.id = bk.store_id where bk.tenant_id = $1 and bk.deleted_at is null order by bk.created_at, bk.name`, [tid])).rows;
      const add = (store, b) => asApp(tid, () => saves.addBooking(c, tid, store, b));
      const save = (id, b, status) => asApp(tid, () => saves.saveBooking(c, tid, id, b, status));

      check('B1 a booking is taken at its store, at the store\'s own time, on the table picked', (await add(main, form(t1))) === 'ok'
        && JSON.stringify((await booked()).map((r) => [r.store_id, r.table_id, r.at, r.size])) === JSON.stringify([[main, t1, '2026-12-24 19:30', 4]]), JSON.stringify(await booked()));
      check('B1 a booking can be taken with its table left for later', (await add(beach, form(null, { name: 'Appadoo' }))) === 'ok'
        && (await booked()).some((r) => r.name === 'Appadoo' && r.store_id === beach && r.table_id === null));
      const before = (await booked()).length;
      const cross = await add(main, form(b1, { name: 'Wrong store' }));
      check('B2 a table of another store is refused, and no booking is taken', cross === 'no-table' && (await booked()).length === before, cross + ' ' + JSON.stringify((await booked()).filter((r) => r.name === 'Wrong store')));
      const stale = await add(main, form(old, { name: 'Removed table' }));
      check('B2 a table removed meanwhile is refused, and no booking is taken', stale === 'no-table' && (await booked()).length === before, stale);
      const foreign = await add(main, form(theirs, { name: 'Their table' }));
      check('B2 a table of another restaurant is refused, and no booking is taken', foreign === 'no-table' && (await booked()).length === before, foreign);
      check('B2 a store that is gone is said to be gone', (await add(crypto.randomUUID(), form(null))) === 'no-store' && (await booked()).length === before);

      const id = (await booked()).find((r) => r.name === 'Ramgoolam').id;
      const mine = async () => (await booked()).find((r) => r.id === id);
      const moved = await save(id, form(b1, { size: 9 }), 'seated');
      const kept = await mine();
      check('B3 a booking is not moved to a table of another store, and is left as it was', moved === 'no-table' && kept.table_id === t1 && kept.size === 4 && kept.status === 'confirmed', moved + ' ' + JSON.stringify(kept));
      check('B3 a booking moves to another table of its own store', (await save(id, form(t2, { size: 6 }), 'seated')) === 'ok'
        && JSON.stringify(await mine().then((r) => [r.table_id, r.size, r.status])) === JSON.stringify([t2, 6, 'seated']), JSON.stringify(await mine()));
      check('B3 a booking can be left with no table', (await save(id, form(null), 'confirmed')) === 'ok' && (await mine()).table_id === null);

      await c.query(`update bookings set deleted_at = now() where id = $1`, [id]);
      const late = [await save(id, form(t1, { name: 'Too late' }), 'seated'), await save(id, form(null, { name: 'Too late' }), 'seated')];
      const untouched = await q1(`select name, status from bookings where id = $1`, [id]);
      check('B4 a booking removed meanwhile is not said to be saved, with a table picked or without', late.join() === 'gone,gone' && untouched.name === 'Ramgoolam' && untouched.status === 'confirmed', late.join() + ' ' + JSON.stringify(untouched));
    }

    // ---- printers, in a restaurant with two stores ----
    {
      const v = (name) => ({ name, kind: 'network', address: '192.168.1.50', paper: 80, feed: 3, cut: true });
      // what each store has, as "name" or "name*" for the one its receipts come out on
      const has = async (store) => (await c.query(`select name, is_receipt from printers where tenant_id = $1 and store_id = $2 and deleted_at is null order by sort_order`, [tid, store]))
        .rows.map((r) => r.name + (r.is_receipt ? '*' : '')).join(' ');
      const idOf = async (name) => (await q1(`select id from printers where tenant_id = $1 and name = $2`, [tid, name])).id;
      const add = (store, name) => asApp(tid, () => saves.addPrinter(c, tid, store, v(name)));
      const receipts = (printer) => asApp(tid, () => saves.setReceiptPrinter(c, tid, printer));

      const cashier = await add(main, 'Cashier');
      const kitchen = await add(main, 'Kitchen');
      check('R1 a store\'s first printer prints its receipts, the next one does not', cashier.first === true && kitchen.first === false && (await has(main)) === 'Cashier* Kitchen', await has(main));
      const bar = await add(beach, 'Beach bar');
      const grill = await add(beach, 'Beach grill');
      check('R2 a printer added for the second store is in the second store', (await has(beach)) === 'Beach bar* Beach grill' && (await has(main)) === 'Cashier* Kitchen',
        `main: ${await has(main)} | beach: ${await has(beach)}`);
      check('R2 and that store\'s first printer prints its receipts', bar && bar.first === true && grill && grill.first === false, JSON.stringify([bar, grill]));
      const nowhere = await add(crypto.randomUUID(), 'Nowhere');
      const foreign = await add(theirStore, 'Theirs');
      check('R2 a printer for a store that is not the restaurant\'s is not added', nowhere === null && foreign === null && (await q1(`select count(*)::int n from printers where name in ('Nowhere', 'Theirs')`)).n === 0,
        JSON.stringify([nowhere, foreign]));

      const picked = await receipts(await idOf('Beach grill'));
      check('R3 picking a printer for receipts changes its own store, and no other', picked === 'ok' && (await has(beach)) === 'Beach bar Beach grill*' && (await has(main)) === 'Cashier* Kitchen',
        `${picked} main: ${await has(main)} | beach: ${await has(beach)}`);
      check('R3 the same in the first store', (await receipts(await idOf('Kitchen'))) === 'ok' && (await has(main)) === 'Cashier Kitchen*' && (await has(beach)) === 'Beach bar Beach grill*',
        `main: ${await has(main)} | beach: ${await has(beach)}`);
      const lost = await receipts(crypto.randomUUID());
      check('R3 a printer that is no longer there is refused, and nothing changes', lost === 'no-printer' && (await has(main)) === 'Cashier Kitchen*' && (await has(beach)) === 'Beach bar Beach grill*',
        `${lost} main: ${await has(main)} | beach: ${await has(beach)}`);
      check('R3 "no printer" still takes receipts off the first store\'s printers', (await receipts(null)) === 'ok' && (await has(main)) === 'Cashier Kitchen' && (await has(beach)) === 'Beach bar Beach grill*',
        `main: ${await has(main)} | beach: ${await has(beach)}`);

      // a printer changed from a page that was open while it was removed in another tab
      const savePrinter = (id, form, active) => asApp(tid, () => saves.savePrinter(c, tid, id, form, active));
      const printer = async (id) => q1(`select name, paper_mm, is_active from printers where id = $1`, [id]);
      const kitchenId = await idOf('Kitchen');
      check('R4 a printer is changed: its name, its paper, whether it is on', (await savePrinter(kitchenId, { ...v('Hot kitchen'), paper: 58 }, false)) === true
        && JSON.stringify(await printer(kitchenId)) === '{"name":"Hot kitchen","paper_mm":58,"is_active":false}', JSON.stringify(await printer(kitchenId)));
      const grillId = await idOf('Beach grill');
      await c.query(`update printers set deleted_at = now() where id = $1`, [grillId]);
      const latePrinter = await savePrinter(grillId, v('Grill two'), true);
      check('R4 a printer removed meanwhile is not said to be saved', latePrinter === false && (await printer(grillId)).name === 'Beach grill', String(latePrinter));
      const theirPrinter = (await q1(`insert into printers (tenant_id, store_id, name) values ($1, $2, 'Their printer') returning id`, [other, theirStore])).id;
      const foreignPrinter = await savePrinter(theirPrinter, v('Ours now'), true);
      check('R4 nor is another restaurant\'s, which stays as it was', foreignPrinter === false && (await printer(theirPrinter)).name === 'Their printer', String(foreignPrinter));
    }
  } finally {
    for (const t of [tid, other]) {
      try { await devguard.cleanupTenant(c, t); } catch (e) { console.error('cleanup of ' + t + ' failed: ' + e.message); failures++; }
    }
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
