package com.restopos.core.data

import com.restopos.core.common.Uuid7
import com.restopos.core.database.AloneDao
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.StockMovementEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TaxEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.Instant

// A change the tablet's own rules refuse, under the server's code for it: the
// screen that asked turns it into words exactly as it does a server's refusal.
class Refused(val code: String) : Exception(code)

// A tablet that works on its own (the offline edition) answers by itself the
// changes a linked till asks the server for and waits: a product, a tax, a
// table, a member of staff. Each function here is the server's function of
// the same name (push_item_save and the rest), written again over the
// tablet's own rows: the same checks in the same order, the same refusals,
// and the rows left as a pull would have left them. The change itself is
// then kept in the queue (ServiceRepository.ask), and the day the business
// goes Premium the server takes it by that same function. So a rule that is
// looser here than there would be refused on that day, with what depends on
// it: nothing is decided here that the server's function does not decide.
//
// Who may is not asked here: the screen has asked already, as it does before
// asking the server.
class LocalAnswers(private val dao: AloneDao, private val clock: () -> Long = System::currentTimeMillis, private val newId: () -> String = Uuid7::next) {
    private fun now(): String = Instant.ofEpochMilli(clock()).toString()
    private fun bad(): Nothing = throw Refused("bad-payload")

    // The kinds of change this tablet can answer by itself.
    fun answers(type: String): Boolean = type in KINDS

    // One change, applied. Call it inside one transaction with the queueing of the change.
    suspend fun apply(type: String, p: JsonObject, tenant: String, employee: String?) {
        when (type) {
            "item.save" -> itemSave(p, tenant)
            "item.remove" -> itemRemove(p)
            "category.save" -> categorySave(p, tenant)
            "category.remove" -> categoryRemove(p)
            "stock.adjust" -> stockAdjust(p, employee)
            "tables.add" -> tablesAdd(p, tenant)
            "printer.save" -> printerSave(p, tenant)
            "company.save" -> companySave(p, tenant)
            "staff.save" -> staffSave(p, tenant)
            "staff.set_pin" -> staffSetPin(p)
            "tax.save" -> taxSave(p, tenant)
            "supplier.save" -> supplierSave(p, tenant)
            "supplier.remove" -> supplierRemove(p)
            else -> throw Refused("not-alone")
        }
    }

    // ---- push_item_save (0084, 0087, 0094) ----
    private suspend fun itemSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        var price = p.long("price") ?: 0
        val cat = p.str("category_id")?.ifEmpty { null }
        val open = p.bool("open_price") ?: false
        val avail = p.bool("available") ?: true
        val track = p.bool("track_stock")
        val newTax = p.str("tax_id")?.ifEmpty { null }
        val sup = p.str("supplier_id")?.ifEmpty { null }
        val store = p.str("store_id")?.ifEmpty { null }
        val cost = p.long("cost")
        val point = p.long("reorder_point")
        val qty = p.long("reorder_qty")
        if (cost != null && (cost < 0 || cost > 100_000_000L)) bad()
        if ((point ?: 0) < 0 || (qty ?: 0) < 0) throw Refused("bad-quantity")
        val name = (p.str("name") ?: "").trim().take(80)
        val code = (p.str("barcode") ?: "").filterNot { it.isWhitespace() }.ifEmpty { null }
        if (price < 0 || price > 100_000_000L || (code?.length ?: 0) > 64) bad()
        if (name.isEmpty()) throw Refused("name-required")
        // one whose price is typed at the sale has none of its own
        if (open) price = 0
        if (cat != null && dao.category(cat)?.takeIf { it.deleted_at == null } == null) throw Refused("bad-category")
        val taxes = dao.taxes().filter { it.deleted_at == null }
        if (newTax != null && taxes.none { it.id == newTax }) throw Refused("bad-tax")
        if (sup != null && dao.supplier(sup)?.takeIf { it.deleted_at == null } == null) throw Refused("unknown-supplier")
        // a reorder level is one store's: the till names its own
        val reorder = "reorder_point" in p || "reorder_qty" in p
        if (reorder && (store == null || store !in dao.storeIds())) throw Refused("bad-store")
        fun text(key: String) = p.str(key)?.trim()?.take(60)?.ifEmpty { null }

