// make-platform-admin.test.cjs — what db/make-platform-admin.cjs does to the
// database, and its rules. The login it promotes here is a row made inside one
// transaction that is rolled back: nothing is created in the sign-in service
// and nothing is left behind. The part that makes a real login (a call to the
// sign-in service) is not run here.
//
// Usage: node db/tests/make-platform-admin.test.cjs
const { spawnSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { wrongEmail, wrongPassword, findLogin, promote, inWords } = require('../make-platform-admin.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const thrown = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

(async () => {
  // R: the rules, which need no database
  check('R1 an e-mail is accepted', wrongEmail('owner@example.com') === null);
  check('R2 what is not an e-mail is refused', !!wrongEmail('owner') && !!wrongEmail('a b@example.com') && !!wrongEmail(''));
  check('R3 a password of ten characters, typed the same twice, is accepted', wrongPassword('correct-10', 'correct-10') === null);
  check('R4 a short one is refused, with its length', /9 characters/.test(wrongPassword('nine-char', 'nine-char') || ''));
  check('R5 two that differ are refused', /not the same/.test(wrongPassword('correct-10', 'correct-11') || ''));
  check('R6 a paste that arrived as a control character is refused', /paste/.test(wrongPassword('\u0016', '\u0016') || ''));
  check('R7 one that begins or ends with a space is refused', /space/.test(wrongPassword(' correct-10', ' correct-10') || ''));
  check('R8 a refusal is put in words, with the client named',
    inWords('login-belongs-to-a-client:Cafe X') === 'That login belongs to the client "Cafe X". A platform admin belongs to no client: use another e-mail.');

  // A: what is typed at a hidden question is not shown, its length is
  const child = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(__dirname, '..', 'make-platform-admin.cjs'))}).ask('Password: ', { hidden: true }).then((a) => console.log('GOT ' + a.length))`],
  { input: 'never-shown-pw\n', encoding: 'utf8' });
  check('A1 the question is shown', child.stdout.includes('Password: '), JSON.stringify(child.stdout.slice(0, 60)));
  check('A2 what was typed is not', !child.stdout.includes('never-shown-pw'));
  check('A3 its length is, and the answer arrives whole', child.stdout.includes('(14 characters)') && child.stdout.includes('GOT 14'), JSON.stringify(child.stdout.slice(-40)));

  // D: the database part, in one transaction that is rolled back
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  try {
    const email = `mpa-${Date.now()}@example.invalid`;
    await c.query(`insert into neon_auth."user" (id, name, email, "emailVerified", role) values (gen_random_uuid(), 'MPA', $1, false, 'user')`, [email]);
    let user = await findLogin(c, email.toUpperCase());
    check('D1 a login is found by its e-mail, whatever its case', !!user && user.email === email);
    const audits = async () => (await c.query(`select count(*)::int as n from platform.audit where admin_auth_user_id = $1 and action = 'admin.make'`, [user.id])).rows[0].n;
    const row = async () => (await c.query(`select email, revoked_at from platform.admins where auth_user_id = $1`, [user.id])).rows[0];

    check('D2 an unknown login is refused', (await thrown(() => promote(c, undefined))) === 'unknown-login');
    check('D3 a login is made a platform admin', (await promote(c, user)) === 'made');
    user = await findLogin(c, email);
    check('D4 it has the role the sign-in service asks of an admin', user.role === 'admin');
    check('D5 it has a live row in platform.admins', (await row())?.email === email && (await row()).revoked_at === null);
    check('D6 and one line in the audit', (await audits()) === 1);
    // what the back office asks before it shows /admin (web/lib/platform.ts)
    const seen = await c.query(`select email from platform.admins where auth_user_id = $1 and revoked_at is null`, [user.id]);
    check('D7 the back office would take it for an admin', seen.rowCount === 1);

    check('D8 a second run says it is one already', (await promote(c, user)) === 'already');
    check('D9 and writes nothing more', (await audits()) === 1);

    await c.query(`update platform.admins set revoked_at = now() where auth_user_id = $1`, [user.id]);
    check('D10 an admin who was revoked is made one again', (await promote(c, user)) === 'made' && (await row()).revoked_at === null);

    await c.query(`update neon_auth."user" set banned = true where id = $1`, [user.id]);
    check('D11 a login that is switched off is refused', (await thrown(async () => promote(c, await findLogin(c, email)))) === 'login-switched-off');

    const linked = (await c.query(
      `select u.id, u.email, u.role, u.banned, t.name from employees e
         join neon_auth."user" u on u.id = e.auth_user_id join tenants t on t.id = e.tenant_id
        where coalesce(u.banned, false) = false limit 1`)).rows[0];
    if (!linked) {
      console.log('SKIP D12 no login on this branch belongs to a client');
    } else {
      const said = await thrown(() => promote(c, linked));
      check("D12 a client's login is refused, with the client's name", said === `login-belongs-to-a-client:${linked.name}`);
      const still = await c.query(`select 1 from platform.admins where auth_user_id = $1 and revoked_at is null`, [linked.id]);
      check('D13 and is left as it was', still.rowCount === 0 || linked.role === 'admin');
    }
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }

  console.log(failures === 0 ? 'MAKE-PLATFORM-ADMIN PASS' : `MAKE-PLATFORM-ADMIN FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
