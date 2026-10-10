package com.restopos.core.data

import com.restopos.core.database.AloneDao
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.RoleEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.StockMovementEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TaxEntity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The tablet's own copy of its rows, held in memory: what LocalAnswers reads and writes.
class FakeAlone : AloneDao {
    val items = LinkedHashMap<String, ItemEntity>()
    val categories = LinkedHashMap<String, CategoryEntity>()
    val taxes = LinkedHashMap<String, TaxEntity>()
    val itemTaxes = ArrayList<ItemTaxCrossRef>()
    val variants = ArrayList<ItemVariantEntity>()
    val levels = LinkedHashMap<String, StockLevelEntity>()
    val movements = ArrayList<StockMovementEntity>()
    val suppliers = LinkedHashMap<String, SupplierEntity>()
    val tables = LinkedHashMap<String, TableEntity>()
    val printers = LinkedHashMap<String, PrinterEntity>()
    var settings: SettingsEntity? = null
    val employees = LinkedHashMap<String, EmployeeEntity>()
    val employeeStores = ArrayList<EmployeeStoreEntity>()
    val roles = LinkedHashMap<String, RoleEntity>()
    val stores = ArrayList<String>()

    private fun liveVariant(v: ItemVariantEntity) = v.deleted_at == null && items[v.item_id]?.deleted_at == null
    override suspend fun item(id: String) = items[id]
    override suspend fun putItem(row: ItemEntity) { items[row.id] = row }
    override suspend fun itemsWithBarcode(code: String, not: String) = items.values.count { it.barcode == code && it.deleted_at == null && it.id != not }
    override suspend fun variantsWithBarcode(code: String, not: String) = variants.count { it.barcode == code && liveVariant(it) && it.id != not }
    override suspend fun itemsWithSku(sku: String, not: String) = items.values.count { it.sku?.lowercase() == sku.lowercase() && it.deleted_at == null && it.id != not }
    override suspend fun variantsWithSku(sku: String, not: String) = variants.count { it.sku?.lowercase() == sku.lowercase() && liveVariant(it) && it.id != not }
    override suspend fun itemsIn(category: String) = items.values.count { it.category_id == category && it.deleted_at == null }
    override suspend fun category(id: String) = categories[id]
    override suspend fun putCategory(row: CategoryEntity) { categories[row.id] = row }
    override suspend fun lastCategoryPlace() = categories.values.filter { it.deleted_at == null }.maxOfOrNull { it.sort_order } ?: -1
    override suspend fun taxes() = taxes.values.toList()
    override suspend fun putTaxes(rows: List<TaxEntity>) { rows.forEach { taxes[it.id] = it } }
    override suspend fun taxesOf(item: String) = itemTaxes.filter { it.item_id == item }.map { it.tax_id }
    override suspend fun dropTaxesOf(item: String) { itemTaxes.removeAll { it.item_id == item } }
    override suspend fun putItemTax(row: ItemTaxCrossRef) { if (itemTaxes.none { it.item_id == row.item_id && it.tax_id == row.tax_id }) itemTaxes += row }
    override suspend fun variantsOf(item: String) = variants.filter { it.item_id == item && it.deleted_at == null }
    override suspend fun levelsOf(store: String, item: String) = levels.values.filter { it.store_id == store && it.item_id == item }
    override suspend fun putLevels(rows: List<StockLevelEntity>) { rows.forEach { levels["${it.store_id}/${it.item_id}/${it.variant_id}"] = it } }
    override suspend fun putMovement(row: StockMovementEntity) { movements += row }
    override suspend fun supplier(id: String) = suppliers[id]
    override suspend fun suppliersNamed(name: String, not: String) = suppliers.values.count { it.name.lowercase() == name.lowercase() && it.deleted_at == null && it.id != not }
    override suspend fun putSupplier(row: SupplierEntity) { suppliers[row.id] = row }
    override suspend fun tables(store: String) = tables.values.filter { it.store_id == store && it.deleted_at == null }
    override suspend fun putTables(rows: List<TableEntity>) { rows.forEach { tables[it.id] = it } }
    override suspend fun printer(id: String) = printers[id]
    override suspend fun printers() = printers.values.filter { it.deleted_at == null }
    override suspend fun putPrinter(row: PrinterEntity) { printers[row.id] = row }
    override suspend fun settings() = settings
    override suspend fun putSettings(row: SettingsEntity) { settings = row }
    override suspend fun employee(id: String) = employees[id]
    override suspend fun putEmployee(row: EmployeeEntity) { employees[row.id] = row }
    override suspend fun putEmployeeStores(rows: List<EmployeeStoreEntity>) { employeeStores += rows }
    override suspend fun role(id: String) = roles[id]
    override suspend fun storeIds() = stores.toList()
}

