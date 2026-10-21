// An EasyPay sale as the MRA's e-invoice (its data structure v1.3.4).
//   node --test mra/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const inv = require('./invoice.cjs');
const { previousNoteHash } = require('./crypto.cjs');

const seller = { name: 'Test Ltd', tradeName: 'Test', tan: '12345678', brn: 'C07012345', businessAddr: 'Royal Road, Bel Air', businessPhoneNo: '+2302076000', vat: 'VATR' };

test('an amount is a string of rupees with two decimals', () => {
  assert.equal(inv.money(11500), '115.00');
  assert.equal(inv.money(5), '0.05');
  assert.equal(inv.money(0), '0.00');
});

// Mauritius is UTC+4 all year, whatever the tablet or server is set to.
test('a date and time is written in Mauritius time, yyyyMMdd HH:mm:ss', () => {
  assert.equal(inv.mraDateTime(new Date(Date.UTC(2026, 9, 21, 12, 5, 9))), '20261021 16:05:09');
  assert.equal(inv.mraDateTime(new Date(Date.UTC(2026, 9, 21, 22, 0, 0))), '20261022 02:00:00');
  assert.equal(inv.mraDateTime(new Date(Date.UTC(2026, 9, 21, 22, 0, 0))).length, 17);
});

// EasyPay's prices include VAT; the VAT in them is taken out as the till does
// (core/data/Calc: (base * rate + (10000 + rate) / 2) / (10000 + rate)).
test('the VAT inside a price is worked out as the till works it out', () => {
  assert.equal(inv.vatIncluded(11500, 1500), 1500);
  assert.equal(inv.vatIncluded(9999, 1500), 1304);
  assert.equal(inv.vatIncluded(5000, 0), 0);
});

test('a line carries its amount without VAT, its VAT and its total, which add up', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(Date.UTC(2026, 9, 21, 8, 0, 0)), seller,
    lines: [{ desc: 'Dholl puri', qty: 2, unitPrice: 9999, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS', code: 'DP' }],
    payment: 'CASH',
  });
  const l = i.itemList[0];
  assert.equal(l.itemNo, '1');
  assert.equal(l.quantity, '2');
  assert.equal(l.totalPrice, '199.98');
  assert.equal(l.vatAmt, '26.08');
  assert.equal(l.amtWoVatCur, '173.90');
  assert.equal(l.amtWoVatMur, '173.90');
  assert.equal(l.discountedValue, '173.90');
  assert.equal(l.productCodeOwn, 'DP');
  assert.equal(l.productCodeMra, '');
});

