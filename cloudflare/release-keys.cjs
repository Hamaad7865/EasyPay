// release-keys.cjs — gives GitHub the three keys a release needs to put
// production up to date by itself (.github/workflows/deploy.yml). Run once,
// by a person, on purpose:
//
//   node cloudflare/release-keys.cjs            says which are set and what --apply would do; changes nothing
//   node cloudflare/release-keys.cjs --apply    makes and sets the ones that are missing
//   node cloudflare/release-keys.cjs --apply --renew    replaces the ones that are there too
//
// The three, kept as secrets of the GitHub repository (written there, never
// read back by anyone):
//
//   NEON_API_KEY            for the migrations and the till API. Made here by
//                           the Neon CLI (already signed in on this PC), able
//                           to reach this one project and nothing else.
//   CLOUDFLARE_ACCOUNT_ID   which Cloudflare account: read from wrangler, which
//                           is signed in on this PC. Not a secret in itself.
//   CLOUDFLARE_API_TOKEN    for the back office and the site. Cloudflare makes
//                           these in its dashboard only, so this one is yours
//                           to make: the script opens the page, says what to
//                           pick, and takes the token from the clipboard when
//                           you press Enter.
//
// Nothing is typed or pasted into a prompt: a value pasted into a terminal's
// hidden prompt can arrive as something else. No key is printed or written to
// a file; each goes from where it was made to GitHub through this process
// only, and each is tried against its service before it is set. The clipboard
// is emptied afterwards.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROJECT = 'snowy-fire-89764432';
const REPO = 'Hamaad7865/EasyPay';
const WORKER = 'easypay-backoffice';
const PAGES = 'easypaypos';
const KEY_NAME = 'easypay-github-releases';
const WRANGLER = 'wrangler@4.117.0'; // the version web/ builds and deploys with
const NAMES = ['NEON_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
const TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

// ---- what is read, and what is refused ----

// what a copy brings with it: spaces and a line end around the value
const tidy = (value) => String(value ?? '').trim();

// the key in what `neon api-keys create --output json` printed, or null
function keyFrom(text) {
  // from the first bracket to the last: the CLI may say things before and after
  const from = text.search(/[[{]/);
  const to = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (from < 0 || to < from) return null;
  let o;
  try { o = JSON.parse(text.slice(from, to + 1)); } catch { return null; }
  const key = (Array.isArray(o) ? o[0] : o)?.key;
  return typeof key === 'string' && /^\S+$/.test(key) ? key : null;
}

// what is wrong with a Cloudflare token taken from the clipboard, or null
function wrongToken(value) {
  const v = tidy(value);
  if (!v) return 'Nothing was copied: the clipboard is empty.';
  if (/^[0-9a-f]{32}$/i.test(v)) return 'That is the account ID, not a token. Copy the token itself: Cloudflare shows it once, after Create Token.';
  if (/^napi_/.test(v)) return "That is Neon's key, not a Cloudflare token.";
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(v)) return 'What is on the clipboard is not a token: a token is one run of letters, digits, _ and -, with no spaces.';
  return null;
}

// the Cloudflare accounts named in what `wrangler whoami` printed
function accountsIn(text) {
  return [...new Set(String(text).match(/\b[0-9a-f]{32}\b/g) || [])];
}

// which of the three `gh secret list` does not show
function missing(listed) {
  const have = new Set(String(listed).split(/\r?\n/).map((l) => l.split(/\s+/)[0]));
  return NAMES.filter((x) => !have.has(x));
}

// ---- how a program is started ----

// One command line, through the shell (neon and wrangler are .cmd files on Windows, which only
// a shell starts). Nothing secret is ever in it: a key goes in on standard input, and the words
// here are this file's own.
// Nothing in it is escaped either, because no escaping holds in both shells it meets. cmd.exe
// takes every " as the start or the end of a quoted run, whatever stands before it: after a \"
// it reads & | < > as its own, and a \ before the closing quote takes that quote with it. sh
// reads $ and ` inside quotes. So an argument is made only of what both leave alone (letters,
// digits, - _ . / @, and a space or a ' once it is inside double quotes), and one that holds
// anything else stops the run before a shell sees it. A value that cannot be written that way
// goes in on standard input, as a key does. The command is not looked at: it is a name written
// here, or this checkout's own wrangler, already in quotes.
function commandLine(command, args) {
  args.forEach((a, i) => {
    // said by its place, not by what it holds: what is refused is not printed either
    if (!/^[A-Za-z0-9 '_./@-]+$/.test(a)) throw new Error(`${command} was not run: its argument ${i + 1} is empty, or holds a character a shell could read as its own (a quote, a backslash, & | < > $ % and the like).`);
  });
  return [command, ...args.map((a) => (/[ ']/.test(a) ? `"${a}"` : a))].join(' ');
}
function run(command, args, input) {
  const r = spawnSync(commandLine(command, args), { encoding: 'utf8', input, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout || '', said: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

module.exports = { keyFrom, wrongToken, accountsIn, tidy, missing, commandLine, run };
if (require.main !== module) return;

// ---- the run ----

const here = (...p) => path.join(__dirname, '..', ...p);
const stop = (why) => { console.error(`\nSTOPPED: ${why}`); process.exit(1); };
// the secret goes in on standard input: it is in no command line and no file
const set = (name, value) => {
  const r = run('gh', ['secret', 'set', name, '--repo', REPO], value);
  if (!r.ok) stop(`GitHub did not take ${name}: ${r.said.split(/\r?\n/).pop()}`);
  console.log(`   ${name} is set on ${REPO}.`);
};
const enter = (says) => new Promise((done) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(says, () => { rl.close(); done(); });
});
const cloudflare = async (token, address) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${address}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success === true, result: body.result, said: (body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}` };
};

(async () => {
  const apply = process.argv.includes('--apply');
  const renew = process.argv.includes('--renew');

  const listed = run('gh', ['secret', 'list', '--repo', REPO]);
  if (!listed.ok) stop(`GitHub could not be asked which secrets ${REPO} has (is gh signed in? gh auth status): ${listed.said.split(/\r?\n/).pop()}`);
  const lacking = missing(listed.out);
  const todo = renew ? NAMES : lacking;
  console.log(`${REPO} has ${NAMES.length - lacking.length} of the ${NAMES.length} keys a release needs.`);
  for (const name of NAMES) console.log(`   ${lacking.includes(name) ? 'missing' : 'set    '}  ${name}`);
  if (!todo.length) { console.log('\nNothing to do: a release can put production up to date by itself.'); return; }

  if (!apply) {
    console.log('\nWith --apply this would:');
    if (todo.includes('NEON_API_KEY')) console.log(`   make a Neon API key named "${KEY_NAME}" that reaches this project only, try it, and set NEON_API_KEY;`);
    if (todo.includes('CLOUDFLARE_ACCOUNT_ID')) console.log('   read the Cloudflare account from wrangler and set CLOUDFLARE_ACCOUNT_ID;');
    if (todo.includes('CLOUDFLARE_API_TOKEN')) console.log('   open Cloudflare\'s API Tokens page for you to make a token, take it from the clipboard, try it, and set CLOUDFLARE_API_TOKEN.');
    console.log('\nNothing was changed. Run again with --apply.');
    return;
  }

  // 1. Neon: the CLI makes the key
  if (todo.includes('NEON_API_KEY')) {
    console.log('\n1. Neon');
    const made = run('neon', ['api-keys', 'create', '--name', KEY_NAME, '--project-id', PROJECT, '--output', 'json']);
    const key = made.ok ? keyFrom(made.out) : null;
    // what the CLI said, without anything that could be the key
    if (!key) stop(`Neon made no key (is the CLI signed in? neon me): ${made.said.replace(/napi_\S+/g, 'napi_…').split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ')}`);
    const res = await fetch(`https://console.neon.tech/api/v2/projects/${PROJECT}/branches`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const branches = res.ok ? (await res.json()).branches || [] : [];
    if (!branches.some((b) => b.name === 'production')) stop(`The new key does not see this project's production branch (HTTP ${res.status}). It was not set. Remove it: neon api-keys list --org-id … , then neon api-keys revoke <id>.`);
    console.log(`   A key named "${KEY_NAME}" was made. It reaches this project only, and sees its production branch.`);
    set('NEON_API_KEY', key);
  }

  // 2. Cloudflare: which account
  let account = '';
  if (todo.includes('CLOUDFLARE_ACCOUNT_ID') || todo.includes('CLOUDFLARE_API_TOKEN')) {
    console.log('\n2. Cloudflare');
    const local = here('.claude', 'cf', 'web', 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
    const who = fs.existsSync(local) ? run(`"${local}"`, ['whoami']) : run('npx', ['-y', WRANGLER, 'whoami']);
    const accounts = accountsIn(who.said);
    const asked = (process.argv.find((a) => a.startsWith('--account=')) || '').slice(10);
    if (asked && !accounts.includes(asked)) stop(`wrangler is not signed in to the account ${asked}.`);
    if (!asked && accounts.length !== 1) {
      stop(accounts.length ? `wrangler is signed in to ${accounts.length} accounts. Say which holds EasyPay: add --account=<its ID> (npx ${WRANGLER} whoami lists them).` : `wrangler is not signed in on this PC: npx ${WRANGLER} login, then run this again.`);
    }
    account = asked || accounts[0];
    console.log(`   The account is ${account.slice(0, 6)}…${account.slice(-4)}.`);
    if (todo.includes('CLOUDFLARE_ACCOUNT_ID')) set('CLOUDFLARE_ACCOUNT_ID', account);
  }

  // 3. Cloudflare: the token, which only its dashboard makes
  if (todo.includes('CLOUDFLARE_API_TOKEN')) {
    if (process.platform !== 'win32') stop(`The token is taken from the clipboard, which this script reads on Windows only. Make it at ${TOKEN_PAGE} ("Edit Cloudflare Workers"), then: gh secret set CLOUDFLARE_API_TOKEN --repo ${REPO}`);
    console.log(`
3. The Cloudflare token. A page is opening in your browser (${TOKEN_PAGE}). On it:
     a. Create Token
     b. beside "Edit Cloudflare Workers", Use template
     c. under Account Resources pick your account; under Zone Resources pick All zones
     d. Continue to summary, then Create Token
     e. press Copy beside the token (it is shown this once)
   Then come back to this window.`);
    spawnSync('cmd', ['/c', 'start', '', TOKEN_PAGE], { stdio: 'ignore' });
    const clipboard = () => tidy(run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']).out);
    let token = '';
    for (let tries = 1; ; tries++) {
      await enter('\n   Press Enter when the token is copied. ');
      token = clipboard();
      const wrong = wrongToken(token);
      if (!wrong) break;
      console.log(`   ${wrong}`);
      if (tries >= 5) stop('No token was taken. Nothing more was set; run this again when you have it.');
    }
    // tried before it is set: that it is live, and that it sees the two things a release deploys
    const live = await cloudflare(token, '/user/tokens/verify');
    const alive = live.ok ? live : await cloudflare(token, `/accounts/${account}/tokens/verify`);
    if (!alive.ok || alive.result?.status !== 'active') stop(`Cloudflare does not know that token (${alive.said}). It was not set. Copy it again from the page, or make another.`);
    const scripts = await cloudflare(token, `/accounts/${account}/workers/scripts`);
    if (!scripts.ok || !(scripts.result || []).some((s) => s.id === WORKER)) stop(`The token does not see the back office's Worker (${WORKER}): ${scripts.ok ? 'it is not in that account' : scripts.said}. It was not set. Make it from the "Edit Cloudflare Workers" template, with your account picked.`);
    const pages = await cloudflare(token, `/accounts/${account}/pages/projects/${PAGES}`);
    if (!pages.ok) stop(`The token does not see the site's Pages project (${PAGES}): ${pages.said}. It was not set. Make it from the "Edit Cloudflare Workers" template, which includes Cloudflare Pages.`);
    console.log(`   The token is live and sees ${WORKER} and ${PAGES}.`);
    set('CLOUDFLARE_API_TOKEN', token);
    run('powershell', ['-NoProfile', '-Command', "Set-Clipboard -Value ' '"]);
    console.log('   The clipboard was emptied.');
  }

  const after = missing(run('gh', ['secret', 'list', '--repo', REPO]).out);
  if (after.length) stop(`Still missing on GitHub: ${after.join(', ')}.`);
  console.log(`\nDone: ${REPO} has all three. From now on a release puts production up to date by itself:
   a till version ("v…" tag) or a "live-…" tag runs the database, the till API, the back office and the site, in that order.`);
})().catch((e) => stop(e.message));
