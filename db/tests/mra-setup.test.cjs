// mra-setup.test.cjs — migration 0116: Premium MRA, piece 1
// (docs/superpowers/specs/2026-10-17-premium-mra-design.md).
//   - a client's MRA state (off, setting_up, training, live) and the details
//     the MRA asks for: legal name, TAN, goods or services, a code per tax, an
//     EBS MRA ID per till
//   - a client is on MRA only on the premium plan, both ways round
//   - /admin moves a client between off and setting_up, written to the
//     settings its tills pull and to the audit
//   - the checklist says, line by line, what the move still lacks
//   - a payment type is not corrected on a sale of a live MRA client
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/mra-setup.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  // runs a statement that is expected to fail, without losing the transaction
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const said = (e) => (e ? e.message : 'no error');
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // a till's push, as the tenant's own connection makes it
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
  const tag = (o) => o.status + (o.code ? ':' + o.code : '');
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mra@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    const mraOf = async (t) => (await one(`select mra from tenants where id = $1`, [t])).mra;
    const settings = async (t) => { await as(t); return (await one(`select data from pos_settings where tenant_id = $1`, [t])).data; };
    const lastAudit = async (t, action) =>
      (await one(`select detail from platform.audit where tenant_id = $1 and action = $2 order by created_at desc limit 1`, [t, action]))?.detail ?? null;
    const setMra = (t, state) => failsWith(`select platform.set_tenant_mra($1, $2, $3)`, [admin, t, state]);

    // M1 the state and the details, and what they accept
    const prem = await make('MRA Premium', 'MRA1', 'premium');
    const off = await make('MRA Offline', 'MRA2', 'offline');
    const t = prem.tenant_id;
    check('M1 a new client is not on MRA', (await mraOf(t)) === 'off');
    check('M1 the state takes only off, setting_up, training and live',
      /tenants_mra_check/.test(said(await failsWith(`update tenants set mra = 'other' where id = $1`, [t]))));
    await as(t);
    check('M1 a tax code is one of TC01 to TC06',
      /taxes_mra_code_check/.test(said(await failsWith(`update taxes set mra_code = 'TC09' where tenant_id = $1`, [t]))));
    await c.query(`insert into categories (tenant_id, name) values ($1, 'Drinks')`, [t]);
    check('M1 a category is goods or services',
      /categories_mra_nature_check/.test(said(await failsWith(`update categories set mra_nature = 'food' where tenant_id = $1`, [t]))));

    // M2 moving a client to MRA, from /admin
    check('M2 an offline client is not put on MRA', said(await setMra(off.tenant_id, 'setting_up')) === 'mra-needs-premium');
    check('M2 the offline client stays off', (await mraOf(off.tenant_id)) === 'off');
    check('M2 a premium client is put on MRA (setting up)', (await setMra(t, 'setting_up')) === null && (await mraOf(t)) === 'setting_up');
    check('M2 its tills are told through their settings', (await settings(t)).mra === 'setting_up', JSON.stringify((await settings(t)).mra));
    const a = await lastAudit(t, 'tenant.mra');
    check('M2 the audit has it, from off to setting_up', a && a.from === 'off' && a.to === 'setting_up', JSON.stringify(a));

    // M3 the plan and the state hold each other
    check('M3 a client on MRA is not moved to another plan',
      said(await failsWith(`select platform.set_tenant_plan($1, $2, 'offline')`, [admin, t])) === 'mra-needs-premium');
    check('M3 nor made trial', said(await failsWith(`update tenants set plan = 'trial' where id = $1`, [t])) === 'mra-needs-premium');
    check('M3 training and live are not set from /admin yet', said(await setMra(t, 'live')) === 'bad-mra-state' && said(await setMra(t, 'training')) === 'bad-mra-state');
    check('M3 an unknown state is refused', said(await setMra(t, 'x')) === 'bad-mra-state');
    check('M3 an unknown client is refused', said(await setMra(crypto.randomUUID(), 'setting_up')) === 'unknown-tenant');

    // M4 the checklist, bare then complete
    await as(t);
    const store = (await one(`select id from stores where tenant_id = $1`, [t])).id;
    const till = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, 'Till 1', 'T1') returning id`, [t, store])).id;
    const till2 = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, 'Till 2', 'T2') returning id`, [t, store])).id;
    await c.query(`insert into items (tenant_id, name, price) values ($1, 'Untaxed water', 2500)`, [t]);
    const list = async () => {
      const r = (await one(`select platform.mra_checklist($1, $2) as r`, [admin, t])).r;
      return Object.fromEntries(r.map((l) => [l.key, l]));
    };
    let l = await list();
    check('M4 six lines', Object.keys(l).sort().join() === 'addresses,company,items,nature,taxes,tills', Object.keys(l).join());
    check('M4 bare: none of them done', Object.values(l).every((x) => x.ok === false), JSON.stringify(l));
    check('M4 company: legal name, TAN and BRN missing', JSON.stringify(l.company.missing) === JSON.stringify(['legal name', 'TAN', 'BRN']), JSON.stringify(l.company));
    check('M4 the branch without an address is named', JSON.stringify(l.addresses.missing) === JSON.stringify(['Main']), JSON.stringify(l.addresses));
    check('M4 every tax without a code is named', l.taxes.missing.length >= 1 && l.taxes.missing.includes('VAT'), JSON.stringify(l.taxes));
    check('M4 the items without a tax are counted', l.items.count === 1, JSON.stringify(l.items));
    check('M4 the tills without an ID are named', JSON.stringify(l.tills.missing) === JSON.stringify(['Till 1', 'Till 2']), JSON.stringify(l.tills));
    await c.query(`update tenants set legal_name = 'MRA Premium Ltd', tan = '12345678', brn = 'C12345678', mra_nature = 'services' where id = $1`, [t]);
    await as(t);
    await c.query(`update stores set address = 'Royal Road, Curepipe' where tenant_id = $1`, [t]);
    await c.query(`update taxes set mra_code = case when rate_bp = 1500 then 'TC01' else 'TC02' end where tenant_id = $1`, [t]);
    await c.query(`update items set deleted_at = now() where tenant_id = $1 and name = 'Untaxed water'`, [t]);
    // M5 the tills' EBS MRA IDs, from /admin
    const setId = (d, id) => failsWith(`select platform.set_till_mra_id($1, $2, $3)`, [admin, d, id]);
    check('M5 a till is given its EBS MRA ID', (await setId(till, 'EBS-0001')) === null);
    const ta = await lastAudit(t, 'till.mra_id');
    check('M5 the audit has it', ta && ta.till === till && ta.from === null && ta.to === 'EBS-0001', JSON.stringify(ta));
    check('M5 the same ID on another till of the client is refused', said(await setId(till2, 'EBS-0001')) === 'mra-id-taken');
    check('M5 an ID with a space is refused', said(await setId(till2, 'a b')) === 'bad-mra-id');
    check('M5 an unknown till is refused', said(await setId(crypto.randomUUID(), 'EBS-0003')) === 'unknown-till');
    check('M5 an empty ID clears it', (await setId(till2, 'EBS-0002')) === null && (await setId(till2, '  ')) === null &&
      (await one(`select mra_ebs_id from pos_devices where id = $1`, [till2])).mra_ebs_id === null);
    await setId(till2, 'EBS-0002');
    l = await list();
    check('M4 complete: every line done', Object.values(l).every((x) => x.ok === true), JSON.stringify(l));
    check('M4 a till taken out of use is not asked for', await (async () => {
      await as(t);
      await c.query(`update pos_devices set mra_ebs_id = null, deleted_at = now() where id = $1`, [till2]);
      return (await list()).tills.ok === true;
    })());

    // M6 a payment type is not corrected on a sale the MRA holds
    await as(t);
    const owner = (await one(`select id from employees where tenant_id = $1`, [t])).id;
    const dp = await one(`insert into items (tenant_id, name, price) values ($1, 'Dholl puri', 5000) returning id, price`, [t]);
    await c.query(`insert into item_taxes (tenant_id, item_id, tax_id) select $1, $2, id from taxes where tenant_id = $1 and name = 'VAT'`, [t, dp.id]);
    const cash = (await one(`select id from payment_types where tenant_id = $1 and name = 'Cash'`, [t])).id;
    const card = (await one(`select id from payment_types where tenant_id = $1 and name = 'Card'`, [t])).id;
    let seq = 0;
    const sale = async () => {
      const tk = crypto.randomUUID(), rc = crypto.randomUUID();
      const r = await push(t, owner, [
        op('ticket.create', { id: tk, store_id: store }),
        op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: dp.id, qty: 1000 }),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: till, number: 'MRA-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount: Number(dp.price) }] }),
      ]);
      return { rc, ok: r.every((o) => o.status === 'applied'), r };
    };
    const correct = (rc) => push(t, owner, [op('payment.correct', { id: crypto.randomUUID(), receipt_id: rc, from_payment_type_id: cash, to_payment_type_id: card })]);
    const corrections = async (rc) => { await as(t); return (await one(`select count(*)::int as n from payment_corrections where receipt_id = $1`, [rc])).n; };
    const s1 = await sale();
    check('M6 a sale is made', s1.ok, JSON.stringify(s1.r));
    await c.query(`update tenants set mra = 'live' where id = $1`, [t]);
    const refused = (await correct(s1.rc))[0];
    check('M6 on a live MRA client the correction is refused', refused.status !== 'applied', tag(refused));
    check('M6 and nothing is written', (await corrections(s1.rc)) === 0);
    await c.query(`update tenants set mra = 'off' where id = $1`, [t]);
    const taken = (await correct(s1.rc))[0];
    check('M6 off MRA it is taken as before', tag(taken) === 'applied' && (await corrections(s1.rc)) === 1, tag(taken));
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
