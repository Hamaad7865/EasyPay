// production-settings.cjs — gives the live back office and the till's release
// the addresses of production, read from Neon and checked first. Run by a
// person, on purpose:
//
//   node cloudflare/production-settings.cjs            reads and checks them, changes nothing
//   node cloudflare/production-settings.cjs --apply    sets them, then asks the live sign-in whether it answers
//
// It asks the Neon CLI (already signed in on this PC) for three things of the
// production branch: the database's pooled address, the sign-in service's
// address and the till API's address. With --apply:
//
//   the Worker easypay-backoffice gets DATABASE_URL and NEON_AUTH_BASE_URL
//   (its third setting, NEON_AUTH_COOKIE_SECRET, is left as it is);
//   the repository gets the variables TILL_FUNCTION_URL and TILL_AUTH_URL,
//   which "release the till" builds the APK with.
//
// Nothing is typed or pasted, which is the point: a value pasted into a
// terminal's hidden prompt can arrive as something else, and the back office
// then answers every sign-in with "Internal Server Error". The database's
// address holds a password: it is never printed and never written to a file,
// it goes from Neon to Cloudflare through this process only. The two other
// addresses are public (every till carries them) and are printed.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'snowy-fire-89764432';
// EASYPAY_SETTINGS_BRANCH is for trying the reading on another branch: what it
// reads is then refused by the check below, so nothing can be set from it
const BRANCH = process.env.EASYPAY_SETTINGS_BRANCH || 'production';
// the production compute's host begins with this; the dev branch's does not
const HOST = 'ep-soft-poetry';
const WORKER = 'easypay-backoffice';
const REPO = 'Hamaad7865/EasyPay';
const LIVE = 'https://easypaypos.pages.dev';
const WRANGLER = 'wrangler@4.117.0'; // the version web/ builds and deploys with

// ---- the checks: each returns what is wrong with a value, or null ----

const parsed = (value) => { try { return new URL(value); } catch { return null; } };

function wrongDatabase(value) {
  const u = parsed(value);
  if (!u || !/^postgres(ql)?:$/.test(u.protocol)) return 'it is not a database address';
  if (!u.hostname.startsWith(HOST)) return `it is not the production host (${u.hostname.split('.')[0]})`;
  if (!u.hostname.split('.')[0].endsWith('-pooler')) return 'it is not the pooled address: a Worker opens a connection for every question, which is what the pooler is for';
  if (u.username !== 'neondb_owner') return `it is for the role ${u.username}, and the back office signs in as neondb_owner`;
  if (!u.password) return 'it carries no password';
  return null;
}

// `dev` is the same setting of the dev branch, when this PC has it: production's must not be it
function wrongAuth(value, dev) {
  const u = parsed(value);
  if (!u || u.protocol !== 'https:') return 'it is not an https address';
  if (!u.hostname.includes('.neonauth.')) return `it is not a Neon Auth host (${u.hostname})`;
  if (!u.pathname.replace(/\/$/, '').endsWith('/auth')) return `it does not end in /auth (${u.pathname})`;
  if (dev && value.replace(/\/$/, '') === dev.replace(/\/$/, '')) return "it is the dev branch's";
  return null;
}

function wrongFunction(value, dev) {
  const u = parsed(value);
  if (!u || u.protocol !== 'https:') return 'it is not an https address';
  if (!u.hostname.endsWith('.neon.tech')) return `it is not a Neon host (${u.hostname})`;
  if (dev && value.replace(/\/$/, '') === dev.replace(/\/$/, '')) return "it is the dev branch's";
  return null;
}

