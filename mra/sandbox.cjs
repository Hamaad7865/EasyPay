// Proves the connection to the MRA e-invoicing test system before any till
// sends to it (the Premium MRA design, piece 2). Run by the owner, whose
// portal login it uses, from the repository's folder:
//
//   node mra/sandbox.cjs check          what is filled in and the certificate; sends nothing
//   node mra/sandbox.cjs sign-in        asks the MRA for a token
//   node mra/sandbox.cjs send case1     sends one invoice of the MRA's test case 1
//   node mra/sandbox.cjs send case2     a debit note on the last invoice fiscalised (test case 2)
//   node mra/sandbox.cjs send case3     a credit note on the last invoice fiscalised (test case 3)
//   node mra/sandbox.cjs send case4     10 invoices in one request (test case 4)
//   node mra/sandbox.cjs send case5     an invoice with a TAN not the seller's, to be refused (test case 5)
//   node mra/sandbox.cjs send case6     a pro forma (test case 6)
//   node mra/sandbox.cjs send case7     a training invoice (test case 7)
//   node mra/sandbox.cjs forget         after an unanswered send has been checked on the portal
//
// It reads .claude/mra/sandbox.env and the MRA public key named there, keeps
// the token and the key for invoices in .claude/mra/session.json, the invoice
// counter and the last hash of each kind in .claude/mra/state.json, and writes
// what happened to .claude/mra/out/: never the password, the token or a key.
// The folder is kept out of git. A send is never repeated by this script: a
// send with no answer stops the next one until it has been checked on the
// portal, because resending can fiscalise the same invoice twice.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./api.cjs');
const inv = require('./invoice.cjs');
const { newAesKey, publicKeyOf } = require('./crypto.cjs');

// MRA_DIR and MRA_FAKE (a stand-in for the MRA on this computer) are for its test only
const DIR = process.env.MRA_DIR || path.join(__dirname, '..', '.claude', 'mra');
const toFake = (req) => (process.env.MRA_FAKE ? { ...req, url: req.url.replace('https://vfisc.mra.mu', process.env.MRA_FAKE) } : req);
const OUT = path.join(DIR, 'out');
const at = (f) => path.join(DIR, f);

function readEnv() {
  const env = {};
  const file = at('sandbox.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    env[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim();
  }
  return env;
}

// MRA_AREA_CODE, MRA_SELLER_VAT and MRA_SELLER_PHONE may be left empty: with no area
// code the MRA is asked without one; with no VAT status the seller is VATR, as the
// MRA's test cases 1 and 4 need items with VAT
const NEEDED = ['MRA_EBS_ID', 'MRA_USERNAME', 'MRA_PASSWORD', 'MRA_PUBLIC_KEY', 'MRA_SELLER_NAME', 'MRA_SELLER_TRADE_NAME', 'MRA_SELLER_TAN', 'MRA_SELLER_BRN', 'MRA_SELLER_ADDRESS'];

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(at(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(at(f), JSON.stringify(v, null, 2));
function outcome(name, v) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify({ at: new Date().toISOString(), ...v }, null, 2));
}

function ready(env) {
  const missing = NEEDED.filter((k) => !env[k]);
  if (missing.length) { console.log('Not filled in .claude/mra/sandbox.env: ' + missing.join(', ')); return null; }
  if (env.MRA_SELLER_VAT && !['VATR', 'NVTR'].includes(env.MRA_SELLER_VAT)) { console.log('MRA_SELLER_VAT is VATR, NVTR or empty.'); return null; }
  let key;
  try { key = publicKeyOf(fs.readFileSync(at(env.MRA_PUBLIC_KEY))); } catch (e) { console.log(`The MRA public key ${env.MRA_PUBLIC_KEY} could not be read: ${e.message}`); return null; }
  return {
    who: { username: env.MRA_USERNAME, password: env.MRA_PASSWORD, ebsMraId: env.MRA_EBS_ID, areaCode: env.MRA_AREA_CODE || '' },
    key,
    seller: { name: env.MRA_SELLER_NAME, tradeName: env.MRA_SELLER_TRADE_NAME, tan: env.MRA_SELLER_TAN, brn: env.MRA_SELLER_BRN, businessAddr: env.MRA_SELLER_ADDRESS, businessPhoneNo: env.MRA_SELLER_PHONE || '', vat: env.MRA_SELLER_VAT || 'VATR' },
  };
}

