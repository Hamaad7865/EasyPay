// make-platform-admin.cjs — makes a login a platform admin ("super admin") of
// production: the one who creates clients and their logins at /admin. Run by
// the owner, in a terminal, on purpose:
//
//   node db/make-platform-admin.cjs
//
// It asks for an e-mail and, if that login does not exist yet, for a password
// (typed twice, never shown, never in a command line or a file: it goes to the
// sign-in service over https and nowhere else). Then it asks once more before
// it changes anything.
//
// A platform admin is three things (0044_platform_admin.sql), and there is no
// screen that makes the first one, since only an admin can make a login:
//   a login in the sign-in service (Neon Auth);
//   the role 'admin' on that login, which the service's own admin calls need;
//   a live row in platform.admins.
// The second and third are written in one transaction, with a line in
// platform.audit. A login that belongs to a client is refused: an admin
// belongs to no restaurant (0045). A login that exists is promoted with its
// password left as it is, so running this twice is harmless.
//
// Like migrate-production.cjs it asks the Neon CLI (already signed in on this
// PC) for production's connection and checks it really is production's.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PROJECT = 'snowy-fire-89764432';
const BRANCH = 'production';
// the production compute's host begins with this; the dev branch's does not
const HOST = 'ep-soft-poetry';
const LIVE = 'https://easypaypos.com';

// ---- the rules: each returns what is wrong, or null ----

function wrongEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'that is not an e-mail address';
  return null;
}

function wrongPassword(password, again) {
  // a paste into a hidden prompt can arrive as one control character: say so, do not store it
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'it holds a character that is not a letter, digit or sign (a paste that went wrong?): type it';
  if (password !== password.trim()) return 'it begins or ends with a space';
  if (password.length < 10) return `it is ${password.length} characters: at least 10`;
  if (again !== undefined && password !== again) return 'the two are not the same';
  return null;
}

// ---- the database part: no BEGIN or COMMIT here, the caller holds the transaction ----

// What stands in the way of making this login an admin, or null. `user` is its row or undefined.
async function refusal(c, user) {
  if (!user) return 'unknown-login';
  if (user.banned) return 'login-switched-off';
  const linked = await c.query(
    `select t.name from employees e join tenants t on t.id = e.tenant_id where e.auth_user_id = $1 limit 1`, [user.id]);
  if (linked.rowCount) return `login-belongs-to-a-client:${linked.rows[0].name}`;
  return null;
}

const findLogin = async (c, email) =>
  (await c.query(`select id, email, role, banned from neon_auth."user" where lower(email) = lower($1)`, [email])).rows[0];

// 'made' | 'already'. Throws the refusal's code when the login may not be one.
async function promote(c, user) {
  const no = await refusal(c, user);
  if (no) throw new Error(no);
  const was = await c.query(`select revoked_at from platform.admins where auth_user_id = $1`, [user.id]);
  const already = was.rowCount === 1 && was.rows[0].revoked_at === null && user.role === 'admin';
  if (already) return 'already';
  await c.query(`update neon_auth."user" set role = 'admin' where id = $1`, [user.id]);
  await c.query(
    `insert into platform.admins (auth_user_id, email) values ($1, $2)
     on conflict (auth_user_id) do update set revoked_at = null, email = excluded.email`, [user.id, user.email]);
  await c.query(
    `insert into platform.audit (admin_auth_user_id, action, detail) values ($1, 'admin.make', $2)`,
    [user.id, JSON.stringify({ email: user.email, by: 'db/make-platform-admin.cjs' })]);
  return 'made';
}

const REFUSALS = {
  'unknown-login': 'There is no such login.',
  'login-switched-off': 'That login is switched off in the sign-in service.',
};
function inWords(code) {
  if (code.startsWith('login-belongs-to-a-client:')) {
    return `That login belongs to the client "${code.slice(code.indexOf(':') + 1)}". A platform admin belongs to no client: use another e-mail.`;
  }
  return REFUSALS[code] || code;
}

// ---- the sign-in service ----

// Makes the login. { id } or { why }. The origin is the back office's own
// address, which production's sign-in service has to trust anyway.
async function signUp(authBase, { email, password, name }) {
  const res = await fetch(`${authBase.replace(/\/$/, '')}/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LIVE },
    body: JSON.stringify({ email, password, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body.user && body.user.id) return { id: body.user.id };
  const said = `${res.status} ${body.code || ''} ${body.message || ''}`.trim();
  if (res.status === 403 && /origin/i.test(said)) {
    return { why: `the sign-in service does not trust ${LIVE} yet: add it as a trusted domain (Neon console, Auth, production branch). It said: ${said}` };
  }
  return { why: `the sign-in service said: ${said}` };
}

async function signsIn(authBase, { email, password }) {
  const res = await fetch(`${authBase.replace(/\/$/, '')}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LIVE },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 200) return null;
  const body = await res.json().catch(() => ({}));
  return `${res.status} ${body.code || ''} ${body.message || ''}`.trim();
}

