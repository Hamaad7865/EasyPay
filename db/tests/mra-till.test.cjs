// mra-till.test.cjs — migration 0132: MRA e-invoicing, phase 2
// (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md, Task 8).
//   - /admin's MRA connection (the MRA's address and public key) and training
//     and live: the moves, the checklist, live only after Go live
//   - what the tills are told: mra, mra_seller, mra_connect
//   - a till's mra.record: kept as it was sent, only the answer changes, the
//     receipt's difference noted, the till's counter and chains kept
//   - mra_records are never changed or deleted by a till, nor by Clear test
//     activity, and an EBS MRA ID typed for a new till brings its counter
//   - a till's mra.status, and mra-no-correction reaching the till by name
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/mra-till.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

// a made-up certificate's shape (the MRA's is pasted in /admin)
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBmade+up+for+the+test\n-----END CERTIFICATE-----';

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
  const said = (e) => (e ? e.message : 'no error');
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  async function push(tenant, emp, ops) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      const r = (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r;
      await c.query('SET LOCAL ROLE none');
      await c.query('RELEASE SAVEPOINT ' + name);
      return r;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT ' + name);
      await c.query('SET LOCAL ROLE none');
      throw e;
    }
  }
  // a statement as app_user, the till's own role, expected to fail
  async function asApp(tenant, sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      await c.query(sql, params);
      await c.query('SET LOCAL ROLE none');
      await c.query('RELEASE SAVEPOINT ' + name);
      return null;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT ' + name);
      await c.query('SET LOCAL ROLE none');
      return e;
    }
  }
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mra-till@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    const made = await make('MRA Till', 'MRT1', 'premium');
    const other = await make('MRA Other', 'MRT2', 'premium');
    const t = made.tenant_id;
    const mraOf = async () => (await one(`select mra, mra_live_since from tenants where id = $1`, [t]));
    const settings = async () => { await as(t); return (await one(`select data from pos_settings where tenant_id = $1`, [t])).data; };
    const setMra = (state) => failsWith(`select platform.set_tenant_mra($1, $2, $3)`, [admin, t, state]);
    const hadConnection = await one(`select url, certificate from platform.mra_connection where id = 1`);
    if (hadConnection) await c.query(`delete from platform.mra_connection`);

    // T1 the moves
    check('T1 off to training is not a move', said(await setMra('training')) === 'bad-mra-move');
    check('T1 off to setting up', (await setMra('setting_up')) === null && (await mraOf()).mra === 'setting_up');
    check('T1 training waits for the checklist', said(await setMra('training')) === 'mra-checklist');
    await as(t);
    const store = (await one(`select id from stores where tenant_id = $1`, [t])).id;
    const tillA = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, 'Till A', 'TA') returning id`, [t, store])).id;
    await c.query(`update tenants set legal_name = 'MRA Till Ltd', tan = '12345678', brn = 'C12345678', mra_nature = 'goods' where id = $1`, [t]);
    await as(t);
    await c.query(`update stores set address = 'Royal Road, Bel Air' where tenant_id = $1`, [t]);
    await c.query(`update taxes set mra_code = case when rate_bp = 1500 then 'TC01' else 'TC02' end where tenant_id = $1`, [t]);
    await c.query(`update items set deleted_at = now() where tenant_id = $1 and not exists (select 1 from item_taxes it where it.item_id = items.id)`, [t]);
    await c.query(`select platform.set_till_mra_ids($1, $2, $3::jsonb)`, [admin, t, JSON.stringify({ [tillA]: 'EBS-A' })]);
    check('T1 training waits for the MRA connection', said(await setMra('training')) === 'mra-no-connection');

    // T2 the MRA connection, typed once in /admin
    const connect = (url, cert) => failsWith(`select platform.set_mra_connection($1, $2, $3)`, [admin, url, cert]);
    check('T2 an address that is not https is refused', said(await connect('http://vfisc.mra.mu', CERT)) === 'bad-mra-url');
    check('T2 something that is not a certificate is refused', said(await connect('https://vfisc.mra.mu', 'hello')) === 'bad-mra-certificate');
    check('T2 the address and certificate are kept', (await connect('https://vfisc.mra.mu/', CERT)) === null);
    let s = await settings();
    check('T2 a client setting up is sent them', s.mra_connect && s.mra_connect.url === 'https://vfisc.mra.mu' && s.mra_connect.certificate === CERT, JSON.stringify(s.mra_connect));
    check('T2 a client not on MRA is not', await (async () => { await as(other.tenant_id); return !(await one(`select data from pos_settings where tenant_id = $1`, [other.tenant_id])).data.mra_connect; })());

    // T3 training, then live after Go live
    check('T3 setting up to training', (await setMra('training')) === null && (await mraOf()).mra === 'training');
    s = await settings();
    check('T3 the tills are told training', s.mra === 'training');
    check('T3 and the seller the invoices carry', s.mra_seller && s.mra_seller.legal_name === 'MRA Till Ltd' && s.mra_seller.tan === '12345678' && s.mra_seller.nature === 'goods', JSON.stringify(s.mra_seller));
    check('T3 training back to setting up, and again', (await setMra('setting_up')) === null && (await setMra('training')) === null);
    const settingUp = (await one(`select platform.is_setting_up($1) as r`, [t])).r;
    if (!settingUp) await c.query(`insert into platform.setting_up (tenant_id) values ($1)`, [t]);
    check('T3 live waits for the client to go live on EasyPay', said(await setMra('live')) === 'mra-before-go-live');
    await c.query(`select platform.go_live($1, $2)`, [admin, t]);
    check('T3 training to live', (await setMra('live')) === null && (await mraOf()).mra === 'live');
    const since = (await mraOf()).mra_live_since;
    check('T3 the day it went live is kept', since !== null);
    check('T3 live is not taken back to setting up', said(await setMra('setting_up')) === 'bad-mra-move');
    check('T3 MRA off from live, and the day stays', (await setMra('off')) === null && String((await mraOf()).mra_live_since) === String(since));
    await c.query(`update tenants set mra = 'live' where id = $1`, [t]);

    // T4 a till's record of what it sent
    await as(t);
    const owner = (await one(`select id from employees where tenant_id = $1`, [t])).id;
    const dp = await one(`insert into items (tenant_id, name, price) values ($1, 'Dholl puri', 5000) returning id, price`, [t]);
    await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) select $1, $2, id from taxes where tenant_id = $1 and rate_bp = 1500 limit 1`, [t, dp.id]);
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [t])).id;
    const card = (await one(`select id from payment_types where tenant_id = $1 and name = 'Card'`, [t])).id;
    let seq = 0;
    const sale = async () => {
      const tk = crypto.randomUUID(), rc = crypto.randomUUID();
      const r = await push(t, owner, [
        op('ticket.create', { id: tk, store_id: store }),
        op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp.id, qty: 1000 }),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: tillA, number: 'MRT1-TA-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount: Number(dp.price) }] }),
      ]);
      return { rc, ok: r.every((o) => o.status === 'applied'), r };
    };
    const invoice = (paid, id, at = '20261021 10:00:00') => JSON.stringify({ invoiceCounter: '1', invoiceIdentifier: id, totalAmtPaid: paid, dateTimeInvoiceIssued: at, seller: { brn: 'C12345678' } });
    const record = (o) => ({ id: o.id, store_id: store, device_id: o.device || tillA, ebs_id: 'EBS-A', receipt_id: o.rc ?? null, type: o.type || 'STD',
      counter: o.counter, identifier: o.identifier, ref_identifier: '', previous_hash: '0', invoice: o.invoice, issued_at: '2026-10-21T06:00:00Z',
      status: o.status || 'waiting', irn: o.irn || '', qr: o.qr || '', errors: o.errors || [], warnings: [], answered_at: o.answered_at || '' });
    const s1 = await sale();
    check('T4 a sale is made', s1.ok, JSON.stringify(s1.r));
    const r1 = { id: s1.rc, rc: s1.rc, counter: 1, identifier: 'MRT1-TA-1', invoice: invoice('50.00', 'MRT1-TA-1') };
    let res = await push(t, owner, [op('mra.record', record(r1))]);
    check('T4 its record is taken, waiting', tag(res[0]) === 'applied' && res[0].data.status === 'waiting', JSON.stringify(res));
    const row = async (id) => { await as(t); return one(`select * from mra_records where id = $1`, [id]); };
    let x = await row(s1.rc);
    check('T4 the invoice is kept as it was sent', x && x.invoice === r1.invoice && x.doc_type === 'STD' && Number(x.counter) === 1 && x.ebs_id === 'EBS-A');
    check('T4 the receipt comes to what the MRA was told: no difference', x.differs === null, JSON.stringify(x.differs));
    const dev = async (d) => { await as(t); return one(`select mra_counter, mra_chain, mra_status from pos_devices where id = $1`, [d]); };
    let d = await dev(tillA);
    check('T4 the till\'s counter is kept', Number(d.mra_counter) === 1, d.mra_counter);
    check('T4 and the last STD of its chain', d.mra_chain.STD && d.mra_chain.STD.invoiceIdentifier === 'MRT1-TA-1' && d.mra_chain.STD.totalAmtPaid === '50.00' &&
      d.mra_chain.STD.dateTime === '20261021 10:00:00' && d.mra_chain.STD.brn === 'C12345678', JSON.stringify(d.mra_chain));
    res = await push(t, owner, [op('mra.record', record({ ...r1, status: 'fiscalised', irn: 'IRN-1', qr: 'iVBORw0KGgo=', answered_at: '2026-10-21T06:00:01Z' }))]);
    x = await row(s1.rc);
    check('T4 the MRA\'s answer is taken', tag(res[0]) === 'applied' && x.status === 'fiscalised' && x.irn === 'IRN-1' && x.qr === 'iVBORw0KGgo=' && x.answered_at !== null);
    await push(t, owner, [op('mra.record', record({ ...r1, status: 'waiting' }))]);
    check('T4 a fiscalised record stays fiscalised', (await row(s1.rc)).status === 'fiscalised');
    const again = op('mra.record', record({ ...r1, status: 'fiscalised', irn: 'IRN-1' }));
    await push(t, owner, [again]);
    check('T4 the same op twice is a replay', (await push(t, owner, [again]))[0].replayed === true);
    res = await push(t, owner, [op('mra.record', record({ ...r1, invoice: invoice('99.00', 'MRT1-TA-1') }))]);
    check('T4 the same record with another invoice is refused by name', tag(res[0]) === 'rejected:mra-record-fixed', tag(res[0]));
    res = await push(t, owner, [op('mra.record', record({ ...r1, id: crypto.randomUUID(), rc: null, device: crypto.randomUUID() }))]);
    check('T4 a record of a till that is not the client\'s is refused', tag(res[0]) === 'rejected:bad-mra-record', tag(res[0]));
    res = await push(t, owner, [op('mra.record', { ...record({ ...r1, id: crypto.randomUUID() }), type: 'XYZ' })]);
    check('T4 a record of an unknown type is refused', tag(res[0]) === 'rejected:bad-mra-record', tag(res[0]));

    // T5 a difference between the receipt and the invoice is noted, not rewritten
    const s2 = await sale();
    await push(t, owner, [op('mra.record', record({ id: s2.rc, rc: s2.rc, counter: 4, identifier: 'MRT1-TA-2', invoice: invoice('49.00', 'MRT1-TA-2') }))]);
    x = await row(s2.rc);
    check('T5 the difference is noted', x.differs && Number(x.differs.receipt) === 5000 && Number(x.differs.invoice) === 4900, JSON.stringify(x.differs));
    check('T5 and the invoice is still as it was sent', JSON.parse(x.invoice).totalAmtPaid === '49.00');

    // T6 one counter across types, a chain per type; records may arrive out of order
    const trnId = crypto.randomUUID();
    await push(t, owner, [op('mra.record', record({ id: trnId, type: 'TRN', counter: 3, identifier: 'TRN00000003', invoice: invoice('10.00', 'TRN00000003', '20261021 11:00:00') }))]);
    d = await dev(tillA);
    check('T6 an earlier counter arriving later does not take the counter back', Number(d.mra_counter) === 4, d.mra_counter);
    check('T6 each type its own chain', d.mra_chain.TRN.invoiceIdentifier === 'TRN00000003' && d.mra_chain.STD.invoiceIdentifier === 'MRT1-TA-2', JSON.stringify(d.mra_chain));
    await push(t, owner, [op('mra.record', record({ id: crypto.randomUUID(), counter: 2, identifier: 'MRT1-TA-OLD', invoice: invoice('1.00', 'MRT1-TA-OLD') }))]);
    d = await dev(tillA);
    check('T6 nor an earlier STD the chain', Number(d.mra_counter) === 4 && d.mra_chain.STD.invoiceIdentifier === 'MRT1-TA-2', JSON.stringify(d.mra_chain));

    // T7 a till changes nothing it sent, and deletes nothing
    check('T7 the invoice cannot be changed', /mra-record-fixed/.test(said(await asApp(t, `update mra_records set invoice = '{}' where id = $1`, [s1.rc]))));
    check('T7 nor the counter', /mra-record-fixed/.test(said(await asApp(t, `update mra_records set counter = 9 where id = $1`, [s1.rc]))));
    check('T7 a record is not deleted', /permission denied|insert-only/.test(said(await asApp(t, `delete from mra_records where id = $1`, [s1.rc]))));
    check('T7 not even by the owner\'s connection', /insert-only/.test(said(await failsWith(`delete from mra_records where id = $1`, [s1.rc]))));

    // T8 the till's status
    res = await push(t, owner, [op('mra.status', { device_id: tillA, status: { signed_in_until: '2026-10-22T06:00:00Z', refused: null, waiting: 2 } })]);
    d = await dev(tillA);
    check('T8 the till\'s MRA status is kept, with the server\'s time', tag(res[0]) === 'applied' && d.mra_status.waiting === 2 && !!d.mra_status.at, JSON.stringify(d.mra_status));
    res = await push(t, owner, [op('mra.status', { device_id: tillA, status: 'connected' })]);
    check('T8 a status that is not an object is refused', tag(res[0]) === 'rejected:bad-mra-record', tag(res[0]));

    // T9 a payment correction on a live client reaches the till by name
    const corr = (await push(t, owner, [op('payment.correct', { id: crypto.randomUUID(), receipt_id: s1.rc, from_payment_type_id: cash, to_payment_type_id: card })]))[0];
    check('T9 the correction is refused as mra-no-correction', tag(corr) === 'rejected:mra-no-correction', tag(corr));

    // T10 Clear test activity keeps what was sent to the MRA; a new till
    // given the EBS goes on from its counter
    await c.query(`update tenants set mra = 'training' where id = $1`, [t]);
    await c.query(`insert into platform.setting_up (tenant_id) values ($1) on conflict do nothing`, [t]);
    const cleared = await failsWith(`select platform.clear_test_activity($1, $2)`, [admin, t]);
    check('T10 Clear test activity runs on a client in training', cleared === null, said(cleared));
    await as(t);
    check('T10 the till is gone', (await one(`select count(*)::int as n from pos_devices where id = $1`, [tillA])).n === 0);
    check('T10 what was sent to the MRA is not', (await one(`select count(*)::int as n from mra_records where tenant_id = $1`, [t])).n === 4);
    const tillB = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, 'Till B', 'TB') returning id`, [t, store])).id;
    await c.query(`select platform.set_till_mra_ids($1, $2, $3::jsonb)`, [admin, t, JSON.stringify({ [tillB]: 'EBS-A' })]);
    d = await dev(tillB);
    check('T10 the new till given the EBS goes on from its counter', Number(d.mra_counter) === 4, d.mra_counter);
    check('T10 and from its chains', d.mra_chain.STD && d.mra_chain.STD.invoiceIdentifier === 'MRT1-TA-2' && d.mra_chain.TRN.invoiceIdentifier === 'TRN00000003', JSON.stringify(d.mra_chain));

    if (hadConnection) await c.query(`insert into platform.mra_connection (id, url, certificate) values (1, $1, $2) on conflict (id) do update set url = excluded.url, certificate = excluded.certificate`, [hadConnection.url, hadConnection.certificate]);
  } catch (e) {
    console.log('FAIL the test itself: ' + e.stack);
    failures++;
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