function check() {
  const env = readEnv();
  const c = ready(env);
  if (!c) return;
  const cert = new crypto.X509Certificate(fs.readFileSync(at(env.MRA_PUBLIC_KEY)));
  console.log(`Everything needed is filled in. The MRA certificate is valid from ${cert.validFrom} to ${cert.validTo}.`);
  if (!env.MRA_AREA_CODE) console.log('No area code: the MRA is asked without one. If sign-in is refused for it, fill MRA_AREA_CODE.');
  if (!env.MRA_SELLER_VAT) console.log('MRA_SELLER_VAT is empty: sent as VATR (VAT-registered).');
  const s = readJson('session.json', null);
  console.log(s && s.expiresAt > Date.now() ? `Signed in until ${s.expiryDate} (Mauritius time).` : 'Not signed in yet: run  node mra/sandbox.cjs sign-in');
  const st = readJson('state.json', null);
  if (st) console.log(`Invoices sent so far: ${st.counter}.` + (st.unsure ? ` ${st.unsure.identifier} got no answer: check it on the portal, then  node mra/sandbox.cjs forget` : ''));
}

async function signIn() {
  const c = ready(readEnv());
  if (!c) return;
  const aesKey = newAesKey();
  const req = api.tokenRequest({ ...c.who, aesKey, refresh: false, requestId: api.requestId() }, c.key);
  let r;
  try { r = await api.send(toFake(req)); } catch (e) {
    outcome('sign-in.json', { ok: false, error: e.name === 'TimeoutError' ? 'no answer within 15 seconds' : e.message });
    console.log('The MRA did not answer: ' + (e.name === 'TimeoutError' ? 'no answer within 15 seconds' : e.message));
    return;
  }
  const s = r.json ? api.readToken(r.json, aesKey) : { ok: false, errors: [`HTTP ${r.httpStatus}: ${r.text}`] };
  if (s.ok) writeJson('session.json', { token: s.token, invoiceKey: s.invoiceKey.toString('base64'), expiresAt: s.expiresAt, expiryDate: s.expiryDate });
  outcome('sign-in.json', { ok: s.ok, httpStatus: r.httpStatus, responseId: s.responseId || (r.json && r.json.responseId) || null, expiryDate: s.expiryDate || null, errors: s.errors || [] });
  console.log(s.ok ? `Signed in. The token lasts until ${s.expiryDate} (Mauritius time).` : `Refused (HTTP ${r.httpStatus}): ${(s.errors || []).join('; ')}` + (c.who.areaCode ? '' : '\nNo area code was sent: if the reason is about it, fill MRA_AREA_CODE.'));
}

// A note (DRN, CRN) corrects the last standard invoice the MRA fiscalised.
// `count` invoices go in one request; `refused`: the MRA is expected to refuse it.
const CASES = {
  case1: { type: 'STD', lines: inv.testCase1Lines },
  case2: { type: 'DRN', lines: inv.testCase2Lines, reason: 'Item served and left off the invoice' },
  case3: { type: 'CRN', lines: inv.testCase3Lines, reason: 'Return of product' },
  case4: { type: 'STD', lines: inv.testCase4Lines, count: 10 },
  case5: { type: 'STD', lines: inv.testCase5Lines, refused: true },
  case6: { type: 'PRF', lines: inv.testCase6Lines },
  case7: { type: 'TRN', lines: inv.testCase7Lines },
};