test('the totals are the lines\' sums, and what is paid is the total less the discount', () => {
  const i = inv.build({
    counter: 7, identifier: 'EP-7', type: 'STD', previous: null, issuedAt: new Date(Date.UTC(2026, 9, 21, 8, 0, 0)), seller,
    lines: [
      { desc: 'Curry', qty: 1, unitPrice: 11500, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS' },
      { desc: 'Bread', qty: 3, unitPrice: 1000, taxCode: 'TC03', vatBp: 0, nature: 'GOODS' },
    ],
    payment: 'CARD',
  });
  assert.equal(i.totalVatAmount, '15.00');
  assert.equal(i.totalAmtWoVatCur, '130.00');
  assert.equal(i.totalAmtWoVatMur, '130.00');
  assert.equal(i.invoiceTotal, '145.00');
  assert.equal(i.discountTotalAmount, '0.00');
  assert.equal(i.totalAmtPaid, '145.00');
  assert.equal(i.invoiceCounter, '7');
  assert.equal(i.invoiceTypeDesc, 'STD');
  assert.equal(i.transactionType, 'B2C');
  assert.equal(i.personType, 'VATR');
  assert.equal(i.currency, 'MUR');
  assert.equal(i.salesTransactions, 'CARD');
  assert.equal(i.dateTimeInvoiceIssued, '20261021 12:00:00');
  assert.equal(i.seller.tan, '12345678');
  assert.equal(i.seller.brn, 'C07012345');
  assert.equal(i.previousNoteHash, '0');
});

// The hash goes from one invoice to the next of the same kind, from the
// fields as they were sent.
test('the next invoice carries the hash of the one before it, of its own kind', () => {
  const at = new Date(Date.UTC(2026, 9, 21, 8, 0, 0));
  const line = [{ desc: 'Tea', qty: 1, unitPrice: 2300, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS' }];
  const first = inv.build({ counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: at, seller, lines: line, payment: 'CASH' });
  const second = inv.build({ counter: 2, identifier: 'EP-2', type: 'STD', previous: inv.chained(first), issuedAt: at, seller, lines: line, payment: 'CASH' });
  assert.equal(second.previousNoteHash, previousNoteHash({ dateTime: '20261021 12:00:00', totalAmtPaid: '23.00', brn: 'C07012345', invoiceIdentifier: 'EP-1' }));
  assert.deepEqual(inv.chained(first), { dateTime: '20261021 12:00:00', totalAmtPaid: '23.00', brn: 'C07012345', invoiceIdentifier: 'EP-1' });
});

// A seller that is not VAT-registered charges no VAT.
test('a seller not registered for VAT shows no VAT', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(), seller: { ...seller, vat: 'NVTR' },
    lines: [{ desc: 'Curry', qty: 1, unitPrice: 11500, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS' }], payment: 'CASH',
  });
  assert.equal(i.personType, 'NVTR');
  assert.equal(i.totalVatAmount, '0.00');
  assert.equal(i.itemList[0].vatAmt, '0.00');
  assert.equal(i.itemList[0].amtWoVatCur, '115.00');
});

// The MRA's test case 1: one standard invoice of 6 items, 3 with VAT and 3
// without, sent 3 times with 3 invoice numbers.
test('test case 1 is a standard invoice of 6 items, 3 with VAT and 3 without', () => {
  const lines = inv.testCase1Lines();
  assert.equal(lines.length, 6);
  assert.equal(lines.filter((l) => l.vatBp > 0).length, 3);
  assert.equal(lines.filter((l) => l.vatBp === 0).length, 3);
  const i = inv.build({ counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(), seller, lines, payment: 'CASH' });
  assert.equal(i.itemList.length, 6);
  assert.equal(i.itemList.filter((l) => l.vatAmt !== '0.00').length, 3);
});

// A credit or debit note names the invoice it corrects and why (the data
// structure: both mandatory for CRN and DRN); a standard invoice has neither.
test('a credit or debit note carries the invoice it corrects and the reason', () => {
  const at = new Date(Date.UTC(2026, 9, 21, 8, 0, 0));
  const line = [{ desc: 'Soft drink', qty: 1, unitPrice: 5750, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS' }];
  const crn = inv.build({ counter: 4, identifier: 'EP-4', type: 'CRN', previous: null, issuedAt: at, seller, lines: line, payment: 'CASH', ref: 'EP-1', reason: 'Returned' });
  assert.equal(crn.invoiceTypeDesc, 'CRN');
  assert.equal(crn.invoiceRefIdentifier, 'EP-1');
  assert.equal(crn.reasonStated, 'Returned');
  assert.equal(crn.totalAmtPaid, '57.50');
  const std = inv.build({ counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: at, seller, lines: line, payment: 'CASH' });
  assert.equal(std.invoiceRefIdentifier, '');
  assert.equal(std.reasonStated, '');
});

test('a credit or debit note without the invoice it corrects, or without a reason, is not built', () => {
  const base = { counter: 1, identifier: 'EP-1', previous: null, issuedAt: new Date(), seller, payment: 'CASH',
    lines: [{ desc: 'Tea', qty: 1, unitPrice: 2300, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS' }] };
  assert.throws(() => inv.build({ ...base, type: 'DRN', reason: 'Undercharged' }), /invoice it corrects/);
  assert.throws(() => inv.build({ ...base, type: 'CRN', ref: 'EP-0' }), /reason/);
});

// The MRA's test cases 2 and 3: one note of one item each, on an item of test case 1.
test('test cases 2 and 3 are one item each, taken from test case 1', () => {
  const names = inv.testCase1Lines().map((l) => l.desc);
  for (const lines of [inv.testCase2Lines(), inv.testCase3Lines()]) {
    assert.equal(lines.length, 1);
    assert.ok(names.includes(lines[0].desc), lines[0].desc);
  }
});

// Test case 4: 10 invoices in one request, each with an item with VAT and one without.
test('each of test case 4\'s 10 invoices has an item with VAT and one without', () => {
  for (let i = 0; i < 10; i++) {
    const lines = inv.testCase4Lines(i);
    assert.ok(lines.some((l) => l.vatBp > 0), `invoice ${i}`);
    assert.ok(lines.some((l) => l.vatBp === 0), `invoice ${i}`);
  }
});

// Test case 5 is one item; 6 (pro forma) and 7 (training) at least two.
test('test case 5 is one item, test cases 6 and 7 at least two', () => {
  assert.equal(inv.testCase5Lines().length, 1);
  assert.ok(inv.testCase6Lines().length >= 2);
  assert.ok(inv.testCase7Lines().length >= 2);
});

// ---- a real sale (the phase 2 plan, "How a sale becomes an invoice") ----

test('a quantity in thousandths is written as a number', () => {
  assert.equal(inv.qtyText(2000), '2');
  assert.equal(inv.qtyText(250), '0.25');
  assert.equal(inv.qtyText(1125), '1.125');
});

test('a negative amount keeps its sign', () => {
  assert.equal(inv.money(-5), '-0.05');
  assert.equal(inv.money(-11500), '-115.00');
});

// The till spreads an order discount over the lines and works the VAT out on
// what is left of each (core/data/Calc). The MRA is told the same VAT.
test('a line\'s part of the order discount comes off before its VAT', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(Date.UTC(2026, 9, 21, 8, 0, 0)), seller,
    lines: [{ desc: 'Curry', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 11500, share: 1150, vatBp: 1500 }],
    payment: 'CASH',
  });
  const l = i.itemList[0];
  assert.equal(l.vatAmt, '13.50'); // (10350 * 1500 + 5750) / 11500
  assert.equal(l.amtWoVatCur, '90.00'); // 103.50 - 13.50
  assert.equal(l.unitPrice, '100.00'); // 115.00 without its VAT
  assert.equal(l.discount, '10.00');
  assert.equal(l.totalPrice, '103.50');
  assert.equal(i.totalAmtPaid, '103.50');
});

test('VAT on top is added to what the line charges', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [{ desc: 'Cake', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 10000, vatBp: 1500, added: true }],
    payment: 'CASH',
  });
  assert.equal(i.itemList[0].vatAmt, '15.00');
  assert.equal(i.itemList[0].amtWoVatCur, '100.00');
  assert.equal(i.itemList[0].unitPrice, '100.00');
  assert.equal(i.invoiceTotal, '115.00');
});

test('a line sold by the kilo has a fraction for its quantity and a price for one kilo', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [{ desc: 'Prawns', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 250, base: 20000, vatBp: 1500 }],
    payment: 'CASH',
  });
  assert.equal(i.itemList[0].quantity, '0.25');
  // VAT inside 200.00 is 26.09 (2609.19 rounded down), 173.91 without it, 695.64 a kilo
  assert.equal(i.itemList[0].unitPrice, '695.64');
  assert.equal(i.itemList[0].totalPrice, '200.00');
});

