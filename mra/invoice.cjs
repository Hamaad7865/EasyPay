// An EasyPay sale as the MRA's e-invoice (the MRA's "Data Structure of an
// e-Invoice", v1.3.4). Amounts are integer cents here and strings of rupees
// with two decimals in the invoice. EasyPay's prices include VAT: the VAT in
// each line is taken out as the till does (android core/data/Calc), so the
// MRA is told what the receipt says.
//   - invoiceTotal = totalVatAmount + totalAmtWoVatCur
//   - totalAmtPaid = invoiceTotal - discountTotalAmount
//   - previousNoteHash: of the previous invoice of the same kind (STD, CRN,
//     DRN, PRF, TRN), from its fields as they were sent; "0" for the first.
const { previousNoteHash } = require('./crypto.cjs');

const money = (cents) => {
  const c = Math.round(cents);
  return `${Math.trunc(c / 100)}.${String(Math.abs(c % 100)).padStart(2, '0')}`;
};

// Mauritius is UTC+4 all year, with no summer time.
function mraDateTime(date) {
  const d = new Date(date.getTime() + 4 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// The VAT inside a VAT-included amount, rate in basis points (1500 = 15 %).
const vatIncluded = (gross, bp) => (bp > 0 ? Math.floor((gross * bp + Math.floor((10000 + bp) / 2)) / (10000 + bp)) : 0);

// One invoice. `lines`: { desc, qty (whole), unitPrice (cents, VAT included),
// taxCode (TC01..TC07), vatBp, nature (GOODS|SERVICES), code? }. `previous`:
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
    const gross = l.unitPrice * l.qty;
    const v = vatRegistered ? vatIncluded(gross, l.vatBp) : 0;
    vat += v;
    ex += gross - v;
    return {
      itemNo: String(i + 1),
      taxCode: l.taxCode,
      nature: l.nature,
      productCodeMra: '',
      productCodeOwn: l.code || '',
      itemDesc: l.desc,
      quantity: String(l.qty),
      unitPrice: money(Math.round((gross - v) / l.qty)),
      discount: '0.00',
      discountedValue: money(gross - v),
      amtWoVatCur: money(gross - v),
      amtWoVatMur: money(gross - v),
      vatAmt: money(v),
      totalPrice: money(gross),
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

module.exports = { money, mraDateTime, vatIncluded, build, chained, testCase1Lines, testCase2Lines, testCase3Lines };
