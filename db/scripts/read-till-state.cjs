// read-till-state.cjs — reads off an emulator what a till did with the debug
// build's made-up business: its outbox (every operation it would send, in the
// order it made them) and its own copy of the receipts, lines, payments and
// stock. The file it writes is what db/scripts/replay-demo-outbox.cjs sends to
// the dev server, and what db/tests/retail-till-replay.test.cjs keeps as a
// fixture.
//
// It only reads. The app's database is copied off the device (the debug build
// lets adb read its files; a release build does not) and opened here.
//
// Usage: node db/scripts/read-till-state.cjs <out.json> [device serial]
//   The serial is the emulator to read (adb devices), "emulator-5584" unless
//   said. It refuses a till that is set up for anything but the made-up
//   business: a real till's sales are not for a fixture.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const out = process.argv[2];
const serial = process.argv[3] || 'emulator-5584';
if (!out) { console.error('usage: node db/scripts/read-till-state.cjs <out.json> [device serial]'); process.exit(1); }
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (args) => execFileSync(ADB, ['-s', serial, ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

const shop = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'debug', 'assets', 'demo-shop.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'till-state-'));
try {
  // the database and what it has not yet folded into it
  for (const f of ['till.db', 'till.db-wal', 'till.db-shm']) {
    try { fs.writeFileSync(path.join(dir, f), adb(['exec-out', 'run-as', 'com.restopos.app', 'cat', 'databases/' + f])); } catch (e) { if (f === 'till.db') throw e; }
  }
  const db = new DatabaseSync(path.join(dir, 'till.db'));
  const all = (sql) => db.prepare(sql).all();
  const tenants = all(`select distinct tenant_id from receipts union select distinct tenant_id from tickets`).map((r) => r.tenant_id);
  if (tenants.some((t) => t !== shop.tenant)) throw new Error('this till holds a business that is not the made-up one: it is not read');
  const state = {
    outbox: all(`select op_id, type, payload, employee_id, state from outbox order by created_at, rowid`),
    receipts: all(`select id, number, type, refund_of, subtotal, discount_total, tax_total, total from receipts where pulled = 0 order by device_time, rowid`),
    receipt_lines: all(`select rl.receipt_id, rl.name_snapshot, rl.unit_price, rl.qty, rl.ticket_line_id, rl.list_price, rl.price_kind, rl.price_label
                          from receipt_lines rl join receipts r on r.id = rl.receipt_id where r.pulled = 0 order by rl.rowid`),
    // how each receipt was settled, by the kind of payment type
    payments: all(`select p.receipt_id, p.payment_type_id, t.kind, p.amount, p.tendered, p.change, p.reference
                     from receipt_payments p join receipts r on r.id = p.receipt_id left join payment_types t on t.id = p.payment_type_id
                    where r.pulled = 0 order by p.rowid`),
    // a drawer that was closed: what the till worked out it should hold, and what was counted
    shifts: all(`select id, opening_float, expected_cash, counted_cash from shifts where closed_at is not null order by opened_at`),
    levels: all(`select item_id, nullif(variant_id, '') as variant_id, qty from stock_levels order by item_id, variant_id`),
    lines: all(`select id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, paid, voided_at, list_price, price_kind, price_label, price_by from ticket_lines order by rowid`),
  };
  db.close();
  fs.writeFileSync(out, JSON.stringify(state, null, 1));
  console.log(`${out}: ${state.outbox.length} operations (${[...new Set(state.outbox.map((o) => o.type))].join(', ')}), ${state.receipts.length} receipts, ${state.payments.length} payments, ${state.levels.length} stock figures`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
