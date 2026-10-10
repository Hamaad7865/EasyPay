package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The example changes the server's own suite sends (db/tests/till-office.test.cjs
// swaps their stand-in ids for real ones). A test of the till builds the same
// change from the same stand-ins and holds it against the file, so that what
// the tablet sends is what the server was tested with.
object OfficeFixtures {
    // unit tests run in android/app
    private val dir = File("../../db/tests/fixtures/till-office")
    fun payload(name: String): JsonElement = Json.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject["payload"]!!
    fun type(name: String): String = Json.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject["type"].toString().trim('"')
}

// A tax on the till's own sheet, and the second page of an item's sheet: what
// is read of what was typed, why it cannot be saved yet, what the server's
// refusals read as, and what is sent.
class OfficeFormsTest {
    // ---- a tax ----
    @Test fun `a rate is a percentage from 0 to 100, with two decimals at most`() {
        assertEquals(1500, TaxForm.rateBp("15"))
        assertEquals(1250, TaxForm.rateBp("12.5"))
        assertEquals(725, TaxForm.rateBp(" 7,25 "))
        assertEquals(1500, TaxForm.rateBp("15 %"))
        assertEquals(0, TaxForm.rateBp("0"))
        assertEquals(10000, TaxForm.rateBp("100"))
        listOf("", "100.01", "101", "-1", "1.234", "abc", "1e2").forEach { assertNull(it, TaxForm.rateBp(it)) }
    }

    @Test fun `a rate is shown again as it would be typed`() {
        assertEquals(listOf("15", "12.5", "7.25", "0", "100", "0.05"), listOf(1500, 1250, 725, 0, 10000, 5).map { TaxForm.rate(it) })
        // and reads back as itself
        listOf(1500, 1250, 725, 0, 10000, 5).forEach { assertEquals(it, TaxForm.rateBp(TaxForm.rate(it))) }
        assertEquals("15% · included in the price", TaxForm.says(1500, "included"))
        assertEquals("7.5% · added on top", TaxForm.says(750, "added"))
    }

    @Test fun `a tax needs a name and a rate`() {
        assertEquals(TaxForm.Tax("VAT", 1500, added = false, usual = true), TaxForm.read("  VAT ", "15", added = false, usual = true).getOrThrow())
        assertEquals(30, TaxForm.read("n".repeat(80), "15", false, false).getOrThrow().name.length)
        assertEquals("Give the tax a name", TaxForm.read("   ", "15", false, false).exceptionOrNull()?.message)
        assertEquals("The rate is a percentage between 0 and 100", TaxForm.read("VAT", "150", false, false).exceptionOrNull()?.message)
        assertEquals("The rate is a percentage between 0 and 100", TaxForm.read("VAT", "", false, false).exceptionOrNull()?.message)
    }

    @Test fun `each refusal of a tax has its own sentence`() {
        val said = listOf("name-taken", "name-required", "bad-rate", "bad-tax", "conflict", "forbidden", "unknown-op").map { TaxForm.refused(it) }
        assertEquals(said.size, said.toSet().size)
        assertTrue(said.none { it.contains("refused it") })
        assertEquals("The server refused it.", TaxForm.refused(null))
        assertEquals("The server refused it (something-new).", TaxForm.refused("something-new"))
    }

    @Test fun `what is sent for a tax is the example the server was tested with`() {
        assertEquals("tax.save", OfficeFixtures.type("tax-save"))
        val tax = TaxForm.read("Tourist levy", "7.5", added = true, usual = false).getOrThrow()
        assertEquals(OfficeFixtures.payload("tax-save"), OfficePayloads.taxSave("tax-1", tax, null))
        val with = OfficePayloads.taxSave("tax-1", tax, "emp-manager")
        assertEquals("\"emp-manager\"", with["approved_by"].toString())
        assertEquals(OfficeFixtures.payload("tax-save"), JsonObject(with - "approved_by"))
    }

