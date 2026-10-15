package com.restopos.core.data

import com.restopos.core.common.Uuid7
import com.restopos.core.database.AloneDao
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DeliveryEntity
import com.restopos.core.database.DeliveryLineEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.FloorElementEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.StockCountEntity
import com.restopos.core.database.StockCountLineEntity
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

    // One change, applied. Call it inside one transaction with the queueing of
    // what it returns: the change as the server is to take it, and after it a
    // change this tablet made beside it. Both are there for the barcodes: a
    // shop's line saved with none is given one of EasyPay's here, since no
    // back office is there to make it, and the server is sent the barcode
    // itself, so that the one on a printed label is the one it holds after.
    suspend fun apply(type: String, p: JsonObject, tenant: String, employee: String?): List<Pair<String, JsonObject>> {
        when (type) {
            "item.save" -> { val kept = coded(p); itemSave(kept, tenant); return listOf(type to kept) }
            "variants.make" -> return listOfNotNull(type to p, codes(p, variantsMake(p, tenant)))
            // kept with what moved on this tablet since each line was counted: the server cannot know it (0103)
            "count.complete" -> return listOf(type to countComplete(p, employee))
            else -> change(type, p, tenant, employee)
        }
        return listOf(type to p)
    }

    private suspend fun change(type: String, p: JsonObject, tenant: String, employee: String?) {
        when (type) {
            "item.remove" -> itemRemove(p)
            "category.save" -> categorySave(p, tenant)
            "category.remove" -> categoryRemove(p)
            "stock.adjust" -> stockAdjust(p, employee)
            "tables.add" -> tablesAdd(p, tenant)
            "floor.save" -> floorSave(p, tenant)
            "room.rename" -> roomRename(p)
            "room.remove" -> roomRemove(p)
            "printer.save" -> printerSave(p, tenant)
            "company.save" -> companySave(p, tenant)
            "staff.save" -> staffSave(p, tenant)
            "staff.set_pin" -> staffSetPin(p)
            "tax.save" -> taxSave(p, tenant)
            "supplier.save" -> supplierSave(p, tenant)
            "supplier.remove" -> supplierRemove(p)
            "po.save" -> poSave(p, employee)
            "po.send" -> poState(p, "send")
            "po.cancel" -> poState(p, "cancel")
            "po.close" -> poState(p, "close")
            "delivery.receive" -> deliveryReceive(p, employee)
            "role.save" -> roleSave(p, tenant)
            "role.remove" -> roleRemove(p)
            "staff.update" -> staffUpdate(p)
            "discount.save" -> discountSave(p, tenant)
            "discount.remove" -> discountRemove(p)
            "addon.save" -> addonSave(p, tenant)
            "addon.remove" -> addonRemove(p)
            "settings.save" -> settingsSave(p, tenant)
            "variants.save" -> variantsSave(p)
            "variant.remove" -> variantRemove(p)
            // a promotion (0110) is already on the tablet when it is queued (core/data/Promotions): nothing more to do here
            "promotion.apply", "promotion.reduce", "promotion.lift" -> Unit
            else -> throw Refused("not-alone")
        }
    }

    // ---- barcodes_auto, assign_barcodes (0070, 0080): EasyPay's own barcodes ----
    // A shop's product saved with no barcode, as it is kept: with the next of
    // EasyPay's. Not one that has variants: its lines have their own.
    private suspend fun coded(p: JsonObject): JsonObject {
        if (!PosSettings.parse(dao.settings()?.data).retail) return p
        if ((p.str("barcode") ?: "").any { !it.isWhitespace() }) return p
        val id = p.str("id")?.takeIf { UUID.matches(it) } ?: return p
        if (dao.variantsOf(id).isNotEmpty()) return p
        val code = mint(emptySet()) ?: return p
        return JsonObject(p + ("barcode" to JsonPrimitive(code)))
    }

    // The lines just made, given their barcodes: a change of its own, kept
    // after the one that made them.
    private suspend fun codes(p: JsonObject, made: List<com.restopos.core.database.ItemVariantEntity>): Pair<String, JsonObject>? {
        val given = LinkedHashMap<String, String>()
        for (v in made) given[v.id] = mint(given.values.toSet()) ?: break
        if (given.isEmpty()) return null
        val save = buildJsonObject {
            put("item_id", p.id("item_id"))
            put("lines", JsonArray(given.map { (line, code) -> buildJsonObject { put("id", line); put("barcode", code) } }))
            // whoever gave their word for the lines gave it for their barcodes
            p["approved_by"]?.let { put("approved_by", it) }
        }
        variantsSave(save)
        return "variants.save" to save
    }

    // The next of EasyPay's barcodes: the one after the highest this tablet
    // has held, and never one in use. null when no number is left.
    private suspend fun mint(given: Set<String>): String? {
        val like = Barcodes.PREFIX + "%"
        val top = listOfNotNull(dao.topItemBarcode(like), dao.topVariantBarcode(like)).mapNotNull { Barcodes.serial(it) }.maxOrNull() ?: 0L
        // past the last number the prefix has room for, the gaps below are looked through
        var n = if (Barcodes.ean13(Barcodes.PREFIX, top + 1) != null) top + 1 else 1L
        while (true) {
            val code = Barcodes.ean13(Barcodes.PREFIX, n) ?: return null
            if (code !in given && dao.itemsWithBarcode(code, "") == 0 && dao.variantsWithBarcode(code, "") == 0) return code
            n++
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
        // Which printers its orders print on (0098), when the sheet says: of
        // those named, the ones that are there. Not sent, they are left.
        val printers = if ("printer_ids" in p) {
            val named = ((p["printer_ids"] as? JsonArray) ?: bad()).map { (it as? JsonPrimitive)?.contentOrNull?.takeIf { x -> UUID.matches(x) } ?: bad() }
            val live = dao.printers().sortedWith(compareBy<PrinterEntity> { it.sort_order }.thenBy { it.id }).map { it.id }
            JsonArray(live.filter { it in named }.map { JsonPrimitive(it) }).toString()
        } else null
        val was = dao.category(id)
        if (was != null) {
            if (was.deleted_at != null) throw Refused("bad-category")
            // its place and whether its stock is counted are left
            dao.putCategory(was.copy(name = name, color = color, printer_ids = printers ?: was.printer_ids))
        } else dao.putCategory(CategoryEntity(id, tenant, name, color, sort_order = dao.lastCategoryPlace() + 1, printer_ids = printers ?: "[]"))
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

    // ---- push_floor_save (0101, 0102) ----
    // One room as the plan holds it: its tables written as they stand, the
    // ones taken off removed, no other room touched. And what stands in the
    // room (0102), when the plan says: not named, it is left where it stands.
    private suspend fun floorSave(p: JsonObject, tenant: String) {
        val store = p.id("store_id")
        val area = (p.str("area") ?: "").trim().take(30)
        val rows = (p["tables"] as? JsonArray) ?: bad()
        val listed = p["removed"]
        val pieces = p["elements"]
        val piecesGone = p["removed_elements"]
        if (area.isEmpty() || rows.size > 300 || (listed != null && listed !is JsonArray)
            || (pieces != null && pieces !is JsonArray) || (piecesGone != null && piecesGone !is JsonArray)) bad()
        if (pieces is JsonArray && pieces.size > 200) bad()
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val ids = ArrayList<String>()
        val names = ArrayList<String>()
        val sent = ArrayList<TableEntity>()
        // the angle each was sent with; one sent with none keeps the angle it has
        val angles = HashMap<String, Int?>()
        for (row in rows) {
            val t = (row as? JsonObject) ?: bad()
            val id = t.id("id")
            val name = (t.str("name") ?: "").trim().take(30)
            val seats = t.long("seats"); val x = t.long("x"); val y = t.long("y"); val w = t.long("w"); val h = t.long("h")
            val shape = t.str("shape") ?: "square"
            val rot = t.long("rotation")
            if (name.isEmpty() || seats == null || seats !in 1..99 || shape !in setOf("square", "round", "booth", "stool")
                || w == null || w !in 4..100 || h == null || h !in 4..60 || x == null || x < 0 || x + w > 100 || y == null || y < 0 || y + h > 60
                || (rot != null && rot !in 0..359)
                || id in ids) bad()
            if (name.lowercase() in names) throw Refused("name-taken")
            ids += id
            names += name.lowercase()
            angles[id] = rot?.toInt()
            sent += TableEntity(id, tenant, store, name, area, seats.toInt(), shape, x.toInt(), y.toInt(), w.toInt(), h.toInt(), rotation = rot?.toInt() ?: 0)
        }
        fun idList(of: JsonArray?) = of?.map { ((it as? JsonPrimitive)?.takeIf { v -> v !is JsonNull }?.contentOrNull)?.takeIf { v -> UUID.matches(v) } ?: bad() } ?: emptyList()
        val gone = idList(listed as? JsonArray)
        // a table cannot be both on the plan and taken off it
        if (gone.any { it in ids }) bad()
        // the room's walls, doors, windows and bar, read before anything is written
        val elementsGone = idList(piecesGone as? JsonArray)
        val elementIds = ArrayList<String>()
        val elements = ArrayList<FloorElementEntity>()
        for (row in (pieces as? JsonArray) ?: JsonArray(emptyList())) {
            val e = (row as? JsonObject) ?: bad()
            val id = e.id("id")
            val kind = e.str("kind") ?: ""
            val x = e.long("x"); val y = e.long("y"); val w = e.long("w"); val h = e.long("h")
            val rot = e.long("rotation") ?: 0
            // an element is one unit thick at least, and whole on the plan before it is turned
            if (kind !in setOf("wall", "door", "window", "bar")
                || w == null || w !in 1..100 || h == null || h !in 1..60 || x == null || x < 0 || x + w > 100 || y == null || y < 0 || y + h > 60
                || rot !in 0..359 || id in elementIds || id in elementsGone) bad()
            elementIds += id
            elements += FloorElementEntity(id, tenant, store, area, kind, x.toInt(), y.toInt(), w.toInt(), h.toInt(), rot.toInt(), sort_order = elements.size)
        }
        val there = dao.tables(store)
        val leaving = there.filter { it.id in gone }
        val staying = there.filter { it.id !in gone }
        val others = staying.filter { it.id !in ids }
        // a table's number is its own in the whole store
        if (others.any { it.name.lowercase() in names }) throw Refused("name-taken")
        if (others.size + sent.size > 300) throw Refused("too-many")
        var place = staying.maxOfOrNull { it.sort_order } ?: -1
        val written = sent.map { t ->
            val was = staying.firstOrNull { it.id == t.id }
            // the id is another store's table, or one that was removed
            if (was == null && dao.table(t.id) != null) throw Refused("conflict")
            // a table that is there keeps its place in the order, and its angle when none was sent; a new one goes after the last
            if (was != null) t.copy(sort_order = was.sort_order, server_seq = was.server_seq, rotation = angles[t.id] ?: was.rotation) else t.copy(sort_order = ++place)
        }
        // the elements: the ones taken off removed, the ones sent written as they stand; any other is left alone
        val standing = dao.elements(store)
        val elementsLeaving = standing.filter { it.id in elementsGone }
        val writtenElements = ArrayList<FloorElementEntity>()
        if (pieces != null) {
            val others = standing.count { it.id !in elementsGone && it.id !in elementIds }
            if (others + elements.size > 200) throw Refused("too-many")
            for (e in elements) {
                val was = standing.firstOrNull { it.id == e.id && it.id !in elementsGone }
                // the id is another store's element, or one that was removed
                if (was == null && dao.element(e.id) != null) throw Refused("conflict")
                writtenElements += if (was != null) e.copy(server_seq = was.server_seq) else e
            }
        }
        val at = now()
        dao.putTables(leaving.map { it.copy(deleted_at = at) } + written)
        dao.putElements(elementsLeaving.map { it.copy(deleted_at = at) } + writtenElements)
    }

    // ---- push_room_rename (0101) ----
    private suspend fun roomRename(p: JsonObject) {
        val store = p.id("store_id")
        val from = p.str("from") ?: ""
        val to = (p.str("to") ?: "").trim().take(30)
        if (from.isEmpty() || to.isEmpty()) bad()
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val there = dao.tables(store)
        val room = there.filter { it.area == from }
        // done already, or a room that is gone: nothing to do
        if (to == from || room.isEmpty()) return
        if (there.any { it.area.lowercase() == to.lowercase() && it.area != from }) throw Refused("room-exists")
        dao.putTables(room.map { it.copy(area = to) })
        // its walls, doors, windows and bar go with it (0102)
        dao.putElements(dao.elements(store).filter { it.area == from }.map { it.copy(area = to) })
    }

    // ---- push_room_remove (0101) ----
    // An order open on one of its tables stays open, under Orders, without a table.
    private suspend fun roomRemove(p: JsonObject) {
        val store = p.id("store_id")
        val area = p.str("area") ?: ""
        if (area.isEmpty()) bad()
        if (store !in dao.storeIds()) throw Refused("bad-store")
        val at = now()
        dao.putTables(dao.tables(store).filter { it.area == area }.map { it.copy(deleted_at = at) })
        // and what stood in it (0102)
        dao.putElements(dao.elements(store).filter { it.area == area }.map { it.copy(deleted_at = at) })
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

    // ---- doc_lines, stock_line_ok (0074): the lines of an order or a delivery ----
    // One line a product and variant, the quantities added and the cost
    // averaged by quantity, in the order the server takes them: by product,
    // then by variant, a product's own line last. skipZero: a delivery's line
    // of nothing is passed over, where an order's is a bad line.
    private fun docLines(of: kotlinx.serialization.json.JsonElement?, skipZero: Boolean): List<DocLines.Line> {
        val rows = (of as? JsonArray) ?: throw Refused("bad-line")
        fun whole(x: JsonObject, key: String): Long? = x.prim(key)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() ?: throw Refused("bad-line") }
        val read = rows.map { row ->
            val x = (row as? JsonObject) ?: throw Refused("bad-line")
            val item = x.str("item_id")?.takeIf { UUID.matches(it) } ?: throw Refused("bad-line")
            val variant = x.str("variant_id") ?: ""
            if (variant.isNotEmpty() && !UUID.matches(variant)) throw Refused("bad-line")
            val qty = whole(x, "qty") ?: throw Refused("bad-line")
            if (qty < 0 || qty > Int.MAX_VALUE || (qty == 0L && !skipZero)) throw Refused("bad-line")
            val cost = whole(x, "unit_cost")
            if (qty > 0 && (cost == null || cost < 0)) throw Refused("bad-line")
            DocLines.Line(item, variant, qty.toInt(), cost ?: 0)
        }
        return DocLines.merged(read).sortedWith(compareBy<DocLines.Line> { it.item }.thenBy { it.variant.isEmpty() }.thenBy { it.variant })
    }

    private suspend fun lineOk(l: DocLines.Line) {
        val item = dao.item(l.item)?.takeIf { it.deleted_at == null } ?: throw Refused("unknown-item")
        val counted = item.track_stock || item.category_id?.let { c -> dao.category(c)?.is_stock } == true
        if (!counted) throw Refused("not-counted")
        // a product with variants is ordered and received by the variant, never as itself
        val variants = dao.variantsOf(l.item)
        if (l.variant.isEmpty()) { if (variants.isNotEmpty()) throw Refused("pick-variant") }
        else if (variants.none { it.id == l.variant }) throw Refused("unknown-line")
    }

    // a day as the server reads one (2026-10-20), or none; anything else is a bad payload
    private fun day(p: JsonObject, key: String): String? {
        val text = p.str(key)?.ifEmpty { null } ?: return null
        return runCatching { java.time.LocalDate.parse(text).toString() }.getOrNull() ?: bad()
    }
    // an id that may be left empty, and has to be one when it is not
    private fun maybeId(p: JsonObject, key: String): String? = p.str(key)?.ifEmpty { null }?.also { if (!UUID.matches(it)) bad() }
    private suspend fun liveSupplier(id: String): Boolean = dao.supplier(id)?.let { it.deleted_at == null } == true

    // next_doc_number (0074): PO-0007, D-0012. The tablet counts on from the
    // highest number it holds. The server gives its own the day the change is
    // sent, and the row comes back with it: the same number, unless something
    // was numbered there meanwhile (an order written in EasyPay's office).
    private fun nextNumber(prefix: String, held: List<String>): String {
        val top = held.filter { it.startsWith(prefix) }.mapNotNull { it.removePrefix(prefix).toIntOrNull() }.maxOrNull() ?: 0
        return prefix + (top + 1).toString().padStart(4, '0')
    }

    // ---- push_po_save: po_save_as, po_save (0074, 0092) ----
    // A draft, new or saved again. Saved again its lines are the ones given,
    // and it keeps its number.
    private suspend fun poSave(p: JsonObject, employee: String?) {
        val id = p.id("id"); val store = p.id("store_id"); val supplier = p.id("supplier_id")
        val expected = day(p, "expected_on")
        val note = (p.str("note") ?: "").trim().ifEmpty { null }
        val was = dao.order(id)?.takeIf { it.deleted_at == null }
        if (!liveSupplier(supplier)) throw Refused("unknown-supplier")
        if (was == null) { if (store !in dao.storeIds()) throw Refused("unknown-store") }
        else if (was.status != "draft") throw Refused("not-draft")
        val lines = docLines(p["lines"] ?: JsonArray(emptyList()), skipZero = false)
        lines.forEach { lineOk(it) }
        val at = clock()
        dao.putOrder(
            was?.copy(supplier_id = supplier, expected_on = expected, note = note, updated_at = at)
                ?: PurchaseOrderEntity(id, store, nextNumber("PO-", dao.orderNumbers()), supplier, "draft", expected, note, created_by = employee, created_at = at, updated_at = at),
        )
        dao.dropOrderLines(id)
        dao.putOrderLines(lines.map { PurchaseOrderLineEntity(id, it.item, it.variant, it.qty, it.cost) })
    }

    // ---- push_po_state: po_send, po_cancel, po_close (0074, 0092) ----
    // Asked again of an order that is there already (sent again after a lost
    // answer), it is done and nothing changes.
    private suspend fun poState(p: JsonObject, what: String) {
        val id = p.id("id")
        val o = dao.order(id)?.takeIf { it.deleted_at == null } ?: throw Refused("unknown-order")
        val there = when (what) {
            "send" -> o.status in setOf("sent", "part", "received")
            "cancel" -> o.status == "cancelled"
            else -> o.status == "closed"
        }
        if (there) return
        val at = clock()
        when (what) {
            "send" -> {
                if (o.status != "draft") throw Refused("not-draft")
                if (dao.orderLines(id).isEmpty()) throw Refused("no-lines")
                dao.putOrder(o.copy(status = "sent", sent_at = at, updated_at = at))
            }
            "cancel" -> {
                if (dao.deliveriesOf(id) > 0) throw Refused("already-received")
                if (o.status !in setOf("draft", "sent")) throw Refused("not-open")
                dao.putOrder(o.copy(status = "cancelled", updated_at = at))
            }
            else -> {
                if (o.status != "part") throw Refused("not-part")
                dao.putOrder(o.copy(status = "closed", updated_at = at))
            }
        }
    }

    // ---- push_delivery_receive: delivery_receive (0074, 0092) ----
    // Written once: the stock goes up, what was paid becomes what the product
    // costs, and an order it was for is part received or received.
    private suspend fun deliveryReceive(p: JsonObject, employee: String?) {
        val id = p.id("id"); val store = p.id("store_id")
        val orderId = maybeId(p, "order_id"); val supplierId = maybeId(p, "supplier_id")
        val arrived = day(p, "arrived_on")
        // sent again after a lost answer: it was received the first time
        if (dao.delivery(id) != null) return
        var at = store; var from = supplierId
        val order = orderId?.let { dao.order(it)?.takeIf { o -> o.deleted_at == null } ?: throw Refused("unknown-order") }
        if (order != null) {
            if (order.status !in setOf("sent", "part")) throw Refused("not-open")
            // the order says which shop and which supplier
            at = order.store_id; from = order.supplier_id
        } else {
            if (store !in dao.storeIds()) throw Refused("unknown-store")
            if (supplierId != null && !liveSupplier(supplierId)) throw Refused("unknown-supplier")
        }
        val lines = docLines(p["lines"] ?: JsonArray(emptyList()), skipZero = true)
        if (lines.isEmpty()) throw Refused("nothing-received")
        lines.forEach { lineOk(it) }
        val now = clock()
        dao.putDelivery(DeliveryEntity(
            id, at, nextNumber("D-", dao.deliveryNumbers()), order?.id, from,
            arrived ?: Instant.ofEpochMilli(now).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString(),
            (p.str("invoice_no") ?: "").trim().ifEmpty { null }, (p.str("note") ?: "").trim().ifEmpty { null }, employee, created_at = now,
        ))
        dao.putDeliveryLines(lines.map { DeliveryLineEntity(id, it.item, it.variant, it.qty, it.cost) })
        for (l in lines) {
            moveIn(at, l, id, employee, now)
            // what was last paid is what the product costs (after the stock has moved, as the server has it)
            if (l.variant.isEmpty()) dao.item(l.item)?.takeIf { it.cost != l.cost }?.let { dao.putItem(it.copy(cost = l.cost)) }
            else dao.variant(l.variant)?.takeIf { it.cost != l.cost }?.let { dao.putVariants(listOf(it.copy(cost = l.cost))) }
        }
        if (order != null) {
            // what has now arrived of each line of the order; something that was not ordered counts for no line
            val after = dao.orderLines(order.id).map { ol ->
                lines.firstOrNull { it.item == ol.item_id && it.variant == ol.variant_id }?.let { ol.copy(received = ol.received + it.qty) } ?: ol
            }
            dao.putOrderLines(after)
            val all = after.isNotEmpty() && after.all { it.received >= it.qty }
            dao.putOrder(order.copy(status = if (all) "received" else "part", updated_at = now))
        }
    }

    // stock_move, stock_level_for (0074): what arrives at a known cost goes on
    // the shelf and moves the average of what is there, to four decimals as
    // the server keeps it. A shelf that held nothing, or less, costs what this
    // delivery cost.
    private suspend fun moveIn(store: String, l: DocLines.Line, delivery: String, employee: String?, at: Long) {
        val level = dao.levelsOf(store, l.item).firstOrNull { it.variant_id == l.variant } ?: StockLevelEntity(store, l.item, l.variant)
        val avg = if (level.qty <= 0) l.cost.toDouble()
        else java.math.BigDecimal(level.qty).multiply(java.math.BigDecimal.valueOf(level.avg_cost)).add(java.math.BigDecimal(l.qty).multiply(java.math.BigDecimal(l.cost)))
            .divide(java.math.BigDecimal(level.qty.toLong() + l.qty), 4, java.math.RoundingMode.HALF_UP).toDouble()
        dao.putLevels(listOf(level.copy(qty = level.qty + l.qty, avg_cost = avg)))
        // the tablet's own line in the stock history; the server writes its own the day this is sent
        dao.putMovement(StockMovementEntity(newId(), store, l.item, l.variant, l.qty, "receive", unit_cost = l.cost.toDouble(), ref_type = "delivery", ref_id = delivery, employee_id = employee, created_at = at))
    }

    // ---- push_count_complete: count_from_till, count_complete (0074, 0092) ----
    // A count as the tablet kept it, completed as one change: exactly the
    // lines given. A line that was counted is set to its figure against what
    // the tablet held of it WHEN it was counted (kept in its row while the
    // count was open), so what was sold after someone counted the shelf stays
    // sold: the server reaches the same figure by adding up what moved since.
    // A line nobody counted is left as it is or set to nothing, as chosen; a
    // line left out is neither. Sent again, it was completed the first time.
    //
    // Returns the change as it is kept for the server: with, on each counted
    // line, what moved on this tablet between the line being counted and the
    // count being completed (`moved`, server 0103). The day the business is
    // made Premium this tablet's deliveries and corrections are written on
    // the server at that moment, long after they happened; a server left to
    // add up "what moved since the line was counted" by when things were
    // written took a delivery from before the count for one after it, and
    // added it twice. The tablet is the only one that moved its stock while
    // it worked on its own, so it is the one that knows.
    private suspend fun countComplete(p: JsonObject, employee: String?): JsonObject {
        val id = p.id("id"); val store = p.id("store_id")
        val scope = maybeId(p, "scope_id")
        val ahead = p.long("clock_ahead_ms") ?: 0L
        // a clock more than a day out is not a clock to set anything right by
        if (ahead > 86_400_000L || ahead < -86_400_000L) bad()
        val was = dao.count(id)
        if (was != null && was.status != "open") return p
        val kind = p.str("scope_kind")?.takeIf { it in setOf("all", "category", "supplier", "brand") } ?: throw Refused("bad-scope")
        if (store !in dao.storeIds()) throw Refused("unknown-store")
        val uncounted = p.str("uncounted")?.takeIf { it == "leave" || it == "zero" } ?: throw Refused("bad-uncounted")
        val title = when (kind) {
            "all" -> "The whole shop"
            "category" -> scope?.let { dao.category(it)?.name }
            "supplier" -> scope?.let { dao.supplier(it)?.name }
            else -> (p.str("scope_text") ?: "").trim().take(120).ifEmpty { null }
        } ?: throw Refused("bad-scope")
        val rows = (p["lines"] as? JsonArray)?.takeIf { it.isNotEmpty() } ?: throw Refused("nothing-to-count")

        class Sent(val item: String, val variant: String, val counted: Int?, val at: Long?, val out: Boolean)
        val sent = ArrayList<Sent>()
        for (row in rows) {
            val l = (row as? JsonObject) ?: bad()
            val item = l.id("item_id")
            val variant = l.str("variant_id") ?: ""
            if (variant.isNotEmpty() && !UUID.matches(variant)) bad()
            val out = l.bool("left_out") ?: false
            val counted = l.long("counted")
            val at = l.str("counted_at")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() ?: bad() }
            if (counted != null && (counted < 0 || counted > Int.MAX_VALUE || at == null)) throw Refused("bad-quantity")
            if (out) {
                // left out: not checked, and a product or a variant that is gone is not written at all
                val there = dao.item(item)?.let { it.deleted_at == null } == true && (variant.isEmpty() || dao.variantsOf(item).any { it.id == variant })
                if (!there) continue
            } else lineOk(DocLines.Line(item, variant, 0, 0))
            sent += Sent(item, variant, counted?.toInt(), at, out)
        }
        if (sent.isEmpty()) throw Refused("nothing-to-count")

        val now = clock()
        // what the tablet held of each line at the moment it was counted
        val held = dao.countLines(id).associate { (it.item_id to it.variant_id) to it.expected }
        val written = ArrayList<StockCountLineEntity>()
        val moved = HashMap<Pair<String, String>, Int>()
        for (l in sent.sortedWith(compareBy<Sent> { it.item }.thenBy { it.variant })) {
            if (l.out) { written += StockCountLineEntity(id, l.item, l.variant, l.counted, if (l.counted == null) null else l.at, left_out = true); continue }
            val level = dao.levelsOf(store, l.item).firstOrNull { it.variant_id == l.variant } ?: StockLevelEntity(store, l.item, l.variant)
            if (l.counted == null && uncounted == "leave") {
                written += StockCountLineEntity(id, l.item, l.variant, expected = level.qty, unit_cost = level.avg_cost)
                continue
            }
            // not counted and set to nothing: against what it holds now
            val before = if (l.counted == null) level.qty else held[l.item to l.variant] ?: level.qty
            // what the tablet holds now, less what it held when the line was counted: what moved in between
            if (l.counted != null) moved[l.item to l.variant] = level.qty - before
            val counted = l.counted ?: 0
            val diff = counted - before
            written += StockCountLineEntity(id, l.item, l.variant, counted, l.at ?: now, expected = before, diff = diff, unit_cost = level.avg_cost)
            if (diff != 0) {
                dao.putLevels(listOf(level.copy(qty = level.qty + diff)))
                // the tablet's own line in the stock history; the server writes its own the day this is sent
                dao.putMovement(StockMovementEntity(newId(), store, l.item, l.variant, diff, "count", unit_cost = level.avg_cost, ref_type = "count", ref_id = id, employee_id = employee, created_at = now))
            }
        }
        dao.dropCountLines(id)
        dao.putCountLines(written)
        dao.putCount(
            (was ?: StockCountEntity(id, store, scope_kind = kind, title = title, status = "open", started_by = employee, created_at = now)).copy(
                number = nextNumber("C-", dao.countNumbers()), scope_kind = kind, scope_id = if (kind == "category" || kind == "supplier") scope else null,
                scope_text = if (kind == "brand") title else null, title = title, status = "completed", uncounted = uncounted, completed_by = employee, completed_at = now,
            ),
        )
        // the change as it is kept: each counted line with what moved on this tablet since it was counted
        return JsonObject(p + ("lines" to JsonArray(rows.map { row ->
            val x = row as JsonObject
            moved[(x.str("item_id") ?: "") to (x.str("variant_id") ?: "")]?.let { JsonObject(x + ("moved" to JsonPrimitive(it))) } ?: x
        })))
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
            val had = dao.choice(cid)
            if (had?.let { it.group_id != id } == true) continue
            // how many of it a line may take (0108): from 1 to 99, and as it was where nothing is said
            val most = if ("max_qty" in c) (c.long("max_qty")?.takeIf { it in 1..99 } ?: bad()).toInt() else had?.max_qty ?: 1
            // picked alone (0106): what the sheet says, and as it was where nothing is said
            keep += com.restopos.core.database.ModifierEntity(cid, tenant, id, cname, price, alone = c.bool("alone") ?: had?.alone ?: false, max_qty = most)
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

    // ---- push_settings_save (0096, 0108, 0111): the receipt's two notes, the service charge, the kitchen notes, the due reminder ----
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
        // the notes offered when an item is added, whole: twelve of forty letters
        // at most, what is empty or not words left out; saved empty, it stays empty
        p["kitchenNotes"]?.let { sent ->
            val list = (sent as? JsonArray) ?: bad()
            val notes = list.mapNotNull { n -> (n as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.take(40)?.takeIf { it.isNotEmpty() } }.take(12)
            patch = JsonObject(patch + ("kitchenNotes" to JsonArray(notes.map { JsonPrimitive(it) })))
        }
        // the minutes before an order for later is due that the tills ring (0111); 0 is off
        if ("dueReminderMinutes" in p) {
            val m = p.long("dueReminderMinutes")
            if (m == null || m !in 0..120) throw Refused("bad-payload")
            patch = JsonObject(patch + ("dueReminderMinutes" to JsonPrimitive(m.toInt())))
        }
        if (patch.isNotEmpty()) mergeSettings(tenant, patch)
    }

    // ---- push_variants_make, push_variants_save, push_variant_remove (0097) ----
    // Returns the lines it made.
    private suspend fun variantsMake(p: JsonObject, tenant: String): List<com.restopos.core.database.ItemVariantEntity> {
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
        return new
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
            "floor.save", "room.rename", "room.remove",
            "po.save", "po.send", "po.cancel", "po.close", "delivery.receive", "count.complete",
            "promotion.apply", "promotion.reduce", "promotion.lift",
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
