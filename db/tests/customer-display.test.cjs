// customer-display.test.cjs — migration 0129: a customer display is a row in
// printers of kind "display". A second tablet faces the customer and shows
// the sale of the till it faces, over the shop's own Wi-Fi.
//   - a display has its address, its pairing code and its till (a till of
//     its own store), and is never where receipts come out
//   - it is free on every plan: an offline-edition business has one
//   - only a display faces a till and has a message
//   - a till adds one with printer.save (an offline tablet's own, sent up
//     when the business goes to the cloud): the code tidied, the message cut,
//     never the store's first printer, never turned into a printer
//   - a till is sent it, with its till and its message
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/customer-display.test.cjs
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
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

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
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // something done as the business's own connection; an error leaves the transaction usable
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
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-cd@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    // an offline-edition shop: displays are on every plan
    const shop = await make('Display Offline', 'CD1', 'offline');
    const theirs = await make('Display Other', 'CD2', 'trial');
    const tid = shop.tenant_id, store = shop.store_id, owner = shop.employee_id;
    const annex = (await one(`insert into stores (tenant_id, name, code) values ($1, 'Annex', 'CD1B') returning id`, [tid])).id;
    const device = async (t, s, code) => (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, $3, $3) returning id`, [t, s, code])).id;
    const till = await device(tid, store, 'T1');
    const annexTill = await device(tid, annex, 'T2');
    const theirTill = await device(theirs.tenant_id, theirs.store_id, 'T9');

    const put = (o) => asApp(tid, () => c.query(
      `insert into printers (tenant_id, store_id, name, kind, address, pair_code, device_id, message, is_receipt)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [tid, o.store ?? store, o.name ?? 'Counter', o.kind ?? 'display', o.address === undefined ? '192.168.1.70' : o.address,
        o.code === undefined ? 'DSPLY234' : o.code, o.device === undefined ? till : o.device, o.message ?? null, o.receipt ?? false]));
    const row = async (id) => { await as(tid); return one(`select kind, address, pair_code, device_id, message, is_receipt, is_active from printers where id = $1`, [id]); };

    // ---- the row ----
    let r = await put({ message: 'Ask about our lunch deal' });
    check('D1 a display with its address, code and till is kept, on the offline plan', !failed(r), said(r));
    const kept = failed(r) ? null : await row(r.rows[0].id);
    check('D1 as it was given', kept && kept.kind === 'display' && kept.device_id === till && kept.message === 'Ask about our lunch deal' && !kept.is_receipt, JSON.stringify(kept));
    r = await put({ code: null });
    check('D2 no pairing code is no display', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put({ address: ' ' });
    check('D2 no address is no display', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put({ device: null });
    // the till's own check (bad-device) speaks before the row's
    check('D2 a display faces a till', failed(r) && (said(r) === 'bad-device' || said(r).includes('printers_display_check')), said(r));
    r = await put({ receipt: true });
    check('D2 a display never prints the receipts', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put({ device: annexTill });
    check('D2 a till of another store is refused', failed(r) && said(r) === 'bad-device', said(r));
    r = await put({ device: theirTill });
    check('D2 a till of another business is refused', failed(r) && said(r) === 'bad-device', said(r));
    r = await put({ store: annex, device: annexTill });
    check('D2 the annex has a display of its own till', !failed(r), said(r));
    r = await put({ message: 'x'.repeat(121) });
    check('D3 a message is at most 120 characters', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put({ kind: 'network', code: null, device: null, message: 'Hello' });
    check('D3 only a display has a message', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put({ kind: 'network', code: null });
    check('D3 only a display faces a till', failed(r) && said(r).includes('printers_display_check'), said(r));

    // ---- from a till: printer.save ----
    const push = (ops) => asApp(tid, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const save = async (payload) => { const res = await push([op('printer.save', payload)]); return failed(res) ? 'error ' + said(res) : tag(res[0]); };
    // a store with no printer yet: its first printer takes the receipts, a display never
    const fresh = (await one(`insert into stores (tenant_id, name, code) values ($1, 'Kiosk', 'CD1C') returning id`, [tid])).id;
    const kioskTill = await device(tid, fresh, 'T3');
    const disp = crypto.randomUUID();
    const display = (o = {}) => ({ id: disp, store_id: fresh, name: 'Counter', kind: 'display', address: '10.0.2.16', paper_mm: 80, pair_code: 'dsply-234', device_id: kioskTill, message: 'Hello', ...o });
    let s = await save(display({ message: '  ' + 'y'.repeat(130) + '  ' }));
    let d = await row(disp);
    check('P1 a till adds a display', s === 'applied' && d && d.kind === 'display' && d.device_id === kioskTill, s + ' ' + JSON.stringify(d));
    check('P1 its code as the display shows it, its message cut to 120', d && d.pair_code === 'DSPLY234' && d.message === 'y'.repeat(120), JSON.stringify(d));
    check('P1 it is not the receipt printer though it is the store\'s first row', d && !d.is_receipt, JSON.stringify(d));
    const first = crypto.randomUUID();
    s = await save({ id: first, store_id: fresh, name: 'Receipt', kind: 'network', address: '10.0.2.2', paper_mm: 80 });
    check('P2 a printer added after it still takes the receipts', s === 'applied' && (await row(first)).is_receipt === true, s);
    s = await save(display({ name: 'Front', message: 'Welcome' }));
    d = await row(disp);
    check('P3 a display changed from a till stays a display', s === 'applied' && d.kind === 'display' && d.message === 'Welcome' && d.pair_code === 'DSPLY234', s + ' ' + JSON.stringify(d));
    s = await save(display({ message: '' }));
    check('P3 an empty message is none', s === 'applied' && (await row(disp)).message === null, s);
    s = await save(display({ kind: 'network', pair_code: null, device_id: null }));
    check('P4 a display is not turned into a printer', s === 'rejected:bad-printer' && (await row(disp)).kind === 'display', s);
    s = await save({ id: first, store_id: fresh, name: 'Receipt', kind: 'display', address: '10.0.2.2', pair_code: 'DSPLY234', device_id: kioskTill });
    check('P4 nor a printer into a display', s === 'rejected:bad-printer' && (await row(first)).kind === 'network', s);
    const other = crypto.randomUUID();
    s = await save(display({ id: other, device_id: null }));
    check('P5 a display from a till names its till', s === 'rejected:bad-device', s);
    s = await save(display({ id: other, device_id: annexTill }));
    check('P5 a till of another store is refused', s === 'rejected:bad-device', s);
    s = await save(display({ id: other, pair_code: 'DSPLY23' }));
    check('P6 a code that is not one is refused', s === 'rejected:bad-address', s);
    s = await save(display({ id: other, pair_code: 'DSPLY10I' }));
    check('P6 a code with letters the display never shows is refused', s === 'rejected:bad-address', s);
    s = await save(display({ id: other, address: 'counter' }));
    check('P6 an address that is not one is refused', s === 'rejected:bad-address', s);
    s = await save(display({ id: other, kind: 'screen' }));
    check('P7 a kitchen screen is still the back office\'s', s === 'rejected:bad-payload', s);
    s = await save({ id: other, store_id: fresh, name: 'Bar', kind: 'network', address: '10.0.2.9', paper_mm: 80, device_id: kioskTill, message: 'Hi' });
    check('P8 a printer sent with a till and a message is kept without them', s === 'applied' && (await row(other)).device_id === null && (await row(other)).message === null, s);

    // ---- the till is sent it ----
    const pulled = await asApp(tid, async () => (await c.query('select sync_pull($1::uuid, 0, 500) as r', [fresh])).rows[0].r);
    const sent = failed(pulled) ? [] : (pulled.changes.printers || []).filter((x) => x.id === disp);
    check('P9 a pull hands the display with its till and its message', sent.length === 1 && sent[0].kind === 'display' && sent[0].device_id === kioskTill && sent[0].message === null && sent[0].pair_code === 'DSPLY234',
      failed(pulled) ? said(pulled) : JSON.stringify(sent[0]));

    // ---- the back office's own saves (web/lib/saves.ts, web/lib/printers.ts) ----
    const saves = lib('saves');
    const printers = lib('printers');
    const office = (await one(`insert into stores (tenant_id, name, code) values ($1, 'Office', 'CD1D') returning id`, [tid])).id;
    const officeTill = await device(tid, office, 'T4');
    const form = (o) => ({ name: 'Front', kind: 'display', address: '192.168.1.80', paper: 80, feed: 3, cut: true, pair: 'DSPLY234', device: officeTill, message: 'Hello\nWelcome', ...o });
    r = await asApp(tid, () => saves.addPrinter(c, tid, office, form({})));
    const front = failed(r) ? null : (await one(`select id, is_receipt, device_id, message from printers where tenant_id = $1 and store_id = $2 and kind = 'display'`, [tid, office]));
    check('B1 the back office adds a display, not as the store\'s receipt printer', !failed(r) && r.first === false && front && !front.is_receipt && front.device_id === officeTill && front.message === 'Hello\nWelcome', failed(r) ? said(r) : JSON.stringify(front));
    r = await asApp(tid, () => saves.addPrinter(c, tid, office, { name: 'Cashier', kind: 'network', address: '192.168.1.50', paper: 80, feed: 3, cut: true }));
    check('B1 the printer added after it takes the receipts', !failed(r) && r.first === true, failed(r) ? said(r) : JSON.stringify(r));
    r = await asApp(tid, () => saves.setReceiptPrinter(c, tid, office, front.id));
    check('B2 a display cannot be chosen to print receipts', r === 'screen', String(r));
    r = await asApp(tid, () => saves.savePrinter(c, tid, front.id, form({ name: 'Front desk', message: null }), false));
    const saved = await one(`select name, is_active, message, device_id, kind from printers where id = $1`, [front.id]);
    check('B3 a display saved: renamed, switched off, its message cleared', r === true && saved.name === 'Front desk' && saved.is_active === false && saved.message === null && saved.kind === 'display', String(r) + ' ' + JSON.stringify(saved));
    const cashier = (await one(`select id from printers where tenant_id = $1 and store_id = $2 and kind = 'network'`, [tid, office])).id;
    r = await asApp(tid, () => saves.savePrinter(c, tid, cashier, form({}), true));
    check('B4 a printer is not made a display', (r === false || r === 'receipt') && (await one(`select kind from printers where id = $1`, [cashier])).kind === 'network', failed(r) ? said(r) : String(r));
    r = await asApp(tid, () => saves.savePrinter(c, tid, front.id, form({ kind: 'network', pair: null, device: null, message: null }), true));
    check('B4 nor a display a printer', r === false && (await one(`select kind from printers where id = $1`, [front.id])).kind === 'display', failed(r) ? said(r) : String(r));
    check('B5 two lines, trimmed, at most 120 characters', printers.displayMessage('  Hello ', ' Welcome ') === 'Hello\nWelcome' && printers.displayMessage('', '') === null
      && printers.displayMessage('', 'Only') === 'Only' && printers.displayMessage('x'.repeat(80), 'y'.repeat(80)).length === 120);
    check('B6 nothing that prints nothing is a printer', printers.silent('screen') && printers.silent('display') && !printers.silent('network') && !printers.silent('usb') && !printers.silent('bluetooth'));
    const sharing = printers.displaysSharing([{ name: 'A', address: '10.0.0.5', kind: 'display' }, { name: 'B', address: '10.0.0.5:9311', kind: 'display' }, { name: 'C', address: '10.0.0.6', kind: 'display' }, { name: 'K', address: '10.0.0.5', kind: 'screen' }]);
    check('B7 two displays at one address are named, once', sharing.length === 1 && sharing[0].startsWith('A and B are at the same address (10.0.0.5:9311)'), JSON.stringify(sharing));
  } catch (e) {
    console.log('FAIL the suite stopped: ' + (e.stack || e));
    failures++;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
