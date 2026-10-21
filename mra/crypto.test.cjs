// The MRA e-invoicing cryptography, held to fixed values worked out with the
// openssl command line (fixtures/crypto.json).
//   node --test mra/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fx = require('./fixtures/crypto.json');
const mra = require('./crypto.cjs');

test('the previous invoice hash is the sha256 of date, amount, BRN and number, in capitals', () => {
  const h = fx.hash;
  assert.equal(mra.previousNoteHash({ dateTime: h.dateTime, totalAmtPaid: h.totalAmtPaid, brn: h.brn, invoiceIdentifier: h.invoiceIdentifier }), h.expected);
});

test('the first invoice of a kind has "0" for a previous hash', () => {
  assert.equal(mra.previousNoteHash(null), '0');
});

test('an invoice is encrypted with AES-256 in ECB mode, as the fixed bytes say', () => {
  assert.equal(mra.aesEncrypt(Buffer.from(fx.aes.keyHex, 'hex'), fx.aes.plain), fx.aes.cipherBase64);
  assert.equal(mra.aesDecrypt(Buffer.from(fx.aes.keyHex, 'hex'), fx.aes.cipherBase64), fx.aes.plain);
});

// The key the MRA sends back is wrapped twice: base64 of the AES encryption,
// under our own key, of the base64 of the key that encrypts invoices.
test('the key from the MRA is unwrapped into the 32 bytes that encrypt invoices', () => {
  const key = mra.unwrapKey(fx.unwrap.keyFromMra, Buffer.from(fx.unwrap.ourKeyHex, 'hex'));
  assert.equal(key.length, 32);
  assert.equal(key.toString('base64'), fx.unwrap.invoiceKeyBase64);
});

test('a new AES key is 32 random bytes', () => {
  const a = mra.newAesKey();
  const b = mra.newAesKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

// The sign-in's payload goes encrypted with the MRA public key, PKCS#1 v1.5 as
// Java's "RSA" does (Node would pick OAEP if not told). Node refuses to decrypt
// PKCS#1 v1.5 itself, so the openssl command line decrypts it here.
test('the sign-in payload is RSA-encrypted with PKCS#1 v1.5 padding', (t) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sealed = mra.rsaEncrypt(publicKey.export({ type: 'spki', format: 'pem' }), '{"username":"u"}');
  assert.equal(Buffer.from(sealed, 'base64').length, 256);
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-rsa-'));
  try {
    fs.writeFileSync(path.join(dir, 'k.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.from(sealed, 'base64'));
    let out;
    try {
      out = execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.bin'), '-pkeyopt', 'rsa_padding_mode:pkcs1'], { encoding: 'utf8' });
    } catch (e) {
      if (e.code === 'ENOENT') { t.skip('openssl is not on this computer'); return; }
      throw e;
    }
    assert.equal(out, '{"username":"u"}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the public key is read from the certificate, in PEM or DER', () => {
  // a certificate made by openssl for the test only
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-crt-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-in', path.join(dir, 'c.pem'), '-outform', 'DER', '-out', path.join(dir, 'c.der')], { stdio: 'ignore' });
    for (const f of ['c.pem', 'c.der']) {
      const sealed = mra.rsaEncrypt(mra.publicKeyOf(fs.readFileSync(path.join(dir, f))), 'x');
      assert.equal(Buffer.from(sealed, 'base64').length, 256, f);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