async function sendCase(name) {
  const which = CASES[name];
  if (!which) { console.log('Known: ' + Object.keys(CASES).join(', ')); return; }
  const c = ready(readEnv());
  if (!c) return;
  const session = readJson('session.json', null);
  if (!session || session.expiresAt - Date.now() < 10 * 60_000) { console.log('Sign in first:  node mra/sandbox.cjs sign-in'); return; }
  const state = readJson('state.json', { counter: 0, number: 0, last: {}, unsure: null });
  if (state.unsure) { console.log(`${state.unsure.identifier} got no answer. Check on the portal (EBS Testing, Download) whether it was fiscalised, then  node mra/sandbox.cjs forget`); return; }
  const ref = which.reason ? state.last.STD && state.last.STD.invoiceIdentifier : '';
  if (which.reason && !ref) { console.log('A note corrects an invoice the MRA fiscalised: none yet. Send case1 first.'); return; }

  // test case 5: any TAN but the seller's
  const seller = which.refused ? { ...c.seller, tan: c.seller.tan === '12345678' ? '87654321' : '12345678' } : c.seller;
  // each invoice chained to the one before it, the first to the last of its kind fiscalised
  const invoices = [];
  let previous = state.last[which.type] || null;
  for (let i = 0; i < (which.count || 1); i++) {
    const identifier = `EPT${which.type}${String(state.number + 1 + i).padStart(6, '0')}`;
    const invoice = inv.build({ counter: state.counter + 1 + i, identifier, type: which.type, previous, issuedAt: new Date(), seller, lines: which.lines(i), payment: 'CASH', ref, reason: which.reason });
    invoices.push(invoice);
    previous = inv.chained(invoice);
  }
  const ids = invoices.map((x) => x.invoiceIdentifier);
  const label = ids.length > 1 ? `${ids[0]} to ${ids[ids.length - 1]}` : ids[0];
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `invoice-${ids[0]}.json`), JSON.stringify(invoices, null, 2));
  // written down before it goes: a send with no answer must not be repeated unknowingly
  state.unsure = { identifier: label, count: invoices.length, at: new Date().toISOString() };
  writeJson('state.json', state);

  const req = api.transmitRequest({ ...c.who, token: session.token, invoiceKey: Buffer.from(session.invoiceKey, 'base64'), invoices, requestId: api.requestId() });
  let r;
  try { r = await api.send(toFake(req)); } catch (e) {
    const why = e.name === 'TimeoutError' ? 'no answer within 15 seconds' : e.message;
    outcome(`send-${ids[0]}.json`, { identifiers: ids, answered: false, error: why });
    console.log(`No answer for ${label} (${why}). It is not sent again. Check on the portal whether it was fiscalised, then  node mra/sandbox.cjs forget`);
    return;
  }
  const a = r.json ? api.readTransmit(r.json) : { status: `HTTP ${r.httpStatus}`, errors: [r.text], invoices: [] };
  // answered: every number sent is used, fiscalised or refused; the chain goes on
  // from the last one fiscalised (a refused invoice is not the MRA's previous one)
  state.unsure = null;
  state.counter += invoices.length;
  state.number += invoices.length;
  const results = invoices.map((invoice) => {
    const mine = a.invoices.find((x) => x.identifier === invoice.invoiceIdentifier) || null;
    if (mine && mine.status === 'SUCCESS') {
      state.last[which.type] = inv.chained(invoice);
      if (mine.qrCode) fs.writeFileSync(path.join(OUT, `qr-${invoice.invoiceIdentifier}.png`), Buffer.from(mine.qrCode, 'base64'));
    }
    return { identifier: invoice.invoiceIdentifier, mine };
  });
  writeJson('state.json', state);
  outcome(`send-${ids[0]}.json`, { identifiers: ids, answered: true, httpStatus: r.httpStatus, status: a.status, environment: a.environment, responseId: a.responseId, errors: a.errors, info: a.info,
    invoices: results.map(({ identifier, mine }) => (mine ? { identifier, status: mine.status, irn: mine.irn, qrSaved: Boolean(mine.qrCode), errors: mine.errors, warnings: mine.warnings } : { identifier, status: null })) });
  for (const { identifier, mine } of results) {
    const ok = mine && mine.status === 'SUCCESS';
    const why = [...a.errors, ...(mine ? mine.errors : [])].join('; ') || 'no reason given';
    if (which.refused) console.log(ok ? `${identifier} was fiscalised, but test case 5 expects a refusal` : `${identifier} refused, as test case 5 expects: ${why}`);
    else console.log(ok ? `${identifier} fiscalised. IRN ${mine.irn}. QR code saved in .claude/mra/out/qr-${identifier}.png` : `${identifier} not fiscalised (${a.status}): ${why}`);
  }
}

function forget() {
  const state = readJson('state.json', null);
  if (!state || !state.unsure) { console.log('Nothing is waiting.'); return; }
  console.log(`${state.unsure.identifier} is let go of: the next send uses the next number.`);
  state.number += state.unsure.count || 1;
  state.unsure = null;
  writeJson('state.json', state);
}

const [cmd, arg] = process.argv.slice(2);
({ check, 'sign-in': signIn, send: () => sendCase(arg), forget }[cmd] || (() => console.log('node mra/sandbox.cjs check | sign-in | send case1 ... case7 | forget')))();
