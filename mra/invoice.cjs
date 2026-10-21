// An EasyPay sale as the MRA's e-invoice (the MRA's "Data Structure of an
// e-Invoice", v1.3.4). Amounts are integer cents here and strings of rupees
// with two decimals in the invoice. EasyPay's prices include VAT: the VAT in
// each line is taken out as the till does (android core/data/Calc), so the
// MRA is told what the receipt says.
//   - invoiceTotal = totalVatAmount + totalAmtWoVatCur
//   - totalAmtPaid = invoiceTotal - discountTotalAmount
//   - previousNoteHash: of the previous invoice of the same kind (STD, CRN,
//     DRN, PRF, TRN), from its fields as they were sent; "0" for the first.
// A line is a till's line (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md,
// "How a sale becomes an invoice"): qtyMilli in thousandths, base what it
// charges before the order discount (add-ons in), share its part of that
// discount as core/data/Calc spreads it, vatBp its rate, added when the VAT
// goes on top. A test case's line (a whole qty, a unitPrice with VAT inside)
// is taken too. The till's Kotlin is held to the same rules
// (fixtures/invoices.json).
const { previousNoteHash } = require('./crypto.cjs');

const money = (cents) => {
  const c = Math.round(cents);
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

// thousandths, as the till keeps a quantity, as a plain number
const qtyText = (milli) => {
  const rest = String(Math.abs(milli % 1000)).padStart(3, '0').replace(/0+$/, '');
  return rest ? `${Math.trunc(milli / 1000)}.${rest}` : String(Math.trunc(milli / 1000));
};

// Mauritius is UTC+4 all year, with no summer time.
function mraDateTime(date) {
  const d = new Date(date.getTime() + 4 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// The VAT inside a VAT-included amount, rate in basis points (1500 = 15 %).
const vatIncluded = (gross, bp) => (bp > 0 ? Math.floor((gross * bp + Math.floor((10000 + bp) / 2)) / (10000 + bp)) : 0);
// The VAT that goes on top of an amount (Calc: (net * rate + 5000) / 10000).
const vatAdded = (net, bp) => (bp > 0 ? Math.floor((net * bp + 5000) / 10000) : 0);

// A test case's line (a whole quantity, a price with VAT inside) as a till's line.
const general = (l) => ({ desc: l.desc, code: l.code || '', taxCode: l.taxCode, nature: l.nature, qtyMilli: l.qty * 1000, base: l.unitPrice * l.qty, share: 0, vatBp: l.vatBp, added: false });

// What one line comes to, in cents: without VAT before and after its part of
// the order discount, and its VAT, worked out as the till works it out. A
// refund's line brings its VAT as the till's refund worked it out (vat).
function figures({ base, share = 0, vatBp = 0, added = false, vat: given = null }, vatRegistered) {
  const net = base - share;
  const vat = !vatRegistered ? 0 : given != null ? given : added ? vatAdded(net, vatBp) : vatIncluded(net, vatBp);
  const exBefore = !vatRegistered || added ? base : base - vatIncluded(base, vatBp);
  return { exBefore, ex: added ? net : net - vat, vat };
}

// One invoice. `lines`: till's lines { desc, code, taxCode (TC01..TC07),
// nature (GOODS|SERVICES), qtyMilli, base, share, vatBp, added }, or a test
// case's { desc, qty (whole), unitPrice (cents, VAT included), taxCode,
// vatBp, nature, code? }. `discount`: what the lines' shares left of the
// order discount (cents). `previous`:
// what chained() gave for the last invoice of this type, or null. A credit or
// debit note (CRN, DRN) names the invoice it corrects (`ref`, its identifier)
// and why (`reason`, up to 100 characters): both mandatory for those two.
function build({ counter, identifier, type, previous, issuedAt, seller, lines, payment, discount = 0, transaction = 'B2C', counterNo = '1', cashier = '', ref = '', reason = '' }) {
  if (type === 'CRN' || type === 'DRN') {
    if (!ref) throw new Error(`A ${type} names the invoice it corrects.`);
    if (!reason) throw new Error(`A ${type} gives its reason.`);
  }
  const vatRegistered = seller.vat !== 'NVTR';
  let vat = 0, ex = 0;
  const itemList = lines.map((l, i) => {
    const L = l.qtyMilli != null ? l : general(l);
    const f = figures(L, vatRegistered);
    vat += f.vat;
    ex += f.ex;
    return {
      itemNo: String(i + 1),
      taxCode: L.taxCode,
      nature: L.nature,
      productCodeMra: '',
      productCodeOwn: L.code || '',
      itemDesc: L.desc,
      quantity: qtyText(L.qtyMilli),
      unitPrice: money(Math.round((f.exBefore * 1000) / L.qtyMilli)),
      discount: money(f.exBefore - f.ex),
      discountedValue: money(f.ex),
      amtWoVatCur: money(f.ex),
      amtWoVatMur: money(f.ex),
      vatAmt: money(f.vat),
      totalPrice: money(f.ex + f.vat),
    };
  });
  const total = vat + ex;
  return {
    invoiceCounter: String(counter),
    transactionType: transaction,
    personType: vatRegistered ? 'VATR' : 'NVTR',
    invoiceTypeDesc: type,
    currency: 'MUR',
    invoiceIdentifier: identifier,
    invoiceRefIdentifier: ref,
    previousNoteHash: previousNoteHash(previous),
    reasonStated: reason.slice(0, 100),
    totalVatAmount: money(vat),
    totalAmtWoVatCur: money(ex),
    totalAmtWoVatMur: money(ex),
    invoiceTotal: money(total),
    discountTotalAmount: money(discount),
    totalAmtPaid: money(total - discount),
    dateTimeInvoiceIssued: mraDateTime(issuedAt),
    seller: {
      name: seller.name,
      tradeName: seller.tradeName,
      tan: seller.tan,
      brn: seller.brn,
      businessAddr: seller.businessAddr,
      businessPhoneNo: seller.businessPhoneNo || '',
      ebsCounterNo: counterNo,
      cashierID: cashier,
    },
    buyer: { name: '', tan: '', brn: '', businessAddr: '', buyerType: 'NVTR', nic: '' },
    itemList,
    salesTransactions: payment,
  };
}

// What the next invoice of the same type hashes, as this one was sent.
const chained = (invoice) => ({
  dateTime: invoice.dateTimeInvoiceIssued,
  totalAmtPaid: invoice.totalAmtPaid,
  brn: invoice.seller.brn,
  invoiceIdentifier: invoice.invoiceIdentifier,
});

// The MRA's test case 1: 6 items, 3 with VAT (TC01) and 3 exempt (TC03).
const testCase1Lines = () => [
  { desc: 'Chicken curry', qty: 1, unitPrice: 11500, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS', code: 'TC1-A' },
  { desc: 'Fried noodles', qty: 2, unitPrice: 23000, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS', code: 'TC1-B' },
  { desc: 'Soft drink', qty: 2, unitPrice: 5750, taxCode: 'TC01', vatBp: 1500, nature: 'GOODS', code: 'TC1-C' },
  { desc: 'Bread', qty: 3, unitPrice: 1250, taxCode: 'TC03', vatBp: 0, nature: 'GOODS', code: 'TC1-D' },
  { desc: 'Milk', qty: 1, unitPrice: 4000, taxCode: 'TC03', vatBp: 0, nature: 'GOODS', code: 'TC1-E' },
  { desc: 'Rice 1 kg', qty: 1, unitPrice: 2500, taxCode: 'TC03', vatBp: 0, nature: 'GOODS', code: 'TC1-F' },
];

// Test case 2, a debit note of 1 item: a curry served and left off the invoice.
const testCase2Lines = () => [testCase1Lines()[0]];
// Test case 3, a credit note of 1 item: one soft drink brought back.
const testCase3Lines = () => [{ ...testCase1Lines()[2], qty: 1 }];

// Test case 4, invoice i of the 10 sent in one request: an item with VAT and one without.
const testCase4Lines = (i) => { const l = testCase1Lines(); return [l[i % 3], l[3 + (i % 3)]]; };
// Test case 5, 1 item (sent with a TAN that is not the seller's, to be refused).
const testCase5Lines = () => [testCase1Lines()[0]];
// Test case 6, a pro forma, and 7, a training invoice: 2 items each.
const testCase6Lines = () => { const l = testCase1Lines(); return [l[1], l[4]]; };
const testCase7Lines = () => { const l = testCase1Lines(); return [l[2], l[5]]; };

// The owner's test of a real sale in the sandbox (the phase 2 plan, D3), as
// the till would send it: Rs 50 off a bill of four lines, spread as Calc
// spreads it (1074, 1869, 934, 1121; the 2 cents left are the invoice's own
// discount), a kilo line, VAT on top, an add-on, then 10 % service charge on
// what is left (Rs 48.50), exempt and a service. The total is Calc's: 547.10.
const probeMixed = () => ({
  lines: [
    { desc: 'Chicken curry', code: 'PM-A', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 11500, share: 1074, vatBp: 1500, added: false },
    { desc: 'Prawns (kg)', code: 'PM-B', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 250, base: 20000, share: 1869, vatBp: 1500, added: false },
    { desc: 'Cake', code: 'PM-C', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 10000, share: 934, vatBp: 1500, added: true },
    { desc: 'Burger (Egg)', code: 'PM-D', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 12000, share: 1121, vatBp: 1500, added: false },
    { desc: 'Service charge', code: '', taxCode: 'TC03', nature: 'SERVICES', qtyMilli: 1000, base: 4850, share: 0, vatBp: 0, added: false },
  ],
  discount: 2,
});

module.exports = { probeMixed, money, qtyText, mraDateTime, vatIncluded, vatAdded, general, figures, build, chained, testCase1Lines, testCase2Lines, testCase3Lines, testCase4Lines, testCase5Lines, testCase6Lines, testCase7Lines };
