// mra-page.test.cjs — the back office's MRA page (web/lib/mra-page.ts, web/app/backoffice/mra):
// its two questions asked as the business's own connection, for a probe client on dev whose
// invoices are written the way the server keeps them (mra_records, 0132), then the page itself
// drawn with no sign-in (page.cjs). Everything is rolled back.
// Usage: node db/tests/mra-page.test.cjs
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

// the page's questions and words, compiled from the TypeScript they live in
function loadPage() {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', 'mra-page.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

(async () => {
  const p = loadPage();
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // a question as the business's own connection, as every back office page asks it
  async function read(tenant, sql, params) {
    await c.query('SAVEPOINT r');
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      const rows = (await c.query(sql, params)).rows;
      await c.query('RELEASE SAVEPOINT r');
      return rows;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT r');
      throw e;
    } finally {
      await c.query('SET LOCAL ROLE none');
    }
  }
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mra-page@example.com')`, [admin]);
    const make = async (name, code) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,'premium') as r`, [admin, name, code, crypto.randomUUID()])).r;
    const t = (await make('MRA Page', 'MRP1')).tenant_id;
    const other = (await make('MRA Page Other', 'MRP2')).tenant_id;
    await as(t);
    const store = (await one(`select id from stores where tenant_id = $1`, [t])).id;
    await c.query(`update stores set timezone = 'Indian/Mauritius' where id = $1`, [store]);
    const till = async (tenant, st, name, code) => (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, $3, $4) returning id`, [tenant, st, name, code])).id;
    const tA = await till(t, store, 'Till A', 'TA');
    const tB = await till(t, store, 'Till B', 'TB');
    const gone = crypto.randomUUID(); // a till that was removed: its invoices stay
    await c.query(`update pos_devices set mra_ebs_id = 'EBS-A', mra_status = $2::jsonb where id = $1`,
      [tA, JSON.stringify({ at: '2026-10-22T17:24:00Z', connected: true, until: '2026-10-23T09:18:00Z', refused: null, check: 0, environment: 'TEST' })]);
    await c.query(`update pos_devices set mra_status = $2::jsonb where id = $1`, [tB, JSON.stringify({ at: '2026-10-22T17:00:00Z', connected: false, refused: 'Wrong password' })]);

    let n = 0;
    const rec = async (tenant, st, dev, type, ident, status, issued, paid, more = {}) => {
      n += 1;
      await as(tenant);
      await c.query(
        `insert into mra_records (id, tenant_id, store_id, device_id, ebs_id, doc_type, counter, identifier, ref_identifier, previous_hash, invoice, issued_at, status, irn, qr, errors, answered_at)
         values ($1,$2,$3,$4,'EBS-A',$5,$6,$7,$8,'h',$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [crypto.randomUUID(), tenant, st, dev, type, n, ident, more.ref ?? null, JSON.stringify({ totalAmtPaid: paid }), issued, status,
          status === 'fiscalised' ? 'IRN-' + ident : null, status === 'fiscalised' ? 'iVBORw0KGgoAAAA' : null,
          JSON.stringify(more.errors ?? []), status === 'waiting' ? null : issued],
      );
    };
    await rec(t, store, tA, 'STD', 'MRP1-TA-000001', 'fiscalised', '2026-10-21T08:00:00Z', '480.00');
    await rec(t, store, tA, 'CRN', 'MRP1-TA-R000002', 'fiscalised', '2026-10-21T09:00:00Z', '57.50', { ref: 'MRP1-TA-000001' });
    // 21:30 UTC on the 21st is 01:30 on the 22nd in Mauritius
    await rec(t, store, tA, 'STD', 'MRP1-TA-000003', 'refused', '2026-10-21T21:30:00Z', '100.00', { errors: ['ERR0600: Invalid seller BRN'] });
    await rec(t, store, tA, 'STD', 'MRP1-TA-000004', 'waiting', '2026-10-22T10:00:00Z', '140.00');
    await rec(t, store, tA, 'STD', 'MRP1-TA-000005', 'check', '2026-10-22T11:00:00Z', '140.00');
    await rec(t, store, tB, 'TRN', 'TRN00000006', 'fiscalised', '2026-10-20T08:00:00Z', '115.00');
    await rec(t, store, gone, 'PRF', 'MRP1-TX-PRF000007', 'fiscalised', '2026-10-19T08:00:00Z', '270.00');
    await as(other);
    const otherStore = (await one(`select id from stores where tenant_id = $1`, [other])).id;
    const otherTill = await till(other, otherStore, 'Their till', 'T1');
    await rec(other, otherStore, otherTill, 'STD', 'OTHER-000001', 'fiscalised', '2026-10-22T08:00:00Z', '10.00');

    const none = { store: null, till: null, type: null, status: null, from: null, to: null };
    const list = (f, withQr = true) => read(t, p.INVOICES_SQL, p.invoiceParams(t, { ...none, ...f }, 500, withQr));
    const ids = (rows) => rows.map((r) => r.identifier);

    // P1 the tills
    const tills = await read(t, p.TILLS_SQL, [t]);
    check('P1 both tills, in order', tills.map((r) => r.code).join(',') === 'TA,TB', tills.map((r) => r.code).join(','));
    const a = tills.find((r) => r.code === 'TA');
    check('P1 Till A: two without an answer, one of them sent twice; one refused', a.waiting === 2 && a.to_check === 1 && a.refused === 1, JSON.stringify({ w: a.waiting, c: a.to_check, r: a.refused }));
    check('P1 Till A: the oldest waiting is the 10:00 one', new Date(a.oldest_waiting).toISOString() === '2026-10-22T10:00:00.000Z');
    check('P1 Till A: last fiscalised is the credit note', new Date(a.last_fiscalised).toISOString() === '2026-10-21T09:00:00.000Z');
    check('P1 Till A keeps its EBS ID, its branch and its report', a.ebs === 'EBS-A' && a.store_id === store && a.status.connected === true && a.status.environment === 'TEST');
    const b = tills.find((r) => r.code === 'TB');
    check('P1 Till B: nothing waits', b.waiting === 0 && b.oldest_waiting === null && b.refused === 0);

    // P2 the invoices
    const all = await list({});
    check('P2 every invoice of this business, newest first', ids(all).join(',') === 'MRP1-TA-000005,MRP1-TA-000004,MRP1-TA-000003,MRP1-TA-R000002,MRP1-TA-000001,TRN00000006,MRP1-TX-PRF000007', ids(all).join(','));
    check('P2 another business\'s invoice is never seen', !ids(all).includes('OTHER-000001'));
    const crn = all.find((r) => r.type === 'CRN');
    check('P2 a credit note names its sale and reads with a minus', crn.ref === 'MRP1-TA-000001' && p.signedCents(crn.type, crn.paid) === -5750);
    const lost = all.find((r) => r.identifier === 'MRP1-TX-PRF000007');
    check('P2 an invoice whose till is gone is still listed', lost && lost.till === 'A till no longer set up' && lost.till_code === null);
    check('P2 the QR comes with it, and not for the CSV', crn.qr === 'iVBORw0KGgoAAAA' && (await list({}, false)).every((r) => r.qr === null));
    check('P2 a refusal keeps the MRA\'s reason', p.reasons(all.find((r) => r.status === 'refused').errors) === 'ERR0600: Invalid seller BRN');

    // P3 the filters
    check('P3 by type', ids(await list({ type: 'CRN' })).join(',') === 'MRP1-TA-R000002');
    check('P3 waiting covers sent and sent twice', ids(await list({ status: 'waiting' })).join(',') === 'MRP1-TA-000005,MRP1-TA-000004');
    check('P3 by till', ids(await list({ till: tB })).join(',') === 'TRN00000006');
    check('P3 by branch: all seven are in its one branch, the gone till\'s too', (await list({ store })).length === 7);
    check('P3 dates are the branch\'s own: 21:30 UTC on the 21st is the 22nd', ids(await list({ from: '2026-10-22', to: '2026-10-22' })).join(',') === 'MRP1-TA-000005,MRP1-TA-000004,MRP1-TA-000003');
    check('P3 the page\'s limit holds', (await read(t, p.INVOICES_SQL, p.invoiceParams(t, none, 2, true))).length === 2);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  if (failures) {
    console.log(failures + ' failed');
    process.exit(1);
  }
  console.log('all passed');
})().catch((e) => {
  console.log('FAILED ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
