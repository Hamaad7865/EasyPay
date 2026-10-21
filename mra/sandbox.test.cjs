// The owner's command (sandbox.cjs) run whole against a stand-in for the MRA
// on this computer, with its own key and certificate: sign-in, sending test
// cases 1 to 3, the QR code kept, the hash going from one invoice to the next, a
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

test('sign-in and test cases 1 to 3 against a stand-in for the MRA', async (t) => {
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
      received.push(list[0]);
      return answer({ responseId: 'R1', requestId: b.requestId, status: 'SUCCESS', environment: 'TEST', fiscalisedInvoices: [{ invoiceIdentifier: list[0].invoiceIdentifier, irn: `irn-${received.length}`, qrCode: Buffer.from('png').toString('base64'), status: 'SUCCESS' }] });
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

  // what it writes for anyone to read holds no password, token or key
  for (const f of fs.readdirSync(path.join(dir, 'out')).filter((f) => f.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(dir, 'out', f), 'utf8');
    assert.ok(!text.includes(PASSWORD) && !text.includes('stand-in-token') && !text.includes(invoiceKey.toString('base64')), f);
  }
});
