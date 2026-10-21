package com.restopos.core.mra

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

// The till builds the invoices mra/invoice.cjs builds, byte for byte
// (mra/fixtures/invoices.json, made by mra/fixtures/make-invoices.cjs).
class MraInvoiceTest {
    @Test fun everyFixtureIsBuiltByteForByte() {
        val cases = Json.parseToJsonElement(repoFile("mra/fixtures/invoices.json").readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size >= 11)
        cases.forEach { c ->
            val o = c.jsonObject
            val input = o["input"]!!
            val built = if (input is JsonArray) MraInvoice.list(input.map { MraInvoice.build(input(it.jsonObject)).text })
            else MraInvoice.build(input(input.jsonObject)).text
            assertEquals(o["name"]!!.jsonPrimitive.content, o["expected"]!!.jsonPrimitive.content, built)
        }
    }

    @Test fun moneyAndQuantities() {
        assertEquals("115.00", MraInvoice.money(11500)); assertEquals("0.05", MraInvoice.money(5)); assertEquals("0.00", MraInvoice.money(0))
        assertEquals("-0.05", MraInvoice.money(-5)); assertEquals("-115.00", MraInvoice.money(-11500))
        assertEquals("2", MraInvoice.qtyText(2000)); assertEquals("0.25", MraInvoice.qtyText(250)); assertEquals("1.125", MraInvoice.qtyText(1125))
    }

    // Mauritius is UTC+4 all year, whatever the tablet is set to
    @Test fun mauritiusTime() {
        assertEquals("20261021 16:05:09", MraInvoice.mraDateTime(Instant.parse("2026-10-21T12:05:09Z").toEpochMilli()))
        assertEquals("20261022 02:00:00", MraInvoice.mraDateTime(Instant.parse("2026-10-21T22:00:00Z").toEpochMilli()))
    }

    @Test fun theVatIsWorkedOutAsTheTillWorksItOut() {
        assertEquals(1500, MraInvoice.vatIncluded(11500, 1500)); assertEquals(1304, MraInvoice.vatIncluded(9999, 1500)); assertEquals(0, MraInvoice.vatIncluded(5000, 0))
        assertEquals(1500, MraInvoice.vatAdded(10000, 1500)); assertEquals(1360, MraInvoice.vatAdded(9066, 1500))
    }

    @Test fun aNoteNamesWhatItCorrectsAndWhy() {
        val l = listOf(Line("Tea", "", "TC01", "GOODS", 1000, 2300, vatBp = 1500))
        val base = MraInvoice.Input(1, "EP-1", "CRN", null, 0, Seller("A", "A", "1", "B", "X"), l, "CASH")
        assertThrows(IllegalArgumentException::class.java) { MraInvoice.build(base.copy(reason = "Returned")) }
        assertThrows(IllegalArgumentException::class.java) { MraInvoice.build(base.copy(type = "DRN", ref = "EP-0")) }
        assertEquals("EP-0", MraInvoice.build(base.copy(ref = "EP-0", reason = "Returned")).json.fields.first { it.first == "invoiceRefIdentifier" }.second.let { (it as MraJson.Str).v })
    }

    @Test fun whatTheNextOneHashesIsThisOneAsSent() {
        val b = MraInvoice.build(MraInvoice.Input(1, "EP-1", "STD", null, Instant.parse("2026-10-21T08:00:00Z").toEpochMilli(),
            Seller("A", "A", "1", "C07012345", "X"), listOf(Line("Tea", "", "TC01", "GOODS", 1000, 2300, vatBp = 1500)), "CASH"))
        assertEquals(Chained("20261021 12:00:00", "23.00", "C07012345", "EP-1"), b.chained)
    }

    companion object {
        private fun JsonObject.s(k: String): String = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content ?: ""

        // an input of invoices.json, as invoice.cjs took it
        fun input(o: JsonObject): MraInvoice.Input {
            val seller = o["seller"]!!.jsonObject
            val prev = o["previous"]?.takeIf { it !is JsonNull }?.jsonObject
            return MraInvoice.Input(
                counter = o["counter"]!!.jsonPrimitive.long, identifier = o.s("identifier"), type = o.s("type"),
                previous = prev?.let { Chained(it.s("dateTime"), it.s("totalAmtPaid"), it.s("brn"), it.s("invoiceIdentifier")) },
                issuedAt = o["issuedAt"]!!.jsonPrimitive.long,
                seller = Seller(seller.s("name"), seller.s("tradeName"), seller.s("tan"), seller.s("brn"), seller.s("businessAddr"), seller.s("businessPhoneNo"), seller.s("vat") != "NVTR"),
                lines = o["lines"]!!.jsonArray.map { line(it.jsonObject) },
                payment = o.s("payment"),
                discount = o["discount"]?.jsonPrimitive?.long ?: 0,
                transaction = o.s("transaction").ifEmpty { "B2C" },
                counterNo = o.s("counterNo").ifEmpty { "1" },
                cashier = o.s("cashier"), ref = o.s("ref"), reason = o.s("reason"),
            )
        }

        private fun line(l: JsonObject) = Line(
            l.s("desc"), l.s("code"), l.s("taxCode"), l.s("nature"), l["qtyMilli"]!!.jsonPrimitive.int, l["base"]!!.jsonPrimitive.long,
            l["share"]?.jsonPrimitive?.long ?: 0, l["vatBp"]?.jsonPrimitive?.int ?: 0, l["added"]?.jsonPrimitive?.boolean ?: false,
            l["vat"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.long,
        )

        // a JSON tree read from a file, in the file's order, as MraJson writes it
        fun tree(e: JsonElement): MraJson.J = when (e) {
            is JsonObject -> MraJson.Obj(e.entries.map { (k, v) -> k to tree(v) })
            is JsonArray -> MraJson.Arr(e.map { tree(it) })
            else -> MraJson.Str(e.jsonPrimitive.content)
        }
    }
}