// one NAME=value line of an env file, without the quotes some writers put around the value
function setting(text, name) {
  const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

// hands `value` to a command on its standard input, so that it is in no command line and no file
function hand(command, value) {
  const r = spawnSync(command, { shell: true, input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return { ok: r.status === 0, said: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

module.exports = { wrongDatabase, wrongAuth, wrongFunction, setting, hand };
if (require.main !== module) return;

// ---- the run ----

const here = (...p) => path.join(__dirname, '..', ...p);
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const lastLine = (text) => text.split(/\r?\n/).filter((l) => l.trim()).pop() || '';

(async () => {
  const apply = process.argv.includes('--apply');

  // production's three addresses, from Neon
  const database = execSync(`neon connection-string ${BRANCH} --project-id ${PROJECT} --role-name neondb_owner --pooled`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const pulled = path.join(os.tmpdir(), `easypay-production-${process.pid}.env`);
  let env = '';
  try {
    // only these two, both public; into a file of its own, never the project's .env.local
    execSync(`neon env pull --project-id ${PROJECT} --branch ${BRANCH} --file "${pulled}" -e NEON_AUTH_BASE_URL,NEON_FUNCTION_API_BASE_URL`, { stdio: ['ignore', 'pipe', 'pipe'] });
    env = read(pulled);
  } finally {
    fs.rmSync(pulled, { force: true });
  }
  const auth = setting(env, 'NEON_AUTH_BASE_URL');
  const api = setting(env, 'NEON_FUNCTION_API_BASE_URL');

  // what this PC has of the dev branch, to tell the two apart
  const devAuth = setting(read(here('web', '.env.local')), 'NEON_AUTH_BASE_URL');
  const devApi = setting(read(here('android', 'local.properties')), 'functionUrl');

  const found = [
    { what: "the database's pooled address", shown: database ? `(host ${HOST}…, not shown)` : '', wrong: database ? wrongDatabase(database) : 'Neon gave none' },
    { what: "the sign-in service's address", shown: auth, wrong: auth ? wrongAuth(auth, devAuth) : 'production has none: Neon Auth is not switched on for that branch' },
    { what: "the till API's address", shown: api, wrong: api ? wrongFunction(api, devApi) : 'production has none: the till API is not deployed there yet (neon deploy --branch production --env-pull=false)' },
  ];
  console.log(`${BRANCH} (${PROJECT}), as Neon gives it:`);
  for (const f of found) console.log(`  ${f.wrong ? 'NOT RIGHT' : 'ok       '}  ${f.what}  ${f.wrong ? '— ' + f.wrong : f.shown}`);
  const [db, signIn, tillApi] = found;
  if (db.wrong || signIn.wrong) {
    console.log('\nNothing was changed: the back office needs both of the first two.');
    process.exit(1);
  }
  if (!apply) {
    console.log('\nNothing was changed. To set them: node cloudflare/production-settings.cjs --apply');
    return;
  }

  // the Worker's two settings; each is a new version of the Worker, live at once
  let failed = false;
  for (const [name, value] of [['DATABASE_URL', database], ['NEON_AUTH_BASE_URL', auth]]) {
    const r = hand(`npx --yes ${WRANGLER} secret put ${name} --name ${WORKER}`, value);
    console.log(`  ${r.ok ? 'set      ' : 'NOT SET  '}  ${WORKER}: ${name}${r.ok ? '' : '  — ' + lastLine(r.said)}`);
    failed = failed || !r.ok;
  }

  // the two addresses the till's release is built with
  const variables = [['TILL_AUTH_URL', auth]].concat(tillApi.wrong ? [] : [['TILL_FUNCTION_URL', api]]);
  for (const [name, value] of variables) {
    const r = spawnSync('gh', ['variable', 'set', name, '--repo', REPO, '--body', value], { encoding: 'utf8' });
    const ok = r.status === 0;
    console.log(`  ${ok ? 'set      ' : 'NOT SET  '}  ${REPO}: variable ${name}${ok ? '' : '  — ' + lastLine(`${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`)}`);
    failed = failed || !ok;
  }
  if (tillApi.wrong) console.log(`  skipped    ${REPO}: variable TILL_FUNCTION_URL (see above)`);

  // does the live sign-in answer now? The new version takes a few seconds to be the one that answers.
  let answer = '';
  for (let tries = 0; tries < 8; tries++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${LIVE}/api/auth/ok`, { cache: 'no-store' });
      answer = `${res.status} ${(await res.text()).slice(0, 80)}`;
      if (res.status === 200) break;
    } catch (e) {
      answer = e.message;
    }
  }
  const up = answer.startsWith('200');
  console.log(`\n${LIVE}/api/auth/ok answers: ${answer}`);
  console.log(up ? `The sign-in service answers. Sign in at ${LIVE}/login` : 'The sign-in service does not answer yet: see the lines above.');
  if (failed || !up) process.exit(1);
})().catch((e) => {
  // never the command line: it could carry the address
  console.error(`Stopped: ${String(e.stderr || e.message || e).split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ').replace(/postgres(ql)?:\/\/\S+/g, '(address not shown)')}`);
  process.exit(1);
});
