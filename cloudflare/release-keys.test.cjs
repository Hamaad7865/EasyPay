// release-keys.test.cjs — what release-keys.cjs reads and refuses before it
// sets anything: the key Neon's CLI printed, a Cloudflare token off the
// clipboard, and the account the CLI is signed in to; and what it will and
// will not put in a command line. Needs nothing but Node:
//   node cloudflare/release-keys.test.cjs
const assert = require('node:assert');
const { keyFrom, wrongToken, accountsIn, tidy, missing, commandLine, run } = require('./release-keys.cjs');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

const NEON = 'napi_' + 'k3y'.repeat(20);
const TOKEN = 'Abc-123_' + 'x'.repeat(32); // 40 characters, as Cloudflare hands out
const ACCOUNT = '0123456789abcdef0123456789abcdef';

ok("the key is read from what Neon's CLI printed", () => {
  assert.strictEqual(keyFrom(JSON.stringify({ id: 12, name: 'easypay-github-releases', key: NEON })), NEON);
  assert.strictEqual(keyFrom(JSON.stringify([{ id: 12, key: NEON }])), NEON);
  // the CLI may say things around it
  assert.strictEqual(keyFrom(`WARNING: Store this key now\n${JSON.stringify({ key: NEON }, null, 2)}\n`), NEON);
  assert.strictEqual(keyFrom(`${JSON.stringify({ key: NEON }, null, 2)}\nINFO: Limited to this project.\n`), NEON);
});
ok('what holds no key is not one', () => {
  for (const text of ['', 'ERROR: not signed in', '{}', '[]', JSON.stringify({ key: '' }), JSON.stringify({ key: 12 }), JSON.stringify({ key: 'two words' })]) {
    assert.strictEqual(keyFrom(text), null, text);
  }
});

ok('what was copied is tidied of the line end a copy brings', () => {
  assert.strictEqual(tidy(`  ${TOKEN}\r\n`), TOKEN);
  assert.strictEqual(tidy(null), '');
});
ok('a Cloudflare token is accepted', () => assert.strictEqual(wrongToken(TOKEN), null));
ok('an empty clipboard is said to be that', () => assert.match(wrongToken(''), /nothing was copied/i));
ok('the account ID copied in its place is named', () => assert.match(wrongToken(ACCOUNT), /account ID/));
ok("Neon's key copied in its place is named", () => assert.match(wrongToken(NEON), /Neon/));
ok('a sentence, a web address or a control character is not a token', () => {
  assert.match(wrongToken('Edit Cloudflare Workers'), /not a token/);
  assert.match(wrongToken('https://dash.cloudflare.com/profile/api-tokens'), /not a token/);
  assert.match(wrongToken('\u0016'), /not a token/); // what Ctrl+V leaves in a hidden prompt
  assert.match(wrongToken('short'), /not a token/);
  assert.match(wrongToken('x'.repeat(400)), /not a token/);
});

ok('the account is read from what wrangler says about who is signed in', () => {
  const whoami = [
    'Getting User settings...',
    "You are logged in with an OAuth Token, associated with the email someone@example.com.",
    '┌──────────────────────┬──────────────────────────────────┐',
    '│ Account Name         │ Account ID                       │',
    '├──────────────────────┼──────────────────────────────────┤',
    `│ Someone's Account    │ ${ACCOUNT} │`,
    '└──────────────────────┴──────────────────────────────────┘',
  ].join('\n');
  assert.deepStrictEqual(accountsIn(whoami), [ACCOUNT]);
  const two = whoami.replace('└', `│ Another             │ ${'f'.repeat(32)} │\n└`);
  assert.deepStrictEqual(accountsIn(two), [ACCOUNT, 'f'.repeat(32)]);
  assert.deepStrictEqual(accountsIn('You are not authenticated. Please run `wrangler login`.'), []);
  // the same account listed twice is one account
  assert.deepStrictEqual(accountsIn(`${ACCOUNT} ${ACCOUNT}`), [ACCOUNT]);
});

