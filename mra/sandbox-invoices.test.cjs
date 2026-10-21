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
// the owner's probe-mixed (sandbox.cjs): a till's lines, by code (its service line by its name)
const probe = Object.fromEntries(inv.probeMixed().lines.map((l) => [l.code || l.desc, l]));
const lineOf = (it) => (byCode[it.productCodeOwn] ? { ...byCode[it.productCodeOwn], qty: Number(it.quantity) } : probe[it.productCodeOwn || it.itemDesc]);
// probe-chain (sandbox.cjs) chained to an invoice the MRA never saw: EPTSTD999999, Rs 1.00, dated as it was sent
const madeUp = (x) => [0, 1000].map((back) => ({
  dateTime: inv.mraDateTime(new Date(mraMoment(x.dateTimeInvoiceIssued) - back)), totalAmtPaid: '1.00', brn: x.seller.brn, invoiceIdentifier: 'EPTSTD999999',
}));

test('every invoice the MRA fiscalised is what invoice.cjs builds', { skip: sent.length === 0 && 'no .claude/mra/out on this computer' }, () => {
  for (const x of sent) {
    let previous = null;
    if (x.previousNoteHash !== '0') {
      const before = sent.filter((y) => y.invoiceTypeDesc === x.invoiceTypeDesc).map(inv.chained).concat(madeUp(x))
        .find((c) => previousNoteHash(c) === x.previousNoteHash);
      assert.ok(before, `${x.invoiceIdentifier}: no invoice of its kind hashes to its previousNoteHash`);
      previous = before;
    }
    const s = x.seller;
    const built = inv.build({
      counter: Number(x.invoiceCounter), identifier: x.invoiceIdentifier, type: x.invoiceTypeDesc, previous,
      issuedAt: new Date(mraMoment(x.dateTimeInvoiceIssued)),
      seller: { name: s.name, tradeName: s.tradeName, tan: s.tan, brn: s.brn, businessAddr: s.businessAddr, businessPhoneNo: s.businessPhoneNo, vat: x.personType },
      lines: x.itemList.map(lineOf),
      payment: x.salesTransactions, discount: cents(x.discountTotalAmount), transaction: x.transactionType,
      counterNo: s.ebsCounterNo, cashier: s.cashierID, ref: x.invoiceRefIdentifier, reason: x.reasonStated,
    });
    assert.equal(JSON.stringify(built), JSON.stringify(x), x.invoiceIdentifier);
  }
  assert.ok(sent.length >= 18, `only ${sent.length} invoices found`);
});
