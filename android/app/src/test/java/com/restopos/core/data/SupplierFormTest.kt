package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The example changes the server's own suite sends (db/tests/till-stock.test.cjs
// swaps their stand-in ids for real ones). A test of the till builds the same
// change from the same stand-ins and holds it against the file, so that what
// the tablet sends is what the server was tested with.
object StockFixtures {
    // unit tests run in android/app
    private val dir = File("../../db/tests/fixtures/till-stock")
    fun payload(name: String): JsonElement = Json.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject["payload"]!!
    fun type(name: String): String = Json.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject["type"].toString().trim('"')
}

// A supplier on the till's own sheet: what is kept of what was typed, why it
// cannot be saved yet, what the server's refusal reads as, and what is sent.
class SupplierFormTest {
    private val typed = SupplierForm.Supplier("Maurilait", "Devi", "52501234", "", "Phoenix", "")

    @Test fun `what is kept is what was typed, less the spaces around it and cut to the server's lengths`() {
        val s = SupplierForm.clean(SupplierForm.Supplier("  Maurilait ", " Devi", "5250 1234 ", " a@b.mu ", " Phoenix ", " Tuesdays "))
        assertEquals(SupplierForm.Supplier("Maurilait", "Devi", "5250 1234", "a@b.mu", "Phoenix", "Tuesdays"), s)
        val long = SupplierForm.clean(SupplierForm.Supplier("n".repeat(300), "c".repeat(300), "p".repeat(300), "e".repeat(300), "a".repeat(300), "o".repeat(300)))
        assertEquals(listOf(120, 120, 40, 120, 200, 200), listOf(long.name, long.contact, long.phone, long.email, long.address, long.note).map { it.length })
    }

    @Test fun `a supplier needs a name and nothing else`() {
        assertEquals("A supplier needs a name.", SupplierForm.problem(SupplierForm.Supplier("   ")))
        assertNull(SupplierForm.problem(SupplierForm.Supplier("Maurilait")))
    }

    @Test fun `each refusal has its own sentence`() {
        val codes = listOf("name-taken", "name-required", "unknown-supplier", "forbidden", "conflict", "unknown-op")
        val said = codes.map { SupplierForm.refused(it) }
        assertEquals(said.size, said.toSet().size)
        assertTrue(said.none { it.contains("refused it") })
        assertEquals("The server refused it.", SupplierForm.refused(null))
        assertEquals("The server refused it (something-new).", SupplierForm.refused("something-new"))
    }

    @Test fun `what is sent for a supplier is the example the server was tested with`() {
        assertEquals("supplier.save", StockFixtures.type("supplier-save"))
        assertEquals(StockFixtures.payload("supplier-save"), StockPayloads.supplierSave("supplier-1", typed, null))
        assertEquals("supplier.remove", StockFixtures.type("supplier-remove"))
        assertEquals(StockFixtures.payload("supplier-remove"), StockPayloads.supplierRemove("supplier-1", null))
    }

    @Test fun `someone's word goes with it and changes nothing else`() {
        val with = StockPayloads.supplierSave("supplier-1", typed, "emp-manager")
        assertEquals("\"emp-manager\"", with["approved_by"].toString())
        assertEquals(StockFixtures.payload("supplier-save"), kotlinx.serialization.json.JsonObject(with - "approved_by"))
    }
}