        val was = dao.item(id)
        // a barcode and a SKU are one product's only (the server's guard on the table)
        val sku = if ("sku" in p) text("sku") else was?.sku
        if (code != null && (dao.itemsWithBarcode(code, id) > 0 || dao.variantsWithBarcode(code, id) > 0)) throw Refused("barcode-taken")
        if (sku != null && (dao.itemsWithSku(sku, id) > 0 || dao.variantsWithSku(sku, id) > 0)) throw Refused("sku-taken")

        if (was != null) {
            if (was.deleted_at != null) throw Refused("bad-item")
            if (open && (was.sold_by == "weight" || dao.variantsOf(id).isNotEmpty())) throw Refused("open-price-not-here")
            dao.putItem(was.copy(
                name = name, price = price, open_price = open, category_id = cat, barcode = code, is_available = avail,
                // one whose price is typed at the sale is a service, and has no stock to count
                track_stock = if (track == null) was.track_stock else track && !open,
                sku = sku,
                brand = if ("brand" in p) text("brand") else was.brand,
                supplier_id = if ("supplier_id" in p) sup else was.supplier_id,
                supplier_code = if ("supplier_code" in p) text("supplier_code") else was.supplier_code,
                // the sheet sends a cost only when it showed one
                cost = if ("cost" in p) cost else was.cost,
            ))
            // one tax per item: the others are taken off, the chosen one put on
            if (newTax != null) { dao.dropTaxesOf(id); dao.putItemTax(ItemTaxCrossRef(id, newTax)) }
        } else {
            val shop = PosSettings.parse(dao.settings()?.data).retail
            dao.putItem(ItemEntity(
                id, tenant, cat, name, price, avail, barcode = code, sku = sku,
                track_stock = (track ?: shop) && !open, open_price = open,
                cost = if ("cost" in p) cost else null, supplier_id = sup, brand = text("brand"), supplier_code = text("supplier_code"),
            ))
            // the tax the sheet named, or the usual one
            val tax = newTax ?: taxes.sortedWith(compareByDescending<TaxEntity> { it.is_default }.thenBy { it.id }).firstOrNull()?.id
            if (tax != null) dao.putItemTax(ItemTaxCrossRef(id, tax))
        }
        if (reorder) setReorder(store!!, id, point?.toInt(), qty?.toInt())
    }

    // stock_set_reorder: on every line of the product in one shop, its variants or itself when it has none
    private suspend fun setReorder(store: String, item: String, point: Int?, qty: Int?) {
        val variants = dao.variantsOf(item).map { it.id }.ifEmpty { listOf("") }
        val have = dao.levelsOf(store, item).associateBy { it.variant_id }
        dao.putLevels(variants.map { v -> (have[v] ?: StockLevelEntity(store, item, v)).copy(reorder_point = point, reorder_qty = qty) })
    }

    // ---- push_item_remove ----
    private suspend fun itemRemove(p: JsonObject) {
        val was = dao.item(p.id("item_id")) ?: throw Refused("bad-item")
        // removed already is removed
        if (was.deleted_at == null) dao.putItem(was.copy(deleted_at = now()))
    }

    // ---- push_category_save, push_category_remove (0087) ----
    private suspend fun categorySave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val name = (p.str("name") ?: "").trim().take(60)
        val color = (p.str("color") ?: "").trim().lowercase().ifEmpty { null }
        if (color != null && !COLOR.matches(color)) bad()
        if (name.isEmpty()) throw Refused("name-required")
        val was = dao.category(id)
        if (was != null) {
            if (was.deleted_at != null) throw Refused("bad-category")
            // the name and the colour only: its printers, its place and whether its stock is counted are left
            dao.putCategory(was.copy(name = name, color = color))
        } else dao.putCategory(CategoryEntity(id, tenant, name, color, sort_order = dao.lastCategoryPlace() + 1))
    }

    private suspend fun categoryRemove(p: JsonObject) {
        val was = dao.category(p.id("category_id")) ?: throw Refused("bad-category")
        if (dao.itemsIn(was.id) > 0) throw Refused("has-items")
        if (was.deleted_at == null) dao.putCategory(was.copy(deleted_at = now()))
    }

    // ---- push_stock_adjust (0087) ----
    private suspend fun stockAdjust(p: JsonObject, employee: String?) {
        val store = p.id("store_id")
        val item = p.id("item_id")
        val variant = p.str("variant_id")?.ifEmpty { null }
        val units = p.long("units")
        val way = p.str("direction") ?: ""
        var reason = (p.str("reason") ?: "").trim().ifEmpty { null }
        val note = (p.str("note") ?: "").trim().take(120).ifEmpty { null }
        if (way != "in" && way != "out") bad()
        if (units == null || units <= 0 || units > Int.MAX_VALUE) throw Refused("bad-qty")
        // no reason is an adjustment; a reason belongs to its direction
        if (reason == null) reason = "adjust"
        else if (way == "in" && reason !in IN_REASONS) throw Refused("bad-reason")
        else if (way == "out" && reason !in OUT_REASONS) throw Refused("bad-reason")
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val it = dao.item(item)?.takeIf { it.deleted_at == null } ?: throw Refused("bad-item")
        val counted = it.track_stock || it.category_id?.let { c -> dao.category(c)?.is_stock } == true
        if (!counted) throw Refused("not-counted")
        // a product with variants holds its stock on them, never on itself
        val variants = dao.variantsOf(item)
        if (variant == null) { if (variants.isNotEmpty()) throw Refused("pick-variant") }
        else if (variants.none { v -> v.id == variant }) throw Refused("bad-variant")
        val level = dao.levelsOf(store, item).firstOrNull { l -> l.variant_id == (variant ?: "") } ?: StockLevelEntity(store, item, variant ?: "")
        if (way == "out" && level.qty < units) throw Refused("not-enough-stock")
        val by = if (way == "out") -units.toInt() else units.toInt()
        dao.putLevels(listOf(level.copy(qty = level.qty + by)))
        // the tablet's own line in the stock history; the server writes its own the day this is sent
        dao.putMovement(StockMovementEntity(newId(), store, item, variant ?: "", by, reason, employee_id = employee, note = note, created_at = clock()))
    }

    // ---- push_tables_add (0089) ----
    private suspend fun tablesAdd(p: JsonObject, tenant: String) {
        val store = p.id("store_id")
        val area = (p.str("area") ?: "").trim().take(30)
        val rows = (p["tables"] as? JsonArray) ?: bad()
        if (area.isEmpty() || rows.size !in 1..60) bad()
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val there = dao.tables(store)
        val names = ArrayList<String>()
        val new = ArrayList<TableEntity>()
        for (row in rows) {
            val t = (row as? JsonObject) ?: bad()
            val id = t.id("id")
            val name = (t.str("name") ?: "").trim().take(30)
            val seats = t.long("seats"); val x = t.long("x"); val y = t.long("y"); val w = t.long("w"); val h = t.long("h")
            val shape = t.str("shape") ?: "square"
            if (name.isEmpty() || seats == null || seats !in 1..99 || shape !in setOf("square", "round")
                || w == null || w !in 4..100 || h == null || h !in 4..60 || x == null || x < 0 || x + w > 100 || y == null || y < 0 || y + h > 60) bad()
            // sent again after a lost answer: the table is there already
            if (there.any { it.id == id }) continue
            if (name.lowercase() in names) throw Refused("name-taken")
            names += name.lowercase()
            new += TableEntity(id, tenant, store, name, area, seats.toInt(), shape, x.toInt(), y.toInt(), w.toInt(), h.toInt())
        }
        if (new.isEmpty()) return
        if (there.any { it.area.lowercase() == area.lowercase() }) throw Refused("room-exists")
        if (there.any { it.name.lowercase() in names }) throw Refused("name-taken")
        if (there.size + new.size > 300) throw Refused("too-many")
        var place = there.maxOfOrNull { it.sort_order } ?: -1
        dao.putTables(new.map { it.copy(sort_order = ++place) })
    }

    // ---- push_printer_save (0089, 0088) ----
    private suspend fun printerSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val store = p.id("store_id")
        val paper = p.long("paper_mm") ?: 80
        val name = (p.str("name") ?: "").trim().take(40)
        val kind = p.str("kind") ?: ""
        var address: String? = (p.str("address") ?: "").trim().take(40)
        val one = p["one_printer"]
        if (kind !in setOf("network", "usb", "bluetooth") || (paper != 58L && paper != 80L) || (one != null && (one as? JsonPrimitive)?.booleanOrNull == null)) bad()
        if (name.isEmpty()) throw Refused("name-required")
        if ((kind == "network" && !IP.matches(address!!)) || (kind == "bluetooth" && (address!!.isEmpty() || IP.matches(address)))) throw Refused("bad-address")
        if (kind == "usb") address = null
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val was = dao.printer(id)
        if (was != null) {
            if (was.deleted_at != null || was.kind == "screen" || was.store_id != store) throw Refused("bad-printer")
            dao.putPrinter(was.copy(name = name, kind = kind, address = address, paper_mm = paper.toInt()))
        } else {
            val all = dao.printers()
            // the first printer of a store is where its receipts come out
            val first = all.none { it.store_id == store && it.kind != "screen" }
            dao.putPrinter(PrinterEntity(id, tenant, store, name, kind, address, paper.toInt(), is_receipt = first, sort_order = (all.maxOfOrNull { it.sort_order } ?: -1) + 1))
        }
        if (one != null) mergeSettings(tenant, buildJsonObject { put("onePrinter", (one as JsonPrimitive).booleanOrNull ?: false) })
    }

    // ---- push_company_save (0089) ----
    private suspend fun companySave(p: JsonObject, tenant: String) {
        fun cut(key: String, most: Int) = (p.str(key) ?: "").trim().take(most)
        val name = cut("name", 80)
        if (name.isEmpty()) throw Refused("name-required")
        mergeSettings(tenant, buildJsonObject {
            put("company", buildJsonObject {
                put("name", name); put("brn", cut("brn", 30)); put("vat", cut("vat", 30)); put("address", cut("address", 240)); put("phone", cut("phone", 40))
            })
        })
    }

    // The settings with these keys put over them, as the server's `data || excluded.data`.
    private suspend fun mergeSettings(tenant: String, over: JsonObject) {
        val was = dao.settings()
        val data = runCatching { Json.parseToJsonElement(was?.data ?: "{}").jsonObject }.getOrDefault(JsonObject(emptyMap()))
        dao.putSettings(SettingsEntity(was?.tenant_id ?: tenant, JsonObject(data + over).toString()))
    }

    // ---- push_staff_save, push_staff_set_pin (0089) ----
    private suspend fun staffSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val role = p.id("role_id")
        val name = (p.str("name") ?: "").trim().take(80)
        val hash = p.str("pin_hash") ?: ""
        if (name.isEmpty()) throw Refused("name-required")
        if (hash.isBlank()) throw Refused("bad-pin")
        if (dao.role(role)?.takeIf { it.deleted_at == null } == null) throw Refused("bad-role")
        // sent again after a lost answer: the person is there already
        if (dao.employee(id) != null) return
        dao.putEmployee(EmployeeEntity(id, tenant, name, hash, role))
        dao.putEmployeeStores(dao.storeIds().map { EmployeeStoreEntity(id, it, tenant) })
    }

    private suspend fun staffSetPin(p: JsonObject) {
        val hash = p.str("pin_hash") ?: ""
        if (hash.isBlank()) throw Refused("bad-pin")
        val was = dao.employee(p.id("employee_id"))?.takeIf { it.deleted_at == null } ?: throw Refused("unknown-staff")
        dao.putEmployee(was.copy(pin_hash = hash))
    }

    // ---- push_tax_save (0094) ----
    private suspend fun taxSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val rate = p.long("rate_bp")
        val usual = p.bool("is_default") ?: false
        val type = p.str("type")
        if (type != "included" && type != "added") bad()
        val name = (p.str("name") ?: "").trim().take(30)
        if (name.isEmpty()) throw Refused("name-required")
        if (rate == null || rate !in 0..10000) throw Refused("bad-rate")
        val all = dao.taxes()
        // one tax to a name, removed ones too
        if (all.any { it.id != id && it.name.lowercase() == name.lowercase() }) throw Refused("name-taken")
        val was = all.firstOrNull { it.id == id }
        if (was != null && was.deleted_at != null) throw Refused("bad-tax")
        val mine = (was ?: TaxEntity(id, tenant, name, rate.toInt(), type!!)).copy(name = name, rate_bp = rate.toInt(), type = type!!)
        // the usual tax is moved onto this one; it is never switched off
        if (usual) dao.putTaxes(all.filter { it.id != id && it.is_default }.map { it.copy(is_default = false) } + mine.copy(is_default = true))
        else dao.putTaxes(listOf(mine))
    }

    // ---- push_supplier_save, push_supplier_remove (0092) ----
    private suspend fun supplierSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        fun cut(key: String, most: Int) = (p.str(key) ?: "").trim().take(most).ifEmpty { null }
        val name = (p.str("name") ?: "").trim().take(120)
        if (name.isEmpty()) throw Refused("name-required")
        val was = dao.supplier(id)
        // one that was removed is not brought back by a save that arrives late
        if (was != null && was.deleted_at != null) throw Refused("unknown-supplier")
        if (dao.suppliersNamed(name, id) > 0) throw Refused("name-taken")
        dao.putSupplier((was ?: SupplierEntity(id, tenant, name)).copy(
            name = name, contact = cut("contact", 120), phone = cut("phone", 40), email = cut("email", 120), address = cut("address", 200), note = cut("note", 200),
        ))
    }

    private suspend fun supplierRemove(p: JsonObject) {
        val was = dao.supplier(p.id("id")) ?: return
        if (was.deleted_at == null) dao.putSupplier(was.copy(deleted_at = now()))
    }

    companion object {
        val KINDS = setOf(
            "item.save", "item.remove", "category.save", "category.remove", "stock.adjust", "tables.add", "printer.save",
            "company.save", "staff.save", "staff.set_pin", "tax.save", "supplier.save", "supplier.remove",
        )
        private val IN_REASONS = setOf("receive", "found")
        private val OUT_REASONS = setOf("damaged", "expired", "lost", "internal", "supplier_return")
        private val COLOR = Regex("^#[0-9a-f]{6}$")
        private val IP = Regex("""^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$""")
        private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        // What a payload holds under a key, read as the server reads it: a
        // key that is not there, or holds JSON null, is null.
        private fun JsonObject.prim(key: String): JsonPrimitive? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }
        private fun JsonObject.str(key: String): String? = prim(key)?.contentOrNull
        private fun JsonObject.bool(key: String): Boolean? = prim(key)?.let { it.booleanOrNull ?: throw Refused("bad-payload") }
        // a whole number; anything else under the key is a bad payload, as a failed cast is on the server
        private fun JsonObject.long(key: String): Long? = prim(key)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() ?: throw Refused("bad-payload") }
        // an id that has to be there and has to be one
        private fun JsonObject.id(key: String): String = str(key)?.takeIf { UUID.matches(it) } ?: throw Refused("bad-payload")
    }
}
