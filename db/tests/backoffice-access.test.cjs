// backoffice-access.test.cjs — who the back office lets in.
// A role has a tick for "Sign in to the back office" (backoffice.access). A
// login whose role does not hold it is for the tills: it must not open the
// back office, with whatever its pages show (the menu, customers, receipts).
//   - the owner and a manager come in
//   - a cashier's login is sent to the page that says why, and is not sent
//     round in circles from there
//   - ticking the box for the role lets the same login in
//   - a login that is switched off, or linked to nothing, is told so as before
// The real web/lib/tenant.ts is run, with the sign-in and the database stood
// in for (the session is the test's say, the database the test's connection).
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/backoffice-access.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const WEB = path.join(__dirname, '..', '..', 'web');
const ts = require(path.join(WEB, 'node_modules', 'typescript'));

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

// web/lib/tenant.ts as it is, compiled here; who is signed in is `who.id`
function tenantLib(client, who) {
  const stubs = {
    react: { cache: (fn) => fn },
    'next/navigation': {
      redirect: (to) => { throw new Error('redirect ' + to); },
      notFound: () => { throw new Error('not found'); },
    },
    '@/lib/auth/server': { auth: { getSession: async () => ({ data: who.id ? { user: { id: who.id, email: 'someone@example.com' } } : null }) } },
    '@/lib/db': { ask: (sql, params) => client.query(sql, params) },
  };
  const load = (file) => {
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file,
    }).outputText;
    const mod = { exports: {} };
    const req = (name) => {
      if (stubs[name]) return stubs[name];
      if (name.startsWith('@/')) return load(path.join(WEB, name.slice(2) + '.ts'));
      throw new Error('an import this test has no stand-in for: ' + name);
    };
    new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
    return mod.exports;
  };
  return load(path.join(WEB, 'lib', 'tenant.ts'));
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-boa@example.com')`, [admin]);
    const ownerAuth = crypto.randomUUID(), managerAuth = crypto.randomUUID(), cashierAuth = crypto.randomUUID();
    const made = (await one(`select platform.create_tenant($1,'Access Test','Main','BA1','Owner',$2,'standard') as r`, [admin, ownerAuth])).r;
    const tid = made.tenant_id;
    await c.query(`select platform.add_login($1,$2,'Mina','Manager',$3)`, [admin, tid, managerAuth]);
    const cashier = (await one(`select platform.add_login($1,$2,'Ravi','Cashier',$3) as id`, [admin, tid, cashierAuth])).id;

    const who = { id: null };
    const lib = tenantLib(c, who);
    // where someone ends up: 'in' with their context, or the page they are sent to
    const enter = async (id) => {
      who.id = id;
      try { return { in: await lib.tenantContext() }; } catch (e) { return { to: String(e.message).replace(/^redirect /, '') }; }
    };

    let r = await enter(ownerAuth);
    check('A1 the owner comes in', !!r.in && r.in.tenantId === tid && r.in.role === 'Owner', JSON.stringify(r.to ?? r.in?.role));
    r = await enter(managerAuth);
    check('A2 a manager comes in: the role holds "Sign in to the back office"', !!r.in && r.in.role === 'Manager', JSON.stringify(r.to ?? r.in?.role));
    r = await enter(cashierAuth);
    check('A3 a cashier\'s login does not: its role has no such tick', !r.in && r.to === '/onboarding', JSON.stringify(r.to ?? 'came in as ' + r.in?.role));

    // the page it is sent to must not send it straight back (that would go round for ever)
    check('A4 the lookup that page makes says the login is known but kept out',
      typeof lib.loginStanding === 'function' && (await (async () => { who.id = cashierAuth; return lib.loginStanding(cashierAuth); })()) === 'no-access',
      typeof lib.loginStanding === 'function' ? await lib.loginStanding(cashierAuth) : 'no such function');
    check('A4 and that the owner and the manager may come in',
      typeof lib.loginStanding === 'function' && (await lib.loginStanding(ownerAuth)) === 'ok' && (await lib.loginStanding(managerAuth)) === 'ok');
    check('A4 and that a login linked to nothing is unknown',
      typeof lib.loginStanding === 'function' && (await lib.loginStanding(crypto.randomUUID())) === 'none');

    // an action is refused the same way: it never reaches the permission check as someone inside
    who.id = cashierAuth;
    let acted = 'ran';
    try { await lib.requirePerm('items.edit'); } catch (e) { acted = e.message; }
    check('A5 a server action by that login is turned away too', acted === 'redirect /onboarding', acted);

    // the owner ticks the box for cashiers
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    await c.query(`update roles set permissions = permissions || '["backoffice.access"]'::jsonb where tenant_id = $1 and name = 'Cashier'`, [tid]);
    r = await enter(cashierAuth);
    check('A6 with the box ticked for its role, the same login comes in', !!r.in && r.in.employeeId === cashier, JSON.stringify(r.to));

    // switched off: as before, "no restaurant on this login"
    await c.query(`select platform.set_login_active($1,$2,false)`, [admin, cashier]);
    r = await enter(cashierAuth);
    check('A7 a login that was switched off is sent to the same page', !r.in && r.to === '/onboarding', JSON.stringify(r.to));
    check('A7 and is told it has no access at all, not that its role lacks it',
      typeof lib.loginStanding === 'function' && (await lib.loginStanding(cashierAuth)) === 'none');
    r = await enter(null);
    check('A8 nobody signed in goes to the sign-in page', !r.in && r.to === '/login', JSON.stringify(r.to));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'BACKOFFICE ACCESS PASS' : `BACKOFFICE ACCESS FAIL (${failures})`);
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exitCode = 1; });