test('the cents of a discount the lines did not take are the invoice\'s own discount', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [
      { desc: 'A', code: '', taxCode: 'TC03', nature: 'GOODS', qtyMilli: 1000, base: 100, share: 33 },
      { desc: 'B', code: '', taxCode: 'TC03', nature: 'GOODS', qtyMilli: 1000, base: 200, share: 66 },
    ],
    discount: 1, payment: 'CASH',
  });
  assert.equal(i.discountTotalAmount, '0.01');
  assert.equal(i.totalAmtPaid, '2.00'); // 300 - 100 off
});

test('the old form (whole quantities, prices with VAT) and the general form build the same bytes', () => {
  const old = inv.build({ counter: 1, identifier: 'X', type: 'STD', previous: null, issuedAt: new Date(0), seller, lines: inv.testCase1Lines(), payment: 'CASH' });
  const general = inv.build({ counter: 1, identifier: 'X', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: inv.testCase1Lines().map(inv.general), payment: 'CASH' });
  assert.equal(JSON.stringify(general), JSON.stringify(old));
});

// The till is held to fixtures/invoices.json; the file must say what this code builds.
test('fixtures/invoices.json is what invoice.cjs builds today', () => {
  const { made, FILE } = require('./fixtures/make-invoices.cjs');
  const file = JSON.parse(require('node:fs').readFileSync(FILE, 'utf8'));
  assert.deepEqual(file, made(), 'run  node mra/fixtures/make-invoices.cjs');
  assert.ok(file.cases.length >= 11);
});