    // ---- the second page of an item's sheet ----
    private val polo = ItemForm.read("Polo shirt", "499", false, "6091234500017").getOrThrow()
    private val full = ItemForm.Typed(
        taxId = "tax-1", shop = true, costShown = true, cost = "170", skuShown = true, sku = " POLO-01 ",
        brand = "Maison", supplierId = "supplier-1", supplierCode = "M-POLO", reorder = "3", orderQty = "12",
    )

    @Test fun `a shop's second page read`() {
        val m = ItemForm.readMore(full).getOrThrow()
        assertEquals(listOf("tax-1", 17000L, "POLO-01", "Maison", "supplier-1", "M-POLO", 3000, 12000), listOf(m.taxId, m.cost, m.sku, m.brand, m.supplierId, m.supplierCode, m.reorder, m.orderQty))
        // by weight, a level is kilos with decimals; nothing typed is none, and nothing left is a level too
        val kilos = ItemForm.readMore(full.copy(reorder = "1,5", orderQty = "0")).getOrThrow()
        assertEquals(listOf(1500, 0), listOf(kilos.reorder, kilos.orderQty))
        val none = ItemForm.readMore(full.copy(cost = " ", sku = "", brand = " ", supplierId = null, supplierCode = "", reorder = "", orderQty = " ")).getOrThrow()
        assertEquals(listOf(null, null, null, null, null, null, null), listOf(none.cost, none.sku, none.brand, none.supplierId, none.supplierCode, none.reorder, none.orderQty))
        assertEquals(60, ItemForm.readMore(full.copy(sku = "s".repeat(90))).getOrThrow().sku?.length)
    }

    @Test fun `what is not a number is said before the tablet asks`() {
        assertEquals("The cost is not a number", ItemForm.readMore(full.copy(cost = "abc")).exceptionOrNull()?.message)
        assertEquals("Rs 1,000,000 is the most a product can cost", ItemForm.readMore(full.copy(cost = "2000000")).exceptionOrNull()?.message)
        assertEquals("The reorder level is not a number", ItemForm.readMore(full.copy(reorder = "-1")).exceptionOrNull()?.message)
        assertEquals("The order quantity is not a number", ItemForm.readMore(full.copy(orderQty = "a dozen")).exceptionOrNull()?.message)
        // a cost that was not shown is not read at all, whatever the box held
        assertNull(ItemForm.readMore(full.copy(costShown = false, cost = "abc")).getOrThrow().cost)
    }

    @Test fun `a restaurant's second page is its tax and nothing of a shop's`() {
        val m = ItemForm.readMore(ItemForm.Typed(taxId = "tax-1", shop = false, cost = "abc", sku = "X", reorder = "nonsense")).getOrThrow()
        assertEquals("tax-1", m.taxId)
        assertFalse(m.shop)
        assertEquals(listOf(null, null, null), listOf(m.cost, m.sku, m.reorder))
    }

    @Test fun `a quantity is shown again as it would be typed`() {
        assertEquals(listOf("", "3", "1.5", "0", "0.25", "12"), listOf(null, 3000, 1500, 0, 250, 12000).map { ItemForm.shown(it) })
    }

    @Test fun `what is sent for a product is the example the server was tested with`() {
        assertEquals("item.save", OfficeFixtures.type("item-save-full"))
        val m = ItemForm.readMore(full).getOrThrow()
        assertEquals(OfficeFixtures.payload("item-save-full"), OfficePayloads.itemSave("item-1", polo, "category-1", true, true, m, "store-1", null))
        // emptied: every field is sent as none, so the server clears it
        val none = ItemForm.readMore(full.copy(cost = "", sku = "", brand = "", supplierId = null, supplierCode = "", reorder = "", orderQty = ""), from = full.copy(taxId = "tax-0")).getOrThrow()
        val sent = OfficePayloads.itemSave("item-1", polo, "category-1", true, true, none, "store-1", null)
        assertEquals(OfficeFixtures.payload("item-save-cleared"), sent)
        assertEquals(JsonNull, sent["cost"])
    }

