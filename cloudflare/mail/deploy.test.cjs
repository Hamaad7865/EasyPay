// node --test cloudflare/mail/deploy.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendingAnswer, healthAnswer } = require('./deploy.cjs');

// as wrangler 4.117 prints `email sending list`
const table = (rows) => [
  '┌──────┬──────┬─────────┬─────┐',
  '│ zone │ name │ enabled │ tag │',
  ...rows.map(([zone, name, on]) => `│ ${zone} │ ${name} │ ${on} │ 16f3af285b9041b896d104a0ec2fe1cb │`),
  '└──────┴──────┴─────────┴─────┘',
].join('\n');

test('easypaypos.com is found in the list, and only when it is enabled is it ready', () => {
  assert.equal(sendingAnswer(table([['easyhome.mu', 'easyhome.mu', 'yes']])).ok, false);
  assert.match(sendingAnswer(table([['easyhome.mu', 'easyhome.mu', 'yes']])).words, /email sending enable easypaypos\.com/);
  assert.equal(sendingAnswer(table([['easypaypos.com', 'easypaypos.com', 'yes']])).ok, true);
  assert.equal(sendingAnswer(table([['easypaypos.com', 'easypaypos.com', 'no']])).ok, false);
  // a subdomain of it is not the domain the mail is from
  assert.equal(sendingAnswer(table([['easypaypos.com', 'mail.easypaypos.com', 'yes']])).ok, false);
});

test('the live address is up when it says ok', () => {
  assert.equal(healthAnswer({ status: 200, said: '{"ok":true}' }).ok, true);
  assert.equal(healthAnswer({ status: 404, said: '' }).ok, false);
  assert.match(healthAnswer({ status: 0, said: 'ENOTFOUND' }).words, /did not answer \(ENOTFOUND\)/);
});
