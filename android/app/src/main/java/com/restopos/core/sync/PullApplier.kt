package com.restopos.core.sync

import androidx.room.withTransaction
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.BookingEntity
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.DrawerCountEntity
import com.restopos.core.database.FloorElementEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.DeliveryEntity
import com.restopos.core.database.DeliveryLineEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.StockCountEntity
import com.restopos.core.database.StockCountLineEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.StockMovementEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.ItemModGroupCrossRef
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.PunchEntity
import com.restopos.core.database.RoleEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.SyncStateEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.database.TillRequestEntity
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptLineEntity
import com.restopos.core.database.ReceiptLineModEntity
import com.restopos.core.database.ReceiptLineTaxEntity
import com.restopos.core.database.CreditNoteEntity
import com.restopos.core.database.PromotionEntity
import com.restopos.core.database.ReceiptPaymentEntity
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.OffsetDateTime
import javax.inject.Inject
import javax.inject.Singleton

// Writes one page of the pull into the tablet's own database: the rows and
// the cursor that came with them, in one transaction (spec 5.5). It reads
// only the tables it names, so a table the server sends that this build does
// not know is read past. Apart from the worker so that it can be given a page
// with no network (the debug build does, to check this reader).
@Singleton
class PullApplier @Inject constructor(private val db: TillDatabase) {
    suspend fun apply(store: String, changes: Map<String, List<JsonElement>>, next: Long, epochs: String) {
        val dao = db.catalog()
        fun id(e: JsonElement) = e.jsonObject["id"]!!.jsonPrimitive.content
        fun str(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.contentOrNull
        fun lng(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.longOrNull
        // a figure the server keeps with decimals (an average cost: "4533.6000")
        fun dbl(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.doubleOrNull
        fun bool(e: JsonElement, k: String, d: Boolean) = e.jsonObject[k]?.jsonPrimitive?.booleanOrNull ?: d
        // a server timestamp ("2026-10-04T08:27:15.278+00:00") as epoch millis
        fun time(e: JsonElement, k: String): Long? =
            str(e, k)?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
        db.withTransaction {
            changes["categories"]?.let { rows ->
                dao.upsertCategories(rows.map {
                    CategoryEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "color"), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        printer_ids = it.jsonObject["printer_ids"]?.takeIf { v -> v is kotlinx.serialization.json.JsonArray }?.toString() ?: "[]",
                        is_stock = bool(it, "is_stock", false),
                    )
                })
            }
            changes["items"]?.let { rows ->
                dao.upsertItems(rows.map {
                    ItemEntity(id(it), str(it, "tenant_id") ?: "", str(it, "category_id"), str(it, "name") ?: "", lng(it, "price") ?: 0, bool(it, "is_available", true), str(it, "tile_color"), str(it, "image_path"), str(it, "deleted_at"), lng(it, "server_seq"),
                        tags = (it.jsonObject["dietary_tags"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { t -> runCatching { t.jsonPrimitive.contentOrNull }.getOrNull() }?.joinToString(",") ?: "",
                        barcode = str(it, "barcode")?.trim()?.ifEmpty { null },
                        sku = str(it, "sku")?.trim()?.ifEmpty { null }, sold_by = str(it, "sold_by") ?: "each", track_stock = bool(it, "track_stock", false),
                        option_names = (it.jsonObject["option_names"] as? kotlinx.serialization.json.JsonArray)?.toString() ?: "[]",
                        // its price is typed at the sale: without this every product arrived as one with a fixed price,
                        // and a tap rang it up at whatever its price field held instead of asking
                        open_price = bool(it, "open_price", false),
                        // a shop's stock papers (0092): they always arrived, and were dropped here until now
                        cost = lng(it, "cost"), supplier_id = str(it, "supplier_id"), brand = str(it, "brand")?.trim()?.ifEmpty { null },
                        supplier_code = str(it, "supplier_code")?.trim()?.ifEmpty { null },
                        // its price before the promotion it is on (0110)
                        promo_was = lng(it, "promo_was"),
                        // what one of it is made of (0112)
                        parts = (it.jsonObject["parts"] as? kotlinx.serialization.json.JsonArray)?.toString() ?: "[]")
                })
            }
            // A shop's variants, and what this shop holds of each product. A
            // level the server has is the figure; what this till sold since
            // is taken off it again when the sale is made (TicketRepository.pay)
            // and is in the server's figure once the sale has gone up, which
            // every sync does before it pulls.
            val retail = db.retail()
            // Not so on a tablet that works on its own: its sales never went
            // up, so the server's figure is the one of the day it was set up.
            // What it counts itself stays (Fetched.level). As this page finds
            // the tablet: the plan may be arriving with the page itself.
            val alone = com.restopos.core.data.PosSettings.parse(db.ops().settings()).alone
            changes["item_variants"]?.let { rows ->
                retail.upsertVariants(rows.mapNotNull {
                    val item = str(it, "item_id") ?: return@mapNotNull null
                    ItemVariantEntity(
                        id(it), str(it, "tenant_id") ?: "", item, str(it, "name") ?: "", lng(it, "price") ?: 0,
                        str(it, "sku")?.trim()?.ifEmpty { null }, str(it, "barcode")?.trim()?.ifEmpty { null },
                        (it.jsonObject["option_values"] as? kotlinx.serialization.json.JsonArray)?.toString() ?: "[]",
                        str(it, "deleted_at"), lng(it, "server_seq"), cost = lng(it, "cost"), promo_was = lng(it, "promo_was"),
                    )
                })
            }
            // A shop's promotions (server 0110). "No variant" is null there and "" here, as on stock_levels.
            changes["promotions"]?.let { rows ->
                db.promotions().upsert(rows.mapNotNull {
                    PromotionEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "item_id") ?: return@mapNotNull null, str(it, "variant_id") ?: "",
                        lng(it, "original_price") ?: 0, lng(it, "promo_price") ?: 0, str(it, "status") ?: "active", str(it, "note"),
                        str(it, "applied_by"), time(it, "applied_at") ?: System.currentTimeMillis(), lng(it, "server_seq"),
                    )
                })
            }
            changes["stock_levels"]?.let { rows ->
                val kept = ArrayList<StockLevelEntity>()
                rows.forEach {
                    val item = str(it, "item_id") ?: return@forEach
                    val at = str(it, "store_id") ?: store
                    val variant = str(it, "variant_id") ?: ""
                    if (str(it, "deleted_at") != null) retail.dropLevel(at, item, variant)
                    else {
                        val sent = StockLevelEntity(
                            at, item, variant, (lng(it, "qty") ?: 0).toInt(), lng(it, "server_seq"),
                            avg_cost = dbl(it, "avg_cost") ?: 0.0, reorder_point = lng(it, "reorder_point")?.toInt(), reorder_qty = lng(it, "reorder_qty")?.toInt(),
                        )
                        kept.add(if (alone) Fetched.level(retail.levelsOf(at, item).firstOrNull { l -> l.variant_id == variant }, sent) else sent)
                    }
                }
                retail.upsertLevels(kept)
            }
            changes["modifier_groups"]?.let { rows ->
                dao.upsertGroups(rows.map {
                    ModifierGroupEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "min_select") ?: 0).toInt(), (lng(it, "max_select") ?: 1).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["modifiers"]?.let { rows ->
                dao.upsertModifiers(rows.map {
                    ModifierEntity(id(it), str(it, "tenant_id") ?: "", str(it, "group_id") ?: "", str(it, "name") ?: "", lng(it, "price") ?: 0, str(it, "deleted_at"), lng(it, "server_seq"), alone = bool(it, "alone", false), max_qty = (lng(it, "max_qty") ?: 1).toInt().coerceIn(1, 99))
                })
            }
            changes["taxes"]?.let { rows ->
                dao.upsertTaxes(rows.map {
                    TaxEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "rate_bp") ?: 0).toInt(), str(it, "type") ?: "added", bool(it, "is_default", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["discounts"]?.let { rows ->
                dao.upsertDiscounts(rows.map {
                    DiscountEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "type") ?: "amount", lng(it, "value") ?: 0, bool(it, "requires_approval", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["dining_options"]?.let { rows ->
                dao.upsertDining(rows.map {
                    DiningOptionEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", bool(it, "is_default", false), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        needs_table = bool(it, "needs_table", false), kitchen = str(it, "kitchen") ?: "save",
                        kind = str(it, "kind") ?: if (bool(it, "needs_table", false)) "dine" else "counter",
                    )
                })
            }
            changes["payment_types"]?.let { rows ->
                dao.upsertPayments(rows.map {
                    PaymentTypeEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "kind") ?: "other", bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        opens_drawer = bool(it, "opens_drawer", false),
                    )
                })
            }
            changes["stores"]?.let { rows ->
                dao.upsertStores(rows.map {
                    StoreEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", str(it, "timezone") ?: "Indian/Mauritius", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["pos_devices"]?.let { rows ->
                dao.upsertDevices(rows.map {
                    // The receipt sequence only ever moves forward. This till may
                    // have issued receipts the server has not seen yet; taking the
                    // server's lower number would hand out the same numbers again.
                    val local = dao.device(id(it))?.last_receipt_seq ?: 0
                    DeviceEntity(id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", maxOf(local, lng(it, "last_receipt_seq") ?: 0), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            val ops = db.ops()
            // a link taken off in the back office (an item's tax changed, an
            // add-on group unticked) is taken off here too
            changes["item_taxes"]?.let { rows ->
                rows.forEach {
                    val item = str(it, "item_id")
                    val tax = str(it, "tax_id")
                    if (item != null && tax != null && str(it, "deleted_at") != null) ops.unlinkTax(item, tax)
                }
                dao.upsertItemTaxes(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val tax = str(it, "tax_id")
                    if (item == null || tax == null || str(it, "deleted_at") != null) null else ItemTaxCrossRef(item, tax)
                })
            }
            changes["item_modifier_groups"]?.let { rows ->
                rows.forEach {
                    val item = str(it, "item_id")
                    val group = str(it, "group_id")
                    if (item != null && group != null && str(it, "deleted_at") != null) ops.unlinkGroup(item, group)
                }
                dao.upsertItemModGroups(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val group = str(it, "group_id")
                    if (item == null || group == null || str(it, "deleted_at") != null) null else ItemModGroupCrossRef(item, group)
                })
            }
            changes["printers"]?.let { rows ->
                ops.upsertPrinters(rows.map {
                    PrinterEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "name") ?: "", str(it, "kind") ?: "network", str(it, "address"),
                        (lng(it, "paper_mm") ?: 80).toInt(), bool(it, "is_receipt", false), (lng(it, "feed_lines") ?: 3).toInt(), bool(it, "cut", true),
                        bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        pair_code = str(it, "pair_code"), all_items = bool(it, "all_items", false),
                    )
                })
            }
            changes["pos_settings"]?.lastOrNull()?.let {
                val sent = it.jsonObject["data"]?.toString() ?: "{}"
                // What this tablet changed in its settings while it worked on
                // its own, and has not sent yet, stays as the tablet has it:
                // the server's copy of it is the older one (OwnSettings).
                val waiting = OwnSettings.KINDS.filter { kind -> db.outbox().pendingOf(listOf(kind)) > 0 }
                val data = if (waiting.isNotEmpty()) OwnSettings.kept(sent, ops.settings(), waiting) else sent
                ops.upsertSettings(SettingsEntity(str(it, "tenant_id") ?: "", data))
                val told = com.restopos.core.data.PosSettings.parse(data)
                com.restopos.core.common.Money.decimals = told.decimals
                // the plan came with these: the first screens after it say at once where a change goes
                com.restopos.core.data.Journey.alone = told.alone
            }
            // Cash movements and day closings are made on this till. The copies
            // that come back only matter after a reinstall; one made here and
            // not sent yet is never touched by the pull.
            changes["cash_movements"]?.let { rows ->
                ops.upsertCashMoves(rows.mapNotNull {
                    val at = time(it, "device_time") ?: time(it, "created_at") ?: return@mapNotNull null
                    CashMoveEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "shift_id"), str(it, "employee_id"),
                        str(it, "type") ?: "out", lng(it, "amount") ?: 0, str(it, "reason"), at, str(it, "deleted_at"), lng(it, "server_seq"),
                        deposit_id = str(it, "deposit_id"),
                        account_payment_id = str(it, "account_payment_id"),
                    )
                })
            }
            changes["customers"]?.let { rows ->
                db.customers().upsert(rows.map {
                    CustomerEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "phone"), str(it, "email"), str(it, "note"), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["drawer_counts"]?.let { rows ->
                ops.upsertDrawerCounts(rows.mapNotNull {
                    val at = time(it, "device_time") ?: time(it, "created_at") ?: return@mapNotNull null
                    DrawerCountEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "shift_id") ?: return@mapNotNull null,
                        str(it, "employee_id"), lng(it, "counted") ?: 0, lng(it, "expected") ?: 0, at, str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            // What the back office asked of the store's tills (server 0091). All of
            // them are kept; a till acts on its own (TillRequests), and what this
            // tablet has already acted on stays marked when the row comes again.
            changes["till_requests"]?.let { rows ->
                ops.upsertRequests(rows.mapNotNull {
                    val at = time(it, "requested_at") ?: return@mapNotNull null
                    TillRequestEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "device_id") ?: return@mapNotNull null, str(it, "shift_id") ?: return@mapNotNull null,
                        str(it, "kind") ?: return@mapNotNull null, lng(it, "counted_cash"), lng(it, "amount"), str(it, "reason"), str(it, "requested_by"), at,
                        str(it, "status") ?: "waiting", str(it, "deleted_at"), lng(it, "server_seq"), ops.requestAnswered(id(it)) ?: false,
                    )
                })
            }
            changes["day_closes"]?.let { rows ->
                ops.upsertDayCloses(rows.mapNotNull {
                    val at = time(it, "closed_at") ?: return@mapNotNull null
                    // A closing this tablet made keeps the number it printed: the
                    // tablet counts its own closings, the server the store's, and
                    // with two tills a reprinted Z said another number.
                    val number = ops.dayCloseNumber(id(it)) ?: (lng(it, "number") ?: 0).toInt()
                    DayCloseEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", number,
                        str(it, "closed_by"), time(it, "from_time"), at, str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            changes["tables"]?.let { rows ->
                db.tables().upsertTables(rows.map {
                    TableEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "name") ?: "", str(it, "area") ?: "Main",
                        (lng(it, "seats") ?: 4).toInt(), str(it, "shape") ?: "square",
                        (lng(it, "x") ?: 0).toInt(), (lng(it, "y") ?: 0).toInt(), (lng(it, "w") ?: 10).toInt(), (lng(it, "h") ?: 10).toInt(),
                        (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        (lng(it, "rotation") ?: 0).toInt(),
                    )
                })
            }
            // what stands in the store's rooms beside the tables (server 0102)
            changes["floor_elements"]?.let { rows ->
                db.tables().upsertElements(rows.map {
                    FloorElementEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "area") ?: "Main", str(it, "kind") ?: "wall",
                        (lng(it, "x") ?: 0).toInt(), (lng(it, "y") ?: 0).toInt(), (lng(it, "w") ?: 10).toInt(), (lng(it, "h") ?: 1).toInt(),
                        (lng(it, "rotation") ?: 0).toInt(), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            // Bookings are the same on every till of the store. One changed here
            // and not sent yet is on its way up; the copy that comes back after
            // it has landed is the one that counts.
            changes["bookings"]?.let { rows ->
                db.service().upsertBookings(rows.mapNotNull {
                    val at = time(it, "booked_for") ?: return@mapNotNull null
                    BookingEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, at, str(it, "name") ?: "", (lng(it, "size") ?: 1).toInt(),
                        str(it, "phone"), str(it, "area"), str(it, "table_id"), str(it, "tags"), str(it, "status") ?: "confirmed", str(it, "ticket_id"),
                        str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            val staff = db.staff()
            changes["roles"]?.let { rows ->
                staff.upsertRoles(rows.map {
                    RoleEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", it.jsonObject["permissions"]?.toString() ?: "[]", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["employees"]?.let { rows ->
                staff.upsertEmployees(rows.map {
                    EmployeeEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "pin_hash"), str(it, "role_id"), bool(it, "is_active", true), str(it, "deleted_at"), lng(it, "server_seq"),
                        has_login = str(it, "auth_user_id") != null)
                })
            }
            changes["employee_stores"]?.let { rows ->
                staff.upsertEmployeeStores(rows.mapNotNull {
                    val employee = str(it, "employee_id")
                    val at = str(it, "store_id")
                    if (employee == null || at == null) null
                    else EmployeeStoreEntity(employee, at, str(it, "tenant_id") ?: "", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["timeclock_punches"]?.let { rows ->
                staff.upsertPunches(rows.mapNotNull {
                    val employee = str(it, "employee_id")
                    val at = time(it, "device_time")
                    if (employee == null || at == null) null
                    else PunchEntity(id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id"), employee, str(it, "kind") ?: "in", at, str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["shifts"]?.let { rows ->
                staff.upsertShifts(rows.mapNotNull {
                    val opened = time(it, "opened_at") ?: return@mapNotNull null
                    val pulled = ShiftEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "",
                        str(it, "opened_by"), opened, lng(it, "opening_float") ?: 0, str(it, "closed_by"), time(it, "closed_at"),
                        lng(it, "expected_cash"), lng(it, "counted_cash"), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                    // A period closed on this tablet stays closed. Until the
                    // close has been sent, the server still has it open, and
                    // taking its copy would reopen it here.
                    val local = staff.shift(pulled.id)
                    if (local?.closed_at != null && pulled.closed_at == null) null else pulled
                })
            }
            // The shop's receipts of the last 30 days. One made on this tablet
            // is already here, with what it printed: its copy from the server is
            // left alone. The others (another till's, or this till's own after a
            // reinstall) are kept so a sale can be found and refunded on any
            // till. A receipt comes before its lines, and a line before its
            // taxes, so each finds what it belongs to.
            val receipts = db.receipts()
            changes["receipts"]?.forEach {
                val rid = id(it)
                val here = ops.receipt(rid)
                if (here != null && !here.pulled) return@forEach
                val at = time(it, "device_time") ?: time(it, "created_at") ?: return@forEach
                val ticket = str(it, "ticket_id") ?: return@forEach
                receipts.upsertPulled(
                    ReceiptEntity(
                        rid, str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", ticket, str(it, "number") ?: "",
                        str(it, "type") ?: "sale", str(it, "refund_of"), lng(it, "subtotal") ?: 0, lng(it, "discount_total") ?: 0, lng(it, "tax_total") ?: 0,
                        lng(it, "service_charge") ?: 0, lng(it, "rounding") ?: 0, lng(it, "total") ?: 0, bool(it, "needs_review", false), at,
                        str(it, "deleted_at"), lng(it, "server_seq"), doc = null, pulled = true,
                    ),
                )
            }
            changes["receipt_lines"]?.let { rows ->
                receipts.upsertPulledLines(rows.mapNotNull {
                    val rc = str(it, "receipt_id")?.let { r -> ops.receipt(r) }?.takeIf { r -> r.pulled } ?: return@mapNotNull null
                    ReceiptLineEntity(
                        id(it), rc.tenant_id, rc.id, str(it, "name_snapshot") ?: "", lng(it, "unit_price") ?: 0, (lng(it, "qty") ?: 0).toInt(), str(it, "ticket_line_id"),
                        lng(it, "list_price"), str(it, "price_kind"), str(it, "price_label"),
                    )
                })
            }
            changes["receipt_payments"]?.let { rows ->
                receipts.upsertPulledPayments(rows.mapNotNull {
                    val rc = str(it, "receipt_id")?.let { r -> ops.receipt(r) }?.takeIf { r -> r.pulled } ?: return@mapNotNull null
                    val type = str(it, "payment_type_id") ?: return@mapNotNull null
                    ReceiptPaymentEntity(id(it), rc.tenant_id, rc.id, type, lng(it, "amount") ?: 0, lng(it, "tendered"), lng(it, "change") ?: 0, str(it, "reference"))
                })
            }
            // A shop's credit notes (server 0109). The server's balance and
            // status win: a note this tablet spent is overwritten by the
            // figure the server worked out once the sale got there, and one
            // this tablet issued keeps its own row until the server sends it.
            changes["credit_notes"]?.let { rows ->
                db.notes().upsert(rows.mapNotNull {
                    CreditNoteEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "number") ?: return@mapNotNull null,
                        lng(it, "amount") ?: 0, lng(it, "balance") ?: 0, str(it, "refund_id") ?: "", str(it, "customer_id"), str(it, "valid_to")?.take(10),
                        str(it, "status") ?: "open", str(it, "issued_by"), time(it, "created_at") ?: System.currentTimeMillis(), lng(it, "server_seq"), pulled = true,
                    )
                })
            }
            // A shop's deposits (server 0113), each with its lines and its
            // payments inside the row as they stand on the server. The server's
            // figures win, except for a deposit with something of this tablet's
            // own still waiting to go up (one of its operations, or a
            // collection's bill): the server's copy of it is older, and the
            // next pull after the push brings it whole.
            changes["deposits"]?.let { rows ->
                val dd = db.deposits()
                rows.forEach { e ->
                    val did = id(e)
                    val number = str(e, "number") ?: return@forEach
                    if (dd.waiting(did, number) > 0) return@forEach
                    dd.upsert(listOf(com.restopos.core.database.DepositEntity(
                        did, str(e, "tenant_id") ?: "", str(e, "store_id") ?: store, str(e, "device_id") ?: "", number, str(e, "customer_id"),
                        str(e, "collect_by")?.take(10) ?: "", str(e, "status") ?: "open", lng(e, "total") ?: 0, lng(e, "paid") ?: 0,
                        lng(e, "given_back") ?: 0, lng(e, "used") ?: 0, lng(e, "kept") ?: 0, lng(e, "owed") ?: 0, lng(e, "noted") ?: 0,
                        str(e, "cancel_outcome"), str(e, "cancel_reason"), bool(e, "auto_cancelled", false), str(e, "credit_note_id"),
                        str(e, "created_by"), time(e, "device_time") ?: time(e, "created_at") ?: 0, time(e, "cancelled_at"), lng(e, "server_seq"), pulled = true,
                    )))
                    dd.dropLines(did)
                    dd.upsertLines((e.jsonObject["lines"] as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { l ->
                        com.restopos.core.database.DepositLineEntity(
                            id(l), did, str(l, "item_id") ?: return@mapNotNull null, str(l, "variant_id") ?: "", str(l, "name") ?: "",
                            (lng(l, "qty") ?: 0).toInt(), (lng(l, "qty_collected") ?: 0).toInt(), lng(l, "unit_price") ?: 0, lng(l, "list_price"),
                            str(l, "price_kind"), str(l, "price_label"), str(l, "price_by"), (lng(l, "sort") ?: 0).toInt(),
                        )
                    })
                    dd.dropPayments(did)
                    dd.upsertPayments((e.jsonObject["payments"] as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { q ->
                        com.restopos.core.database.DepositPaymentEntity(
                            id(q), did, str(q, "payment_type_id") ?: return@mapNotNull null, str(q, "kind") ?: "in", lng(q, "amount") ?: 0,
                            lng(q, "tendered"), lng(q, "change") ?: 0, str(q, "shift_id"), str(q, "device_id"), str(q, "employee_id"),
                            time(q, "device_time") ?: time(q, "created_at") ?: 0,
                        )
                    })
                }
            }
            // A shop's bills on account (server 0114), as the server has them;
            // except a bill with something of its own still waiting to go up
            // (its sale, a payment on it, a return off it): the server's copy
            // is older, and the next pull after the push brings it.
            changes["account_bills"]?.let { rows ->
                val ad = db.accounts()
                rows.forEach { e ->
                    val bid = id(e)
                    if (ad.waiting(bid) > 0) return@forEach
                    if (str(e, "deleted_at") != null) { ad.drop(bid); return@forEach }
                    ad.upsertBills(listOf(com.restopos.core.database.AccountBillEntity(
                        bid, str(e, "tenant_id") ?: "", str(e, "store_id") ?: store, str(e, "device_id"), str(e, "customer_id"),
                        str(e, "number") ?: return@forEach, str(e, "day")?.take(10) ?: "", lng(e, "amount") ?: 0, lng(e, "paid") ?: 0, lng(e, "returned") ?: 0,
                        time(e, "created_at") ?: 0, lng(e, "server_seq"), pulled = true,
                    )))
                }
            }
            // only a pulled line carries the server's id, so these find nothing for a receipt made here
            changes["receipt_line_taxes"]?.let { rows ->
                receipts.upsertLineTaxes(rows.mapNotNull {
                    val line = str(it, "receipt_line_id")?.let { l -> receipts.line(l) } ?: return@mapNotNull null
                    ReceiptLineTaxEntity(id(it), line.id, str(it, "tax_id") ?: "", str(it, "name_snapshot") ?: "Tax", (lng(it, "rate_bp") ?: 0).toInt(), str(it, "type") ?: "included")
                })
            }
            changes["receipt_line_modifiers"]?.let { rows ->
                receipts.upsertLineMods(rows.mapNotNull {
                    val line = str(it, "receipt_line_id")?.let { l -> receipts.line(l) } ?: return@mapNotNull null
                    ReceiptLineModEntity(id(it), line.id, lng(it, "price") ?: 0)
                })
            }
            // A shop's stock papers (server 0092). "No variant" is null on the
            // server and "" here, as on stock_levels. An order and a delivery
            // arrive with their lines inside the row, and those take the place
            // of the lines kept: a draft saved again has other lines, not more.
            val stock = db.stock()
            changes["suppliers"]?.let { rows ->
                stock.upsertSuppliers(rows.map {
                    SupplierEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "contact"), str(it, "phone"), str(it, "email"),
                        str(it, "address"), str(it, "note"), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            fun lines(e: JsonElement) = (e.jsonObject["lines"] as? kotlinx.serialization.json.JsonArray).orEmpty()
            changes["purchase_orders"]?.let { rows ->
                stock.upsertOrders(rows.mapNotNull {
                    val supplier = str(it, "supplier_id") ?: return@mapNotNull null
                    PurchaseOrderEntity(
                        id(it), str(it, "store_id") ?: store, str(it, "number") ?: "", supplier, str(it, "status") ?: "draft", str(it, "expected_on"),
                        str(it, "note"), str(it, "created_by"), time(it, "sent_at"), time(it, "created_at") ?: 0, time(it, "updated_at") ?: 0,
                        str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
                rows.forEach { o ->
                    stock.replaceOrderLines(id(o), lines(o).mapNotNull { l ->
                        val item = str(l, "item_id") ?: return@mapNotNull null
                        PurchaseOrderLineEntity(id(o), item, str(l, "variant_id") ?: "", (lng(l, "qty") ?: 0).toInt(), lng(l, "unit_cost") ?: 0, (lng(l, "received") ?: 0).toInt())
                    })
                }
            }
            changes["deliveries"]?.let { rows ->
                stock.upsertDeliveries(rows.map {
                    DeliveryEntity(
                        id(it), str(it, "store_id") ?: store, str(it, "number") ?: "", str(it, "order_id"), str(it, "supplier_id"), str(it, "arrived_on") ?: "",
                        str(it, "invoice_no"), str(it, "note"), str(it, "received_by"), time(it, "created_at") ?: 0, lng(it, "server_seq"),
                    )
                })
                rows.forEach { d ->
                    stock.replaceDeliveryLines(id(d), lines(d).mapNotNull { l ->
                        val item = str(l, "item_id") ?: return@mapNotNull null
                        DeliveryLineEntity(id(d), item, str(l, "variant_id") ?: "", (lng(l, "qty") ?: 0).toInt(), lng(l, "unit_cost") ?: 0)
                    })
                }
            }
            // A count this tablet sent comes back under the same id with the
            // server's number, and its lines under the same keys: the tablet's
            // own rows are written over, not kept beside them.
            changes["stock_counts"]?.let { rows ->
                // what the tablet wrote for a count that has now been to the server: the server's lines follow
                rows.forEach { stock.dropOwnCountLines(id(it)) }
                stock.upsertCounts(rows.map {
                    StockCountEntity(
                        id(it), str(it, "store_id") ?: store, str(it, "number"), str(it, "scope_kind") ?: "all", str(it, "scope_id"), str(it, "scope_text"),
                        str(it, "title") ?: "", str(it, "status") ?: "open", str(it, "uncounted"), str(it, "started_by"), str(it, "completed_by"),
                        time(it, "completed_at"), time(it, "created_at") ?: 0, lng(it, "server_seq"),
                    )
                })
            }
            changes["stock_count_lines"]?.let { rows ->
                stock.upsertCountLines(rows.mapNotNull {
                    val count = str(it, "count_id") ?: return@mapNotNull null
                    val item = str(it, "item_id") ?: return@mapNotNull null
                    StockCountLineEntity(
                        count, item, str(it, "variant_id") ?: "", lng(it, "counted")?.toInt(), time(it, "counted_at"), bool(it, "left_out", false),
                        lng(it, "expected")?.toInt(), lng(it, "diff")?.toInt(), dbl(it, "unit_cost"), lng(it, "server_seq"),
                    )
                })
            }
            changes["stock_movements"]?.let { rows ->
                stock.upsertMovements(rows.mapNotNull {
                    val item = str(it, "item_id") ?: return@mapNotNull null
                    StockMovementEntity(
                        id(it), str(it, "store_id") ?: store, item, str(it, "variant_id") ?: "", (lng(it, "qty") ?: 0).toInt(), str(it, "reason") ?: "adjust",
                        dbl(it, "unit_cost"), str(it, "ref_type"), str(it, "ref_id"), str(it, "receipt_id"), str(it, "employee_id"), str(it, "note"),
                        time(it, "created_at") ?: 0, lng(it, "server_seq"),
                    )
                })
            }
            db.sync().saveCursor(SyncStateEntity(store, next, epochs))
        }
    }
}
