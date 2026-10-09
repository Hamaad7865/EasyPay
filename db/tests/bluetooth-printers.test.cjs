// bluetooth-printers.test.cjs — migration 0088: a printer may be reached by
// Bluetooth, and one that is has what the tablet finds it by. The till is
// sent it like any other printer.
// Usage: node db/tests/bluetooth-printers.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const fails = async (sql, args) => { try { await c.query(sql, args); return null; } catch (e) { return e.message; } };
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','Bluetooth-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','BTP1') returning id`)).id;
    const add = `insert into printers (tenant_id, store_id, name, kind, address, paper_mm) values ($1,$2,$3,$4,$5,58) returning id`;
    const made = await q1(add, [tid, store, 'Counter', 'bluetooth', 'MPT-II']);
    check('B1 a Bluetooth printer is kept, with the name the tablet finds it by', !!made && !!made.id);
    const byAddress = await q1(add, [tid, store, 'Bar', 'bluetooth', '00:11:22:AA:BB:CC']);
    check('B1 or with its Bluetooth address', !!byAddress && !!byAddress.id);
    const none = await fails(add, [tid, store, 'Nameless', 'bluetooth', null]);
    const blank = await fails(add, [tid, store, 'Blank', 'bluetooth', '  ']);
    check('B2 one with nothing to find it by is refused', /printers_bluetooth_check/.test(none || '') && /printers_bluetooth_check/.test(blank || ''), String(none).slice(0, 60));
    const odd = await fails(add, [tid, store, 'Odd', 'infrared', 'x']);
    check('B2 and a kind that is not one is refused as before', /printers_kind_check/.test(odd || ''), String(odd).slice(0, 60));
    const usb = await q1(add, [tid, store, 'Cable', 'usb', null]);
    const net = await q1(add, [tid, store, 'Kitchen', 'network', '192.168.1.50']);
    check('B3 the kinds there were are kept as they were', !!usb && !!net);
    // as a till gets it
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const page = (await q1('select sync_pull($1, 0, 1000) as r', [store])).r;
    await c.query('COMMIT');
    const sent = (page.changes.printers || []).find((p) => p.id === made.id);
    check('B4 a till is sent it, with its kind and what it is found by', !!sent && sent.kind === 'bluetooth' && sent.address === 'MPT-II', JSON.stringify(sent && [sent.kind, sent.address]));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
