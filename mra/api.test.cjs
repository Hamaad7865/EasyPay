// The two calls to the MRA e-invoicing system, as requests and answers, with
// no network: sign-in (token generation) and invoice transmission.
//   node --test mra/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('./api.cjs');
const { aesEncrypt, aesDecrypt } = require('./crypto.cjs');

const who = { username: 'dev@example.mu', password: 'not-a-real-one', ebsMraId: 'EBS123', areaCode: '100' };

// openssl decrypts what Node sealed with PKCS#1 v1.5 (Node will not)
function openWith(privateKey, sealedBase64, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-api-'));
  try {
    fs.writeFileSync(path.join(dir, 'k.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.from(sealedBase64, 'base64'));
    return execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.bin'), '-pkeyopt', 'rsa_padding_mode:pkcs1'], { encoding: 'utf8' });
  } catch (e) {
    if (e.code === 'ENOENT') { t.skip('openssl is not on this computer'); return null; }
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the sign-in names the user, the EBS and the area in its header, and seals the login', (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aesKey = Buffer.alloc(32, 7);
  const r = api.tokenRequest({ ...who, aesKey, refresh: false, requestId: 'REQ-1' }, publicKey);
  assert.equal(r.url, api.TOKEN_URL);
  assert.deepEqual(r.headers, { 'Content-Type': 'application/json', username: 'dev@example.mu', ebsMraId: 'EBS123', areaCode: '100' });
  assert.deepEqual(Object.keys(r.body), ['requestId', 'payload']);
  assert.equal(r.body.requestId, 'REQ-1');
  const opened = openWith(privateKey, r.body.payload, t);
  if (opened === null) return;
  assert.deepEqual(JSON.parse(opened), { username: 'dev@example.mu', password: 'not-a-real-one', encryptKey: aesKey.toString('base64'), refreshToken: 'false' });
});

// The owner's area code is not known yet: with none, the header has no areaCode
// at all (not an empty one or "undefined"), and the MRA's answer says whether it
// is needed.
test('with no area code, neither request names one in its header', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const none = { ...who, areaCode: '' };
  const sign = api.tokenRequest({ ...none, aesKey: Buffer.alloc(32, 7), refresh: false, requestId: 'REQ-1' }, publicKey);
  assert.deepEqual(sign.headers, { 'Content-Type': 'application/json', username: 'dev@example.mu', ebsMraId: 'EBS123' });
  const send = api.transmitRequest({ ...none, token: 'tok', invoiceKey: Buffer.alloc(32, 3), invoices: [], requestId: 'REQ-2' });
  assert.deepEqual(send.headers, { 'Content-Type': 'application/json', username: 'dev@example.mu', ebsMraId: 'EBS123', token: 'tok' });
});

test('a sign-in that asks for a new token says refreshToken "true"', (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = api.tokenRequest({ ...who, aesKey: Buffer.alloc(32, 1), refresh: true, requestId: 'REQ-2' }, publicKey);
  const opened = openWith(privateKey, r.body.payload, t);
  if (opened !== null) assert.equal(JSON.parse(opened).refreshToken, 'true');
});

test('a successful sign-in gives the token, the key for invoices and when it ends', () => {
  const aesKey = Buffer.alloc(32, 7);
  const invoiceKey = Buffer.alloc(32, 9);
  const answer = { responseId: 'TK1', requestId: 'REQ-1', status: 'SUCCESS', token: 'tok', key: aesEncrypt(aesKey, invoiceKey.toString('base64')), expiryDate: '20261022 16:10:00' };
  const s = api.readToken(answer, aesKey);
  assert.equal(s.ok, true);
  assert.equal(s.token, 'tok');
  assert.deepEqual(s.invoiceKey, invoiceKey);
  assert.equal(s.expiryDate, '20261022 16:10:00');
  assert.equal(s.expiresAt, Date.UTC(2026, 9, 22, 12, 10, 0));
});

test('a refused sign-in gives its errors and nothing else', () => {
  const s = api.readToken({ status: 'ERROR', errors: ['Invalid Header Request'] }, Buffer.alloc(32));
  assert.deepEqual(s, { ok: false, errors: ['Invalid Header Request'] });
});

test('an invoice list goes encrypted with the key from the sign-in, with the token in the header', () => {
  const invoiceKey = Buffer.alloc(32, 9);
  const invoices = [{ invoiceIdentifier: 'EP-1', totalAmtPaid: '23.00' }];
  const r = api.transmitRequest({ ...who, token: 'tok', invoiceKey, invoices, requestId: 'REQ-3', now: new Date(Date.UTC(2026, 9, 21, 12, 0, 0)) });
  assert.equal(r.url, api.TRANSMIT_URL);
  assert.deepEqual(r.headers, { 'Content-Type': 'application/json', username: 'dev@example.mu', ebsMraId: 'EBS123', areaCode: '100', token: 'tok' });
  assert.equal(r.body.requestId, 'REQ-3');
  assert.equal(r.body.requestDateTime, '20261021 16:00:00');
  assert.equal(r.body.signedHash, '');
  assert.deepEqual(JSON.parse(aesDecrypt(invoiceKey, r.body.encryptedInvoice)), invoices);
});

test('the answer to a transmission says, for each invoice, its IRN and QR code or its errors', () => {
  const a = api.readTransmit({
    responseId: 'R1', responseDateTime: '20261021 16:00:01', requestId: 'REQ-3', status: 'HAS_ERROR', environment: 'TEST', infoMessages: null, errorMessages: null,
    fiscalisedInvoices: [
      { invoiceIdentifier: 'EP-1', irn: 'abc-123', qrCode: 'iVBORw0KGgo=', status: 'SUCCESS', warningMessages: null, errorMessages: null },
      { invoiceIdentifier: 'EP-2', irn: null, qrCode: null, status: 'ERROR', warningMessages: null, errorMessages: [{ code: 'LV_ERR002', description: 'TAN does not match' }] },
    ],
  });
  assert.equal(a.status, 'HAS_ERROR');
  assert.equal(a.environment, 'TEST');
  assert.deepEqual(a.invoices[0], { identifier: 'EP-1', status: 'SUCCESS', irn: 'abc-123', qrCode: 'iVBORw0KGgo=', errors: [], warnings: [] });
  assert.deepEqual(a.invoices[1].errors, ['LV_ERR002: TAN does not match']);
  assert.deepEqual(api.readTransmit({ status: 'ERROR', errorMessages: [{ code: 'ERR0050', description: 'Token is not valid' }] }).errors, ['ERR0050: Token is not valid']);
});

test('a request id is unique and at most 50 characters', () => {
  const a = api.requestId();
  const b = api.requestId();
  assert.notEqual(a, b);
  assert.ok(a.length <= 50);
});
