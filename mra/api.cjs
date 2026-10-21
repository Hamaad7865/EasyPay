// The two calls to the MRA e-invoicing system (its technical guide, v1.3),
// as requests and answers; send() does the network, once, with a timeout.
//   - Sign-in (token generation): the header names the portal user, the EBS
//     MRA ID and the area code; the body is a request id and the login sealed
//     with the MRA public key (crypto.cjs). The token lasts 24 hours; asked
//     again while it has more than 10 minutes left, the same token comes back.
//   - Transmission: the same header with the token; the body is a request id,
//     the time, an optional signature and the invoice list encrypted with the
//     key the sign-in gave. At most 500 invoices a request.
// The addresses are the MRA's test system (the EBS in SANDBOX or TEST DRIVE).
const crypto = require('node:crypto');
const { rsaEncrypt, aesEncrypt, unwrapKey } = require('./crypto.cjs');
const { mraDateTime } = require('./invoice.cjs');

const TOKEN_URL = 'https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token';
const TRANSMIT_URL = 'https://vfisc.mra.mu/realtime/invoice/transmit';

const requestId = () => `EP${Date.now()}${crypto.randomBytes(4).toString('hex')}`;

// the area code only when there is one: none, and the MRA says whether it needs it
const header = (who) => ({ 'Content-Type': 'application/json', username: who.username, ebsMraId: who.ebsMraId, ...(who.areaCode ? { areaCode: who.areaCode } : {}) });

function tokenRequest({ username, password, ebsMraId, areaCode, aesKey, refresh, requestId: id }, mraPublicKey) {
  const login = JSON.stringify({ username, password, encryptKey: aesKey.toString('base64'), refreshToken: refresh ? 'true' : 'false' });
  return { url: TOKEN_URL, headers: header({ username, ebsMraId, areaCode }), body: { requestId: id, payload: rsaEncrypt(mraPublicKey, login) } };
}

// "yyyyMMdd HH:mm:ss" in Mauritius time (UTC+4) as a moment
function mraMoment(text) {
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(String(text || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 4, +m[5], +m[6]) : null;
}

function readToken(answer, aesKey) {
  if (!answer || answer.status !== 'SUCCESS' || !answer.token || !answer.key) {
    return { ok: false, errors: (answer && answer.errors) || [answer && answer.status ? `status ${answer.status}` : 'no answer'] };
  }
  return { ok: true, responseId: answer.responseId, token: answer.token, invoiceKey: unwrapKey(answer.key, aesKey), expiryDate: answer.expiryDate, expiresAt: mraMoment(answer.expiryDate) };
}

function transmitRequest({ username, ebsMraId, areaCode, token, invoiceKey, invoices, requestId: id, now = new Date() }) {
  return {
    url: TRANSMIT_URL,
    headers: { ...header({ username, ebsMraId, areaCode }), token },
    body: { requestId: id, requestDateTime: mraDateTime(now), signedHash: '', encryptedInvoice: aesEncrypt(invoiceKey, JSON.stringify(invoices)) },
  };
}

const said = (list) => (list || []).map((m) => (typeof m === 'string' ? m : `${String(m.code || '').trim()}: ${String(m.description || '').trim()}`));

function readTransmit(answer) {
  return {
    status: answer.status,
    environment: answer.environment,
    responseId: answer.responseId,
    errors: said(answer.errorMessages),
    info: said(answer.infoMessages),
    invoices: (answer.fiscalisedInvoices || []).map((f) => ({
      identifier: f.invoiceIdentifier,
      status: f.status,
      irn: f.irn,
      qrCode: f.qrCode,
      errors: said(f.errorMessages),
      warnings: said(f.warningMessages),
    })),
  };
}

// One POST, never repeated here: a transmission resent after a timeout can be
// fiscalised twice (the guide). The MRA asks for at least 10 seconds.
async function send(request, timeoutMs = 15000) {
  const r = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { httpStatus: r.status, json, text: json ? null : text.slice(0, 500) };
}

module.exports = { TOKEN_URL, TRANSMIT_URL, requestId, tokenRequest, readToken, transmitRequest, readTransmit, send, mraMoment };
