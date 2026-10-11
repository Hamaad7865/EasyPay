// admin-inside.test.cjs — EasyPay's platform admin in an offline client's back
// office ("Login to back office" in /admin). The statement that decides who
// may come in, and as whom, is read from web/lib/tenant.ts (adminInside), so
// what is held to these rules is what the back office runs.
// Everything runs in one transaction that is rolled back.
// Usage: node db/tests/admin-inside.test.cjs
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

// the first statement of adminInside, as the file has it
function statement() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'lib', 'tenant.ts'), 'utf8');
  const from = src.indexOf('export async function adminInside');
  const m = from < 0 ? null : /ask\(\s*`([\s\S]*?)`/.exec(src.slice(from));
  if (!m) throw new Error('adminInside and its statement were not found in web/lib/tenant.ts');
  return m[1];
}

(async () => {
  const sql = statement();
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (q, params) => (await c.query(q, params)).rows[0];
  // who the admin stands in for, or null: the statement, and nothing else
  const inside = async (user, tenant) => { const r = await one(sql, [user, tenant]); return r && r.id ? r : null; };
  try {
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID(), gone = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'inside-test@example.com')`, [admin]);
    await c.query(`insert into platform.admins (auth_user_id, email, revoked_at) values ($1, 'inside-gone@example.com', now())`, [gone]);

    const offline = crypto.randomUUID(), standard = crypto.randomUUID(), premium = crypto.randomUUID(), empty = crypto.randomUUID();
    await c.query(
      `insert into tenants (id, tenant_id, name, plan, business_type) values
         ($1,$1,'Chez Inside',' Offline ','restaurant'), ($2,$2,'Standard Inside','standard','retail'),
         ($3,$3,'Premium Inside','premium','restaurant'), ($4,$4,'Nobody Inside','offline','retail')`,
      [offline, standard, premium, empty],
    );
    const people = {};
    for (const t of [offline, standard, premium, empty]) {
      const ownerRole = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [t])).id;
      const cashierRole = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Cashier','["sale.create","backoffice.access"]'::jsonb) returning id`, [t])).id;
      // the cashier is the older row, and has a login: the admin must still stand in for the owner
      const cashier = (await one(
        `insert into employees (tenant_id, name, role_id, auth_user_id, created_at) values ($1,'Cashier',$2,$3, now() - interval '2 days') returning id`,
        [t, cashierRole, crypto.randomUUID()],
      )).id;
      const owner = (await one(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Aisha',$2,$3) returning id`, [t, ownerRole, crypto.randomUUID()])).id;
      people[t] = { ownerRole, cashierRole, cashier, owner };
    }

    // I: who comes in, and as whom
    {
      const r = await inside(admin, offline);
      check('I1 a platform admin comes into an offline client\'s back office', r !== null && r.tenant_id === offline, r && r.tenant_name);
      check('I1 as its owner, the one whose role holds everything, not an older login with less', r && r.id === people[offline].owner && r.employee_name === 'Aisha' && r.role === 'Owner');
      check('I1 with what the pages need of the client: its name, its kind, its plan, its standing', r && r.tenant_name === 'Chez Inside' && r.business_type === 'restaurant' && r.status === 'active' && String(r.plan).trim().toLowerCase() === 'offline');
      check('I2 a login that is no platform admin does not', (await inside(stranger, offline)) === null);
      check('I2 nor one whose admin was taken back', (await inside(gone, offline)) === null);
      check('I2 nor the client\'s own owner, by naming their own client', (await inside((await one(`select auth_user_id from employees where id = $1`, [people[offline].owner])).auth_user_id, offline)) === null);
      check('I3 a client on Standard is not opened from /admin: it has a back office of its own', (await inside(admin, standard)) === null);
      check('I3 nor one on Premium', (await inside(admin, premium)) === null);
      check('I3 nor a client that is not there', (await inside(admin, crypto.randomUUID())) === null);
    }

    // O: the owner the admin stands in for
    {
      // an owner with no login (a client made before logins, or set up with a code): still the owner
      await c.query(`update employees set auth_user_id = null where id = $1`, [people[empty].owner]);
      let r = await inside(admin, empty);
      check('O1 an owner without a login is stood in for all the same', r && r.id === people[empty].owner);
      // two who hold everything: the one with a login, then the older
      const second = (await one(`insert into employees (tenant_id, name, role_id, auth_user_id, created_at) values ($1,'Second',$2,$3, now() - interval '9 days') returning id`, [empty, people[empty].ownerRole, crypto.randomUUID()])).id;
      r = await inside(admin, empty);
      check('O1 of two who hold everything, the one with a login', r && r.id === second);
      await c.query(`update employees set is_active = false where id = $1`, [second]);
      r = await inside(admin, empty);
      check('O2 one who was switched off is passed over', r && r.id === people[empty].owner);
      await c.query(`update employees set deleted_at = now() where id = $1`, [people[empty].owner]);
      check('O2 with nobody left who holds everything there is nothing to open', (await inside(admin, empty)) === null);
      await c.query(`update employees set deleted_at = null where id = $1`, [people[empty].owner]);
      await c.query(`update roles set permissions = '["sale.create"]'::jsonb where id = $1`, [people[empty].ownerRole]);
      check('O2 nor when the role no longer holds everything', (await inside(admin, empty)) === null);
      await c.query(`update roles set permissions = '["*"]'::jsonb where id = $1`, [people[empty].ownerRole]);
      check('O2 and it opens again once it does', (await inside(admin, empty)) !== null);
    }

    // P: the plan decides, every time it is asked
    {
      await c.query(`update tenants set plan = 'premium' where id = $1`, [offline]);
      check('P1 made Premium, the client is no longer opened from /admin', (await inside(admin, offline)) === null);
      await c.query(`update tenants set plan = 'offline', deleted_at = now() where id = $1`, [offline]);
      check('P1 a client that was removed is not opened', (await inside(admin, offline)) === null);
      await c.query(`update tenants set deleted_at = null where id = $1`, [offline]);
      await c.query(`update platform.admins set revoked_at = now() where auth_user_id = $1`, [admin]);
      check('P2 an admin taken back while inside is out at the next page', (await inside(admin, offline)) === null);
    }

    // W: what the owner the admin stands in for may do is what the pages ask
    {
      const ok = await one(`select has_perm($1, 'items.edit') as a, has_perm($1, 'backoffice.access') as b`, [people[empty].owner]);
      check('W1 the one stood in for holds every permission the pages ask for', ok.a === true && ok.b === true);
    }
  } catch (e) {
    failures++;
    console.log('FAIL the suite stopped: ' + (e && e.message));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
