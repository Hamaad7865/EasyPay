// till-release.test.cjs — which build of the till the API names to tablets:
// what a release published (till.json), what the deploy was told, and which
// of the two wins. Needs nothing but Node 24, which reads the .ts as it is:
//   node till-release.test.cjs
const assert = require('node:assert');
const { published, deployed, newest, releasesOf, stale } = require('./till-release.ts');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

const FILE = 'https://github.com/Hamaad7865/EasyPay/releases/latest/download/till.json';
const BASE = 'https://github.com/Hamaad7865/EasyPay/releases/download/';
const APK = BASE + 'v0.5.1/easypay-0.5.1.apk';
const file = (o) => JSON.stringify(o);

ok("the APKs of a release are under the same repository's releases", () => {
  assert.strictEqual(releasesOf(FILE), BASE);
  assert.strictEqual(releasesOf('https://github.com/Hamaad7865/EasyPay/releases/download/v0.5.1/till.json'), BASE);
  // somewhere that is not a GitHub release: the same site, and nothing wider
  assert.strictEqual(releasesOf('https://downloads.example/easypay/till.json'), 'https://downloads.example/');
  assert.strictEqual(releasesOf('not an address'), null);
  assert.strictEqual(releasesOf('http://github.com/Hamaad7865/EasyPay/releases/latest/download/till.json'), null);
  assert.strictEqual(releasesOf(''), null);
});

ok('what a release published is read as a build', () => {
  assert.deepStrictEqual(published(file({ version: 6, name: '0.5.1', url: APK }), BASE), { version: 6, name: '0.5.1', url: APK });
});
ok('a build with no name is called by its number', () => {
  assert.strictEqual(published(file({ version: 6, url: APK }), BASE).name, 'build 6');
  assert.strictEqual(published(file({ version: 6, name: '   ', url: APK }), BASE).name, 'build 6');
});
ok('a version that is not a whole number above zero is no build', () => {
  for (const version of [0, -1, 6.5, '6', null, undefined, NaN, 1e12]) {
    assert.strictEqual(published(file({ version, name: 'x', url: APK }), BASE), null, String(version));
  }
});
ok("an APK that is not one of this repository's releases is refused", () => {
  assert.strictEqual(published(file({ version: 6, name: 'x', url: 'https://github.com/someone-else/EasyPay/releases/download/v9/easypay.apk' }), BASE), null);
  assert.strictEqual(published(file({ version: 6, name: 'x', url: 'https://evil.example/easypay.apk' }), BASE), null);
  assert.strictEqual(published(file({ version: 6, name: 'x', url: APK.replace('https:', 'http:') }), BASE), null);
  assert.strictEqual(published(file({ version: 6, name: 'x', url: BASE + '../../../evil/easypay.apk' }), BASE), null);
  assert.strictEqual(published(file({ version: 6, name: 'x', url: APK + ' and more' }), BASE), null);
  assert.strictEqual(published(file({ version: 6, name: 'x' }), BASE), null);
});
ok('what is not the file is no build', () => {
  for (const text of ['', 'Not Found', '<html>', '[]', 'null', '6', file([{ version: 6, url: APK }]), 'x'.repeat(5000)]) {
    assert.strictEqual(published(text, BASE), null, text.slice(0, 20));
  }
  assert.strictEqual(published(file({ version: 6, name: 'x', url: APK }), null), null); // nowhere it may come from
});
ok('a name is kept short', () => {
  assert.strictEqual(published(file({ version: 6, name: 'n'.repeat(200), url: APK }), BASE).name.length, 40);
});

ok('what the deploy was told is read as before', () => {
  assert.deepStrictEqual(deployed({ LATEST_TILL_VERSION: '5', LATEST_TILL_NAME: '0.5.0', TILL_APK_URL: 'https://downloads.example/easypay-0.5.0.apk' }),
    { version: 5, name: '0.5.0', url: 'https://downloads.example/easypay-0.5.0.apk' });
  assert.strictEqual(deployed({ LATEST_TILL_VERSION: '5', TILL_APK_URL: ' https://downloads.example/a.apk ' }).name, 'build 5');
  assert.strictEqual(deployed({}), null);
  assert.strictEqual(deployed({ LATEST_TILL_VERSION: '0', LATEST_TILL_NAME: '', TILL_APK_URL: '' }), null);
  assert.strictEqual(deployed({ LATEST_TILL_VERSION: '5', TILL_APK_URL: 'http://downloads.example/a.apk' }), null);
  assert.strictEqual(deployed({ LATEST_TILL_VERSION: 'five', TILL_APK_URL: 'https://downloads.example/a.apk' }), null);
});

ok('the newer of the two is the one named, and the deploy wins a tie', () => {
  const five = { version: 5, name: '0.5.0', url: 'https://a.example/5.apk' };
  const six = { version: 6, name: '0.5.1', url: APK };
  assert.strictEqual(newest(five, six), six);
  assert.strictEqual(newest(six, five), six);
  assert.strictEqual(newest(five, null), five);
  assert.strictEqual(newest(null, six), six);
  assert.strictEqual(newest(null, null), null);
  // the same build named by both: what the deploy said stands (its address may be a mirror)
  const mirror = { version: 6, name: '0.5.1', url: 'https://mirror.example/6.apk' };
  assert.strictEqual(newest(mirror, six), mirror);
});

ok('the file is read again after ten minutes, and after one when the last read failed', () => {
  const t = 1_800_000_000_000;
  assert.strictEqual(stale(t, null), true); // never read
  assert.strictEqual(stale(t + 9 * 60_000, { at: t, ok: true }), false);
  assert.strictEqual(stale(t + 10 * 60_000, { at: t, ok: true }), true);
  assert.strictEqual(stale(t + 59_000, { at: t, ok: false }), false);
  assert.strictEqual(stale(t + 60_000, { at: t, ok: false }), true);
  assert.strictEqual(stale(t - 5_000, { at: t, ok: true }), true); // the clock went back
});

console.log(`\n${n} checks passed`);
