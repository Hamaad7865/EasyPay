package com.restopos.core.mra

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

// The till builds, byte for byte, the invoices the MRA's sandbox actually
// fiscalised on 2026-10-21. Those files are in .claude/mra/out on the owner's
// computer only (kept out of git): anywhere else this test is skipped.
class MraSandboxInvoicesTest {
    // the MRA's test case 1, by the code each item carries (mra/invoice.cjs)
    private class Item(val desc: String, val unitPrice: Long, val taxCode: String, val vatBp: Int)
    private val byCode = mapOf(
        "TC1-A" to Item("Chicken curry", 11500, "TC01", 1500), "TC1-B" to Item("Fried noodles", 23000, "TC01", 1500),
        "TC1-C" to Item("Soft drink", 5750, "TC01", 1500), "TC1-D" to Item("Bread", 1250, "TC03", 0),
        "TC1-E" to Item("Milk", 4000, "TC03", 0), "TC1-F" to Item("Rice 1 kg", 2500, "TC03", 0),
    )

    // the owner's probe-mixed (mra/invoice.cjs probeMixed): a till's lines, by code, its service line by its name
    private val probe = mapOf(
        "PM-A" to Line("Chicken curry", "PM-A", "TC01", "GOODS", 1000, 11500, 1074, 1500),
        "PM-B" to Line("Prawns (kg)", "PM-B", "TC01", "GOODS", 250, 20000, 1869, 1500),
        "PM-C" to Line("Cake", "PM-C", "TC01", "GOODS", 1000, 10000, 934, 1500, added = true),
        "PM-D" to Line("Burger (Egg)", "PM-D", "TC01", "GOODS", 1000, 12000, 1121, 1500),
        "Service charge" to Line("Service charge", "", "TC03", "SERVICES", 1000, 4850),
    )

    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content

    @Test fun everyInvoiceTheMraFiscalisedIsWhatTheTillBuilds() {
        val dir = sandboxOut()
        assumeTrue("no .claude/mra/out on this computer", dir != null)
        val sent = dir!!.listFiles { f -> f.name.matches(Regex("invoice-.*\\.json")) }!!.sortedBy { it.name }
            .flatMap { Json.parseToJsonElement(it.readText()).jsonArray.map { x -> x.jsonObject } }
        assertTrue("only ${sent.size} invoices", sent.size >= 18)
        fun chained(x: JsonObject) = Chained(x.s("dateTimeInvoiceIssued"), x.s("totalAmtPaid"), x["seller"]!!.jsonObject.s("brn"), x.s("invoiceIdentifier"))
        sent.forEach { x ->
            val previous = if (x.s("previousNoteHash") == "0") null else {
                // probe-chain chained to an invoice the MRA never saw: EPTSTD999999, Rs 1.00, dated as it was sent
                val at = MraApi.mraMoment(x.s("dateTimeInvoiceIssued"))!!
                val madeUp = listOf(0L, 1000L).map { Chained(MraInvoice.mraDateTime(at - it), "1.00", x["seller"]!!.jsonObject.s("brn"), "EPTSTD999999") }
                val before = (sent.filter { y -> y.s("invoiceTypeDesc") == x.s("invoiceTypeDesc") }.map { chained(it) } + madeUp)
                    .firstOrNull { MraCrypto.previousNoteHash(it) == x.s("previousNoteHash") }
                assertNotNull("${x.s("invoiceIdentifier")}: no invoice of its kind hashes to its previousNoteHash", before)
                before!!
            }
            val s = x["seller"]!!.jsonObject
            val lines = x["itemList"]!!.jsonArray.map { e ->
                val it = e.jsonObject
                val item = byCode[it.s("productCodeOwn")]
                if (item == null) probe.getValue(it.s("productCodeOwn").ifEmpty { it.s("itemDesc") })
                else {
                    val qty = it.s("quantity").toInt()
                    Line(item.desc, it.s("productCodeOwn"), item.taxCode, it.s("nature"), qty * 1000, item.unitPrice * qty, vatBp = item.vatBp)
                }
            }
            val built = MraInvoice.build(MraInvoice.Input(
                counter = x.s("invoiceCounter").toLong(), identifier = x.s("invoiceIdentifier"), type = x.s("invoiceTypeDesc"), previous = previous,
                issuedAt = MraApi.mraMoment(x.s("dateTimeInvoiceIssued"))!!,
                seller = Seller(s.s("name"), s.s("tradeName"), s.s("tan"), s.s("brn"), s.s("businessAddr"), s.s("businessPhoneNo"), x.s("personType") == "VATR"),
                lines = lines, payment = x.s("salesTransactions"), discount = Math.round(x.s("discountTotalAmount").toDouble() * 100),
                transaction = x.s("transactionType"), counterNo = s.s("ebsCounterNo"), cashier = s.s("cashierID"),
                ref = x.s("invoiceRefIdentifier"), reason = x.s("reasonStated"),
            ))
            assertEquals(x.s("invoiceIdentifier"), MraJson.encode(MraInvoiceTest.tree(x)), built.text)
        }
    }
}