// A tablet that works on its own answers a change by the server's rules,
// written again in Kotlin. Each test here is a case of the server's own
// suites (item-ops, till-categories-stock, till-setup, till-stock,
// till-office), asked of the tablet: the same refusal, the same rows after.
class LocalAnswersTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-%012d".format(n)
    private val tenant = id(1); private val store = id(2); private val otherStore = id(3)
    private val vat = id(10); private val zero = id(11); private val cat = id(20); private val sup = id(30)
    private val role = id(40); private val owner = id(41)
    private val dao = FakeAlone().apply {
        stores += store
        taxes[vat] = TaxEntity(vat, tenant, "VAT", 1500, "included", is_default = true)
        taxes[zero] = TaxEntity(zero, tenant, "Zero rated", 0, "included")
        categories[cat] = CategoryEntity(cat, tenant, "Clothing")
        suppliers[sup] = SupplierEntity(sup, tenant, "Maison Ltd")
        roles[role] = RoleEntity(role, tenant, "Cashier", "[\"sale.create\"]")
        settings = SettingsEntity(tenant, """{"businessType":"retail","plan":"offline"}""")
    }
    private var clock = 1_760_000_000_000L
    private var made = 900
    private val local = LocalAnswers(dao, { clock }, { id(made++) })

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    // what the tablet says of a change: "done", or the code it was refused with
    private fun ask(type: String, payload: JsonObject): String = runBlocking {
        try { local.apply(type, payload, tenant, owner); "done" } catch (e: Refused) { e.code }
    }
    private fun ask(type: String, json: String) = ask(type, obj(json))
    // an example payload of the server's suite, its stand-ins swapped for this test's ids
    private fun fixture(name: String, ids: Map<String, String>): JsonObject {
        var text = OfficeFixtures.payload(name).toString()
        ids.forEach { (k, v) -> text = text.replace("\"$k\"", "\"$v\"") }
        return obj(text)
    }
    private val ids = mapOf("item-1" to id(100), "tax-1" to zero, "category-1" to cat, "supplier-1" to sup, "store-1" to store)

    // ---- item.save ----
    @Test fun `a new product with every field, as the server's example`() {
        assertEquals("done", ask("item.save", fixture("item-save-full", ids)))
        val i = dao.items[id(100)]!!
        assertEquals(listOf("Polo shirt", 49900L, "POLO-01", 17000L, "Maison", sup, "M-POLO", "6091234500017", cat, true),
            listOf(i.name, i.price, i.sku, i.cost, i.brand, i.supplier_id, i.supplier_code, i.barcode, i.category_id, i.track_stock))
        assertEquals(listOf(zero), runBlocking { dao.taxesOf(id(100)) })
        val l = dao.levels.values.single()
        assertEquals(listOf(store, 3000, 12000, 0), listOf(l.store_id, l.reorder_point, l.reorder_qty, l.qty))
    }

    @Test fun `an older sheet's save changes the price and none of the rest`() {
        ask("item.save", fixture("item-save-full", ids))
        val old = """{"id":"${id(100)}","name":"Polo shirt","price":45000,"open_price":false,"category_id":"$cat","barcode":"6091234500017","available":true}"""
        assertEquals("done", ask("item.save", old))
        val i = dao.items[id(100)]!!
        assertEquals(listOf(45000L, "POLO-01", 17000L, "Maison", sup, "M-POLO", true), listOf(i.price, i.sku, i.cost, i.brand, i.supplier_id, i.supplier_code, i.track_stock))
        assertEquals(listOf(zero), runBlocking { dao.taxesOf(id(100)) })
        assertEquals(3000, dao.levels.values.single().reorder_point)
    }

    @Test fun `emptied, as the server's example`() {
        ask("item.save", fixture("item-save-full", ids))
        assertEquals("done", ask("item.save", fixture("item-save-cleared", ids)))
        val i = dao.items[id(100)]!!
        assertEquals(listOf(null, null, null, null, null), listOf(i.sku, i.cost, i.brand, i.supplier_id, i.supplier_code))
        val l = dao.levels.values.single()
        assertEquals(listOf(null, null), listOf(l.reorder_point, l.reorder_qty))
    }

    @Test fun `an item's tax is moved, and one is left on it`() {
        ask("item.save", fixture("item-save-full", ids))
        val base = """"id":"${id(100)}","name":"Polo shirt","price":45000,"open_price":false,"category_id":"","barcode":"","available":true"""
        assertEquals("done", ask("item.save", "{$base,\"tax_id\":\"$vat\"}"))
        assertEquals(listOf(vat), runBlocking { dao.taxesOf(id(100)) })
        assertEquals("bad-tax", ask("item.save", "{$base,\"tax_id\":\"${id(999)}\"}"))
        // an empty tax leaves it its own
        assertEquals("done", ask("item.save", "{$base,\"tax_id\":\"\"}"))
        assertEquals(listOf(vat), runBlocking { dao.taxesOf(id(100)) })
    }

    @Test fun `a new item with no tax named gets the usual one, and a restaurant's is not counted`() {
        dao.settings = SettingsEntity(tenant, """{"plan":"offline"}""")
        assertEquals("done", ask("item.save", fixture("item-save-tax", ids + ("tax-1" to "")).let { JsonObject(it - "tax_id") }))
        assertEquals(listOf(vat), runBlocking { dao.taxesOf(id(100)) })
        assertFalse(dao.items[id(100)]!!.track_stock)
        // a shop's new product is counted unless told otherwise
        dao.settings = SettingsEntity(tenant, """{"businessType":"retail"}""")
        ask("item.save", """{"id":"${id(101)}","name":"Belt","price":30000,"open_price":false,"category_id":"","barcode":"","available":true}""")
        assertTrue(dao.items[id(101)]!!.track_stock)
    }

    @Test fun `what an item is refused for`() {
        val base = """"id":"${id(100)}","price":1000,"open_price":false,"category_id":"","barcode":"","available":true"""
        assertEquals("name-required", ask("item.save", "{$base,\"name\":\"  \"}"))
        assertEquals("bad-payload", ask("item.save", """{"id":"not-an-id","name":"X","price":1000}"""))
        assertEquals("bad-payload", ask("item.save", """{"id":"${id(100)}","name":"X","price":100000001}"""))
        assertEquals("bad-category", ask("item.save", "{$base,\"name\":\"X\"}".replace("\"category_id\":\"\"", "\"category_id\":\"${id(998)}\"")))
        assertEquals("unknown-supplier", ask("item.save", "{$base,\"name\":\"X\",\"supplier_id\":\"${id(997)}\"}"))
        assertEquals("bad-store", ask("item.save", "{$base,\"name\":\"X\",\"reorder_point\":1000,\"reorder_qty\":2000}"))
        assertEquals("bad-store", ask("item.save", "{$base,\"name\":\"X\",\"store_id\":\"$otherStore\",\"reorder_point\":1000,\"reorder_qty\":2000}"))
        assertEquals("bad-quantity", ask("item.save", "{$base,\"name\":\"X\",\"store_id\":\"$store\",\"reorder_point\":-1,\"reorder_qty\":2000}"))
        assertEquals("bad-payload", ask("item.save", "{$base,\"name\":\"X\",\"cost\":-5}"))
        assertTrue(dao.items.isEmpty())
    }

    @Test fun `a barcode and a SKU are one product's only`() {
        ask("item.save", fixture("item-save-full", ids))
        val other = """"id":"${id(101)}","name":"Other polo","price":1000,"open_price":false,"category_id":"","available":true"""
        assertEquals("barcode-taken", ask("item.save", "{$other,\"barcode\":\"6091234500017\"}"))
        assertEquals("sku-taken", ask("item.save", "{$other,\"barcode\":\"\",\"sku\":\"polo-01\"}"))
        // a variant's code is taken too
        dao.variants += ItemVariantEntity(id(200), tenant, id(100), "S", 49900, sku = "POLO-S", barcode = "6090000000001")
        assertEquals("barcode-taken", ask("item.save", "{$other,\"barcode\":\"6090000000001\"}"))
        assertEquals("sku-taken", ask("item.save", "{$other,\"barcode\":\"\",\"sku\":\"POLO-S\"}"))
        // its own code is its own
        assertEquals("done", ask("item.save", fixture("item-save-full", ids)))
        // and a removed product's is free again
        ask("item.remove", """{"item_id":"${id(100)}"}""")
        assertEquals("done", ask("item.save", "{$other,\"barcode\":\"6091234500017\",\"sku\":\"POLO-01\"}"))
    }

    @Test fun `a price typed at the sale has no price and no stock counted, and is not for variants or weight`() {
        assertEquals("done", ask("item.save", """{"id":"${id(100)}","name":"Labour","price":5000,"open_price":true,"category_id":"","barcode":"","available":true,"track_stock":true}"""))
        val i = dao.items[id(100)]!!
        assertEquals(listOf(0L, true, false), listOf(i.price, i.open_price, i.track_stock))
        dao.items[id(101)] = ItemEntity(id(101), tenant, null, "Rice", 8000, sold_by = "weight")
        assertEquals("open-price-not-here", ask("item.save", """{"id":"${id(101)}","name":"Rice","price":0,"open_price":true}"""))
        dao.items[id(102)] = ItemEntity(id(102), tenant, null, "Shirt", 8000)
        dao.variants += ItemVariantEntity(id(201), tenant, id(102), "S", 8000)
        assertEquals("open-price-not-here", ask("item.save", """{"id":"${id(102)}","name":"Shirt","price":0,"open_price":true}"""))
    }

    @Test fun `removed is removed, once or twice, and one that never was is refused`() {
        ask("item.save", fixture("item-save-full", ids))
        assertEquals("done", ask("item.remove", """{"item_id":"${id(100)}"}"""))
        val at = dao.items[id(100)]!!.deleted_at
        assertNotNull(at)
        clock += 5000
        assertEquals("done", ask("item.remove", """{"item_id":"${id(100)}"}"""))
        assertEquals(at, dao.items[id(100)]!!.deleted_at)
        assertEquals("bad-item", ask("item.remove", """{"item_id":"${id(555)}"}"""))
        // and it is not brought back by a save that arrives late
        assertEquals("bad-item", ask("item.save", fixture("item-save-full", ids)))
    }

    // ---- categories ----
    @Test fun `a category made, changed and removed`() {
        assertEquals("done", ask("category.save", """{"id":"${id(21)}","name":" Shoes ","color":"#AA3311"}"""))
        val c = dao.categories[id(21)]!!
        assertEquals(listOf("Shoes", "#aa3311", 1), listOf(c.name, c.color, c.sort_order))
        dao.categories[id(21)] = c.copy(printer_ids = "[\"p1\"]", is_stock = true)
        assertEquals("done", ask("category.save", """{"id":"${id(21)}","name":"Footwear","color":""}"""))
        val d = dao.categories[id(21)]!!
        // its printers and whether its stock is counted are left as they were
        assertEquals(listOf("Footwear", null, "[\"p1\"]", true), listOf(d.name, d.color, d.printer_ids, d.is_stock))
        assertEquals("name-required", ask("category.save", """{"id":"${id(22)}","name":""}"""))
        assertEquals("bad-payload", ask("category.save", """{"id":"${id(22)}","name":"X","color":"red"}"""))
        dao.items[id(100)] = ItemEntity(id(100), tenant, id(21), "Boot", 1000)
        assertEquals("has-items", ask("category.remove", """{"category_id":"${id(21)}"}"""))
        dao.items[id(100)] = dao.items[id(100)]!!.copy(deleted_at = "2026-10-11T00:00:00Z")
        assertEquals("done", ask("category.remove", """{"category_id":"${id(21)}"}"""))
        assertEquals("done", ask("category.remove", """{"category_id":"${id(21)}"}"""))
        assertEquals("bad-category", ask("category.save", """{"id":"${id(21)}","name":"Back"}"""))
        assertEquals("bad-category", ask("category.remove", """{"category_id":"${id(777)}"}"""))
    }

    // ---- stock ----
    @Test fun `stock in and out, never below nothing, each written in the history`() {
        dao.items[id(100)] = ItemEntity(id(100), tenant, cat, "Mug", 32000, track_stock = true)
        val base = """"store_id":"$store","item_id":"${id(100)}","variant_id":"""""
        assertEquals("done", ask("stock.adjust", "{$base,\"units\":5000,\"direction\":\"in\",\"reason\":\"receive\"}"))
        assertEquals(5000, dao.levels.values.single().qty)
        assertEquals("not-enough-stock", ask("stock.adjust", "{$base,\"units\":6000,\"direction\":\"out\",\"reason\":\"\"}"))
        assertEquals("done", ask("stock.adjust", "{$base,\"units\":2000,\"direction\":\"out\",\"reason\":\"damaged\"}"))
        assertEquals(3000, dao.levels.values.single().qty)
        assertEquals(listOf(5000 to "receive", -2000 to "damaged"), dao.movements.map { it.qty to it.reason })
        assertEquals(owner, dao.movements.first().employee_id)
        assertEquals("bad-reason", ask("stock.adjust", "{$base,\"units\":1000,\"direction\":\"in\",\"reason\":\"damaged\"}"))
        assertEquals("bad-qty", ask("stock.adjust", "{$base,\"units\":0,\"direction\":\"in\"}"))
        assertEquals("bad-payload", ask("stock.adjust", "{$base,\"units\":1000,\"direction\":\"sideways\"}"))
        assertEquals("bad-store", ask("stock.adjust", "{$base,\"units\":1000,\"direction\":\"in\"}".replace(store, otherStore)))
    }

    @Test fun `stock is counted on the line that holds it`() {
        dao.items[id(100)] = ItemEntity(id(100), tenant, null, "Fee", 1000)
        val of = { item: String, variant: String -> """{"store_id":"$store","item_id":"$item","variant_id":"$variant","units":1000,"direction":"in"}""" }
        assertEquals("not-counted", ask("stock.adjust", of(id(100), "")))
        // a category that counts its stock counts every item in it
        dao.categories[cat] = dao.categories[cat]!!.copy(is_stock = true)
        dao.items[id(100)] = dao.items[id(100)]!!.copy(category_id = cat)
        assertEquals("done", ask("stock.adjust", of(id(100), "")))
        dao.items[id(101)] = ItemEntity(id(101), tenant, null, "Shirt", 1000, track_stock = true)
        dao.variants += ItemVariantEntity(id(200), tenant, id(101), "S", 1000)
        assertEquals("pick-variant", ask("stock.adjust", of(id(101), "")))
        assertEquals("bad-variant", ask("stock.adjust", of(id(101), id(299))))
        assertEquals("done", ask("stock.adjust", of(id(101), id(200))))
        assertEquals("bad-item", ask("stock.adjust", of(id(444), "")))
    }

    // ---- the first-run set-up ----
    @Test fun `the tables of a new room`() {
        fun t(n: Int, name: String, x: Int = 0) = """{"id":"${id(n)}","name":"$name","seats":4,"shape":"square","x":$x,"y":0,"w":10,"h":10}"""
        val room = { area: String, rows: String -> """{"store_id":"$store","area":"$area","tables":[$rows]}""" }
        assertEquals("done", ask("tables.add", room("Main", t(300, "1") + "," + t(301, "2", 12))))
        assertEquals(listOf("1" to 0, "2" to 1), dao.tables.values.map { it.name to it.sort_order })
        // sent again after a lost answer: nothing twice, and no refusal
        assertEquals("done", ask("tables.add", room("Main", t(300, "1") + "," + t(301, "2", 12))))
        assertEquals(2, dao.tables.size)
        assertEquals("room-exists", ask("tables.add", room("main", t(302, "3"))))
        assertEquals("name-taken", ask("tables.add", room("Terrace", t(303, "2"))))
        assertEquals("name-taken", ask("tables.add", room("Terrace", t(304, "T1") + "," + t(305, "t1", 12))))
        assertEquals("bad-payload", ask("tables.add", room("Terrace", t(306, "T9", 95))))
        assertEquals("bad-store", ask("tables.add", room("Terrace", t(307, "T1")).replace(store, otherStore)))
        assertEquals("done", ask("tables.add", room("Terrace", t(308, "T1"))))
        assertEquals(2, dao.tables[id(308)]!!.sort_order)
    }

    @Test fun `a printer, and where receipts come out`() {
        val p = { n: Int, more: String -> """{"id":"${id(n)}","store_id":"$store","name":"Counter","kind":"network","address":"192.168.1.50","paper_mm":80$more}""" }
        assertEquals("done", ask("printer.save", p(400, ",\"one_printer\":true")))
        assertTrue(dao.printers[id(400)]!!.is_receipt)
        assertTrue(PosSettings.parse(dao.settings!!.data).onePrinter)
        // what the settings held is kept beside it
        assertTrue(PosSettings.parse(dao.settings!!.data).retail)
        assertEquals("done", ask("printer.save", p(401, "")))
        assertFalse(dao.printers[id(401)]!!.is_receipt)
        assertEquals(1, dao.printers[id(401)]!!.sort_order)
        assertEquals("bad-address", ask("printer.save", p(402, "").replace("192.168.1.50", "the kitchen")))
        assertEquals("name-required", ask("printer.save", p(402, "").replace("Counter", " ")))
        assertEquals("bad-payload", ask("printer.save", p(402, "").replace("\"paper_mm\":80", "\"paper_mm\":72")))
        assertEquals("done", ask("printer.save", """{"id":"${id(403)}","store_id":"$store","name":"USB","kind":"usb","address":"anything","paper_mm":58}"""))
        assertNull(dao.printers[id(403)]!!.address)
        assertEquals("bad-address", ask("printer.save", """{"id":"${id(404)}","store_id":"$store","name":"BT","kind":"bluetooth","address":"","paper_mm":58}"""))
        // changed: its name and paper; that it prints the receipts stays
        assertEquals("done", ask("printer.save", p(400, "").replace("Counter", "Front").replace("\"paper_mm\":80", "\"paper_mm\":58")))
        assertEquals(listOf("Front", 58, true), dao.printers[id(400)]!!.let { listOf(it.name, it.paper_mm, it.is_receipt) })
    }

    @Test fun `the business's details go into the settings beside what is there`() {
        assertEquals("done", ask("company.save", """{"name":" Chez Aisha ","address":"Royal Road","phone":"5250 1234","brn":"C123","vat":"VAT9"}"""))
        val s = PosSettings.parse(dao.settings!!.data)
        assertEquals(listOf("Chez Aisha", "Royal Road", "5250 1234", "C123", "VAT9"), listOf(s.companyName, s.address, s.phone, s.brn, s.vat))
        assertTrue(s.retail && s.alone)
        assertEquals("name-required", ask("company.save", """{"name":""}"""))
    }

    @Test fun `a member of staff and their PIN`() {
        val row = """{"id":"${id(500)}","name":" Ben ","role_id":"$role","pin_hash":"pbkdf2:abc"}"""
        assertEquals("done", ask("staff.save", row))
        assertEquals(listOf("Ben", "pbkdf2:abc", role), dao.employees[id(500)]!!.let { listOf(it.name, it.pin_hash, it.role_id) })
        assertEquals(listOf(store), dao.employeeStores.map { it.store_id })
        // sent again: the person is there already, and is left as they are
        assertEquals("done", ask("staff.save", row.replace("Ben", "Benjamin")))
        assertEquals("Ben", dao.employees[id(500)]!!.name)
        assertEquals(1, dao.employeeStores.size)
        assertEquals("bad-role", ask("staff.save", row.replace(id(500), id(501)).replace(role, id(49))))
        assertEquals("bad-pin", ask("staff.save", row.replace(id(500), id(501)).replace("pbkdf2:abc", "")))
        assertEquals("name-required", ask("staff.save", row.replace(id(500), id(501)).replace(" Ben ", " ")))
        assertEquals("done", ask("staff.set_pin", """{"employee_id":"${id(500)}","pin_hash":"pbkdf2:new"}"""))
        assertEquals("pbkdf2:new", dao.employees[id(500)]!!.pin_hash)
        assertEquals("unknown-staff", ask("staff.set_pin", """{"employee_id":"${id(599)}","pin_hash":"pbkdf2:new"}"""))
        assertEquals("bad-pin", ask("staff.set_pin", """{"employee_id":"${id(500)}","pin_hash":""}"""))
    }

    // ---- taxes ----
    @Test fun `a tax added, changed, and the usual one moved`() {
        val levy = fixture("tax-save", mapOf("tax-1" to id(12)))
        assertEquals("done", ask("tax.save", levy))
        assertEquals(listOf("Tourist levy", 750, "added", false), dao.taxes[id(12)]!!.let { listOf(it.name, it.rate_bp, it.type, it.is_default) })
        assertEquals("done", ask("tax.save", levy))
        assertEquals(3, dao.taxes.size)
        assertEquals("name-taken", ask("tax.save", JsonObject(levy + ("id" to JsonPrimitive(id(13))) + ("name" to JsonPrimitive("vat")))))
        assertEquals("bad-rate", ask("tax.save", JsonObject(levy + ("rate_bp" to JsonPrimitive(10001)))))
        assertEquals("name-required", ask("tax.save", JsonObject(levy + ("name" to JsonPrimitive("  ")))))
        assertEquals("bad-payload", ask("tax.save", JsonObject(levy + ("type" to JsonPrimitive("sometimes")))))
        assertEquals("done", ask("tax.save", JsonObject(levy + ("is_default" to JsonPrimitive(true)))))
        assertEquals(listOf(id(12)), dao.taxes.values.filter { it.is_default }.map { it.id })
        // saved again without the switch, it stays the usual one
        assertEquals("done", ask("tax.save", levy))
        assertTrue(dao.taxes[id(12)]!!.is_default)
    }

    // ---- suppliers ----
    @Test fun `a supplier added, changed and removed`() {
        val row = { n: Int, name: String -> """{"id":"${id(n)}","name":"$name","contact":"Devi","phone":"52501234","email":"","address":"Phoenix","note":""}""" }
        assertEquals("done", ask("supplier.save", row(31, "Maurilait")))
        assertEquals(listOf("Maurilait", "Devi", null), dao.suppliers[id(31)]!!.let { listOf(it.name, it.contact, it.email) })
        assertEquals("name-taken", ask("supplier.save", row(32, "maison ltd")))
        assertEquals("name-required", ask("supplier.save", row(32, " ")))
        assertEquals("done", ask("supplier.remove", """{"id":"${id(31)}"}"""))
        assertEquals("done", ask("supplier.remove", """{"id":"${id(31)}"}"""))
        assertEquals("unknown-supplier", ask("supplier.save", row(31, "Maurilait")))
        // its name is free again
        assertEquals("done", ask("supplier.save", row(33, "Maurilait")))
    }

    @Test fun `a change this tablet cannot answer by itself says so`() {
        assertEquals("not-alone", ask("po.save", "{}"))
        assertFalse(local.answers("po.save"))
        assertTrue(local.answers("item.save") && local.answers("tax.save") && local.answers("tables.add"))
    }

    @Test fun `the plan that makes a tablet work on its own`() {
        assertTrue(PosSettings.parse("""{"plan":"offline"}""").alone)
        assertTrue(PosSettings.parse("""{"plan":" Offline "}""").alone)
        listOf("""{"plan":"standard"}""", """{"plan":"premium"}""", """{"plan":"trial"}""", "{}", null).forEach { assertFalse(PosSettings.parse(it).alone) }
        // on its own it has none of Premium's screens
        assertFalse(PosSettings.parse("""{"plan":"offline"}""").premium)
    }
}
