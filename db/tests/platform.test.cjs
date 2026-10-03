// platform.test.cjs — the platform admin's database side (migrations 0044, 0045).
//   - the tenant role cannot see the platform schema or call its functions
//   - only a live platform admin can create a tenant; the tenant comes with
//     its store, the four roles and the owner's login row
//   - logins can be added, switched off and on
//   - a suspended tenant keeps syncing sales already made (spec 4.4)
//   - every admin action is logged, and the log cannot be changed
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/platform.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

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
  try {
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID();
    const ownerAuth = crypto.randomUUID(), cashierAuth = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-test@example.com')`, [admin]);

    // T1 the tenant role is locked out of the platform schema
    await c.query('SET LOCAL ROLE app_user');
    let e = await failsWith('select count(*) from platform.admins');
    check('T1 app_user cannot read platform.admins', e && e.code === '42501', e ? e.code : 'no error');
    e = await failsWith(`insert into platform.admins (auth_user_id, email) values ($1, 'x@example.com')`, [crypto.randomUUID()]);
    check('T1 app_user cannot make itself an admin', e && e.code === '42501', e ? e.code : 'no error');
    e = await failsWith(`select platform.create_tenant($1,'X','Main','S1','O',$2,'standard')`, [admin, crypto.randomUUID()]);
    check('T1 app_user cannot call platform.create_tenant', e && e.code === '42501', e ? e.code : 'no error');
    await c.query('SET LOCAL ROLE none');

    // T2 only a live platform admin creates tenants
    e = await failsWith(`select platform.create_tenant($1,'X','Main','S1','O',$2,'standard')`, [stranger, ownerAuth]);
    check('T2 a non-admin is refused', e && e.message === 'not-a-platform-admin', e ? e.message : 'no error');
    e = await failsWith(`select platform.create_tenant($1,'  ','Main','S1','O',$2,'standard')`, [admin, ownerAuth]);
    check('T2 a name is required', e && e.message === 'name-required', e ? e.message : 'no error');
    e = await failsWith(`select platform.create_tenant($1,'X','Main','bad code!','O',$2,'standard')`, [admin, ownerAuth]);
    check('T2 a bad store code is refused', e && e.message === 'bad-store-code', e ? e.message : 'no error');

    // T3 a tenant arrives complete
    const made = (await one(`select platform.create_tenant($1,'Chez Test','Port Louis','pl1','Aisha',$2,'standard') as r`, [admin, ownerAuth])).r;
    const tid = made.tenant_id;
    const t = await one(`select name, plan, status from tenants where id = $1`, [tid]);
    check('T3 tenant created, active, on its plan', t.name === 'Chez Test' && t.plan === 'standard' && t.status === 'active', JSON.stringify(t));
    const store = await one(`select name, code from stores where tenant_id = $1`, [tid]);
    check('T3 first store created, code upper-cased', store.name === 'Port Louis' && store.code === 'PL1', JSON.stringify(store));
    const roles = (await c.query(`select name from roles where tenant_id = $1 order by name`, [tid])).rows.map((r) => r.name);
    check('T3 the four roles exist', JSON.stringify(roles) === '["Cashier","Manager","Owner","Waiter"]', JSON.stringify(roles));
    const owner = await one(`select e.id, e.name, r.name as role, e.auth_user_id,
        (select count(*)::int from employee_stores s where s.employee_id = e.id) as stores
      from employees e join roles r on r.id = e.role_id where e.tenant_id = $1`, [tid]);
    check('T3 owner login linked, with the Owner role and the store',
      owner.name === 'Aisha' && owner.role === 'Owner' && owner.auth_user_id === ownerAuth && owner.stores === 1, JSON.stringify(owner));
    e = await failsWith(`select platform.create_tenant($1,'Second','Main','S1','O',$2,'standard')`, [admin, ownerAuth]);
    check('T3 one login cannot own two tenants', e && e.message === 'login-already-linked', e ? e.message : 'no error');

    // T4 another login, with a role
    const cashier = (await one(`select platform.add_login($1,$2,'Ravi','Cashier',$3) as id`, [admin, tid, cashierAuth])).id;
    e = await failsWith(`select platform.add_login($1,$2,'Nobody','Chef',$3)`, [admin, tid, crypto.randomUUID()]);
    check('T4 an unknown role is refused', e && e.message === 'unknown-role', e ? e.message : 'no error');
    const perms = await one(`select has_perm($1,'payment.take') as cashier_pays, has_perm($1,'sale.refund') as cashier_refunds,
        has_perm($2,'sale.refund') as owner_refunds`, [cashier, owner.id]);
    check('T4 cashier takes payment but cannot refund; owner can',
      perms.cashier_pays === true && perms.cashier_refunds === false && perms.owner_refunds === true, JSON.stringify(perms));
    const waiter = await one(`select permissions ? 'payment.take' as pays, permissions ? 'sale.apply_discount' as discounts,
        permissions ? 'sale.create' as sells from roles where tenant_id = $1 and name = 'Waiter'`, [tid]);
    check('T4 waiter sells, takes no payment, gives no discount', waiter.sells && !waiter.pays && !waiter.discounts, JSON.stringify(waiter));

    // helper: what the API does for this tenant
    const storeId = made.store_id;
    async function push(emp, ops) {
      await c.query('SAVEPOINT push_sp');
      try {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        const r = (await one('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).r;
        await c.query('SET LOCAL ROLE none');
        await c.query('RELEASE SAVEPOINT push_sp');
        return r;
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT push_sp'); // also restores the role
        throw err;
      }
    }
    const ticketOp = () => ({ op_id: crypto.randomUUID(), type: 'ticket.create', payload: { id: crypto.randomUUID(), store_id: storeId } });

    // T5 suspending keeps the data flowing
    e = await failsWith(`select platform.set_tenant_status($1,$2,'suspended','')`, [admin, tid]);
    check('T5 suspending needs a reason', e && e.message === 'reason-required', e ? e.message : 'no error');
    e = await failsWith(`select platform.set_tenant_status($1,$2,'deleted','x')`, [admin, tid]);
    check('T5 only active or suspended', e && e.message === 'bad-status', e ? e.message : 'no error');
    await c.query(`select platform.set_tenant_status($1,$2,'suspended','plan cancelled 2026-10')`, [admin, tid]);
    const s1 = await one(`select status, status_reason, status_changed_at is not null as stamped from tenants where id = $1`, [tid]);
    check('T5 suspended with its reason', s1.status === 'suspended' && s1.status_reason === 'plan cancelled 2026-10' && s1.stamped, JSON.stringify(s1));
    const r5 = await push(owner.id, [ticketOp()]);
    check('T5 a suspended tenant still syncs', r5[0].status === 'applied', JSON.stringify(r5[0]));
    await c.query(`select platform.set_tenant_status($1,$2,'active',null)`, [admin, tid]);
    const s2 = await one(`select status, status_reason from tenants where id = $1`, [tid]);
    check('T5 reactivated, reason cleared', s2.status === 'active' && s2.status_reason === null, JSON.stringify(s2));

    // T6 plan is a label the admin sets
    await c.query(`select platform.set_tenant_plan($1,$2,'premium')`, [admin, tid]);
    check('T6 plan changed', (await one(`select plan from tenants where id = $1`, [tid])).plan === 'premium');

    // T10 stores, business details and tills (migration 0045)
    const store2 = (await one(`select platform.add_store($1,$2,'Grand Baie','gb1') as id`, [admin, tid])).id;
    const access = await one(`select count(*)::int n from employee_stores where store_id = $1`, [store2]);
    const code2 = (await one(`select code from stores where id = $1`, [store2])).code;
    check('T10 a second store is added, and both logins can use it', access.n === 2 && code2 === 'GB1', JSON.stringify({ access, code2 }));
    e = await failsWith(`select platform.add_store($1,$2,'Again','PL1')`, [admin, tid]);
    check('T10 a store code cannot be used twice', e && e.message === 'store-code-taken', e ? e.message : 'no error');
    await c.query(`select platform.set_tenant_details($1,$2,'Chez Test Ltd','C12345678','VAT20123456')`, [admin, tid]);
    const det = await one(`select name, brn, vat_number from tenants where id = $1`, [tid]);
    check('T10 name, BRN and VAT number are saved', det.name === 'Chez Test Ltd' && det.brn === 'C12345678' && det.vat_number === 'VAT20123456', JSON.stringify(det));
    const till = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Till 1','T1') returning id`, [tid, storeId])).id;
    await c.query(`select platform.set_device_active($1,$2,false)`, [admin, till]);
    const off = await one(`select deleted_at is not null as off from pos_devices where id = $1`, [till]);
    await c.query(`select platform.set_device_active($1,$2,true)`, [admin, till]);
    const on = await one(`select deleted_at is null as on from pos_devices where id = $1`, [till]);
    check('T10 a till is deactivated and reactivated', off.off === true && on.on === true);
    e = await failsWith(`select platform.add_login($1,$2,'Me','Manager',$1)`, [admin, tid]);
    check('T10 a platform admin cannot be made a restaurant login', e && e.message === 'login-is-platform-admin', e ? e.message : 'no error');
    e = await failsWith(`select platform.create_tenant($1,'Mine','Main','S1','Me',$1,'standard')`, [admin]);
    check('T10 nor the owner of one', e && e.message === 'login-is-platform-admin', e ? e.message : 'no error');

    // T7 switching one login off stops that login, nobody else
    await c.query(`select platform.set_login_active($1,$2,false)`, [admin, cashier]);
    let blocked = null;
    try { await push(cashier, [ticketOp()]); } catch (err) { blocked = err; }
    check('T7 a disabled login cannot push', blocked && blocked.message === 'unknown-employee', blocked ? blocked.message : 'no error');
    const r7 = await push(owner.id, [ticketOp()]);
    check('T7 the owner is unaffected', r7[0].status === 'applied');
    await c.query(`select platform.set_login_active($1,$2,true)`, [admin, cashier]);
    const r7b = await push(cashier, [ticketOp()]);
    check('T7 re-enabled login works again', r7b[0].status === 'applied');

    // T8 a revoked admin is an admin no more
    await c.query(`update platform.admins set revoked_at = now() where auth_user_id = $1`, [admin]);
    e = await failsWith(`select platform.set_tenant_plan($1,$2,'free')`, [admin, tid]);
    check('T8 a revoked admin is refused', e && e.message === 'not-a-platform-admin', e ? e.message : 'no error');

    // T9 everything was logged, and the log is insert-only
    const actions = (await c.query(`select action from platform.audit where tenant_id = $1 order by created_at, id`, [tid])).rows.map((r) => r.action);
    const expected = ['tenant.create', 'login.add', 'tenant.suspended', 'tenant.active', 'tenant.plan', 'store.add',
      'tenant.details', 'till.deactivate', 'till.activate', 'login.disable', 'login.enable'];
    check('T9 every action is in the audit log', expected.every((a) => actions.includes(a)) && actions.length === expected.length, JSON.stringify(actions));
    const secrets = await one(`select count(*)::int n from platform.audit where tenant_id = $1 and detail::text ilike '%password%'`, [tid]);
    check('T9 the log holds no password', secrets.n === 0);
    e = await failsWith(`delete from platform.audit where tenant_id = $1`, [tid]);
    check('T9 the log cannot be deleted', e !== null, e ? e.message.slice(0, 50) : 'no error');
    e = await failsWith(`update platform.audit set action = 'x' where tenant_id = $1`, [tid]);
    check('T9 the log cannot be edited', e !== null, e ? e.message.slice(0, 50) : 'no error');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PLATFORM PASS' : `PLATFORM FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
