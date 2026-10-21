// invoice.cjs held to the invoices the MRA's sandbox actually fiscalised,
// byte for byte (the phase 2 plan, Task 1). Those files are in
// .claude/mra/out, kept out of git: on any other computer, and in CI, this
// test is skipped.
//   node --test mra/sandbox-invoices.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inv = require('./invoice.cjs');
const { mraMoment } = require('./api.cjs');
const { previousNoteHash } = require('./crypto.cjs');

const OUT = path.join(__dirname, '..', '.claude', 'mra', 'out');
const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => /^invoice-.*\.json$/.test(f)).sort() : [];
const sent = files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
const cents = (s) => Math.round(Number(s) * 100);
// the test cases' lines, by the code each item carries
const byCode = Object.fromEntries(inv.testCase1Lines().map((l) => [l.code, l]));

test('every invoice the MRA fiscalised is what invoice.cjs builds', { skip: sent.length === 0 && 'no .claude/mra/out on this computer' }, () => {
  for (const x of sent) {
    let previous = null;
    if (x.previousNoteHash !== '0') {
      const before = sent.find((y) => y.invoiceTypeDesc === x.invoiceTypeDesc && previousNoteHash(inv.chained(y)) === x.previousNoteHash);
      assert.ok(before, `${x.invoiceIdentifier}: no invoice of its kind hashes to its previousNoteHash`);
      previous = inv.chained(before);
    }
    const s = x.seller;
    const built = inv.build({
      counter: Number(x.invoiceCounter), identifier: x.invoiceIdentifier, type: x.invoiceTypeDesc, previous,
      issuedAt: new Date(mraMoment(x.dateTimeInvoiceIssued)),
      seller: { name: s.name, tradeName: s.tradeName, tan: s.tan, brn: s.brn, businessAddr: s.businessAddr, businessPhoneNo: s.businessPhoneNo, vat: x.personType },
      lines: x.itemList.map((it) => ({ ...byCode[it.productCodeOwn], qty: Number(it.quantity) })),
      payment: x.salesTransactions, discount: cents(x.discountTotalAmount), transaction: x.transactionType,
      counterNo: s.ebsCounterNo, cashier: s.cashierID, ref: x.invoiceRefIdentifier, reason: x.reasonStated,
    });
    assert.equal(JSON.stringify(built), JSON.stringify(x), x.invoiceIdentifier);
  }
  assert.ok(sent.length >= 18, `only ${sent.length} invoices found`);
});