// Asks on the terminal. With `hidden`, what is typed is not shown; its length is, afterwards,
// so that a paste that arrived as one character is seen for what it is.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    let quiet = false;
    rl._writeToOutput = (s) => { if (!quiet) write(s); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write(`(${answer.length} characters)\n`);
      resolve(hidden ? answer : answer.trim());
    });
    quiet = hidden; // the question is on screen; what is typed after it is not
  });
}

module.exports = { wrongEmail, wrongPassword, refusal, findLogin, promote, inWords, ask };
if (require.main !== module) return;

// ---- the run ----

const neon =(args) => execSync(`neon ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function productionAuthUrl() {
  const file = path.join(os.tmpdir(), `easypay-admin-${process.pid}.env`);
  try {
    neon(`env pull --project-id ${PROJECT} --branch ${BRANCH} --file "${file}" -e NEON_AUTH_BASE_URL`);
    const m = fs.readFileSync(file, 'utf8').match(/^NEON_AUTH_BASE_URL=(.*)$/m);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } finally {
    fs.rmSync(file, { force: true });
  }
}

(async () => {
  if (!process.stdin.isTTY) throw new Error('run this in a terminal: it asks for an e-mail and a password');
  const { Client } = require('pg');

  const url = neon(`connection-string ${BRANCH} --project-id ${PROJECT} --role-name neondb_owner`);
  if (!new URL(url).hostname.startsWith(HOST)) throw new Error(`this is not the production host (${new URL(url).hostname.split('.')[0]}): nothing was done`);
  const c = new Client({ connectionString: url, ssl: { require: true } });
  await c.connect();
  try {
    const now = await c.query(`select email from platform.admins where revoked_at is null order by created_at`);
    console.log(now.rowCount ? `Platform admins of production now: ${now.rows.map((r) => r.email).join(', ')}` : 'Production has no platform admin yet.');

    const email = await ask('\nE-mail of the login to make a platform admin: ');
    if (wrongEmail(email)) throw new Error(wrongEmail(email));
    let user = await findLogin(c, email);
    let authBase = '';
    let password = '';

    if (user) {
      const no = await refusal(c, user);
      if (no) throw new Error(inWords(no));
      console.log('That login exists. Its password is left as it is.');
    } else {
      authBase = productionAuthUrl();
      if (!/^https:\/\/[^/]+\.neonauth\./.test(authBase)) throw new Error('production has no sign-in service address: Neon Auth is not switched on for that branch');
      console.log('There is no such login yet: it will be made. Type a password for it (at least 10 characters). Nothing shows as you type.');
      password = await ask('Password: ', { hidden: true });
      const again = await ask('The same password again: ', { hidden: true });
      const wrong = wrongPassword(password, again);
      if (wrong) throw new Error(`that password will not do: ${wrong}. Nothing was done`);
    }

    const sure = await ask(`\nMake ${email} a platform admin of PRODUCTION? Type yes: `);
    if (sure.toLowerCase() !== 'yes') { console.log('Nothing was done.'); return; }

    if (!user) {
      const made = await signUp(authBase, { email, password, name: 'EasyPay admin' });
      if (made.why) throw new Error(`the login was not made: ${made.why}`);
      user = await findLogin(c, email);
      if (!user) throw new Error('the login was made but is not in the database yet: run this again in a minute, it will find it');
      console.log('The login is made.');
    }

    await c.query('BEGIN');
    let did;
    try {
      did = await promote(c, user);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(inWords(e.message));
    }
    console.log(did === 'already' ? `${user.email} is a platform admin already.` : `${user.email} is a platform admin.`);

    if (password) {
      const no = await signsIn(authBase, { email, password });
      console.log(no ? `Signing in with it was refused (${no}). The login and its rights are there; see what the sign-in service wants.` : 'Signing in with that password works.');
    }
    console.log(`\nSign in at ${LIVE}/login — it takes you to ${LIVE}/admin`);
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(`STOPPED: ${String(e.stderr || e.message).replace(/postgres(ql)?:\/\/\S+/g, '***').trim()}`);
  process.exit(1);
});
