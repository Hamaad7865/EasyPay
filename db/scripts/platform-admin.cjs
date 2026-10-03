// platform-admin.cjs — who is a platform admin ("super admin").
//
//   node db/scripts/platform-admin.cjs grant you@example.com
//   node db/scripts/platform-admin.cjs list
//   node db/scripts/platform-admin.cjs revoke you@example.com
//
// Run from the repo root. It works on the branch in .env.local and refuses to
// run against production (the same guard the tests use).
//
// grant: if no login exists for that email, it asks for a name and a password
// (typed by you, not shown, not stored anywhere by this script) and creates
// the login. Then it gives the login role 'admin' in the auth service, which
// the auth admin endpoints require, and adds it to platform.admins, which the
// web admin area checks. A login that belongs to a restaurant is refused: keep
// the admin login separate from any restaurant's login.
const readline = require('readline');
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

const ORIGIN = 'http://localhost:3000';

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // echo nothing while the password is typed
      rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

async function createLogin(authBase, email) {
  console.log(`No login exists for ${email}. Creating it.`);
  const name = (await ask('Your name: ')).trim() || 'Platform admin';
  const password = await ask('Choose a password (8 characters or more): ', true);
  if (password.length < 8) throw new Error('The password must be at least 8 characters.');
  if ((await ask('Type it again: ', true)) !== password) throw new Error('The two passwords do not match.');
  const res = await fetch(authBase + '/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body.user) throw new Error('The login could not be created: ' + (body.message || res.status));
  return body.user.id;
}

(async () => {
  const [cmd, rawEmail] = process.argv.slice(2);
  const email = (rawEmail || '').trim().toLowerCase();
  if (!['grant', 'list', 'revoke'].includes(cmd) || (cmd !== 'list' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    console.log('Usage: node db/scripts/platform-admin.cjs grant|revoke <email>   or   list');
    process.exit(2);
  }
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  try {
    console.log(`Branch: ${env.NEON_BRANCH}`);
    if (cmd === 'list') {
      const rows = (await c.query(`select email, created_at::date::text as since, revoked_at is null as active
                                     from platform.admins order by created_at`)).rows;
      if (rows.length === 0) console.log('No platform admins yet.');
      for (const r of rows) console.log(`${r.active ? 'active ' : 'revoked'}  ${r.email}  (since ${r.since})`);
      return;
    }
    let user = (await c.query(`select id from neon_auth."user" where lower(email) = $1`, [email])).rows[0];
    if (cmd === 'revoke') {
      if (!user) throw new Error(`No login exists for ${email}.`);
      await c.query('BEGIN');
      await c.query(`update platform.admins set revoked_at = now() where auth_user_id = $1 and revoked_at is null`, [user.id]);
      await c.query(`update neon_auth."user" set role = 'user' where id = $1`, [user.id]);
      await c.query('COMMIT');
      console.log(`${email} is no longer a platform admin.`);
      return;
    }
    // grant
    if (!user) {
      const authBase = (env.NEON_AUTH_BASE_URL || '').replace(/\/$/, '');
      if (!authBase) throw new Error('NEON_AUTH_BASE_URL is not set in .env.local.');
      user = { id: await createLogin(authBase, email) };
    }
    const linked = (await c.query(`select t.name from employees e join tenants t on t.id = e.tenant_id
                                     where e.auth_user_id = $1 and e.deleted_at is null`, [user.id])).rows[0];
    if (linked) throw new Error(`${email} is a login of the restaurant "${linked.name}". Use a separate email for the platform admin.`);
    await c.query('BEGIN');
    await c.query(`update neon_auth."user" set role = 'admin' where id = $1`, [user.id]);
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, $2)
                   on conflict (auth_user_id) do update set revoked_at = null, email = excluded.email`, [user.id, email]);
    await c.query('COMMIT');
    console.log(`${email} is now a platform admin. Sign in on the web app; you will land on /admin.`);
    console.log('If you were already signed in, sign out and in again so the session picks up the new role.');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error('Not done: ' + e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
