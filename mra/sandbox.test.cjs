// The owner's command (sandbox.cjs) run whole against a stand-in for the MRA
// on this computer, with its own key and certificate: sign-in, sending test
// cases 1 to 7, the QR code kept, the hash going from one invoice to the next, a
// send with no answer stopping the next, and nothing secret in what it writes.
//   node --test mra/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { aesEncrypt, aesDecrypt, previousNoteHash } = require('./crypto.cjs');

const PASSWORD = 'pass-for-the-stand-in-only';
const SCRIPT = path.join(__dirname, 'sandbox.cjs');
const run = (env, ...args) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } }, (err, stdout) => resolve(stdout)));

test('sign-in and test cases 1 to 7 against a stand-in for the MRA', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-sandbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'mra.key'), '-out', path.join(dir, 'mra.crt'), '-days', '2', '-subj', '/CN=stand-in'], { stdio: 'ignore' });
  } catch (e) { if (e.code === 'ENOENT') { t.skip('openssl is not on this computer'); return; } throw e; }
  fs.writeFileSync(path.join(dir, 'sandbox.env'), [
    'MRA_EBS_ID=EBSTEST1', 'MRA_USERNAME=dev@example.mu', `MRA_PASSWORD=${PASSWORD}`, 'MRA_AREA_CODE=100', 'MRA_PUBLIC_KEY=mra.crt',
    'MRA_SELLER_NAME=Test Ltd', 'MRA_SELLER_TRADE_NAME=Test', 'MRA_SELLER_TAN=12345678', 'MRA_SELLER_BRN=C07012345', 'MRA_SELLER_ADDRESS=Bel Air', 'MRA_SELLER_VAT=VATR',
  ].join('\n'));

  const invoiceKey = Buffer.alloc(32, 5);
  const received = [];
  let silent = false;
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      const answer = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('/generate-token')) {
        assert.equal(req.headers.username, 'dev@example.mu');
        assert.equal(req.headers.ebsmraid, 'EBSTEST1');
        assert.equal(req.headers.areacode, '100');
        fs.writeFileSync(path.join(dir, 'p.bin'), Buffer.from(b.payload, 'base64'));
        const login = JSON.parse(execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', path.join(dir, 'mra.key'), '-in', path.join(dir, 'p.bin'), '-pkeyopt', 'rsa_padding_mode:pkcs1'], { encoding: 'utf8' }));
        if (login.password !== PASSWORD) return answer({ status: 'ERROR', errors: ['Invalid User'] });
        return answer({ responseId: 'TK1', requestId: b.requestId, status: 'SUCCESS', token: 'stand-in-token', key: aesEncrypt(Buffer.from(login.encryptKey, 'base64'), invoiceKey.toString('base64')), expiryDate: '20991231 23:59:59' });
      }
      if (silent) return; // never answers: the script must give up and not send again
      assert.equal(req.headers.token, 'stand-in-token');
      const list = JSON.parse(aesDecrypt(invoiceKey, b.encryptedInvoice));
      requests += 1;
      const answers = list.map((i) => {
        received.push(i);
        return i.seller.tan === '12345678'
          ? { invoiceIdentifier: i.invoiceIdentifier, irn: `irn-${received.length}`, qrCode: Buffer.from('png').toString('base64'), status: 'SUCCESS' }
          : { invoiceIdentifier: i.invoiceIdentifier, status: 'ERROR', errorMessages: [{ code: 'LV_ERR002', description: 'Invalid TAN' }] };
      });
      return answer({ responseId: 'R1', requestId: b.requestId, status: answers.every((a) => a.status === 'SUCCESS') ? 'SUCCESS' : 'HAS_ERROR', environment: 'TEST', fiscalisedInvoices: answers });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAllConnections() || server.close());
  const env = { MRA_DIR: dir, MRA_FAKE: `http://127.0.0.1:${server.address().port}` };

  assert.match(await run(env, 'send', 'case1'), /Sign in first/);
  assert.match(await run(env, 'sign-in'), /Signed in/);
  // a note corrects an invoice that was fiscalised: none yet
  assert.match(await run(env, 'send', 'case2'), /Send case1 first/);
  assert.match(await run(env, 'send', 'case1'), /EPTSTD000001 fiscalised\. IRN irn-1/);
  assert.match(await run(env, 'send', 'case1'), /EPTSTD000002 fiscalised/);

  assert.equal(received.length, 2);
  assert.equal(received[0].previousNoteHash, '0');
  assert.equal(received[1].previousNoteHash, previousNoteHash({ dateTime: received[0].dateTimeInvoiceIssued, totalAmtPaid: received[0].totalAmtPaid, brn: 'C07012345', invoiceIdentifier: 'EPTSTD000001' }));
  assert.equal(received[1].invoiceCounter, '2');
  assert.equal(received[0].itemList.length, 6);
  assert.ok(fs.existsSync(path.join(dir, 'out', 'qr-EPTSTD000001.png')));

  // a send that gets no answer is not repeated, and stops the next one
  silent = true;
  assert.match(await run(env, 'send', 'case1'), /No answer for EPTSTD000003/);
  silent = false;
  assert.match(await run(env, 'send', 'case1'), /got no answer/);
  assert.equal(received.length, 2);
  assert.match(await run(env, 'forget'), /let go of/);
  assert.match(await run(env, 'send', 'case1'), /EPTSTD000004 fiscalised/);

  // test cases 2 and 3: a debit note and a credit note of one item, each on the
  // last invoice fiscalised, each kind with its own hash chain
  assert.match(await run(env, 'send', 'case2'), /EPTDRN000005 fiscalised/);
  assert.match(await run(env, 'send', 'case3'), /EPTCRN000006 fiscalised/);
  assert.match(await run(env, 'send', 'case2'), /EPTDRN000007 fiscalised/);
  const [drn, crn, drn2] = received.slice(3);
  assert.equal(drn.invoiceTypeDesc, 'DRN');
  assert.equal(crn.invoiceTypeDesc, 'CRN');
  for (const n of [drn, crn]) {
    assert.equal(n.invoiceRefIdentifier, 'EPTSTD000004');
    assert.equal(n.previousNoteHash, '0');
    assert.ok(n.reasonStated.length > 0 && n.reasonStated.length <= 100);
    assert.equal(n.itemList.length, 1);
  }
  assert.equal(drn2.previousNoteHash, previousNoteHash({ dateTime: drn.dateTimeInvoiceIssued, totalAmtPaid: drn.totalAmtPaid, brn: 'C07012345', invoiceIdentifier: 'EPTDRN000005' }));

  // test case 4: 10 invoices in one request, chained one to the next from the last
  // standard invoice fiscalised (EPTSTD000004), each with an item with VAT and one without
  const before = requests;
  const out4 = await run(env, 'send', 'case4');
  assert.match(out4, /EPTSTD000008 fiscalised/);
  assert.match(out4, /EPTSTD000017 fiscalised/);
  assert.equal(requests, before + 1);
  const ten = received.slice(6, 16);
  assert.equal(ten.length, 10);
  const std4 = received[2];
  ten.forEach((i, n) => {
    const prev = n === 0 ? std4 : ten[n - 1];
    assert.equal(i.previousNoteHash, previousNoteHash({ dateTime: prev.dateTimeInvoiceIssued, totalAmtPaid: prev.totalAmtPaid, brn: 'C07012345', invoiceIdentifier: prev.invoiceIdentifier }));
    assert.equal(Number(i.invoiceCounter), Number(ten[0].invoiceCounter) + n);
    assert.ok(i.itemList.some((l) => l.vatAmt !== '0.00') && i.itemList.some((l) => l.vatAmt === '0.00'));
  });

  // test case 5: a TAN other than the seller's is refused, as the case expects; the
  // number is used, and the chain goes on from the last invoice fiscalised
  assert.match(await run(env, 'send', 'case5'), /EPTSTD000018 refused, as test case 5 expects/);
  assert.notEqual(received[16].seller.tan, '12345678');
  assert.match(await run(env, 'send', 'case1'), /EPTSTD000019 fiscalised/);
  assert.equal(received[17].previousNoteHash, previousNoteHash({ dateTime: ten[9].dateTimeInvoiceIssued, totalAmtPaid: ten[9].totalAmtPaid, brn: 'C07012345', invoiceIdentifier: 'EPTSTD000017' }));

  // test cases 6 and 7: a pro forma and a training invoice of two items, each kind its own chain
  assert.match(await run(env, 'send', 'case6'), /EPTPRF000020 fiscalised/);
  assert.match(await run(env, 'send', 'case7'), /EPTTRN000021 fiscalised/);
  const [prf, trn] = received.slice(18);
  assert.equal(prf.invoiceTypeDesc, 'PRF');
  assert.equal(trn.invoiceTypeDesc, 'TRN');
  for (const i of [prf, trn]) {
    assert.equal(i.previousNoteHash, '0');
    assert.ok(i.itemList.length >= 2);
    assert.equal(i.invoiceRefIdentifier, '');
  }

  // what it writes for anyone to read holds no password, token or key
  for (const f of fs.readdirSync(path.join(dir, 'out')).filter((f) => f.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(dir, 'out', f), 'utf8');
    assert.ok(!text.includes(PASSWORD) && !text.includes('stand-in-token') && !text.includes(invoiceKey.toString('base64')), f);
  }
});

// After a batch of 10 got no answer and was checked on the portal, the next
// send starts after all 10 numbers, not after the first.
test('forget after an unanswered batch skips every number in it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mra-forget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ counter: 7, number: 7, last: {}, unsure: { identifier: 'EPTSTD000008 to EPTSTD000017', count: 10 } }));
  assert.match(await run({ MRA_DIR: dir }, 'forget'), /EPTSTD000008 to EPTSTD000017 is let go of/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(st.number, 17);
  assert.equal(st.unsure, null);
});
