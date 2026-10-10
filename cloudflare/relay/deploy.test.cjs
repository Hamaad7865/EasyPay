// deploy.test.cjs — how deploy.cjs reads what the till service and the live
// relay answer. Needs nothing but Node:
//   node cloudflare/relay/deploy.test.cjs
const assert = require('node:assert');
const { passAnswer, tillAnswer } = require('./deploy.cjs');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

ok('a till service that has /guest/pass turns away whoever has no credential', () => {
  const a = passAnswer({ status: 401, said: '{"error":"Unauthorized"}' });
  assert.strictEqual(a.there, true);
  assert.ok(!a.wrong);
});
ok('one that has not had the release yet is not a reason to stop', () => {
  const a = passAnswer({ status: 404, said: '' });
  assert.strictEqual(a.there, false);
  assert.ok(!a.wrong);
  assert.match(a.words, /release/);
});
ok('one that does not answer, or answers something else, is', () => {
  assert.ok(passAnswer({ status: 0, said: 'ENOTFOUND' }).wrong);
  assert.ok(passAnswer({ status: 500, said: '' }).wrong);
  assert.ok(passAnswer({ status: 200, said: '{}' }).wrong);
});

ok('the live relay turning a made-up till away is the whole chain working', () => {
  assert.strictEqual(tillAnswer({ status: 401, said: '{"error":"this till is not known, or has been switched off"}' }).ok, true);
});
ok('a relay deployed with no address says so, and is told apart from a service not ready', () => {
  const none = tillAnswer({ status: 503, said: '{"error":"the relay has not been told where EasyPay\'s till service is"}' });
  assert.strictEqual(none.ok, false);
  assert.match(none.words, /WITHOUT/);
  const notYet = tillAnswer({ status: 503, said: '{"error":"EasyPay\'s till service did not answer"}' });
  assert.strictEqual(notYet.ok, false);
  assert.doesNotMatch(notYet.words, /WITHOUT/);
});
ok('a made-up till that is let in is not called working', () => {
  assert.strictEqual(tillAnswer({ status: 101, said: '' }).ok, false);
  assert.strictEqual(tillAnswer({ status: 0, said: 'ECONNREFUSED' }).ok, false);
});

console.log(`\n${n} checks passed`);
