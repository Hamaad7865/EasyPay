// The cryptography of the MRA e-invoicing system (its technical guide, v1.3):
//   - sign-in: our own random AES-256 key goes, with the portal login, in a
//     JSON that is RSA-encrypted (PKCS#1 v1.5, Java's "RSA") with the MRA
//     public key from its certificate, then base64;
//   - the MRA answers with a token and a key for invoices, wrapped twice:
//     base64 of the AES-256-ECB encryption, under our key, of the base64 of
//     the 32 bytes that encrypt invoices;
//   - an invoice list is AES-256-ECB (PKCS#7 padding) encrypted with those 32
//     bytes, then base64;
//   - each invoice carries the hash of the previous one of its kind: sha256 of
//     its date and time, amount paid, BRN and number, in capital hex; "0" for
//     the first.
// Held to fixed values worked out with openssl (fixtures/crypto.json).
const crypto = require('node:crypto');

function previousNoteHash(prev) {
  if (!prev) return '0';
  const joined = `${prev.dateTime}${prev.totalAmtPaid}${prev.brn}${prev.invoiceIdentifier}`;
  return crypto.createHash('sha256').update(joined, 'utf8').digest('hex').toUpperCase();
}

function newAesKey() {
  return crypto.randomBytes(32);
}

function aesEncrypt(key, plain) {
  const c = crypto.createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
}

function aesDecrypt(key, base64) {
  const d = crypto.createDecipheriv('aes-256-ecb', key, null);
  return Buffer.concat([d.update(Buffer.from(base64, 'base64')), d.final()]).toString('utf8');
}

// The MRA's `key` from the sign-in, as the 32 bytes that encrypt invoices.
function unwrapKey(keyFromMra, ourKey) {
  const key = Buffer.from(aesDecrypt(ourKey, keyFromMra).trim(), 'base64');
  if (key.length !== 32) throw new Error(`the key from the MRA is ${key.length} bytes, not 32`);
  return key;
}

// The public key of the MRA's certificate (.crt, PEM or DER).
function publicKeyOf(certificate) {
  return new crypto.X509Certificate(certificate).publicKey;
}

// RSA with PKCS#1 v1.5 padding, then base64. `key` is a KeyObject or a PEM public key.
function rsaEncrypt(key, plain) {
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8')).toString('base64');
}

module.exports = { previousNoteHash, newAesKey, aesEncrypt, aesDecrypt, unwrapKey, publicKeyOf, rsaEncrypt };