    @Test fun `a cost that was not shown, and the SKU of a product with variants, are not sent`() {
        val m = ItemForm.readMore(full.copy(costShown = false, skuShown = false)).getOrThrow()
        val sent = OfficePayloads.itemSave("item-1", polo, "category-1", true, true, m, "store-1", null)
        assertFalse(sent.containsKey("cost"))
        assertFalse(sent.containsKey("sku"))
        assertTrue(sent.containsKey("brand") && sent.containsKey("reorder_point"))
    }

    @Test fun `of a product being changed, only what was changed on the page is sent`() {
        // nothing touched: the tablet's copy may be older than the server's, so none of it goes
        val same = ItemForm.readMore(full, from = full).getOrThrow()
        val basic = setOf("id", "name", "price", "open_price", "category_id", "barcode", "available", "track_stock")
        assertEquals(basic, OfficePayloads.itemSave("item-1", polo, "category-1", true, true, same, "store-1", null).keys)
        // one field
        val brand = ItemForm.readMore(full.copy(brand = "Atelier"), from = full).getOrThrow()
        assertEquals(basic + "brand", OfficePayloads.itemSave("item-1", polo, "category-1", true, true, brand, "store-1", null).keys)
        // the tax
        val tax = ItemForm.readMore(full.copy(taxId = "tax-2"), from = full).getOrThrow()
        assertEquals(basic + "tax_id", OfficePayloads.itemSave("item-1", polo, "category-1", true, true, tax, "store-1", null).keys)
        // the two reorder figures go together, with the store they are for
        val level = ItemForm.readMore(full.copy(orderQty = "24"), from = full).getOrThrow()
        val sent = OfficePayloads.itemSave("item-1", polo, "category-1", true, true, level, "store-1", null)
        assertEquals(basic + setOf("store_id", "reorder_point", "reorder_qty"), sent.keys)
        assertEquals(listOf("3000", "24000"), listOf(sent["reorder_point"].toString(), sent["reorder_qty"].toString()))
        // spaces typed round a value are not a change
        assertEquals(basic, OfficePayloads.itemSave("item-1", polo, "category-1", true, true, ItemForm.readMore(full.copy(sku = "POLO-01"), from = full.copy(sku = " POLO-01 ")).getOrThrow(), "store-1", null).keys)
    }

    @Test fun `an item that carries no tax is not given one by opening its sheet`() {
        assertEquals("usual", ItemForm.startTax(new = true, own = null, usual = "usual"))
        assertNull(ItemForm.startTax(new = false, own = null, usual = "usual"))
        assertEquals("own", ItemForm.startTax(new = false, own = "own", usual = "usual"))
        // and with none picked, none is sent, new or not
        val dish = ItemForm.read("Dholl puri", "25", false, "").getOrThrow()
        val untaxed = ItemForm.readMore(ItemForm.Typed(taxId = null, shop = false)).getOrThrow()
        assertFalse(OfficePayloads.itemSave("item-1", dish, "category-1", true, false, untaxed, "store-1", null).containsKey("tax_id"))
    }

    @Test fun `a restaurant's item is sent with its tax and none of a shop's keys`() {
        val dish = ItemForm.read("Dholl puri", "25", false, "").getOrThrow()
        val m = ItemForm.readMore(ItemForm.Typed(taxId = "tax-1", shop = false)).getOrThrow()
        assertEquals(OfficeFixtures.payload("item-save-tax"), OfficePayloads.itemSave("item-1", dish, "category-1", true, false, m, "store-1", null))
    }

    @Test fun `a sheet with no second page sends what it always sent`() {
        val sent = OfficePayloads.itemSave("item-1", polo, null, true, null, null, "store-1", "emp-manager")
        assertEquals(setOf("id", "name", "price", "open_price", "category_id", "barcode", "available", "approved_by"), sent.keys)
        assertEquals("\"\"", sent["category_id"].toString())
    }

    @Test fun `the new refusals of an item have their own sentences`() {
        val said = listOf("bad-tax", "unknown-supplier", "bad-store", "bad-quantity", "sku-taken", "barcode-taken").map { ItemForm.refused(it, shop = true) }
        assertEquals(said.size, said.toSet().size)
        assertTrue(said.none { it.contains("refused it") })
    }
}
