// production-settings.test.cjs — the checks production-settings.cjs makes before it
// sets anything, and the way it hands a value over. Needs nothing but Node:
//   node cloudflare/production-settings.test.cjs
const assert = require('node:assert');
const { wrongDatabase, wrongAuth, wrongFunction, setting, hand } = require('./production-settings.cjs');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

const DB = 'postgresql://neondb_owner:pw@ep-soft-poetry-abc123-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const AUTH = 'https://ep-soft-poetry-abc123.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const API = 'https://br-some-thing-abc123-api.compute.c-4.ap-southeast-1.aws.neon.tech';

ok("production's pooled address is accepted", () => assert.strictEqual(wrongDatabase(DB), null));
ok("the dev branch's database is refused", () => assert.match(wrongDatabase(DB.replace('ep-soft-poetry', 'ep-falling-surf')), /not the production host \(ep-falling-surf/));
ok('the unpooled address is refused', () => assert.match(wrongDatabase(DB.replace('-pooler', '')), /not the pooled address/));
ok('another role is refused', () => assert.match(wrongDatabase(DB.replace('neondb_owner', 'app_user')), /role app_user/));
ok('an address with no password is refused', () => assert.match(wrongDatabase(DB.replace(':pw@', '@')), /no password/));
ok('what is not an address is refused', () => {
  assert.match(wrongDatabase('\u0016'), /not a database address/); // what Ctrl+V leaves in a hidden prompt
  assert.match(wrongDatabase(AUTH), /not a database address/);
});

ok("the sign-in service's address is accepted, with or without a closing slash", () => {
  assert.strictEqual(wrongAuth(AUTH, ''), null);
  assert.strictEqual(wrongAuth(AUTH + '/', ''), null);
});
ok('a whole NAME=value line is refused', () => assert.match(wrongAuth('NEON_AUTH_BASE_URL=' + AUTH, ''), /not an https address/));
ok('a quoted address is refused', () => assert.match(wrongAuth(`"${AUTH}"`, ''), /not an https address/));
ok('a control character is refused', () => assert.match(wrongAuth('\u0016', ''), /not an https address/));
ok('an address that is not Neon Auth is refused', () => assert.match(wrongAuth('https://easypaypos.pages.dev/api/auth', ''), /not a Neon Auth host/));
ok('an address that does not end in /auth is refused', () => assert.match(wrongAuth(AUTH.replace('/neondb/auth', ''), ''), /does not end in \/auth/));
ok("the dev branch's sign-in address is refused", () => assert.match(wrongAuth(AUTH, AUTH + '/'), /the dev branch's/));

ok("the till API's address is accepted", () => assert.strictEqual(wrongFunction(API, ''), null));
ok("the dev branch's till API is refused", () => assert.match(wrongFunction(API, API), /the dev branch's/));
ok('a till API address elsewhere is refused', () => assert.match(wrongFunction('https://example.com', ''), /not a Neon host/));

ok('a setting is read from an env file, quoted or not, and a missing one is empty', () => {
  const text = `NEON_BRANCH=production\r\nNEON_AUTH_BASE_URL="${AUTH}"\r\nNEON_FUNCTION_API_BASE_URL=${API}\r\n`;
  assert.strictEqual(setting(text, 'NEON_AUTH_BASE_URL'), AUTH);
  assert.strictEqual(setting(text, 'NEON_FUNCTION_API_BASE_URL'), API);
  assert.strictEqual(setting(text, 'DATABASE_URL'), '');
});

ok('a value handed to a command arrives whole, on its standard input and in no command line', () => {
  // the command says how long what it read is, and whether it matches the address's own ending
  const reader = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.length, s.endsWith('channel_binding=require'), process.argv.length))"`;
  const r = hand(reader, DB);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.said, `${DB.length} true 1`);
});
ok('a command that fails is reported as failed, with what it said', () => {
  const r = hand(`node -e "console.error('no such Worker');process.exit(3)"`, 'x');
  assert.strictEqual(r.ok, false);
  assert.match(r.said, /no such Worker/);
});

console.log(`\n${n} checks passed`);
