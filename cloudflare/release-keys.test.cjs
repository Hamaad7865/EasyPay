// release-keys.test.cjs — what release-keys.cjs reads and refuses before it
// sets anything: the key Neon's CLI printed, a Cloudflare token off the
// clipboard, and the account the CLI is signed in to. Needs nothing but Node:
//   node cloudflare/release-keys.test.cjs
const assert = require('node:assert');
const { keyFrom, wrongToken, accountsIn, tidy, missing } = require('./release-keys.cjs');

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

console.log(`\n${n} checks passed`);
