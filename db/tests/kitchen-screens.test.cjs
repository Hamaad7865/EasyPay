// kitchen-screens.test.cjs — migration 0086: a kitchen screen is a row in
// printers of kind "screen". The owner asked for "a configurable kitchen on
// another screen": a tablet in the kitchen that shows each order when Send to
// kitchen is pressed. The till reaches it over the restaurant's own Wi-Fi, at
// the address and with the pairing code typed in the back office under
// Printers; which items it shows is the categories ticked for it, or everything.
//   - a screen has an address and a pairing code, and is never where
//     receipts come out
//   - it is a premium feature: a restaurant on another plan cannot be given
//     one, and keeps what it has, switched off or not, when its plan goes down
//   - a till is sent the screen with its code and whether it shows everything
//   - the back office's own saves: a store's first entry being a screen is
//     not its receipt printer, and a screen cannot be chosen as one
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/kitchen-screens.test.cjs
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
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // something done as the restaurant's own connection; an error leaves the transaction usable
  async function asApp(tenant, fn) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      const out = await fn();
      await c.query('SET LOCAL ROLE none');
      await c.query('RELEASE SAVEPOINT ' + name);
      return out;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT ' + name);
      await c.query('SET LOCAL ROLE none');
      return e;
    }
  }
  const failed = (r) => r instanceof Error;
  const said = (r) => (failed(r) ? (r.code === 'P0001' ? r.message : r.code + (r.constraint ? ' ' + r.constraint : '')) : 'no error');
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-ks@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    const prem = await make('Screens Premium', 'KS1', 'premium');
    const std = await make('Screens Standard', 'KS2', 'standard');
    const pid = prem.tenant_id, sid = std.tenant_id;

    const put = (t, store, o) => asApp(t, () => c.query(
      `insert into printers (tenant_id, store_id, name, kind, address, pair_code, all_items, is_receipt)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [t, store, o.name, o.kind ?? 'screen', o.address === undefined ? '192.168.1.60' : o.address, o.code === undefined ? 'KTCHN234' : o.code, o.all ?? false, o.receipt ?? false]));
    const row = async (t, id) => { await as(t); return one(`select kind, address, pair_code, all_items, is_receipt, is_active, deleted_at from printers where id = $1`, [id]); };

    // K1 what a screen is
    let r = await put(pid, prem.store_id, { name: 'Grill', all: true });
    const grill = failed(r) ? null : r.rows[0].id;
    const g = grill && await row(pid, grill);
    check('K1 a premium restaurant\'s printer may be of kind screen, with an address and a code',
      !!g && g.kind === 'screen' && g.address === '192.168.1.60' && g.pair_code === 'KTCHN234' && g.all_items === true, said(r));
    r = await put(pid, prem.store_id, { name: 'No code', code: null });
    check('K1 a screen with no code is refused', failed(r) && r.code === '23514', said(r));
    r = await put(pid, prem.store_id, { name: 'No address', address: null });
    check('K1 a screen with no address is refused', failed(r) && r.code === '23514', said(r));
    r = await put(pid, prem.store_id, { name: 'Paper', kind: 'network', code: null });
    check('K1 a printer needs no code, as before', !failed(r), said(r));

    // K2 never the receipt printer
    r = await put(pid, prem.store_id, { name: 'Till screen', receipt: true });
    check('K2 a screen marked as the receipt printer is refused', failed(r) && r.code === '23514', said(r));

    // K3 a premium feature
    r = await put(sid, std.store_id, { name: 'Grill' });
    check('K3 a standard restaurant cannot be given a screen', failed(r) && r.message === 'not-premium', said(r));
    r = await put(sid, std.store_id, { name: 'Kitchen', kind: 'network', code: null });
    check('K3 a network printer it can', !failed(r), said(r));

    // K5 a category ticks a screen as it ticks a printer
    await as(pid);
    const cat = (await one(`insert into categories (tenant_id, name, printer_ids) values ($1, 'Grills', array[$2::uuid]) returning printer_ids`, [pid, grill]));
    check('K5 a category keeps a screen\'s id among its printers', !!grill && cat.printer_ids.length === 1 && cat.printer_ids[0] === grill, JSON.stringify(cat.printer_ids));

    // K4 a till is sent the screen
    const pulled = await asApp(pid, async () => {
      const rows = []; let cursor = 0;
      for (let i = 0; i < 40; i++) {
        const page = (await c.query(`select sync_pull($1::uuid, $2::bigint, 500) as r`, [prem.store_id, cursor])).rows[0].r;
        rows.push(...((page.changes && page.changes.printers) || []));
        if (!page.has_more) break;
        cursor = page.next_cursor;
      }
      return rows;
    });
    const sent = !failed(pulled) && pulled.find((p) => p.id === grill);
    check('K4 a pull hands a till the screen with its code and that it shows everything',
      !!sent && sent.kind === 'screen' && sent.pair_code === 'KTCHN234' && sent.all_items === true && sent.address === '192.168.1.60', failed(pulled) ? said(pulled) : JSON.stringify(sent));

    // K6 the back office's own saves
    const fresh = await make('Screens First', 'KS3', 'premium');
    const fid = fresh.tenant_id;
    const form = (o) => ({ name: o.name, kind: o.kind, address: o.address ?? '192.168.1.61', paper: 80, feed: 3, cut: true, pair: o.kind === 'screen' ? 'KTCHN234' : null, all: o.all ?? false });
    r = await asApp(fid, () => saves.addPrinter(c, fid, fresh.store_id, form({ name: 'Grill', kind: 'screen', all: true })));
    await as(fid);
    let rows = (await c.query(`select name, kind, is_receipt, pair_code, all_items from printers where tenant_id = $1 and deleted_at is null order by sort_order`, [fid])).rows;
    check('K6 a store\'s first entry being a screen is not its receipt printer',
      !failed(r) && r && r.first === false && rows.length === 1 && rows[0].kind === 'screen' && !rows[0].is_receipt && rows[0].pair_code === 'KTCHN234' && rows[0].all_items === true, failed(r) ? said(r) : JSON.stringify(rows));
    r = await asApp(fid, () => saves.addPrinter(c, fid, fresh.store_id, form({ name: 'Cashier', kind: 'network', address: '192.168.1.50' })));
    await as(fid);
    rows = (await c.query(`select id, name, kind, is_receipt from printers where tenant_id = $1 and deleted_at is null order by sort_order`, [fid])).rows;
    check('K6 and the printer entered next is', !failed(r) && r && r.first === true && rows.length === 2 && rows[1].is_receipt && !rows[0].is_receipt, failed(r) ? said(r) : JSON.stringify(rows));
    const theScreen = rows.find((p) => p.kind === 'screen').id, thePrinter = rows.find((p) => p.kind === 'network').id;
    r = await asApp(fid, () => saves.setReceiptPrinter(c, fid, fresh.store_id, theScreen));
    await as(fid);
    check('K6 choosing a screen as the receipt printer is refused, and the receipt printer stays',
      r === 'screen' && (await one(`select is_receipt from printers where id = $1`, [thePrinter])).is_receipt === true, failed(r) ? said(r) : String(r));
    r = await asApp(fid, () => saves.savePrinter(c, fid, thePrinter, form({ name: 'Cashier', kind: 'screen' }), true));
    await as(fid);
    check('K6 the receipt printer cannot be turned into a screen',
      r === 'receipt' && (await one(`select kind from printers where id = $1`, [thePrinter])).kind === 'network', failed(r) ? said(r) : String(r));
    r = await asApp(fid, () => saves.savePrinter(c, fid, theScreen, { ...form({ name: 'Grill 2', kind: 'screen', address: '192.168.1.62:9400' }), pair: 'ABCDEFGH' }, true));
    await as(fid);
    const g2 = await one(`select name, address, pair_code, all_items from printers where id = $1`, [theScreen]);
    check('K6 a screen\'s name, address, code and what it shows are saved',
      r === true && g2.name === 'Grill 2' && g2.address === '192.168.1.62:9400' && g2.pair_code === 'ABCDEFGH' && g2.all_items === false, failed(r) ? said(r) : JSON.stringify(g2));

    // K7 the plan goes down
    await c.query(`select platform.set_tenant_plan($1, $2, 'standard')`, [admin, fid]);
    const kept = await row(fid, theScreen);
    check('K7 a plan set to standard leaves the screen\'s row as it was', kept.kind === 'screen' && kept.is_active === true && kept.deleted_at === null);
    r = await asApp(fid, () => saves.setReceiptPrinter(c, fid, fresh.store_id, null));
    const none = await row(fid, thePrinter);
    r = failed(r) ? r : await asApp(fid, () => saves.setReceiptPrinter(c, fid, fresh.store_id, thePrinter));
    check('K3 after the plan went down the restaurant can still choose its receipt printer',
      r === 'ok' && none.is_receipt === false && (await row(fid, thePrinter)).is_receipt === true, failed(r) ? said(r) : String(r));
    r = await asApp(fid, () => saves.savePrinter(c, fid, theScreen, { ...form({ name: 'Grill 2', kind: 'screen', address: '192.168.1.62:9400' }), pair: 'ABCDEFGH' }, false));
    check('K3 a screen entered while premium can still be switched off after the plan went down', r === true && (await row(fid, theScreen)).is_active === false, failed(r) ? said(r) : String(r));
    r = await asApp(fid, () => saves.savePrinter(c, fid, theScreen, { ...form({ name: 'Grill 2', kind: 'screen', address: '192.168.1.62:9400' }), pair: 'ABCDEFGH' }, true));
    check('K3 and not switched on again until the plan is back', failed(r) && r.message === 'not-premium' && (await row(fid, theScreen)).is_active === false, said(r));
    r = await asApp(fid, () => c.query(`update printers set deleted_at = now() where tenant_id = $1 and id = $2`, [fid, theScreen]));
    check('K3 and can be removed', !failed(r) && (await row(fid, theScreen)).deleted_at !== null, said(r));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'KITCHEN SCREENS PASS' : `KITCHEN SCREENS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