ok('which of the three are still to be set', () => {
  const list = (names) => names.map((x) => `${x}\t2026-10-09T00:00:00Z`).join('\n');
  assert.deepStrictEqual(missing(list(['ANDROID_KEY_ALIAS'])), ['NEON_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  assert.deepStrictEqual(missing(list(['NEON_API_KEY', 'CLOUDFLARE_API_TOKEN'])), ['CLOUDFLARE_ACCOUNT_ID']);
  assert.deepStrictEqual(missing(list(['NEON_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])), []);
  // a name that only begins the same is another secret
  assert.deepStrictEqual(missing(list(['NEON_API_KEY_OLD', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])), ['NEON_API_KEY']);
});

// A program that says what it was given: Node itself, started the way the script starts gh,
// neon and wrangler (one line, through this machine's own shell: cmd.exe on the owner's PC,
// sh in CI), reading these words on standard input the way gh reads a key.
const SAYS_WHAT_IT_GOT = 'console.log(JSON.stringify(process.argv.slice(2)))';
const NODE = `"${process.execPath}"`; // a path in quotes, as the script's own wrangler is
const given = (args) => {
  const r = run(NODE, ['-', ...args], SAYS_WHAT_IT_GOT);
  assert.ok(r.ok, r.said);
  return JSON.parse(r.out);
};

ok('every argument the script passes reaches the program as it was written', () => {
  const words = ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', 'Hamaad7865/EasyPay', 'api-keys', '--name', 'easypay-github-releases',
    '--project-id', 'snowy-fire-89764432', '-y', 'wrangler@4.117.0', '-NoProfile', '-Command', 'Get-Clipboard -Raw', "Set-Clipboard -Value ' '"];
  assert.deepStrictEqual(given(words), words);
  // and one made of everything an argument may hold
  assert.deepStrictEqual(given(["Az09 '_./@-"]), ["Az09 '_./@-"]);
  assert.strictEqual(commandLine('gh', ['secret', 'list', '--repo', 'Hamaad7865/EasyPay']), 'gh secret list --repo Hamaad7865/EasyPay');
  assert.strictEqual(commandLine('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']), 'powershell -NoProfile -Command "Get-Clipboard -Raw"');
});
ok('a value with a backslash and a quote is refused, and no shell is given it', () => {
  // Each of these came apart under the quoting this replaced (a " made \"), seen on Windows: the
  // first arrived as a\b, the second had cmd.exe run the echo, the third arrived with a " on its end.
  for (const value of ['a\\"b', 'x" & echo ran & "y', 'ends in a backslash\\']) {
    assert.throws(() => commandLine('gh', ['secret', 'set', value]), /was not run/, value);
    assert.throws(() => run(NODE, ['-', value], SAYS_WHAT_IT_GOT), /was not run/, value);
  }
});
ok('so is anything else a shell would read as its own, and an argument that is empty', () => {
  for (const mark of ['"', '\\', '&', '|', '<', '>', '^', '%', '$', '`', ';', '!', '(', ')', '*', '?', '~', '#', '{', '=', ':', ',', '\n', '\r', '\t']) {
    assert.throws(() => commandLine('gh', ['secret', `a${mark}b`]), /was not run/, JSON.stringify(mark));
  }
  // an empty argument would be missing from the line, and every later one would move up a place
  assert.throws(() => commandLine('gh', ['secret', '']), /was not run/);
});
ok('what a refusal says holds nothing of the value, which could be a key', () => {
  let said = '';
  try { commandLine('gh', ['secret', 'set', `${NEON}"`]); } catch (e) { said = e.message; }
  assert.match(said, /gh was not run/);
  assert.ok(!said.includes(NEON) && !said.includes('k3y'), said);
});

console.log(`\n${n} checks passed`);
