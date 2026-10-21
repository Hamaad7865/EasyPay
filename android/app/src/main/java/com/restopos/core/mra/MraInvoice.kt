package com.restopos.core.mra

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.abs

// An EasyPay receipt as the MRA's e-invoice (its data structure v1.3.4), as
// mra/invoice.cjs builds it, held to mra/fixtures/invoices.json and to the
// invoices the MRA's sandbox fiscalised. The rules, field by field, are in
// docs/superpowers/plans/2026-10-21-mra-phase-2-till.md ("How a sale becomes
// an invoice"). Amounts are integer cents here, strings of rupees there.
data class Seller(
    val name: String,
    val tradeName: String,
    val tan: String,
    val brn: String,
    val businessAddr: String,
    val businessPhoneNo: String = "",
    val vatRegistered: Boolean = true,
)

// One line: qtyMilli in thousandths; base what it charges before the order
// discount (add-ons in); share its part of that discount, as Calc spreads it;
// vatBp its tax rate; added when the tax goes on top of the price; vat the
// VAT as given, for a refund's line (RefundCalc's), else worked out.
data class Line(
    val desc: String,
    val code: String,
    val taxCode: String,
    val nature: String,
    val qtyMilli: Int,
    val base: Long,
    val share: Long = 0,
    val vatBp: Int = 0,
    val added: Boolean = false,
    val vat: Long? = null,
)

// What the next invoice of the same type hashes, as this one was sent.
data class Chained(val dateTime: String, val totalAmtPaid: String, val brn: String, val invoiceIdentifier: String)

object MraInvoice {
    data class Input(
        val counter: Long,
        val identifier: String,
        val type: String,
        val previous: Chained?,
        val issuedAt: Long,
        val seller: Seller,
        val lines: List<Line>,
        val payment: String,
        // the cents of the order discount the lines' shares did not take
        val discount: Long = 0,
        val transaction: String = "B2C",
        val counterNo: String = "1",
        val cashier: String = "",
        val ref: String = "",
        val reason: String = "",
    )

    class Built(val json: MraJson.Obj, val chained: Chained) {
        val text: String get() = MraJson.encode(json)
    }

    fun money(cents: Long): String {
        val a = abs(cents)
        return (if (cents < 0) "-" else "") + (a / 100) + "." + (a % 100).toString().padStart(2, '0')
    }

    // thousandths, as the till keeps a quantity, as a plain number
    fun qtyText(milli: Int): String {
        val rest = (abs(milli) % 1000).toString().padStart(3, '0').trimEnd('0')
        return if (rest.isEmpty()) (milli / 1000).toString() else "${milli / 1000}.$rest"
    }

    // Mauritius is UTC+4 all year, with no summer time
    private val MRA_TIME = DateTimeFormatter.ofPattern("yyyyMMdd HH:mm:ss").withZone(ZoneOffset.ofHours(4))
    fun mraDateTime(epochMs: Long): String = MRA_TIME.format(Instant.ofEpochMilli(epochMs))

    // as core/data/Calc: the VAT inside an amount, and the VAT on top of one
    fun vatIncluded(gross: Long, bp: Int): Long = if (bp > 0) (gross * bp + (10000 + bp) / 2) / (10000 + bp) else 0
    fun vatAdded(net: Long, bp: Int): Long = if (bp > 0) (net * bp + 5000) / 10000 else 0

    // what one line comes to: without VAT before and after its part of the
    // order discount, and its VAT
    class Figures(val exBefore: Long, val ex: Long, val vat: Long)
    fun figures(l: Line, vatRegistered: Boolean): Figures {
        val net = l.base - l.share
        val vat = if (!vatRegistered) 0 else l.vat ?: if (l.added) vatAdded(net, l.vatBp) else vatIncluded(net, l.vatBp)
        val exBefore = if (!vatRegistered || l.added) l.base else l.base - vatIncluded(l.base, l.vatBp)
        return Figures(exBefore, if (l.added) net else net - vat, vat)
    }

    fun build(i: Input): Built {
        if (i.type == "CRN" || i.type == "DRN") {
            require(i.ref.isNotEmpty()) { "A ${i.type} names the invoice it corrects." }
            require(i.reason.isNotEmpty()) { "A ${i.type} gives its reason." }
        }
        var vat = 0L
        var ex = 0L
        val items = i.lines.mapIndexed { n, l ->
            val f = figures(l, i.seller.vatRegistered)
            vat += f.vat
            ex += f.ex
            MraJson.obj(
                "itemNo" to (n + 1).toString(),
                "taxCode" to l.taxCode,
                "nature" to l.nature,
                "productCodeMra" to "",
                "productCodeOwn" to l.code,
                "itemDesc" to l.desc,
                "quantity" to qtyText(l.qtyMilli),
                // JavaScript's Math.round: half up
                "unitPrice" to money((f.exBefore * 1000 * 2 + l.qtyMilli) / (2L * l.qtyMilli)),
                "discount" to money(f.exBefore - f.ex),
                "discountedValue" to money(f.ex),
                "amtWoVatCur" to money(f.ex),
                "amtWoVatMur" to money(f.ex),
                "vatAmt" to money(f.vat),
                "totalPrice" to money(f.ex + f.vat),
            )
        }
        val total = vat + ex
        val at = mraDateTime(i.issuedAt)
        val paid = money(total - i.discount)
        val json = MraJson.obj(
            "invoiceCounter" to i.counter.toString(),
            "transactionType" to i.transaction,
            "personType" to (if (i.seller.vatRegistered) "VATR" else "NVTR"),
            "invoiceTypeDesc" to i.type,
            "currency" to "MUR",
            "invoiceIdentifier" to i.identifier,
            "invoiceRefIdentifier" to i.ref,
            "previousNoteHash" to MraCrypto.previousNoteHash(i.previous),
            "reasonStated" to i.reason.take(100),
            "totalVatAmount" to money(vat),
            "totalAmtWoVatCur" to money(ex),
            "totalAmtWoVatMur" to money(ex),
            "invoiceTotal" to money(total),
            "discountTotalAmount" to money(i.discount),
            "totalAmtPaid" to paid,
            "dateTimeInvoiceIssued" to at,
            "seller" to MraJson.obj(
                "name" to i.seller.name,
                "tradeName" to i.seller.tradeName,
                "tan" to i.seller.tan,
                "brn" to i.seller.brn,
                "businessAddr" to i.seller.businessAddr,
                "businessPhoneNo" to i.seller.businessPhoneNo,
                "ebsCounterNo" to i.counterNo,
                "cashierID" to i.cashier,
            ),
            "buyer" to MraJson.obj("name" to "", "tan" to "", "brn" to "", "businessAddr" to "", "buyerType" to "NVTR", "nic" to ""),
            "itemList" to MraJson.arr(items),
            "salesTransactions" to i.payment,
        )
        return Built(json, Chained(at, paid, i.seller.brn, i.identifier))
    }

    // a request's invoices, as JSON.stringify writes a list of them
    fun list(invoices: List<String>): String = invoices.joinToString(",", "[", "]")
}
