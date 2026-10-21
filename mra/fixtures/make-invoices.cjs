// Writes fixtures/invoices.json: invoices built by invoice.cjs from fixed
// inputs, with a made-up seller. The till's Kotlin builds the same inputs and
// must give the same bytes (android .../core/mra/MraInvoiceTest.kt).
// invoice.test.cjs checks this file still matches the code.
//   node mra/fixtures/make-invoices.cjs
const fs = require('node:fs');
const path = require('node:path');
const inv = require('../invoice.cjs');

function cases() {
  const seller = { name: 'Made Up Ltd', tradeName: 'Made Up', tan: '12345678', brn: 'C07000000', businessAddr: 'Royal Road, Bel Air', businessPhoneNo: '+2302076000', vat: 'VATR' };
  const at = Date.UTC(2026, 9, 21, 10, 0, 0);
  const line = (desc, qtyMilli, base, more = {}) => ({ desc, code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli, base, share: 0, vatBp: 1500, added: false, ...more });
  const t1 = inv.testCase1Lines().map(inv.general);
  const first = { counter: 1, identifier: 'MU-T1-000001', type: 'STD', previous: null, issuedAt: at, seller, lines: t1, payment: 'CASH' };
  const ten = [];
  for (let i = 0, prev = null; i < 10; i++) {
    const input = { ...first, counter: 10 + i, identifier: `MU-T1-${String(10 + i).padStart(6, '0')}`, previous: prev, lines: inv.testCase4Lines(i).map(inv.general) };
    ten.push(input);
    prev = inv.chained(build(input));
  }
  return [
    { name: 'test case 1', input: first },
    { name: 'chained to the first', input: { ...first, counter: 2, identifier: 'MU-T1-000002', issuedAt: at + 60_000, previous: inv.chained(build(first)) } },
    { name: 'a credit note', input: { ...first, counter: 3, identifier: 'MU-T1-R000003', type: 'CRN', ref: 'MU-T1-000002', reason: 'Return of product', lines: inv.testCase3Lines().map(inv.general) } },
    { name: 'training', input: { ...first, counter: 4, identifier: 'TRN00000004', type: 'TRN', lines: inv.testCase7Lines().map(inv.general) } },
    { name: 'not registered for VAT', input: { ...first, seller: { ...seller, vat: 'NVTR' } } },
    // Calc: 100.00 off 300.03 is 33.33 and 66.66 on the lines, a cent left over
    { name: 'a discount over two lines, a cent left', input: { ...first, discount: 1, lines: [line('A', 1000, 10001, { share: 3333 }), line('B', 2000, 20002, { share: 6666, taxCode: 'TC03', vatBp: 0 })] } },
    { name: 'VAT on top', input: { ...first, lines: [line('Cake', 1000, 10000, { code: 'CK', added: true })] } },
    { name: 'by the kilo', input: { ...first, lines: [line('Prawns', 250, 20000)] } },
    { name: 'service charge', input: { ...first, lines: [...t1, line('Service charge', 1000, 3000, { taxCode: 'TC03', nature: 'SERVICES', vatBp: 0 })] } },
    { name: 'escaping', input: { ...first, cashier: 'Zoë', lines: [line('Say "hi" \\ café\t€ \u0001', 1000, 11500)] } },
    { name: 'ten in one request', input: ten },
  ];
}

function build(input) {
  return inv.build({ ...input, issuedAt: new Date(input.issuedAt) });
}

function made() {
  return {
    about: 'Invoices built by mra/invoice.cjs from fixed inputs (a made-up seller). The till builds the same inputs and must give the same bytes. Made by node mra/fixtures/make-invoices.cjs.',
    cases: cases().map(({ name, input }) => ({ name, input, expected: JSON.stringify(Array.isArray(input) ? input.map(build) : build(input)) })),
  };
}

const FILE = path.join(__dirname, 'invoices.json');
if (require.main === module) fs.writeFileSync(FILE, JSON.stringify(made(), null, 2) + '\n');

module.exports = { made, FILE };
