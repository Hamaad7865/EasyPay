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
            "role.save" -> roleSave(p, tenant)
            "role.remove" -> roleRemove(p)
            "staff.update" -> staffUpdate(p)
            "discount.save" -> discountSave(p, tenant)
            "discount.remove" -> discountRemove(p)
            "addon.save" -> addonSave(p, tenant)
            "addon.remove" -> addonRemove(p)
            "settings.save" -> settingsSave(p, tenant)
            "variants.make" -> variantsMake(p, tenant)
            "variants.save" -> variantsSave(p)
            "variant.remove" -> variantRemove(p)
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
        // the add-on groups it carries (0096), when the sheet says: each a group that is there
        val groups = if ("groups" in p) ((p["groups"] as? JsonArray) ?: bad()).map { (it as? JsonPrimitive)?.contentOrNull?.takeIf { g -> UUID.matches(g) } ?: bad() }.distinct() else null
        if (groups != null) {
            val live = dao.groups().filter { it.deleted_at == null }.map { it.id }.toSet()
            if (groups.any { it !in live }) throw Refused("bad-group")
        }

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
        if (groups != null) { dao.dropGroupsOf(id); dao.putItemGroups(groups.map { com.restopos.core.database.ItemModGroupCrossRef(id, it) }) }
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

    // ---- push_role_save, push_role_remove (0095) ----
    private suspend fun roleSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val ticked = (p["permissions"] as? JsonArray) ?: bad()
        val offered = (p["offered"] as? JsonArray) ?: bad()
        val name = (p.str("name") ?: "").trim().take(30)
        if (name.isEmpty()) throw Refused("name-required")
        // "*" is the owner's alone: it is neither offered nor ticked, whatever was sent
        val offer = offered.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.filter { it != "*" && it.length in 1..60 }
        val ticks = ticked.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.filter { it in offer }.toSet()
        val all = dao.roles()
        if (all.any { it.id != id && it.name.lowercase() == name.lowercase() }) throw Refused("name-taken")
        val was = all.firstOrNull { it.id == id }
        if (was != null) {
            if (was.deleted_at != null) throw Refused("bad-role")
            val had = RoleForm.held(was.permissions)
            if ("*" in had) throw Refused("owner-role")
            dao.putRole(was.copy(name = name, permissions = list(RoleForm.saved(had, ticks, offer))))
        } else dao.putRole(com.restopos.core.database.RoleEntity(id, tenant, name, list(ticks.sorted())))
    }

    private fun list(perms: List<String>): String = JsonArray(perms.map { JsonPrimitive(it) }).toString()

    private suspend fun roleRemove(p: JsonObject) {
        val id = p.id("role_id")
        val was = dao.roles().firstOrNull { it.id == id } ?: throw Refused("bad-role")
        // removed already is removed
        if (was.deleted_at != null) return
        if (RoleForm.isOwner(was.permissions)) throw Refused("owner-role")
        if (dao.staffOn(id) > 0) throw Refused("role-in-use")
        dao.putRole(was.copy(deleted_at = now(), name = was.name.take(30) + " (removed " + stamp() + ")"))
    }

    // as the server writes it into a removed row's name, so that the name is free again
    private fun stamp(): String = java.time.format.DateTimeFormatter.ofPattern("yyyyMMddHHmmss").withZone(java.time.ZoneOffset.UTC).format(Instant.ofEpochMilli(clock()))

    // ---- push_staff_update (0095) ----
    private suspend fun staffUpdate(p: JsonObject) {
        val id = p.id("employee_id")
        val role = p.str("role_id")?.ifEmpty { null }
        val active = p.bool("active")
        val name = (p.str("name") ?: "").trim().take(80)
        if ("name" in p && name.isEmpty()) throw Refused("name-required")
        if ("role_id" in p && role == null) throw Refused("bad-role")
        val was = dao.employee(id)?.takeIf { it.deleted_at == null } ?: throw Refused("unknown-staff")
        // someone with a login of their own is not changed from a till
        if (was.has_login) throw Refused("has-login")
        if (role != null && dao.roles().none { it.id == role && it.deleted_at == null }) throw Refused("bad-role")
        dao.putEmployee(was.copy(
            name = if ("name" in p) name else was.name,
            role_id = if ("role_id" in p) role else was.role_id,
            is_active = if ("active" in p && active != null) active else was.is_active,
        ))
    }

    // ---- push_discount_save, push_discount_remove (0095) ----
    private suspend fun discountSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val value = p.long("value")
        val needs = p.bool("requires_approval") ?: false
        val type = p.str("type")
        if (type != "percent" && type != "amount") bad()
        val name = (p.str("name") ?: "").trim().take(40)
        if (name.isEmpty()) throw Refused("name-required")
        if (value == null || value < 1 || (type == "percent" && value > 100) || value > 100_000_000L) throw Refused("bad-value")
        val all = dao.discounts()
        if (all.any { it.id != id && it.name.lowercase() == name.lowercase() }) throw Refused("name-taken")
        val was = all.firstOrNull { it.id == id }
        if (was != null && was.deleted_at != null) throw Refused("bad-discount")
        dao.putDiscount((was ?: com.restopos.core.database.DiscountEntity(id, tenant, name, type!!, value)).copy(name = name, type = type!!, value = value, requires_approval = needs))
    }

    private suspend fun discountRemove(p: JsonObject) {
        val id = p.id("discount_id")
        val was = dao.discounts().firstOrNull { it.id == id } ?: throw Refused("bad-discount")
        if (was.deleted_at == null) dao.putDiscount(was.copy(deleted_at = now(), name = was.name.take(40) + " (removed " + stamp() + ")"))
    }

    // ---- push_addon_save, push_addon_remove (0096) ----
    private suspend fun addonSave(p: JsonObject, tenant: String) {
        val id = p.id("id")
        val min = p.long("min") ?: 0
        val max = p.long("max") ?: 0
        val rows = (p["choices"] as? JsonArray) ?: bad()
        val name = (p.str("name") ?: "").trim().take(40)
        if (name.isEmpty()) throw Refused("name-required")
        // the fewest 0 is optional, 1 means one must be picked; the most 0 is as many as they like
        if (min !in 0..20 || max !in 0..20 || (max != 0L && max < min)) throw Refused("bad-limits")
        if (rows.size > 50) throw Refused("too-many")
        val all = dao.groups()
        if (all.any { it.id != id && it.name.lowercase() == name.lowercase() }) throw Refused("name-taken")
        val was = all.firstOrNull { it.id == id }
        if (was != null && was.deleted_at != null) throw Refused("bad-group")
        val keep = ArrayList<com.restopos.core.database.ModifierEntity>()
        val named = HashSet<String>()
        for (row in rows) {
            val c = (row as? JsonObject) ?: bad()
            val cid = c.id("id")
            val price = c.long("price") ?: 0
            val cname = (c.str("name") ?: "").trim().take(40)
            if (price < 0 || price > 100_000_000L) bad()
            if (cname.isEmpty()) throw Refused("name-required")
            named += cid
            // a choice that is another group's is left alone
            if (dao.choice(cid)?.let { it.group_id != id } == true) continue
            keep += com.restopos.core.database.ModifierEntity(cid, tenant, id, cname, price)
        }
        dao.putGroup((was ?: com.restopos.core.database.ModifierGroupEntity(id, tenant, name)).copy(name = name, min_select = min.toInt(), max_select = max.toInt()))
        dao.putChoices(keep)
        // a choice that is not in the list is removed
        dao.putChoices(dao.choicesOf(id).filter { it.deleted_at == null && it.id !in named }.map { it.copy(deleted_at = now()) })
    }

    private suspend fun addonRemove(p: JsonObject) {
        val id = p.id("group_id")
        val was = dao.groups().firstOrNull { it.id == id } ?: throw Refused("bad-group")
        // removed already is removed
        if (was.deleted_at != null) return
        dao.dropLinksTo(id)
        dao.putChoices(dao.choicesOf(id).filter { it.deleted_at == null }.map { it.copy(deleted_at = now()) })
        dao.putGroup(was.copy(deleted_at = now(), name = was.name.take(40) + " (removed " + stamp() + ")"))
    }

    // ---- push_settings_save (0096): the receipt's two notes and the service charge ----
    private suspend fun settingsSave(p: JsonObject, tenant: String) {
        var patch = JsonObject(emptyMap())
        p["receipt"]?.let { r ->
            val sent = (r as? JsonObject) ?: bad()
            val now = runCatching { Json.parseToJsonElement(dao.settings()?.data ?: "{}").jsonObject["receipt"]?.jsonObject }.getOrNull() ?: JsonObject(emptyMap())
            // the two notes only: the logo and whether it shows are left as they are
            val notes = buildJsonObject {
                if ("header" in sent) put("header", (sent.str("header") ?: "").replace("\r", "").take(300))
                if ("footer" in sent) put("footer", (sent.str("footer") ?: "").replace("\r", "").take(300))
            }
            patch = JsonObject(patch + ("receipt" to JsonObject(now + notes)))
        }
        if ("servicePct" in p) {
            val pct = p.long("servicePct")
            if (pct == null || pct !in 0..30) throw Refused("bad-value")
            patch = JsonObject(patch + ("servicePct" to JsonPrimitive(pct.toInt())))
        }
        if (patch.isNotEmpty()) mergeSettings(tenant, patch)
    }

    // ---- push_variants_make, push_variants_save, push_variant_remove (0097) ----
    private suspend fun variantsMake(p: JsonObject, tenant: String) {
        val id = p.id("item_id")
        val names = (p["names"] as? JsonArray) ?: bad()
        val lines = (p["lines"] as? JsonArray) ?: bad()
        val item = dao.item(id)?.takeIf { it.deleted_at == null } ?: throw Refused("unknown-item")
        if (names.size !in 1..3 || lines.isEmpty()) throw Refused("bad-options")
        val called = ArrayList<String>()
        for (n in names) {
            val name = ((n as? JsonPrimitive)?.contentOrNull ?: "").trim()
            if (name.isEmpty() || name.length > 30 || called.any { it.lowercase() == name.lowercase() }) throw Refused("bad-options")
            called += name
        }
        val live = dao.variantsOf(id)
        // a product that has variants keeps its number of options
        if (live.isNotEmpty() && VariantForm.held(item.option_names).size != called.size) throw Refused("bad-options")
        // stock held by the product itself would belong to no line once it has lines
        if (live.isEmpty() && dao.levelsOfItem(id).any { it.qty != 0 }) throw Refused("has-stock")
        fun key(values: List<String>) = values.joinToString("\u001f") { it.lowercase() }
        val there = live.map { key(VariantForm.held(it.option_values)) }.toMutableSet()
        val seen = HashSet<String>()
        val new = ArrayList<com.restopos.core.database.ItemVariantEntity>()
        for (row in lines) {
            val l = (row as? JsonObject) ?: bad()
            val vid = l.id("id")
            val values = ((l["values"] as? JsonArray) ?: throw Refused("bad-options")).map { ((it as? JsonPrimitive)?.contentOrNull ?: "").trim() }
            if (values.size != called.size || values.any { it.isEmpty() || it.length > 30 }) throw Refused("bad-options")
            // the same line twice in one send
            if (!seen.add(key(values))) throw Refused("bad-options")
            // a line the product has already, by its values or by this id, is left as it is
            if (key(values) in there || dao.variant(vid) != null) continue
            new += com.restopos.core.database.ItemVariantEntity(
                vid, tenant, id, values.joinToString(" / "), item.price,
                option_values = JsonArray(values.map { JsonPrimitive(it) }).toString(), cost = item.cost,
            )
        }
        if (live.size + new.size > 200) throw Refused("too-many-variants")
        dao.putItem(item.copy(option_names = JsonArray(called.map { JsonPrimitive(it) }).toString()))
        dao.putVariants(new)
    }

    private suspend fun variantsSave(p: JsonObject) {
        val id = p.id("item_id")
        val lines = (p["lines"] as? JsonArray) ?: bad()
        if (lines.size > 200) bad()
        for (row in lines) {
            val l = (row as? JsonObject) ?: bad()
            val vid = l.id("id")
            val cost = l.long("cost")
            val code = if ("barcode" in l) (l.str("barcode") ?: "").filterNot { it.isWhitespace() }.ifEmpty { null } else null
            if ((cost != null && (cost < 0 || cost > 100_000_000L)) || (code?.length ?: 0) > 64) bad()
            val was = dao.variant(vid)?.takeIf { it.item_id == id && it.deleted_at == null } ?: throw Refused("unknown-variant")
            val barcode = if ("barcode" in l) code else was.barcode
            val sku = if ("sku" in l) (l.str("sku") ?: "").trim().take(60).ifEmpty { null } else was.sku
            // a barcode and a SKU are one line's only, among the products and among their variants
            if (barcode != null && (dao.itemsWithBarcode(barcode, vid) > 0 || dao.variantsWithBarcode(barcode, vid) > 0)) throw Refused("barcode-taken")
            if (sku != null && (dao.itemsWithSku(sku, vid) > 0 || dao.variantsWithSku(sku, vid) > 0)) throw Refused("sku-taken")
            // the sheet sends a cost only when it showed one
            dao.putVariants(listOf(was.copy(barcode = barcode, sku = sku, cost = if ("cost" in l) cost else was.cost)))
        }
    }

    private suspend fun variantRemove(p: JsonObject) {
        val id = p.id("variant_id")
        val was = dao.variant(id) ?: throw Refused("unknown-variant")
        // removed already is removed
        if (was.deleted_at != null) return
        // what is on the shelf would drop out of the stock without a word
        if (dao.levelsOfItem(was.item_id).any { it.variant_id == id && it.qty != 0 }) throw Refused("has-stock")
        dao.putVariants(listOf(was.copy(deleted_at = now())))
        // with its last variant gone, a product is a simple one again
        if (dao.variantsOf(was.item_id).isEmpty()) dao.item(was.item_id)?.let { dao.putItem(it.copy(option_names = "[]")) }
    }

    companion object {
        val KINDS = setOf(
            "item.save", "item.remove", "category.save", "category.remove", "stock.adjust", "tables.add", "printer.save",
            "company.save", "staff.save", "staff.set_pin", "tax.save", "supplier.save", "supplier.remove",
            "role.save", "role.remove", "staff.update", "discount.save", "discount.remove",
            "addon.save", "addon.remove", "settings.save", "variants.make", "variants.save", "variant.remove",
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
