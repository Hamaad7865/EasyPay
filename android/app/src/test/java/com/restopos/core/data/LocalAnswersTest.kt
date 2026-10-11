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
import kotlinx.serialization.json.jsonPrimitive
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
    private fun top(codes: List<String?>, like: String) = codes.filterNotNull().filter { it.startsWith(like.removeSuffix("%")) && it.length == 13 }.maxOrNull()
    override suspend fun topItemBarcode(like: String) = top(items.values.map { it.barcode }, like)
    override suspend fun topVariantBarcode(like: String) = top(variants.map { it.barcode }, like)
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
    val orders = LinkedHashMap<String, com.restopos.core.database.PurchaseOrderEntity>()
    val orderLines = ArrayList<com.restopos.core.database.PurchaseOrderLineEntity>()
    val deliveries = LinkedHashMap<String, com.restopos.core.database.DeliveryEntity>()
    val deliveryLines = ArrayList<com.restopos.core.database.DeliveryLineEntity>()
    override suspend fun order(id: String) = orders[id]
    override suspend fun putOrder(row: com.restopos.core.database.PurchaseOrderEntity) { orders[row.id] = row }
    override suspend fun orderLines(order: String) = orderLines.filter { it.order_id == order }
    override suspend fun dropOrderLines(order: String) { orderLines.removeAll { it.order_id == order } }
    override suspend fun putOrderLines(rows: List<com.restopos.core.database.PurchaseOrderLineEntity>) {
        rows.forEach { r -> orderLines.removeAll { it.order_id == r.order_id && it.item_id == r.item_id && it.variant_id == r.variant_id }; orderLines += r }
    }
    override suspend fun delivery(id: String) = deliveries[id]
    override suspend fun deliveriesOf(order: String) = deliveries.values.count { it.order_id == order }
    override suspend fun putDelivery(row: com.restopos.core.database.DeliveryEntity) { deliveries[row.id] = row }
    override suspend fun putDeliveryLines(rows: List<com.restopos.core.database.DeliveryLineEntity>) { deliveryLines += rows }
    override suspend fun orderNumbers() = orders.values.map { it.number }
    override suspend fun deliveryNumbers() = deliveries.values.map { it.number }
    val counts = LinkedHashMap<String, com.restopos.core.database.StockCountEntity>()
    val countLines = ArrayList<com.restopos.core.database.StockCountLineEntity>()
    override suspend fun count(id: String) = counts[id]
    override suspend fun putCount(row: com.restopos.core.database.StockCountEntity) { counts[row.id] = row }
    override suspend fun countLines(count: String) = countLines.filter { it.count_id == count }
    override suspend fun dropCountLines(count: String) { countLines.removeAll { it.count_id == count } }
    override suspend fun putCountLines(rows: List<com.restopos.core.database.StockCountLineEntity>) {
        rows.forEach { r -> countLines.removeAll { it.count_id == r.count_id && it.item_id == r.item_id && it.variant_id == r.variant_id }; countLines += r }
    }
    override suspend fun countNumbers() = counts.values.mapNotNull { it.number }
    override suspend fun tables(store: String) = tables.values.filter { it.store_id == store && it.deleted_at == null }
    override suspend fun table(id: String) = tables[id]
    val elements = LinkedHashMap<String, com.restopos.core.database.FloorElementEntity>()
    override suspend fun elements(store: String) = elements.values.filter { it.store_id == store && it.deleted_at == null }
    override suspend fun element(id: String) = elements[id]
    override suspend fun putElements(rows: List<com.restopos.core.database.FloorElementEntity>) { rows.forEach { elements[it.id] = it } }
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
    override suspend fun roles() = roles.values.toList()
    override suspend fun putRole(row: RoleEntity) { roles[row.id] = row }
    override suspend fun staffOn(role: String) = employees.values.count { it.role_id == role && it.deleted_at == null }
    val discounts = LinkedHashMap<String, com.restopos.core.database.DiscountEntity>()
    override suspend fun discounts() = discounts.values.toList()
    override suspend fun putDiscount(row: com.restopos.core.database.DiscountEntity) { discounts[row.id] = row }
    override suspend fun variant(id: String) = variants.firstOrNull { it.id == id }
    override suspend fun putVariants(rows: List<ItemVariantEntity>) { rows.forEach { r -> variants.removeAll { it.id == r.id }; variants += r } }
    override suspend fun levelsOfItem(item: String) = levels.values.filter { it.item_id == item }
    val groups = LinkedHashMap<String, com.restopos.core.database.ModifierGroupEntity>()
    val choices = LinkedHashMap<String, com.restopos.core.database.ModifierEntity>()
    val itemGroups = ArrayList<com.restopos.core.database.ItemModGroupCrossRef>()
    override suspend fun groups() = groups.values.toList()
    override suspend fun putGroup(row: com.restopos.core.database.ModifierGroupEntity) { groups[row.id] = row }
    override suspend fun choicesOf(group: String) = choices.values.filter { it.group_id == group }
    override suspend fun choice(id: String) = choices[id]
    override suspend fun putChoices(rows: List<com.restopos.core.database.ModifierEntity>) { rows.forEach { choices[it.id] = it } }
    override suspend fun groupsOf(item: String) = itemGroups.filter { it.item_id == item }.map { it.group_id }
    override suspend fun dropGroupsOf(item: String) { itemGroups.removeAll { it.item_id == item } }
    override suspend fun dropLinksTo(group: String) { itemGroups.removeAll { it.group_id == group } }
    override suspend fun putItemGroups(rows: List<com.restopos.core.database.ItemModGroupCrossRef>) { rows.forEach { r -> if (itemGroups.none { it.item_id == r.item_id && it.group_id == r.group_id }) itemGroups += r } }
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

    // what goes into the queue for a change: each kind and its payload, as the server is to take it
    private fun kept(type: String, json: String): List<Pair<String, JsonObject>> = runBlocking { local.apply(type, obj(json), tenant, owner) }
    private fun plain(n: Int, name: String, barcode: String = "") =
        """{"id":"${id(n)}","name":"$name","price":25000,"open_price":false,"category_id":"$cat","barcode":"$barcode","available":true}"""

    @Test fun `a shop's product saved with no barcode is given the next of EasyPay's, and the server is sent it`() {
        val first = kept("item.save", plain(700, "Cotton scarf")).single()
        assertEquals("item.save", first.first)
        assertEquals("2000000000015", first.second["barcode"]!!.jsonPrimitive.content)
        assertEquals("2000000000015", dao.items[id(700)]!!.barcode)
        // the next one takes the next number; one typed in is left as typed
        assertEquals("2000000000022", kept("item.save", plain(701, "Wool scarf")).single().second["barcode"]!!.jsonPrimitive.content)
        assertEquals("6091234500017", kept("item.save", plain(702, "Polo", "6091234500017")).single().second["barcode"]!!.jsonPrimitive.content)
        // saved again it keeps its own; emptied by hand it is given a new one, never the old
        assertEquals("done", ask("item.save", plain(700, "Cotton scarf, long", "2000000000015")))
        assertEquals("2000000000015", dao.items[id(700)]!!.barcode)
        assertEquals("2000000000039", kept("item.save", plain(701, "Wool scarf")).single().second["barcode"]!!.jsonPrimitive.content)
    }

    @Test fun `a number is not given twice, a removed product's included, and one typed in by hand is stepped over`() {
        ask("item.save", plain(710, "One"))
        ask("item.save", plain(711, "Two"))
        assertEquals("done", ask("item.remove", """{"item_id":"${id(711)}"}"""))
        ask("item.save", plain(712, "Three"))
        assertEquals("2000000000039", dao.items[id(712)]!!.barcode)
        // the owner typed the very next one on another product
        ask("item.save", plain(713, "Four", "2000000000046"))
        ask("item.save", plain(714, "Five"))
        assertEquals("2000000000053", dao.items[id(714)]!!.barcode)
    }

    @Test fun `a restaurant's item is given none, and what is refused takes no number`() {
        dao.settings = SettingsEntity(tenant, """{"plan":"offline"}""")
        assertEquals("", kept("item.save", plain(720, "Grilled fish")).single().second["barcode"]!!.jsonPrimitive.content)
        assertNull(dao.items[id(720)]!!.barcode)
        dao.settings = SettingsEntity(tenant, """{"businessType":"retail","plan":"offline"}""")
        assertEquals("name-required", ask("item.save", plain(721, " ")))
        ask("item.save", plain(722, "Mug"))
        assertEquals("2000000000015", dao.items[id(722)]!!.barcode)
    }

    @Test fun `the lines made for a product are given theirs in a change kept after the first, and the product none`() {
        ask("item.save", plain(730, "Tee", "6091234500031"))
        val made = kept("variants.make", """{"item_id":"${id(730)}","names":["Size"],"lines":[{"id":"${id(731)}","values":["S"]},{"id":"${id(732)}","values":["M"]}],"approved_by":"$owner"}""")
        assertEquals(listOf("variants.make", "variants.save"), made.map { it.first })
        assertEquals(
            """{"item_id":"${id(730)}","lines":[{"id":"${id(731)}","barcode":"2000000000015"},{"id":"${id(732)}","barcode":"2000000000022"}],"approved_by":"$owner"}""",
            made[1].second.toString(),
        )
        assertEquals(listOf("2000000000015", "2000000000022"), dao.variants.filter { it.item_id == id(730) }.map { it.barcode })
        // a value added later: only the new line, with the next number; nothing made, nothing more kept
        val more = kept("variants.make", """{"item_id":"${id(730)}","names":["Size"],"lines":[{"id":"${id(733)}","values":["L"]}]}""")
        assertEquals("""{"item_id":"${id(730)}","lines":[{"id":"${id(733)}","barcode":"2000000000039"}]}""", more[1].second.toString())
        assertEquals(listOf("variants.make"), kept("variants.make", """{"item_id":"${id(730)}","names":["Size"],"lines":[{"id":"${id(734)}","values":["l"]}]}""").map { it.first })
        // the product itself, saved with its barcode emptied: its lines have theirs, it gets none
        assertEquals("", kept("item.save", plain(730, "Tee")).single().second["barcode"]!!.jsonPrimitive.content)
        assertNull(dao.items[id(730)]!!.barcode)
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

    // ---- the floor plan, changed on the tablet (server 0101) ----
    @Test fun `a room saved as its plan holds it`() {
        fun t(n: Int, name: String, x: Int = 0, more: String = "") = """{"id":"${id(n)}","name":"$name","seats":4,"shape":"square","x":$x,"y":0,"w":10,"h":10$more}"""
        val add = { area: String, rows: String -> """{"store_id":"$store","area":"$area","tables":[$rows]}""" }
        val save = { area: String, rows: String, gone: String -> """{"store_id":"$store","area":"$area","tables":[$rows],"removed":[$gone]}""" }
        assertEquals("done", ask("tables.add", add("Main", t(300, "1") + "," + t(301, "2", 12) + "," + t(302, "3", 24))))
        assertEquals("done", ask("tables.add", add("Terrace", t(310, "5"))))
        fun live() = dao.tables.values.filter { it.deleted_at == null }

        // moved, made bigger, given other covers and another shape; one taken off; one of the room not sent
        val moved = """{"id":"${id(300)}","name":"1","seats":6,"shape":"round","x":40,"y":20,"w":16,"h":14}"""
        assertEquals("done", ask("floor.save", save("Main", moved, "\"${id(302)}\"")))
        val one = dao.tables[id(300)]!!
        assertEquals(listOf(40, 20, 16, 14, 6), listOf(one.x, one.y, one.w, one.h, one.seats))
        assertEquals("round" to 0, one.shape to one.sort_order)
        assertNotNull(dao.tables[id(302)]!!.deleted_at)
        assertEquals(12 to "Main", dao.tables[id(301)]!!.let { it.x to it.area })
        assertEquals("Terrace", dao.tables[id(310)]!!.area)
        // sent again, it leaves what one sending left
        val was = live().toString()
        assertEquals("done", ask("floor.save", save("Main", moved, "\"${id(302)}\"")))
        assertEquals(was, live().toString())

        // a table added to a room the store has goes after the last in the order
        assertEquals("done", ask("floor.save", save("Main", moved + "," + t(303, "7", 60), "")))
        assertEquals(4, dao.tables[id(303)]!!.sort_order)
        // two tables swap numbers in one save
        assertEquals("done", ask("floor.save", save("Main", t(300, "2") + "," + t(301, "1", 12), "")))
        assertEquals("2" to "1", dao.tables[id(300)]!!.name to dao.tables[id(301)]!!.name)

        val still = live().toString()
        assertEquals("name-taken", ask("floor.save", save("Main", t(300, "5"), "")))
        assertEquals("name-taken", ask("floor.save", save("Main", t(300, "A") + "," + t(304, "a", 30), "")))
        assertEquals("bad-payload", ask("floor.save", save("Main", t(300, "2", 95), "")))
        assertEquals("bad-payload", ask("floor.save", save("Main", t(300, "2").replace("\"seats\":4", "\"seats\":0"), "")))
        assertEquals("bad-payload", ask("floor.save", save("Main", t(300, "2") + "," + t(300, "2b", 30), "")))
        assertEquals("bad-payload", ask("floor.save", save("Main", t(300, "2"), "\"${id(300)}\"")))
        assertEquals("bad-payload", ask("floor.save", save("  ", t(300, "2"), "")))
        assertEquals("bad-payload", ask("floor.save", save("Main", t(300, "2"), "").replace("\"removed\":[]", "\"removed\":\"all\"")))
        assertEquals("bad-store", ask("floor.save", save("Main", t(305, "9"), "").replace(store, otherStore)))
        // a table that was removed does not come back by its id
        assertEquals("conflict", ask("floor.save", save("Main", t(302, "33", 70), "")))
        assertEquals(still, live().toString())
        // an id that is nobody's table removes nothing
        assertEquals("done", ask("floor.save", save("Main", "", "\"${id(999)}\"")))
        assertEquals(still, live().toString())
    }

    @Test fun `an angle, a booth and a stool, and what stands in the room`() {
        fun t(n: Int, name: String, x: Int = 0, more: String = "") = """{"id":"${id(n)}","name":"$name","seats":4,"shape":"square","x":$x,"y":0,"w":10,"h":10$more}"""
        fun e(n: Int, kind: String, x: Int, y: Int, w: Int, h: Int, rot: Int = 0) = """{"id":"${id(n)}","kind":"$kind","x":$x,"y":$y,"w":$w,"h":$h,"rotation":$rot}"""
        fun save(rows: String, more: String = "") = """{"store_id":"$store","area":"Main","tables":[$rows],"removed":[]$more}"""
        fun live() = dao.elements.values.filter { it.deleted_at == null }
        assertEquals("done", ask("floor.save", save(t(300, "1", 0, ",\"rotation\":45") + "," + t(301, "B1", 12).replace("square", "booth") + "," + t(302, "S1", 24).replace("square", "stool"),
            ",\"elements\":[${e(400, "wall", 0, 20, 60, 1)},${e(401, "bar", 70, 10, 24, 6, 90)},${e(402, "window", 90, 0, 8, 1)}]")))
        assertEquals(45, dao.tables[id(300)]!!.rotation)
        assertEquals("booth" to "stool", dao.tables[id(301)]!!.shape to dao.tables[id(302)]!!.shape)
        assertEquals(listOf("wall", "bar", "window"), live().map { it.kind })
        assertEquals(90 to "Main", dao.elements[id(401)]!!.let { it.rotation to it.area })
        // a save that names no angle and no elements turns nothing back and moves nothing
        val was = live().toString()
        assertEquals("done", ask("floor.save", save(t(300, "1"))))
        assertEquals(45, dao.tables[id(300)]!!.rotation)
        assertEquals(was, live().toString())
        // nor does one that names none
        assertEquals("done", ask("floor.save", save("", ",\"elements\":[]")))
        assertEquals(was, live().toString())
        // an angle of nought is an angle
        assertEquals("done", ask("floor.save", save(t(300, "1", 0, ",\"rotation\":0"))))
        assertEquals(0, dao.tables[id(300)]!!.rotation)
        // one taken off, one moved; sent again it leaves what one sending left
        val change = save("", ",\"elements\":[${e(400, "wall", 0, 30, 60, 1)}],\"removed_elements\":[\"${id(402)}\"]")
        assertEquals("done", ask("floor.save", change))
        assertEquals(30, dao.elements[id(400)]!!.y)
        assertNotNull(dao.elements[id(402)]!!.deleted_at)
        val then = live().toString()
        assertEquals("done", ask("floor.save", change))
        assertEquals(then, live().toString())

        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "pillar", 2, 2, 2, 2)}]")))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "wall", 95, 0, 10, 1)}]")))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "wall", 2, 2, 10, 0)}]")))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "door", 2, 2, 8, 2, 360)}]")))
        assertEquals("bad-payload", ask("floor.save", save(t(300, "1", 0, ",\"rotation\":400"))))
        assertEquals("bad-payload", ask("floor.save", save(t(300, "1").replace("square", "sofa"))))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "wall", 2, 40, 10, 1)},${e(410, "wall", 2, 42, 10, 1)}]")))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":[${e(410, "wall", 2, 40, 10, 1)}],\"removed_elements\":[\"${id(410)}\"]")))
        assertEquals("bad-payload", ask("floor.save", save("", ",\"elements\":\"all\"")))
        // an element that was removed does not come back by its id
        assertEquals("conflict", ask("floor.save", save("", ",\"elements\":[${e(402, "window", 90, 0, 8, 1)}]")))
        assertEquals(then, live().toString())

        // a room renamed takes what stands in it; removed, it takes that too
        assertEquals("done", ask("room.rename", """{"store_id":"$store","from":"Main","to":"Hall"}"""))
        assertEquals(setOf("Hall"), live().map { it.area }.toSet())
        assertEquals("done", ask("room.remove", """{"store_id":"$store","area":"Hall"}"""))
        assertEquals(0, live().size)
    }

    @Test fun `a room renamed, and a room removed`() {
        fun t(n: Int, name: String, x: Int = 0) = """{"id":"${id(n)}","name":"$name","seats":4,"shape":"square","x":$x,"y":0,"w":10,"h":10}"""
        val add = { area: String, rows: String -> """{"store_id":"$store","area":"$area","tables":[$rows]}""" }
        assertEquals("done", ask("tables.add", add("Main", t(300, "1") + "," + t(301, "2", 12))))
        assertEquals("done", ask("tables.add", add("Terrace", t(310, "5"))))
        val rename = { from: String, to: String -> """{"store_id":"$store","from":"$from","to":"$to"}""" }
        assertEquals("done", ask("room.rename", rename("Main", " Dining room ")))
        assertEquals(listOf("Dining room", "Dining room", "Terrace"), dao.tables.values.map { it.area })
        // sent again: nothing left to rename, and no refusal
        assertEquals("done", ask("room.rename", rename("Main", "Dining room")))
        assertEquals("room-exists", ask("room.rename", rename("Dining room", "terrace")))
        // a room may change its own capitals
        assertEquals("done", ask("room.rename", rename("Dining room", "DINING ROOM")))
        assertEquals("DINING ROOM", dao.tables[id(300)]!!.area)
        assertEquals("bad-payload", ask("room.rename", rename("DINING ROOM", "   ")))
        assertEquals("bad-store", ask("room.rename", rename("DINING ROOM", "Hall").replace(store, otherStore)))

        val remove = { area: String -> """{"store_id":"$store","area":"$area"}""" }
        assertEquals("done", ask("room.remove", remove("Terrace")))
        assertNotNull(dao.tables[id(310)]!!.deleted_at)
        assertEquals(2, dao.tables.values.count { it.deleted_at == null })
        assertEquals("done", ask("room.remove", remove("Terrace")))
        assertEquals("bad-payload", ask("room.remove", remove("")))
        assertEquals("bad-store", ask("room.remove", remove("DINING ROOM").replace(store, otherStore)))
        // the number of a removed table is free again
        assertEquals("done", ask("floor.save", """{"store_id":"$store","area":"DINING ROOM","tables":[${t(320, "5", 40)}],"removed":[]}"""))
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

    // The day the tablet is connected it keeps these of its own until its
    // queue has gone up (OwnSettings). A kept change that wrote anything
    // else into the settings would be overwritten by the server's old copy.
    @Test fun `what the kept changes write into the settings is what the tablet keeps on connecting`() {
        val before = obj(dao.settings!!.data)
        ask("company.save", """{"name":"Chez Aisha","address":"Royal Road"}""")
        ask("settings.save", OfficeFixtures.payload("settings-save").jsonObject)
        ask("printer.save", """{"id":"${id(410)}","store_id":"$store","name":"Counter","kind":"usb","address":"","paper_mm":80,"one_printer":true}""")
        val after = obj(dao.settings!!.data)
        val written = after.keys.filter { after[it] != before[it] }.toSet()
        assertEquals(com.restopos.core.sync.OwnSettings.KEYS, written)
        assertTrue(LocalAnswers.KINDS.containsAll(com.restopos.core.sync.OwnSettings.KINDS))
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

    // ---- orders to suppliers and what arrives (the server's 0074 and 0092: its suites purchase-orders and till-stock) ----
    private val plain = id(110); private val sized = id(111); private val small = id(112); private val large = id(113); private val fee = id(114)
    private val order = id(300); private val delivery = id(310)
    private val stockIds get() = mapOf(
        "order-1" to order, "delivery-1" to delivery, "store-1" to store, "supplier-1" to sup,
        "item-plain" to plain, "item-sized" to sized, "variant-s" to small, "variant-m" to medium, "count-1" to count,
    )
    private val medium = id(115); private val count = id(320)
    private fun stockFixture(name: String): JsonObject {
        var text = StockFixtures.payload(name).toString()
        stockIds.forEach { (k, v) -> text = text.replace("\"$k\"", "\"$v\"") }
        return obj(text)
    }
    // a product counted as itself, one counted by its variants, and one that is not counted
    private fun shelves() {
        dao.items[plain] = ItemEntity(plain, tenant, cat, "Soap", 9900, track_stock = true, cost = 4000)
        dao.items[sized] = ItemEntity(sized, tenant, cat, "Shirt", 49900, track_stock = true)
        dao.variants += ItemVariantEntity(small, tenant, sized, "S", 49900)
        dao.variants += ItemVariantEntity(large, tenant, sized, "L", 49900)
        dao.items[fee] = ItemEntity(fee, tenant, null, "Delivery fee", 5000)
    }
    private fun line(item: String, variant: String, qty: Int, cost: Long) = """{"item_id":"$item","variant_id":"$variant","qty":$qty,"unit_cost":$cost}"""
    private fun po(id: String, lines: String, supplier: String = sup, at: String = store) =
        """{"id":"$id","store_id":"$at","supplier_id":"$supplier","expected_on":"","note":"","lines":[$lines]}"""
    private fun got(id: String, order: String, lines: String, supplier: String = "", at: String = store) =
        """{"id":"$id","store_id":"$at","order_id":"$order","supplier_id":"$supplier","arrived_on":"2026-10-10","invoice_no":" INV-88 ","note":"","lines":[$lines]}"""

    @Test fun `an order written, saved again and sent, as the server's examples`() {
        shelves()
        assertEquals("done", ask("po.save", stockFixture("po-save")))
        val o = dao.orders[order]!!
        assertEquals(listOf("PO-0001", "draft", sup, store, "2026-10-20", null, owner), listOf(o.number, o.status, o.supplier_id, o.store_id, o.expected_on, o.note, o.created_by))
        assertEquals(listOf(Triple(plain, "", 12000) to 4500L, Triple(sized, small, 6000) to 18000L), dao.orderLines.map { Triple(it.item_id, it.variant_id, it.qty) to it.unit_cost })
        // saved again: the lines are the ones given, two of a product made one at the cost averaged by quantity, and the number stays
        assertEquals("done", ask("po.save", po(order, line(plain, "", 3000, 4500) + "," + line(plain, "", 1000, 4900))))
        assertEquals(listOf(Triple(plain, "", 4000) to 4600L), dao.orderLines.map { Triple(it.item_id, it.variant_id, it.qty) to it.unit_cost })
        assertEquals(listOf("PO-0001", null), dao.orders[order]!!.let { listOf(it.number, it.expected_on) })
        // a second order takes the next number
        assertEquals("done", ask("po.save", po(id(301), line(plain, "", 1000, 4500))))
        assertEquals("PO-0002", dao.orders[id(301)]!!.number)
        assertEquals("done", ask("po.send", stockFixture("po-send")))
        assertEquals(listOf("sent", clock), dao.orders[order]!!.let { listOf(it.status, it.sent_at) })
        // sent again after a lost answer: it is sent, and nothing changes
        clock += 5000
        assertEquals("done", ask("po.send", stockFixture("po-send")))
        assertEquals(clock - 5000, dao.orders[order]!!.sent_at)
        // and it is a draft no longer
        assertEquals("not-draft", ask("po.save", po(order, line(plain, "", 1000, 4500))))
    }

    @Test fun `what an order is refused for`() {
        shelves()
        assertEquals("unknown-supplier", ask("po.save", po(order, line(plain, "", 1000, 4500), supplier = id(39))))
        assertEquals("unknown-store", ask("po.save", po(order, line(plain, "", 1000, 4500), at = otherStore)))
        assertEquals("bad-payload", ask("po.save", po("not-an-id", line(plain, "", 1000, 4500))))
        assertEquals("bad-payload", ask("po.save", po(order, "").replace("\"expected_on\":\"\"", "\"expected_on\":\"next week\"")))
        // a line of nothing, of less than nothing, with no cost, or of no product
        assertEquals("bad-line", ask("po.save", po(order, line(plain, "", 0, 4500))))
        assertEquals("bad-line", ask("po.save", po(order, line(plain, "", -1000, 4500))))
        assertEquals("bad-line", ask("po.save", po(order, """{"item_id":"$plain","variant_id":"","qty":1000}""")))
        assertEquals("bad-line", ask("po.save", po(order, """{"variant_id":"","qty":1000,"unit_cost":1}""")))
        assertEquals("bad-line", ask("po.save", po(order, "").replace("\"lines\":[]", "\"lines\":null")))
        // the four things wrong with a line's product
        assertEquals("unknown-item", ask("po.save", po(order, line(id(199), "", 1000, 4500))))
        assertEquals("not-counted", ask("po.save", po(order, line(fee, "", 1000, 4500))))
        assertEquals("pick-variant", ask("po.save", po(order, line(sized, "", 1000, 4500))))
        assertEquals("unknown-line", ask("po.save", po(order, line(sized, id(198), 1000, 4500))))
        assertEquals("unknown-line", ask("po.save", po(order, line(plain, small, 1000, 4500))))
        assertTrue(dao.orders.isEmpty() && dao.orderLines.isEmpty())
        // an empty draft may be saved, and cannot be sent
        assertEquals("done", ask("po.save", po(order, "")))
        assertEquals("no-lines", ask("po.send", """{"id":"$order"}"""))
        assertEquals("unknown-order", ask("po.send", """{"id":"${id(399)}"}"""))
        assertEquals("not-part", ask("po.close", """{"id":"$order"}"""))
        assertEquals("done", ask("po.cancel", """{"id":"$order"}"""))
        assertEquals("done", ask("po.cancel", """{"id":"$order"}"""))
        assertEquals("cancelled", dao.orders[order]!!.status)
        assertEquals("not-draft", ask("po.send", """{"id":"$order"}"""))
        // a supplier that was removed takes no new order
        ask("supplier.remove", """{"id":"$sup"}""")
        assertEquals("unknown-supplier", ask("po.save", po(id(302), line(plain, "", 1000, 4500))))
    }

    @Test fun `a delivery against an order, in two parts, as the server's example`() {
        shelves()
        dao.levels["$store/$plain/"] = StockLevelEntity(store, plain, "", qty = 2000, avg_cost = 4000.0)
        ask("po.save", stockFixture("po-save"))
        // not while it is a draft
        assertEquals("not-open", ask("delivery.receive", stockFixture("delivery-receive")))
        ask("po.send", stockFixture("po-send"))
        assertEquals("done", ask("delivery.receive", stockFixture("delivery-receive")))
        val d = dao.deliveries[delivery]!!
        assertEquals(listOf("D-0001", order, sup, store, "2026-10-10", "INV-88", null, owner), listOf(d.number, d.order_id, d.supplier_id, d.store_id, d.arrived_on, d.invoice_no, d.note, d.received_by))
        // 2 on the shelf at 40.00 and 10 arriving at 46.00: twelve at 45.00
        val l = dao.levels["$store/$plain/"]!!
        assertEquals(12000, l.qty)
        assertEquals(4500.0, l.avg_cost, 0.0)
        val m = dao.movements.single()
        assertEquals(listOf(plain, "", 10000, "receive", 4600.0, "delivery", delivery, owner), listOf(m.item_id, m.variant_id, m.qty, m.reason, m.unit_cost, m.ref_type, m.ref_id, m.employee_id))
        // what was last paid is what it costs
        assertEquals(4600L, dao.items[plain]!!.cost)
        // ten of twelve soaps and none of the shirts: part received
        assertEquals("part", dao.orders[order]!!.status)
        assertEquals(listOf(10000, 0), dao.orderLines.sortedBy { it.item_id }.map { it.received })
        // the same delivery sent again changes nothing
        assertEquals("done", ask("delivery.receive", stockFixture("delivery-receive")))
        assertEquals(listOf(12000, 1), listOf(dao.levels["$store/$plain/"]!!.qty, dao.movements.size))
        // an order with something received cannot be cancelled, and a part-received one can be closed
        assertEquals("already-received", ask("po.cancel", """{"id":"$order"}"""))
        // the rest arrives, with something that was not ordered
        assertEquals("done", ask("delivery.receive", got(id(311), order, line(plain, "", 2000, 4600) + "," + line(sized, small, 6000, 18000) + "," + line(sized, large, 1000, 19000))))
        assertEquals("received", dao.orders[order]!!.status)
        assertEquals("D-0002", dao.deliveries[id(311)]!!.number)
        assertEquals(listOf(18000L, 19000L), listOf(dao.variants.first { it.id == small }.cost, dao.variants.first { it.id == large }.cost))
        assertEquals(listOf(6000 to 18000.0, 1000 to 19000.0), listOf(dao.levels["$store/$sized/$small"]!!, dao.levels["$store/$sized/$large"]!!).map { it.qty to it.avg_cost })
        // nothing more is received against it
        assertEquals("not-open", ask("delivery.receive", got(id(312), order, line(plain, "", 1000, 4600))))
        assertEquals("not-part", ask("po.close", """{"id":"$order"}"""))
    }

    @Test fun `a delivery with no order, the average it leaves, and what it is refused for`() {
        shelves()
        // nothing on the shelf: it costs what this delivery cost
        assertEquals("done", ask("delivery.receive", got(delivery, "", line(plain, "", 3000, 4533), supplier = sup)))
        assertEquals(listOf(null, sup), dao.deliveries[delivery]!!.let { listOf(it.order_id, it.supplier_id) })
        assertEquals(3000 to 4533.0, dao.levels["$store/$plain/"]!!.let { it.qty to it.avg_cost })
        // 3 at 45.33 and 4 at 46.00: seven at 45.712857, kept to four decimals of a cent as the server keeps it
        assertEquals("done", ask("delivery.receive", got(id(311), "", line(plain, "", 4000, 4600))))
        assertEquals(7000 to 4571.2857, dao.levels["$store/$plain/"]!!.let { it.qty to it.avg_cost })
        assertNull(dao.deliveries[id(311)]!!.supplier_id)
        // a shelf that had gone below nothing costs what arrives
        dao.levels["$store/$sized/$small"] = StockLevelEntity(store, sized, small, qty = -2000, avg_cost = 9999.0)
        assertEquals("done", ask("delivery.receive", got(id(312), "", line(sized, small, 5000, 17000))))
        assertEquals(3000 to 17000.0, dao.levels["$store/$sized/$small"]!!.let { it.qty to it.avg_cost })
        // lines of nothing are passed over, and with nothing left nothing was received
        assertEquals("nothing-received", ask("delivery.receive", got(id(313), "", line(plain, "", 0, 4600))))
        assertEquals("nothing-received", ask("delivery.receive", got(id(313), "", "")))
        assertEquals("bad-line", ask("delivery.receive", got(id(313), "", line(plain, "", -1, 4600))))
        assertEquals("unknown-order", ask("delivery.receive", got(id(313), id(399), line(plain, "", 1000, 4600))))
        assertEquals("unknown-store", ask("delivery.receive", got(id(313), "", line(plain, "", 1000, 4600), at = otherStore)))
        assertEquals("unknown-supplier", ask("delivery.receive", got(id(313), "", line(plain, "", 1000, 4600), supplier = id(39))))
        assertEquals("pick-variant", ask("delivery.receive", got(id(313), "", line(sized, "", 1000, 4600))))
        assertEquals("not-counted", ask("delivery.receive", got(id(313), "", line(fee, "", 1000, 4600))))
        assertEquals("bad-payload", ask("delivery.receive", got(id(313), "", line(plain, "", 1000, 4600)).replace("2026-10-10", "the 10th")))
        assertNull(dao.deliveries[id(313)])
        assertEquals(3, dao.movements.size)
    }

    @Test fun `the tablet can answer an order, a delivery and a count by itself`() {
        assertTrue(listOf("po.save", "po.send", "po.cancel", "po.close", "delivery.receive", "count.complete").all { local.answers(it) })
    }

    // ---- a count of the shelves (the server's count_from_till and count_complete, 0074 and 0092) ----
    private fun counting(lines: String, uncounted: String = "leave", kind: String = "all", scope: String = "", text: String = "", at: String = store, ahead: Long = 0) =
        """{"id":"$count","store_id":"$at","scope_kind":"$kind","scope_id":"$scope","scope_text":"$text","started_at":"2026-10-10T08:00:00Z","clock_ahead_ms":$ahead,"uncounted":"$uncounted","lines":[$lines]}"""
    private fun tally(item: String, variant: String, n: Int?, out: Boolean = false) =
        """{"item_id":"$item","variant_id":"$variant","counted":${n ?: "null"},"counted_at":${if (n == null) "null" else "\"2026-10-10T08:05:00Z\""},"left_out":$out}"""
    private fun level(item: String, variant: String = "") = dao.levels["$store/$item/$variant"]

    @Test fun `a count completed, as the server's example`() {
        shelves()
        dao.variants += ItemVariantEntity(medium, tenant, sized, "M", 49900)
        dao.levels["$store/$plain/"] = StockLevelEntity(store, plain, "", qty = 10000, avg_cost = 4000.0)
        dao.levels["$store/$sized/$small"] = StockLevelEntity(store, sized, small, qty = 3000, avg_cost = 18000.0)
        // soap counted 9 where the tablet holds 10; the small shirts not counted and left as they are; the medium left out
        assertEquals("done", ask("count.complete", stockFixture("count-complete")))
        val c = dao.counts[count]!!
        assertEquals(listOf("C-0001", "completed", "all", null, "The whole shop", "leave", owner, clock), listOf(c.number, c.status, c.scope_kind, c.scope_id, c.title, c.uncounted, c.completed_by, c.completed_at))
        assertEquals(9000, level(plain)!!.qty)
        assertEquals(3000, level(sized, small)!!.qty)
        val m = dao.movements.single()
        assertEquals(listOf(plain, "", -1000, "count", 4000.0, "count", count, owner), listOf(m.item_id, m.variant_id, m.qty, m.reason, m.unit_cost, m.ref_type, m.ref_id, m.employee_id))
        val lines = dao.countLines.associateBy { it.item_id to it.variant_id }
        assertEquals(listOf<Any?>(9000, 10000, -1000, 4000.0, false), lines[plain to ""]!!.let { listOf(it.counted, it.expected, it.diff, it.unit_cost, it.left_out) })
        assertEquals(listOf<Any?>(null, 3000, null, false), lines[sized to small]!!.let { listOf(it.counted, it.expected, it.diff, it.left_out) })
        assertEquals(true, lines[sized to medium]!!.left_out)
        // sent again after a lost answer: it was completed the first time
        assertEquals("done", ask("count.complete", stockFixture("count-complete")))
        assertEquals(listOf(9000, 1), listOf(level(plain)!!.qty, dao.movements.size))
    }

    @Test fun `a sale after a line was counted is no difference, and what was not counted can be set to nothing`() {
        shelves()
        // the tablet's own open count of Clothing: the soap was counted 9 when the tablet held 10, and one was sold since
        dao.counts[count] = com.restopos.core.database.StockCountEntity(count, store, null, "category", scope_id = cat, title = "Clothing", status = "open", started_by = owner, created_at = 1)
        dao.countLines += com.restopos.core.database.StockCountLineEntity(count, plain, "", 9000, 5, expected = 10000)
        dao.levels["$store/$plain/"] = StockLevelEntity(store, plain, "", qty = 9000, avg_cost = 4000.0)
        dao.levels["$store/$sized/$small"] = StockLevelEntity(store, sized, small, qty = 3000)
        dao.levels["$store/$sized/$large"] = StockLevelEntity(store, sized, large, qty = 2000)
        val sent = counting(tally(plain, "", 9000) + "," + tally(sized, small, null) + "," + tally(sized, large, null, out = true), uncounted = "zero", kind = "category", scope = cat)
        assertEquals("done", ask("count.complete", sent))
        // one short when it was counted, and the one sold since stays sold: 8 now
        assertEquals(8000, level(plain)!!.qty)
        // not counted, and set to nothing; left out, and left alone
        assertEquals(listOf(0, 2000), listOf(level(sized, small)!!.qty, level(sized, large)!!.qty))
        val lines = dao.countLines.associateBy { it.item_id to it.variant_id }
        assertEquals(listOf<Any?>(9000, 10000, -1000), lines[plain to ""]!!.let { listOf(it.counted, it.expected, it.diff) })
        assertEquals(listOf<Any?>(0, 3000, -3000), lines[sized to small]!!.let { listOf(it.counted, it.expected, it.diff) })
        assertEquals(listOf(-1000, -3000), dao.movements.map { it.qty })
        val c = dao.counts[count]!!
        assertEquals(listOf("C-0001", "completed", "category", cat, "Clothing", "zero", owner), listOf(c.number, c.status, c.scope_kind, c.scope_id, c.title, c.uncounted, c.started_by))
    }

    @Test fun `what a count is refused for`() {
        shelves()
        val soap = tally(plain, "", 1000)
        assertEquals("bad-scope", ask("count.complete", counting(soap, kind = "shelf")))
        assertEquals("bad-scope", ask("count.complete", counting(soap, kind = "category", scope = id(29))))
        assertEquals("bad-scope", ask("count.complete", counting(soap, kind = "brand", text = "  ")))
        assertEquals("unknown-store", ask("count.complete", counting(soap, at = otherStore)))
        assertEquals("bad-uncounted", ask("count.complete", counting(soap, uncounted = "guess")))
        assertEquals("nothing-to-count", ask("count.complete", counting("")))
        assertEquals("bad-payload", ask("count.complete", counting(soap, ahead = 90_000_000)))
        assertEquals("bad-quantity", ask("count.complete", counting(tally(plain, "", -1))))
        assertEquals("bad-quantity", ask("count.complete", counting("""{"item_id":"$plain","variant_id":"","counted":1000,"counted_at":null,"left_out":false}""")))
        assertEquals("unknown-item", ask("count.complete", counting(tally(id(199), "", 1000))))
        assertEquals("not-counted", ask("count.complete", counting(tally(fee, "", 1000))))
        assertEquals("pick-variant", ask("count.complete", counting(tally(sized, "", 1000))))
        assertEquals("unknown-line", ask("count.complete", counting(tally(sized, id(198), 1000))))
        // a line that is left out is not checked, and one whose product is gone is not written: with only those there is nothing
        assertEquals("nothing-to-count", ask("count.complete", counting(tally(id(199), "", null, out = true))))
        assertTrue(dao.counts.isEmpty() && dao.countLines.isEmpty() && dao.movements.isEmpty())
        // a brand's count is called by the brand
        assertEquals("done", ask("count.complete", counting(soap + "," + tally(id(199), "", null, out = true), kind = "brand", text = " Maison ")))
        assertEquals(listOf("Maison", "Maison", null), dao.counts[count]!!.let { listOf(it.title, it.scope_text, it.scope_id) })
        assertEquals(1, dao.countLines.size)
    }

    // ---- roles, staff, discounts (the server's 0095, sections S and D of its suite) ----
    @Test fun `a role added, its ticks changed, and what the sheet did not offer kept`() {
        val sent = fixture("role-save", mapOf("role-1" to id(42)))
        assertEquals("done", ask("role.save", sent))
        assertEquals("[\"payment.take\",\"sale.create\",\"sale.refund\"]", dao.roles[id(42)]!!.permissions)
        assertEquals("done", ask("role.save", sent))
        dao.roles[id(42)] = dao.roles[id(42)]!!.copy(permissions = "[\"payment.take\",\"sale.create\",\"sale.refund\",\"stock.count\"]")
        val changed = JsonObject(sent + ("name" to JsonPrimitive("Shift lead")) + ("permissions" to Json.parseToJsonElement("[\"sale.create\",\"items.edit\"]")))
        assertEquals("done", ask("role.save", changed))
        assertEquals(listOf("Shift lead", "[\"items.edit\",\"sale.create\",\"stock.count\"]"), dao.roles[id(42)]!!.let { listOf(it.name, it.permissions) })
        // the owner's star is never taken
        val star = JsonObject(sent + ("name" to JsonPrimitive("Shift lead")) + ("permissions" to Json.parseToJsonElement("[\"*\",\"sale.create\"]")) + ("offered" to Json.parseToJsonElement("[\"*\",\"sale.create\"]")))
        assertEquals("done", ask("role.save", star))
        assertFalse(dao.roles[id(42)]!!.permissions.contains("*"))
        assertEquals("name-taken", ask("role.save", JsonObject(sent + ("id" to JsonPrimitive(id(43))) + ("name" to JsonPrimitive("cashier")))))
        assertEquals("name-required", ask("role.save", JsonObject(sent + ("name" to JsonPrimitive(" ")))))
    }

    @Test fun `the owner's role is not changed or removed, and a role staff hold is not removed`() {
        dao.roles[id(44)] = RoleEntity(id(44), tenant, "Owner", "[\"*\"]")
        val sent = fixture("role-save", mapOf("role-1" to id(44)))
        assertEquals("owner-role", ask("role.save", sent))
        assertEquals("owner-role", ask("role.remove", """{"role_id":"${id(44)}"}"""))
        dao.employees[id(500)] = EmployeeEntity(id(500), tenant, "Ben", "x", role)
        assertEquals("role-in-use", ask("role.remove", """{"role_id":"$role"}"""))
        dao.employees[id(500)] = dao.employees[id(500)]!!.copy(role_id = id(44))
        assertEquals("done", ask("role.remove", """{"role_id":"$role"}"""))
        assertTrue(dao.roles[role]!!.let { it.deleted_at != null && it.name.startsWith("Cashier (removed ") })
        assertEquals("done", ask("role.remove", """{"role_id":"$role"}"""))
        assertEquals("bad-role", ask("role.remove", """{"role_id":"${id(49)}"}"""))
        // its name is free, and it is not brought back
        assertEquals("bad-role", ask("role.save", fixture("role-save", mapOf("role-1" to role))))
        assertEquals("done", ask("role.save", JsonObject(fixture("role-save", mapOf("role-1" to id(45))) + ("name" to JsonPrimitive("Cashier")))))
    }

    @Test fun `a member of staff's name, role and whether they may use the tills`() {
        dao.roles[id(42)] = RoleEntity(id(42), tenant, "Supervisor", "[]")
        dao.employees[id(500)] = EmployeeEntity(id(500), tenant, "Ben", "x", role)
        assertEquals("done", ask("staff.update", fixture("staff-update", mapOf("staff-1" to id(500), "role-1" to id(42)))))
        assertEquals(listOf("Benjamin", id(42), true), dao.employees[id(500)]!!.let { listOf(it.name, it.role_id, it.is_active) })
        assertEquals("done", ask("staff.update", """{"employee_id":"${id(500)}","active":false}"""))
        assertEquals(listOf("Benjamin", id(42), false), dao.employees[id(500)]!!.let { listOf(it.name, it.role_id, it.is_active) })
        assertEquals("bad-role", ask("staff.update", """{"employee_id":"${id(500)}","role_id":"${id(49)}"}"""))
        assertEquals("name-required", ask("staff.update", """{"employee_id":"${id(500)}","name":"  "}"""))
        assertEquals("unknown-staff", ask("staff.update", """{"employee_id":"${id(599)}","name":"Nobody"}"""))
        dao.employees[id(501)] = EmployeeEntity(id(501), tenant, "Owner", "x", role, has_login = true)
        assertEquals("has-login", ask("staff.update", """{"employee_id":"${id(501)}","active":false}"""))
        assertTrue(dao.employees[id(501)]!!.is_active)
    }

    @Test fun `a discount added, changed and removed`() {
        val sent = fixture("discount-save", mapOf("discount-1" to id(60)))
        assertEquals("done", ask("discount.save", sent))
        assertEquals(listOf("Staff meal", "percent", 20L, true), dao.discounts[id(60)]!!.let { listOf(it.name, it.type, it.value, it.requires_approval) })
        assertEquals("done", ask("discount.save", JsonObject(sent + ("name" to JsonPrimitive("Loyal customer")) + ("type" to JsonPrimitive("amount")) + ("value" to JsonPrimitive(5000)) + ("requires_approval" to JsonPrimitive(false)))))
        assertEquals(listOf("Loyal customer", "amount", 5000L, false), dao.discounts[id(60)]!!.let { listOf(it.name, it.type, it.value, it.requires_approval) })
        assertEquals("bad-value", ask("discount.save", JsonObject(sent + ("value" to JsonPrimitive(101)))))
        assertEquals("bad-value", ask("discount.save", JsonObject(sent + ("value" to JsonPrimitive(0)))))
        assertEquals("bad-value", ask("discount.save", JsonObject(sent + ("type" to JsonPrimitive("amount")) + ("value" to JsonPrimitive(100000001)))))
        assertEquals("name-required", ask("discount.save", JsonObject(sent + ("name" to JsonPrimitive("")))))
        assertEquals("bad-payload", ask("discount.save", JsonObject(sent + ("type" to JsonPrimitive("half")))))
        assertEquals("name-taken", ask("discount.save", JsonObject(sent + ("id" to JsonPrimitive(id(61))) + ("name" to JsonPrimitive("loyal CUSTOMER")))))
        assertEquals("done", ask("discount.remove", """{"discount_id":"${id(60)}"}"""))
        assertTrue(dao.discounts[id(60)]!!.let { it.deleted_at != null && it.name.startsWith("Loyal customer (removed ") })
        assertEquals("done", ask("discount.remove", """{"discount_id":"${id(60)}"}"""))
        assertEquals("bad-discount", ask("discount.save", sent))
        assertEquals("bad-discount", ask("discount.remove", """{"discount_id":"${id(69)}"}"""))
    }

    @Test fun `what is sent for a role, a member of staff and a discount is the example the server was tested with`() {
        assertEquals(OfficeFixtures.payload("role-save"), OfficePayloads.roleSave("role-1", "Supervisor", setOf("sale.refund", "sale.create", "payment.take"), listOf("sale.create", "payment.take", "sale.apply_discount", "sale.refund", "items.edit"), null))
        assertEquals(OfficeFixtures.payload("role-remove"), OfficePayloads.roleRemove("role-1", null))
        assertEquals(OfficeFixtures.payload("staff-update"), OfficePayloads.staffUpdate("staff-1", "Benjamin", "role-1", true, null))
        assertEquals(setOf("employee_id", "active"), OfficePayloads.staffUpdate("staff-1", null, null, false, null).keys)
        val d = DiscountForm.read(" Staff meal ", percent = true, value = "20", needsManager = true).getOrThrow()
        assertEquals(OfficeFixtures.payload("discount-save"), OfficePayloads.discountSave("discount-1", d, null))
        assertEquals(OfficeFixtures.payload("discount-remove"), OfficePayloads.discountRemove("discount-1", null))
        assertEquals(DiscountForm.Discount("Rs off", false, 5050, false), DiscountForm.read("Rs off", false, "50.50", false).getOrThrow())
        assertEquals("A percentage is a whole number from 1 to 100", DiscountForm.read("X", true, "12.5", false).exceptionOrNull()?.message)
        assertEquals("Say how much the discount takes off", DiscountForm.read("X", false, "0", false).exceptionOrNull()?.message)
    }

    @Test fun `the permissions a role's sheet offers are the back office's, by kind of business`() {
        val file = Json.parseToJsonElement(java.io.File("../../db/tests/fixtures/till-office/perms.json").readText()).jsonObject
        fun of(kind: String) = (file[kind] as kotlinx.serialization.json.JsonArray).map { g ->
            g.jsonObject["title"].toString().trim('"') to (g.jsonObject["perms"] as kotlinx.serialization.json.JsonArray).map { p ->
                (p as kotlinx.serialization.json.JsonArray).let { (it[0] as JsonPrimitive).content to (it[1] as JsonPrimitive).content }
            }
        }
        assertEquals(of("restaurant"), Perms.groups(shop = false).map { it.title to it.perms })
        assertEquals(of("retail"), Perms.groups(shop = true).map { it.title to it.perms })
        // what a role holds after a save: the ticks among what was offered, and what it held besides
        assertEquals(listOf("items.edit", "sale.create", "stock.count"), RoleForm.saved(setOf("sale.create", "sale.refund", "stock.count"), setOf("sale.create", "items.edit"), listOf("sale.create", "sale.refund", "items.edit")))
        assertEquals("Can do everything", RoleForm.says("[\"*\"]", shop = false))
        assertEquals("2 of ${Perms.offered(false).size} permissions", RoleForm.says("[\"sale.create\",\"payment.take\",\"stock.count\"]", shop = false))
    }

    // ---- add-ons, an item's groups, a few settings (the server's 0096, sections A and Z of its suite) ----
    private val addonIds = mapOf("group-1" to id(70), "choice-1" to id(71), "choice-2" to id(72), "item-1" to id(100), "category-1" to cat)
    private fun live(group: String) = dao.choices.values.filter { it.group_id == group && it.deleted_at == null }.map { it.name + ":" + it.price }.sorted()

    @Test fun `a group of add-ons saved whole, changed and removed`() {
        val sent = fixture("addon-save", addonIds)
        assertEquals("done", ask("addon.save", sent))
        assertEquals(listOf("Extras", 0, 2), dao.groups[id(70)]!!.let { listOf(it.name, it.min_select, it.max_select) })
        assertEquals(listOf("Cheese:2500", "Chilli:0"), live(id(70)))
        assertEquals("done", ask("addon.save", sent))
        assertEquals(2, dao.choices.size)
        // a choice renamed, one dropped, one added
        val changed = obj("""{"id":"${id(70)}","name":"Toppings","min":1,"max":3,"choices":[{"id":"${id(71)}","name":"Cheddar","price":3000},{"id":"${id(73)}","name":"Egg","price":1500}]}""")
        assertEquals("done", ask("addon.save", changed))
        assertEquals(listOf("Cheddar:3000", "Egg:1500"), live(id(70)))
        assertNotNull(dao.choices[id(72)]!!.deleted_at)
        assertEquals("bad-limits", ask("addon.save", JsonObject(sent + ("min" to JsonPrimitive(3)) + ("max" to JsonPrimitive(2)))))
        assertEquals("bad-limits", ask("addon.save", JsonObject(sent + ("max" to JsonPrimitive(21)))))
        assertEquals("name-required", ask("addon.save", JsonObject(sent + ("name" to JsonPrimitive(" ")))))
        assertEquals("name-required", ask("addon.save", obj("""{"id":"${id(70)}","name":"Toppings","min":0,"max":0,"choices":[{"id":"${id(74)}","name":"","price":0}]}""")))
        assertEquals("name-taken", ask("addon.save", obj("""{"id":"${id(75)}","name":"toppings","min":0,"max":0,"choices":[]}""")))
        // removed: off its items, its choices gone, its name freed
        dao.itemGroups += com.restopos.core.database.ItemModGroupCrossRef(id(100), id(70))
        assertEquals("done", ask("addon.remove", """{"group_id":"${id(70)}"}"""))
        assertTrue(dao.groups[id(70)]!!.let { it.deleted_at != null && it.name.startsWith("Toppings (removed ") })
        assertTrue(live(id(70)).isEmpty() && dao.itemGroups.isEmpty())
        assertEquals("done", ask("addon.remove", """{"group_id":"${id(70)}"}"""))
        assertEquals("bad-group", ask("addon.save", sent))
        assertEquals("bad-group", ask("addon.remove", """{"group_id":"${id(79)}"}"""))
    }

    @Test fun `the add-on groups an item carries`() {
        dao.settings = SettingsEntity(tenant, """{"plan":"offline"}""")
        ask("addon.save", fixture("addon-save", addonIds))
        ask("addon.save", obj("""{"id":"${id(76)}","name":"Cooking","min":1,"max":1,"choices":[{"id":"${id(77)}","name":"Rare","price":0}]}"""))
        val item = fixture("item-save-groups", addonIds)
        assertEquals("done", ask("item.save", item))
        assertEquals(listOf(id(70)), runBlocking { dao.groupsOf(id(100)) })
        assertEquals("done", ask("item.save", JsonObject(item + ("groups" to Json.parseToJsonElement("[\"${id(76)}\"]")))))
        assertEquals(listOf(id(76)), runBlocking { dao.groupsOf(id(100)) })
        // a save that names no groups leaves them
        assertEquals("done", ask("item.save", JsonObject(item - "groups")))
        assertEquals(listOf(id(76)), runBlocking { dao.groupsOf(id(100)) })
        // one that is not there is refused, and nothing of the save is written
        assertEquals("bad-group", ask("item.save", JsonObject(item + ("name" to JsonPrimitive("Renamed")) + ("groups" to Json.parseToJsonElement("[\"${id(78)}\"]")))))
        assertEquals("Dholl puri", dao.items[id(100)]!!.name)
        assertEquals("done", ask("item.save", JsonObject(item + ("groups" to Json.parseToJsonElement("[]")))))
        assertTrue(runBlocking { dao.groupsOf(id(100)) }.isEmpty())
    }

    @Test fun `the receipt's two notes and the service charge, and nothing else of the settings`() {
        dao.settings = SettingsEntity(tenant, """{"plan":"offline","quickPay":"cash","receipt":{"header":"Old","footer":"Old foot","logo":"data:image/png;base64,AAAA","showLogo":false}}""")
        assertEquals("done", ask("settings.save", OfficeFixtures.payload("settings-save").jsonObject))
        val st = PosSettings.parse(dao.settings!!.data)
        assertEquals(listOf("Open every day, 9 to 9", "Thank you. See you again soon.", "data:image/png;base64,AAAA", false, 10, "cash", true),
            listOf(st.header, st.footer, st.logo, st.showLogo, st.servicePct, st.quickPay, st.alone))
        assertEquals("bad-value", ask("settings.save", """{"servicePct":31}"""))
        assertEquals("done", ask("settings.save", """{"receipt":{"footer":"${"x".repeat(400)}"}}"""))
        val after = PosSettings.parse(dao.settings!!.data)
        assertEquals(listOf(300, "Open every day, 9 to 9", 10), listOf(after.footer.length, after.header, after.servicePct))
    }

    @Test fun `what is sent for a group of add-ons, an item's groups and the settings is the example the server was tested with`() {
        val g = AddonForm.read(" Extras ", "", "2", listOf(AddonForm.Typed("choice-1", "Cheese", "25"), AddonForm.Typed("choice-2", "Chilli", ""), AddonForm.Typed("choice-3"))).getOrThrow()
        assertEquals(OfficeFixtures.payload("addon-save"), OfficePayloads.addonSave("group-1", g, null))
        assertEquals(OfficeFixtures.payload("addon-remove"), OfficePayloads.addonRemove("group-1", null))
        assertEquals(OfficeFixtures.payload("settings-save"), OfficePayloads.settingsSave("Open every day, 9 to 9", "Thank you. See you again soon.", 10, null))
        assertEquals(setOf("servicePct"), OfficePayloads.settingsSave(null, null, 0, null).keys)
        val dish = ItemForm.read("Dholl puri", "25", false, "").getOrThrow()
        val more = ItemForm.readMore(ItemForm.Typed(taxId = null, shop = false, groups = setOf("group-1"))).getOrThrow()
        assertEquals(OfficeFixtures.payload("item-save-groups"), OfficePayloads.itemSave("item-1", dish, "category-1", true, false, more, "store-1", null))
        // of an item being changed, its groups are sent only when they were changed
        val same = ItemForm.readMore(ItemForm.Typed(taxId = "t", groups = setOf("a")), from = ItemForm.Typed(taxId = "t", groups = setOf("a"))).getOrThrow()
        assertFalse(OfficePayloads.itemSave("item-1", dish, null, true, false, same, "store-1", null).containsKey("groups"))
        assertEquals("The most that can be picked cannot be less than the fewest", AddonForm.read("X", "3", "2", emptyList()).exceptionOrNull()?.message)
        assertEquals("Give each choice a name", AddonForm.read("X", "", "", listOf(AddonForm.Typed("c", "", "5"))).exceptionOrNull()?.message)
        assertEquals(listOf("Optional, any number", "Optional, up to 2", "At least 1", "Pick 1", "Pick 1 to 3"), listOf(0 to 0, 0 to 2, 1 to 0, 1 to 1, 1 to 3).map { AddonForm.rule(it.first, it.second) })
    }

    // ---- a product's variants (the server's 0097, section V of its suite) ----
    private val variantIds = mapOf("item-1" to id(100), "variant-1" to id(201), "variant-2" to id(202), "variant-3" to id(203), "variant-4" to id(204))
    private fun names(item: String) = dao.variants.filter { it.item_id == item && it.deleted_at == null }.map { it.name }.sorted()

    @Test fun `a product's lines made under the tablet's ids, and made once`() {
        dao.items[id(100)] = ItemEntity(id(100), tenant, null, "Polo", 49900, cost = 17000, track_stock = true)
        val sent = fixture("variants-make", variantIds)
        assertEquals("done", ask("variants.make", sent))
        assertEquals(listOf("M / Navy", "M / White", "S / Navy", "S / White"), names(id(100)))
        val line = dao.variants.first { it.id == id(201) }
        assertEquals(listOf("S / White", 49900L, 17000L, "[\"S\",\"White\"]"), listOf(line.name, line.price, line.cost, line.option_values))
        assertEquals("[\"Size\",\"Colour\"]", dao.items[id(100)]!!.option_names)
        assertEquals("done", ask("variants.make", sent))
        assertEquals(4, dao.variants.size)
        // a size added later makes its lines only; one it has, typed in other letters, is left
        assertEquals("done", ask("variants.make", """{"item_id":"${id(100)}","names":["Size","Colour"],"lines":[{"id":"${id(205)}","values":["L","White"]},{"id":"${id(206)}","values":["s","white"]}]}"""))
        assertEquals(5, dao.variants.size)
        val one = { names: String, lines: String -> ask("variants.make", """{"item_id":"${id(100)}","names":[$names],"lines":[$lines]}""") }
        assertEquals("bad-options", one("\"Size\"", """{"id":"${id(207)}","values":["XL"]}"""))
        assertEquals("bad-options", one("\"Size\",\"size\"", """{"id":"${id(207)}","values":["XL","x"]}"""))
        assertEquals("bad-options", one("\"Size\",\"Colour\"", """{"id":"${id(207)}","values":["XL"]}"""))
        assertEquals("bad-options", one("\"Size\",\"Colour\"", """{"id":"${id(207)}","values":["XL","Red"]},{"id":"${id(208)}","values":["xl","red"]}"""))
        assertEquals("unknown-item", ask("variants.make", JsonObject(sent + ("item_id" to JsonPrimitive(id(999))))))
        // a product with stock of its own is not given variants
        dao.items[id(101)] = ItemEntity(id(101), tenant, null, "Stocked", 1000, track_stock = true)
        dao.levels["x"] = StockLevelEntity(store, id(101), "", qty = 5000)
        assertEquals("has-stock", ask("variants.make", """{"item_id":"${id(101)}","names":["Size"],"lines":[{"id":"${id(209)}","values":["S"]}]}"""))
    }

    @Test fun `a line's codes saved, and a line removed`() {
        dao.items[id(100)] = ItemEntity(id(100), tenant, null, "Polo", 49900, cost = 17000, track_stock = true)
        ask("variants.make", fixture("variants-make", variantIds))
        assertEquals("done", ask("variants.save", fixture("variants-save", variantIds)))
        assertEquals(listOf("6091234500024", "POLO-S-WH", 17500L), dao.variants.first { it.id == id(201) }.let { listOf(it.barcode, it.sku, it.cost) })
        // a barcode or a SKU another line has
        assertEquals("barcode-taken", ask("variants.save", """{"item_id":"${id(100)}","lines":[{"id":"${id(202)}","barcode":"6091234500024"}]}"""))
        assertEquals("sku-taken", ask("variants.save", """{"item_id":"${id(100)}","lines":[{"id":"${id(202)}","sku":"polo-s-wh"}]}"""))
        assertEquals("unknown-variant", ask("variants.save", """{"item_id":"${id(100)}","lines":[{"id":"${id(299)}","sku":"X"}]}"""))
        // its own codes are its own, a cost not sent is left, and emptied codes are none
        assertEquals("done", ask("variants.save", """{"item_id":"${id(100)}","lines":[{"id":"${id(201)}","barcode":"6091234500024","sku":"POLO-S-WH"}]}"""))
        assertEquals("done", ask("variants.save", """{"item_id":"${id(100)}","lines":[{"id":"${id(201)}","barcode":"","sku":""}]}"""))
        assertEquals(listOf(null, null, 17500L), dao.variants.first { it.id == id(201) }.let { listOf(it.barcode, it.sku, it.cost) })
        // a line that holds stock is not removed
        dao.levels["y"] = StockLevelEntity(store, id(100), id(202), qty = 3000)
        assertEquals("has-stock", ask("variant.remove", """{"variant_id":"${id(202)}"}"""))
        assertEquals("done", ask("variant.remove", fixture("variant-remove", variantIds)))
        assertEquals("done", ask("variant.remove", fixture("variant-remove", variantIds)))
        assertEquals(listOf("M / Navy", "M / White", "S / Navy"), names(id(100)))
        assertEquals("unknown-variant", ask("variant.remove", """{"variant_id":"${id(298)}"}"""))
        // with its last variant gone, a product is a simple one again
        dao.levels.remove("y")
        listOf(202, 203, 204).forEach { ask("variant.remove", """{"variant_id":"${id(it)}"}""") }
        assertEquals("[]", dao.items[id(100)]!!.option_names)
    }

    @Test fun `the options typed are read as the lines to make, and what is sent is the server's example`() {
        var n = 0
        val ids = { "variant-${++n}" }
        val make = VariantForm.read(listOf(VariantForm.Option("Size", "S, M"), VariantForm.Option(" Colour ", "White,Navy, white"), VariantForm.Option()), emptyList(), 0, ids).getOrThrow()
        assertEquals(OfficeFixtures.payload("variants-make"), OfficePayloads.variantsMake("item-1", make, null))
        // a value added later: only the lines the product does not have
        val more = VariantForm.read(listOf(VariantForm.Option("Size", "S, M, L"), VariantForm.Option("Colour", "White, Navy")), make.lines.map { it.values }, 2, { "new" }).getOrThrow()
        assertEquals(listOf(listOf("L", "White"), listOf("L", "Navy")), more.lines.map { it.values })
        val said = { o: List<VariantForm.Option>, has: List<List<String>>, had: Int -> VariantForm.read(o, has, had) { "x" }.exceptionOrNull()?.message }
        assertEquals("Every one of those is already there", said(listOf(VariantForm.Option("Size", "S"), VariantForm.Option("Colour", "white")), make.lines.map { it.values }, 2))
        assertEquals("Name an option, for example Size, and give its values", said(listOf(VariantForm.Option()), emptyList(), 0))
        assertEquals("Give Size at least one value", said(listOf(VariantForm.Option("Size", " , ")), emptyList(), 0))
        assertEquals("Two options have the same name", said(listOf(VariantForm.Option("Size", "S"), VariantForm.Option("size", "M")), emptyList(), 0))
        assertTrue(said(listOf(VariantForm.Option("Size", "S")), make.lines.map { it.values }, 2)!!.contains("that number cannot change"))
        assertEquals(OfficeFixtures.payload("variants-save"), OfficePayloads.variantSave("item-1", "variant-1", "6091 2345 00024", " POLO-S-WH ", true, 17500, null))
        assertFalse((OfficePayloads.variantSave("item-1", "variant-1", "", "", false, 5, null)["lines"] as kotlinx.serialization.json.JsonArray)[0].jsonObject.containsKey("cost"))
        assertEquals(OfficeFixtures.payload("variant-remove"), OfficePayloads.variantRemove("variant-1", null))
        assertEquals(listOf("S", "M", "L"), VariantForm.values("S, M ,  m; L,"))
    }

    @Test fun `the printers a category's orders print on`() {
        dao.printers[id(400)] = PrinterEntity(id(400), tenant, store, "Counter", is_receipt = true, sort_order = 0)
        dao.printers[id(401)] = PrinterEntity(id(401), tenant, store, "Kitchen", sort_order = 1)
        val sent = fixture("category-save-printers", mapOf("category-1" to id(23), "printer-1" to id(401)))
        assertEquals("done", ask("category.save", sent))
        assertEquals("[\"${id(401)}\"]", dao.categories[id(23)]!!.printer_ids)
        // one that is no printer is left out; both, in the printers' own order
        assertEquals("done", ask("category.save", JsonObject(sent + ("printer_ids" to Json.parseToJsonElement("[\"${id(401)}\",\"${id(499)}\",\"${id(400)}\"]")))))
        assertEquals("[\"${id(400)}\",\"${id(401)}\"]", dao.categories[id(23)]!!.printer_ids)
        // a save that names none leaves them, and an empty list clears them
        assertEquals("done", ask("category.save", JsonObject(sent - "printer_ids" + ("name" to JsonPrimitive("Grill and BBQ")))))
        assertEquals(listOf("Grill and BBQ", "[\"${id(400)}\",\"${id(401)}\"]"), dao.categories[id(23)]!!.let { listOf(it.name, it.printer_ids) })
        assertEquals("done", ask("category.save", JsonObject(sent + ("printer_ids" to Json.parseToJsonElement("[]")))))
        assertEquals("[]", dao.categories[id(23)]!!.printer_ids)
        assertEquals("bad-payload", ask("category.save", JsonObject(sent + ("printer_ids" to JsonPrimitive("kitchen")))))
        assertEquals("bad-payload", ask("category.save", JsonObject(sent + ("printer_ids" to Json.parseToJsonElement("[\"not-an-id\"]")))))
    }

    @Test fun `a change this tablet cannot answer by itself says so`() {
        // a booking belongs to Premium, which is the cloud: nothing of it is answered on a tablet that works on its own
        assertEquals("not-alone", ask("booking.upsert", "{}"))
        assertFalse(local.answers("booking.upsert"))
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
